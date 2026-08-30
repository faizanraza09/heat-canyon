"""Arbitrary what-ifs, anywhere, over any window — re-solved, never looked up.

THE DIFFERENCE THIS MODULE EXISTS TO MAKE

``web/data/scenarios.json`` already holds a grid: six interventions at three
representative canyons, at three hours of the event day and at twelve monthly
peaks. That grid is what the interface shows and it is genuinely re-solved. But
it is a grid, and a planner's question is not on it. "What if we put trees on
Madison between 42nd and 48th." "What if every pre-war residential building with
an HVI of 4 or 5 got external shading — how much exposure does that remove, and
what does it cost in January." "Where would cool pavement make things worse."

None of those can be answered by interpolating a grid, because the answer depends
on the geometry of the specific place: a canyon whose floor is already shaded
gains nothing from trees, and the model can only know that by solving that
canyon.

So this module takes a SELECTION and a SPEC and re-solves.

  selection   streets by name, buildings by BIN or by filter, a radius around a
              point, or the whole AOI
  spec        albedo, tree canopy, facade shading, glazing, or one of the named
              catalogue measures — and any combination, because they compose
  window      one hour, one period, a season, or the whole year

WHAT COMES BACK

Deltas in kelvin at the canyon (ground, wall, mean radiant temperature, WBGT,
2 m air) and at the facade panel level, aggregated to the selection; the
population-weighted exposure change; and — for anything wider than one hour — the
seasonal split, because a shading measure that removes 4 K in July also removes
solar gain in January and a plan that reports only the July figure is not a plan.

WHAT IT DOES NOT CLAIM

The canyon solution is one-dimensional across the street: it resolves height and
orientation, not along-street variation, and it has no advective coupling between
adjacent canyons. Treating six blocks of Madison Avenue therefore returns six
independent solutions rather than the boundary-layer response of six treated
blocks together, which would be larger for air temperature and about the same for
surface and radiant temperature. Since surface and radiant temperature are where
the effects are, that limitation bites least where the answer matters most — but
it is a limitation, it is returned in the payload, and the air-temperature delta
is the number to distrust.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import numpy as np

from .. import physics as P
from .. import scenarios as SC
from .. import solar
from .. import yearsolve as YS
from .dataset import Dataset, month_key

#: What a spec may change, with its physical meaning and its bounds. Enumerated
#: so an agent can discover the lever set without reading the source, and bounded
#: so a request for albedo 3.0 is refused rather than silently solved.
LEVERS: dict[str, dict] = {
    "wall_albedo": {
        "meaning": "shortwave reflectance of the treated facades",
        "range": [0.05, 0.90],
        "note": ("A light facade coating. Lowers the treated wall's own surface "
                 "temperature and RAISES what it reflects onto the wall opposite "
                 "and onto pedestrians — the model resolves both."),
    },
    "ground_albedo": {
        "meaning": "shortwave reflectance of the roadbed and sidewalk",
        "range": [0.05, 0.60],
        "note": ("Cool pavement. Reliably lowers ground surface temperature and can "
                 "raise mean radiant temperature in a deep canyon, which is a real "
                 "documented trade-off."),
    },
    "roof_albedo": {
        "meaning": "shortwave reflectance of roofs",
        "range": [0.05, 0.90],
        "note": ("A roof is nearly invisible from the sidewalk, so this moves the "
                 "top-floor cooling load and almost nothing at street level."),
    },
    "tree_cover": {
        "meaning": "fraction of the canyon under canopy, absolute (not added)",
        "range": [0.0, 0.85],
        "note": ("Acts on three terms: intercepts the beam, moves absorbed energy "
                 "into latent heat, and replaces a hot surface in the pedestrian's "
                 "view with a cool one. Also lowers sky view factor, which slows "
                 "night-time cooling — the model reproduces the penalty."),
    },
    "facade_shade": {
        "meaning": "fraction of the beam intercepted outside the envelope",
        "range": [0.0, 0.90],
        "note": ("Brise-soleil, deep reveals, awnings. Only the treated face, and "
                 "nothing for the sidewalk unless it overhangs."),
    },
    "wall_admittance": {
        "meaning": "thermal admittance of the facade, J/(m2 K s^0.5)",
        "range": [200.0, 2000.0],
        "note": ("External insulation or added mass. Governs how much of the net "
                 "radiation the fabric absorbs rather than shedding to the air, so "
                 "a heavier wall runs cooler at its surface under the same sun."),
    },
}

#: Named measures, as specs. The same physics as the catalogue in
#: ``heatcanyon.scenarios`` — these exist so an agent can say "cool_roof" instead
#: of remembering that a cool roof is albedo 0.70.
PRESETS: dict[str, dict] = {
    "cool_roof": {"roof_albedo": 0.70},
    "cool_pavement": {"ground_albedo": 0.40},
    "cool_walls": {"wall_albedo": 0.60},
    "street_trees": {"tree_cover": 0.45},
    "dense_trees": {"tree_cover": 0.70},
    "facade_shading": {"facade_shade": 0.35},
    "deep_shading": {"facade_shade": 0.65},
    "external_insulation": {"wall_admittance": 400.0},
    "all_measures": {"roof_albedo": 0.70, "ground_albedo": 0.40,
                     "tree_cover": 0.45, "facade_shade": 0.35},
}


class SpecError(ValueError):
    pass


def resolve_spec(spec: dict | str | Sequence[str]) -> dict:
    """Turn a preset name, a list of them, or a lever dict into one lever dict."""
    if isinstance(spec, str):
        spec = [spec]
    if isinstance(spec, (list, tuple)):
        out: dict[str, float] = {}
        for name in spec:
            if name not in PRESETS:
                raise SpecError(f"unknown preset {name!r}; have {sorted(PRESETS)}")
            out.update(PRESETS[name])
        return out
    out = {}
    for k, v in dict(spec).items():
        if k in PRESETS:
            out.update(PRESETS[k])
            continue
        if k not in LEVERS:
            raise SpecError(
                f"unknown lever {k!r}; have {sorted(LEVERS)} and presets "
                f"{sorted(PRESETS)}")
        lo, hi = LEVERS[k]["range"]
        fv = float(v)
        if not (lo <= fv <= hi):
            raise SpecError(f"{k}={fv} is outside the physical range [{lo}, {hi}]")
        out[k] = fv
    return out


# ------------------------------------------------------------------ selection


@dataclass
class Selection:
    """Which canyons, panels and buildings an intervention touches."""

    description: str
    canyons: list[int]
    panels: np.ndarray
    buildings: list[int]
    residential_units: int
    wall_area_m2: float
    street_length_m: float

    def as_dict(self) -> dict:
        return {
            "description": self.description,
            "canyon_sections": len(self.canyons),
            "facade_panels": int(len(self.panels)),
            "buildings": len(self.buildings),
            "residential_units": self.residential_units,
            "treated_wall_area_m2": round(self.wall_area_m2),
            "street_length_m": round(self.street_length_m),
        }


def select(d: Dataset, *, streets: Sequence[str] | None = None,
           bins: Sequence[str] | None = None, near: Sequence[float] | None = None,
           radius_m: float = 200.0, filters: dict | None = None,
           whole_aoi: bool = False) -> Selection:
    """Resolve a target description into concrete canyons, panels and buildings."""
    panel_mask = np.zeros(d.n_panel, dtype=bool)
    parts: list[str] = []

    if whole_aoi:
        panel_mask[:] = True
        parts.append("the whole study area")

    if streets:
        wanted = {s.strip().upper() for s in streets}
        ids = {int(c["i"]) for c in d.canyons
               if any(w in (c["name"] or "").upper() for w in wanted)}
        if not ids:
            raise SpecError(
                f"no street matched {sorted(wanted)}. Street names come from NYC "
                f"Centerline and look like 'MADISON AVE' or 'WEST 47 STREET' — "
                f"call canyon_stats to see them.")
        panel_mask |= np.isin(d.panel_canyon, list(ids))
        parts.append("streets " + ", ".join(sorted(wanted)))

    if bins:
        idx = [d.bin_to_index.get(str(b)) for b in bins]
        found = [i for i in idx if i is not None]
        if not found:
            raise SpecError(f"none of {list(bins)} is a BIN in this study area")
        for i in found:
            ps = d.panels_of_building.get(i)
            if ps is not None:
                panel_mask[ps] = True
        parts.append(f"{len(found)} named buildings")

    if near is not None:
        x, y = float(near[0]), float(near[1])
        dd = ((d.panel_mid[:, 0] - x) ** 2 + (d.panel_mid[:, 1] - y) ** 2)
        panel_mask |= dd <= radius_m * radius_m
        parts.append(f"within {radius_m:g} m of ({x:.0f}, {y:.0f})")

    if filters:
        from .queries import query_buildings
        hits = query_buildings(d, limit=60, **filters)["buildings"]
        for b in hits:
            i = d.bin_to_index.get(str(b["bin"]))
            if i is None:
                continue
            ps = d.panels_of_building.get(i)
            if ps is not None:
                panel_mask[ps] = True
        parts.append(f"{len(hits)} buildings matching a filter")

    if not panel_mask.any():
        # Naming which selector came up empty, because "empty selection" sends the
        # caller looking at the spec when the problem is a filter that matched
        # nothing: `{"residential_only": true, "min_hvi": 5}` is a perfectly
        # well-formed filter with no rows behind it in the ranked set.
        raise SpecError(
            "that selection is empty, so there is nothing to treat. Tried: "
            + (("; ".join(parts)) or "nothing")
            + ". A filter can be well formed and still match no building in the "
              "ranked set — check it with query_buildings first, and note that "
              "the ranked set is the top 150 by event-day priority.")

    panels = np.where(panel_mask)[0]
    canyons = sorted({int(c) for c in d.panel_canyon[panels] if c >= 0})
    buildings = sorted({int(b) for b in d.panel_building[panels]})

    units = 0
    for i in buildings:
        a = d.attrs[i] if i < len(d.attrs) else {}
        units += int(a.get("units") or 0)
    h_wall = np.maximum(d.panel_top[panels] - d.panel_base[panels], 3.0)
    area = float((d.panel_length[panels] * h_wall).sum())
    length = float(sum((d.canyon_by_index.get(c) or {}).get("w", 0.0) * 0
                       for c in canyons))
    # Street length is the number of cross-sections times the sampling interval
    # the extractor used; canyons.json does not carry a segment length, so this is
    # reported as sections rather than invented as metres.
    length = float(len(canyons) * 20.0)

    return Selection(description="; ".join(parts) or "unnamed selection",
                     canyons=canyons, panels=panels, buildings=buildings,
                     residential_units=units, wall_area_m2=area,
                     street_length_m=length)


# ------------------------------------------------------------------ the solve


def _canyon_state(d: Dataset, ci: int, lambda_p: float, disp: float,
                  z0: float) -> tuple[P.CanyonState, dict]:
    c = d.canyon_by_index[ci]
    st = P.CanyonState(
        svf=c["svf"], h_mean=max((c["hl"] + c["hr"]) / 2.0, 4.0),
        width_m=max(c["w"], 6.0), aspect_ratio=c["hw"], bearing=c["bearing"],
        asymmetry=c["asym"], lambda_p=lambda_p, d=disp, z0=z0,
        tree_cover=c.get("trees", 0.0) or 0.0,
    )
    return st, c


def _met_and_sun(d: Dataset, period: str, hour_slot: int) -> tuple[P.Met, Any]:
    p = d.period(period)
    h = p.hours[hour_slot]
    y, m, dd = int(p.date[:4]), int(p.date[5:7]), int(p.date[8:10])
    # The event day is EDT; a monthly representative day may be either, so the
    # offset comes from the date rather than being assumed.
    from datetime import datetime
    from zoneinfo import ZoneInfo
    dt = datetime(y, m, dd, int(h["edt"])).replace(tzinfo=ZoneInfo("America/New_York"))
    off = dt.utcoffset().total_seconds() / 3600.0
    sun = solar.sun_position(d.meta["projection"]["lat0"],
                             d.meta["projection"]["lon0"], y, m, dd,
                             float(h["edt"]) + 0.5, utc_offset=off)
    met = P.Met(t_air_2m=h["t_anchor_c"], rh_percent=h["rh"],
                wind_10m=h["wind_10m"], wind_dir=250.0,
                cloud_fraction=h["cloud"], dni=h["dni"], dhi=h["dhi"],
                hour_edt=float(h["edt"]))
    return met, sun


def _apply_to_state(st: P.CanyonState, levers: dict) -> P.CanyonState:
    """Tree cover changes the canyon state itself, not just a surface property."""
    tc = levers.get("tree_cover", st.tree_cover)
    return P.CanyonState(
        svf=max(0.02, st.svf * (1.0 - 0.35 * max(0.0, tc - st.tree_cover))),
        h_mean=st.h_mean, width_m=st.width_m, aspect_ratio=st.aspect_ratio,
        bearing=st.bearing, asymmetry=st.asymmetry, lambda_p=st.lambda_p,
        d=st.d, z0=st.z0, tree_cover=tc,
    )


def _material_for(levers: dict, key: str, base: str) -> str:
    """Map an albedo lever onto the nearest catalogue material, or register one.

    ``physics.MATERIALS`` is keyed by name, so an arbitrary albedo needs an entry.
    Registering it under a generated name keeps the physics engine's own table as
    the single source of surface properties rather than threading albedo through
    every signature.
    """
    alb = levers.get(key)
    if alb is None:
        return base
    props = dict(P.MATERIALS[base])
    props["albedo"] = float(alb)
    if key == "wall_albedo" and "wall_admittance" in levers:
        props["admittance"] = float(levers["wall_admittance"])
    name = f"_hc_{key}_{alb:.3f}_{props['admittance']:.0f}"
    P.MATERIALS.setdefault(name, props)
    return name


def solve_one(d: Dataset, ci: int, levers: dict, period: str, hour_slot: int,
              *, wall_material: str = "brick") -> dict:
    """Baseline and treated solution for one canyon at one hour."""
    m = d.meta["morphology"]
    st, c = _canyon_state(d, ci, m["lambda_p"], m["displacement_height_m"],
                          m["roughness_length_m"])
    met, sun = _met_and_sun(d, period, hour_slot)
    hl, hr = max(c["hl"], 1.0), max(c["hr"], 1.0)

    def run(state: P.CanyonState, lv: dict) -> P.CanyonSolution:
        person_block = min(0.85, 0.75 * max(0.0, lv.get("tree_cover", state.tree_cover)
                                            - c.get("trees", 0.0)) / 0.40) \
            if lv.get("tree_cover") is not None else 0.0
        ground_shade = min(0.85, 1.4 * max(0.0, lv.get("tree_cover", 0.0)
                                           - c.get("trees", 0.0)))
        wall = _material_for(lv, "wall_albedo", wall_material)
        if "wall_admittance" in lv and "wall_albedo" not in lv:
            props = dict(P.MATERIALS[wall_material])
            props["admittance"] = float(lv["wall_admittance"])
            wall = f"_hc_adm_{props['admittance']:.0f}"
            P.MATERIALS.setdefault(wall, props)
        return P.solve_canyon(
            met, state, sun, hl, hr,
            material_left=wall, material_right=wall,
            ground_material=_material_for(lv, "ground_albedo", "asphalt"),
            roof_material=_material_for(lv, "roof_albedo", "concrete"),
            person_beam_block=person_block,
            facade_shade_factor=float(lv.get("facade_shade", 0.0)),
            ground_shade_fraction=ground_shade,
        )

    base_sol = run(st, {})
    st2 = _apply_to_state(st, levers)
    new_sol = run(st2, levers)

    def readout(sol: P.CanyonSolution, state: P.CanyonState, lv: dict) -> dict:
        grounds = [p for p in sol.panels if p.kind == "ground"]
        walls = [p for p in sol.panels if p.kind == "wall"]
        roofs = [p for p in sol.panels if p.kind == "roof"]
        lower = [p for p in walls if p.z_lo < 20.0] or walls
        lit = sol.sunlit_floor_fraction > 0.01
        return {
            "ground_c": max((p.t_surface for p in grounds), default=met.t_air_2m),
            "roof_c": max((p.t_surface for p in roofs), default=met.t_air_2m),
            "facade_lower_c": max((p.t_surface for p in lower), default=met.t_air_2m),
            "facade_peak_c": max((p.t_surface for p in walls), default=met.t_air_2m),
            "mrt_c": sol.t_mrt_sun if lit else sol.t_mrt_shade,
            "mrt_sun_c": sol.t_mrt_sun, "mrt_shade_c": sol.t_mrt_shade,
            "wbgt_c": sol.wbgt_sun if lit else sol.wbgt_shade,
            "sunlit_floor_fraction": sol.sunlit_floor_fraction,
        }

    a, b = readout(base_sol, st, {}), readout(new_sol, st2, levers)

    # Air temperature responds through the changed sensible heat flux, using the
    # same bulk-resistance conversion `scenarios.run_scenario` uses, so an
    # arbitrary spec and a catalogue measure cannot disagree about d_air.
    base_h = P.sensible_heat_flux(met, st, base_sol.sunlit_floor_fraction)
    new_h = P.sensible_heat_flux(met, st2, new_sol.sunlit_floor_fraction)
    u_c = P.canyon_wind(met.wind_10m, st2.aspect_ratio)
    r_a = P.RHO_AIR * P.CP_AIR / max(P.convective_coefficient(u_c), 1.0)
    d_air = max(-2.5, min(0.5, (new_h - base_h) / max(r_a * 10.0, 1.0)))

    return {
        "canyon": ci, "street": c.get("name"),
        "aspect_ratio_hw": c["hw"], "width_m": c["w"], "svf": c["svf"],
        "bearing_deg": c["bearing"], "tree_cover_now": c.get("trees", 0.0),
        "hour_edt": met.hour_edt, "air_c": met.t_air_2m,
        "sun_altitude": round(sun.altitude, 1),
        "baseline": {k: round(v, 3) for k, v in a.items()},
        "treated": {k: round(v, 3) for k, v in b.items()},
        "delta_k": {
            "ground": round(b["ground_c"] - a["ground_c"], 3),
            "roof": round(b["roof_c"] - a["roof_c"], 3),
            "facade_lower": round(b["facade_lower_c"] - a["facade_lower_c"], 3),
            "facade_peak": round(b["facade_peak_c"] - a["facade_peak_c"], 3),
            "mrt": round(b["mrt_c"] - a["mrt_c"], 3),
            "mrt_sun": round(b["mrt_sun_c"] - a["mrt_sun_c"], 3),
            "mrt_shade": round(b["mrt_shade_c"] - a["mrt_shade_c"], 3),
            "wbgt": round(b["wbgt_c"] - a["wbgt_c"], 3),
            "air_2m": round(d_air, 3),
        },
    }


#: Which hour slots stand for a window. The peak slot alone for "peak", the three
#: daylight slots for a day, all eight for a full diurnal cycle.
WINDOW_SLOTS = {
    "peak": [4],
    "afternoon": [4, 5],
    "daylight": [2, 3, 4, 5],
    "day": [0, 1, 2, 3, 4, 5, 6, 7],
}


def run(d: Dataset, *, spec: Any, period: str | Sequence[str] = "event",
        window: str = "peak", max_canyons: int = 40, **selector) -> dict:
    """Re-solve a selection under a spec, over one or many periods.

    ``period`` may be a single period key, a list of them, ``"year"`` for all
    twelve months, or ``"seasons"`` for one month from each season.
    """
    levers = resolve_spec(spec)
    sel = select(d, **selector)
    slots = WINDOW_SLOTS.get(window, WINDOW_SLOTS["peak"])

    if period == "year":
        periods = [month_key(m) for m in range(1, 13)]
    elif period == "seasons":
        periods = [month_key(m) for m in (1, 4, 7, 10)]
    elif isinstance(period, (list, tuple)):
        periods = [d.resolve_period(p) for p in period]
    else:
        periods = [d.resolve_period(period)]

    # Solving every cross-section of Madison Avenue is 200 canyons times eight
    # hours times twelve months, which is a lot of canyon solutions for an answer
    # that is dominated by the spread rather than the count. A stratified sample
    # by aspect ratio keeps the geometric variety that makes the answer
    # place-specific while bounding the work; the sample size is reported.
    canyons = _sample_canyons(d, sel.canyons, max_canyons)

    rows = []
    for pk in periods:
        for s in slots:
            for ci in canyons:
                rows.append(dict(solve_one(d, ci, levers, pk, s), period=pk,
                                 hour_slot=s))

    by_period = {}
    for pk in periods:
        sub = [r for r in rows if r["period"] == pk]
        by_period[pk] = _aggregate(sub)

    out = {
        "spec": levers,
        "spec_meaning": {k: LEVERS[k]["note"] for k in levers if k in LEVERS},
        "selection": sel.as_dict(),
        "canyons_solved": len(canyons),
        "canyons_in_selection": len(sel.canyons),
        "sampled": len(canyons) < len(sel.canyons),
        "periods": periods,
        "window": window,
        "hour_slots": slots,
        "solutions": len(rows),
        "by_period": by_period,
        "overall": _aggregate(rows),
        "per_canyon": _per_canyon(rows),
        "limitations": [
            "The canyon solution is one-dimensional across the street: it resolves "
            "height and orientation but not along-street variation, and there is no "
            "advective coupling between adjacent canyons. Treating several blocks "
            "returns several independent solutions, so the AIR temperature delta is "
            "an under-estimate at scale while the surface and radiant deltas are "
            "roughly right.",
            "Deltas are instantaneous at the hours solved, not daily means. Use "
            "window='day' for a diurnal picture.",
            "Tree cover is a canopy FRACTION, not a species or a planting plan, and "
            "it assumes an established canopy — not the first ten years of one.",
        ],
    }
    if len(periods) > 1:
        out["seasonal"] = _seasonal(by_period)
    out["exposure_effect"] = _exposure_effect(d, sel, out["overall"])
    return out


def _sample_canyons(d: Dataset, ids: Sequence[int], cap: int) -> list[int]:
    ids = list(ids)
    if len(ids) <= cap:
        return ids
    hw = np.array([(d.canyon_by_index.get(i) or {}).get("hw", 0.0) for i in ids])
    order = np.argsort(hw)
    take = np.linspace(0, len(ids) - 1, cap).round().astype(int)
    return [ids[int(order[i])] for i in take]


def _aggregate(rows: Sequence[dict]) -> dict:
    if not rows:
        return {}
    keys = list(rows[0]["delta_k"])
    out = {}
    for k in keys:
        v = np.array([r["delta_k"][k] for r in rows], dtype=np.float64)
        out[k] = {
            "mean": round(float(v.mean()), 3),
            "median": round(float(np.median(v)), 3),
            "p10": round(float(np.percentile(v, 10)), 3),
            "p90": round(float(np.percentile(v, 90)), 3),
            "best": round(float(v.min()), 3),
            "worst": round(float(v.max()), 3),
            "made_worse_fraction": round(float((v > 0.05).mean()), 3),
        }
    return out


def _per_canyon(rows: Sequence[dict]) -> list[dict]:
    by: dict[int, list[dict]] = {}
    for r in rows:
        by.setdefault(r["canyon"], []).append(r)
    out = []
    for ci, rs in by.items():
        mrt = np.array([r["delta_k"]["mrt"] for r in rs])
        out.append({
            "canyon": ci, "street": rs[0]["street"],
            "aspect_ratio_hw": rs[0]["aspect_ratio_hw"],
            "width_m": rs[0]["width_m"], "svf": rs[0]["svf"],
            "tree_cover_now": rs[0]["tree_cover_now"],
            "d_mrt_mean_k": round(float(mrt.mean()), 3),
            "d_facade_lower_mean_k": round(float(np.mean(
                [r["delta_k"]["facade_lower"] for r in rs])), 3),
            "d_ground_mean_k": round(float(np.mean(
                [r["delta_k"]["ground"] for r in rs])), 3),
            "solutions": len(rs),
        })
    out.sort(key=lambda r: r["d_mrt_mean_k"])
    return out


def _seasonal(by_period: dict) -> dict:
    """Summer benefit against winter penalty — the number a year makes possible."""
    def mean_of(months: Iterable[int], field: str) -> float | None:
        vals = [by_period[month_key(m)][field]["mean"]
                for m in months if month_key(m) in by_period]
        return round(float(np.mean(vals)), 3) if vals else None

    s_mrt = mean_of((6, 7, 8), "mrt")
    w_mrt = mean_of((12, 1, 2), "mrt")
    return {
        "summer_d_mrt_k": s_mrt,
        "winter_d_mrt_k": w_mrt,
        "summer_d_facade_k": mean_of((6, 7, 8), "facade_lower"),
        "winter_d_facade_k": mean_of((12, 1, 2), "facade_lower"),
        "seasonal_penalty_k": (round(w_mrt - s_mrt, 3)
                               if s_mrt is not None and w_mrt is not None else None),
        "best_month": min(by_period, key=lambda k: by_period[k]["mrt"]["mean"])
                      if by_period else None,
        "worst_month": max(by_period, key=lambda k: by_period[k]["mrt"]["mean"])
                       if by_period else None,
        "reading": (
            "A positive seasonal_penalty means the measure does less good in winter "
            "than in summer. For shading and canopy that is the correct sign and it "
            "is the cost of the measure: the same geometry that removes July's beam "
            "removes January's. For a high-albedo surface the penalty is small "
            "because the winter beam is small. Whether the penalty matters depends "
            "on whether the building is heating-dominated, which this model does not "
            "know — it solves the outside of the envelope, not the inside."
        ),
    }


def _exposure_effect(d: Dataset, sel: Selection, overall: dict) -> dict:
    """The selection's exposure change, weighted by who is behind the wall."""
    if not overall:
        return {}
    d_mrt = overall.get("mrt", {}).get("mean", 0.0)
    d_facade = overall.get("facade_lower", {}).get("mean", 0.0)
    kh = d.plane("degree_hours_35")[sel.panels].mean()
    hours = d.plane("hours_above_35")[sel.panels].mean()
    avoided_kh = min(float(kh), abs(d_facade) * float(hours)) * (1 if d_facade < 0 else -1)
    return {
        "treated_wall_area_m2": round(sel.wall_area_m2),
        "residential_units_behind_treated_wall": sel.residential_units,
        "mean_annual_degree_hours_35_now": round(float(kh), 1),
        "mean_annual_hours_above_35_now": round(float(hours), 1),
        "estimated_annual_degree_hours_avoided": round(avoided_kh, 1),
        "person_degree_hours_avoided": round(avoided_kh * sel.residential_units, 1),
        "mean_d_mrt_k": d_mrt,
        "method": (
            "The facade delta is modelled at the hours solved. It is projected onto "
            "the year by multiplying it by the hours the facade currently spends "
            "above 35 C and capping at the degree-hours it currently accumulates. "
            "That projection is arithmetic, not physics: it assumes the measure "
            "delivers the same kelvin at every exceeding hour, which over-states a "
            "shading measure's winter contribution and under-states its high-summer "
            "one. For the physics across the year, pass period='year'."
        ),
    }


def catalogue() -> dict:
    """Levers, presets, windows — everything a spec may say."""
    return {
        "levers": LEVERS,
        "presets": {k: v for k, v in PRESETS.items()},
        "windows": {k: f"hour slots {v}" for k, v in WINDOW_SLOTS.items()},
        "periods": ["event", "month_01..month_12", "year (all twelve)",
                    "seasons (Jan, Apr, Jul, Oct)"],
        "selectors": {
            "streets": "list of names, substring matched against NYC Centerline",
            "bins": "list of building BINs",
            "near": "[x, y] in local metres, with radius_m",
            "filters": "any query_buildings filter, e.g. "
                       "{'residential_only': true, 'min_hvi': 4, 'built_before': 1945}",
            "whole_aoi": "true to treat everything",
        },
        "composition_note": (
            "Levers compose: pass several and they are applied together and solved "
            "once. That is not the same as adding their separate effects, and the "
            "difference is real — trees shade the pavement a cool coating was meant "
            "to fix, so the combination delivers less than the sum. Solve the "
            "combination rather than adding the parts."
        ),
    }

"""The structured read surface: what the agent can ask without writing code.

Everything here returns plain dicts and lists of numbers, never prose. That is
the property that stops an analyst paraphrasing creatively — there is nothing to
paraphrase, only records to report — and it is why the provenance travels
*inside* the result rather than in a note beside it. A tool result that says
``{"value": 38.7, "kind": "measured", "source": "FortyGuard /v1/heatmap"}``
cannot lose its provenance on the way into a sentence.

WHAT BELONGS HERE AND WHAT DOES NOT

Here: anything that reads the model and returns records. Selecting buildings,
summarising a street, pulling a series out of the year, comparing two periods,
locating the extremes.

Not here: statistics (``analysis``), physics re-solves (``interventions``), and
anything the agent is better off writing itself in a script. The registry is kept
short on purpose — a tool's schema is in every request, whereas a shell and a
documented dataset cost nothing until used.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .. import year as Y
from .dataset import EVENT, Dataset, month_key

MEASURED = "measured (FortyGuard product or NYC Open Data)"
REANALYSIS = "reanalysis, bias-corrected (ERA5 via Open-Meteo)"
MODELLED = "modelled by this project's physics engine"


def _stats(a) -> dict:
    v = np.asarray(a, dtype=np.float64).reshape(-1)
    v = v[np.isfinite(v)]
    if not v.size:
        return {}
    return {
        "n": int(v.size), "min": round(float(v.min()), 3),
        "p10": round(float(np.percentile(v, 10)), 3),
        "median": round(float(np.median(v)), 3),
        "mean": round(float(v.mean()), 3),
        "p90": round(float(np.percentile(v, 90)), 3),
        "max": round(float(v.max()), 3),
    }


# ------------------------------------------------------------------ overview


def area_summary(d: Dataset) -> dict:
    """The study area, the event, the year, and which tier answers what."""
    m = d.meta
    peak = m["hours"][m["peak_index"]]
    y = m["year"]
    return {
        "study_area": m["aoi"]["label"],
        "area_km2": m["aoi"]["area_km2"],
        "bbox_lon_lat": m["aoi"]["bbox"],
        "counts": m["counts"],
        "morphology": m["morphology"],
        "event_day": {
            "date": m["event"]["date"],
            "label": m["event"]["label"],
            "threshold_c": m["event"]["threshold_c"],
            "peak_hour_edt": peak["edt"],
            "peak_anchor_air_c": peak["t_anchor_c"],
            "hours_measured": [{"edt": h["edt"], "air_c": h["t_anchor_c"],
                                "dni": h["dni"], "wind_ms": h["wind_10m"]}
                               for h in m["hours"]],
            "kind": MEASURED,
        },
        "year": {
            "window": y["window"],
            "days": y["days"],
            "annual": y["annual"],
            "seasons": y["seasons"],
            "months": y["months"],
            "episodes": y["episodes"],
            "kind": REANALYSIS,
        },
        "measured_exceedance_hours_above_35c": d.tiles["stats"]["exceedance"],
        "measured_persistence_hours_above_35c": d.tiles["stats"]["persistence"],
        "tiers": y["tiers"] if "tiers" in y else d.year["tiers"],
        "provenance_note": (
            "Air temperature, hours above 35 C and persistence on the event day "
            "are FortyGuard products. The year's air temperature is ERA5 "
            "reanalysis bias-corrected against FortyGuard on the one overlapping "
            "day. Facade surface temperature, air temperature above 2 m, mean "
            "radiant temperature, WBGT, sky view factor and every annual facade "
            "total are modelled by this project."
        ),
    }


def data_dictionary(d: Dataset) -> dict:
    """Everything that exists, where, in what units, and how to reach it.

    Served as a tool rather than written into the system prompt because it is
    long, it changes with the pipeline, and an agent that needs it can ask once.
    """
    return {
        "layout": d.layout(),
        "tiers": d.year["tiers"],
        "periods": {
            "event": {"date": d.year["periods"]["event"]["date"],
                      "anchor": d.year["periods"]["event"]["anchor_source"]},
            "months": [{"key": month_key(m["month"]), "month": m["month"],
                        "label": m["label"], "representative_date": m["date"],
                        "rms_to_month_mean_k": m["rep_rms_k"]}
                       for m in d.year["periods"]["months"]],
        },
        "annual_planes": {
            "sun_hours": "hours of direct beam on the panel band, per year",
            "dose_kwh": "incident shortwave on the panel band, kWh/m2/yr",
            "absorbed_kwh": "absorbed shortwave after albedo, kWh/m2/yr",
            "degree_hours_35": "sum of max(T_surface - 35, 0) over the year, K.h",
            "degree_hours_40": "same at 40 C, K.h",
            "hours_above_35": "hours with surface above 35 C, per year",
            "t_max": "annual maximum facade surface temperature, degC",
            "t_min": "annual minimum, degC",
            "t_mean": "annual mean, degC",
            "summer_mean": "Jun-Aug mean facade surface temperature, degC",
            "winter_mean": "Dec-Feb mean, degC",
            "swing": ("summer_mean minus winter_mean, K. Nearly uniform across the "
                      "AOI at 25-30 K, because it is set by the air temperature's own "
                      "annual cycle rather than by geometry"),
            "winter_sun_share": ("Dec-Feb sunlit hours divided by Jun-Aug's. THIS is "
                                 "the seasonal quantity that varies with geometry, "
                                 "0.05 in a deep slot to 0.8 on an open south wall, "
                                 "and it is what a shading decision turns on"),
            "month_of_max": "1-12, the month the annual maximum occurred in",
            "monthly_mean": "(12, panel, band) monthly mean surface temperature",
            "monthly_sun_hours": "(12, panel, band) sunlit hours per month",
        },
        "building_fields": {
            "attrs": ("i, bin, bbl, h (height m), base, floors, year, mat, in_aoi, "
                      "lon, lat, addr, use, units, zip, ex/vu/pr (event-day exposure, "
                      "vulnerability, priority 0-100), aex/apr (annual exposure and "
                      "priority), mop (month of peak), swing (K), sunh (sunlit h/yr)"),
            "ranked_items": ("full dossier per building: measured{} modelled{} "
                             "components{} reasons[] actions[] annual{}"),
        },
        "canyon_fields": ("i, name, x, y, bearing, w (facade to facade m), w_curb, "
                          "hl/hr (wall heights), svf, hw (aspect ratio), asym, "
                          "canyon (0/1), trees (cover fraction), dl/dr"),
        "tile_fields": ("air[hour][tile] = [x, y, degC]; anomaly[hour][tile] = "
                        "[x, y, K vs AOI median]; exceedance/persistence[tile] = "
                        "[x, y, hours]; year{hours_above_35, hours_above_32, "
                        "degree_hours_35, tropical_nights, mean_c, max_c, cdd}"),
        "year_fields": ("days[365]{date, doy, month, tmax, tmin, tmean, tmax_h, rh, "
                        "wind, cloud, ghi_kwh, dni_peak, precip, h35, h32, kh35, "
                        "trop, cdd, hdd, daylight, noon_alt}; months[12]{...}; "
                        "seasons[4]; episodes[]; hourly{8760 of each variable}"),
        "units": {
            "temperature": "degrees Celsius unless a delta, which is kelvin",
            "irradiance": "W/m2", "dose": "kWh/m2", "wind": "m/s",
            "degree_hours": "K.h", "length": "metres", "area": "m2 or km2",
            "x_y": "metres in the local projection, origin at the AOI centre",
        },
        "how_to_go_further": (
            "Anything not covered by a tool: write a script. The dataset is "
            "importable as heatcanyon.agent.dataset, the physics engine as "
            "heatcanyon.physics, the vectorised solver as heatcanyon.yearsolve, "
            "and the interventions as heatcanyon.agent.interventions. Run it with "
            "Bash from your workspace."
        ),
    }


def methodology(d: Dataset, topic: str = "overview") -> dict:
    """How a part of the model works and how confident to be in it."""
    y = d.meta["year"]
    notes: dict[str, str] = {
        "overview": (
            "FortyGuard supplies 2 m air temperature on a 60 m grid for eight hours "
            "of 2 July 2026. Building heights come from NYC Open Data footprints "
            "refined by 2017 airborne LiDAR, street widths from NYC Centerline. From "
            "those a 3 m digital surface model is rasterised, sky view factor "
            "computed by horizon scanning, shadows ray-traced per hour, and a "
            "coupled surface energy balance solved for every facade band. Air "
            "temperature is extended vertically by Monin-Obukhov similarity above "
            "roof level and a canyon-mixing model below."
        ),
        "year": (
            "The year is ERA5 reanalysis via Open-Meteo, 8,760 hours, bias-corrected "
            "against FortyGuard on the one day both cover. It is resolved at three "
            "tiers: the event day at full resolution with ray-traced shadows; twelve "
            "representative days, one per month, likewise; and an 8,760-hour "
            "accumulation using the analytic canyon shading form, which produces "
            "totals and extremes but no viewable field. Any day between the twelve "
            "is shown as its month's field plus a measured dT_surface/dT_air times "
            "that day's air-temperature departure. Every one of those boundaries is "
            "in heatcanyon/tiers.py and reported in meta.json under `year`."
        ),
        "bias_correction": (
            "ERA5's cell over Midtown is about 25 km and contains water and New "
            "Jersey, so it is a regional 2 m temperature, not an urban one. Measured "
            "against FortyGuard on 2 July 2026 it runs about 2 K too warm at "
            "mid-afternoon and 2 K too cool before dawn — its diurnal amplitude is "
            "too large. A 24-value diurnal offset curve is fitted to the eight hours "
            "both cover and applied year-round. The curve comes from ONE day, so it "
            "captures the shape of the bias but not its seasonality; a winter offset "
            "is an extrapolation. Both series are shipped."
        ),
        "uncertainty": (
            "The vertical air-temperature extrapolation is unvalidated and labelled "
            "as such. No public dataset measures air temperature at height in "
            "Manhattan. Its one-sigma uncertainty grows from 0.5 K at the 2 m anchor "
            "to roughly 3 K at 150 m, which is LARGER than the modelled vertical "
            "gradient itself. The surface temperature and mean radiant temperature "
            "fields are where the real variation is, and they are driven by solar "
            "geometry, which is exact."
        ),
        "convection": (
            "The exterior convective coefficient is h_c = 5.8 + 3.8u with u the "
            "canyon wind. The intercept has been wrong twice in opposite directions "
            "and the history is in heatcanyon/physics.py: McAdams' 5.7 is a COMBINED "
            "coefficient and double-counted the explicit longwave term; the 2.0 that "
            "replaced it was a free-convection value used as a forced-convection "
            "intercept, which was too small and was masked by a wind value 3.6x too "
            "large (km/h read as m/s). Both are fixed. The current form is the mean "
            "of Palyvos (2008) windward and leeward convective-only correlations for "
            "vertical walls, and the engine has no orientation dependence."
        ),
        "svf": (
            "Sky view factor is the mean of cos^2(horizon elevation) over 32 "
            "azimuths — the cosine-weighted solid-angle fraction for a horizontal "
            "surface, which reduces exactly to the infinite-canyon closed form "
            "cos(atan(2H/W)). The commonly quoted mean(1 - sin(beta)) form "
            "under-estimates SVF by about 35% and is not used. Facades use Hottel's "
            "infinite-strip weighting (1 - sin(alpha))/2 instead, because a vertical "
            "surface has a different view factor from a horizontal one."
        ),
        "validation": (
            "Run `python -m heatcanyon.cli validate`. The checks cover the raster "
            "sky view factor against the analytic canyon solution, the solar "
            "reconstruction against ERA5, the timezone convention against an "
            "independently fetched daily maximum, the vectorised year solver against "
            "the scalar engine element for element, the bias correction's residuals, "
            "the day-within-month sensitivity against a full re-solve, and the "
            "scenario responses against published effect ranges. The horizontal air "
            "temperature field can be checked against NYC's 84 Manhattan street "
            "sensors; the vertical dimension cannot be checked against anything."
        ),
        "shading": (
            "The event day and the twelve monthly days ray-march the 3 m surface "
            "model for shadows. The 8,760-hour accumulation uses the closed form for "
            "the shadow the opposite wall casts up a facade, because ray-marching "
            "8,760 solar positions is about two hours of work. The two are compared "
            "on the event day and the disagreement published: see "
            "meta.json year.shading_discrepancy. It can only appear in the ground "
            "band, and it means annual sunlit hours are a slight over-estimate at "
            "corners, plazas and intersections."
        ),
        "timezone": (
            "FortyGuard's heatmap endpoint interprets start_time in local standard "
            "time, GMT-5, year-round. New York is on EDT in July, so a start_time of "
            "14:00 is 15:00 wall clock. Established with a control call rather than "
            "assumed, because getting it wrong would put the sun on the wrong facade."
        ),
        "scoring": (
            "Two orderings are published and they disagree, which is the point. The "
            "event-day score weights duration within the heat wave (0.32 dose + 0.20 "
            "persistence) because duration is what the epidemiology links to "
            "mortality. The annual score weights accumulated facade load (0.30 "
            "degree-hours + 0.22 sunlit hours + 0.18 solar dose) because over a year "
            "that is what an intervention changes. Both are multiplied by the same "
            "vulnerability score as a geometric mean, so a building must score on "
            "both exposure and vulnerability to rank. Vulnerability weights the "
            "DOHMH Heat Vulnerability Index at 0.40 and residential units at 0.28."
        ),
        "tile_transfer": (
            "The year's per-tile air temperature is a composite: FortyGuard's "
            "measured within-AOI anomaly pattern for the nearest of the eight bought "
            "hours, carried onto the bias-corrected ERA5 hourly level. The anomaly "
            "was measured on one clear July heat-wave day, and urban heat island "
            "intensity is larger under clear calm conditions, so it is an upper case "
            "and a cloudy winter day's real pattern is flatter. Nothing in it is a "
            "measurement of any of the 364 days FortyGuard did not see."
        ),
    }
    t = (topic or "overview").lower().strip()
    return {
        "topic": t if t in notes else "overview",
        "explanation": notes.get(t, notes["overview"]),
        "available_topics": sorted(notes),
        "figures": {
            "shading_discrepancy": y.get("shading_discrepancy"),
            "sensitivity": y.get("sensitivity"),
            "bias_correction": (y.get("provenance") or {}).get("bias_correction"),
            "ordering_agreement": y.get("ordering_agreement"),
            "annual_fields": y.get("annual_fields"),
        },
        "provenance": d.meta["provenance"],
    }


# ----------------------------------------------------------------- buildings


_SORTS = {
    "priority": lambda b: -b["priority"],
    "exposure": lambda b: -b["exposure"],
    "vulnerability": lambda b: -b["vulnerability"],
    "annual_priority": lambda b: -b["annual"]["priority"],
    "annual_exposure": lambda b: -b["annual"]["exposure"],
    "persistence": lambda b: -b["measured"]["persistence_h"],
    "exceedance": lambda b: -b["measured"]["exceedance_h"],
    "facade_temp": lambda b: -b["modelled"]["facade_peak_c"],
    "annual_facade_kh35": lambda b: -b["annual"]["facade_kh35"],
    "annual_sun_hours": lambda b: -b["annual"]["sun_hours"],
    "annual_swing": lambda b: -b["annual"]["swing_k"],
    "units": lambda b: -(b.get("units") or 0),
    "svf": lambda b: b["measured"]["svf"],
    "height": lambda b: -(b.get("h") or 0),
    "year_built": lambda b: (b.get("year") or 9999),
}


#: The compact fields every one of the 4,044 scored buildings carries, mapped from
#: the query's vocabulary onto the abbreviations `buildings.json` uses. The full
#: dossier fields exist only on the ranked 150, which is why `scope` matters.
_SCORED_FIELDS = {
    "priority": "pr", "exposure": "ex", "vulnerability": "vu",
    "annual_priority": "apr", "annual_exposure": "aex",
    "height": "h", "units": "units", "year_built": "year",
    "annual_sun_hours": "sunh", "annual_swing": "swing",
    "annual_facade_kh35": "akh", "annual_dose_kwh": "adose",
}


def query_buildings_scored(d: Dataset, limit: int = 10,
                           sort_by: str = "annual_priority", **f: Any) -> dict:
    """The same question over ALL 4,044 scored buildings, compact fields only.

    THE RANKED SET IS A SELECTED SAMPLE and this exists because that bites. The
    150 rows with full dossiers were selected by EVENT-DAY priority, so sorting
    them by annual priority reorders a sample chosen on a different criterion. On
    the first live turn the analyst noticed this itself, went to a script, and
    found the true annual leader — which was ranked 62nd on the heat wave and was
    in the sample only by luck. A question about the whole area should not depend
    on that luck, so it gets its own scope.

    What it cannot answer is anything needing a field the compact record does not
    carry: persistence, WBGT, mean radiant temperature, the score decompositions,
    the action list. Those are on the ranked set, and the answer says so.
    """
    rows = [a for a in d.attrs if a.get("in_aoi") and a.get("pr") is not None]

    def keep(a: dict) -> bool:
        checks = (
            (f.get("min_units"), a.get("units") or 0, "ge"),
            (f.get("min_height_m"), a.get("h") or 0, "ge"),
            (f.get("max_height_m"), a.get("h") or 0, "le"),
            (f.get("min_annual_sun_hours"), a.get("sunh") or 0, "ge"),
            (f.get("min_annual_swing_k"), a.get("swing") or 0, "ge"),
            (f.get("min_annual_priority"), a.get("apr") or 0, "ge"),
            (f.get("min_annual_kh35"), a.get("akh") or 0, "ge"),
        )
        for want, have, op in checks:
            if want is None:
                continue
            if op == "ge" and have < want:
                return False
            if op == "le" and have > want:
                return False
        if f.get("built_before") is not None:
            if not (a.get("year") and a["year"] < f["built_before"]):
                return False
        if f.get("built_after") is not None:
            if not (a.get("year") and a["year"] > f["built_after"]):
                return False
        if f.get("residential_only") and not (a.get("units") or 0) > 0:
            return False
        if f.get("month_of_peak") is not None and a.get("mop") != int(f["month_of_peak"]):
            return False
        if f.get("address_contains"):
            if str(f["address_contains"]).lower() not in (a.get("addr") or "").lower():
                return False
        if f.get("zip") and str(f["zip"]) != str(a.get("zip") or ""):
            return False
        return True

    ignored = sorted(k for k in f if k not in (
        "min_units", "min_height_m", "max_height_m", "min_annual_sun_hours",
        "min_annual_swing_k", "min_annual_priority", "min_annual_kh35",
        "built_before", "built_after",
        "residential_only", "month_of_peak", "address_contains", "zip")
        and f[k] is not None)

    sel = [a for a in rows if keep(a)]
    key = _SCORED_FIELDS.get(sort_by, "apr")
    sel.sort(key=lambda a: -(a.get(key) or 0))
    limit = max(1, min(int(limit or 10), 60))
    return {
        "scope": "scored",
        "matched": len(sel),
        "of_scored": len(rows),
        "sorted_by": sort_by if sort_by in _SCORED_FIELDS else "annual_priority",
        "available_sorts": sorted(_SCORED_FIELDS),
        "returned": min(limit, len(sel)),
        "buildings": [{
            "bin": a.get("bin"), "address": a.get("addr"),
            "rank_wave": a.get("pr_rank"), "rank_annual": a.get("apr_rank"),
            "priority": a.get("pr"), "exposure": a.get("ex"),
            "vulnerability": a.get("vu"),
            "annual_priority": a.get("apr"), "annual_exposure": a.get("aex"),
            "height_m": a.get("h"), "floors": a.get("floors"),
            "year_built": a.get("year"), "residential_units": a.get("units"),
            "zip": a.get("zip"), "land_use": a.get("use"),
            "annual_sun_hours": a.get("sunh"), "annual_swing_k": a.get("swing"),
            "annual_facade_kh35": a.get("akh"), "annual_dose_kwh": a.get("adose"),
            "month_of_peak": a.get("mop"),
            "lon": a.get("lon"), "lat": a.get("lat"),
            "in_ranked_set": str(a.get("bin")) in d.ranked_by_bin,
        } for a in sel[:limit]],
        "ignored_filters": ignored,
        "note": (
            "Every building scored inside the AOI, using the compact fields. "
            + (f"These filters need the full dossier and were IGNORED here: "
               f"{ignored}. Re-run with scope='ranked' for them. " if ignored else "")
            + "Persistence, WBGT, mean radiant temperature, the score "
              "decompositions and the action list live on the ranked 150 only; call "
              "get_building for any of these BINs to get them where they exist."
        ),
    }


def query_buildings(d: Dataset, limit: int = 10, sort_by: str = "priority",
                    scope: str = "ranked", **f: Any) -> dict:
    """Filter and sort the scored buildings. Thresholds combine with AND."""
    if scope == "scored":
        return query_buildings_scored(d, limit=limit, sort_by=sort_by, **f)
    rows = d.ranked["items"]

    def keep(b: dict) -> bool:
        a = b.get("annual") or {}
        m, mo = b["measured"], b["modelled"]
        checks = (
            (f.get("min_persistence_h"), m["persistence_h"], "ge"),
            (f.get("min_exceedance_h"), m["exceedance_h"], "ge"),
            (f.get("max_svf"), m["svf"], "le"),
            (f.get("min_svf"), m["svf"], "ge"),
            (f.get("min_units"), b.get("units") or 0, "ge"),
            (f.get("min_hvi"), b.get("hvi") or 0, "ge"),
            (f.get("min_facade_peak_c"), mo["facade_peak_c"], "ge"),
            (f.get("min_wbgt_c"), mo["wbgt_peak_c"], "ge"),
            (f.get("min_height_m"), b.get("h") or 0, "ge"),
            (f.get("max_height_m"), b.get("h") or 0, "le"),
            (f.get("min_annual_kh35"), a.get("facade_kh35", 0), "ge"),
            (f.get("min_annual_sun_hours"), a.get("sun_hours", 0), "ge"),
            (f.get("min_annual_swing_k"), a.get("swing_k", 0), "ge"),
            (f.get("min_annual_priority"), a.get("priority", 0), "ge"),
        )
        for want, have, op in checks:
            if want is None:
                continue
            if op == "ge" and have < want:
                return False
            if op == "le" and have > want:
                return False
        if f.get("built_before") is not None:
            if not (b.get("year") and b["year"] < f["built_before"]):
                return False
        if f.get("built_after") is not None:
            if not (b.get("year") and b["year"] > f["built_after"]):
                return False
        if f.get("residential_only") and not (b.get("units") or 0) > 0:
            return False
        if f.get("month_of_peak") is not None:
            if (b.get("annual") or {}).get("month_of_peak") != int(f["month_of_peak"]):
                return False
        if f.get("land_use_name"):
            k = str(f["land_use_name"]).lower()
            if k not in (b.get("use_name") or "").lower():
                return False
        if f.get("zip"):
            if str(f["zip"]) != str(b.get("zip") or ""):
                return False
        if f.get("address_contains"):
            if str(f["address_contains"]).lower() not in (b.get("addr") or "").lower():
                return False
        return True

    sel = [b for b in rows if keep(b)]
    key = _SORTS.get(sort_by, _SORTS["priority"])
    sel.sort(key=key)
    limit = max(1, min(int(limit or 10), 60))
    return {
        "scope": "ranked",
        "matched": len(sel),
        "of_ranked": len(rows),
        "of_scored": d.ranked["n_scored"],
        "sorted_by": sort_by if sort_by in _SORTS else "priority",
        "available_sorts": sorted(_SORTS),
        "returned": min(limit, len(sel)),
        "buildings": [_brief(d, b) for b in sel[:limit]],
        "ranked_set_note": (
            f"THIS IS A SELECTED SAMPLE. The ranked set holds the top {len(rows)} "
            f"buildings by EVENT-DAY priority out of {d.ranked['n_scored']} scored, "
            f"so sorting it by an annual field reorders a sample that was chosen on "
            f"a different criterion, and a filter matching nothing here may still "
            f"match buildings outside it. For any question about the whole study "
            f"area — and for every annual ordering — pass scope='scored'."
        ),
    }


def _brief(d: Dataset, b: dict) -> dict:
    a = b.get("annual") or {}
    return {
        "bin": b["bin"], "address": b["addr"],
        "rank_wave": d.ranked_by_bin.get(str(b["bin"]), {}).get("rank"),
        "priority": b["priority"], "exposure": b["exposure"],
        "vulnerability": b["vulnerability"],
        "annual_priority": a.get("priority"), "annual_exposure": a.get("exposure"),
        "floors": b["floors"], "height_m": b["h"], "year_built": b["year"],
        "residential_units": b.get("units"), "zip": b.get("zip"),
        "hvi": b.get("hvi"), "land_use": b.get("use_name"),
        "lon": b.get("lon"), "lat": b.get("lat"),
        "measured": b["measured"], "modelled": b["modelled"],
        "annual": {k: a.get(k) for k in
                   ("facade_kh35", "sun_hours", "dose_kwh", "facade_max_c",
                    "summer_mean_c", "winter_mean_c", "swing_k", "month_of_peak")},
    }


def get_building(d: Dataset, bin_or_address: str) -> dict:
    """Full dossier for one building, plus its own monthly profile."""
    q = str(bin_or_address).strip().lower()
    hit = None
    for b in d.ranked["items"]:
        if str(b["bin"]) == q or (b["addr"] or "").lower() == q:
            hit = b
            break
    if hit is None:
        for b in d.ranked["items"]:
            if q and q in (b["addr"] or "").lower():
                hit = b
                break
    if hit is None:
        # Not in the ranked 150, but it may still be a building we scored.
        idx = d.bin_to_index.get(q)
        if idx is not None:
            a = d.attrs[idx]
            return {
                "in_ranked_set": False,
                "attrs": a,
                "note": ("This building was scored but is outside the ranked top "
                         f"{len(d.ranked['items'])}, so it has no full dossier. Its "
                         "scores and annual summary are in `attrs`."),
                "panels": int(len(d.panels_of_building.get(idx, ()))),
            }
        return {"error": f"No building matching {bin_or_address!r}."}

    idx = d.bin_to_index.get(str(hit["bin"]))
    panels = (d.panels_of_building.get(idx, np.zeros(0, dtype=int))
              if idx is not None else np.zeros(0, dtype=int))
    out = dict(hit)
    out["in_ranked_set"] = True
    # Two different ranks, and conflating them was a real confusion on the first
    # live turn: the agent computed an annual rank of 98 over all 4,044 scored
    # buildings while this field said 39, because this one ranks within the 150.
    # Both are now named for their population, and the population-wide ranks come
    # from the pipeline, which computed them over everything it scored.
    attr = d.attrs[idx] if idx is not None else {}
    out["rank_wave_of_scored"] = attr.get("pr_rank")
    out["rank_annual_of_scored"] = attr.get("apr_rank")
    out["scored_population"] = d.ranked["n_scored"]
    out["rank_wave"] = d.ranked_by_bin.get(str(hit["bin"]), {}).get("rank")
    order = d.ranked["orderings"]["annual"]
    try:
        out["rank_annual_within_ranked_150"] = 1 + order.index(
            d.ranked["items"].index(hit))
    except ValueError:
        out["rank_annual_within_ranked_150"] = None
    out["rank_note"] = (
        "rank_wave and rank_annual_of_scored are over all "
        f"{d.ranked['n_scored']} scored buildings. "
        "rank_annual_within_ranked_150 is only within the 150 that carry full "
        "dossiers, which were selected by event-day priority. Quote the "
        "*_of_scored ranks unless you mean the sample."
    )
    out["panels"] = int(len(panels))
    if len(panels):
        out["facade_orientations"] = _orientation_breakdown(d, panels)
        out["worst_panel"] = _worst_panel(d, panels)
    out["canyon"] = _canyon_of_building(d, panels)
    return out


def _orientation_breakdown(d: Dataset, panels: np.ndarray) -> list[dict]:
    """How much wall faces each way, and what the year does to each aspect."""
    az = d.panel_azimuth[panels]
    length = d.panel_length[panels]
    sun = d.plane("sun_hours")[panels].mean(axis=1)
    kh = d.plane("degree_hours_35")[panels].mean(axis=1)
    out = []
    for name, lo, hi in (("N", 315, 45), ("E", 45, 135), ("S", 135, 225), ("W", 225, 315)):
        sel = ((az >= lo) & (az < hi)) if lo < hi else ((az >= lo) | (az < hi))
        if not sel.any():
            continue
        out.append({
            "aspect": name,
            "wall_length_m": round(float(length[sel].sum()), 1),
            "annual_sun_hours_mean": round(float(sun[sel].mean()), 1),
            "annual_degree_hours_35_mean": round(float(kh[sel].mean()), 1),
        })
    out.sort(key=lambda r: -r["annual_degree_hours_35_mean"])
    return out


def _worst_panel(d: Dataset, panels: np.ndarray) -> dict:
    kh = d.plane("degree_hours_35")[panels]
    p, b = np.unravel_index(int(np.argmax(kh)), kh.shape)
    gp = int(panels[p])
    return {
        "panel": gp, "band": int(b),
        "height_above_base_m": round(float(d.band_z[gp, b]), 1),
        "azimuth_deg": round(float(d.panel_azimuth[gp]), 1),
        "sky_view_factor": round(float(d.svf_bands[gp, b]), 3),
        "annual_degree_hours_35": round(float(kh[p, b]), 1),
        "annual_sun_hours": round(float(d.plane("sun_hours")[gp, b]), 1),
        "annual_max_c": round(float(d.plane("t_max")[gp, b]), 1),
        "month_of_max": int(d.plane("month_of_max")[gp, b]),
    }


def _canyon_of_building(d: Dataset, panels: np.ndarray) -> dict | None:
    if not len(panels):
        return None
    ids = d.panel_canyon[panels]
    ids = ids[ids >= 0]
    if not len(ids):
        return None
    vals, counts = np.unique(ids, return_counts=True)
    c = d.canyon_by_index.get(int(vals[int(np.argmax(counts))]))
    return c


# ------------------------------------------------------------------- streets


def canyon_stats(d: Dataset, name_contains: str | None = None,
                 limit: int = 12, sort_by: str = "sections") -> dict:
    """Street-canyon morphology aggregated per street, with the year attached."""
    rows = [c for c in d.canyons if c["canyon"]]
    if name_contains:
        k = name_contains.strip().upper()
        rows = [c for c in rows if k in (c["name"] or "").upper()]
    if not rows:
        return {"matched": 0, "streets": [],
                "note": "No enclosed canyon cross-sections matched that name."}

    by: dict[str, list[dict]] = {}
    for c in rows:
        by.setdefault(c["name"] or "(unnamed)", []).append(c)

    # Panels belonging to each street, so the annual facade load can be reported
    # per street rather than only per building.
    canyon_to_street: dict[int, str] = {}
    for name, cs in by.items():
        for c in cs:
            canyon_to_street[int(c["i"])] = name
    street_of_panel = np.array(
        [canyon_to_street.get(int(ci), "") for ci in d.panel_canyon], dtype=object)

    sun = d.plane("sun_hours").mean(axis=1)
    kh = d.plane("degree_hours_35").mean(axis=1)
    swing = d.plane("swing").mean(axis=1)

    def med(v):
        v = sorted(x for x in v if x is not None)
        return round(v[len(v) // 2], 3) if v else None

    out = []
    for name, cs in by.items():
        sel = street_of_panel == name
        out.append({
            "street": name, "cross_sections": len(cs),
            "width_facade_to_facade_m": med([c["w"] for c in cs]),
            "width_curb_to_curb_m": med([c["w_curb"] for c in cs if c["w_curb"]]),
            "wall_height_m": med([(c["hl"] + c["hr"]) / 2 for c in cs]),
            "aspect_ratio_hw": med([c["hw"] for c in cs]),
            "sky_view_factor": med([c["svf"] for c in cs]),
            "asymmetry": med([c["asym"] for c in cs]),
            "bearing_deg": med([c["bearing"] for c in cs]),
            "tree_cover": med([c["trees"] for c in cs]),
            "facade_panels": int(sel.sum()),
            "annual_sun_hours_mean": round(float(sun[sel].mean()), 1) if sel.any() else None,
            "annual_degree_hours_35_mean": round(float(kh[sel].mean()), 1) if sel.any() else None,
            "annual_swing_k_mean": round(float(swing[sel].mean()), 2) if sel.any() else None,
        })
    keyf = {
        "sections": lambda r: -(r["cross_sections"] or 0),
        "aspect": lambda r: -(r["aspect_ratio_hw"] or 0),
        "svf": lambda r: (r["sky_view_factor"] or 1),
        "annual_load": lambda r: -(r["annual_degree_hours_35_mean"] or 0),
        "sun_hours": lambda r: -(r["annual_sun_hours_mean"] or 0),
        "trees": lambda r: (r["tree_cover"] or 0),
    }.get(sort_by, lambda r: -(r["cross_sections"] or 0))
    out.sort(key=keyf)
    return {
        "matched": len(rows), "streets": out[:max(1, min(int(limit or 12), 60))],
        "sorted_by": sort_by, "available_sorts": ["sections", "aspect", "svf",
                                                  "annual_load", "sun_hours", "trees"],
        "kind": {"morphology": MEASURED, "annual_columns": MODELLED},
    }


# ---------------------------------------------------------------- the year


_DAY_METRICS = ("tmax", "tmin", "tmean", "h35", "h32", "kh35", "trop", "cdd",
                "hdd", "ghi_kwh", "rh", "wind", "cloud", "precip", "dni_peak",
                "daylight", "noon_alt", "tmax_h")
_HOURLY = {"t_air_c": "year_t_air", "t_air_raw_c": "year_t_air_raw",
           "apparent_c": "year_apparent", "rh": "year_rh", "wind_ms": "year_wind",
           "cloud": "year_cloud", "ghi": "year_ghi", "dni": "year_dni",
           "dhi": "year_dhi"}


def year_series(d: Dataset, metric: str = "tmax", resolution: str = "daily",
                start: str | None = None, end: str | None = None,
                month: int | None = None) -> dict:
    """A series out of the study year, daily / monthly / hourly.

    The whole point of the year being on the platform: ask for one number as a
    function of time and get every value, not a summary of them.
    """
    if resolution == "hourly":
        attr = _HOURLY.get(metric)
        if attr is None:
            if metric in ("facade_mean_c", "facade_lit_fraction"):
                vals = d.year["hourly"][metric]
                return {
                    "metric": metric, "resolution": "hourly",
                    "n": len(vals), "values": vals,
                    "stride": d.year["hourly"].get("facade_stride", 1),
                    "kind": MODELLED,
                    "note": ("Scene-mean facade surface temperature per solved hour "
                             "of the annual accumulation. Indexed by solved hour, "
                             "not by calendar hour, when the stride is not 1."),
                }
            return {"error": f"no hourly metric {metric!r}",
                    "available": sorted(list(_HOURLY) + ["facade_mean_c",
                                                         "facade_lit_fraction"])}
        arr = getattr(d, attr)
        idx = np.arange(len(arr))
        if month is not None:
            keep = np.array([d.days[i]["month"] == int(month)
                             for i in d.year_day_index])
            idx = idx[keep]
        if start or end:
            lo = d.date_to_day.get(start or d.days[0]["date"], 0)
            hi = d.date_to_day.get(end or d.days[-1]["date"], len(d.days) - 1)
            keep = (d.year_day_index >= lo) & (d.year_day_index <= hi)
            idx = idx[keep[idx]]
        return {
            "metric": metric, "resolution": "hourly", "n": int(len(idx)),
            "dates": [d.days[int(d.year_day_index[i])]["date"] for i in idx[:2000]],
            "hours": [int(d.year_hour_of_day[i]) for i in idx[:2000]],
            "values": [round(float(arr[i]), 2) for i in idx[:2000]],
            "truncated": bool(len(idx) > 2000),
            "stats": _stats(arr[idx]),
            "kind": REANALYSIS,
        }

    if resolution == "monthly":
        if metric not in d.months[0]:
            return {"error": f"no monthly metric {metric!r}",
                    "available": sorted(k for k in d.months[0] if k != "diurnal_c")}
        return {
            "metric": metric, "resolution": "monthly",
            "months": [{"month": m["month"], "label": m["label"],
                        "value": m[metric]} for m in d.months],
            "kind": REANALYSIS,
        }

    if metric not in _DAY_METRICS:
        return {"error": f"no daily metric {metric!r}", "available": list(_DAY_METRICS)}
    days = d.days
    if month is not None:
        days = [x for x in days if x["month"] == int(month)]
    if start:
        days = [x for x in days if x["date"] >= start]
    if end:
        days = [x for x in days if x["date"] <= end]
    vals = [x[metric] for x in days]
    return {
        "metric": metric, "resolution": "daily", "n": len(days),
        "window": [days[0]["date"], days[-1]["date"]] if days else None,
        "dates": [x["date"] for x in days],
        "values": vals,
        "stats": _stats(vals),
        "top10": sorted(({"date": x["date"], "value": x[metric]} for x in days),
                        key=lambda r: -(r["value"] or 0))[:10],
        "kind": REANALYSIS,
    }


def climatology(d: Dataset) -> dict:
    """Monthly and seasonal aggregates, the extremes, and the heat-wave episodes."""
    y = d.year
    return {
        "window": y["window"],
        "annual": y["annual"],
        "months": y["months"],
        "seasons": y["seasons"],
        "episodes": y["episodes"],
        "thresholds": y["thresholds"],
        "event_day_in_year": y["event_day_in_year"],
        "hottest_days": sorted(({"date": x["date"], "tmax": x["tmax"],
                                 "kh35": x["kh35"], "tropical_night": x["trop"]}
                                for x in d.days), key=lambda r: -r["tmax"])[:15],
        "coldest_days": sorted(({"date": x["date"], "tmin": x["tmin"]}
                                for x in d.days), key=lambda r: r["tmin"])[:10],
        "tropical_nights": [x["date"] for x in d.days if x["trop"]],
        "diurnal_range_by_month": [
            {"month": m["month"], "label": m["label"],
             "range_k": round(m["tmax_mean"] - m["tmin_mean"], 2),
             "noon_sun_altitude": m["noon_alt"]} for m in d.months],
        "kind": REANALYSIS,
        "note": ("Every count here is over the bias-corrected ERA5 series for the "
                 "AOI as a whole. Per-tile versions of the same counts are in "
                 "tiles.json under `year`, and those are a composite with "
                 "FortyGuard's measured spatial anomaly."),
    }


def compare_periods(d: Dataset, a: str, b: str, hour_slot: int | None = None) -> dict:
    """Two solved periods, side by side over every panel and band.

    Written as a tool because it is the question the year exists to answer and
    because getting the pairing right — same hour slot, same panels, difference in
    the right direction — is exactly the sort of thing that goes wrong in an
    ad-hoc script.
    """
    pa, pb = d.period(a), d.period(b)
    slots = range(pa.n_hours) if hour_slot is None else [int(hour_slot)]
    rows = []
    for h in slots:
        sa, sb = pa.surface[h], pb.surface[h]
        diff = sb - sa
        rows.append({
            "hour_edt": pa.hours[h]["edt"],
            "a": {"air_c": pa.hours[h]["t_anchor_c"],
                  "sun_alt": pa.hours[h]["sun_alt"],
                  "surface": _stats(sa), "lit_fraction": round(float(pa.lit[h].mean()), 4)},
            "b": {"air_c": pb.hours[h]["t_anchor_c"],
                  "sun_alt": pb.hours[h]["sun_alt"],
                  "surface": _stats(sb), "lit_fraction": round(float(pb.lit[h].mean()), 4)},
            "surface_difference_k": _stats(diff),
            "air_difference_k": round(pb.hours[h]["t_anchor_c"]
                                      - pa.hours[h]["t_anchor_c"], 2),
        })
    return {
        "a": {"period": pa.key, "date": pa.date, "anchor": pa.anchor_source},
        "b": {"period": pb.key, "date": pb.date, "anchor": pb.anchor_source},
        "hours": rows,
        "kind": MODELLED,
        "reading_note": (
            "Differences are b minus a, in kelvin. A large part of any monthly "
            "difference is solar geometry rather than air temperature: the noon sun "
            "is about 26 degrees lower in December than in June over Manhattan, so a "
            "facade that is lit for six hours in July may be lit for none in "
            "January. Compare the lit_fraction rows before attributing a difference "
            "to the weather."
        ),
    }


def panel_field(d: Dataset, plane: str, group_by: str = "aspect",
                period: str | None = None, hour_slot: int | None = None,
                limit: int = 20) -> dict:
    """An annual plane or a solved hour, aggregated the way you ask for.

    ``group_by``: aspect | band | material | street | building | canyon_depth |
    height_band | none.
    """
    if period is not None:
        p = d.period(period)
        h = p.n_hours // 2 if hour_slot is None else int(hour_slot)
        arr = p.surface[h] if plane in ("surface", "thermal") else p.air[h]
        label = f"{p.key} hour {p.hours[h]['edt']:02d}:00 {plane}"
        kind = MODELLED
    else:
        arr = d.plane(plane)
        if arr.ndim == 3:
            return {"error": f"{plane} is (12, panel, band); ask for a month with "
                             f"group_by='month' or index it in a script"}
        label = f"annual {plane}"
        kind = MODELLED

    groups = _grouping(d, group_by)
    if groups is None:
        return {"field": label, "group_by": "none", "stats": _stats(arr), "kind": kind}
    rows = []
    for name, mask in groups:
        sub = arr[mask] if mask.ndim == 1 else arr[mask]
        if not np.size(sub):
            continue
        rows.append({"group": name, "n_cells": int(np.size(sub)), **_stats(sub)})
    rows.sort(key=lambda r: -(r.get("mean") or 0))
    return {"field": label, "group_by": group_by, "groups": rows[:max(1, int(limit))],
            "overall": _stats(arr), "kind": kind}


def _grouping(d: Dataset, how: str):
    """(name, boolean mask over (panel, band)) pairs for a grouping key."""
    P, B = d.n_panel, d.n_band
    if how in ("none", "", None):
        return None
    if how == "aspect":
        az = d.panel_azimuth
        out = []
        for name, lo, hi in (("north", 315, 45), ("east", 45, 135),
                             ("south", 135, 225), ("west", 225, 315)):
            sel = ((az >= lo) & (az < hi)) if lo < hi else ((az >= lo) | (az < hi))
            out.append((name, np.repeat(sel[:, None], B, axis=1)))
        return out
    if how == "band":
        return [(f"band {b} (~{np.median(d.band_z[:, b]):.0f} m)",
                 np.repeat((np.arange(B) == b)[None, :], P, axis=0))
                for b in range(B)]
    if how == "material":
        return [(name, np.repeat((d.panel_material == i)[:, None], B, axis=1))
                for i, name in enumerate(d.materials)]
    if how == "height_band":
        z = d.band_z
        edges = [0, 10, 25, 50, 100, 200, 1e9]
        return [(f"{edges[i]:.0f}-{edges[i+1]:.0f} m" if edges[i + 1] < 1e9
                 else f"above {edges[i]:.0f} m",
                 (z >= edges[i]) & (z < edges[i + 1]))
                for i in range(len(edges) - 1)]
    if how == "canyon_depth":
        hw = np.array([(d.canyon_by_index.get(int(c)) or {}).get("hw", 0.0)
                       if c >= 0 else 0.0 for c in d.panel_canyon])
        edges = [0, 0.5, 1.0, 2.0, 3.0, 1e9]
        return [(f"H/W {edges[i]}-{edges[i+1]}" if edges[i + 1] < 1e9
                 else f"H/W above {edges[i]}",
                 np.repeat(((hw >= edges[i]) & (hw < edges[i + 1]))[:, None], B, axis=1))
                for i in range(len(edges) - 1)]
    if how == "street":
        name_of = np.array([(d.canyon_by_index.get(int(c)) or {}).get("name") or ""
                            if c >= 0 else "" for c in d.panel_canyon], dtype=object)
        top = {}
        for n in name_of:
            if n:
                top[n] = top.get(n, 0) + 1
        best = sorted(top, key=lambda k: -top[k])[:24]
        return [(n, np.repeat((name_of == n)[:, None], B, axis=1)) for n in best]
    if how == "building":
        out = []
        for it in d.ranked["items"][:40]:
            i = d.bin_to_index.get(str(it["bin"]))
            if i is None:
                continue
            ps = d.panels_of_building.get(i)
            if ps is None or not len(ps):
                continue
            mask = np.zeros((P, B), dtype=bool)
            mask[ps, :] = True
            out.append((it["addr"] or str(it["bin"]), mask))
        return out
    raise ValueError(f"unknown group_by {how!r}")


def tile_field(d: Dataset, layer: str = "hours_above_35", top: int = 12) -> dict:
    """The 60 m tile field: a measured hour, or an annual composite metric."""
    if layer in d.tiles.get("year", {}):
        vals = d.tiles["year"][layer]
        pts = d.tiles["exceedance"]
        rows = [{"x": pts[i][0], "y": pts[i][1],
                 "lonlat": [round(v, 6) for v in d.to_lonlat(pts[i][0], pts[i][1])],
                 "value": vals[i]} for i in range(min(len(vals), len(pts)))]
        rows.sort(key=lambda r: -(r["value"] or 0))
        return {"layer": layer, "n_tiles": len(vals), "grid_m": d.tiles["grid_m"],
                "stats": _stats(vals), "hottest": rows[:max(1, int(top))],
                "coolest": rows[-max(1, int(top)):],
                "kind": "composite: FortyGuard measured anomaly on the ERA5 level",
                "note": d.tiles["year_note"]}
    if layer in ("exceedance", "persistence"):
        pts = d.tiles[layer]
        rows = [{"x": p[0], "y": p[1], "value": p[2]} for p in pts]
        rows.sort(key=lambda r: -r["value"])
        return {"layer": layer, "n_tiles": len(pts), "grid_m": d.tiles["grid_m"],
                "stats": _stats([p[2] for p in pts]), "hottest": rows[:int(top)],
                "coolest": rows[-int(top):], "kind": MEASURED}
    return {"error": f"no tile layer {layer!r}",
            "available": ["exceedance", "persistence"] + sorted(d.tiles.get("year", {}))}


def scenario_results(d: Dataset, site_label: str | None = None) -> dict:
    """The precomputed what-if grid: three event hours and twelve months."""
    sites = d.scenarios["sites"]
    if site_label:
        k = site_label.strip().lower()
        sites = [s for s in sites
                 if k in s["label"].lower() or k in (s["name"] or "").lower()] or sites
    return {
        "catalogue": d.scenarios["catalogue"],
        "published_effect_ranges_for_checking": d.scenarios["expected_ranges"],
        "sites": sites,
        "annual_note": d.scenarios["annual_note"],
        "reading_note": (
            "All d_* values are the change from baseline in kelvin, and positive "
            "means the intervention made that metric worse. Cool pavement raising "
            "mean radiant temperature in a deep canyon is a real documented "
            "trade-off, not an error. A positive seasonal_penalty means the measure "
            "does less good in winter than in summer, which for shading is correct "
            "and is its cost. For an intervention at a place or a scale not in this "
            "grid, use run_intervention, which re-solves rather than interpolating."
        ),
        "kind": MODELLED,
    }

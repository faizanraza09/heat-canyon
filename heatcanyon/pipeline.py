"""Orchestration: turn cached inputs into the exact files the web app loads.

Everything expensive happens here, once, offline. The browser receives
pre-solved numbers and never runs physics, so what a judge sees on screen is
provably the same field the validation script checked — there is no second,
simplified model in JavaScript that could quietly disagree with this one.

Outputs, all under ``web/data/``:

  meta.json        study area, projection, hours, provenance, headline stats
  buildings.json   footprints in local metres + attributes + per-building scores
  facades.json     facade panel geometry (flat typed arrays)
  thermal.bin      Int16 surface temperature per panel per band per hour
  air.bin          Int16 air temperature per band per hour, per canyon
  tiles.json       the FortyGuard 2 m field per hour, plus exceedance/persistence
  massing_bid.bin  building index per 3 m cell, for projecting onto other geometry
  massing_h.bin    refined surface height per 3 m cell, decimetres
  ground_elev.bin  ground elevation per 3 m cell, decimetres (streets filled)
  canyons.json     canyon cross-sections with morphology
  ranked.json      the prioritised building list with full score decomposition
  scenarios.json   scenario deltas at representative canyons

And, since the platform shows a year rather than an afternoon:

  year.json        the hourly meteorology, 365 daily records, 12 monthly records,
                   seasons, heat-wave episodes, the bias correction and its residuals
  month_NN/*.bin   twelve solved days, one per month, same shape as the event day's
                   binaries; fetched by the browser only for the month being shown
  annual/*.bin     per-panel-per-band annual totals and extremes
  sens.bin         dT_surface/dT_air per panel per band, for day-within-month scrubbing

  See heatcanyon/tiers.py for what each temporal tier is and is not.
"""

from __future__ import annotations

import json
import math
import struct
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

from . import aoi as aoi_mod
from . import exposure as EX
from . import fg
from . import geometry as G
from . import lidar
from . import nyc
from . import physics as P
from . import scenarios as SC
from . import solar
from . import tiers as T
from . import year as Y
from . import yearsolve as YS

OUT = Path("web/data")

#: The diurnal hours we bought from FortyGuard, as (API GMT-5 hour, wall-clock EDT).
#: Defined once in ``tiers`` so the event day and the twelve monthly days are
#: sampled identically and can be compared hour for hour.
HOURS = T.HOURS
PEAK_INDEX = T.PEAK_INDEX   # 14:00 GMT-5 = 15:00 EDT, the anchor hour
N_BANDS = 10            # facade height bands
# Ten rather than six. Six put a single band across 70 m of a 400 m tower, which
# is coarser than the shadow line it is meant to resolve and visibly faceted at
# street level. Ten costs about 4.7 MB in the browser and a few seconds in the
# solve, and it is the resolution at which a climbing shadow actually reads as a
# gradient rather than a staircase.
STUDY_DATE = (2026, 7, 2)
STUDY_DATE_STR = f"{STUDY_DATE[0]}-{STUDY_DATE[1]:02d}-{STUDY_DATE[2]:02d}"
WAVE = ("2026-06-29", "2026-07-05")
THRESHOLD_C = 35.0

#: Every hour of the year is solved by default. A stride is offered because the
#: annual accumulation is the one part of this build measured in minutes rather
#: than seconds, and a developer changing the renderer should not have to pay for
#: it on every run. Anything but 1 is recorded in meta.json, so a shipped build
#: cannot quietly be a sampled one.
YEAR_STRIDE = 1


# ------------------------------------------------------------------ helpers


def _tiles(fetch: fg.Fetch) -> list[dict]:
    return fetch.result.get("map_data", {}).get("features", [])


class TileField:
    """Nearest-tile lookup over a FortyGuard heatmap layer.

    The tiles are a regular lattice, so a hash on rounded centroid coordinates
    is both exact and far faster than a spatial index. Falls back to a linear
    nearest search only for points outside the lattice.
    """

    def __init__(self, features: list[dict], field: str) -> None:
        self.pts: list[tuple[float, float, float]] = []
        for f in features:
            v = f["properties"].get(field)
            if v is None:
                continue
            ring = f["geometry"]["coordinates"][0]
            lon = sum(p[0] for p in ring[:-1]) / max(len(ring) - 1, 1)
            lat = sum(p[1] for p in ring[:-1]) / max(len(ring) - 1, 1)
            self.pts.append((lon, lat, float(v)))
        self.arr = np.array([[p[0], p[1]] for p in self.pts]) if self.pts else np.zeros((0, 2))
        self.vals = np.array([p[2] for p in self.pts]) if self.pts else np.zeros(0)

    def at(self, lon: float, lat: float) -> float:
        if not len(self.vals):
            return float("nan")
        d = (self.arr[:, 0] - lon) ** 2 + ((self.arr[:, 1] - lat) * 1.3) ** 2
        return float(self.vals[int(np.argmin(d))])

    def at_many(self, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
        if not len(self.vals):
            return np.full(len(lons), np.nan)
        out = np.empty(len(lons))
        for i in range(len(lons)):
            d = (self.arr[:, 0] - lons[i]) ** 2 + ((self.arr[:, 1] - lats[i]) * 1.3) ** 2
            out[i] = self.vals[int(np.argmin(d))]
        return out

    @property
    def stats(self) -> dict:
        if not len(self.vals):
            return {}
        v = self.vals
        return {
            "min": float(v.min()), "max": float(v.max()),
            "mean": float(v.mean()), "median": float(np.median(v)),
            "p10": float(np.percentile(v, 10)), "p90": float(np.percentile(v, 90)),
            "n": int(len(v)),
        }


def _event_day_indices(ym: "Y.YearMet") -> list[int]:
    """The 24 hourly indices of the study day inside the year series."""
    try:
        return [int(i) for i in ym.day_slice(STUDY_DATE_STR)]
    except ValueError:
        return list(range(24))


def _nearest_hour_slot(hour_edt: int) -> int:
    """Which of the eight bought hours stands for a given wall-clock hour.

    Cyclic nearest: hour 1 belongs to the 00:00 slot, not the 03:00 one. Written
    out because getting it wrong puts the pre-dawn anomaly on the afternoon and
    silently inverts the spatial pattern for a third of every day.
    """
    best, best_d = 0, 99
    for i, (_g5, edt) in enumerate(HOURS):
        d = min((hour_edt - edt) % 24, (edt - hour_edt) % 24)
        if d < best_d:
            best, best_d = i, d
    return best


def _spearman(a, b) -> float:
    """Spearman rank correlation. Both inputs are already ranks."""
    x = np.asarray(a, dtype=np.float64)
    y = np.asarray(b, dtype=np.float64)
    if x.size < 3:
        return float("nan")
    x = x - x.mean(); y = y - y.mean()
    den = math.sqrt(float((x * x).sum()) * float((y * y).sum()))
    return round(float((x * y).sum() / den), 4) if den else float("nan")


def _plane_stats(arr) -> dict:
    """Min / mean / percentiles of one annual plane, for the legend and the agent."""
    a = np.asarray(arr, dtype=np.float64).reshape(-1)
    a = a[np.isfinite(a)]
    if not a.size:
        return {}
    return {
        "min": round(float(a.min()), 3), "max": round(float(a.max()), 3),
        "mean": round(float(a.mean()), 3), "median": round(float(np.median(a)), 3),
        "p05": round(float(np.percentile(a, 5)), 3),
        "p95": round(float(np.percentile(a, 95)), 3),
        "n": int(a.size),
    }


def _q16(values, scale: float = 100.0, *, name: str = "") -> bytes:
    """Quantise to Int16. 0.01 K precision is far finer than the model's skill.

    Raises rather than clipping. Silent clipping cost a whole annual plane: the
    facade sunlit-hours field at a scale of 10 saturated at 3,276.7 hours, and
    because 3,276.7 is a plausible-looking number for "sunlit hours per year" the
    field looked fine in every summary statistic — only the suspiciously round
    maximum gave it away. A quantisation that cannot represent its input is a
    build error, not a rounding.
    """
    a = np.asarray(values, dtype=np.float64) * scale
    lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
    if lo < -32768 or hi > 32767:
        raise ValueError(
            f"_q16 overflow{f' on {name}' if name else ''}: scaled range "
            f"{lo:.1f}..{hi:.1f} does not fit Int16 at scale {scale:g}. "
            f"Lower the scale or use _q16u.")
    return np.round(a).astype("<i2").tobytes()


def _q16u(values, scale: float = 1.0, *, name: str = "") -> bytes:
    """Quantise a non-negative field to UInt16 — twice the headroom of Int16.

    The annual counting and dose planes are all non-negative and all have ranges
    an Int16 cannot hold at a useful precision: 4,400 sunlit hours, 800 kWh/m2 of
    incident shortwave, tens of thousands of degree-hours. Spending the sign bit
    on them was the whole problem.
    """
    a = np.asarray(values, dtype=np.float64) * scale
    lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
    if lo < 0 or hi > 65535:
        raise ValueError(
            f"_q16u overflow{f' on {name}' if name else ''}: scaled range "
            f"{lo:.1f}..{hi:.1f} does not fit UInt16 at scale {scale:g}.")
    return np.round(a).astype("<u2").tobytes()


# ------------------------------------------------------------------- driver


def build(area_key: str = "midtown", verbose: bool = True,
          use_lidar: bool = True, year_stride: int = YEAR_STRIDE) -> dict:
    t_start = time.time()
    area = aoi_mod.get(area_key)
    proj = G.Projector(area)
    OUT.mkdir(parents=True, exist_ok=True)

    def log(msg: str) -> None:
        if verbose:
            print(f"  {msg}", flush=True)

    log(f"study area: {area.label}  {area.area_km2:.2f} km2")

    # ---------------------------------------------------------- free inputs
    buildings = nyc.footprints(area)
    lines = nyc.centerlines(area)
    lots = nyc.pluto(area)
    hvi = nyc.hvi_by_zcta()
    trees = nyc.trees(area)
    log(f"NYC: {len(buildings):,} footprints, {len(lines):,} street segments, "
        f"{len(lots):,} lots, {len(trees):,} trees")

    # ------------------------------------------------------- FortyGuard cache
    g = fg.CachedFortyGuard(allow_live=False, verbose=False)
    hourly: list[TileField] = []
    for gmt5, _edt in HOURS:
        f = g.heatmap(area=area, start_date=f"{STUDY_DATE[0]}-{STUDY_DATE[1]:02d}-{STUDY_DATE[2]:02d}",
                      filter_type=1, start_time=f"{gmt5:02d}:00", granularity=60,
                      analytic_type="tcm", label=f"{area.key}_tcm_h{gmt5:02d}")
        hourly.append(TileField(_tiles(f), "average_temperature"))
    fullday = g.heatmap(area=area, start_date="2026-07-02", filter_type=3, granularity=60,
                        analytic_type="tcm", label=f"{area.key}_tcm_fullday")
    exc = g.heatmap(area=area, start_date=WAVE[0], end_date=WAVE[1], filter_type=4,
                    granularity=60, analytic_type="exceedance", threshold=THRESHOLD_C,
                    direction="above", label=f"{area.key}_exceedance_35C")
    per = g.heatmap(area=area, start_date=WAVE[0], end_date=WAVE[1], filter_type=4,
                    granularity=60, analytic_type="persistence", threshold=THRESHOLD_C,
                    direction="above", label=f"{area.key}_persistence_35C")
    f_exc = TileField(_tiles(exc), "value")
    f_per = TileField(_tiles(per), "value")
    f_daymax = TileField(_tiles(fullday), "max_temperature")
    f_daymin = TileField(_tiles(fullday), "min_temperature")
    log(f"FortyGuard: {len(HOURS)} hourly layers + exceedance + persistence + full day")

    # -------------------------------------------------- environmental series
    env = g.env_params(latitude=40.7536, longitude=-73.9832, temperature=35.0,
                       start_date="2026-07-02", filter_type=3,
                       label="midtown_env_bryant_park_2026-07-02")
    env_params = env.result["locations"][0]["parameters"]

    om = json.loads(Path("data/manhattan/_openmeteo_radiation_2026-07-02.json").read_text())["hourly"]

    # --------------------------------------------------------------- geometry
    # Two surface models, deliberately. The flat extrusion is what the footprint
    # table supports on its own: one lid per polygon at ``height_roof``. The
    # refined model replaces those lids with the roof profile the 2017 airborne
    # LiDAR actually measured, so Midtown's setbacks are present instead of
    # erased. See heatcanyon/lidar.py for why the cloud is the only free source
    # that can do this and how the two are reconciled.
    dsm_flat = G.rasterize_dsm(buildings, proj, res=3.0)

    # Macdonald's H is the mean *roof* height of the array, and it has to be
    # read off the flat model. Taken from the refined surface it would be the
    # mean surface elevation instead — 62.8 m rather than 75.1 m here, because
    # a setback shoulder lowers the average without lowering any roof — and
    # that would feed an understated displacement height and roughness length
    # into every wind profile downstream. The refinement belongs in sky view and
    # shadowing, not in the bulk roughness scalars.
    h_bar = dsm_flat.mean_building_height

    dsm, lidar_report = dsm_flat, None
    if use_lidar:
        surf = lidar.surface_for(dsm_flat, proj, log=log)
        # Whether anything independent vouches for each footprint's height.
        # A BBL carrying a PLUTO floor count is one whose join to the tax lot
        # worked; the truncated footprints are the ones joined to the viaduct or
        # rail yard beneath them, which has no floors. See refine_dsm.
        height_trusted = [
            bool((lots.get(b.get("bbl") or "") or {}).get("floors"))
            for b in buildings
        ]
        dsm, lidar_report = lidar.refine_dsm(
            dsm_flat, surf, buildings, height_trusted=height_trusted, log=log)

    svf_grid = G.svf_raster(dsm, n_azimuth=32, max_radius_m=250.0)
    lambda_p = dsm.built_fraction
    canyons = G.extract_canyons(lines, dsm, svf_grid, proj)
    facades = G.extract_facades(buildings, proj, min_length_m=6.0, max_panel_m=40.0)
    # Frontal area index, computed from the facade panels rather than reusing the
    # plan area index. Macdonald's roughness length needs the frontal one, and
    # the two are equal only for cubes.
    ny_g, nx_g = dsm.shape
    grid_area = (nx_g * dsm.res) * (ny_g * dsm.res)
    lambda_f = G.frontal_area_index(facades, grid_area)
    d_disp, z0 = G.roughness_length(h_bar, lambda_p, lambda_f)
    log(f"geometry: DSM {dsm.shape} @{dsm.res}m "
        f"({'LiDAR roofs' if use_lidar else 'flat lids'}), "
        f"{len(canyons):,} cross-sections, "
        f"{len(facades):,} facade panels, lambda_p={lambda_p:.3f}, H={h_bar:.0f}m, "
        f"d={d_disp:.0f}m, z0={z0:.2f}m")

    # Tree cover per canyon: count trees within 25 m of the cross-section.
    tree_xy = np.array([proj.to_xy(t["lon"], t["lat"]) for t in trees]) if trees else np.zeros((0, 2))

    # Index canyons on a coarse grid so each facade can find its street fast.
    cgrid: dict[tuple[int, int], list[int]] = {}
    CELL = 40.0
    for i, c in enumerate(canyons):
        cgrid.setdefault((int(c.x // CELL), int(c.y // CELL)), []).append(i)

    def nearest_canyon(x: float, y: float, max_d: float = 90.0) -> int | None:
        best, bd = None, max_d**2
        cx, cy = int(x // CELL), int(y // CELL)
        r = int(max_d // CELL) + 1
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for i in cgrid.get((cx + dx, cy + dy), ()):
                    c = canyons[i]
                    dd = (c.x - x) ** 2 + (c.y - y) ** 2
                    if dd < bd:
                        best, bd = i, dd
        return best

    # ---------------------------------------------- panel -> canyon, material
    n_pan = len(facades)
    pan_canyon = np.full(n_pan, -1, dtype=np.int32)
    pan_material = np.zeros(n_pan, dtype=np.int8)
    MATS = YS.MATS

    for pi, fpanel in enumerate(facades):
        mx, my = fpanel.mid
        nc = nearest_canyon(mx, my) if canyons else None
        pan_canyon[pi] = -1 if nc is None else nc
        b = buildings[fpanel.building]
        mat = P.facade_material(b.get("year"), b["height_m"])
        pan_material[pi] = MATS.index(mat) if mat in MATS else 2

    # Canyon states, cached per canyon so the physics is solved once per street
    # rather than once per panel.
    cstates: list[P.CanyonState] = []
    for c in canyons:
        n_tree = 0
        if len(tree_xy):
            dd = (tree_xy[:, 0] - c.x) ** 2 + (tree_xy[:, 1] - c.y) ** 2
            n_tree = int((dd < 25.0**2).sum())
        st = P.CanyonState(
            svf=c.svf, h_mean=max(c.h_mean, 4.0), width_m=max(c.width_m, 6.0),
            aspect_ratio=c.aspect_ratio, bearing=c.bearing, asymmetry=c.asymmetry,
            lambda_p=lambda_p, d=d_disp, z0=z0,
            tree_cover=min(0.6, n_tree / 12.0),
        )
        cstates.append(st)

    # The whole scene as flat arrays, once. Every tier below solves against this
    # single object, so the event day, the twelve monthly days and the 8,760-hour
    # accumulation cannot be looking at slightly different geometry.
    statics = YS.statics_from_scene(
        facades, canyons, pan_canyon, pan_material, cstates,
        d=d_disp, z0=z0, lambda_p=lambda_p, n_bands=N_BANDS)
    svf_band = statics.svf_wall.astype(np.float32)
    shadows = T.ShadowCache(dsm)
    cell_i, cell_j = T.panel_cells(facades, dsm)

    # ------------------------------------------------------------- the year
    # ERA5 via Open-Meteo, bias-corrected against the one day FortyGuard also
    # covers. See heatcanyon/year.py for why this is the only source that can
    # supply a year of hourly radiation without a credential, and exactly what
    # the correction does and does not claim.
    fg_by_hour: dict[int, float] = {}
    for idx, (gmt5, _edt) in enumerate(HOURS):
        vals = hourly[idx].vals
        if len(vals):
            fg_by_hour[(gmt5 + 1) % 24] = float(np.median(vals))

    raw = Y.load(bias=None)
    era5_by_hour = {}
    for h_edt in fg_by_hour:
        i = raw.index_of(STUDY_DATE_STR, h_edt)
        if i is not None:
            era5_by_hour[h_edt] = float(raw.t_air_raw[i])
    bias = Y.fit_bias(era5_by_hour, fg_by_hour, fitted_on=STUDY_DATE_STR)
    ym = Y.load(bias=bias)
    log(f"year: {ym.start} to {ym.end}, {len(ym):,} hours, "
        f"bias {bias.offsets.min():+.1f} to {bias.offsets.max():+.1f} K by hour")
    year_annual = ym.annual()
    log(f"year: {year_annual['days_above_35']} days over 35 C, "
        f"{year_annual['tropical_nights']} tropical nights, "
        f"{year_annual['hours_above_35']:.0f} hours over 35 C")

    # ------------------------------------------- the event day's meteorology
    # The anchor stays FortyGuard's measured field and the humidity and cloud
    # stay FortyGuard's env series — those are the purchased products and the
    # tier the validation applies to. Wind and radiation come from the year
    # series, which fixes a real units bug: the one-day Open-Meteo cache carries
    # wind in km/h and it was being read straight into Met.wind_10m, which is
    # m/s. A 3.6x wind overstates the convective coefficient h_c = 2 + 3.8u and
    # damps every facade's surface-to-air excess.
    mets: list[P.Met] = []
    suns = []
    for idx, (gmt5, edt) in enumerate(HOURS):
        hour_edt = (gmt5 + 1) % 24
        yi = ym.index_of(STUDY_DATE_STR, hour_edt)
        rh = env_params["relative_humidity_percent"][gmt5]
        cloud = min(1.0, env_params["cloud_cover_octas"][gmt5] / 100.0)
        sun = solar.sun_position(area.center[1], area.center[0],
                                 STUDY_DATE[0], STUDY_DATE[1], STUDY_DATE[2],
                                 hour_edt + 0.5, utc_offset=-4.0)
        anchor = float(np.median(hourly[idx].vals)) if len(hourly[idx].vals) else 35.0
        mets.append(P.Met(
            t_air_2m=anchor, rh_percent=rh,
            wind_10m=float(ym.wind[yi]) if yi is not None else 3.0,
            wind_dir=float(ym.wind_dir[yi]) if yi is not None else 250.0,
            cloud_fraction=cloud,
            dni=float(ym.dni[yi]) if yi is not None else 0.0,
            dhi=float(ym.dhi[yi]) if yi is not None else 0.0,
            hour_edt=float(hour_edt),
        ))
        suns.append(sun)

    log(f"solving {n_pan:,} panels x {N_BANDS} bands x {len(HOURS)} hours "
        f"for the event day...")
    event = T.solve_day(
        label="event", date=STUDY_DATE_STR, mets=mets, suns=suns, st=statics,
        shadows=shadows, cell_i=cell_i, cell_j=cell_j,
        anchor_source="FortyGuard /v1/heatmap 2 m air temperature (measured product)",
        keep_analytic=True, want_terms=True, log=log)
    therm = event.surface
    air_prof = event.air
    air_sig = event.air_sigma
    sunlit_bits = event.lit
    shadows_event = list(event.ground_sun)
    shade_audit = T.shading_discrepancy(event)
    log(f"shading audit: analytic over-estimates the ground band by "
        f"{shade_audit['mean_over_estimate_hours_per_band']:.3f} h per band "
        f"over 8 hours ({shade_audit['ground_band_disagreement_fraction']*100:.2f}% of cells)")

    # ------------------------------------------------ twelve monthly tiers
    month_tiers: list[T.DayTier] = []
    for rec in ym.months:
        m_mets, m_suns = [], []
        yy, mm, dd = (int(rec.rep_date[:4]), int(rec.rep_date[5:7]),
                      int(rec.rep_date[8:10]))
        for gmt5, _edt in HOURS:
            hour_edt = (gmt5 + 1) % 24
            yi = ym.index_of(rec.rep_date, hour_edt)
            if yi is None:
                yi = ym.index_of(rec.rep_date, 12) or 0
            off = float(ym.utc_offset[yi])
            m_suns.append(solar.sun_position(area.center[1], area.center[0],
                                             yy, mm, dd, hour_edt + 0.5,
                                             utc_offset=off))
            m_mets.append(P.Met(
                t_air_2m=float(ym.t_air[yi]), rh_percent=float(ym.rh[yi]),
                wind_10m=float(ym.wind[yi]), wind_dir=float(ym.wind_dir[yi]),
                cloud_fraction=float(ym.cloud[yi]), dni=float(ym.dni[yi]),
                dhi=float(ym.dhi[yi]), hour_edt=float(hour_edt),
            ))
        tier = T.solve_day(
            label=f"{rec.label[:3]} {rec.rep_date}", date=rec.rep_date,
            mets=m_mets, suns=m_suns, st=statics, shadows=shadows,
            cell_i=cell_i, cell_j=cell_j,
            anchor_source="ERA5 reanalysis, bias-corrected (heatcanyon/year.py)",
            want_terms=True)
        month_tiers.append(tier)
        log(f"  month {rec.month:02d} {rec.label[:3]} rep {rec.rep_date} "
            f"(rms {rec.rep_rms_k:.2f} K) surface "
            f"{tier.surface.min():.1f} to {tier.surface.max():.1f} C")
    log(f"shadow cache: {shadows.misses} ray-marches for "
        f"{shadows.misses + shadows.hits} solar positions")

    # ------------------------------------- the day-within-month sensitivity
    probe_hours = [(t.mets[PEAK_INDEX], t.suns[PEAK_INDEX]) for t in month_tiers]
    probe_hours += [(t.mets[1], t.suns[1]) for t in month_tiers[::3]]
    gamma, gamma_report = T.sensitivity(
        mets=[m for m, _ in probe_hours], suns=[s for _, s in probe_hours],
        st=statics)
    log(f"sensitivity dTs/dTair: mean {gamma_report['mean']:.3f} K/K, "
        f"p05-p95 {gamma_report['p05']:.3f}-{gamma_report['p95']:.3f}")

    # ------------------------------------------ audit the day reconstruction
    # 365 solves at one hour, so the interface can print the error of the field it
    # is actually painting instead of a caveat about reconstructions in general.
    recon = T.reconstruction_audit(ym, statics, month_tiers, gamma, log=log)
    for rec in ym.days:
        got = recon.per_day.get(rec.date)
        if got:
            rec.recon_p50_k = got["p50"]
            rec.recon_p95_k = got["p95"]
            rec.recon_solved = bool(got["solved"])
    recon_meta = recon.summary()
    log(f"reconstruction: median day p95 {recon_meta['p95_error_median_k']:.2f} K, "
        f"worst {recon_meta['p95_error_worst_k']:.2f} K on "
        f"{recon_meta['worst_day']['date']} ({recon.seconds:.0f}s)")

    # ---------------------------------------------- the annual accumulation
    log(f"accumulating the year over {len(ym)//max(1,year_stride):,} hours "
        f"(stride {year_stride})...")
    annual = T.accumulate_year(ym, statics, stride=year_stride, log=log)
    log(f"year solved in {annual.seconds:.0f}s: facade sunlit hours "
        f"{annual.sun_hours.mean():.0f} mean, "
        f"{annual.sun_hours.max():.0f} max; degree-hours over 35 C "
        f"{annual.degree_hours_35.mean():.0f} mean")

    # ------------------------------------------------------- write binaries
    # The event day keeps the filenames it has always had, at the top level, so
    # a client that knows nothing about the year still loads exactly what it did
    # before. Each month lands in its own directory with the identical shape, and
    # the browser fetches one month at a time — 4.7 MB when you scrub into
    # October, rather than 56 MB before the first frame.
    sh_step = max(1, int(round(6.0 / dsm.res)))

    def write_day(tier: T.DayTier, dest: Path) -> dict:
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "thermal.bin").write_bytes(_q16(tier.surface.reshape(-1)))
        (dest / "air.bin").write_bytes(_q16(tier.air.reshape(-1)))
        # air_sigma is NOT written per period. The uncertainty on the vertical
        # air profile is a function of height and canyon enclosure only — it does
        # not depend on the hour or the day — so the top-level copy serves every
        # period. It was being written thirteen times, 4.7 MB each, before that
        # was noticed.
        (dest / "sunlit.bin").write_bytes(
            np.packbits(tier.lit.reshape(-1)).tobytes())
        stack = np.stack([g[::sh_step, ::sh_step] for g in tier.ground_sun], axis=0)
        (dest / "ground_sun.bin").write_bytes(
            np.packbits(stack.reshape(-1)).tobytes())
        return {
            "date": tier.date,
            "anchor_source": tier.anchor_source,
            "hours": [{
                "gmt5": g5, "edt": edt,
                "t_anchor_c": round(tier.mets[i].t_air_2m, 2),
                "rh": round(tier.mets[i].rh_percent, 1),
                "cloud": round(tier.mets[i].cloud_fraction, 2),
                "wind_10m": round(tier.mets[i].wind_10m, 2),
                "dni": round(tier.mets[i].dni), "dhi": round(tier.mets[i].dhi),
                "sun_alt": round(tier.suns[i].altitude, 1),
                "sun_az": round(tier.suns[i].azimuth, 1),
                "sky_c": round(tier.mets[i].sky_temperature, 1),
                "surface_min_c": round(float(tier.surface[i].min()), 1),
                "surface_max_c": round(float(tier.surface[i].max()), 1),
                "lit_fraction": round(float(tier.lit[i].mean()), 4),
            } for i, (g5, edt) in enumerate(HOURS)],
        }

    event_meta = write_day(event, OUT)
    # ONE plane, not eight. The uncertainty on the vertical air profile is a
    # function of height and canyon enclosure only, so `DayTier.air_sigma` is the
    # same (panel, band) array repeated once per hour — and writing it that way
    # shipped 4.7 MB where 0.6 MB says the same thing, on every first load, for a
    # chart the visitor may never open.
    (OUT / "air_sigma.bin").write_bytes(_q16(event.air_sigma[0].reshape(-1)))
    # The event day's own copies of the two rasters the top level already carries
    # under different names, so the loader can treat "the event" as a thirteenth
    # selectable period with no special case.
    (OUT / "event").mkdir(parents=True, exist_ok=True)
    for name in ("thermal.bin", "air.bin", "sunlit.bin", "ground_sun.bin"):
        (OUT / "event" / name).write_bytes((OUT / name).read_bytes())

    month_meta = []
    for rec, tier in zip(ym.months, month_tiers):
        d = write_day(tier, OUT / f"month_{rec.month:02d}")
        d.update(month=rec.month, label=rec.label, rep_rms_k=round(rec.rep_rms_k, 3))
        month_meta.append(d)
    _m7 = sorted((OUT / "month_07").iterdir())
    log(f"months: 12 x {len(_m7)} binaries written "
        f"({sum(f.stat().st_size for f in _m7)/1e6:.1f} MB each, "
        f"{', '.join(f.name for f in _m7)})")

    # -------------------------------------------------------- annual planes
    # One file per quantity, all (n_panel, n_band). Int16 at 0.01 precision for
    # temperatures, and a coarser scale for the counting fields whose range is
    # far larger than a kelvin: 4,000 sunlit hours will not fit in an Int16 at
    # centi-precision, so hours are stored at 0.1 h and doses at 0.01 kWh.
    ann = OUT / "annual"
    ann.mkdir(parents=True, exist_ok=True)
    # (scale, dtype). The counting and dose planes are non-negative with ranges an
    # Int16 cannot hold — 4,400 sunlit hours, hundreds of kWh/m2, tens of thousands
    # of degree-hours — so they go to UInt16. Both writers raise on overflow.
    plane_spec = {
        "sun_hours": (4.0, "uint16"),
        "dose_kwh": (20.0, "uint16"),
        "absorbed_kwh": (20.0, "uint16"),
        "degree_hours_35": (1.0, "uint16"),
        "degree_hours_40": (1.0, "uint16"),
        "hours_above_35": (4.0, "uint16"),
        "t_max": (100.0, "int16"), "t_min": (100.0, "int16"),
        "t_mean": (100.0, "int16"), "summer_mean": (100.0, "int16"),
        "winter_mean": (100.0, "int16"), "swing": (100.0, "int16"),
        "winter_sun_share": (10000.0, "uint16"),
    }
    for name, (scale, dtype) in plane_spec.items():
        arr = np.asarray(getattr(annual, name)).reshape(-1)
        writer = _q16u if dtype == "uint16" else _q16
        (ann / f"{name}.bin").write_bytes(writer(arr, scale, name=name))
    # ---- the attribution planes: WHY each band is hot, not just how hot.
    #
    # Taken at each band's OWN hottest hour of the event day rather than at a
    # fixed hour, because the hour a band peaks is itself a function of which way
    # it faces — an east wall peaks at ten and a west wall at five, and reading
    # both at three in the afternoon would attribute the east wall's heat to a
    # sun that had left it four hours earlier.
    #
    # Scaled terms, so the three sum exactly to the observed rise. See
    # physics.SurfaceTerms.scaled.
    if event.dt_solar is not None:
        # TWO SAMPLINGS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT.
        #
        # The first pass took each band's terms at that band's OWN hottest hour,
        # which produced 0.4% trap-dominated across 294,150 panel-bands — and on
        # reflection that number is a tautology rather than a finding. A band is
        # at its hottest *because* the sun is on it; sampling there asks "what
        # made this surface peak" and the answer is always the sun, everywhere,
        # for every facade that gets any sun at all.
        #
        # A prescription is not chosen against one instant. It is chosen against
        # the hours that carry the load, and over those hours a band in a deep
        # slot spends most of its time shaded and hot — hot because the wall
        # opposite is radiating at it, which is a different problem needing a
        # different measure. So the planes the schedule actually selects on are
        # the WORKING means: the terms averaged over the hours this band is
        # above 30 degC, which is the population a cooling system is sized for.
        #
        # Both ship. `_peak` answers "why is this wall's maximum what it is",
        # `_mean` answers "what should be done about it", and confusing the two
        # is how a shading measure gets specified for a floor that never sees
        # the sun.
        surf_e = event.surface
        hottest = np.argmax(surf_e, axis=0)                 # (P,B)
        pick = np.ogrid[:surf_e.shape[1], :surf_e.shape[2]]

        hot = surf_e > 30.0                                 # (H,P,B)
        n_hot = hot.sum(axis=0)
        # A band that never clears 30 degC has no working hours to average, so
        # it falls back to every daylight hour rather than to zero. Zero would
        # read as "no solar driver", which for a north wall in January is nearly
        # true and for a north wall in July is not.
        lit_any = event.lit.any(axis=(1, 2))
        fallback = np.broadcast_to(lit_any[:, None, None], hot.shape)
        use = np.where(n_hot[None, :, :] > 0, hot, fallback)
        w = use.astype(np.float32)
        wsum = np.maximum(w.sum(axis=0), 1e-6)

        def _mean_over(arr):
            return (arr * w).sum(axis=0) / wsum

        term_planes = {
            "dt_solar_peak": event.dt_solar[hottest, pick[0], pick[1]],
            "dt_trap_peak": event.dt_trap[hottest, pick[0], pick[1]],
            "dt_sky_peak": event.dt_sky[hottest, pick[0], pick[1]],
            # The linearisation error at the same hour, published rather than
            # absorbed: the scaled terms above have had it divided out, and a
            # reviewer is entitled to see how large the correction was.
            "dt_residual_peak": event.residual[hottest, pick[0], pick[1]],
            "dt_solar_mean": _mean_over(event.dt_solar),
            "dt_trap_mean": _mean_over(event.dt_trap),
            "dt_sky_mean": _mean_over(event.dt_sky),
        }
        for name, arr in term_planes.items():
            (ann / f"{name}.bin").write_bytes(
                _q16(np.asarray(arr).reshape(-1), 100.0, name=name))
            plane_spec[name] = (100.0, "int16")

        trap_peak = float((term_planes["dt_trap_peak"]
                           > term_planes["dt_solar_peak"]).mean())
        trap_mean = float((term_planes["dt_trap_mean"]
                           > term_planes["dt_solar_mean"]).mean())
        log(f"attribution, at each band's own peak hour: "
            f"solar {term_planes['dt_solar_peak'].mean():.2f} K, "
            f"trap {term_planes['dt_trap_peak'].mean():.2f} K, "
            f"sky {term_planes['dt_sky_peak'].mean():.2f} K; "
            f"{100.0 * trap_peak:.1f}% trap-dominated")
        log(f"attribution, over each band's working hours: "
            f"solar {term_planes['dt_solar_mean'].mean():.2f} K, "
            f"trap {term_planes['dt_trap_mean'].mean():.2f} K, "
            f"sky {term_planes['dt_sky_mean'].mean():.2f} K; "
            f"{100.0 * trap_mean:.1f}% trap-dominated "
            f"(this is the plane the prescription selects on)")

    (ann / "month_of_max.bin").write_bytes(
        annual.month_of_max.astype(np.uint8).reshape(-1).tobytes())
    (ann / "monthly_mean.bin").write_bytes(
        _q16(annual.monthly_mean.reshape(-1), 100.0, name="monthly_mean"))
    (ann / "monthly_sun_hours.bin").write_bytes(
        _q16u(annual.monthly_sun_hours.reshape(-1), 10.0, name="monthly_sun_hours"))
    # dTs/dTair, one byte per panel-band, encoded (gamma - 0.5) * 200 so the byte
    # covers 0.50 to 1.775 K/K at 0.005 resolution. Measured values cluster just
    # above 1.0 — a facade's surface temperature tracks the air almost one for one
    # once the radiation term is fixed, and slightly more than one because a
    # warmer air mass also raises the radiative sky temperature it exchanges with.
    # A plain `gamma * 250` byte would have clipped anything above 1.02, which the
    # upper tail reaches.
    SENS_OFFSET, SENS_SCALE = 0.5, 200.0
    (OUT / "sens.bin").write_bytes(
        np.clip(np.round((gamma - SENS_OFFSET) * SENS_SCALE), 0, 255)
        .astype(np.uint8).reshape(-1).tobytes())
    annual_meta = {
        "hours_solved": annual.hours,
        "stride": annual.stride,
        "sampled": annual.stride != 1,
        "seconds": round(annual.seconds, 1),
        "shading": "analytic canyon form (see heatcanyon/tiers.py)",
        "planes": {name: {"scale": scale, "dtype": dtype}
                   for name, (scale, dtype) in plane_spec.items()},
        "extra_planes": {
            "month_of_max": {"scale": 1, "dtype": "uint8"},
            "monthly_mean": {"scale": 100.0, "dtype": "int16",
                             "shape": [12, "panel", "band"]},
            "monthly_sun_hours": {"scale": 10.0, "dtype": "uint16",
                                  "shape": [12, "panel", "band"]},
        },
        "stats": {
            "sun_hours": _plane_stats(annual.sun_hours),
            "dose_kwh": _plane_stats(annual.dose_kwh),
            "degree_hours_35": _plane_stats(annual.degree_hours_35),
            "t_max": _plane_stats(annual.t_max),
            "swing": _plane_stats(annual.swing),
            "winter_sun_share": _plane_stats(annual.winter_sun_share),
        },
    }

    # Coarse height grid, for collision in the walker. The browser needs to know
    # where the buildings are so a pedestrian cannot stroll through a tower, and
    # re-deriving that from 5,000 polygons client-side would be both slow and a
    # second source of truth. This is the same surface model the physics used,
    # downsampled to 4 m and clamped to one byte per cell.
    step = max(1, int(round(4.0 / dsm.res)))
    coarse = dsm.height[::step, ::step]
    grid = np.clip(np.ceil(coarse), 0, 255).astype(np.uint8)
    (OUT / "heights.bin").write_bytes(grid.tobytes())
    grid_meta = {
        "nx": int(grid.shape[1]), "ny": int(grid.shape[0]),
        "res": round(dsm.res * step, 3),
        "x0": round(dsm.x0, 2), "y0": round(dsm.y0, 2),
    }

    # ------------------------------------------------ the projection grids
    # Two rasters that let the browser answer, for any point in space, "which
    # building is this, and how far up it am I?" — which is what allows the
    # measured facade field to be painted onto a surface this project did not
    # generate, namely Google's photogrammetry mesh.
    #
    # Without them the photoreal layer has to draw our own extruded prisms
    # alongside Google's real geometry, and the two interpenetrate: the prism is
    # the wrong shape, so it stabs through real roofs and leaves real walls
    # poking out of flat colour. Painting the field onto the real surface instead
    # removes the conflict at its source, because there is then only one set of
    # geometry in the frame.
    #
    # uint16 throughout: 65535 marks "no building", and decimetres keep a 400 m
    # tower inside the type with 0.1 m to spare.
    base_of = np.zeros(len(buildings) + 1, dtype=np.float32)
    for _i, _b in enumerate(buildings):
        base_of[_i] = float(_b.get("base_m") or 0.0)
    base_grid_m = base_of[np.where(dsm.building_id >= 0, dsm.building_id, len(buildings))]

    bid_u16 = np.where(dsm.building_id >= 0, dsm.building_id, 65535).astype(np.uint16)
    if int(dsm.building_id.max()) >= 65535:
        raise RuntimeError("building count exceeds the uint16 sentinel")
    (OUT / "massing_bid.bin").write_bytes(bid_u16.tobytes())
    (OUT / "massing_h.bin").write_bytes(
        np.clip(np.round(dsm.height * 10.0), 0, 65535).astype(np.uint16).tobytes()
    )
    # Ground elevation over the whole grid, streets included.
    #
    # Needed because the scene draws on a flat datum but the photoreal layer
    # brings real terrain: without this the first-person walker stands at the
    # datum while Google's road surface is ten metres higher, which puts the
    # camera inside the terrain mesh looking up through it.
    #
    # Derived from the footprint table's ground_elevation rather than from the
    # LiDAR's own class-2 ground, deliberately. Our facades are offset by
    # exactly base_m, so taking the walker's offset from the same quantity means
    # the two cannot disagree; a LiDAR ground would be independently correct and
    # still leave the eye floating relative to our own walls.
    #
    # Buildings carry their own value; the streets between them are filled by
    # nearest-neighbour dilation, which is the right model for Manhattan, where
    # a roadbed sits at the elevation of the lots either side of it.
    # A footprint row with no ground_elevation reads as 0 out of nyc.py, which is
    # sea level and wrong everywhere in Midtown. Seeding it would dilate that
    # zero across the surrounding streets and drop the walker 13 m through the
    # road, so those cells are treated as unknown and inherit from neighbours.
    _seed_ok = (dsm.building_id >= 0) & (base_grid_m > 0.5)
    ground_elev = np.where(_seed_ok, base_grid_m, np.nan)
    for _ in range(80):
        holes = ~np.isfinite(ground_elev)
        if not holes.any():
            break
        filled = ground_elev.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(np.roll(ground_elev, dy, 0), dx, 1)
            take = holes & np.isfinite(shifted)
            filled[take] = shifted[take]
            holes = holes & ~take
        ground_elev = filled
    # Median over *building* cells only. Taken over the whole grid it would be
    # dominated by the streets, which seed as zero, and the handful of cells the
    # dilation cannot reach would be filled with sea level.
    _built_base = base_grid_m[_seed_ok]
    base_median = float(np.median(_built_base)) if _built_base.size else 0.0
    ground_elev = np.nan_to_num(ground_elev, nan=base_median)
    (OUT / "ground_elev.bin").write_bytes(
        np.clip(np.round(ground_elev * 10.0), 0, 65535).astype(np.uint16).tobytes()
    )

    massing_meta = {
        "nx": int(dsm.shape[1]), "ny": int(dsm.shape[0]),
        "res": dsm.res, "x0": round(dsm.x0, 2), "y0": round(dsm.y0, 2),
        "height_scale": 0.1, "no_building": 65535,
        "ground_scale": 0.1,
        "datum_m": round(base_median, 2),
    }

    # Wall sky view factor, one byte per band. A facade deep in a canyon sees
    # almost no sky, and rendering that as genuine darkening is what makes a
    # street read as a canyon rather than a corridor of lit boxes.
    (OUT / "svf_bands.bin").write_bytes(
        np.clip(np.round(svf_band / 0.5 * 255.0), 0, 255).astype(np.uint8).tobytes()
    )

    # Cast shadows on the ground, per hour, from the same ray-traced masks the
    # physics used. Painting these onto the ground plane is exact rather than
    # decorative: it is the identical geometry that decided which facade bands
    # were sunlit. Already written per period by `write_day`; the metadata block
    # is assembled here because it describes the grid, which is shared.
    sh_stack = np.stack([sh[::sh_step, ::sh_step] for sh in shadows_event], axis=0)
    shadow_meta = {
        "nx": int(sh_stack.shape[2]), "ny": int(sh_stack.shape[1]),
        "res": round(dsm.res * sh_step, 3),
        "x0": round(dsm.x0, 2), "y0": round(dsm.y0, 2),
        "hours": int(sh_stack.shape[0]),
    }
    log(f"binaries: thermal {(OUT/'thermal.bin').stat().st_size/1e6:.1f} MB, "
        f"air {(OUT/'air.bin').stat().st_size/1e6:.1f} MB, "
        f"sunlit {(OUT/'sunlit.bin').stat().st_size/1e3:.0f} kB")

    return _finish(
        area=area, proj=proj, buildings=buildings, facades=facades, canyons=canyons,
        cstates=cstates, pan_canyon=pan_canyon, pan_material=pan_material, MATS=MATS,
        therm=therm, air_prof=air_prof, sunlit_bits=sunlit_bits, mets=mets, suns=suns,
        lots=lots, hvi=hvi, trees=trees, hourly=hourly, f_exc=f_exc, f_per=f_per,
        f_daymax=f_daymax, f_daymin=f_daymin, exc=exc, per=per, env_params=env_params,
        om=om, dsm=dsm, svf_grid=svf_grid, lambda_p=lambda_p, lambda_f=lambda_f, h_bar=h_bar,
        d_disp=d_disp, z0=z0, log=log, t_start=t_start, N_BANDS=N_BANDS,
        grid_meta=grid_meta, shadow_meta=shadow_meta, massing_meta=massing_meta,
        lidar_report=lidar_report, use_lidar=use_lidar,
        ym=ym, bias=bias, annual=annual, statics=statics, event=event,
        month_tiers=month_tiers, event_meta=event_meta, month_meta=month_meta,
        annual_meta=annual_meta, gamma=gamma, gamma_report=gamma_report,
        shade_audit=shade_audit, year_annual=year_annual, year_stride=year_stride,
        recon_meta=recon_meta,
    )


def _finish(**kw) -> dict:
    """Assemble and write every JSON product. Split out purely for readability."""
    area = kw["area"]; proj = kw["proj"]; buildings = kw["buildings"]
    facades = kw["facades"]; canyons = kw["canyons"]; cstates = kw["cstates"]
    pan_canyon = kw["pan_canyon"]; pan_material = kw["pan_material"]; MATS = kw["MATS"]
    therm = kw["therm"]; air_prof = kw["air_prof"]; sunlit_bits = kw["sunlit_bits"]
    mets = kw["mets"]; suns = kw["suns"]; lots = kw["lots"]; hvi = kw["hvi"]
    trees = kw["trees"]; hourly = kw["hourly"]; f_exc = kw["f_exc"]; f_per = kw["f_per"]
    f_daymax = kw["f_daymax"]; f_daymin = kw["f_daymin"]; exc = kw["exc"]; per = kw["per"]
    env_params = kw["env_params"]; om = kw["om"]; dsm = kw["dsm"]; svf_grid = kw["svf_grid"]
    lambda_p = kw["lambda_p"]; h_bar = kw["h_bar"]; d_disp = kw["d_disp"]; z0 = kw["z0"]
    log = kw["log"]; t_start = kw["t_start"]; NB = kw["N_BANDS"]
    ym: Y.YearMet = kw["ym"]; annual: T.AnnualFields = kw["annual"]
    month_tiers: list[T.DayTier] = kw["month_tiers"]
    event: T.DayTier = kw["event"]

    n_hr = len(HOURS)

    # ------------------------------------------------------------- buildings
    # Group panels by building so each building knows its own faces.
    by_building: dict[int, list[int]] = {}
    for pi, f in enumerate(facades):
        by_building.setdefault(f.building, []).append(pi)

    b_out = []
    b_rings: list[list[float]] = []
    ring_index: list[list[int]] = []
    exposures: list[EX.BuildingExposure] = []
    assessed_per_unit: dict[str, float] = {}

    for bi, b in enumerate(buildings):
        ring_xy = proj.ring_to_xy(b["ring"])
        # Centroid in lon/lat for the tile lookups.
        cx = float(ring_xy[:-1, 0].mean()); cy = float(ring_xy[:-1, 1].mean())
        lon, lat = proj.to_lonlat(cx, cy)
        # Keep only buildings whose centroid is inside the study AOI; the padded
        # ring beyond it exists to complete canyons, not to be scored.
        inside = (area.west <= lon <= area.east) and (area.south <= lat <= area.north)

        start = len(b_rings)
        flat: list[float] = []
        for x, y in ring_xy[:-1]:
            flat.extend((round(float(x), 2), round(float(y), 2)))
        b_rings.append(flat)
        ring_index.append([start, len(flat) // 2])

        lot = lots.get(b.get("bbl") or "")
        # Reconcile PLUTO's floor count against the measured footprint height.
        # PLUTO counts floors per tax *lot*, while a footprint is one building
        # mass, so a lot holding a tower and a low annexe reports the tower's
        # floor count against both. Where the two disagree badly, the measured
        # height wins, because that is what the physics is actually solved on.
        h_floors = max(1, int(round(b["height_m"] / 3.2)))
        floors = h_floors
        floors_source = "height"
        if lot and lot.get("floors"):
            pl = int(lot["floors"])
            if pl > 0 and 0.5 <= pl / h_floors <= 2.0:
                floors, floors_source = pl, "pluto"
        zipc = lot.get("zipcode") if lot else None
        mat = P.facade_material(b.get("year"), b["height_m"])

        panels = by_building.get(bi, [])
        if panels and inside:
            pidx = np.array(panels)
            t_all = therm[:, pidx, :]
            # Per-facade daily solar dose: integrate absorbed shortwave over the
            # bought hours, treating each as representative of a 3-hour block.
            face_peak = float(t_all.max())
            face_min = float(t_all.min())
            peak_hr = therm[PEAK_INDEX, pidx, :]
            spread = float(peak_hr.max() - peak_hr.min())
            # Dose proxy: sum of (T_surface - T_air) over lit hours, in K-hours,
            # converted to an equivalent absorbed energy.
            lit = sunlit_bits[:, pidx, :]
            dose_kwh = float((lit.sum() / max(lit.size, 1)) * 6.5)
            # Which face is worst at the peak hour.
            worst = int(np.unravel_index(np.argmax(peak_hr), peak_hr.shape)[0])
            worst_pi = int(pidx[worst])
            worst_az = facades[worst_pi].azimuth
            worst_t = float(peak_hr[worst].max())
            svf_mean = float(np.mean([
                cstates[pan_canyon[p]].svf if pan_canyon[p] >= 0 else 0.8 for p in panels
            ]))
            # The year, rolled up over this building's own panels and bands.
            # Means for anything per-band (an average band's sunlit hours is a
            # comparable quantity between a walk-up and a tower); maxima for the
            # extremes; the modal month for the peak.
            # Modal month of the annual maximum over this building's panel-bands.
            # np.unique rather than np.bincount: bincount needs a non-negative
            # integer array and quietly returns an all-zero histogram if the dtype
            # or the mask is not what you assumed, which reads downstream as "no
            # month" — every building reported month_of_peak 0 for one build before
            # that was traced. unique(return_counts) cannot fail that way.
            mom = np.asarray(annual.month_of_max[pidx], dtype=np.int32).reshape(-1)
            mvals, mcounts = np.unique(mom[mom > 0], return_counts=True)
            annual_rec = {
                "kh35": float(annual.degree_hours_35[pidx].mean()),
                "kh40": float(annual.degree_hours_40[pidx].mean()),
                "sun_hours": float(annual.sun_hours[pidx].mean()),
                "dose_kwh": float(annual.dose_kwh[pidx].mean()),
                "absorbed_kwh": float(annual.absorbed_kwh[pidx].mean()),
                "t_max": float(annual.t_max[pidx].max()),
                "t_mean": float(annual.t_mean[pidx].mean()),
                "summer_mean": float(annual.summer_mean[pidx].mean()),
                "winter_mean": float(annual.winter_mean[pidx].mean()),
                "swing": float(annual.swing[pidx].mean()),
                "hours_above_35": float(annual.hours_above_35[pidx].mean()),
                # Named for what it is at BUILDING level. `month_of_max` is the
                # per-panel-band plane; this is the modal month over a building's
                # panels, and `exposure.attach_annual` reads it under this name.
                # The two names were out of step for one build and every building
                # reported month 0, which read as "no data" rather than as a typo.
                "month_of_peak": int(mvals[int(np.argmax(mcounts))]) if mvals.size else 0,
                "monthly_mean_c": [float(annual.monthly_mean[m][pidx].mean())
                                   for m in range(12)],
                "monthly_sun_hours": [float(annual.monthly_sun_hours[m][pidx].mean())
                                      for m in range(12)],
            }
        else:
            face_peak = face_min = worst_t = float("nan")
            spread = 0.0; dose_kwh = 0.0; worst_az = 0.0; svf_mean = 0.8
            annual_rec = {}

        rec = {
            "i": bi, "bin": b.get("bin"), "bbl": b.get("bbl"),
            "h": round(b["height_m"], 1), "base": round(b.get("base_m") or 0.0, 1),
            "floors": floors, "floors_src": floors_source, "year": b.get("year"),
            "mat": MATS.index(mat) if mat in MATS else 2,
            "in_aoi": 1 if inside else 0,
            "lon": round(lon, 6), "lat": round(lat, 6),
        }
        if lot:
            rec.update({
                "addr": lot.get("address"), "use": lot.get("land_use"),
                "units": lot.get("units_res", 0), "zip": zipc,
            })
        b_out.append(rec)

        if not inside:
            continue

        ex_h = f_exc.at(lon, lat)
        pe_h = f_per.at(lon, lat)
        pk = f_daymax.at(lon, lat)
        ci = pan_canyon[panels[0]] if panels else -1
        st = cstates[ci] if ci >= 0 else None

        # Pedestrian metrics at the building's own doorstep, at the peak hour.
        if st is not None:
            c = canyons[ci]
            sol = P.solve_canyon(mets[PEAK_INDEX], st, suns[PEAK_INDEX],
                                 max(c.h_left, 1.0), max(c.h_right, 1.0),
                                 material_left=mat, material_right=mat, n_bands=4)
            mrt = sol.t_mrt_sun if sol.sunlit_floor_fraction > 0.01 else sol.t_mrt_shade
            wbgt = sol.wbgt_sun if sol.sunlit_floor_fraction > 0.01 else sol.wbgt_shade
        else:
            mrt = mets[PEAK_INDEX].t_air_2m + 8.0
            wbgt = 30.0

        if lot and lot.get("assessed_total") and lot.get("units_res"):
            u = max(1, int(lot["units_res"]))
            assessed_per_unit[b.get("bbl") or ""] = float(lot["assessed_total"]) / u

        exposures.append(EX.BuildingExposure(
            bin=b.get("bin"), bbl=b.get("bbl"),
            address=(lot or {}).get("address"), lon=lon, lat=lat,
            height_m=b["height_m"], floors=floors, year_built=b.get("year"),
            land_use=(lot or {}).get("land_use"), units_res=(lot or {}).get("units_res", 0),
            zipcode=zipc, material=mat,
            exceedance_hours=ex_h if ex_h == ex_h else 0.0,
            persistence_hours=pe_h if pe_h == pe_h else 0.0,
            peak_air_c=pk if pk == pk else 0.0,
            svf_mean=svf_mean, facade_solar_kwh=dose_kwh,
            mrt_peak=mrt, wbgt_peak=wbgt,
            facade_peak_c=face_peak if face_peak == face_peak else 0.0,
            facade_spread_k=spread,
            hvi=hvi.get(zipc or ""),
        ))
        EX.attach_annual(exposures[-1], annual_rec)

        # The nine figures the building card needs, onto the footprint record.
        #
        # `ranked.json` carries the full dossier but is the top 150, and the
        # interface keyed selection on membership in it — so 5,179 of the 5,329
        # footprints answered a hover with a name and a height and then did
        # nothing at all when clicked. Widening `ranked.json` to all 4,044
        # scored buildings would be a 16 MB payload for prose almost nobody
        # opens; these nine numbers are about 150 KB onto a file the page
        # already fetches, and they are every figure the card's grids show.
        #
        # `rec` is already in `b_out` — appended by reference above, before the
        # AOI test — so filling it in here is what reaches the output.
        rec.update({
            "exc_h": round(ex_h, 2) if ex_h == ex_h else 0.0,
            "per_h": round(pe_h, 2) if pe_h == pe_h else 0.0,
            "air_c": round(pk, 2) if pk == pk else 0.0,
            "svf": round(svf_mean, 3),
            "fac_c": round(face_peak, 2) if face_peak == face_peak else 0.0,
            "fac_k": round(spread, 2),
            "mrt_c": round(mrt, 2),
            "wbgt_c": round(wbgt, 2),
            "fac_kwh": round(dose_kwh, 3),
        })

    EX.score_all(exposures, assessed_per_unit)
    EX.score_annual(exposures)
    log(f"scored {len(exposures):,} buildings inside the AOI "
        f"on the event day and on the year")
    _mop = {}
    for e in exposures:
        _mop[e.annual_month_of_peak] = _mop.get(e.annual_month_of_peak, 0) + 1
    log("  month of annual facade peak: "
        + ", ".join(f"{k or 'unset'}:{v}" for k, v in sorted(_mop.items())))

    # How far apart the two orderings are. Published rather than smoothed over:
    # if the year and the heat wave agreed about where to act, the year would not
    # have been worth computing.
    wave_order = [e.bin for e in sorted(exposures, key=lambda x: -x.priority_score)]
    year_order = [e.bin for e in sorted(exposures, key=lambda x: -x.annual_priority_score)]
    top50_overlap = len(set(wave_order[:50]) & set(year_order[:50]))
    rank_of = {b: i for i, b in enumerate(wave_order)}
    moved = sorted(
        ((abs(rank_of[b] - i), b, rank_of[b], i) for i, b in enumerate(year_order)),
        reverse=True)[:5]
    ordering_report = {
        "top50_overlap": top50_overlap,
        "top10_overlap": len(set(wave_order[:10]) & set(year_order[:10])),
        "spearman": _spearman([rank_of[b] for b in year_order],
                              list(range(len(year_order)))),
        "biggest_movers": [{"bin": b, "wave_rank": w + 1, "year_rank": y + 1,
                            "moved": int(d)} for d, b, w, y in moved],
        "reading": (
            "The heat-wave ordering and the annual ordering are different "
            "questions and give different answers. A building that ranks far "
            "higher on the year has chronic facade load; one that ranks far "
            "higher on the wave has trapped air during an acute event. Where "
            "they agree the case is strong on both grounds."
        ),
    }
    log(f"orderings: {top50_overlap}/50 buildings in both top fifties, "
        f"Spearman {ordering_report['spearman']:.3f}")

    # Write scores back onto the building records for the 3D view.
    #
    # Both POPULATION ranks go on as well, over everything scored rather than over
    # the ranked 150. Without them a client can only report a building's position
    # inside a sample that was itself selected by event-day priority, and the two
    # numbers differ enough to mislead: one building sat 39th in the sample and
    # 98th in the population.
    score_by_bin = {e.bin: e for e in exposures}
    wave_rank = {e.bin: i + 1 for i, e in enumerate(
        sorted(exposures, key=lambda x: -x.priority_score))}
    annual_rank = {e.bin: i + 1 for i, e in enumerate(
        sorted(exposures, key=lambda x: -x.annual_priority_score))}
    for rec in b_out:
        e = score_by_bin.get(rec.get("bin"))
        if e:
            rec["pr_rank"] = wave_rank.get(e.bin)
            rec["apr_rank"] = annual_rank.get(e.bin)
            rec["ex"] = round(e.exposure_score, 1)
            rec["vu"] = round(e.vulnerability_score, 1)
            rec["pr"] = round(e.priority_score, 1)
            rec["aex"] = round(e.annual_exposure_score, 1)
            rec["apr"] = round(e.annual_priority_score, 1)
            rec["mop"] = e.annual_month_of_peak
            rec["swing"] = round(e.annual_swing_k, 1)
            rec["sunh"] = round(e.annual_sun_hours)
            # The two headline annual quantities, on EVERY scored building rather
            # than only the ranked 150. A live turn asked for the top three by
            # annual facade dose across the whole area, found the field missing
            # from the compact record, and had to substitute the annual exposure
            # SCORE for the dose itself — a reasonable proxy reported as if it
            # were the thing. Cheap to carry, so it is carried.
            rec["akh"] = round(e.annual_facade_kh35, 1)
            rec["adose"] = round(e.annual_dose_kwh, 1)

    (OUT / "buildings.json").write_text(json.dumps({
        "n": len(b_out), "materials": MATS,
        "attrs": b_out,
        "rings": b_rings,
    }, separators=(",", ":"), allow_nan=False))

    # --------------------------------------------------------------- facades
    fx = []
    for f in facades:
        fx.extend((round(f.x0, 2), round(f.y0, 2), round(f.x1, 2), round(f.y1, 2)))
    (OUT / "facades.json").write_text(json.dumps({
        "n": len(facades), "bands": NB,
        "xy": fx,
        "building": [f.building for f in facades],
        "az": [round(f.azimuth, 1) for f in facades],
        "base": [round(f.base_m, 1) for f in facades],
        "top": [round(f.top_m, 1) for f in facades],
        "canyon": [int(c) for c in pan_canyon],
        "mat": [int(m) for m in pan_material],
    }, separators=(",", ":"), allow_nan=False))

    # --------------------------------------------------------------- canyons
    c_out = []
    for i, c in enumerate(canyons):
        st = cstates[i]
        c_out.append({
            "i": i, "name": c.name, "x": round(c.x, 1), "y": round(c.y, 1),
            "bearing": round(c.bearing, 1), "w": round(c.width_m, 1),
            "w_curb": c.width_curb_m, "hl": round(c.h_left, 1), "hr": round(c.h_right, 1),
            "svf": round(c.svf, 3), "hw": round(c.aspect_ratio, 2),
            "asym": round(c.asymmetry, 2), "canyon": 1 if c.is_canyon else 0,
            "trees": round(st.tree_cover, 2),
            # Measured distances to the wall on each side. Exported because the
            # street-level camera needs them: placing the eye on the centreline
            # sample point alone can put it inside a building where the
            # centreline is off-centre, and these let the viewer be seated in
            # the true middle of the canyon cross-section.
            "dl": round(c.d_left, 1), "dr": round(c.d_right, 1),
        })
    (OUT / "canyons.json").write_text(json.dumps(c_out, separators=(",", ":"), allow_nan=False))

    # ----------------------------------------------------------------- tiles
    def tile_payload(features, field, digits=2):
        out = []
        for f in features:
            v = f["properties"].get(field)
            if v is None:
                continue
            ring = f["geometry"]["coordinates"][0]
            lon = sum(p[0] for p in ring[:-1]) / (len(ring) - 1)
            lat = sum(p[1] for p in ring[:-1]) / (len(ring) - 1)
            x, y = proj.to_xy(lon, lat)
            out.append([round(x, 1), round(y, 1), round(float(v), digits)])
        return out

    peak_layer = _tiles_from(hourly)

    # ---------------------------------------------------- the tile field, year
    #
    # FortyGuard measured this field on one day. The year needs it on 365, and
    # 8,760 more heatmap calls is 37 million credits against a 2 million budget.
    #
    # So the SPATIAL structure and the TEMPORAL level are separated. What
    # FortyGuard measured that reanalysis cannot see is the pattern *within* the
    # study area: which tiles run hot relative to their neighbours, at each hour
    # of the day. That pattern is a product of morphology — plan density, sky
    # view, materials — and morphology does not change between March and August.
    # The level, which reanalysis can supply for every hour of the year, is the
    # AOI-wide air temperature.
    #
    # The transfer is therefore: tile(day, hour) = AOI_air(day, hour)
    #                                            + anomaly(tile, hour-of-day).
    #
    # Two limits, stated rather than buried. (1) The anomaly is measured on ONE
    # day, a clear July heat-wave day, and urban heat island intensity is known
    # to be larger under clear calm conditions than under cloud and wind — so the
    # anomaly is an upper case, and a cloudy February day's real pattern is
    # flatter than this reproduces. (2) It is an anomaly of a modelled/measured
    # FortyGuard product, so it inherits whatever that product's spatial skill
    # is. Both are recorded in `meta.json` under `year.tile_transfer`.
    tile_anom = []
    tile_anom_stats = []
    for i in range(n_hr):
        vals = hourly[i].vals
        med = float(np.median(vals)) if len(vals) else 0.0
        rows = tile_payload_from_field(hourly[i], proj)
        tile_anom.append([[x, y, round(v - med, 3)] for x, y, v in rows])
        anom = np.array([r[2] for r in tile_anom[-1]]) if rows else np.zeros(0)
        tile_anom_stats.append({
            "hour_edt": HOURS[i][1], "aoi_median_c": round(med, 3),
            "anomaly_min": round(float(anom.min()), 3) if anom.size else None,
            "anomaly_max": round(float(anom.max()), 3) if anom.size else None,
            "anomaly_p90_minus_p10": round(
                float(np.percentile(anom, 90) - np.percentile(anom, 10)), 3)
                if anom.size else None,
        })

    # Per-tile annual metrics, from the transfer. The AOI hourly series is
    # reanalysis; the per-tile offset is FortyGuard's measured pattern; the
    # product is labelled as the composite it is.
    hour_slot = np.array([_nearest_hour_slot(int(h)) for h in range(24)])
    anom_by_tile = np.array([[row[2] for row in tile_anom[i]] for i in range(n_hr)]) \
        if tile_anom and tile_anom[0] else np.zeros((n_hr, 0))
    n_tiles = anom_by_tile.shape[1]
    t_tile_hours = (ym.t_air[:, None]
                    + anom_by_tile[hour_slot[ym.hour_of_day], :]) if n_tiles else None

    if t_tile_hours is not None:
        night = (ym.hour_of_day >= 22) | (ym.hour_of_day <= 6)
        per_day_night_min = np.full((ym.n_days, n_tiles), np.inf, dtype=np.float32)
        for di in range(ym.n_days):
            k = np.where((ym.day_index == di) & night)[0]
            if len(k):
                per_day_night_min[di] = t_tile_hours[k].min(axis=0)
        tile_year = {
            "hours_above_35": [round(float(v), 1)
                               for v in (t_tile_hours > 35.0).sum(axis=0)],
            "hours_above_32": [round(float(v), 1)
                               for v in (t_tile_hours > 32.0).sum(axis=0)],
            "degree_hours_35": [round(float(v), 1) for v in
                                np.maximum(t_tile_hours - 35.0, 0).sum(axis=0)],
            "tropical_nights": [int(v) for v in
                                (per_day_night_min > 26.0).sum(axis=0)],
            "mean_c": [round(float(v), 2) for v in t_tile_hours.mean(axis=0)],
            "max_c": [round(float(v), 2) for v in t_tile_hours.max(axis=0)],
            "cdd": [round(float(v), 1) for v in
                    np.maximum(t_tile_hours - 18.0, 0).sum(axis=0) / 24.0],
        }
        tile_year_stats = {k: _plane_stats(v) for k, v in tile_year.items()}
    else:
        tile_year, tile_year_stats = {}, {}

    tiles = {
        "hours": [{"gmt5": g5, "edt": edt} for g5, edt in HOURS],
        "grid_m": 60,
        "air": [tile_payload_from_field(hourly[i], proj) for i in range(n_hr)],
        "anomaly": tile_anom,
        "anomaly_stats": tile_anom_stats,
        "exceedance": tile_payload(_tiles(exc), "value", 2),
        "persistence": tile_payload(_tiles(per), "value", 2),
        "year": tile_year,
        "year_stats": tile_year_stats,
        "year_note": (
            "Annual per-tile metrics are a composite: FortyGuard's measured "
            "within-AOI anomaly pattern carried onto the bias-corrected ERA5 "
            "hourly level. Not a measurement of any of the 364 days FortyGuard "
            "did not see."
        ),
        "stats": {
            "air": [hourly[i].stats for i in range(n_hr)],
            "exceedance": f_exc.stats,
            "persistence": f_per.stats,
            "daymax": f_daymax.stats,
            "daymin": f_daymin.stats,
        },
    }
    (OUT / "tiles.json").write_text(json.dumps(tiles, separators=(",", ":"), allow_nan=False))
    log(f"tiles: {n_tiles:,} tiles, {n_hr} measured hours + the year by transfer")

    # ---------------------------------------------------------------- ranked
    ranked = []
    for e in exposures[:150]:
        acts = EX.recommend(e)
        ranked.append({
            "annual": {
                "facade_kh35": round(e.annual_facade_kh35, 1),
                "facade_kh40": round(e.annual_facade_kh40, 1),
                "sun_hours": round(e.annual_sun_hours, 1),
                "dose_kwh": round(e.annual_dose_kwh, 1),
                "absorbed_kwh": round(e.annual_absorbed_kwh, 1),
                "facade_max_c": round(e.annual_facade_max_c, 1),
                "summer_mean_c": round(e.annual_summer_mean_c, 2),
                "winter_mean_c": round(e.annual_winter_mean_c, 2),
                "swing_k": round(e.annual_swing_k, 2),
                "month_of_peak": e.annual_month_of_peak,
                "hours_above_35": round(e.annual_hours_above_35, 1),
                "monthly_mean_c": [round(v, 2) for v in e.annual_monthly_mean_c],
                "exposure": round(e.annual_exposure_score, 1),
                "priority": round(e.annual_priority_score, 1),
                "components": {k: round(v, 3) for k, v in e.annual_components.items()},
                "reasons": e.annual_reasons,
                "basis": ("whole year, ERA5 bias-corrected anchor, analytic canyon "
                          "shading — see heatcanyon/tiers.py"),
            },
            "bin": e.bin, "bbl": e.bbl, "addr": e.address,
            "lon": e.lon, "lat": e.lat, "h": round(e.height_m, 1), "floors": e.floors,
            "year": e.year_built, "units": e.units_res, "zip": e.zipcode,
            "use": e.land_use, "use_name": nyc.LAND_USE.get(e.land_use or 0),
            "hvi": e.hvi, "material": e.material,
            "exposure": round(e.exposure_score, 1),
            "vulnerability": round(e.vulnerability_score, 1),
            "priority": round(e.priority_score, 1),
            "measured": {
                "exceedance_h": round(e.exceedance_hours, 2),
                "persistence_h": round(e.persistence_hours, 2),
                "peak_air_c": round(e.peak_air_c, 2),
                "svf": round(e.svf_mean, 3),
            },
            "modelled": {
                "facade_peak_c": round(e.facade_peak_c, 1),
                "facade_spread_k": round(e.facade_spread_k, 1),
                "mrt_peak_c": round(e.mrt_peak, 1),
                "wbgt_peak_c": round(e.wbgt_peak, 1),
                "facade_solar_kwh": round(e.facade_solar_kwh, 2),
            },
            "components": {k: round(v, 3) for k, v in e.components.items()},
            "reasons": e.reasons,
            "actions": [
                {"key": a.key, "title": a.title, "rationale": a.rationale,
                 "programme": a.programme, "effect": a.expected_effect}
                for a in acts
            ],
        })
    # The annual ordering of the SAME 150 records, as an index list rather than a
    # second copy: the interface switches between orderings, and shipping the
    # rows twice would be 400 kB spent on a sort.
    by_annual = sorted(range(len(ranked)),
                       key=lambda i: -ranked[i]["annual"]["priority"])
    (OUT / "ranked.json").write_text(json.dumps({
        "n_scored": len(exposures),
        "weights": {"exposure": EX.EXPOSURE_WEIGHTS,
                    "vulnerability": EX.VULNERABILITY_WEIGHTS,
                    "annual_exposure": EX.ANNUAL_EXPOSURE_WEIGHTS},
        "orderings": {
            "wave": list(range(len(ranked))),
            "annual": by_annual,
            "agreement": ordering_report,
        },
        "items": ranked,
    }, separators=(",", ":"), allow_nan=False))

    # ------------------------------------------------------- the decision layer
    #
    # The per-floor schedule, the priced measures and the programme. Written last
    # because every one of them reads a product written above, and written inside
    # a try/except because none of them is load-bearing for the atlas: a build
    # that cannot produce them still ships twelve layers, two time axes, a street
    # camera and an analyst. See docs/DECISIONS.md.
    #
    # Only the ranked 150 get a full schedule. The other 3,894 scored buildings
    # carry the four compact fields below, which is what the portfolio table and
    # the map need; a full schedule for every building would be 38 MB of JSON to
    # answer a question nobody asks about 3,894 buildings at once.
    try:
        from . import decide as DECIDE

        d_agent = None
        try:
            from .agent.dataset import Dataset
            d_agent = Dataset(OUT)
        except Exception as exc:  # noqa: BLE001
            log(f"decision layer: dataset unavailable ({exc}); skipped")

        if d_agent is not None:
            t_dec = time.time()
            floors_out: dict[str, dict] = {}
            presc_out: dict[str, list] = {}
            attrs_by_bin = {str(a.get("bin")): a for a in b_out if a.get("bin")}
            failed = 0
            for rec in ranked:
                bn = str(rec["bin"])
                try:
                    one = DECIDE.prescriptions_for(d_agent, bn, max_canyons=6)
                except Exception:  # noqa: BLE001 — one building must not lose the set
                    failed += 1
                    continue
                floors_out[bn] = one["loads"]
                presc_out[bn] = one["prescriptions"]

            (OUT / "floors.json").write_text(json.dumps({
                "n": len(floors_out), "bands": N_BANDS,
                "attributed": bool(event.dt_solar is not None),
                "basis": ("Conduction from the solved facade surface temperature; "
                          "envelope from a stated era rule, not a survey. Every "
                          "figure derived through that rule is a RANGE and is "
                          "labelled assumed."),
                "items": floors_out,
            }, separators=(",", ":"), allow_nan=False))

            unverified = sum(1 for r in EC_CONSTANTS() if not r.get("verified"))
            (OUT / "prescriptions.json").write_text(json.dumps({
                "constants_as_of": _constants_as_of(),
                "unverified": unverified,
                "items": presc_out,
            }, separators=(",", ":"), allow_nan=False))

            # The building's own modelled exposure as the headroom, so the
            # portfolio's interaction model works against a real total
            # rather than inferring one from the largest single measure.
            at_risk = {b: float((v or {}).get("person_hours") or 0.0)
                       for b, v in floors_out.items()}
            cands = DECIDE.candidates_from(presc_out, attrs_by_bin, at_risk)
            prog = DECIDE.programme(d_agent, candidates=cands)
            (OUT / "portfolio.json").write_text(json.dumps({
                "n": len(cands),
                "objectives": ["person_hours", "degree_hours", "vulnerable",
                               "peak_relief"],
                "candidates": [DECIDE._jsonable(c) for c in cands],
                "curves": prog.get("curves", {}),
                "curve": prog.get("curve", []),
                "allocation": prog.get("allocation"),
                "phases": prog.get("phases", {}),
                "disagreement": prog.get("disagreement"),
                "ledger": prog.get("ledger", ""),
                "constants": EC_CONSTANTS(),
                "unverified": unverified,
            }, separators=(",", ":"), allow_nan=False))

            # The four compact fields, on every scored building, in the spirit of
            # the existing `akh` and `adose`: a live turn that has to substitute a
            # score for the quantity it was asked about is a turn that reports a
            # proxy as if it were the thing.
            for rec_b in b_out:
                fl = floors_out.get(str(rec_b.get("bin")))
                if not fl:
                    continue
                rec_b["pkw"] = round(sum(fl["peak_kw"]) / 2, 1)
                rec_b["amwh"] = round(sum(fl["annual_mwh"]) / 2, 1)
                doms = [r.get("dominant") for r in fl.get("floors", [])]
                rec_b["dom"] = (0 if doms.count("solar") >= doms.count("trap")
                                else 1) if doms else 2
                recs = [r.get("night_recovery") for r in fl.get("floors", [])]
                rec_b["nrec"] = (2 if recs.count("good") > len(recs) / 2
                                 else (0 if recs.count("none") > len(recs) / 2 else 1))
            (OUT / "buildings.json").write_text(json.dumps({
                "n": len(b_out), "materials": MATS,
                "attrs": b_out, "rings": b_rings,
            }, separators=(",", ":"), allow_nan=False))

            log(f"decision layer: {len(floors_out)} schedules, "
                f"{sum(len(v) for v in presc_out.values())} measures, "
                f"{len(cands)} candidates, {unverified} unverified constants"
                + (f", {failed} buildings failed" if failed else "")
                + f" ({time.time() - t_dec:.1f}s)")
    except Exception as exc:  # noqa: BLE001
        log(f"decision layer: skipped ({type(exc).__name__}: {exc})")

    # ------------------------------------------------------------- scenarios
    reps = _representative_canyons(canyons, cstates)
    sc_out = []
    for label, ci in reps:
        c, st = canyons[ci], cstates[ci]
        rows = []
        for hi in (2, PEAK_INDEX, 5):
            res = SC.compare(mets[hi], st, suns[hi], max(c.h_left, 1.0), max(c.h_right, 1.0))
            rows.append({
                "hour_edt": HOURS[hi][1],
                "results": [{
                    "key": r.key, "title": r.title,
                    "d_roof": round(r.d_roof, 2), "d_ground": round(r.d_ground, 2),
                    "d_facade": round(r.d_facade, 2), "d_air": round(r.d_air, 2),
                    "d_mrt_sun": round(r.d_mrt_sun, 2), "d_mrt_shade": round(r.d_mrt_shade, 2),
                    "d_wbgt": round(r.d_wbgt, 2),
                    "abs": {
                        "ground": round(r.t_ground_surface, 1), "roof": round(r.t_roof_surface, 1),
                        "facade": round(r.t_facade_peak, 1), "air": round(r.t_air_2m, 2),
                        "mrt_sun": round(r.t_mrt_sun, 1), "wbgt": round(r.wbgt_sun, 1),
                    },
                } for r in res],
            })
        # The same interventions, re-solved at every month's peak hour.
        #
        # This is the single most useful thing the year adds to the what-if
        # panel, and it is not a scaling of the July answer: the sun is 26 deg
        # lower in December than in June over Manhattan, so a canyon that is
        # half sunlit in July has a floor in permanent shade in January, and the
        # physics of every intervention changes with it. Facade shading that
        # removes 4 K of July surface temperature removes solar gain in January
        # too, when the building wanted it. Cool pavement that raises mean
        # radiant temperature in a deep canyon in summer does so in winter as
        # well, when raising it is a benefit rather than a cost.
        #
        # Because each row is a real re-solve, the annual columns below are a
        # sum over twelve solved months rather than a published coefficient
        # applied twelve times.
        month_rows = []
        for rec, tier in zip(ym.months, month_tiers):
            res = SC.compare(tier.mets[PEAK_INDEX], st, tier.suns[PEAK_INDEX],
                             max(c.h_left, 1.0), max(c.h_right, 1.0))
            month_rows.append({
                "month": rec.month, "label": rec.label[:3], "date": rec.rep_date,
                "hour_edt": HOURS[PEAK_INDEX][1],
                "t_air_c": round(tier.mets[PEAK_INDEX].t_air_2m, 2),
                "sun_alt": round(tier.suns[PEAK_INDEX].altitude, 1),
                "results": [{
                    "key": r.key,
                    "d_facade": round(r.d_facade, 2), "d_ground": round(r.d_ground, 2),
                    "d_mrt_sun": round(r.d_mrt_sun, 2),
                    "d_mrt_shade": round(r.d_mrt_shade, 2),
                    "d_wbgt": round(r.d_wbgt, 2), "d_air": round(r.d_air, 2),
                } for r in res],
            })

        # Annual roll-up per scenario: the cooling it delivers in the months when
        # cooling is wanted, and the heating it removes in the months when it is
        # not. Summer is June to August, winter December to February, using the
        # same definitions as `year.SEASONS`.
        keys = [r["key"] for r in month_rows[0]["results"]] if month_rows else []
        annual_rows = []
        for k in keys:
            per_month = {m["month"]: next(r for r in m["results"] if r["key"] == k)
                         for m in month_rows}
            summer = [per_month[m]["d_mrt_sun"] for m in (6, 7, 8) if m in per_month]
            winter = [per_month[m]["d_mrt_sun"] for m in (12, 1, 2) if m in per_month]
            all_m = [per_month[m]["d_mrt_sun"] for m in per_month]
            f_summer = [per_month[m]["d_facade"] for m in (6, 7, 8) if m in per_month]
            f_winter = [per_month[m]["d_facade"] for m in (12, 1, 2) if m in per_month]
            annual_rows.append({
                "key": k,
                "d_mrt_summer": round(float(np.mean(summer)), 2) if summer else None,
                "d_mrt_winter": round(float(np.mean(winter)), 2) if winter else None,
                "d_mrt_year": round(float(np.mean(all_m)), 2) if all_m else None,
                "d_facade_summer": round(float(np.mean(f_summer)), 2) if f_summer else None,
                "d_facade_winter": round(float(np.mean(f_winter)), 2) if f_winter else None,
                "seasonal_penalty": (
                    round(float(np.mean(winter)) - float(np.mean(summer)), 2)
                    if summer and winter else None),
                "best_month": (min(per_month, key=lambda m: per_month[m]["d_mrt_sun"])
                               if per_month else None),
                "worst_month": (max(per_month, key=lambda m: per_month[m]["d_mrt_sun"])
                                if per_month else None),
            })

        sc_out.append({
            "label": label, "canyon": ci, "name": c.name,
            "w": round(c.width_m, 1), "hw": round(c.aspect_ratio, 2),
            "svf": round(c.svf, 3), "bearing": round(c.bearing, 1),
            "asym": round(c.asymmetry, 2), "trees_now": round(st.tree_cover, 2),
            "hours": rows,
            "months": month_rows,
            "annual": annual_rows,
        })
    (OUT / "scenarios.json").write_text(json.dumps({
        "catalogue": [{"key": s.key, "title": s.title, "description": s.description,
                       "caveat": s.caveat} for s in SC.SCENARIOS.values()],
        "expected_ranges": SC.EXPECTED_RANGES,
        "sites": sc_out,
        "annual_note": (
            "Every monthly row is a full re-solve of that canyon at that month's "
            "representative-day peak hour, with that month's real solar geometry "
            "and meteorology. The annual columns are means over the twelve solved "
            "months, not a published coefficient applied twelve times. A positive "
            "seasonal_penalty means the intervention does less good in winter than "
            "in summer, which for a shading measure is the correct sign and is the "
            "cost of it."
        ),
    }, separators=(",", ":"), allow_nan=False))
    log(f"scenarios: {len(sc_out)} sites x {len(SC.SCENARIOS)} interventions "
        f"x (3 event hours + 12 months) re-solved")

    # ------------------------------------------------------------------ year
    # One file, because the browser needs all of it the moment the year timeline
    # is drawn: 365 daily records to shape the strip, 12 monthly records to label
    # it, and the hourly series so scrubbing a day shows that day's own curve.
    # Quantised where it can be — the hourly air temperature is 8,760 values and
    # 0.01 degC precision on a reanalysis product is three digits of noise.
    hourly_air = [round(float(v), 2) for v in ym.t_air]
    year_doc = {
        "window": [ym.start, ym.end],
        "days": [d.as_dict() for d in ym.days],
        "months": [m.as_dict() for m in ym.months],
        "seasons": ym.seasons(),
        "annual": kw["year_annual"],
        "episodes": [e.as_dict() for e in ym.episodes()[:12]],
        "hourly": {
            "t_air_c": hourly_air,
            "t_air_raw_c": [round(float(v), 2) for v in ym.t_air_raw],
            "apparent_c": [round(float(v), 2) for v in ym.apparent],
            "rh": [round(float(v)) for v in ym.rh],
            "wind_ms": [round(float(v), 1) for v in ym.wind],
            "cloud": [round(float(v), 2) for v in ym.cloud],
            "ghi": [round(float(v)) for v in ym.ghi],
            "dni": [round(float(v)) for v in ym.dni],
            "dhi": [round(float(v)) for v in ym.dhi],
            "hour_of_day": [int(v) for v in ym.hour_of_day],
            "day_index": [int(v) for v in ym.day_index],
            "facade_mean_c": [round(float(v), 2) for v in annual.aoi_hourly_surface],
            "facade_lit_fraction": [round(float(v), 4) for v in annual.aoi_hourly_lit],
            "facade_stride": annual.stride,
        },
        "thresholds": {
            "hot_c": Y.T_HOT_C, "warm_c": Y.T_WARM_C,
            "tropical_night_c": Y.T_TROPICAL_NIGHT_C, "degree_day_base_c": Y.T_BASE_C,
        },
        "event_day_in_year": {
            "date": STUDY_DATE_STR,
            "day_index": ym.dates.index(STUDY_DATE_STR)
                         if STUDY_DATE_STR in ym.dates else None,
            "rank_by_tmax": 1 + sorted(
                (d.t_max for d in ym.days), reverse=True).index(
                    next(d.t_max for d in ym.days if d.date == STUDY_DATE_STR))
                if STUDY_DATE_STR in ym.dates else None,
            "note": ("The day the rest of the model solves in full, located "
                     "inside the year so its claim to be the hottest day is "
                     "checkable rather than asserted."),
        },
        "provenance": ym.provenance(),
        "periods": {
            "event": kw["event_meta"],
            "months": kw["month_meta"],
        },
        "annual_fields": kw["annual_meta"],
        "sensitivity": dict(kw["gamma_report"], offset=0.5, scale=200.0,
                            dtype="uint8", file="sens.bin"),
        "reconstruction": kw["recon_meta"],
        "shading_discrepancy": kw["shade_audit"],
        "tiers": {
            "event": ("2 July 2026, 8 hours, every panel, ray-traced shadows, "
                      "FortyGuard measured anchor. The validated tier."),
            "month": ("12 representative days, 8 hours each, every panel, "
                      "ray-traced shadows, bias-corrected ERA5 anchor. The fields "
                      "the browser paints."),
            "annual": (f"{annual.hours:,} hours, every panel, analytic canyon "
                       f"shading, accumulated not stored. Totals and extremes only."),
            "day_within_month": (
                "month field + dT_surface/dT_air times the day's air-temperature "
                "departure, plus the surface-to-air excess scaled by the "
                "irradiance ratio on lit bands. Its error is MEASURED for every "
                "day against a full re-solve — see `reconstruction` — and the "
                "interface prints that day's own figure."),
        },
    }
    (OUT / "year.json").write_text(json.dumps(year_doc, separators=(",", ":"), allow_nan=False))
    log(f"year.json: {len(ym.days)} days, {len(ym.months)} months, "
        f"{len(ym)} hours, {(OUT/'year.json').stat().st_size/1e6:.1f} MB")

    # ------------------------------------------------------------------ meta
    cy = [c for c in canyons if c.is_canyon]
    street_svf = svf_grid[dsm.height <= 0.5]
    meta = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "aoi": {
            "key": area.key, "label": area.label, "bbox": list(area.bbox),
            "area_km2": round(area.area_km2, 2), "area_mi2": round(area.area_mi2, 2),
            "width_m": round(area.width_m), "height_m": round(area.height_m),
        },
        "projection": proj.params(),
        "event": {
            "date": f"{STUDY_DATE[0]}-{STUDY_DATE[1]:02d}-{STUDY_DATE[2]:02d}",
            "label": "New York heat wave, 29 June - 5 July 2026",
            "wave_start": WAVE[0], "wave_end": WAVE[1],
            "threshold_c": THRESHOLD_C,
            "note": "2026-07-02 was the hottest day of the 2026 Manhattan summer.",
        },
        "hours": [{"gmt5": g5, "edt": edt,
                   "t_anchor_c": round(mets[i].t_air_2m, 2),
                   "rh": mets[i].rh_percent, "cloud": round(mets[i].cloud_fraction, 2),
                   "wind_10m": round(mets[i].wind_10m, 1),
                   "dni": round(mets[i].dni), "dhi": round(mets[i].dhi),
                   "sun_alt": round(suns[i].altitude, 1), "sun_az": round(suns[i].azimuth, 1),
                   "sky_c": round(mets[i].sky_temperature, 1)}
                  for i, (g5, edt) in enumerate(HOURS)],
        "peak_index": PEAK_INDEX,
        "bands": NB,
        "counts": {
            "buildings": len(buildings),
            "buildings_scored": len(exposures),
            "facade_panels": len(facades),
            "canyon_sections": len(canyons),
            "true_canyons": len(cy),
            "street_segments": None,
            "trees": len(trees),
            "residential_units": sum(e.units_res for e in exposures),
        },
        "morphology": {
            "lambda_p": round(lambda_p, 3),
            "lambda_f": round(kw["lambda_f"], 3),
            "macdonald_clamped": bool(kw["lambda_f"] > 0.35 or kw["lambda_p"] > 0.35),
            "mean_building_height_m": round(h_bar, 1),
            # Named explicitly because the two surface models disagree here by
            # ~12 m and a reader needs to know which one fed the roughness.
            "mean_building_height_basis": "flat roof heights (Macdonald H)",
            "surface_model": ("2017 LiDAR roof profiles, gated against the "
                              "footprint table" if kw.get("use_lidar")
                              else "flat footprint extrusion"),
            "displacement_height_m": round(d_disp, 1),
            "roughness_length_m": round(z0, 2),
            "svf_street_median": round(float(np.median(street_svf)), 3),
            "svf_street_p10": round(float(np.percentile(street_svf, 10)), 3),
            "hw_median": round(float(np.median([c.aspect_ratio for c in cy])), 2) if cy else None,
            "hw_p90": round(float(np.percentile([c.aspect_ratio for c in cy], 90)), 2) if cy else None,
            "asymmetry_median": round(float(np.median([c.asymmetry for c in cy])), 2) if cy else None,
            "asymmetry_share_gt_half": round(
                float(np.mean([c.asymmetry > 0.5 for c in cy])), 3) if cy else None,
        },
        "surface_model": (
            dict(kw["lidar_report"].as_dict(),
                 source="USGS 3DEP NY_NewYorkCity (2017 airborne LiDAR, EPT)",
                 grid_res_m=dsm.res,
                 mean_surface_height_m=round(dsm.mean_building_height, 1),
                 mean_roof_height_m=round(h_bar, 1))
            if kw.get("lidar_report") is not None else
            {"source": "flat footprint extrusion", "grid_res_m": dsm.res}
        ),
        "env_series": {
            "hours_gmt5": list(range(24)),
            "apparent_temperature_c": env_params.get("apparent_temperature_celsius"),
            "relative_humidity_percent": env_params.get("relative_humidity_percent"),
            "wet_bulb_c": env_params.get("wet_bulb_temperature_celsius"),
            "cloud_cover": env_params.get("cloud_cover_octas"),
            "air_quality_idx": env_params.get("air_quality:idx"),
            "ozone_idx": env_params.get("air_quality_o3:idx"),
            "heat_index_c": env_params.get("heat_index_celsius"),
            "heat_index_caveat": (
                "The env_params heat-index series applies one temperature anchor across "
                "all 24 hours and varies only humidity, so it peaks overnight when "
                "humidity does. It is a humidity-sensitivity curve, not a diurnal "
                "forecast. apparent_temperature_celsius does follow the real cycle and "
                "is the series used everywhere in this project."
            ),
        },
        "radiation_reference": {
            "source": "ERA5 reanalysis via Open-Meteo archive (free, no key)",
            # Read out of the YEAR series rather than the one-day cache, and in
            # m/s. The one-day cache carries wind in km/h — Open-Meteo's default
            # — and it was being read straight into Met.wind_10m, which is m/s.
            # A 3.6x wind inflates h_c = 2 + 3.8u and damps every facade's
            # surface-to-air excess, so this is a substantive fix and not a
            # tidy-up. The new fetch asks for m/s explicitly (scripts/fetch_year.py).
            "ghi": [round(float(ym.ghi[i]), 1) for i in _event_day_indices(ym)],
            "wind_10m": [round(float(ym.wind[i]), 2) for i in _event_day_indices(ym)],
            "wind_unit": "m/s",
            "t2m": [round(float(ym.t_air_raw[i]), 2) for i in _event_day_indices(ym)],
            "t2m_bias_corrected": [round(float(ym.t_air[i]), 2)
                                   for i in _event_day_indices(ym)],
            "dni": [round(float(ym.dni[i]), 1) for i in _event_day_indices(ym)],
            "dhi": [round(float(ym.dhi[i]), 1) for i in _event_day_indices(ym)],
            "convention": "preceding-hour mean, local wall clock",
            "one_day_cache_units_note": (
                "data/manhattan/_openmeteo_radiation_2026-07-02.json is kept for "
                "provenance and its wind_speed_10m field is in km/h. Nothing reads "
                "it for wind any more."
            ),
        },
        # The year, in summary. The full record is year.json; this is what a
        # client needs before it decides whether to fetch it.
        "year": {
            "window": [ym.start, ym.end],
            "days": len(ym.days),
            "hours": len(ym),
            "months": [{"month": m.month, "label": m.label, "rep_date": m.rep_date,
                        "tmax_mean": round(m.t_max_mean, 2),
                        "tmean": round(m.t_mean, 2),
                        "h35": round(m.hours_above_35, 1),
                        "trop": m.tropical_nights,
                        "noon_alt": round(m.sun_noon_altitude, 1)}
                       for m in ym.months],
            "annual": kw["year_annual"],
            "seasons": ym.seasons(),
            "episodes": [e.as_dict() for e in ym.episodes()[:6]],
            "stride": kw["year_stride"],
            "sampled": kw["year_stride"] != 1,
            "annual_fields": kw["annual_meta"],
            "sensitivity": dict(kw["gamma_report"], offset=0.5, scale=200.0,
                                dtype="uint8", file="sens.bin"),
            "reconstruction": kw["recon_meta"],
            "shading_discrepancy": kw["shade_audit"],
            "ordering_agreement": ordering_report,
            "tile_transfer": {
                "method": ("tile(day, hour) = AOI air temperature from the "
                           "bias-corrected ERA5 series + FortyGuard's measured "
                           "within-AOI anomaly for the nearest of the eight "
                           "bought hours"),
                "anomaly_by_hour": tile_anom_stats,
                "limitations": [
                    "The anomaly is measured on one clear July heat-wave day. Urban "
                    "heat island intensity is larger under clear calm conditions, so "
                    "this is an upper case and a cloudy winter day's real pattern is "
                    "flatter than the transfer reproduces.",
                    "It is an anomaly of a FortyGuard product and inherits that "
                    "product's spatial skill.",
                    "Nothing here is a measurement of any of the 364 days FortyGuard "
                    "did not see, and the interface labels it as a composite.",
                ],
            },
            "periods": {
                "event": {"date": kw["event_meta"]["date"], "dir": "",
                          "anchor": kw["event_meta"]["anchor_source"]},
                "months": [{"month": m["month"], "label": m["label"],
                            "date": m["date"], "dir": f"month_{m['month']:02d}",
                            "rep_rms_k": m["rep_rms_k"]}
                           for m in kw["month_meta"]],
            },
            "provenance": ym.provenance(),
        },
        "height_grid": kw["grid_meta"],
        "shadow_grid": kw["shadow_meta"],
        "massing_grid": kw["massing_meta"],
        "viewpoints": street_viewpoints(canyons, dsm, proj),
        "provenance": _provenance(),
        "spend": json.loads((Path("data/manhattan/_ledger.json")).read_text())
                 if Path("data/manhattan/_ledger.json").exists() else {},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":"), allow_nan=False))

    log(f"wrote {len(list(OUT.iterdir()))} files to {OUT} in {time.time()-t_start:.0f}s")
    return meta


def street_viewpoints(
    canyons: list[G.Canyon],
    dsm: G.DSM,
    proj: G.Projector,
    limit: int = 6,
) -> list[dict]:
    """Validated street-level camera positions, chosen with the DSM in hand.

    The browser cannot do this job. It has canyon attributes but no surface
    model, so a viewpoint derived there from a centreline sample can land inside
    a building — NYC's street centreline is not always the middle of the space
    between the facades, and at 1.7 m the result is a frame filled edge to edge
    with one flat wall. Both earlier attempts failed exactly that way.

    Here every candidate is tested against the raster before being exported:

    * the eye must stand in genuinely open ground, with clearance on all sides;
    * the view along the street axis must stay clear for a good distance, so the
      shot looks down a canyon rather than at the end of one;
    * the canyon must be wide enough to read and deep enough to be worth seeing.

    Each viewpoint records which direction along the axis was validated, so the
    camera does not have to guess and then discover it is facing a wall.
    """
    out: list[dict] = []
    seen_streets: set[str] = set()

    cands = [
        c for c in canyons
        if c.is_canyon and c.name and 18.0 <= c.width_m <= 48.0
        and c.aspect_ratio >= 1.0 and c.d_left > 4.0 and c.d_right > 4.0
    ]
    # Order for readability, not for extremity. Sorting purely by depth put the
    # single most extreme canyon in Midtown first -- 21 m wide between a 109 m
    # and a 427 m wall -- which is a real place and a genuinely bad first
    # impression: at a sky view factor near 0.1 almost nothing is visible. The
    # key below prefers canyons near H/W 4, which is deep enough to feel
    # enclosed and open enough to see along, and the extremes remain reachable
    # through the next-street control.
    cands.sort(key=lambda c: abs(c.aspect_ratio - 4.0))

    for c in cands:
        if c.name in seen_streets:
            continue
        ang = math.radians(c.bearing)
        ax, ay = math.sin(ang), math.cos(ang)      # along the street axis
        nx, ny = ay, -ax                           # across it, to the right

        # Seat the eye midway between the measured walls.
        shift = (c.d_right - c.d_left) / 2.0
        ex, ey = c.x + nx * shift, c.y + ny * shift

        if not _clear_at(dsm, ex, ey, radius_m=3.5):
            continue

        # Check both directions along the axis and keep the clearer one.
        best_dir, best_run = None, 0.0
        for sgn in (1.0, -1.0):
            run = _clear_run(dsm, ex, ey, ax * sgn, ay * sgn, max_m=180.0)
            if run > best_run:
                best_dir, best_run = sgn, run
        if best_dir is None or best_run < 60.0:
            continue

        bearing = c.bearing if best_dir > 0 else (c.bearing + 180.0) % 360.0
        lon, lat = proj.to_lonlat(ex, ey)
        out.append({
            "name": c.name,
            "x": round(ex, 1), "y": round(ey, 1),
            "bearing": round(bearing, 1),
            "clear_m": round(best_run, 1),
            "width_m": round(c.width_m, 1),
            "hw": round(c.aspect_ratio, 2),
            "svf": round(c.svf, 3),
            "asym": round(c.asymmetry, 2),
            "h_left": round(c.h_left, 1), "h_right": round(c.h_right, 1),
            "lon": round(lon, 6), "lat": round(lat, 6),
            "canyon": c.street_id,
        })
        seen_streets.add(c.name)
        if len(out) >= limit:
            break
    return out


def _clear_at(dsm: G.DSM, x: float, y: float, radius_m: float = 3.5) -> bool:
    """True when no building occupies a disc around (x, y)."""
    steps = max(1, int(radius_m / dsm.res))
    ny, nx = dsm.shape
    for di in range(-steps, steps + 1):
        for dj in range(-steps, steps + 1):
            i, j = dsm.xy_to_ij(x + dj * dsm.res, y + di * dsm.res)
            if not (0 <= i < ny and 0 <= j < nx):
                return False
            if dsm.height[i, j] > 1.0:
                return False
    return True


def _clear_run(dsm: G.DSM, x: float, y: float, dx: float, dy: float, max_m: float) -> float:
    """Distance the view stays clear of buildings along a direction, in metres."""
    steps = max(1, int(max_m / dsm.res))
    ny, nx = dsm.shape
    for s in range(1, steps + 1):
        r = s * dsm.res
        i, j = dsm.xy_to_ij(x + dx * r, y + dy * r)
        if not (0 <= i < ny and 0 <= j < nx):
            return r
        if dsm.height[i, j] > 1.0:
            return r
    return max_m


def tile_payload_from_field(tf: TileField, proj: G.Projector) -> list[list[float]]:
    out = []
    for lon, lat, v in tf.pts:
        x, y = proj.to_xy(lon, lat)
        out.append([round(x, 1), round(y, 1), round(v, 2)])
    return out


def _tiles_from(hourly):
    return hourly


def _representative_canyons(canyons, cstates) -> list[tuple[str, int]]:
    """Pick canyons that span the morphology space, for the scenario comparison.

    Deliberately chosen to include the cases where the answers *differ*: a deep
    symmetric canyon where trees do almost nothing, a shallow open street where
    they do a great deal, and a strongly asymmetric canyon where the answer
    depends on the hour.
    """
    # Restrict to streets a person would recognise before ranking them. Picking
    # purely by extremes surfaced a 6 m Park Avenue service slot as the
    # "deepest canyon", which is true of the data and useless as an example:
    # the scenario panel is there to compare places, so the places have to be
    # legible.
    cy = [
        (i, c) for i, c in enumerate(canyons)
        if c.is_canyon and c.name and c.width_m >= 15.0
        and c.d_left > 4.0 and c.d_right > 4.0
    ]
    if not cy:
        cy = [(i, c) for i, c in enumerate(canyons) if c.is_canyon and c.name]
    if not cy:
        return []

    picks: list[tuple[str, int]] = []
    used_names: set[str] = set()

    def pick(label, keyfn, filt=None):
        pool = [
            (i, c) for i, c in cy
            if (filt(c) if filt else True) and c.name not in used_names
        ]
        if not pool:
            return
        i, c = max(pool, key=lambda t: keyfn(t[1]))
        picks.append((label, i))
        used_names.add(c.name)

    # Three regimes that give genuinely different answers, so the comparison
    # teaches something rather than repeating itself.
    pick("Deep canyon", lambda c: c.aspect_ratio - 4.0 * c.asymmetry,
         lambda c: c.asymmetry < 0.3)
    pick("One-sided canyon", lambda c: c.asymmetry * min(c.aspect_ratio, 6.0),
         lambda c: c.asymmetry > 0.4)
    pick("Open street", lambda c: c.svf, lambda c: c.aspect_ratio < 2.0)

    seen = set(); out = []
    for label, i in picks:
        if i in seen:
            continue
        seen.add(i); out.append((label, i))
    return out


def EC_CONSTANTS() -> list[dict]:
    """The economics constants table, or an empty one if that module is absent."""
    try:
        from . import economics
        return economics.constants_table()
    except Exception:  # noqa: BLE001
        return []


def _constants_as_of() -> str:
    """The OLDEST `as_of` in the constants table, which is the one that matters.

    A table whose newest entry is this month and whose oldest is four years old
    is a four-year-old table for any figure that touches the old entry, and
    reporting the newest date would be the more flattering and less true answer.
    """
    rows = EC_CONSTANTS()
    dates = sorted(str(r.get("as_of") or "") for r in rows if r.get("as_of"))
    return dates[0] if dates else "unsourced"


def _provenance() -> list[dict]:
    """Every data source, what it contributed, and whether it is measured."""
    return [
        {"source": "FortyGuard tOS Enterprise API /v1/heatmap",
         "provides": "2 m air temperature, 60 m grid, 8 diurnal hours + full day",
         "kind": "measured/modelled product", "cost": "credits", "key_required": True},
        {"source": "FortyGuard /v1/heatmap analytic_type=exceedance|persistence",
         "provides": "hours above 35 C and longest unbroken run, 29 Jun - 5 Jul 2026",
         "kind": "measured/modelled product", "cost": "credits", "key_required": True},
        {"source": "FortyGuard /v1/env_params",
         "provides": "humidity, apparent temperature, wet bulb, cloud, air quality",
         "kind": "measured/modelled product", "cost": "credits", "key_required": True},
        {"source": "NYC Open Data 5zhs-2jue Building Footprints",
         "provides": "footprint geometry, height_roof and ground_elevation (feet)",
         "kind": "measured (photogrammetric, ~2017 vintage)", "cost": "free", "key_required": False},
        {"source": "USGS 3DEP NY_NewYorkCity, Entwine Point Tiles",
         "provides": "2017 airborne LiDAR; roof profiles and setbacks on the 3 m grid",
         "kind": "measured (2017 vintage, 0.73 m post spacing)",
         "cost": "free", "key_required": False},
        {"source": "NYC Open Data inkn-q76z Centerline",
         "provides": "street width (feet, curb to curb), lanes, name",
         "kind": "measured", "cost": "free", "key_required": False},
        {"source": "NYC Open Data 64uk-42ks PLUTO 26v2",
         "provides": "year built, floors, residential units, land use, assessed value",
         "kind": "administrative record", "cost": "free", "key_required": False},
        {"source": "NYC Open Data 4mhf-duep Heat Vulnerability Index",
         "provides": "DOHMH HVI quintile 1-5 by 2020 ZCTA",
         "kind": "composite index", "cost": "free", "key_required": False},
        {"source": "NYC Open Data uvpi-gqnh Street Tree Census 2015",
         "provides": "living street trees, species and trunk diameter",
         "kind": "measured (2015 vintage)", "cost": "free", "key_required": False},
        {"source": "NYC Open Data qdq3-9eqn Hyperlocal Temperature Monitoring",
         "provides": "street-level air temperature, 84 Manhattan sensors, 2018/19",
         "kind": "measured", "cost": "free", "key_required": False},
        {"source": "ERA5 reanalysis via Open-Meteo archive",
         "provides": ("8,760 hours of air temperature, humidity, wind, cloud and "
                      "beam/diffuse irradiance for the study year — the entire "
                      "temporal axis, plus the reference the solar reconstruction "
                      "is validated against"),
         "kind": "reanalysis (bias-corrected against FortyGuard on the one "
                 "overlapping day)",
         "cost": "free", "key_required": False},
    ]

"""Three temporal tiers over one scene, and the honest boundaries between them.

The platform used to show one afternoon. It now shows a year, and a year cannot
be shown the way an afternoon was: 8,760 hours at 29,415 panels x 10 bands is
2.6 billion surface energy balances and 56 MB of facade field per eight hours
shipped to a browser. So the time axis is resolved at three different
resolutions, each chosen for what it is for, and each labelled so nobody has to
guess which one they are looking at.

  EVENT   2 July 2026, eight hours, every panel, ray-traced shadows.
          Anchored on FortyGuard's measured 2 m field. This is the tier the
          project's validation applies to and the one every purchased credit
          paid for. Unchanged in substance from the original model.

  MONTH   Twelve representative days, eight hours each, every panel, ray-traced
          shadows. Anchored on the bias-corrected ERA5 series. The
          representative day for a month is the day whose own diurnal profile
          sits closest to that month's mean profile (``year.MonthRecord``), so
          it is a real day that happened, not a synthetic average — which
          matters, because an averaged day has an averaged sun and no averaged
          day is ever actually lit that way. These are the fields the browser
          paints.

  ANNUAL  All 8,760 hours, every panel, ANALYTIC canyon shading, accumulated
          rather than stored. Produces totals and extremes — sunlit hours a
          year, degree-hours above 35 degC, the month each facade peaks in — and
          never a field you can look at hour by hour.

BETWEEN THE MONTH TIER AND ANY GIVEN DAY

Scrubbing to 14 March must show 14 March, not "March". The browser therefore
paints the March field plus the day's own air-temperature departure from the
March representative day, scaled by a per-panel sensitivity dT_surface/dT_air
this module measures directly by re-solving the scene with the anchor lifted 1 K.
That is a first-order correction with a measured coefficient, not a guess, and
``scripts/validate.py`` checks it against a full re-solve on days deliberately
chosen to be unlike their month's representative day. It is labelled in the
interface wherever it is in use.

WHY THE ANNUAL TIER TAKES A SHORT CUT, AND WHAT IT COSTS

Ray-marching 8,760 solar positions across an 864 x 901 surface model is about
two hours of shadow work on its own. The annual tier therefore uses the closed
form for the shadow the opposite wall casts up a facade. Where the street is a
street the two agree; at corners, plazas and across intersections the raster
sees obstruction a 2-D cross-section cannot, so annual sunlit hours are a slight
over-estimate there. The size of that over-estimate is not left as a caveat: the
event day is solved BOTH ways and the disagreement is measured, reported in
``meta.json`` under ``year.shading_discrepancy``, and asserted against a ceiling
in the validation script.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np

from . import geometry as G
from . import physics as P
from . import solar
from . import year as Y
from . import yearsolve as YS

#: The eight diurnal hours, as (API GMT-5 hour, wall-clock EDT hour). Kept
#: identical to the hours FortyGuard was billed for so the event tier and the
#: month tier are sampled the same way and can be compared directly.
HOURS = [(2, 3), (5, 6), (8, 9), (11, 12), (14, 15), (17, 18), (20, 21), (23, 0)]
PEAK_INDEX = 4


# ------------------------------------------------------------------- outputs


@dataclass
class DayTier:
    """One day solved at eight hours over every panel and band."""

    label: str
    date: str
    anchor_source: str
    surface: np.ndarray            # (H,P,B) float32, degC
    air: np.ndarray                # (H,P,B) float32, degC
    air_sigma: np.ndarray          # (H,P,B) float32, K
    lit: np.ndarray                # (H,P,B) bool
    ground_sun: np.ndarray         # (H,ny,nx) bool, at the DSM resolution
    mets: list[P.Met]
    suns: list[solar.SunPosition]
    lit_analytic: np.ndarray | None = None   # (H,P,B) bool, for the shading audit

    # WHY a surface is hot, not just how hot: the three additive drivers, each in
    # kelvin of rise above the band's own air temperature. Filled only when
    # `solve_day(want_terms=True)`, because a prescription needs them and the
    # 8,760-hour accumulation does not.
    #
    # These are the SCALED terms — rescaled to sum exactly to the observed rise.
    # See physics.SurfaceTerms.scaled: the raw decomposition overstates the rise
    # by a second-order error reaching three kelvin on a sunlit July wall, and a
    # schedule quoting kelvin from numbers that do not add up to the wall's
    # actual excess is indefensible. The correction is one multiplicative factor,
    # so every ratio — and therefore `dominant` — is untouched by it.
    dt_solar: np.ndarray | None = None       # (H,P,B) float32, K
    dt_trap: np.ndarray | None = None        # (H,P,B) float32, K
    dt_sky: np.ndarray | None = None         # (H,P,B) float32, K, negative
    residual: np.ndarray | None = None       # (H,P,B) float32, K, the linearisation

    @property
    def n_hours(self) -> int:
        return int(self.surface.shape[0])


@dataclass
class AnnualFields:
    """The year, accumulated. Every array is (P,B) unless noted."""

    hours: int
    stride: int
    sun_hours: np.ndarray            # hours with direct beam on the panel
    dose_kwh: np.ndarray             # incident shortwave, kWh/m2
    absorbed_kwh: np.ndarray         # absorbed shortwave, kWh/m2
    degree_hours_35: np.ndarray      # K.h of facade surface above 35 degC
    degree_hours_40: np.ndarray      # K.h above 40 degC
    hours_above_35: np.ndarray
    t_max: np.ndarray
    t_min: np.ndarray
    t_mean: np.ndarray
    month_of_max: np.ndarray         # 1-12
    monthly_mean: np.ndarray         # (12,P,B) monthly mean surface temperature
    monthly_max: np.ndarray          # (12,P,B)
    monthly_sun_hours: np.ndarray    # (12,P,B)
    aoi_hourly_surface: np.ndarray   # (hours,) scene-mean facade surface temp
    aoi_hourly_lit: np.ndarray       # (hours,) fraction of panel-bands in sun
    seconds: float = 0.0

    @property
    def summer_mean(self) -> np.ndarray:
        return self.monthly_mean[[5, 6, 7]].mean(axis=0)

    @property
    def winter_mean(self) -> np.ndarray:
        return self.monthly_mean[[11, 0, 1]].mean(axis=0)

    @property
    def swing(self) -> np.ndarray:
        return self.summer_mean - self.winter_mean

    @property
    def winter_sun_share(self) -> np.ndarray:
        """December-February sunlit hours as a fraction of June-August's.

        The seasonal SWING in facade temperature turns out to be nearly uniform
        across Midtown — 25 to 30 K everywhere — because it is set by the air
        temperature's own annual cycle, which the whole study area shares. That is
        a real finding and a dull map.

        This is the quantity that actually varies with geometry, from about 0.05
        in a deep north-south slot to near 0.8 on an open south-facing wall, and
        it is the one a planner needs: a facade with almost no winter sun is a
        facade where summer shading costs nothing, and one with a high share is a
        facade where the same shading takes away the heating season's only free
        gain. Clipped at 2.0, which only a band with a tiny summer denominator can
        approach.
        """
        summer = self.monthly_sun_hours[[5, 6, 7]].sum(axis=0)
        winter = self.monthly_sun_hours[[11, 0, 1]].sum(axis=0)
        return np.clip(winter / np.maximum(summer, 1.0), 0.0, 2.0)


# ------------------------------------------------------------ shadow plumbing


class ShadowCache:
    """Ray-traced sunlit masks, memoised on quantised solar position.

    Two different days three months apart can present the sun at very nearly the
    same altitude and azimuth, and the mask depends on nothing else. Quantising
    to 1 degree in both and memoising turns 96 monthly rasters into rather fewer
    actual ray-marches without changing any of them by more than a metre of
    shadow at street level.
    """

    def __init__(self, dsm: G.DSM, max_radius_m: float = 500.0,
                 quant_deg: float = 1.0) -> None:
        self.dsm = dsm
        self.max_radius_m = max_radius_m
        self.q = quant_deg
        self._cache: dict[tuple[int, int], np.ndarray] = {}
        self.misses = 0
        self.hits = 0

    def get(self, sun: solar.SunPosition) -> np.ndarray:
        if not sun.up:
            return np.zeros(self.dsm.shape, dtype=bool)
        key = (int(round(sun.altitude / self.q)), int(round(sun.azimuth / self.q)))
        hit = self._cache.get(key)
        if hit is not None:
            self.hits += 1
            return hit
        self.misses += 1
        mask = G.shadow_raster(self.dsm, sun.altitude, sun.azimuth,
                              max_radius_m=self.max_radius_m)
        self._cache[key] = mask
        return mask


def panel_cells(facades, dsm: G.DSM) -> tuple[np.ndarray, np.ndarray]:
    """DSM cell indices of every panel's mid-point, clamped into the grid."""
    ny, nx = dsm.shape
    ii = np.empty(len(facades), dtype=np.int32)
    jj = np.empty(len(facades), dtype=np.int32)
    for p, f in enumerate(facades):
        i, j = dsm.xy_to_ij(*f.mid)
        ii[p] = min(max(i, 0), ny - 1)
        jj[p] = min(max(j, 0), nx - 1)
    return ii, jj


def _lit_with_raster(sun: solar.SunPosition, st: YS.PanelStatics,
                     shadow: np.ndarray, cell_i: np.ndarray,
                     cell_j: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(lit, lit_analytic, cos_incidence).

    The analytic canyon form decides every band; the ray-traced mask then
    vetoes the GROUND band only, exactly as the original scalar loop did. The
    ground band is where the 2-D cross-section is weakest — an intersection or a
    plaza opens the canyon in a direction the cross-section cannot represent —
    and it is also the band a pedestrian stands in.
    """
    lit, cos_i = YS.sunlit_v(sun, st)
    analytic = lit.copy()
    if sun.up:
        ground_ok = shadow[cell_i, cell_j]
        lit[:, 0] &= ground_ok
    return lit, analytic, cos_i


# ---------------------------------------------------------------- a day tier


def solve_day(*, label: str, date: str, mets: list[P.Met],
              suns: list[solar.SunPosition], st: YS.PanelStatics,
              shadows: ShadowCache, cell_i: np.ndarray, cell_j: np.ndarray,
              anchor_source: str, keep_analytic: bool = False,
              want_terms: bool = False, log=lambda _m: None) -> DayTier:
    """Solve one day at every hour in ``mets``, over every panel and band.

    ``want_terms`` additionally recovers the attribution — how much of each
    band's rise above air came from absorbed shortwave, from longwave off the
    surfaces opposite, and from its own view of a cold sky. It costs one extra
    pass of closed-form arithmetic per hour and four more (P,B) float32 arrays,
    so it is off for the annual accumulation and on for the thirteen days the
    interface and the prescriptions read.
    """
    n_h = len(mets)
    n_p, n_b = st.n_panel, st.n_band
    surface = np.empty((n_h, n_p, n_b), dtype=np.float32)
    air = np.empty((n_h, n_p, n_b), dtype=np.float32)
    lit = np.zeros((n_h, n_p, n_b), dtype=bool)
    analytic = np.zeros((n_h, n_p, n_b), dtype=bool) if keep_analytic else None
    ground = np.zeros((n_h,) + shadows.dsm.shape, dtype=bool)
    terms = ({k: np.zeros((n_h, n_p, n_b), dtype=np.float32)
              for k in ("dt_solar", "dt_trap", "dt_sky", "residual")}
             if want_terms else None)

    for h in range(n_h):
        met, sun = mets[h], suns[h]
        mask = shadows.get(sun)
        ground[h] = mask
        lit_h, an_h, _cos = _lit_with_raster(sun, st, mask, cell_i, cell_j)
        # ONE surroundings pass, and the attribution does not get a second one.
        #
        # `YS.solve_hour` can now iterate the surroundings temperature per canyon
        # instead of assuming one scene-wide `t_air + 5 K`, which is what the
        # scalar `physics.solve_canyon` does and is more physical. It was briefly
        # switched on here, for the days that carry the attribution, on the
        # reasoning that a constant surroundings temperature would flatten the
        # trapping term.
        #
        # Two things sent it back off, and both are worth recording.
        #
        # It did not do what it was turned on for. Measured on a synthetic deep
        # slot against an open avenue, the enclosed-to-open ratio of the trapping
        # term is 2.01 with one pass and 1.66 with two — the constant does not
        # flatten the term at all, because the term already varies through
        # `f_sky`, which is per band and is the quantity that actually carries
        # enclosure. The iteration made the discrimination slightly WORSE.
        #
        # And it moved the field the browser paints. Mean -0.31 K over the event
        # day, 48% of panel-bands by more than half a kelvin, worst 2.97 K. That
        # field is this project's headline product; it is screenshotted, its
        # extremes are quoted in the documentation, and three visual checks are
        # tuned to it. Changing it as a side effect of adding a different feature
        # is exactly the silent drift `yearsolve.py`'s own rule exists to
        # prevent: the physics changes in `physics.py` first, and the vector
        # engine is brought back into line afterwards. It had not.
        #
        # The capability stays in `yearsolve` — it is correct, and it is the
        # right change to make deliberately, with its own validation and a
        # re-baselining of the visual checks. It is not this change.
        f = YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi, lit_override=lit_h,
                          want_terms=want_terms)
        surface[h] = f.surface
        air[h] = f.air
        lit[h] = lit_h
        if terms is not None and f.terms is not None:
            sc = f.terms.scaled(f.surface, f.air)
            terms["dt_solar"][h] = sc["solar"]
            terms["dt_trap"][h] = sc["trap"]
            terms["dt_sky"][h] = sc["sky"]
            terms["residual"][h] = f.terms.residual
        if analytic is not None:
            analytic[h] = an_h
        log(f"  {label} {int(met.hour_edt):02d}:00 done "
            f"(surface {f.surface.min():.1f} to {f.surface.max():.1f} C)")

    sigma = YS.air_uncertainty_v(st).astype(np.float32)
    air_sigma = np.repeat(sigma[None, :, :], n_h, axis=0)
    return DayTier(label=label, date=date, anchor_source=anchor_source,
                   surface=surface, air=air, air_sigma=air_sigma, lit=lit,
                   ground_sun=ground, mets=mets, suns=suns,
                   lit_analytic=analytic,
                   **(terms or {}))


# --------------------------------------------------------------- the sensitivity


def sensitivity(*, mets: list[P.Met], suns: list[solar.SunPosition],
                st: YS.PanelStatics, delta_k: float = 1.0) -> tuple[np.ndarray, dict]:
    """dT_surface / dT_air per panel and band, measured by re-solving.

    Averaged over the hours it is given — which the caller chooses to span the
    year and the day, so the coefficient is not a July-afternoon artefact. The
    report carries the spread across those hours, because the honest statement is
    not "gamma is 0.94" but "gamma is 0.94 and it varies by this much depending
    on when you ask".
    """
    per_hour = []
    for met, sun in zip(mets, suns):
        lit, _cos = YS.sunlit_v(sun, st)
        base = YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi,
                             lit_override=lit).surface
        warmer = P.Met(met.t_air_2m + delta_k, met.rh_percent, met.wind_10m,
                       met.wind_dir, met.cloud_fraction, met.dni, met.dhi,
                       met.hour_edt)
        bumped = YS.solve_hour(warmer, sun, st, dni=met.dni, dhi=met.dhi,
                               lit_override=lit).surface
        per_hour.append(((bumped - base) / delta_k).astype(np.float32))

    stack = np.stack(per_hour, axis=0)
    gamma = stack.mean(axis=0)
    report = {
        "definition": "dT_surface / dT_air at 2 m, K/K, per facade panel and band",
        "measured_by": (f"re-solving the scene with the air-temperature anchor "
                        f"raised {delta_k:g} K, at {len(per_hour)} hours spanning "
                        f"the year and the day"),
        "delta_k": delta_k,
        "mean": round(float(gamma.mean()), 4),
        "p05": round(float(np.percentile(gamma, 5)), 4),
        "p95": round(float(np.percentile(gamma, 95)), 4),
        "min": round(float(gamma.min()), 4),
        "max": round(float(gamma.max()), 4),
        "spread_across_hours_mean_k_per_k": round(float(stack.std(axis=0).mean()), 4),
        "use": (
            "The browser paints a month's solved field plus gamma times the "
            "selected day's air-temperature departure from that month's "
            "representative day. Validated against a full re-solve in "
            "scripts/validate.py."
        ),
    }
    return gamma, report


# ------------------------------------------------- the day reconstruction
#
# ONE DEFINITION, USED THREE TIMES. This formula is what the browser paints for
# any of the 352 days that were not solved, what `agent/dataset.surface_on`
# returns, and what the audit below measures. Writing it out here rather than in
# each of them is not tidiness: three implementations of a reconstruction would
# drift, and the number the interface shows for its own error would stop being
# the error of the field on screen.


def wind_factor(u10_rep: float, u10_day: float, aspect: np.ndarray,
                h_mean: np.ndarray, z: np.ndarray) -> np.ndarray:
    """h_c(reference wind) / h_c(the day's wind), per panel and band.

    The surface-to-air excess goes as 1/h_c, so a windier day sheds more heat and
    every excess shrinks by this ratio. It is per panel and band rather than
    scalar because the canyon attenuates the free-stream wind by exp(-0.386 H/W)
    at street level and lets it through at roof height, so a 3 m/s change means
    something different at the bottom of a 4:1 slot than at the top of it.

    Measured: adding this term took the median day's 95th-percentile error from
    1.78 K to 1.54 K, the 90th-percentile day from 5.65 K to 4.28 K, and the worst
    day from 17.5 K to 13.5 K. It needs no data the browser does not already hold.
    """
    hc_rep = YS.convective_coefficient_v(
        YS.wind_profile(u10_rep, aspect, h_mean, z))
    hc_day = YS.convective_coefficient_v(
        YS.wind_profile(u10_day, aspect, h_mean, z))
    return (hc_rep / np.maximum(hc_day, 1e-6)).astype(np.float32)


def reconstruct(surface_rep: np.ndarray, lit_rep: np.ndarray, *,
                t_air_rep: float, t_air_day: float,
                ghi_rep: float, ghi_day: float, gamma: np.ndarray,
                wind_ratio: np.ndarray | float = 1.0,
                ratio_cap: float = 2.5) -> np.ndarray:
    """A solved month's field, moved to another day of that month.

    Three terms. The first was all there was at first, and each of the other two
    was added because it was measured to help.

    **The air term.** ``gamma`` is dT_surface/dT_air, measured by re-solving the
    scene with the anchor lifted 1 K. It comes out at 1.007 K/K: a facade tracks
    the air almost one for one once the radiation term is fixed, and slightly more
    than one because warmer air also raises the radiative sky temperature.

    **The irradiance term.** A day 16 K warmer than its month's representative day
    is usually a CLEAR day against a cloudy one, and the beam load differs by
    hundreds of W/m2 — which the air term cannot see at all. Measured before this
    term existed: a January probe with the same geometry and 591 W/m2 of beam on
    the reference day against zero on the target was wrong by 14 K at its worst
    band. So the surface-to-air excess, which is what the radiation actually
    drives, is scaled by the global irradiance ratio.

    Applied only where the band is LIT, and that qualifier matters. Scaling a
    shaded band's excess by a beam ratio over-corrects it, because a shaded band's
    excess is diffuse and longwave rather than beam: applying the ratio everywhere
    took the median April error from 0.40 K to 2.85 K while improving the tail.
    Lit-only improves both.

    **The wind term.** The excess also goes as 1/h_c, and h_c is 5.8 + 3.8u, so a
    windier day sheds more heat from every surface — lit or shaded, which is why
    this factor applies everywhere while the irradiance ratio does not. See
    ``wind_factor``.

    What none of the three can do is correct a change in solar GEOMETRY. Two days
    a fortnight apart differ by several degrees of declination, which moves the
    shadow line and changes the incidence angle on every lit band, and no scalar
    applied to a solved field can reproduce that. That residual is why
    ``reconstruction_audit`` exists: it is measured per day rather than left as a
    caveat, shipped in ``year.json``, and shown in the interface beside the date.
    """
    out = surface_rep + gamma * np.float32(gamma_delta(t_air_day, t_air_rep))
    ratio = 1.0
    if ghi_rep >= 20.0:
        ratio = float(np.clip(ghi_day / ghi_rep, 0.0, ratio_cap))
    w = np.asarray(wind_ratio, dtype=np.float32)
    lit_scale = ratio * w
    if np.any(np.abs(lit_scale - 1.0) > 1e-6) or np.any(np.abs(w - 1.0) > 1e-6):
        excess = surface_rep - np.float32(t_air_rep)
        out = out + np.where(lit_rep, excess * (lit_scale - 1.0),
                             excess * (w - 1.0))
    return out.astype(np.float32)


def gamma_delta(t_air_day: float, t_air_rep: float) -> float:
    """The air-temperature departure the reconstruction is built on. Trivial, and
    named so the browser's implementation can be checked against one thing."""
    return float(t_air_day) - float(t_air_rep)


@dataclass
class ReconstructionAudit:
    """How wrong the reconstruction is, for every day of the year.

    Measured rather than asserted. Each of the 365 days is solved at one hour and
    compared against its own month's reconstruction, so the interface can show the
    error of the field it is actually painting instead of a global caveat.
    """

    per_day: dict[str, dict]
    hour_slot: int
    seconds: float

    def summary(self) -> dict:
        p95 = np.array([r["p95"] for r in self.per_day.values()])
        p50 = np.array([r["p50"] for r in self.per_day.values()])
        agree = np.array([r["lit_agree"] for r in self.per_day.values()])
        worst = max(self.per_day.items(), key=lambda kv: kv[1]["p95"])
        by_month: dict[int, list[float]] = {}
        for date, rec in self.per_day.items():
            by_month.setdefault(int(date[5:7]), []).append(rec["p95"])
        return {
            "method": ("every day of the year solved at one hour and compared "
                       "against its own month's reconstruction"),
            "hour_slot": self.hour_slot,
            "days": len(self.per_day),
            "seconds": round(self.seconds, 1),
            "p50_error_median_k": round(float(np.median(p50)), 3),
            "p95_error_median_k": round(float(np.median(p95)), 3),
            "p95_error_p90_k": round(float(np.percentile(p95, 90)), 3),
            "p95_error_worst_k": round(float(p95.max()), 3),
            "worst_day": {"date": worst[0], **{k: round(v, 3)
                                               for k, v in worst[1].items()}},
            "mean_lit_agreement": round(float(agree.mean()), 4),
            "p95_by_month_k": {m: round(float(np.median(v)), 3)
                               for m, v in sorted(by_month.items())},
            "reading": (
                "The residual is solar geometry, not weather. Two days a fortnight "
                "apart differ by several degrees of declination, which moves the "
                "shadow line and changes the incidence angle on every lit band, and "
                "no scalar applied to a solved field reproduces that. It is "
                "therefore largest in the equinox months, where declination moves "
                "fastest, and smallest in June and December where it barely moves. "
                "The twelve monthly days are solved rather than interpolated for "
                "exactly this reason; this is what remains between them."
            ),
        }


def reconstruction_audit(ym: Y.YearMet, st: YS.PanelStatics,
                         month_tiers: list[DayTier], gamma: np.ndarray, *,
                         hour_slot: int = PEAK_INDEX,
                         log=lambda _m: None) -> ReconstructionAudit:
    """Solve every day at one hour and measure the reconstruction against it.

    365 solves at about 110 ms is under a minute, which is a cheap price for
    turning an unbounded caveat into a number the interface can print beside the
    date somebody is looking at.
    """
    t0 = time.time()
    by_month = {int(t.date[5:7]): t for t in month_tiers}
    rep_air: dict[int, float] = {}
    rep_ghi: dict[int, float] = {}
    rep_wind: dict[int, float] = {}
    for m, tier in by_month.items():
        # `DayTier.mets` carries the wall-clock hour. There is no `.hours` on the
        # tier — that is the metadata dict the pipeline writes afterwards — and
        # reaching for it raised an AttributeError five minutes into a build.
        i = ym.index_of(tier.date, int(tier.mets[hour_slot].hour_edt))
        rep_air[m] = float(ym.t_air[i]) if i is not None else 0.0
        rep_ghi[m] = float(ym.ghi[i]) if i is not None else 0.0
        rep_wind[m] = float(ym.wind[i]) if i is not None else 3.0

    out: dict[str, dict] = {}
    for n, day in enumerate(ym.dates):
        m = int(day[5:7])
        tier = by_month.get(m)
        if tier is None:
            continue
        edt = int(tier.mets[hour_slot].hour_edt)
        i = ym.index_of(day, edt)
        if i is None:
            continue
        met = P.Met(t_air_2m=float(ym.t_air[i]), rh_percent=float(ym.rh[i]),
                    wind_10m=float(ym.wind[i]), wind_dir=float(ym.wind_dir[i]),
                    cloud_fraction=float(ym.cloud[i]), dni=float(ym.dni[i]),
                    dhi=float(ym.dhi[i]), hour_edt=float(edt))
        truth = YS.solve_hour(met, ym.sun(int(i)), st, dni=met.dni, dhi=met.dhi)
        recon = reconstruct(tier.surface[hour_slot], tier.lit[hour_slot],
                            t_air_rep=rep_air[m], t_air_day=float(ym.t_air[i]),
                            ghi_rep=rep_ghi[m], ghi_day=float(ym.ghi[i]),
                            gamma=gamma,
                            wind_ratio=wind_factor(rep_wind[m], float(ym.wind[i]),
                                                   st.aspect, st.h_mean, st.z))
        same = tier.lit[hour_slot] == truth.lit
        err = np.abs(recon - truth.surface)
        e = err[same] if same.any() else err
        out[day] = {
            "p50": float(np.median(e)), "p95": float(np.percentile(e, 95)),
            "max": float(e.max()), "lit_agree": float(same.mean()),
            "solved": day == tier.date,
        }
        if (n + 1) % 60 == 0:
            log(f"  reconstruction audit {n+1}/{len(ym.dates)} days "
                f"({time.time()-t0:.0f}s)")
    return ReconstructionAudit(per_day=out, hour_slot=hour_slot,
                              seconds=time.time() - t0)


# ------------------------------------------------------------- the annual tier


def accumulate_year(ym: Y.YearMet, st: YS.PanelStatics, *, stride: int = 1,
                    log=lambda _m: None) -> AnnualFields:
    """Walk the whole year, hour by hour, accumulating rather than storing.

    Nothing here is kept per hour except two scene-wide scalars, which is what
    makes a year affordable: the per-hour field is 1.2 MB and there are 8,760 of
    them, but the accumulators are twenty planes regardless of how long the year
    is.
    """
    t0 = time.time()
    n_p, n_b = st.n_panel, st.n_band
    shape = (n_p, n_b)

    # A STRIDE MUST BE COPRIME WITH 24, and this is not a nicety.
    #
    # Measured the hard way: `--year-stride 24` produced an annual field with
    # ZERO sunlit hours everywhere. Every 24th hour of a series that starts at
    # midnight is midnight, so the whole year was sampled with the sun below the
    # horizon. Any stride sharing a factor with 24 under-samples the hour of day
    # the same way to a lesser degree — a stride of 8 sees only hours 0, 8 and 16,
    # and therefore never sees the afternoon peak at all.
    #
    # So the requested stride is nudged up to the next value coprime with 24,
    # which sweeps every hour of the day over the year. Announced, because a
    # developer who asked for 24 should be told they got 25.
    want = max(1, int(stride))
    stride = want
    while math.gcd(stride, 24) != 1:
        stride += 1
    if stride != want:
        log(f"  year stride {want} shares a factor with 24 and would sample only "
            f"{24 // math.gcd(want, 24)} hours of the day — using {stride}")

    idx = np.arange(0, len(ym), stride)
    weight = float(stride)                    # each solved hour stands for `stride`

    sun_hours = np.zeros(shape, dtype=np.float32)
    dose = np.zeros(shape, dtype=np.float64)
    absorbed = np.zeros(shape, dtype=np.float64)
    kh35 = np.zeros(shape, dtype=np.float32)
    kh40 = np.zeros(shape, dtype=np.float32)
    h35 = np.zeros(shape, dtype=np.float32)
    t_sum = np.zeros(shape, dtype=np.float64)
    t_max = np.full(shape, -1e9, dtype=np.float32)
    t_min = np.full(shape, 1e9, dtype=np.float32)
    month_of_max = np.zeros(shape, dtype=np.int8)

    monthly_sum = np.zeros((12,) + shape, dtype=np.float64)
    monthly_n = np.zeros(12, dtype=np.float64)
    monthly_max = np.full((12,) + shape, -1e9, dtype=np.float32)
    monthly_sun = np.zeros((12,) + shape, dtype=np.float32)

    aoi_surface = np.zeros(len(idx), dtype=np.float32)
    aoi_lit = np.zeros(len(idx), dtype=np.float32)

    alb = st.albedo[:, None]
    report_every = max(1, len(idx) // 12)

    for k, i in enumerate(idx):
        met = P.Met(
            t_air_2m=float(ym.t_air[i]), rh_percent=float(ym.rh[i]),
            wind_10m=float(ym.wind[i]), wind_dir=float(ym.wind_dir[i]),
            cloud_fraction=float(ym.cloud[i]), dni=float(ym.dni[i]),
            dhi=float(ym.dhi[i]), hour_edt=float(ym.hour_of_day[i]),
        )
        sun = ym.sun(int(i))
        f = YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi)
        ts = f.surface
        m0 = int(ym.month[i]) - 1

        sun_hours += f.lit * weight
        monthly_sun[m0] += f.lit * weight
        dose += f.irradiance * (weight / 1000.0)
        absorbed += f.irradiance * (1.0 - alb) * (weight / 1000.0)
        over35 = ts - 35.0
        np.maximum(over35, 0.0, out=over35)
        kh35 += over35.astype(np.float32) * weight
        over40 = ts - 40.0
        np.maximum(over40, 0.0, out=over40)
        kh40 += over40.astype(np.float32) * weight
        h35 += (ts > 35.0) * weight
        t_sum += ts
        newmax = ts > t_max
        t_max = np.where(newmax, ts, t_max).astype(np.float32)
        month_of_max = np.where(newmax, m0 + 1, month_of_max).astype(np.int8)
        np.minimum(t_min, ts, out=t_min)

        monthly_sum[m0] += ts
        monthly_n[m0] += 1.0
        np.maximum(monthly_max[m0], ts, out=monthly_max[m0])

        aoi_surface[k] = float(ts.mean())
        aoi_lit[k] = float(f.lit.mean())

        if (k + 1) % report_every == 0 or k + 1 == len(idx):
            log(f"  year {k+1:,}/{len(idx):,} hours "
                f"({ym.times[int(i)][:10]}) {time.time()-t0:.0f}s")

    n = float(len(idx))
    monthly_mean = np.divide(monthly_sum, np.maximum(monthly_n, 1.0)[:, None, None])
    return AnnualFields(
        hours=len(idx), stride=stride,
        sun_hours=sun_hours, dose_kwh=dose.astype(np.float32),
        absorbed_kwh=absorbed.astype(np.float32),
        degree_hours_35=kh35, degree_hours_40=kh40, hours_above_35=h35,
        t_max=t_max, t_min=t_min, t_mean=(t_sum / n).astype(np.float32),
        month_of_max=month_of_max,
        monthly_mean=monthly_mean.astype(np.float32),
        monthly_max=monthly_max, monthly_sun_hours=monthly_sun,
        aoi_hourly_surface=aoi_surface, aoi_hourly_lit=aoi_lit,
        seconds=time.time() - t0,
    )


# ---------------------------------------------------------------- the audit


def shading_discrepancy(tier: DayTier) -> dict:
    """How far the analytic canyon shading differs from the ray-traced mask.

    Computed on the event day, where both were produced, and published so the
    annual tier's short cut carries a measured cost rather than a caveat. Only
    the ground band can differ — the raster vetoes that band alone — so the
    figure is reported for the ground band and for the whole facade.
    """
    if tier.lit_analytic is None:
        return {}
    a, r = tier.lit_analytic, tier.lit
    ground_a, ground_r = a[:, :, 0], r[:, :, 0]
    disagree = int((ground_a != ground_r).sum())
    total = int(ground_a.size)
    over = int((ground_a & ~ground_r).sum())
    return {
        "basis": "event day, 8 hours, every panel",
        "ground_band_cells": total,
        "ground_band_disagreements": disagree,
        "ground_band_disagreement_fraction": round(disagree / max(total, 1), 5),
        "analytic_says_lit_raster_says_shaded": over,
        "analytic_sunlit_hours_mean": round(float(a.sum(axis=0).mean()), 4),
        "raster_sunlit_hours_mean": round(float(r.sum(axis=0).mean()), 4),
        "mean_over_estimate_hours_per_band": round(
            float((a.sum(axis=0) - r.sum(axis=0)).mean()), 4),
        "reading": (
            "The analytic canyon form and the ray-traced mask can only differ in "
            "the ground band, because that is the only band the raster vetoes. "
            "The difference is the obstruction a 2-D cross-section cannot see: "
            "corners, plazas, and the far side of an intersection. The annual "
            "tier uses the analytic form alone, so its sunlit-hour totals carry "
            "this over-estimate in the ground band and none above it."
        ),
    }

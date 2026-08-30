"""The year solver: the same physics as ``heatcanyon.physics``, in array form.

WHY A SECOND IMPLEMENTATION EXISTS AT ALL

A second implementation of a physical model is normally a liability — two
versions drift and the visualisation quietly stops agreeing with the validation.
This one is written anyway, for a reason that is arithmetic rather than
architectural: the scalar engine solves 2.35 million surface energy balances for
eight hours in about a minute, which is 8,760 hours in roughly eighteen hours of
wall clock. A year at facade resolution is simply not reachable one panel at a
time.

THE RULE THAT KEEPS IT HONEST

``scripts/validate.py`` runs both engines over a random sample of panels, bands
and hours drawn from the real scene and requires agreement to better than 0.01 K
on surface temperature and 0.001 K on the air profile. Nothing here may be
"improved" independently: if the physics changes it changes in
``heatcanyon.physics`` first, and this module is brought back into line until the
check passes again. The check is not decoration — it is what makes it legitimate
to paint a year of facade temperatures the scalar engine never computed.

WHAT IS DELIBERATELY DIFFERENT, AND WHY IT IS STATED RATHER THAN HIDDEN

One thing genuinely differs, and it is a modelling choice rather than a
numerical one. The event-day tier decides whether a facade band is sunlit by
ray-marching the 3 m surface model (``geometry.shadow_raster``) and
cross-checking the analytic canyon form. The annual accumulation uses the
**analytic canyon form alone**: the shadow a wall of height H at distance W
casts up the facade opposite. Ray-marching 8,760 solar positions over an
864 x 901 grid is about two hours of pure shadow work, and the analytic form is
what the raster agrees with to within a fraction of a band anywhere the street
is a street. Where it differs is at corners, plazas and across intersections,
where the raster sees obstruction the 2-D cross-section cannot. The annual
sunlit-hour totals are therefore a slight OVER-estimate at those places, and
``annual.json`` carries the measured discrepancy against the event day so the
size of that over-estimate is a published number rather than an assumption.

The monthly tier — twelve representative days at eight hours each, the fields
the browser actually paints — uses the ray-traced rasters exactly like the event
day. Only the 8,760-hour accumulation takes the analytic short cut.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from . import physics as P
from . import solar

MATS = ["brick", "limestone", "concrete", "steel_glass", "glass_curtain"]


# ------------------------------------------------------------------ statics


@dataclass
class PanelStatics:
    """Everything about the scene that does not change with the hour.

    Shapes: ``(n_panel,)`` for panel properties, ``(n_panel, n_band)`` for band
    properties. Built once per build and reused for all 8,760 hours.
    """

    azimuth: np.ndarray          # (P,) wall outward normal bearing, deg
    z: np.ndarray                # (P,B) band centre height above the panel base, m
    h_opp: np.ndarray            # (P,) opposing wall height, m
    width: np.ndarray            # (P,) canyon width, m
    bearing: np.ndarray          # (P,) street axis bearing, deg
    svf_wall: np.ndarray         # (P,B) wall sky view factor, 0..0.5
    svf_street: np.ndarray       # (P,) street-level sky view factor
    h_mean: np.ndarray           # (P,) mean wall height of the canyon, m
    aspect: np.ndarray           # (P,) H/W
    tree_cover: np.ndarray       # (P,)
    albedo: np.ndarray           # (P,) material shortwave reflectance
    emissivity: np.ndarray       # (P,)
    f_storage: np.ndarray        # (P,) storage fraction from admittance
    d: float                     # displacement height, m
    z0: float                    # roughness length, m
    lambda_p: float

    #: (P,) canyon id per panel, -1 where a panel belongs to no canyon. Carried
    #: only so `solve_hour` can compute a canyon-local surroundings temperature;
    #: nothing else here reads it, and it defaults to None so every existing
    #: caller and every test constructing a PanelStatics by hand keeps working.
    canyon: np.ndarray | None = None

    @property
    def n_panel(self) -> int:
        return int(self.azimuth.shape[0])

    @property
    def n_band(self) -> int:
        return int(self.z.shape[1])


def svf_wall_v(z: np.ndarray, h_opposite: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Mirror of ``geometry.svf_wall_point`` over arrays.

    Hottel's infinite-strip result: a point on a wall sees half the sky dome
    minus whatever the wall opposite subtends. Broadcasting ``z`` as (P,B)
    against ``h_opposite`` and ``w`` as (P,1).
    """
    h = np.asarray(h_opposite, dtype=np.float64)[:, None]
    ww = np.asarray(w, dtype=np.float64)[:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        alpha = np.arctan(np.where(ww > 0, (h - z) / np.maximum(ww, 1e-9), 0.0))
    out = 0.5 * (1.0 - np.sin(alpha))
    out = np.where(z >= h, 0.5, out)
    return np.where(ww > 0, out, 0.0)


def statics_from_scene(facades, canyons, pan_canyon, pan_material, cstates,
                       svf_band: np.ndarray | None = None, *, d: float, z0: float,
                       lambda_p: float, n_bands: int) -> PanelStatics:
    """Assemble the static arrays from the objects the pipeline already built.

    ``svf_band`` is normally left out and computed here from the same closed form
    the scalar path used, which is also what gets written to ``svf_bands.bin`` —
    so the renderer's ambient occlusion, the scalar engine and the vector engine
    are all reading one array rather than three implementations of one formula.
    """
    n = len(facades)
    az = np.array([f.azimuth for f in facades], dtype=np.float64)
    h_wall = np.array([max(f.top_m - f.base_m, 3.0) for f in facades], dtype=np.float64)
    band = (np.arange(n_bands, dtype=np.float64) + 0.5) / n_bands
    z = h_wall[:, None] * band[None, :]

    h_opp = np.zeros(n); width = np.zeros(n); bearing = np.zeros(n)
    svf_street = np.zeros(n); h_mean = np.zeros(n); aspect = np.zeros(n)
    tree = np.zeros(n)
    for p in range(n):
        ci = int(pan_canyon[p])
        if ci >= 0:
            c, st = canyons[ci], cstates[ci]
            h_opp[p] = max(c.h_left if c.h_right <= c.h_left else c.h_right, 1.0)
            width[p] = st.width_m
            bearing[p] = st.bearing
            svf_street[p] = st.svf
            h_mean[p] = st.h_mean
            aspect[p] = st.aspect_ratio
            tree[p] = st.tree_cover
        else:
            # The same open-ground fallback state the scalar path uses for a
            # panel with no canyon within 90 m.
            h_opp[p] = 0.0
            width[p] = 40.0
            bearing[p] = 0.0
            svf_street[p] = 0.8
            h_mean[p] = 10.0
            aspect[p] = 0.25
            tree[p] = 0.0

    alb = np.empty(n); emi = np.empty(n); sto = np.empty(n)
    for p in range(n):
        props = P.MATERIALS[MATS[int(pan_material[p])]]
        alb[p] = props["albedo"]
        emi[p] = props["emissivity"]
        sto[p] = min(0.40, 0.10 + 0.20 * (props["admittance"] / 1500.0))

    svf_wall = (svf_wall_v(z, h_opp, width) if svf_band is None
                else np.asarray(svf_band, dtype=np.float64).reshape(n, n_bands))

    return PanelStatics(
        azimuth=az, z=z, h_opp=h_opp, width=width, bearing=bearing,
        svf_wall=svf_wall,
        svf_street=svf_street, h_mean=h_mean, aspect=aspect, tree_cover=tree,
        albedo=alb, emissivity=emi, f_storage=sto,
        canyon=np.asarray(pan_canyon, dtype=np.int32),
        d=float(d), z0=float(z0), lambda_p=float(lambda_p),
    )


# ------------------------------------------------------------- vector physics


def canyon_wind_v(wind_10m: float, aspect: np.ndarray) -> np.ndarray:
    """Mirror of ``physics.canyon_wind``."""
    return np.maximum(0.3, wind_10m * np.exp(-0.386 * np.maximum(aspect, 0.0)))


def wind_profile(u10: float, aspect: np.ndarray, h_mean: np.ndarray,
                 z: np.ndarray) -> np.ndarray:
    """Wind at every panel band, m/s. The blend the solve itself uses.

    Factored out of ``solve_hour`` because the day reconstruction needs the same
    profile to correct for a change in wind: the surface-to-air excess goes as
    1/h_c, and h_c is 5.8 + 3.8u. Two implementations of this blend would let the
    reconstruction drift from the field it is reconstructing.
    """
    u_base = canyon_wind_v(u10, aspect)[:, None]
    frac = np.minimum(1.0, z / np.maximum(h_mean, 1.0)[:, None])
    return u_base + (u10 - u_base) * frac ** 1.5


def convective_coefficient_v(wind: np.ndarray) -> np.ndarray:
    """Mirror of ``physics.convective_coefficient``. See its docstring — the
    intercept is load-bearing and has a history."""
    return 5.8 + 3.8 * np.maximum(wind, 0.0)


def friction_velocity_v(wind_10m: float, st: PanelStatics, z_ref: float = 10.0):
    z_eff = max(z_ref, st.d + 2.0 * st.z0)
    denom = math.log(max(z_eff - st.d, 2.0 * st.z0) / st.z0)
    if denom <= 0.1:
        denom = 0.1
    return max(0.05, P.KAPPA * max(wind_10m, 0.5) / denom)


def sensible_heat_flux_v(met: P.Met, st: PanelStatics,
                         sunlit_fraction: float) -> np.ndarray:
    """Mirror of ``physics.sensible_heat_flux``, per panel."""
    s_down = met.dni * max(0.0, sunlit_fraction) + met.dhi
    alpha_bulk = 0.15 + 0.10 * st.tree_cover
    q_star = (1.0 - alpha_bulk) * s_down
    f_latent = 0.08 + 0.45 * st.tree_cover
    f_storage = 0.30 if s_down > 50.0 else -0.35
    h = q_star * np.maximum(0.0, 1.0 - f_latent - f_storage)
    if s_down <= 50.0:
        h = 25.0 * (1.0 - st.svf_street) + 5.0
    return h


def psi_h_v(zeta: np.ndarray) -> np.ndarray:
    """Mirror of ``physics.psi_h``, branch-free."""
    zeta = np.asarray(zeta, dtype=np.float64)
    unstable = zeta < 0.0
    x = np.power(np.maximum(1.0 - 16.0 * np.where(unstable, zeta, 0.0), 1e-12), 0.25)
    out_unstable = 2.0 * np.log((1.0 + x * x) / 2.0)
    out_stable = -5.0 * np.minimum(np.where(unstable, 0.0, zeta), 2.0)
    return np.where(unstable, out_unstable, out_stable)


def air_temperature_profile_v(met: P.Met, st: PanelStatics,
                              sunlit_fraction: float = 0.4) -> np.ndarray:
    """Mirror of ``physics.air_temperature_at_height`` over every panel and band.

    Returns shape (P, B) in degC. The evaluation height is ``max(z, 2.0)``,
    matching the scalar caller in ``pipeline.build``.
    """
    z = np.maximum(st.z, 2.0)
    z_ref = 2.0
    h_canopy = np.maximum(st.h_mean, 6.0)[:, None]

    u_star = friction_velocity_v(met.wind_10m, st)
    h_flux = sensible_heat_flux_v(met, st, sunlit_fraction)
    theta_star = (-h_flux / (P.RHO_AIR * P.CP_AIR * u_star))[:, None]
    L = np.where(np.abs(theta_star) < 1e-6, 1e6,
                 (u_star ** 2 * met.t_air_k) / (P.KAPPA * P.G_ACCEL * theta_star))
    daytime = (met.dni + met.dhi) > 50.0

    enclosure = 1.0 - np.clip(st.svf_street, 0.0, 1.0)[:, None]
    grad = (-0.010 * (0.4 + 0.6 * enclosure) if daytime
            else -0.014 * (0.3 + 0.7 * enclosure))
    grad = np.maximum(grad, -0.95 * P.LAPSE_DRY)

    t_canopy_top = met.t_air_2m + grad * (h_canopy - z_ref)

    def most(z_eval, z_from, t_from):
        za = np.maximum(z_eval - st.d, 0.5)
        zb = np.maximum(z_from - st.d, 0.5)
        d_theta = (theta_star / P.KAPPA) * (
            np.log(za / zb) - psi_h_v(za / L) + psi_h_v(zb / L))
        return t_from + d_theta - P.LAPSE_DRY * (z_eval - z_from)

    inside = met.t_air_2m + grad * (z - z_ref)

    z_rsl = 2.0 * h_canopy
    t_rsl_top = most(z_rsl, h_canopy, t_canopy_top)
    f = (z - h_canopy) / np.maximum(z_rsl - h_canopy, 1e-6)
    blended = t_canopy_top + f * (t_rsl_top - t_canopy_top)

    above = most(z, z_rsl, t_rsl_top)
    t_adiabat = met.t_air_2m - P.LAPSE_DRY * (z - z_ref)
    above = np.clip(above, t_adiabat - 3.0, met.t_air_2m + 2.0)

    out = np.where(z <= h_canopy, inside,
                   np.where(z <= z_rsl, blended, above))
    return out


def air_uncertainty_v(st: PanelStatics) -> np.ndarray:
    """Mirror of ``physics.air_temperature_uncertainty``. Time-invariant."""
    z = np.maximum(st.z, 2.0)
    base = 0.5
    growth = 0.9 * np.log1p(np.maximum(0.0, z - 2.0) / 12.0)
    penalty = 0.5 * (1.0 - np.clip(st.svf_street, 0.0, 1.0))[:, None]
    return base + growth + penalty * np.minimum(1.0, z / 50.0)


def sunlit_v(sun: solar.SunPosition, st: PanelStatics) -> tuple[np.ndarray, np.ndarray]:
    """(lit, cos_incidence) for every panel and band, analytic canyon form.

    ``lit`` is (P, B) boolean, ``cos_incidence`` is (P,).
    """
    n, b = st.n_panel, st.n_band
    if not sun.up:
        return np.zeros((n, b), dtype=bool), np.zeros(n)

    cos_i = (math.cos(math.radians(sun.altitude))
             * np.cos(np.radians(sun.azimuth - st.azimuth)))
    facing = cos_i > 0.0

    cross = np.abs(np.sin(np.radians(sun.azimuth - st.bearing)))
    tan_alt = math.tan(math.radians(sun.altitude))
    with np.errstate(divide="ignore", invalid="ignore"):
        z_sh = st.h_opp - st.width * tan_alt / cross
    z_sh = np.where(cross < 1e-3, 0.0, np.maximum(z_sh, 0.0))

    lit = facing[:, None] & (st.z >= z_sh[:, None])
    return lit, cos_i


def wall_irradiance_v(sun: solar.SunPosition, st: PanelStatics, lit: np.ndarray,
                      cos_i: np.ndarray, *, dni: float | None = None,
                      dhi: float | None = None, cloud: float = 0.0,
                      ground_albedo: np.ndarray | float = 0.15) -> np.ndarray:
    """Mirror of ``solar.wall_irradiance``'s ``total``, over (P, B).

    ``dni``/``dhi`` override the cloud-parameterised reconstruction. The year
    passes the ERA5 values straight in, because for a year of hours the observed
    beam and diffuse are better information than a reconstruction from cloud
    fraction — and the reconstruction stays in ``solar.sky_irradiance`` as the
    validated cross-check it has always been.
    """
    if not sun.up:
        return np.zeros((st.n_panel, st.n_band))
    if dni is None or dhi is None:
        dni, dhi = solar.sky_irradiance(sun, cloud)

    beam = np.where(lit & (cos_i[:, None] > 0.0),
                    dni * np.maximum(0.0, cos_i)[:, None], 0.0)
    diffuse = dhi * np.clip(st.svf_wall / 0.5, 0.0, 1.0) * 0.5
    ghi = dni * math.cos(math.radians(sun.zenith)) + dhi
    reflected = ground_albedo * ghi * np.maximum(0.0, 0.5 - st.svf_wall)
    return beam + diffuse + reflected


def surface_temperature_v(met: P.Met, st: PanelStatics, sw: np.ndarray,
                          wind: np.ndarray, t_surroundings: float,
                          max_iter: int = 14) -> np.ndarray:
    """Mirror of ``physics.surface_temperature`` over (P, B).

    The scalar version breaks out of its damped fixed point as soon as the step
    falls under 0.01 K. Here every element takes the same number of steps and
    the ones that have converged simply stop moving — which is why the two agree
    to far better than 0.01 K rather than merely to the tolerance. Iterating a
    converged element is a few wasted flops; branching per element would cost
    far more than that.
    """
    t_air = met.t_air_2m
    h_c = convective_coefficient_v(wind)
    t_sky_k = met.sky_temperature + 273.15
    t_sur_k = t_surroundings + 273.15

    alb = st.albedo[:, None]
    eps = st.emissivity[:, None]
    f_sto = st.f_storage[:, None]

    sw_abs = (1.0 - alb) * np.maximum(0.0, sw)
    f_sky = np.clip(st.svf_wall, 0.0, 1.0)
    lw_in = eps * (f_sky * P.SIGMA * t_sky_k ** 4
                   + (1.0 - f_sky) * P.SIGMA * t_sur_k ** 4)

    return _fixed_point(np.full(sw.shape, t_air + 2.0, dtype=np.float64),
                        t_air, sw_abs, lw_in, eps, f_sto, h_c, max_iter)


# -------------------------------------------------------------- the hour step


@dataclass
class HourTerms:
    """The vector mirror of ``physics.SurfaceTerms``, over (P, B).

    Only the five arrays that vary per element are carried. ``h_c``, ``h_r``,
    ``f_storage`` and ``f_sky`` are recoverable from ``PanelStatics`` and the
    wind for the hour, and holding four more (P,B) float32 planes for the whole
    year would cost more memory than the fields the browser actually paints.
    """

    dt_solar: np.ndarray         # (P,B) float32, K
    dt_trap: np.ndarray          # (P,B) float32, K
    dt_sky: np.ndarray           # (P,B) float32, K — negative
    k: np.ndarray                # (P,B) float32, K per W/m2
    residual: np.ndarray         # (P,B) float32, K — the linearisation error

    def scaled(self, t_surface: np.ndarray, t_air: np.ndarray) -> dict:
        """The three planes rescaled to sum exactly to the observed rise, K.

        The vector mirror of ``physics.SurfaceTerms.scaled``, and the same rule
        applies: this is what gets quoted in kelvin, the raw planes are what
        gets checked. See that property for why a single multiplicative factor
        is a legitimate correction rather than a cosmetic one — the
        linearisation error is one factor on the whole rise, so dividing it out
        restores the sum and leaves every ratio untouched.
        """
        raw = self.dt_solar + self.dt_trap + self.dt_sky
        dt = (t_surface - t_air).astype(np.float32)
        # Where the rise is negligible the factor is numerically meaningless and
        # there are no ratios worth preserving, so those elements are left as
        # they are rather than multiplied by a ratio of two near-zeros.
        live = (np.abs(raw) > 1e-6) & (np.abs(dt) > 1e-6)
        f = np.ones_like(raw)
        np.divide(dt, raw, out=f, where=live)
        return {"solar": self.dt_solar * f, "trap": self.dt_trap * f,
                "sky": self.dt_sky * f, "factor": f}


@dataclass
class HourFields:
    """One hour, solved over every panel and band."""

    surface: np.ndarray          # (P,B) degC
    air: np.ndarray              # (P,B) degC
    lit: np.ndarray              # (P,B) bool
    irradiance: np.ndarray       # (P,B) W/m2 absorbed-side incident shortwave
    terms: HourTerms | None = None   # only when solve_hour(want_terms=True)


def hour_terms(met: P.Met, st: PanelStatics, sw: np.ndarray, wind: np.ndarray,
               sky_c: np.ndarray, t_surroundings: float | np.ndarray,
               t_air_local: np.ndarray, t_surface: np.ndarray) -> HourTerms:
    """Mirror of ``physics.surface_terms``'s decomposition, over (P, B).

    Pure post-processing. It takes the ``t_surface`` the fixed point already
    converged to and does closed-form arithmetic on the same inputs that
    produced it; there is no iteration here and nothing it can perturb. That is
    deliberate — an attribution that re-solved, even identically, would be a
    second place for the physics to drift from ``physics.py``.

    ``sky_c`` and ``t_air_local`` are per-element arrays because
    ``_surface_with_local_sky`` gives every band its own air and sky
    temperature, and ``h_r`` is built from that local air temperature rather
    than the hour's 2 m value: a band 200 m up can sit two kelvin cooler, which
    enters h_r as a cube and the trapping and sky terms as a fourth power.

    ``met`` is unused and kept only so the signature mirrors the scalar call.
    Everything the hour knows has already been localised into the arrays.
    """
    h_c = convective_coefficient_v(wind)
    eps = st.emissivity[:, None]
    f_sto = st.f_storage[:, None]

    sw_abs = (1.0 - st.albedo[:, None]) * np.maximum(0.0, sw)
    f_sky = np.clip(st.svf_wall, 0.0, 1.0)

    t_air_k = t_air_local + 273.15
    t_sky_k = sky_c + 273.15
    t_sur_k = np.asarray(t_surroundings, dtype=np.float64) + 273.15

    # Linearised about the LOCAL air temperature — see physics.SurfaceTerms for
    # why the expansion is taken there rather than about the surface.
    h_r = 4.0 * eps * P.SIGMA * t_air_k ** 3
    k = (1.0 - f_sto) / (h_c + (1.0 - f_sto) * h_r)

    dt_solar = k * sw_abs
    dt_trap = k * eps * (1.0 - f_sky) * P.SIGMA * (t_sur_k ** 4 - t_air_k ** 4)
    dt_sky = k * eps * f_sky * P.SIGMA * (t_sky_k ** 4 - t_air_k ** 4)
    residual = (t_surface - t_air_local) - (dt_solar + dt_trap + dt_sky)

    # float32 out, like every other annual plane: the terms are quantised to
    # 0.01 K on their way to disk anyway, and float64 would double the memory
    # a tier holds while it accumulates.
    return HourTerms(
        dt_solar=np.broadcast_to(dt_solar, sw.shape).astype(np.float32),
        dt_trap=np.broadcast_to(dt_trap, sw.shape).astype(np.float32),
        dt_sky=np.broadcast_to(dt_sky, sw.shape).astype(np.float32),
        k=np.broadcast_to(k, sw.shape).astype(np.float32),
        residual=np.broadcast_to(residual, sw.shape).astype(np.float32),
    )


def solve_hour(met: P.Met, sun: solar.SunPosition, st: PanelStatics, *,
               dni: float | None = None, dhi: float | None = None,
               lit_override: np.ndarray | None = None,
               sunlit_fraction: float = 0.4,
               t_surroundings_offset: float = 5.0,
               want_terms: bool = False,
               surroundings_iter: int = 1,
               max_iter: int = 14) -> HourFields:
    """Solve one hour over the whole scene.

    ``lit_override`` lets the monthly tier hand in the ray-traced mask so that
    the fields the browser paints come from the same shadow geometry the event
    day used, while the annual accumulation leaves it out and takes the analytic
    canyon form.

    ``want_terms`` is off by default and must stay that way for the annual pass.
    The decomposition is cheap next to the fixed point, but 8,760 hours times
    five extra (P,B) planes is not free, and nothing in the accumulation reads
    them; the tiers that do ask for them ask for a few hundred hours.

    ``surroundings_iter`` IS THE ONE PLACE THIS ENGINE WAS BEHIND THE SCALAR ONE.

    A wall's longwave environment is the other surfaces of its own canyon, and
    ``physics.solve_canyon`` gets that by iterating: assume a bulk surroundings
    temperature, solve every panel, recompute the area-weighted mean, repeat.
    This function assumed ``t_air + 5 K`` for the whole scene and never revised
    it — which is defensible for the annual accumulation, where it was written,
    because the surface temperature it produces is within a few tenths of a
    kelvin and the accumulation is 8,760 hours of it.

    It is not defensible for the ATTRIBUTION. ``dt_trap`` is driven by
    ``T_sur^4 - T_air^4``, so a fixed offset makes the trapping term a near
    constant everywhere and every band with any sun on it comes back
    solar-dominated. The finding that a deep canyon's lower floors are heated by
    the wall opposite rather than by the sun — the finding that decides whether
    shading is the right measure at all — cannot survive a constant surroundings
    temperature, because that finding IS the variation in it.

    So with ``surroundings_iter > 1`` the scene is solved, a per-canyon
    area-weighted mean wall temperature is formed, and the scene is solved again
    against it. Two passes is enough: the coupling is strongly damped by the
    fourth-power emission, and the scalar engine converges in a handful.

    One difference from the scalar engine is deliberate and is stated rather than
    hidden. The bulk mean here is over WALLS ONLY, because walls are all this
    engine carries; ``solve_canyon``'s mean also includes the road and the roofs.
    In a deep canyon — where the trapping term matters and where this correction
    changes an answer — a wall mostly sees the wall opposite, so the two are
    close. In an open street they diverge, and there the trapping term is small
    enough that it does not change which measure is selected.

    Default 1, so the annual pass, ``scripts/validate.py``'s scalar/vector
    equivalence check and every existing caller are bit-for-bit unchanged.
    """
    lit, cos_i = sunlit_v(sun, st)
    if lit_override is not None:
        lit = lit_override
    irr = wall_irradiance_v(sun, st, lit, cos_i, dni=dni, dhi=dhi,
                            cloud=met.cloud_fraction)
    air = air_temperature_profile_v(met, st, sunlit_fraction)

    # Wind blends from the canyon value at street level to the free-stream value
    # at roof height, with the same 1.5 exponent the scalar path uses.
    u = wind_profile(met.wind_10m, st.aspect, st.h_mean, st.z)

    # The scalar path builds a LOCAL Met at the band's own air temperature, so
    # the sky temperature it uses is the one belonging to that height. Reproduced
    # here rather than approximated: sky temperature enters as T^4 and a 2 K
    # error in it is not negligible.
    local = _local_sky_temperature(air, met)
    t_sur = met.t_air_2m + t_surroundings_offset
    t_s = _surface_with_local_sky(met, st, irr, u, local, t_sur, air, max_iter)

    for _ in range(max(0, int(surroundings_iter) - 1)):
        nxt = canyon_surroundings(st, t_s, fallback=t_sur)
        if nxt is None:
            break
        # Damped, like the scalar engine's outer loop, for the same reason: the
        # coupling is a fourth power and an undamped update oscillates.
        t_sur = t_sur + 0.7 * (nxt - t_sur)
        t_s = _surface_with_local_sky(met, st, irr, u, local, t_sur, air, max_iter)

    terms = (hour_terms(met, st, irr, u, local, t_sur, air, t_s)
             if want_terms else None)
    return HourFields(surface=t_s, air=air, lit=lit, irradiance=irr, terms=terms)


def canyon_surroundings(st: PanelStatics, t_s: np.ndarray,
                        fallback: float) -> np.ndarray | None:
    """Area-weighted mean wall temperature of each panel's own canyon, (P,1).

    This is the longwave environment a wall actually exchanges with, in place of
    one scene-wide constant. Returns None when the statics carry no canyon
    identity, so a caller built by hand in a test degrades to the constant
    rather than failing.

    Panels outside any canyon — a free-standing wall, an edge of the padded ring
    — keep the fallback. There is no canyon around them to average, and taking
    the scene mean instead would import a deep canyon's trapped heat onto an
    open facade, which is the exact error this function exists to remove.
    """
    if st.canyon is None:
        return None
    cid = np.asarray(st.canyon, dtype=np.int64)
    if cid.shape[0] != t_s.shape[0]:
        return None

    # Panel weight is its wall area: the band height times the plan length. The
    # engine does not carry plan length, so bands are weighted equally within a
    # panel and panels equally within a canyon — which is the same assumption
    # the scalar engine's `area_weight` makes for two facades of equal height.
    mean_panel = t_s.mean(axis=1)
    n = int(cid.max()) + 1 if cid.size and cid.max() >= 0 else 0
    if n <= 0:
        return None
    valid = cid >= 0
    sums = np.bincount(cid[valid], weights=mean_panel[valid], minlength=n)
    counts = np.bincount(cid[valid], minlength=n)
    per_canyon = np.divide(sums, counts, out=np.full(n, fallback, dtype=np.float64),
                           where=counts > 0)
    out = np.full(t_s.shape[0], float(fallback), dtype=np.float64)
    out[valid] = per_canyon[cid[valid]]
    return out[:, None]


def _local_sky_temperature(air: np.ndarray, met: P.Met) -> np.ndarray:
    """Sky temperature for a local Met carrying ``air`` as its 2 m temperature.

    Mirror of ``Met.sky_temperature`` and ``Met.dew_point``: both are properties
    of the local air temperature, so a band 200 m up gets its own value.
    """
    a, b = 17.62, 243.12
    rh = min(max(met.rh_percent, 1.0), 100.0)
    gamma = np.log(rh / 100.0) + a * air / (b + air)
    tdp = (b * gamma / (a - gamma)) / 100.0
    eps_clear = np.clip(0.711 + 0.56 * tdp + 0.73 * tdp * tdp, 0.6, 1.0)
    c = min(max(met.cloud_fraction, 0.0), 1.0)
    eps = eps_clear + (1.0 - eps_clear) * c
    return (air + 273.15) * eps ** 0.25 - 273.15


def _surface_with_local_sky(met: P.Met, st: PanelStatics, sw: np.ndarray,
                            wind: np.ndarray, sky_c: np.ndarray,
                            t_surroundings: float, t_air_local: np.ndarray,
                            max_iter: int) -> np.ndarray:
    """``surface_temperature_v`` with per-element air and sky temperatures."""
    h_c = convective_coefficient_v(wind)
    t_sky_k = sky_c + 273.15
    t_sur_k = t_surroundings + 273.15

    alb = st.albedo[:, None]
    eps = st.emissivity[:, None]
    f_sto = st.f_storage[:, None]

    sw_abs = (1.0 - alb) * np.maximum(0.0, sw)
    f_sky = np.clip(st.svf_wall, 0.0, 1.0)
    lw_in = eps * (f_sky * P.SIGMA * t_sky_k ** 4
                   + (1.0 - f_sky) * P.SIGMA * t_sur_k ** 4)

    return _fixed_point(t_air_local + 2.0, t_air_local, sw_abs, lw_in, eps,
                        f_sto, h_c, max_iter)


def _fixed_point(t_s, t_air, sw_abs, lw_in, eps, f_sto, h_c, max_iter):
    """The damped fixed point, with the scalar engine's break reproduced exactly.

    ``physics.surface_temperature`` breaks out the moment its step falls under
    0.01 K, taking the undamped value. Continuing to iterate a converged element
    here would leave it slightly MORE converged than the scalar answer, and the
    two would then differ by up to the tolerance — which is precisely the size of
    discrepancy the validation check exists to rule out. So a converged element
    is frozen at the value the scalar loop would have returned. Freezing costs
    one boolean array; not freezing costs the check.
    """
    t_s = np.broadcast_to(np.asarray(t_s, dtype=np.float64),
                          sw_abs.shape).astype(np.float64, copy=True)
    # Everything the loop needs, allocated once. Fourteen iterations over
    # 294,150 cells is 4 million element-writes per temporary, and NumPy's
    # default of a fresh array per sub-expression made allocation, not
    # arithmetic, the cost of the annual pass.
    gain = (1.0 - f_sto) / h_c
    base = t_air + (sw_abs + lw_in) * gain
    coef = eps * P.SIGMA * gain
    live = np.ones(t_s.shape, dtype=bool)
    t_new = np.empty_like(t_s)
    for _ in range(max_iter):
        # t_new = t_air + (sw + lw_in - eps*sigma*T^4) * (1-f_sto)/h_c, folded so
        # the loop body is one power, one multiply and one subtract.
        np.add(t_s, 273.15, out=t_new)
        np.power(t_new, 4.0, out=t_new)
        np.multiply(t_new, coef, out=t_new)
        np.subtract(base, t_new, out=t_new)
        step = t_new - t_s
        hit = live & (np.abs(step) < 0.01)
        np.copyto(t_s, t_new, where=hit)
        np.copyto(t_s, t_s + 0.55 * step, where=live & ~hit)
        live &= ~hit
        if not live.any():
            break
    return t_s

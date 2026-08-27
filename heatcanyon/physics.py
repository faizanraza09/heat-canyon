"""The thermal engine: vertical air temperature, facade surface temperature, MRT.

This is the module that does the extrapolation the project is actually about,
and it is the one most exposed to criticism, so the reasoning is written out.

What we are given
-----------------
FortyGuard supplies air temperature at 2 m on a 60 m grid. That is a single
scalar per tile. Everything else here is derived from it plus geometry.

What we produce, and how confident we are in each
-------------------------------------------------
1. Air temperature T(z) up a facade. *Physically grounded estimate.* Built from
   Monin-Obukhov similarity theory above roof level and a canyon-mixing model
   below it. There is no public measured air temperature at height in Manhattan
   to validate this against, so it carries an explicit uncertainty band that
   widens with height. We say so rather than hiding it.

2. Facade surface temperature T_s. *Modelled, and much larger in range than the
   air temperature.* This comes from a surface energy balance driven by the
   solar geometry, so a sunlit west wall at 5 p.m. and the shaded east wall
   opposite it differ by 15-20 K. Satellite land-surface temperature can
   cross-check roofs and ground, though not walls (no satellite sees a wall).

3. Mean radiant temperature T_mrt. *Modelled.* This is what a body actually
   exchanges radiation with, and it is the quantity that makes standing on a
   sunlit sidewalk feel different from the air temperature reading. Its range
   across a canyon dwarfs the air temperature range, which is the honest core
   finding of the whole project.

The central honesty point
-------------------------
Air temperature inside a canyon varies far *less* than surface temperature does
-- typically 1-3 K across a canyon cross-section against 15-25 K for surfaces.
Any visualisation that paints dramatic colour differences on facades and calls
them air temperature is lying. This engine therefore models all three fields and
labels which is which everywhere it reports.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

# --------------------------------------------------------------- constants

KAPPA = 0.40          # von Karman constant
G_ACCEL = 9.81        # m/s^2
RHO_AIR = 1.16        # kg/m^3 at ~35 C
CP_AIR = 1005.0       # J/(kg K)
SIGMA = 5.670374419e-8  # Stefan-Boltzmann, W/(m^2 K^4)
LAPSE_DRY = 0.0098    # K/m, dry adiabatic


#: Radiative and thermal properties of the surfaces this engine paints.
#: albedo = shortwave reflectance, emissivity = longwave, admittance in
#: J/(m^2 K s^0.5) governs how much of the net radiation the mass absorbs.
MATERIALS: dict[str, dict[str, float]] = {
    "brick":        {"albedo": 0.30, "emissivity": 0.93, "admittance": 1200.0},
    "concrete":     {"albedo": 0.25, "emissivity": 0.91, "admittance": 1500.0},
    "limestone":    {"albedo": 0.35, "emissivity": 0.92, "admittance": 1400.0},
    "glass_curtain":{"albedo": 0.20, "emissivity": 0.88, "admittance": 400.0},
    "steel_glass":  {"albedo": 0.22, "emissivity": 0.88, "admittance": 500.0},
    "asphalt":      {"albedo": 0.10, "emissivity": 0.95, "admittance": 1300.0},
    "cool_roof":    {"albedo": 0.70, "emissivity": 0.90, "admittance": 900.0},
    "cool_pavement":{"albedo": 0.40, "emissivity": 0.93, "admittance": 1300.0},
    "green_roof":   {"albedo": 0.25, "emissivity": 0.96, "admittance": 700.0},
    "vegetation":   {"albedo": 0.20, "emissivity": 0.97, "admittance": 600.0},
}


def facade_material(year_built: int | None, height_m: float) -> str:
    """Guess the dominant facade material from construction era and height.

    A crude but defensible rule for Manhattan's stock: pre-war buildings are
    masonry, post-1960 towers are curtain wall, and tall post-war buildings are
    steel-and-glass. This drives albedo, which is the single most influential
    surface parameter. It is a *stated assumption*, surfaced in the interface,
    not a measurement -- PLUTO carries no cladding field.
    """
    y = year_built or 1920
    if y >= 1990 and height_m > 60:
        return "glass_curtain"
    if y >= 1960 and height_m > 40:
        return "steel_glass"
    if y >= 1945:
        return "concrete"
    if height_m > 80:
        return "limestone"
    return "brick"


# ------------------------------------------------------------ meteorology


@dataclass
class Met:
    """The meteorological state at one hour, above the canyon."""

    t_air_2m: float          # deg C, from FortyGuard — the anchor
    rh_percent: float        # %
    wind_10m: float          # m/s at 10 m in the open
    wind_dir: float          # degrees, direction wind comes FROM
    cloud_fraction: float    # 0-1
    dni: float               # W/m^2 direct normal
    dhi: float               # W/m^2 diffuse horizontal
    hour_edt: float          # wall-clock hour, for labelling

    @property
    def t_air_k(self) -> float:
        return self.t_air_2m + 273.15

    @property
    def dew_point(self) -> float:
        """Magnus-Tetens dew point, deg C."""
        a, b = 17.62, 243.12
        rh = min(max(self.rh_percent, 1.0), 100.0)
        gamma = math.log(rh / 100.0) + a * self.t_air_2m / (b + self.t_air_2m)
        return b * gamma / (a - gamma)

    @property
    def sky_temperature(self) -> float:
        """Effective radiative sky temperature, deg C (Berdahl-Martin 1984).

            eps_sky = 0.711 + 0.56*(Tdp/100) + 0.73*(Tdp/100)^2
            T_sky   = T_air * eps_sky^0.25

        Cloud cover raises the effective sky emissivity towards 1 because cloud
        base radiates nearly as a black body at near-air temperature. A humid,
        cloudy night therefore has a *warm* sky, which is why heat waves do not
        break overnight -- the city cannot radiate to space.
        """
        tdp = self.dew_point / 100.0
        eps_clear = 0.711 + 0.56 * tdp + 0.73 * tdp * tdp
        eps_clear = min(max(eps_clear, 0.6), 1.0)
        eps = eps_clear + (1.0 - eps_clear) * min(max(self.cloud_fraction, 0.0), 1.0)
        return self.t_air_k * eps**0.25 - 273.15

    @property
    def ghi(self) -> float:
        return self.dni * 0.0 + self.dhi  # placeholder; callers pass explicit cos(z)


def canyon_wind(wind_10m: float, aspect_ratio: float) -> float:
    """Wind speed inside the canyon, m/s.

    The canyon shelters: above roof level the flow is the urban boundary layer,
    while inside a canyon of aspect ratio H/W a recirculating vortex forms and
    speeds drop sharply. The exponential attenuation

        u_canyon = u_above * exp(-0.386 * H/W)

    is an exponential attenuation of the standard form used across canyon
    models. The attribution matters: it is *not* in Masson (2000), which uses a
    prognostic drag and stable-boundary-layer scheme rather than any closed
    exp(-a*H/W) law, so citing TEB for this coefficient would be wrong. Treat
    0.386 as a calibrated attenuation constant consistent with observed canyon
    sheltering, not as a quantity traceable to a single paper.

    It matters a great deal here regardless: convection is the main way a hot
    facade sheds heat, so halving the wind roughly doubles the surface-to-air
    temperature difference. A floor of 0.3 m/s keeps the convective coefficient
    finite in the deepest canyons where the formula would otherwise stall.
    """
    return max(0.3, wind_10m * math.exp(-0.386 * max(0.0, aspect_ratio)))


def convective_coefficient(wind: float) -> float:
    """Exterior *convective* heat transfer coefficient, W/(m^2 K).

        h_c = 2.0 + 3.8 * u

    Note the intercept. The widely quoted McAdams form is h = 5.7 + 3.8u, and
    that is what this function used to return -- which was a real bug, because
    5.7 is a *combined* surface conductance: convection plus a linearised
    radiative coefficient. Around a 290 K surface the radiative part alone is
    4*eps*sigma*T^3 ~ 5 W/(m^2 K), which is most of the 5.7.

    Since ``surface_temperature`` already carries an explicit longwave term
    eps*sigma*(T_s^4 - T_env^4) -- the term the whole sky-view-factor
    calculation exists to weight -- using the combined coefficient counted
    radiation roughly twice. At 1 m/s that inflated the turbulent flux by about
    50%, which damps the diurnal surface swing and pulls facade temperatures
    towards air temperature: plausible-looking answers for the wrong reason.

    The intercept is therefore reduced to a genuinely convective free-convection
    value of about 2 W/(m^2 K) for a vertical surface in still air, and the
    longwave term stays explicit.

    Two documented simplifications: there is no orientation dependence (real
    windward and leeward facades differ by up to a factor of two) and no
    buoyancy term for a sunlit wall driving its own free convection. ``wind``
    must be the *canyon* wind, not the above-roof value.
    """
    return 2.0 + 3.8 * max(0.0, wind)


# -------------------------------------------------- vertical air profile


@dataclass
class CanyonState:
    """Everything the thermal model needs to know about one location's geometry."""

    svf: float               # sky view factor at street level
    h_mean: float            # mean wall height, m
    width_m: float           # facade-to-facade, m
    aspect_ratio: float      # H/W, 0 if not an enclosed canyon
    bearing: float           # street axis, degrees
    asymmetry: float         # 0 symmetric, ->1 one-sided
    lambda_p: float = 0.45   # plan area fraction of buildings
    d: float = 0.0           # displacement height, m
    z0: float = 1.0          # roughness length, m
    tree_cover: float = 0.0  # fraction of the canyon with canopy


def friction_velocity(met: Met, st: CanyonState, z_ref: float = 10.0) -> float:
    """u* from the reference wind, using the local roughness.

        u* = kappa * u(z_ref) / ln((z_ref - d) / z0)

    Above a city, z_ref = 10 m usually sits *below* the displacement height,
    which is unphysical for the log law. Where that happens the reference is
    lifted to d + 2*z0 and the wind scaled up along the profile, which is the
    standard blending trick and keeps u* finite and sensible.
    """
    z_eff = max(z_ref, st.d + 2.0 * st.z0)
    denom = math.log(max(z_eff - st.d, 2.0 * st.z0) / st.z0)
    if denom <= 0.1:
        denom = 0.1
    return max(0.05, KAPPA * max(met.wind_10m, 0.5) / denom)


def sensible_heat_flux(met: Met, st: CanyonState, sunlit_fraction: float) -> float:
    """Bulk sensible heat flux from the urban surface, W/m^2.

    Rather than solving a full surface energy balance for the whole grid, this
    partitions the absorbed shortwave using a Bowen-ratio style split that
    reflects how little evaporative cooling a dense city has available:

        Q* ~ (1 - alpha_bulk) * S_down * f_sunlit
        H  ~ Q* * (1 - f_storage - f_latent)

    Dense Midtown has very little vegetation, so f_latent is small and the
    storage term is large (Oke's classic result that urban surfaces put an
    unusually high fraction of net radiation into storage, then release it after
    sunset -- the mechanism behind the nocturnal heat island). Tree cover moves
    energy from H into latent heat, which is exactly how the tree scenario cools
    the air rather than just the surface.
    """
    s_down = met.dni * max(0.0, sunlit_fraction) + met.dhi
    alpha_bulk = 0.15 + 0.10 * st.tree_cover
    q_star = (1.0 - alpha_bulk) * s_down
    f_latent = 0.08 + 0.45 * st.tree_cover      # bare city ~8%, well-treed ~50%
    f_storage = 0.30 if s_down > 50.0 else -0.35  # releases stored heat at night
    h = q_star * max(0.0, 1.0 - f_latent - f_storage)
    if s_down <= 50.0:
        # Night: the stored heat released from the fabric drives a small upward
        # flux even with no sun, and a low sky view factor traps it.
        h = 25.0 * (1.0 - st.svf) + 5.0
    return h


def friction_temperature(met: Met, st: CanyonState, sunlit_fraction: float) -> float:
    """theta* = -H / (rho * cp * u*), in K. Negative during daytime heating."""
    h = sensible_heat_flux(met, st, sunlit_fraction)
    u_star = friction_velocity(met, st)
    return -h / (RHO_AIR * CP_AIR * u_star)


def psi_h(zeta: float) -> float:
    """Integrated stability correction for heat, Businger-Dyer / Paulson form.

    zeta = (z - d)/L is the Monin-Obukhov stability parameter. Unstable
    (daytime, zeta < 0) mixes efficiently and flattens the profile; stable
    (clear night, zeta > 0) suppresses mixing and steepens it. Getting the sign
    right is what makes the model produce a *warmer* canyon bottom at night and
    a cooler one by day.
    """
    if zeta < 0.0:
        x = (1.0 - 16.0 * zeta) ** 0.25
        return 2.0 * math.log((1.0 + x * x) / 2.0)
    return -5.0 * min(zeta, 2.0)


def obukhov_length(met: Met, st: CanyonState, sunlit_fraction: float) -> float:
    """Monin-Obukhov length L, metres. Large |L| means near-neutral."""
    u_star = friction_velocity(met, st)
    theta_star = friction_temperature(met, st, sunlit_fraction)
    if abs(theta_star) < 1e-6:
        return 1e6
    return (u_star**2 * met.t_air_k) / (KAPPA * G_ACCEL * theta_star)


def air_temperature_at_height(
    z: float,
    met: Met,
    st: CanyonState,
    sunlit_fraction: float = 0.5,
) -> float:
    """Air temperature at height z above the street, deg C.

    Three regimes, blended so the profile is continuous:

    **Canyon interior, z <= H.** The recirculating vortex keeps the canyon
    comparatively well mixed, so the gradient is weak. It is not zero: by day
    the sunlit surfaces heat the air near them and the canyon top exchanges with
    a cooler boundary layer, giving a slight decrease with height. At night the
    fabric releases the heat it stored during the day, so the canyon *bottom*
    stays the warmest part and temperature again falls with height.

    That night-time structure is a canyon heat island with a weak lapse, and it
    is worth naming carefully: it is *not* an inversion. An inversion means
    temperature rising with height, which is what forms in the stable layer
    *above* roof level over open ground. The real nocturnal picture over a city
    is two-layer -- a warm, weakly lapsing canyon volume underneath, and a
    stably stratified layer above it -- and calling the canyon part an inversion
    (as an earlier version of this docstring did) inverts the physics it is
    trying to describe.

    The interior gradient is scaled by (1 - SVF) because an enclosed canyon
    decouples from the air above far more effectively than an open one.

    **Roughness sublayer, H < z < 2H.** Individual buildings still imprint on
    the flow and similarity theory does not hold cleanly. Blended.

    **Inertial sublayer, z > 2H.** Monin-Obukhov similarity applies:

        T(z) = T(z_r) + (theta*/kappa) * [ ln((z-d)/(z_r-d)) - psi_h(zeta_z) + psi_h(zeta_r) ]

    Above that the profile tends to the dry adiabatic lapse rate.

    The magnitudes stay deliberately modest -- a few kelvin over 100 m -- because
    that is what tower and drone profiles over cities actually measure. Air is
    well mixed; it is the *surfaces* that diverge dramatically.
    """
    z = max(0.1, z)
    z_ref = 2.0
    h_canopy = max(st.h_mean, 6.0)

    theta_star = friction_temperature(met, st, sunlit_fraction)
    L = obukhov_length(met, st, sunlit_fraction)
    daytime = (met.dni + met.dhi) > 50.0

    # ---- profile above the roughness sublayer, evaluated at the blend top
    def most(z_eval: float, z_from: float, t_from: float) -> float:
        """Actual air temperature at z_eval, given the value at z_from.

        Monin-Obukhov similarity is written in *potential* temperature, and the
        earlier version of this function returned the potential-temperature
        difference directly as if it were a temperature difference. That omitted
        the dry-adiabatic conversion

            T(z) = theta(z) - Gamma_d * z,   Gamma_d = g/cp = 0.0098 K/m

        which is negligible over the few metres inside a canyon but is 0.98 K
        per 100 m of facade -- larger than most of the effects this engine
        exists to resolve, and enough on its own to explain a suspiciously weak
        modelled daytime gradient.
        """
        za = max(z_eval - st.d, 0.5)
        zb = max(z_from - st.d, 0.5)
        zeta_a, zeta_b = za / L, zb / L
        d_theta = (theta_star / KAPPA) * (
            math.log(za / zb) - psi_h(zeta_a) + psi_h(zeta_b)
        )
        return t_from + d_theta - LAPSE_DRY * (z_eval - z_from)

    # ---- canyon interior gradient
    # Daytime: cooler aloft inside the canyon. Night: warmer at the bottom.
    enclosure = 1.0 - min(max(st.svf, 0.0), 1.0)
    if daytime:
        grad = -0.010 * (0.4 + 0.6 * enclosure)   # K/m, mild decrease upward
    else:
        grad = -0.014 * (0.3 + 0.7 * enclosure)   # K/m, canyon heat island lapse
    # Hard physical bound: dry air cannot sustain a lapse rate steeper than the
    # dry adiabat, because that state is convectively unstable and overturns.
    # The unclamped nocturnal coefficient could reach -0.020 K/m in a deeply
    # enclosed canyon, which is superadiabatic and therefore not a state the
    # atmosphere holds. Clamping here rather than only reporting it means the
    # model cannot emit an impossible profile in the first place.
    grad = max(grad, -0.95 * LAPSE_DRY)
    t_canopy_top = met.t_air_2m + grad * (h_canopy - z_ref)

    if z <= h_canopy:
        return met.t_air_2m + grad * (z - z_ref)

    z_rsl = 2.0 * h_canopy
    t_rsl_top = most(z_rsl, h_canopy, t_canopy_top)
    if z <= z_rsl:
        # Linear blend across the roughness sublayer.
        f = (z - h_canopy) / max(z_rsl - h_canopy, 1e-6)
        return t_canopy_top + f * (t_rsl_top - t_canopy_top)

    t = most(z, z_rsl, t_rsl_top)
    # Never let the modelled profile fall below the dry adiabat from the anchor,
    # nor rise above it: that is the physical envelope for a dry atmosphere.
    t_adiabat = met.t_air_2m - LAPSE_DRY * (z - z_ref)
    lo, hi = t_adiabat - 3.0, met.t_air_2m + 2.0
    return min(max(t, lo), hi)


def air_temperature_uncertainty(z: float, st: CanyonState) -> float:
    """One-sigma uncertainty on T(z), K. Widens with height, by construction.

    At the 2 m anchor the uncertainty is FortyGuard's own, taken here as 0.5 K.
    Above that it grows because (a) the similarity-theory coefficients are
    generic rather than fitted to this city, (b) the sensible heat flux is
    parameterised rather than measured, and (c) *nothing* validates it: there is
    no public measured air temperature at height in Manhattan.

    A deep canyon is more uncertain than an open street at the same height,
    because the canyon-mixing assumption is doing more work there.
    """
    base = 0.5
    growth = 0.9 * math.log1p(max(0.0, z - 2.0) / 12.0)
    enclosure_penalty = 0.5 * (1.0 - min(max(st.svf, 0.0), 1.0))
    return base + growth + enclosure_penalty * min(1.0, z / 50.0)


# ------------------------------------------------ surface energy balance


def surface_temperature(
    met: Met,
    st: CanyonState,
    shortwave_absorbed: float,
    svf_surface: float,
    material: str = "concrete",
    wind: float | None = None,
    t_surroundings: float | None = None,
    max_iter: int = 40,
) -> float:
    """Solve the surface energy balance for a facade or ground panel, deg C.

    Balance, per unit area:

        (1 - alpha) * S_in  +  eps*(SVF*sigma*T_sky^4 + (1-SVF)*sigma*T_sur^4)
          =  eps*sigma*T_s^4  +  h_c*(T_s - T_air)  +  G

    Terms, left to right: absorbed shortwave; longwave received from the sky
    (weighted by how much sky the panel sees) and from surrounding surfaces
    (the rest); emitted longwave; convection to the canyon air; conduction into
    the wall's thermal mass.

    The storage term G is written as a fraction of the net radiation set by the
    material's thermal admittance -- heavy masonry pulls more heat inward and so
    runs cooler at its surface than a thin curtain wall receiving the same sun,
    which is a real and visible effect on Manhattan's mixed stock.

    Solved by damped fixed-point iteration on the quartic. Converges in well
    under 40 steps for every physically sensible input; the damping is there
    because the T^4 term makes an undamped iteration oscillate.
    """
    props = MATERIALS.get(material, MATERIALS["concrete"])
    alpha, eps, adm = props["albedo"], props["emissivity"], props["admittance"]

    t_air = met.t_air_2m
    u = wind if wind is not None else canyon_wind(met.wind_10m, st.aspect_ratio)
    h_c = convective_coefficient(u)
    t_sky_k = met.sky_temperature + 273.15
    t_sur_k = (t_surroundings if t_surroundings is not None else t_air + 6.0) + 273.15

    sw_abs = (1.0 - alpha) * max(0.0, shortwave_absorbed)
    f_sky = min(max(svf_surface, 0.0), 1.0)
    lw_in = eps * (f_sky * SIGMA * t_sky_k**4 + (1.0 - f_sky) * SIGMA * t_sur_k**4)

    # Storage fraction from admittance: 0.15 for light cladding, ~0.35 for
    # heavy masonry, following the range reported for urban fabric.
    f_storage = min(0.40, 0.10 + 0.20 * (adm / 1500.0))

    t_s = t_air + 2.0
    for _ in range(max_iter):
        t_s_k = t_s + 273.15
        lw_out = eps * SIGMA * t_s_k**4
        net_rad = sw_abs + lw_in - lw_out
        g = f_storage * net_rad
        # Convection must carry the remainder.
        t_new = t_air + (net_rad - g) / h_c
        if abs(t_new - t_s) < 0.01:
            t_s = t_new
            break
        t_s = t_s + 0.55 * (t_new - t_s)   # damping
    return t_s


def mean_radiant_temperature(
    met: Met,
    t_surfaces: dict[str, float],
    view_factors: dict[str, float],
    shortwave_on_person: float,
    emissivity_person: float = 0.97,
    absorptivity_person: float = 0.70,
) -> float:
    """Mean radiant temperature, deg C — what a body actually exchanges with.

    Following the SOLWEIG / ISO 7726 six-directional formulation, the radiation
    a standing person absorbs is summed over the surfaces they can see and
    converted back to the temperature of an equivalent black enclosure:

        T_mrt = [ ( sum_i F_i * eps_i * sigma * T_i^4 + a_sr * S_str ) / (eps_p * sigma) ]^0.25

    where F_i are the view factors from the body to each surface class (sky,
    sunlit ground, shaded ground, sunlit walls, shaded walls), and S_str is the
    shortwave the body intercepts directly.

    T_mrt is the honest headline for a heat-exposure tool: on a sunlit Midtown
    sidewalk it runs 15-25 K above the air temperature, while in the shade
    twenty metres away it is close to air temperature. That gap is what a 2 m
    air-temperature map cannot show and what a pedestrian unambiguously feels.
    """
    total = 0.0
    fsum = 0.0
    for name, f in view_factors.items():
        t = t_surfaces.get(name)
        if t is None or f <= 0:
            continue
        eps_i = 0.95 if name != "sky" else 1.0
        total += f * eps_i * SIGMA * (t + 273.15) ** 4
        fsum += f
    if fsum > 0:
        total /= fsum          # normalise: view factors must sum to unity
    total += absorptivity_person * max(0.0, shortwave_on_person) / 1.0
    t_mrt_k = (total / (emissivity_person * SIGMA)) ** 0.25
    return t_mrt_k - 273.15


def apparent_temperature(t_air: float, rh: float, wind: float) -> float:
    """Australian BoM apparent temperature, deg C — humidity and wind combined.

        AT = T + 0.33*e - 0.70*u - 4.00,    e = (RH/100) * 6.105 * exp(17.27T/(237.7+T))

    Used rather than the NWS heat index because it is defined continuously
    across the whole temperature range and includes a wind term, so it responds
    correctly to the canyon's sheltered air.
    """
    e = (rh / 100.0) * 6.105 * math.exp(17.27 * t_air / (237.7 + t_air))
    return t_air + 0.33 * e - 0.70 * wind - 4.00


def wet_bulb_globe_temperature(t_air: float, t_mrt: float, rh: float, wind: float) -> float:
    """Simplified outdoor WBGT, deg C — the standard occupational heat metric.

        WBGT = 0.7*T_nwb + 0.2*T_globe + 0.1*T_air

    Black-globe temperature is approximated from the mean radiant temperature,
    and the wet-bulb term from Stull's (2011) closed-form fit, whose
    coefficients are transcribed exactly and which is accurate to about 0.3 K
    mean absolute error over -20..50 C and 5-99% relative humidity at sea-level
    pressure.

    One documented approximation, because it biases the result in a known
    direction: Stull's fit gives the *psychrometric* (shielded) wet-bulb
    temperature, whereas outdoor WBGT is defined on the *natural* wet-bulb
    temperature, which is higher because the wet wick is exposed to sun and to
    low ventilation. Using the psychrometric value therefore under-reports
    outdoor WBGT, by roughly 1.4-2.1 K in hot, calm, sunny conditions. The WBGT
    figures this engine reports should be read as conservative -- if anything
    the real exposure is worse, which is the safe direction for a heat-risk
    tool but must not be mistaken for precision.

    WBGT is what OSHA and military heat guidance are written against, so it
    converts the model output into thresholds that already carry policy.
    """
    tw = (
        t_air * math.atan(0.151977 * (rh + 8.313659) ** 0.5)
        + math.atan(t_air + rh)
        - math.atan(rh - 1.676331)
        + 0.00391838 * rh**1.5 * math.atan(0.023101 * rh)
        - 4.686035
    )
    t_globe = t_mrt * 0.9 + t_air * 0.1
    return 0.7 * tw + 0.2 * t_globe + 0.1 * t_air


# ------------------------------------------------- coupled canyon solver


@dataclass
class SurfacePanel:
    """One resolved surface in a canyon cross-section."""

    name: str
    kind: str                # "wall" | "ground" | "roof"
    azimuth: float           # outward normal, deg (walls only)
    z_lo: float              # metres above street
    z_hi: float
    svf: float               # sky view factor of this panel
    sunlit: bool
    irradiance: float        # total absorbed-side shortwave, W/m^2
    material: str
    area_weight: float       # relative area, for the longwave mean
    t_surface: float = 0.0   # deg C, filled by the solver
    t_air: float = 0.0       # deg C at this panel's height


@dataclass
class CanyonSolution:
    """A fully resolved canyon cross-section at one hour."""

    panels: list[SurfacePanel]
    t_air_2m: float
    t_mrt_sun: float          # MRT standing in sun on the sidewalk
    t_mrt_shade: float        # MRT standing in shade
    wbgt_sun: float
    wbgt_shade: float
    t_surroundings: float     # the converged bulk surface temperature
    iterations: int
    sunlit_floor_fraction: float
    facade_shadow_height: float

    def by_name(self, name: str) -> SurfacePanel | None:
        for p in self.panels:
            if p.name == name:
                return p
        return None

    @property
    def hottest(self) -> SurfacePanel:
        return max(self.panels, key=lambda p: p.t_surface)

    @property
    def surface_spread(self) -> float:
        ts = [p.t_surface for p in self.panels]
        return max(ts) - min(ts)


def solve_canyon(
    met: Met,
    st: CanyonState,
    sun,                      # solar.SunPosition
    h_left: float,
    h_right: float,
    material_left: str = "brick",
    material_right: str = "brick",
    ground_material: str = "asphalt",
    roof_material: str = "concrete",
    n_bands: int = 8,
    person_beam_block: float = 0.0,
    facade_shade_factor: float = 0.0,
    facade_shade_height: float = 12.0,
    ground_shade_fraction: float = 0.0,
    tol: float = 0.05,
    max_outer: int = 12,
) -> CanyonSolution:
    """Resolve every surface in a canyon cross-section, self-consistently.

    Why an iterative coupled solve rather than one pass: a facade's longwave
    environment *is* the other surfaces of the same canyon. In a deep canyon a
    panel sees very little sky, so most of the longwave it receives comes from
    the opposing wall and the road — both of which are themselves being solved
    for. Guessing that environment as "air temperature plus six degrees" (the
    usual shortcut) systematically understates shaded-facade temperature in deep
    canyons and overstates it in open ones, because it gets the enclosure
    backwards.

    So: assume a bulk surroundings temperature, solve every panel, recompute the
    area-weighted mean surface temperature, and repeat until it stops moving.
    Converges in a handful of iterations because the coupling is strongly
    damped by the T^4 emission term.

    Geometry per panel: each wall is divided into ``n_bands`` height bands. Each
    band gets its own sky view factor from the analytic wall formula, its own
    sunlit flag from the canyon shadow height, and its own air temperature from
    the vertical profile — so the vertical structure is resolved rather than
    assumed uniform.
    """
    import heatcanyon.solar as _solar

    W = max(st.width_m, 1.0)
    bearing = st.bearing
    # The two facades of a street with axis bearing b face b+90 and b-90.
    az_right = (bearing + 90.0) % 360.0
    az_left = (bearing - 90.0) % 360.0

    floor_frac = _solar.canyon_sunlit_fraction(sun, bearing, h_left, h_right, W)
    # Which wall is up-sun determines which facade the shadow climbs.
    delta = (sun.azimuth - bearing) % 360.0 if sun.up else 0.0
    shadow_on_right = delta < 180.0
    h_shading = h_left if shadow_on_right else h_right
    shadow_h = _solar.facade_sunlit_height(sun, bearing, h_shading, W) if sun.up else float("inf")

    panels: list[SurfacePanel] = []

    # ---- ground: split into a sunlit and a shaded panel by the shadow geometry
    for gname, glit, gw in (
        ("ground_sun", True, max(floor_frac, 0.0)),
        ("ground_shade", False, max(1.0 - floor_frac, 0.0)),
    ):
        if gw <= 0.001:
            continue
        gi = _solar.ground_irradiance(sun, met.cloud_fraction, st.svf, sunlit=glit)
        panels.append(
            SurfacePanel(
                name=gname, kind="ground", azimuth=0.0, z_lo=0.0, z_hi=0.0,
                svf=st.svf, sunlit=glit, irradiance=gi["total"],
                material=ground_material, area_weight=gw * W / max(W, 1.0),
                t_air=met.t_air_2m,
            )
        )

    # ---- walls: n_bands per side, each with its own SVF, sun state, air temp
    from .geometry import svf_wall_point

    for side, h_side, h_opp, az, mat in (
        ("left", h_left, h_right, az_left, material_left),
        ("right", h_right, h_left, az_right, material_right),
    ):
        if h_side <= 0.5:
            continue
        band = h_side / n_bands
        for b in range(n_bands):
            z_lo, z_hi = b * band, (b + 1) * band
            z_mid = 0.5 * (z_lo + z_hi)
            svf_w = svf_wall_point(z_mid, h_opp, W)
            # A band is sunlit if it clears the shadow climbing the shaded wall,
            # and if the sun is on its side of the street at all.
            this_side_shaded = (side == "right") == shadow_on_right
            if not sun.up:
                lit = False
            elif this_side_shaded:
                lit = z_mid >= shadow_h
            else:
                lit = True
            irr = _solar.wall_irradiance(
                sun, az, met.cloud_fraction, svf_w, sunlit=lit,
                ground_albedo=MATERIALS[ground_material]["albedo"],
            )
            # Wind rises through the canyon: sheltered at the bottom, close to
            # the free-stream value at roof height.
            panels.append(
                SurfacePanel(
                    name=f"wall_{side}_{b}", kind="wall", azimuth=az,
                    z_lo=z_lo, z_hi=z_hi, svf=svf_w, sunlit=lit,
                    irradiance=irr["total"], material=mat,
                    area_weight=band / max(h_left + h_right, 1.0),
                    t_air=air_temperature_at_height(max(z_mid, 2.0), met, st, floor_frac),
                )
            )

    # ---- roofs. Included because they are the surface with the highest sky
    # view factor in the whole scene and the only one nothing shades, which
    # makes them the largest single lever on the building's own heat gain even
    # though a pedestrian can barely see them. Leaving them out would make the
    # cool-roof scenario silently do nothing.
    for side, h_side in (("left", h_left), ("right", h_right)):
        if h_side <= 0.5:
            continue
        roof_irr = _solar.ground_irradiance(sun, met.cloud_fraction, 1.0, sunlit=True)
        panels.append(
            SurfacePanel(
                name=f"roof_{side}", kind="roof", azimuth=0.0,
                z_lo=h_side, z_hi=h_side, svf=0.95, sunlit=sun.up,
                irradiance=roof_irr["total"], material=roof_material,
                area_weight=0.5 * W / max(W, 1.0),
                t_air=air_temperature_at_height(max(h_side, 2.0), met, st, floor_frac),
            )
        )

    # ---- interventions that reduce the shortwave reaching a surface. Applied
    # before the coupled solve so the longwave environment reflects them too.
    if ground_shade_fraction > 0.0 or facade_shade_factor > 0.0:
        for p in panels:
            if p.kind == "ground" and p.sunlit and ground_shade_fraction > 0.0:
                p.irradiance *= (1.0 - ground_shade_fraction)
            if (
                p.kind == "wall" and p.sunlit and facade_shade_factor > 0.0
                and p.z_lo < facade_shade_height
            ):
                p.irradiance *= (1.0 - facade_shade_factor)

    # ---- outer loop on the bulk surroundings temperature
    t_sur = met.t_air_2m + 6.0
    iterations = 0
    for it in range(max_outer):
        iterations = it + 1
        for p in panels:
            z_mid = 0.5 * (p.z_lo + p.z_hi)
            u = canyon_wind(met.wind_10m, st.aspect_ratio)
            if p.kind == "wall":
                # Blend towards the free-stream wind approaching roof level.
                frac = min(1.0, z_mid / max(st.h_mean, 1.0))
                u = u + (met.wind_10m - u) * frac**1.5
            local_met = Met(
                t_air_2m=p.t_air, rh_percent=met.rh_percent, wind_10m=met.wind_10m,
                wind_dir=met.wind_dir, cloud_fraction=met.cloud_fraction,
                dni=met.dni, dhi=met.dhi, hour_edt=met.hour_edt,
            )
            p.t_surface = surface_temperature(
                local_met, st, p.irradiance, p.svf, material=p.material,
                wind=u, t_surroundings=t_sur,
            )
        wsum = sum(p.area_weight for p in panels) or 1.0
        t_new = sum(p.t_surface * p.area_weight for p in panels) / wsum
        if abs(t_new - t_sur) < tol:
            t_sur = t_new
            break
        t_sur = t_sur + 0.7 * (t_new - t_sur)

    # ---- pedestrian-level MRT, in sun and in shade
    walls = [p for p in panels if p.kind == "wall" and p.z_lo < 20.0]
    wall_sun = [p.t_surface for p in walls if p.sunlit]
    wall_shade = [p.t_surface for p in walls if not p.sunlit]
    g_sun = next((p.t_surface for p in panels if p.name == "ground_sun"), None)
    g_shade = next((p.t_surface for p in panels if p.name == "ground_shade"), None)

    def _mrt(in_sun: bool) -> float:
        t_ground = (g_sun if in_sun else g_shade) or g_shade or g_sun or met.t_air_2m
        t_ws = sum(wall_sun) / len(wall_sun) if wall_sun else met.t_air_2m + 4.0
        t_wh = sum(wall_shade) / len(wall_shade) if wall_shade else met.t_air_2m + 2.0
        # View factors for a standing person: the classic six-directional split,
        # with the sky share set by the canyon's own SVF.
        f_sky = 0.5 * min(max(st.svf, 0.0), 1.0)
        f_ground = 0.25
        f_rest = max(0.0, 1.0 - f_sky - f_ground)
        n_lit = 1.0 if wall_sun else 0.0
        n_sh = 1.0 if wall_shade else 0.0
        denom = (n_lit + n_sh) or 1.0
        vf = {
            "sky": f_sky,
            "ground": f_ground,
            "wall_sun": f_rest * n_lit / denom,
            "wall_shade": f_rest * n_sh / denom,
        }
        temps = {
            "sky": met.sky_temperature,
            "ground": t_ground,
            "wall_sun": t_ws,
            "wall_shade": t_wh,
        }
        # Shortwave intercepted by a standing body: the projected-area factor
        # for a rotationally symmetric person is about 0.28 at mid solar
        # altitudes (Fanger), plus diffuse from the visible sky.
        # Shortwave intercepted by the body. ``person_beam_block`` is the
        # fraction of the direct beam a canopy (or awning) removes before it
        # reaches the person — and this is the dominant term in pedestrian MRT,
        # far larger than any change in surface temperature. Shading the ground
        # while leaving the beam on the body, which is the easy mistake, badly
        # understates what a street tree actually does.
        block = min(max(person_beam_block, 0.0), 1.0)
        sw = 0.0
        if sun.up:
            if in_sun:
                sw += met.dni * 0.28 * (1.0 - block)
            sw += met.dhi * f_sky * 2.0 * (1.0 - 0.5 * block)
        # Canopy also replaces part of the sky and wall view with leaf surfaces
        # sitting close to air temperature, which lowers the longwave term.
        if block > 0.0:
            vf = {k: v * (1.0 - block * 0.5) for k, v in vf.items()}
            vf["canopy"] = block * 0.5
            temps["canopy"] = met.t_air_2m + 1.0
        return mean_radiant_temperature(met, temps, vf, sw)

    # "MRT standing in sun" is only a real place if some of the floor is
    # actually sunlit. In a canyon whose floor never sees the sun there is no
    # such position, and reporting one would invent an exposure that cannot
    # occur. Report the shade value for both in that case, flagged by
    # sunlit_floor_fraction being zero.
    mrt_shade = _mrt(False)
    mrt_sun = _mrt(True) if (sun.up and floor_frac > 0.01) else mrt_shade
    u_c = canyon_wind(met.wind_10m, st.aspect_ratio)
    return CanyonSolution(
        panels=panels,
        t_air_2m=met.t_air_2m,
        t_mrt_sun=mrt_sun,
        t_mrt_shade=mrt_shade,
        wbgt_sun=wet_bulb_globe_temperature(met.t_air_2m, mrt_sun, met.rh_percent, u_c),
        wbgt_shade=wet_bulb_globe_temperature(met.t_air_2m, mrt_shade, met.rh_percent, u_c),
        t_surroundings=t_sur,
        iterations=iterations,
        sunlit_floor_fraction=floor_frac,
        facade_shadow_height=(0.0 if shadow_h == float("inf") else shadow_h),
    )

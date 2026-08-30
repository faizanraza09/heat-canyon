"""Solar position, canyon shading geometry, and surface irradiance.

Solar position follows the NOAA Solar Calculator formulation (a condensed form
of Meeus, *Astronomical Algorithms*), accurate to well under 0.1 degrees for
present-day dates — far tighter than the 3 m geometry raster needs.

The irradiance model is a clear-sky decomposition attenuated by observed cloud
cover. FortyGuard's ``env_params`` endpoint advertises a ``solar_irradiance``
parameter but does not actually return it (the ``analysis`` argument is ignored
server-side and the default response omits it), so irradiance is reconstructed
here from solar geometry and cross-checked against a free reanalysis archive.
That check is in ``scripts/validate.py``: with the standard clear-continental
turbidity tau = 0.70 and no fitted parameters, the reconstruction tracks the
ERA5 archive's hourly global horizontal irradiance on the study day to 37 W/m^2
RMS, which is 7.3% of the mean daytime value, with a +2.5% bias.

One convention trap worth recording: reanalysis archives report radiation as a
*preceding-hour mean*, not an instantaneous value at the label. Comparing an
instantaneous model against them produces an apparent one-hour phase error and
inflates the residual to 26% -- all of it an artefact. Model irradiance is
therefore integrated over the preceding hour before any comparison.

Timezone convention throughout this project: the FortyGuard API labels hours in
local *standard* time (GMT-5) year-round. New York is on EDT (GMT-4) in July, so
FortyGuard hour h is wall-clock hour h+1. Functions here take an explicit UTC
offset so the two can never be silently confused.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Solar constant at the top of the atmosphere, W/m^2.
SOLAR_CONSTANT = 1361.0


@dataclass(frozen=True)
class SunPosition:
    """Where the sun is, and how strongly it is shining, at one instant."""

    altitude: float        # degrees above the horizon (negative = below)
    azimuth: float         # degrees clockwise from true north
    declination: float     # degrees
    hour_angle: float      # degrees
    air_mass: float        # relative optical air mass (Kasten-Young)
    dni_clear: float       # clear-sky direct normal irradiance, W/m^2
    dhi_clear: float       # clear-sky diffuse horizontal irradiance, W/m^2
    ghi_clear: float       # clear-sky global horizontal irradiance, W/m^2

    @property
    def up(self) -> bool:
        return self.altitude > 0.0

    @property
    def zenith(self) -> float:
        return 90.0 - self.altitude


def day_of_year(month: int, day: int, year: int = 2026) -> int:
    days = [31, 29 if _leap(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return sum(days[: month - 1]) + day


def _leap(y: int) -> bool:
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


def sun_position(
    latitude: float,
    longitude: float,
    year: int,
    month: int,
    day: int,
    hour_local: float,
    utc_offset: float = -4.0,
) -> SunPosition:
    """Solar position for a local clock time.

    ``utc_offset`` is the offset of ``hour_local`` from UTC: -4 for EDT (summer
    wall clock in New York), -5 for the EST convention the FortyGuard API uses.
    """
    doy = day_of_year(month, day, year)

    # Fractional year, radians (NOAA form).
    gamma = 2.0 * math.pi / (366.0 if _leap(year) else 365.0) * (doy - 1 + (hour_local - 12.0) / 24.0)

    # Equation of time, minutes.
    eqtime = 229.18 * (
        0.000075
        + 0.001868 * math.cos(gamma)
        - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma)
        - 0.040849 * math.sin(2 * gamma)
    )
    # Solar declination, radians.
    decl = (
        0.006918
        - 0.399912 * math.cos(gamma)
        + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma)
        + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma)
        + 0.00148 * math.sin(3 * gamma)
    )

    # True solar time, minutes past local midnight.
    time_offset = eqtime + 4.0 * longitude - 60.0 * utc_offset
    tst = hour_local * 60.0 + time_offset
    ha = math.radians(tst / 4.0 - 180.0)  # hour angle, radians

    lat = math.radians(latitude)
    cos_zen = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(ha)
    cos_zen = max(-1.0, min(1.0, cos_zen))
    zenith = math.acos(cos_zen)
    altitude = 90.0 - math.degrees(zenith)

    # Azimuth, clockwise from north.
    sin_zen = math.sin(zenith)
    if sin_zen < 1e-6:
        azimuth = 180.0
    else:
        cos_az = (math.sin(decl) - math.sin(lat) * cos_zen) / (math.cos(lat) * sin_zen)
        cos_az = max(-1.0, min(1.0, cos_az))
        azimuth = math.degrees(math.acos(cos_az))
        if math.sin(ha) > 0:          # afternoon
            azimuth = 360.0 - azimuth

    # ---------------------------------------------------------- irradiance
    if altitude <= 0.0:
        return SunPosition(altitude, azimuth, math.degrees(decl), math.degrees(ha),
                           float("inf"), 0.0, 0.0, 0.0)

    # Kasten-Young (1989) relative optical air mass — the standard form, and
    # far better behaved than 1/cos(z) at low sun angles.
    am = 1.0 / (cos_zen + 0.50572 * (altitude + 6.07995) ** -1.6364)

    # Eccentricity correction of the earth-sun distance.
    e0 = 1.0 + 0.033 * math.cos(2.0 * math.pi * doy / 365.0)
    extraterrestrial = SOLAR_CONSTANT * e0

    # ASHRAE-style clear-sky transmittance. tau ~= 0.7 is the classic clear
    # continental value; raising it to am**0.678 is Meinel's empirical fit and
    # reproduces measured DNI well across the whole air-mass range.
    dni = extraterrestrial * 0.7 ** (am**0.678)
    # Liu-Jordan diffuse fraction for clear sky: about 10% of the beam's
    # horizontal component reaches the surface as Rayleigh-scattered diffuse.
    dhi = 0.10 * dni * cos_zen
    ghi = dni * cos_zen + dhi

    return SunPosition(
        altitude=altitude,
        azimuth=azimuth,
        declination=math.degrees(decl),
        hour_angle=math.degrees(ha),
        air_mass=am,
        dni_clear=dni,
        dhi_clear=dhi,
        ghi_clear=ghi,
    )


# ------------------------------------------------------------ cloud effects


def cloud_attenuation(cloud_fraction: float) -> tuple[float, float]:
    """Return (beam multiplier, diffuse multiplier) for a cloud fraction 0-1.

    Kasten-Czeplak (1980) is the standard relation for global irradiance under
    partial cloud:

        GHI / GHI_clear = 1 - 0.75 * C^3.4

    Clouds suppress the beam far more than the global total, because scattered
    light is redirected into the diffuse component rather than lost. The split
    used here sends the beam down steeply while letting diffuse rise, so the
    global total matches Kasten-Czeplak while the beam/diffuse ratio stays
    physical. This matters for facades: under overcast, a west wall stops being
    special because there is no beam left to favour it.
    """
    c = min(max(cloud_fraction, 0.0), 1.0)
    global_mult = 1.0 - 0.75 * c**3.4
    beam_mult = max(0.0, (1.0 - c) ** 1.6)
    return (beam_mult, global_mult)


def sky_irradiance(sun: SunPosition, cloud_fraction: float) -> tuple[float, float]:
    """Actual (DNI, DHI) after cloud attenuation, W/m^2.

    Diffuse is taken as the residual of the cloud-adjusted global budget once
    the attenuated beam's horizontal component is removed, so the two components
    always sum back to a Kasten-Czeplak-consistent global irradiance.
    """
    if not sun.up:
        return (0.0, 0.0)
    beam_mult, global_mult = cloud_attenuation(cloud_fraction)
    dni = sun.dni_clear * beam_mult
    ghi = sun.ghi_clear * global_mult
    dhi = max(0.0, ghi - dni * math.cos(math.radians(sun.zenith)))
    return (dni, dhi)


# ------------------------------------------------------- surface incidence


def cos_incidence_vertical(sun: SunPosition, wall_azimuth: float) -> float:
    """cos of the beam incidence angle on a vertical wall facing ``wall_azimuth``.

        cos(theta) = cos(altitude) * cos(azimuth_sun - azimuth_wall)

    Negative means the wall is facing away from the sun (self-shaded), which is
    clamped to zero by callers. This single term is what makes a west facade the
    hottest surface in the city at 5 p.m. while the east facade opposite it has
    already been in shadow for hours.
    """
    if not sun.up:
        return 0.0
    d = math.radians(sun.azimuth - wall_azimuth)
    return math.cos(math.radians(sun.altitude)) * math.cos(d)


def wall_irradiance(
    sun: SunPosition,
    wall_azimuth: float,
    cloud_fraction: float,
    svf: float,
    sunlit: bool = True,
    ground_albedo: float = 0.15,
    dni: float | None = None,
    dhi: float | None = None,
) -> dict[str, float]:
    """Shortwave load on a vertical facade panel, W/m^2, split by component.

    Three terms, all of which a facade actually receives:

    * beam      direct sun, zero if the panel is shaded by another building or
                faces away from the sun
    * diffuse   sky-scattered, scaled by the panel's own sky view factor
    * reflected ground-bounced, scaled by (1 - SVF_sky_for_wall) as a proxy for
                the fraction of the panel's view occupied by ground and other
                walls, times the ground albedo

    The reflected term is small over asphalt but becomes significant over light
    pavement, which is exactly the lever the cool-pavement scenario pulls.

    ``dni``/``dhi`` override the cloud-parameterised reconstruction with observed
    values. The year tier passes ERA5's own beam and diffuse straight in: for
    8,760 hours the reanalysis's radiation is better information than a
    reconstruction from cloud fraction, and ``sky_irradiance`` remains what
    ``scripts/validate.py`` checks the reconstruction against. Passing neither
    keeps the original behaviour exactly.
    """
    if dni is None or dhi is None:
        dni, dhi = sky_irradiance(sun, cloud_fraction)
    cos_i = cos_incidence_vertical(sun, wall_azimuth)
    beam = dni * max(0.0, cos_i) if (sunlit and cos_i > 0.0) else 0.0

    # A vertical surface with an unobstructed view sees half the sky dome.
    diffuse = dhi * max(0.0, min(svf / 0.5, 1.0)) * 0.5
    ghi = dni * math.cos(math.radians(sun.zenith)) + dhi if sun.up else 0.0
    reflected = ground_albedo * ghi * max(0.0, 0.5 - svf) if sun.up else 0.0

    return {
        "beam": beam,
        "diffuse": diffuse,
        "reflected": reflected,
        "total": beam + diffuse + reflected,
        "cos_incidence": cos_i,
    }


def ground_irradiance(
    sun: SunPosition, cloud_fraction: float, svf: float, sunlit: bool = True,
    dni: float | None = None, dhi: float | None = None,
) -> dict[str, float]:
    """Shortwave load on the canyon floor, W/m^2.

    ``dni``/``dhi`` override the reconstruction; see ``wall_irradiance``.
    """
    if dni is None or dhi is None:
        dni, dhi = sky_irradiance(sun, cloud_fraction)
    cos_zen = math.cos(math.radians(sun.zenith)) if sun.up else 0.0
    beam = dni * cos_zen if sunlit else 0.0
    diffuse = dhi * max(0.0, min(svf, 1.0))
    return {"beam": beam, "diffuse": diffuse, "total": beam + diffuse}


# ------------------------------------------------- canyon shading geometry


def canyon_sunlit_fraction(
    sun: SunPosition, street_bearing: float, h_left: float, h_right: float, width: float
) -> float:
    """Fraction of the canyon floor width in direct sun. Analytic cross-check.

    The shadow a wall of height H casts across the canyon floor has horizontal
    length

        L = H / tan(altitude) * |sin(azimuth_sun - street_bearing)|

    The sine term is the projection of the shadow onto the cross-street
    direction: when the sun is aligned with the street axis the term vanishes
    and the canyon is fully lit down its length regardless of how deep it is,
    which is why Manhattanhenge is a heat event as well as a photograph.

    The raster shadow mask in ``geometry.shadow_raster`` is what the engine
    actually uses; this closed form exists to sanity-check it and to explain the
    orientation effect in the interface.
    """
    if not sun.up:
        return 0.0
    if width <= 0:
        return 0.0
    alt = math.radians(sun.altitude)
    if math.tan(alt) <= 1e-6:
        return 0.0
    cross = abs(math.sin(math.radians(sun.azimuth - street_bearing)))
    # Whichever wall is up-sun casts into the canyon.
    delta = (sun.azimuth - street_bearing) % 360.0
    h_shading = h_left if delta < 180.0 else h_right
    shadow = h_shading / math.tan(alt) * cross
    return max(0.0, min(1.0, 1.0 - shadow / width))


def facade_sunlit_height(
    sun: SunPosition, street_bearing: float, h_opposite: float, width: float
) -> float:
    """Height above the canyon floor below which a facade is shaded, metres.

    The opposing wall of height H at distance W casts a shadow that climbs the
    facade to

        z_shadow = H - W * tan(altitude) / |sin(azimuth_sun - street_bearing)|

    so everything above ``z_shadow`` is in sun. This is the quantity that puts a
    bright hot band across the upper floors of a street while the lower floors
    sit in shade — the single most recognisable feature of a real 3 p.m. street
    canyon, and one a 2 m reading cannot express at all.
    """
    if not sun.up:
        return float("inf")
    cross = abs(math.sin(math.radians(sun.azimuth - street_bearing)))
    if cross < 1e-3:
        return 0.0  # sun down the street axis: whole facade lit
    z = h_opposite - width * math.tan(math.radians(sun.altitude)) / cross
    return max(0.0, z)


if __name__ == "__main__":
    # Midtown Manhattan on the study day, wall-clock EDT.
    lat, lon = 40.7550, -73.9825
    print(f"{'EDT':>5} {'alt':>7} {'azim':>7} {'AM':>6} {'DNI':>7} {'GHI':>7}"
          f"  {'W-facade':>9} {'E-facade':>9} {'S-facade':>9}")
    for h in range(5, 21):
        s = sun_position(lat, lon, 2026, 7, 2, h + 0.5, utc_offset=-4.0)
        if not s.up:
            print(f"{h:5d} {s.altitude:7.1f} {s.azimuth:7.1f}   (below horizon)")
            continue
        w = wall_irradiance(s, 270.0, 0.0, 0.30)["total"]
        e = wall_irradiance(s, 90.0, 0.0, 0.30)["total"]
        so = wall_irradiance(s, 180.0, 0.0, 0.30)["total"]
        print(f"{h:5d} {s.altitude:7.1f} {s.azimuth:7.1f} {s.air_mass:6.2f}"
              f" {s.dni_clear:7.0f} {s.ghi_clear:7.0f}  {w:9.0f} {e:9.0f} {so:9.0f}")

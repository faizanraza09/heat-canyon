"""Solved surface temperatures into watts, floor by floor.

A building-energy model reaches for **sol-air temperature** at this point. It has
to: it knows the outdoor air temperature and the incident solar radiation, but
not the wall's actual surface temperature, so it invents an equivalent air
temperature that would produce the same conduction and drives the wall with that.
Sol-air is a workaround for a missing number.

This model is not missing that number. ``physics.surface_temperature`` solves the
full surface energy balance — absorbed shortwave, longwave from the sky and from
the surfaces opposite, emission, convection into the canyon air and storage into
the fabric — coupled across the canyon and ray-traced for shading, at ten bands
up every facade panel. So the conduction term here is the direct one:

    q_band = U * A_band * (T_surface - T_indoor)

with the surface temperature the model actually computed. That is the whole
reason this module exists rather than a spreadsheet, and it is why a west wall at
18:00 and the east wall opposite it produce genuinely different floor loads
instead of two numbers derived from the same sol-air value.

What is added to it
-------------------
* **Transmitted solar** through the glazed fraction, ``SHGC * I_band *
  A_glazed``, where ``I_band`` is the incident irradiance the solar model already
  resolves per band including the shading of the building opposite.
* **Ventilation** against the band's *own* air temperature. ``physics`` resolves
  air temperature with height, and floor 22 of a canyon does not breathe the 2 m
  reading; using the 2 m value would flatten the one vertical gradient this
  project spent its modelling effort on.
* **Internal gains** over the floor plate, from ``envelope.Occupancy``.

What is assumed, and it is a lot
--------------------------------
Everything about the envelope: U-value, window-to-wall ratio, SHGC, infiltration,
internal gain. All of it comes from ``envelope.py``'s assumption table as a
*range*, and every figure this module returns is a ``(lo, hi)`` pair produced by
running the entire calculation twice — once at the low corner of the table and
once at the high corner. That is not a confidence interval and is not presented
as one; it is the spread between two defensible readings of the same rule, and
collapsing it to a midpoint anywhere would turn an honest "somewhere between 4
and 7 kW" into a false "5.5 kW". Load is monotone in each of the five assumed
inputs, so the two corners do bracket the table.

The floor plate is assumed too. ``building_floors`` is handed facade panels, not
a footprint, so the conditioned area per storey is reconstructed from the
envelope perimeter under a stated plan depth (``PLAN_DEPTH_M``). This is the one
place a geometric assumption enters, it is a single stated scalar rather than a
range that then gets averaged, and it affects internal gains, ventilation and the
free-running indoor estimate but not the conduction or solar terms, which run off
real panel geometry.

The indoor temperature is an estimate and says so
-------------------------------------------------
``t_indoor_free_c`` is a **steady-state** balance between envelope gain,
ventilation and internal gain with no mechanical cooling. It is an ESTIMATE, it
is not a dynamic building simulation, and every docstring, field comment and
returned ``basis`` string says so.

It borrows exactly two things from a dynamic method, because without them it is
not merely imprecise but wrong by more than ten kelvin, and a wrong indoor
temperature is worse than none:

* the wall's **decrement factor and time lag** (``DECREMENT``, ``LAG_HOURS``), so
  that a solid-masonry wall damps its own 51 degC afternoon peak to a fifth of
  its swing and delivers it seven hours later instead of putting it straight into
  the room. Glazing has no mass and is not damped at all.
* the room's **internal admittance** (``ADMITTANCE``), so that the afternoon
  solar gain lands on the floor slab and the partitions before it lands in the
  air. Solving each hour as an independent steady state gives the room no mass
  whatever, and the first version of this module did exactly that and put a
  pre-war apartment at 50 degC.

Both come from the CIBSE admittance procedure, which is the standard algebraic
approximation to the dynamic answer and stops well short of being one. What is
still missing is real: no capacity carried across days, so the first hot day
after a cool spell is overstated; no occupant behaviour, so nobody closes the
blinds in the afternoon or opens the windows at night; and a single ventilation
rate standing in for a decision a resident makes hourly. The estimate biases
**high** on all three counts.

``peak_w`` is likewise the instantaneous *gain* at the setpoint, not a
mass-damped room cooling load. The decrement factor damps the wall's share of it,
but the solar gain through glass is radiant, lands on the room's surfaces first
and is released over the following hours — the effect ASHRAE's radiant time
series exists to capture. A heavy building's true peak cooling load is therefore
somewhat lower and somewhat later than the figure here. That is stated rather
than corrected, because correcting it properly means a dynamic model.

Floors and bands
----------------
The model solves ten bands up a panel; PLUTO says how many storeys there are.
``band_of_floor(f) = floor(f * n_bands / floors)`` maps one to the other, and
``FloorLoad.storeys_in_band`` reports how many storeys shared a band so the
schedule never implies a storey-level resolution the physics does not have. Two
storeys in one band get identical numbers, and saying so is better than
interpolating between bands to manufacture a difference that was never solved.

Faces do not sum to the floor peak, and that is real
----------------------------------------------------
``FaceLoad.conduction_w`` and ``solar_gain_w`` are reported at that face's own
worst hour. An east face peaks at 09:00 and the west face opposite it at 18:00,
so the faces of one floor deliberately do not add up to ``FloorLoad.peak_w``,
which is taken at the floor's coincident worst hour. Forcing them to add would
mean either inventing a simultaneous peak that never happens or hiding when each
face is actually in trouble, and the timing is what a shading decision turns on.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import numpy as np

from . import physics
from .envelope import Assembly, Occupancy
from .exposure import compass


# ----------------------------------------------------------------- constants

#: Plan depth of a Manhattan floor plate, metres. The perimeter comes from real
#: panel geometry; the plate is then reconstructed as a rectangle of this depth,
#: falling back to a square for buildings too small to be that deep. Twenty-two
#: metres is the double-loaded-corridor depth that dominates the residential
#: stock and is close to the lot depth of a standard 100 ft Manhattan block lot
#: less the rear yard. Deliberately a single stated scalar, not a range: this is
#: a geometric assumption about shape, and inventing a range for it and then
#: averaging it would be exactly the collapse this layer forbids.
PLAN_DEPTH_M = 22.0

#: Fraction of the storey height that is conditioned air rather than slab and
#: ceiling void. Used only for the ventilation volume, where it is a 15 per cent
#: correction; leaving it out would overstate infiltration by that much.
CEILING_FRACTION = 0.85

#: Gross floor area per dwelling unit, m2, including the share of corridors,
#: stairs and lobby. NYC multifamily stock runs 80-100 m2 gross per unit; 90 is
#: used to convert a floor plate into a resident count where no unit count is
#: available. Checked against 10 Park Avenue, where it recovers 268 units to
#: within about twenty per cent.
M2_PER_DWELLING = 90.0

#: Indoor dry-bulb above which a floor is counted as exposed, degC. This is not
#: the cooling setpoint — that lives on ``Occupancy`` — but the threshold health
#: guidance uses for indoor heat in a residential setting, and it is the number
#: ``hours_indoor_over_threshold`` counts against.
INDOOR_THRESHOLD_C = 28.0

#: Cooling season, 1 June to 30 September: 122 days, 2,928 hours. ``annual_kwh``
#: is a cooling-season figure and is labelled one. Running the same conduction
#: integral over the whole year would return a large negative number, because
#: the annual mean facade in New York is well below any indoor setpoint, and a
#: negative "annual cooling load" is not a useful thing to put in front of a
#: planner. The winter side of the trade-off is carried instead by
#: ``FaceLoad.winter_sun_share``, which is what a shading decision needs.
COOLING_SEASON_HOURS = 2928.0
COOLING_SEASON_LABEL = "1 June - 30 September"

#: Share of the year's incident shortwave on a vertical surface that arrives
#: inside the cooling season. Carried as a range because it is strongly
#: orientation-dependent — a south wall collects a large part of its annual total
#: in winter when the sun is low and normal to it, an east or west wall collects
#: most of it in summer — and this module has no per-orientation source for it.
#: Widened rather than guessed narrow, per the module's own rule.
SUMMER_DOSE_SHARE = (0.35, 0.50)

#: Fallback only: how many days of the cooling season carry a load equal to the
#: solved day's, when no annual planes are supplied. The solved event day is a
#: heat-wave day, so the equivalent count is far below the season's 122. Wide,
#: because it is a fallback and a wrong narrow number would be worse than a wide
#: one. When ``annual`` is supplied this constant is not used at all.
EQUIVALENT_EVENT_DAYS = (30.0, 70.0)

#: Below this surface-to-air difference neither driver is worth naming and the
#: attribution reports "ambient". Lifted verbatim from ``SurfaceTerms.dominant``
#: in docs/DECISIONS.md section 1 so the floor schedule and the panel-level
#: attribution cannot label the same band differently.
AMBIENT_K = 1.5

#: Sky view factor thresholds for night recovery, from ``SurfaceTerms``. Note the
#: scale: a vertical surface sees at most half the sky dome, so this project's
#: wall SVF runs 0 to 0.5 and 0.35 is a genuinely open wall, not a middling one.
RECOVERY_GOOD = 0.35
RECOVERY_LIMITED = 0.15

#: Decrement factor by thermal mass: the fraction of the *fluctuation* about the
#: daily mean surface temperature that reaches the inside face of the opaque
#: wall. This is the one dynamic effect a steady-state balance cannot be allowed
#: to ignore, and leaving it out was not a small error: driving a solid-masonry
#: wall with its own instantaneous 51 degC afternoon surface temperature puts the
#: inside of a pre-war apartment at 50 degC, which is nonsense. A three-wythe
#: brick wall damps the swing to a fifth of itself and delivers it seven hours
#: later; a curtain-wall spandrel delivers nearly all of it at once. The daily
#: mean passes through undamped in both cases, which is why a heavy building is
#: still hot — just hot at midnight rather than at three in the afternoon, which
#: is the whole overnight-exposure argument of this project.
#:
#: Method and magnitudes from the CIBSE admittance procedure (Guide A, dynamic
#: thermal properties): decrement factor and time lag for the standard wall
#: constructions. Glazing has no mass and is not decremented at all — its
#: conduction is instantaneous, and for a single-glazed pre-war window that term
#: is larger than the wall's.
DECREMENT = {"heavy": (0.20, 0.45), "medium": (0.40, 0.70), "light": (0.80, 1.00)}

#: Time lag by thermal mass, hours, rounded to the nearest solved hour slot. A
#: single stated scalar per mass class rather than a range: it shifts *when* the
#: load arrives, and interpolating a lag between two corners would produce a
#: schedule with two different peak hours in it.
LAG_HOURS = {"heavy": 7.0, "medium": 4.0, "light": 1.0}

#: Air changes per hour for the FREE-RUNNING estimate only, as distinct from the
#: infiltration rate the cooling load is computed against.
#:
#: A building with mechanical cooling is closed, and its ventilation load is the
#: assembly's infiltration rate — that is what ``peak_w`` and ``annual_kwh`` use,
#: exactly as the contract specifies. A building with no mechanical cooling is by
#: definition one whose occupants have the windows open, and modelling it at 0.5
#: ACH would have the indoor air decoupled from the outdoor air it is manifestly
#: exchanging with. Five air changes an hour is a mid-range figure for a
#: residential room with openable windows on a still summer day (ASHRAE
#: Fundamentals ch. 16 natural ventilation; CIBSE AM10).
#:
#: Deliberately a single scalar and not a range, because ventilation is the one
#: input that moves the two outputs in opposite directions — more of it raises
#: the cooling load and lowers the free-running temperature — so it cannot ride
#: along inside the low/high corner pair without making one of the two answers
#: nonsense at each end.
FREE_RUNNING_ACH = 5.0

#: Thermal admittance of the room's own internal surfaces, W/m2K, by mass class.
#: Admittance is not the same quantity as a U-value and is several times larger:
#: it measures how much heat a surface takes up over a diurnal cycle rather than
#: how much passes through it, so a plastered concrete slab with a U-value near
#: zero still has an admittance around 5. It is what actually damps the swing in
#: a free-running room, and leaving it out puts a pre-war apartment several
#: kelvin above the outdoor air at every hour of the day, which masonry
#: buildings do not do.
#:
#: CIBSE Guide A, dynamic thermal properties: heavyweight surfaces 4.5-6,
#: mediumweight 3-4.5, lightweight 1.5-2.5 W/m2K. The lower end of each band is
#: taken because carpet, furniture and suspended ceilings all cover mass that the
#: tabulated figure assumes is exposed.
ADMITTANCE = {"heavy": 4.5, "medium": 3.2, "light": 2.0}

#: Exposed internal surface area per m2 of floor plate: the floor, the ceiling
#: and roughly half a plate's worth of partitions. Residential plans are more
#: heavily partitioned than open-plan offices, and both are covered by the same
#: figure here, which is a simplification worth naming.
INTERNAL_SURFACE_RATIO = 2.5


# ------------------------------------------------------------------- inputs


@dataclass(frozen=True)
class Panel:
    """One facade panel's geometry, as ``building_floors`` needs it.

    A plain record rather than a slice of the pipeline's arrays, so the function
    stays callable from a test with six lines of synthetic input. ``index`` is
    the global panel index and is carried only so a caller can trace a face back
    to ``facades.json``; nothing here indexes with it.
    """

    index: int
    azimuth: float          # degrees, the direction the facade faces
    length_m: float         # plan length of the panel
    base_m: float           # metres above ground at the panel's foot
    top_m: float            # metres above ground at its head

    @property
    def height_m(self) -> float:
        return max(0.0, self.top_m - self.base_m)


# --------------------------------------------------------------- the outputs


@dataclass
class FaceLoad:
    """One storey's load on one facade panel, at that face's own worst hour."""

    azimuth: float
    compass: str
    area_m2: float
    glazed_m2: float
    t_peak_c: float
    peak_hour_edt: int
    conduction_w: tuple[float, float]     # lo-hi from the assembly range
    solar_gain_w: tuple[float, float]
    #: The same two terms at the BUILDING's coincident peak hour rather than at
    #: this face's own. Sizing a device wants the face's worst hour; pricing a
    #: demand charge wants the hour the meter actually reads, and they are not
    #: the same hour on any elevation that is not the one driving the building.
    #: Both are carried because both questions get asked of this record.
    conduction_coincident_w: tuple[float, float]
    solar_gain_coincident_w: tuple[float, float]
    #: Transmitted solar as a DAY MEAN rather than at any peak hour. The indoor
    #: temperature a person actually sits in is solved from the daily mean plus a
    #: damped swing about it (the CIBSE admittance procedure, see
    #: ``_solve_corner``), so the mean is the term an exposure calculation needs
    #: and a peak-hour figure would overstate it by the swing.
    solar_gain_mean_w: tuple[float, float]
    annual_kwh: tuple[float, float]       # cooling season, see COOLING_SEASON_HOURS
    #: ``annual_kwh``, kept as the two terms it is the sum of, because a measure
    #: acts on one of them and not the other. ``cond_kwh + solar_kwh ==
    #: annual_kwh`` at both ends of the range, by construction rather than by
    #: rounding. ``cond_glazed_kwh`` is the glass's share of ``cond_kwh`` — what
    #: a new unit replaces, as against the spandrel it leaves alone.
    cond_kwh: tuple[float, float]
    solar_kwh: tuple[float, float]
    cond_glazed_kwh: tuple[float, float]
    dt_solar: float
    dt_trap: float
    dt_sky: float
    sun_hours_yr: float
    winter_sun_share: float


@dataclass
class FloorLoad:
    """One storey, resolved. Every range is a corner pair, never a midpoint."""

    floor: int                       # 1-based storey
    band: int                        # which of the solved bands it sits in
    z_lo: float
    z_hi: float                      # metres above the building base
    storeys_in_band: int             # how many storeys share this band's solve
    faces: list[FaceLoad]
    envelope_m2: float
    peak_w: tuple[float, float]
    peak_hour_edt: int
    annual_kwh: tuple[float, float]
    t_surface_peak_c: float
    #: Free-running indoor dry-bulb with NO mechanical cooling. An ESTIMATE from
    #: a steady-state balance with no thermal capacity in it; see the module
    #: docstring. Not a simulated temperature and not to be rendered without the
    #: word "estimated" beside it.
    t_indoor_free_c: tuple[float, float]
    dt_solar: float
    dt_trap: float
    dt_sky: float
    dominant: str                    # "solar" | "trap" | "ambient"
    night_recovery: str              # "good" | "limited" | "none"
    hours_indoor_over_threshold: float   # per year, free-running, ESTIMATE
    person_hours: float                  # residential only, 0 otherwise
    severity: int
    #: The two sensitivities that let a measure's effect on EXPOSURE be computed
    #: without re-entering the solve, which nothing downstream can do — see
    #: ``solar_control_delta`` for why.
    #:
    #: ``t_indoor_k_per_w`` is ``1 / den_mean``: kelvin off the free-running
    #: indoor mean per watt of gain removed from this floor.
    #: ``hours_over_per_kelvin`` is ``d(hours_indoor_over_threshold) / d(offset)``,
    #: evaluated on the REAL annual air series rather than assumed — it is the
    #: density of that series at the threshold, so it is large for a floor
    #: sitting right at 28 degC and near zero for one far above or below it.
    #: A local linearisation, which is honest for the fraction of a kelvin a
    #: facade measure moves and would not be for a whole-building retrofit.
    t_indoor_k_per_w: float = 0.0
    hours_over_per_kelvin: float = 0.0                        # 0-4, for the interface stripe


@dataclass
class RoofLoad:
    """The roof plane's contribution to the top storey.

    Defined here because ``BuildingLoads`` references it and the interface needs
    a stable shape, but ``building_floors`` always returns ``None`` for it: the
    roof is not a facade panel, it is not in the arrays this function is handed,
    and manufacturing a roof temperature from the top band would be wrong by
    10-20 K because a roof has a full sky view and a wall has half of one. A
    caller that has solved the roof plane fills this in.
    """

    area_m2: float
    t_peak_c: float
    peak_hour_edt: int
    conduction_w: tuple[float, float]
    annual_kwh: tuple[float, float]
    basis: str


@dataclass
class BuildingLoads:
    """The whole schedule for one building, with its assumptions attached."""

    bin: str
    assembly: Assembly
    occupancy: Occupancy
    floors: list[FloorLoad]
    roof: RoofLoad | None
    peak_kw: tuple[float, float]
    annual_mwh: tuple[float, float]
    peak_hour_edt: int
    worst_floor: int
    person_hours: float
    basis: str
    notes: list[str] = field(default_factory=list)


# ----------------------------------------------------------- floor to band


def band_of_floor(floor_index: int, floors: int, n_bands: int) -> int:
    """Which solved band a 0-based storey index sits in.

    The formula from the contract, kept as a named function so the pipeline, the
    server and the tests cannot each round it differently. A 26-storey building
    over 10 bands puts two or three storeys in every band; the schedule reports
    ``storeys_in_band`` rather than pretending the floors within a band differ.
    """
    if floors <= 0 or n_bands <= 0:
        return 0
    return min(n_bands - 1, int(floor_index * n_bands // floors))


def floor_plate_m2(perimeter_m: float) -> float:
    """Conditioned area of one storey, m2, from the envelope perimeter.

    ``building_floors`` receives facade panels, not a footprint polygon, so the
    plate is reconstructed rather than measured. Treat the plan as a rectangle of
    depth ``PLAN_DEPTH_M``; where the perimeter is too small to admit that depth
    the shape degenerates to a square, which is the right limit for a small
    walk-up on a single lot. An L-shaped or courtyard plan is overstated by this,
    and that is stated rather than corrected, because correcting it would need
    the footprint the function was deliberately not given.
    """
    if perimeter_m <= 0.0:
        return 0.0
    depth = min(PLAN_DEPTH_M, perimeter_m / 4.0)
    width = max(depth, perimeter_m / 2.0 - depth)
    return depth * width


# ------------------------------------------------------------- the corners


@dataclass(frozen=True)
class _Corner:
    """One end of the assumption table, evaluated as a complete building.

    Cooling load rises monotonically with each of these five, so evaluating the
    all-low and all-high corners brackets the table. The alternative — perturbing
    one parameter at a time and adding the deviations — would understate the
    spread, and sampling the interior would imply a distribution the assumption
    table does not have.
    """

    name: str
    u_wall: float
    u_glass: float
    wwr: float
    shgc: float
    ach: float
    gain_w_m2: float
    decrement: float


def _corners(assembly: Assembly, occupancy: Occupancy) -> tuple[_Corner, _Corner]:
    dec = DECREMENT.get(assembly.thermal_mass, DECREMENT["medium"])
    return (
        _Corner("lo", assembly.u_wall[0], assembly.u_glass[0], assembly.wwr[0],
                assembly.shgc[0], assembly.infiltration_ach[0],
                occupancy.internal_gain_w_m2[0], dec[0]),
        _Corner("hi", assembly.u_wall[1], assembly.u_glass[1], assembly.wwr[1],
                assembly.shgc[1], assembly.infiltration_ach[1],
                occupancy.internal_gain_w_m2[1], dec[1]),
    )


# ------------------------------------------------------------ the main call


def building_floors(
    *,
    bin: str,
    floors: int,
    height_m: float,
    base_m: float,
    panels: Sequence[Panel],
    band_area: np.ndarray | None,
    surface: np.ndarray,
    air: np.ndarray,
    irradiance: np.ndarray,
    terms: Mapping[str, np.ndarray] | None,
    annual: Mapping[str, np.ndarray] | None,
    assembly: Assembly,
    occupancy: Occupancy,
    hours: Sequence[Mapping],
) -> BuildingLoads:
    """Turn one building's solved field into a per-storey cooling schedule.

    Pure by construction. Every array it needs arrives as an argument, it imports
    no pipeline, and it reads nothing from disk — so the same function serves the
    build, the server against a live ``Dataset``, and a test with six synthetic
    panels. That purity is not tidiness: it is what makes the number the
    interface shows and the number the pipeline wrote provably the same number.

    Arguments
    ---------
    bin
        The building identifier, carried through to the output untouched.
    floors, height_m, base_m
        PLUTO's storey count, the building height in metres, and the height of
        its base above the terrain datum. ``floors <= 0`` falls back to a storey
        count derived from the height, and the fallback is recorded in ``notes``.
    panels
        The building's facade panels as :class:`Panel` records. May be empty: a
        building with no panels returns an empty schedule rather than raising,
        because a footprint too small to panelise is a real and common case in
        the AOI and it must not take a build down.
    band_area
        ``(n_panel, n_band)`` m2 per band, or ``None`` to derive it as
        ``panel_length * (top - base) / n_bands``. Accepting it lets the pipeline
        pass the array it already holds; deriving it keeps the definition in one
        place for every other caller.
    surface, air, irradiance
        ``(n_hour, n_panel, n_band)``. Solved facade surface temperature (degC),
        the vertically resolved air temperature at the band (degC), and incident
        shortwave on the panel (W/m2). All three are per band, all three are
        indexed in the same panel order as ``panels``.
    terms
        The attribution, ``{"dt_solar", "dt_trap", "dt_sky"}`` each
        ``(n_panel, n_band)`` in kelvin, mirroring ``physics.SurfaceTerms`` and
        the ``dt_*_peak`` annual planes. ``None`` is allowed: the attribution
        fields come back as zero and every floor reports ``dominant ==
        "ambient"``, which is the correct thing to say when nothing has been
        attributed rather than a guess at which driver won.
    annual
        Annual planes, each ``(n_panel, n_band)`` unless noted, all optional:
        ``sun_hours``, ``winter_sun_share``, ``dose_kwh`` (incident kWh/m2/yr),
        ``summer_mean`` (summer mean surface temperature, degC), ``svf``;
        plus ``t_air_year`` (1-D, the year's hourly air temperature in degC) and
        ``summer_mean_air`` (scalar, degC). Without ``summer_mean`` and
        ``dose_kwh`` the annual energy falls back to scaling the solved day by
        ``EQUIVALENT_EVENT_DAYS``; without ``t_air_year`` the indoor exceedance
        hours are reported as zero and ``basis`` says they were not estimated,
        because a fabricated exceedance count would read as safety.
    assembly, occupancy
        From ``envelope.assembly_for`` and ``envelope.occupancy_for``. Their
        ranges are the only source of the ``(lo, hi)`` spread in the output.
    hours
        The solved hours, in array order, each a mapping with at least ``edt``.
        Used for labelling the peak hour and for the day integral's hour spacing,
        which is ``24 / len(hours)``.
    """
    notes: list[str] = []
    n_hour = int(surface.shape[0]) if surface.ndim == 3 else 0
    n_band = int(surface.shape[2]) if surface.ndim == 3 else 0
    n_panel = len(panels)

    if floors <= 0:
        floors = max(1, int(round(height_m / 3.1)))
        notes.append(
            f"PLUTO carried no floor count; {floors} storeys assumed from "
            f"{height_m:.0f} m at 3.1 m per storey.")

    if n_panel == 0 or n_hour == 0 or n_band == 0:
        # A building with no panelised facade is not an error. It happens for
        # footprints below the panelisation length and for buildings clipped at
        # the AOI edge, and the right answer is an empty schedule that every
        # consumer already knows how to render as "not resolved".
        return BuildingLoads(
            bin=bin, assembly=assembly, occupancy=occupancy, floors=[], roof=None,
            peak_kw=(0.0, 0.0), annual_mwh=(0.0, 0.0), peak_hour_edt=0,
            worst_floor=0, person_hours=0.0,
            basis=_basis(assembly, occupancy, resolved=False, annual_basis="none",
                         exceedance=False),
            notes=notes + ["No facade panels for this building; nothing resolved."],
        )

    edt = [int(h.get("edt", i)) for i, h in enumerate(hours)] if hours else list(range(n_hour))
    if len(edt) < n_hour:
        edt = edt + list(range(len(edt), n_hour))
    hour_span = 24.0 / float(n_hour)

    # ---- geometry
    length = np.array([p.length_m for p in panels], dtype=np.float64)
    p_top = np.array([p.top_m for p in panels], dtype=np.float64)
    p_base = np.array([p.base_m for p in panels], dtype=np.float64)
    azimuth = np.array([p.azimuth for p in panels], dtype=np.float64)

    if band_area is None:
        band_area = (length * np.maximum(0.0, p_top - p_base) / n_band)[:, None] \
            * np.ones((1, n_band))
    band_area = np.asarray(band_area, dtype=np.float64).reshape(n_panel, n_band)

    # One storey's envelope on one panel. Identical to band_area * n_band /
    # floors, which is panel_length * storey_height: the two definitions agree
    # and the sum over storeys equals the sum over bands exactly.
    storey_face = band_area * (float(n_band) / float(floors))

    storey_h = max(0.1, height_m / float(floors))
    perimeter = float(length.sum())
    plate_m2 = floor_plate_m2(perimeter)
    volume = plate_m2 * storey_h * CEILING_FRACTION

    surface = np.asarray(surface, dtype=np.float64)
    air = np.asarray(air, dtype=np.float64)
    irradiance = np.asarray(irradiance, dtype=np.float64)

    # Air temperature felt by the storey: the band's own air, weighted by how
    # much of the envelope faces each way. The 2 m reading is not used anywhere
    # in this module.
    w = storey_face.sum(axis=0)                      # (n_band,)
    safe_w = np.where(w > 0.0, w, 1.0)
    t_air_band = (air * storey_face[None, :, :]).sum(axis=1) / safe_w[None, :]
    t_air_band = np.where(w[None, :] > 0.0, t_air_band, air.mean(axis=1))

    # ---- the attribution, per band
    dt_solar_p, dt_trap_p, dt_sky_p = _terms_arrays(terms, n_panel, n_band)
    attributed = terms is not None
    dt_solar_b = _area_mean(dt_solar_p, storey_face)
    dt_trap_b = _area_mean(dt_trap_p, storey_face)
    dt_sky_b = _area_mean(dt_sky_p, storey_face)

    svf_p = _plane(annual, "svf", n_panel, n_band, default=0.2)
    svf_b = _area_mean(svf_p, storey_face)
    sun_hours_p = _plane(annual, "sun_hours", n_panel, n_band, default=0.0)
    winter_share_p = _plane(annual, "winter_sun_share", n_panel, n_band, default=0.0)
    dose_p = _plane(annual, "dose_kwh", n_panel, n_band, default=None)
    summer_p = _plane(annual, "summer_mean", n_panel, n_band, default=None)
    summer_air = None
    if annual is not None and annual.get("summer_mean_air") is not None:
        summer_air = float(np.asarray(annual["summer_mean_air"]).reshape(-1)[0])
    t_air_year = None
    if annual is not None and annual.get("t_air_year") is not None:
        t_air_year = np.asarray(annual["t_air_year"], dtype=np.float64).ravel()

    have_annual_planes = dose_p is not None and summer_p is not None
    annual_basis = "annual planes" if have_annual_planes else "event day scaled"
    if not have_annual_planes:
        notes.append(
            "No annual dose or summer-mean plane supplied; cooling-season energy "
            f"is the solved day scaled by {EQUIVALENT_EVENT_DAYS[0]:.0f}-"
            f"{EQUIVALENT_EVENT_DAYS[1]:.0f} equivalent event days.")

    # ---- solve both corners of the assumption table
    lo_corner, hi_corner = _corners(assembly, occupancy)
    lag_slots = int(round(LAG_HOURS.get(assembly.thermal_mass, 4.0) / hour_span))
    sol = [
        _solve_corner(c, occupancy=occupancy, storey_face=storey_face,
                      surface=surface, irradiance=irradiance,
                      t_air_band=t_air_band, volume=volume, plate_m2=plate_m2,
                      dose_p=dose_p, summer_p=summer_p, summer_air=summer_air,
                      hour_span=hour_span, share_i=i, lag_slots=lag_slots,
                      mass=assembly.thermal_mass)
        for i, c in enumerate((lo_corner, hi_corner))
    ]

    # ---- storey-level assembly
    storeys_in_band = np.zeros(n_band, dtype=int)
    for f in range(floors):
        storeys_in_band[band_of_floor(f, floors, n_band)] += 1

    t_surface_band_peak = surface.max(axis=0).max(axis=0) if n_panel else np.zeros(n_band)
    face_peak_hour = np.argmax(sol[1]["q_face"], axis=0)          # (n_panel, n_band)
    band_peak_hour = np.argmax(sol[1]["q_total"], axis=0)         # (n_band,)

    # ---- the BUILDING's coincident hour, computed before the floors so a face
    # can be reported at it as well as at its own worst hour.
    #
    # WHY THIS MOVED UP. It used to be computed after the floor loop, from the
    # assembled FloorLoads, which meant a FaceLoad could only ever report itself
    # at ITS OWN peak. That is the right hour for sizing a device and the wrong
    # one for a demand charge: Con Edison bills the single highest half-hour the
    # whole building sets in a month, and a north-west face peaking at 18:00
    # contributes whatever it happens to be doing at the building's hour, not
    # its own maximum. Summing per-face maxima across faces that peak at
    # different hours overstates the demand saving of every facade measure, and
    # the demand charge is the LARGER half of the saving on SC-9 -- 153k of a
    # 251k annual total on the worked case -- so the error was in the biggest
    # line. The roll-up below has always used this hour, and its comment has
    # always said "at the coincident hour rather than the sum of peaks"; the
    # faces simply had no way to honour it.
    per_hour = np.zeros((n_hour, 2))
    for f in range(floors):
        b = band_of_floor(f, floors, n_band)
        per_hour[:, 0] += sol[0]["q_total"][:, b]
        per_hour[:, 1] += sol[1]["q_total"][:, b]
    h_build = int(np.argmax(per_hour[:, 1]))

    out_floors: list[FloorLoad] = []
    for f in range(floors):
        b = band_of_floor(f, floors, n_band)
        hpk = int(band_peak_hour[b])

        faces: list[FaceLoad] = []
        for p in range(n_panel):
            if storey_face[p, b] <= 0.0:
                continue
            hf = int(face_peak_hour[p, b])
            faces.append(FaceLoad(
                azimuth=float(azimuth[p]),
                compass=compass(float(azimuth[p])),
                area_m2=float(storey_face[p, b]),
                # The contract types this as a single float, so it is reported
                # at the assembly's HIGH window-to-wall corner. That is not a
                # midpoint: the low corner is area_m2 * assembly.wwr[0] and the
                # assembly travels with the result, so both ends stay reachable.
                glazed_m2=float(storey_face[p, b] * assembly.wwr[1]),
                t_peak_c=float(surface[:, p, b].max()),
                peak_hour_edt=edt[hf],
                conduction_w=(float(sol[0]["q_cond"][hf, p, b]),
                              float(sol[1]["q_cond"][hf, p, b])),
                solar_gain_w=(float(sol[0]["q_sol"][hf, p, b]),
                              float(sol[1]["q_sol"][hf, p, b])),
                conduction_coincident_w=(float(sol[0]["q_cond"][h_build, p, b]),
                                         float(sol[1]["q_cond"][h_build, p, b])),
                solar_gain_coincident_w=(float(sol[0]["q_sol"][h_build, p, b]),
                                         float(sol[1]["q_sol"][h_build, p, b])),
                solar_gain_mean_w=(float(sol[0]["qsol_mean"][p, b]),
                                   float(sol[1]["qsol_mean"][p, b])),
                annual_kwh=(float(sol[0]["face_kwh"][p, b]),
                            float(sol[1]["face_kwh"][p, b])),
                cond_kwh=(float(sol[0]["face_cond_kwh"][p, b]),
                          float(sol[1]["face_cond_kwh"][p, b])),
                solar_kwh=(float(sol[0]["face_sol_kwh"][p, b]),
                           float(sol[1]["face_sol_kwh"][p, b])),
                cond_glazed_kwh=(float(sol[0]["face_cond_glazed_kwh"][p, b]),
                                 float(sol[1]["face_cond_glazed_kwh"][p, b])),
                dt_solar=float(dt_solar_p[p, b]),
                dt_trap=float(dt_trap_p[p, b]),
                dt_sky=float(dt_sky_p[p, b]),
                sun_hours_yr=float(sun_hours_p[p, b]),
                winter_sun_share=float(winter_share_p[p, b]),
            ))

        t_in = (float(sol[0]["t_indoor"][:, b].max()),
                float(sol[1]["t_indoor"][:, b].max()))
        peak_w = (float(sol[0]["q_total"][hpk, b]), float(sol[1]["q_total"][hpk, b]))
        ann = (float(sol[0]["floor_kwh"][b]), float(sol[1]["floor_kwh"][b]))

        hours_over = _exceedance_hours(sol, b, t_air_band, t_air_year)
        hours_per_k = _exceedance_slope(sol, b, t_air_band, t_air_year)
        den = float(sol[0]["den_mean"][b])
        k_per_w = (1.0 / den) if den > 0.0 else 0.0
        persons = _persons_on_floor(plate_m2, occupancy)
        env_m2 = float(storey_face[:, b].sum())

        out_floors.append(FloorLoad(
            floor=f + 1,
            band=b,
            z_lo=f * storey_h,
            z_hi=(f + 1) * storey_h,
            storeys_in_band=int(storeys_in_band[b]),
            faces=faces,
            envelope_m2=env_m2,
            peak_w=peak_w,
            peak_hour_edt=edt[hpk],
            annual_kwh=ann,
            t_surface_peak_c=float(t_surface_band_peak[b]),
            t_indoor_free_c=t_in,
            dt_solar=float(dt_solar_b[b]),
            dt_trap=float(dt_trap_b[b]),
            dt_sky=float(dt_sky_b[b]),
            dominant=_dominant(dt_solar_b[b], dt_trap_b[b], dt_sky_b[b], attributed),
            night_recovery=_night_recovery(float(svf_b[b])),
            hours_indoor_over_threshold=hours_over,
            person_hours=persons * hours_over,
            t_indoor_k_per_w=k_per_w,
            hours_over_per_kelvin=hours_per_k,
            severity=severity_of(t_in, hours_over, peak_w, plate_m2),
        ))

    # ---- building roll-up, at the coincident hour rather than the sum of peaks.
    # `per_hour` and `h_build` are computed above the floor loop now, so the
    # faces can report themselves at this hour too; see the note there.
    peak_kw = (per_hour[h_build, 0] / 1000.0, per_hour[h_build, 1] / 1000.0)
    annual_mwh = (sum(fl.annual_kwh[0] for fl in out_floors) / 1000.0,
                  sum(fl.annual_kwh[1] for fl in out_floors) / 1000.0)
    person_hours = sum(fl.person_hours for fl in out_floors)

    worst = max(out_floors,
                key=lambda fl: (fl.severity, fl.t_indoor_free_c[0], fl.peak_w[1]))

    notes.append(
        f"Floor plate {plate_m2:,.0f} m2 per storey, reconstructed from a "
        f"{perimeter:,.0f} m envelope perimeter at an assumed {PLAN_DEPTH_M:.0f} m "
        f"plan depth; storey height {storey_h:.2f} m from PLUTO's floor count.")
    if not attributed:
        notes.append(
            "No surface-term attribution supplied; dt_solar, dt_trap and dt_sky "
            "are zero and every floor reports 'ambient'.")

    return BuildingLoads(
        bin=bin, assembly=assembly, occupancy=occupancy, floors=out_floors,
        roof=None,
        peak_kw=(float(peak_kw[0]), float(peak_kw[1])),
        annual_mwh=(float(annual_mwh[0]), float(annual_mwh[1])),
        peak_hour_edt=edt[h_build],
        worst_floor=worst.floor,
        person_hours=float(person_hours),
        basis=_basis(assembly, occupancy, resolved=True, annual_basis=annual_basis,
                     exceedance=t_air_year is not None),
        notes=notes,
    )


# --------------------------------------------------------------- internals


def _solve_corner(
    c: _Corner,
    *,
    occupancy: Occupancy,
    storey_face: np.ndarray,
    surface: np.ndarray,
    irradiance: np.ndarray,
    t_air_band: np.ndarray,
    volume: float,
    plate_m2: float,
    dose_p: np.ndarray | None,
    summer_p: np.ndarray | None,
    summer_air: float | None,
    hour_span: float,
    share_i: int,
    lag_slots: int,
    mass: str,
) -> dict[str, np.ndarray]:
    """Every per-band quantity at one corner of the assumption table.

    The conduction term is ``U * A * (T_surface - T_indoor)`` with the *solved*
    surface temperature, not a sol-air equivalent — see the module docstring for
    why that distinction is the reason this module exists. Opaque and glazed
    fractions conduct separately, because a curtain wall's spandrel and its glass
    differ by a factor of three and averaging them would erase the difference the
    glazing measure is meant to exploit.
    """
    a_glazed = storey_face * c.wwr
    a_opaque = storey_face * (1.0 - c.wwr)
    ua_op = a_opaque * c.u_wall                              # (n_panel, n_band) W/K
    ua_gl = a_glazed * c.u_glass
    ua = ua_op + ua_gl

    # The opaque wall is driven by its decremented, lagged surface temperature;
    # the glazing by the raw one, because glass has no mass to damp anything. See
    # DECREMENT: this is the only dynamic term in an otherwise steady-state
    # balance, and it is here because without it a solid-masonry wall delivers its
    # own 51 degC afternoon peak straight to the room, which is not what masonry
    # does.
    t_op = _decremented(surface, c.decrement, lag_slots)

    # Ventilation: infiltration at the band's own air temperature -- the
    # vertically resolved profile, never the 2 m reading. rho and cp are
    # physics.py's, so this term and the convection term in the surface balance
    # rest on the same air properties.
    c_vent = physics.RHO_AIR * physics.CP_AIR * c.ach * volume / 3600.0   # W/K
    c_vent_free = physics.RHO_AIR * physics.CP_AIR * FREE_RUNNING_ACH * volume / 3600.0
    q_int = c.gain_w_m2 * plate_m2                                        # W

    t_set = occupancy.setpoint_c

    # Free-running indoor temperature: the steady-state balance with no
    # mechanical cooling, so with the windows open at FREE_RUNNING_ACH rather
    # than at the sealed building's infiltration rate. ESTIMATE - there is no
    # thermal capacity in this balance beyond the wall's own decrement factor, so
    # it will overstate how fast the inside follows the outside on the first hot
    # day after a cool spell, and it takes no account of the occupant closing the
    # windows against the afternoon and opening them at night. It is carried
    # because a resident's exposure is the point of the project and there is no
    # honest way to state that exposure without an indoor number.
    # Solved by the CIBSE admittance procedure rather than hour by hour: a daily
    # mean from the steady-state balance, plus a swing about it damped by the
    # room's own internal admittance. Solving each hour independently instead —
    # which is what a naive steady state does — gives the room no mass at all and
    # lets the afternoon solar gain land entirely in the air.
    q_sol_free = c.shgc * irradiance * a_glazed[None, :, :]
    y_int = ADMITTANCE.get(mass, ADMITTANCE["medium"]) * INTERNAL_SURFACE_RATIO * plate_m2

    ts_mean = surface.mean(axis=0)                       # (n_panel, n_band)
    tair_mean = t_air_band.mean(axis=0)                  # (n_band,)
    qsol_mean = q_sol_free.mean(axis=0)                  # (n_panel, n_band)

    # The daily mean. The decrement factor damps the fluctuation and leaves the
    # mean untouched, which is why a heavy building is not cooler on average —
    # only later, and flatter.
    den_mean = ua.sum(axis=0) + c_vent_free              # (n_band,)
    den_mean = np.where(den_mean > 0.0, den_mean, 1.0)
    t_in_mean = ((ua * ts_mean).sum(axis=0) + qsol_mean.sum(axis=0)
                 + c_vent_free * tair_mean + q_int) / den_mean

    # The swing about it, damped by everything the room can store heat in.
    dq = ((ua_op[None, :, :] * (t_op - ts_mean[None, :, :])).sum(axis=1)
          + (ua_gl[None, :, :] * (surface - ts_mean[None, :, :])).sum(axis=1)
          + (q_sol_free - qsol_mean[None, :, :]).sum(axis=1)
          + c_vent_free * (t_air_band - tair_mean[None, :]))
    t_indoor = t_in_mean[None, :] + dq / (den_mean + y_int)[None, :]

    # Cooling load: what a machine would have to remove to hold the setpoint in a
    # closed building, which is why this term uses the infiltration rate and the
    # free-running estimate above does not.
    q_cond = ua_op[None, :, :] * (t_op - t_set) + ua_gl[None, :, :] * (surface - t_set)
    q_sol = q_sol_free
    q_face = q_cond + q_sol
    q_vent = c_vent * (t_air_band - t_set)
    q_total = q_face.sum(axis=1) + q_vent + q_int

    # ---- cooling-season energy
    #
    # KEPT AS TWO TERMS, NOT ONE.
    #
    # `face_kwh` is what the schedule reports and it is the sum of these two,
    # but the two are what a measure acts on and they are not interchangeable.
    # A glazing swap moves `shgc` and `u_glass`; a louvre moves the transmitted
    # beam and nothing else; insulation moves `u_wall` alone. Reporting only the
    # sum forced `prescribe` to infer the split from the peak-hour ratio of
    # `solar_gain_w` to `conduction_w`, which weights a dose against
    # degree-hours and is not the same number — and before that, to skip the
    # split entirely and scale the whole load by an outdoor kelvin, which
    # credited a low-SHGC unit with 2.2% of its own effect. The split exists in
    # this expression already; it costs nothing to carry it out.
    #
    # `face_cond_glazed_kwh` is the glass's share of the conduction term, which
    # is the only part of it a glazing unit replaces. On an early curtain wall
    # that share is about 0.9 — 0.75 of the area at three to six W/m2K against
    # 0.25 of it at one to two — so treating the whole conduction term as
    # replaceable would overstate the measure, and treating none of it as
    # replaceable understates it by more.
    share = SUMMER_DOSE_SHARE[share_i]
    if dose_p is not None and summer_p is not None:
        # A seasonal mean carries no fluctuation, so the decrement factor does
        # not apply to it: the mean passes through a heavy wall undamped, and
        # that is exactly why mass moves the load in time without removing it.
        driving = np.maximum(0.0, summer_p - t_set) * COOLING_SEASON_HOURS
        face_cond_kwh = ua * driving / 1000.0
        face_cond_glazed_kwh = ua_gl * driving / 1000.0
        face_sol_kwh = c.shgc * a_glazed * dose_p * share
        face_kwh = face_cond_kwh + face_sol_kwh
        vent_kwh = 0.0
        if summer_air is not None:
            vent_kwh = c_vent * max(0.0, summer_air - t_set) * COOLING_SEASON_HOURS / 1000.0
        int_kwh = q_int * COOLING_SEASON_HOURS / 1000.0
        floor_kwh = face_kwh.sum(axis=0) + vent_kwh + int_kwh
    else:
        # The scaled-event-day fallback. Clipping at zero is NOT linear, so
        # max(0, q_cond) + max(0, q_sol) does not equal max(0, q_face) and
        # splitting the clipped total by the components' magnitude shares is the
        # only apportionment that preserves the sum. It matters because an hour
        # whose conduction runs backwards — a wall cooler than the room, giving
        # the room's heat away while the sun still pours through the glass — is
        # a real hour on an east elevation in the morning.
        days = EQUIVALENT_EVENT_DAYS[share_i]
        pos = np.maximum(0.0, q_face) * hour_span * days / 1000.0
        w_cond, w_sol = np.abs(q_cond), np.abs(q_sol)
        denom = np.maximum(1e-9, w_cond + w_sol)
        face_cond_kwh = (pos * w_cond / denom).sum(axis=0)
        face_sol_kwh = (pos * w_sol / denom).sum(axis=0)
        face_kwh = face_cond_kwh + face_sol_kwh
        gl_share = ua_gl / np.maximum(1e-9, ua)
        face_cond_glazed_kwh = face_cond_kwh * gl_share
        floor_kwh = np.maximum(0.0, q_total).sum(axis=0) * hour_span * days / 1000.0

    return {"q_cond": q_cond, "q_sol": q_sol, "q_face": q_face,
            "q_total": q_total, "t_indoor": t_indoor,
            "face_kwh": face_kwh, "floor_kwh": floor_kwh,
            "face_cond_kwh": face_cond_kwh, "face_sol_kwh": face_sol_kwh,
            "face_cond_glazed_kwh": face_cond_glazed_kwh,
            "ua_glazed_frac": ua_gl / np.maximum(1e-9, ua),
            # The two quantities an EXPOSURE delta needs, as against an energy
            # one. `qsol_mean` is the day-mean transmitted gain per panel, which
            # is what a solar-control measure reduces; `den_mean` is the
            # free-running balance's denominator, so a watt of gain removed is
            # `1 / den_mean` kelvin off the indoor mean. Together they turn a
            # shading fraction into a real indoor temperature change instead of
            # a load-fraction proxy.
            "qsol_mean": qsol_mean, "den_mean": den_mean,
            "c_vent": np.asarray(c_vent), "q_int": np.asarray(q_int)}


def solar_control_delta(
    face: FaceLoad,
    assembly: Assembly,
    *,
    shgc_new: float | None = None,
    u_glass_new: tuple[float, float] | None = None,
    solar_cut: float | None = None,
    cond_frac: float = 0.0,
    winter_scale: float = 1.0,
) -> dict[str, tuple[float, float]]:
    """What a solar-control measure does, from the terms the solve already reported.

    WHY THIS IS HERE AND NOT IN ``prescribe.py``
    --------------------------------------------

    This is the analytic derivative of ``_solve_corner``'s own cooling-season
    expression with respect to ``shgc`` and ``u_glass``, and it is fifteen lines
    below that expression so the two cannot drift. The alternative was to re-run
    the solve with an overridden assembly, which is the arrangement this module
    would prefer — one expression, evaluated twice — and it is not available:
    ``BuildingLoads`` carries the solve's *outputs*, not the surface,
    irradiance, dose and summer-mean planes it needs as inputs, so nothing
    downstream of ``building_floors`` can re-enter it. Threading those arrays
    through the decision layer to make a re-solve possible would put four
    hundred megabytes of plane into a prescription's argument list.

    So: the derivative, next to the function it differentiates, with the terms
    it needs carried on ``FaceLoad`` rather than inferred. The thing this
    replaces inferred them from an OUTDOOR surface temperature delta, which is
    the wrong quantity — a low-SHGC unit rejects the beam at the glass line, so
    it barely moves the outdoor surface at all, and scaling by that delta
    credited a full curtain-wall replacement with about 2% of its own effect.

    TWO LEVERS, AND A MEASURE MAY PULL EITHER OR BOTH
    ------------------------------------------------

    ``shgc_new`` — a new unit's solar heat gain coefficient. Capped at the
    assembly's existing value, because a retrofit that would RAISE the SHGC is
    not this measure and must not be reported as a saving.

    ``solar_cut`` — the fraction of transmitted solar removed, for a measure
    specified that way rather than by a target coefficient. A film is 0.35 of
    what is already there; a target of 0.25 on glass already at 0.50 is 0.50 of
    it. Give one or the other, never both.

    ``u_glass_new`` — the new unit's U-value, as a (lo, hi) band. Applies to
    ``cond_glazed_kwh`` only, which is the glass's share of the conduction term:
    a new window does nothing for the spandrel beside it. A film leaves this
    ``None``, because a film changes no U-value — that is exactly why it is the
    cheap measure and exactly why it is the weaker one.

    ``cond_frac`` — the fraction of the WHOLE conduction term removed by the
    wall running cooler, for a device fitted OUTSIDE the glass. This is the one
    place the canyon engine's outdoor delta belongs: a louvre intercepts the
    beam before it reaches the wall, so the wall genuinely runs cooler and
    ``U*A*(T_surface - T_indoor)`` genuinely falls, which is what
    ``facade_surface_dT`` of -18 to -6 K is measuring. The caller computes the
    fraction from that delta over the driving temperature difference — exactly
    the arithmetic that was wrong when applied to the SOLAR term and is right
    here. An internal device (a film, a blind) leaves this at zero: it sits
    behind the glass and the wall outside it does not know it is there.

    Giving a measure BOTH a solar cut and a ``cond_frac`` is not
    double-counting. They are different terms of the same sum — the transmitted
    beam and the conducted skin load — and ``FaceLoad`` reports them separately
    for this reason. Giving one measure ``u_glass_new`` and ``cond_frac``
    together WOULD double-count, and no caller in this project does; a device is
    either replacing the glass or standing outside it.

    ``winter_scale`` — how much of the summer solar cut also applies in the
    heating season, 0 to 1. Not a fudge: it is the seasonal selectivity of the
    device, and the catalogue states it per measure. An operable device retracts,
    so it is 0. A film cannot, so it is 1. A horizontal overhang sized on the
    summer profile angle passes most of the low winter beam underneath itself,
    so it is small but not nothing. Vertical fins intercept the low, near-normal
    beam, which is precisely the winter one, so they are 1.

    THE WINTER SIDE IS RETURNED, NOT INFERRED
    -----------------------------------------

    ``winter_kwh`` is the heat this measure stops letting in during the heating
    season: the same solar term, taken over the winter share of the annual dose
    instead of the summer share. It is a HEAT quantity and a COST, and it is
    returned positive. What it replaces was ``|winter_facade_delta| /
    |summer_facade_delta| * 0.5`` applied to the cooling figure, which
    ``prescribe`` itself labelled the least certain number on the prescription.
    This is not certain either — the dose split is a plane, not a measurement —
    but it is the right quantity computed the right way round.

    Signs: ``kwh`` and ``peak_w`` are SAVINGS and come back positive;
    ``winter_kwh`` is a PENALTY and also comes back positive. The caller applies
    the conventions its own contract states.
    """
    u_gl = assembly.u_glass
    out_kwh = [0.0, 0.0]
    out_w = [0.0, 0.0]
    out_winter = [0.0, 0.0]

    for i in (0, 1):
        f_sol = _solar_fraction_at(assembly, i, shgc_new, solar_cut)

        # The conduction half, glass only. The pessimistic end of the saving
        # pairs the assembly's OWN low U with the new unit's HIGH one, so the
        # band cannot be narrowed by picking favourable corners at both ends.
        f_con = 0.0
        if u_glass_new is not None and float(u_gl[i]) > 0.0:
            u_new = float(u_glass_new[1 - i])
            f_con = max(0.0, 1.0 - u_new / float(u_gl[i]))

        cf = max(0.0, min(1.0, float(cond_frac)))
        gl_share = (face.cond_glazed_kwh[i] / face.cond_kwh[i]
                    if face.cond_kwh[i] > 0.0 else 0.0)
        out_kwh[i] = (face.solar_kwh[i] * f_sol
                      + face.cond_glazed_kwh[i] * f_con
                      + face.cond_kwh[i] * cf)
        # PEAK, AT THE HOUR THE METER READS.
        #
        # `solar_gain_w` and `conduction_w` are this face's own worst hour, which
        # is what sizing a louvre needs and is the wrong hour to price a demand
        # charge at: the bill is the single highest demand the WHOLE BUILDING
        # sets, and a west elevation's 18:00 maximum is not when a building whose
        # load peaks at 15:00 gets metered. Summing per-face maxima across faces
        # with different peak hours produced a demand saving no meter would ever
        # have recorded. So the coincident pair is used here, and the face's own
        # pair stays on the record for the sizing question.
        cond_w = max(0.0, face.conduction_coincident_w[i])
        out_w[i] = (face.solar_gain_coincident_w[i] * f_sol
                    + cond_w * f_con * gl_share
                    + cond_w * cf)
        # The heating-season side of the solar term. `winter_sun_share` is the
        # fraction of the face's ANNUAL sun that arrives in the heating season,
        # and `solar_kwh` is the cooling-season share of the same dose, so the
        # winter quantity is the cooling one rescaled between the two shares.
        summer_share = SUMMER_DOSE_SHARE[i]
        ws = max(0.0, min(1.0, float(winter_scale)))
        if summer_share > 0.0 and ws > 0.0:
            annual_sol = face.solar_kwh[i] / summer_share
            out_winter[i] = annual_sol * float(face.winter_sun_share) * f_sol * ws

    return {
        "kwh": (out_kwh[0], out_kwh[1]),
        "peak_w": (out_w[0], out_w[1]),
        "winter_kwh": (out_winter[0], out_winter[1]),
        # The fraction of transmitted solar this measure actually removes, at the
        # low corner. Reported so `exposure_delta` need not re-derive it from the
        # assembly and risk deriving it differently.
        "solar_fraction": _solar_fraction_at(assembly, 0, shgc_new, solar_cut),
    }


def _solar_fraction_at(assembly: Assembly, i: int,
                       shgc_new: float | None, solar_cut: float | None) -> float:
    """The share of transmitted solar removed, at one corner of the assembly."""
    if solar_cut is not None:
        return max(0.0, min(1.0, float(solar_cut)))
    shgc_old = float(assembly.shgc[i])
    if shgc_new is not None and shgc_old > 0.0:
        return max(0.0, 1.0 - min(float(shgc_new), shgc_old) / shgc_old)
    return 0.0


def exposure_delta(
    floor: FloorLoad,
    treated: Sequence[FaceLoad],
    *,
    solar_fraction: float,
) -> dict[str, float]:
    """How many person-hours of indoor heat a solar-control measure removes.

    THE COMPANION TO ``solar_control_delta``, AND THE REASON IT IS SEPARATE

    Energy is a per-face quantity and exposure is not. A person sits in a room,
    and the room's temperature is solved per FLOOR from the sum of what every
    face admits — so removing gain from one elevation moves the whole floor a
    little, and doing the arithmetic per face and adding would count the same
    room several times.

    THE CHAIN, EACH LINK MEASURED RATHER THAN ASSUMED

    A shading fraction removes ``solar_fraction`` of the treated faces' DAY-MEAN
    transmitted gain. ``t_indoor_k_per_w`` turns those watts into kelvin off the
    free-running indoor mean — it is ``1 / den_mean`` from the same balance that
    produced ``t_indoor_free_c``, not a rule of thumb. ``hours_over_per_kelvin``
    turns kelvin into hours using the density of the REAL annual air series at
    the threshold. Person-hours is then hours times the people on the plate,
    which is what ``person_hours`` already is.

    WHAT THIS REPLACES

    ``prescribe._derive_energy`` scaled a floor's person-hours by
    ``|facade_dT| / (T_surface - setpoint)`` — the outdoor surface delta again,
    the same ratio that was wrong for solar energy and is wrong here for the
    same reason. It also made exposure proportional to a quantity a low-SHGC
    unit barely moves. This is the indoor temperature, which is what exposure
    actually is: the module's own docstring calls it "the quantity a resident
    experiences and the only one on this schedule that is about a person rather
    than about a building".

    WHAT IT IS NOT

    A local linearisation. It is honest for the fraction of a kelvin a facade
    measure moves and it would not be for a whole-building retrofit, so the
    result is clamped at the floor's own exceedance — a measure cannot remove
    more hours than there are. It is also silent on the swing: the admittance
    procedure damps the fluctuation about the mean, and only the mean is
    differentiated here, so a measure that flattens a peak without moving a mean
    gets no credit. Both limits are stated on the prescription.
    """
    k_per_w = float(getattr(floor, "t_indoor_k_per_w", 0.0) or 0.0)
    h_per_k = float(getattr(floor, "hours_over_per_kelvin", 0.0) or 0.0)
    hours_now = float(getattr(floor, "hours_indoor_over_threshold", 0.0) or 0.0)
    ph_now = float(getattr(floor, "person_hours", 0.0) or 0.0)
    f = max(0.0, min(1.0, float(solar_fraction)))
    if k_per_w <= 0.0 or h_per_k <= 0.0 or f <= 0.0 or hours_now <= 0.0:
        return {"d_t_indoor_k": 0.0, "d_hours": 0.0, "d_person_hours": 0.0}

    # The LOW corner of the gain, matching `_exceedance_hours` and `severity_of`,
    # which both score against the reading the assumption table supports even at
    # its most favourable. Using the high corner here would make every measure's
    # exposure benefit the most flattering number available.
    watts = sum(max(0.0, fa.solar_gain_mean_w[0]) for fa in treated)
    d_t = watts * f * k_per_w
    d_hours = min(hours_now, d_t * h_per_k)
    per_person = (ph_now / hours_now) if hours_now > 0.0 else 0.0
    return {"d_t_indoor_k": d_t, "d_hours": d_hours,
            "d_person_hours": d_hours * per_person}


def _decremented(surface: np.ndarray, f: float, lag_slots: int) -> np.ndarray:
    """The temperature the *inside* face of the opaque wall is driven by.

        T_op(t) = T_mean + f * (T_surface(t - lag) - T_mean)

    The daily mean passes through undamped and the fluctuation about it is
    damped by the decrement factor and delayed by the time lag — the CIBSE
    admittance procedure's two dynamic properties, and the minimum a
    steady-state balance has to borrow from a dynamic one to stop being wrong by
    ten kelvin on a masonry building. The roll is circular because the solved day
    is a representative day treated as periodic, which is the same assumption the
    annual accumulation already makes.
    """
    t_mean = surface.mean(axis=0)[None, :, :]
    lagged = np.roll(surface, lag_slots, axis=0) if lag_slots else surface
    return t_mean + f * (lagged - t_mean)


def _terms_arrays(terms, n_panel, n_band):
    """The attribution as three arrays, zeros when nothing was attributed.

    Zeros rather than a guess: ``dominant`` then reports "ambient", which says
    "not attributed" rather than naming a driver the solve never separated.
    """
    if terms is None:
        z = np.zeros((n_panel, n_band))
        return z, z.copy(), z.copy()
    def g(k):
        v = terms.get(k)
        if v is None:
            return np.zeros((n_panel, n_band))
        return np.asarray(v, dtype=np.float64).reshape(n_panel, n_band)
    return g("dt_solar"), g("dt_trap"), g("dt_sky")


def _plane(annual, key, n_panel, n_band, default):
    if annual is None or annual.get(key) is None:
        if default is None:
            return None
        return np.full((n_panel, n_band), float(default))
    return np.asarray(annual[key], dtype=np.float64).reshape(n_panel, n_band)


def _area_mean(arr: np.ndarray, weights: np.ndarray) -> np.ndarray:
    w = weights.sum(axis=0)
    out = (arr * weights).sum(axis=0) / np.where(w > 0.0, w, 1.0)
    return np.where(w > 0.0, out, arr.mean(axis=0))


def _dominant(dt_solar: float, dt_trap: float, dt_sky: float, attributed: bool) -> str:
    """Which driver made this band hot. Thresholds from ``SurfaceTerms``."""
    if not attributed:
        return "ambient"
    total = float(dt_solar) + float(dt_trap) + float(dt_sky)
    if total < AMBIENT_K:
        return "ambient"
    return "solar" if dt_solar >= dt_trap else "trap"


def _night_recovery(svf: float) -> str:
    if svf >= RECOVERY_GOOD:
        return "good"
    if svf >= RECOVERY_LIMITED:
        return "limited"
    return "none"


def _persons_on_floor(plate_m2: float, occupancy: Occupancy) -> float:
    """How many people are on one storey. Zero for every non-residential use.

    An office tower's peak load coincides with its occupied hours but nobody
    sleeps through the night in it, and overnight exposure without relief is the
    mechanism that kills — the same reasoning ``exposure.vulnerability()``
    applies to the residents term. Unit counts are not in this function's
    signature, so the count comes from the floor plate at ``M2_PER_DWELLING``
    gross per dwelling.
    """
    if occupancy.persons_per_unit <= 0.0:
        return 0.0
    return plate_m2 / M2_PER_DWELLING * occupancy.persons_per_unit


def _exceedance_hours(sol, band: int, t_air_band: np.ndarray,
                      t_air_year: np.ndarray | None) -> float:
    """Hours a year the free-running indoor estimate exceeds 28 degC. ESTIMATE.

    The solved day is one day. To reach a year, the day's mean indoor-to-air
    offset is taken as a constant and the year's hourly air series is shifted by
    it. That is a strong assumption and it biases *high*: the offset is measured
    on a heat-wave day with strong sun and a hot facade, and a mild June day
    would produce a smaller one. It is reported as an estimate everywhere.

    With no annual air series supplied the answer is 0.0 and ``basis`` says the
    exceedance was not estimated. An invented count would read as safety, and
    that is the one failure mode this project's labelling exists to prevent.
    """
    if t_air_year is None or t_air_year.size == 0:
        return 0.0
    # The optimistic corner: the count the evidence supports even at the low end
    # of the assumption table.
    offset = float((sol[0]["t_indoor"][:, band] - t_air_band[:, band]).mean())
    return float(np.count_nonzero(t_air_year + offset > INDOOR_THRESHOLD_C))


def _exceedance_slope(sol, band: int, t_air_band: np.ndarray,
                      t_air_year: np.ndarray | None) -> float:
    """How many exceedance hours a kelvin of indoor relief actually buys.

    ``d(hours) / d(offset)`` for the count above, evaluated as a central
    difference over one kelvin on the real annual air series. It is the density
    of that series at the threshold, and the shape of that density is the whole
    reason this is measured rather than assumed: a floor whose indoor estimate
    sits at 28.2 degC has hundreds of hours within a kelvin of the threshold and
    a fraction of a kelvin of shading moves a great many of them, while a floor
    at 34 degC has almost none within a kelvin and the same shading moves almost
    nothing there. A constant coefficient would get both cases wrong in opposite
    directions, and it is the second case — the worst floors, where a measure
    looks most attractive — that it would flatter.

    Same corner as ``_exceedance_hours``: the low one, so a measure's exposure
    benefit is the one the assumption table supports even at its most favourable
    reading of the envelope.
    """
    if t_air_year is None or t_air_year.size == 0:
        return 0.0
    offset = float((sol[0]["t_indoor"][:, band] - t_air_band[:, band]).mean())
    hi = np.count_nonzero(t_air_year + offset + 0.5 > INDOOR_THRESHOLD_C)
    lo = np.count_nonzero(t_air_year + offset - 0.5 > INDOOR_THRESHOLD_C)
    return float(max(0, hi - lo))


def severity_of(t_indoor: tuple[float, float], hours_over: float,
                peak_w: tuple[float, float], plate_m2: float) -> int:
    """The 0-4 stripe the interface reads before any number does.

    Every test is scored against the **low** corner of the range, so the stripe
    shows the severity the assumption table supports even at its most favourable
    reading. Using the high corner would put most of the pre-war stock at 4 and
    the stripe would stop discriminating; using a midpoint would be the collapse
    this layer forbids.

    The ladder is the free-running indoor temperature, because that is the
    quantity a resident experiences and the only one on this schedule that is
    about a person rather than about a building:

    ====  ==========================================================
    0     below 28 degC — under the threshold public-health guidance
          uses for indoor heat in a residential setting
    1     28-32 — above that threshold; sleep is measurably disrupted
    2     32-36 — sustained heat strain for a sedentary adult
    3     36-40 — at skin temperature, so the body has lost its dry
          path and can shed heat only by evaporating
    4     40 and above — at or past core body temperature, where even
          evaporation fails as soon as the air is humid
    ====  ==========================================================

    The steps are wider than a comfort scale's because the schedule is scored on
    a heat-wave day in a study area chosen for being hot. A ladder anchored at
    28-31-34-37 was tried first and put ninety-six per cent of the floors in the
    AOI at 4, which is arguably true on a 39 degC day and is useless as a stripe.
    These four are the physiological transitions rather than comfort bands, and
    they leave the pattern legible.

    A floor is lifted one step, never past 4, when it is **both** hot for a long
    time (more than 400 hours a year above the indoor threshold, which is more
    than sixteen full days of it) **and** expensive to hold at setpoint (more
    than 40 W per m2 of floor plate at peak, against the 30-50 W/m2 a NYC
    apartment's design cooling load usually runs). Both, not either: a floor that
    is briefly hot and a floor that is cheaply cooled are different problems from
    a floor that is neither, and requiring both keeps the lift from firing on
    every floor of every building in a study area chosen for being hot.

    Where no annual air series was supplied ``hours_over`` is zero and the lift
    simply never fires, which is the right behaviour for a missing input: it
    cannot make a floor look worse than the evidence supports.
    """
    t = t_indoor[0]
    if t >= 40.0:
        s = 4
    elif t >= 36.0:
        s = 3
    elif t >= 32.0:
        s = 2
    elif t >= 28.0:
        s = 1
    else:
        s = 0
    load_w_m2 = (peak_w[0] / plate_m2) if plate_m2 > 0.0 else 0.0
    if s < 4 and hours_over > 400.0 and load_w_m2 > 40.0:
        s += 1
    return s


def _basis(assembly: Assembly, occupancy: Occupancy, *, resolved: bool,
           annual_basis: str, exceedance: bool) -> str:
    """The provenance sentence. Always contains the word "assumed"."""
    head = (
        "Conduction from the SOLVED facade surface temperature, not sol-air; "
        "solar gain from the solved per-band irradiance; ventilation against the "
        "vertically resolved air profile. "
    ) if resolved else "Not resolved: no facade panels. "
    return (
        head +
        f"Envelope and occupancy are ASSUMED from the {assembly.label} assembly "
        f"({assembly.era}) and {occupancy.label} occupancy; every range is the "
        f"spread between the low and high corners of that assumed table, not a "
        f"confidence interval. Indoor temperature is a steady-state ESTIMATE "
        f"with no mechanical cooling, open windows at {FREE_RUNNING_ACH:.0f} ACH, "
        f"and only the wall's decrement factor and the room's admittance "
        f"standing in for thermal capacity; it biases high. Cooling-season "
        f"energy covers {COOLING_SEASON_LABEL} ({annual_basis}). "
        + ("Indoor exceedance hours estimated by shifting the year's air series "
           "by the solved day's mean indoor-to-air offset."
           if exceedance else
           "Indoor exceedance hours NOT estimated: no annual air series supplied.")
    )

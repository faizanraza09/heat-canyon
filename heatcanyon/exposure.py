"""Floor-level heat exposure scoring and vulnerability-weighted prioritisation.

The point of this module is to turn a temperature field into a decision. A map
that shows the city is orange is not actionable; a ranked list that says *these
buildings, these floors, these faces, and here is why* is.

Design principle: every score is a transparent weighted sum of named,
inspectable components, each normalised to 0-1 against the study area. No
learned weights, no black box — a planner has to be able to argue with the
number, which means being able to see it decomposed. The interface exposes the
full decomposition for every ranked building.

Exposure and vulnerability are kept strictly separate and multiplied only at the
end. Exposure is physics; vulnerability is people. Conflating them hides which
half is driving a ranking, and they call for different interventions: high
exposure with low vulnerability is a design problem, high vulnerability with
moderate exposure is an outreach problem.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import nyc


# ------------------------------------------------------------ normalisation


def _norm(value: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 0.0
    return min(1.0, max(0.0, (value - lo) / (hi - lo)))


def percentile_bounds(values: list[float], lo_pct: float = 5.0, hi_pct: float = 95.0):
    """Robust normalisation bounds. Percentiles, not min/max, so one bad
    footprint cannot compress the entire scale."""
    if not values:
        return (0.0, 1.0)
    v = sorted(values)
    n = len(v)
    return (v[int(lo_pct / 100.0 * (n - 1))], v[int(hi_pct / 100.0 * (n - 1))])


# ------------------------------------------------------------------ exposure


#: Weights for the exposure index. Chosen deliberately, and stated:
#:
#: * ``dose`` dominates because duration of exposure, not peak temperature, is
#:   what the epidemiology links to mortality. This is also the FortyGuard
#:   layer that discriminates most strongly across Midtown (a 19-hour spread
#:   against a 2.6 K spread in the snapshot).
#: * ``persistence`` is separate from dose because a continuous run without
#:   overnight relief is more dangerous than the same hours split up.
#: * ``facade_solar`` and ``mrt`` carry the geometry — they are what makes one
#:   face of a building different from another, and they are modelled, not
#:   measured, which is why together they weigh less than the measured terms.
EXPOSURE_WEIGHTS = {
    "dose": 0.32,           # hours above threshold, measured (FortyGuard)
    "persistence": 0.20,    # longest unbroken run, measured (FortyGuard)
    "peak_air": 0.10,       # peak 2 m air temperature, measured (FortyGuard)
    "facade_solar": 0.22,   # daily absorbed shortwave on the facade, modelled
    "mrt": 0.10,            # pedestrian mean radiant temperature, modelled
    "enclosure": 0.06,      # 1 - SVF: how trapped the canyon is, measured geometry
}


@dataclass
class FloorExposure:
    """Exposure at one floor band of one building."""

    floor: int
    z_mid: float                 # metres above ground
    t_air: float                 # deg C, modelled
    t_air_sigma: float           # K, uncertainty — grows with height
    t_facade_peak: float         # deg C, peak facade surface temp that day
    solar_dose_kwh: float        # kWh/m^2 absorbed on the facade over the day
    hours_sunlit: float
    svf: float
    hottest_face: str            # compass name of the worst-exposed facade
    hottest_face_temp: float


@dataclass
class BuildingExposure:
    """A building resolved into an exposure profile and a priority score."""

    bin: str | None
    bbl: str | None
    address: str | None
    lon: float
    lat: float
    height_m: float
    floors: int
    year_built: int | None
    land_use: int | None
    units_res: int
    zipcode: str | None
    material: str

    # measured inputs
    exceedance_hours: float
    persistence_hours: float
    peak_air_c: float
    svf_mean: float

    # modelled inputs
    facade_solar_kwh: float
    mrt_peak: float
    wbgt_peak: float
    facade_peak_c: float
    facade_spread_k: float

    # people
    hvi: int | None

    floors_detail: list[FloorExposure] = field(default_factory=list)
    components: dict[str, float] = field(default_factory=dict)
    exposure_score: float = 0.0
    vulnerability_score: float = 0.0
    priority_score: float = 0.0
    reasons: list[str] = field(default_factory=list)

    # ---- the year, filled by `attach_annual` and scored by `score_annual`
    #
    # Kept separate from the fields above rather than folded into them, because
    # they answer a different question and rest on a different source. Everything
    # above is one day: the day FortyGuard was billed for, the day the validation
    # applies to. Everything here is the whole year, anchored on bias-corrected
    # reanalysis. Merging the two would produce a single number nobody could say
    # the provenance of.
    annual_facade_kh35: float = 0.0     # K.h of facade surface above 35 degC, per year
    annual_facade_kh40: float = 0.0
    annual_sun_hours: float = 0.0       # mean hours of direct beam per facade band
    annual_dose_kwh: float = 0.0        # incident shortwave on the facade, kWh/m2/yr
    annual_absorbed_kwh: float = 0.0
    annual_facade_max_c: float = 0.0
    annual_summer_mean_c: float = 0.0
    annual_winter_mean_c: float = 0.0
    annual_swing_k: float = 0.0
    annual_month_of_peak: int = 0
    annual_monthly_mean_c: list[float] = field(default_factory=list)
    annual_hours_above_35: float = 0.0  # facade-hours above 35 degC per band, per year
    annual_components: dict[str, float] = field(default_factory=dict)
    annual_exposure_score: float = 0.0
    annual_priority_score: float = 0.0
    annual_reasons: list[str] = field(default_factory=list)

    @property
    def residential(self) -> bool:
        return (self.land_use in nyc.RESIDENTIAL_USES) or self.units_res > 0


# -------------------------------------------------------------- vulnerability


#: Vulnerability weights. All four are proxies for the same thing — the ability
#: to avoid or survive indoor heat — and all four come from free public data.
VULNERABILITY_WEIGHTS = {
    "hvi": 0.40,            # DOHMH Heat Vulnerability Index, quintile 1-5
    "residents": 0.28,      # residential units: people who sleep in the exposure
    "age": 0.20,            # pre-war stock: no central air, poor envelope
    "affordability": 0.12,  # low assessed value per unit: less likely to run AC
}


def vulnerability(
    b: BuildingExposure,
    assessed_per_unit: float | None,
    bounds: dict[str, tuple[float, float]],
) -> tuple[float, dict[str, float]]:
    """Score how badly this building's occupants can cope, 0-1.

    A non-residential building scores zero on the residents term by
    construction: an office tower's peak exposure coincides with the hours it is
    occupied, but nobody sleeps through the night in it, and overnight exposure
    without relief is the mechanism that kills. This is why the ranking does not
    simply surface the tallest, shiniest towers.
    """
    comp: dict[str, float] = {}

    # HVI is a quintile; map 1-5 onto 0-1. Unknown ZIPs get the study-area
    # median rather than zero, so a missing join cannot look like safety.
    hvi = b.hvi if b.hvi is not None else 2
    comp["hvi"] = _norm(float(hvi), 1.0, 5.0)

    if b.residential:
        lo, hi = bounds.get("units", (0.0, 200.0))
        comp["residents"] = _norm(float(b.units_res), lo, hi)
    else:
        comp["residents"] = 0.0

    # Pre-1960 construction is the practical dividing line for central air and
    # envelope performance in New York's stock.
    y = b.year_built or 1920
    comp["age"] = 1.0 if y < 1945 else (0.6 if y < 1960 else (0.3 if y < 1980 else 0.0))

    if assessed_per_unit and b.residential:
        lo, hi = bounds.get("assessed", (50_000.0, 900_000.0))
        # Inverted: cheaper per unit implies less capacity to cool.
        comp["affordability"] = 1.0 - _norm(assessed_per_unit, lo, hi)
    else:
        comp["affordability"] = 0.0

    score = sum(VULNERABILITY_WEIGHTS[k] * comp[k] for k in VULNERABILITY_WEIGHTS)
    return (score, comp)


# ----------------------------------------------------------------- scoring


def score_all(
    buildings: list[BuildingExposure],
    assessed_per_unit: dict[str, float] | None = None,
) -> list[BuildingExposure]:
    """Normalise every component across the study area and compute final scores.

    Normalisation is relative to *this* study area, which is the honest framing:
    the output is a within-AOI priority ordering, not an absolute claim that
    these are the hottest buildings in New York. Comparing across AOIs would
    need a citywide run.
    """
    assessed_per_unit = assessed_per_unit or {}

    bounds = {
        "dose": percentile_bounds([b.exceedance_hours for b in buildings]),
        "persistence": percentile_bounds([b.persistence_hours for b in buildings]),
        "peak_air": percentile_bounds([b.peak_air_c for b in buildings]),
        "facade_solar": percentile_bounds([b.facade_solar_kwh for b in buildings]),
        "mrt": percentile_bounds([b.mrt_peak for b in buildings]),
        "units": percentile_bounds([float(b.units_res) for b in buildings if b.units_res > 0] or [0.0, 1.0]),
        "assessed": percentile_bounds(list(assessed_per_unit.values()) or [0.0, 1.0]),
    }

    for b in buildings:
        c: dict[str, float] = {}
        c["dose"] = _norm(b.exceedance_hours, *bounds["dose"])
        c["persistence"] = _norm(b.persistence_hours, *bounds["persistence"])
        c["peak_air"] = _norm(b.peak_air_c, *bounds["peak_air"])
        c["facade_solar"] = _norm(b.facade_solar_kwh, *bounds["facade_solar"])
        c["mrt"] = _norm(b.mrt_peak, *bounds["mrt"])
        c["enclosure"] = 1.0 - min(1.0, max(0.0, b.svf_mean))

        b.components = c
        b.exposure_score = 100.0 * sum(EXPOSURE_WEIGHTS[k] * c[k] for k in EXPOSURE_WEIGHTS)

        apu = assessed_per_unit.get(b.bbl or "")
        vscore, vcomp = vulnerability(b, apu, bounds)
        b.vulnerability_score = 100.0 * vscore
        b.components.update({f"vuln_{k}": v for k, v in vcomp.items()})

        # Geometric mean of exposure and vulnerability. Chosen over a sum so
        # that a building must score on *both* to rank highly — a hot but
        # unoccupied warehouse and a vulnerable but shaded walk-up are both
        # correctly pushed down, which a sum would not do.
        b.priority_score = math.sqrt(max(b.exposure_score, 0.0) * max(b.vulnerability_score, 0.0))
        b.reasons = explain(b)

    buildings.sort(key=lambda x: -x.priority_score)
    return buildings


#: Annual exposure weights. Deliberately a DIFFERENT shape from the event-day
#: weights above, because a year asks a different question of the same building.
#:
#: The event-day score is dominated by duration within one heat wave, which is
#: what the epidemiology of an acute event turns on. Over a year the thing that
#: matters is accumulated load and how relentless it is: a facade that spends
#: 900 K.h above 35 degC across four months is a different problem from one that
#: spends the same total in nine days, and the annual score is the one that can
#: tell them apart. Sunlit hours carry real weight here because over a year they
#: are the lever an intervention actually pulls.
ANNUAL_EXPOSURE_WEIGHTS = {
    "facade_dose": 0.30,     # K.h above 35 degC on the facade, modelled, per year
    "sun_hours": 0.22,       # hours of direct beam per facade band, per year
    "solar_dose": 0.18,      # incident shortwave, kWh/m2/yr, modelled
    "peak": 0.14,            # annual maximum facade surface temperature, modelled
    "relentlessness": 0.10,  # months in which the facade mean exceeds 30 degC
    "enclosure": 0.06,       # 1 - SVF, measured geometry
}


def attach_annual(b: BuildingExposure, rec: dict) -> None:
    """Copy one building's annual roll-up onto it. Pure plumbing, no scoring."""
    b.annual_facade_kh35 = float(rec.get("kh35", 0.0))
    b.annual_facade_kh40 = float(rec.get("kh40", 0.0))
    b.annual_sun_hours = float(rec.get("sun_hours", 0.0))
    b.annual_dose_kwh = float(rec.get("dose_kwh", 0.0))
    b.annual_absorbed_kwh = float(rec.get("absorbed_kwh", 0.0))
    b.annual_facade_max_c = float(rec.get("t_max", 0.0))
    b.annual_summer_mean_c = float(rec.get("summer_mean", 0.0))
    b.annual_winter_mean_c = float(rec.get("winter_mean", 0.0))
    b.annual_swing_k = float(rec.get("swing", 0.0))
    b.annual_month_of_peak = int(rec.get("month_of_peak", 0))
    b.annual_monthly_mean_c = [float(v) for v in rec.get("monthly_mean_c", [])]
    b.annual_hours_above_35 = float(rec.get("hours_above_35", 0.0))


def score_annual(buildings: list[BuildingExposure]) -> list[BuildingExposure]:
    """Score the year, alongside — never instead of — the event-day score.

    Two orderings are published and they disagree, which is the point. The
    event-day ranking answers "who is in trouble during a heat wave". The annual
    ranking answers "whose fabric is loaded all year", and it promotes buildings
    whose exposure is chronic rather than acute — a west-facing pre-war walk-up on
    a wide, open street ranks higher here than in the wave ordering, because its
    problem is 1,600 hours of afternoon sun rather than four days of trapped air.
    Where the two orderings agree, the case is strong on both grounds and the
    interface says so.
    """
    if not buildings:
        return buildings

    bounds = {
        "facade_dose": percentile_bounds([b.annual_facade_kh35 for b in buildings]),
        "sun_hours": percentile_bounds([b.annual_sun_hours for b in buildings]),
        "solar_dose": percentile_bounds([b.annual_dose_kwh for b in buildings]),
        "peak": percentile_bounds([b.annual_facade_max_c for b in buildings]),
    }

    for b in buildings:
        c: dict[str, float] = {
            "facade_dose": _norm(b.annual_facade_kh35, *bounds["facade_dose"]),
            "sun_hours": _norm(b.annual_sun_hours, *bounds["sun_hours"]),
            "solar_dose": _norm(b.annual_dose_kwh, *bounds["solar_dose"]),
            "peak": _norm(b.annual_facade_max_c, *bounds["peak"]),
            "relentlessness": min(1.0, sum(
                1 for v in b.annual_monthly_mean_c if v > 30.0) / 6.0),
            "enclosure": 1.0 - min(1.0, max(0.0, b.svf_mean)),
        }
        b.annual_components = c
        b.annual_exposure_score = 100.0 * sum(
            ANNUAL_EXPOSURE_WEIGHTS[k] * c[k] for k in ANNUAL_EXPOSURE_WEIGHTS)
        # Same geometric mean against the same vulnerability score: the people in
        # a building do not change because the time window did.
        b.annual_priority_score = math.sqrt(
            max(b.annual_exposure_score, 0.0) * max(b.vulnerability_score, 0.0))
        b.annual_reasons = explain_annual(b)
    return buildings


def explain_annual(b: BuildingExposure) -> list[str]:
    """Plain-language reasons the year ranks this building where it does."""
    out: list[str] = []
    if b.annual_facade_kh35 > 0:
        out.append(
            f"Its facades accumulate {b.annual_facade_kh35:,.0f} kelvin-hours above "
            f"35 °C over the year — modelled surface temperature, not air.")
    if b.annual_sun_hours > 0:
        out.append(
            f"An average facade band takes {b.annual_sun_hours:,.0f} hours of direct "
            f"sun a year and {b.annual_dose_kwh:,.0f} kWh/m² of shortwave.")
    if b.annual_month_of_peak:
        from .year import MONTH_NAMES
        out.append(
            f"It peaks in {MONTH_NAMES[b.annual_month_of_peak - 1]} at "
            f"{b.annual_facade_max_c:.0f} °C, and swings "
            f"{b.annual_swing_k:.0f} K between summer and winter means.")
    hot_months = sum(1 for v in b.annual_monthly_mean_c if v > 30.0)
    if hot_months >= 4:
        out.append(
            f"{hot_months} months of the year have a mean facade temperature above "
            f"30 °C, so this is chronic load rather than a heat-wave problem.")
    elif hot_months <= 2 and b.exposure_score > 55:
        out.append(
            "It scores high on the heat wave and low on the year: its problem is "
            "acute, so relief measures matter more than fabric measures.")
    if b.annual_winter_mean_c and b.annual_summer_mean_c:
        out.append(
            f"Winter facade mean is {b.annual_winter_mean_c:.0f} °C, so any shading "
            f"fitted for July also removes solar gain in January — the annual "
            f"trade-off is real and is quantified in the what-if panel.")
    return out


def explain(b: BuildingExposure) -> list[str]:
    """Plain-language reasons this building ranks where it does.

    Written as findings a person could act on or dispute, with the numbers
    attached and the measured/modelled distinction preserved.
    """
    out: list[str] = []
    c = b.components

    if b.persistence_hours >= 4.0:
        out.append(
            f"Measured: {b.persistence_hours:.1f} h unbroken above 35 °C during the "
            f"heat wave — no overnight recovery window."
        )
    if b.exceedance_hours >= 25.0:
        out.append(
            f"Measured: {b.exceedance_hours:.0f} total hours above 35 °C across the "
            f"seven-day event."
        )
    if b.svf_mean < 0.25:
        out.append(
            f"Measured geometry: sky view factor {b.svf_mean:.2f} — the street here is "
            f"deeply enclosed and radiates poorly to the sky at night."
        )
    if b.facade_spread_k >= 8.0:
        out.append(
            f"Modelled: {b.facade_spread_k:.0f} K spread between this building's hottest "
            f"and coolest face — the exposure is one-sided and so is the remedy."
        )
    if b.mrt_peak - b.peak_air_c > 15.0:
        out.append(
            f"Modelled: pedestrian mean radiant temperature at the base peaks "
            f"{b.mrt_peak - b.peak_air_c:.0f} K above air temperature "
            f"({b.mrt_peak:.0f} °C) — the sidewalk is far harsher than the air reading."
        )
    if b.wbgt_peak >= 32.0:
        out.append(
            f"Modelled: WBGT {b.wbgt_peak:.1f} °C at the base exceeds the 32 °C "
            f"threshold at which occupational guidance calls for work to stop."
        )
    if b.residential and b.units_res > 0:
        out.append(
            f"People: {b.units_res} residential units — occupants are exposed overnight, "
            f"not only during working hours."
        )
    if b.year_built and b.year_built < 1945:
        out.append(
            f"People: built {b.year_built}; pre-war stock is unlikely to have central "
            f"air conditioning or a performing envelope."
        )
    if b.hvi and b.hvi >= 4:
        out.append(
            f"People: DOHMH Heat Vulnerability Index {b.hvi}/5 for ZIP {b.zipcode} — "
            f"among the least able neighbourhoods to cope citywide."
        )
    return out


# ------------------------------------------------------ recommended actions


@dataclass
class Action:
    """A threshold-triggered intervention with a citation and an effect estimate."""

    key: str
    title: str
    rationale: str
    programme: str
    expected_effect: str
    applies_to: str


def recommend(b: BuildingExposure) -> list[Action]:
    """Threshold-triggered recommendations. Declarative, not generative.

    These fire on measured and modelled thresholds, so the same building always
    produces the same advice and a reviewer can trace every recommendation to
    the number that triggered it. The AI layer in ``ai.py`` writes the narrative
    *around* these; it does not invent them.
    """
    out: list[Action] = []

    if b.facade_solar_kwh > 3.0 and b.facade_spread_k >= 6.0:
        out.append(Action(
            key="facade_shading",
            title="External shading on the worst-exposed face",
            rationale=(
                f"The {b.hottest_face_name()} face absorbs {b.facade_solar_kwh:.1f} kWh/m² "
                f"over the day and runs {b.facade_spread_k:.0f} K hotter than the coolest "
                f"face. External shading intercepts that load before it reaches the wall, "
                f"which internal blinds cannot."
            ),
            programme="NYC Accelerator (free building-performance advice); ASHRAE 90.1 envelope guidance",
            expected_effect="Cuts absorbed facade shortwave 40-70% on the treated face",
            applies_to=f"{b.address or b.bin}",
        ))

    if b.height_m >= 12.0:
        out.append(Action(
            key="cool_roof",
            title="High-albedo roof coating",
            rationale=(
                "Roofs have the highest sky view factor of any surface on the building and "
                "take the full solar load with no shading from neighbours. Raising albedo "
                "from a typical 0.25 to 0.70 removes most of the absorbed shortwave."
            ),
            programme="NYC °CoolRoofs (free installation for eligible buildings); Local Law 92/94 sustainable-roof requirement",
            expected_effect="Roof surface 15-25 K cooler at peak; top-floor cooling load down 10-30%",
            applies_to=f"{b.address or b.bin}",
        ))

    if b.svf_mean < 0.30 and b.persistence_hours >= 3.0:
        out.append(Action(
            key="night_ventilation",
            title="Assisted night ventilation / cooling centre routing",
            rationale=(
                f"Sky view factor {b.svf_mean:.2f} means this street cannot radiate to the "
                f"sky at night, and the measured {b.persistence_hours:.1f} h unbroken "
                f"exceedance confirms there is no natural recovery window. Passive night "
                f"cooling will not work here; occupants need an alternative."
            ),
            programme="NYC Cool Options / cooling-centre network; DOHMH heat emergency plan",
            expected_effect="Removes reliance on overnight passive cooling that the geometry precludes",
            applies_to=f"{b.address or b.bin}",
        ))

    if b.mrt_peak - b.peak_air_c > 12.0:
        out.append(Action(
            key="street_trees",
            title="Street trees on the sunlit side",
            rationale=(
                f"Pedestrian mean radiant temperature at the base peaks {b.mrt_peak:.0f} °C, "
                f"{b.mrt_peak - b.peak_air_c:.0f} K above the air temperature. Canopy acts on "
                f"the radiant term directly, which is the term that dominates the felt "
                f"difference — far more than it acts on air temperature."
            ),
            programme="NYC Parks street-tree request; USDA Forest Service i-Tree planning",
            expected_effect="Shaded MRT typically 15-25 K below sunlit MRT; air temperature 0.5-1.5 K",
            applies_to=f"{b.address or b.bin}",
        ))

    if b.residential and b.year_built and b.year_built < 1945 and b.exceedance_hours > 22.0:
        out.append(Action(
            key="ac_access",
            title="Air-conditioning access programme referral",
            rationale=(
                f"{b.units_res} units in pre-war stock ({b.year_built}) facing "
                f"{b.exceedance_hours:.0f} h above 35 °C. Retrofit is slow; access to "
                f"cooling is immediate."
            ),
            programme="HEAP Cooling Assistance Component (NY State); NYCHA / DOHMH outreach",
            expected_effect="Directly addresses indoor overnight exposure for identified units",
            applies_to=f"{b.address or b.bin}",
        ))

    return out


def _hottest_face_name(self: BuildingExposure) -> str:
    if self.floors_detail:
        return self.floors_detail[0].hottest_face
    return "most-exposed"


BuildingExposure.hottest_face_name = _hottest_face_name  # type: ignore[attr-defined]


def compass(azimuth: float) -> str:
    """Compass name for a facade azimuth."""
    names = ["north", "north-east", "east", "south-east",
             "south", "south-west", "west", "north-west"]
    return names[int(((azimuth % 360.0) + 22.5) // 45.0) % 8]

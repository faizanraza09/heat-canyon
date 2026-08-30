"""What the wall is made of — the stated assumptions, in one place.

PLUTO carries a construction year, a floor count, a land use and a unit count.
It carries no cladding, no glazing, no window-to-wall ratio and no U-value, and
neither does any other free citywide dataset. Every watt this project prices
therefore rests on an assumption table, and the only defensible thing to do with
such a table is to put it in one module, state where each number came from, and
carry a range rather than a point wherever the input is a rule rather than a
measurement.

That is the same stance ``physics.facade_material()`` already takes for albedo.
This module extends it from the radiative properties to the thermal ones, and it
does so by *deriving its era from that function* rather than re-deriving it:
``assembly_for()`` calls ``facade_material()`` and maps the material it returns
onto an assembly. The two can therefore never disagree about what a building is
made of, which they would within a release or two if each carried its own set of
year and height thresholds.

Two words about the ranges, because they are the point of the module.

*They are corners of an assumption table, not confidence intervals.* Nobody has
measured the U-value of 10 Park Avenue's north wall. The low end is what the wall
plausibly is if the stock characterisation is optimistic about it, the high end
if it is pessimistic, and the honest output is both. Nothing in this module or in
``loads.py`` may collapse a range to its midpoint; a single number here would
propagate into a dollar figure downstream, and a dollar figure is the easiest
number in the system to over-trust.

*Where a value could not be sourced confidently the range was widened, not
narrowed.* A wide range that contains the truth is a usable input to a decision;
a narrow range that does not is worse than no number at all. Every such widening
is called out in the assembly's ``note``.

Definitions that matter downstream
----------------------------------
``u_wall`` is the **opaque** assembly U-value — the wall or spandrel including
its framing and its surface films, not the area-weighted whole-facade U-value
that a curtain-wall datasheet usually quotes. ``loads.py`` splits the band into
an opaque fraction and a glazed fraction and conducts through each with its own
coefficient, so a whole-assembly figure would double-count the glass. For
masonry with a 0.2 window-to-wall ratio the two are nearly the same number; for a
curtain wall they are not remotely.

``thermal_mass`` is the capacity available to damp the *indoor* temperature
swing, which is not the same quantity as the surface admittance
``physics.MATERIALS`` uses to set how much of the net radiation the outer skin
stores. A concrete-framed building with lightweight precast spandrels has a high
surface admittance at the panel and only medium capacity behind it.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from . import nyc, physics


# ------------------------------------------------------------------ assembly


@dataclass(frozen=True)
class Assembly:
    """One era's envelope, as a set of ranges with their provenance attached."""

    key: str
    label: str
    era: str
    u_wall: tuple[float, float]            # W/m2K, opaque assembly incl. films
    wwr: tuple[float, float]               # window-to-wall ratio of the facade
    u_glass: tuple[float, float]           # W/m2K, glazing incl. frame
    shgc: tuple[float, float]              # solar heat gain coefficient
    infiltration_ach: tuple[float, float]  # air changes per hour, natural
    thermal_mass: str                      # "heavy" | "medium" | "light"
    note: str
    source: str

    @property
    def ranges(self) -> dict[str, tuple[float, float]]:
        """Every numeric range, for the interface and for the range check."""
        return {
            "u_wall": self.u_wall,
            "wwr": self.wwr,
            "u_glass": self.u_glass,
            "shgc": self.shgc,
            "infiltration_ach": self.infiltration_ach,
        }


#: Which ``physics.facade_material()`` results each assembly can arise from.
#: ``assembly_for()`` is written against this map, and ``tests/test_loads.py``
#: asserts the two agree over a spread of (year, height) pairs. If a material is
#: ever added to ``physics.MATERIALS`` and returned by ``facade_material``, this
#: dict is where the omission shows up rather than in a silent fallback.
MATERIAL_OF_ASSEMBLY: dict[str, tuple[str, ...]] = {
    "pre_war_masonry": ("brick", "limestone"),
    "mid_century_masonry": ("concrete",),
    "post_war_concrete": ("concrete",),
    "early_curtain_wall": ("steel_glass",),
    "modern_curtain_wall": ("glass_curtain",),
}

#: The year that splits the two assemblies sharing the ``concrete`` material.
#: New York State's first energy code took effect in 1979, so 1980 is the line
#: between an envelope with no insulation requirement and one with a weak but
#: real one. The split is *within* a single ``facade_material`` result, so it
#: cannot contradict the radiative properties the physics uses; it only says
#: that two buildings the solar model treats alike conduct very differently.
CODE_ERA_YEAR = 1980


ASSEMBLIES: dict[str, Assembly] = {
    "pre_war_masonry": Assembly(
        key="pre_war_masonry",
        label="Pre-war solid masonry",
        era="before 1945",
        # Two to three wythes of brick, or brick backing behind a limestone or
        # terracotta face, plaster on furring inside, no cavity and no
        # insulation. A three-wythe wall at the base thins to two by the upper
        # storeys, which is most of why the range is 0.7 W/m2K wide.
        u_wall=(1.5, 2.2),
        wwr=(0.12, 0.28),
        # Wood double-hung single glazing is the original condition; a large but
        # unknown share of the stock has been reglazed or has storm windows, and
        # PLUTO cannot tell which. The range spans both, deliberately.
        u_glass=(2.7, 5.9),
        shgc=(0.55, 0.82),
        infiltration_ach=(0.5, 1.5),
        thermal_mass="heavy",
        note=(
            "Solid load-bearing masonry: no cavity, no insulation, and a wall "
            "section that thins with height, so the U range is wide by "
            "construction rather than by uncertainty. The glazing range is the "
            "one that could not be sourced and was widened instead of guessed: "
            "the original single-glazed wood sash and a modern replacement unit "
            "differ by more than a factor of two, and no free dataset records "
            "which any given building has. Heavy mass is the reason this era "
            "runs cooler at its surface in the afternoon and hotter at midnight, "
            "which physics.py already models through admittance."
        ),
        source=(
            "U computed from ASHRAE Handbook of Fundamentals material "
            "conductivities for 2-3 wythe solid brick with interior plaster on "
            "furring, R 0.45-0.67 m2K/W including surface films; cross-checked "
            "against the DOE/NREL commercial reference-building 'pre-1980' "
            "vintage mass-wall U-factor of 0.29 Btu/h.ft2.F (1.65 W/m2K). "
            "Window-to-wall ratio from the punched-window pattern of NYC pre-war "
            "residential stock as characterised in Urban Green Council's '90 by "
            "50' study. Infiltration from ASHRAE Fundamentals ch. 16 and NIST "
            "airtightness measurements of older US multifamily buildings."
        ),
    ),
    "mid_century_masonry": Assembly(
        key="mid_century_masonry",
        label="Post-war masonry cavity wall",
        era="1945-1979",
        # Brick outer wythe, cavity, concrete block back-up, plaster or board
        # inside. Better than solid brick because of the cavity, still with no
        # insulation requirement anywhere in the band.
        u_wall=(1.0, 1.7),
        wwr=(0.18, 0.34),
        u_glass=(2.6, 5.6),
        shgc=(0.55, 0.82),
        infiltration_ach=(0.4, 1.1),
        thermal_mass="heavy",
        note=(
            "The cavity is the whole difference from the era before it, and it "
            "is worth roughly 0.5 W/m2K. Aluminium single-glazed replacement "
            "sash became common in this stock in the 1970s and 1980s and is "
            "thermally worse than the wood it replaced at the frame, which is "
            "why the glazing range does not tighten relative to the pre-war "
            "band. Through-wall air-conditioner sleeves are endemic in this era "
            "and are a large, unquantified infiltration path; the upper end of "
            "the ACH range carries them."
        ),
        source=(
            "U computed from ASHRAE Handbook of Fundamentals conductivities for "
            "a 100 mm brick / 50 mm cavity / 200 mm block wall, R 0.6-1.0 "
            "m2K/W including films. Bracketed above by the DOE/NREL 'pre-1980' "
            "mass-wall U of 1.65 W/m2K and below by ASHRAE 90.1-2004's Climate "
            "Zone 4A mass-wall maximum of U-0.151 Btu/h.ft2.F (0.86 W/m2K), "
            "which this era predates and does not meet. NYC is ASHRAE Climate "
            "Zone 4A throughout."
        ),
    ),
    "post_war_concrete": Assembly(
        key="post_war_concrete",
        label="Concrete frame with insulated spandrel",
        era="1980 onwards, outside the curtain-wall stock",
        # Concrete or masonry frame with precast, EIFS or cavity-insulated
        # infill, built under a code that required some insulation.
        u_wall=(0.5, 1.3),
        wwr=(0.25, 0.45),
        u_glass=(2.0, 3.6),
        shgc=(0.40, 0.75),
        infiltration_ach=(0.25, 0.8),
        thermal_mass="medium",
        note=(
            "The first era in the stock built under an energy code, which is why "
            "its U range straddles the code maximum rather than sitting above "
            "it: the code is a ceiling on new work, not a description of what "
            "the stock achieves, and thermal bridging at slab edges and shelf "
            "angles routinely doubles the nominal centre-of-panel figure. Mass "
            "is called medium rather than heavy because the frame is concrete "
            "but the spandrel is usually a thin precast or EIFS panel; that "
            "distinction is about damping the indoor swing and is separate from "
            "the surface admittance physics.py assigns to concrete."
        ),
        source=(
            "ASHRAE 90.1 Climate Zone 4A prescriptive envelope criteria, 2004 "
            "edition mass wall U-0.151 Btu/h.ft2.F (0.86 W/m2K) and 2019 "
            "edition U-0.090 (0.51 W/m2K), taken as the achievable end of the "
            "range; the DOE/NREL '1980-2004' reference-building vintage supplies "
            "the middle. The upper end allows for thermal bridging measured in "
            "ASHRAE RP-1365 assembly tests, which are the reason a nominally "
            "R-13 spandrel performs closer to R-6."
        ),
    ),
    "early_curtain_wall": Assembly(
        key="early_curtain_wall",
        label="Early aluminium curtain wall",
        era="1960-1989, above 40 m",
        # Thermally unbroken aluminium framing, single or early sealed double
        # glazing, an insulated metal or spandrel-glass panel below the vision
        # band with little in it.
        u_wall=(1.0, 2.2),
        wwr=(0.50, 0.75),
        u_glass=(3.0, 5.9),
        shgc=(0.50, 0.80),
        infiltration_ach=(0.3, 0.9),
        thermal_mass="light",
        note=(
            "The worst envelope in the stock and the one where the opaque and "
            "glazed halves must be kept apart: an area-weighted whole-assembly "
            "U-value for this era lands near 3 W/m2K and is dominated entirely "
            "by the glass, so applying it to the spandrel too would overstate "
            "the conduction by a factor of two. Tinted grey and bronze glass is "
            "common here and cuts SHGC without cutting U, which is why the SHGC "
            "range reaches down to 0.50 while the glazing U does not improve. "
            "The frames are thermally unbroken aluminium and no free record "
            "distinguishes single from early sealed double glazing, so the "
            "glazing range was widened rather than split."
        ),
        source=(
            "Glazing U and SHGC from ASHRAE Handbook of Fundamentals ch. 15 "
            "fenestration tables for single and early sealed double glazing in "
            "aluminium frames without a thermal break. Spandrel U from the same "
            "chapter's opaque-panel assemblies with 25-50 mm of batt behind a "
            "metal pan. Window-to-wall ratio from the vision-band proportion of "
            "the 1960s and 1970s Manhattan curtain-wall type; treated as a "
            "characterisation of the type rather than a measured distribution."
        ),
    ),
    "modern_curtain_wall": Assembly(
        key="modern_curtain_wall",
        label="Modern thermally broken curtain wall",
        era="1990 onwards, above 60 m",
        u_wall=(0.5, 1.3),
        wwr=(0.55, 0.82),
        u_glass=(1.5, 2.8),
        shgc=(0.25, 0.48),
        infiltration_ach=(0.15, 0.5),
        thermal_mass="light",
        note=(
            "Low-e coatings are what changed, and they changed SHGC far more "
            "than U: this era admits roughly half the solar gain of the era "
            "before it through nearly half again as much glass. That is the "
            "reason the ranking does not simply surface the shiniest towers, and "
            "it is also why the glazing-retrofit measure ranks poorly here and "
            "well on the early curtain wall. The window-to-wall ratio range "
            "reaches 0.82 because floor-to-ceiling glass with a shallow shadow "
            "box is now the default and a nominal 0.70 understates it."
        ),
        source=(
            "ASHRAE 90.1 Climate Zone 4A fixed-fenestration criteria, 2004 "
            "edition U-0.57 Btu/h.ft2.F (3.24 W/m2K) / SHGC 0.39 and 2016-2019 "
            "editions near U-0.38 (2.16) / SHGC 0.36, with NFRC-rated "
            "thermally broken units reaching 1.5 W/m2K at the better end. "
            "Spandrel U as for the post-1980 band. NYC Local Law 97's covered-"
            "building stock is where this assembly concentrates."
        ),
    ),
}


def assembly_for(
    year_built: int | None,
    height_m: float,
    land_use: int | None = None,
) -> Assembly:
    """Pick the envelope assembly for one building. A stated assumption.

    The era comes from ``physics.facade_material()`` rather than from a second
    set of thresholds here. That is deliberate: the alternative — two tables of
    year and height cut-offs maintained side by side — produces a building whose
    albedo says curtain wall and whose U-value says masonry, and the drift would
    be invisible because neither number is ever checked against a measurement.

    ``facade_material`` returns five materials and this module carries five
    assemblies, but they do not correspond one to one. Brick and limestone are
    both pre-war heavy masonry and differ only in what is hung on the front, so
    they share an assembly. ``concrete`` covers everything from a 1950 six-storey
    walk-up to a 1995 low-rise, which is two entirely different envelopes, so it
    splits at ``CODE_ERA_YEAR``. The split is inside one material, so it cannot
    put this module and the physics at odds.

    ``land_use`` is used for exactly one thing, and it is used because ignoring
    it would be worse: a pre-war *loft or factory* building carries large steel
    industrial sash, three to four times the glazed fraction of the tenement
    stock the pre-war range is written around. Where the use code says
    commercial or industrial and the era is pre-war, the window-to-wall range is
    widened at the top to cover it. Nothing else about the assembly changes, and
    the key stays the same, so downstream code that looks the assembly up by key
    still finds it.
    """
    material = physics.facade_material(year_built, height_m)
    year = year_built or 1920

    if material in ("brick", "limestone"):
        key = "pre_war_masonry"
    elif material == "concrete":
        key = "mid_century_masonry" if year < CODE_ERA_YEAR else "post_war_concrete"
    elif material == "steel_glass":
        key = "early_curtain_wall"
    elif material == "glass_curtain":
        key = "modern_curtain_wall"
    else:
        # Unreachable while MATERIAL_OF_ASSEMBLY covers facade_material's range;
        # a new material added to physics.py lands here loudly rather than being
        # silently absorbed into the nearest era.
        raise KeyError(
            f"physics.facade_material returned {material!r}, which "
            f"heatcanyon.envelope has no assembly for. Add it to "
            f"MATERIAL_OF_ASSEMBLY and ASSEMBLIES."
        )

    a = ASSEMBLIES[key]
    if key == "pre_war_masonry" and land_use in (5, 6):
        lo, hi = a.wwr
        a = replace(
            a,
            wwr=(lo, 0.45),
            note=a.note + (
                " Land use is commercial or industrial and the era is pre-war, "
                "so the window-to-wall range has been widened at the top to "
                "0.45 to cover loft and factory buildings with large steel "
                "industrial sash. That is the only thing PLUTO's use code is "
                "allowed to change about an assembly here."
            ),
        )
    return a


# ---------------------------------------------------------------- occupancy


@dataclass(frozen=True)
class Occupancy:
    """Who is inside, when, and what they contribute to the load.

    ``internal_gain_w_m2`` is a *peak coincident sensible* gain over the
    conditioned floor plate — lights, equipment and bodies at the hour the
    cooling load peaks, not a daily average. Latent gain is not carried: this
    model solves a dry-bulb balance and adding a latent term without a humidity
    balance to put it in would be decoration.
    """

    key: str
    label: str
    internal_gain_w_m2: tuple[float, float]
    occupied_hours: tuple[int, int]
    overnight: bool
    setpoint_c: float
    persons_per_unit: float

    @property
    def residential(self) -> bool:
        return self.persons_per_unit > 0.0


OCCUPANCIES: dict[str, Occupancy] = {
    "residential": Occupancy(
        key="residential",
        label="Residential",
        # Lighting 2-5, plug load 3-5, bodies 2-4 W/m2 at the evening peak.
        internal_gain_w_m2=(4.0, 9.0),
        occupied_hours=(0, 24),
        overnight=True,
        # 24 degC rather than the 23-24 a design engineer would size to. The
        # setpoint is what the load is computed against; overnight exposure is
        # scored separately against 28 degC in loads.py, which is the threshold
        # the health guidance uses and is a different question.
        setpoint_c=24.0,
        # Average household size for New York County, ACS 5-year. Manhattan is
        # roughly 2.0 against 2.5 citywide, and using the citywide figure here
        # would inflate every person-hour in the study area by a quarter.
        persons_per_unit=2.0,
    ),
    "office": Occupancy(
        key="office",
        label="Office",
        # Lighting 6-11 (a 1970s office and a 90.1-2010 office differ by that
        # much on its own), equipment 8-12, occupants 5-6 W/m2 sensible.
        internal_gain_w_m2=(12.0, 28.0),
        occupied_hours=(8, 19),
        overnight=False,
        setpoint_c=23.0,
        persons_per_unit=0.0,
    ),
    "retail": Occupancy(
        key="retail",
        label="Retail",
        internal_gain_w_m2=(15.0, 35.0),
        occupied_hours=(10, 21),
        overnight=False,
        setpoint_c=23.0,
        persons_per_unit=0.0,
    ),
    "other": Occupancy(
        key="other",
        label="Other or unknown use",
        internal_gain_w_m2=(6.0, 16.0),
        occupied_hours=(7, 19),
        overnight=False,
        setpoint_c=24.0,
        persons_per_unit=0.0,
    ),
}


def occupancy_for(land_use: int | None) -> Occupancy:
    """Map a PLUTO land-use code onto an occupancy. A stated assumption.

    ``nyc.RESIDENTIAL_USES`` is the authority for which codes have people
    sleeping in them, and mixed residential-and-commercial is inside it: the
    apartments above the shop are where the overnight exposure is.

    **An unknown land use returns residential**, and that is a deliberate
    asymmetry rather than an oversight. ``person_hours`` is zero for every
    non-residential occupancy, so defaulting a missing join to "other" would
    make an unrecorded building look safe, and the same reasoning already
    governs the unknown-ZIP case in ``exposure.vulnerability()``. In this study
    area the modal building with no use code is residential or mixed anyway.

    Retail exists in the table but ``occupancy_for`` never returns it. PLUTO's
    land-use field has no retail code — code 5 is "Commercial & Office
    Buildings" and covers both — so the distinction cannot be made from this
    input. It is carried for a caller that knows better, such as one scoring a
    ground-floor band, and pretending the use code could tell them apart would
    be a fabrication.
    """
    if land_use is None:
        return OCCUPANCIES["residential"]
    if land_use in nyc.RESIDENTIAL_USES:
        return OCCUPANCIES["residential"]
    if land_use == 5:
        return OCCUPANCIES["office"]
    return OCCUPANCIES["other"]


def assumption_table() -> list[dict]:
    """Every assembly and occupancy as plain dicts, for the interface and for
    ``validate``. An assumed figure rendered without its range or its source is a
    bug, so the source travels with the numbers rather than living in a footnote.
    """
    rows: list[dict] = []
    for a in ASSEMBLIES.values():
        rows.append({
            "kind": "assembly",
            "key": a.key,
            "label": a.label,
            "era": a.era,
            "materials": list(MATERIAL_OF_ASSEMBLY[a.key]),
            "thermal_mass": a.thermal_mass,
            "note": a.note,
            "source": a.source,
            "basis": "assumed",
            **{k: list(v) for k, v in a.ranges.items()},
        })
    for o in OCCUPANCIES.values():
        rows.append({
            "kind": "occupancy",
            "key": o.key,
            "label": o.label,
            "internal_gain_w_m2": list(o.internal_gain_w_m2),
            "occupied_hours": list(o.occupied_hours),
            "overnight": o.overnight,
            "setpoint_c": o.setpoint_c,
            "persons_per_unit": o.persons_per_unit,
            "basis": "assumed",
        })
    return rows

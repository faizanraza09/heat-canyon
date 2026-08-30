"""The measure, specified: a device, a dimension, a floor range, and the number that chose it.

``exposure.recommend()`` fires five building-level actions off temperature and
geometry thresholds. It stays exactly where it is and keeps working — the
analyst and the interface read it, and a threshold catalogue is the right shape
for a one-paragraph brief. This module is the richer parallel path: the same
declarative, never-generative stance, taken down to a face, a floor range and a
projection in metres.

Two ideas separate it from a recommendation list.

**The measure family is chosen by the attribution, never by a temperature.**
Section 1 of ``docs/DECISIONS.md`` decomposes the surface energy balance into
three additive kelvin terms — absorbed shortwave, longwave trapped from the
surfaces opposite, and the negative sky term that is the surface's only free
cooling. Four buildings all peaking at 53 °C can be hot for four different
reasons, and each reason has a different remedy. A solar-dominant west facade
wants its beam intercepted; a trap-dominant courtyard wall wants insulation and
something done about the wall opposite; a floor whose surface is barely above
air temperature wants no facade measure at all and should be told so rather than
sold a brise-soleil. Every ``why`` string here quotes the attribution figures
that selected the measure, so a reviewer can trace the choice back to the number
and argue with it.

**The geometry is derived, not looked up.** For a horizontal overhang the
required projection follows from the profile angle:

    P = h_window · cos(gamma_sun − gamma_wall) / tan(alpha_sun)

evaluated at the hour of peak absorbed shortwave for that band, which the model
knows because it solved every hour. The formula earns its keep mostly through
its *negative* results, and this module surfaces them rather than clamping them
away. On an east or west wall the peak arrives at low solar altitude with the
sun nearly normal to the glass: ``tan alpha`` collapses, ``P`` diverges, and a
fixed horizontal overhang is simply the wrong device. Vertical fins fail on the
same wall for the mirror reason — a beam arriving near-normal in plan needs fins
deeper than they are far apart, which is a wall, not a shading device. So a west
facade gets operable shading or a glazing swap, and the prescription says which
fixed device it rejected and at what dimension.

WHAT THIS MODULE DOES NOT DO

It never re-solves physics. ``resolve`` is a callable the caller supplies: the
pipeline passes a ``scenarios.run_scenario`` closure, the server passes the live
intervention engine in ``agent/interventions.py``. This module decides *what* to
solve and interprets the answer. That is the only arrangement in which the
stated effect and the model's own answer cannot drift apart — a coefficient
table would let them, silently, forever.

It also never prices anything. ``Prescription.money`` is left ``None`` for
``economics.price`` to fill, and the fields that function needs (``key``,
``area_m2``, the effect's energy deltas) are all present on the prescription.

THE ``resolve`` CONTRACT

``resolve`` takes exactly one positional argument, a plain dict, and returns a
plain dict or ``None``. Plain dicts on both sides because the two callers are
very different objects and neither should have to import this module to be
called by it.

    request = {
        "bin":        str,            # the building
        "measure":    str,            # a key of MEASURES
        "family":     str,            # the measure family
        "spec":       dict,           # lever dict in the agent/interventions.py
                                      # LEVERS vocabulary, e.g. {"facade_shade": 0.6}
        "faces":      list[str],      # compass names being treated
        "azimuths":   list[float],    # their facade azimuths, same order
        "floors":     (int, int),     # inclusive storey range
        "bands":      (int, int),     # inclusive solved-band range
        "area_m2":    float,          # treated envelope area
        "periods":    ["summer", "winter", "year"],
    }

    result = {                        # every key optional; missing means unknown
        "d_facade_peak_k":  float,    # K, negative is cooler. THE anchor figure.
        "d_annual_kwh":     (lo, hi) or float,   # negative is saved
        "d_peak_kw":        (lo, hi) or float,
        "d_person_hours":   float,    # negative is avoided exposure
        "d_winter_kwh":     (lo, hi) or float,   # POSITIVE is a heating penalty
        "seasonal":         {"summer_d_facade_k": .., "winter_d_facade_k": ..,
                             "year_d_facade_k": ..},
        "note":             str,      # carried through to Prescription.effect_note
    }

Only ``d_facade_peak_k`` really has to come back. Anything else missing is
derived here by a first-order scaling of the building's own load, and when that
happens the prescription's ``confidence`` drops to ``"assumed"`` and
``effect_note`` says which figures were derived rather than reported. A resolver
that raises is caught: the prescription survives with ``effect=None`` and the
exception's message in ``effect_note``, because a broken re-solve should cost
one number, not the whole schedule.

``resolve=None`` is a supported mode, not a degraded one — it is how the module
is used before the pipeline is wired and how the tests run. Every prescription
comes back complete except for ``effect``, which is ``None`` with a stated
reason.

DETERMINISM

The same building must always yield the same prescriptions in the same order.
There is no randomness here, nothing iterates a set, nothing depends on dict
insertion order for its result, and the final sort key is
``(rank, first floor, last floor, device, faces, key)`` — five integers and
strings and not one float, so no floating-point tie can flip the order between
two runs of the same input.

IMPORTS

``envelope``, ``loads`` and ``economics`` are siblings in the same layer and are
imported for type checking only. Nothing here calls into them at runtime: this
module reads attributes off whatever ``BuildingLoads``-shaped object it is
given, which is what lets the tests run against synthetic fixtures and lets this
file be imported before its siblings land.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Iterable, Sequence

from . import solar as S

if TYPE_CHECKING:  # pragma: no cover - types only, never imported at runtime
    from .economics import Money
    from .envelope import Assembly, Occupancy
    from .loads import BuildingLoads, FaceLoad, FloorLoad


# --------------------------------------------------------------- constants


#: The projection cutoff, in metres, beyond which this module refuses to
#: specify a fixed horizontal overhang.
#:
#: 1.5 m is a judgement and is stated as one. Three things set it. A projection
#: much past 1.5 m on a Manhattan facade stops being a shading device and starts
#: being a structure: it needs its own cantilever back into the slab edge, it
#: usually crosses the lot line into the street wall the zoning resolution
#: protects, and on any landmarked or contextual facade it will not be
#: permitted. Second, a 1.5 m overhang on a 2.1 m window head corresponds to a
#: profile angle of 54.5°, which is comfortably inside the summer profile angles
#: a southerly Manhattan facade actually sees — so the cutoff does not reject
#: anything that would have worked. Third, and most usefully, the cutoff is what
#: converts the projection formula from a dimension generator into a *test*: the
#: cases it rejects are exactly the east and west facades where the fixed device
#: is the wrong answer, and rejecting them loudly is more valuable than
#: returning a 6 m awning nobody will build.
#:
#: Raising it would not make west facades work — see FIN_MAX_DEPTH_RATIO — it
#: would only produce larger implausible numbers.
CUTOFF_PROJECTION_M = 1.5

#: An overhang between the cutoff and this limit is not hopeless, only too deep
#: on its own; combined with fins in an eggcrate it comes back under the cutoff.
#: Past 2.5 m nothing fixed is worth drawing.
EGGCRATE_PROJECTION_LIMIT_M = 2.5

#: Vertical fins block a beam whose horizontal offset from the wall normal is
#: ``dg`` when their depth ``d`` and spacing ``s`` satisfy ``d >= s / tan|dg|``.
#: A fin deeper than its spacing reads as a solid wall from inside: it takes the
#: view, most of the daylight and the natural ventilation with it, and it is not
#: what anyone means by a shading device. So a depth-to-spacing ratio of 1.0 is
#: the feasibility limit, which puts the fin's own cutoff at |dg| >= 45°. That
#: is the reason a due-west facade cannot be fixed-shaded by *either* device: the
#: horizontal fails because the sun is low, the vertical fails because the sun is
#: normal, and both failures have the same cause.
FIN_MAX_DEPTH_RATIO = 1.0

#: Nominal fin depth, metres. Fins are specified at a fixed depth with the
#: spacing derived, rather than the other way round, because depth is what the
#: facade budget and the cantilever detail are sensitive to and spacing is what
#: the module is free to choose.
FIN_DEPTH_M = 0.6

#: Below this the horizontal offset between sun and wall normal is treated as
#: zero for the fin calculation, to keep ``1/tan`` finite. At 0.5° the required
#: ratio is already 115:1, so the branch it guards is decided either way.
_MIN_OFFSET_DEG = 0.5

#: Below this solar altitude the overhang formula is unbounded and is reported as
#: such rather than evaluated. 3° is below the altitude at which any facade takes
#: meaningful beam through the urban horizon anyway.
_MIN_ALTITUDE_DEG = 3.0

#: A floor is "acutely" rather than "chronically" exposed when its free-running
#: indoor hours above 28 °C fall below this. The distinction decides whether an
#: operational measure with a lead time of one season is offered alongside the
#: capital one: a floor that is unbearable for 90 hours a year in two heat waves
#: is a scheduling and relocation problem, and telling its occupants to wait for
#: the next capital cycle is not an answer. A floor loaded for 600 hours has a
#: fabric problem and the fabric measure is the honest one.
ACUTE_HOURS_THRESHOLD = 200.0

#: A roof measure needs a roof worth treating. Below 12 m the building is short
#: enough that the facades dominate the top floor's load anyway; below 120 m2
#: there is not enough roof to matter against the mobilisation cost.
ROOF_MIN_HEIGHT_M = 12.0
ROOF_MIN_AREA_M2 = 120.0

#: Canopy reaches bands 0 and 1 of the ten solved bands and no further. This is
#: not a modelling convenience, it is what a street tree does: a mature London
#: plane in Midtown is 12-15 m to the crown against building heights of 60-250 m.
CANOPY_TOP_BAND = 1

#: Study-area fallbacks for the solar position, used only when ``context``
#: supplies neither a sun table nor a callable. Midtown AOI centroid and the
#: study date, mirroring ``aoi.LAT0`` and ``pipeline.STUDY_DATE`` — copied rather
#: than imported so this module keeps no dependency on the pipeline.
_FALLBACK_LAT = 40.7550
_FALLBACK_LON = -73.9832
_FALLBACK_DATE = (2026, 7, 2)
_EDT_OFFSET = -4.0


# ------------------------------------------------------------------ shapes


@dataclass
class Effect:
    """What the model says the measure does, from a re-solve and nothing else.

    ``source`` is ``"re-solved"`` and only ever ``"re-solved"``: an ``Effect``
    exists if and only if a resolver returned an answer. Where no resolver was
    supplied, or one failed, the prescription carries ``effect=None`` and a
    reason in ``effect_note`` — never a plausible-looking coefficient.
    """

    d_facade_peak_k: float
    d_annual_kwh: tuple[float, float]
    d_peak_kw: tuple[float, float]
    d_person_hours: float
    d_winter_kwh: tuple[float, float]      # positive = a heating penalty
    seasonal: dict[str, float]
    source: str = "re-solved"


@dataclass(frozen=True)
class MeasureFamily:
    """One entry in the catalogue: what the measure is and how it is solved.

    ``spec`` is a lever dict in the vocabulary ``agent/interventions.py`` already
    publishes in ``LEVERS``, so a prescription can be handed straight to the live
    engine without a translation table nobody would maintain.

    ``resolvable`` is False for measures that change nothing outside the
    envelope. Night purge ventilation, cooling-centre routing and tenant
    relocation are real, effective and in several cases the *only* thing
    available before the next heat wave — and a canyon surface-energy-balance
    model has nothing to say about any of them. Marking them plainly is better
    than inventing a facade delta so the column is full.
    """

    key: str
    title: str
    family: str            # shading | glazing | envelope | roof | canopy |
                           # ventilation | operational | mechanical
    rank: int              # the published ordering; lower comes first
    lead_time: str         # "this season" | "one year" | "capital cycle"
    confidence: str        # "modelled" | "assumed"
    spec: dict[str, float]
    resolvable: bool
    winter_cost: str
    programme: tuple[str, ...]
    also_consider: tuple[str, ...]
    note: str


@dataclass
class Prescription:
    """One measure, on named faces, over an inclusive storey range.

    Fields beyond the contract in section 5 of ``docs/DECISIONS.md``:
    ``bands`` (which of the ten solved bands the storey range maps to, so the
    schedule never implies storey-level resolution the model does not have) and
    ``effect_note`` (why ``effect`` is ``None``, or which of its figures were
    derived rather than reported by the resolver). ``effect`` and ``money`` are
    optional because a prescription is complete and useful before either the
    resolver or ``economics.price`` has run.
    """

    key: str
    title: str
    family: str
    faces: list[str]                 # compass names treated, sorted
    floors: tuple[int, int]          # inclusive storey range
    bands: tuple[int, int]           # inclusive solved-band range
    device: str
    geometry: dict
    area_m2: float
    why: str
    #: The same reasoning in labelled parts, in the order it was written:
    #: ``[("Where the heat is", "..."), ("Sizing", "..."), ...]``. ``why`` is
    #: these joined, and stays because a model reading a schedule wants prose.
    #: The brief sets each part under its own heading, which is what turned
    #: section 4 from a page of unbroken paragraph into something a contractor
    #: can find a number in.
    why_parts: list[tuple[str, str]]
    winter_cost: str
    programme: list[str]
    does_not_fix: str
    also_consider: list[str]
    confidence: str                  # "modelled" | "assumed"
    lead_time: str                   # "this season" | "one year" | "capital cycle"
    effect: Effect | None = None
    effect_note: str = ""
    money: "Money | None" = None

    def as_dict(self) -> dict:
        """JSON-ready, for ``prescriptions.json`` and the ``/api/prescribe`` body."""
        eff = None
        if self.effect is not None:
            eff = {
                "d_facade_peak_k": self.effect.d_facade_peak_k,
                "d_annual_kwh": list(self.effect.d_annual_kwh),
                "d_peak_kw": list(self.effect.d_peak_kw),
                "d_person_hours": self.effect.d_person_hours,
                "d_winter_kwh": list(self.effect.d_winter_kwh),
                "seasonal": dict(self.effect.seasonal),
                "source": self.effect.source,
            }
        return {
            "key": self.key, "title": self.title, "family": self.family,
            "faces": list(self.faces), "floors": list(self.floors),
            "bands": list(self.bands), "device": self.device,
            "geometry": dict(self.geometry), "area_m2": self.area_m2,
            "why": self.why, "effect": eff, "effect_note": self.effect_note,
            "winter_cost": self.winter_cost, "programme": list(self.programme),
            "does_not_fix": self.does_not_fix,
            "also_consider": list(self.also_consider),
            "confidence": self.confidence, "lead_time": self.lead_time,
            "money": None,
        }


# ------------------------------------------------------------- the catalogue


def _m(**kw) -> MeasureFamily:
    return MeasureFamily(**kw)


#: The measure catalogue.
#:
#: Ranks are the published ordering and are deliberately not a cost ordering.
#: Glazing sits first because on a curtain wall — where the selection table sends
#: it — the glass *is* the wall and every other facade measure is working around
#: it. Fixed shading follows, then operable, then the operational measures that
#: can happen this season, then fabric, roof, canopy, ventilation and finally the
#: measures that treat people rather than buildings.
#:
#: Six of the sixteen have ``lead_time="this season"``. That is not padding. The
#: first question after any of this is presented is "what can we do before
#: August", and a catalogue in which every honest answer is "not this one" is a
#: catalogue that has failed the question.
MEASURES: dict[str, MeasureFamily] = {
    "glazing_retrofit": _m(
        key="glazing_retrofit",
        title="Glazing retrofit to a low-SHGC unit",
        family="glazing",
        rank=10,
        lead_time="capital cycle",
        confidence="assumed",
        # The lever the canyon model has for a glazing swap is the shortwave the
        # facade stops admitting. A curtain-wall unit going from SHGC ~0.55 to
        # ~0.25 removes a little over half the transmitted beam.
        spec={"facade_shade": 0.55},
        resolvable=True,
        winter_cost=(
            "A low-SHGC unit rejects the January beam as efficiently as the July "
            "one, so a heating-dominated floor pays for this all winter. The "
            "modern units also raise the U-value, which partly repays it."),
        programme=("NYC Accelerator building-performance advice",
                   "Local Law 97 compliance pathway",
                   "NYSERDA Empire Building Challenge"),
        also_consider=("operable_shading", "window_film"),
        note=("On a curtain wall the glass is the wall: the opaque spandrel is a "
              "minority of the elevation and no external device can be hung off "
              "it without a new structural line. The glazing unit is where the "
              "load actually is."),
    ),
    "fixed_shading_horizontal": _m(
        key="fixed_shading_horizontal",
        title="Fixed horizontal overhang",
        family="shading",
        rank=20,
        lead_time="capital cycle",
        confidence="modelled",
        spec={"facade_shade": 0.60},
        resolvable=True,
        winter_cost=(
            "An overhang sized on the summer profile angle passes most of the "
            "winter beam underneath it, because the winter sun is lower. This is "
            "the one shading device whose seasonal penalty is small by "
            "construction, and it is why it is preferred wherever the geometry "
            "allows it."),
        programme=("NYC Accelerator", "ASHRAE 90.1 envelope guidance",
                   "Landmarks Preservation Commission review if applicable"),
        also_consider=("window_film", "cool_roof"),
        note=("Continuous along the elevation, sized from the profile angle at "
              "the hour of peak absorbed shortwave for the governing band."),
    ),
    "fixed_shading_vertical": _m(
        key="fixed_shading_vertical",
        title="Fixed vertical fins",
        family="shading",
        rank=21,
        lead_time="capital cycle",
        confidence="modelled",
        spec={"facade_shade": 0.55},
        resolvable=True,
        winter_cost=(
            "Fins block by plan angle, not by altitude, so they take the same "
            "share of the beam in January as in July. The seasonal penalty is "
            "real and larger than an overhang's."),
        programme=("NYC Accelerator", "ASHRAE 90.1 envelope guidance"),
        also_consider=("operable_shading", "window_film"),
        note=("Fins are the device when the beam arrives obliquely in plan. They "
              "are useless when it arrives normal to the glass, which is exactly "
              "the west-facade case."),
    ),
    "fixed_shading_eggcrate": _m(
        key="fixed_shading_eggcrate",
        title="Eggcrate brise-soleil (overhang plus fins)",
        family="shading",
        rank=22,
        lead_time="capital cycle",
        confidence="modelled",
        spec={"facade_shade": 0.65},
        resolvable=True,
        winter_cost=(
            "Both the altitude and the plan components are blocked year-round; "
            "this is the deepest winter penalty of the fixed devices and the "
            "price of treating a south-west or south-east exposure with one."),
        programme=("NYC Accelerator", "ASHRAE 90.1 envelope guidance"),
        also_consider=("operable_shading", "glazing_retrofit"),
        note=("Neither element alone comes in under the projection cutoff on a "
              "diagonal exposure; together they do, at a modest overhang and a "
              "fin spacing derived from the residual plan angle."),
    ),
    "operable_shading": _m(
        key="operable_shading",
        title="External operable shading (louvres or retractable awning)",
        family="shading",
        rank=30,
        lead_time="one year",
        confidence="assumed",
        spec={"facade_shade": 0.70},
        resolvable=True,
        winter_cost=(
            "None worth stating: the point of an operable device is that it "
            "retracts, so the winter beam is available when it is wanted. The "
            "cost is moved into maintenance and into whether anyone actually "
            "operates it."),
        programme=("NYC Accelerator", "NYSERDA Empire Building Challenge"),
        also_consider=("window_film", "glazing_retrofit", "blinds_policy"),
        note=("The answer wherever a fixed device is geometrically infeasible or "
              "where the winter beam is worth keeping. It is also the answer "
              "with the largest gap between modelled and delivered performance, "
              "because it depends on being operated."),
    ),
    "window_film": _m(
        key="window_film",
        title="Applied solar-control window film",
        family="glazing",
        rank=35,
        lead_time="this season",
        confidence="assumed",
        spec={"facade_shade": 0.35},
        resolvable=True,
        winter_cost=(
            "Permanent and unselective: it rejects the January beam too, and it "
            "cannot be retracted. On a heating-dominated floor that is a genuine "
            "annual cost against a summer benefit."),
        programme=("NYC Accelerator", "Utility custom-measure rebate"),
        also_consider=("blinds_policy", "operable_shading"),
        note=("Weeks of lead time and no structural work — the reason it is in "
              "this catalogue at all. It buys perhaps half of what an external "
              "device buys, because it absorbs inside the glass line rather than "
              "intercepting outside it, and that is stated rather than rounded up."),
    ),
    "blinds_policy": _m(
        key="blinds_policy",
        title="Managed internal blinds and closure schedule",
        family="operational",
        rank=36,
        lead_time="this season",
        confidence="assumed",
        # Internal blinds act inside the glass line: the energy is already in the
        # room. The engine has no lever for that, and pretending facade_shade is
        # one would overstate it by roughly a factor of three.
        spec={},
        resolvable=False,
        winter_cost="None. The schedule reverses seasonally.",
        programme=("Building operations",
                   "NYC Accelerator operations and maintenance review"),
        also_consider=("window_film", "operable_shading"),
        note=("The cheapest thing on this list and the one most often already "
              "half-done. It acts inside the glass, so it controls glare and "
              "radiant asymmetry well and absorbed heat poorly."),
    ),
    "wall_insulation": _m(
        key="wall_insulation",
        title="External wall insulation / added facade admittance",
        family="envelope",
        rank=40,
        lead_time="capital cycle",
        confidence="modelled",
        spec={"wall_admittance": 400.0},
        resolvable=True,
        winter_cost=(
            "Negative — this is the one measure in the catalogue that pays in "
            "both seasons. The same fabric that keeps summer longwave out keeps "
            "winter heat in."),
        programme=("NYC Accelerator", "Local Law 97 compliance pathway",
                   "NYSERDA Empire Building Challenge"),
        also_consider=("opposite_facade_albedo", "cool_roof"),
        note=("The measure for a trapping-dominated wall. Shading a wall whose "
              "load is longwave from the building opposite does close to nothing, "
              "which is precisely the error the attribution exists to prevent."),
    ),
    "opposite_facade_albedo": _m(
        key="opposite_facade_albedo",
        title="Raise the albedo of the facade opposite",
        family="envelope",
        rank=41,
        lead_time="capital cycle",
        confidence="modelled",
        spec={"wall_albedo": 0.60},
        resolvable=True,
        winter_cost="Negligible: the winter beam on a canyon wall is small.",
        programme=("NYC Accelerator", "Block-scale coordination — this measure "
                   "is on someone else's building"),
        also_consider=("wall_insulation", "street_canopy"),
        note=("The trapping term is longwave from the surfaces opposite, so the "
              "lever is on the other side of the street. The model resolves the "
              "trade-off honestly: a lighter wall opposite runs cooler and "
              "radiates less, but reflects more shortwave across, and both "
              "appear in the re-solve. It is included knowing full well that it "
              "requires an owner who is not the client."),
    ),
    "cool_roof": _m(
        key="cool_roof",
        title="High-albedo roof coating (0.25 to 0.70)",
        family="roof",
        rank=50,
        lead_time="one year",
        confidence="modelled",
        spec={"roof_albedo": 0.70},
        resolvable=True,
        winter_cost=(
            "Small. The winter beam on a horizontal surface at 41° N is weak and "
            "often under snow; the published penalty is a few per cent of the "
            "summer benefit."),
        programme=("NYC °CoolRoofs — free installation for eligible buildings",
                   "Local Law 92/94 sustainable roof requirement"),
        also_consider=("roof_insulation", "street_canopy"),
        note=("Roofs have the highest sky view factor of any surface on the "
              "building and nothing shades them. Almost invisible from the "
              "sidewalk, so it does nothing for pedestrians — it is a top-floor "
              "measure and is described as one."),
    ),
    "roof_insulation": _m(
        key="roof_insulation",
        title="Roof insulation upgrade at the top floor",
        family="roof",
        rank=51,
        lead_time="capital cycle",
        confidence="assumed",
        spec={},
        resolvable=False,
        winter_cost="Negative — it pays in both seasons.",
        programme=("NYC Accelerator", "Local Law 97 compliance pathway"),
        also_consider=("cool_roof",),
        note=("The canyon model solves the outside of the roof, not the assembly "
              "beneath it, so there is no lever here to re-solve. Paired with "
              "the cool roof because coating a poorly insulated deck treats the "
              "symptom the assembly is causing."),
    ),
    "street_canopy": _m(
        key="street_canopy",
        title="Street canopy on the sunlit sidewalk",
        family="canopy",
        rank=60,
        lead_time="one year",
        confidence="modelled",
        spec={"tree_cover": 0.45},
        resolvable=True,
        winter_cost=(
            "Canopy lowers the sky view factor slightly, which slows night-time "
            "radiative cooling year-round; deciduous species return most of the "
            "winter beam. The daytime summer gain dominates decisively and the "
            "model reproduces both signs."),
        programme=("NYC Parks street tree request",
                   "USDA Forest Service i-Tree planning",
                   "Business Improvement District streetscape programme"),
        also_consider=("cool_roof", "opposite_facade_albedo"),
        note=("Planting is a single season; the modelled effect assumes an "
              "established canopy, which is ten to fifteen years away. Both "
              "numbers belong in the schedule and the second one is the one "
              "people forget."),
    ),
    "night_purge": _m(
        key="night_purge",
        title="Night purge ventilation",
        family="ventilation",
        rank=70,
        lead_time="this season",
        confidence="assumed",
        spec={},
        resolvable=False,
        winter_cost="None. Summer operation only.",
        programme=("Building operations",
                   "NYC Accelerator operations and maintenance review"),
        also_consider=("blinds_policy", "wall_insulation"),
        note=("Offered only where the sky term says the fabric can actually shed "
              "its stored heat overnight. Where it cannot, this measure is "
              "worse than useless: it moves warm air through the building all "
              "night and consumes fan energy to do it, and the selection table "
              "excludes it outright rather than caveating it."),
    ),
    "mechanical_capacity": _m(
        key="mechanical_capacity",
        title="Mechanical cooling capacity and distribution review",
        family="mechanical",
        rank=80,
        lead_time="one year",
        confidence="assumed",
        spec={},
        resolvable=False,
        winter_cost="None.",
        programme=("NYC Accelerator", "Utility demand-response enrolment",
                   "Local Law 97 compliance pathway"),
        also_consider=("blinds_policy", "tenant_relocation"),
        note=("Where the surface is essentially at air temperature there is no "
              "facade measure to make: the building is hot because the city is "
              "hot. The remaining levers are mechanical and operational, and "
              "saying so is more useful than prescribing shading that would "
              "recover a fraction of a kelvin."),
    ),
    "tenant_relocation": _m(
        key="tenant_relocation",
        title="Relocate occupants off the worst floors during a heat wave",
        family="operational",
        rank=90,
        lead_time="this season",
        confidence="assumed",
        spec={},
        resolvable=False,
        winter_cost="None.",
        programme=("Building operations", "Tenant heat-emergency protocol"),
        also_consider=("cooling_centre_routing", "blinds_policy"),
        note=("The model identifies the worst floors precisely, which makes this "
              "actionable rather than vague. It is a schedule change, available "
              "this week, and it is the only measure in the catalogue whose lead "
              "time is shorter than a heat wave's forecast horizon."),
    ),
    "cooling_centre_routing": _m(
        key="cooling_centre_routing",
        title="Cooling-centre routing and cooling-assistance referral",
        family="operational",
        rank=91,
        lead_time="this season",
        confidence="assumed",
        spec={},
        resolvable=False,
        winter_cost="None.",
        programme=("NYC Cool Options cooling-centre network",
                   "DOHMH heat emergency plan",
                   "HEAP Cooling Assistance Component (New York State)"),
        also_consider=("tenant_relocation", "mechanical_capacity"),
        note=("For overnight-occupied floors where the fabric cannot recover and "
              "the retrofit is years away. It treats the person rather than the "
              "building, which is the correct target when the exposure is "
              "overnight and the remedy is not."),
    ),
}


# ---------------------------------------------------------- shading geometry


def _wrap180(deg: float) -> float:
    """Signed angle in (-180, 180]."""
    return ((float(deg) + 180.0) % 360.0) - 180.0


def shading_geometry(
    azimuth: float,
    peak_alt: float,
    peak_az: float,
    window_head_m: float = 2.1,
) -> dict:
    """Derive the shading device and its dimension from the sun at the peak hour.

    ``azimuth`` is the outward normal of the wall, degrees clockwise from true
    north. ``peak_alt`` and ``peak_az`` are the solar altitude and azimuth at the
    hour of peak absorbed shortwave for the band being treated — not at solar
    noon, which is a different hour on every facade but the southern one and is
    the classic way to specify a device that fails at 16:00.

    The horizontal overhang follows from the profile angle:

        P = h_window · cos(gamma_sun − gamma_wall) / tan(alpha_sun)

    and the fins from the plan angle, where a beam offset ``dg`` from the wall
    normal is blocked by fins of depth ``d`` at spacing ``s`` when
    ``d >= s / tan|dg|``.

    Both formulas are exact for a continuous device and both diverge, in
    opposite regimes, and the divergences are the point. Returned rather than
    clamped: ``projection_uncapped_m`` always carries what the formula actually
    produced, and ``infeasible_reason`` says which device was rejected and at
    what dimension, so a facade consultant can check the arithmetic instead of
    taking the device name on trust.

    Returns a dict with ``device`` in
    ``{"horizontal", "vertical", "eggcrate", "operable", "glazing"}`` plus the
    dimension that follows and the angles it was derived from.
    """
    alt = float(peak_alt)
    dg = _wrap180(float(peak_az) - float(azimuth))
    abs_dg = abs(dg)
    h = float(window_head_m)

    out: dict[str, Any] = {
        "device": "",
        "projection_m": None,
        "projection_uncapped_m": None,
        "fin_spacing_m": None,
        "fin_depth_m": None,
        "shgc_target": None,
        "window_head_m": round(h, 2),
        "peak_altitude_deg": round(alt, 1),
        "peak_azimuth_deg": round(float(peak_az) % 360.0, 1),
        "wall_azimuth_deg": round(float(azimuth) % 360.0, 1),
        "incidence_deg": round(abs_dg, 1),
        "profile_angle_deg": None,
        "fin_depth_to_spacing": None,
        "cutoff_m": CUTOFF_PROJECTION_M,
        "infeasible_reason": None,
        "alternative_device": None,
    }

    # ---- case 1: no beam on this wall at its own peak hour.
    #
    # Either the sun is down or it is behind the wall plane. The peak absorbed
    # shortwave is then diffuse and inter-reflected, which arrives from the whole
    # visible hemisphere and which no external device of any depth intercepts. A
    # north facade in Manhattan is this case for most of the year, and its only
    # real lever is the glass itself.
    if alt <= _MIN_ALTITUDE_DEG or abs_dg >= 90.0:
        out["device"] = "glazing"
        out["shgc_target"] = 0.25
        out["infeasible_reason"] = (
            f"At this band's peak hour the sun is {alt:.0f}° above the horizon and "
            f"{abs_dg:.0f}° off the wall normal, so the wall takes no direct beam: "
            f"its load is diffuse and inter-reflected shortwave from the whole "
            f"visible hemisphere. No external device intercepts that, at any "
            f"depth. The lever is the glazing's own solar heat gain coefficient."
        )
        out["profile_angle_deg"] = None
        return out

    cos_dg = math.cos(math.radians(abs_dg))
    tan_alt = math.tan(math.radians(alt))
    projection = h * cos_dg / tan_alt
    # Profile angle: the altitude of the beam projected into the plane normal to
    # the wall. tan(profile) = tan(alt) / cos(dg), and P = h / tan(profile).
    profile = math.degrees(math.atan2(tan_alt, cos_dg))
    out["projection_uncapped_m"] = round(projection, 2)
    out["profile_angle_deg"] = round(profile, 1)

    # Required fin depth-to-spacing ratio for the same beam.
    if abs_dg < _MIN_OFFSET_DEG:
        ratio = float("inf")
    else:
        ratio = 1.0 / math.tan(math.radians(abs_dg))
    out["fin_depth_to_spacing"] = (None if math.isinf(ratio) else round(ratio, 2))

    # ---- case 2: a continuous horizontal overhang comes in under the cutoff.
    if projection <= CUTOFF_PROJECTION_M:
        out["device"] = "horizontal"
        out["projection_m"] = round(projection, 2)
        return out

    # ---- case 3: the overhang is too deep, but the beam arrives obliquely
    # enough in plan that fins do the work at a buildable depth-to-spacing ratio.
    if ratio <= FIN_MAX_DEPTH_RATIO:
        spacing = FIN_DEPTH_M / ratio if ratio > 0 else FIN_DEPTH_M
        out["device"] = "vertical"
        out["fin_depth_m"] = round(FIN_DEPTH_M, 2)
        out["fin_spacing_m"] = round(spacing, 2)
        out["infeasible_reason"] = (
            f"A fixed horizontal overhang was rejected: at a profile angle of "
            f"{profile:.0f}° it would need to project {projection:.2f} m, past the "
            f"{CUTOFF_PROJECTION_M:.1f} m this module will specify on a Manhattan "
            f"facade. The beam arrives {abs_dg:.0f}° off the wall normal in plan, "
            f"which vertical fins block at a depth-to-spacing ratio of "
            f"{ratio:.2f} — buildable."
        )
        return out

    # ---- case 4: neither alone, but both together, at modest dimensions.
    if projection <= EGGCRATE_PROJECTION_LIMIT_M and ratio <= 2.0:
        spacing = FIN_DEPTH_M / ratio
        out["device"] = "eggcrate"
        out["projection_m"] = round(CUTOFF_PROJECTION_M, 2)
        out["fin_depth_m"] = round(FIN_DEPTH_M, 2)
        out["fin_spacing_m"] = round(spacing, 2)
        out["infeasible_reason"] = (
            f"A horizontal overhang alone was rejected at {projection:.2f} m, past "
            f"the {CUTOFF_PROJECTION_M:.1f} m cutoff, and fins alone were rejected "
            f"at a depth-to-spacing ratio of {ratio:.2f}, past the "
            f"{FIN_MAX_DEPTH_RATIO:.1f} at which a fin reads as a wall. This is a "
            f"diagonal exposure — {abs_dg:.0f}° off the normal at {alt:.0f}° "
            f"altitude — and the two elements together come in at "
            f"{CUTOFF_PROJECTION_M:.1f} m of overhang and fins at "
            f"{spacing:.2f} m centres."
        )
        return out

    # ---- case 5: the useful negative result.
    #
    # The sun is low AND nearly normal to the glass. This is the east or west
    # facade at its own peak hour, and it is the case where both fixed devices
    # fail for the same underlying reason. Saying which, and at what dimension,
    # is worth more than a device name.
    out["device"] = "operable"
    out["shgc_target"] = 0.25
    out["alternative_device"] = "glazing"
    ratio_txt = ("effectively infinite" if math.isinf(ratio) else f"{ratio:.1f}:1")
    out["infeasible_reason"] = (
        f"No fixed device works on this wall. At its peak hour the sun is only "
        f"{alt:.0f}° above the horizon and just {abs_dg:.0f}° off the wall normal — "
        f"low and nearly square-on at the same time. A horizontal overhang would "
        f"have to project {projection:.2f} m against a {CUTOFF_PROJECTION_M:.1f} m "
        f"cutoff, because tan(altitude) is in the denominator and the altitude is "
        f"small; vertical fins would need a depth-to-spacing ratio of {ratio_txt} "
        f"against a limit of {FIN_MAX_DEPTH_RATIO:.1f}, because the beam is normal "
        f"in plan and there is nothing for a fin to intercept. Both failures have "
        f"one cause and no larger dimension fixes either. The devices that work "
        f"here are operable — retracted outside the two or three hours that matter "
        f"— or a glazing unit with a solar heat gain coefficient at or below 0.25."
    )
    return out


# ------------------------------------------------------- attribution helpers


def _shares(dt_solar: float, dt_trap: float) -> dict[str, float]:
    """Mirror of ``SurfaceTerms.shares``: normalised over the positive drivers.

    The sky term is excluded because it is relief, not a cause, and folding a
    negative number into a share denominator produces percentages that do not
    mean anything.
    """
    a = max(0.0, float(dt_solar))
    b = max(0.0, float(dt_trap))
    tot = a + b
    if tot <= 0.0:
        return {"solar": 0.0, "trap": 0.0}
    return {"solar": a / tot, "trap": b / tot}


def _sun_at(hour_edt: float, ctx: dict) -> tuple[float, float]:
    """Solar altitude and azimuth at a wall-clock EDT hour.

    Three sources, in order: a ``sun_at`` callable on the context (what the
    server passes, backed by the solved hours), a ``sun`` table keyed by integer
    hour (what a test or the pipeline passes), and finally a direct computation
    from ``solar.sun_position`` at the study-area centroid on the study date.
    The fallback is exact solar geometry, not a lookup, so it cannot be wrong in
    kind — only about which day it is, and the context can say.
    """
    fn = ctx.get("sun_at")
    if callable(fn):
        got = fn(hour_edt)
        if got is not None:
            if hasattr(got, "altitude") and hasattr(got, "azimuth"):
                return (float(got.altitude), float(got.azimuth))
            alt, az = got
            return (float(alt), float(az))

    table = ctx.get("sun")
    if isinstance(table, dict):
        got = table.get(int(round(hour_edt)))
        if got is not None:
            if hasattr(got, "altitude") and hasattr(got, "azimuth"):
                return (float(got.altitude), float(got.azimuth))
            alt, az = got
            return (float(alt), float(az))

    y, mo, dy = tuple(ctx.get("date") or _FALLBACK_DATE)
    sp = S.sun_position(
        float(ctx.get("latitude", _FALLBACK_LAT)),
        float(ctx.get("longitude", _FALLBACK_LON)),
        int(y), int(mo), int(dy), float(hour_edt), _EDT_OFFSET,
    )
    return (float(sp.altitude), float(sp.azimuth))


def _rng(value: Any, default: tuple[float, float] = (0.0, 0.0)) -> tuple[float, float]:
    """Coerce a scalar or a pair to an ordered (lo, hi) pair.

    Ranges are never collapsed to a midpoint anywhere in this layer, so a scalar
    arriving from a resolver becomes a degenerate range rather than being carried
    as a bare number that later code would have to special-case.
    """
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return (float(value), float(value))
    a, b = float(value[0]), float(value[1])
    return (a, b) if a <= b else (b, a)


def _fmt_floors(lo: int, hi: int) -> str:
    return f"floor {lo}" if lo == hi else f"floors {lo}–{hi}"


def _fmt_faces(faces: Sequence[str]) -> str:
    fs = list(faces)
    if not fs:
        return "no face"
    if len(fs) == 1:
        return f"the {fs[0]} face"
    return "the " + ", ".join(fs[:-1]) + f" and {fs[-1]} faces"


def _merge_ranges(nums: Sequence[int]) -> list[tuple[int, int]]:
    """Contiguous runs in a sorted list of storey numbers."""
    out: list[tuple[int, int]] = []
    for n in sorted(set(int(x) for x in nums)):
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def _fmt_ranges(runs: Sequence[tuple[int, int]]) -> str:
    parts = [(f"{a}" if a == b else f"{a}–{b}") for a, b in runs]
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


# --------------------------------------------------------------- the picking


@dataclass
class _Pick:
    """One floor's vote for one measure, before contiguous floors are merged."""

    key: str
    faces: tuple[str, ...]
    device: str
    floor: int
    band: int
    geometry: dict
    area_m2: float
    governing_metric: float      # larger wins the merged geometry
    why: tuple[tuple[str, str], ...]   # the reasoning, in labelled parts

    @property
    def why_floor(self) -> str:
        """The same reasoning as one paragraph.

        Kept because two other readers want prose: the analyst's
        ``prescribe_building`` tool, which hands it to a model that would rather
        have sentences than a structure to walk, and the tests, which assert on
        phrases. The brief takes ``why`` and sets each part under its own
        heading, which is the whole reason the parts exist.
        """
        return " ".join(t for _, t in self.why if t).strip()


def _why(*parts: tuple[str, str]) -> tuple[tuple[str, str], ...]:
    """Drop the parts that did not apply, and keep the order they were written in.

    Most branches have one or two parts that are conditional — a device is only
    rejected when a simpler one was tried, a selection is only overridden when
    something overrode it — and the alternative to filtering here is a heading
    with nothing under it.
    """
    return tuple((label, text.strip()) for label, text in parts if text and text.strip())


def _face_attr(fl: Any, name: str, default: float = 0.0) -> float:
    v = getattr(fl, name, None)
    return default if v is None else float(v)


def _int_attr(obj: Any, name: str, default: int = 0) -> int:
    """Integer attribute with a real default.

    Spelt out rather than written ``getattr(x, n, d) or d`` because band 0 is a
    legitimate band — it is the sidewalk — and the idiomatic short form would
    silently turn the ground floor into the default. That bug is the reason this
    helper exists.
    """
    v = getattr(obj, name, None)
    return default if v is None else int(v)


def _treated_faces(fl: Any, term: str) -> list[Any]:
    """The faces worth treating on this floor, by the term that dominates it.

    A floor is not uniformly exposed: a west face carrying 7 K of absorbed
    shortwave and a north face carrying 0.4 K are not the same problem and
    should not be quoted the same measure. Faces are kept when they carry at
    least 60% of the worst face's term and at least 1 K in absolute terms, so a
    building with two comparably loaded faces gets both and one with a single
    hot face is not sold shading it does not need. The 1 K floor is what stops a
    uniformly cool building from generating a prescription for its least-cool
    face.
    """
    faces = list(getattr(fl, "faces", None) or [])
    if not faces:
        return []
    vals = [_face_attr(f, term) for f in faces]
    worst = max(vals)
    if worst <= 0.0:
        return []
    keep = [f for f, v in zip(faces, vals) if v >= max(1.0, 0.6 * worst)]
    # Sorted by compass name, never by a float, so the face list is stable.
    keep.sort(key=lambda f: str(getattr(f, "compass", "")))
    return keep


def _face_area(faces: Iterable[Any]) -> float:
    return round(sum(_face_attr(f, "area_m2") for f in faces), 1)


def _peak_hour(fl: Any, faces: Sequence[Any]) -> int:
    """The hour to size the device at.

    The face's own peak hour where it has one, falling back to the floor's. The
    lowest-numbered hour among tied faces, so the choice cannot depend on list
    order.
    """
    hours = [_int_attr(f, "peak_hour_edt", -1) for f in faces]
    hours = [h for h in hours if h >= 0]
    if hours:
        return min(hours)
    return _int_attr(fl, "peak_hour_edt", 15)


def _picks_for_floor(fl: Any, loads: Any, ctx: dict) -> list[_Pick]:
    """Apply the selection table of section 5 to one floor.

    The table, restated so the code below can be read against it:

        dominant   night recovery    winter sun share   selected
        solar      any               < 0.35             fixed shading, device by orientation
        solar      any               >= 0.35            operable shading, or glazing if WWR > 0.5
        solar      any               any, WWR > 0.5     glazing retrofit ranks first
        trap       none / limited    any                night purge EXCLUDED; insulation, wall opposite
        trap       good              any                night purge ventilation
        ambient    any               any                no facade measure; operational and mechanical

    Every branch also asks whether the exposure is acute rather than chronic, and
    whether capital work is blocked, and adds a measure with a lead time of one
    season if either is true. That is not in the table because it is orthogonal
    to it: it is the difference between what should be done and what can be done
    before August.
    """
    picks: list[_Pick] = []
    dominant = str(getattr(fl, "dominant", "ambient") or "ambient")
    recovery = str(getattr(fl, "night_recovery", "none") or "none")
    floor = _int_attr(fl, "floor")
    band = _int_attr(fl, "band")
    dt_solar = _face_attr(fl, "dt_solar")
    dt_trap = _face_attr(fl, "dt_trap")
    dt_sky = _face_attr(fl, "dt_sky")
    t_surf = _face_attr(fl, "t_surface_peak_c")
    sh = _shares(dt_solar, dt_trap)
    hours = _face_attr(fl, "hours_indoor_over_threshold")
    severity = _int_attr(fl, "severity")

    assembly = getattr(loads, "assembly", None)
    occupancy = getattr(loads, "occupancy", None)
    wwr_hi = float((getattr(assembly, "wwr", (0.3, 0.4)) or (0.3, 0.4))[1])
    overnight = bool(getattr(occupancy, "overnight", False))

    landmark = bool(ctx.get("landmark"))
    capex_blocked = bool(ctx.get("capex_blocked")) or landmark
    acute = hours < ACUTE_HOURS_THRESHOLD and severity >= 3

    # The diagnosis every branch opens with. It answers "how hot, and why", and
    # it is the same three facts each time, so it is its own labelled part rather
    # than the first three sentences of nine different paragraphs.
    attrib = (
        f"{_fmt_floors(floor, floor).capitalize()} sits in band {band} and peaks at "
        f"{t_surf:.1f} °C. The attribution splits that as {dt_solar:.1f} K "
        f"absorbed shortwave and {dt_trap:.1f} K longwave trapped from the "
        f"surfaces opposite ({sh['solar'] * 100:.0f}% solar, "
        f"{sh['trap'] * 100:.0f}% trapping of the positive drivers), against "
        f"{dt_sky:.1f} K of relief to the sky — night recovery \"{recovery}\"."
    )

    # ------------------------------------------------------------- solar
    if dominant == "solar":
        faces = _treated_faces(fl, "dt_solar")
        if faces:
            hour = _peak_hour(fl, faces)
            alt, az = _sun_at(hour, ctx)
            wss = sum(_face_attr(f, "winter_sun_share") for f in faces) / len(faces)

            # The device is derived per face and the faces are grouped by the
            # device they need, because a south face and a west face on the same
            # floor genuinely want different objects bolted to them.
            by_device: dict[str, list[Any]] = {}
            geo_by_device: dict[str, dict] = {}
            for f in faces:
                fh = _int_attr(f, "peak_hour_edt", hour)
                falt, faz = _sun_at(fh, ctx)
                g = shading_geometry(_face_attr(f, "azimuth"), falt, faz)
                g["peak_hour_edt"] = fh
                dev = g["device"]
                by_device.setdefault(dev, []).append(f)
                # Keep the geometry that governs: the deepest projection, or the
                # tightest fin spacing. Ties break on compass name, never a float.
                prev = geo_by_device.get(dev)
                if prev is None or _governing(g) > _governing(prev):
                    geo_by_device[dev] = g

            for dev in sorted(by_device):
                grp = sorted(by_device[dev], key=lambda f: str(getattr(f, "compass", "")))
                gnames = tuple(str(getattr(f, "compass", "")) for f in grp)
                garea = _face_area(grp)
                geo = dict(geo_by_device[dev])

                key = _measure_for_device(dev)
                reason = geo.get("infeasible_reason")

                # Selection table, rows 2 and 3. A curtain wall sends this to
                # glazing whatever the geometry said, and a facade that wants its
                # winter beam sends it to an operable device.
                override = ""
                if wwr_hi > 0.5 and key != "glazing_retrofit":
                    override = (
                        f"The assembly's window-to-wall ratio reaches {wwr_hi:.2f}, "
                        f"so the glass is the wall: an external device would be "
                        f"hung off a spandrel that is a minority of the elevation. "
                        f"The glazing retrofit takes precedence over the "
                        f"{MEASURES[key].title.lower()} the geometry alone selected."
                    )
                    key, dev = "glazing_retrofit", "glazing"
                elif wss >= 0.35 and key.startswith("fixed_shading"):
                    override = (
                        f"{wss * 100:.0f}% of this face's annual sun arrives in the "
                        f"heating season, above the 35% at which a fixed device "
                        f"costs more in January than it saves in July. The "
                        f"{MEASURES[key].title.lower()} the geometry selected is "
                        f"replaced by an operable one that retracts."
                    )
                    key, dev = "operable_shading", "operable"
                elif landmark and key.startswith("fixed_shading"):
                    override = (
                        "The facade is landmarked or contextual, so no external "
                        "fixed device will be permitted; the measure moves inside "
                        "the glass line and loses roughly half its effect, which "
                        "is stated rather than absorbed."
                    )
                    key, dev = "window_film", "film"

                sun = (
                    f"{_fmt_faces(gnames).capitalize()} "
                    f"carr{'ies' if len(gnames) == 1 else 'y'} the load. "
                    f"At the peak hour ({geo.get('peak_hour_edt', hour)}:00 EDT) the "
                    f"sun is {geo['peak_altitude_deg']:.0f}° above the horizon and "
                    f"{geo['incidence_deg']:.0f}° off the wall normal"
                )
                if geo.get("profile_angle_deg") is not None:
                    sun += f", a profile angle of {geo['profile_angle_deg']:.0f}°"
                sun += "."

                sizing = ""
                if geo.get("projection_uncapped_m") is not None:
                    sizing = (
                        f"P = {geo['window_head_m']:.2f} m · "
                        f"cos({geo['incidence_deg']:.0f}°) / "
                        f"tan({geo['peak_altitude_deg']:.0f}°) = "
                        f"{geo['projection_uncapped_m']:.2f} m."
                    )

                picks.append(_Pick(
                    key=key, faces=gnames, device=dev, floor=floor, band=band,
                    geometry=geo, area_m2=garea,
                    governing_metric=_governing(geo),
                    why=_why(
                        ("Where the heat is", attrib),
                        ("What carries it", sun),
                        ("Sizing", sizing),
                        ("Why not something simpler", reason or ""),
                        ("Why this device", override),
                    ),
                ))

        # The measure that can happen before the next heat wave.
        if faces and (acute or capex_blocked):
            names = tuple(sorted(str(getattr(f, "compass", "")) for f in faces))
            trigger = (
                "capital work on this facade is blocked"
                if capex_blocked else
                f"the exposure is acute rather than chronic — "
                f"{hours:.0f} free-running hours above 28 °C a year at severity "
                f"{severity}, concentrated in a handful of events"
            )
            picks.append(_Pick(
                key="blinds_policy", faces=names, device="internal",
                floor=floor, band=band, geometry={}, area_m2=_face_area(faces),
                governing_metric=0.0,
                why=_why(
                    ("Where the heat is", attrib),
                    ("Why now", (
                        f"Every facade measure above answers \"not before the next "
                        f"heat wave\", and {trigger}. A managed closure schedule on "
                        f"{_fmt_faces(names)} is available this season."
                    )),
                    ("What it will and will not do", (
                        f"It acts inside the glass line, so it controls glare and "
                        f"radiant asymmetry well and the {dt_solar:.1f} K of absorbed "
                        f"shortwave poorly — perhaps a third of what an external "
                        f"device would take. It is offered because a third, this "
                        f"year, is not nothing."
                    )),
                ),
            ))

    # -------------------------------------------------------------- trap
    elif dominant == "trap":
        faces = _treated_faces(fl, "dt_trap")
        names = tuple(str(getattr(f, "compass", "")) for f in faces) or ("all",)
        area = _face_area(faces) or _face_attr(fl, "envelope_m2")

        if recovery == "good":
            picks.append(_Pick(
                key="night_purge", faces=names, device="operational",
                floor=floor, band=band, geometry={}, area_m2=area,
                governing_metric=0.0,
                why=_why(
                    ("Where the heat is", attrib),
                    ("The mechanism", (
                        f"The load is trapping, not sun: {dt_trap:.1f} K of the "
                        f"positive drivers is longwave from the surfaces opposite "
                        f"({sh['trap'] * 100:.0f}%), which shading cannot intercept "
                        f"because it is not a beam."
                    )),
                    ("Why purge works here", (
                        f"The sky term is {dt_sky:.1f} K and the night recovery reads "
                        f"\"good\", so this fabric can actually shed its stored heat "
                        f"overnight — which is the one condition under which purge "
                        f"ventilation is worth running."
                    )),
                ),
            ))
        else:
            excluded = (
                f"Night purge ventilation is excluded here, explicitly. The sky "
                f"term is only {dt_sky:.1f} K and the night recovery reads "
                f"\"{recovery}\": this surface cannot radiate to the sky, so there "
                f"is no cool night air to purge with and the measure would move "
                f"warm air through the building for a whole night and spend fan "
                f"energy doing it."
            )
            picks.append(_Pick(
                key="wall_insulation", faces=names, device="fabric",
                floor=floor, band=band, geometry={}, area_m2=area,
                governing_metric=0.0,
                why=_why(
                    ("Where the heat is", attrib),
                    ("The mechanism", (
                        f"{dt_trap:.1f} K of the {dt_solar + dt_trap:.1f} K of "
                        f"positive driver is longwave arriving from the buildings "
                        f"opposite ({sh['trap'] * 100:.0f}%), against {dt_solar:.1f} K "
                        f"of sun. Shading this wall would treat the smaller term: "
                        f"the lever is the fabric's own admittance, which governs "
                        f"how much of that net radiation it absorbs rather than sheds."
                    )),
                    ("Why not night purge", excluded),
                ),
            ))
            picks.append(_Pick(
                key="opposite_facade_albedo", faces=names, device="fabric",
                floor=floor, band=band, geometry={}, area_m2=area,
                governing_metric=0.0,
                why=_why(
                    ("Where the heat is", attrib),
                    ("The mechanism", (
                        f"The {dt_trap:.1f} K trapping term is radiated by a surface "
                        f"this owner does not own. Raising the albedo of the facade "
                        f"opposite lowers what it runs at and therefore what it "
                        f"radiates across. The model re-solves both sides, so the "
                        f"reflected-shortwave penalty that partly offsets it is in "
                        f"the answer rather than in a footnote."
                    )),
                    ("Why not night purge", excluded),
                ),
            ))
            if overnight:
                picks.append(_Pick(
                    key="cooling_centre_routing", faces=names, device="people",
                    floor=floor, band=band, geometry={}, area_m2=area,
                    governing_metric=0.0,
                    why=_why(
                        ("Where the heat is", attrib),
                        ("Why now", (
                            f"People sleep behind this wall and the geometry "
                            f"precludes the overnight recovery they would need — a "
                            f"{dt_sky:.1f} K sky term is not a recovery window. The "
                            f"fabric measure above is a capital-cycle answer to an "
                            f"overnight exposure that exists now."
                        )),
                    ),
                ))

    # ----------------------------------------------------------- ambient
    else:
        names = ("all",)
        area = _face_attr(fl, "envelope_m2")
        no_facade = (
            "The surface is within 1.5 K of air temperature, so neither driver is "
            "worth naming and there is no facade measure to make: this floor is hot "
            "because the city is hot. Prescribing shading here would recover a "
            "fraction of a kelvin and cost a facade contract."
        )
        picks.append(_Pick(
            key="mechanical_capacity", faces=names, device="mechanical",
            floor=floor, band=band, geometry={}, area_m2=area,
            governing_metric=0.0,
            why=_why(("Where the heat is", attrib),
                     ("Why there is nothing to bolt on", no_facade)),
        ))
        if severity >= 3:
            key = "cooling_centre_routing" if overnight else "tenant_relocation"
            picks.append(_Pick(
                key=key, faces=names, device="people",
                floor=floor, band=band, geometry={}, area_m2=area,
                governing_metric=0.0,
                why=_why(
                    ("Where the heat is", attrib),
                    ("Why there is nothing to bolt on", no_facade),
                    ("Why now", (
                        f"Severity {severity} with {hours:.0f} free-running hours "
                        f"above 28 °C a year, and the mechanical review above is a "
                        f"one-year answer. This one is available this season."
                    )),
                ),
            ))

    return picks


def _governing(geo: dict) -> float:
    """Which of two geometries for the same device governs the merged range.

    The deepest projection, or where there is none the tightest fin spacing
    expressed as a negative so larger still means more demanding. A device sized
    on the least-demanding band would be undersized on the rest of the range,
    which is the whole reason merged prescriptions carry one governing geometry
    rather than an average.
    """
    p = geo.get("projection_uncapped_m")
    if p is not None:
        return float(p)
    s = geo.get("fin_spacing_m")
    if s is not None:
        return -float(s)
    return 0.0


def _measure_for_device(device: str) -> str:
    return {
        "horizontal": "fixed_shading_horizontal",
        "vertical": "fixed_shading_vertical",
        "eggcrate": "fixed_shading_eggcrate",
        "operable": "operable_shading",
        "glazing": "glazing_retrofit",
    }[device]


# ----------------------------------------------------- building-wide picks


def _roof_picks(loads: Any, ctx: dict, floors: Sequence[Any]) -> list[_Pick]:
    """Roof measures, on height, top-floor share and roof area.

    A roof is one surface serving one band, so unlike a facade measure this one
    is stated once for the building with its floor range set to the storeys the
    top band actually contains. The top-floor share is what makes the measure
    worth or not worth doing: a 4-storey walk-up puts a quarter of its floor
    area under the roof and a 40-storey tower puts a fortieth, and the same
    coating buys wildly different things.
    """
    if not floors:
        return []
    height = float(ctx.get("height_m", 0.0) or 0.0)
    if height <= 0.0:
        height = max(float(getattr(f, "z_hi", 0.0) or 0.0) for f in floors)
    roof = getattr(loads, "roof", None)
    area = ctx.get("roof_area_m2")
    if area is None:
        area = getattr(roof, "area_m2", None)
    if area is None:
        return []
    area = float(area)

    top = max(floors, key=lambda f: _int_attr(f, "floor"))
    top_band = _int_attr(top, "band")
    in_band = [_int_attr(f, "floor") for f in floors
               if _int_attr(f, "band") == top_band]
    n_floors = len(floors)
    share = (len(in_band) / n_floors) if n_floors else 0.0

    if height < ROOF_MIN_HEIGHT_M or area < ROOF_MIN_AREA_M2:
        return []

    lo, hi = min(in_band), max(in_band)
    t_roof = float(getattr(roof, "t_peak_c", 0.0) or 0.0)
    roof_txt = f" The roof peaks at {t_roof:.0f} °C." if t_roof else ""
    reach = (
        f"Building height {height:.0f} m with {area:,.0f} m² of roof, and the top "
        f"band holds {len(in_band)} of {n_floors} storeys — {share * 100:.0f}% of "
        f"the floor area sits directly under it.{roof_txt}"
    )
    mech = (
        "A roof has the highest sky view factor of any surface on the building and "
        "nothing shades it, so it takes the full solar load; raising albedo from a "
        "typical 0.25 to 0.70 removes most of the absorbed shortwave at the one "
        "surface where nothing else can."
    )
    why = _why(("What sits under it", reach), ("The mechanism", mech))
    out = [_Pick(key="cool_roof", faces=("roof",), device="coating",
                 floor=lo, band=top_band, geometry={"albedo_target": 0.70},
                 area_m2=round(area, 1), governing_metric=0.0, why=why)]
    # A coating over a poor deck treats the symptom the assembly is causing, so
    # the insulation measure is raised alongside it wherever the top floor is
    # actually in trouble.
    if _int_attr(top, "severity") >= 3:
        out.append(_Pick(
            key="roof_insulation", faces=("roof",), device="fabric",
            floor=lo, band=top_band, geometry={}, area_m2=round(area, 1),
            governing_metric=0.0,
            why=why + _why(("Why the coating is not enough", (
                f"The top storey is at severity {_int_attr(top, 'severity')}, which "
                f"a coating alone will not clear: the coating lowers the surface the "
                f"deck sees, the deck decides how much of that reaches the floor "
                f"below."
            ))),
        ))
    # Merging expects one pick per floor; extend the range explicitly.
    for p in out:
        p.geometry = dict(p.geometry)
        p.geometry["floor_range"] = [lo, hi]
    return out


def _canopy_picks(loads: Any, ctx: dict, floors: Sequence[Any]) -> list[_Pick]:
    """Street canopy, which reaches bands 0 and 1 and no further.

    The band limit is the whole content of this prescription. A street tree is a
    pedestrian and ground-floor measure; a schedule that lists it against a
    building whose problem is on floor 19 and says nothing about its reach is
    implying, by silence, that it helps. It does not, and the ``does_not_fix``
    field says so in the same breath as the measure is offered.
    """
    ground = [f for f in floors if _int_attr(f, "band", 99) <= CANOPY_TOP_BAND]
    if not ground:
        return []
    solar_ground = [f for f in ground
                    if str(getattr(f, "dominant", "")) == "solar"
                    or _face_attr(f, "dt_solar") >= 2.0]
    mrt = ctx.get("mrt_peak_c")
    air = ctx.get("peak_air_c")
    radiant_gap = (float(mrt) - float(air)) if (mrt is not None and air is not None) else None
    if not solar_ground and not (radiant_gap is not None and radiant_gap > 12.0):
        return []

    nums = [_int_attr(f, "floor") for f in ground]
    lo, hi = min(nums), max(nums)
    n_floors = len(floors)
    top_floor = max(_int_attr(f, "floor") for f in floors)
    gap_txt = ""
    if radiant_gap is not None:
        gap_txt = (
            f" Pedestrian mean radiant temperature at the base peaks "
            f"{float(mrt):.0f} °C, {radiant_gap:.0f} K above the air temperature, "
            f"and canopy acts on the radiant term directly — which is the term "
            f"that dominates what a person on the sidewalk feels."
        )
    why = _why(
        ("What it reaches", (
            f"Bands 0–{CANOPY_TOP_BAND} of the ten solved bands — "
            f"{_fmt_floors(lo, hi)} of {top_floor} — sit within reach of a street "
            f"canopy, and {len(solar_ground)} of those {len(ground)} storeys are "
            f"solar-dominant at the sidewalk.{gap_txt}"
        )),
        ("What it does not reach", (
            f"This measure reaches band {CANOPY_TOP_BAND} and no further: a mature "
            f"London plane in Midtown is 12 to 15 m to the crown against a building "
            f"of {top_floor} storeys, so it does nothing whatever for the floors "
            f"above it. That is stated here rather than left to be inferred from a "
            f"measure list that happens not to mention it."
        )),
    )
    p = _Pick(key="street_canopy", faces=("sidewalk",), device="canopy",
              floor=lo, band=0, geometry={"canopy_fraction": 0.45,
                                          "bands": [0, CANOPY_TOP_BAND],
                                          "floor_range": [lo, hi]},
              area_m2=round(sum(_face_attr(f, "envelope_m2") for f in ground), 1),
              governing_metric=0.0, why=why)
    return [p]


# ------------------------------------------------------------------ merging


def _merge(picks: Sequence[_Pick]) -> list[dict]:
    """Merge contiguous floors that voted for the same measure on the same faces.

    A twenty-six storey tower whose floors 8 to 19 all want a 1.1 m overhang on
    the west face should produce one prescription for floors 8-19, not twelve
    identical ones. Floors are merged only when the measure key, the face list
    and the device all match exactly and the storey numbers are contiguous; a
    gap in the middle produces two prescriptions, which is correct, because a
    facade contract that skips four floors is a different contract.

    The merged geometry is the governing floor's — the most demanding, not the
    average — because a device sized on the average band is undersized on half
    the range it is fitted to.
    """
    by_key: dict[tuple[str, tuple[str, ...], str], list[_Pick]] = {}
    for p in picks:
        by_key.setdefault((p.key, p.faces, p.device), []).append(p)

    out: list[dict] = []
    for sig in sorted(by_key):
        group = sorted(by_key[sig], key=lambda p: p.floor)
        # An explicit floor_range on the geometry (roof, canopy) overrides the
        # contiguity walk: those measures were picked once for a range already.
        explicit = group[0].geometry.get("floor_range")
        runs: list[list[_Pick]] = []
        if explicit:
            runs = [group]
        else:
            for p in group:
                if runs and p.floor == runs[-1][-1].floor + 1:
                    runs[-1].append(p)
                else:
                    runs.append([p])
        for run in runs:
            if explicit:
                lo, hi = int(explicit[0]), int(explicit[1])
            else:
                lo, hi = run[0].floor, run[-1].floor
            bands = sorted(p.band for p in run)
            # The governing floor: most demanding geometry, ties to the lowest
            # storey number so the choice never rests on a float comparison.
            gov = min(run, key=lambda p: (-p.governing_metric, p.floor))
            out.append({
                "key": sig[0], "faces": list(sig[1]), "device": sig[2],
                "floors": (lo, hi), "bands": (bands[0], bands[-1]),
                "geometry": dict(gov.geometry),
                "area_m2": round(sum(p.area_m2 for p in run), 1),
                "why": gov.why_floor,
                "why_parts": [list(x) for x in gov.why],
                "n_floors": len(run),
                "gov_floor": gov.floor,
            })
    return out


# ------------------------------------------------------------ does_not_fix


def _fill_does_not_fix(out: Sequence[Prescription], floors: Sequence[Any]) -> None:
    """State what each measure leaves alone, and what covers it.

    This field exists because the most damaging thing a measure schedule can do
    is imply completeness. A west-facade overhang on floors 8-19 is a good
    measure and it does nothing for floors 1-7, nothing for the east elevation,
    and nothing at all for the roof. Silence on those points reads as coverage.
    Every prescription therefore names the storeys outside its range and the
    other prescription that reaches them, or says plainly that nothing in this
    schedule does — which is a finding in its own right and is the sentence a
    reviewer should be looking for.
    """
    all_floors = sorted(_int_attr(f, "floor") for f in floors)
    if not all_floors:
        for p in out:
            p.does_not_fix = (
                "No floor schedule was supplied, so the untreated extent cannot be "
                "stated. Treat this prescription as covering only the faces named."
            )
        return

    all_faces: list[str] = sorted({
        str(getattr(fc, "compass", ""))
        for f in floors for fc in (getattr(f, "faces", None) or [])
        if str(getattr(fc, "compass", ""))
    })

    for p in out:
        lo, hi = p.floors
        outside = [n for n in all_floors if n < lo or n > hi]
        parts: list[str] = []

        if outside:
            runs = _merge_ranges(outside)
            covered: list[str] = []
            uncovered: list[int] = []
            for a, b in runs:
                others = sorted(
                    {q.title for q in out
                     if q is not p and q.floors[0] <= a and q.floors[1] >= b}
                )
                if others:
                    label = f"{a}" if a == b else f"{a}–{b}"
                    covered.append(f"floors {label} by {others[0].lower()}")
                else:
                    uncovered.extend(range(a, b + 1))
            parts.append(
                f"It does not reach {_fmt_ranges(runs)} of "
                f"{all_floors[0]}–{all_floors[-1]}."
            )
            if covered:
                parts.append("Those are covered by " + "; ".join(covered) + ".")
            if uncovered:
                parts.append(
                    f"Nothing in this schedule reaches floor"
                    f"{'s' if len(uncovered) > 1 else ''} "
                    f"{_fmt_ranges(_merge_ranges(uncovered))}."
                )
        else:
            parts.append(
                f"It covers every storey ({all_floors[0]}–{all_floors[-1]}), so "
                f"no floor is left out by extent."
            )

        untreated = [f for f in all_faces if f not in p.faces]
        if p.key == "street_canopy":
            parts.append(
                f"Its reach is bands 0–{CANOPY_TOP_BAND} and no further, which is "
                f"a statement about the measure and not about this building."
            )
        if untreated and p.faces and p.faces[0] not in ("all", "roof", "sidewalk"):
            parts.append(
                f"On the treated storeys it leaves the "
                f"{', '.join(untreated)} elevation"
                f"{'s' if len(untreated) > 1 else ''} at full load."
            )
        if p.family != "roof":
            parts.append("It does nothing for the roof.")

        p.does_not_fix = " ".join(parts)


# ---------------------------------------------------------------- the effect


def _floor_span(loads: Any, lo: int, hi: int) -> list[Any]:
    return [f for f in (getattr(loads, "floors", None) or [])
            if lo <= _int_attr(f, "floor") <= hi]


def _derive_energy(loads: Any, p: Prescription, d_facade_k: float) -> tuple[
        tuple[float, float], tuple[float, float], float, list[str]]:
    """First-order energy interpretation of a re-solved facade delta.

    Used only for the figures the resolver did not report itself. The
    conduction term through an opaque wall is ``U·A·(T_surface − T_indoor)``, so
    it is linear in the driving temperature difference and a facade delta of
    ``dT`` removes ``dT / (T_surface − T_setpoint)`` of it. That linearity is
    exact for conduction and approximate for the transmitted-solar and
    ventilation terms the same load carries, which is why anything derived here
    drops the prescription's confidence to "assumed" and is named in
    ``effect_note``. It is not a substitute for the resolver reporting energy;
    it is what keeps a prescription useful when it does not.
    """
    notes: list[str] = []
    span = _floor_span(loads, p.floors[0], p.floors[1])
    if not span or d_facade_k == 0.0:
        return ((0.0, 0.0), (0.0, 0.0), 0.0, notes)

    occ = getattr(loads, "occupancy", None)
    setpoint = float(getattr(occ, "setpoint_c", 24.0) or 24.0)

    kwh_lo = kwh_hi = kw_lo = kw_hi = 0.0
    ph = 0.0
    for fl in span:
        t_surf = _face_attr(fl, "t_surface_peak_c")
        drive = max(1.0, t_surf - setpoint)
        frac = min(1.0, abs(float(d_facade_k)) / drive)
        sign = -1.0 if d_facade_k < 0 else 1.0
        a_lo, a_hi = _rng(getattr(fl, "annual_kwh", None))
        w_lo, w_hi = _rng(getattr(fl, "peak_w", None))
        kwh_lo += sign * frac * a_lo
        kwh_hi += sign * frac * a_hi
        kw_lo += sign * frac * w_lo / 1000.0
        kw_hi += sign * frac * w_hi / 1000.0
        ph += sign * frac * _face_attr(fl, "person_hours")

    notes.append(
        "Energy and person-hours are a first-order linear scaling of this "
        "building's own load by the re-solved facade delta over the driving "
        "temperature difference, not a second re-solve; the facade kelvin figure "
        "is the model's own answer and the rest is interpretation."
    )
    return (
        tuple(sorted((round(kwh_lo, 1), round(kwh_hi, 1)))),
        tuple(sorted((round(kw_lo, 3), round(kw_hi, 3)))),
        round(ph, 1),
        notes,
    )


def _attach_effect(p: Prescription, loads: Any, resolve, ctx: dict) -> None:
    """Ask the caller's resolver what this measure does, and interpret the answer.

    Four outcomes, all of them stated rather than papered over: no resolver, a
    measure with no lever the physics can be asked about, a resolver that
    raised, and an answer.
    """
    fam = MEASURES[p.key]

    if not fam.resolvable:
        p.effect = None
        p.effect_note = (
            f"No effect figure. {fam.title} does not change anything outside the "
            f"envelope, so the canyon surface-energy-balance model has no lever to "
            f"re-solve and there is nothing for it to answer. Its benefit is real "
            f"and falls on occupant exposure or on plant, neither of which this "
            f"model resolves. A coefficient could be quoted here and deliberately "
            f"is not."
        )
        return

    if resolve is None:
        p.effect = None
        p.effect_note = (
            "No effect figure: no resolver was supplied to for_building(), so "
            "nothing has been re-solved. Every stated effect in this layer comes "
            "from re-running the physics with the measure applied, and this module "
            "will not substitute a published coefficient for one. Pass "
            "resolve=scenarios.run_scenario closure (pipeline) or the live "
            "intervention engine (server) to fill it."
        )
        return

    request = {
        "bin": str(getattr(loads, "bin", "") or ""),
        "measure": p.key,
        "family": p.family,
        "spec": dict(fam.spec),
        "faces": list(p.faces),
        "azimuths": _azimuths_for(loads, p),
        "floors": tuple(p.floors),
        "bands": tuple(p.bands),
        "area_m2": p.area_m2,
        "periods": ["summer", "winter", "year"],
    }

    try:
        result = resolve(request)
    except Exception as exc:  # a broken re-solve costs one number, not the schedule
        p.effect = None
        p.effect_note = (
            f"No effect figure: the resolver raised "
            f"{type(exc).__name__}: {exc}. The prescription itself does not depend "
            f"on the re-solve — the measure was selected by the attribution — so it "
            f"is carried without an effect rather than dropped."
        )
        return

    if not result:
        p.effect = None
        p.effect_note = (
            "No effect figure: the resolver returned nothing for this measure. "
            "Most often that means the selection reached no solved canyon — a "
            "building on an interior lot line with no canyon cross-section through "
            "it — and the honest answer is that the model cannot say."
        )
        return

    d_facade = float(result.get("d_facade_peak_k", 0.0) or 0.0)
    notes: list[str] = []
    if result.get("note"):
        notes.append(str(result["note"]))

    have_kwh = "d_annual_kwh" in result and result["d_annual_kwh"] is not None
    have_kw = "d_peak_kw" in result and result["d_peak_kw"] is not None
    have_ph = "d_person_hours" in result and result["d_person_hours"] is not None

    d_kwh = d_kw = None
    d_ph = None
    if not (have_kwh and have_kw and have_ph):
        d_kwh, d_kw, d_ph, dnotes = _derive_energy(loads, p, d_facade)
        notes.extend(dnotes)
        p.confidence = "assumed"

    seasonal_in = result.get("seasonal") or {}
    seasonal = {k: float(v) for k, v in sorted(seasonal_in.items())
                if isinstance(v, (int, float))}
    seasonal.setdefault("summer_d_facade_k", d_facade)

    eff_kwh = _rng(result["d_annual_kwh"]) if have_kwh else d_kwh

    winter = result.get("d_winter_kwh")
    if winter is None:
        # A shading measure that removes July's beam removes January's. Where the
        # resolver did not price the winter side, the sign is stated as unknown
        # rather than assumed to be zero, which would read as "no penalty".
        w_facade = seasonal.get("winter_d_facade_k")
        if w_facade is not None and eff_kwh is not None:
            share = abs(w_facade) / max(1e-6, abs(d_facade)) if d_facade else 0.0
            winter = (abs(eff_kwh[0]) * share * 0.5, abs(eff_kwh[1]) * share * 0.5)
            notes.append(
                "The winter heating penalty is inferred from the re-solved winter "
                "facade delta at half the summer coefficient; it is the least "
                "certain figure on this prescription."
            )
        else:
            winter = (0.0, 0.0)
            notes.append(
                "No winter figure was returned and none is inferred: the heating "
                "penalty of this measure is unquantified here, not zero."
            )

    p.effect = Effect(
        d_facade_peak_k=round(d_facade, 3),
        d_annual_kwh=eff_kwh,
        d_peak_kw=_rng(result["d_peak_kw"]) if have_kw else d_kw,
        d_person_hours=(round(float(result["d_person_hours"]), 1) if have_ph else d_ph),
        d_winter_kwh=_rng(winter),
        seasonal=seasonal,
        source="re-solved",
    )
    p.effect_note = " ".join(notes)


def _azimuths_for(loads: Any, p: Prescription) -> list[float]:
    """The azimuths behind the compass names, for the resolver's selection."""
    want = set(p.faces)
    seen: dict[str, float] = {}
    for fl in _floor_span(loads, p.floors[0], p.floors[1]):
        for fc in (getattr(fl, "faces", None) or []):
            name = str(getattr(fc, "compass", ""))
            if name in want and name not in seen:
                seen[name] = round(_face_attr(fc, "azimuth"), 1)
    return [seen[k] for k in sorted(seen)]


# ------------------------------------------------------------------ the API


def for_building(
    loads: "BuildingLoads",
    *,
    resolve: Callable[[dict], dict | None] | None = None,
    context: dict | None = None,
) -> list[Prescription]:
    """The measure schedule for one building.

    ``loads`` is a ``BuildingLoads`` from ``heatcanyon.loads``, or anything with
    the same attributes — this function reads them, it does not import the class,
    which is what lets it be tested against synthetic fixtures.

    ``resolve`` is documented in full in the module docstring. ``None`` is
    supported: every prescription comes back complete except ``effect``, which is
    ``None`` with the reason in ``effect_note``.

    ``context`` is optional and every key has a default:

        latitude, longitude, date      for the solar fallback; Midtown and the
                                       study date if absent
        sun_at(hour) -> (alt, az)      the preferred source of solar position
        sun {hour: (alt, az)}          a table, if a callable is inconvenient
        height_m, roof_area_m2         for the roof trigger
        mrt_peak_c, peak_air_c         for the canopy trigger
        landmark: bool                 a landmarked or contextual facade, which
                                       blocks external fixed devices
        capex_blocked: bool            capital work is unavailable; the schedule
                                       leans on measures with a one-season lead

    The returned list is sorted by ``(rank, first floor, last floor, device,
    faces, key)`` and contains no floats in its ordering, so it is byte-identical
    across runs on identical input.
    """
    ctx = dict(context or {})
    floors = sorted((getattr(loads, "floors", None) or []),
                    key=lambda f: _int_attr(f, "floor"))

    picks: list[_Pick] = []
    for fl in floors:
        picks.extend(_picks_for_floor(fl, loads, ctx))
    picks.extend(_roof_picks(loads, ctx, floors))
    picks.extend(_canopy_picks(loads, ctx, floors))

    out: list[Prescription] = []
    for g in _merge(picks):
        fam = MEASURES[g["key"]]
        out.append(Prescription(
            key=fam.key,
            title=fam.title,
            family=fam.family,
            faces=list(g["faces"]),
            floors=g["floors"],
            bands=g["bands"],
            device=g["device"],
            geometry=g["geometry"],
            area_m2=g["area_m2"],
            why=g["why"],
            why_parts=[tuple(x) for x in g.get("why_parts", [])],
            winter_cost=fam.winter_cost,
            programme=list(fam.programme),
            does_not_fix="",
            also_consider=list(fam.also_consider),
            confidence=fam.confidence,
            lead_time=fam.lead_time,
        ))

    out.sort(key=lambda p: (MEASURES[p.key].rank, p.floors[0], p.floors[1],
                            p.device, ",".join(p.faces), p.key))

    _fill_does_not_fix(out, floors)
    for p in out:
        _attach_effect(p, loads, resolve, ctx)
    return out


def catalogue() -> list[dict]:
    """The measure catalogue as plain data, for ``/api/prescribe`` and for docs."""
    return [
        {
            "key": m.key, "title": m.title, "family": m.family, "rank": m.rank,
            "lead_time": m.lead_time, "confidence": m.confidence,
            "spec": dict(m.spec), "resolvable": m.resolvable,
            "winter_cost": m.winter_cost, "programme": list(m.programme),
            "also_consider": list(m.also_consider), "note": m.note,
        }
        for m in sorted(MEASURES.values(), key=lambda m: (m.rank, m.key))
    ]

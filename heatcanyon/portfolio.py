"""The programme: a budget, an ordering, and the disagreement between orderings.

Nobody spends money one building at a time. The platform ranks 150 buildings out
of 4,044 scored and stops there, which is a list rather than a plan: it says
where the heat is, not where the next two million dollars should go, not what
can start this summer against what waits for a capital cycle, and not what the
whole thing buys. This module closes that gap. It takes a flat list of
``Candidate`` rows — one per *(building x measure)* pair, priced by
``economics.price`` and specified by ``prescribe.for_building`` — and turns them
into a programme under a budget.

WHY THE DISAGREEMENT IS THE OUTPUT

``compare_objectives`` is the function this module exists for. Four objectives
are already implemented in the analyst (``agent/analysis.allocate``), a fifth —
``carbon`` — exists only here for a reason given below, and each produces a
defensible ranking. The value is not in any one of them. It is in the
fact that they *differ*, and that choosing between them is a political act which
the platform currently performs implicitly, by whichever ordering the interface
happens to render first.

Rank by avoided person-hours per dollar and the money flows to large, dense,
cheap-to-treat buildings. Weight the same person-hours by the Heat Vulnerability
Index and it flows towards residents least able to cope, buying fewer avoided
hours per dollar to buy them for people with fewer alternatives. Rank by tonnes
and it flows somewhere else again, towards the fabric of buildings that burn gas
all winter, and buys nobody any relief in August at all. All three answers are
correct; they answer different questions. So the module returns the overlap at
the budget line, the buildings that appear under one objective and not the other,
and how far each moved — and states in prose that the reader is choosing, rather
than presenting one column as the answer.

This is the same stance ``pipeline.py`` already takes when it publishes the
disagreement between the heat-wave ordering and the annual ordering instead of
smoothing it away.

WHY THE OBJECTIVES ARE NOT REDEFINED HERE

``agent/analysis.allocate`` already defines what ``person_hours``,
``degree_hours``, ``vulnerable`` and ``peak_relief`` mean. Two modules with two
definitions of "vulnerable" would be a bug that never raises an exception, so the
definitions in ``OBJECTIVES`` below are stated as the same arithmetic on the same
quantities — in particular ``vulnerable`` is person-hours scaled by ``hvi / 5``,
character for character the analyst's ``avoided * units * (hvi or 1) / 5`` once
you substitute ``person_hours = avoided * units``. ``tests/test_portfolio.py``
holds a cross-check that runs the analyst's own ``allocate`` over equivalent rows
and asserts the two agree on the ordering, so a change to one that is not made to
the other fails a test rather than quietly producing a different politics.

``carbon`` IS THE EXCEPTION, AND ON PURPOSE

There are five objectives here and four in the analyst. That asymmetry is not the
drift the paragraph above warns about, and the reason is structural rather than a
matter of taste: ``agent/analysis.allocate`` scores BUILDINGS out of ``ranked``,
from ``facade_kh35``, ``hours_above_35``, ``units``, ``hvi`` and
``facade_peak_c``, against an assumed ``per_unit_effect_k`` that the caller
supplies. Every one of its four objectives is computable from a building's own
attributes. Tonnes of CO2e avoided is not: it is a property of a MEASURE on a
building, it comes from ``economics.price``, and nothing in the analyst's
building-level view carries it. So ``carbon`` cannot be mirrored there without
first giving that function a priced candidate, at which point it would be this
function.

The cross-check accordingly runs over the objectives the two share and does not
enumerate ``OBJECTIVES``. If you add a sixth that IS computable from building
attributes, it belongs in both and in that test.

WHY THE MONEY IS A RANGE AND THE PROVENANCE IS "assumed"

Every capex band, tariff and household size in this layer came from an assumption
table that no measurement in this study constrains. Following the contract in
``docs/DECISIONS.md``, nothing here collapses a range to its midpoint and every
figure that passed through such a table carries ``basis`` containing "assumed".
A dollar figure is the easiest number in the system to over-trust, and the
credibility of the project rests on the label being exact.

WHAT THIS MODULE DOES NOT DO

It does not re-solve physics, price anything, or choose a measure. It consumes
``Candidate`` rows and orders them. If a benefit figure is wrong, it is wrong
upstream in ``prescribe`` or ``loads``; this module will faithfully allocate a
budget against a wrong number and say so with a straight face, which is why the
``basis`` string travels all the way to the ledger paragraph.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence


# --------------------------------------------------------------- assumptions

#: The facade temperature above which exposure is counted, matching
#: ``exposure.annual_facade_kh35`` and the analyst's ``hours_above_35``. Stated
#: as a constant so the ledger paragraph and the scoring model cannot drift.
EXPOSURE_THRESHOLD_C = 35.0

#: The largest share of a building's treatable exposure that any single measure
#: is assumed to remove. Used only to *infer* a building's headroom when the
#: caller has not supplied ``person_hours_at_risk`` on the candidate; see
#: ``_headroom``. 0.6 is deliberately generous — it makes the inferred headroom
#: small, which makes the modelled interaction between two measures on one
#: building strong, which is the conservative direction: it under-credits the
#: second measure rather than over-crediting it. ASSUMED.
SINGLE_MEASURE_CEILING = 0.6

#: Fallback electricity tariff, USD per kWh, used by ``ledger`` only when
#: ``heatcanyon.economics`` is not importable. The real number lives in
#: ``economics.CONSTANTS["electricity_usd_kwh"]`` with a source and an ``as_of``
#: date; this exists so that a build without the economics module still produces
#: a paragraph, and the paragraph says which one it used. ASSUMED.
ASSUMED_TARIFF_USD_KWH = (0.24, 0.31)

#: Fallback household size, persons per residential unit. Same rule: the real
#: value is ``economics.CONSTANTS["household_size"]``. ASSUMED.
ASSUMED_HOUSEHOLD_SIZE = 2.3

#: Lead times in the order a programme is actually phased, taken from
#: ``prescribe.Prescription.lead_time``. ``phase`` emits these keys first and in
#: this order; anything else it is handed follows, sorted, so an unrecognised
#: lead time is visible rather than silently dropped.
LEAD_TIME_ORDER: tuple[str, ...] = ("this season", "one year", "capital cycle")

#: Every output of this module carries it. The wording is the contract's.
BASIS = ("assumed — capex bands, tariffs, occupancy and the measure-interaction "
         "model are stated assumptions that no measurement in this study "
         "constrains; figures derived from them are given as ranges")


# ------------------------------------------------------------ sibling modules


def economics_module():
    """Return ``heatcanyon.economics``, or raise with a message that says why.

    ``economics`` is written by a parallel effort against section 4 of the
    contract and may not exist yet. Every use of it in this module is optional —
    ``ledger`` degrades to the ``ASSUMED_*`` fallbacks above and says so — but a
    caller that genuinely needs the constants table should get a sentence rather
    than an ``ImportError`` traceback from three frames down.
    """
    try:
        from . import economics                      # noqa: PLC0415
    except ImportError as exc:                       # pragma: no cover - trivial
        raise ImportError(
            "heatcanyon.economics is not available, so priced constants "
            "(tariff, household size, LL97) cannot be read. portfolio.py works "
            "without it by falling back to its own ASSUMED_* constants; if you "
            "need the sourced table, build economics.py first (docs/DECISIONS.md "
            "section 4)."
        ) from exc
    return economics


def _economics_range(name: str, fallback: tuple[float, float] | float
                     ) -> tuple[tuple[float, float], str]:
    """Read one constant as a (lo, hi) range plus a short provenance phrase.

    ``economics.Constant.value`` is documented as ``float | tuple[float, float]``,
    so a scalar is widened to a degenerate range rather than being special-cased
    at every call site.
    """
    try:
        econ = economics_module()
        const = getattr(econ, "CONSTANTS", {})[name]
        value = getattr(const, "value", const)
        as_of = getattr(const, "as_of", None)
    except Exception:                                # noqa: BLE001
        return (_range(fallback), "assumed by portfolio.py, no sourced constant")
    where = f"economics.CONSTANTS[{name!r}]"
    if as_of:
        where += f", as of {as_of}"
    return (_range(value), where)


# ------------------------------------------------------------------ ranges

Range = tuple[float, float]


def _range(v: Range | float | int) -> Range:
    if isinstance(v, (tuple, list)):
        lo, hi = float(v[0]), float(v[1])
        return (lo, hi) if lo <= hi else (hi, lo)
    return (float(v), float(v))


def _sum(rs: Iterable[Range]) -> Range:
    lo = hi = 0.0
    for r in rs:
        lo += r[0]
        hi += r[1]
    return (lo, hi)


def _mul(a: Range, b: Range) -> Range:
    """Interval product for non-negative quantities, which is all this layer has
    (energy, money, tonnes). Signed intervals would need all four corners."""
    return (a[0] * b[0], a[1] * b[1])


# ---------------------------------------------------------------- candidate


@dataclass(frozen=True)
class Candidate:
    """One measure on one building, priced. The atom of a programme.

    The first ten fields are the contract's (``docs/DECISIONS.md`` section 6) and
    keep their names and meanings exactly. The five after them are optional
    extensions with ``None`` defaults, added because the four objectives the
    analyst already implements need quantities the contract's ten cannot express,
    and because the constraint grammar filters on year and ZIP:

    ``degree_hours_avoided``
        Facade kelvin-hours avoided, ignoring who lives there — the analyst's
        ``avoided``. Without it, the ``degree_hours`` objective has to recover
        it as ``person_hours_avoided / units``, which is exact for a residential
        building and reads zero for one with no residents. Supply it and the
        objective is right for the whole stock; the ``Allocation`` says which
        happened.
    ``peak_relief_k``
        Event-day peak facade temperature reduction, K. The ``peak_relief``
        objective is unevaluable without it and raises rather than silently
        allocating nothing.
    ``person_hours_at_risk``
        The building's total treatable exposure, from
        ``loads.BuildingLoads.person_hours``. This is what makes the interaction
        between two measures on one building a calculation instead of a guess —
        see ``_headroom``.
    ``year_built`` / ``zip``
        For the ``built_before`` and ``zip`` constraints, which the analyst's
        ``allocate`` supports and which this module mirrors exactly, including
        the behaviour that a missing value fails the constraint rather than
        passing it. A candidate whose year is unknown is not "built before 1945".

    Frozen because a programme is an ordering over these rows and nothing in the
    module should be able to edit a benefit figure while ordering by it.
    """

    bin: str
    addr: str
    measure: str
    capex: Range
    person_hours_avoided: float
    kwh_saved: Range
    carbon_t: Range
    usd_per_person_hour: float
    lead_time: str
    hvi: int | None = None
    units: int = 0

    degree_hours_avoided: float | None = None
    peak_relief_k: float | None = None
    person_hours_at_risk: float | None = None
    year_built: int | None = None
    zip: str | None = None

    @property
    def key(self) -> tuple[str, str]:
        """Identity of the candidate. A building may appear many times with
        different measures, so the BIN alone is not a key."""
        return (self.bin, self.measure)

    @classmethod
    def from_prescription(cls, p: Any, *, bin: str, addr: str,
                          hvi: int | None = None, units: int = 0,
                          person_hours_at_risk: float | None = None,
                          year_built: int | None = None,
                          zip: str | None = None) -> "Candidate":
        """Build a candidate from a ``prescribe.Prescription``.

        Duck-typed on purpose: this reads the attributes section 5 of the
        contract documents (``key``, ``lead_time``, ``effect.d_person_hours``,
        ``effect.d_annual_kwh``, ``money.capex_usd``, ``money.carbon_t_yr``) and
        never imports ``prescribe``. That keeps the two modules independently
        testable and means a build without ``prescribe.py`` still imports this
        one — the dependency is on the documented shape, not on the file.
        """
        eff = p.effect
        money = p.money
        capex = _range(money.capex_usd)
        ph = float(eff.d_person_hours)
        return cls(
            bin=str(bin), addr=str(addr), measure=str(p.key),
            capex=capex,
            person_hours_avoided=ph,
            kwh_saved=_range(eff.d_annual_kwh),
            carbon_t=_range(money.carbon_t_yr),
            usd_per_person_hour=(capex[1] / ph) if ph > 0 else math.inf,
            lead_time=str(p.lead_time),
            hvi=hvi, units=int(units),
            degree_hours_avoided=None,
            peak_relief_k=float(getattr(eff, "d_facade_peak_k", 0.0) or 0.0),
            person_hours_at_risk=person_hours_at_risk,
            year_built=year_built, zip=zip,
        )


# ---------------------------------------------------------------- objectives


def _hvi_weight(hvi: int | None) -> float:
    """The analyst's HVI weighting, reproduced exactly.

    ``agent/analysis.allocate`` writes ``float(b.get("hvi") or 1) / 5.0``. The
    ``or 1`` is load-bearing and is kept: it means an unknown HVI *and* an HVI of
    zero are both treated as the least-vulnerable quintile, so a missing join can
    never look like urgency. (Note that ``exposure.vulnerability`` makes the
    opposite choice — an unknown ZIP there gets the study-area median, 2, because
    a missing join must not look like *safety* in a score whose whole purpose is
    to find people at risk. The two are not in conflict: one is scoring
    exposure, the other is spending money, and spending is the place to be
    conservative.)
    """
    return float(hvi or 1) / 5.0


def _degree_hours(c: Candidate) -> float:
    if c.degree_hours_avoided is not None:
        return float(c.degree_hours_avoided)
    # Exact inverse of the analyst's person_hours = avoided * units whenever the
    # building has residents. For a building with none, person-hours is zero by
    # construction and this reads zero where the analyst would read the full
    # facade kelvin-hours. That understatement is reported in Allocation.notes
    # rather than papered over with an invented occupancy.
    return c.person_hours_avoided / c.units if c.units > 0 else 0.0


def _peak_relief(c: Candidate) -> float:
    return float(c.peak_relief_k or 0.0)


def _carbon(c: Candidate) -> float:
    """Tonnes of CO2e avoided a year, at the LOW end of the range.

    The low end, not the midpoint, because every other objective here scores
    against the reading the assumption table supports even at its most
    favourable — ``severity_of`` and ``_exceedance_hours`` both do — and a
    carbon objective is the one most likely to be quoted at a podium.

    A NEGATIVE annual carbon is a real outcome here, not a guard against bad
    data: a solar-control measure on a heating-dominated elevation rejects more
    winter sun than it saves in summer cooling, and once the gas behind that is
    counted its net can be a LOSS. This function returns that loss as a negative,
    and ``benefit`` then clamps it to zero — the clamp it applies to every
    objective — so ``unit_cost`` comes back ``inf`` and the measure sorts to the
    end and is never bought under an objective called carbon. Which is the right
    outcome by a slightly indirect route: the ordering cannot distinguish a
    carbon loss from a carbon of exactly zero, and for ranking it does not need
    to. The signed figure is still on ``Candidate.carbon_t`` for anything that
    wants to SHOW it, and the brief does.
    """
    lo, hi = c.carbon_t
    return float(min(lo, hi))


#: The four objectives, as functions of a single candidate. Each is the analyst's
#: definition written against ``Candidate`` fields instead of ``ranked.json``
#: rows; the docstring at the top of this module explains why they are not
#: independently invented here.
OBJECTIVES: dict[str, Callable[[Candidate], float]] = {
    # Residents times facade degree-hours avoided. The default, because it is the
    # quantity public-health guidance is written against and it refuses to spend
    # on an empty tower.
    "person_hours": lambda c: float(c.person_hours_avoided),
    # Facade kelvin-hours avoided, ignoring who lives there. Its only real use is
    # as the contrast: run it against person_hours and the difference IS the
    # equity story.
    "degree_hours": _degree_hours,
    # Person-hours weighted by the Heat Vulnerability Index.
    "vulnerable": lambda c: float(c.person_hours_avoided) * _hvi_weight(c.hvi),
    # Reduction in event-day peak facade temperature: the acute objective rather
    # than the chronic one.
    "peak_relief": _peak_relief,
    # Tonnes of CO2e avoided a year, on BOTH fuels.
    #
    # THE ONLY OBJECTIVE HERE THAT IS NOT A HEAT-EXPOSURE OBJECTIVE, AND IT
    # EXISTS BECAUSE THE OTHER FOUR COULD NOT SEE A WHOLE MEASURE FAMILY.
    #
    # Exterior insulation earns its keep in January: it stops a building burning
    # gas. Priced properly it is the largest annual saving in the catalogue, and
    # under every objective above it ranked 281st to 700th of 769 while the
    # budget bought the first 222 — so a measure that was correctly modelled,
    # correctly priced and correctly ranked was still structurally unbuyable,
    # because nothing the allocator could be asked was a question insulation
    # answers. That is not a defect in the measure and it was not a defect in
    # those four objectives; it was a missing question.
    #
    # It is deliberately CARBON and not net present value. An NPV objective would
    # answer "what pays back best", which systematically prefers a large building
    # with a large bill to a vulnerable one with a small bill — and `vulnerable`
    # exists in this very dict to resist exactly that. Carbon is defensible on
    # the same public-good footing as the other four and does not import a
    # payback logic that argues against them.
    "carbon": _carbon,
}


def benefit(c: Candidate, objective: str = "person_hours") -> float:
    """The candidate's standalone benefit under one objective.

    "Standalone" means: against an untreated building. What it is worth as the
    second measure on a building already treated is smaller, and that is
    ``allocate``'s business, not this function's.
    """
    try:
        fn = OBJECTIVES[objective]
    except KeyError:
        raise ValueError(
            f"unknown objective {objective!r}; expected one of "
            f"{sorted(OBJECTIVES)}") from None
    return max(0.0, float(fn(c)))


def cost_of(c: Candidate, basis: str = "high") -> float:
    """The dollar figure the allocator spends.

    Defaults to the *high* end of the capex band. A programme that fits its
    budget only if every one of forty capex assumptions lands at the bottom of
    its range is not a programme, and the contract forbids collapsing the range
    to a midpoint to make the arithmetic tidy. ``basis="low"`` is available for
    showing the optimistic bound beside the committed one.
    """
    lo, hi = _range(c.capex)
    if basis == "low":
        return lo
    if basis == "high":
        return hi
    raise ValueError(f"cost basis must be 'low' or 'high', not {basis!r}")


def unit_cost(c: Candidate, objective: str = "person_hours", *,
              basis: str = "high") -> float:
    """Dollars per unit of objective benefit. ``inf`` when the benefit is zero.

    The curve is ordered by this rather than by the candidate's own
    ``usd_per_person_hour`` field. The two should agree for the default
    objective, but an ordering has to be a function of the quantities it claims
    to order by: if a caller supplies a stale or hand-edited
    ``usd_per_person_hour`` the curve must still be the curve of the capex and
    the benefit actually being summed. ``usd_per_person_hour`` is carried
    through untouched for display.
    """
    b = benefit(c, objective)
    if b <= 0.0:
        return math.inf
    return cost_of(c, basis) / b


def _sort_key(c: Candidate, objective: str, basis: str) -> tuple:
    """Total order over candidates. Deterministic by construction.

    Cheapest per unit of benefit first; ties broken by larger benefit (spend the
    same rate on the bigger win), then by BIN and measure key. No comparison in
    this module ever falls through to insertion order, which is what the
    contract means by "same input, same programme, same order" — a dict built in
    a different order must not produce a different plan.
    """
    return (unit_cost(c, objective, basis=basis), -benefit(c, objective),
            c.bin, c.measure)


# --------------------------------------------------------------- constraints


def _eligible(c: Candidate, constraint: dict) -> bool:
    """The analyst's constraint grammar, applied to a candidate.

    Mirrors ``agent/analysis.allocate``'s ``eligible`` exactly, including the
    two places where its behaviour is easy to get subtly wrong: an unknown
    ``year_built`` fails ``built_before`` (unknown is not "old"), and ZIP is
    compared as a string because leading zeros survive in the data and not in an
    int.
    """
    if not constraint:
        return True
    if constraint.get("residential_only") and not (c.units or 0) > 0:
        return False
    min_hvi = constraint.get("min_hvi")
    if min_hvi and (c.hvi or 0) < min_hvi:
        return False
    before = constraint.get("built_before")
    if before and not (c.year_built and c.year_built < before):
        return False
    want_zip = constraint.get("zip")
    if want_zip and str(c.zip or "") != str(want_zip):
        return False
    return True


# -------------------------------------------------------------------- curve


def curve(candidates: Sequence[Candidate], *, objective: str = "person_hours",
          cost_basis: str = "high", constraint: dict | None = None
          ) -> list[Candidate]:
    """Every candidate as a point on the cost curve, cheapest benefit first.

    This is the classic marginal abatement cost curve with person-hours of
    exposure in place of tonnes: each candidate is a bar whose width is its
    capex and whose height is its dollars per person-hour, sorted ascending, and
    the interface draws a vertical line where the cumulative width reaches the
    budget. Everything left of the line is the programme.

    The ordering here is *standalone* cost-effectiveness — every candidate priced
    against an untreated building. That is the right thing to draw, because a
    curve is a picture of the opportunity set rather than of a particular
    programme, and a curve whose bars silently changed height depending on what
    had already been bought would be unreadable. ``allocate`` does the
    interaction properly; the two therefore differ where a building takes more
    than one measure, and that is intended.

    Zero-benefit candidates sort to the end at infinite cost rather than being
    dropped, so the caller can see them and see that they were never bought.
    """
    pool = [c for c in candidates if _eligible(c, constraint or {})]
    return sorted(pool, key=lambda c: _sort_key(c, objective, cost_basis))


# --------------------------------------------------------------- allocation


@dataclass
class Allocation:
    """A programme: what gets bought, in what order, and what it buys."""

    objective: str
    budget_usd: float
    cost_basis: str
    interaction: str
    constraint: dict

    selected: list[Candidate]
    #: Benefit actually credited to each selected candidate at the moment it was
    #: selected — for the first measure on a building this equals its standalone
    #: benefit, for the second it is what the first left behind. Parallel to
    #: ``selected``.
    marginal: list[float]

    capex_usd: Range
    benefit_total: float
    benefit_standalone: float
    person_hours_avoided: float
    kwh_saved: Range
    carbon_t: Range

    buildings: int
    units: int
    considered: int
    eligible: int
    skipped_over_budget: int
    unspent_usd: float

    notes: list[str] = field(default_factory=list)
    basis: str = BASIS
    method: str = ""

    @property
    def keys(self) -> list[tuple[str, str]]:
        return [c.key for c in self.selected]

    @property
    def bins(self) -> list[str]:
        seen: list[str] = []
        for c in self.selected:
            if c.bin not in seen:
                seen.append(c.bin)
        return seen

    def rows(self) -> list[dict]:
        """Flat dicts for JSON and for the interface table."""
        return [{
            "order": i + 1, "bin": c.bin, "addr": c.addr, "measure": c.measure,
            "capex_usd": list(_range(c.capex)),
            "person_hours_avoided": c.person_hours_avoided,
            "marginal_benefit": m,
            "usd_per_unit_benefit": (cost_of(c, self.cost_basis) / m
                                     if m > 0 else None),
            "lead_time": c.lead_time, "hvi": c.hvi, "units": c.units,
        } for i, (c, m) in enumerate(zip(self.selected, self.marginal))]


def _headroom(cands: Sequence[Candidate], objective: str) -> float:
    """A building's total treatable benefit, in the objective's own units.

    This is the number that makes the second measure on a building worth less
    than the first, so it is the one honest place in the module and deserves the
    paragraph.

    If any candidate on the building carries ``person_hours_at_risk`` — which is
    ``loads.BuildingLoads.person_hours``, a modelled quantity — the headroom is
    that, converted into the objective's units by the same linear factor the
    objective applies to person-hours. Then the interaction below is a
    calculation over a modelled total, not an assumption.

    If nothing carries it, the headroom is inferred as the largest single
    candidate's benefit divided by ``SINGLE_MEASURE_CEILING``: the assumption
    that no one measure removes more than 60% of a building's treatable
    exposure. That is an assumption table entry and it is why every allocation
    that used it carries "assumed" in its basis and says so in ``notes``.

    Either way the headroom is at least the largest single benefit, so no
    candidate is ever credited with more than its own standalone figure.
    """
    benefits = [benefit(c, objective) for c in cands]
    best = max(benefits) if benefits else 0.0
    if best <= 0.0:
        return 0.0

    at_risk = next((c.person_hours_at_risk for c in cands
                    if c.person_hours_at_risk), None)
    if at_risk and at_risk > 0:
        # Convert person-hours at risk into the objective's units using the same
        # per-building factor the objective itself uses. For person_hours the
        # factor is 1; for vulnerable it is hvi/5, and since that factor is
        # constant within a building the *ratios* — which is all the interaction
        # model uses — are identical either way. degree_hours and peak_relief are
        # not person-hour quantities at all, so they fall through to the
        # inferred headroom below.
        if objective == "person_hours":
            factor = 1.0
        elif objective == "vulnerable":
            factor = _hvi_weight(cands[0].hvi)
        else:
            factor = 0.0
        if factor > 0.0:
            return max(best, float(at_risk) * factor)

    return best / SINGLE_MEASURE_CEILING


def allocate(candidates: Sequence[Candidate], budget_usd: float, *,
             objective: str = "person_hours", constraint: dict | None = None,
             cost_basis: str = "high", interaction: str = "residual"
             ) -> Allocation:
    """Spend a fixed budget across buildings and measures.

    HOW MULTIPLE MEASURES ON ONE BUILDING ARE HANDLED

    A building may appear several times — a cool roof, a glazing retrofit and
    night purge ventilation are three candidates on one BIN — and their benefits
    are not additive. Shading a facade that a glazing swap has already cooled
    removes exposure that has partly gone. Summing the standalone figures would
    let the allocator buy the same person-hour twice and report a programme that
    cannot be delivered.

    The default (``interaction="residual"``) does the marginal calculation
    rather than warning about it. Each building has a headroom ``E`` (see
    ``_headroom``) and each measure is credited with a fraction ``b_i / E`` of
    what remains untreated:

        combined(S) = E * (1 - product over i in S of (1 - b_i / E))

    so the marginal value of adding a measure to a building that already holds
    ``S`` is its standalone benefit multiplied by the residual factor
    ``product(1 - b_i / E)``. Three properties earn this model its place. The
    total is independent of the order the measures were bought in, so the
    programme's headline figure does not depend on the search. It is bounded by
    ``E``, so no building can be credited with avoiding more exposure than it
    has. And it collapses to plain addition when the measures are small relative
    to the building, which is the regime most single-measure buildings sit in.

    It is still a model of the interaction and not a re-solve of it. The honest
    version would send every subset back through ``prescribe``'s ``resolve``
    callable and read the combined effect out of the physics; that is minutes of
    ray tracing per building and is the right thing to do for the final dozen
    sites, not for four thousand. The module therefore states the model, keeps
    ``interaction="independent"`` available so the difference can be seen, and
    puts the choice in ``Allocation.method`` where it travels with the numbers.

    WHY GREEDY, AND WHAT THAT COSTS

    The analyst's ``allocate`` is greedy under a *cardinality* budget, where
    greedy on an additive objective is exactly optimal and saying "heuristic"
    would be a needless hedge. This is a *knapsack* with a submodular objective
    and neither of those properties survives: greedy on benefit-per-dollar is not
    optimal here. It is within a constant factor, and the standard trick that
    makes the factor real is cheap — compare the greedy programme against the
    single best affordable candidate and keep the better — so it is implemented
    and it reports itself in ``notes`` when it fires. The selection uses lazy
    re-evaluation: a candidate's marginal value can only fall as its building
    fills up, so a stale heap entry is re-costed and pushed back rather than the
    whole pool being rescored after every pick.

    A candidate too expensive for the remaining budget is skipped and counted,
    not treated as the end of the programme, because a cheaper one further down
    the curve may still fit.
    """
    if interaction not in ("residual", "independent"):
        raise ValueError("interaction must be 'residual' or 'independent', "
                         f"not {interaction!r}")
    if objective not in OBJECTIVES:
        raise ValueError(f"unknown objective {objective!r}; expected one of "
                         f"{sorted(OBJECTIVES)}")
    budget_usd = float(budget_usd)
    if budget_usd < 0:
        raise ValueError("budget_usd must not be negative")
    constraint = dict(constraint or {})

    considered = len(candidates)
    pool = curve(candidates, objective=objective, cost_basis=cost_basis,
                 constraint=constraint)
    notes: list[str] = []

    if objective == "peak_relief" and not any(
            c.peak_relief_k is not None for c in pool):
        raise ValueError(
            "objective 'peak_relief' needs peak_relief_k on the candidates; no "
            "candidate carries one, so the objective is unevaluable. Supply it "
            "from prescribe.Effect.d_facade_peak_k rather than allocating "
            "against an all-zero benefit.")
    if objective == "degree_hours" and not any(
            c.degree_hours_avoided is not None for c in pool):
        notes.append(
            "degree_hours was recovered as person_hours / units because no "
            "candidate carried degree_hours_avoided. That is exact for a "
            "residential building and reads zero for one with no residents, so "
            "non-residential stock is under-weighted in this ordering.")

    # Buildings, in a deterministic order, with their headroom under this
    # objective. Built from the sorted pool so the grouping never depends on the
    # order the caller happened to hand us the candidates in.
    by_bin: dict[str, list[Candidate]] = {}
    for c in pool:
        by_bin.setdefault(c.bin, []).append(c)
    headroom = {b: _headroom(cs, objective) for b, cs in by_bin.items()}
    inferred = [b for b, cs in by_bin.items()
                if len(cs) > 1 and not any(c.person_hours_at_risk for c in cs)]
    if interaction == "residual" and inferred:
        notes.append(
            f"{len(inferred)} buildings take more than one measure and carry no "
            f"person_hours_at_risk, so their headroom was inferred from the "
            f"assumed ceiling of {SINGLE_MEASURE_CEILING:.0%} for a single "
            f"measure. Supply loads.BuildingLoads.person_hours on the candidates "
            f"to make the interaction a calculation instead of an assumption.")

    residual: dict[str, float] = {b: 1.0 for b in by_bin}
    picks_on: dict[str, int] = {b: 0 for b in by_bin}

    def marginal_of(c: Candidate) -> float:
        b = benefit(c, objective)
        if interaction == "independent":
            return b
        return b * residual[c.bin]

    def ratio_of(c: Candidate, m: float) -> float:
        cost = cost_of(c, cost_basis)
        if m <= 0.0:
            return -math.inf
        return math.inf if cost <= 0.0 else m / cost

    # (-ratio, cost, bin, measure, index, stamp). Every element is a float or a
    # string, so the tuple comparison is a total order and no tie ever falls
    # through to the heap's internal arrangement.
    heap: list[tuple] = []
    for i, c in enumerate(pool):
        m = marginal_of(c)
        if m <= 0.0:
            continue
        heapq.heappush(heap, (-ratio_of(c, m), cost_of(c, cost_basis),
                              c.bin, c.measure, i, 0))
    eligible_n = len(pool)

    selected: list[Candidate] = []
    marginals: list[float] = []
    remaining = budget_usd
    skipped = 0

    while heap:
        negr, cost, b, m_key, idx, stamp = heapq.heappop(heap)
        c = pool[idx]
        if cost > remaining:
            # The budget only shrinks, so this can never become affordable again.
            skipped += 1
            continue
        if stamp != picks_on[b]:
            m = marginal_of(c)
            if m <= 0.0:
                continue
            heapq.heappush(heap, (-ratio_of(c, m), cost, b, m_key, idx,
                                  picks_on[b]))
            continue
        m = marginal_of(c)
        if m <= 0.0:
            continue
        selected.append(c)
        marginals.append(m)
        remaining -= cost
        picks_on[b] += 1
        if interaction == "residual":
            E = headroom[b]
            share = min(1.0, benefit(c, objective) / E) if E > 0 else 1.0
            residual[b] *= (1.0 - share)

    total = sum(marginals)

    # The half-approximation guard. Greedy on benefit-per-dollar can be beaten by
    # a single large candidate it passed over; taking the better of the two is
    # what turns "within a constant factor" from a claim into a property.
    affordable = [c for c in pool if cost_of(c, cost_basis) <= budget_usd]
    best_single = max(
        affordable,
        key=lambda c: (benefit(c, objective), -cost_of(c, cost_basis),
                       c.bin, c.measure),
        default=None)
    if best_single is not None and benefit(best_single, objective) > total:
        notes.append(
            "The greedy programme was beaten by a single candidate "
            f"({best_single.bin}/{best_single.measure}) and was replaced by it. "
            "This is the knapsack pathology, not a bug: one very large, very "
            "cost-effective measure can be passed over by an ordering that "
            "spends the budget on cheaper ones first.")
        selected = [best_single]
        marginals = [benefit(best_single, objective)]
        remaining = budget_usd - cost_of(best_single, cost_basis)
        total = marginals[0]
        skipped = max(0, eligible_n - 1)

    standalone = sum(benefit(c, objective) for c in selected)
    if interaction == "residual" and standalone > total + 1e-9:
        notes.append(
            f"Measure interaction removed {standalone - total:,.0f} units of "
            f"double-counted benefit ({1 - total / standalone:.0%} of the "
            f"standalone sum) across buildings taking more than one measure.")

    bins = []
    for c in selected:
        if c.bin not in bins:
            bins.append(c.bin)
    units = sum({c.bin: c.units for c in selected}.values())

    method = (
        f"greedy on marginal benefit per dollar under a {cost_basis}-end capex "
        f"budget, with lazy re-evaluation and a best-single-candidate guard; "
        + ("measures on one building combine on the residual "
           "(1 - product of (1 - b/E)), so the second is credited only with what "
           "the first leaves behind"
           if interaction == "residual" else
           "measures on one building are treated as independent and their "
           "benefits are summed, which double-counts wherever two measures treat "
           "the same exposure — a stated limitation of this mode"))

    return Allocation(
        objective=objective, budget_usd=budget_usd, cost_basis=cost_basis,
        interaction=interaction, constraint=constraint,
        selected=selected, marginal=marginals,
        capex_usd=_sum(_range(c.capex) for c in selected),
        benefit_total=total, benefit_standalone=standalone,
        person_hours_avoided=sum(c.person_hours_avoided for c in selected),
        kwh_saved=_sum(_range(c.kwh_saved) for c in selected),
        carbon_t=_sum(_range(c.carbon_t) for c in selected),
        buildings=len(bins), units=units,
        considered=considered, eligible=eligible_n,
        skipped_over_budget=skipped, unspent_usd=remaining,
        notes=notes, basis=BASIS, method=method,
    )


# ------------------------------------------------------------ disagreement


@dataclass
class Disagreement:
    """What two objectives do differently with the same money.

    ``pairs`` holds every pairwise comparison; the top-level ``overlap``,
    ``only_in``, ``moved`` and ``reading`` fields are the headline pair — the
    first two objectives passed — because an interface showing two columns needs
    one answer, not a matrix.
    """

    budget_usd: float
    objectives: list[str]
    allocations: dict[str, Allocation]
    pairs: list[dict]

    overlap: int
    building_overlap: int
    only_in: dict[str, list[dict]]
    moved: list[dict]
    reading: str
    basis: str = BASIS


def _entry(c: Candidate, ranks: dict[tuple[str, str], dict[str, int]],
           a: str, b: str) -> dict:
    r = ranks.get(c.key, {})
    ra, rb = r.get(a), r.get(b)
    return {
        "bin": c.bin, "addr": c.addr, "measure": c.measure,
        "capex_usd": list(_range(c.capex)),
        "person_hours_avoided": c.person_hours_avoided,
        "hvi": c.hvi, "units": c.units,
        f"rank_{a}": ra, f"rank_{b}": rb,
        "moved": (None if ra is None or rb is None else rb - ra),
    }


def _reading(a: str, b: str, alloc_a: Allocation, alloc_b: Allocation,
             overlap: int, only_a: list[dict], only_b: list[dict],
             budget: float) -> str:
    """The prose finding, in the register ``pipeline.ordering_report`` uses.

    That report does not say "the correlation is 0.71". It says the two
    orderings are different questions, names what a mover means, and says where
    agreement makes the case strong. This does the same for the objectives, and
    ends on the sentence the module exists to make someone read: that the choice
    is being made either way.
    """
    n_a, n_b = len(alloc_a.selected), len(alloc_b.selected)
    if not n_a and not n_b:
        return (f"At {_usd(budget)} neither '{a}' nor '{b}' can buy anything: "
                f"every candidate costs more than the whole budget. The two "
                f"objectives agree only in the trivial sense.")
    if overlap == n_a == n_b and not only_a and not only_b:
        return (f"At {_usd(budget)} the '{a}' and '{b}' orderings buy exactly "
                f"the same {_plural(overlap, 'measure')}. They are different "
                f"questions "
                f"that happen to have the same answer at this budget, which is "
                f"the strongest case a programme can have: it is the right "
                f"spend on either account. Move the budget line and they may "
                f"part.")
    share = overlap / max(n_a, n_b, 1)
    lines = [
        f"'{a}' and '{b}' are different questions and give different answers. "
        f"At {_usd(budget)} they agree on {overlap} of {max(n_a, n_b)} measures "
        f"({share:.0%}), covering {_common_bins(alloc_a, alloc_b)} buildings in "
        f"common. "
        f"{_plural(len(only_a), 'measure is', 'measures are')} bought only "
        f"under '{a}' and {len(only_b):,} only under '{b}'."
    ]
    if only_b:
        top = only_b[0]
        lines.append(
            f"{top['addr'] or top['bin']} enters under '{b}' at rank "
            f"{top.get('rank_' + b)} and sits at rank {top.get('rank_' + a)} "
            f"under '{a}' — {_plural(abs(top['moved'] or 0), 'place')} apart. "
            f"A building "
            f"that appears under one objective and not the other is not a "
            f"rounding difference; it is the whole disagreement, in one address.")
    if a in ("person_hours", "degree_hours") and b == "vulnerable":
        lines.append(
            "The direction is the familiar one: efficiency buys the most "
            "avoided exposure per dollar, equity buys fewer avoided hours and "
            "buys them for residents the Heat Vulnerability Index says have the "
            "fewest alternatives. Neither ordering is wrong.")
    lines.append(
        "Where they agree the case is strong on both grounds and the money "
        "should go there first. Where they disagree, someone is choosing — and "
        "if the interface shows only one column, the choice is being made "
        "without being made.")
    return " ".join(lines)


def _common_bins(a: Allocation, b: Allocation) -> int:
    return len(set(a.bins) & set(b.bins))


def _plural(n: int, one: str, many: str | None = None) -> str:
    """Agreement matters here. This prose ends up in a deck beside a dollar
    figure, and "1 measures are bought" undoes a paragraph of care."""
    return f"{n:,} {one if abs(n) == 1 else (many or one + 's')}"


def compare_objectives(candidates: Sequence[Candidate], budget_usd: float,
                       objectives: Sequence[str] = ("person_hours", "vulnerable"),
                       *, constraint: dict | None = None,
                       cost_basis: str = "high",
                       interaction: str = "residual") -> Disagreement:
    """Allocate the same budget under several objectives and report the split.

    This is the point of the module. Each objective is a defensible answer to
    "where should the money go" and they do not coincide, so the useful output is
    not a ranking but the *difference between* rankings: the overlap at the
    budget line, the measures bought under one objective and not the other, and
    how far each moved on the full curve.

    Ranks are positions on the whole ordered curve, not positions inside the
    selected set, so "moved 480 places" means something for a candidate that one
    objective bought and the other never reached.
    """
    objectives = list(dict.fromkeys(str(o) for o in objectives))
    if len(objectives) < 2:
        raise ValueError("compare_objectives needs at least two objectives; "
                         "the disagreement between them is the output")
    for o in objectives:
        if o not in OBJECTIVES:
            raise ValueError(f"unknown objective {o!r}; expected one of "
                             f"{sorted(OBJECTIVES)}")

    allocs: dict[str, Allocation] = {}
    ranks: dict[tuple[str, str], dict[str, int]] = {}
    for o in objectives:
        allocs[o] = allocate(candidates, budget_usd, objective=o,
                             constraint=constraint, cost_basis=cost_basis,
                             interaction=interaction)
        for i, c in enumerate(curve(candidates, objective=o,
                                    cost_basis=cost_basis,
                                    constraint=constraint)):
            ranks.setdefault(c.key, {})[o] = i + 1

    by_key = {c.key: c for c in candidates}
    pairs: list[dict] = []
    for i in range(len(objectives)):
        for j in range(i + 1, len(objectives)):
            a, b = objectives[i], objectives[j]
            ka = {c.key for c in allocs[a].selected}
            kb = {c.key for c in allocs[b].selected}
            only_a = [_entry(by_key[k], ranks, a, b) for k in
                      sorted(ka - kb, key=lambda k: ranks.get(k, {}).get(a, 0))]
            only_b = [_entry(by_key[k], ranks, a, b) for k in
                      sorted(kb - ka, key=lambda k: ranks.get(k, {}).get(b, 0))]
            moved = sorted(
                (_entry(by_key[k], ranks, a, b) for k in sorted(ka | kb)),
                key=lambda e: (-abs(e["moved"] or 0), e["bin"], e["measure"]))
            pairs.append({
                "objectives": [a, b],
                "overlap": len(ka & kb),
                "building_overlap": _common_bins(allocs[a], allocs[b]),
                "selected": {a: len(ka), b: len(kb)},
                "only_in": {a: only_a, b: only_b},
                "moved": moved[:10],
                "benefit": {a: allocs[a].benefit_total,
                            b: allocs[b].benefit_total},
                "reading": _reading(a, b, allocs[a], allocs[b], len(ka & kb),
                                    only_a, only_b, budget_usd),
            })

    head = pairs[0]
    return Disagreement(
        budget_usd=float(budget_usd), objectives=objectives,
        allocations=allocs, pairs=pairs,
        overlap=head["overlap"], building_overlap=head["building_overlap"],
        only_in=head["only_in"], moved=head["moved"], reading=head["reading"],
        basis=BASIS,
    )


# -------------------------------------------------------------------- phase


def phase(allocation: Allocation) -> dict[str, list[Candidate]]:
    """Group the programme by when it can start, not by what it is worth.

    A cool roof is a purchase order and a summer. A glazing retrofit is a capital
    cycle, a tenant negotiation and a facade permit. A street tree is a planting
    season, a different agency and a different budget line. Sorting a list of
    measures by benefit produces a ranking; sorting it by when it can begin
    produces a plan, and the two look nothing alike — the top of a cost curve is
    routinely dominated by measures nobody can start for three years.

    Keys come out in ``LEAD_TIME_ORDER`` first, then anything else sorted, so the
    dict iterates in programme order and never in whatever order the candidates
    arrived. Within a phase the allocation's own selection order is kept.
    """
    groups: dict[str, list[Candidate]] = {}
    for c in allocation.selected:
        groups.setdefault(c.lead_time, []).append(c)
    ordered: dict[str, list[Candidate]] = {}
    for key in LEAD_TIME_ORDER:
        if key in groups:
            ordered[key] = groups.pop(key)
    for key in sorted(groups):
        ordered[key] = groups[key]
    return ordered


def phase_summary(allocation: Allocation) -> list[dict]:
    """``phase`` with the money and the benefit attached, for the interface.

    Kept separate from ``phase`` because the contract fixes ``phase``'s return
    type to ``dict[str, list[Candidate]]`` and a table needs totals.
    """
    credited = {c.key: m for c, m in zip(allocation.selected,
                                         allocation.marginal)}
    out = []
    for name, group in phase(allocation).items():
        out.append({
            "lead_time": name,
            "measures": len(group),
            "buildings": len({c.bin for c in group}),
            "capex_usd": list(_sum(_range(c.capex) for c in group)),
            "benefit": sum(credited.get(c.key, 0.0) for c in group),
            "share_of_capex": (
                _sum(_range(c.capex) for c in group)[1] /
                allocation.capex_usd[1] if allocation.capex_usd[1] else 0.0),
        })
    return out


# ------------------------------------------------------------------- ledger


def _usd(x: float) -> str:
    """One house format for money, so a figure never appears three ways."""
    x = float(x)
    if x >= 1e9:
        return f"${x / 1e9:,.2f} bn"
    if x >= 1e6:
        return f"${x / 1e6:,.2f} m"
    if x >= 1e4:
        return f"${x / 1e3:,.0f}k"
    return f"${x:,.0f}"


def _usd_range(r: Range) -> str:
    lo, hi = r
    if abs(hi - lo) < 1e-6:
        return _usd(lo)
    return f"{_usd(lo)}–{_usd(hi)}"


def _num_range(r: Range, unit: str, digits: int = 0) -> str:
    lo, hi = r
    if abs(hi - lo) < 10 ** (-digits) / 2:
        return f"{lo:,.{digits}f} {unit}"
    return f"{lo:,.{digits}f}–{hi:,.{digits}f} {unit}"


def ledger(allocation: Allocation, *,
           tariff_usd_kwh: Range | float | None = None,
           household_size: float | None = None) -> str:
    """The outcome paragraph: what this programme is, and what it rests on.

    *This programme, at this budget, treats N buildings, avoids X person-hours
    above 35 °C for Y residents, saves Z MWh and T tonnes, and costs $C with a
    P-year payback.* That is the sentence that ends up in a deck, and it should
    come out of the model rather than out of a consultant — which means it has to
    carry the things a consultant's version leaves out.

    So: every figure whose input carried a range is rendered as a range, never as
    a midpoint; the paragraph names its basis, because every dollar in it passed
    through an assumption table; it says where the tariff came from and how old
    it is, because a stale tariff is a wrong answer that looks right; and it says
    what the payback excludes. It also states the measure-interaction model,
    because the difference between the standalone sum and the credited total is
    exactly the number an unscrupulous version of this paragraph would quote.
    """
    a = allocation
    tariff_src = "supplied by the caller"
    if tariff_usd_kwh is None:
        tariff, tariff_src = _economics_range("electricity_usd_kwh",
                                              ASSUMED_TARIFF_USD_KWH)
    else:
        tariff = _range(tariff_usd_kwh)
    if household_size is None:
        hh_r, hh_src = _economics_range("household_size", ASSUMED_HOUSEHOLD_SIZE)
    else:
        hh_r, hh_src = _range(household_size), "supplied by the caller"

    if not a.selected:
        return (
            f"At {_usd(a.budget_usd)} this programme treats 0 buildings: no "
            f"candidate under the '{a.objective}' objective is both eligible "
            f"and affordable ({a.eligible} of {a.considered} candidates passed "
            f"the constraint, {a.skipped_over_budget} were priced above the "
            f"budget). The capex bands that produced that verdict are assumed, "
            f"not measured, so the honest reading is that the budget is close to "
            f"the cost of the cheapest single measure rather than that nothing "
            f"is worth doing. Basis: {a.basis}.")

    mwh = (a.kwh_saved[0] / 1000.0, a.kwh_saved[1] / 1000.0)
    saving = _mul(a.kwh_saved, tariff)
    residents = (a.units * hh_r[0], a.units * hh_r[1])

    if saving[0] > 0:
        pay = (a.capex_usd[0] / saving[1], a.capex_usd[1] / saving[0])
        pay_txt = (f"pays back on avoided electricity in "
                   f"{_num_range(pay, 'years', 1)}")
    else:
        pay_txt = ("does not pay back on avoided electricity within the model, "
                   "because the candidates carry no energy saving")

    measures = len(a.selected)
    parts = [
        f"At a budget of {_usd(a.budget_usd)}, this programme treats "
        f"{_plural(a.buildings, 'building')} with "
        f"{_plural(measures, 'measure')} under the '{a.objective}' objective.",

        f"It avoids {a.person_hours_avoided:,.0f} person-hours above "
        f"{EXPOSURE_THRESHOLD_C:.0f} °C for {a.units:,} residential units "
        f"(about {_num_range(residents, 'residents')} at an assumed household "
        f"size of {_num_range(hh_r, '', 1).strip()}, {hh_src}),",

        f"saves {_num_range(mwh, 'MWh')} and {_num_range(a.carbon_t, 't CO2e')} "
        f"a year,",

        f"and costs {_usd_range(a.capex_usd)} — leaving "
        f"{_usd(a.unspent_usd)} of the budget unspent because the next measure "
        f"on the curve costs more than that.",

        f"At an assumed tariff of {tariff[0]:.3f}–{tariff[1]:.3f} $/kWh "
        f"({tariff_src}) it {pay_txt}; that figure counts energy only and "
        f"excludes demand charges and any Local Law 97 penalty avoided, both of "
        f"which shorten it.",
    ]

    if a.interaction == "residual" and a.benefit_standalone > a.benefit_total + 1e-9:
        parts.append(
            f"Where a building takes more than one measure the second is "
            f"credited only with the exposure the first leaves behind, which "
            f"removes {a.benefit_standalone - a.benefit_total:,.0f} units of "
            f"double-counted benefit from the standalone sum.")

    parts.append(
        f"Every dollar in this paragraph passed through an assumption table — "
        f"capex bands, tariff, household size — and is therefore stated as a "
        f"range and labelled assumed rather than measured or modelled. "
        f"Basis: {a.basis}.")

    return " ".join(parts)

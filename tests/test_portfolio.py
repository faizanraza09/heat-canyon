"""The programme layer: ordering, allocation, and the disagreement between
objectives.

These are unit tests over ``heatcanyon.portfolio`` against synthetic
``Candidate`` fixtures, deliberately not against ``economics.price`` or
``prescribe.for_building``. The module's job is to order and select, and it must
be provable that it orders and selects correctly without a solved model, a
priced measure or a sibling module that may not exist yet. A fixture here is
three lines and the arithmetic is checkable by hand, which is the point: when a
programme comes out wrong in production the question "is the allocator wrong or
is the benefit figure wrong" has to be answerable, and it is only answerable if
the allocator has its own tests.

The one exception is ``test_vulnerable_matches_the_analyst``, which reaches into
``agent/analysis.allocate`` on purpose. Two modules holding two definitions of
"vulnerable" would be a bug that never raises, so the agreement is asserted
rather than assumed.
"""
from __future__ import annotations

import math
import random
from types import SimpleNamespace

import pytest

from heatcanyon import portfolio as PF


# ----------------------------------------------------------------- fixtures


def cand(bin: str, measure: str = "cool_roof", *, capex=(100_000.0, 120_000.0),
         ph: float = 1_000.0, units: int = 50, hvi: int | None = 3,
         lead: str = "this season", **kw) -> PF.Candidate:
    """One synthetic candidate with internally consistent money.

    Energy and carbon are tied to person-hours by a fixed factor so that a
    programme's MWh and tonnes move with its person-hours and a test can predict
    them; nothing in the module depends on the relationship holding.
    """
    lo, hi = capex
    return PF.Candidate(
        bin=bin, addr=f"{bin} Example Street", measure=measure,
        capex=(lo, hi), person_hours_avoided=ph,
        kwh_saved=(ph * 10.0, ph * 14.0),
        carbon_t=(ph * 0.003, ph * 0.005),
        usd_per_person_hour=(hi / ph if ph > 0 else math.inf),
        lead_time=lead, hvi=hvi, units=units, **kw)


@pytest.fixture
def mixed() -> list[PF.Candidate]:
    """A small stock with a wide spread of cost-effectiveness, one candidate
    that buys nothing, and three lead times."""
    return [
        cand("A", "cool_roof", capex=(40_000, 50_000), ph=5_000, units=80, hvi=4),
        cand("B", "shading", capex=(200_000, 240_000), ph=6_000, units=120, hvi=2,
             lead="one year"),
        cand("C", "glazing", capex=(900_000, 1_100_000), ph=9_000, units=200,
             hvi=5, lead="capital cycle"),
        cand("D", "canopy", capex=(60_000, 75_000), ph=400, units=10, hvi=3,
             lead="one year"),
        cand("E", "purge", capex=(30_000, 35_000), ph=0.0, units=40, hvi=5),
    ]


# -------------------------------------------------------------------- curve


def test_curve_is_ordered_by_cost_effectiveness(mixed):
    ordered = PF.curve(mixed)
    costs = [PF.unit_cost(c, "person_hours") for c in ordered]
    assert costs == sorted(costs)
    # A: 50000/5000 = 10 $/ph, the cheapest. E buys nothing and sorts last at
    # infinite cost rather than being silently dropped.
    assert ordered[0].bin == "A"
    assert ordered[-1].bin == "E"
    assert math.isinf(costs[-1])


def test_curve_is_stable_across_repeated_calls_and_input_order(mixed):
    """Determinism is a requirement, not a nicety: the same stock must give the
    same curve however the caller happened to build the list."""
    base = [c.key for c in PF.curve(mixed)]
    assert [c.key for c in PF.curve(mixed)] == base
    for seed in range(5):
        shuffled = list(mixed)
        random.Random(seed).shuffle(shuffled)
        assert [c.key for c in PF.curve(shuffled)] == base


def test_curve_ties_do_not_fall_through_to_input_order():
    """Two candidates with identical cost and identical benefit must still have
    a defined order, and it must not be the order they were handed over in."""
    a = cand("Z9", "roof", capex=(10_000, 10_000), ph=100)
    b = cand("A1", "roof", capex=(10_000, 10_000), ph=100)
    assert [c.bin for c in PF.curve([a, b])] == ["A1", "Z9"]
    assert [c.bin for c in PF.curve([b, a])] == ["A1", "Z9"]


# --------------------------------------------------------------- allocation


def test_allocation_never_exceeds_the_budget(mixed):
    for budget in (0, 10_000, 55_000, 130_000, 400_000, 2_000_000):
        alloc = PF.allocate(mixed, budget)
        # The allocator commits at the high end of every capex band, so both
        # ends of the programme's cost must sit inside the budget.
        assert alloc.capex_usd[1] <= budget + 1e-9
        assert alloc.capex_usd[0] <= alloc.capex_usd[1]
        assert alloc.unspent_usd >= -1e-9


def test_a_candidate_with_no_benefit_is_never_selected(mixed):
    alloc = PF.allocate(mixed, 10_000_000)
    assert "E" not in [c.bin for c in alloc.selected]
    assert all(m > 0 for m in alloc.marginal)


def test_allocation_is_deterministic_under_input_permutation(mixed):
    base = PF.allocate(mixed, 400_000)
    for seed in range(5):
        shuffled = list(mixed)
        random.Random(seed).shuffle(shuffled)
        other = PF.allocate(shuffled, 400_000)
        assert other.keys == base.keys
        assert other.marginal == pytest.approx(base.marginal)


def test_unknown_objective_and_bad_basis_are_refused(mixed):
    with pytest.raises(ValueError):
        PF.allocate(mixed, 100_000, objective="cheapest")
    with pytest.raises(ValueError):
        PF.cost_of(mixed[0], "midpoint")


def test_peak_relief_refuses_to_allocate_against_nothing(mixed):
    """An objective that cannot be evaluated must say so rather than return an
    empty programme, which reads as 'nothing is worth doing'."""
    with pytest.raises(ValueError, match="peak_relief_k"):
        PF.allocate(mixed, 500_000, objective="peak_relief")
    with_k = [cand("A", "roof", ph=100, peak_relief_k=3.0),
              cand("B", "roof", ph=100, peak_relief_k=1.0)]
    alloc = PF.allocate(with_k, 500_000, objective="peak_relief")
    assert alloc.selected[0].bin == "A"


# ------------------------------------------- multiple measures per building


def test_second_measure_on_a_building_is_credited_less_than_the_first():
    """The whole reason the allocator is not a sort: a building's second measure
    treats exposure the first already removed."""
    a = cand("A", "roof", capex=(10_000, 10_000), ph=1_000,
             person_hours_at_risk=1_200)
    b = cand("A", "shading", capex=(10_000, 10_000), ph=800,
             person_hours_at_risk=1_200)
    alloc = PF.allocate([a, b], 100_000)
    assert len(alloc.selected) == 2
    first, second = alloc.marginal
    assert first == pytest.approx(1_000.0)
    # residual after the first = 1 - 1000/1200 = 1/6; 800 * 1/6 = 133.3
    assert second == pytest.approx(800.0 * (1.0 - 1_000.0 / 1_200.0))
    assert alloc.benefit_total < alloc.benefit_standalone
    # And the building can never be credited with more exposure than it has.
    assert alloc.benefit_total <= 1_200.0 + 1e-9


def test_interaction_total_does_not_depend_on_purchase_order():
    """The residual model is order-independent by construction, which is what
    makes the headline figure a property of the programme rather than of the
    search that found it."""
    a = cand("A", "roof", capex=(10_000, 10_000), ph=1_000,
             person_hours_at_risk=1_500)
    b = cand("A", "shading", capex=(9_000, 9_000), ph=900,
             person_hours_at_risk=1_500)
    forward = PF.allocate([a, b], 100_000).benefit_total
    reverse = PF.allocate([b, a], 100_000).benefit_total
    assert forward == pytest.approx(reverse)
    e = 1_500.0
    expected = e * (1 - (1 - 1_000 / e) * (1 - 900 / e))
    assert forward == pytest.approx(expected)


def test_independent_mode_sums_and_says_that_it_does():
    a = cand("A", "roof", capex=(10_000, 10_000), ph=1_000,
             person_hours_at_risk=1_200)
    b = cand("A", "shading", capex=(10_000, 10_000), ph=800,
             person_hours_at_risk=1_200)
    alloc = PF.allocate([a, b], 100_000, interaction="independent")
    assert alloc.benefit_total == pytest.approx(1_800.0)
    assert "double-counts" in alloc.method


def test_inferred_headroom_is_flagged_as_an_assumption():
    a = cand("A", "roof", capex=(10_000, 10_000), ph=1_000)
    b = cand("A", "shading", capex=(10_000, 10_000), ph=800)
    alloc = PF.allocate([a, b], 100_000)
    assert any("assumed ceiling" in n for n in alloc.notes)
    assert "assumed" in alloc.basis
    # headroom = 1000 / 0.6 = 1666.7, so the second measure keeps most of itself
    e = 1_000.0 / PF.SINGLE_MEASURE_CEILING
    assert alloc.marginal[1] == pytest.approx(800.0 * (1 - 1_000.0 / e))


# --------------------------------------------------------------- objectives


def test_vulnerable_is_person_hours_weighted_by_hvi():
    c = cand("A", ph=1_000, hvi=5)
    assert PF.benefit(c, "vulnerable") == pytest.approx(1_000.0)
    assert PF.benefit(cand("B", ph=1_000, hvi=1), "vulnerable") == pytest.approx(200.0)
    # The analyst's `or 1`: an unknown HVI is treated as the least vulnerable
    # quintile, so a missing join cannot look like urgency in a spending decision.
    assert PF.benefit(cand("C", ph=1_000, hvi=None), "vulnerable") == pytest.approx(200.0)


def test_degree_hours_recovers_the_analysts_avoided_figure():
    c = cand("A", ph=1_000, units=50)
    assert PF.benefit(c, "degree_hours") == pytest.approx(20.0)
    explicit = cand("B", ph=1_000, units=50, degree_hours_avoided=33.0)
    assert PF.benefit(explicit, "degree_hours") == pytest.approx(33.0)


def test_vulnerable_matches_the_analyst():
    """Cross-check against ``agent/analysis.allocate`` itself.

    ``allocate`` only ever touches ``d.ranked["items"]``, so a namespace with
    that one attribute is a sufficient stand-in for a Dataset. The rows are
    built so that the analyst's ``avoided`` collapses to ``facade_kh35`` (its
    ``per_unit_effect_k * hours_above_35`` cap is set far above it), which makes
    its ``person_hours`` exactly ``kh35 * units`` — the quantity the Candidate
    fixtures below carry. If either module's idea of "vulnerable" changes and
    the other's does not, the two orderings part and this fails.
    """
    AN = pytest.importorskip("heatcanyon.agent.analysis")

    spec = [("A", 40.0, 200, 1), ("B", 30.0, 60, 5),
            ("C", 35.0, 100, 3), ("D", 10.0, 300, 2)]
    rows = [{
        "bin": b, "addr": f"{b} Example Street", "units": u, "hvi": h,
        "year": 1950, "zip": "10018",
        "annual": {"facade_kh35": kh, "hours_above_35": 10_000.0},
        "modelled": {"facade_peak_c": 50.0}, "actions": [],
    } for b, kh, u, h in spec]
    d = SimpleNamespace(ranked={"items": rows})

    cands = [cand(b, "roof", capex=(10_000, 10_000), ph=kh * u, units=u, hvi=h)
             for b, kh, u, h in spec]

    for objective in ("person_hours", "vulnerable"):
        analyst = [r["bin"] for r in AN.allocate(
            d, budget=len(spec), objective=objective,
            per_unit_effect_k=3.0)["allocation"]]
        # Equal capex on every candidate, so cheapest-per-unit-benefit is the
        # same ordering as largest-benefit-first.
        mine = [c.bin for c in PF.curve(cands, objective=objective)]
        assert mine == analyst, objective


# --------------------------------------------------------------- constraints


def test_constraints_filter():
    pool = [
        cand("RES", ph=1_000, units=80, hvi=2, year_built=1930, zip="10018"),
        cand("OFFICE", ph=1_000, units=0, hvi=5, year_built=1930, zip="10018"),
        cand("NEW", ph=1_000, units=80, hvi=5, year_built=2005, zip="10036"),
        cand("UNKNOWN_YEAR", ph=1_000, units=80, hvi=5, year_built=None,
             zip="10018"),
    ]
    keep = lambda con: {c.bin for c in PF.curve(pool, constraint=con)}

    assert keep({"residential_only": True}) == {"RES", "NEW", "UNKNOWN_YEAR"}
    assert keep({"min_hvi": 5}) == {"OFFICE", "NEW", "UNKNOWN_YEAR"}
    # An unknown year is not "built before 1945": unknown must not pass a filter
    # whose whole purpose is to find old stock. This mirrors the analyst exactly.
    assert keep({"built_before": 1945}) == {"RES", "OFFICE"}
    assert keep({"zip": "10036"}) == {"NEW"}
    assert keep({"zip": 10036}) == {"NEW"}          # compared as strings
    assert keep({"residential_only": True, "built_before": 1945}) == {"RES"}
    assert keep({}) == {c.bin for c in pool}

    alloc = PF.allocate(pool, 10_000_000, constraint={"zip": "10036"})
    assert [c.bin for c in alloc.selected] == ["NEW"]
    assert alloc.considered == 4 and alloc.eligible == 1


# ------------------------------------------------------------ disagreement


def _agreeing() -> list[PF.Candidate]:
    """Same HVI everywhere, so 'vulnerable' is 'person_hours' times a constant
    and the two orderings cannot differ."""
    return [cand("A", capex=(50_000, 50_000), ph=5_000, units=80, hvi=3),
            cand("B", capex=(50_000, 50_000), ph=3_000, units=80, hvi=3),
            cand("C", capex=(50_000, 50_000), ph=1_000, units=80, hvi=3)]


def _opposed() -> list[PF.Candidate]:
    """A large, low-vulnerability building against a smaller, high-vulnerability
    one, at the same price and a budget that buys exactly one of them."""
    return [cand("TOWER", capex=(100_000, 100_000), ph=20_000, units=200, hvi=1),
            cand("WALKUP", capex=(100_000, 100_000), ph=12_000, units=60, hvi=5)]


def test_identical_orderings_report_full_overlap():
    dis = PF.compare_objectives(_agreeing(), 100_000,
                                ["person_hours", "vulnerable"])
    a, b = dis.allocations["person_hours"], dis.allocations["vulnerable"]
    assert a.keys == b.keys
    assert dis.overlap == len(a.selected) == 2
    assert dis.only_in["person_hours"] == [] and dis.only_in["vulnerable"] == []
    assert "same answer" in dis.reading


def test_opposed_objectives_report_the_disagreement():
    dis = PF.compare_objectives(_opposed(), 100_000,
                                ["person_hours", "vulnerable"])
    assert [c.bin for c in dis.allocations["person_hours"].selected] == ["TOWER"]
    assert [c.bin for c in dis.allocations["vulnerable"].selected] == ["WALKUP"]
    assert dis.overlap == 0
    assert [e["bin"] for e in dis.only_in["person_hours"]] == ["TOWER"]
    assert [e["bin"] for e in dis.only_in["vulnerable"]] == ["WALKUP"]
    # Which way each moved, on the full curve rather than inside the selection.
    moved = {e["bin"]: e["moved"] for e in dis.moved}
    assert moved["TOWER"] == 1 and moved["WALKUP"] == -1
    assert "different questions" in dis.reading
    assert "choosing" in dis.reading
    assert "assumed" in dis.basis


def test_compare_objectives_needs_two_and_covers_every_pair():
    with pytest.raises(ValueError):
        PF.compare_objectives(_opposed(), 100_000, ["person_hours"])
    dis = PF.compare_objectives(
        _opposed(), 100_000, ["person_hours", "vulnerable", "degree_hours"])
    assert [p["objectives"] for p in dis.pairs] == [
        ["person_hours", "vulnerable"],
        ["person_hours", "degree_hours"],
        ["vulnerable", "degree_hours"]]
    # The headline is the first pair, so a two-column interface has one answer.
    assert dis.reading == dis.pairs[0]["reading"]


# -------------------------------------------------------------------- phase


def test_phase_partitions_the_allocation_with_nothing_lost_or_duplicated(mixed):
    alloc = PF.allocate(mixed, 10_000_000)
    groups = PF.phase(alloc)
    flat = [c for group in groups.values() for c in group]
    assert len(flat) == len(alloc.selected)
    assert sorted(c.key for c in flat) == sorted(c.key for c in alloc.selected)
    assert len({c.key for c in flat}) == len(flat)
    for name, group in groups.items():
        assert all(c.lead_time == name for c in group)


def test_phase_keys_come_out_in_programme_order():
    """Sorted by when it can start, not by what it is worth: the capital-cycle
    measure here is the largest single benefit and still comes last."""
    pool = [cand("A", capex=(1_000, 1_000), ph=100, lead="capital cycle"),
            cand("B", capex=(1_000, 1_000), ph=90, lead="this season"),
            cand("C", capex=(1_000, 1_000), ph=80, lead="one year"),
            cand("D", capex=(1_000, 1_000), ph=70, lead="when the block is dug up")]
    groups = PF.phase(PF.allocate(pool, 100_000))
    assert list(groups) == ["this season", "one year", "capital cycle",
                            "when the block is dug up"]
    summary = PF.phase_summary(PF.allocate(pool, 100_000))
    assert [s["lead_time"] for s in summary] == list(groups)
    assert sum(s["measures"] for s in summary) == 4


# ------------------------------------------------------------------- ledger


def test_ledger_states_the_budget_the_count_and_its_basis(mixed):
    alloc = PF.allocate(mixed, 500_000)
    text = PF.ledger(alloc)
    assert PF._usd(500_000) in text
    assert PF._plural(alloc.buildings, "building") in text
    assert "assumed" in text
    assert f"{alloc.person_hours_avoided:,.0f} person-hours" in text
    assert "35 °C" in text


def test_ledger_gives_ranges_where_the_input_carried_one(mixed):
    alloc = PF.allocate(mixed, 500_000)
    text = PF.ledger(alloc, tariff_usd_kwh=(0.22, 0.30), household_size=(2.1, 2.6))
    assert "–" in text                       # an en dash, from a rendered range
    assert PF._usd_range(alloc.capex_usd) in text
    assert "0.220–0.300 $/kWh" in text
    assert "pays back" in text
    # A midpoint anywhere in this paragraph would be a contract violation.
    assert "2.1–2.6" in text


def test_ledger_on_an_empty_programme_says_why_rather_than_nothing(mixed):
    text = PF.ledger(PF.allocate(mixed, 1_000))
    assert "0 buildings" in text          # _plural, not a bare count
    assert "assumed" in text
    assert "nothing" in text


def test_ledger_reports_the_interaction_it_applied():
    pool = [cand("A", "roof", capex=(10_000, 10_000), ph=1_000,
                 person_hours_at_risk=1_200),
            cand("A", "shading", capex=(10_000, 10_000), ph=800,
                 person_hours_at_risk=1_200)]
    text = PF.ledger(PF.allocate(pool, 100_000))
    assert "leaves behind" in text
    assert "double-counted" in text


# ------------------------------------------------------------ sibling guard


def test_missing_economics_gives_a_sentence_not_a_traceback(monkeypatch):
    """``economics.py`` may legitimately not be in a build. Its absence must
    degrade one clause of one paragraph, not break the module.

    Patching ``builtins.__import__`` alone is not enough and it is worth saying
    why, because the first version of this test passed for the wrong reason and
    then started failing for the right one. ``from . import economics`` consults
    ``sys.modules`` before it consults the import machinery, so once economics
    exists and has been imported once — which it now has, by every other test in
    the session — the hook never fires and the guard is never exercised. The
    entry has to be removed for the duration as well.
    """
    import sys
    import heatcanyon

    # Removing the module takes TWO deletions, and the first version of this
    # test did neither of them properly. `from . import economics` calls
    # `__import__("", ..., fromlist=("economics",))` — an EMPTY name — so a hook
    # that inspects the name for the string "economics" never fires, which is
    # why patching `builtins.__import__` looked like it worked and did nothing.
    # And the statement resolves through `getattr(heatcanyon, "economics")`,
    # which the first successful import sets on the package, so clearing
    # `sys.modules` alone still finds it.
    #
    # `raising=False` on both because a build that genuinely lacks economics has
    # neither to delete, and this test has to pass in that build too — which is
    # the only build where the guard it checks is load-bearing.
    monkeypatch.delitem(sys.modules, "heatcanyon.economics", raising=False)
    monkeypatch.delattr(heatcanyon, "economics", raising=False)
    monkeypatch.setattr(
        sys, "path_importer_cache", dict(sys.path_importer_cache), raising=False)

    # With both gone the import machinery goes looking for the file, which is
    # still on disk in a full build — so the absence is simulated at the finder
    # by blocking the module name outright.
    class Blocked:
        @staticmethod
        def find_spec(name, path=None, target=None):
            if name == "heatcanyon.economics":
                raise ImportError("no economics")
            return None

    monkeypatch.setattr(sys, "meta_path", [Blocked] + list(sys.meta_path))

    with pytest.raises(ImportError, match="docs/DECISIONS.md"):
        PF.economics_module()
    r, src = PF._economics_range("electricity_usd_kwh", PF.ASSUMED_TARIFF_USD_KWH)
    assert r == PF.ASSUMED_TARIFF_USD_KWH
    assert "assumed" in src

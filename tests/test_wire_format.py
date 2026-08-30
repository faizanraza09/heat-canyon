"""The JSON the browser actually receives, against the contract it was built to.

WHY THIS FILE EXISTS

Every other Python test in this suite checks objects. `test_loads.py` asserts
that a `FloorLoad` carries a `t_indoor_free_c` range; `test_prescribe.py`
asserts that a `Prescription` names what it does not fix. All of them passed
while the interface rendered `undefined` on every floor number, an em dash on
every indoor estimate, `NaN` against a `-999` sentinel in the what-if bars, and
"WORST FLOOR — UNDEFINED".

The cause was one line. `decide.prescriptions_for` handed `BuildingLoads` to a
generic serialiser, which emitted the dataclass's own field names — `floor`,
`t_surface_peak_c`, `dominant` — while `docs/DECISIONS.md` section 7 specifies
`f`, `t_surf`, `dom`, and the four interface modules were built against the
contract. Nothing threw. Nothing failed. The schedule rendered confidently and
wrongly in the reader's own typeface, which is the worst way for a number to be
wrong in a project whose whole claim is that its numbers are traceable.

So this file tests the WIRE FORMAT: the keys, the shapes and the ranges of the
products as they sit on disk. It is deliberately dumb — it knows nothing about
physics and asserts no value — because the failure it exists to catch is a
translation failure, and a translation failure is invisible to anything that
inspects the objects on either side of it.

It skips when a product is absent, because a build without the decision layer is
supported.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

DATA = Path("web/data")


def _load(name: str):
    f = DATA / name
    if not f.exists():
        pytest.skip(f"{name} not in this build")
    return json.loads(f.read_text())


def _is_range(v) -> bool:
    """A two-element numeric list, which is how every assumed figure ships."""
    return (isinstance(v, list) and len(v) == 2
            and all(isinstance(x, (int, float)) for x in v))


@pytest.fixture(scope="module")
def floors():
    return _load("floors.json")


# ------------------------------------------------------------------- floors


def test_floors_carries_the_keys_the_contract_states(floors):
    """Section 7's key set, exactly. Extra keys are fine; missing ones are not.

    Written as a set difference rather than an equality so the products can grow
    without this failing, which is the behaviour that keeps a format test from
    becoming the thing everyone edits to make the build pass.
    """
    items = floors.get("items") or {}
    assert items, "floors.json has no buildings in it"

    want_building = {"assembly", "occupancy", "peak_kw", "annual_mwh",
                     "peak_hour_edt", "worst_floor", "person_hours", "floors"}
    want_floor = {"f", "band", "z_lo", "z_hi", "storeys", "envelope_m2",
                  "peak_w", "annual_kwh", "t_surf", "t_in", "solar", "trap",
                  "sky", "dom", "rec", "hrs", "ph", "sev", "faces"}
    want_face = {"az", "c", "m2", "t", "hr", "w", "solar", "trap", "sunh", "wss"}

    for bin_, rec in items.items():
        assert not (want_building - set(rec)), \
            f"{bin_} is missing {sorted(want_building - set(rec))}"
        assert rec["floors"], f"{bin_} has an empty schedule"
        for fl in rec["floors"]:
            assert not (want_floor - set(fl)), \
                f"{bin_} floor {fl.get('f')} is missing {sorted(want_floor - set(fl))}"
            for fa in fl["faces"]:
                assert not (want_face - set(fa)), \
                    f"{bin_} face is missing {sorted(want_face - set(fa))}"


def test_nothing_in_the_schedule_renders_as_undefined(floors):
    """Every field the interface prints has to be a value, not a hole.

    This is the assertion that would have caught it. `undefined` in a pane comes
    from reading a key that is not there, and the only way to see that from
    Python is to check the same keys the renderer reads and require them to hold
    something printable.
    """
    for bin_, rec in (floors.get("items") or {}).items():
        assert isinstance(rec["worst_floor"], int) and rec["worst_floor"] > 0
        assert isinstance(rec["peak_hour_edt"], int)
        assert isinstance(rec["person_hours"], (int, float))
        for fl in rec["floors"]:
            assert isinstance(fl["f"], int) and fl["f"] > 0, \
                f"{bin_}: a floor has no number, which renders as 'undefined'"
            assert isinstance(fl["t_surf"], (int, float))
            assert fl["dom"] in ("solar", "trap", "ambient")
            assert fl["rec"] in ("good", "limited", "none")
            assert isinstance(fl["sev"], int) and 0 <= fl["sev"] <= 4
            for fa in fl["faces"]:
                assert isinstance(fa["c"], str) and fa["c"]
                assert isinstance(fa["t"], (int, float))
                assert isinstance(fa["hr"], int)


def test_every_assumed_figure_is_still_a_range_on_the_wire(floors):
    """The layer's one non-negotiable property, checked where it can be lost.

    `test_loads.py` already asserts the objects carry ranges. A serialiser is
    the place a range becomes a midpoint without anyone noticing, so it is
    asserted again on the other side of one.
    """
    for bin_, rec in (floors.get("items") or {}).items():
        for k in ("peak_kw", "annual_mwh"):
            assert _is_range(rec[k]), f"{bin_}.{k} is not a two-ended range"
        for k in ("u_wall", "wwr", "shgc"):
            assert _is_range(rec["assembly"][k]), f"{bin_}.assembly.{k}"
        for fl in rec["floors"]:
            for k in ("peak_w", "annual_kwh", "t_in"):
                assert _is_range(fl[k]), f"{bin_} floor {fl['f']} {k}"
            for fa in fl["faces"]:
                assert _is_range(fa["w"]), f"{bin_} face {fa['c']} w"


def test_the_schedule_covers_every_storey_once(floors):
    """Floor numbers run 1..n with no gaps and no repeats.

    A gap renders as a missing row nobody notices; a repeat renders as two rows
    for one storey, which is how a building's load gets double-counted in a
    portfolio.
    """
    for bin_, rec in (floors.get("items") or {}).items():
        nums = [fl["f"] for fl in rec["floors"]]
        assert nums == sorted(nums), f"{bin_}: floors are not in order"
        assert len(set(nums)) == len(nums), f"{bin_}: a storey appears twice"
        assert nums[0] == 1, f"{bin_}: schedule does not start at floor 1"
        assert nums == list(range(1, len(nums) + 1)), f"{bin_}: a storey is missing"


def test_bands_are_monotone_with_height(floors):
    """A floor higher up never sits in a lower solved band.

    The band mapping is what ties a storey to the physics, and it is the one
    piece of arithmetic in the serialiser that could silently invert.
    """
    for bin_, rec in (floors.get("items") or {}).items():
        bands = [fl["band"] for fl in rec["floors"]]
        assert bands == sorted(bands), f"{bin_}: band does not rise with floor"
        assert min(bands) >= 0 and max(bands) < floors["bands"]


# ------------------------------------------------------------ prescriptions


def test_prescriptions_carry_what_the_interface_reads():
    doc = _load("prescriptions.json")
    items = doc.get("items") or {}
    assert items
    want = {"key", "title", "family", "faces", "floors", "device", "geometry",
            "area_m2", "why", "does_not_fix", "also_consider", "confidence",
            "lead_time"}
    for bin_, pres in items.items():
        for p in pres:
            assert not (want - set(p)), \
                f"{bin_}/{p.get('key')} missing {sorted(want - set(p))}"
            assert len(p["floors"]) == 2 and p["floors"][0] <= p["floors"][1]
            assert p["why"], f"{bin_}/{p['key']} has no rationale"
            # A measure with no effect must say why rather than being silent;
            # a silent one reads as an effect of zero.
            assert p.get("effect") is not None or p.get("effect_note")
            money = p.get("money")
            if money is not None:
                for k in ("capex_usd", "energy_usd_yr", "carbon_t_yr"):
                    assert _is_range(money[k]), f"{bin_}/{p['key']} money.{k}"


def test_a_priced_measure_states_what_its_price_rests_on():
    doc = _load("prescriptions.json")
    assert isinstance(doc.get("unverified"), int)
    assert doc.get("constants_as_of")
    priced = [p for pres in doc["items"].values() for p in pres if p.get("money")]
    assert priced, "nothing is priced, so the portfolio will be empty"
    for p in priced:
        assert "assumed" in (p["money"].get("basis") or "").lower(), \
            f"{p['key']} prices without saying the figure is assumed"


# ---------------------------------------------------------------- portfolio


def test_portfolio_candidates_are_orderable_and_attributable():
    doc = _load("portfolio.json")
    cands = doc.get("candidates") or []
    assert cands, "no priced candidates, so there is no programme to allocate"
    for c in cands[:200]:
        assert c.get("bin"), "a candidate with no building cannot be acted on"
        assert c.get("measure")
        assert _is_range(c["capex"]), f"{c['bin']} capex is not a range"
        # None is allowed and means "this measure avoids nothing, so cost per
        # avoided hour is undefined". A number is not: a zero or a negative one
        # sorts arbitrarily and would place a useless measure at the head of the
        # curve. `test_a_benefit_is_never_negative_on_the_wire` requires most
        # candidates to be orderable.
        u = c["usd_per_person_hour"]
        assert u is None or (isinstance(u, (int, float)) and u > 0), \
            f"{c['bin']}/{c['measure']} has an unsortable ordering key: {u!r}"
        assert c.get("lead_time") in ("this season", "one year", "capital cycle")


def test_no_product_in_the_build_is_a_fixture():
    """The same guard `validate` applies, kept here so pytest alone catches it."""
    for name in ("floors.json", "prescriptions.json", "portfolio.json"):
        f = DATA / name
        if f.exists():
            assert json.loads(f.read_text()).get("fixture") is not True, (
                f"{name} is placeholder data from "
                f"scripts/make_decision_fixtures.py. Re-run the build.")


def test_the_products_are_strictly_valid_json():
    """No `Infinity`, no `NaN`. Python writes them; `JSON.parse` rejects them.

    `json.dumps` emits bare `Infinity` and `NaN` by default. Both are legal
    Python and neither is legal JSON, so a browser rejects the WHOLE FILE rather
    than the field — `portfolio.json` was reported as absent from the build
    while 769 rows sat on disk, and the panel showed an empty programme instead
    of a parse error.

    Both writers now pass `allow_nan=False`, so this should be impossible. It is
    asserted anyway: the failure was silent, expensive to find, and costs one
    substring search to rule out.
    """
    for name in ("floors.json", "prescriptions.json", "portfolio.json"):
        f = DATA / name
        if not f.exists():
            continue
        raw = f.read_text()
        for token in ("Infinity", "NaN"):
            assert token not in raw, (
                f"{name} contains bare {token}, which is not JSON. Every browser "
                f"will reject the entire file and report it as missing.")
        json.loads(raw, parse_constant=_reject)


def _reject(v):
    raise AssertionError(f"non-JSON constant {v!r} in a shipped product")


def test_a_benefit_is_never_negative_on_the_wire():
    """The portfolio orders on benefits, and a benefit below zero cannot sort.

    `prescribe.Effect` carries signed CHANGES — a measure that removes exposure
    reports a negative `d_person_hours`. `portfolio.Candidate` carries
    BENEFITS. Handing one to the other unreconciled turned 726 of 769
    candidates negative, sent every ordering key to infinity, and produced a
    programme that reported avoiding minus half a million person-hours.
    """
    doc = _load("portfolio.json")
    cands = doc.get("candidates") or []
    assert cands
    bad = [c for c in cands if (c.get("person_hours_avoided") or 0) < 0]
    assert not bad, (
        f"{len(bad)} candidates carry a negative benefit — the sign convention "
        f"between prescribe and portfolio is unreconciled. First: "
        f"{bad[0]['bin']}/{bad[0]['measure']}")
    orderable = [c for c in cands if c.get("usd_per_person_hour")]
    assert len(orderable) > 0.8 * len(cands), (
        f"only {len(orderable)} of {len(cands)} candidates have an ordering "
        f"key; the cost curve cannot be drawn from the rest")


def test_the_portfolio_ships_an_order_per_objective():
    """`curves`, not `curve`. The panel reads the plural and compares two.

    Writing only the single ordered `curve` for one objective cost the whole
    comparison: the panel found no `curves` key, reported "0 objectives", and
    had nothing to disagree about — which is the one thing that view exists for.
    """
    doc = _load("portfolio.json")
    curves = doc.get("curves") or {}
    assert curves, "portfolio.json has no `curves`; see docs/DECISIONS.md section 7"
    n = len(doc.get("candidates") or [])
    for name, order in curves.items():
        assert isinstance(order, list) and order, f"curve {name} is empty"
        assert all(isinstance(i, int) and 0 <= i < n for i in order), \
            f"curve {name} holds something other than candidate indices"
        assert len(set(order)) == len(order), f"curve {name} repeats a candidate"
    assert len(curves) >= 2, \
        "at least two objectives are needed for the panel to show a disagreement"

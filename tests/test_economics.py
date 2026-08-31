"""The arithmetic and the labelling of ``heatcanyon.economics``.

Two different things are under test here and they are worth naming separately.

The first is the interval arithmetic. Every figure the decision layer publishes
is a range, and the rule the contract states is that nothing may narrow one: a
wider input must produce a wider output. That property is easy to break by
accident — a single ``sum(x) / 2`` anywhere in the chain silently collapses a
range to a midpoint and nothing downstream would notice, because the result
would still be a plausible number in a plausible unit. So it is asserted
directly, on nested input intervals, rather than inferred from spot values.

The second is the labelling. A constant with an empty ``source`` or an
unparseable ``as_of`` is worse than a missing constant, because the interface
renders it as though it were sourced. Those are asserted over the whole table,
so a constant added later cannot skip them.

``payback_yr is None`` gets its own test because it is the one place where the
honest answer is an absence. A measure whose winter heating penalty outweighs
its summer saving does not pay back, and the module must say so rather than
return a large number that a reader scanning a column would mistake for a long
but finite payback.
"""
from __future__ import annotations

from datetime import date

import pytest

from heatcanyon import economics as E


# ------------------------------------------------------------------ helpers


def _width(interval) -> float:
    return interval[1] - interval[0]


def _money(**over):
    """A realistic base case, overridable field by field.

    External shading on a mid-block Midtown facade: the case worked by hand in
    the module's own commentary, so a change that breaks it is visible against a
    number a person checked.
    """
    kwargs = dict(
        measure_key="external_shading",
        area_m2=1240.0,
        # THERMAL, which is what `prescribe.Effect` reports and what `price`
        # divides by `cooling_cop`. The peak figure used to be 4.0 kW, which is
        # seven to twenty-five times too small for 1,240 m2 of treated facade:
        # real fixed-shading measures in the build save 25 to 86 kW over an area
        # like this. Demand is the larger half of the saving on SC-9, so a
        # starved peak made the whole worked case look unpayable and the guard
        # below fire for a reason that was in the fixture rather than the table.
        # Both figures are now anchored on the 1,072 m2 case in the real build.
        kwh_saved_yr=22_000.0,
        kw_peak_saved=34.0,
        occupancy="office",
    )
    kwargs.update(over)
    return E.price(**kwargs)


# ------------------------------------------------- ranges must never narrow


def test_wider_input_range_gives_wider_output_range():
    """The contract's rule, asserted on every output that carries a range.

    The narrow case is a point estimate and the wide case brackets it, so the
    wide output must bracket the narrow output as well as being wider. Testing
    only the widths would let a shifted-but-wider interval pass.
    """
    narrow = _money(kwh_saved_yr=11_000.0, kw_peak_saved=4.0)
    wide = _money(kwh_saved_yr=(8_000.0, 14_000.0), kw_peak_saved=(3.0, 5.0))

    for fieldname in ("energy_usd_yr", "demand_usd_yr", "carbon_t_yr",
                      "ll97_usd_yr", "annual_saving_usd", "npv_usd"):
        n = getattr(narrow, fieldname)
        w = getattr(wide, fieldname)
        assert _width(w) > _width(n), f"{fieldname} narrowed"
        assert w[0] <= n[0] + 1e-9 and w[1] >= n[1] - 1e-9, (
            f"{fieldname} does not bracket the point case")


def test_wider_area_widens_capex_and_payback():
    """Capex and payback take their spread from a different input, so they need
    their own case: a range on the treated area rather than on the saving."""
    narrow = _money(area_m2=1240.0)
    wide = _money(area_m2=(1000.0, 1500.0))

    assert _width(wide.capex_usd) > _width(narrow.capex_usd)
    assert narrow.payback_yr is not None and wide.payback_yr is not None
    assert _width(wide.payback_yr) > _width(narrow.payback_yr)


def test_a_point_input_still_returns_a_range():
    """A scalar input must not produce a scalar output. The spread of the
    constants table survives even when the physics hands over a single number,
    and that is the whole reason the table is ranged."""
    m = _money(kwh_saved_yr=11_000.0, kw_peak_saved=4.0, area_m2=1240.0)
    assert _width(m.energy_usd_yr) > 0
    assert _width(m.demand_usd_yr) > 0
    assert _width(m.capex_usd) > 0


# ------------------------------------------------------ payback and its absence


def test_payback_is_none_when_the_measure_loses_money():
    """A net winter heating penalty with no peak relief: the saving is negative
    at both ends and the measure never pays back."""
    m = _money(kwh_saved_yr=-4_000.0, kw_peak_saved=0.0)
    assert m.annual_saving_usd[1] <= 0.0
    assert m.payback_yr is None


def test_payback_is_none_when_the_saving_is_exactly_zero():
    m = _money(kwh_saved_yr=0.0, kw_peak_saved=0.0)
    assert m.annual_saving_usd == (0.0, 0.0)
    assert m.payback_yr is None


def test_payback_is_none_when_the_saving_straddles_zero():
    """The pessimistic end of the range does not pay back, so no payback is
    reported. Quoting the optimistic end alone would hide the disagreement."""
    m = _money(kwh_saved_yr=(-3_000.0, 9_000.0), kw_peak_saved=0.0)
    assert m.annual_saving_usd[0] < 0 < m.annual_saving_usd[1]
    assert m.payback_yr is None


def test_every_interval_price_returns_is_ordered():
    """No pair may come back with its high end below its low end.

    Written because two separate bugs in the winter-penalty work produced
    inverted pairs and nothing here noticed. `_mul` ends on `(min(c), max(c))`
    and every other helper orders its result, but the net saving is built by
    subtracting PER CORNER — the summer benefit and the winter penalty are
    driven by the same solar figure at the same corner of the assembly table, so
    crossing them prices two different assemblies at once — and a per-corner
    subtraction does not preserve ordering on its own.
    """
    cases = [
        {},
        dict(winter_kwh_thermal=40_000.0),
        # The pathological one: a winter penalty that grows faster between the
        # corners than the benefit does, which inverts a naive per-corner net.
        dict(kwh_saved_yr=(20_000.0, 24_000.0), kw_peak_saved=(30.0, 32.0),
             winter_kwh_thermal=(1_000.0, 400_000.0)),
        dict(kwh_saved_yr=(-3_000.0, 9_000.0), kw_peak_saved=0.0),
    ]
    for over in cases:
        m = _money(**over)
        for name in ("energy_usd_yr", "demand_usd_yr", "carbon_t_yr",
                     "ll97_usd_yr", "capex_usd", "npv_usd", "winter_usd_yr",
                     "annual_saving_usd", "measure_life_years", "discount_rate"):
            lo, hi = getattr(m, name)
            assert lo <= hi, f"{name} inverted on {over}: ({lo}, {hi})"
        if m.payback_yr is not None:
            lo, hi = m.payback_yr
            assert 0.0 < lo <= hi, f"payback inverted or negative on {over}"


def test_the_winter_penalty_is_not_crossed_against_the_summer_saving():
    """A correlated term must be subtracted corner by corner, not crossed.

    Both halves come from the same transmitted-solar figure at the same corner
    of the assembly table, so the pessimistic net is the low corner's benefit
    less the low corner's OWN penalty. Crossing them — lowest benefit against
    highest penalty, which is what interval subtraction does for independent
    quantities — pairs the low corner of an assembly with the high corner of the
    same assembly, and reported that a glazing swap never pays back where the
    per-corner arithmetic gives twelve to three hundred and forty years.
    """
    kwh = (200_000.0, 900_000.0)
    kw = (500.0, 2_000.0)
    win = (200_000.0, 700_000.0)
    m = _money(kwh_saved_yr=kwh, kw_peak_saved=kw, winter_kwh_thermal=win)
    corner_lo = (m.energy_usd_yr[0] + m.demand_usd_yr[0] + m.ll97_usd_yr[0]
                 - m.winter_usd_yr[0])
    corner_hi = (m.energy_usd_yr[1] + m.demand_usd_yr[1] + m.ll97_usd_yr[1]
                 - m.winter_usd_yr[1])
    assert m.annual_saving_usd == pytest.approx((min(corner_lo, corner_hi),
                                                max(corner_lo, corner_hi)))
    # And the crossed form, which is what this must NOT be.
    crossed = m.energy_usd_yr[0] + m.demand_usd_yr[0] + m.ll97_usd_yr[0] \
        - m.winter_usd_yr[1]
    assert m.annual_saving_usd[0] > crossed


def test_the_winter_penalty_is_only_charged_when_asked_for():
    """A measure with no heating-season figure is priced on its summer side, and
    its penalty reads zero rather than being invented."""
    m = _money()
    assert m.winter_usd_yr == (0.0, 0.0)
    n = _money(winter_kwh_thermal=50_000.0)
    assert n.winter_usd_yr[1] > 0
    assert n.annual_saving_usd[1] < m.annual_saving_usd[1]


def test_cooling_load_is_divided_by_the_cop_before_it_is_priced():
    """`loads.py` reports heat moved; the tariff bills electricity.

    Guards the division that was missing for the whole life of this table, and
    guards its DIRECTION: a higher coefficient of performance means less
    electricity for the same heat and therefore a smaller saving, so the
    optimistic end of the benefit pairs the high thermal figure with the LOW COP.
    """
    m = _money(kwh_saved_yr=10_000.0, kw_peak_saved=0.0)
    e_lo, e_hi = E.CONSTANTS["electricity_usd_kwh"].pair
    cop_lo, cop_hi = E.CONSTANTS["cooling_cop"].pair
    assert cop_lo > 1.0, "a COP at or below one would make the division a no-op"
    assert m.energy_usd_yr == pytest.approx(
        (10_000.0 / cop_hi * e_lo, 10_000.0 / cop_lo * e_hi))


def test_payback_is_a_plausible_number_when_it_exists():
    """A payback under a year, or beyond three centuries, means the capex band or
    the tariff is wrong rather than the measure being remarkable.

    THE UPPER BOUND WAS 200 AND IS NOW 300, WHICH IS A REAL LOOSENING AND IS
    WHY IT IS ARGUED FOR HERE.

    Two constants joined the stack: `cooling_cop`, without which a thermal
    kilowatt-hour was priced at an electrical tariff, and
    `heating_usd_kwh_thermal`, without which a solar-control measure's January
    was described and never costed. Both are honest and both are ranges, and
    the pessimistic end of a payback is now the product of six independent worst
    cases — least load, highest coefficient of performance, cheapest
    electricity, dearest heat, most winter dose, highest capex. `price` says in
    its own docstring that ranges propagate and nothing collapses to a midpoint,
    so that corner is the contract working; it is also a corner no real building
    occupies, and every constant added to the table widens it multiplicatively.

    So this guard is still worth having and its old calibration was not
    survivable. The optimistic end is asserted tightly, because that is the end
    an error in the capex band or the tariff shows up in first.
    """
    m = _money()
    assert m.payback_yr is not None
    assert 1.0 < m.payback_yr[0] < 60.0, "optimistic end implies a wrong band"
    assert m.payback_yr[0] < m.payback_yr[1] < 300.0


# ------------------------------------------------------------ linearity in kWh


def test_carbon_scales_linearly_with_kwh():
    a = _money(kwh_saved_yr=10_000.0)
    b = _money(kwh_saved_yr=30_000.0)
    for i in (0, 1):
        assert b.carbon_t_yr[i] == pytest.approx(3.0 * a.carbon_t_yr[i], rel=1e-12)


def test_ll97_penalty_avoided_scales_linearly_with_kwh():
    a = _money(kwh_saved_yr=10_000.0)
    b = _money(kwh_saved_yr=30_000.0)
    for i in (0, 1):
        assert b.ll97_usd_yr[i] == pytest.approx(3.0 * a.ll97_usd_yr[i], rel=1e-12)


def test_carbon_and_ll97_go_negative_with_a_negative_saving():
    """A measure that costs energy costs carbon too. Clamping at zero would let
    a heating penalty look free."""
    m = _money(kwh_saved_yr=-5_000.0)
    assert m.carbon_t_yr[1] < 0
    assert m.ll97_usd_yr[1] < 0


def test_demand_is_priced_on_four_summer_months_not_twelve():
    """The demand charge is the half a peak-shaving measure moves, and the
    tariff charges the summer rate for June through September only.

    The COP appears in the expected value because `kw_peak_saved` is a THERMAL
    kilowatt and the tariff bills an electrical one. Crossed endpoints: the low
    end of the saving is the thermal figure over the HIGH coefficient of
    performance. What this test is actually guarding is the 4 rather than a 12,
    and that is unchanged.
    """
    m = _money(kw_peak_saved=4.0, kwh_saved_yr=0.0)
    lo, hi = E.CONSTANTS["demand_usd_kw_month"].pair
    cop_lo, cop_hi = E.CONSTANTS["cooling_cop"].pair
    assert m.demand_usd_yr == pytest.approx(
        (4.0 / cop_hi * lo * 4.0, 4.0 / cop_lo * hi * 4.0))


def test_demand_and_energy_are_never_folded_together():
    """The energy rate must be the volumetric one. If it had been set to an
    all-in average retail price the demand charge would be double-counted, so
    the two constants are asserted to be different numbers."""
    volumetric = E.CONSTANTS["electricity_usd_kwh"].pair
    all_in = E.CONSTANTS["electricity_all_in_usd_kwh"].pair
    assert volumetric[1] < all_in[0], (
        "the volumetric rate must sit strictly below the all-in average, "
        "otherwise the demand charge is being counted twice")


# -------------------------------------------------------------------- the NPV


def test_npv_is_negative_when_capex_exceeds_discounted_savings():
    """A large treated area for a trivial saving. Over any lifetime in the table
    the discounted saving cannot approach the capex, so the NPV is negative at
    both ends."""
    m = _money(area_m2=5_000.0, kwh_saved_yr=200.0, kw_peak_saved=0.05)
    assert m.npv_usd[1] < 0.0


def test_npv_is_positive_when_the_saving_is_large_against_the_capex():
    m = _money(area_m2=50.0, kwh_saved_yr=60_000.0, kw_peak_saved=30.0)
    assert m.npv_usd[0] > 0.0


def test_npv_never_exceeds_the_undiscounted_saving_over_the_life():
    """Discounting must reduce, not inflate. Catches a sign error in the annuity
    factor that a spot value would not."""
    m = _money()
    undiscounted = m.annual_saving_usd[1] * m.measure_life_years[1] - m.capex_usd[0]
    assert m.npv_usd[1] <= undiscounted + 1e-6


def test_annuity_factor_matches_the_textbook_value():
    """Ten years at five per cent: 7.7217. Written out because the module
    defines the discounting convention (end-of-period, no escalation) and a
    convention change should break a test, not slide through."""
    assert E._annuity_factor(0.05, 10) == pytest.approx(7.7217349, rel=1e-6)
    assert E._annuity_factor(0.0, 10) == pytest.approx(10.0)
    assert E._annuity_factor(0.05, 0) == 0.0


# ------------------------------------------------------------- the basis line


def test_basis_states_the_assumption_and_the_oldest_date():
    m = _money()
    assert "assumed" in m.basis
    oldest = min(E.CONSTANTS[k].as_of for k in m.constants_used)
    assert oldest in m.basis
    date.fromisoformat(oldest)


def test_basis_names_the_unverified_constants_it_leaned_on():
    m = _money()
    assert set(m.unverified_used) <= set(m.constants_used)
    for key in m.unverified_used:
        assert not E.CONSTANTS[key].verified


# ------------------------------------------------------------- the table itself


def test_constants_table_reports_the_unverified_count():
    rows = E.constants_table()
    counted = sum(1 for r in rows if not r["verified"])
    assert counted == E.unverified_count()
    assert counted == sum(1 for c in E.CONSTANTS.values() if not c.verified)
    assert 0 < counted <= len(rows)


def test_constants_table_covers_every_constant_exactly_once():
    rows = E.constants_table()
    keys = [r["key"] for r in rows]
    assert sorted(keys) == sorted(E.CONSTANTS)
    assert len(keys) == len(set(keys))


def test_every_constant_has_a_source_and_a_parseable_iso_date():
    for key, c in E.CONSTANTS.items():
        assert c.source.strip(), f"{key} has no source"
        assert c.unit.strip(), f"{key} has no unit"
        date.fromisoformat(c.as_of)  # raises if not ISO
        assert c.as_of <= "2026-12-31", f"{key} is dated in the future"


def test_every_unverified_constant_says_what_needs_checking():
    """The contract requires a ``# TODO: verify`` marker naming exactly what to
    check. It lives in the note so it survives serialisation to the interface,
    where the reader who has to act on it actually is."""
    for key, c in E.CONSTANTS.items():
        if not c.verified:
            assert "TODO: verify" in c.note, f"{key} is unverified but says nothing"


def test_every_verified_constant_cites_something_specific():
    """A verified constant must name a document, not a topic."""
    for key, c in E.CONSTANTS.items():
        if c.verified:
            assert len(c.source) > 40, f"{key} claims verification on a thin source"
            assert "No citable figure" not in c.source


def test_table_rows_are_json_ready():
    for r in E.constants_table():
        assert isinstance(r["value"], (float, list))
        if isinstance(r["value"], list):
            assert len(r["value"]) == 2 and r["value"][0] <= r["value"][1]
        assert isinstance(r["verified"], bool)


def test_as_of_is_the_oldest_constant_in_the_table():
    assert E.as_of() == min(c.as_of for c in E.CONSTANTS.values())


# --------------------------------------------------- catalogue completeness


def test_every_measure_has_a_capex_band_and_a_lifetime():
    """Priced measures are enumerated explicitly, so a measure added to
    MEASURE_KEYS without its two constants fails here rather than pricing at
    zero somewhere in the portfolio."""
    for key in E.MEASURE_KEYS:
        assert f"capex_usd_m2_{key}" in E.CONSTANTS
        assert f"measure_life_years_{key}" in E.CONSTANTS


def test_every_measure_can_be_priced_for_every_occupancy():
    for key in E.MEASURE_KEYS:
        for occ in ("residential", "office", "retail", "other"):
            m = E.price(measure_key=key, area_m2=500.0, kwh_saved_yr=8_000.0,
                        kw_peak_saved=3.0, occupancy=occ)
            assert m.capex_usd[0] > 0
            assert m.ll97_cap_kg_co2e_sf is not None


def test_an_unknown_measure_raises_rather_than_pricing_at_zero():
    with pytest.raises(KeyError):
        E.price(measure_key="teleportation", area_m2=100.0, kwh_saved_yr=1.0,
                kw_peak_saved=1.0, occupancy="office")


def test_an_unknown_occupancy_falls_back_to_the_stated_default():
    """Unknown occupancy is common — PLUTO's land-use field is often blank — so
    it must not raise. It falls back to the 'other' cap, which is itself flagged
    unverified precisely because it is a stand-in."""
    m = E.price(measure_key="cool_roof", area_m2=400.0, kwh_saved_yr=5_000.0,
                kw_peak_saved=2.0, occupancy="warehouse-of-unusual-size")
    assert m.ll97_cap_kg_co2e_sf == E.CONSTANTS["ll97_cap_kg_co2e_sf_other"].pair[0]
    assert "ll97_cap_kg_co2e_sf_other" in m.unverified_used


def test_occupancy_accepts_an_object_with_a_key():
    """``envelope.Occupancy`` is passed straight through by ``prescribe.py``, but
    this module must not import it: the constants table has to stand alone."""
    class FakeOccupancy:
        key = "residential"

    m = E.price(measure_key="window_film", area_m2=200.0, kwh_saved_yr=4_000.0,
                kw_peak_saved=1.5, occupancy=FakeOccupancy())
    assert m.ll97_cap_kg_co2e_sf == pytest.approx(6.75)


# ------------------------------------------------------- Local Law 97 specifics


def test_ll97_caps_are_the_first_compliance_period_values():
    """The one constant where staleness would be actively damaging. These are
    the 2024-2029 limits from 28-320.3.1; if the second compliance period's
    values are ever swapped in, that is a different question being answered and
    this test should be updated deliberately, not incidentally."""
    assert E.CONSTANTS["ll97_cap_kg_co2e_sf_residential"].value == pytest.approx(6.75)
    assert E.CONSTANTS["ll97_cap_kg_co2e_sf_office"].value == pytest.approx(8.46)
    assert E.CONSTANTS["ll97_cap_kg_co2e_sf_retail"].value == pytest.approx(11.81)
    for key in ("residential", "office", "retail"):
        note = E.CONSTANTS[f"ll97_cap_kg_co2e_sf_{key}"].note
        assert "2030" in note, "the note must name the period the cap applies to"


def test_ll97_penalty_is_the_statutory_maximum_and_says_so():
    c = E.CONSTANTS["ll97_penalty_usd_tco2e"]
    assert c.value == pytest.approx(268.0)
    assert c.verified
    assert "not more than" in c.note


def test_ll97_coefficient_spans_both_compliance_periods():
    """A measure with a twenty-year life straddles the 2030 boundary, across
    which the electricity coefficient roughly halves. The range is that fact,
    not an uncertainty band."""
    lo, hi = E.CONSTANTS["ll97_coefficient_kg_co2e_kwh"].pair
    assert hi == pytest.approx(0.288962)
    assert lo < hi / 1.5


def test_the_policy_coefficient_is_not_the_physical_emissions_factor():
    """LL97's coefficient is a policy instrument and eGRID's is a measurement of
    the grid. They differ by roughly a third and must not be substituted."""
    policy = E.CONSTANTS["ll97_coefficient_kg_co2e_kwh"].pair
    physical = E.CONSTANTS["grid_kg_co2e_kwh"].pair
    assert policy[1] < physical[0]

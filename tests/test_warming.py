"""The warming scenarios: the same city under warmer air.

The module makes one first-order move — a uniform offset on the air series,
propagated through the pipeline's own measured dT_surface/dT_air — and the
whole of its defensibility rests on that move being monotone, on the counting
definitions matching ``year.py``'s, and on the caveats travelling with every
number rather than living in a docstring nobody reads.

So that is what these check. There is deliberately no test asserting that any
particular figure is *correct*: correctness here would mean agreement with a
climate projection, the module explicitly is not one, and a test that implied
otherwise would be the same overclaim in a different file.
"""

from __future__ import annotations

import numpy as np
import pytest

from heatcanyon import warming as W


@pytest.fixture
def year():
    """A synthetic year with a real diurnal cycle and a real seasonal one.

    Built rather than loaded so the test runs without a pipeline output, and
    shaped so the thresholds it is counting against actually bite: a flat series
    would pass every monotonicity check trivially.
    """
    hours = np.arange(8760)
    day = hours // 24
    hod = hours % 24
    seasonal = 13.0 - 14.0 * np.cos(2 * np.pi * (day - 200) / 365.0)
    diurnal = 5.5 * -np.cos(2 * np.pi * (hod - 3) / 24.0)
    return seasonal + diurnal, hod.astype(np.int64), day.astype(np.int64)


def test_every_count_rises_with_the_offset(year):
    """Monotone in the offset, in every direction, with no exceptions.

    Not a tautology. ``days_above_35`` counts DAYS whose maximum clears the
    threshold while ``hours_above_35`` counts hours, and the two are computed by
    different reductions — a sign or an axis error in either shows up here and
    nowhere else.
    """
    t, hod, di = year
    rows = [W.year_summary(t, hod, di, d) for d in W.LEVELS]
    for name in ("days_above_35", "days_above_38", "tropical_nights",
                 "hours_above_35", "cooling_degree_hours", "peak_air_c",
                 "mean_air_c"):
        vals = [getattr(r, name) for r in rows]
        assert vals == sorted(vals), f"{name} is not monotone in the offset: {vals}"


def test_the_offset_is_exactly_an_offset(year):
    """Mean and peak move by the offset and by nothing else.

    The one property that makes this method legible: a reader told "plus two and
    a half kelvin" is entitled to find the mean two and a half kelvin higher. If
    a future version starts scaling the tails differently — which would be more
    realistic — this test should fail and the claim in the docstring should
    change with it.
    """
    t, hod, di = year
    base = W.year_summary(t, hod, di, 0.0)
    for d in (1.5, 2.5, 4.0):
        r = W.year_summary(t, hod, di, d)
        assert r.mean_air_c == pytest.approx(base.mean_air_c + d, abs=1e-9)
        assert r.peak_air_c == pytest.approx(base.peak_air_c + d, abs=1e-9)


def test_zero_offset_reproduces_the_year(year):
    """+0 K must be the study year itself, not an approximation of it."""
    t, hod, di = year
    r = W.year_summary(t, hod, di, 0.0)
    assert r.hours_above_35 == int((t > 35.0).sum())
    assert r.peak_air_c == pytest.approx(float(t.max()))
    assert r.mean_air_c == pytest.approx(float(t.mean()))


def test_facade_response_uses_the_measured_coefficient():
    """The surface lift is gamma times the air lift, per panel and band.

    Gamma clusters just above 1.0 and varies across the scene; a facade band
    with a larger gamma must warm more. Collapsing it to a scalar would be the
    easy simplification and would erase the reason the coefficient was measured
    per panel-band in the first place.
    """
    surf = np.array([[50.0, 40.0], [30.0, 20.0]])
    gamma = np.array([[1.20, 1.00], [0.90, 1.05]])
    out = W.facade_under_warming(surf, gamma, 2.5)
    assert out == pytest.approx(surf + gamma * 2.5)
    # The band with the larger gamma gains more from the same air lift.
    assert (out - surf)[0, 0] > (out - surf)[0, 1]


def test_a_building_carries_its_caveats_on_every_row(year):
    """Every result states the assumption it rests on. Not one, all of them.

    A caveat attached to the headline row and omitted from the rest is worse
    than none: it teaches a reader that the unmarked rows are the safe ones.
    """
    t, hod, di = year
    rows = W.building_exposure(t_air=t, hour_of_day=hod, day_index=di,
                               indoor_offset_k=2.0)
    assert len(rows) == len(W.LEVELS)
    for r in rows:
        assert "assumed" in r.basis
        assert "not a climate projection" in r.basis
        assert r.notes, f"+{r.delta_k} K carries no note"
        assert any("conservative" in n for n in r.notes)
    # The extrapolation warning appears only where gamma is actually being
    # extrapolated, or it stops meaning anything.
    assert not any("upper bound" in n for n in rows[0].notes)
    assert any("upper bound" in n for n in rows[-1].notes)


def test_indoor_hours_rise_with_the_offset(year):
    t, hod, di = year
    rows = W.building_exposure(t_air=t, hour_of_day=hod, day_index=di,
                               indoor_offset_k=2.0)
    vals = [r.indoor_hours_over for r in rows]
    assert vals == sorted(vals)
    assert vals[-1] > vals[0], "a 4 K warmer year must expose more hours"


def test_a_hotter_building_crosses_earlier(year):
    """The indoor offset is the building's own, so it must move the answer."""
    t, hod, di = year
    cool = W.building_exposure(t_air=t, hour_of_day=hod, day_index=di,
                               indoor_offset_k=1.0)
    hot = W.building_exposure(t_air=t, hour_of_day=hod, day_index=di,
                              indoor_offset_k=5.0)
    for a, b in zip(cool, hot):
        assert b.indoor_hours_over >= a.indoor_hours_over


def test_crossing_interpolates_and_admits_when_it_never_crosses(year):
    """The threshold-crossing offset, and the case that must return None.

    Reporting the top of the range for a quantity that never reaches the
    threshold would read as a crossing the model found. It did not find one, and
    None is how it says so.
    """
    t, hod, di = year
    rows = W.building_exposure(t_air=t, hour_of_day=hod, day_index=di,
                               indoor_offset_k=2.0)
    lo, hi = rows[0].indoor_hours_over, rows[-1].indoor_hours_over

    mid = (lo + hi) / 2.0
    x = W.crossing(rows, attribute="indoor_hours_over", threshold=mid)
    assert x is not None
    assert W.LEVELS[0] <= x <= W.LEVELS[-1]

    # Already over at +0 K: the crossing is the bottom of the range, not None.
    assert W.crossing(rows, attribute="indoor_hours_over",
                      threshold=lo - 1) == W.LEVELS[0]
    # Never reached anywhere in the range.
    assert W.crossing(rows, attribute="indoor_hours_over",
                      threshold=hi + 1000) is None


def test_the_indoor_threshold_agrees_with_loads():
    """Two modules counting the same exposure must count it the same way.

    ``warming`` deliberately holds its own constant so it stays importable
    without the decision layer, which means the two can drift. This is the
    assertion that stops them.
    """
    loads = pytest.importorskip("heatcanyon.loads")
    assert W.INDOOR_THRESHOLD_C == loads.INDOOR_THRESHOLD_C

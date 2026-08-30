"""The climate year: the series, the calibration, and the records derived from it.

These are unit tests over ``heatcanyon.year`` rather than over the built output —
the built output is checked by ``scripts/validate.py`` and
``tests/test_agent_surface.py``. What is tested here is the arithmetic that turns
8,760 raw hours into 365 day records, twelve month records with a representative
day each, four seasons, and a set of heat-wave episodes: the layer where an
off-by-one in an hour index or a wrong DST offset produces a plausible number.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from heatcanyon import year as Y

pytestmark = pytest.mark.skipif(
    not Y.cache_path().exists(),
    reason="no cached year; run `python scripts/fetch_year.py` (free, no key)",
)


@pytest.fixture(scope="module")
def ym():
    return Y.load()


# ------------------------------------------------------------------ the fit


def test_bias_fit_recovers_its_own_anchors():
    """A calibration that cannot reproduce its training data is broken."""
    era5 = {3: 28.8, 6: 27.3, 9: 30.6, 12: 39.0, 15: 40.7, 18: 36.1, 21: 37.0, 0: 28.1}
    fg = {3: 30.8, 6: 28.1, 9: 32.1, 12: 35.9, 15: 38.7, 18: 36.8, 21: 36.0, 0: 33.7}
    bias = Y.fit_bias(era5, fg, fitted_on="2026-07-02")
    for h in era5:
        assert abs(era5[h] + bias.offsets[h] - fg[h]) < 1e-9
    # ERA5's amplitude over this cell is too large, so the correction is mostly an
    # amplitude correction: positive before dawn, negative in the afternoon.
    assert bias.offsets[3] > 0 and bias.offsets[15] < 0
    rep = bias.report
    assert "one day" in rep["limitation"]
    assert len(rep["offsets_by_local_hour_k"]) == 24


def test_bias_fit_is_cyclic_across_midnight():
    """Hour 23 is adjacent to hour 0, or the overnight hours flat-extrapolate.

    With eight anchors three hours apart, a non-cyclic interpolation leaves the
    hours either side of midnight held at whichever end they fell off — and that
    is exactly where the bias is largest.
    """
    era5 = {0: 10.0, 12: 20.0}
    fg = {0: 12.0, 12: 19.0}
    bias = Y.fit_bias(era5, fg)
    # 23:00 sits one hour from the 00:00 anchor and thirteen from the 12:00 one,
    # so it must be far closer to +2 than to -1.
    assert bias.offsets[23] > 1.5
    assert bias.offsets[1] > 1.5
    assert bias.offsets[11] < 0.0


def test_bias_fit_refuses_a_fit_with_no_overlap():
    with pytest.raises(ValueError):
        Y.fit_bias({1: 10.0}, {5: 12.0})


def test_correction_moves_the_series_and_keeps_the_raw_one(ym):
    bias = Y.fit_bias({h: float(ym.t_air_raw[ym.index_of("2026-07-02", h)])
                       for h in (3, 15)},
                      {3: 31.0, 15: 38.0}, fitted_on="2026-07-02")
    corrected = Y.load(bias=bias)
    assert not np.allclose(corrected.t_air, corrected.t_air_raw)
    # The raw series survives, so the size of the correction is always inspectable.
    assert np.allclose(corrected.t_air_raw, ym.t_air_raw)
    assert corrected.provenance()["bias_correction"] is not None
    assert corrected.provenance()["kind"].startswith("reanalysis")


# ---------------------------------------------------------------- the series


def test_the_year_is_a_year(ym):
    assert len(ym) == 8760
    assert ym.n_days == 365
    assert ym.start == Y.WINDOW[0]
    assert ym.end == Y.WINDOW[1]
    # Every hour of every day, exactly once.
    counts = np.bincount(ym.day_index, minlength=365)
    assert set(counts.tolist()) == {24}


def test_daylight_saving_is_handled_rather_than_assumed(ym):
    """The offset has to come from the calendar, not from a constant.

    A single utc_offset over a year that crosses two DST transitions puts the sun
    an hour out for seven months, which moves the shadow line by tens of metres
    and would be invisible in any temperature statistic.
    """
    offs = {float(ym.utc_offset[i]) for i in range(len(ym))}
    assert offs == {-4.0, -5.0}
    jan = ym.index_of("2026-01-15", 12)
    jul = ym.index_of("2026-07-15", 12)
    assert float(ym.utc_offset[jan]) == -5.0
    assert float(ym.utc_offset[jul]) == -4.0


def test_solar_noon_is_near_the_middle_of_the_day(ym):
    """The sanity check that catches a wrong offset or a hemisphere error."""
    for date, lo, hi in (("2026-06-21", 68.0, 76.0), ("2025-12-21", 22.0, 30.0)):
        k = ym.day_slice(date)
        alts = np.array([ym.sun(int(i)).altitude for i in k])
        noon = int(np.argmax(alts))
        assert 11 <= int(ym.hour_of_day[k[noon]]) <= 14, date
        assert lo < alts.max() < hi, f"{date}: noon altitude {alts.max():.1f}"


def test_day_records_are_internally_consistent(ym):
    days = ym.days
    assert len(days) == 365
    for d in days[:40] + days[180:220]:
        assert d.t_min <= d.t_mean <= d.t_max
        assert 0 <= d.hours_above_35 <= 24
        assert d.degree_hours_above_35 >= 0
        assert 0 <= d.daylight_hours <= 16
        assert (d.cdd > 0) != (d.hdd > 0) or d.t_mean == Y.T_BASE_C
        if d.hours_above_35 > 0:
            assert d.t_max > Y.T_HOT_C
        if d.tropical_night:
            assert d.t_min > 20.0            # a 26 C night minimum implies this


def test_month_records_pick_a_real_representative_day(ym):
    months = ym.months
    assert len(months) == 12
    for m in months:
        assert m.days >= 28
        assert m.t_min_mean <= m.t_mean <= m.t_max_mean
        # The representative day is a day that happened, inside its own month.
        rec = next(d for d in ym.days if d.date == m.rep_date)
        assert rec.month == m.month
        # And it is genuinely the closest one, not merely the first.
        assert m.rep_rms_k < 3.0
        assert len(m.diurnal_c) == 24


def test_the_representative_day_is_the_closest_one(ym):
    """Recomputed independently, because "closest" is easy to get wrong."""
    m = ym.month_record(7)
    diurnal = np.array(m.diurnal_c)
    best, best_rms = None, float("inf")
    for d in (x for x in ym.days if x.month == 7):
        k = ym.day_slice(d.date)
        prof = np.full(24, np.nan)
        prof[ym.hour_of_day[k]] = ym.t_air[k]
        ok = np.isfinite(prof)
        rms = float(np.sqrt(np.mean((prof[ok] - diurnal[ok]) ** 2)))
        if rms < best_rms:
            best, best_rms = d.date, rms
    assert best == m.rep_date
    assert abs(best_rms - m.rep_rms_k) < 1e-6


def test_seasonality_is_ordered(ym):
    seasons = {s["season"]: s for s in ym.seasons()}
    assert seasons["summer"]["tmean"] > seasons["winter"]["tmean"] + 15
    assert seasons["summer"]["ghi_kwh"] > seasons["winter"]["ghi_kwh"] * 2
    assert seasons["winter"]["hdd"] > seasons["summer"]["hdd"]
    assert seasons["summer"]["noon_alt_mean"] > seasons["winter"]["noon_alt_mean"] + 25
    # New York is heating dominated, and the year should say so.
    ann = ym.annual()
    assert ann["hdd"] > ann["cdd"]


def test_episodes_recover_the_study_event(ym):
    """An episode definition that cannot find the event it describes is not one.

    The project chose 29 June to 5 July 2026 as its heat wave before any of this
    existed. Run-length detection over the daily maxima has to rediscover it.
    """
    eps = ym.episodes(threshold_c=32.0, min_days=2)
    assert eps
    hit = [e for e in eps if e.start <= "2026-07-02" <= e.end]
    assert hit, f"2026-07-02 falls outside every episode: {[e.as_dict() for e in eps[:5]]}"
    e = hit[0]
    assert e.days >= 2
    assert e.peak_c >= 32.0
    assert e.start <= e.peak_date <= e.end
    # Sorted longest and hottest first, so a caller taking the head gets the one
    # that matters.
    assert eps[0].days >= eps[-1].days


def test_the_study_day_is_near_the_top_of_its_own_year(ym):
    ranked = sorted(ym.days, key=lambda d: -d.t_max)
    place = [d.date for d in ranked].index("2026-07-02") + 1
    assert place <= 5, f"the study day ranks {place} of 365 by daily maximum"


def test_annual_totals_agree_with_the_day_records(ym):
    ann = ym.annual()
    days = ym.days
    assert ann["days"] == 365
    assert ann["hours"] == 8760
    assert ann["days_above_35"] == sum(1 for d in days if d.t_max > Y.T_HOT_C)
    assert ann["tropical_nights"] == sum(1 for d in days if d.tropical_night)
    assert abs(ann["cdd"] - sum(d.cdd for d in days)) < 0.5
    assert ann["tmax_date"] == max(days, key=lambda d: d.t_max).date
    assert abs(ann["tmean_c"] - float(ym.t_air.mean())) < 0.01


def test_provenance_names_the_grid_cell_and_the_limitation(ym):
    p = ym.provenance()
    assert "ERA5" in p["source"]
    assert p["grid_cell"] and p["grid_cell"] != p["requested_at"]
    # The cell is 25 km and contains water. Saying so is the point of the field.
    assert "New Jersey" in p["grid_cell_note"]
    assert p["units"]["wind_speed_10m"] == "m/s", (
        "the year must be fetched in m/s: Open-Meteo's default is km/h and "
        "Met.wind_10m is m/s, which is a 3.6x error in the convective coefficient")


def test_index_lookups_are_exact(ym):
    i = ym.index_of("2026-07-02", 15)
    assert i is not None
    assert ym.times[i].startswith("2026-07-02T15")
    assert ym.index_of("2019-01-01", 0) is None
    assert len(ym.day_slice("2026-07-02")) == 24
    assert Y.hours_since("2025-08-01", "2025-08-02", 5) == 29

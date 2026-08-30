"""The same geometry under warmer air.

WHY THIS IS NOT A CLIMATE PROJECTION, AND SAYS SO

Every capital measure in the decision layer has a twenty to forty year life. The
study year is one year. That gap is the strongest argument for acting now and
the platform could not make it, so this module makes it — in the crudest form
that is still defensible, and labelled as crude.

A uniform offset is added to the 8,760-hour air temperature series and
everything downstream is recomputed. It ignores changes to humidity, to cloud,
to circulation, and to the shape of the distribution — real warming does not
raise every hour by the same amount, and the tails are exactly where it does
not. The honest claim is **"the same city under warmer air"**, never "Midtown in
2050", and every figure this module produces carries that string.

WHY IT COSTS SECONDS RATHER THAN A REBUILD

Re-solving 8,760 hours takes twelve minutes, and doing that four times over for
four warming levels would make the feature unusable. It is not necessary,
because the pipeline already measured the coefficient this needs.

``sens.bin`` holds ``gamma = dT_surface / dT_air`` per panel and band: the
measured response of each facade band's surface temperature to a one-kelvin lift
in the air-temperature anchor, obtained by re-solving the whole scene with the
anchor raised and differencing. The day reconstruction already uses it to turn
"March the fourteenth" into a field from March's solved day, and
``scripts/validate.py`` checks that reconstruction against full re-solves on
deliberately awkward days.

A uniform warming is the same operation with a different departure. Where the
reconstruction asks "what does this facade do on a day 3 K warmer than its
month's representative day", this asks "what does it do in a year 3 K warmer
throughout". Same coefficient, same first-order approximation, same published
error — which is why this module is a hundred lines rather than a second
pipeline.

WHERE THE APPROXIMATION IS WEAKEST, STATED

``gamma`` was measured around the study year's own temperatures. At +4 K it is
being extrapolated, and the fourth-power emission term means the true response
falls slightly as the surface gets hotter — so these numbers run a little HIGH
at the top of the range, and they are an upper bound rather than a best estimate
there. The bias is small next to the uniform-offset assumption itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

#: The offsets offered, in kelvin. Not labelled with years or scenarios on
#: purpose: naming one "2050 under SSP2-4.5" would import a precision this
#: method does not have and would invite the figure to be quoted as a
#: projection. A reader who knows what +2.5 K means can map it themselves.
LEVELS: tuple[float, ...] = (0.0, 1.5, 2.5, 4.0)

#: Indoor dry-bulb above which a floor counts as exposed, degC. Mirrors
#: ``loads.INDOOR_THRESHOLD_C`` rather than importing it, so this module stays
#: usable when the decision layer is absent; a test asserts the two agree.
INDOOR_THRESHOLD_C = 28.0

BASIS = ("assumed — a uniform offset on the measured air series, propagated "
         "through the pipeline's own measured dT_surface/dT_air. The same city "
         "under warmer air, not a climate projection.")


@dataclass
class WarmingResult:
    """What one uniform offset does to the year."""

    delta_k: float
    days_above_35: int
    days_above_38: int
    tropical_nights: int
    hours_above_35: int
    cooling_degree_hours: float
    peak_air_c: float
    mean_air_c: float
    #: Hours a year the free-running indoor estimate clears the threshold, given
    #: a building's own measured indoor-to-air offset. Filled by
    #: ``building_exposure``; zero from ``year_summary`` alone, which knows
    #: nothing about any building.
    indoor_hours_over: float = 0.0
    facade_peak_c: float = 0.0
    notes: list[str] = field(default_factory=list)
    basis: str = BASIS


def year_summary(t_air: np.ndarray, hour_of_day: np.ndarray, day_index: np.ndarray,
                 delta_k: float) -> WarmingResult:
    """What the study year looks like with every hour lifted by ``delta_k``.

    The counting definitions match ``year.py``'s so a warmed year and the real
    one can be put in the same column: a day is above 35 if its maximum is, and
    a tropical night is one whose minimum stays above 20.
    """
    t = np.asarray(t_air, dtype=np.float64) + float(delta_k)
    di = np.asarray(day_index, dtype=np.int64)
    n_days = int(di.max()) + 1 if di.size else 0

    # Per-day maxima and minima without a Python loop over 365 days.
    day_max = np.full(n_days, -1e9)
    day_min = np.full(n_days, 1e9)
    np.maximum.at(day_max, di, t)
    np.minimum.at(day_min, di, t)

    return WarmingResult(
        delta_k=float(delta_k),
        days_above_35=int((day_max > 35.0).sum()),
        days_above_38=int((day_max > 38.0).sum()),
        tropical_nights=int((day_min > 20.0).sum()),
        hours_above_35=int((t > 35.0).sum()),
        # Degree-hours above 18 degC, the conventional cooling base.
        cooling_degree_hours=float(np.maximum(0.0, t - 18.0).sum()),
        peak_air_c=float(t.max()),
        mean_air_c=float(t.mean()),
    )


def facade_under_warming(surface_peak: np.ndarray, gamma: np.ndarray,
                         delta_k: float) -> np.ndarray:
    """Facade surface temperature under a uniform air-temperature lift.

    ``gamma`` is the pipeline's own measured response — see the module
    docstring. First order, and the one place this module touches the physics.
    """
    return (np.asarray(surface_peak, dtype=np.float64)
            + np.asarray(gamma, dtype=np.float64) * float(delta_k))


def building_exposure(*, t_air: np.ndarray, hour_of_day: np.ndarray,
                      day_index: np.ndarray, indoor_offset_k: float,
                      surface_peak: np.ndarray | None = None,
                      gamma: np.ndarray | None = None,
                      levels: tuple[float, ...] = LEVELS) -> list[WarmingResult]:
    """One building across every warming level.

    ``indoor_offset_k`` is the building's own measured indoor-minus-air offset
    from ``loads`` — the quantity the annual exceedance count is already built
    on. Carrying it forward unchanged is itself an assumption, and a
    conservative one in the wrong direction: a hotter year with the windows open
    would raise the offset slightly, so these indoor hour counts run LOW. That
    is stated on every result rather than corrected, because correcting it would
    need a re-solve and the point of this module is that it does not do one.
    """
    out: list[WarmingResult] = []
    for d in levels:
        r = year_summary(t_air, hour_of_day, day_index, d)
        t = np.asarray(t_air, dtype=np.float64) + float(d)
        r.indoor_hours_over = float((t + indoor_offset_k > INDOOR_THRESHOLD_C).sum())
        if surface_peak is not None and gamma is not None:
            r.facade_peak_c = float(facade_under_warming(surface_peak, gamma, d).max())
        if d > 2.5:
            r.notes.append(
                "gamma was measured around this year's own temperatures, so at "
                "this offset it is being extrapolated and the fourth-power "
                "emission term makes the true response a little smaller. Treat "
                "this level as an upper bound.")
        r.notes.append(
            "Indoor hours assume the building's measured indoor-to-air offset is "
            "unchanged by the warming, which makes this count conservative.")
        out.append(r)
    return out


def crossing(results: list[WarmingResult], *, attribute: str,
             threshold: float) -> float | None:
    """The offset at which a quantity first clears a threshold, interpolated.

    This is the number an owner acts on — "the top floor crosses two hundred
    hours a year above the indoor threshold somewhere between +1.5 and +2.5 K" —
    and returning None when it never crosses is deliberate: reporting the top of
    the range instead would read as a crossing that the model did not find.
    """
    prev = None
    for r in results:
        v = float(getattr(r, attribute))
        if v >= threshold:
            if prev is None:
                return r.delta_k
            pv, pd = prev
            if v == pv:
                return r.delta_k
            return pd + (threshold - pv) * (r.delta_k - pd) / (v - pv)
        prev = (v, r.delta_k)
    return None

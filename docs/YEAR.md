# The year

*How the Urban Canyon went from one afternoon to 8,760 hours, what each temporal tier
does and does not claim, and the four places the year could quietly be wrong.*

---

## Why one day was not enough

The original model solved eight hours of 2 July 2026. That was the right thing to
solve first: it is the hottest day of the Manhattan summer, it is the day the
FortyGuard purchase covers, and it is the day the validation applies to.

But a single day cannot answer the questions a city actually asks.

- How many hours a year does this facade sit above 35 °C?
- Which month does this canyon peak in — and is it July?
- Does the shading that saves July cost January?
- How many nights a year does this block fail to drop below 26 °C?

Every one of those is temporal, and none of them can be asked of one day. The
last is the sharpest: overnight minima above about 26 °C are what the
epidemiology of heat mortality is most sensitive to, and a model of one
afternoon has nothing to say about them.

The pivot also produced the finding that justifies it on its own. **The
event-day ranking and the annual ranking of the same buildings share only about
a quarter of their top fifty** (Spearman ≈ 0.73). A programme designed against a
heat wave and a programme designed against a year are different programmes, and
before the year existed there was no way to know that.

---

## Where a year of data comes from without a credential

FortyGuard's heatmap endpoint costs a flat 4,220 credits per call regardless of
tile count. A year of hourly urban fields is therefore 8,760 calls — 37 million
credits against a 2 million budget — and the repository ships no key anyway.

What *is* freely available at hourly resolution for any point on earth is the
**ERA5 reanalysis**, served by Open-Meteo without a key. This project already
used it: `heatcanyon/solar.py`'s irradiance reconstruction is validated against
ERA5 radiation to 7.3 % RMS. So the temporal axis rests on a source the
repository already trusts and already checks.

`scripts/fetch_year.py` pulls 8,760 hours of air temperature, humidity, dew
point, cloud cover, wind, and beam/diffuse/global irradiance for the AOI centre,
in one request, and caches it under `data/manhattan/`.

### The window

**2025-08-01 to 2026-07-31.** A full 365 days, ending on the month of the
modelled heat wave, so the year *contains* the day the rest of the project solves
in full and the two can be cross-checked rather than merely coexisting.
`year.event_day_in_year` reports where 2 July sits in the year's own ranking, and
the validation asserts it is in the top five.

### What ERA5 cannot do, and what is done about it

ERA5's grid cell over Midtown is 0.25° — about 25 km — and the cell containing
Manhattan also contains a large amount of open water and New Jersey. It is
therefore **not** an urban 2 m air temperature, and using it raw as the anchor
would silently replace a measured urban field with a regional one.

Measured against FortyGuard on the one day both cover:

| local hour | ERA5 | FortyGuard | offset |
|---|---|---|---|
| 03:00 | 28.8 °C | 30.8 °C | **+2.0 K** |
| 15:00 | 40.7 °C | 38.7 °C | **−2.0 K** |

ERA5's diurnal amplitude is too large — exactly the error a coarse, partly
marine cell makes against a dense city with high thermal mass. So a **24-value
diurnal offset curve** is fitted to the eight hours both sources speak at,
interpolated cyclically so it closes at midnight, and applied year-round.

**Its limitation is that it is fitted to one day.** It captures the shape of the
bias but not its seasonality; a January offset is an extrapolation from a July
fit. Both the corrected and the raw series are shipped in `year.json`, every
product derived from the corrected series is labelled *reanalysis
(bias-corrected)* and never *measured*, and `scripts/validate.py` prints the
whole fit with its residuals and prints the limitation as an explicitly
unvalidated item rather than burying it.

---

## Three temporal tiers

8,760 hours × 29,415 panels × 10 bands is 2.6 billion surface energy balances, and
56 MB of facade field per eight hours shipped to a browser. So the time axis is
resolved at three resolutions, each chosen for what it is for. `heatcanyon/tiers.py`
is the single owner of these definitions.

| | EVENT | MONTH | ANNUAL |
|---|---|---|---|
| what | 2 July 2026 | 12 representative days | all 8,760 hours |
| hours | 8 | 8 each | every one |
| spatial | every panel × band | every panel × band | every panel × band |
| shadows | ray-traced | ray-traced | analytic canyon form |
| anchor | FortyGuard, **measured** | ERA5, bias-corrected | ERA5, bias-corrected |
| output | a viewable field | viewable fields | totals and extremes only |
| validated | yes, this is the tier the suite covers | by construction from the same code | by the checks below |

### The representative day

A month's representative day is **the real day whose own diurnal profile sits
closest to that month's mean profile**, by RMS. Not a synthetic average day —
because an averaged day has an averaged sun, and no averaged day is ever actually
lit that way. `year.json` carries each month's `rep_date` and the RMS it achieved
(0.48 to 1.53 K).

### Any of the other 352 days

Scrubbing to 14 March must show 14 March, not "March". The browser paints, per
panel and band:

```
excess = T_surface(rep, hour) − T_air(rep, hour)
r      = clamp(GHI(day, hour) / GHI(rep, hour), 0, 2.5)
w      = h_c(u10 on the rep day) / h_c(u10 on this day)      ← per panel and band

T_surface(day, hour) = T_surface(rep, hour)
                     + γ × [T_air(day) − T_air(rep)]         ← the air term
                     + excess × (r·w − 1)   where lit        ← irradiance and wind
                     + excess × (w  − 1)    where shaded     ← wind only
```

**The air term.** γ is `dT_surface/dT_air`, measured by re-solving the whole scene
with the anchor lifted 1 K at 16 probe hours spanning the year and the day. It
comes out at **1.007 ± 0.005 K/K** — a facade tracks the air almost one-for-one
once the radiation term is fixed, and slightly more than one because warmer air
also raises the radiative sky temperature it exchanges with.

**The irradiance term**, which was missing at first. A day 16 K warmer than its
month's representative day is usually a *clear* day against a cloudy one, and the
beam differs by hundreds of W/m² — which the air term cannot see. Measured before
the term existed: a January probe with 591 W/m² of beam on the reference day
against **zero** on the target was wrong by 14 K at its worst band, and 2 K with
the term.

Applied only where the band is **lit**, and that qualifier matters. Scaling a
shaded band's excess by a beam ratio over-corrects it, because a shaded band's
excess is diffuse and longwave rather than beam: applying the ratio everywhere
took the median April error from 0.40 K to 2.85 K while improving the tail.
Lit-only improves both.

**The wind term.** The excess also goes as 1/h_c, and h_c is 5.8 + 3.8u, so a
windier day sheds more heat from every surface — lit or shaded, which is why this
factor applies everywhere while the irradiance ratio does not. It is per panel and
band rather than scalar, because the canyon attenuates the free-stream wind by
exp(−0.386·H/W) at street level and lets it through at roof height: a 3 m/s change
means something different at the bottom of a 4:1 slot than at the top of it. It
needs no data the browser does not already hold — the canyon's aspect ratio and
wall height are in `canyons.json`, and the hourly wind is in `year.json`.

Each of the three terms was measured across all 365 days before being kept:

| terms | median day p95 | 90th-percentile day p95 | worst day p95 |
|---|---|---|---|
| air only | 2.62 K | 9.73 K | 19.4 K |
| air + irradiance | 1.78 K | 5.65 K | 17.5 K |
| air + irradiance + wind | **1.54 K** | **4.28 K** | **13.5 K** |

(Sample of 120 canyons at 15:00. The shipped audit over the full scene gives a
median day of 2.04 K, a 90th-percentile day of 5.48 K and a worst day of 13.6 K.)

`heatcanyon/tiers.py`'s `reconstruct` is the **one** definition of this formula.
The browser implements the same arithmetic, `agent/dataset.surface_on` calls it
directly, and the audit below measures it. Three implementations would drift, and
then the error the interface prints would stop being the error of the field on
screen.

### The reconstruction's own error, per day

Neither term can correct a change in solar **geometry**. Two days a fortnight
apart in March differ by about five degrees of declination, which moves the shadow
line and changes the incidence angle on every lit band, and no scalar applied to a
solved field reproduces that.

So it is measured rather than caveated. The pipeline **solves every one of the 365
days at one hour** — about 45 seconds — compares it against its own month's
reconstruction, and ships the per-day error in `year.json`. The interface prints
that day's own figure beside the date (`reconstructed ±1.2 K`) and the strip
tooltip carries it too, so what you get is the error of the field you are looking
at rather than a statement about reconstructions in general.

The residual behaves exactly as the mechanism predicts: largest in the equinox
months where declination moves fastest, smallest in June and December where it
barely moves. `meta.json year.reconstruction` carries the median day, the 90th
percentile day, the worst day by name, and the median by month. As shipped: the
median day's 95th-percentile band error is **2.04 K**, the 90th-percentile day
**5.48 K**, and the worst day of the year **13.6 K** (28 February 2026). The
monthly medians run from 1.57 K in December to 3.60 K in October.

**The obvious next improvement — blending the two nearest monthly tiers instead
of using only the containing month's — was measured and rejected.** For 24 March
the neighbours are 14 March and 11 April, and a distance-weighted blend of both
looks like it should roughly halve the declination error. Measured across all 365
days on the same 120-canyon sample, on the two-term reconstruction:

| reconstruction basis | median day p95 | 90th-percentile day p95 | worst day p95 |
|---|---|---|---|
| the containing month | 1.78 K | 5.65 K | 17.5 K |
| the nearest solved day | 1.82 K | 5.96 K | 21.3 K |
| distance-weighted blend of the two nearest | 1.70 K | 4.57 K | 17.2 K |

The blend buys 0.08 K at the median and 1.1 K at the 90th percentile, for the cost
of holding two months in the browser instead of one — 10 MB per scrub rather than
5 — and a second implementation of the reconstruction to keep in step with the
audit. Adding the **wind term** instead bought 0.24 K at the median and 1.4 K at
the 90th percentile for no extra data and one shared function, which is why that
happened and the blend did not. Interestingly the *nearest* solved day is slightly
worse than the *containing* month, which is the mid-month representative-day
selection already having removed the boundary cases that idea was meant to fix.

Two things would move this materially rather than marginally: solving two days per
month instead of one, which halves the declination distance for about two minutes
of build time and 120 MB of gitignored disk; or shipping the solar geometry per
day so the beam term could be recomputed rather than scaled. Neither is done here.
The error is disclosed per day instead.

That measurement also changed how a representative day is chosen. It was picked
purely by diurnal RMS, which could land it at either end of its month and put it
up to 15 days of declination from the far end. The score now adds a penalty for
distance from the month's midpoint — 0.05 K per day, calibrated against the spread
in candidate days' own RMS, so a genuinely better profile can still win but an
equally good one at the edge of the month cannot.

### Why the annual tier takes a short cut

Ray-marching 8,760 solar positions across an 864 × 901 surface model is about two
hours of shadow work. The annual tier therefore uses the closed form for the
shadow the opposite wall casts up a facade.

The two can only differ in the **ground band**, because the ray-traced mask vetoes
that band alone. The difference is the obstruction a 2-D cross-section cannot
see: corners, plazas, the far side of an intersection. The event day is solved
**both ways**, the disagreement is measured (7.6 % of ground-band cells, a mean
over-estimate of 0.06 h per band over eight hours), published in `meta.json`
under `year.shading_discrepancy`, and asserted against a ceiling in the
validation script.

---

## The second engine, and the rule that keeps it honest

The scalar engine solves 2.35 million energy balances in about a minute, which is
8,760 hours in roughly eighteen hours of wall clock. A year at facade resolution
is not reachable one panel at a time, so `heatcanyon/yearsolve.py` is a
vectorised mirror of `heatcanyon/physics.py`.

A second implementation of a physical model is normally a liability. This one is
governed by one rule:

> **Nothing in `yearsolve.py` may be improved independently.** If the physics
> changes it changes in `physics.py` first, and the vector path is brought back
> into line until the equivalence check passes.

`tests/test_yearsolve_equivalence.py` and `scripts/validate.py` compare the two
over randomly drawn but physically realistic scenes — every material, canyon
depths from an open plaza to a 4:1 slot, heights from a doorway to the top of a
400 m tower, hours from before dawn to mid-afternoon — and require agreement to
**1 × 10⁻⁶ K**, not to the 0.01 K the fixed point converges to. The vector path
reproduces the scalar loop's break condition exactly rather than approximately,
so loosening that tolerance is not a fix; it is the first sign the two engines
have drifted.

---

## Two physics corrections the year forced

The pivot surfaced two errors that a single day had been hiding. Both are
documented at their source; both change every number in the model.

### 1. Wind was 3.6× too large

Open-Meteo returns wind speed in **km/h** by default. The one-day cache carried
km/h in a field the pipeline read straight into `Met.wind_10m`, which is m/s.
`scripts/fetch_year.py` now requests `wind_speed_unit=ms` at the API rather than
converting in the reader, so the cache cannot be misread again.

### 2. The convective coefficient's intercept had been wrong twice

`h_c = a + 3.8u` sets the entire surface-to-air temperature difference this
engine exists to compute, and `a` has been wrong in both directions.

- **First**, `a = 5.7`, from McAdams. That is a *combined* surface conductance —
  convection plus a linearised radiative coefficient — and since
  `surface_temperature` already carries an explicit longwave term it counted
  radiation roughly twice.
- **Then** `a = 2.0`, described as a free-convection value for a vertical surface
  in still air. Diagnosing McAdams as combined was right; substituting a
  free-convection value for the intercept of a *forced*-convection correlation
  was not.

A large wind hides a small intercept: at 12 m/s the intercept is 4 % of `h_c`. So
the two errors cancelled. Fixing the units put the canyon wind where it belongs,
0.3 to 3 m/s, where the intercept is a *third* of `h_c` — and peak facade
temperatures went to 68 °C, about 15 K above anything a thermographic survey of
masonry reports.

The current form is **`h_c = 5.8 + 3.8u`**, the mean of Palyvos (2008)'s
convective-only correlations for vertical walls (windward `7.4 + 4.0V`, leeward
`4.2 + 3.5V`), since this engine has no orientation dependence. That it is
numerically close to McAdams is a coincidence of the literature, not a retreat:
the 5.8 is a measured convective intercept, the 5.7 was convection plus
radiation, and the explicit longwave term stays.

`scripts/validate.py` now carries an **envelope check** on peak facade
temperature — the 99.9th percentile must land inside 45–65 °C, and under 1 % of
the day may exceed 60 °C — because both wrong intercepts produced fields that
looked plausible in every summary statistic. That check would have caught either.

---

## What is shipped, and how large it is

| product | size | when it loads |
|---|---|---|
| `year.json` | 0.6 MB | up front |
| `annual/*.bin` (13 planes) | 12 MB | up front |
| `sens.bin` | 0.3 MB | up front |
| `thermal.bin` etc. (event day) | 9.9 MB | up front |
| `month_NN/*.bin` × 12 | 9.9 MB each | on first scrub into that month |
| `month_NN/air.bin` | 4.7 MB of the above | only if the air layer is on |

First load is what it always was. Scrubbing into October costs about 5 MB once.

### The annual planes

Per panel per band, over the whole year: `sun_hours`, `dose_kwh`,
`absorbed_kwh`, `degree_hours_35`, `degree_hours_40`, `hours_above_35`, `t_max`,
`t_min`, `t_mean`, `summer_mean`, `winter_mean`, `swing`, `winter_sun_share`,
`month_of_max`, plus `monthly_mean` and `monthly_sun_hours` as (12, panel, band).

Two notes on those last two.

**`swing` is nearly uniform.** Summer mean minus winter mean comes out at 25–30 K
*everywhere*, because it is set by the air temperature's own annual cycle and the
whole study area shares one of those. That is a real finding and a dull map, so
the interface shows `winter_sun_share` instead — December-to-February sunlit
hours over June-to-August's, which runs from about 0.05 in a deep north-south
slot to 0.8 on an open south wall. That is the quantity a shading decision
actually turns on.

**Quantisation raises rather than clips.** The sunlit-hours plane was silently
saturating at 3,276.7 h because Int16 at a scale of 10 cannot hold 4,400 — and
3,276.7 is a plausible-looking number for "sunlit hours per year", so it survived
every summary statistic. The counting and dose planes are now UInt16, both
writers raise on overflow, and the validation checks the share of cells sitting
at the representable ceiling.

### The tile field through the year

FortyGuard measured the 60 m air-temperature field on one day. The year needs it
on 365, so the **spatial structure and the temporal level are separated**:

```
tile(day, hour) = AOI_air(day, hour) + anomaly(tile, nearest bought hour)
```

The anomaly is what FortyGuard measured that reanalysis cannot see — which tiles
run hot relative to their neighbours — and it is a product of morphology, which
does not change between March and August. The level is what reanalysis supplies
for every hour.

Two limits, stated rather than buried. The anomaly is measured on **one clear
July heat-wave day**, and urban heat island intensity is larger under clear calm
conditions, so it is an upper case and a cloudy February day's real pattern is
flatter than the transfer reproduces. And it is an anomaly of a FortyGuard
product, so it inherits that product's spatial skill. Every annual tile metric is
labelled a **composite**, never measured, and `meta.json
year.tile_transfer` carries both limits.

---

## Two orderings, and they disagree

The event-day exposure score weights duration within the heat wave (0.32 dose +
0.20 persistence), because duration is what the epidemiology links to mortality
during an acute event. The annual score weights accumulated facade load (0.30
degree-hours + 0.22 sunlit hours + 0.18 solar dose), because over a year that is
what an intervention changes.

Both are multiplied by the **same** vulnerability score as a geometric mean — the
people in a building do not change because the time window did.

They share about 12 of their top fifty. Where a building ranks far higher on the
year, its problem is chronic and fabric measures matter; far higher on the wave,
and its problem is acute and relief matters. `ranked.json` carries both orderings
and the measured agreement between them, and the interface switches between them
with the agreement printed underneath.

---

## The four places the year could be wrong

Stated as a list because a reader deciding how much to trust this should not have
to assemble it themselves.

1. **The bias correction's seasonality is unvalidated.** One overlapping day, so
   a January offset is an extrapolation. Closing it needs either NYC's Hyperlocal
   Temperature Monitoring summer series (free, one season) or a second FortyGuard
   purchase on a winter day (4,220 credits, tests the extrapolation directly).
2. **The reconstruction between solved months is first order in two terms.** Its
   error is measured for every day against a full re-solve, shipped, and shown
   beside the date. The residual is solar geometry within the month, largest near
   an equinox. It does not claim to cover a band whose *sunlit state* changed —
   cloud flipping a facade in or out of the beam is a step change, not a
   first-order departure, and it is one reason the twelve monthly days are solved
   rather than interpolated.
3. **The annual tier's shading is analytic.** Over-estimates sunlit hours in the
   ground band at corners, plazas and intersections, by a published amount.
4. **The tile transfer carries one day's anomaly across the year.** An upper case,
   labelled as a composite.

`python -m heatcanyon.cli validate` prints all four, with numbers.

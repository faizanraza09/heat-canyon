# HeatCanyon

**A 3D street-canyon heat exposure engine for Midtown Manhattan, built on the
FortyGuard Temperature API and free public data.**

FortyGuard measures air temperature at 2 m. This resolves what that means on
every facade, floor and sidewalk of a Manhattan street canyon — then ranks which
buildings to act on, and tests what would actually help.

---

## The one-paragraph version

We built a 3D street-level heat exposure model for Midtown Manhattan. It pulls
ambient air temperature from the FortyGuard Temperature API, reconstructs street
canyon geometry from NYC Open Data building footprints and street widths — both
measured, not estimated — and derives the morphology that drives heat in a
canyon: aspect ratio, sky view factor, street orientation, and the asymmetry
created by uneven building heights on either side. It then solves a coupled
surface energy balance for every facade band at eight hours across the hottest
day of the 2026 New York heat wave, producing a temperature field painted onto
facades and ground in a navigable 3D view. Because no public dataset measures air
temperature at height anywhere in Manhattan, the vertical dimension is presented
as a physically grounded estimate with stated assumptions and an uncertainty band
that widens with height — and which, honestly, exceeds the gradient it describes.
The finding that survives that caveat is the useful one: **surfaces vary 5.6
times more than air**, so what a pedestrian actually feels is governed by solar
geometry, not by the air temperature reading. On top of the physics sits an
exposure-and-vulnerability ranking that joins the measured heat layers to
residential unit counts, building age and the city's own Heat Vulnerability
Index, a what-if engine that re-solves the canyon for each intervention rather
than applying a published coefficient, and an AI analyst that can only answer
from tool calls against the computed model. Heat is the deadliest climate hazard
in cities, and the people deciding what to do about it work with data that
averages away exactly the variation that matters.

## What is actually here

| | |
|---|---|
| **Study area** | Midtown Manhattan, 4.69 km² |
| **Event** | New York heat wave, 29 June – 5 July 2026; peak day 2 July (40.7 °C) |
| **Buildings** | 5,329 footprints, 4,044 scored, 68,533 residential units |
| **Canyons** | 4,471 cross-sections, 2,826 true enclosed canyons |
| **Facade panels** | 29,415, each in 6 height bands |
| **Physics solved** | 1,411,920 coupled surface energy balances |
| **API spend** | 74,900 of 2,000,000 credits (3.7%) |
| **Tests** | 12 Python validation checks + 22 Playwright browser tests |

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Everything below runs offline. The cached API responses are committed, so
# reproducing the whole project costs zero credits.
python -m heatcanyon.cli build      # solve the model -> web/data/
python -m heatcanyon.cli validate   # 12 checks
python -m heatcanyon.cli serve      # http://127.0.0.1:8000
```

The AI analyst additionally needs `ANTHROPIC_API_KEY`. Everything else works
without it.

To refetch from FortyGuard (spends credits — the cache means you should not need
to):

```bash
export FORTYGUARD_API_KEY=...
python scripts/fetch_fortyguard.py --live --aoi midtown
python scripts/fetch_diurnal.py --live
python -m heatcanyon.cli spend        # audit the ledger
```

## The interface

Six layers, each tagged **measured** or **modelled** wherever it appears:

- **Facade surface temperature** — the field with the real signal, 24 → 59 °C
- **Air temperature** — measured at 2 m, extended upward, with its uncertainty
- **Direct sun / shade** — ray-traced through the actual 3D scene
- **Hours above 35 °C** — measured, 14.4 → 33.6 h across 4.69 km²
- **Longest unbroken run** — measured, the metric with no overnight relief
- **Intervention priority** — exposure × vulnerability

A time scrubber over eight hours, a street-level camera seated in six
DSM-validated canyon viewpoints, a ranked building list where every score opens
into its full decomposition, and a scenario panel that re-solves the physics per
site.

## Six things this found that a snapshot would not

1. **The exceedance layer spans 14.4 to 33.6 hours across 4.69 km²** — a 19-hour
   spread — while the temperature snapshot spans 1.0 K. Duration discriminates;
   peak does not.
2. **42% of Midtown canyons are more than half one-sided.** Asymmetry is the norm,
   not an edge case.
3. **East facades run hotter than west by mid-morning and the order reverses by
   evening**, with a shadow line that climbs the shaded wall as the sun drops.
4. **Street trees cut pedestrian MRT by 18.6 K on West 47th Street and 1.3 K on
   Madison Avenue** — a factor of 14, because Madison's floor is already shaded.
5. **Cool pavement lowers ground temperature while raising pedestrian radiant
   load** in a deep canyon. Reflected shortwave goes into people.
6. **The vertical air temperature signal is weaker than its own uncertainty.**
   Worth saying out loud rather than rendering a confident gradient.

## Honesty notes

Three things are load-bearing here:

- **Nothing validates air temperature at height.** No public dataset measures it
  in Manhattan. The band widens with height, is drawn in the interface, and
  exceeds the signal. Closing that gap needs a tower, a UAV, or facade sensors.
- **Recommendations are threshold-triggered, not generated.** Each fires on a
  stated measured or modelled value crossing a stated cutoff and cites the public
  programme that funds it. The same building always yields the same advice.
- **The AI analyst starts with no numbers in context.** Every figure it reports
  must come back from a tool call against the computed model, and the browser
  shows the call trace.

Full detail, including the derivations, the six physics bugs found in review, and
the API findings, is in [METHODOLOGY.md](METHODOLOGY.md).

## Layout

```
heatcanyon/
  aoi.py         study areas — the billed polygon is the rendered polygon
  fg.py          cache-first FortyGuard access + credit ledger
  nyc.py         free public-data ingest (field names verified live)
  geometry.py    DSM, sky view factor, shadows, facades, canyons
  solar.py       solar position, clear-sky irradiance, canyon shading
  physics.py     vertical air profile, coupled energy balance, MRT, WBGT
  exposure.py    transparent scoring + threshold-triggered actions
  scenarios.py   what-if by re-solving, not by coefficient
  pipeline.py    orchestration -> web/data/
  ai.py          tool-using analyst over the computed model
  server.py      static files + /api/ask
web/             three.js scene, UI, precomputed data
scripts/         fetch (metered) and validate (free)
tests/           Playwright: geometry, physics behaviour, visual
docs/
  METHODOLOGY.md          what the model does and where it stops
  research/               literature verification and effect sizes
```

## Why three.js rather than deck.gl or MapLibre

Both colour one polygon per building. `fill-extrusion-vertical-gradient` is a
fixed shading darkening, not a data-driven ramp. The entire point here is
variation *across a single facade* — up its height and by which way it faces — so
the facade geometry is generated directly as coloured triangles, one quad per
band per panel. The cost is supplying our own basemap, which is no loss: a
photographic basemap would compete with the data for attention.

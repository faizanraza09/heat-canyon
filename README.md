# HeatCanyon

**A 3D street-canyon heat exposure engine for Midtown Manhattan, across a whole
year, built on the FortyGuard Temperature API and free public data — with an
analyst that re-solves the physics to answer questions.**

FortyGuard measures air temperature at 2 m. This resolves what that means on
every facade, floor and sidewalk of a Manhattan street canyon, for 8,760 hours,
then ranks which buildings to act on, tests what would actually help, and lets
you ask.

![Midtown Manhattan with the modelled facade temperature field draped over Google's photorealistic 3D mesh](docs/images/app/01-overview.jpg)

*The application as it opens: 5,329 Midtown buildings, 29,415 facade panels
solved for sun, shade and re-radiation, drawn over Google's photogrammetry so
the heat sits on a street you recognise.*

---

## Why it exists

A heat map of 2 m air temperature is where we started, and the whole project
exists because of what that map does **not** say.

Here is a live FortyGuard heatmap of the study area at 15:00 on the hottest day
of the 2026 New York heat wave — 432 tiles over 4.69 km²:

| | |
|---|---|
| Minimum | 37.95 °C |
| Maximum | 38.87 °C |
| **Spread across the whole study area** | **0.92 K** |

And here is the same square kilometre, the same hour, after this project solves
the surface energy balance on every facade band:

| | |
|---|---|
| Hottest wall | 61.2 °C |
| **1st-to-99th percentile spread across facades** | **14.46 K** |

A body standing on that pavement exchanges heat with the walls, not with the
thermometer. **Surfaces vary about 5.6× more than air** across a Manhattan
canyon, and that variation — which is what a shading decision, a cool-roof
programme or a tree planting turns on — is exactly what a 2 m field averages
away. The API gives us the anchor that makes the rest defensible; the model
gives the anchor somewhere to land.

The second thing this project learned is that **one day was the wrong unit**.
It now solves the whole year, and the year's first finding was that the fifty
buildings most at risk during a heat wave and the fifty most loaded across a
year **overlap by about a quarter** (Spearman ≈ 0.73). A programme designed
against a heat wave and a programme designed against a year are different
programmes.

## What is actually here

| | |
|---|---|
| **Study area** | Midtown Manhattan, 4.69 km² |
| **Event** | New York heat wave, 29 June – 5 July 2026; peak day 2 July |
| **Year** | 2025-08-01 to 2026-07-31, 8,760 hours, 5 days over 35 °C, 4 tropical nights |
| **Buildings** | 5,329 footprints, 4,044 scored, 68,533 residential units |
| **Canyons** | 4,471 cross-sections, 2,825 true enclosed canyons |
| **Facade panels** | 29,415, each in 10 height bands |
| **Solved days** | 13 at full facade resolution: the FortyGuard-measured event day plus one representative day per month |
| **Physics solved** | 2.6 billion coupled surface energy balances for the annual totals, plus 30.6 million for the thirteen viewable days |
| **Analyst** | Claude Agent SDK, 20 in-process tools, 3 specialists |
| **FortyGuard spend** | 74,900 of 2,000,000 credits (3.7%) — the year adds nothing, it is free |
| **Tests** | 20 validation checks, 62 Python unit tests, 147 Playwright browser tests |

---

# 1. Running it from scratch

## Prerequisites

- **Python 3.11+** (3.12 is what it is developed on)
- **~1 GB of disk** — about 460 MB of solved fields, plus ~200 MB of cached
  LiDAR and public data
- **Network access on the first build**, for three free sources: NYC Open Data,
  USGS 3DEP LiDAR and Open-Meteo. All three are keyless.
- Optional: **Node 18+**, only for the Playwright browser tests

You do **not** need a FortyGuard key to run this. Every response the project
ever bought is committed under `data/manhattan/`, so the build reproduces
offline for zero credits and a running demo can never spend any.

## Install

```bash
git clone <this repo> && cd heat-canyon

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt
```

## Configure

```bash
cp .env.example .env
```

**Nothing in `.env` is required.** `build`, `validate` and `serve` all work with
an empty file. Each key unlocks exactly one optional thing:

| Variable | Unlocks | Without it |
|---|---|---|
| `FORTYGUARD_API_KEY` | Re-fetching temperature data from the API | The committed responses are used. Zero credits, identical output. |
| `GOOGLE_MAPS_API_KEY` | The photoreal 3D Tiles context layer | The synthetic massing model, which is the default design anyway |
| `ELEVENLABS_API_KEY` | Re-baking the opening film's narration | The committed MP3s play; past those, the browser's own speech synthesiser |
| `HEATCANYON_AGENT_AUTH` | Which credential the analyst uses: `cli` (default), `api_key`, `oauth` | — |
| `ANTHROPIC_API_KEY` | The analyst, in `api_key` mode | With `cli` (the default) it inherits the machine's own logged-in `claude` CLI |

`.env.example` is heavily commented — read it rather than this table if you are
deciding what to set.

> **A note on the two client-visible keys.** A Google Maps key is client-visible
> by design; restrict it to the Map Tiles API, add an HTTP-referrer restriction,
> and cap the root-tile-request quota. The FortyGuard and ElevenLabs keys are
> server-side only and never reach the browser.

## Build, validate, serve

```bash
# Solve the model into web/data/. No API calls. ~15 minutes.
python -m heatcanyon.cli build

# 20 checks, each printing the number it measured. ~1 minute.
python -m heatcanyon.cli validate

# http://127.0.0.1:8000
python -m heatcanyon.cli serve
```

The first `build` also downloads and caches ~200 MB of free public sources
(NYC building footprints, street centrelines, PLUTO, the Heat Vulnerability
Index, the 2015 street-tree census, and USGS airborne LiDAR tiles). Subsequent
builds read the cache.

About twelve of the fifteen minutes are the 8,760-hour annual accumulation. If
you are iterating on the renderer:

```bash
python -m heatcanyon.cli build --year-stride 12   # ~3 minutes
```

Anything but `--year-stride 1` is recorded in `meta.json` under `year.sampled`,
so a sampled build can never be mistaken for a full one.

## Verify it worked

```bash
curl -s http://127.0.0.1:8000/api/health
```

```json
{"ok": true, "study_area": "Midtown Manhattan", "buildings_scored": 4044,
 "year": ["2025-08-01", "2026-07-31"], "periods": 13,
 "agent_available": true, "agent_unavailable_because": null,
 "agent_model": "claude-sonnet-5", "agent_spent_usd": 6.764884,
 "legacy_ai_available": false, "credits_spent": 74900}
```

`validate` is the stronger check. It prints `PASS`, `FAIL` or `UNVALIDATED` per
check *with the number it measured*, because a validation script that only
prints `PASS` is not evidence of anything — and the things that genuinely cannot
be validated (the vertical air-temperature extrapolation, above all) print as
`UNVALIDATED` with the reason rather than being quietly omitted.

## Optional: re-fetch from FortyGuard

This **spends credits**, and the cache means you should not need to.

```bash
export FORTYGUARD_API_KEY=...
python scripts/fetch_fortyguard.py --live --aoi midtown
python scripts/fetch_diurnal.py     --live
python -m heatcanyon.cli spend        # audit the ledger
```

## Optional: the year's meteorology

Already committed (`data/manhattan/_openmeteo_year_*.json`). To re-fetch — free,
no key, Open-Meteo's ERA5 archive:

```bash
python scripts/fetch_year.py
```

## Optional: the browser tests

```bash
npm install
npx playwright install chromium
npx playwright test 09-design -g "one heat ramp"    # ~20 seconds
```

**The full suite takes about 28 minutes** and drives a real WebGL scene through
SwiftShader. See [*What doesn't work yet*](#3-what-doesnt-work-yet) for its
actual state — it is not a clean baseline.

## Docker

```bash
docker build -t heatcanyon .
docker run -p 7860:7860 --env-file .env heatcanyon
```

The image ships the *solved* fields; it does not build them. `python -m
heatcanyon.cli build` needs the raw LiDAR and footprints, which are fetched on a
workstation and shipped as artifacts (`scripts/deploy_hf.py`). The image needs no
Node: `claude-agent-sdk` bundles a standalone `claude` binary in its platform
wheel.

For a split deploy — the 189 MB of static interface and solved fields on a CDN,
the API on a compute host — `scripts/deploy_static.py` handles the static half
and injects the API origin on the way out (`--target gh-pages | cloudflare |
none`, with `--api-base` naming the compute origin).

## Common problems

| Symptom | Cause |
|---|---|
| `build` fails on a cache miss with `allow_live=False` | You changed an AOI or a threshold, so the request hashes to a new cache key. Either revert, or re-fetch with `--live`. |
| The app loads but the buildings are flat boxes | `--no-lidar`, or the LiDAR fetch failed. Re-run `build`. |
| Photoreal toggle says "No Google Maps API key set" | No `GOOGLE_MAPS_API_KEY` in `.env` — or paste one into the panel, which stores it in that browser only. |
| Photoreal is on but nothing streams, console shows `429` | Google's default project quota is **50 root tile requests per day**. Raise it in Cloud console → Quotas → `tile.googleapis.com`. |
| The analyst says it is unavailable | No Claude credential. Install Claude Code and run `claude` once, or set `ANTHROPIC_API_KEY` with `HEATCANYON_AGENT_AUTH=api_key`. Everything else still works. |
| Playwright kills your dev server | Fixed — the suite passes `--port` so its command line differs textually from yours. If you see it, you are on an old `playwright.config.mjs`. |

---

# 2. A real FortyGuard API request and response

Made from this repository, with this repository's client, on **2026-08-30**.

## The call

`heatcanyon/aoi.py` owns the study-area polygon, so the polygon that is billed is
provably the polygon that is rendered. `fortyguard/client.py` handles the
submit-then-poll pattern.

```python
from dotenv import load_dotenv; load_dotenv()
from fortyguard import FortyGuardClient
from heatcanyon import aoi as aoi_mod

client = FortyGuardClient()          # reads FORTYGUARD_API_KEY
area   = aoi_mod.get("midtown")      # Midtown Manhattan, 4.69 km²

result = client.create_heatmap(
    polygon_aoi   = area.polygon_aoi(),
    start_date    = "2026-07-02",    # peak day of the 2026 NY heat wave
    filter_type   = 1,               # 1 = a single hour
    start_time    = "15:00",         # GMT-5
    granularity   = 100,             # metres
    analytic_type = "tcm",           # snapshot temperature
    verbose       = True,
)
```

### Request — `POST https://api.fortyguard.com/v1/heatmap`

```http
POST /v1/heatmap HTTP/1.1
Host: api.fortyguard.com
api-key: <FORTYGUARD_API_KEY>
Content-Type: application/json
```

```json
{
  "polygon_aoi": {
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "properties": { "key": "midtown", "label": "Midtown Manhattan" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[
          [-73.995, 40.744], [-73.970, 40.744], [-73.970, 40.764],
          [-73.995, 40.764], [-73.995, 40.744]
        ]]
      }
    }]
  },
  "date_time": { "start_date": "2026-07-02", "filter_type": 1, "start_time": "15:00" },
  "granularity": 100,
  "analytic_type": "tcm"
}
```

### What came back

```
credits before: 1,910,860
POST /v1/heatmap
Submitted -> activity_id=e275c9a8-fe25-42e4-8ab8-927a0c16b87e
  status: processing
  status: processing
  status: processing
  status: processing
  status: processing
  status: processing
  status: processing
  status: completed
Done.
elapsed 32.1s  credits after 1,906,640  cost 4220
```

### Response — `GET /v1/status/e275c9a8-fe25-42e4-8ab8-927a0c16b87e`

432 tiles. The envelope, one representative feature, and the statistics block,
verbatim:

```json
{
  "activity_id": "e275c9a8-fe25-42e4-8ab8-927a0c16b87e",
  "result": {
    "map_data": {
      "type": "FeatureCollection",
      "features": [
        {
          "id": "0",
          "type": "Feature",
          "properties": {
            "tile_id": 0,
            "average_temperature": 38.7547,
            "min_temperature": 38.7547,
            "max_temperature": 38.7547
          },
          "geometry": {
            "type": "Polygon",
            "coordinates": [[
              [-73.9945618869882, 40.745063696400486],
              [-73.9933654287193, 40.74505326668719],
              [-73.99335194195126, 40.74594764866613],
              [-73.99454841624355, 40.74595807870652],
              [-73.9945618869882, 40.745063696400486]
            ]]
          }
        }
        /* … 431 more tiles … */
      ]
    },
    "stats_data": {
      "temperature_stats": {
        "minimum": 37.9509,
        "maximum": 38.87,
        "mean": 38.44512222222223,
        "standard_deviation": 0.30822492422479353
      },
      "overall_temperature_distribution": [37.9509, 38.1462, 38.50715, 38.738025, 38.87],
      "normal_temperature_distribution": { "x_axis": [ /* 100 bins */ ], "y_axis": [ /* … */ ] }
    }
  }
}
```

**That response is the project's thesis in one object.** A whole square mile of
Manhattan on the hottest afternoon of the record, and the measured air
temperature spans **0.92 K** — 37.95 to 38.87 °C, standard deviation 0.31. It is
a genuinely well-mixed field, and the API is right to report it that way. The
model then takes that anchor and resolves what it means on the walls, where the
same hour spans **14.46 K** and reaches 61.2 °C.

## Every call this project has ever made

`heatcanyon/fg.py` wraps the client with a disk cache keyed on a hash of the full
request payload, plus a credit ledger. Changing a threshold or a granularity
correctly *misses* the cache; re-running the same analysis correctly *hits* it.

```console
$ python -m heatcanyon.cli spend
19 billed call(s) recorded:
  2026-08-27T13:35:28Z  /v1/heatmap         probe_fidi_day            cost=4220
  2026-08-27T13:37:40Z  /v1/heatmap         midtown_tcm_peakhour      cost=4220
  2026-08-27T13:38:12Z  /v1/heatmap         midtown_tcm_fullday       cost=4220
  2026-08-27T13:38:55Z  /v1/heatmap         midtown_exceedance_35C    cost=4220
  2026-08-27T13:39:30Z  /v1/heatmap         midtown_persistence_35C   cost=4220
  …
  2026-08-27T13:40:17Z  /v1/env_params      midtown_env_bryant_park   cost=2900
                        TOTAL                                         cost=74900
```

| Endpoint | Calls | Credits | What it supplies |
|---|---:|---:|---|
| `/v1/heatmap` `tcm` | 10 | 42,200 | 2 m air temperature at 8 diurnal hours + full day + a timezone control |
| `/v1/heatmap` `exceedance` | 1 | 4,220 | Hours above 35 °C across the seven-day wave |
| `/v1/heatmap` `persistence` | 1 | 4,220 | Longest unbroken run above 35 °C |
| `/v1/heatmap` `time_of_measure` | 1 | 4,220 | Hour of day each cell peaks |
| `/v1/heatmap` (probe) | 2 | 8,440 | A FiDi probe and a timezone control, both kept for provenance |
| `/v1/env_params` | 4 | 11,600 | Humidity, apparent temperature, wet bulb, cloud, AQI, solar irradiance at three points |
| **Total** | **19** | **74,900** | **3.7% of the 2,000,000 allowance** |

Every one of those responses is committed under `data/manhattan/` with its
`activity_id`, fetch timestamp, elapsed time and credit delta. The audit trail is
`data/manhattan/_ledger.json`, and it is also copied into `web/data/meta.json`
under `spend`, so the running application can show its own provenance.

## How the API's output is actually used

1. **The anchor.** The `tcm` heatmaps are the 2 m air-temperature field. Every
   facade solve takes its `T_air` from the tile it stands in.
2. **The measured layers.** `exceedance` ships to the browser as itself — the
   *Hours above 35 °C* layer — and `persistence` becomes the *longest unbroken
   run* in every building's file and in its exposure score. They are the two
   figures in the interface labelled **measured** at the ground rather than
   modelled.
3. **The year's calibration.** ERA5 reanalysis supplies 8,760 hours, and it is
   **bias-corrected against FortyGuard** on the one day both cover. That
   correction is the reason the annual layers are defensible at all — and its
   seasonality is unvalidated, which the interface says out loud.
4. **The environmental drivers.** `env_params` supplies the humidity, cloud
   cover and irradiance that the energy balance needs and that a temperature
   field alone cannot provide.

---

# 3. What doesn't work yet

Nothing below is hidden in the application. Every one of these is printed by
`validate`, labelled in the interface, or both.

## Limits of the science

- **Nothing validates air temperature at height.** No public dataset measures it
  anywhere in Manhattan. The uncertainty band widens with height, is drawn in the
  interface, and **exceeds the signal it describes**. Closing that gap needs a
  tower, a UAV, or facade sensors. We say so rather than rendering a confident
  gradient.
- **The year is reanalysis, not measurement.** ERA5, bias-corrected against
  FortyGuard on the single day both cover — so the correction's *seasonality* is
  an extrapolation: a January offset comes from a July fit. Both the corrected
  and the raw series ship, every derived product is labelled *reanalysis
  (bias-corrected)*, and `validate` prints this as an explicitly `UNVALIDATED`
  item.
- **352 of the 365 days are reconstructed, not solved.** Thirteen days are solved
  at full facade resolution. Any other date is its month's solved field plus a
  measured `dT_surface/dT_air` times that day's air-temperature departure. It is
  checked against a full re-solve on deliberately awkward days and labelled in
  the interface, but it is a reconstruction.
- **The annual tier's shading is analytic, not ray-traced.** Ray-marching 8,760
  solar positions is about two hours of compute. The event day is solved both
  ways and the disagreement is published: it can only appear in the ground band,
  and it is a measured over-estimate at corners, plazas and intersections.
- **The free-running indoor temperature is a steady-state estimate.** No thermal
  capacity, no mechanical cooling. A heavy building on a short event will follow
  the outside faster in the model than in reality. It ships anyway, with its
  range, because a resident's exposure is the point and an indoor number is the
  only honest way to state it.

## Limits of the decision layer

- **Recommendations are threshold-triggered, not generated.** Each fires on a
  stated measured or modelled value crossing a stated cutoff, and cites the
  public programme that funds it. The same building always yields the same
  advice. This is a deliberate choice — it is auditable — but it is not
  design optimisation.
- **Every figure with a currency symbol on it is assumed, not modelled.** Wall
  U-values, window-to-wall ratios, tariffs, capex bands and occupancy are era
  rules and published tables, not measurements of these buildings. They ship as
  **ranges, never midpoints**, labelled *assumed* — a fourth and softer tier than
  measured / modelled / composite — and a validation check fails the build if a
  range collapses to a point. `GET /api/constants` and `validate` both report
  the tally, and it is not flattering: **9 of the 33 economic constants are
  sourced; 24 are not.** The capex bands are the weakest of them.
- **Facade shading does not pay back on energy alone** — 39 to 179 years at NYC
  tariffs, negative NPV at both ends of the range. That is the correct answer and
  the module reports it rather than hiding it in an optimistic midpoint. The case
  for the measure lives in indoor exposure and person-hours, which is what the
  programme is ordered by.
- **The equity objective cannot discriminate in this study area.** Every ZIP in
  Midtown falls in the same quintile of the city's Heat Vulnerability Index — all
  4,044 scored buildings carry HVI 2 — so the 40% of the vulnerability score that
  HVI carries is a constant here and does the ordering no work at all. Efficiency
  and equity therefore return byte-identical programmes; the panel detects that,
  **names the degenerate pair** and falls back to a pair that genuinely
  disagrees. A citywide run is what would fix it, and this is an argument for one.

## Limits of the software

- **One study area is built.** The pipeline is parameterised by AOI
  (`heatcanyon/aoi.py`, `--aoi`), and nothing in the physics is New York
  specific, but Midtown Manhattan is the only area with committed API responses
  and a solved field. Another city means new credits and a new LiDAR fetch.
- **The photoreal layer is quota-bound.** Google bills per *root tileset
  request*, one per page session, and the default project quota is **50 a day**.
  Visitor fifty-one gets a 429 and a grey city. The layer is built to issue no
  request at all without a key, and `?photoreal=0` suppresses it for one visit.
- **The photoreal layer on software GL is slow and imperfect.** The screenshots
  in this README were taken through SwiftShader on a machine with no GPU; tiles
  take two to four minutes to settle per camera move, and partial levels of
  detail read as faceted shards until they do. There is a "CPU-efficient tiles"
  toggle for exactly this, and it is what the screenshots use.
- **The analyst needs a Claude credential.** Without one it reports itself
  unavailable and everything else in the application still works. The
  single-shot fallback (`heatcanyon/ai.py`) needs only `ANTHROPIC_API_KEY`, and
  the interface always says which analyst answered.
- **The Playwright suite is not a clean baseline.** As of 2026-08-30 roughly 40
  of 147 tests fail on `main` for reasons unrelated to any given change: renamed
  tabs and panels, a fifth film chapter, a re-baked narration, three in-flight
  specs (`15-orbit`, `15-floor-shards`, `16-smooth-time`), and
  `GoogleCloudAuth: Failed to load data with error code 429` where the tile API
  is rate-limiting the machine. A failing test here is not by itself evidence of
  a regression, and a passing suite is not currently available to preserve. The
  62 Python unit tests and the 20 validation checks *are* green and are the
  faster signal.
- **`main` is a working tree, not a release.** Several sessions edit it at once.

---

# 4. The platform, feature by feature — and how to get to it

Everything below is reachable from the running application. If you want one
route through it: leave the layer on **Façade temperature**, press **▶** to run
the afternoon, then take the top-ranked building on the right and open its file.

## The opening film

The application opens on a film, because the number it exists to explain — a
Midtown wall over 60 °C on an afternoon when FortyGuard's measured air field read
38.4 °C — only means something once you know where it sits in a warming planet's
distribution.

The real NASA GISTEMP anomaly series drawn onto a globe as the planet warms, the
world's 160 largest cities igniting, a lock onto New York, and a single descent
that does not stop until the application is running. There is **no transition at
the end**: for the last five seconds the film computes its pose in the study
area's own east-north-up frame and hands it to the scene renderer every frame, so
both draw the same viewpoint of the same square kilometre and the globe canvas
simply dissolves off. The buildings rise out of the photograph and the photograph
fades to the temperature field behind them.

- **No figure in the narration is written into the script.** Every number is read
  at run time out of `meta.json`, `ranked.json` and `global_temp.json`. Re-run
  the pipeline on a different city and the voice-over updates itself.
- **The narration is a real read** — ElevenLabs, one MP3 per line, keyed by the
  SHA-256 of exactly what was sent and **committed**, so a clone with no API key
  and no network plays it. A page load cannot spend: the endpoint the film calls
  is a cache read.

**Skip it:** `?intro=0`. **Replay it:** the **▶** button beside the panel title.

## The guided tour

Runs unasked the first time a browser sees the application, and takes about two
minutes to show where every control is. **Replay:** the **?** button beside the
panel title. **Skip:** `Esc`, or `?tour=0`.

## Navigating the 3D model

| Action | Does |
|---|---|
| **Drag** | Slide across the city |
| **Scroll** | Zoom |
| **Right-drag** (or hold Shift) | Turn and tilt around whichever building is selected — how you get at the three walls facing away from you |
| **Click a building** | Opens its file at the top of the left panel; the ranking on the right stays put |
| **The pad by the compass** | The same turns and tilts, in steps |
| **The button under it** | Walks right round the selection |

Nothing on screen is decoration: wall colour is modelled surface temperature at
the hour on the scrubber, and the ground wash is the measured air-temperature
field.

## The Measure tab — eight layers in two groups

The colour ramp is **fixed at −20 to 60 °C** and never moves — not between hours,
not between days, not between months. Scrubbing from July to January reads as the
city changing rather than as the legend rescaling underneath it. The bracket on
the ramp marks where the hour on screen falls.

**One moment** (above the rule):

| Layer | What it is |
|---|---|
| Façade temperature | How hot each wall actually gets. A sunlit face runs far hotter than the air standing beside it. |
| Sun and shade | Which walls the sun reaches this hour, ray-traced through the actual 3D scene |
| Hours above 35 °C | **Measured**, across the seven-day wave. Duration harms more than peak. |
| Where to act — heat wave | Event-day exposure weighted by how many people live behind each wall and how well they can cope |

**The whole year** (below it):

| Layer | What it is |
|---|---|
| Where to act — the year | Chronic annual load instead of one heat wave. **It ranks a different set of buildings, and the difference is the finding.** |
| Annual heat dose | Degree-hours the facade spends above 35 °C over the year — accumulated load, not a peak |
| Annual solar dose | kWh/m² each facade band receives in a year — the quantity shading removes |
| Winter sun share | Winter sunlit hours as a fraction of summer, 0.05 to 0.8. Near zero means shading in July costs nothing in January. |

An annual layer has no hour and no day, so **the time controls grey out and say
so** rather than appearing to drive a field that cannot respond.

![The annual "where to act" layer, with the time controls greyed out](docs/images/app/06-annual.jpg)

*Switched to* Where to act — the year. *The clock has gone quiet and says why:
"a total over all 8,760 solved hours — the date and hour do not change it." An
annual layer that appeared to respond to a scrubber would be lying.*

Selecting a building also loads the vertical air-temperature profile with its
uncertainty band into the building's file — it is fetched on demand, because it
is 4.7 MB per period and the least trustworthy field in the model.

## Two time axes

Along the bottom, a **year strip** of 365 columns — each day's temperature range,
coloured by its maximum, with the overnight minimum as a base, so a tropical
night reads as a thick warm bar rather than a statistic. Heat-wave episodes are
bracketed above it (found by run length, not told where they were) and the
thirteen solved days ticked below, the FortyGuard-measured one marked differently
from the twelve reanalysis-anchored ones.

Below it, an **hour strip** of the eight solved hours within the selected day.

- **Drag** the year strip to scrub. **Day / Month / Season / Year** changes what
  is averaged.
- **▶** on the year row swings the shadow line: December's noon sun is 26° lower
  than June's, so a canyon half lit in July has a floor in permanent shade in
  January.
- The figures under the hour strip are the weather that drove the hour, and the
  pill on the right says whether you are looking at a **measured anchor**, a
  **solved day**, or a **reconstruction**.

![The same city in mid-afternoon, closer in, with the facade field over the photoreal mesh](docs/images/app/02-midtown-afternoon.jpg)

*Mid-afternoon on 2 July. The east–west avenues take the sun full on the face
while the north–south slots hold their shade — the variation the 2 m field
cannot see.*

Both axes *move* the city rather than cutting to it — the mesh carries two clock
states at once with one uniform sliding between them, so a played day is one
continuous sweep. `prefers-reduced-motion`, or `?smooth=0`, puts the cuts back.

## The ranking rail

4,044 buildings ranked by heat exposure against how badly their occupants can
cope — age of stock, homes inside, the city's own Heat Vulnerability Index.

**Two orderings, and they disagree.** *Heat wave* asks who is in trouble during
an acute event; *the year* asks whose fabric is loaded all year. They share about
a quarter of their top fifty. Where a building ranks far higher on the year, its
problem is chronic and fabric measures matter; far higher on the wave, and its
problem is acute and relief matters.

A ranking is not a verdict. It is a queue, and the file behind each row shows its
whole working.

![A selected building, its file open on the left, lit against the dimmed photoreal city](docs/images/app/03-building-detail.jpg)

*Clicking a building opens its file at the top of the left panel while the rail
keeps its place, and dims the rest of the city around the selection.*

## The building file

The heat wave first: hours above 35 °C, the longest unbroken run, the hottest
wall, and the difference between faces. Then **the year** — accumulated facade
dose, sunlit hours, the summer-to-winter swing, and a bar per month showing when
this particular wall actually peaks. Then temperature up the height of the
building with its uncertainty band, the reasons it ranks where it does on *both*
orderings, and what can be done about it.

The file opens in the panel rather than over the ranking, so working down a list
of sixty addresses does not cost you the list sixty times. **Close**, or `Esc`.

## The Decide tab — a floor schedule and a what-if

![The Decide tab, showing the per-floor schedule with attributed reasons](docs/images/app/04-decide.jpg)

A temperature is a finding. This is the answer to the question everyone actually
asks next, which is *so what do I do*.

`physics.surface_temperature` solves

```
(1−α)S + ε(f_sky·σT_sky⁴ + (1−f_sky)·σT_sur⁴) = εσT_s⁴ + h_c(T_s − T_air) + G
```

and used to return one float, throwing away the terms on the left — which are the
*reason* the surface is hot. Linearising the emission term about air temperature
makes the balance separable into three drivers that simply add:

| Driver | What it is | What moves it |
|---|---|---|
| **solar** | Absorbed shortwave | Shading, albedo, glazing, canopy |
| **trapping** | Longwave from the surfaces opposite, above air temperature | The building across the street, canyon geometry, insulation |
| **sky** | Longwave to a cold sky — the only free cooling a surface gets | Sky view factor; a small magnitude means no night recovery |

That is the whole prescription engine's selector. Four buildings can all peak at
53 °C for four different reasons, and those reasons take four different measures.
A floor whose excess is 71% direct solar wants external shading; a floor whose
excess is 58% longwave off the wall opposite does not, and **its intervention is
a coating on somebody else's building.**

**The floor schedule** gives one row per storey: peak surface temperature and the
hour it happens, the free-running indoor estimate, cooling load in kW, the
attributed reason, and whether the geometry permits overnight recovery at all.
Watch the bars swap as you go up a deep canyon — lower floors are heated by the
street, upper floors by the sun — and the crossover is where the prescription
changes.

**The measure is specified, not named.** Not "external shading" but a projection
in metres, on a named face, over a named floor range, on a stated area, with the
effect from a re-solve rather than a coefficient:

```
P = h_window · cos(γ_sun − γ_wall) / tan(α_sun)
```

which also yields the most useful negative result in facade design for free: on
an east or west wall the peak arrives at low altitude with the sun nearly normal
to the glass, `P` diverges, and a horizontal overhang is simply the wrong device.

**The what-if table** re-solves the canyon per intervention — trees, a cool roof,
lighter paving, an awning — and reports the change in °C on the road, on the
wall, on the air, and on what a body standing there actually exchanges heat with.
A second table runs the same measures at every month's peak, so the seasonal
**cost** column is a number rather than a caveat. Trees do a great deal on a
shallow street and almost nothing on a deep one already in shade: same
intervention, different street, different answer.

## The portfolio

**PORTFOLIO AND COSTS**, at the foot of the ranking rail. Nobody spends money one
building at a time. Every measure on every ranked building becomes a candidate
ordered by cost per person-hour of exposure avoided, with a budget line you can
drag — everything left of the line is the programme.

Two objectives sit side by side and they disagree: efficiency buys the most
avoided exposure per dollar, equity buys it for the people least able to cope.
That disagreement is a political choice being made either way, so both columns
are on screen. (In *this* study area they are degenerate — see
[what doesn't work yet](#limits-of-the-decision-layer).)

## Umbra, the analyst

![The analyst window over the model, with its suggested questions](docs/images/app/05-analyst.jpg)

**Open:** the *Analyst ↗* tab, or `A`. **Close:** `Esc`.

Not a chat box. It is a Claude Agent SDK turn with this project's physics engine
importable, a shell, a workspace, twenty in-process tools over the solved
fields, and three specialists it can consult. It does work rather than lookups:

- **Re-solves an intervention** anywhere in the city, over any window — an albedo,
  a canopy fraction, a shading factor, a wall admittance — and reports the deltas
  with their spread across canyons and their seasonal split.
- **Runs the statistics properly** — Moran's I with a permutation test, Getis-Ord
  Gi\* with a false-discovery correction, OLS with robust standard errors and the
  residuals named.
- **Writes its own scripts** against the documented arrays.
- **Allocates a budget** under four objectives, so the gap between efficiency and
  equity is visible.
- **Drives the map** — sets the layer, scrubs the year to the date it is talking
  about, lights up the buildings it names.

Every tool call appears in the transcript with its arguments and what came back,
because the claim is that every number came out of this model, and a claim like
that is worth exactly what the evidence on screen is worth. **It starts with no
numbers in context**: every figure it reports has to come back from a tool call
or a script it ran.

It can read the open web — for context this model does not hold, such as a
programme's funding rules or a standard's threshold — and everything from there
is labelled **EXTERNAL**. It may never source a *figure* from the web that this
model can produce itself.

Spend is bounded three ways: per turn (`BUDGET_USD`, harness-enforced), by a
token countdown the model can *see* so it wraps up rather than being guillotined
mid-finding (`TASK_BUDGET_TOKENS`), and across the whole server process
(`SESSION_BUDGET_USD`).

## Photoreal context

**Measure tab → CONTEXT → Photoreal context.**

Drapes the model over Google's Photorealistic 3D Tiles — real roads, kerbs,
vehicles and street trees, because they are part of the same photogrammetry mesh.
What it buys is recognition: a client who cannot read a sky view factor can
absolutely read *that is the north side of 42nd Street*.

It opens **on** wherever a key can be found, and remembers being switched off. No
key means no request at all; `?photoreal=0` suppresses it for one visit without
touching the remembered preference.

Five controls, and each is a real decision rather than a slider:

| Control | What it does |
|---|---|
| **Photo colour** | Desaturates the photograph so the data reads against it |
| **Heat shows above** | A *threshold*, not a strength — spends the colour on the top of the domain and leaves the rest as photograph, so the frame has a figure and a ground at any altitude |
| **Field on streets** | How strongly the measured 2 m field washes the roadway |
| **Context reach** | A cap on how far the photographic world extends. Everything past it is never requested, so the download queue spends itself on the study area instead of on New Jersey |
| **CPU-efficient tiles** | For a machine without a GPU. Software renderers spend their frame budget on partial levels of detail, which look like broken geometry |

Google's per-tile credits are aggregated and shown in a strip that labels both
sides, so a viewer can tell Google's basemap from our data. Nothing reads geometry
back out of the tiles — the surface model that feeds the physics is public LiDAR.


## Getting out of the way

The chevrons fold the left panel, the ranking and the clock away individually.
Each leaves a labelled tab on the wall it slid off — **INSPECT**, **RANKING**,
the hour — so you can always tell what is coming back.

## Keyboard reference

| Key | Does |
|---|---|
| `Space` | Play / pause the clock |
| `←` `→` | Step back and forward through the day |
| `Esc` | Clear the selection; close the analyst |
| `[` `]` `\` | Fold the left panel, the ranking, the clock |
| `H` | Fold all three — the fastest route to just looking at the city |
| `N` | Face north |
| `Q` `E` | Turn left and right around the selection |
| `W` `S` | Tilt up and down |
| `O` | Orbit the selection continuously |
| `A` | Open / close the analyst |

## URL flags

| Flag | Does |
|---|---|
| `?intro=0` | Skip the opening film **and** the tour |
| `?tour=0` / `?tour=1` | Force the tour off or on |
| `?photoreal=0` | Suppress the photoreal layer for this visit only |
| `?smooth=0` | Cut between clock states instead of dissolving |

## The HTTP API

`python -m heatcanyon.cli serve` is a FastAPI app. The interface is a client of it, and so is
anything else you want to point at it.

| Route | Does |
|---|---|
| `GET /api/health` | Study area, counts, analyst availability, credits spent |
| `GET /api/constants` | Every physical and economic constant, with its provenance tier |
| `POST /api/intervention` | Re-solve a canyon under a measure |
| `GET /api/intervention/catalogue` | The measures available |
| `POST /api/prescribe` | The floor schedule and specified measures for a building |
| `GET /api/portfolio` | The budget-constrained programme under four objectives |
| `GET /api/warming` | The GISTEMP series the film draws |
| `POST /api/agent/ask` · `GET /api/agent/runs/{id}/events` | Start an analyst turn; stream its transcript |
| `POST /api/agent/interrupt-all` | Stop every running turn |

---

# 5. How it is built

## Layout

```
heatcanyon/
  aoi.py         study areas — the billed polygon is the rendered polygon
  fg.py          cache-first FortyGuard access + credit ledger
  nyc.py         free public-data ingest (field names verified live)
  lidar.py       USGS 3DEP airborne LiDAR → roof profiles and setbacks
  geometry.py    DSM, sky view factor, shadows, facades, canyons
  solar.py       solar position, clear-sky irradiance, canyon shading
  physics.py     vertical air profile, coupled energy balance, MRT, WBGT
  exposure.py    transparent scoring + threshold-triggered actions
  scenarios.py   what-if by re-solving, not by coefficient
  year.py        the climate year: 8,760 hours, calibrated and summarised
  yearsolve.py   the same physics in array form, validated against physics.py
  prescribe.py   attributed drivers → specified measures
  economics.py   loads, money and carbon, every constant labelled
  portfolio.py   budget-constrained programmes under four objectives
  agent/         the analyst: tools, persona, queries, transport
  server.py      FastAPI: static, model API, agent streaming
  pipeline.py    the build, end to end

fortyguard/      the API client (one method per endpoint, submit-and-poll)
web/             the interface: three.js scene, film, panels, solved fields
scripts/         fetchers, validators, deployers, the voice pre-warm
docs/            the long-form record
tests/           62 Python unit tests + 147 Playwright browser tests
```

## Data sources

| Source | Provides | Kind | Cost |
|---|---|---|---|
| FortyGuard `/v1/heatmap` | 2 m air temperature, 8 diurnal hours + full day | measured/modelled product | credits |
| FortyGuard `/v1/heatmap` `exceedance` \| `persistence` | Hours above 35 °C and longest unbroken run | measured/modelled product | credits |
| FortyGuard `/v1/env_params` | Humidity, apparent temperature, wet bulb, cloud, AQI | measured/modelled product | credits |
| NYC Open Data `5zhs-2jue` | Building footprints, roof height, ground elevation | measured (~2017 photogrammetry) | free |
| USGS 3DEP `NY_NewYorkCity` (EPT) | 2017 airborne LiDAR; roof profiles and setbacks on a 3 m grid | measured (0.73 m post spacing) | free |
| NYC Open Data `inkn-q76z` | Street width curb to curb, lanes, name | measured | free |
| NYC Open Data `64uk-42ks` (PLUTO 26v2) | Year built, floors, residential units, land use, assessed value | administrative record | free |
| NYC Open Data `4mhf-duep` | DOHMH Heat Vulnerability Index by ZCTA | composite index | free |
| NYC Open Data `uvpi-gqnh` | Street Tree Census 2015 | measured (2015 vintage) | free |
| NYC Open Data `qdq3-9eqn` | Hyperlocal street-level air temperature, 84 Manhattan sensors | measured | free |
| ERA5 via Open-Meteo archive | 8,760 hours of temperature, humidity, wind, cloud, beam/diffuse irradiance | reanalysis (bias-corrected) | free |
| NASA GISTEMP | The global anomaly series the opening film draws | measured | free |
| Google Photorealistic 3D Tiles | Optional photographic context | photogrammetry | per session |

Every layer in the interface is tagged **measured**, **reanalysis**,
**modelled**, **composite** or **assumed** wherever it appears.

## Further reading

| Document | Covers |
|---|---|
| [docs/HEATCANYON.md](docs/HEATCANYON.md) | The project in full — the film, the interface, the findings, the honesty notes |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | The physics, and the measured size of every approximation |
| [docs/YEAR.md](docs/YEAR.md) | The temporal pivot, the bias correction, and two physics corrections the year forced |
| [docs/DECISIONS.md](docs/DECISIONS.md) | The decision layer: attribution, prescription, economics, portfolio |
| [docs/AGENT.md](docs/AGENT.md) | The analyst: tools, containment, and the three spend bounds |

## Why three.js rather than deck.gl or MapLibre

Because the thing being drawn is not a map. It is 29,415 vertical panels each
carrying ten independently-coloured height bands, lit by a sun whose position is
solved per hour, casting ray-traced shadows into a canyon. Layer-based mapping
libraries model the world as extruded polygons with one colour each — the
variation *up a single facade* is the entire finding, and it is precisely the
thing they cannot express.

---

## Notebooks

This repository began as the FortyGuard Temperature API quickstart, and those
walkthroughs are still here and still work:

```bash
jupyter lab
```

| Notebook | Endpoint |
|---|---|
| `00_setup.ipynb` | Key check and credit balance |
| `01_create_heatmap.ipynb` | `/v1/heatmap` — all four analytic types |
| `02_environmental_parameters.ipynb` | `/v1/env_params` |
| `03_satellite_segmentation.ipynb` | `/v1/satellite_segmentation` |
| `04_street_view_segmentation.ipynb` | `/v1/street_view_segmentation` |
| `05_heat_intelligence_report.ipynb` | `/v1/heat_intelligence` |

## Licence

MIT — see [LICENSE](LICENSE). The data sources carry their own terms; Google's
Photorealistic 3D Tiles in particular may not be cached, stored, or have geometry
derived from them, and this project does none of those things.

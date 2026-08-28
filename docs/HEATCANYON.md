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

## The opening

The application opens on a film, because the number this project exists to
explain — a wall at 57 °C on a street in Midtown — only means something once you
know where it sits in a warming planet's distribution.

It is about a hundred seconds: the real NASA GISTEMP anomaly series drawn onto a
globe as the planet warms, the world's 160 largest cities igniting, a lock onto
New York, and a dive that bottoms out over Manhattan and cross-fades into the
live model while the city camera is already descending. A procedural score plays
under it, and the narration is spoken by the platform's speech synthesiser where
one exists — captions carry the whole script where it does not.

Two properties are worth stating, because they are what make it maintainable:

- **No figure in the narration is written into the script.** Every number is read
  at run time out of `meta.json`, `ranked.json` and `global_temp.json`. Re-run the
  pipeline on a different city or a different day and the voice-over updates
  itself. The only hand-written constants are two round numbers in one joke, and
  they carry their sources in `web/js/story.js`.
- **No beat has a duration.** A beat is as long as its own sentence takes to
  deliver, and the camera interpolates across whatever that turns out to be, so
  editing a line lengthens its shot instead of desynchronising the film.

`?intro=0` suppresses it — the Playwright suite uses that — and so does a
`prefers-reduced-motion` preference. There is a *Skip* control throughout and a
*Film* button in the masthead to play it again.

### And then the tour

The film explains the city. It says nothing about the instrument, and the frame
it hands over is three panels, six layers, a day on a scrubber and two camera
modes, with no indication of which one to touch first. So when the overlay
leaves, a guided tour comes up: twelve spotlit steps, one control each, in the
order you would actually use them — the model, the layers and their fixed scale,
the day, the street camera, the ranked list, one building's file, *What if*,
*Ask*, the photoreal toggle, and how to fold the whole interface away again.

Three details are the difference between this and the onboarding overlay
everybody clicks past:

- **Each step puts the interface into the state it is describing.** The card
  about the scenario table opens the *What if* tab first; the card about a
  building's file selects the top-ranked building, in the panel and in the model
  both. There is nothing to imagine.
- **Targets are resolved when the step opens, not when the tour is written.** A
  control that is hidden or absent drops its step rather than spotlighting an
  empty rectangle, and the highlight re-measures every frame, so a panel that is
  still animating or a pane that scrolls does not leave it pointing at nothing.
- **It runs once.** `hc.tour.v1` in localStorage retires it, `?intro=0`
  suppresses it along with the film, `?tour=1` forces it back, and the masthead
  keeps a *Tour* chip. While it is up it owns Escape — which in the application
  means fold both panels, and in the tour means leave.

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
  js/film.js       the opening film: globe, dive, score, cross-fade
  js/story.js      its script and storyboard, both computed from the data
  js/tour.js       the guided tour that picks up where the film hands over
scripts/         fetch (metered), validate (free), make_globe_assets (free)
tests/           Playwright: geometry, physics behaviour, visual, film, tour
docs/
  METHODOLOGY.md          what the model does and where it stops
  research/               literature verification and effect sizes
```

## Photoreal context (optional, off by default)

The clean synthetic basemap is the default for a reason argued at the top of
`web/js/scene.js`: a photographic basemap competes with the data for attention.
But recognition has its own value — a client who cannot read a sky view factor
can read "that is the north side of 42nd Street" — so Google's Photorealistic
3D Tiles are available as a toggle in the View tab.

**It needs your own Google Maps API key.** Enable the Map Tiles API on a
billing-enabled Cloud project, create a key, and paste it into the panel; it is
kept in `localStorage` and never committed. `?gmaps_key=…` works once as well.

**Cost.** Billing is per *root tileset request* — roughly one per session, not
per tile — against a free allowance of 1,000/month, so a visitor who pans around
for an hour streaming hundreds of megabytes is one billable event. Demo-scale use
is comfortably free. The layer constructs no `TilesRenderer` until switched on,
so with the toggle untouched nothing billable is ever requested; `tests/04-photoreal.spec.mjs`
asserts exactly that. Set a quota cap on root tile requests anyway.

**Why tiles and not Street View.** `WebGLOverlayView` binds to a vector `Map`,
never to a `StreetViewPanorama`, and a panorama's depth buffer is not exposed —
so anything drawn over one floats in front of every foreground object,
misregisters as the pose drifts, and cannot move continuously because panoramas
sit ~10 m apart. 3D Tiles are real geometry: occlusion is correct by
construction and the existing first-person walker keeps working untouched.

**How the data gets onto the buildings.** Not by drawing our own geometry next
to Google's. That was tried and it fails for a reason no amount of tuning fixes:
the two describe the same buildings with different shapes — ours a flat-lidded
prism on the footprint, theirs the measured surface — so wherever they disagree
they interpenetrate. Real roofs slice through flat colour, real walls poke out of
ours, and the seam flickers as the camera moves. The problem is shape, not depth
bias, so there is no offset that resolves it.

Instead the field is **projected onto Google's mesh** per fragment. The pipeline
exports two rasters — `massing_bid.bin` (building index per 3 m cell) and
`massing_h.bin` (refined LiDAR surface height, decimetres) — and the browser
builds a third table holding the colour of every
(building, azimuth bucket, height band) cell. A fragment shader on the tiles
then derives its surface normal from world-position derivatives, probes the
index raster a little way *into* the surface, turns world Y into the same height
band the physics solved, and looks up the colour. Our own prisms are hidden while
this is on, so there is only one set of geometry in the frame and nothing can
interpenetrate.

The colour table is accumulated inside the existing recolour loop rather than
computed separately, which guarantees the projected colour equals the colour the
geometry would have had. A second implementation of the ramp, the orientation
shading and the contrast curve would drift, and the disagreement would only
surface as a screenshot that looked subtly wrong.

Two details that were bugs before they were features. The index raster is
**dilated by two cells**, because Google's wall is an approximation of ours and a
probe near a footprint edge otherwise reads "street" — which produced vertical
stripes along every large slab at street level, one per 3 m cell boundary, as
neighbouring fragments disagreed about whether a building was there. And the
probe runs at **two depths**, shallow first, so walls standing metres apart still
resolve to the right building while a wall well outside ours is still found.

**Three problems it had to solve.**

1. *Draco.* Google's tiles are Draco-compressed glTF. Without a decoder every
   tile parses to nothing and the scene stays silently empty, which reads as a
   bad key and sends you debugging the wrong thing.
2. *The flat datum.* The scene deliberately draws every building from y = 0
   rather than its NAVD88 ground elevation. Midtown's terrain spans 0–26 m, so
   against Google's real terrain that is up to 13 m of misregistration — four
   storeys. The layer therefore swaps in a second vertex set on true elevations,
   referenced to the median footprint elevation, plus a 0.7 m outward push so the
   coloured skin does not z-fight the photogrammetry facade it sits on. Both are
   real vertex positions, not a vertex-shader offset, because picking raycasts
   against CPU-side geometry.
3. *Legibility.* Full-colour photogrammetry is saturated everywhere and fights an
   inferno ramp, so a shader patch pulls it toward grey by default and washes the
   measured 2 m field onto up-facing near-ground surfaces — the roads and plazas
   carry the measured layer the flat ground plane used to.

**Walking it.** The scene draws on a flat datum; the photoreal layer brings real
terrain. Reconciling those for the first-person walker took three goes, and the
first two are worth recording because each looked plausible.

The eye was left at the datum while Google's roadbed sat ten metres higher, so
the camera stood *inside* the terrain looking up through it — which renders as a
storm of pale shards and is the single worst artefact the layer produced. Fixing
that meant a ground-elevation raster (`ground_elev.bin`), derived from the same
`base_m` our facades are offset by so the two cannot disagree, with the streets
between buildings filled by nearest-neighbour dilation.

That got within a metre, which is not close enough: a metre is the difference
between standing on a road and standing in it. So the layer now **probes
Google's own surface** with a downward raycast a few times a second and eases
toward it, keeping the raster as the fallback for the moment before tiles
arrive. Measured on a Madison Avenue walk, the raster said 11.0 m where the mesh
is at 10.11 m, and 1.8 m where it is at 2.61 m — errors in both directions, which
is exactly what no constant can fix.

`errorTarget` also drops from 12 to 5 on entering street mode. A pedestrian
needs depth where a fly-over needs breadth, and the loose overhead value leaves
root-level slabs standing where the road should be.

**A blend that started too strong.** The first defaults were 0.55 desaturation
and 0.85 data wash. At that strength the heat colour is paint: it covers the
windows, cornices and stonework that are the whole reason for a photographic
mesh, and the result reads as flat coloured cardboard — indistinguishable from
tiles that failed to refine, which sent a good half hour of debugging in the
wrong direction. The tint is now 0.55, modulated by the surface's own luminance
so shadow and highlight survive it.

**Terms that shaped the code.** Per-tile `asset.copyright` credits are
aggregated into an on-screen strip that labels Google's basemap separately from
our data. Tiles may not be cached, so no visual baseline in the suite enables the
layer. Geometry may not be derived from the tiles — nothing reads back from them,
and the surface model that feeds the physics comes from public LiDAR instead.

## Why three.js rather than deck.gl or MapLibre

Both colour one polygon per building. `fill-extrusion-vertical-gradient` is a
fixed shading darkening, not a data-driven ramp. The entire point here is
variation *across a single facade* — up its height and by which way it faces — so
the facade geometry is generated directly as coloured triangles, one quad per
band per panel. The cost is supplying our own basemap, which is no loss: a
photographic basemap would compete with the data for attention.

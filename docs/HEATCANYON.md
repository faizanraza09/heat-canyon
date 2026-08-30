# HeatCanyon

**A 3D street-canyon heat exposure engine for Midtown Manhattan across a whole
year, built on the FortyGuard Temperature API and free public data, with an
analyst that re-solves the physics to answer questions.**

FortyGuard measures air temperature at 2 m. This resolves what that means on
every facade, floor and sidewalk of a Manhattan street canyon — for 8,760 hours
— then ranks which buildings to act on, tests what would actually help, and lets
you ask.

---

## Two things this is not

It is not a heat map. A heat map of 2 m air temperature is what we started from,
and the whole project exists because a Manhattan street canyon varies **5.6 times
more in surface temperature than in air temperature**: what a body on the pavement
exchanges heat with is set by solar geometry and the walls either side of it, not
by the forecast.

And it is not one day. It was, and one day turned out to be the wrong unit. The
platform now solves the whole year, and the first thing the year said was that
**the fifty buildings most at risk during a heat wave and the fifty most loaded
across a year overlap by about a quarter**. A programme designed against a heat
wave and a programme designed against a year are different programmes.

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
| **Event** | New York heat wave, 29 June – 5 July 2026; peak day 2 July |
| **Year** | 2025-08-01 to 2026-07-31, 8,760 hours, 5 days over 35 °C, 4 tropical nights |
| **Buildings** | 5,329 footprints, 4,044 scored, 68,533 residential units |
| **Canyons** | 4,471 cross-sections, 2,825 true enclosed canyons |
| **Facade panels** | 29,415, each in 10 height bands |
| **Solved days** | 13 at full facade resolution: the FortyGuard-measured event day plus one representative day per month |
| **Physics solved** | 2.6 billion coupled surface energy balances for the annual totals, plus 30.6 million for the thirteen viewable days |
| **Analyst** | Claude Agent SDK, 19 in-process tools, 3 subagents, no web access |
| **API spend** | 74,900 of 2,000,000 credits (3.7%) — unchanged by the year, which is free |
| **Tests** | 20 Python validation checks, 62 Python unit tests, 80 Playwright browser tests |

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# The year's meteorology. Free, no key — Open-Meteo's ERA5 archive. Cached, so
# you only ever run this once. See docs/YEAR.md.
python scripts/fetch_year.py

# Everything below runs offline. The cached API responses are committed, so
# reproducing the whole project costs zero FortyGuard credits.
python -m heatcanyon.cli build      # solve the model -> web/data/  (~15 min)
python -m heatcanyon.cli validate   # 20 checks
python -m heatcanyon.cli serve      # http://127.0.0.1:8000
```

`build` takes about fifteen minutes, and about twelve of those are the
8,760-hour annual accumulation. `--year-stride N` skips most of it while you are
working on the renderer; anything but 1 is recorded in `meta.json` under
`year.sampled`, so a sampled build cannot be mistaken for a full one.

The analyst needs a Claude credential — either a logged-in `claude` CLI (the
default, and what makes it work on a laptop with nothing set) or
`ANTHROPIC_API_KEY` with `HEATCANYON_AGENT_AUTH=api_key`. Everything else works
without one, and the interface says which analyst answered.

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

The real NASA GISTEMP anomaly series drawn onto a globe as the planet warms, the
world's 160 largest cities igniting, a lock onto New York, and then a single
descent that does not stop until the application is running. A procedural score
plays under it, and the narration is read by ElevenLabs — cached to disk and
committed, so it costs nothing to play and works offline. Where a line has no
recording the platform's speech synthesiser takes that line, and where there is
no synthesiser either the caption carries it. See **The voice** below.

### The descent, and why there is no transition

The first cut of this ended at about 190 km, washed the frame warm, and
cross-faded into the model. Two things made that read as an edit rather than as a
continuing shot, and both are now fixed in the places they were actually wrong.

**The camera appeared to stall.** Halving your height above a city doubles what it
fills of the frame, so a camera that loses height at a constant *rate* appears to
accelerate wildly and then stop dead. The storyboard now states an ALTITUDE in
kilometres and film.js interpolates it geometrically — a constant ratio per
second is a constant apparent speed — with a custom ease on the last beat that
holds the rate and then settles rather than easing in from a standstill.

**There was nothing to look at below ten kilometres per pixel**, which is where
the Natural Earth land mask runs out. `scripts/fetch_approach.py` bakes a
six-level satellite pyramid centred on the study area, 1,800 km across down to 7,
each level about a third the width of the one above it. Two sources: the two
widest levels are Esri World Imagery, and the four the eye actually lands on are
USGS NAIP, because Esri's mosaic seam runs straight down the Hudson three
kilometres from the study area. NAIP is land-only, so its voids over open water
are filled back from Esri and brightness-matched at the join; the levels are then
chained to one exposure by measuring each against the next over the ground they
share. On the globe each level is a curved patch faded out radially — a disc, not
a rectangle, because a rectangle appearing on a planet is an edit.

**And the handover is not a transition at all.** For the last five seconds the
film computes its pose in the study area's own east-north-up frame, which is the
frame `scene.js` already works in, and hands it over every frame; `LANDING` in
film.js is `scene.js`'s opening view written in spherical terms. So both
renderers draw the same viewpoint of the same square kilometre, the application
lays the same two mosaics on its own ground, and the globe canvas dissolving off
over the last 1.3 seconds is a photograph becoming a measurement — the buildings
rise out of the picture, the photograph fades to the temperature field behind
them, and the camera never stops moving.

Three properties are worth stating, because they are what make it maintainable:

- **No figure in the narration is written into the script.** Every number is read
  at run time out of `meta.json`, `ranked.json` and `global_temp.json` — the span
  of the record, the date, the peak air temperature, the wall, the pavement, the
  height-to-width ratio, the hour. Re-run the pipeline on a different city or a
  different day and the voice-over updates itself. There are no hand-typed numbers
  in it at all; the only numerals in the whole script are the year.
- **Figures are spelled as words.** "A hundred and forty-six years", not "146
  years"; "thirty-nine degrees", not "39 °C". That is the design's register, and it
  pays for itself twice: a caption set in Instrument Serif at 38px reads as prose
  rather than as a readout, and the caption and the spoken line can be the same
  string, because a synthesiser handed "39 °C" says "thirty-nine degree see".
- **A beat's length is stated, not derived.** It used to be computed from the
  beat's own word count, so that lengthening a line lengthened its shot. That is a
  defensible idea which produced a film of 1:47 — two and a half times what the
  design asks for — and made the runtime a function of whether the viewer had
  audio on, since a spoken line needs longer than a read one. The title card
  promises a runtime and the transport bar sizes its four segments by chapter
  length; both should be the same on every machine.

  The recorded voice qualifies that third one, and only that one. A beat whose
  recording is longer than its shot is **stretched to fit** — see below — so the
  stated length is a floor rather than a fixed value. What the rule was actually
  protecting survives: the length still does not vary by machine, because every
  viewer plays the same committed recordings and stretches by the same amount.

## The voice

The narration is a real read: ElevenLabs, one MP3 per line, synthesised by
`heatcanyon/voice.py` and played by `web/js/voice.js` through the same limiter as
the score, which ducks about eight decibels under each line and comes back up
between them.

Four things about it are worth knowing.

**It costs nothing to run.** Every line is keyed by the SHA-256 of exactly what
was sent — the text, the voice, the model, the format, and the neighbouring lines
sent as prosody context — and written to `web/data/vo/<key>.mp3`, which is
committed. A clone with no API key and no network plays the real read. There is
no invalidation logic because there is nothing to invalidate: an edited line is a
different key and a new file, and `heatcanyon voice --prune` sweeps the ones the
index no longer names.

**A page load cannot spend.** `POST /api/voice/lines` reads the cache and nothing
else unless the caller sets `synthesise`, which the film never does and
`scripts/prewarm_voice.mjs` always does. That asymmetry is not caution in the
abstract: the cache in this repository was first filled by a Playwright suite in
another terminal, which opened the application, played the film and spent a third
of the month's free allowance before anyone noticed. Baking is a deliberate act,
taken once, by someone who meant to.

**The shot is as long as the sentence.** Measured against the recordings, 22 of
the 27 spoken beats ran over their stated length, several by more than double —
the second line is 14 seconds of audio in a 5.5-second beat, so two thirds of the
sentence that opens the film would never have been heard. So `Film._retime`
gives each beat a floor of `recording / 1.15 + 0.25 s`: a line may be hurried by
up to fifteen percent to fit (pitch preserved, and inaudible at that margin), and
past that the beat grows. Beats already long enough are untouched, and so are the
three silent beats of the descent. The film therefore runs 3:35 voiced against
2:42 unvoiced, and the title card is re-printed when the recordings arrive rather
than left holding the shorter figure. The lengths come from the server, which
measures each MP3 by counting its frames, because `HTMLAudioElement.duration` is
`NaN` until the file has been fetched and the film needs to lay its beats out
before it starts.

**A line is checked before it is played, not just found.** Five beats in chapter
three take their wording from `floors.json` and `prescriptions.json`, which
`data.js` fetches in the background — so those sentences change after the script
has already been sent to be read. `Narrator.has` compares the text as well as the
index and refuses a recording of the earlier wording, because a stale line under
a current caption is worse than no line at all; the film asks a second time when
the decision layer lands, which corrects those five and costs nothing.

The fallback is per line, never per film: a script with one unmade line is 26
lines properly read and one in the browser voice. `?voice=0` runs the unvoiced
cut, which is what the two tests about the film's geometry measure.

```
node scripts/prewarm_voice.mjs --dry   # what the film says, and what is missing
node scripts/prewarm_voice.mjs         # buy the missing lines, once
heatcanyon voice                       # cache, plan and settings
heatcanyon voice --lines               # the cached script, line by line
heatcanyon voice --voices              # the voice ids on the account
```

Re-bake after editing `story.js` or re-running the pipeline: the script's figures
come from the model, so a changed number is a changed sentence and a changed
sentence is a new recording. The dry run is free and says exactly which.

`?intro=0` suppresses it — the Playwright suite uses that — and so does a
`prefers-reduced-motion` preference. It runs under a real transport bar: four
segments sized by their own chapter's length, a running clock, pause, chapter
stepping and *Skip to atlas*, with <kbd>Space</kbd> and the arrows bound to the
same three ideas they mean in the atlas. The **▶** button beside the panel title
plays it again.

### And then the tour

The film explains the city. It says nothing about the instrument, and the frame
it hands over is three panels, twelve layers, a year and a day on two scrubbers,
and two camera modes, with no indication of which one to touch first. So when the
overlay leaves, a guided tour comes up: thirteen spotlit steps, one control each,
in the order you would actually use them — the model, the layers and their fixed
scale, the year strip and what a solved day is, the hour within it, the street
camera, the two orderings of the ranked list, one building's file, *What if* and
its seasonal cost column, the analyst, the photoreal toggle, and how to fold the
whole interface away again.

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
  Two hooks exist for the same reason: `tab` raises the pane a target lives in,
  and `reveal` brings a target into existence, both *before* the usability check
  rather than after it. Doing the second in `enter` was a real bug — the card
  about one building's file targets `#selcard`, which is `hidden` until something
  is picked, so the step read as missing and three of twelve steps silently
  vanished while the dots still promised twelve.
- **It runs once.** `hc.tour.v1` in localStorage retires it, `?intro=0`
  suppresses it along with the film, `?tour=1` forces it back, and the panel
  header keeps a **?** button. While it is up it owns the keyboard on the capture
  phase — Escape means leave the tour, not what it means in the application.

## The interface

Twelve layers in two groups, each tagged **measured**, **reanalysis**,
**modelled** or **composite** wherever it appears.

The left panel has two tabs, and only two: **Measure** — what is happening — and
**Decide** — why this building is hot, and what a measure does about it. Those
last two were briefly separate and separating them was wrong: they are one
question in two halves, reading the second needs the first in view, and a
four-item tab row makes choosing a tab a decision in itself. The analyst, the
portfolio and the per-building brief open over the model rather than inside a
340px column.

*One moment:*

- **Facade surface temperature** — the field with the real signal
- **Direct sun / shade** — ray-traced through the actual 3D scene
- **Hours above 35 °C** — measured, across the seven-day wave
- **Longest unbroken run** — measured, the metric with no overnight relief
- **Air temperature** — measured at 2 m, extended upward, with its uncertainty
- **Where to act, heat wave** — event-day exposure × vulnerability

*The whole year:*

- **Where to act, the year** — annual load × vulnerability. A different list.
- **Sunlit hours a year** — south walls take three times north walls
- **Annual heat dose** — degree-hours above 35 °C on the facade
- **Annual solar dose** — kWh/m², the quantity shading removes
- **Winter sun share** — Dec–Feb sunlit hours over Jun–Aug's, 0.05 to 0.8
- **Month it peaks** — and it is not always July

An annual layer has no hour and no day, so the time controls grey out and say so
rather than appearing to drive a field that cannot respond.

### Two time axes

A **year strip** of 365 columns — each day's temperature range, coloured by its
maximum, with the overnight minimum as a base so a tropical night reads as a thick
warm bar rather than as a statistic — with the heat-wave episodes bracketed above
it and the thirteen solved days ticked below, the FortyGuard-measured one marked
differently from the twelve reanalysis-anchored ones. And an **hour strip** of the
eight solved hours within the selected day.

Two axes rather than one slider, because the question worth asking is the same
hour in different months, and one slider cannot ask it. **Day / Month / Season /
Year** changes what is averaged. Press play on the year row and the shadow line
swings: December's noon sun is 26° lower than June's.

Both axes move the city rather than cutting to it. Stepping the clock used to
replace 294,150 painted quads in one frame, which is a hard edit in the middle of
a continuous physical process and costs the viewer the thing the axis exists to
show — which walls warm first, and how the shadow line travels. Repainting at a
fractional hour every frame is not affordable (that repaint is about 40 ms, so it
would cap the whole scene at 25 fps), so the mesh carries both states at once:
the hour it came from and the hour it is going to, with one uniform sliding
between them, and the sun's altitude and azimuth interpolated alongside. A frame
of the dissolve costs a single float. A played day is then one continuous sweep
rather than eight cuts, and a played year one continuous swing of the shadow
line. `prefers-reduced-motion` — and `?smooth=0` — put the cuts back.

Plus a ranked building list with **two orderings that disagree**, and a scenario panel
that re-solves the physics per site — at the hour, and at every month's peak, so
the seasonal cost of a shading measure is a number rather than a caveat.

## From a temperature to a work order

A wall at 57 °C is a finding. Everyone who is shown one asks the same question
next, and for a long time this platform could not answer it: *so what do I do?*

The physics was never the gap. Three things were.

**Units.** Every output stopped at °C, K·h and kWh/m². Every decision is made in
kW, dollars, tonnes and person-hours, and nothing crossed that line.

**Resolution.** The whole thesis is variation *across a single facade* — 29,415
panels in ten height bands, solved. Then the advice collapsed into the same five
building-level actions for every building over a threshold, throwing away
exactly the resolution that justified the model.

**Audience.** The interface was built for someone who will fly a 3D scene. An
executive reads a headline, decides where money goes, and circulates something.
There was no table, no cost curve and nothing to hand a contractor.

### The thing the model already knew and was deleting

`physics.surface_temperature` solves

```
(1-α)S + ε(f_sky·σT_sky⁴ + (1-f_sky)·σT_sur⁴) = εσT_s⁴ + h_c(T_s - T_air) + G
```

and returned one float. The terms on the left are the *reason* the surface is
hot, they were computed on every iteration, and they were thrown away. Four
buildings can all peak at 53 °C for four different reasons, and those four
reasons take four different measures.

Linearising the emission term about air temperature makes the balance separable
into three drivers that simply add, each already in kelvin:

| term | what it is | what moves it |
|---|---|---|
| **solar** | absorbed shortwave | shading, albedo, glazing, canopy |
| **trapping** | longwave from the surfaces opposite, above air temperature | the building across the street, canyon geometry, insulation |
| **sky** | longwave to a cold sky — the only free cooling a surface gets | sky view factor; a small magnitude means no night recovery |

That is the whole prescription engine's selector. A floor whose excess is 71%
direct solar wants external shading; a floor whose excess is 58% longwave off
the wall opposite does not, and no amount of shading will help it — **its
intervention is a coating on somebody else's building.** A per-building
recommendation list structurally cannot produce that sentence. This one produces
it as a matter of course.

Two things had to be got right for it to be honest:

- **The linearisation overstates the rise**, by a second-order error that is
  0.5 K on a shaded facade and near 3 K on an ordinary sunlit July wall. The
  terms that ship are rescaled so they sum exactly to the rise the solve
  produced; because the error is a single multiplicative factor, every ratio —
  and therefore every prescription — is untouched by the correction. The
  residual is published rather than absorbed.
- **The vector engine was using one surroundings temperature for the whole
  scene** while the scalar engine iterated it per canyon. With a constant, the
  trapping term is a constant, and every band with any sun on it comes back
  solar-dominated — the finding would have been erased by the approximation
  rather than by the physics. The thirteen solved days now iterate it; the
  8,760-hour accumulation still does not, and does not need to.

### What comes out

**A floor schedule.** One row per storey: peak surface temperature and the hour
it happens, the free-running indoor estimate, cooling load in kW, the attributed
reason, and whether the geometry permits overnight recovery at all. Watch the
bars swap as you go up a deep canyon — the lower floors are heated by the street,
the upper floors by the sun — and the crossover is where the prescription
changes.

**A measure, specified.** Not "external shading". A projection in metres, on a
named face, over a named floor range, on a stated area, with the effect from a
re-solve rather than a coefficient. The geometry is derived from the profile
angle at the hour that band actually peaks:

```
P = h_window · cos(γ_sun - γ_wall) / tan(α_sun)
```

which also yields the most useful negative result in facade design for free: on
an east or west wall the peak arrives at low altitude with the sun nearly normal
to the glass, `P` diverges, and a horizontal overhang is simply the wrong device.
Same building, same physics, different face, different device — derived, not
looked up.

**A price, labelled as the softest thing on screen.** The project labels every
figure *measured*, *reanalysis*, *modelled* or *composite*. Money needs a fourth
tier — **assumed** — and it is softer than all three, because no measurement in
this study constrains a wall U-value, a window-to-wall ratio or a capex band.
Every assumed figure ships as a **range**, never a midpoint; a validation check
fails the build if one collapses.

**A programme.** Every measure on every ranked building becomes a candidate
ordered by cost per person-hour of exposure avoided, with a budget line.
Efficiency and equity do not choose the same buildings, and both columns are on
screen because that disagreement is a political choice being made either way.

### What it costs to be honest about this

Facade shading **does not pay back on energy alone** — 39 to 179 years at NYC
tariffs, negative NPV at both ends of the range. That is the correct answer and
the module reports it rather than hiding it in an optimistic midpoint. The case
for the measure lives in indoor exposure and person-hours, which is what the
programme is ordered by, not in the payback column. A platform that produced a
flattering payback here would be worth less than one that produces this.

Full specification, including every module boundary and the measured size of
every approximation, is in [DECISIONS.md](DECISIONS.md).

## The analyst

The **Analyst** tab is not a chat box. It is a Claude Agent SDK turn with this
project's physics engine importable, a shell, a workspace, twenty in-process
tools over the solved fields, and three specialists it can consult. It does work
rather than lookups:

- **re-solves an intervention** anywhere in the city, over any window — an
  albedo, a canopy fraction, a shading factor, a wall admittance — and reports
  the deltas with their spread across canyons and their seasonal split;
- **runs the statistics properly** — Moran's I with a permutation test,
  Getis-Ord Gi\* with a false-discovery correction, OLS with robust standard
  errors and the residuals named;
- **writes its own scripts** against the documented arrays;
- **allocates a budget** under four objectives, so the gap between efficiency and
  equity is visible;
- **drives this map** — sets the layer, scrubs the year to the date it is talking
  about, lights up the buildings it names.

Every tool call appears in the transcript with its arguments and what came back,
because the claim is that every number came out of this model and a claim like
that is worth exactly what the evidence on screen is worth.

It **can** read the open web, and for a long time it deliberately could not. The
reason for the original refusal is worth keeping on the record: an agent that can
read the open web will eventually answer a question about Manhattan from a news
article. What changed is that a recommendation which ignores what is actually
fundable is worth less than one that does not, so the guard moved from the tool
list into the prompt — the web is for context the model does not hold (a
programme's funding rules, a standard's threshold, what the city announced last
month), everything from it is labelled EXTERNAL wherever it appears, and it may
never supply a figure this model is itself capable of producing. That is a softer
containment than a refused tool and it is stated as one.

Full design, including the containment, the three spend bounds and what the
containment is *not*, is in [AGENT.md](AGENT.md).

## Nine things this found that a snapshot would not

The first six the single day found. The last three needed the year, and are the
reason it exists.

1. **The exceedance layer spans 14.4 to 33.6 hours across 4.69 km²** — a 19-hour
   spread — while the temperature snapshot spans 1.0 K. Duration discriminates;
   peak does not.
2. **42% of Midtown canyons are more than half one-sided.** Asymmetry is the norm,
   not an edge case.
3. **East facades run hotter than west by mid-morning and the order reverses by
   evening**, with a shadow line that climbs the shaded wall as the sun drops.
4. **Street trees cut pedestrian MRT by an order of magnitude more on West 47th
   Street than on Madison Avenue**, because Madison's floor is already shaded.
5. **Cool pavement lowers ground temperature while raising pedestrian radiant
   load** in a deep canyon. Reflected shortwave goes into people.
6. **The vertical air temperature signal is weaker than its own uncertainty.**
   Worth saying out loud rather than rendering a confident gradient.
7. **The heat-wave ranking and the annual ranking share about a quarter of their
   top fifty** (Spearman ≈ 0.73). One finds trapped air during an acute event; the
   other finds chronic facade load. A programme built on either misses the other.
8. **The seasonal temperature swing is nearly uniform across Midtown** — 25 to
   30 K everywhere — because it is set by the air's own annual cycle, which the
   whole area shares. What varies with geometry is **winter sun share**, from 0.05
   in a deep north-south slot to 0.8 on an open south wall, and that is the number
   a shading decision actually turns on.
9. **Facade shading that removes several kelvin in July removes January's solar
   gain too.** Twelve re-solved months turn that from a caveat into a column, and
   for canopy and shading the sign of it is positive: the measure does less good in
   winter, and that is its price.

Two of those cost the model a correction. Fixing the year's wind units exposed a
convective coefficient that had been wrong twice in opposite directions and was
only surviving because the two errors cancelled — see
[YEAR.md](YEAR.md#two-physics-corrections-the-year-forced).

## Honesty notes

Three things are load-bearing here:

- **Nothing validates air temperature at height.** No public dataset measures it
  in Manhattan. The band widens with height, is drawn in the interface, and
  exceeds the signal. Closing that gap needs a tower, a UAV, or facade sensors.
- **Recommendations are threshold-triggered, not generated.** Each fires on a
  stated measured or modelled value crossing a stated cutoff and cites the public
  programme that funds it. The same building always yields the same advice.
- **The analyst starts with no numbers in context.** Every figure it reports must
  come back from a tool call or a script it ran, and the transcript shows which.
- **The year is reanalysis, not measurement.** ERA5 bias-corrected against
  FortyGuard on the one day both cover, so the correction's *seasonality* is
  unvalidated: a January offset is an extrapolation from a July fit. Both the
  corrected and the raw series ship, every derived product is labelled
  *reanalysis (bias-corrected)*, and the validation prints the limitation as an
  explicitly unvalidated item rather than burying it.
- **The annual tier's shading is analytic, not ray-traced.** Ray-marching 8,760
  solar positions is two hours of work. The event day is solved both ways and the
  disagreement is published: it can only appear in the ground band, and it is a
  measured over-estimate at corners, plazas and intersections.
- **Any of the 352 days that were not solved is reconstructed.** Its month's
  solved field plus a measured `dT_surface/dT_air` times that day's
  air-temperature departure. Checked against a full re-solve on deliberately
  awkward days, and labelled in the interface.

- **The equity objective cannot discriminate in this study area, and the
  interface says so rather than pretending otherwise.** Every ZIP in Midtown
  falls in the same quintile of the city's Heat Vulnerability Index — all 4,044
  scored buildings carry HVI 2 — so the 40% of the vulnerability score that HVI
  carries is a constant here and does the ordering no work at all. The remaining
  three terms (residents, building age, assessed value per unit) do all of it.
  The consequence in the portfolio is that *efficiency* and *equity* return
  byte-identical programmes; the panel detects that, names the degenerate pair
  and falls back to a pair that genuinely disagrees. A citywide run is what would
  make the equity column mean something, and this is an argument for one.
- **Every figure with a currency symbol on it is assumed, not modelled.** Wall
  U-values, window-to-wall ratios, tariffs, capex bands and occupancy are era
  rules and published tables, not measurements of these buildings. They ship as
  ranges, they are labelled *assumed*, and `validate` prints how many of the
  thirty-three economic constants are actually sourced. Two-thirds of them are
  not yet, and the capex bands are the weak half.
- **The free-running indoor temperature is a steady-state estimate.** It assumes
  no mechanical cooling and carries no thermal capacity, so a heavy building on a
  short event will follow the outside faster in the model than in reality. It is
  carried anyway, with its range, because a resident's exposure is the point of
  the project and an indoor number is the only honest way to state it.

Full detail is in [METHODOLOGY.md](METHODOLOGY.md); the temporal pivot in
[YEAR.md](YEAR.md); the analyst in [AGENT.md](AGENT.md); the decision layer in
[DECISIONS.md](DECISIONS.md).

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
  year.py        the climate year: 8,760 hours, calibrated and summarised
  yearsolve.py   the same physics in array form, validated against physics.py
  tiers.py       the three temporal tiers and the boundaries between them
  pipeline.py    orchestration -> web/data/
  ai.py          the single-shot fallback analyst
  server.py      static files, /api/agent/*, /api/ask, and the decision endpoints
  ---- the decision layer: a temperature into a work order. docs/DECISIONS.md
  envelope.py    the stated assumptions: U-value, glazing, occupancy, by era
  loads.py       per-floor cooling load from the SOLVED surface, not sol-air
  economics.py   every monetary and carbon constant, each with a source and a date
  prescribe.py   the measure, with its geometry, extent and floor range
  portfolio.py   the cost curve, four objectives, and where two of them disagree
  decide.py      the adapter: Dataset in, the five pure modules out
  agent/         the analyst: Claude Code as a library
    knobs.py         all configuration, from the environment
    dataset.py       every pipeline output, loaded once, indexed
    queries.py       the structured read surface
    analysis.py      Moran's I, Getis-Ord Gi*, OLS, k-means, allocation
    interventions.py arbitrary what-ifs, re-solved
    persona.py       the system prompt
    agents.py        three specialists: geographer, physicist, reviewer
    tools.py         the in-process MCP server
    hooks.py         containment
    events.py        SDK messages -> console frames
    options.py       ClaudeAgentOptions: spend and auth, in one place
    session.py       background runs, durable transcripts, SSE
web/             three.js scene, UI, precomputed data
  js/year.js       the year strip and the four aggregate modes
  js/agent.js      the analyst console
  js/film.js       the opening film: globe, descent, score, camera handover
  js/story.js      its script and storyboard, both computed from the data
  js/tour.js       the guided tour that picks up where the film hands over
  js/ctx.js        the context the decision surfaces are built against
  js/decision.js   mounts them, and survives their absence
  js/floors.js     the floor schedule and the attribution
  js/whatif.js     what-if, bound to the selected building
  js/portfolio.js  the cost curve and the programme
  js/brief.js      the printable per-building brief
scripts/         fetch_fortyguard (metered), fetch_year (free), validate (free)
                 fetch_approach (free) — the descent's satellite pyramid
tests/           Playwright: geometry, physics, visual, film, tour, year, analyst
                 pytest: the year, the vector engine, the analyst's tool surface
docs/
  METHODOLOGY.md          what the model does and where it stops
  DECISIONS.md            the decision layer, module by module
  YEAR.md                 the temporal pivot, tier by tier
  AGENT.md                the analyst's design and its containment
  research/               literature verification and effect sizes
```

## Photoreal context (optional, off by default)

The clean synthetic basemap is the default for a reason argued at the top of
`web/js/scene.js`: a photographic basemap competes with the data for attention.
But recognition has its own value — a client who cannot read a sky view factor
can read "that is the north side of 42nd Street" — so Google's Photorealistic
3D Tiles are available as a toggle in the Measure tab.

**It needs your own Google Maps API key.** Enable the Map Tiles API on a
billing-enabled Cloud project, create a key, and paste it into the panel; it is
kept in `localStorage` and never committed. `?gmaps_key=…` works once as well.

**Cost.** Billing is per *root tileset request* — roughly one per session, not
per tile — against a free allowance of 1,000/month, so a visitor who pans around
for an hour streaming hundreds of megabytes is one billable event. Demo-scale use
is comfortably free. The layer constructs no `TilesRenderer` until switched on,
so with the toggle untouched nothing billable is ever requested; `tests/04-photoreal.spec.mjs`
asserts exactly that. Set a quota cap on root tile requests anyway.
`tests/12-photoreal-streaming.spec.mjs` covers the streaming configuration and
the detail ramp, and stays free by intercepting every request to
tile.googleapis.com and answering it with an empty local tileset.

**Why tiles and not Street View.** `WebGLOverlayView` binds to a vector `Map`,
never to a `StreetViewPanorama`, and a panorama's depth buffer is not exposed —
so anything drawn over one floats in front of every foreground object,
misregisters as the pose drifts, and cannot move continuously because panoramas
sit ~10 m apart. 3D Tiles are real geometry, so occlusion against our own
drawn data is correct by construction rather than by compositing trick.

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
   heat ramp, so a shader patch pulls it toward grey by default and washes the
   measured 2 m field onto up-facing near-ground surfaces — the roads and plazas
   carry the measured layer the flat ground plane used to.

**The flat datum.** The scene draws every building from y = 0 rather than its
NAVD88 ground elevation, and Midtown's terrain spans 0–26 m — up to 13 m of
misregistration against Google's real terrain, four storeys. The layer therefore
swaps in a second vertex set on true elevations, referenced to the median
footprint elevation, using a ground-elevation raster (`ground_elev.bin`) derived
from the same `base_m` our facades are offset by so the two cannot disagree,
with the streets between buildings filled by nearest-neighbour dilation. A 0.7 m
outward push keeps the coloured skin off the photogrammetry facade it sits on.
Both are real vertex positions rather than a vertex-shader offset, because
picking raycasts against CPU-side geometry.

**Making it actually stream.** The layer shipped with three settings that
between them stopped it converging, and the symptom was the same in each case —
a fly-over of faceted shards, and — while the street camera still existed —
an eye sealed in a grey box.

*The queues were throttled, not opened.* `downloadQueue.maxJobs` is a deprecated
alias for `maxJobsPerOrigin` in 3d-tiles-renderer 0.5, whose default is 25, so a
line written to raise concurrency cut it to 3; the parse queue went from 5 to 1
the same way. Both are now set through the properties they mean, above the
library defaults rather than below them, because parsing is the binding
constraint: a tile takes about 170 ms to decode on a quiet queue and 600 ms on a
busy one, and raising the fly-over from three concurrent parses to eight took it
from *240 tiles short after a minute* to fully resolved in forty seconds. The
queues are also this layer's own instances rather than the library's exported
singletons, which are shared page-wide and outlive any one tileset.

*The detail budget was spent evenly over a 14 km frustum.* `errorTarget` is
screen-space, so a tile a mile down Madison was held to the same pixel accuracy
as the kerb underfoot — 1,109 tiles in the frustum at eye level, 989 of them
queued, against a haze that closes at 1,250 m. `errorFalloff` now discounts a
tile's error with distance, gently for the fly-over and steeply for the
pedestrian, and `loadSiblings` is off so the queue is not also fetching the
kilometre of city behind the wall you are facing. Street level went from 1,109
tiles in frustum to about 320, and from a grey box to a canyon.

*Nothing said what was happening.* The status line waited on `load-tile-set`, an
event this library has never dispatched — the names are `load-root-tileset` and
`load-tileset` — so a session streaming perfectly looked exactly like one whose
key had been refused. It now reports `loadProgress` as a percentage and settles
only when both queues are idle.

**The world ends at the study area.** The frustum was the only thing bounding
this layer, and from a kilometre up the frustum holds the whole metropolitan
area — Newark to the west, Jamaica Bay to the east, every tile of it selected,
queued, decoded and drawn. None of it is the subject. `errorFalloff` looks like
the answer and is not: it is subtractive on the error, so the far city arrives
*coarser* but it still arrives, still costs a download slot and still costs a
parse slot. Coarsening the horizon reduces bytes; it does not reduce contention.

A `ContextRadiusPlugin` cuts it instead. Any tile whose bounding volume lies
wholly outside 4 km of the AOI centre is reported out of view, and
`determineFrustumSet` returns at the first such tile without descending, so the
subtree beneath it is never preprocessed, never marked used, never queued and
never drawn. The test is against the bounding volume rather than its centre so
that an ancestor spanning half the eastern seaboard still intersects the disc
and still refines; only the children that leave it are dropped, which puts the
boundary at tile granularity instead of taking the root out with everything
else. Four kilometres is chosen for what is at that distance rather than for any
budget — both rivers, the lower half of Central Park, the near shores of Hoboken
and Long Island City — so the edge mostly falls on water, which is the one place
a cut in a photogrammetry mesh does not read as damage. The CONTEXT REACH slider
moves it, and its top stop lifts the cap entirely for a fly-over that wants the
horizon in the frame.

The hook is `calculateTileViewError`, whose contract is worth stating because it
is unusual: returning `true` means *this plugin has an opinion*, and the
renderer intersects those opinions, so one plugin reporting `inView: false`
takes the tile out of view whatever the frustum said. Returning `false` abstains.
A plugin cannot make a tile coarser this way — the aggregation takes the maximum
error, so it can only ask for more refinement — which is the other half of why
this is a cut and not a taper.

**Reading a failed request.** The layer said one thing for every failure —
check billing, check the Map Tiles API — which is the 401/403 story told over
the top of every other one. A 429 is a different story entirely: the key is
fine, the API is on, and the project has simply started more tile sessions than
its quota allows in the window. Sent to check billing you check billing, find
nothing wrong, and conclude the layer is broken. The status code is now read out
of the error text (the library reports it there rather than as a field) and the
three cases are told apart.

The distinction matters for what happens next as well. A root failure leaves
`rootLoadingState` at -1, nothing in the library ever resets it, and `enable()`
skips `_build` when a TilesRenderer already exists — so the tileset was inert
for the rest of the session and switching the layer off and on again silently
did nothing. A root failure is now recorded and cleared by `enable()`, which
calls `resetFailedTiles()`. Deliberately not retried on a timer: a root request
is the billable unit, and the standing rule is that nothing costs anything
without someone asking for it. The toggle is the retry, and now it is one. The
error also has to outlast the frame that found it — a dead tileset still reports
a settled `loadProgress`, so the frame loop was overwriting the explanation with
a cheerful "ready" inside 400 ms.

**The detail ramp.** `errorTarget` drops from 14 to 5 on entering street mode: a
pedestrian needs depth where a fly-over needs breadth, and the loose overhead
value leaves root-level slabs standing where the road should be. But it does not
drop *immediately*. Google's tiles refine by REPLACE, so a level appears only
once every sibling in it has arrived, which means asking for a depth the
pipeline cannot finish yields no picture at all rather than a slightly coarser
one. So each mode opens at 2.6× its target and walks down, steered by
`loadProgress` — tightening once nearly everything requested is on screen,
loosening when half of it is missing, and holding still across a wide band in
between so the target cannot oscillate. Queue depth was the obvious signal for
this and is the wrong one: it dips to nothing between waves, which the ramp read
as "keeping up" while ten per cent of the frame had arrived.

**Anisotropy.** Every surface that matters at eye level — roadway, pavement,
crossing markings, kerb — is seen at a grazing angle, where isotropic mipmapping
picks its level from the worst axis and smears them into a band a few metres
ahead of the camera. That reads as tiles failing to refine when they have
refined perfectly and are being sampled badly, so streamed textures get eight
anisotropic taps (one on a software renderer, where the rasteriser rather than
the sampler is out of headroom).

**Height above the road, not above the datum.** The street wash falls off with
height so it lands on the roadway and not up the building flanks, and the term
read `vWorldPR.y` — height above y = 0, which is the flat datum rather than the
ground. This layer is the one place that distinction bites, because it is the
only place the scene stands on real terrain: Midtown spans 0–26 m against a
falloff that saturates at 22 m, so the same roadway that took the full wash
downtown took almost none of it on the high ground, and the measured field
quietly drained out of the streets as you walked north. A `uGroundY` uniform,
fed from the same ground-elevation raster the facades are offset by and
refreshed a few times a second, now carries the local terrain height so the
falloff measures what it always meant to.

**What the tiles cannot do.** Google's Manhattan tileset terminates at a
geometric error of 2.006 m — measured across the 35,783 tiles of a loaded
street-level session, the minimum is identical to the median, and the deepest
tile is at depth 25 with `.glb` content and no children. So a vehicle or
construction shed seven metres from the eye is reconstructed with two metres of
error, and renders as a pale faceted box; the traversal asks for finer geometry
(screen-space error 166 px against a target of 5) and there is none to give.
That is the dataset's floor, not the pipeline's, and it is the reason this is a
context layer rather than a street-level basemap. It is worth knowing before
spending time debugging it as a loading fault, which it looks exactly like.

**The sky stays.** Switching the layer on hides the ground plane, the backdrop
and the drawn streets, all of which stand in for a real world now present. It
used to hide the sky dome too, and that was wrong: Google's tiles contain no sky,
so the slot between two towers became the raw clear colour — one flat grey band
in the middle of the frame, in the place a street-canyon model has most to say.
The dome is drawn first, at renderOrder −1000, with depth testing and writing
both off, so it cannot touch the photograph.

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

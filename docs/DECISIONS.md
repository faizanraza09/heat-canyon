# The decision layer — implementation contract

**Status: being built.** This file is the single source of truth for the module
boundaries, function signatures and data shapes of the decision layer. Every
module below is written against this contract, so they can be written in
parallel and still fit together. If an implementation needs to deviate, the
contract changes here first.

The layer turns a solved temperature field into a per-floor prescription with a
price on it. Read [HEATCANYON.md](HEATCANYON.md) first for what is being turned.

---

## The chain

```
physics.surface_terms      why this surface is hot          K, decomposed
        │
envelope.assembly_for      what the wall is made of         stated assumption
        │
loads.building_floors      what it costs to hold 24 °C      W, kWh, person-hours
        │
prescribe.for_building     what to do, where, how big       m, m², K avoided
        │
economics.price            what it costs and saves          $, tCO2e, years
        │
portfolio.curve            where the budget goes            $ per person-hour
```

Each stage consumes only the stage above it plus the arrays already on disk.
No stage may reach past its neighbour.

---

## Provenance: a fourth tier

The project labels every figure **measured**, **reanalysis**, **modelled** or
**composite**. The decision layer introduces a fourth, and it is softer than all
three:

> **assumed** — derived through a stated assumption table that no measurement in
> this study constrains. Wall U-values, window-to-wall ratios, tariffs, capex
> bands, occupancy.

Every number that passes through an assumption table carries `basis: "assumed"`
and a `range` rather than a point value. An interface that renders an assumed
figure without its range or its label is a bug. This is not decoration: the
credibility of the whole project rests on the labelling being exact, and a
dollar figure is the easiest number in the system to over-trust.

---

## 1 · `heatcanyon/physics.py` — the attribution

### The decomposition

`surface_temperature()` solves

```
(1-α)·S  +  ε(f_sky·σT_sky⁴ + (1-f_sky)·σT_sur⁴)  =  εσT_s⁴ + h_c(T_s - T_air) + G
```

and returns one float. The terms on the left are the reason the surface is hot,
and they are what a prescription needs. Recover them by linearising the emission
term about the air temperature — `εσT_s⁴ ≈ εσT_air⁴ + h_r·(T_s - T_air)` with
`h_r = 4εσT_air³` — which makes the balance separable:

```
ΔT = k · [ sw_abs  +  ε(1-f_sky)σ(T_sur⁴ - T_air⁴)  +  ε·f_sky·σ(T_sky⁴ - T_air⁴) ]

        (1 - f_storage)
k  =  ────────────────────────
      h_c + (1 - f_storage)·h_r
```

Three additive drivers, each already in kelvin:

| term | sign | meaning | what moves it |
|---|---|---|---|
| `dt_solar` | ≥ 0 | absorbed shortwave | shading, albedo, glazing, canopy |
| `dt_trap` | usually > 0 | longwave from the surfaces opposite, above air temperature | the building opposite, canyon geometry, insulation |
| `dt_sky` | < 0 | longwave to a cold sky — the surface's only free cooling | SVF; low magnitude means no night recovery |

`k` itself carries the fabric: heavy masonry has a large `f_storage` and a small
`k`, which is why it runs cooler in the afternoon and hotter at midnight.

The linearisation is the only approximation, and it turned out to be larger than
this contract first assumed. It is worth stating exactly, because it changes how
a term may be quoted.

The tangent to a convex curve always lies above it, so the raw terms **always
overstate** the rise, by a second-order error that grows as its square:

```
residual  ~=  -k · eps · sigma · 6 · T_air^2 · dT^2
```

Measured over a sweep of 80,000 realistic combinations:

| regime | max residual |
|---|---|
| rise below 15 K — shaded facades, every night hour, most of the year | 0.47 K |
| rise below 30 K | 2.0 K |
| an ordinary sunlit July wall in this scene, rise 38.6 K | 2.82 K |
| worst case: dark low-mass surface, ~1000 W/m2 absorbed, rise ~60 K | 7.96 K |

So the validation does **not** assert a flat bound, which would fail on exactly
the hot surfaces this project is about. It asserts three things instead, in
increasing strength: the residual is never positive, which catches a sign error
in the algebra; it is below 0.5 K under 15 K of rise; and over the whole sweep
`|residual| <= 0.003·dT² + 0.03`, which says the disagreement *is* the
second-order term and nothing else has crept in.

**The consequence for consumers.** `shares` and `dominant` are unaffected: the
error is a single multiplicative factor on the rise and barely moves the ratio
between two terms. But a term quoted **in kelvin** must not come from the raw
fields — a set of numbers that adds up to three kelvin more than the wall's
actual excess is indefensible. `SurfaceTerms.scaled` (and `HourTerms.scaled`)
divides that factor back out so the three terms sum exactly to the observed
rise, leaving every ratio bit-for-bit unchanged. **Use `scaled` for anything a
reader sees; use the raw fields for anything that checks the algebra.**
`residual` stays on the record either way, and the methodology states the
correction rather than absorbing it silently.

### Signatures

```python
@dataclass
class SurfaceTerms:
    t_surface: float      # degC, identical to surface_temperature()
    t_air: float          # degC
    dt_solar: float       # K
    dt_trap: float        # K
    dt_sky: float         # K, negative
    residual: float       # K: (t_surface - t_air) - (dt_solar + dt_trap + dt_sky)
    k: float              # K per W/m2
    h_c: float            # W/m2K convective
    h_r: float            # W/m2K linearised radiative
    f_storage: float      # 0-0.4
    sw_abs: float         # W/m2 absorbed shortwave
    f_sky: float          # the panel's sky view factor

    @property
    def dt_total(self) -> float: ...        # t_surface - t_air
    @property
    def shares(self) -> dict[str, float]: ...
    # normalised over the POSITIVE drivers only (solar, trap), since a negative
    # sky term is relief rather than a cause. Keys: solar, trap. Sums to 1.0
    # when either is positive, otherwise both are 0.0.
    @property
    def dominant(self) -> str: ...
    # "solar" | "trap" | "ambient"
    # "ambient" when dt_total < 1.5 K: the surface is simply at air temperature
    # and neither driver is worth naming.
    @property
    def night_recovery(self) -> str: ...
    # "good" | "limited" | "none" from f_sky: >= 0.35 | >= 0.15 | below.
    # Governs whether purge ventilation is offered at all.


def surface_terms(met, st, shortwave_absorbed, svf_surface, material="concrete",
                  wind=None, t_surroundings=None, max_iter=40) -> SurfaceTerms
```

`surface_temperature()` keeps its exact present signature and return type and
becomes `return surface_terms(...).t_surface`. Nothing downstream changes, and
`scripts/validate.py`'s scalar/vector equivalence check must still pass
unmodified.

`SurfacePanel` gains one optional field, `terms: SurfaceTerms | None = None`,
filled by `solve_canyon` on its final outer iteration only.

### Vector mirror — `heatcanyon/yearsolve.py`

```python
@dataclass
class HourTerms:
    dt_solar: np.ndarray   # (P,B) float32
    dt_trap:  np.ndarray
    dt_sky:   np.ndarray
    k:        np.ndarray
    residual: np.ndarray

def hour_terms(met, st, sw, wind, sky_c, t_surroundings, t_air_local, t_surface) -> HourTerms
```

Pure post-processing of an already-solved hour: it takes the converged
`t_surface` and recomputes the terms, so it cannot perturb the solve. `HourFields`
gains `terms: HourTerms | None = None`, populated only when `solve_hour` is
called with `want_terms=True` — the annual accumulation leaves it off.

**The rule from `yearsolve.py`'s docstring stands unchanged:** the physics
changes in `physics.py` first and this module is brought back into line. A new
check in `scripts/validate.py` requires scalar and vector terms to agree to
1e-6 K over a random sample.

### Annual planes

`tiers.py` accumulates, over the thirteen solved days weighted by the year, and
`pipeline.py` writes to `web/data/annual/`:

| file | shape | scale | meaning |
|---|---|---|---|
| `dt_solar_peak.bin` | (P,B) int16 | 100 | solar term at the band's own hottest hour, K |
| `dt_trap_peak.bin` | (P,B) int16 | 100 | trapping term at the same hour, K |
| `dt_sky_peak.bin` | (P,B) int16 | 100 | sky term at the same hour, K |
| `dt_solar_mean.bin` | (P,B) int16 | 100 | solar term averaged over hours above 30 °C |
| `dt_trap_mean.bin` | (P,B) int16 | 100 | ditto, trapping |

Registered in `meta.json` under `year.annual_fields.planes` exactly like the
existing planes, so `Dataset.plane()` and `panel_field` reach them with no
special case.

---

## 2 · `heatcanyon/envelope.py` — the stated assumptions

PLUTO carries no cladding, glazing or U-value field. This module is the single
place every such assumption lives, in the spirit of the existing
`physics.facade_material()` — a defensible rule, surfaced rather than buried.

```python
@dataclass(frozen=True)
class Assembly:
    key: str
    label: str                       # "Pre-war solid masonry"
    era: str                         # "before 1945"
    u_wall: tuple[float, float]      # W/m2K, lo-hi
    wwr: tuple[float, float]         # window-to-wall ratio, lo-hi
    u_glass: tuple[float, float]     # W/m2K
    shgc: tuple[float, float]
    infiltration_ach: tuple[float, float]
    thermal_mass: str                # "heavy" | "medium" | "light"
    note: str                        # what makes this era what it is
    source: str                      # where the numbers come from

ASSEMBLIES: dict[str, Assembly]      # keys mirror physics.MATERIALS facade names
def assembly_for(year_built: int | None, height_m: float,
                 land_use: int | None = None) -> Assembly
def occupancy_for(land_use: int | None) -> Occupancy
```

```python
@dataclass(frozen=True)
class Occupancy:
    key: str                   # "residential" | "office" | "retail" | "other"
    label: str
    internal_gain_w_m2: tuple[float, float]
    occupied_hours: tuple[int, int]      # local, e.g. (0,24) residential, (8,19) office
    overnight: bool                      # do people sleep in the exposure
    setpoint_c: float                    # 24.0 residential, 23.0 office
    persons_per_unit: float              # residential only; 0 otherwise
```

The five assemblies keyed to the eras `physics.facade_material()` already
distinguishes, so the two can never disagree about what a building is made of:
`pre_war_masonry`, `post_war_concrete`, `early_curtain_wall`,
`modern_curtain_wall`, `mid_century_masonry`.

Every range is carried through to the end. **Nothing in the layer may collapse a
range to its midpoint**; the spread is the honest output when the input is a
rule rather than a measurement.

---

## 3 · `heatcanyon/loads.py` — physics into watts

A building-energy model would reach for sol-air temperature here because it does
not know the wall's real surface temperature. This model *solved* it, coupled
and ray-traced, so the conduction term is direct:

```
q_band = U · A_band · (T_surface - T_indoor)          W
A_band = panel_length · (top - base) / n_bands        m2, from facades.json
```

plus transmitted solar through the glazed fraction (`SHGC · I_band · A_glazed`,
and the irradiance per band is already solved), ventilation against the
vertically-resolved air profile, and internal gains from occupancy.

Floors map to bands through the PLUTO floor count:

```
band_of_floor(f) = floor(f * n_bands / floors)
```

A 26-storey building over 10 bands puts 2–3 storeys in each band; the schedule
says so rather than implying storey-level resolution the model does not have.

```python
@dataclass
class FaceLoad:
    azimuth: float
    compass: str                     # exposure.compass()
    area_m2: float
    glazed_m2: float
    t_peak_c: float
    peak_hour_edt: int
    conduction_w: tuple[float, float]     # lo-hi from the assembly range
    solar_gain_w: tuple[float, float]
    annual_kwh: tuple[float, float]
    dt_solar: float; dt_trap: float; dt_sky: float
    sun_hours_yr: float
    winter_sun_share: float

@dataclass
class FloorLoad:
    floor: int                       # 1-based storey
    band: int                        # which of the 10 solved bands it sits in
    z_lo: float; z_hi: float         # m above the building base
    storeys_in_band: int
    faces: list[FaceLoad]
    envelope_m2: float
    peak_w: tuple[float, float]
    peak_hour_edt: int
    annual_kwh: tuple[float, float]
    t_surface_peak_c: float
    t_indoor_free_c: tuple[float, float]   # free-running, no cooling. ESTIMATE.
    dt_solar: float; dt_trap: float; dt_sky: float
    dominant: str                    # "solar" | "trap" | "ambient"
    night_recovery: str
    hours_indoor_over_threshold: float     # per year, free-running, > 28 degC
    person_hours: float                    # residential only, 0 otherwise
    severity: int                          # 0-4, for the interface stripe

@dataclass
class BuildingLoads:
    bin: str
    assembly: Assembly
    occupancy: Occupancy
    floors: list[FloorLoad]
    roof: RoofLoad | None
    peak_kw: tuple[float, float]
    annual_mwh: tuple[float, float]
    peak_hour_edt: int
    worst_floor: int
    person_hours: float
    basis: str                       # always contains "assumed"

def building_floors(*, bin, floors, height_m, base_m, panels, band_area,
                    surface, air, irradiance, terms, annual, assembly,
                    occupancy, hours) -> BuildingLoads
```

`building_floors` is pure: every array it needs is passed in, so it is callable
from the pipeline, from the server against `Dataset`, and from a test with
synthetic input. It must not import `pipeline` or read from disk.

**`t_indoor_free_c` is an estimate and must be labelled one everywhere.** A
steady-state balance between envelope gain, ventilation and internal gain is not
a dynamic building simulation and will be wrong for a heavy building on a short
event. It is carried because a resident's exposure is the point of the project
and an indoor number is the only honest way to state it — with its range, its
assumption list, and the sentence that it assumes no mechanical cooling.

---

## 4 · `heatcanyon/economics.py` — decision currency

One module, one constants table, every entry carrying `source` and `as_of`. A
stale tariff is a wrong answer that looks right, so the table is printed by
`validate` and the interface shows the `as_of` date beside any dollar figure.

```python
@dataclass(frozen=True)
class Constant:
    value: float | tuple[float, float]
    unit: str
    source: str
    as_of: str                 # ISO date
    note: str = ""

CONSTANTS: dict[str, Constant]
# electricity_usd_kwh, demand_usd_kw_month, grid_kg_co2e_kwh,
# ll97_penalty_usd_tco2e, ll97_cap_kg_co2e_sf (by occupancy),
# discount_rate, measure_life_years, household_size,
# capex_usd_m2 per measure key

@dataclass
class Money:
    energy_usd_yr: tuple[float, float]
    demand_usd_yr: tuple[float, float]
    carbon_t_yr: tuple[float, float]
    ll97_usd_yr: tuple[float, float]
    capex_usd: tuple[float, float]
    payback_yr: tuple[float, float] | None      # None when it never pays back
    npv_usd: tuple[float, float]
    basis: str

def price(*, measure_key, area_m2, kwh_saved_yr, kw_peak_saved,
          occupancy, gross_floor_m2=None) -> Money
def constants_table() -> list[dict]     # for the interface and for validate
```

**Every constant in this table ships with a `# TODO: verify` marker and a
`verified: bool` field set False until sourced.** `validate` prints the count of
unverified constants as an explicitly unvalidated item — the same treatment the
project already gives the year's bias-correction seasonality. Local Law 97's cap
and penalty in particular must be checked against the live rule before any figure
is quoted; that is the one constant where staleness would be actively damaging.

---

## 5 · `heatcanyon/prescribe.py` — the measure, specified

A recommendation without a geometry, an extent, a floor range and a price is a
topic, not a decision. This module replaces `exposure.recommend()`'s five
building-level actions — which stays in place and keeps working, because the
threshold catalogue is what the existing analyst and the existing interface
read — with a per-face, per-floor-range specification derived from the physics.

### Shading geometry

For a horizontal overhang the required projection follows from the profile
angle, and the model knows the solar altitude α and azimuth γ at every solved
hour and knows from `sunlit.bin` which hours actually reach each band:

```
P = h_window · cos(γ_sun - γ_wall) / tan(α_sun)
```

evaluated at the hour of peak absorbed shortwave for that band. The formula also
produces the most useful negative result in facade design at no extra cost: on
an **east or west** wall the peak arrives at low altitude with the sun nearly
normal to the glass, `tan α → 0`, and `P` diverges. A horizontal overhang is
then the wrong device and the module must say so and offer vertical fins,
operable shading or a glazing swap instead. On a **south** wall at high summer
altitude a modest projection does the whole job.

`shading_geometry()` returns `device = "horizontal" | "vertical" | "eggcrate" |
"operable" | "glazing"` with the projection or fin spacing that follows, and
`infeasible_reason` when no fixed device works.

### Selection

The measure family is chosen by the **attribution**, never by a temperature
threshold. That is the whole point: four buildings peaking at 53 °C can need
four different measures.

| dominant | night recovery | winter sun share | selected |
|---|---|---|---|
| solar | any | < 0.35 | fixed shading, device by orientation |
| solar | any | ≥ 0.35 | operable shading, or glazing if WWR > 0.5 |
| solar | any | any, WWR > 0.5 | glazing retrofit ranks first on curtain wall |
| trap | none / limited | any | night purge is *excluded*; insulation, and the wall opposite |
| trap | good | any | night purge ventilation |
| ambient | any | any | no facade measure; operational and mechanical only |

Roof measures fire on height, top-floor share and roof area. Canopy fires on the
ground bands only and the module must state that it reaches bands 0–1 and no
further — a street tree does nothing for floor 19 and the schedule should say so
rather than implying otherwise by silence.

Every prescription carries an `also_consider` and a `does_not_fix`, the second
naming the floors this measure leaves untouched and the measure that covers
them.

### Signatures

```python
@dataclass
class Prescription:
    key: str; title: str; family: str
    faces: list[str]                 # compass names treated
    floors: tuple[int, int]          # inclusive storey range
    device: str
    geometry: dict                   # projection_m, fin_spacing_m, shgc_target...
    area_m2: float
    why: str                         # cites the attribution figures
    effect: Effect                   # from a re-solve, never a coefficient
    winter_cost: str
    money: Money
    programme: list[str]
    does_not_fix: str
    also_consider: list[str]
    confidence: str                  # "modelled" | "assumed"
    lead_time: str                   # "this season" | "one year" | "capital cycle"

@dataclass
class Effect:
    d_facade_peak_k: float
    d_annual_kwh: tuple[float, float]
    d_peak_kw: tuple[float, float]
    d_person_hours: float
    d_winter_kwh: tuple[float, float]      # positive = a heating penalty
    seasonal: dict[str, float]             # summer/winter/year MRT or facade delta
    source: str                            # "re-solved" always

MEASURES: dict[str, MeasureFamily]
def for_building(loads: BuildingLoads, *, resolve, context) -> list[Prescription]
def shading_geometry(azimuth, peak_alt, peak_az, window_head_m=2.1) -> dict
```

`resolve` is a callable the caller supplies — the pipeline passes a
`scenarios.run_scenario` closure, the server passes the live intervention
engine. `prescribe` never re-solves physics itself; it decides *what* to solve
and interprets the answer. That keeps the stated effect and the model's own
answer from ever drifting apart.

**Determinism is a requirement, not a nicety.** The same building must always
yield the same prescription. The existing stance — recommendations are
threshold-triggered, not generated; the LLM writes the narrative around them and
never authors the measure — extends here unchanged.

---

## 6 · `heatcanyon/portfolio.py` — the programme

```python
@dataclass
class Candidate:
    bin: str; addr: str; measure: str
    capex: tuple[float, float]
    person_hours_avoided: float
    kwh_saved: tuple[float, float]
    carbon_t: tuple[float, float]
    usd_per_person_hour: float       # the ordering key for the curve
    lead_time: str
    hvi: int | None; units: int

def curve(candidates, *, objective="person_hours") -> list[Candidate]
def allocate(candidates, budget_usd, *, objective) -> Allocation
def compare_objectives(candidates, budget_usd, objectives) -> Disagreement
def phase(allocation) -> dict[str, list[Candidate]]   # by lead_time
def ledger(allocation) -> str     # the generated outcome paragraph
```

`compare_objectives` is the point of the module. `allocate_budget` already
implements four objectives in the analyst; its most valuable output is not any
one ranking but the **disagreement** between two of them, because that
disagreement is a political choice currently being made implicitly. The
interface shows both columns and names the buildings that appear in one and not
the other, so the user can see that they are choosing.

---

## 7 · Data products

New files under `web/data/`. All written by `pipeline._finish`.

### `floors.json`
```
{ "n": 150, "bands": 10,
  "items": { "<bin>": {
      "assembly": {key, label, u_wall:[lo,hi], wwr:[lo,hi], shgc:[lo,hi], note, source},
      "occupancy": {key, label, setpoint_c, overnight},
      "peak_kw": [lo,hi], "annual_mwh": [lo,hi], "peak_hour_edt": 15,
      "worst_floor": 22, "person_hours": 41200,
      "floors": [ {f, band, z_lo, z_hi, storeys, envelope_m2,
                   peak_w:[lo,hi], annual_kwh:[lo,hi], t_surf, t_in:[lo,hi],
                   solar, trap, sky, dom, rec, hrs, ph, sev,
                   faces:[{az, c, m2, t, hr, w:[lo,hi], solar, trap, sunh, wss}] } ],
      "roof": {...} } } }
```

### `prescriptions.json`
```
{ "constants_as_of": "2026-08-29", "unverified": 7,
  "items": { "<bin>": [ Prescription as JSON ] } }
```

### `portfolio.json`
```
{ "n": 4044, "objectives": ["person_hours","degree_hours","vulnerable","peak_relief"],
  "candidates": [ Candidate ],
  "curves": { "<objective>": [candidate indices, ordered] },
  "disagreement": { "top100_overlap": 41, "only_in": {...} },
  "constants": [ Constant as JSON ] }
```

`buildings.json` `attrs` gains four compact fields on every scored building, in
the spirit of the existing `akh` / `adose`: `pkw` (peak cooling kW, midpoint),
`amwh` (annual MWh, midpoint), `dom` (dominant term, 0=solar 1=trap 2=ambient),
`nrec` (night recovery, 0=none 1=limited 2=good).

---

## 8 · `heatcanyon/server.py` — the engine, over HTTP

`agent/interventions.py` is a first-class planning engine reachable only by
asking an LLM in prose. That is a routing problem, not a modelling one.

```
POST /api/intervention
  body: the same selector grammar the agent tool already accepts —
        {spec, streets?, bins?, near?, radius_m?, filters?, whole_aoi?,
         period?, window?, max_canyons?}
  200:  {deltas, per_canyon, seasonal, population, seconds, cost: null}

POST /api/prescribe
  body: {bin, measures?: [key]}
  200:  {prescriptions: [...], loads: BuildingLoads}

GET  /api/portfolio?objective=&budget=&constraint=
  200:  {curve, allocation, disagreement, ledger}

GET  /api/constants
  200:  {constants: [...], unverified: n, as_of}
```

A re-solve is seconds, not milliseconds. Every endpoint returns `seconds` and the
interface shows a real progress state; pretending otherwise makes a working
engine feel broken. Requests are bounded by the same three spend limits the
agent already respects, and `max_canyons` defaults to 40 with a stratified
sample above it.

---

## 9 · The interface

The platform's information architecture becomes three verbs, which is also the
order a decision is actually made in:

| | | |
|---|---|---|
| **Measure** | the 3D model, twelve layers, two time axes | what is happening |
| **Decide** | the floor schedule and its attribution, then what-if on the same building | why, what to do, what it costs |

Existing surfaces keep their behaviour. The left panel keeps **two** tabs —
**Measure** and **Decide** — because Diagnose and What-if turned out to be one
question in two halves: why this building is hot, and what a measure does about
it. Reading the second needs the first in view, so they stack in one scrolling
column in that order rather than sitting behind two tabs a reader alternates
between, and a four-item row made choosing a tab a decision in itself. They stay
separate MODULES; only the tab merged.
The right panel keeps the ranking and gains a way into the portfolio; the right panel keeps the ranking and gains a
way into the portfolio; the analyst stays where it is. Two new full-screen views
sit alongside the analyst window, opened and dismissed the same way, with the
same Escape behaviour.

### New modules under `web/js/`

| module | owns | reads |
|---|---|---|
| `floors.js` | the floor schedule and the attribution bars | `floors.json` |
| `whatif.js` | the what-if pane, bound to the current selection | `/api/intervention` |
| `portfolio.js` | the portfolio table and the cost curve | `portfolio.json`, `/api/portfolio` |
| `brief.js` | the printable per-building brief | `floors.json`, `prescriptions.json` |

Each is a self-contained ES module exporting one class with `mount(host, ctx)`
and `update(state)`. `ui.js` owns the tab switching and hands each module its
host element and a context object; no new module writes to `ui.js`'s DOM or
reads its private state.

### Shared context

```js
ctx = {
  d,                 // the loaded Dataset (web/js/data.js)
  scene,             // for select/focus/highlight
  state: {selectedBin, hour, day, layer, aggregate},
  on(event, fn),     // 'select' | 'time' | 'layer'
  emit(event, payload),
  fmt: {money, kw, kwh, k, range},   // shared formatters, defined once
}
```

`fmt.range(lo, hi, unit)` renders an assumed range in the one house style —
`4.1–6.8 kW` — so a range never appears as a bare midpoint anywhere in the
interface.

### Design constraints

The existing visual system is the system: Instrument Serif for display,
Instrument Sans for body, IBM Plex Mono for data and labels, the dark ground and
the warm ramp already in `app.css`. New surfaces use the existing custom
properties and add none that duplicate one. A severity stripe encodes the floor
schedule's worst column so the pattern reads before any number does.

Nothing may regress: the film, the tour, the twelve layers, the year strip, the
street camera, the photoreal layer and the analyst all keep working, and the
tour gains steps for the new surfaces rather than being left describing an
interface that has changed underneath it.

---

## 10 · Warming scenarios

A uniform delta on the 8,760-hour air series — +1.5, +2.5, +4 K — re-solved
through the same engine. It is a crude framing and is labelled one: a uniform
shift ignores changes to humidity, cloud and circulation, and the honest claim is
**"the same geometry under warmer air"**, never a climate projection. It is
carried because every capital measure in the layer has a 20–40 year life and the
study year is one year.

It costs seconds rather than a rebuild, and that is not a shortcut. `sens.bin`
already holds the measured response of every facade band's surface temperature
to a one-kelvin lift in the air anchor, obtained by re-solving the whole scene
with the anchor raised and differencing. The day reconstruction already uses that
coefficient to turn "March the fourteenth" into a field from March's solved day,
and `validate` checks it against full re-solves on deliberately awkward days. A
uniform warming is the same operation with a different departure — same
coefficient, same first-order approximation, same published error.

Where it is weakest is stated on the results themselves rather than only here:
gamma was measured around this year's own temperatures, so at +4 K it is being
extrapolated, and the fourth-power emission term makes the true response slightly
smaller. That level is an upper bound, not a best estimate.
`heatcanyon/warming.py`, `GET /api/warming`.

---

## What this must not break

- `scripts/validate.py` passes, including the scalar/vector equivalence check.
- The 62 pytest tests and the 80 Playwright tests pass.
- `ranked.json`, `buildings.json`, `facades.json`, `canyons.json`, `tiles.json`,
  `meta.json` and `year.json` keep every field they have. The layer adds; it does
  not rename.
- A build with no decision layer available still produces a working atlas. Every
  new product is optional at load time and its absence degrades one pane, not the
  application.

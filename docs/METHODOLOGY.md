# The Urban Canyon — methodology

What this model does, what it is honest about, and where it stops.

---

## 1. The problem

FortyGuard's Temperature API returns air temperature at **2 m above ground**, on a
60 m grid. That is one number per tile, at ankle-to-shoulder height, for a city
whose people live and work up to 400 m in the air behind walls that face
different directions and spend different parts of the day in shadow.

This project extends that measurement into three dimensions, and is careful about
which parts of the result are measurement and which are inference.

## 2. Study area and event

| | |
|---|---|
| Area | Midtown Manhattan, −73.995 / 40.744 to −73.970 / 40.764 |
| Extent | 2,110 × 2,223 m = 4.69 km² (1.81 mi², inside the API's 10 mi² cap) |
| Buildings | 5,329 footprints ingested, 4,044 scored inside the AOI |
| Residential units | 68,533 |
| Event | New York heat wave, 29 June – 5 July 2026 |
| Peak day | **2026-07-02**, the hottest day of the 2026 Manhattan summer (40.7 °C) |
| Threshold | 35 °C (95 °F), NWS heat-advisory territory |

The peak day was not chosen by hand. Daily maxima for the whole summer were
pulled from a free reanalysis archive first, and 2026-07-02 came out top with
2026-06-29 → 07-05 as the hottest seven-day window. Buying a heatmap of a mild
day would have wasted credits and proved nothing.

## 3. Data sources

### Measured — FortyGuard (metered)

| Layer | Endpoint | What it gives |
|---|---|---|
| 8 diurnal snapshots | `/v1/heatmap` `tcm`, `filter_type=1` | 2 m air temperature at 60 m, every 3 h |
| Full day | `/v1/heatmap` `tcm`, `filter_type=3` | per-tile daily min / mean / max |
| Exceedance | `/v1/heatmap` `exceedance` | hours above 35 °C over the 7-day wave |
| Persistence | `/v1/heatmap` `persistence` | longest unbroken run above 35 °C |
| Time of peak | `/v1/heatmap` `time_of_measure` | hour-of-day of each tile's maximum |
| Environmental | `/v1/env_params` | humidity, apparent temperature, wet bulb, cloud, air quality |

### Measured — free public data (no key, no cost)

| Layer | Source | Field that matters |
|---|---|---|
| Building footprints | NYC Open Data `5zhs-2jue` | `height_roof`, `ground_elevation` (**feet**) |
| Roof profiles | USGS 3DEP `NY_NewYorkCity` (Entwine Point Tiles) | 2017 airborne LiDAR, ~0.73 m post spacing |
| Street centrelines | NYC Open Data `inkn-q76z` | **`streetwidth`** (feet, curb to curb) |
| Tax lots | NYC Open Data `64uk-42ks` (PLUTO 26v2) | `yearbuilt`, `numfloors`, `unitsres`, `landuse` |
| Heat Vulnerability Index | NYC Open Data `4mhf-duep` | `hvi` 1–5 by 2020 ZCTA |
| Street trees | NYC Open Data `uvpi-gqnh` | 2015 census, species and diameter |
| Street-level sensors | NYC Open Data `qdq3-9eqn` | 84 Manhattan sensors, 2018/19, °F |
| **The whole temporal axis** | **ERA5 via Open-Meteo archive** | **8,760 hours: air temperature, humidity, dew point, cloud, wind, GHI/DNI/DHI** |

That last row is the one that changed. ERA5 used to appear here only as the
reference the solar reconstruction is *validated against*; it is now the source of
the entire year, bias-corrected against FortyGuard on the one overlapping day. It
costs nothing and needs no credential, which is why a year was reachable at all —
8,760 FortyGuard heatmap calls would be 37 million credits against a 2 million
budget. Its grid cell over Midtown is about 25 km and contains open water and New
Jersey, so it is a regional 2 m temperature rather than an urban one, and the
calibration and its limits are in [YEAR.md](YEAR.md).

**Its wind is in km/h by default.** A cached response carrying km/h into
`Met.wind_10m`, which is m/s, is a 3.6× error in the convective coefficient. It
was silently cancelling a second error in that coefficient's intercept, and both
survived until the year forced them apart — see §6.

### Measured — the opening film only (no key, no cost)

The film that plays before the application makes claims about the planet, so it
is sourced the same way everything else is. `scripts/make_globe_assets.py`
downloads these once, caches them under `data/globe/`, and writes the three small
artefacts the globe reads.

| Layer | Source | What it gives |
|---|---|---|
| Global temperature record | NASA GISS Surface Temperature Analysis v4, `GLB.Ts+dSST.csv` | land–ocean global mean anomaly, 1880 → present, 1951–1980 baseline |
| Continents | Natural Earth 1:50m land (public domain) | the land mask, rasterised to 4096 × 2048 |
| Cities | Natural Earth 1:110m populated places (public domain) | the 160 largest by `pop_max` |

The one claim the narration makes about the record — that the ten warmest years
have all come since a given year — is **computed** in the build script from the
downloaded series and written into `global_temp.json` as `warmest10_since`, not
typed into the script. If NASA revises the record, the narration follows it.

`streetwidth` deserves a note: it makes canyon aspect ratio a **measured**
quantity rather than an estimate, which is unusual and is the single most
valuable free field in the project.

### Three API findings worth recording

1. **`start_time` is local standard time (GMT−5), year-round — not UTC.**
   Established with a control call, not assumed: `start_time="10:00"` returned
   34.89 °C, which matches 11:00 EDT in the reanalysis (37.3 °C) and not 06:00
   EDT (27.3 °C). New York is on EDT in July, so API hour *h* is wall clock
   *h+1*. Getting this wrong puts the sun on the wrong side of every street.
   Independently confirmed: the `14:00` field is identical to the separately
   fetched full-day per-tile maximum.

2. **Heatmap calls cost a flat 4,220 credits regardless of tile count.** So the
   finest 60 m granularity is free. Total spend for the whole project: **74,900
   of 2,000,000** hackathon credits (3.7%).

3. **`env_params` never returns `solar_irradiance`.** It is listed as an
   available parameter and the `analysis` argument is accepted, but ignored
   server-side. Irradiance is therefore reconstructed from solar geometry and
   validated against ERA5 (7.3% RMS, no fitted parameters).

## 4. The geometry engine

Building heights are rasterised into a **3 m digital surface model**, and every
geometric quantity is derived from that raster by horizon scanning — the standard
SOLWEIG approach. This matters in Midtown, where a 120 m tower sits directly
against a 20 m walk-up and an idealised symmetric-canyon assumption would be
wrong on most blocks.

### Where the surface model comes from

The footprint table alone supports only one lid per polygon at `height_roof` —
LoD 1.5. Midtown is the worst place to accept that: the 1916 zoning resolution
produced a neighbourhood of setback towers, and setbacks are precisely the
mechanism by which sky reaches an upper facade band and sun reaches a canyon
floor. A flat lid erases every one of them and biases the two quantities this
project exists to compute.

Two obvious fixes do not work. DOITT's *NYC 3-D Building Model* is itself
LoD 1.5 by its own metadata — domes and pitched roofs unrendered, ~100 iconic
buildings at LoD 2, 2014 vintage — so it trades one flat lid for another. And
all three NYS elevation services are **bare-earth** DEMs; their maximum value
across New York City is about 126 m, which is terrain with every building
stripped out.

So roof profiles come from the point cloud: USGS 3DEP's `NY_NewYorkCity`
collection, published as Entwine Point Tiles. Only the octree nodes overlapping
the AOI are fetched (~164 MB, cached to `data/lidar/`), giving **22.3 M returns
on the 3 m grid and 99.1% cell coverage**. Classes 7, 9 and 18 (low noise,
water, high noise) are discarded first — a single surviving flier puts a needle
through a brownstone, and because the shadow tracer honours the tallest cell
along a ray, one needle casts a long false shadow across the neighbourhood.

### Reconciling the cloud with the table

The cloud is from 2017 and Midtown has built since, so it cannot simply replace
the table. Each source is authoritative for a different thing: the **table** for
*how tall* a building is, because it is maintained; the **cloud** for *what
shape* it is below that height, because it measured it.

The gate is therefore asymmetric, because the two sources fail in opposite
directions and a symmetric comparison cannot tell those failures apart — tried
first, it rejected 51% of buildings, including several from 1900–1930 that
plainly have not changed.

- **Cloud far below the table** is real. The building did not exist in 2017:
  One Vanderbilt reads 96 m against its true 427 m; a 2020 site reads 2 m of
  bare ground. These keep the flat extrusion.
- **Cloud above the table** is almost never real. Returns off a tower's flank
  land, in plan, inside its low neighbour's footprint, and podium/tower
  footprint pairs put a tower's returns inside the podium polygon. Rather than
  diagnosing each case, the profile is clamped to the table height.
- **Cloud below the table on a building that predates the flight** means the
  *table* is wrong for that polygon — usually because `nyc.footprints` gives
  every ring of a MultiPolygon the whole building's height, so a podium ring
  claims the tower's height. Construction year separates this from new build,
  and the measured height governs.

A grayscale opening on the setback depth then removes isolated one-cell pits
from scan shadowing, which would otherwise each leak sky into the SVF integral,
while genuine setbacks — tens of metres across — survive untouched.

**Result on this AOI:** 5,182 of 5,329 buildings took measured roof profiles,
746 of them with real setbacks at a median depth of 16 m; 124 held flat as
post-2017 construction; 15 were relevelled to the cloud; 23 had too few
returns. Street sky view factor rose from a median of 0.342 to **0.363** and a
10th percentile of 0.121 to **0.144** — setbacks opening the canyons. Every
decision the gate made ships in `meta.json` under `surface_model`.

One deliberate exception. Macdonald's **H is read from the flat roof heights**
(75.1 m), not from the refined surface (62.8 m). A setback shoulder lowers the
mean surface elevation without lowering any roof, so taking H from the refined
model would feed an understated displacement height and roughness length into
every wind profile downstream. The refinement belongs in sky view and
shadowing, not in the bulk roughness scalars.

### Sky view factor

For a **horizontal** surface, the cosine-weighted view factor to the sky is

```
SVF = (1/N) · Σ cos²(βᵢ)
```

over N = 32 azimuths, where βᵢ is the horizon elevation angle. Derivation: the
radiative view factor is (1/π)∫cos θ dΩ, and the inner integral over elevation
gives cos²β / 2, leaving (1/2π)∫cos²β dφ.

This reduces **exactly** to the closed-form infinite-canyon solution
`cos(atan(2H/W))`, verified to four decimal places. The widely quoted
`(1/N)·Σ(1 − sin βᵢ)` form is a *relief-visualisation* weighting (uniform solid
angle) rather than the radiative one, and under-estimates SVF by 30–42% across
the range of urban horizon angles. It is not used here.

For a point at height *z* on a **vertical** facade opposite a wall of height *H*
at distance *W*, Hottel's infinite-strip result gives

```
SVF = ½ · (1 − sin α),   α = atan((H − z) / W),   capped at ½ for z ≥ H
```

A vertical surface sees at most half the sky dome, and its sky access rises
steeply once it clears the opposing roofline. Integrating this over wall height
recovers TEB's `Ψ_wall = ½(x + 1 − √(x²+1))/x` exactly — an independent
confirmation. Horizontal and vertical surfaces have genuinely different view
factors and conflating them is a common error.

### Canyon extraction

Each street segment is sampled every 25 m. At each sample a ray is cast
perpendicular to the axis in both directions; the first mass above 6 m is that
side's wall. This gives **facade-to-facade** width — what the literature means by
*W* — while NYC's `streetwidth` is curb-to-curb. Both are kept. The difference is
the sidewalks, and its measured median of 14.7 m is right for Midtown.

Where a side has no wall within 45 m, the site is flagged and `aspect_ratio`
returns 0 rather than inventing a width from the search limit. Sites wider than
60 m facade-to-facade are treated as plazas, not canyons.

**Result:** 4,471 cross-sections, of which 2,826 are true enclosed canyons.
Median H/W 2.3, 90th percentile 5.5. Median asymmetry 0.43, with **42% of
canyons more than half one-sided** — which is why asymmetry is modelled rather
than assumed away.

### Morphometric roughness

Macdonald, Griffiths & Hall (1998):

```
d/H  = 1 + A^(−λ_p) · (λ_p − 1)                                   A = 4.43
z₀/H = (1 − d/H) · exp{ −[½ · β · C_d / κ² · (1 − d/H) · λ_f ]^(−½) }
```

Note **which index goes where**: displacement height uses the *plan* area index
λ_p, roughness length uses the *frontal* area index λ_f. They are equal only for
cubes. Midtown's λ_p is 0.453 while its measured λ_f is 1.099 — a factor of 2.4 —
so λ_f is computed properly from the facade panels rather than substituted.

Both indices put Midtown beyond Macdonald's validated range (≈0.35), where the
array enters skimming flow and the formula keeps rising while reality peaks and
declines. The index is therefore clamped at the validity limit and the resulting
z₀ ≈ 4 m is a **saturated estimate**, consistent with published values for dense
high-rise fabric but not a parameterisation evaluated inside its domain. z₀ only
enters through the log-law profile above roof level — already the widest
uncertainty band in the model.

## 5. Solar geometry

NOAA Solar Calculator formulation (condensed Meeus). Validated against the
almanac for the study day: **sunrise 05:28, sunset 20:31, solar noon 13:00** —
all to the minute — and noon altitude 72.35° against the identity
90 − latitude + declination = 72.35°.

Sunrise and sunset are compared at the **apparent** horizon (−0.833°: 34′ of
refraction plus 16′ of solar semi-diameter). Comparing geometric altitude zero
against a published time is a category error worth 4.4 minutes at this latitude,
and the first version of the check made exactly that mistake.

Clear-sky irradiance uses Kasten–Young air mass and the Meinel transmittance
`DNI = E₀ · 0.7^(AM^0.678)`, attenuated by observed cloud through
Kasten–Czeplak `GHI/GHI_clear = 1 − 0.75·C^3.4`.

**Validation:** 37 W/m² RMS against ERA5 for the study day = 7.3% of the mean
daytime value, +2.5% bias, with no fitted parameters. One convention trap:
reanalysis archives report radiation as a *preceding-hour mean*. Comparing an
instantaneous model against the label inflates the residual to 26%, all of it
artefact.

Shadows are ray-traced through the actual 3 m surface model per hour, so a
facade band is lit only if the beam genuinely reaches it.

## 6. The thermal model

### What is produced, and how much to trust each

| Quantity | Status | Range across Midtown |
|---|---|---|
| 2 m air temperature | **Measured** (FortyGuard) | 1.0–1.7 K spread per hour |
| Hours above 35 °C | **Measured** (FortyGuard) | 14.4 → 33.6 h |
| Longest unbroken run | **Measured** (FortyGuard) | 1.8 → 4.5 h |
| Facade surface temperature | **Modelled** | 24 → 59 °C over the day |
| Air temperature above 2 m | **Modelled, unvalidated** | ≤1 K per 100 m |
| Mean radiant temperature | **Modelled** | 15–25 K above air in sun |
| WBGT | **Modelled, conservative** | up to 34 °C at street level |

### Facade surface temperature

A coupled surface energy balance per facade band:

```
(1−α)·S↓ + ε·[SVF·σ·T_sky⁴ + (1−SVF)·σ·T_env⁴] = ε·σ·T_s⁴ + h_c·(T_s − T_a) + G
```

Solved by damped fixed-point iteration, and **coupled**: a panel's longwave
environment *is* the other surfaces of the same canyon, so the whole
cross-section is solved together until the area-weighted mean surface
temperature stops moving (typically 5–7 iterations). Guessing that environment
as "air plus six degrees" — the usual shortcut — gets the enclosure backwards,
understating shaded facades in deep canyons and overstating them in open ones.

`h_c = 5.8 + 3.8u`, **and this intercept has been wrong twice in opposite
directions.** It sets the entire surface-to-air temperature difference the engine
exists to compute, so the history is worth writing down.

*First*, `5.7`, from McAdams. That is a **combined** surface conductance whose
5.7 is mostly a linearised radiative coefficient (≈5 W m⁻² K⁻¹ at 290 K), so
using it alongside an explicit longwave term counted radiation roughly twice — a
~50% over-estimate of the turbulent flux at 1 m/s, which damps the diurnal swing
and pulls facades toward air temperature.

*Then* `2.0`, described as a free-convection value for a vertical surface in still
air. Diagnosing McAdams as combined was right; substituting a free-convection
value for the **intercept of a forced-convection correlation** was not. Palyvos
(2008), reviewing convective-only correlations for building envelopes, gives for
vertical walls `7.4 + 4.0V` windward and `4.2 + 3.5V` leeward. Both intercepts are
convective-only and both are far above 2.0.

A large wind hides a small intercept: at 12 m/s the intercept is 4% of `h_c`. The
2.0 was introduced while the wind fed to this function was **3.6× too large** —
Open-Meteo returns km/h and the value was being read as m/s — so the two errors
cancelled and both were invisible. Fixing the units for the year put the canyon
wind where it belongs, 0.3 to 3 m/s, where the intercept is a *third* of `h_c`,
and peak facade temperatures went to 68 °C: about 15 K above anything a
thermographic survey of masonry reports.

The current form is the mean of the two Palyvos correlations, since this engine
has no orientation dependence. That it lands numerically close to McAdams is a
coincidence of the literature, not a retreat: the 5.8 is a measured convective
intercept, the 5.7 was convection plus radiation, and the explicit longwave term
stays. Free convection on a hot wall is still omitted, but the omission is now
**bounded** rather than open: the vertical-plate correlation `1.31·ΔT^(1/3)` gives
under 4 W m⁻² K⁻¹ at a 30 K excess, which moves `h_c` by under 5% in cube-sum with
a forced term of 11 — inside the spread between windward and leeward.

The lesson is in the validation suite rather than only in this paragraph.
`v_facade_envelope` now asserts that the 99.9th-percentile peak facade temperature
lands inside 45–65 °C and that under 1% of the day exceeds 60 °C, because **both**
wrong intercepts produced fields that looked plausible in every summary statistic.
That check would have caught either one.

Canyon wind: `u = u_above · exp(−0.386·H/W)`. This is *not* traceable to Masson
(2000), which uses a prognostic scheme with no closed exponential law; treat
0.386 as a calibrated attenuation constant.

Facade material is inferred from construction era and height (pre-war masonry,
post-1960 curtain wall). PLUTO carries no cladding field, so this is a **stated
assumption**, surfaced in the interface, and it drives albedo.

### Vertical air temperature — the honest part

Three blended regimes: a weakly stratified canyon interior below roof level, a
blended roughness sublayer to 2H, and Monin–Obukhov similarity above that, with
Businger–Dyer stability functions.

Similarity theory is written in **potential** temperature, so the dry-adiabatic
conversion `T(z) = θ(z) − Γ_d·z`, Γ_d = 0.98 K per 100 m, is applied. Omitting it
is negligible inside a canyon and larger than most effects this engine resolves
over a 100 m facade — an earlier version omitted it, which alone explained a
suspiciously weak modelled gradient.

The night-time structure is a **canyon heat island with a weak lapse**, not an
inversion: stored heat keeps the canyon bottom warmest, so temperature falls with
height inside the canyon, while a genuinely stable layer forms above roof level.
Both gradients are hard-clamped sub-adiabatic, because a superadiabatic dry
profile overturns rather than persisting.

**Modelled gradients: −0.91 K per 100 m by day, −0.94 K by night.** The stated
one-sigma uncertainty at 100 m is **2.91 K** — three times the gradient itself.

That is deliberate, and it is the central honest claim of the project:

> **Nothing validates the vertical air-temperature extrapolation.** There is no
> public measured air temperature above 2 m anywhere in Manhattan. NYC's sensor
> network is 84 Manhattan units at pedestrian height, so it can validate the
> *horizontal* field and nothing about the vertical. The uncertainty band widens
> with height, is shown in the interface, and exceeds the signal it describes.

The corollary is the finding that actually matters: **surfaces vary 5.6× more
than air.** Any visualisation that paints dramatic facade contrast and labels it
air temperature is misrepresenting the physics. This model therefore computes all
three fields and labels which is which everywhere it reports.

### Mean radiant temperature and WBGT

MRT follows the SOLWEIG / ISO 7726 six-directional formulation over sky, sunlit
and shaded ground, and sunlit and shaded walls, plus the beam intercepted by a
standing body (projected-area factor 0.28). "MRT in sun" is only reported where
some of the canyon floor is actually sunlit; in a canyon whose floor never sees
the sun, reporting it would invent an exposure that cannot occur.

WBGT uses Stull's (2011) closed form for the wet-bulb term, transcribed exactly
(0.28 °C MAE over −20…50 °C, RH 5–99%, sea level). One documented bias: Stull
gives the *psychrometric* wet bulb, while outdoor WBGT is defined on the
*natural* wet bulb, which is higher. The figures here therefore **under-report**
outdoor WBGT by roughly 1.4–2.1 K in hot, calm, sunny conditions — conservative,
which is the safe direction for a heat-risk tool, but not precision.

## 7. Exposure and vulnerability

Kept strictly separate and combined only at the end, because they call for
different interventions: high exposure with low vulnerability is a design
problem, high vulnerability with moderate exposure is an outreach problem.

**Exposure** (physics), weights stated and fixed:

| Component | Weight | Status |
|---|---|---|
| Hours above threshold | 0.32 | measured |
| Longest unbroken run | 0.20 | measured |
| Peak 2 m air temperature | 0.10 | measured |
| Facade solar dose | 0.22 | modelled |
| Pedestrian MRT | 0.10 | modelled |
| Enclosure (1 − SVF) | 0.06 | measured geometry |

Duration dominates because duration, not peak, is what the epidemiology links to
mortality — and it is also the layer that discriminates most sharply here
(19-hour spread against 2.6 K).

**Vulnerability** (people): HVI 0.40, residential units 0.28, pre-war
construction 0.20, assessed value per unit 0.12. Non-residential buildings score
zero on the residents term by construction — an office tower's peak exposure
coincides with occupancy, but nobody sleeps through the night in it, and
overnight exposure without relief is the lethal mechanism.

Combined as a **geometric mean**, so a building must score on both to rank. A sum
would surface hot empty warehouses and shaded vulnerable walk-ups alike.

Every score is returned fully decomposed. Nothing is learned; all weights are
inspectable and arguable.

## 8. Scenarios

Interventions are evaluated by **changing a physical parameter and re-solving**,
never by applying a published coefficient to an output. Published effect sizes
are used as *validation targets* instead.

That distinction is what makes this a planning instrument. Street trees cut
pedestrian MRT by **18.6 K on West 47th Street** and **1.3 K on Madison Avenue** —
a factor of 14 — because Madison's floor is already shaded by its own towers.
No coefficient can say that. Cool pavement lowers ground surface temperature
while *raising* pedestrian MRT in a deep canyon, because reflected shortwave has
to go somewhere: a real, documented trade-off that a surface-temperature map
would hide entirely.

## 8a. The year

The temporal axis has its own document, [YEAR.md](YEAR.md), because it introduces
a second physics engine, a calibration, a reconstruction and a shading short cut,
and each of those needs its own account. In brief:

- **8,760 hours** of ERA5 reanalysis from Open-Meteo — free, no key — bias-corrected
  against FortyGuard on the one day both cover, with a 24-value diurnal offset
  curve. The correction's *seasonality* is unvalidated and labelled as such.
- **Three tiers.** The FortyGuard-measured event day and twelve monthly
  representative days at full facade resolution with ray-traced shadows; an
  8,760-hour accumulation with analytic canyon shading for the annual totals. A
  month's representative day is the real day whose diurnal profile sits closest to
  that month's mean, not a synthetic average — an averaged day has an averaged sun.
- **Any other date** is that month's field plus a measured `dT_surface/dT_air`
  (1.007 ± 0.005 K/K) times the day's air-temperature departure, checked against a
  full re-solve on deliberately awkward days.
- **A second engine**, `heatcanyon/yearsolve.py`, because 8,760 hours at facade
  resolution is unreachable one panel at a time. It is a vectorised mirror of
  `physics.py` and is required to agree with it to **1×10⁻⁶ K**, not to the 0.01 K
  the fixed point converges to. Nothing in it may be improved independently.
- **Two orderings** of the same buildings — event-day and annual — that share
  about a quarter of their top fifty, both published with the measured agreement
  between them.

## 8b. The analyst

Also its own document, [AGENT.md](AGENT.md). The previous analyst was a
hand-written tool-use loop with six read-only queries; it could not invent a
number and it also could not do any *work*. It is now a Claude Agent SDK turn with
twenty in-process MCP tools over the solved model, three specialists, a shell and
a workspace — it re-solves interventions, runs Moran's I and Getis-Ord Gi\* with a
false-discovery correction, writes its own scripts, and drives the map. It has no
web access, deliberately, because its authority is that every number came from
this model.

## 9. Validation

`python -m heatcanyon.cli validate` — 20 checks pass, 4 print as explicitly
UNVALIDATED rather than being quietly omitted. Plus 62 `pytest` unit tests over
the year module, the vector engine and the analyst's tool surface.

| Check | Result |
|---|---|
| SVF discretisation vs analytic canyon | exact to 1e-3 |
| Facade view factor limits and monotonicity | pass |
| Solar position vs almanac | sunrise/sunset to the minute |
| Irradiance vs ERA5 | 7.3% RMS, no fitted parameters |
| Surface energy balance behaviour | pass |
| Vertical gradient sub-adiabatic | −0.91 / −0.94 K per 100 m |
| Surfaces vary more than air | 5.6× |
| Intervention effects vs published ranges | all 5 inside |
| Scenario context dependence | 14× between sites |
| Timezone convention | pass |
| Canyon width vs street record | +14.7 m median, 99.6% consistent |
| Raster vs analytic SVF | 0.092 mean absolute |
| Vector year solver vs scalar engine | agree to 1e-6 K, 0 mask disagreements |
| ERA5 bias correction vs FortyGuard | residual < 0.05 K on the fitted day |
| Annual seasonality ordering | July > January by 15 K, June solar > 2× December |
| Annual facade totals: aspect ordering | south > north by more than 1.5× |
| Annual facade totals: no clipping | 0% of cells at the representable ceiling |
| Analytic vs ray-traced shading | ground band only, over-estimate published |
| Peak facade temperature envelope | p99.9 inside 45–65 °C |
| Day-within-month reconstruction | vs a full re-solve on the worst-case days |
| **Air temperature at height** | **UNVALIDATED — no public data exists** |
| **Facade surface temperature** | **UNVALIDATED — no satellite sees a wall** |
| **The year's air temperature** | **UNVALIDATED seasonally — one overlapping day** |
| **Per-tile annual metrics** | **UNVALIDATED — a composite, not a measurement** |

`npx playwright test` — 80 browser tests, including nine that render the page and
inspect pixels, twelve over the year control, and eight over the analyst console
(one of which drives a live turn and checks the figure it reports against the
data). Four
real rendering bugs were found by looking at screenshots that every array-level
assertion had passed: corrupt roof triangles drawing 3 km streaks, a clipped
colour ramp, ground-texture aliasing, and a camera that walked east while looking
west.

The year added two more of the same species, both invisible to every summary
statistic. The annual sunlit-hours plane was **silently saturating at 3,276.7
hours** — Int16 at a scale of 10 cannot hold 4,400, and 3,276.7 is a
plausible-looking number for "sunlit hours per year". And a stride of 24 over the
annual accumulation sampled **only midnight**, producing a year with zero sunlit
hours everywhere. Both writers now raise on overflow, the stride is nudged to a
value coprime with 24, and both failures have a check.

## 10. Limits and next steps

- **The vertical dimension is unvalidated.** Closing it needs measurements at
  height: an instrumented tower, a UAV profile, or facade-mounted sensors. That
  is the first roadmap item.
- **The year's bias correction rests on one overlapping day**, so its seasonality
  is an extrapolation. Two routes close it: NYC's Hyperlocal Temperature
  Monitoring network publishes summer-season street-level series, which would
  validate the correction across one season for free; or a second FortyGuard
  purchase on a winter day, 4,220 credits, which would test the extrapolation
  directly. Neither is claimed here.
- **The annual tier's shading is analytic.** Sunlit hours are a measured
  over-estimate in the ground band at corners, plazas and intersections. Closing
  it means ray-marching 8,760 solar positions, which is affordable if the solar
  positions are quantised and memoised — the monthly tier already does that and
  needs 53 ray-marches for 96 hours.
- **The tile field's year is a composite.** One clear July day's measured spatial
  anomaly carried across 365 days, which is an upper case for urban heat island
  intensity. A second heatmap purchase on an overcast day would bound how much.
- **Footprint geometry is ~2017 photogrammetry.** Heights come from the
  maintained table so they stay current, but the 124 buildings completed since
  the 2017 LiDAR flight are drawn as flat extrusions rather than measured
  massing.
- **The clean (non-photoreal) view still draws flat-lidded prisms.** The
  refined surface model reaches the physics, and reaches the screen when the
  photoreal layer is on (the field is projected onto Google's real geometry),
  but the synthetic basemap's own buildings are still extrusions. Making them
  stepped is affordable — greedy meshing the refined raster collapses 588,932
  quads to 253,234, fewer than the existing facade mesh — but raster-derived
  walls staircase, because Manhattan's grid runs ~29° off the raster axes. Only
  66 of 5,329 buildings have concentric setbacks, so inset polygons do not
  generalise either; the workable route is per-level contour extraction with
  simplification to straighten the staircase.
- **Facade panels are still footprint edges at full height.** The surface model
  now has setbacks; the facade panel set does not. Refining panel tops from the
  DSM would correctly stop a street wall at its setback shoulder, but it would
  also remove the tower walls above — those are interior to the footprint, not
  footprint edges, and they are the most exposed surfaces in the model. Doing
  only the reduction would systematically under-count tall setback towers, so
  the two halves have to land together: extract walls from the height raster and
  snap their azimuths to the true footprint-edge bearings. That is the largest
  remaining item.
- **LiDAR canopy is not used.** The cloud sees tree crowns, which would sharpen
  street-level shading, but folding them in changes validated physics and is
  held for its own pass.
- **Facade materials are inferred**, not surveyed.
- **Roofs and roads could be cross-checked** against Landsat Collection 2 surface
  temperature at 100 m. Walls cannot be — no satellite sees a vertical surface.
- **Scores are within-AOI ranks**, not absolute citywide claims.
- **Trees are the 2015 census**, and canopy is approximated by trunk count
  within 25 m rather than measured crown area.
- **z₀ is a saturated estimate**, as Midtown sits outside Macdonald's validated
  density range.

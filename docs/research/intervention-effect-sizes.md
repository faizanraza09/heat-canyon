## 6. Intervention Effect Sizes and Material Properties

### 6.0 Notation, conventions and how to read the confidence tags

| Symbol | Meaning | Unit |
|---|---|---|
| α | broadband solar albedo (shortwave reflectance, 0.3–3 µm) | – (0–1) |
| Δα | change in albedo; Δα_N = neighbourhood plan-area-averaged change | – |
| ε | longwave (thermal) emissivity / emittance | – (0–1) |
| λ_c | tree canopy cover fraction (plan area) | – (0–1) |
| f_GR | fraction of roof plan area converted to green roof | – |
| COP | green-infrastructure coverage percentage (Susca index; integer, e.g. "25") | % |
| BH | mean building height | m |
| LAI | leaf area index | m² m⁻² |
| H/W | canyon aspect ratio (building height / street width) | – |
| ψ_sky, SVF | sky view factor | – (0–1) |
| Q_F, Q_AH | anthropogenic heat flux | W m⁻² |
| T_a | air temperature; measurement height always stated (2 m = screen/pedestrian) | °C; differences in K |
| T_s | surface (skin) temperature | °C; differences in K |
| LST | satellite land surface temperature | °C; differences in K |
| T_mrt (MRT) | mean radiant temperature | °C; differences in K |
| UTCI / PET / SET* | Universal Thermal Climate Index / Physiological Equivalent Temperature / Standard Effective Temperature | °C |
| C = ρc | volumetric heat capacity | MJ m⁻³ K⁻¹ |
| k | thermal conductivity | W m⁻¹ K⁻¹ |
| μ = √(kC) | thermal admittance | J m⁻² s⁻¹ᐟ² K⁻¹ |
| κ = k/C | thermal diffusivity | m² s⁻¹ |

**Sign convention:** negative = cooling.

**Confidence tags used below**
- **[V]** value read directly in the primary full text (or a raw source file), transcribed verbatim
- **[V-abs]** value read in the publisher's own abstract
- **[V-2]** value read in an authoritative secondary compilation (agency guide, review full text quoting a primary)
- **[D]** derived by arithmetic from **[V]** inputs — the arithmetic is shown
- **[U]** **UNVERIFIED** — could not reach a primary source; do not ship without checking

**The single most important structural warning.** Surface temperature, 2 m air temperature and mean radiant temperature respond to the same intervention by wildly different magnitudes, and sometimes with **opposite sign**. Worked examples from verified data below:

| Intervention | ΔT_s | ΔT_a (2 m) | ΔT_mrt |
|---|---|---|---|
| Reflective pavement, per +0.1 α, midday, unshaded | **−3.0 K** | **−0.11 K** | **+2.5 K** |
| Green roof vs dark conventional roof | **−11 K** (roof skin) | **−4 K at 0.3 m above roof**, **−0.1 to −0.3 K at street** | ≈0 at street |
| Green wall, peak sunlit, dark reference wall | **−13 K** (wall skin) | **−1 to −4 K at 5 cm**, **−0.7 to −1.2 K at 50 cm**, **≈0 at 2 m** | −6 to +3 K at 0.5 m |
| Street trees, per +0.10 λ_c | LST **−1.2 to −1.8 K** | **−0.15 to −0.33 K** | **−15 to −17 K under the crown** |

A slider that reports one number per intervention will mislead. Report at least T_a and T_mrt separately.

---

### 6.1 Street trees / urban canopy

#### 6.1.1 Air temperature at 2 m per unit canopy cover — the headline coefficient

| Coefficient | Value | Basis | Source | Conf. |
|---|---|---|---|---|
| **VCE (street trees) = 3.3 °C per Δλ_c = 1.0 → 0.33 K per +0.10 canopy cover**, summer afternoon | Median across microscale (mostly ENVI-met) studies in a 47-study quality-filtered meta-sample | Krayenhoff et al. 2021 | **[V]** high — the most-cited single coefficient |
| Nighttime VCE ≈ **50 % of the respective daytime value** for each study (3 modelling studies) | → **≈0.17 K per +0.10 λ_c at night** **[D]** | Krayenhoff et al. 2021 | **[V]** medium |
| **−1.62 °C over 0 → 100 % canopy at 90 m buffer, clear midday (11:00–14:00)** → **linear-average 0.16 K per +10 % λ_c** **[D]** | 156 bike transects, 201 879 observations, New Haven CT, GAMMs; R² 0.65 (10 m midday) to 0.96 (90 m afternoon) | Locke et al. 2024 | **[V]** **high — best observational value** |
| Same study, by condition: clear afternoon −1.19 °C; clear morning −1.15 °C; cloudy morning −0.92 °C; cloudy afternoon −0.51 °C; **hottest-quartile days, clear afternoon −1.78 °C** (all 0→100 % λ_c) | CIs ±0.01–0.03 °C | Locke et al. 2024 | **[V]** high |
| **>1.5 °C over 0 → 100 % λ_c at 60 m and 90 m radii**; 1.3 °C at 30 m; 0.7 °C at 10 m — daytime | Bike-transect campaign, Madison WI; **nonlinear, with the greatest cooling once λ_c > 40 %** | Ziter et al. 2019 | **[V]** **high** |
| Ziter, nighttime: linear decrease of only **0.3–0.5 °C** over 0→100 % λ_c | → **0.03–0.05 K per +10 %** at night **[D]** | Ziter et al. 2019 | **[V]** high |
| Ziter, hottest days (>30 °C): mean cooling increased by a further **0.2–0.6 °C** | – | Ziter et al. 2019 | **[V]** high |
| **"a 10 % increase in tree canopy reduces air temperature by 0.8 °C, while a 30 % increase lowers it as much as 1.5 °C"** — scenarios: S1 +10 % → **−0.8 °C**, S2 +20 % → **−1.1 °C**, S3 +30 % → **−1.5 °C** across 36 582 hotspot grids | XGBoost surrogate + sensor network, Calgary, July 2023 heatwave; TC explains **26.7 %** of Ta variance (paper's abstract says canopy is "the dominant cooling factor, explaining 67 %" — **internally inconsistent with its own §Results**) | Zaerpour, Papalexiou & Pietroniro 2025 | **[V]** value; **low-medium** as a causal coefficient — see caveat below |
| Park cooling intensity, meta-analysis: **a park was 0.94 °C cooler in the day** on average | Systematic review, meta-analysis of park/non-park pairs. Larger parks and those with trees were cooler | Bowler et al. 2010 | **[V-2]** (verified via two independent renderings of the published abstract) high |
| Meta-analysis of local tree-vs-no-tree contrasts by Köppen group (**not** per unit cover): ΔT_air,max / ΔT_air,min / ΔT_air,mean — Tropical **−2.63 / +0.20 / −1.39**; Aw dry **−4.19 / −0.41 / −1.82**; Af humid **−1.85 / +0.80 / −1.10**; Arid **−3.04 / −0.42 / −1.97**; Temperate **−1.74 / +0.02 / −1.20**; Csa/Csb dry **−2.00 / +0.35 / −1.73**; Continental **−2.45 / +0.30 / −1.30** (all °C) | 78 micro/local-scale studies, 131 articles, 85 cities, 15 climate types. Extremes: ΔT_air,max range **−8.7 °C to +0.4 °C** (arid) | Li, Zhao, Wang, Ürge-Vorsatz, Carmeliet & Bardhan (2024/2025) | **[V]** high for the table (read from the CC-BY preprint) |

**Recommended implementable value.** For 2 m air temperature use **ΔT_a = −0.15 to −0.35 K per +0.10 canopy cover fraction** in summer daytime, with the lower half of the range for observational/measured settings and the upper half for microscale-model emulation. Apply **×0.3–0.5** at night. Apply a **nonlinearity**: little effect below λ_c ≈ 0.2–0.3, steepest gain between 0.3 and 0.6 (Ziter's 40 % threshold), diminishing above ~0.6.

**Honest reconciliation of the spread.** Three independent method families give three different answers and the spread is real, not resolvable:
- Bike-transect **observations** (Ziter 2019 Madison, Locke 2024 New Haven): **0.13–0.18 K per 10 % λ_c** linear-average, larger locally above 40 % canopy.
- Microscale **model** meta-analysis (Krayenhoff 2021): **0.33 K per 10 %**.
- ML surrogate scenario (Zaerpour 2025 Calgary): **0.8 K for the first 10 %** — a factor of 4–5 above the observations. **Flag this one.** It is a machine-learning emulator perturbed off-manifold in identified hotspots, not a measured or physically-modelled response; its own marginal increments (0.8, then +0.3, then +0.4 K) are not monotonically sensible, and the abstract's 67 % variance claim contradicts the paper's own 26.7 %.
- The widely circulated policy figure **"each 10 % increase in canopy lowers ambient air temperature by about 0.3 °C"** (World Resources Institute, *Cooling Potential of Urban Trees*) traces to Krayenhoff et al. 2021, i.e. it is the model-meta-analysis number, not an observational one. **[V]**

#### 6.1.2 Land surface temperature (LST) — much larger than air temperature

| Coefficient | Value | Basis | Source | Conf. |
|---|---|---|---|---|
| **Scaling law: CE = (0.057 ± 0.047) · S^(0.165 ± 0.106)** °C per +1 % urban tree canopy, where S = size of the analytical unit in m | Derived across US cities; within-city exponents Sacramento 0.066, Baltimore 0.102 (P<0.01). Fine-scale (neighbourhood) CE spans **0.04–0.57 °C per 1 % UTC**. Baltimore whole-city prediction **0.23 °C per 1 % (0.21–0.27)** | Wang, Zhou, Pickett & Qian 2024 (PNAS) | **[V]** **high — the single most directly implementable LST law** |
| **[D] Evaluated:** at S = 100 m → **0.122 K per 1 % = 1.22 K per +10 % λ_c**; at S = 500 m → 0.158 → **1.58 K per +10 %**; at S = 1000 m → 0.178 → **1.78 K per +10 %** | Arithmetic on the verified equation | (derived) | **[D]** |
| LST for urban trees vs continuous urban fabric during hot extremes: **−12 to −8 K in Central Europe** (France, Alps/Mid-Europe, British Isles, Eastern Europe); **−4 to 0 K in Southern Europe** (Mediterranean, Iberia, Turkey) | 293 European cities, high-resolution satellite LST + land cover | Schwaab, Meier, Mussetti, Seneviratne, Bürgi & Davin 2021 | **[V]** high |
| **Treeless** urban green space is **2–4× less effective** at reducing LST than urban trees | Same | Schwaab et al. 2021 | **[V]** high |
| Tree Cooling Efficiency (TCE) **defined as the LST reduction per 1 % tree cover increase**; >90 % of 806 global cities show an increasing TCE trend 2000–2015; midday surface cooling of **≈1.5 °C** in tree-covered areas. Strongest drivers of high TCE: high LAI, then **low city albedo** | 806 global cities, Landsat tree cover + LST, boosted regression trees | Zhao, Zhao, Wu, Meili & Fatichi 2023 | **[V-abs]** citation and definition verified; **the numeric global-mean TCE and its climate breakdown are [U]** — Wiley full text not obtainable |
| Surface UHI is **≈2× the canopy-layer (air) UHI** in the same city: SUHI 8.9 ± 1.2 K vs CUHI 4.6 ± 1.1 K; "satellite-derived surface urban heat estimates urban heat intensity by nearly twofold compared to sensor-based" | Calgary, Landsat vs high-accuracy sensor network, 2023 heatwave | Zaerpour et al. 2025 | **[V]** high — **use this factor when converting LST literature to air temperature** |

**Recommended implementable value.** LST: **ΔLST = −1.2 to −1.8 K per +0.10 λ_c** at 100–1000 m analysis scale (Wang et al. scaling law, scale-explicit). Do **not** feed LST coefficients into an air-temperature slider; the ratio LST:T_a is roughly **2:1** for UHI intensity and closer to **8–10:1** for per-canopy sensitivity.

#### 6.1.3 Mean radiant temperature — the largest tree effect by far

| Coefficient | Value | Basis | Source | Conf. |
|---|---|---|---|---|
| **A pedestrian standing directly under a tree canopy experiences T_mrt reductions of 15.5–17.3 °C in all six LCZs** | SOLWEIG, Vancouver, hottest day on record (29 July 2009) | Aminipouri, Knudby, Krayenhoff, Zickfeld & Middel 2019, *Urban For. Urban Green.* 39:9–17, doi:10.1016/j.ufug.2019.01.016 | **[V]** **high — verbatim from the abstract; the cleanest shade-only Tmrt number** |
| Same study, spatially-averaged: **−3.2 to −6.3 °C daytime (09:00–18:00) T_mrt** and **−3.3 to −7.1 °C in the hottest period (11:00–17:00)**, for "a street tree cover increase equivalent to 1 % of plan area"; largest spatial mean reduction **7.1 °C** in a low-rise residential LCZ. Baseline spatially-averaged T_mrt: compact high-rise 41.9 °C, large low-rise 47.9 °C | Same | Same | **[V]** verbatim, **but flag:** a 1 %-of-plan-area increase producing 3–7 K of *area-mean* T_mrt reduction implies an implausibly large per-% sensitivity. **Do not extrapolate this linearly.** Use only the under-crown value (15.5–17.3 K) as an implementable coefficient. |
| **T_mrt reduced by up to 16 °C** by street trees | WRF-BEP-Tree (Δx = 900 m) coupled to TUF-Pedestrian (Δx = 1 m), Las Vegas, July–Aug 2022 | Henao, Mejía, Krayenhoff, Jiang & Martilli 2025, doi:10.1088/2752-5295/ade17d | **[V-abs]** high |
| Directly below clusters of trees, **T_mrt reduced by 14.1 to 18.7 °C** | SOLWEIG, mixed-development suburb, Adelaide | Thom, Coutts, Broadbent & Tapper 2016, doi:10.1016/j.ufug.2016.08.016 | **[U]** — value from a search-result summary only; the ScienceDirect abstract was not obtainable. Citation itself verified via OpenAlex. Consistent with Aminipouri, so plausible. |
| "Previous studies have shown T_mrt reductions as large as **33 K**" | Secondary attribution | via the same search summary | **[U]** — treat as an upper envelope, not a coefficient |
| Trees reduce **T_mrt by up to 35 %** and **PET by up to 25 %** | Field measurement, Kuala Lumpur, quoted in a meta-analysis | via Li et al. 2024/2025 | **[V]** the quoting text; **[U]** the primary |
| In summer, trees reduce **solar radiation by 76–93 %** | Meta-analysis synthesis | via Li et al. 2024/2025 | **[V]** the quoting text |
| Within one street, daytime maximum **ΔT_a = 1.7 °C** while **ΔT_mrt = 13.7 °C** — an 8× ratio | Street-tree canopy coverage study | secondary | **[U]** primary not obtained; useful as an order-of-magnitude illustration of the Ta:Tmrt ratio |
| Reference bound for the sun/shade radiant gap: **"MRT roughly equals air temperature in the shade but can be 30 °C higher in the Sun"** | ASU MaRTiny instrument paper | Kamath et al. 2022 | **[V]** high |

**Recommended implementable value.** **ΔT_mrt (under-crown, dense canopy, midday, hot climate) = −15 to −18 K**, envelope **−10 to −30 K** depending on crown density (LAI/LAD), solar geometry and the ground albedo beneath. Scale linearly with the fraction of the sky hemisphere plus the solar disc that the crown intercepts. Set **ΔT_mrt = 0 or slightly positive after sunset** (see 6.1.4).

#### 6.1.4 Day/night asymmetry — trees can warm at night

| Effect | Value | Mechanism | Source | Conf. |
|---|---|---|---|---|
| Mechanism decomposition — **numerical experiments removing/adding each tree effect separately**: evapotranspiration of well-watered trees alone lowers 2 m T_a by **at maximum 3.1–5.8 °C** across four climates (Phoenix, Singapore, Melbourne, Zurich); a **non-transpiring** tree interacting with radiation **increases 2 m T_a by up to 1.6–2.1 °C** in certain hours; trees also **reduce urban aerodynamic roughness**, inhibiting turbulent exchange and **increasing daytime air temperature**; at night single-tree effects are variable, driven by canyon atmospheric stability | Mechanistic urban ecohydrological model | Meili et al. 2020, *Urban For. Urban Green.* 47:126970 | **[V-abs]** **high — the definitive mechanism paper; cite this for the sign structure** |
| Nocturnal **warming** of **+0.8 °C** attributed to reduced SVF under canopy | Field correlation of T_a with SVF, Singapore (Hien & Jusuf) | via Li et al. 2024/2025 | **[V]** the quoting text |
| Meta-analytic nighttime ΔT_air,min by climate: **+0.80 °C (Af, tropical rainforest — the largest warming of any climate type)**, **+0.35 °C (Csa/Csb)**, **+0.30 °C (continental Dfa/Dwa/Dfb)**, **+0.20 °C (tropical overall)**, **+0.02 °C (temperate overall)**, **−0.41 °C (Aw)**, **−0.42 °C (arid)** | 78 studies | Li et al. 2024/2025 | **[V]** **high — use this table directly as the night-time sign/magnitude lookup** |
| Stated cause: "reduction in cooling or minor warming during the nighttime can be caused by **stomatal closure**, **reduced heat removal due to aerodynamic resistance**, and the **trapping of longwave radiation beneath the tree canopy**" | – | Li et al. 2024/2025 | **[V]** |
| Arid-climate WRF+TUF: large city-wide planting of a **drought-tolerant** species cools mainly at **night, up to 1.5 °C**, with **daytime effects limited** because leaves shed sensible rather than latent heat once stomata close at high VPD; a **more transpiring** species doubles the night cooling and reaches **0.4 °C by day**, but **triples water demand** | Las Vegas | Henao et al. 2025 | **[V-abs]** high |
| Nighttime canopy VCE ≈ **50 % of daytime** in the three modelling studies that reported both | – | Krayenhoff et al. 2021 | **[V]** medium |
| Ziter observational night: canopy still cooling, but only **0.3–0.5 °C over 0→100 % λ_c** | Madison | Ziter et al. 2019 | **[V]** high |

**Recommended implementable value.** Model the night term as a **separate, sign-switchable coefficient**: **ΔT_a(night) = −0.05 K to +0.08 K per +0.10 λ_c**, defaulting to **−0.03 K per +0.10** in temperate/continental and to **+0.08 K per +0.10** in tropical humid (Af). Set **ΔT_mrt(night) ≥ 0** — canopy blocks the sky's longwave sink exactly as a low SVF does. **Do not double-count this with the SVF lever in 6.6.2.**

#### 6.1.5 Species-specific transpirational cooling

| Quantity | Value | Source | Conf. |
|---|---|---|---|
| *Tilia cordata* and *Robinia pseudoacacia* reduce **air temperature 1.6–3.0 °C**, **surface temperature up to 23 °C**, **PET up to 11 °C** | Rahman et al. (Würzburg, 8 plots / 5 sites, full-year 2018 + hottest days 23–31 July) | **[U]** — from a search summary; primary paywalled |
| Daytime T_a reduced **up to 3.5 °C with an energy loss of 75 W m⁻²** for *Tilia cordata* in a warm dry August | Rahman et al. | **[U]** same caveat |
| Transpiration rates higher in the **diffuse-porous** *Tilia* than in the more water-use-efficient **ring-porous** *Robinia* | Rahman et al. | **[U]** direction is robust and repeated across that group's papers |
| Middel et al. 2021 field ranking of tree shade: **native and palm trees least effective, non-native most effective** at reducing T_mrt; tree shade "varied widely" | Middel, AlKhaled, Schneider, Hagen & Coseo 2021, *BAMS* 102(9) | **[V-abs]** high for the ranking |
| Nonlinear increase of cooling with **LAI, leaf area density, canopy coverage** and inversely with **SVF**; canopy solar transmissivity falls **54 % per unit LAI**, saturating around **LAI ≈ 6** | Li et al. 2024/2025; Convertino et al. 2022 | **[V]** medium-high |

**Implementation note.** Species selection changes the *partition* between shade (T_mrt) and transpiration (T_a), not just the magnitude. A drought-tolerant species is a T_mrt lever with almost no daytime T_a benefit; a high-transpiration species buys T_a at ~3× the irrigation water. Expose that trade-off.

#### 6.1.6 The companion coefficient: impervious surface fraction

| Coefficient | Value | Source | Conf. |
|---|---|---|---|
| Daytime T_a **increase** over 0→100 % impervious cover, **linear**: **+0.5 °C (10 m radius), +0.7 °C (30 m), +1.0 °C (60 m), +1.3 °C (90 m)** → **+0.05 to +0.13 K per +10 % impervious** **[D]** | Ziter et al. 2019 | **[V]** **high** |
| Nighttime: **+0.3 to +0.7 °C** over 0→100 %, magnitude increasing with scale → **+0.03 to +0.07 K per +10 %** **[D]**. Reducing impervious cover "remained important for lowering nighttime temperatures" | Ziter et al. 2019 | **[V]** high |
| Evening (17:00–20:00) warming from impervious surface: **+1.11 °C** over 0→100 % on clear and cloudy days; cloudy nights/mornings **+1.03 °C** | Locke et al. 2024 | **[V]** high |
| Context: mean within-transect daytime T_a range was **3.5 °C (SE 0.13; range 1.1–5.7 °C)**, and mean nighttime differences only **0.5 °C (10 m) to 1.1 °C (90 m)** | Ziter et al. 2019 | **[V]** high — the ceiling on what any intra-urban slider can move |
| Caution on LST-based impervious relationships: linear ISA→LST regressions reach RMSE **1.40 °C day / 0.80 °C night**; sensitivity of LST to ISA is **highest at low ISA (0–0.3)** and **saturates at high ISA**. These are **surface**, not air, relationships | multiple | **[V-2]** medium — do not convert to a K-per-10 %-impervious air-temperature slider without an explicit T_s→T_a transfer |

---

### 6.2 Cool roofs and albedo → temperature

#### 6.2.1 Roof surface temperature

| Coefficient | Value | Source | Conf. |
|---|---|---|---|
| Worked triad on a hot sunny day: **black roof (α 0.05, ε 0.92) reaches 180 °F / 82 °C**; **metal roof (α 0.60, ε 0.25) 160 °F / 71 °C**; **white roof (α 0.75, ε 0.92) 120 °F / 49 °C** | EPA, *Reducing Urban Heat Islands: Compendium of Strategies — Cool Roofs*, Ch. 4, Fig. 5 (U.S. EPA 2008) | **[V]** **high** |
| **[D] Derived:** black → white = **33 K reduction for Δα = 0.70 → ΔT_s = −4.8 K per +0.1 α** (roof skin, peak) | Arithmetic on the above | **[D]** |
| Standard black asphalt roofs reach **165–185 °F (74–85 °C)** at midday in summer; bare/metallic-surfaced roofs **150–165 °F (66–77 °C)**; cool roofs with both high reflectance and high emittance peak at only **110–115 °F (43–46 °C)** | EPA Ch. 4 §1.4 | **[V]** high |
| **Conventional roofs can be 55–85 °F (31–47 °C) hotter than the air**; **cool roofs stay within 10–20 °F (6–11 °C) of background air temperature** | EPA Ch. 4 §1.4 | **[V]** **high — the most useful pair of bounds** |
| Traditional roofing materials have solar reflectance of **5–15 %** (absorbing 85–95 %); the coolest materials **>65 %** | EPA Ch. 4 §1.2 | **[V]** high |
| Measured: black roof **68 °C** and white roof **42 °C** when ambient reached **33 °C** (Δ = **26 K**); green-roof membranes in the same comparison **31–38 °C** | Santamouris 2014 §4, reporting an instrumented comparison | **[V]** high |
| Clean white roof reflects 80 % vs grey roof 20 % and stays **≈31 °C (55 °F) cooler** on a typical summer afternoon; measured black vs white roof difference **30 °C (54 °F)**; cool-coloured roof (35 % vs 10 %) stays **≈12 °C (22 °F) cooler** | LBNL Heat Island Group, *Cool Roofs* | **[V-2]** high |
| A white painted stripe on a brick wall measured **5–10 °F (3–5 °C) cooler** than the surrounding darker areas | EPA Ch. 4 §1.2 caption | **[V]** high — useful order of magnitude for wall paint |

**Verdict on the "30–40 K roof surface temperature reduction" claim: SUBSTANTIATED.** 26–33 K is what verified sources give for black→white on the roof skin at peak, i.e. **ΔT_s ≈ −4 to −5 K per +0.1 roof albedo**. The often-quoted 40+ K figures are peak-instant, low-wind, high-insolation cases at the top of the envelope.

#### 6.2.2 Neighbourhood- to city-scale 2 m air temperature — an order of magnitude smaller

| Coefficient | Value | Basis | Source | Conf. |
|---|---|---|---|---|
| **ACE definition:** Albedo Cooling Effectiveness in °C is "the cooling obtained from a **neighbourhood albedo increase from 0.0 to 1.0**, assuming linear temperature responses", where Δα_N = Δα_s · λ_s (λ_s = modified surface area / plan area). **VCE** is defined the same way with λ_s = added vegetation area / plan area. **Divide all ACE/VCE values by 10 to get K per 0.10.** | – | Krayenhoff et al. 2021, *ERL* 16(5):053007, doi:10.1088/1748-9326/abdcf1 | **[V]** **critical for correct implementation** |
| **Whole-neighbourhood (all urban surfaces) albedo: ACE median = 6.0 °C → 0.60 K per +0.10 Δα_N**, summer afternoon (combined micro + mesoscale). Paper's own headline: **"approximately 0.2–0.6 °C cooling per 0.10 neighbourhood albedo increase"** | 47 quality-filtered studies of 146 reviewed, 1987–2017 | Krayenhoff et al. 2021 | **[V]** **high — the reference range** |
| **Roof-only albedo: ACE median 1.6 °C microscale (ENVI-met 3.1) → 0.16 K per 0.10**; **5.8 °C mesoscale → 0.58 K per 0.10**, summer afternoon. **Mesoscale summer night median 2.2 °C → 0.22 K per 0.10** | Same | Krayenhoff et al. 2021 | **[V]** high |
| **Ground/pavement-only albedo: microscale ACE ≈ 5.7 °C → 0.57 K per 0.10** (large inter-study variation); the single mesoscale study gave **less than half** the microscale value | Same | Krayenhoff et al. 2021 | **[V]** high |
| **Whole-city albedo, average ambient T_a: −0.3 K per +0.1 α.** Regression across all mesoscale studies: **ATD = 3.11 · Δα, R² = 0.85**, valid 0 < Δα < 1. Per-study range **0.0 to −0.61 K per 0.1** | Meta-regression, Δα spanning 0.01–0.35 | Santamouris 2014, *Solar Energy* 103:682–703 | **[V]** **high — the ready-made equation to implement** |
| **Whole-city albedo, PEAK ambient T_a: −0.9 K per +0.1 α**; per-study range **−0.57 to −2.3 K per 0.1**; absolute peak reductions 1.0–3.5 K. Fit is linear but with "important scattering… the correlation coefficient is not quite high" | Same | Santamouris 2014 | **[V]** medium-high — use as an **upper-bound envelope**, not a point estimate |
| **Roof-only albedo: −0.1 to −0.33 K per +0.1 roof α, mean −0.20 K** (New York 0.10–0.19; Athens 0.11–0.33; absolute min 0.02 K, max 0.41 K) | Savio et al. 2006 (MM5, NYC); Synnefa et al. 2008 (MM5, Athens) | via Santamouris 2014 | **[V]** high |
| **THE HONEST RECENT NUMBER: "the real magnitude of the afternoon temperature drop caused by the albedo increase is close to 0.09 °C per 0.1 rise of the albedo"**, highly determined by local climate, landscape and layout; statistically significant association of the temperature drop with albedo increase, greenery and street ratio | Review + reanalysis of **fourteen detailed studies** of increased urban albedo | Santamouris & Fiorito 2021, *Solar Energy* 216, doi:10.1016/j.solener.2021.01.031 | **[V-abs]** **high — cite this as the low, realistic bound; it is a factor of 3–10 below the 2014 figures by the same lead author** |
| **ΔT_a = −0.32 K per +0.1 grid-cell-average albedo at 14:00 LST**, response "nearly linear" over Δα = 0.1 and 0.4. Annual-mean for **Δα_pavement = +0.4: −0.18 K (Palm Springs) to −0.86 K (San Jose)** | WRF 4 km, all California cities, validated against 105 stations (bias −0.30 °C), off-line canyon-albedo model | Mohegh, Rosado, Jin, Millstein, Levinson & Ban-Weiss 2017, doi:10.1002/2017JD026845 | **[V]** **high — cleanest citable mesoscale coefficient** |
| Extensive cool-roof deployment, **maximum city-averaged daytime cooling: 0.38 °C (Atlanta), 0.42 °C (Detroit), 0.66 °C (Phoenix)**. Cool roofs in Phoenix are **11 % more effective** than in Atlanta and **30 % more effective** than in Detroit. Effectiveness roughly persists under end-of-century heatwaves; some indication of *increasing* effectiveness in Phoenix | WRF + multi-layer urban model resolving pedestrian level; start-, mid- and end-of-century heatwaves | Broadbent, Krayenhoff & Georgescu 2020, doi:10.1088/1748-9326/ab6a23 | **[V-abs]** high |
| Domain-wide cool roofs + cool pavements: **afternoon summertime temperature in urban locations reduced 0.11–0.53 °C** (some urban areas showed no statistically significant change); **some rural locations showed summer afternoon increases of up to +0.27 °C**, correlated with less cloud cover and lower precipitation. Domain-wide annual-mean outgoing radiation **+0.16 ± 0.03 W m⁻²**; emissions offset **3.3 ± 0.5 Gt CO₂** | WRF, coupled regional climate, continental USA | Millstein & Menon 2011, *ERL* 6:034001 | **[V-abs]** high |
| **100 % cool roofs at α = 0.85 gave −1.2 K city-average**, up to −2.0 K locally, and **>−0.5 K constant at night**; net **−50 W m⁻²** incoming solar and **−30 W m⁻²** sensible heat. Same study: street-level vegetation −0.3 K; solar PV −0.5 K; city-wide AC **+0.15 K** (up to +1.0 K in central London) | WRF BEP-BEM, Greater London, 2 hot days summer 2018, 9 interventions | Brousse, Simpson, Zonato, Martilli, Taylor, Davies & Heaviside 2024, *GRL* 51(13) | **[V]** high |
| Raising the albedo of **all paved surfaces by 0.20** is projected to reduce summertime outdoor air temperature in California cities by **0.1–0.5 °C** → **0.05–0.25 K per +0.1 pavement α** **[D]** | LBNL Heat Island Group, *Cool Pavements* | **[V-2]** high |
| **The high-rise decoupling:** street-level effect of cool roofs in tall-building districts is only **−0.10 K (high-rise)** and **−0.12 K (medium-rise)**. "The impact of reflective roofs on the ambient temperature at street level is seriously reduced when the height of buildings where cool roofs are applied is great." | Santamouris 2014, reviewing Chen et al. 2009 (Tokyo) and Ng et al. 2012 (Hong Kong) | **[V]** **high — a mandatory gate on any roof-albedo slider** |
| Global-scale: increasing roof and pavement albedo by **0.25 and 0.15** respectively decreases radiative forcing by **0.15 W m⁻² over global land**, equivalent to a one-time offset of **44 Gt CO₂**; +0.20 roof albedo gives a CO₂ offset of **0.05 t m⁻²**; a long-term global cooling of **3 × 10⁻¹⁵ K per m² per 0.01 albedo**, ≈ **7 kg CO₂-equivalent** | Akbari & Matthews 2010; Akbari et al. 2009, 2012; Van Curen 2011 (mean radiative forcing **1.38 W m⁻² per 0.01 albedo** in California) | via Santamouris 2014 | **[V]** the quoting text, **[V-2]** the primaries |
| Contrarian global result: worldwide conversion to cool roofs (all roofs 0.12 → 0.65, overall urban albedo +0.147) would **decrease population-weighted temperature by 0.02 K but increase overall Earth temperature by 0.07 K** | Jacobson & Ten Hoeve 2012 (GATOR-GCMOM) | via Santamouris 2014, which notes the assumptions were contested by Oleson et al. | **[V]** the quoting text; contested |
| Health co-benefit coefficient: increased urban albedo reduces heat-related mortality by **0.1–4 deaths per day**, an average decrease of **19.8 % per K of temperature drop**, or **1.8 % per +0.1 albedo** | Santamouris & Fiorito 2021 | **[V-abs]** medium-high |

**Recommended implementable values, cleanly separated by scale.**

| Scale / target | ΔT per +0.1 albedo | Conf. |
|---|---|---|
| **Roof surface (skin), peak** | **−4 to −5 K** | high |
| **Pavement surface (skin), peak** | **−3.0 K** (see 6.3) | high |
| **2 m air, pedestrian, roof-only intervention, microscale** | **−0.16 K** | high |
| **2 m air, pedestrian, roof-only intervention, mesoscale** | **−0.2 to −0.6 K** | high |
| **2 m air, neighbourhood, all-surface Δα_N** | **−0.2 to −0.6 K** (Krayenhoff); central **−0.32 K** (Mohegh) | high |
| **City mean, average ambient** | **−0.3 K** (Santamouris 2014 fit); **−0.09 K** (Santamouris & Fiorito 2021 reanalysis) | both high — **report as a −0.09 to −0.3 K band, not a point value** |
| **City mean, PEAK ambient** | **−0.9 K** (range −0.57 to −2.3) | medium-high |
| **Street level, H/W > 1 or BH > ~20 m, roof intervention** | **−0.1 K, i.e. effectively zero** | high |

The commonly cited **"~0.3 K per 0.1 albedo at city scale"** is **verified** — it is Santamouris (2014)'s meta-regression of average ambient temperature. But the same author's 2021 reanalysis of 14 detailed studies puts the **realistic afternoon figure at 0.09 K per 0.1**. Both are peer-reviewed. Ship the band.

#### 6.2.3 The pedestrian-level radiant penalty of high albedo

High-albedo walls and pavements reflect shortwave onto pedestrians. This can **reverse the sign** of the intervention for human thermal comfort even while air temperature falls.

| Coefficient | Value | Basis | Source | Conf. |
|---|---|---|---|---|
| **"An increase of every 0.1 albedo of the surfaces led to 1.2 °C higher mean radiant temperature, and consequently, 0.8 °C higher PET."** Roof and wall albedo raised from 0.2 (control) to 0.3, 0.4, 0.5, 0.6. Also: increased albedo raised average ground surface sensible heat flux by **6.7 W m⁻²** and ground surface temperature by **0.4 °C** during the day. Baseline comparison: PET in the grass campus park was **11.0 °C lower** than in the concrete parking lot at 16:00 CET | CFD, validated against a measurement campaign, university campus | **Taleghani (2018), *Urban Climate* 24 — sole author, doi:10.1016/j.uclim.2018.03.001** | **[V-abs]** **high — this is the canonical "1.2 K MRT / 0.8 K PET per 0.1 albedo" coefficient. NOTE: it is widely and incorrectly attributed to "Taleghani & Berardi 2017"; the correct attribution is Taleghani 2018 (same journal, adjacent volume).** |
| **ΔT_mrt = +2.6 to +3.0 K per +0.1 α; ΔPET = +0.73 K per +0.1 α** (unshaded). Absolute for Δα = +0.3 (0.2 → 0.5): T_mrt **+7.8 K** max above paved surfaces at 1.5 m, **+8.9 K** at the central unshaded receptor across 0–2.5 m. Daytime-mean (05:00–17:00) PET at 5 unshaded receptors 35.5 → **37.7 °C = +2.2 K**. The shaded-minus-unshaded PET gap at 15:00 widens from ~7 K (all other scenarios) to **12.7 K** with cool pavement | ENVI-met + RayMan, El Monte, LA County | Taleghani, Sailor & Ban-Weiss 2016 | **[V]** high |
| **SIGN FLIP WITH SHADE: ΔPET = −0.37 K per +0.1 α at *shaded* receptors** (−1.1 K for Δα = +0.3) ~5 m from the treated roadway under existing canopy — the advected air-temperature reduction outweighs the small local radiative change. **After 17:00 cool pavement gives the lowest PET of all scenarios** | Same | Taleghani et al. 2016 | **[V]** **high — a first-order design rule** |
| **ΔT_mrt = +2.2 to +3.6 K per +0.1 α**, standing directly over the pavement, unshaded: absolute **+4 K at midday, +2 K in the afternoon** for Δα = 0.11–0.18. Reflected shortwave up **+118 W m⁻²** (Sun Valley), **+144 W m⁻²** daytime average, **up to +130 to +168 W m⁻²** at solar noon. Adjacent sidewalks received **+20 to +30 W m⁻²** in the early evening | MaRTy mobile biometeorological cart, two LA neighbourhoods | Middel, Turner, Schneider, Zhang & Stiller 2020 | **[V]** **high — the canonical measurement** |
| **ΔT_mrt ≈ +2.6 K per +0.1 α**: absolute max **+5.1 °C at noon** (Westcliff); afternoon **+1.4 to +2.3 °C**, for Δα ≈ 0.20. **Night-time BENEFIT: T_mrt −0.5 to −1.3 °C post-sunset** (reduced upwelling longwave) | 8 Phoenix neighbourhoods, 7-month campaign, City of Phoenix cool-pavement pilot on 58 km of residential streets | Schneider, Ortiz, Vanos, Sailor & Middel 2023, *Nature Communications* 14, doi:10.1038/s41467-023-36972-5 | **[V]** **high** |
| **ΔUTCI ≈ +0.6 K per +0.1 α**: α 0.12 → 0.30 gave **+1.2 K UTCI** at every hour 08:00–18:00; α 0.12 → 0.50 gave **+2.3 to +2.4 K** (study average **+2.35 K** for Δα = 0.38). Corresponding T_mrt **+6.25 K** (Δα 0.18) and **+8.75 K** (Δα 0.38) at midday → **+3.5 and +2.3 K per 0.1** respectively, i.e. **sub-linear** | ENVI-met + Ladybug/Grasshopper, Cairo, July; MRT validated R² = 0.93 | Elgendy, Tolba & Kamel 2025 | **[V]** medium-high |
| Facade albedo: "high albedo had **13.2 % more combined thermal stress** compared to medium albedo"; high albedo performed much better in **deep** canyons than wide ones, with average UTCI decreasing by **4.8–5.7 %**; medium albedo should be used exclusively in wide canyons; **"a medium albedo value performs best thermally in all urban street canyons"** | 9 idealised 2-D canyon scenarios varying aspect ratio and albedo | Feteha & ElDeeb 2024, *Build. Serv. Eng. Res. Technol.* 45(4):457–473, doi:10.1177/01436244241245530 | **[V-abs]** medium — percentages only, no K values |
| **COUNTER-EVIDENCE (cooling, not warming): ΔT_mrt = −0.9 to −1.3 K** (real-time mean); **ΔPET = −0.2 to −0.6 K** RT and **−1.7 K** difference-of-difference; **ΔPMV = −0.09** RT / **−0.32** DofD. Author attributes the net benefit to reduced surface temperature and reduced longwave upwelling outweighing the added shortwave | High-resolution multi-platform observations, Pacoima CA, Sept 2022 heatwave | Taha 2024, *Environ. Res. Commun.* 6(3) | **[V-abs]** high for the study — **this directly contradicts Middel/Schneider/Taleghani. The sign of the pedestrian radiant term is genuinely contested.** |
| Foundational conceptual result: "although use of high-albedo materials in canyon surfaces may lower air temperature, **the reduction is not enough to offset increased radiant loads, and as a result, pedestrian thermal comfort may in fact be compromised**"; higher albedo elevates thermal stress in all canyons, wide or narrow; **thermal stress decreases with increasing H/W independent of α**; **high-albedo building *façades*, not pavements, are the principal source** of the increase | ENVI-met, E–W canyon, Stuttgart + four cities; Index of Thermal Stress | Erell, Pearlmutter, Boneh & Bar Kutiel 2014, *Urban Climate* 10(P2):367–386, doi:10.1016/j.uclim.2013.10.005 | **Citation verified via Crossref; ALL numeric ITS/K values [U].** ScienceDirect, the Harvard mirror, BGU, TUM mediatum, ResearchGate and Academia all returned 403 or a bot challenge. Cite the qualitative conclusion only. |
| Reflective pavement raises T_mrt by **≈+10.4 K** in specific zones of a historic square (extreme value); the same study's permeable paved grass gave ΔT_s −3.7 to −4.3 K, ΔUTCI −2.3 to −3.0 K, **ΔT_mrt −10.6 K** | ENVI-met, Alameda de Hércules, Seville | Rezaie, Galan-Marin & Lopez-Cabeza 2026 | **[V-abs]** low-medium (single simulation, extreme) |

**Recommended implementable values.**
- **Unshaded pedestrian, midday: ΔT_mrt = +1.2 to +2.6 K per +0.1 α.** Use **+1.2 K** for a *whole-envelope* (roof + wall) albedo increase (Taleghani 2018) and **+2.5 K** for a *pavement directly underfoot* increase (Middel 2020, Schneider 2023, Taleghani 2016). These are different geometries, not conflicting results.
- **ΔPET = +0.7 to +0.8 K per +0.1 α** (unshaded, daytime). **ΔUTCI ≈ +0.6 K per +0.1 α.**
- **Shaded pedestrian ≥5 m from the treated surface: ΔPET ≈ −0.4 K per +0.1 α** — net benefit.
- **Night: ΔT_mrt ≈ −0.3 to −0.7 K per +0.1 α** — net benefit, from reduced upwelling longwave.
- Attach an explicit **"contested sign"** flag citing Taha 2024.

# Canyon Physics Engine — Formula Verification Against Published Literature

**Purpose:** independent check of the already-implemented urban-canyon heat physics formulas
against the primary literature. One section per implemented formula: verdict, canonical
citation, exact published form, standard coefficient values, and any error found.

**Date of review:** 2026-08-27

**Verdict legend**
- `CORRECT` — matches the published form exactly.
- `CORRECT (with caveat)` — the algebra is right but there is a domain-of-validity or
  interpretation issue that should be documented in code.
- `WRONG` — the implemented form does not match the source; corrected form given.

**Methodology note / limits of this review.** Formula algebra was verified by
independent re-derivation from first principles (shown inline) wherever the result is
analytically derivable — this is stronger evidence than a citation, because it does not
depend on a secondary source having transcribed a coefficient correctly. Where a value is
purely empirical (regression coefficients, drag coefficients, measured lapse rates) it can
only be taken from the source. Items flagged **[UNVERIFIED-SOURCE]** are ones where the
web-search budget for this session was exhausted before the primary text could be pulled;
those coefficients are reported from memory of the literature and **must be confirmed
against the paper PDF before being quoted in anything user-facing.** Treat that tag as a
hard blocker for publication, not a soft note.

---

## Summary table

| # | Formula | Verdict |
|---|---------|---------|
| 1 | SVF horizontal, `mean(cos²β)` | **CORRECT** — proved exact |
| 2 | SVF wall, `0.5(1−sin α)` | **CORRECT** — proved exact, integrates to TEB |
| 3 | Canyon wind `exp(−0.386 H/W)` | **QUESTIONABLE ATTRIBUTION** — not TEB's form |
| 4 | `h_c = 5.7 + 3.8u` | **CORRECT (with caveat)** — it is a *combined* coefficient |
| 5 | Macdonald roughness | **WRONG** — `λ_p` used where source has `λ_f` |
| 6 | Berdahl–Martin sky emissivity | **CORRECT (with caveat)** — missing diurnal/pressure terms |
| 7 | Monin–Obukhov profile | **CORRECT** — signs self-consistent |
| 8 | Vertical air-temperature gradients | **MOSTLY CONSISTENT** — see numbers |
| 9 | Oke 1981 UHI regressions | **ONE COEFFICIENT SUSPECT** — 7.54 vs 7.45 |
| 10 | WBGT + Stull wet-bulb | **CORRECT (with major caveat)** — Tnwb ≠ Tw |
| 11 | Kasten–Young + Meinel | **CORRECT** |
| 12 | Kasten–Czeplak cloud | **CORRECT** |

---

## 1. Sky View Factor — horizontal surface, discretized horizon scan

### Implemented

```
SVF = (1/N) * Σ_i cos²(β_i)      over N equally-spaced azimuths
```
where `β_i` is the horizon elevation angle in azimuth sector `i`.

### Verdict: **CORRECT.** This is the right form for a horizontal surface.

Your rejection of the `(1/N) Σ (1 − sin β_i)` form **for a radiative view factor** is also
correct, and your ~35% figure is the right order of magnitude. But the other form is not a
mistake in its own literature — it is a *different quantity*. That distinction is the whole
source of the confusion, and it is worth getting precisely right, so it is derived below.

### Derivation (proof that your form is exact)

The radiative view factor from a differential planar element to a portion of the
hemisphere is the **cosine-weighted** (Lambert-weighted) solid-angle fraction:

```
F = (1/π) ∫∫ cos θ · sin θ dθ dφ
```

with `θ` the zenith angle measured from the element's normal (vertical, for a horizontal
surface). The `1/π` normalises the full hemisphere to `F = 1`. The `cos θ` is *not* optional
— it is Lambert's cosine law: a patch of sky near the horizon delivers less irradiance to a
horizontal surface than the same solid angle at the zenith, because the flux is projected
onto the receiving surface.

In azimuth sector `i` the sky is unobstructed for `θ` from `0` to `(π/2 − β_i)`:

```
∫_0^{π/2 − β} cos θ sin θ dθ = ½ sin²θ |_0^{π/2 − β} = ½ sin²(π/2 − β) = ½ cos²β
```

Summing over `N` sectors each of azimuthal width `Δφ = 2π/N`:

```
F = (1/π) · Σ_i (2π/N) · ½ cos²β_i = (1/N) Σ_i cos²β_i     ∎
```

So the implemented estimator is the exact quadrature of the true radiative view factor,
with no approximation beyond the azimuthal discretisation itself.

### Verification against the infinite-canyon closed form

Your numerical check is not just close, it is **exact**, and that can be shown analytically.
For a point at the centre of an infinitely long canyon of width `W` between walls of height
`H`, let `a = 2H/W`. The perpendicular distance from the centre to either wall is `W/2`, so
in the azimuth direction `φ` (measured from the canyon axis) the horizon satisfies

```
tan β(φ) = H / ( (W/2) / |sin φ| ) = a · |sin φ|
```

Hence `cos²β = 1 / (1 + a² sin²φ)`, and

```
SVF = (1/2π) ∫_0^{2π} dφ / (1 + a² sin²φ) = 1 / √(1 + a²)
```

(standard integral). And `cos(arctan a) = 1/√(1 + a²)`. **Identical.** So

```
SVF_floor,centre = cos( arctan(2H/W) )
```

is not an empirical fit your scan happens to reproduce — it is the same function. Good
regression test; keep it.

### Why the two competing forms exist — the precise distinction

There are two different scalar summaries of "how much sky is visible", and both are called
"sky view factor" in print. They are not interchangeable and they differ by exactly the
`cos θ` weight.

| | **Radiative view factor** `Ψ_sky` | **Solid-angle sky fraction** (relief-visualisation SVF) |
|---|---|---|
| Weighting | cosine-weighted (Lambert) | uniform solid angle |
| Discretised form | `(1/N) Σ cos²β_i` | `(1/N) Σ (1 − sin β_i)` |
| Normalisation | `∫ cos θ dΩ / π` | `∫ dΩ / 2π` |
| Physical meaning | fraction of isotropic diffuse **irradiance** reaching the surface; the coefficient that multiplies `L↓` and `D_h` in an energy balance | fraction of the **hemisphere's solid angle** that is sky; a geometric openness index |
| Correct use | radiation / energy balance, `T_mrt`, longwave trapping, UHI | terrain and archaeological relief shading, DEM visualisation, lidar openness maps |

The second column's derivation, for completeness — the *unweighted* solid angle of the
visible sky in one sector is

```
Δφ ∫_0^{π/2 − β} sin θ dθ = Δφ [1 − cos(π/2 − β)] = Δφ (1 − sin β)
```

and dividing by the hemisphere `2π` gives `(1/N) Σ (1 − sin β_i)`. It is a perfectly
correct formula — *for the fraction of the sky dome*, which is not what a radiation model
needs.

**Magnitude of the discrepancy.** For a uniform horizon elevation `β`, the ratio
`(1 − sin β) / cos²β = 1/(1 + sin β)`:

| `β` | `cos²β` (radiative) | `1 − sin β` (solid angle) | solid-angle form is low by |
|---|---|---|---|
| 10° | 0.970 | 0.826 | 15% |
| 20° | 0.883 | 0.658 | 25% |
| 30° | 0.750 | 0.500 | 33% |
| 45° | 0.500 | 0.293 | 41% |
| 60° | 0.250 | 0.134 | 46% |

For the horizon elevations typical of dense urban canyons (`β ≈ 25–50°`, i.e. `H/W` roughly
0.5–1.5) the error is **30–42%**, so your "~35%" is well-centred. Note the bias always has
the same sign — the solid-angle form always under-reads — so it does not average out; it
would systematically inflate modelled nocturnal longwave trapping and inflate the UHI.

### Which paper uses which — and why

- **Oke, T.R. (1981).** *Canyon geometry and the nocturnal urban heat island: comparison of
  scale model and field observations.* Journal of Climatology 1(3): 237–254.
  DOI: 10.1002/joc.3370010304 — URL: https://rmets.onlinelibrary.wiley.com/doi/10.1002/joc.3370010304
  Uses the **radiative** view factor `Ψ_sky` throughout; the whole argument of the paper is a
  radiative one (longwave loss from the canyon floor), so it must be cosine-weighted. This is
  the ancestor of the convention you have implemented.

- **Steyn, D.G. (1980).** *The calculation of view factors from fisheye-lens photographs.*
  Atmosphere-Ocean 18(3): 254–258. DOI: 10.1080/07055900.1980.9649091
  The canonical method for extracting `Ψ_sky` from a hemispherical photograph. Steyn
  discretises the fisheye image into `n` **annuli** (rings of constant zenith angle) rather
  than azimuth sectors, and weights each annulus by `sin(2θ)`-type factors — which is the
  same `cos θ sin θ` Lambert kernel as above, just integrated ring-first instead of
  sector-first. Steyn's estimator is therefore the **cosine-weighted** one and is consistent
  with your `cos²β` form; the two differ only in the direction of discretisation.
  **[UNVERIFIED-SOURCE: exact printed coefficient arrangement of Steyn's annular sum not
  re-checked against the paper this session.]**

- **Watson, I.D. & Johnson, G.T. (1987).** *Graphical estimation of sky view-factors in
  urban environments.* Journal of Climatology 7(2): 193–197.
  DOI: 10.1002/joc.3370070210
  Gives the sector-wise **cosine-weighted** construction for urban geometry — this is
  essentially the `cos²β` per-azimuth form you are using, and is the standard citation when
  the horizon is scanned by azimuth rather than by annulus. **Cite this one for your
  implementation**: it is the closest published match to what the code actually does.

- **Zakšek, K., Oštir, K. & Kokalj, Ž. (2011).** *Sky-View Factor as a Relief Visualization
  Technique.* Remote Sensing 3(2): 398–415. DOI: 10.3390/rs3020398 —
  URL: https://www.mdpi.com/2072-4292/3/2/398
  **This is the source of the `1 − sin β` form, and it is a relief-visualisation paper, not
  a radiation paper.** Their SVF is defined as the *proportion of the visible sky within a
  hemisphere of given radius* — a uniform-solid-angle openness measure computed on a DEM,
  designed so that terrain features (ditches, ridges, ramparts) render legibly in a
  grayscale image. There is no radiative transfer anywhere in the paper and no reason for
  them to want a Lambert weight; the cosine weight would actually *reduce* the visual
  contrast they are trying to maximise. Their formula is correct for their purpose.
  **The error in the wild is not in their paper — it is in downstream code that copies their
  equation into an energy-balance model** because the symbol and the name matched. You were
  right to reject it, and this is exactly the provenance you suspected.

- **Lindberg, F., Holmer, B. & Thorsson, S. (2008).** *SOLWEIG 1.0 – Modelling spatial
  variations of 3D radiant fluxes and mean radiant temperature in complex urban settings.*
  International Journal of Biometeorology 52(7): 697–713. DOI: 10.1007/s00484-008-0162-7
  and **Lindberg, F. & Grimmond, C.S.B. (2011).** *The influence of vegetation and building
  morphology on shadow patterns and mean radiant temperatures in urban areas.* Theoretical
  and Applied Climatology 105: 311–323. DOI: 10.1007/s00704-010-0382-7
  SOLWEIG computes `T_mrt`, so it needs the **radiative** factor and uses the cosine-weighted
  definition, following Steyn/Watson-Johnson. SOLWEIG additionally splits the total into
  directional components (`Ψ_sky` decomposed into the four cardinal quadrants plus a
  separate wall/vegetation factor), because `T_mrt` needs the *anisotropic* breakdown, not
  just the scalar. **[UNVERIFIED-SOURCE: quadrant decomposition details from memory.]**

### Recommendation for the code

1. Keep `(1/N) Σ cos²β_i`. It is exact.
2. Rename the symbol in code to `psi_sky_radiative` or add a docstring line
   "cosine-weighted radiative view factor, NOT the Zakšek et al. (2011) solid-angle
   openness index" — this is a mistake that gets re-introduced by well-meaning contributors
   who find the other formula first.
3. Keep the `cos(arctan(2H/W))` infinite-canyon case as an exact regression test.
4. Watch the azimuthal resolution: with `N` sectors the quadrature error in a canyon-like
   geometry goes as `O(1/N²)`. `N = 36` (10° steps) is typically within ~0.3%; `N = 8` is
   not adequate for a canyon because `cos²β` varies sharply near the canyon-perpendicular
   azimuth.

---

## 2. Sky View Factor — point at height z on a vertical wall

### Implemented

```
α    = arctan( (H − z) / W )
SVF  = 0.5 * (1 − sin α)          for z < H
SVF  = 0.5                        for z ≥ H
```

for a wall point at height `z` facing a parallel wall of height `H` across a street of
width `W`.

### Verdict: **CORRECT.** Exact, and it integrates over the wall height to precisely TEB's
wall–sky view factor. That is a strong dual confirmation.

### The Hottel infinite-strip result

The underlying result is the view factor from a **differential element to an infinitely long
strip** parallel to it (Hottel's formulation; the same geometry that gives rise to the
crossed-strings method). For a differential element, the view factor to a portion of the
surrounding cylinder subtending angles `t₁` to `t₂` **measured from the element's own
normal** is

```
F = ( sin t₂ − sin t₁ ) / 2
```

This is the 2-D (infinite-extent) analogue of the cosine-weighted hemisphere integral: in
2-D the Lambert kernel integrates to `½ d(sin t)` rather than `½ d(sin²θ)`.

The related **Hottel crossed-strings method** — for the view factor between two surfaces of
finite cross-section in a 2-D enclosure — is

```
F_12 = ( Σ crossed strings − Σ uncrossed strings ) / ( 2 × L₁ )
```

i.e. for surfaces 1 and 2 with endpoints, `F_12 = (d₁₃ + d₂₄ − d₁₄ − d₂₃) / (2 L₁)` where
the `d` are straight-line distances ("strings") between the endpoints. Both forms come from
Hottel's radiant-transfer work; the standard modern reference is:

- **Hottel, H.C. & Sarofim, A.F. (1967).** *Radiative Transfer.* McGraw-Hill, New York.
  (The crossed-strings construction is Hottel's, from Hottel 1954 / Hottel & Sarofim 1967.)
- Reproduced in **Modest, M.F., *Radiative Heat Transfer*, 3rd ed., Academic Press (2013)**,
  Ch. 4, and in **Incropera & DeWitt**, view-factor tables — either is a fine citation for
  the infinite-strip and crossed-strings results.
  **[UNVERIFIED-SOURCE: page/equation numbers not re-checked this session.]**

### Application to your geometry (why `0.5(1 − sin α)` is right)

Take the wall point's outward normal as horizontal. The opposite wall's top edge is at
elevation `α = arctan((H − z)/W)` above the horizontal, so measured **from the normal** it is
at angle `α`. The sky occupies everything from `α` up to the zenith at `90°`. Therefore

```
F_sky = ( sin 90° − sin α ) / 2 = ( 1 − sin α ) / 2      ∎
```

which is exactly the implemented expression. Sanity checks:
- `z = H` (wall top): `α = 0`, `SVF = 0.5` — the wall top sees a clean half-hemisphere. ✓
- `W → ∞`: `α → 0`, `SVF → 0.5`. ✓
- `z = 0`, `H/W = 1`: `α = 45°`, `SVF = 0.5(1 − 0.7071) = 0.1464` — wall base sees very
  little sky. ✓

### The `z ≥ H` cap at 0.5 — right answer, worth a comment

Strictly, for `z > H` the term `(H − z)/W` is negative, `α < 0`, and the raw formula returns
`0.5(1 − sin α) > 0.5`. That is geometrically correct **only for an isolated two-wall
canyon**, where a point above the far roofline really does see sky below its own horizontal
plane. In a repeating urban array it does not: rays between `α` and the horizontal pass over
the near roof and strike the *next* block downstream. Clamping to `0.5` is therefore the
physically correct choice for a periodic/urban-array context, and is what TEB-family models
assume. Add a one-line comment saying that the clamp encodes the periodic-array assumption,
otherwise it reads like a numerical guard rather than a modelling decision.

### Cross-check against TEB (Masson 2000)

- **Masson, V. (2000).** *A physically-based scheme for the urban energy budget in
  atmospheric models.* Boundary-Layer Meteorology 94(3): 357–397.
  DOI: 10.1023/A:1002463829265

TEB uses **height-averaged** canyon view factors, with `x = h/w` the canyon aspect ratio:

```
Ψ_road = √( x² + 1 ) − x
Ψ_wall = ½ · ( x + 1 − √( x² + 1 ) ) / x
```

and these satisfy the closure `Ψ_wall = ½ ( 1 − Ψ_road )` (each wall sees sky, the opposite
wall, and the road; the factor ½ from the two walls).

**Your point-wise formula averages to TEB's exactly.** Integrating over wall height, with
`a = H/W` and substituting `u = (H − z)/W`:

```
(1/H) ∫_0^H ½ (1 − sin arctan u) dz
  = ½ [ 1 − (1/a) ∫_0^a u/√(1+u²) du ]
  = ½ [ 1 − ( √(1+a²) − 1 ) / a ]
  = ½ ( a + 1 − √(a²+1) ) / a
  = Ψ_wall  (TEB)                                        ∎
```

Numerical check at `x = h/w = 1`: `Ψ_road = √2 − 1 = 0.4142`,
`Ψ_wall = ½(2 − √2) = 0.2929`, and `½(1 − 0.4142) = 0.2929`. ✓

Note also that TEB's `Ψ_road` is the **road-averaged** value, which is correctly *smaller*
than the road-**centre** value from §1: at `x = 1`, `0.4142 < cos(arctan 2) = 0.4472`. If the
code ever compares a scan-derived floor SVF to TEB's `Ψ_road`, make sure it is comparing
average-to-average, not centre-to-average — that mismatch is a ~7% trap at `x = 1` and grows
with aspect ratio.

### Oke's canyon models

Oke (1981, above) and **Oke, T.R. (1987/2002), *Boundary Layer Climates*, 2nd ed.,
Routledge** use the same infinite-canyon geometry, with the road-centre factor
`Ψ_sky = cos(arctan(2H/W))` — equivalently `Ψ_sky = (1 + (2H/W)²)^{−1/2}` — and the
complementary wall factors. Consistent with the above.


---

## 5. Macdonald, Griffiths & Hall (1998) morphometric roughness

### Implemented

```
d/H  = 1 + A^(-λ_p) * (λ_p - 1),                                   A = 4.43
z0/H = (1 - d/H) * exp{ -[ 0.5 * β * Cd / κ² * (1 - d/H) * λ_p ]^(-0.5) }
       Cd = 1.2,  β = 1.0,  κ = 0.4
```

### Verdict: **WRONG.** There is a real bug.

**The `z0` equation must use the FRONTAL area index `λ_f`, not the plan area index `λ_p`.**
Your `d/H` equation is correct and does use `λ_p`; the `z0/H` equation uses a different
morphometric parameter and you have substituted the wrong one.

### Canonical citation

**Macdonald, R.W., Griffiths, R.F. & Hall, D.J. (1998).** *An improved method for the
estimation of surface roughness of obstacle arrays.* Atmospheric Environment
**32**(11): 1857–1864. DOI: 10.1016/S1352-2310(97)00403-2 —
https://doi.org/10.1016/S1352-2310(97)00403-2
(Bibliographic details confirmed via Crossref. The article itself is paywalled — closed
access per Unpaywall — so the equations below are quoted as reproduced in the open-access
evaluation paper cited next, which is the standard secondary reference for them.)

**Verified against:** Kent, C.W., Grimmond, S., Barlow, J., Gatey, D., Kotthaus, S.,
Lindberg, F. & Halios, C.H. (2017). *Evaluation of Urban Local-Scale Aerodynamic
Parameters: Implications for the Vertical Profile of Wind Speed and for Source Areas.*
Boundary-Layer Meteorology **164**: 183–213. DOI: 10.1007/s10546-017-0248-z —
open access, full text at https://pmc.ncbi.nlm.nih.gov/articles/6979542/
(their Eqs. 9 and 10).

### Correct published form

```
Displacement height  (uses PLAN area index λ_p):

    z_d / z_H = 1 + α^(−λ_p) · (λ_p − 1)


Roughness length  (uses FRONTAL area index λ_f):

    z_0 / z_H = (1 − z_d/z_H) · exp{ −[ 0.5 · β · (C_Db / κ²) · (1 − z_d/z_H) · λ_f ]^(−0.5) }
```

So yes — **`β` does multiply inside the bracket, exactly where you have it**, and it is
inside the quantity that is then raised to the `−0.5` power. That part of your
implementation is right. The `0.5 · β · C_D / κ²` grouping is right. The `(1 − d/H)`
prefactor and the `(1 − d/H)` inside the bracket are both right. **The single error is the
final factor: `λ_f`, not `λ_p`.**

### Standard coefficient values (confirmed)

| Symbol | Staggered array | Square array | Note |
|---|---|---|---|
| `α` (your `A`) | **4.43** | 3.59 | appears only in `z_d` |
| `C_Db` | **1.2** | 1.2 | obstacle drag coefficient |
| `β` | **1.0** | 0.55 | drag correction factor |
| `κ` | **0.40** | 0.40 | von Kármán |

Your `A = 4.43`, `C_d = 1.2`, `β = 1.0`, `κ = 0.4` is the **staggered-array** parameter set,
which is the conventional default for real urban areas (buildings are not aligned in
regular rows). That choice is defensible — just document it, and note that a genuinely
gridded street layout (Manhattan, Barcelona Eixample, Chinese superblocks) is closer to the
square-array set `α = 3.59, β = 0.55`, which gives a materially smaller `z_0`.

### Why this matters — magnitude of the bug

`λ_p` (plan area index) = building footprint area / total plan area.
`λ_f` (frontal area index) = building frontal area projected into the wind / total plan area,
and it is **wind-direction dependent**.

They coincide only for the special case of **cubes** (`λ_f = λ_p` when height = width and the
wind is normal to a face). For any real morphology they differ, often by a lot:

- **Tall slender towers** (small footprint, large height): `λ_f ≫ λ_p`. Using `λ_p`
  **under-estimates** `z_0` — because the bracket is smaller, its `−0.5` power is larger, the
  exponential is smaller. A CBD of point towers is the worst case.
- **Low sprawling sheds / warehouses** (large footprint, low height): `λ_f < λ_p`. Using
  `λ_p` **over-estimates** `z_0`.
- Typical mid-rise European perimeter blocks: `λ_f` and `λ_p` are within ~30% of each other,
  so the bug is mild there and may well be why it has not shown up in testing.

Because `z_0` sits inside a logarithm in the wind profile, a factor-of-2 error in `z_0`
moves the modelled wind speed at a given height by roughly `ln(2)/ln(z/z_0)` ≈ 8–12% for
typical `z/z_0`. That then propagates into `h_c` (item 4) and the canyon wind (item 3), so
it is not a cosmetic error, but it is also not catastrophic — it is a systematic bias that
grows with the aspect ratio of the buildings themselves.

### Fix

Compute and pass `λ_f` separately:

```
λ_f(θ) = Σ ( building frontal area projected normal to wind direction θ ) / A_total
λ_p    = Σ ( building footprint area ) / A_total
```

Keep `λ_p` in the `z_d` equation. If the engine only has a single scalar morphology input
and genuinely cannot compute `λ_f`, then the honest fallback is `λ_f ≈ λ_p · (H/L)` where
`L` is a characteristic horizontal building dimension — and that approximation must be
documented as such, because silently reusing `λ_p` reads as if the source formula said `λ_p`.

Also worth adding: Macdonald's method is validated for roughly `λ_p ≲ 0.35`. Above that the
array enters the "skimming flow" regime where `z_0` peaks and then *declines* with further
densification; Macdonald's `z_0` keeps rising, so it over-predicts for very dense fabric.
Clamp or flag `λ_p > 0.35`.


---

## 3. Canyon wind speed

### Implemented

```
u_canyon = u_above * exp( -0.386 * H/W )
```

### Verdict: **QUESTIONABLE ATTRIBUTION.** The form is defensible; the citation is not.

I could **not** verify the coefficient `0.386` in Masson (2000), in Nunez & Oke (1977), or in
Rotach's work, and I could not find `exp(−a·H/W)` in that form in the TEB literature. Two
separate problems:

**(a) TEB does not use this functional form.** Masson (2000)'s canyon wind is a diagnostic
based on the wind at roof level combined with a geometric factor for the canyon vortex
(a `2/π` factor arises from averaging the recirculating vortex over the canyon), not a
simple `exp(−a·H/W)` decay from the above-roof wind. More importantly, **TEB abandoned the
simple diagnostic** — the canyon wind in the modern scheme is prognostic:

- **Hamdi, R. & Masson, V. (2008).** *Inclusion of a Drag Approach in the Town Energy
  Balance (TEB) Scheme: Offline 1D Evaluation in a Street Canyon.* Journal of Applied
  Meteorology and Climatology **47**(10): 2627–2644. DOI: 10.1175/2008JAMC1865.1 —
  https://journals.ametsoc.org/view/journals/apme/47/10/2008jamc1865.1.xml
  (Title verified. The existence of this paper is itself the evidence: TEB's original
  diagnostic canyon wind was replaced by a canopy drag formulation.)
- **Masson, V. & Seity, Y. (2009).** *Including Atmospheric Layers in Vegetation and Urban
  Offline Surface Schemes.* Journal of Applied Meteorology and Climatology 48: 1377–1397.
  DOI: 10.1175/2009JAMC1866.1 — introduces the TEB-SBL prognostic in-canyon profiles.
- Confirmed in **Redon, E. et al. (2020).** *An urban trees parameterization for modeling
  microclimatic variables and thermal comfort conditions at street level with the Town
  Energy Balance model (TEB-SURFEX v8.0).* Geoscientific Model Development **13**: 385–399.
  DOI: 10.5194/gmd-13-385-2020 — https://gmd.copernicus.org/articles/13/385/2020/
  which describes momentum and TKE evolution equations with a building drag term plus a tree
  drag term, and an SBL parameterization computing in-canyon vertical profiles. **Verified by
  reading the paper.** There is no `exp(−a·H/W)` diagnostic in current TEB.

**(b) `0.386` is unsourced.** It may be correct, it may be a fit somebody made, or it may be
a coefficient that has drifted through a chain of secondary sources. **Do not cite Masson
(2000) for it.** Until you can point at a page in a paper, either drop the citation and label
it a calibration constant, or replace the formulation with one that is properly sourced.

### What is well sourced, if you want a citable canyon-wind law

The defensible published options, in increasing order of fidelity:

**Option 1 — exponential canopy wind profile (recommended replacement).** The standard
in-canopy profile, originally for vegetation canopies and carried over to urban canopies:

```
u(z) = u(H) · exp[ a ( z/H − 1 ) ]        for z ≤ H
```

with `a` the canopy attenuation coefficient. Note the argument is `z/H`, not `H/W` — the
morphology enters through `a`.

- **Cionco, R.M. (1965).** *A mathematical model for air flow in a vegetative canopy.*
  Journal of Applied Meteorology **4**: 517–522. (Citation verified.)
- **Macdonald, R.W. (2000).** *Modelling the mean velocity profile in the urban canopy
  layer.* Boundary-Layer Meteorology **97**(1): 25–45. DOI: 10.1023/A:1002785830512 —
  gives `a` for urban obstacle arrays as a function of the frontal area index `λ_f`.
  (Citation verified via Crossref.) Convenient: this is the **same author and the same
  `λ_f`** as your item 5, so one morphology input feeds both.
  Typical urban values `a ≈ 0.5` (sparse) to `≈ 3` (very dense); `a ≈ 1` is a common default.

**Option 2 — spatially averaged canopy velocity scale.** For a bulk canyon wind rather
than a profile, the standard scaling relates the in-canopy mean speed to `u*` and `λ_f`
directly (Bentham & Britter 2003; Britter & Hanna 2003 review). Cleaner physically than an
`H/W` exponential because `H/W` is not the parameter that actually controls canopy drag —
`λ_f` is.

**Option 3 — read the caveat first.** Before committing to *any* exponential:
- **Castro, I.P. (2017).** *Are Urban-Canopy Velocity Profiles Exponential?*
  Boundary-Layer Meteorology **164**(3): 337–351. DOI: 10.1007/s10546-017-0258-x
  (Citation verified.) The short answer in the literature is "only roughly, and not near the
  canopy floor". If your engine's `h_c` (item 4) is sensitive to the canyon wind — and it is,
  linearly — then know that the wind estimate is the weakest link in that chain, whatever
  formula you use.

### Sanity properties your current form does at least satisfy

`exp(−0.386·H/W)` gives `u_can/u_above` = 0.68 at `H/W = 1`, 0.46 at `H/W = 2`, 0.31 at
`H/W = 3`. Those are not unreasonable numbers — in-canyon wind speeds of 30–70% of the
above-roof value are typical of observations. So the model is unlikely to be badly wrong in
practice; the problem is purely that it is presented as sourced when it is not. That is a
credibility risk out of proportion to the physical error.

### Recommendation

Rename the constant to something like `CANYON_WIND_ATTENUATION` with a comment reading
"empirical; calibrated, not taken from a published relation — see docs/research", and open
an issue to migrate to the Macdonald (2000) `λ_f`-based attenuation coefficient. Do not
leave "Masson 2000" next to it.

---

## 4. Convective heat transfer coefficient

### Implemented

```
h_c = 5.7 + 3.8 * u        W m⁻² K⁻¹      (u in m/s)
```

### Verdict: **CORRECT as a transcription — but it is a COMBINED coefficient, and if you add
a separate longwave term you are double-counting.** This is the substantive issue.

### Source

The relation is the McAdams flat-plate correlation, usually cited as:

- **McAdams, W.H. (1954).** *Heat Transmission*, 3rd ed. McGraw-Hill, New York.
  The commonly quoted pair is
  ```
  h = 5.678 + 3.83 v      (often rounded to 5.7 + 3.8 v)    for v ≲ 5 m/s
  h = 7.2 · v^0.78                                          for v ≳ 5 m/s
  ```
  so **your valid wind range is roughly `0 ≤ u ≲ 5 m/s`**; above about 5 m/s the linear form
  over-predicts and the power law should take over. Also note the correlation was obtained
  for a *smooth vertical plate*; real façades, and especially rough or articulated ones, run
  higher.

- The essential modern reference — read this one before defending the choice:
  **Palyvos, J.A. (2008).** *A survey of wind convection coefficient correlations for
  building envelope energy systems' modeling.* Applied Thermal Engineering **28**(8–9):
  801–808. DOI: 10.1016/j.applthermaleng.2007.12.005 (Citation verified via Crossref.)
  Palyvos catalogues several dozen `h = a + b·v` correlations and documents the widespread
  confusion over which are convective-only and which are combined convective+radiative, and
  over whether `v` is the free-stream, local, or met-station wind speed.
  **[UNVERIFIED-SOURCE: paywalled; the specific caution about McAdams is reported from the
  literature rather than read this session.]**

### The double-counting problem — check your code for this

The `5.7` intercept is not a free-convection limit. At `u = 0` a smooth vertical surface in
air has a genuinely convective coefficient of roughly `1.5–3 W m⁻² K⁻¹`, not 5.7. The extra
`≈ 3–4 W m⁻² K⁻¹` is the **linearised radiative** coefficient — around a 290 K surface,
`h_r ≈ 4·ε·σ·T³ ≈ 4 × 0.9 × 5.67e-8 × 290³ ≈ 5.0 W m⁻² K⁻¹`. The `5.7` is a
**surface conductance**, i.e. convection *plus* radiation, which is exactly how ASHRAE
tabulates it (`h_o ≈ 34 W m⁻² K⁻¹` winter at 6.7 m/s, `≈ 22.7 W m⁻² K⁻¹` summer at 3.4 m/s
are combined film coefficients in the same tradition).

**Consequence for your engine:** if the surface energy balance computes
`Q_conv = h_c (T_s − T_a)` with `h_c = 5.7 + 3.8u` **and** a separate explicit longwave term
`ε σ (T_s⁴ − T_sky⁴)`, then the radiative loss is counted roughly twice at low wind speeds.
At `u = 1 m/s` the total `h_c` is 9.5, of which ~5 is really radiation — a **~50%
over-estimate of the turbulent flux**, which will damp the modelled diurnal surface
temperature swing and bias facet temperatures toward air temperature. This is the kind of
error that makes surface temperatures look plausible for the wrong reason.

**Fix — pick one, and be explicit:**

1. **Convective-only intercept.** Use a purely convective correlation and keep your explicit
   longwave term. A common choice for façades:
   `h_c ≈ 2.0 + 3.8u` (or a Palyvos-recommended correlation), keeping `ε σ (T_s⁴ − T_sky⁴)`
   separate. This is the right choice for a physics engine that resolves sky view factors,
   because you *want* the radiative term explicit — it is where your SVF work pays off.
2. **Combined coefficient, no separate LW.** Keep `5.7 + 3.8u` and delete the explicit
   longwave term. Cheaper, but throws away the SVF-dependence of longwave exchange, which is
   the entire point of items 1 and 2. **Not recommended here.**

Given that this engine computes sky view factors to model longwave trapping, option 1 is
clearly the right one. Verify which the code currently does — if both terms are present, this
is a live bug and it is larger in magnitude than the item 5 `λ_f` bug at low wind speeds.

### Also worth documenting

- Which wind speed is `u`? McAdams' `v` is the speed of the air flowing over the plate. If
  the code passes the **canyon** wind (item 3) that is roughly right; if it passes the
  above-roof or met-station wind, `h_c` is over-estimated by the ratio of the two (a factor
  of ~1.5–3 for typical aspect ratios). Given item 3 feeds item 4, an error in the canyon
  wind propagates linearly into the convective flux.
- The correlation has no orientation dependence (windward/leeward façades differ by a factor
  of ~2 in practice) and no buoyancy term (matters on a calm sunny afternoon when a sunlit
  wall drives its own free convection). Both are acceptable simplifications for a
  neighbourhood-scale engine; both should be in the docstring so nobody mistakes the number
  for a facade-resolved value.


---

## 6. Sky temperature — Berdahl & Martin clear-sky emissivity

### Implemented

```
eps_clear = 0.711 + 0.56*(Tdp/100) + 0.73*(Tdp/100)^2       Tdp in °C
T_sky     = T_air * eps_sky^0.25
eps_sky   = eps_clear + (1 - eps_clear) * C                  C = cloud fraction 0..1
```

### Verdict: **CORRECT (with caveats).** The clear-sky polynomial is the standard
Berdahl–Martin form and the coefficients match what is in circulation. Two caveats: you are
using the **abbreviated** version of their equation, and the cloud form is the crudest of the
several in use.

### Citations

- **Berdahl, P. & Martin, M. (1984).** *Emissivity of clear skies.* Solar Energy **32**(5):
  663–664. DOI: 10.1016/0038-092X(84)90144-0 (Citation verified via Crossref.)
  This is the correct primary citation for the dew-point polynomial.
- **Martin, M. & Berdahl, P. (1984).** *Characteristics of infrared sky radiation in the
  United States.* Solar Energy **33**(3): 321–336. DOI: 10.1016/0038-092X(84)90162-2
  (Citation verified.) The companion paper — this is the one with the full form including the
  diurnal and pressure corrections, and the US-wide measurement basis.
- **Berdahl, P. & Fromberg, R. (1982).** *The thermal radiance of clear skies.* Solar Energy
  **29**(4): 299–314. DOI: 10.1016/0038-092X(82)90245-6 (Citation verified.)

**[UNVERIFIED-SOURCE: all three are paywalled. The polynomial coefficients `0.711 / 0.56 /
0.73` are reported from the widely reproduced form of the equation, not read from the paper
this session. They match my recollection of the published values and are what appears
throughout the building-physics literature, but confirm against Solar Energy 32(5):663 before
publishing them.]**

### Caveat 1 — you have dropped the diurnal and altitude terms

The Berdahl–Martin clear-sky emissivity as published is fuller than the three-term
polynomial. The complete form adds a **diurnal** term and a **station-pressure/altitude**
term, along the lines of

```
eps_clear = 0.711 + 0.56*(Tdp/100) + 0.73*(Tdp/100)^2
          + 0.013 * cos( 2*pi*t/24 )                       t = hours from midnight
          + 0.00012 * ( P_station - 1000 )                 P in mbar/hPa
```

**[UNVERIFIED-SOURCE: coefficients of the two extra terms reported from the literature, not
read from the paper.]**

Magnitudes: the diurnal term is `±0.013` in emissivity, worth roughly `±1.5 K` in sky
temperature — small but systematic, and it peaks at exactly the times a UHI model cares
about. The pressure term matters for cities at altitude: Denver (`≈ 840 hPa`) picks up
`0.00012 × (−160) = −0.019` in emissivity, about `−2 K` in sky temperature and a few
W m⁻² in net longwave. For a sea-level, mid-latitude engine the three-term version is fine;
if the API is meant to work anywhere, add the pressure term — it is one line and removes a
real altitude bias.

### Caveat 2 — `T_sky = T_air * eps^0.25` is a definition, not an approximation

This is exact *by construction*: it defines `T_sky` as the blackbody temperature that would
produce the measured downwelling flux, `L↓ = eps_sky * sigma * T_air^4 = sigma * T_sky^4`.
Fine. Just be aware that `T_sky` so defined is a radiative bookkeeping temperature, not a
temperature anything physically has, and that the whole construction hinges on `T_air` being
the screen-level air temperature the emissivity correlation was fitted against — not, for
example, a canyon air temperature your own model has just modified. **If the engine feeds its
own modelled canyon air temperature into this, it is extrapolating the correlation outside
its fitting basis and will amplify its own UHI.** Feed it the above-roof / forcing air
temperature.

### Caveat 3 — the cloud form is the crudest one available

`eps_sky = eps_clear + (1 − eps_clear)·C` is the "clouds are black bodies at air
temperature, covering fraction C" assumption. It is defensible, widely used, and has two
known biases:

1. **Linear in `C`.** Observations support a **nonlinear** dependence. The Konzelmann et al.
   (1994) family, which performs well in validation studies, uses
   ```
   eps_all = eps_clear * (1 - N^p1) + eps_oc * N^p2
   ```
   with `p1, p2` around 4 in the original (`N^4`), and Pirazzini et al. (2001) use
   `L_all = L_clear * (1 + a*N^p)`. Your linear form therefore **over-estimates** downwelling
   longwave at intermediate cloud cover (`C ≈ 0.3–0.6`), which is the most common condition.
   Verified as the standard forms in: **Gubler, S., Gruber, S. & Purves, R.S. (2012).**
   *Uncertainties of parameterized near-surface downward longwave and clear-sky direct
   radiation.* Atmospheric Chemistry and Physics Discussions **12**: 3357–3400.
   DOI: 10.5194/acpd-12-3357-2012 —
   https://acp.copernicus.org/preprints/12/3357/2012/acpd-12-3357-2012.pdf
   (their Eqs. 7–9; **read and verified this session**). Gubler et al. also find that among
   clear-sky parameterizations, Brutsaert (1975), Konzelmann et al. (1994) and
   Dilley & O'Brien (1997) are the best-behaving, with RMSE 6–12 W m⁻²; Berdahl–Martin is not
   among the ones they test, so you cannot claim a validated RMSE for it from that source.
2. **Cloud base temperature = air temperature.** True enough for low stratus, badly wrong for
   high cirrus, which is optically thin and much colder. Martin & Berdahl's own treatment
   scales the cloud contribution by a factor for cloud-base height/temperature. Under thin
   high cloud your form will over-predict `L↓` by tens of W m⁻², suppressing modelled
   nocturnal cooling.

If cloud cover is an input your users actually vary, upgrade to a `N^p` form. If it is
usually 0 or unknown, leave it and document the bias.

### Swinbank, for comparison (as requested)

- **Swinbank, W.C. (1963).** *Long-wave radiation from clear skies.* Quarterly Journal of the
  Royal Meteorological Society **89**(381): 339–348. DOI: 10.1002/qj.49708938105
  (Citation verified via Crossref. Note there is also a 1964 note, QJRMS 90:488–493.)

Swinbank's relation depends on **air temperature alone**, with no humidity input:

```
eps_clear = 9.365e-6 * T_a^2            T_a in K
```
equivalently
```
L_down = 5.31e-13 * T_a^6              W m^-2
```

**[UNVERIFIED-SOURCE: coefficients from the standard reproduction of Swinbank's relation.]**

**Which to prefer, and why it matters for an urban engine:** Swinbank is simpler but has no
humidity dependence, and humidity is precisely what varies between a dry desert city and a
humid coastal one at the same air temperature. Two cities at 30 °C with dew points of 5 °C
and 25 °C have Berdahl–Martin emissivities of about 0.74 and 0.89 — a difference of roughly
`0.15` in emissivity, `≈ 35 W m⁻²` in `L↓`, and `≈ 12 K` in apparent sky temperature.
Swinbank gives them the same sky. Since nocturnal canyon cooling — and therefore the whole
SVF-dependent UHI signal that items 1, 2 and 9 exist to capture — is driven by that net
longwave loss, **Berdahl–Martin (humidity-dependent) is clearly the right choice here** and
Swinbank should be used only as a fallback when dew point is unavailable. Keep Swinbank in the
code as a documented fallback, not as an option of equal standing.

---

## 7. Monin–Obukhov similarity profile

### Implemented

```
T(z)     = T_ref + (theta*/kappa) * [ ln((z-d)/(z_ref-d)) - psi_h(zeta_z) + psi_h(zeta_ref) ]
theta*   = -H / (rho * cp * u*)
L        = u*^2 * T / (kappa * g * theta*)
psi_h    = 2*ln((1+x^2)/2),  x = (1-16*zeta)^0.25        (unstable, zeta < 0)
psi_h    = -5*zeta                                        (stable, zeta > 0)
```

### Verdict: **CORRECT.** The sign conventions are self-consistent and your `theta*` sign
convention is right. But see the important cross-check with item 8 at the end of this
section — I think there is a missing potential-temperature conversion downstream.

### Signs — verified by derivation

**`theta*` convention.** With `theta* = -H/(rho cp u*)`, daytime upward sensible heat flux
`H > 0` gives `theta* < 0`. Substituting into the profile: for `z > z_ref` the logarithm is
positive, so `(theta*/kappa)·ln(...) < 0` and temperature **decreases** with height. Correct
for daytime heating. At night `H < 0`, `theta* > 0`, temperature increases with height —
a nocturnal inversion. Correct. **Your convention is right.**

This is the convention `theta* = -(w'theta')_0 / u*`, which is the more common one in the
micrometeorological literature; the opposite sign convention also exists in print, paired
with a compensating minus sign in the profile equation. Both are fine as long as they are not
mixed. Add a comment naming the convention, because this is the single most common source of
sign bugs in MOST implementations and it is silent — the profile just tilts the wrong way.

**`L` consistency.** The standard definition is
```
L = -u*^3 * T / ( kappa * g * (w'theta')_0 )
```
With `(w'theta')_0 = -u* theta*`, this becomes `L = u*^2 T / (kappa g theta*)`. **Exactly your
expression.** ✓ And the signs work: daytime `theta* < 0` gives `L < 0` (unstable); nocturnal
`theta* > 0` gives `L > 0` (stable). ✓ Strictly `T` should be a layer-mean **virtual**
potential temperature `theta_v`; using `T` in kelvin is standard practice and introduces an
error of order the humidity contribution (< 1% in `L` for typical conditions) — acceptable,
worth a comment.

### psi_h forms — verified

**Unstable (Businger–Dyer, in Paulson's integrated form):**
```
psi_h(zeta) = 2 ln( (1 + x^2) / 2 ),      x = (1 - 16 zeta)^{1/4}
```
Since `x^2 = (1 - 16 zeta)^{1/2}`, this is equivalently
`psi_h = 2 ln( (1 + sqrt(1 - 16 zeta)) / 2 )`. **This is the standard form.** ✓
It integrates `phi_h = (1 - 16 zeta)^{-1/2}`, which is the **Dyer (1974)** version of the
Businger–Dyer relations. Checks: `zeta = 0` gives `x = 1`, `psi_h = 2 ln 1 = 0`. ✓
`psi_h > 0` for `zeta < 0`, which correctly *reduces* the temperature difference relative to
the neutral log law under convective conditions. ✓

- **Paulson, C.A. (1970).** *The Mathematical Representation of Wind Speed and Temperature
  Profiles in the Unstable Atmospheric Surface Layer.* Journal of Applied Meteorology
  **9**(6): 857–861. DOI: 10.1175/1520-0450(1970)009<0857:TMROWS>2.0.CO;2
  (Citation verified via Crossref.) — the integrated `psi` functions.
- **Dyer, A.J. (1974).** *A review of flux-profile relationships.* Boundary-Layer Meteorology
  **7**(3): 363–372. DOI: 10.1007/BF00240838 (Citation verified.) — `phi_h = (1-16ζ)^{-1/2}`,
  `phi_m = (1-16ζ)^{-1/4}`, and `phi_h = phi_m^2`, i.e. `Pr_t = 1` at neutral.
- **Businger, J.A., Wyngaard, J.C., Izumi, Y. & Bradley, E.F. (1971).** *Flux-Profile
  Relationships in the Atmospheric Surface Layer.* Journal of the Atmospheric Sciences
  **28**(2): 181–189. DOI: 10.1175/1520-0469(1971)028<0181:FPRITA>2.0.CO;2
  (Citation verified.)

**Note on which paper to cite for the coefficient 16.** Businger et al. (1971) as published
gives `phi_h = 0.74 (1 - 9 zeta)^{-1/2}` unstable and `phi_h = 0.74 + 4.7 zeta` stable,
**with `kappa = 0.35`**. Dyer (1974) gives the `(1 - 16 zeta)^{-1/2}` form with `kappa = 0.40`
and `phi_h(0) = 1`. **You are using the Dyer/Paulson set, so cite Dyer (1974) and
Paulson (1970), and use `kappa = 0.40`** — not Businger et al. (1971), whose coefficients are
tied to `kappa = 0.35` and a neutral turbulent Prandtl number of 0.74. Mixing the Businger
`0.74`/`4.7` coefficients with `kappa = 0.4` is a common and quietly significant error. Check
that your `kappa` is 0.40 everywhere (it should be, to be consistent with item 5's Macdonald
formulation, which also uses 0.40).

**Stable:**
```
psi_h(zeta) = -5 zeta
```
✓ Correct — this integrates `phi_h = 1 + 5 zeta` (Dyer's stable form). Two things to guard:

1. **Validity limit.** This linear form is only valid for roughly `0 < zeta < 1`. Beyond
   that (very stable, light-wind nights — exactly the conditions of maximum UHI, item 9) it
   over-predicts the temperature difference without bound and the profile becomes unphysical.
   Either clamp `zeta ≤ 1`, or switch to a form that saturates, e.g. Holtslag & De Bruin
   (1988) or Beljaars & Holtslag (1991). **This matters here**: the nocturnal, near-calm,
   strongly stable case is the one your UHI predictions live or die on.
2. **`u* → 0`.** `theta*` and `L` both blow up as `u* → 0`. Calm nights need a floor on `u*`
   (a common choice is `u*_min ≈ 0.05–0.1 m/s`) or the profile will produce absurd gradients.
   Check that this guard exists.

### Cross-check that flags a probable downstream bug

**MOST profiles are in POTENTIAL temperature, not temperature.** Your equation is written
`T(z) = T_ref + ...`, and if the code really does treat the output as air temperature, then
the dry-adiabatic conversion is missing:

```
T(z) = theta(z) - Gamma_d * z ,        Gamma_d = g/cp = 0.0098 K/m = 0.98 K per 100 m
```

Over the shallow depths inside a canyon (say 0–20 m) that is a 0.2 K error and nobody
notices. Over 100 m it is **0.98 K**, which is larger than most of the effects this engine is
trying to resolve.

I believe this is exactly what is happening, because it quantitatively explains the number in
item 8. Worked example with plausible summer-afternoon values —
`H = 200 W m⁻²`, `u* = 0.5 m/s`, `rho·cp = 1200 J m⁻³ K⁻¹`, `T = 300 K`, `kappa = 0.4`:

```
theta* = -200 / (1200 * 0.5)                 = -0.333 K
L      = 0.25 * 300 / (0.4 * 9.81 * -0.333)  = -57 m
zeta(100 m) = -1.75  ->  psi_h = 2.32
zeta(10 m)  = -0.175 ->  psi_h = 0.78
d(theta) over 10 -> 100 m
       = (-0.333/0.4) * [ ln(10) - 2.32 + 0.78 ]
       = -0.833 * 0.76  =  -0.63 K
    => d(theta)/dz ~ -0.70 K per 100 m
    => d(T)/dz     ~ -0.70 - 0.98 = -1.68 K per 100 m
```

**Your reported daytime gradient of −0.6 K per 100 m matches the POTENTIAL temperature
gradient almost exactly, and is missing the −0.98 K per 100 m adiabatic term.** See item 8 —
this is the single most likely explanation for that number, and it is a one-line fix.


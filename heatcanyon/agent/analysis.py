"""Spatial statistics and optimisation, in NumPy, over the solved model.

WHY THESE AND NOT A CORRELATION COEFFICIENT

"Find interesting geographical patterns" is the request that separates an
analyst from a reporter, and it is the one most easily faked. A model that
computes Pearson's r between exposure and building age and writes a paragraph
about it has said almost nothing: it has not established that the pattern is
spatial at all, it has not located it, and it has not ruled out the possibility
that the association is entirely explained by a third variable that happens to be
spatially clustered.

So the tools here are the ones a spatial analyst would actually reach for:

  moran        Global Moran's I with a permutation test. Answers "is this field
               spatially clustered at all, or does it just look that way".
  hotspots     Getis-Ord Gi*, which locates clusters and distinguishes hot from
               cold. Reported with a Benjamini-Hochberg correction, because
               testing four thousand locations at p<0.05 finds two hundred
               "significant" clusters in pure noise.
  regress      OLS with heteroskedasticity-consistent standard errors, variance
               inflation factors, and the residuals returned so the agent can go
               looking at what the model failed to explain — which is usually
               where the finding is.
  cluster      k-means on standardised morphology, to find canyon TYPES rather
               than assuming the four the interface happens to name.
  correlate    A correlation matrix with n and p for every pair, as a screen
               before any of the above.
  allocate     Greedy marginal-benefit allocation under a budget: given money for
               N buildings or M street-kilometres, where does it go.

EVERY ONE OF THESE RETURNS ITS ASSUMPTIONS. Moran's I returns the weights
definition and the number of permutations; the regression returns its VIFs and
its R-squared; the allocation returns what it optimised and what it ignored. A
statistic without its assumptions is an assertion.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Sequence

import numpy as np

from .dataset import Dataset

#: Distance band for the spatial weights, metres. Midtown's block is about 80 m
#: by 275 m, so 150 m is the scale at which "neighbouring buildings" means the
#: same block and the ones across the street, and not the whole district.
DEFAULT_BAND_M = 150.0


# ------------------------------------------------------------------ variables


def variable_table(d: Dataset) -> dict:
    """Every per-building variable available to the statistics, with its kind.

    Assembled here rather than hard-coded into each function so that adding a
    field to the pipeline makes it available to Moran's I, the regression and the
    clustering at once.
    """
    return {
        # measured / administrative
        "exceedance_h": ("measured", lambda b: b["measured"]["exceedance_h"]),
        "persistence_h": ("measured", lambda b: b["measured"]["persistence_h"]),
        "peak_air_c": ("measured", lambda b: b["measured"]["peak_air_c"]),
        "svf": ("measured geometry", lambda b: b["measured"]["svf"]),
        "height_m": ("measured", lambda b: b.get("h") or 0.0),
        "floors": ("administrative", lambda b: b.get("floors") or 0),
        "year_built": ("administrative", lambda b: b.get("year") or 0),
        "units_res": ("administrative", lambda b: b.get("units") or 0),
        "hvi": ("composite index", lambda b: b.get("hvi") or 0),
        # modelled, event day
        "facade_peak_c": ("modelled", lambda b: b["modelled"]["facade_peak_c"]),
        "facade_spread_k": ("modelled", lambda b: b["modelled"]["facade_spread_k"]),
        "mrt_peak_c": ("modelled", lambda b: b["modelled"]["mrt_peak_c"]),
        "wbgt_peak_c": ("modelled", lambda b: b["modelled"]["wbgt_peak_c"]),
        # scores
        "exposure": ("derived score", lambda b: b["exposure"]),
        "vulnerability": ("derived score", lambda b: b["vulnerability"]),
        "priority": ("derived score", lambda b: b["priority"]),
        # modelled, annual
        "annual_kh35": ("modelled, annual", lambda b: (b.get("annual") or {}).get("facade_kh35", 0.0)),
        "annual_sun_hours": ("modelled, annual", lambda b: (b.get("annual") or {}).get("sun_hours", 0.0)),
        "annual_dose_kwh": ("modelled, annual", lambda b: (b.get("annual") or {}).get("dose_kwh", 0.0)),
        "annual_dose": ("modelled, annual", lambda b: (b.get("annual") or {}).get("dose_kwh", 0.0)),
        "annual_facade_max_c": ("modelled, annual", lambda b: (b.get("annual") or {}).get("facade_max_c", 0.0)),
        "annual_swing_k": ("modelled, annual", lambda b: (b.get("annual") or {}).get("swing_k", 0.0)),
        "annual_summer_mean_c": ("modelled, annual", lambda b: (b.get("annual") or {}).get("summer_mean_c", 0.0)),
        "annual_winter_mean_c": ("modelled, annual", lambda b: (b.get("annual") or {}).get("winter_mean_c", 0.0)),
        "annual_month_of_peak": ("modelled, annual", lambda b: (b.get("annual") or {}).get("month_of_peak", 0)),
        "annual_exposure": ("derived score, annual", lambda b: (b.get("annual") or {}).get("exposure", 0.0)),
        "annual_priority": ("derived score, annual", lambda b: (b.get("annual") or {}).get("priority", 0.0)),
    }


def _matrix(d: Dataset, names: Sequence[str],
            scope: str = "ranked") -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """(values (n, k), xy (n, 2), rows) for the requested variables.

    ``scope`` is ``ranked`` (the top 150 with full dossiers) or ``scored`` (all
    4,044, using the compact attribute records). The distinction matters for a
    spatial statistic: the ranked set is a SELECTED sample — the top of a
    priority ordering — and a Moran's I over a selected sample measures the
    clustering of the selection as much as of the field. ``scored`` is the honest
    scope for anything spatial, and it is the default for exactly that reason.
    """
    table = variable_table(d)
    missing = [n for n in names if n not in table]
    if missing:
        raise KeyError(f"unknown variables {missing}; have {sorted(table)}")

    if scope == "ranked":
        rows = d.ranked["items"]
        xy = np.array([d.to_xy(b["lon"], b["lat"]) for b in rows], dtype=np.float64)
        vals = np.array([[float(table[n][1](b)) for n in names] for b in rows],
                        dtype=np.float64)
        return vals, xy, rows

    rows = [a for a in d.attrs if a.get("in_aoi") and a.get("pr") is not None]
    xy = np.array([d.to_xy(a["lon"], a["lat"]) for a in rows], dtype=np.float64)
    compact = {
        "exposure": "ex", "vulnerability": "vu", "priority": "pr",
        "annual_exposure": "aex", "annual_priority": "apr",
        "annual_month_of_peak": "mop", "annual_swing_k": "swing",
        "annual_sun_hours": "sunh", "height_m": "h", "floors": "floors",
        "year_built": "year", "units_res": "units",
        # The two headline annual quantities. A live turn tried Moran's I on
        # `annual_kh35` over the scored population twice, was refused twice
        # because the compact record did not carry it, and gave up on the
        # statistic — so the compact record carries it.
        "annual_kh35": "akh", "annual_dose_kwh": "adose",
    }
    unavailable = [n for n in names if n not in compact]
    if unavailable:
        raise KeyError(
            f"{unavailable} are only carried on the ranked 150, not on all "
            f"{len(rows)} scored buildings. Use scope='ranked' for those, or one "
            f"of {sorted(compact)} for the full set.")
    vals = np.array([[float(a.get(compact[n]) or 0.0) for n in names] for a in rows],
                    dtype=np.float64)
    return vals, xy, rows


# --------------------------------------------------------------------- weights


def _weights(xy: np.ndarray, band_m: float) -> tuple[np.ndarray, dict]:
    """Row-standardised binary distance-band weights, with the islands reported.

    Binary within a distance band rather than inverse distance or k-nearest,
    because on a street grid a fixed band has a meaning anybody can check —
    "buildings within 150 m" — and k-nearest silently changes the definition of
    neighbour between the dense core and the edge of the AOI.

    Row standardisation makes I comparable across rows with different numbers of
    neighbours. Buildings with no neighbour in the band are ISLANDS: they
    contribute nothing to I and their count is returned, because an I computed
    over a set that is a third islands is not describing the same thing as one
    computed over a connected set.
    """
    n = len(xy)
    d2 = ((xy[:, None, :] - xy[None, :, :]) ** 2).sum(axis=2)
    w = (d2 <= band_m * band_m).astype(np.float64)
    np.fill_diagonal(w, 0.0)
    deg = w.sum(axis=1)
    islands = int((deg == 0).sum())
    with np.errstate(invalid="ignore", divide="ignore"):
        w = np.where(deg[:, None] > 0, w / np.maximum(deg[:, None], 1.0), 0.0)
    return w, {
        "definition": f"binary, distance band {band_m:g} m, row standardised",
        "n": n, "islands": islands,
        "mean_neighbours": round(float(deg.mean()), 2),
        "max_neighbours": int(deg.max()) if n else 0,
        "island_note": ("Islands have no neighbour inside the band and contribute "
                        "nothing to the statistic." if islands else
                        "Every observation has at least one neighbour."),
    }


# -------------------------------------------------------------- Moran's I


def moran(d: Dataset, variable: str, *, band_m: float = DEFAULT_BAND_M,
          scope: str = "scored", permutations: int = 999,
          seed: int = 20260702) -> dict:
    """Global Moran's I with a permutation test.

    The permutation test rather than the normal approximation: the analytic
    variance of I assumes a normally distributed variable, and almost nothing
    here is — exposure scores are bounded, unit counts are heavily skewed, and
    month-of-peak is categorical dressed as a number. Reshuffling the values over
    the fixed geography makes no distributional assumption at all.
    """
    vals, xy, _rows = _matrix(d, [variable], scope)
    z = vals[:, 0]
    ok = np.isfinite(z)
    z, xy = z[ok], xy[ok]
    w, wmeta = _weights(xy, band_m)

    def I_of(v: np.ndarray) -> float:
        dv = v - v.mean()
        num = float(dv @ (w @ dv))
        den = float((dv * dv).sum())
        return (len(v) / w.sum()) * num / den if den > 0 and w.sum() > 0 else float("nan")

    obs = I_of(z)
    rng = np.random.default_rng(seed)
    null = np.array([I_of(rng.permutation(z)) for _ in range(int(permutations))])
    # Two-sided pseudo p-value, the (r+1)/(m+1) form so it can never be zero.
    more = int((np.abs(null - null.mean()) >= abs(obs - null.mean())).sum())
    p = (more + 1) / (int(permutations) + 1)

    return {
        "statistic": "Global Moran's I",
        "variable": variable,
        "scope": scope,
        "I": round(obs, 4),
        "expected_I": round(-1.0 / (len(z) - 1), 4),
        "permutations": int(permutations),
        "null_mean": round(float(null.mean()), 4),
        "null_sd": round(float(null.std()), 4),
        "z_score": round(float((obs - null.mean()) / max(null.std(), 1e-12)), 3),
        "p_value": round(p, 5),
        "weights": wmeta,
        "interpretation": (
            f"I = {obs:.3f} against an expectation of {-1.0/(len(z)-1):.3f} under no "
            f"spatial structure. " + (
                "Positive and significant: like values cluster together."
                if obs > 0 and p < 0.05 else
                "Negative and significant: neighbouring values are unlike each other, "
                "a checkerboard rather than a cluster."
                if obs < 0 and p < 0.05 else
                "Not distinguishable from spatial randomness at this band, so any "
                "pattern the eye finds in a map of this variable is not supported by "
                "this test.")
        ),
    }


# ----------------------------------------------------------- Getis-Ord Gi*


def hotspots(d: Dataset, variable: str, *, band_m: float = DEFAULT_BAND_M,
             scope: str = "scored", fdr: float = 0.05,
             top: int = 25) -> dict:
    """Getis-Ord Gi* clusters, with a Benjamini-Hochberg false-discovery control.

    Gi* rather than Moran's local I because it distinguishes hot clusters from
    cold ones, which is the actionable distinction — a planner wants to know
    where the hot clusters are, not merely that clustering exists.

    The FDR correction is not optional. Testing four thousand locations at
    p < 0.05 yields about two hundred "significant" clusters from pure noise,
    which is roughly the number an uncorrected Gi* map of anything will show.
    """
    vals, xy, rows = _matrix(d, [variable], scope)
    z = vals[:, 0]
    ok = np.isfinite(z)
    z, xy = z[ok], xy[ok]
    rows = [r for r, k in zip(rows, ok) if k]
    n = len(z)

    d2 = ((xy[:, None, :] - xy[None, :, :]) ** 2).sum(axis=2)
    # Gi* INCLUDES the focal observation — that is the star — so the diagonal
    # stays in the weight matrix. Using Gi (excluding self) here would report a
    # hot building sitting alone as cold, which is the classic misuse.
    w = (d2 <= band_m * band_m).astype(np.float64)

    xbar = z.mean()
    s = math.sqrt(max((z * z).mean() - xbar * xbar, 1e-30))
    wsum = w.sum(axis=1)
    w2sum = (w * w).sum(axis=1)
    num = w @ z - xbar * wsum
    den = s * np.sqrt(np.maximum((n * w2sum - wsum ** 2) / (n - 1), 1e-30))
    gi = num / den

    # Two-sided normal p, then Benjamini-Hochberg.
    p = 2.0 * (1.0 - _norm_cdf(np.abs(gi)))
    order = np.argsort(p)
    m = len(p)
    thresh = fdr * (np.arange(1, m + 1) / m)
    passed = p[order] <= thresh
    cut = int(np.max(np.where(passed)[0]) + 1) if passed.any() else 0
    sig = np.zeros(m, dtype=bool)
    sig[order[:cut]] = True
    crit = float(p[order][cut - 1]) if cut else 0.0

    def describe(i: int) -> dict:
        r = rows[i]
        return {
            "bin": r.get("bin"),
            "address": r.get("addr") or r.get("address"),
            "lon": r.get("lon"), "lat": r.get("lat"),
            "value": round(float(z[i]), 3),
            "gi_star": round(float(gi[i]), 3),
            "p_value": round(float(p[i]), 6),
            "significant_after_fdr": bool(sig[i]),
            "neighbours_in_band": int(w[i].sum()),
        }

    hot = [i for i in np.argsort(-gi) if sig[i]][:int(top)]
    cold = [i for i in np.argsort(gi) if sig[i]][:int(top)]
    return {
        "statistic": "Getis-Ord Gi* (self included)",
        "variable": variable, "scope": scope, "n": n,
        "band_m": band_m,
        "fdr": fdr,
        "critical_p_after_bh": round(crit, 6),
        "significant_locations": int(sig.sum()),
        "hot_clusters": [describe(int(i)) for i in hot],
        "cold_clusters": [describe(int(i)) for i in cold],
        "uncorrected_at_p05": int((p <= 0.05).sum()),
        "note": (
            f"{int((p <= 0.05).sum())} locations reach p < 0.05 uncorrected and "
            f"{int(sig.sum())} survive Benjamini-Hochberg at q = {fdr}. Report the "
            f"corrected count: with {n} tests the uncorrected one includes roughly "
            f"{0.05*n:.0f} false positives by construction."
        ),
    }


def _norm_cdf(x: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + np.vectorize(math.erf)(np.asarray(x) / math.sqrt(2.0)))


# ------------------------------------------------------------------ regression


def regress(d: Dataset, y: str, x: Sequence[str], *, scope: str = "ranked",
            robust: bool = True, top_residuals: int = 10) -> dict:
    """OLS with HC1 standard errors, VIFs, and the extreme residuals named.

    Robust standard errors by default because the residual variance in every
    relationship here grows with the fitted value — a tall sunlit tower's
    exposure is both larger and more variable than a shaded walk-up's — and
    classical standard errors under those conditions are too small, which turns
    into confident claims about weak effects.

    The extreme residuals are returned by name. They are the useful output: the
    buildings the morphology does NOT explain are where a finding lives, and a
    regression that only reports coefficients throws them away.
    """
    names = list(x)
    vals, xy, rows = _matrix(d, [y] + names, scope)
    ok = np.isfinite(vals).all(axis=1)
    vals, rows = vals[ok], [r for r, k in zip(rows, ok) if k]
    yv = vals[:, 0]
    X = np.column_stack([np.ones(len(vals)), vals[:, 1:]])
    n, k = X.shape
    if n <= k + 1:
        return {"error": f"only {n} complete observations for {k} parameters"}

    XtX_inv = np.linalg.pinv(X.T @ X)
    beta = XtX_inv @ X.T @ yv
    fitted = X @ beta
    resid = yv - fitted
    ss_res = float((resid ** 2).sum())
    ss_tot = float(((yv - yv.mean()) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    adj = 1.0 - (1.0 - r2) * (n - 1) / (n - k) if n > k else float("nan")

    if robust:
        # HC1: the small-sample-corrected White estimator.
        meat = (X * (resid ** 2)[:, None]).T @ X
        cov = XtX_inv @ meat @ XtX_inv * (n / (n - k))
        se_kind = "HC1 heteroskedasticity-consistent"
    else:
        cov = XtX_inv * (ss_res / (n - k))
        se_kind = "classical"
    se = np.sqrt(np.clip(np.diag(cov), 0, None))
    with np.errstate(divide="ignore", invalid="ignore"):
        t = beta / np.where(se > 0, se, np.nan)
    p = 2.0 * (1.0 - _norm_cdf(np.abs(t)))

    # VIF per predictor: regress each on the others.
    vifs = {}
    for j, nm in enumerate(names, start=1):
        others = np.column_stack([X[:, 0]] + [X[:, m] for m in range(1, k) if m != j])
        b = np.linalg.pinv(others.T @ others) @ others.T @ X[:, j]
        rj = X[:, j] - others @ b
        sst = float(((X[:, j] - X[:, j].mean()) ** 2).sum())
        r2j = 1.0 - float((rj ** 2).sum()) / sst if sst > 0 else 0.0
        vifs[nm] = round(1.0 / max(1.0 - r2j, 1e-9), 2)

    order = np.argsort(-np.abs(resid))[:int(top_residuals)]
    table = variable_table(d)

    return {
        "model": f"{y} ~ " + " + ".join(names),
        "scope": scope, "n": n,
        "r_squared": round(r2, 4), "adjusted_r_squared": round(adj, 4),
        "residual_sd": round(float(resid.std(ddof=k)), 4),
        "standard_errors": se_kind,
        "coefficients": [
            {"term": nm, "estimate": round(float(beta[i]), 5),
             "std_error": round(float(se[i]), 5),
             "t": round(float(t[i]), 3), "p_value": round(float(p[i]), 5),
             "ci95": [round(float(beta[i] - 1.96 * se[i]), 5),
                      round(float(beta[i] + 1.96 * se[i]), 5)],
             "vif": vifs.get(nm), "kind": (table.get(nm) or ("intercept",))[0]}
            for i, nm in enumerate(["(intercept)"] + names)],
        "extreme_residuals": [
            {"bin": rows[int(i)].get("bin"),
             "address": rows[int(i)].get("addr") or rows[int(i)].get("address"),
             "observed": round(float(yv[int(i)]), 3),
             "fitted": round(float(fitted[int(i)]), 3),
             "residual": round(float(resid[int(i)]), 3)}
            for i in order],
        "cautions": [
            "Coefficients are associations within this AOI, not causal effects.",
            f"Highest VIF is {max(vifs.values()) if vifs else 0}; above about 5 the "
            f"individual coefficients are not separately identified even when the "
            f"fit is good.",
            "Nothing here accounts for spatial autocorrelation in the residuals — "
            "run moran() on the residuals before treating a p-value as evidence.",
        ],
    }


# ------------------------------------------------------------------ clustering


def cluster(d: Dataset, variables: Sequence[str], k: int = 5, *,
            scope: str = "ranked", seed: int = 20260702,
            iterations: int = 60) -> dict:
    """k-means on standardised variables — canyon and building TYPES, found.

    Standardised first, because k-means minimises Euclidean distance and an
    unstandardised mix of "height in metres" and "sky view factor 0 to 1" is
    entirely a clustering of height. k-means++ seeding and the best of ten
    restarts, since a single random start on a skewed cloud reliably finds a
    local optimum with one enormous cluster.
    """
    names = list(variables)
    vals, xy, rows = _matrix(d, names, scope)
    ok = np.isfinite(vals).all(axis=1)
    vals, rows = vals[ok], [r for r, m in zip(rows, ok) if m]
    mu, sd = vals.mean(axis=0), vals.std(axis=0)
    Z = (vals - mu) / np.where(sd > 0, sd, 1.0)
    k = max(2, min(int(k), 12))

    best, best_inertia = None, float("inf")
    rng = np.random.default_rng(seed)
    for _ in range(10):
        centres = _kmeanspp(Z, k, rng)
        labels = np.zeros(len(Z), dtype=int)
        for _it in range(int(iterations)):
            dist = ((Z[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
            new = dist.argmin(axis=1)
            if (new == labels).all() and _it:
                break
            labels = new
            for c in range(k):
                m = labels == c
                if m.any():
                    centres[c] = Z[m].mean(axis=0)
        inertia = float(((Z - centres[labels]) ** 2).sum())
        if inertia < best_inertia:
            best, best_inertia = (labels.copy(), centres.copy()), inertia
    labels, centres = best

    out = []
    for c in range(k):
        m = labels == c
        if not m.any():
            continue
        out.append({
            "cluster": c, "n": int(m.sum()),
            "share": round(float(m.mean()), 3),
            "centre": {nm: round(float(centres[c, j] * sd[j] + mu[j]), 3)
                       for j, nm in enumerate(names)},
            "centre_standardised": {nm: round(float(centres[c, j]), 3)
                                    for j, nm in enumerate(names)},
            "examples": [
                {"bin": rows[int(i)].get("bin"),
                 "address": rows[int(i)].get("addr") or rows[int(i)].get("address")}
                for i in np.where(m)[0][:5]],
        })
    out.sort(key=lambda r: -r["n"])
    return {
        "method": "k-means on z-standardised variables, best of 10 k-means++ starts",
        "variables": names, "k": k, "n": int(len(Z)),
        "inertia": round(best_inertia, 2),
        "clusters": out,
        "caution": ("k-means always returns k clusters, including when the data has "
                    "no cluster structure. Compare the inertia across two or three "
                    "values of k before treating these as types."),
    }


def _kmeanspp(Z: np.ndarray, k: int, rng) -> np.ndarray:
    centres = [Z[rng.integers(len(Z))]]
    for _ in range(k - 1):
        d2 = np.min(((Z[:, None, :] - np.array(centres)[None, :, :]) ** 2).sum(axis=2),
                    axis=1)
        total = d2.sum()
        probs = d2 / total if total > 0 else np.full(len(Z), 1.0 / len(Z))
        centres.append(Z[rng.choice(len(Z), p=probs)])
    return np.array(centres, dtype=np.float64)


# ---------------------------------------------------------------- correlation


def correlate(d: Dataset, variables: Sequence[str], *,
              scope: str = "ranked", method: str = "spearman") -> dict:
    """A correlation matrix with n and p for every pair. A screen, not a finding.

    Spearman by default: almost every variable here is skewed or bounded, and
    Pearson on a skewed pair reports the influence of its tail.
    """
    names = list(variables)
    vals, xy, rows = _matrix(d, names, scope)
    ok = np.isfinite(vals).all(axis=1)
    vals = vals[ok]
    n = len(vals)
    if method == "spearman":
        vals = np.apply_along_axis(_rank, 0, vals)
    Z = (vals - vals.mean(axis=0)) / np.where(vals.std(axis=0) > 0,
                                              vals.std(axis=0), 1.0)
    R = (Z.T @ Z) / n
    pairs = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            r = float(R[i, j])
            t = r * math.sqrt(max(n - 2, 1) / max(1 - r * r, 1e-12))
            pairs.append({"a": names[i], "b": names[j], "r": round(r, 4),
                          "p_value": round(float(2 * (1 - _norm_cdf(abs(t)))), 5)})
    pairs.sort(key=lambda p: -abs(p["r"]))
    return {
        "method": method, "scope": scope, "n": n,
        "matrix": {names[i]: {names[j]: round(float(R[i, j]), 4)
                              for j in range(len(names))} for i in range(len(names))},
        "pairs_by_strength": pairs,
        "caution": ("A correlation here is a screen. Nothing in this matrix "
                    "accounts for a third variable, and every one of these "
                    "quantities is spatially clustered, so pairs of them will "
                    "correlate through geography alone."),
    }


def _rank(v: np.ndarray) -> np.ndarray:
    order = np.argsort(v, kind="stable")
    r = np.empty(len(v), dtype=np.float64)
    r[order] = np.arange(len(v), dtype=np.float64)
    # Average ties, so a variable with many equal values (HVI quintiles, floor
    # counts) is not ranked by its input order.
    uniq, inv, counts = np.unique(v, return_inverse=True, return_counts=True)
    if (counts > 1).any():
        sums = np.zeros(len(uniq)); np.add.at(sums, inv, r)
        r = (sums / counts)[inv]
    return r


# ---------------------------------------------------------------- allocation


def allocate(d: Dataset, *, budget: int = 20, objective: str = "person_hours",
             candidates: str = "ranked", per_unit_effect_k: float = 3.0,
             constraint: dict | None = None) -> dict:
    """Where a fixed budget of interventions goes, by marginal benefit.

    Greedy on the marginal objective. Greedy is chosen deliberately over anything
    cleverer: the objective here is additive across buildings — treating one
    building does not change another building's residents — so greedy is exactly
    optimal for a cardinality constraint, and saying "we used a heuristic" when
    the problem is a matroid would be a needless hedge.

    ``objective``:
      person_hours   residents times facade degree-hours avoided. The default,
                     because it is the quantity public-health guidance is written
                     against and it correctly refuses to spend on an empty tower.
      degree_hours   facade K.h avoided, ignoring who lives there. Useful as a
                     contrast: run both and the difference IS the equity story.
      vulnerable     person-hours weighted by the Heat Vulnerability Index.
      peak_relief    reduction in event-day peak facade temperature. The acute
                     objective rather than the chronic one.

    ``per_unit_effect_k`` is the assumed facade-temperature reduction the measure
    delivers, in kelvin, and it is an INPUT rather than a result: this function
    allocates, it does not predict. For a real predicted effect at a real place,
    call ``interventions.run`` and feed its answer back in here.
    """
    rows = d.ranked["items"] if candidates == "ranked" else d.ranked["items"]
    constraint = constraint or {}

    def eligible(b: dict) -> bool:
        if constraint.get("residential_only") and not (b.get("units") or 0) > 0:
            return False
        if constraint.get("min_hvi") and (b.get("hvi") or 0) < constraint["min_hvi"]:
            return False
        if constraint.get("built_before") and not (
                b.get("year") and b["year"] < constraint["built_before"]):
            return False
        if constraint.get("zip") and str(b.get("zip") or "") != str(constraint["zip"]):
            return False
        return True

    pool = [b for b in rows if eligible(b)]

    def benefit(b: dict) -> float:
        a = b.get("annual") or {}
        units = float(b.get("units") or 0)
        kh = float(a.get("facade_kh35") or 0.0)
        # A measure that lowers the facade by dT removes dT hours of dose for every
        # hour the facade was above the threshold, capped at the dose it had.
        avoided = min(kh, per_unit_effect_k * float(a.get("hours_above_35") or 0.0))
        if objective == "degree_hours":
            return avoided
        if objective == "vulnerable":
            return avoided * units * (float(b.get("hvi") or 1) / 5.0)
        if objective == "peak_relief":
            return per_unit_effect_k * max(0.0, float(
                b["modelled"]["facade_peak_c"]) - 35.0)
        return avoided * units

    ranked = sorted(pool, key=lambda b: -benefit(b))
    budget = max(1, min(int(budget), len(ranked)))
    chosen = ranked[:budget]
    total = sum(benefit(b) for b in chosen)
    pool_total = sum(benefit(b) for b in ranked)

    return {
        "objective": objective,
        "assumed_facade_reduction_k": per_unit_effect_k,
        "budget_buildings": budget,
        "eligible_candidates": len(pool),
        "of_ranked": len(rows),
        "constraint": constraint,
        "total_benefit": round(total, 1),
        "share_of_available_benefit": round(total / pool_total, 4) if pool_total else None,
        "allocation": [{
            "order": i + 1, "bin": b["bin"], "address": b["addr"],
            "residents_units": b.get("units"), "hvi": b.get("hvi"),
            "annual_kh35": (b.get("annual") or {}).get("facade_kh35"),
            "event_facade_peak_c": b["modelled"]["facade_peak_c"],
            "marginal_benefit": round(benefit(b), 1),
            "actions": [a["key"] for a in b.get("actions", [])],
        } for i, b in enumerate(chosen)],
        "method": ("greedy on marginal benefit, which is exactly optimal here "
                   "because the objective is additive across buildings under a "
                   "cardinality budget"),
        "caution": (
            "per_unit_effect_k is an assumption you supplied, not a modelled "
            "result. Run interventions.run at the top few sites and re-allocate "
            "with the effect it returns before presenting this as a plan. Compare "
            "objective='person_hours' with objective='degree_hours' — where the "
            "two orderings differ is where efficiency and equity pull apart."
        ),
    }

/* What a budget buys, as a pure function of portfolio.json.
 *
 * WHY THIS IS NOT INSIDE THE PANEL
 *
 * It was, and that put the film in an impossible position. The narration has to
 * quote the programme the viewer is looking at, and the panel is the only thing
 * that knows what that is — but the panel is a lazily constructed surface that
 * does not exist until the decision layer lands, and the voice cache is baked by
 * a script that never opens it. So the caption read the panel when it could and
 * fell back to `portfolio.json`'s stored allocation when it could not, and those
 * two are different programmes: the stored one prices at the midpoint and
 * accounts for measures interacting on the same building, this one walks the
 * objective's own curve and stops rather than skips. Two million dollars buys
 * twenty buildings and thirty-three measures there and twenty-one buildings and
 * forty-four measures here. The film said one over a picture of the other.
 *
 * A programme is a function of the data, the objective and the budget. Nothing
 * about it needs a DOM. Putting it here means the panel, the narration and the
 * script that bakes the narration all get the same numbers by construction
 * rather than by two people remembering to keep two copies in step.
 *
 * GREEDY, AND IT STOPS RATHER THAN SKIPS
 *
 * Walk the objective's curve order and buy until the next candidate does not
 * fit. A skip-the-expensive-one rule packs the budget slightly fuller and is
 * what a solver would do, and it breaks the one claim the picture makes, which
 * is that everything left of the line is the programme. A reader who drags the
 * line to $21M and counts 208 bars must get 208 rows in the table. The extra
 * fraction of a percent of packing efficiency is not worth making the chart lie
 * about its own contents.
 */

/** The midpoint of a [low, high] range, which is what the curve is drawn on. */
export const mid = (r) => (Array.isArray(r) ? (r[0] + r[1]) / 2 : Number(r) || 0);

/* A default budget has to be derived from the data rather than typed in, or it
   is a number that happens to look sensible on one fixture and absurd on the
   next. A quarter of everything on the table is defensible, explicable in one
   clause, and lands in the part of the curve where the marginal cost is still
   climbing gently, which is where the interesting conversation is. */
export function defaultBudget(data) {
  const t = data?.total;
  if (!t) return 0;
  const q = t * 0.25;
  const step = q >= 1e7 ? 1e6 : q >= 1e6 ? 1e5 : 1e4;
  return Math.max(step, Math.round(q / step) * step);
}

/** Everything on the table, at midpoint cost. `portfolio.json` does not carry
 *  it, so the panel computes it once at construction; this is that sum. */
export function totalOf(data) {
  return (data?.candidates || []).reduce((s, c) => s + mid(c.capex), 0);
}

/** The programme a budget buys on one objective's curve. */
export function allocate(data, objective, budget) {
  const order = data?.curves?.[objective] || [];
  const C = data?.candidates || [];
  const idx = [];
  let spend = 0; let lo = 0; let hi = 0;
  let ph = 0; let kwhLo = 0; let kwhHi = 0; let cLo = 0; let cHi = 0;
  const bins = new Set();
  for (const i of order) {
    const c = C[i];
    if (!c) continue;
    const m = mid(c.capex);
    if (spend + m > budget) break;
    spend += m;
    lo += (c.capex?.[0] ?? m); hi += (c.capex?.[1] ?? m);
    ph += c.person_hours_avoided || 0;
    kwhLo += (c.kwh_saved?.[0] ?? 0); kwhHi += (c.kwh_saved?.[1] ?? 0);
    cLo += (c.carbon_t?.[0] ?? 0); cHi += (c.carbon_t?.[1] ?? 0);
    bins.add(String(c.bin));
    idx.push(i);
  }
  // Homes are summed over DISTINCT buildings. A building appears in the
  // candidate list once per applicable measure — 10 Park Avenue is in there
  // three times — and summing `units` over candidates counted its residents
  // three times over, which inflated the ledger's population by a factor of
  // nearly three before it was caught.
  const seen = new Set();
  let units = 0;
  for (const i of idx) {
    const c = C[i];
    const b = String(c.bin);
    if (seen.has(b)) continue;
    seen.add(b);
    units += c.units || 0;
  }
  const marginal = idx.length ? C[idx[idx.length - 1]].usd_per_person_hour : null;
  const next = order[idx.length] !== undefined ? C[order[idx.length]] : null;
  return {
    objective, idx, spend, capex: [lo, hi], ph, kwh: [kwhLo, kwhHi], carbon: [cLo, cHi],
    units, buildings: bins.size, bins, marginal, next,
  };
}

/** The same programme, reduced to the handful of figures a caption quotes. */
export function figuresOf(data, objective, budget) {
  const a = allocate(data, objective, budget);
  return {
    objective,
    budget_usd: budget,
    capex_usd: a.spend,
    capex_range: a.capex,
    buildings: a.buildings,
    measures: a.idx.length,
    units: a.units,
    person_hours_avoided: a.ph,
  };
}

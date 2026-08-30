/* What if — the planning engine, routed.
 *
 * The problem this module exists to solve is a routing problem, not a modelling
 * one. `heatcanyon/agent/interventions.py` already re-solves any physical lever
 * — albedo, canopy fraction, shading factor, wall admittance — over any
 * selection of canyons, at any period, and reports the deltas with their spread
 * across canyons and their seasonal split. Until now the only way to reach it
 * was to type a paragraph of prose at an LLM. Meanwhile this pane showed six
 * presets at three fixed demonstration canyons, precomputed at build time, so a
 * planner who had just clicked 10 Park Avenue and wanted to know what shading
 * does to *that building* could not find out. The engine could answer; the
 * interface had no door.
 *
 * Three states, in the order a decision is actually made in:
 *
 *   1. A building is selected. Its prescribed measures, what each one reaches
 *      floor by floor, and a live re-solve of the street it stands on.
 *   2. Nothing selected. The three-site preset grid, which is genuinely the
 *      best general picture in the project and is kept.
 *   3. Design your own. The raw levers behind a disclosure.
 *
 * Two claims are carried deliberately and everything else is arranged around
 * them.
 *
 * THE FIRST IS NON-ADDITIVITY. Trees shade the pavement the cool coating was
 * meant to fix, so four measures together deliver less than the four measures
 * added up. The engine captures this because it re-solves rather than adding
 * coefficients, and in the precomputed grid it is worth roughly a fifth of the
 * benefit on the open street: the four measures sum to -22.5 K of ground
 * surface temperature and together deliver -18.0 K. This pane draws both bars
 * on one scale and names the difference, because a platform that can show that
 * gap is making a claim a spreadsheet of per-measure coefficients cannot make.
 *
 * The gap has a sign and it is not always a shortfall. In the deep canyon the
 * combination delivers *more* felt-temperature relief than its parts, because
 * shading the walls makes the canopy's own shade colder to stand in. The copy
 * below reads the sign rather than assuming a shortfall; asserting "less than
 * the sum" over a number that says otherwise would be worse than saying
 * nothing.
 *
 * A NOTE ON WHAT MAY BE COMPARED WITH WHAT. Both sides of a stack comparison
 * must come out of the same solver in the same units, or the gap is an artefact
 * of the mismatch. In state 2 both sides are the pipeline's own re-solves at
 * the same site and hour, so they are directly comparable. In state 1 the
 * per-measure figures in `prescriptions.json` are per-face, per-floor-band
 * facade peaks while the intervention engine returns canyon-level ground,
 * facade and mean radiant deltas — different quantities. So state 1 does NOT
 * subtract one from the other. It runs the parts and the combination through
 * the engine itself, n+1 re-solves, and labels the block as the street-level
 * answer; the per-floor ladder beside it is separately labelled as the
 * prescription's own claim. Two claims, two sources, each named.
 *
 * THE SECOND IS THE SEASONAL COST. Facade shading that removes several kelvin
 * in July removes January's solar gain too, and the pane this replaces had the
 * best expression of that in the project: a summer / winter / year / cost table
 * built from twelve re-solved months, with a note explaining that a positive
 * winter number is the correct sign for a shading measure and is its price.
 * That table survives here unchanged in structure, gains a bar so the price
 * reads before the number does, and gains a building-scale counterpart in state
 * 1 — the winter heating penalty in kilowatt-hours, which is the currency the
 * owner of the building actually acts in.
 *
 * ON SLOWNESS. A re-solve is seconds, not milliseconds, and a stack comparison
 * is n+1 of them. The progress state counts real elapsed wall time, says which
 * job of how many is running, and on completion reports the engine's own
 * `seconds` beside the wall time. Pretending a slow thing is fast is how a
 * working engine comes to feel broken. Every run is cancellable.
 *
 * ON THE ENDPOINTS NOT EXISTING. `/api/intervention` is being written in
 * parallel with this module and at the time of writing `server.py` has no such
 * route. That is treated as a first-class state, not an exception: the pane
 * falls back to the precomputed grid in `scenarios.json`, says plainly that the
 * live re-solve is unavailable in this build, and keeps working. Every claim
 * the pane makes without the engine is a claim the precomputed data supports on
 * its own.
 *
 * Colour: green cools and red warms, as the pane this replaces established.
 * Money uses --money and --cost and never borrows the temperature ramp. The
 * accent is the cursor and the active state and is never data.
 */

/* ------------------------------------------------------------------ levers

   A mirror of LEVERS and PRESETS in `heatcanyon/agent/interventions.py`. It is
   duplicated rather than fetched because there is no endpoint that serves the
   intervention catalogue — `intervention_catalogue` is an agent tool, and
   `/api/constants` serves the economic constants, which are a different thing.
   Duplication needs a rule to stay honest, so: THE PYTHON IS THE SOURCE OF
   TRUTH. If a range moves there, move it here. The server validates every spec
   against its own copy and rejects an out-of-range lever with a SpecError, so
   the failure mode of drift is a refused request with a legible message rather
   than a wrong answer, which is the right way round.

   The notes are the levers' stated trade-offs, shortened to fit a 300px column.
   The full text is in the Python and in the analyst's catalogue. */

const LEVERS = [
  {
    key: 'tree_cover',
    name: 'Street trees',
    unit: '',
    lo: 0,
    hi: 0.85,
    step: 0.05,
    preset: 0.45,
    fmt: (v) => `${Math.round(v * 100)}% canopy`,
    note: 'Intercepts the beam, moves absorbed energy into latent heat, and puts a '
      + 'cool surface in the pedestrian’s view. Also lowers sky view factor, which '
      + 'slows night-time cooling — the model reproduces the penalty.',
  },
  {
    key: 'facade_shade',
    name: 'Façade shading',
    unit: '',
    lo: 0,
    hi: 0.90,
    step: 0.05,
    preset: 0.35,
    fmt: (v) => `${Math.round(v * 100)}% of beam`,
    note: 'Brise-soleil, deep reveals, awnings. Only the treated face, and nothing '
      + 'for the sidewalk unless it overhangs it.',
  },
  {
    key: 'wall_albedo',
    name: 'Wall albedo',
    unit: '',
    lo: 0.05,
    hi: 0.90,
    step: 0.05,
    preset: 0.60,
    fmt: (v) => v.toFixed(2),
    note: 'A light facade coating. Lowers the treated wall and RAISES what it '
      + 'reflects onto the wall opposite and onto pedestrians — the model resolves '
      + 'both.',
  },
  {
    key: 'ground_albedo',
    name: 'Cool pavement',
    unit: '',
    lo: 0.05,
    hi: 0.60,
    step: 0.05,
    preset: 0.40,
    fmt: (v) => v.toFixed(2),
    note: 'Reliably lowers ground surface temperature and can raise mean radiant '
      + 'temperature in a deep canyon. That trade-off is real and documented.',
  },
  {
    key: 'roof_albedo',
    name: 'Cool roofs',
    unit: '',
    lo: 0.05,
    hi: 0.90,
    step: 0.05,
    preset: 0.70,
    fmt: (v) => v.toFixed(2),
    note: 'A roof is nearly invisible from the sidewalk, so this moves the top-floor '
      + 'cooling load and almost nothing at street level.',
  },
  {
    key: 'wall_admittance',
    name: 'Wall admittance',
    unit: 'J/m²K√s',
    lo: 200,
    hi: 2000,
    step: 50,
    preset: 400,
    fmt: (v) => `${Math.round(v)}`,
    note: 'External insulation or added mass. Governs how much net radiation the '
      + 'fabric absorbs rather than shedding to the air, so a heavier wall runs '
      + 'cooler at its surface under the same sun.',
  },
];

/* Which lever stands for which prescribed measure.

   The prescriptions are written in the language of a construction schedule —
   "external vertical shading, NW face, floors 6-26" — and the engine is written
   in the language of physics. This table is the translation, and it is lossy in
   one direction that has to be stated rather than hidden: NIGHT PURGE HAS NO
   LEVER. It is a ventilation measure acting on the inside of the envelope and
   the canyon solver models the outside, so there is no spec that expresses it.
   A measure with `lever: null` is kept selectable — it is still part of the
   building's schedule and still has a floor range, a price and a winter cost —
   but it is excluded from any spec sent to the engine, and the pane says so
   rather than quietly dropping it and reporting a number for three measures
   under a heading that names four. */

const MEASURE_SPEC = {
  fixed_shading: { facade_shade: 0.35 },
  deep_shading: { facade_shade: 0.65 },
  operable_shading: { facade_shade: 0.35 },
  cool_roof: { roof_albedo: 0.70 },
  cool_facade_coating: { wall_albedo: 0.60 },
  exterior_insulation: { wall_admittance: 400 },
  glazing_retrofit: null,
  night_purge: null,
  rooftop_pv: null,
};

/* The three metrics the stack comparison can be read on, with the key each
   source calls them by. "felt" is mean radiant temperature: what a body on the
   pavement actually exchanges heat with, which is the number that decides
   whether a street is bearable and is not the same as air temperature. */

const METRICS = [
  { key: 'ground', label: 'road', pre: 'd_ground', live: 'ground' },
  { key: 'facade', label: 'wall', pre: 'd_facade', live: 'facade_lower' },
  { key: 'mrt', label: 'felt', pre: 'd_mrt_sun', live: 'mrt' },
];

/* Short names for the preset rows. The pipeline's own titles carry the
   parameter change — "Cool roofs (albedo 0.25 -> 0.70)" — which belongs in the
   methodology, not in a 300px column. This is the same map the pane it replaces
   used, kept verbatim so the two never disagree about what a measure is called.
   `all_measures` is absent on purpose: it is no longer a row. It is what the
   other four rows become when all four are selected, which is the entire point
   of the block below the table. */

const SHORT = {
  cool_roof: 'Cool roofs',
  cool_pavement: 'Cool pavement',
  street_trees: 'Street trees',
  facade_shading: 'Façade shading',
};

/* And the same problem again for the prescriptions, which name themselves in
   the language of a construction schedule: "External vertical shading — NW
   face, floors 6-26". That is exactly right on the measure row, where the face
   is the useful half of it. In a table cell 110px wide it wraps to three lines
   and turns a four-row table into a twelve-line one. So the table uses these,
   the rows use the schedule's own title, and a measure with no entry here falls
   back to `shortTitle`, which at least drops everything after the dash. */
const PRESC_SHORT = {
  fixed_shading: 'Façade shading',
  deep_shading: 'Deep shading',
  operable_shading: 'Operable shading',
  exterior_insulation: 'Insulation',
  cool_roof: 'Cool roof',
  cool_facade_coating: 'Cool walls',
  glazing_retrofit: 'Glazing',
  night_purge: 'Night purge',
  rooftop_pv: 'Rooftop PV',
};

/** The four elemental measures, in the order the precomputed grid stacks them.
 *  `all_measures` is their re-solved combination and is the free, no-endpoint
 *  demonstration of non-additivity this pane leans on. */
const PARTS = ['cool_roof', 'cool_pavement', 'street_trees', 'facade_shading'];

const DOM_TERM = { solar: 'var(--term-solar)', trap: 'var(--term-trap)' };

// ------------------------------------------------------------------ helpers

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Green cools, red warms, and a dead band either side of zero so that rounding
 *  noise does not get painted as a finding. 0.05 K is the same threshold the
 *  pane this replaces used and the same one the engine uses for its
 *  `made_worse_fraction`. */
const sign = (v, eps = 0.05) => (!isFinite(v) ? 'flat' : v < -eps ? 'cool' : v > eps ? 'warm' : 'flat');

/** A signed kelvin figure for a dense cell. `ctx.fmt.k` is used everywhere the
 *  number is read as prose; in a five-column table 300px wide, repeating the
 *  unit twenty times costs more than the header carrying it once.
 *
 *  Zero is printed unsigned. `(-0.004).toFixed(1)` is the string "-0.0", and a
 *  column of "-0.0" and "+0.0" reads as a set of tiny findings when it is in
 *  fact a set of measurements that came out at zero. The dead band here is the
 *  same 0.05 K the colour sense uses, so a cell that is painted neutral is also
 *  printed unsigned and the two can never disagree. */
const dK = (v) => {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) < 0.05) return '0.0';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
};

const HH = (h) => String(h).padStart(2, '0');

/** Formatters, with fallbacks.
 *
 *  `ctx.fmt` is defined once by the host and is the house style; these
 *  fallbacks exist only so that a harness, a test page, or a host that has not
 *  yet grown `pct` cannot make this module throw on its first render. They
 *  reproduce the documented house forms — a range is `4.1–6.8 kW`, never a bare
 *  midpoint — so a missing formatter degrades the typography and never the
 *  meaning. */
function formatters(fmt) {
  const f = fmt || {};
  const num = f.num || ((v, d = 0) => (isFinite(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—'));
  const out = {
    num,
    money: f.money || ((v) => (isFinite(v) ? `$${num(Math.round(v))}` : '—')),
    kw: f.kw || ((v) => `${num(v, 1)} kW`),
    kwh: f.kwh || ((v) => (Math.abs(v) >= 1000 ? `${num(v / 1000, 1)} MWh` : `${num(v)} kWh`)),
    k: f.k || ((v) => `${v > 0 ? '+' : ''}${num(v, 1)} K`),
    temp: f.temp || ((v) => `${num(v, 1)} °C`),
    pct: f.pct || ((v) => `${Math.round(v * 100)}%`),
    /* Passed through rather than reimplemented: a money range must look the
       same on this pane as it does on the portfolio, and the only way to
       guarantee that is to use the host's formatter when it has one. */
    moneyRange: f.moneyRange || null,
  };
  /* The range is the one formatter that must not be got wrong, because an
     assumed figure rendered without it is a bug by the project's own rule. It
     takes the pair the way the JSON stores it, orders it, and prints the unit
     once. */
  out.range = f.range || ((lo, hi, unit) => {
    if (!isFinite(lo) || !isFinite(hi)) return '—';
    const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
    const d = Math.max(Math.abs(a), Math.abs(b)) < 100 ? 1 : 0;
    return `${num(a, d)}–${num(b, d)}${unit ? ` ${unit}` : ''}`;
  });
  return out;
}

/** An assumed figure, dotted-underlined, with the assumption named in its title.
 *
 *  The shared context exports `assumed(html, why)` as the one house treatment,
 *  and this defers to it whenever it is there so that all four decision surfaces
 *  mark a soft figure identically. The local fallback is byte-for-byte the same
 *  markup, and exists so the module renders correctly in a harness and cannot be
 *  broken by a context that has not grown the helper yet.
 *
 *  `.asm` itself: app.css names it as the whole treatment for an assumed figure
 *  but declares no rule for it — the decision layer's four surfaces landed at
 *  once and the class belongs to whichever of them declares it. This module
 *  declares `.wi .asm` in its own sheet, scoped, so it renders correctly whether
 *  or not a global rule ever arrives and cannot collide with one that does. */
function asm(text, title, ctx) {
  const why = title || 'Derived through a stated assumption table.';
  if (typeof ctx?.assumed === 'function') return ctx.assumed(esc(text), why);
  return `<span class="asm" title="${esc(why)}">${esc(text)}</span>`;
}

// ------------------------------------------------------------------- module

export class WhatIf {
  constructor(ctx) {
    this.ctx = ctx;
    this.fmt = formatters(ctx?.fmt);

    /* Which of the three demonstration sites state 2 is showing, and which
       measures are picked. `picked` is a Set of measure keys and its meaning
       depends on the state — preset keys in state 2, prescription keys in state
       1 — so it is cleared whenever the selection changes and the vocabulary
       with it. */
    this.site = 0;
    this.picked = new Set();
    this.metric = 'mrt';
    this.openKey = null;          // which prescription's detail is expanded

    /* The custom pane's own state. It is built once and never re-rendered, so
       that a re-render triggered by the clock ticking cannot yank a slider out
       from under the thumb that is dragging it. */
    this.custom = { open: false, levers: new Map(), period: 'seasons' };

    /* One run slot per origin. Both render from state, so a re-render during a
       run redraws the progress correctly rather than losing it. */
    this.runs = { building: null, custom: null, street: null };

    /* null = not yet known; false = an attempt failed or there is no api at
       all. Never probed speculatively: firing a request nobody asked for, to
       decide what to say about a button, is how an interface starts lying about
       what it has done. */
    this.live = ctx?.api?.intervention ? null : false;

    this._token = 0;
    this._raf = 0;
    this._tick = 0;
    this._onSelect = () => { this.picked.clear(); this.openKey = null; this._schedule(); };
    this._onTime = () => this._schedule();
  }

  // ------------------------------------------------------------ lifecycle

  mount(host) {
    this.host = host;
    host.innerHTML = '';
    this.root = el('div', 'wi');
    host.appendChild(this.root);

    /* Four regions. `body` is re-rendered whenever the selection or the clock
       moves; `customEl` is built once and persists, because it holds live
       controls. The banner and the availability strip are cheap and rebuilt
       with the body. */
    this.bodyEl = el('div', 'wi-body');
    this.customEl = el('div', 'wi-custom');
    this.root.appendChild(this.bodyEl);
    this.root.appendChild(this.customEl);

    this._buildCustom();

    const c = this.ctx;
    c?.on?.('select', this._onSelect);
    c?.on?.('time', this._onTime);
    c?.on?.('layer', this._onTime);

    /* The decision products arrive after the atlas does.
     *
     * `data.js` builds `d.decision` with every product null and fills it in from
     * a second, optional fetch, exposing `decision.ready` — in its own words,
     * "for the panes that need to wait on it". This is one of those panes and
     * the host does not await it, so without this a building selected during
     * the first second of the session finds no schedule and falls through to the
     * general grid, permanently, because nothing would ever tell it to look
     * again. `_schedule` coalesces, and the destroyed check is there because a
     * tab switched away from before the fetch lands would otherwise render into
     * a detached root. */
    const ready = c?.decision?.ready;
    if (ready && typeof ready.then === 'function') {
      ready.then(() => { if (this.root) this._schedule(); },
        () => { /* the products are optional; their absence degrades one pane */ });
    }

    this._render();
  }

  update() { this._schedule(); }

  destroy() {
    const c = this.ctx;
    c?.off?.('select', this._onSelect);
    c?.off?.('time', this._onTime);
    c?.off?.('layer', this._onTime);
    this._cancelAll();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._tick) clearInterval(this._tick);
    this._raf = 0;
    this._tick = 0;
    if (this.root?.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
  }

  /** Coalesce renders to one a frame. The clock can emit `time` sixty times a
   *  second while the day is playing and this pane reads the hour, so without
   *  this the panel rebuilds its DOM on every frame of the transport. */
  _schedule() {
    if (this._raf || !this.root) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  // --------------------------------------------------------------- render

  _render() {
    if (!this.root) return;
    const b = this.bodyEl;
    b.innerHTML = '';

    if (this.ctx?.decision?.fixture) b.appendChild(this._fixtureBanner());
    if (this.live === false) b.appendChild(this._offlineStrip());

    const bin = this._selectedBin();
    if (bin && this._prescriptions(bin).length) this._renderBuilding(b, bin);
    else if (bin) this._renderBuildingBare(b, bin);
    else this._renderSites(b);

    /* The custom pane is not rebuilt here — its sliders are live controls and
       must survive a render — but its run slot is, because a run started from
       the disclosure has to show its progress and its result somewhere and that
       somewhere is inside a subtree `_render` otherwise never touches. This one
       line is the difference between the disclosure's Run button appearing to
       do nothing and the disclosure working at all. */
    this._renderCustomRun();
  }

  _selectedBin() {
    const s = this.ctx?.state?.selectedBin;
    return s === null || s === undefined || s === '' ? null : String(s);
  }

  _prescriptions(bin) {
    /* `ctx.decision.prescriptions` may be handed over either as the whole
       document or as its `items` map, depending on how the host loads it. Both
       are accepted: the alternative is a pane that renders empty because of a
       one-word disagreement about a wrapper. */
    const p = this.ctx?.decision?.prescriptions;
    const items = p?.items || p || {};
    const v = items[bin] || items[String(bin)];
    return Array.isArray(v) ? v : [];
  }

  _floors(bin) {
    const f = this.ctx?.decision?.floors;
    const items = f?.items || f || {};
    return items[bin] || items[String(bin)] || null;
  }

  _building(bin) {
    return this.ctx?.d?.rankByBin?.get?.(String(bin))
      || this.ctx?.d?.ranked?.items?.find?.((r) => String(r.bin) === String(bin))
      || null;
  }

  _fixtureBanner() {
    /* The standing placeholder-data banner. It says the one thing that matters
       — these numbers are shaped like the answer and are not the answer — and
       it does not move or dismiss, because a banner you can dismiss is a banner
       that is not there when the screenshot is taken. */
    const p = this.ctx?.decision?.prescriptions;
    const asOf = p?.constants_as_of;
    /* The as-of date is worth saying and "CONSTANTS AS OF FIXTURE" is not: in a
       fixture build the field holds the literal string FIXTURE, and printing it
       adds a line that says the same thing the line above already said. */
    const dated = asOf && String(asOf).toUpperCase() !== 'FIXTURE';
    return el('div', 'wi-fix',
      'PLACEHOLDER DATA<br>'
      + 'THE MEASURES, EFFECTS AND PRICES ON THIS PANE ARE FIXTURE VALUES OF THE '
      + 'RIGHT SHAPE AND THE WRONG MAGNITUDE'
      + (dated ? `<br>CONSTANTS AS OF ${esc(String(asOf))}` : ''));
  }

  _offlineStrip() {
    const s = el('div', 'wi-off');
    s.innerHTML =
      'LIVE RE-SOLVE UNAVAILABLE IN THIS BUILD<br>'
      + 'SHOWING THE PRECOMPUTED GRID — THE ENGINE IS THERE, THE ROUTE TO IT IS NOT';
    return s;
  }

  // ----------------------------------------------------- state 1: building

  /* A building is selected. This is the case that did not exist before this
     module and it is the whole reason for it.

     The block is ordered the way the question is asked: which building, what is
     prescribed for it, what does each measure reach, what do they cost in
     winter, and what is the worst floor left holding. The re-solve sits between
     the schedule and the seasonal price because that is where someone stops
     reading the schedule and starts doubting it. */

  _renderBuilding(host, bin) {
    const F = this.fmt;
    const b = this._building(bin);
    const fl = this._floors(bin);
    const ps = this._prescriptions(bin);

    // --- identity
    const idb = el('div', 'wi-blk');
    idb.appendChild(el('div', 'wi-id', esc(b?.addr || `BIN ${bin}`)));
    const meta = [];
    if (b?.floors) meta.push(`${b.floors} FLOORS`);
    if (b?.year) meta.push(String(b.year));
    if (b?.units) meta.push(`${F.num(b.units)} UNITS`);
    if (fl?.worst_floor) meta.push(`WORST FLOOR ${fl.worst_floor}`);
    idb.appendChild(el('div', 'wi-meta', meta.join('&nbsp; · &nbsp;')));
    idb.appendChild(el('p', 'wi-lede',
      `${ps.length} measure${ps.length === 1 ? '' : 's'} are prescribed here, chosen `
      + 'by what makes this building hot rather than by how hot it is. Pick them to '
      + 'see what each one reaches, and what it costs in January.'));
    host.appendChild(idb);

    // --- the measure rows
    host.appendChild(el('div', 'wi-hd', '<span class="wi-lab">PRESCRIBED HERE</span>'
      + '<span class="wi-lab wi-dim">Δ FAÇADE PEAK</span>'));
    const list = el('div', 'wi-ms');
    ps.forEach((p) => list.appendChild(this._measureRow(bin, p)));
    host.appendChild(list);

    // --- the per-floor ladder
    if (fl?.floors?.length) host.appendChild(this._ladder(bin, fl, ps));

    // --- the street-level re-solve, and the stacking argument
    host.appendChild(this._buildingRun(bin, ps));

    // --- the winter price
    host.appendChild(this._winterPrice(ps));

    // --- the answering figure
    host.appendChild(this._buildingAnswer(bin, fl, ps));
  }

  _renderBuildingBare(host, bin) {
    /* A building with no schedule. It happens: `prescriptions.json` covers the
       scored buildings and the model carries thousands more. Say which case
       this is instead of falling silently back to the general grid, then fall
       back to the general grid. */
    const b = this._building(bin);
    const blk = el('div', 'wi-blk');
    blk.appendChild(el('div', 'wi-id', esc(b?.addr || `BIN ${bin}`)));
    blk.appendChild(el('p', 'wi-lede',
      'No floor-by-floor schedule was produced for this building — the decision '
      + 'layer covers the scored buildings only. The general picture below still '
      + 'applies to the street it stands on.'));
    host.appendChild(blk);
    this._renderSites(host);
  }

  /** An assumed range as a magnitude, dotted-underlined, in the money palette.
   *
   *  Every figure that passed through an assumption table has to appear with
   *  its range and its label or it is a bug by the project's own rule, and this
   *  is the one place that rule is enforced, so nothing renders `d_annual_kwh`
   *  or a dollar band without going through here. */
  _rng(pair, unit, tone) {
    const [a, b] = pair;
    const text = this.fmt.range(Math.abs(a), Math.abs(b), unit);
    return `<span class="${tone}">${asm(text, 'Assumed: a stated assumption table, '
      + 'not a measurement in this study.', this.ctx)}</span>`;
  }

  _measureRow(bin, p) {
    const F = this.fmt;
    const on = this.picked.has(p.key);
    const open = this.openKey === p.key;
    const dk = p.effect?.d_facade_peak_k;
    const wrap = el('div', `wi-m${on ? ' on' : ''}`);

    const btn = el('button', 'wi-mb');
    btn.setAttribute('aria-pressed', String(on));
    const floors = Array.isArray(p.floors) ? p.floors : null;
    btn.innerHTML =
      `<span class="t">${esc(rowTitle(p))}</span>`
      + `<span class="k ${sign(dk)}">${dK(dk)}</span>`
      + `<span class="f">${floors ? `FLOORS ${floors[0]}–${floors[1]}` : 'WHOLE BUILDING'}`
      + `${p.lead_time ? ` · ${esc(String(p.lead_time).toUpperCase())}` : ''}`
      + `${MEASURE_SPEC[p.key] === null ? ' · NO CANYON LEVER' : ''}</span>`;
    btn.onclick = () => {
      if (this.picked.has(p.key)) { this.picked.delete(p.key); this.openKey = null; }
      else { this.picked.add(p.key); this.openKey = p.key; }
      this._render();
    };
    wrap.appendChild(btn);

    if (!open) return wrap;

    // --- the expanded detail. Every ranged figure carries its range here,
    //     which is why the ranges live on the expanded row rather than in the
    //     measure list: `-14,200–-8,600 kWh` will not fit in a 300px row and a
    //     midpoint that fits is a bug.
    const d = el('div', 'wi-det');
    if (p.why) d.appendChild(el('p', 'wi-why', esc(p.why)));

    const g = el('div', 'wi-kv');
    const kv = (k, v) => { g.appendChild(el('div', 'k', k)); g.appendChild(el('div', 'v', v)); };
    const e = p.effect || {};
    const m = p.money || {};
    if (p.device) kv('DEVICE', esc(cap(p.device)) + (p.geometry?.projection_m
      ? ` · ${p.geometry.projection_m} m` : ''));
    if (p.area_m2) kv('AREA', `${F.num(p.area_m2)} m²`);
    /* Magnitudes, with the DIRECTION carried by the label and the colour.
       `fmt.range` on a pair of negatives prints "-14,200–-8,600", which is a
       correct string and an unreadable one: the reader has to parse two minus
       signs and an en dash to find out that a saving is a saving. The labels
       here say SAVED, CUT and ADDED, the colour says money or cost, and the
       figures are left as plain magnitudes. Nothing is lost — a saving that
       could turn out to be a penalty would be a different measure — and the
       column becomes legible at a glance. */
    if (e.d_annual_kwh) kv('ENERGY SAVED', this._rng(e.d_annual_kwh, 'kWh/yr', 'money'));
    if (e.d_peak_kw) kv('PEAK CUT', this._rng(e.d_peak_kw, 'kW', 'money'));
    if (e.d_winter_kwh) {
      const warms = e.d_winter_kwh[1] > 0;
      kv(warms ? 'WINTER ADDED' : 'WINTER SAVED',
        this._rng(e.d_winter_kwh, 'kWh/yr', warms ? 'cost' : 'money'));
    }
    if (m.capex_usd) {
      /* `fmt.moneyRange` where the host provides it: money's own significant
         figures, the house en dash, and no chance of this pane disagreeing with
         the portfolio about what $460,992 looks like. */
      const cap$ = F.moneyRange
        ? F.moneyRange(m.capex_usd[0], m.capex_usd[1])
        : `${F.money(m.capex_usd[0])}–${F.money(m.capex_usd[1])}`;
      kv('CAPEX', `<span class="cost">${asm(cap$, m.basis || 'assumed', this.ctx)}</span>`);
    }
    if (m.payback_yr) {
      kv('PAYBACK', asm(F.range(m.payback_yr[0], m.payback_yr[1], 'yr'),
        m.basis || 'assumed', this.ctx));
    }
    d.appendChild(g);

    if (p.winter_cost) {
      d.appendChild(el('p', 'wi-note',
        `WINTER COST&nbsp; · &nbsp;${esc(shout(p.winter_cost))}`));
    }
    if (p.does_not_fix) {
      d.appendChild(el('p', 'wi-why wi-neg', `Does not fix: ${esc(p.does_not_fix)}`));
    }
    if (p.programme?.length) {
      d.appendChild(el('p', 'wi-note', `PROGRAMME&nbsp; · &nbsp;${
        esc(shout(p.programme.join(' · ')))}`));
    }
    if (this.ctx?.openBrief) {
      const link = el('button', 'link', 'THE FULL BRIEF');
      link.onclick = () => this.ctx.openBrief(bin);
      d.appendChild(link);
    }
    wrap.appendChild(d);
    return wrap;
  }

  /* ---- the floor ladder.

     The per-floor consequence, which is the thing a building average hides. A
     schedule that says "-6.2 K" about a twenty-six storey building is telling
     you about a wall you cannot identify; this says which floors the measure
     reaches and, beside them, which floors it does not.

     Floors are grouped into the ten bands `floors.json` already carries — a
     row per storey would be twenty-six rows in a 300px panel, and the bands are
     the resolution the physics was solved at anyway. The building reads bottom
     to top, so the array is drawn in reverse: the roof is at the top of the
     ladder where the roof is.

     The term stripe is the band's DOMINANT cause, not its temperature, which is
     what makes the schedule legible as an argument: shading covers floors 6-26
     because those bands are solar-dominated, and insulation covers 1-5 because
     those are trapped longwave from the wall opposite and no amount of shading
     would touch them. The two stripes make that visible before any number is
     read. */

  _ladder(bin, fl, ps) {
    const blk = el('div', 'wi-blk');
    blk.appendChild(el('span', 'wi-lab', 'WHAT EACH MEASURE REACHES'));

    const bands = new Map();
    for (const f of fl.floors) {
      const b = bands.get(f.band) || { band: f.band, lo: f.f, hi: f.f, sev: f.sev, t: f.t_surf, dom: f.dom };
      b.lo = Math.min(b.lo, f.f); b.hi = Math.max(b.hi, f.f);
      b.sev = Math.max(b.sev ?? 0, f.sev ?? 0);
      b.t = Math.max(b.t ?? -999, f.t_surf ?? -999);
      b.dom = f.dom || b.dom;
      bands.set(f.band, b);
    }
    const rows = [...bands.values()].sort((a, b) => b.band - a.band);
    const picked = ps.filter((p) => this.picked.has(p.key));
    const lad = el('div', 'wi-lad');
    let anyOverlap = false;

    for (const r of rows) {
      const covering = picked.filter((p) => Array.isArray(p.floors)
        && p.floors[1] >= r.lo && p.floors[0] <= r.hi);
      const dk = covering.reduce((s, p) => s + (p.effect?.d_facade_peak_k || 0), 0);
      if (covering.length > 1) anyOverlap = true;
      const row = el('div', `wi-lr${covering.length ? ' on' : ''}`);
      row.innerHTML =
        `<span class="fl">${r.lo === r.hi ? r.lo : `${r.lo}–${r.hi}`}</span>`
        + `<span class="tm" style="background:${DOM_TERM[r.dom] || 'var(--t8)'}"></span>`
        + `<span class="sv"><i style="width:${
          Math.round(((r.sev ?? 0) + 1) / 5 * 100)}%;background:var(--sev-${
          Math.min(Math.max(r.sev ?? 0, 0), 4)})"></i></span>`
        + `<span class="tt">${isFinite(r.t) ? r.t.toFixed(0) : '—'}°</span>`
        + `<span class="dl ${covering.length ? sign(dk) : 'none'}">${
          covering.length ? dK(dk) + (covering.length > 1 ? '<b>·</b>' : '') : '·'}</span>`;
      lad.appendChild(row);
    }
    blk.appendChild(lad);

    const legend = ['<span class="sw" style="background:var(--term-solar)"></span>SOLAR',
      '<span class="sw" style="background:var(--term-trap)"></span>TRAPPED LONGWAVE'];
    blk.appendChild(el('p', 'wi-note',
      `FLOOR BAND&nbsp; · &nbsp;DOMINANT CAUSE&nbsp; · &nbsp;SEVERITY&nbsp; · &nbsp;`
      + `FAÇADE PEAK NOW&nbsp; · &nbsp;Δ FROM THE MEASURES SELECTED<br>${legend.join('&nbsp; ')}`
      + (anyOverlap
        ? '<br><b class="warnk">A DOT MARKS A BAND TWO MEASURES BOTH REACH, WHERE THE '
          + 'DELTAS ARE ADDED AND SHOULD NOT BE — SEE BELOW</b>'
        : '')));
    if (!picked.length) {
      blk.appendChild(el('p', 'wi-why wi-dim',
        'Nothing selected, so nothing is treated. Pick a measure above.'));
    }
    return blk;
  }

  /* ---- the winter price.

     The seasonal trade-off table, carried over from the pane this replaces and
     moved into the currency a building is actually run in. The kelvin version
     survives untouched in state 2, where twelve re-solved months exist for the
     demonstration canyons; here the same idea is expressed as the annual
     cooling saving against the January heating penalty, because that is the
     form the schedule carries per measure and per floor range.

     The sign convention is the one that matters and it is the same one: a
     POSITIVE winter number is a heating penalty, it is the correct sign for a
     shading measure, and it is the price of it. It is not a defect in the
     measure and the table must not read as though it were, which is why the
     column is headed "price" rather than "penalty" and why the bar beside it is
     drawn in --cost rather than in the temperature ramp. */

  _winterPrice(ps) {
    const F = this.fmt;
    const blk = el('div', 'wi-blk');
    blk.appendChild(el('span', 'wi-lab', 'ACROSS THE YEAR'));

    const rows = ps.map((p) => {
      const e = p.effect || {};
      const cool = e.d_annual_kwh ? (e.d_annual_kwh[0] + e.d_annual_kwh[1]) / 2 : null;
      const warm = e.d_winter_kwh ? (e.d_winter_kwh[0] + e.d_winter_kwh[1]) / 2 : null;
      return { p, cool, warm, e };
    }).filter((r) => r.cool !== null || r.warm !== null);
    if (!rows.length) return blk;

    const scale = Math.max(...rows.map((r) => Math.abs(r.warm || 0)), 1);
    const t = el('table', 'wi-tab wi-yr');
    t.innerHTML = '<thead><tr><th>Measure</th><th>cools</th><th>warms</th>'
      + '<th class="pr">price</th></tr></thead>';
    const tb = el('tbody');
    for (const r of rows) {
      const on = this.picked.has(r.p.key);
      const tr = el('tr', on ? 'on' : null);
      const cools = r.e.d_annual_kwh ? this._rng(r.e.d_annual_kwh, '', 'money') : '—';
      const warms = r.e.d_winter_kwh
        ? this._rng(r.e.d_winter_kwh, '', (r.warm || 0) > 0 ? 'cost' : 'money') : '—';
      tr.innerHTML =
        `<td>${esc(shortTitle(r.p))}</td>`
        + `<td>${cools}</td>`
        + `<td>${warms}</td>`
        + `<td class="pr"><span class="wi-pb"><i style="width:${
          Math.round(Math.max(r.warm || 0, 0) / scale * 100)}%"></i></span></td>`;
      tr.onclick = () => {
        if (this.picked.has(r.p.key)) { this.picked.delete(r.p.key); this.openKey = null; }
        else { this.picked.add(r.p.key); this.openKey = r.p.key; }
        this._render();
      };
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    blk.appendChild(t);
    blk.appendChild(el('p', 'wi-note',
      'KILOWATT-HOURS A YEAR, ASSUMED RANGES, SHOWN AS MAGNITUDES — THE COLUMN SAYS '
      + 'WHICH WAY<br>"WARMS" IS THE HEATING THE MEASURE ADDS IN JANUARY BY REMOVING '
      + 'THE SAME SOLAR GAIN IT REMOVES IN JULY. THAT IS THE CORRECT SIGN FOR A '
      + 'SHADING MEASURE AND IT IS THE PRICE OF IT'));
    return blk;
  }

  _buildingAnswer(bin, fl, ps) {
    /* One large serif figure, the design's standard way of ending a block that
       answers a question. It is the WORST band's facade peak, not a building
       mean, and the delta beside it is the sum of only those measures that
       actually reach that band — which is frequently one measure, and the
       honest answer to "what does the schedule do for the worst floor in the
       building". */
    const F = this.fmt;
    const blk = el('div', 'wi-blk');
    /* The schedule's own worst floor, not the hottest surface.
       `floors.json` picks `worst_floor` on a quintile of the indoor estimate,
       the annual dose and the solar term together, which is the floor someone
       actually lives worst on. Ranking by `t_surf` alone put floor 1 at the top
       of this building — the ground band has the hottest wall because it is
       trapped, but it is not where the schedule says the problem is, and the
       two answers disagreeing on the same panel would be a defect. Raw surface
       temperature is only the fallback for a schedule with no verdict. */
    const floorsArr = fl?.floors || [];
    const worst = floorsArr.find((f) => f.f === fl?.worst_floor)
      || floorsArr.reduce((a, f) =>
        (!a || (f.t_surf ?? -999) > (a.t_surf ?? -999) ? f : a), null);
    if (!worst) return blk;

    const picked = ps.filter((p) => this.picked.has(p.key));
    const covering = picked.filter((p) => Array.isArray(p.floors)
      && p.floors[1] >= worst.f && p.floors[0] <= worst.f);
    const dk = covering.reduce((s, p) => s + (p.effect?.d_facade_peak_k || 0), 0);
    const now = worst.t_surf;

    const box = el('div', 'wi-ans');
    box.innerHTML = `
      <div>
        <div class="wi-lab">WORST FLOOR — ${worst.f}, ${
      HH(fl.peak_hour_edt ?? 15)}:00</div>
        <div class="v">${isFinite(now) ? F.temp(now + dk) : '—'}</div>
      </div>
      <div class="rt">
        <div class="d ${sign(dk)}">${covering.length
      ? `${F.k(dk)} vs today` : 'untreated'}</div>
        <div class="wi-lab wi-dim">${covering.length
      ? (covering.length > 1 ? `${covering.length} MEASURES REACH IT` : '1 MEASURE REACHES IT')
      : 'NO MEASURE SELECTED REACHES IT'}</div>
      </div>`;
    blk.appendChild(box);
    if (covering.length > 1) {
      blk.appendChild(el('p', 'wi-note wi-warn',
        'TWO MEASURES REACH THIS FLOOR AND THEIR DELTAS ARE ADDED ABOVE. THAT IS THE '
        + 'ARITHMETIC THIS PLATFORM EXISTS TO CORRECT — RE-SOLVE THEM TOGETHER'));
    }
    if (worst.t_in) {
      blk.appendChild(el('p', 'wi-note',
        `INDOORS ON THAT FLOOR, UNTREATED&nbsp; · &nbsp;${
          asm(F.range(worst.t_in[0], worst.t_in[1], '°C'),
            'Assumed: an envelope assembly table, not a survey.', this.ctx)}`));
    }
    return blk;
  }

  // -------------------------------------------------------- state 2: sites

  _renderSites(host) {
    const S = this.ctx?.d?.scenarios;
    if (!S?.sites?.length) {
      host.appendChild(el('div', 'wi-blk',
        '<p class="wi-lede">No scenario sites in this run.</p>'));
      return;
    }
    const site = S.sites[Math.min(this.site, S.sites.length - 1)];

    const lede = el('div', 'wi-blk');
    lede.appendChild(el('p', 'wi-lede',
      'Four interventions the city can actually fund, each re-solved for this '
      + 'canyon rather than applied as a fixed figure. Select more than one to see '
      + 'what they do together — which is not what they do added up.'));
    if (this.ctx?.select) {
      const top = this.ctx?.d?.ranked?.items?.[0];
      if (top?.bin) {
        const b = el('button', 'link', `OR PICK A BUILDING: ${
          String(top.addr || top.bin).toUpperCase()}`);
        b.onclick = () => this.ctx.select(String(top.bin));
        lede.appendChild(b);
      }
    }
    host.appendChild(lede);

    // --- site picker, in the full-bleed metric-row idiom: it is the same kind
    //     of choice the layer list makes, which thing am I looking at.
    const pick = el('div', 'wi-sites');
    S.sites.forEach((sx, i) => {
      const b = el('button', null,
        `<span>${esc(sx.label)}</span><span class="u">${
          esc(String(sx.name).replace(/\s+/g, ' '))} · H/W ${Number(sx.hw).toFixed(1)}</span>`);
      b.setAttribute('aria-pressed', String(i === this.site));
      b.onclick = () => { this.site = i; this.picked.clear(); this._render(); };
      pick.appendChild(b);
    });
    host.appendChild(pick);

    // --- the hourly table
    const hour = this._hourRow(site);
    const blk = el('div', 'wi-blk');
    const R = Object.fromEntries(hour.results.map((r) => [r.key, r]));

    const t = el('table', 'wi-tab');
    t.innerHTML = '<thead><tr><th>Change</th><th>road</th><th>wall</th>'
      + '<th>felt</th><th>air</th></tr></thead>';
    const tb = el('tbody');
    for (const key of PARTS) {
      const r = R[key];
      if (!r) continue;
      const on = this.picked.has(key);
      const cell = (v) => `<td class="${sign(v)}">${dK(v)}</td>`;
      const tr = el('tr', on ? 'on' : null);
      tr.innerHTML = `<td>${esc(SHORT[key] || key)}</td>`
        + cell(r.d_ground) + cell(r.d_facade) + cell(r.d_mrt_sun) + cell(r.d_air);
      tr.onclick = () => {
        if (this.picked.has(key)) this.picked.delete(key); else this.picked.add(key);
        this._render();
      };
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    blk.appendChild(t);

    const all = el('button', 'link', this.picked.size === PARTS.length
      ? 'CLEAR' : 'SELECT ALL FOUR');
    all.onclick = () => {
      if (this.picked.size === PARTS.length) this.picked.clear();
      else PARTS.forEach((k) => this.picked.add(k));
      this._render();
    };
    blk.appendChild(all);

    blk.appendChild(el('p', 'wi-note',
      `CHANGE IN °C AT ${HH(hour.hour_edt)}:00&nbsp; · &nbsp;`
      + '<span class="cool">GREEN COOLS</span>, <span class="warm">RED WARMS</span><br>'
      + '"FELT" IS WHAT A BODY ON THE PAVEMENT EXCHANGES HEAT WITH'));
    host.appendChild(blk);

    // --- the stacking argument, free of any endpoint
    if (this.picked.size > 1) host.appendChild(this._siteStack(site, hour, R));

    // --- the seasonal table, kept
    if (site.annual?.length) host.appendChild(this._siteSeasonal(site, S));

    // --- the answering figure
    host.appendChild(this._siteAnswer(site, hour, R));

    /* A live re-solve of the same street, when there is an engine to ask and
       something to ask it about. It returns null with nothing selected rather
       than an empty block: an empty `.wi-blk` is 42px of padding and a hairline,
       which reads as a section that failed to load. */
    const street = this._streetRun(site);
    if (street) host.appendChild(street);
  }

  _hourRow(site) {
    /* The nearest solved hour to the clock. The grid holds three hours per
       site, not twenty-four, so the pane says which hour it is answering for
       rather than implying it tracks the transport exactly. */
    const hours = this.ctx?.d?.meta?.hours;
    const h = this.ctx?.state?.hour ?? 0;
    const target = hours?.[h]?.edt ?? h;
    let row = site.hours[0];
    for (const r of site.hours) {
      if (Math.abs(r.hour_edt - target) < Math.abs(row.hour_edt - target)) row = r;
    }
    return row;
  }

  _siteStack(site, hour, R) {
    /* The precomputed non-additivity demonstration.

       `all_measures` in the grid is the four elemental measures re-solved
       TOGETHER, at the same site and the same hour as the four rows above it.
       So when all four are selected, both sides of the comparison exist without
       any endpoint at all and the strongest claim on the pane costs nothing.

       With two or three selected the sum of the parts exists and the
       combination does not, and the honest thing is to say so and offer to
       compute it — which is exactly the moment the live engine earns its
       button. */
    const sel = PARTS.filter((k) => this.picked.has(k));
    const m = METRICS.find((x) => x.key === this.metric) || METRICS[2];
    const sum = sel.reduce((s, k) => s + (R[k]?.[m.pre] ?? 0), 0);
    const full = sel.length === PARTS.length ? R.all_measures?.[m.pre] : null;
    const run = this.runs.street;
    const live = run?.status === 'done' && run.combined ? run.combined[m.live] : null;
    const comb = full !== null && full !== undefined ? full : live;

    return this._stackBlock({
      sum,
      comb,
      metric: m,
      source: full !== null && full !== undefined
        ? `PRECOMPUTED · ${esc(String(site.name).replace(/\s+/g, ' '))} AT ${HH(hour.hour_edt)}:00`
        : (comb !== null && comb !== undefined ? 'RE-SOLVED LIVE' : null),
      pending: sel.length < PARTS.length && comb === null,
      pendingCopy: `Selecting all four gives the combination free: the grid already `
        + `holds this canyon re-solved with all four measures at once. For these `
        + `${sel.length}, the combination has to be solved.`,
    });
  }

  _siteSeasonal(site, S) {
    /* THE SEASONAL TRADE-OFF, which is the single most useful thing the year
       adds to this pane and is carried over from the pane this replaces with
       its reasoning intact.

       Every one of these numbers is a full re-solve of this canyon at that
       month's own representative-day peak hour, with that month's real solar
       geometry. It is not the July answer scaled: the noon sun is 26 degrees
       lower in December than in June over Manhattan, so a canyon that is half
       sunlit in July has a floor in permanent shade in January, and the physics
       of every measure changes with it.

       The consequence is the column nobody puts in a brochure. Facade shading
       that removes 4 K of July surface temperature removes January's solar gain
       too, when the building wanted it. A positive winter number is the correct
       sign for a shading measure and it is the cost of the measure.

       What is new here is the bar in the last column. The price was previously a
       number among four numbers and read as just another delta; drawn as a bar
       in --cost it reads as a price before it is read as a figure, and the two
       measures that have one are distinguishable from the two that do not at a
       glance rather than after a comparison. */
    const blk = el('div', 'wi-blk');
    blk.appendChild(el('span', 'wi-lab', 'ACROSS THE YEAR'));
    const rows = site.annual.filter((r) => r.key !== 'baseline');
    const scale = Math.max(...rows.map((r) => Math.abs(r.seasonal_penalty || 0)), 0.1);

    const t = el('table', 'wi-tab wi-yr');
    t.innerHTML = '<thead><tr><th>Measure</th><th>summer</th><th>winter</th>'
      + '<th>year</th><th class="pr">price</th></tr></thead>';
    const tb = el('tbody');
    for (const r of rows) {
      const on = this.picked.has(r.key)
        || (r.key === 'all_measures' && this.picked.size === PARTS.length);
      const cell = (v) => (v === null || v === undefined
        ? '<td class="flat">—</td>' : `<td class="${sign(v)}">${dK(v)}</td>`);
      const tr = el('tr', on ? 'on' : null);
      tr.innerHTML = `<td>${esc(SHORT[r.key]
        || (S.catalogue?.find((c) => c.key === r.key)?.title || r.key).replace(/ \(.*/, ''))}</td>`
        + cell(r.d_mrt_summer) + cell(r.d_mrt_winter) + cell(r.d_mrt_year)
        + `<td class="pr"><span class="wi-pb"><i style="width:${
          Math.round(Math.max(r.seasonal_penalty || 0, 0) / scale * 100)}%"></i></span></td>`;
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    blk.appendChild(t);
    blk.appendChild(el('p', 'wi-note',
      'CHANGE IN WHAT A BODY FEELS, °C, AT EACH SEASON’S PEAK HOUR, FROM TWELVE '
      + 'RE-SOLVED MONTHS<br>"PRICE" IS WINTER MINUS SUMMER: A POSITIVE NUMBER MEANS '
      + 'THE MEASURE DOES LESS GOOD IN WINTER, WHICH FOR SHADING AND CANOPY IS THE '
      + 'CORRECT SIGN AND IS THE PRICE OF IT'));
    return blk;
  }

  _siteAnswer(site, hour, R) {
    const F = this.fmt;
    const sel = PARTS.filter((k) => this.picked.has(k));
    const key = sel.length === PARTS.length ? 'all_measures' : (sel.length === 1 ? sel[0] : null);
    const chosen = key ? R[key] : null;
    const base = R.baseline;
    const blk = el('div', 'wi-blk');
    const abs = chosen?.abs?.facade ?? base?.abs?.facade;
    const delta = chosen?.d_facade ?? 0;

    const box = el('div', 'wi-ans');
    box.innerHTML = `
      <div>
        <div class="wi-lab">PEAK WALL, ${HH(hour.hour_edt)}:00</div>
        <div class="v">${isFinite(abs) ? F.temp(abs) : '—'}</div>
      </div>
      <div class="rt">
        <div class="d ${sign(delta)}">${Math.abs(delta) < 0.05
      ? 'baseline' : `${F.k(delta)} vs today`}</div>
        <div class="wi-lab wi-dim">${sel.length > 1 && !key
      ? 'SELECT ALL FOUR FOR THE<br>RE-SOLVED COMBINATION' : ''}</div>
      </div>`;
    blk.appendChild(box);
    blk.appendChild(el('p', 'wi-note',
      'EACH ROW RE-SOLVES THIS CANYON RATHER THAN APPLYING A FIXED FIGURE, WHICH IS '
      + 'WHY TREES DO A GREAT DEAL ON A SHALLOW STREET AND ALMOST NOTHING ON A DEEP '
      + 'ONE ALREADY IN SHADE'));
    return blk;
  }

  // ------------------------------------------------ the stacking bar block

  /** Sum of the parts against the re-solved combination, on one scale.
   *
   *  Both bars are scaled to the larger magnitude, so the shorter bar is
   *  literally the smaller effect and the empty run at its end is literally the
   *  benefit that does not arrive. The void is drawn as a void — a dashed
   *  outline over the panel ground, not a coloured segment — because it is an
   *  absence and colouring it would make it look like a third quantity.
   *
   *  The sum bar is neutral (--line-ctl) and the combination carries the
   *  temperature sense, green cooling and red warming. That is deliberate: the
   *  sum is a claim about arithmetic and the combination is a result, and only
   *  one of them is a measurement.
   */
  _stackBlock({ sum, comb, metric, source, pending, pendingCopy, running }) {
    const F = this.fmt;
    const blk = el('div', 'wi-blk wi-stack');

    const head = el('div', 'wi-hd2');
    head.appendChild(el('span', 'wi-lab', 'STACKING'));
    const mx = el('div', 'wi-mx');
    METRICS.forEach((m) => {
      const b = el('button', null, m.label.toUpperCase());
      b.setAttribute('aria-pressed', String(m.key === this.metric));
      b.onclick = () => { this.metric = m.key; this._render(); };
      mx.appendChild(b);
    });
    head.appendChild(mx);
    blk.appendChild(head);

    const has = comb !== null && comb !== undefined && isFinite(comb);
    const scale = Math.max(Math.abs(sum), has ? Math.abs(comb) : 0, 0.001);
    const wSum = Math.abs(sum) / scale * 100;
    const wComb = has ? Math.abs(comb) / scale * 100 : 0;

    const track = (label, w, cls, extra) => `
      <div class="wi-tk">
        <div class="lab"><span>${label}</span><span class="n ${cls}">${
      w === null ? '—' : dK(w.v)} K</span></div>
        <div class="tr">${extra}</div>
      </div>`;

    /* Where the void goes.
     *
     * It always sits on the SHORTER bar, running from its end to the longer
     * bar's end, because that is where the difference physically is. The first
     * version always drew it on the combined track, which was right for the
     * shortfall case and invisible for the other one: when the combination
     * beats its parts the combined bar is the full width, so a dashed overlay
     * landed on top of solid green and the most interesting finding on the pane
     * — that the measures reinforce rather than overlap — was drawn and could
     * not be seen. Deciding by length rather than by which row it is makes both
     * directions legible with one rule.
     *
     * The tone reads the direction: a shortfall is a neutral absence, an
     * over-delivery is drawn in the good tone because it is benefit that
     * arrived and the arithmetic did not predict. */
    const shortfall = has ? Math.abs(sum) - Math.abs(comb) : 0;   // >0 = less delivered
    const lo = Math.min(wSum, wComb);
    const hi = Math.max(wSum, wComb);
    const voidSeg = (has && hi - lo > 0.4)
      ? `<u class="${shortfall > 0 ? 'gap' : 'over'}" style="left:${lo.toFixed(1)}%;width:${
        (hi - lo).toFixed(1)}%"></u>` : '';

    blk.insertAdjacentHTML('beforeend', track('Sum of the parts', { v: sum }, 'flat',
      `<i class="neutral" style="width:${wSum.toFixed(1)}%"></i>${
        shortfall <= 0 ? voidSeg : ''}`));

    if (has) {
      blk.insertAdjacentHTML('beforeend', track('Re-solved together', { v: comb }, sign(comb),
        `<i class="${sign(comb)}" style="width:${wComb.toFixed(1)}%"></i>${
          shortfall > 0 ? voidSeg : ''}`));
      blk.appendChild(el('p', 'wi-gap', this._gapCopy(sum, comb, metric)));
      if (source) blk.appendChild(el('p', 'wi-note', source));
    } else {
      blk.insertAdjacentHTML('beforeend', track('Re-solved together', null, 'flat',
        `<u class="pend" style="left:0;width:${wSum.toFixed(1)}%"></u>`));
      blk.appendChild(el('p', 'wi-gap',
        running
          ? 'Solving the parts and the combination through the same engine, so both '
            + 'sides of the comparison come out in the same units.'
          : (pendingCopy || 'The parts are known. What they do together is not that '
            + 'number, and the only way to find out is to re-solve the combination.')));
      if (pending && this.live === false) {
        blk.appendChild(el('p', 'wi-note wi-warn',
          'THE COMBINATION CANNOT BE SOLVED IN THIS BUILD. IN THE PRECOMPUTED GRID '
          + 'THE FOUR MEASURES TOGETHER DELIVER ABOUT FOUR FIFTHS OF THEIR SUM ON THE '
          + 'ROADBED, SO A SUM OF PARTS IS AN OVER-STATEMENT OF ROUGHLY THAT ORDER'));
      }
    }
    return blk;
  }

  /** Name the gap, reading its sign rather than assuming one.
   *
   *  The interesting case is the one a brochure would never print: in the deep
   *  canyon the combination beats its parts on felt temperature, because
   *  shading the walls makes the canopy's shade a colder place to stand. Both
   *  directions are non-additivity and both are evidence that the engine
   *  re-solves. Only the shortfall direction gets the trees-and-pavement
   *  explanation, because that is the mechanism that produces it. */
  _gapCopy(sum, comb, metric) {
    const F = this.fmt;
    const gap = Math.abs(sum) - Math.abs(comb);
    const pctOf = Math.abs(sum) > 0.05 ? Math.abs(comb) / Math.abs(sum) : null;
    const what = metric.label === 'road' ? 'the roadbed'
      : metric.label === 'wall' ? 'the wall' : 'what a body on the pavement feels';
    if (Math.abs(gap) < 0.05) {
      return `On ${what} these measures happen to be very nearly additive here. `
        + 'They are not additive in general, and nothing in the arithmetic told us '
        + 'that — the model was re-solved to find out.';
    }
    if (gap > 0) {
      return `${F.num(Math.abs(gap), 1)} K of the sum is not delivered${
        pctOf ? `, so the combination is ${Math.round(pctOf * 100)}% of its parts` : ''}. `
        + 'Trees shade the pavement the cool coating was meant to fix, and neither '
        + 'measure gets credit twice for the same square metre. Adding coefficients '
        + 'would have missed this; re-solving finds it.';
    }
    return `The combination delivers ${F.num(Math.abs(gap), 1)} K MORE than its parts `
      + `on ${what}. Shading the walls makes the canopy's own shade a colder place to `
      + 'stand in, so the measures reinforce rather than overlap. Non-additivity has '
      + 'a sign, and it is not always a shortfall.';
  }

  // ---------------------------------------------------------- the re-solve

  _buildingRun(bin, ps) {
    const picked = ps.filter((p) => this.picked.has(p.key));
    const solvable = picked.filter((p) => MEASURE_SPEC[p.key]);
    const unsolvable = picked.filter((p) => MEASURE_SPEC[p.key] === null);
    const run = this.runs.building;
    const blk = el('div', 'wi-blk wi-run');

    blk.appendChild(el('span', 'wi-lab', 'AT STREET LEVEL, RE-SOLVED'));
    blk.appendChild(el('p', 'wi-why wi-dim',
      'The schedule above is a per-floor claim; this is the street the building '
      + 'stands on. Different quantities, so the two are never subtracted from one '
      + 'another.'));

    if (!picked.length) {
      blk.appendChild(el('p', 'wi-note', 'SELECT A MEASURE ABOVE TO RE-SOLVE IT'));
      return blk;
    }
    if (unsolvable.length) {
      blk.appendChild(el('p', 'wi-note wi-warn',
        `${esc(unsolvable.map((p) => shortTitle(p).toUpperCase()).join(', '))} `
        + `${unsolvable.length > 1 ? 'ARE' : 'IS'} EXCLUDED: `
        + 'THE CANYON SOLVER MODELS THE OUTSIDE OF THE ENVELOPE AND HAS NO LEVER FOR '
        + 'AN INDOOR OR GLAZING MEASURE'));
    }
    if (!solvable.length) {
      blk.appendChild(el('p', 'wi-note', 'NOTHING SELECTED CAN BE EXPRESSED AS A LEVER'));
      return blk;
    }

    const parts = solvable.map((p) => ({ key: p.key, title: shortTitle(p), spec: MEASURE_SPEC[p.key] }));
    blk.appendChild(this._runControl('building', {
      bins: [bin], parts, period: 'seasons', label: this._building(bin)?.addr || `BIN ${bin}`,
    }));
    blk.appendChild(this._runOutput('building', parts));
    return blk;
  }

  _streetRun(site) {
    const sel = PARTS.filter((k) => this.picked.has(k));
    if (!sel.length) return null;
    const blk = el('div', 'wi-blk wi-run');
    const street = String(site.name).replace(/\s+/g, ' ').trim();
    const parts = sel.map((k) => ({
      key: k, title: SHORT[k] || k, spec: MEASURE_SPEC[presetToMeasure(k)] || presetSpec(k),
    }));
    blk.appendChild(el('span', 'wi-lab', `RE-SOLVE ALL OF ${esc(street.toUpperCase())}`));
    blk.appendChild(el('p', 'wi-why wi-dim',
      'The grid above is three canyons. This solves every cross-section of the '
      + 'street the site sits on, so the answer comes with the spread across it — '
      + 'where the measure works, and where it does not.'));
    blk.appendChild(this._runControl('street', {
      streets: [street], parts, period: 'event', label: street,
    }));
    blk.appendChild(this._runOutput('street', parts));
    return blk;
  }

  /** The button, or the progress row, depending on state. */
  _runControl(slot, cfg) {
    const run = this.runs[slot];
    const wrap = el('div', 'wi-rc');
    if (run && (run.status === 'running')) {
      wrap.appendChild(this._progress(slot, run));
      return wrap;
    }
    const n = cfg.parts.length > 1 ? cfg.parts.length + 1 : 1;
    const b = el('button', 'wi-go');
    b.innerHTML = run?.status === 'error' ? 'TRY AGAIN'
      : `RE-SOLVE&nbsp; <span class="c">${n} SOLVE${n > 1 ? 'S' : ''}</span>`;
    b.onclick = () => this._start(slot, cfg);
    wrap.appendChild(b);
    if (n > 1) {
      const together = cfg.parts.length === 2 ? 'BOTH' : `ALL ${cfg.parts.length}`;
      wrap.appendChild(el('p', 'wi-note',
        `EACH MEASURE ALONE AND THEN ${together} TOGETHER, THROUGH THE SAME `
        + 'SOLVER SO BOTH SIDES OF THE COMPARISON ARE IN THE SAME UNITS<br>'
        + 'A SOLVE IS SECONDS, NOT MILLISECONDS'));
    }
    return wrap;
  }

  _progress(slot, run) {
    /* A real progress state. It counts wall time because wall time is what the
       person is spending; it names which job of how many because an n+1 stack
       is genuinely several solves and a single undifferentiated bar would make
       the wait look like a hang; and it can be stopped.

       The track is indeterminate because the engine does not report progress
       within a solve and inventing a percentage would be a lie told at sixty
       frames a second. Under prefers-reduced-motion the sheet stops the sweep
       and the elapsed figure carries the whole signal, which it can. */
    /* Tagged with its slot so the ten-hertz ticker can find this progress row
       and only this one. Two runs can be on screen at once — one from the
       building block and one from the disclosure — and an untagged querySelector
       updated whichever happened to be first in the document, which showed one
       run's elapsed time under the other run's heading. */
    const box = el('div', 'wi-prog');
    box.dataset.slot = slot;
    box.innerHTML = `
      <div class="lab">
        <span class="wi-lab">SOLVING ${run.job} OF ${run.total}${
      run.partName ? ` · ${esc(run.partName.toUpperCase())}` : ''}</span>
        <span class="el">${run.elapsed.toFixed(1)} s</span>
      </div>
      <div class="tr"><i></i></div>`;
    const stop = el('button', 'link', 'STOP');
    stop.onclick = () => this._cancel(slot);
    box.appendChild(stop);
    return box;
  }

  /** The result of the last run in this slot, rendered from state. */
  _runOutput(slot, parts) {
    const F = this.fmt;
    const run = this.runs[slot];
    const out = el('div', 'wi-out');
    if (!run) return out;

    if (run.status === 'error') {
      out.appendChild(el('p', 'wi-note wi-warn',
        `THE RE-SOLVE DID NOT RETURN&nbsp; · &nbsp;${esc(String(run.err || '').toUpperCase()).slice(0, 160)}`));
      out.appendChild(el('p', 'wi-why wi-dim',
        'The engine exists and the analyst can still reach it in prose; what is '
        + 'missing is the route to it. Everything above is precomputed and '
        + 'unaffected.'));
      return out;
    }
    if (run.status === 'cancelled') {
      out.appendChild(el('p', 'wi-note', 'STOPPED. THE SERVER MAY STILL BE SOLVING; '
        + 'THE ANSWER IS NO LONGER BEING WAITED FOR'));
      return out;
    }
    if (run.status !== 'done') return out;

    // --- the stacking comparison, both sides from the same solver
    const m = METRICS.find((x) => x.key === this.metric) || METRICS[2];
    if (run.parts && run.parts.length > 1 && run.combined) {
      const sum = run.parts.reduce((s, p) => s + (p.deltas?.[m.live]?.mean ?? 0), 0);
      out.appendChild(this._stackBlock({
        sum,
        comb: run.combined[m.live]?.mean,
        metric: m,
        source: `${run.total} RE-SOLVES · ${run.canyons || '—'} CANYONS · `
          + `${F.num(run.engineSeconds, 1)} S IN THE ENGINE`,
      }));
    }

    // --- the headline delta with its spread across canyons
    const c = run.combined || {};
    const grid = el('div', 'wi-kv');
    const kv = (k, v) => { grid.appendChild(el('div', 'k', k)); grid.appendChild(el('div', 'v', v)); };
    for (const mm of METRICS) {
      const s = c[mm.live];
      if (!s) continue;
      kv(mm.label.toUpperCase(), `<span class="${sign(s.mean)}">${dK(s.mean)} K</span>`
        + `<span class="sp">${dK(s.p10)} to ${dK(s.p90)}</span>`);
    }
    if (Object.keys(c).length) {
      out.appendChild(el('span', 'wi-lab', 'THE COMBINATION'));
      out.appendChild(grid);
      out.appendChild(el('p', 'wi-note',
        'MEAN CHANGE ACROSS THE CANYONS SOLVED, WITH THE 10TH TO 90TH PERCENTILE '
        + 'SPREAD BESIDE IT. A MEASURE WITH A WIDE SPREAD WORKS SOMEWHERE AND NOT '
        + 'SOMEWHERE ELSE, AND THE MEAN ALONE WOULD HIDE THAT'));
    }

    // --- the seasonal split, when more than one period was solved
    if (run.seasonal) {
      const s = run.seasonal;
      out.appendChild(el('span', 'wi-lab', 'THE SAME MEASURES IN JANUARY'));
      const t = el('table', 'wi-tab wi-yr');
      t.innerHTML = '<thead><tr><th></th><th>summer</th><th>winter</th><th>price</th></tr></thead>'
        + `<tbody><tr><td>Felt</td>${
          [s.summer_d_mrt_k, s.winter_d_mrt_k, s.seasonal_penalty_k]
            .map((v) => (v === null || v === undefined
              ? '<td class="flat">—</td>' : `<td class="${sign(v)}">${dK(v)}</td>`)).join('')
        }</tr><tr><td>Wall</td>${
          [s.summer_d_facade_k, s.winter_d_facade_k, null]
            .map((v) => (v === null || v === undefined
              ? '<td class="flat">—</td>' : `<td class="${sign(v)}">${dK(v)}</td>`)).join('')
        }</tr></tbody>`;
      out.appendChild(t);
      out.appendChild(el('p', 'wi-note',
        'FROM THE MONTHS ACTUALLY SOLVED, NOT FROM THE SUMMER ANSWER SCALED<br>'
        + 'A POSITIVE PRICE MEANS THE MEASURE DOES LESS GOOD IN WINTER, WHICH FOR '
        + 'SHADING AND CANOPY IS THE CORRECT SIGN AND IS WHAT IT COSTS'));
    }

    // --- who is behind the wall
    const pop = run.population;
    if (pop && pop.residential_units_behind_treated_wall) {
      out.appendChild(el('p', 'wi-note',
        `${F.num(pop.residential_units_behind_treated_wall)} RESIDENTIAL UNITS BEHIND `
        + `${F.num(pop.treated_wall_area_m2)} m² OF TREATED WALL`
        + (pop.person_degree_hours_avoided
          ? `<br>${F.num(Math.abs(pop.person_degree_hours_avoided))} PERSON DEGREE-HOURS `
            + `${pop.person_degree_hours_avoided < 0 ? 'ADDED' : 'AVOIDED'} A YEAR, `
            + 'PROJECTED ARITHMETICALLY FROM THE HOURS SOLVED' : '')));
    }

    // --- honest timing
    out.appendChild(el('p', 'wi-note wi-dim',
      `${run.total} SOLVE${run.total > 1 ? 'S' : ''} · ${F.num(run.elapsed, 1)} S WALL`
      + (isFinite(run.engineSeconds) ? ` · ${F.num(run.engineSeconds, 1)} S REPORTED BY THE ENGINE` : '')
      + (run.label ? `<br>FOR ${esc(String(run.label).toUpperCase())}` : '')
      + (run.stale ? '<br><b class="warnk">THE SELECTION HAS MOVED ON SINCE THIS RAN</b>' : '')));
    return out;
  }

  /** Start a run. `parts` longer than one means n+1 solves: each part alone and
   *  then the combination, so the stacking comparison is like for like. */
  async _start(slot, cfg) {
    const api = this.ctx?.api?.intervention;
    if (!api) { this.live = false; this._render(); return; }

    const token = ++this._token;
    const total = cfg.parts.length > 1 ? cfg.parts.length + 1 : 1;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const run = {
      status: 'running', job: 1, total, elapsed: 0, t0: performance.now(),
      partName: total > 1 ? cfg.parts[0].title : null,
      parts: [], combined: null, seasonal: null, population: null,
      engineSeconds: 0, canyons: null, token, ctrl,
      label: cfg.label, bins: cfg.bins ? [...cfg.bins] : null, stale: false,
    };
    this.runs[slot] = run;
    this._render();
    this._startTicker();

    const selector = cfg.bins ? { bins: cfg.bins } : { streets: cfg.streets };
    const jobs = [];
    if (total > 1) cfg.parts.forEach((p) => jobs.push({ name: p.title, spec: p.spec, key: p.key }));
    jobs.push({
      name: 'all together', key: '__all__',
      spec: Object.assign({}, ...cfg.parts.map((p) => p.spec)),
    });

    try {
      for (let i = 0; i < jobs.length; i++) {
        if (this._token !== token) return;
        run.job = i + 1;
        run.partName = jobs[i].name;
        /* The AbortSignal goes as the second argument, RAW.
         *
         * `ctx.api.intervention` is `(body, signal) => post(path, body, signal)`
         * and `post` hands it straight to `fetch` as `{ signal }`. Wrapping it
         * in an options object — `{ signal: ctrl.signal }` — was the first
         * version here and it would have made `fetch` throw a TypeError on
         * every single request, because a plain object is not an AbortSignal.
         * It is recorded because the failure would have looked like a broken
         * endpoint rather than like a broken call, and this pane's whole
         * fallback path is built to believe a rejection means the route is
         * missing. Passing it into the BODY is also wrong: a signal is not
         * JSON, and a key the server does not know could be refused by a
         * strict schema. A one-argument implementation ignores the extra
         * argument harmlessly. */
        const res = await api({
          ...selector, spec: jobs[i].spec, period: cfg.period, window: 'peak',
          max_canyons: 40,
        }, ctrl ? ctrl.signal : undefined);
        if (this._token !== token) return;

        /* Tolerant reading. DECISIONS section 8 specifies {deltas, per_canyon,
           seasonal, population, seconds}; the engine's own `run()` returns the
           same quantities under `overall` and `exposure_effect`. Accepting both
           costs three `||`s and removes an entire class of integration failure
           between two modules being written at the same time. */
        const deltas = res?.deltas || res?.overall || {};
        run.engineSeconds += Number(res?.seconds) || 0;
        run.canyons = res?.canyons_solved ?? res?.canyons ?? run.canyons;
        if (jobs[i].key === '__all__') {
          run.combined = deltas;
          run.seasonal = res?.seasonal || null;
          run.population = res?.population || res?.exposure_effect || null;
        } else {
          run.parts.push({ key: jobs[i].key, name: jobs[i].name, deltas });
        }
      }
      run.status = 'done';
      this.live = true;
    } catch (err) {
      if (this._token !== token) return;
      run.status = ctrl?.signal?.aborted ? 'cancelled' : 'error';
      run.err = err?.message || String(err);
      /* One failure is enough to know there is no route. It is set once and
         stays set for the session: retrying is a button, not a background
         poll. */
      if (run.status === 'error') this.live = false;
    } finally {
      if (this._token === token) {
        run.elapsed = (performance.now() - run.t0) / 1000;
        this._stopTicker();
        this._render();
      }
    }
  }

  _startTicker() {
    if (this._tick) return;
    /* Ten hertz. The elapsed figure is monospace and tabular so it does not
       jitter, and a tenth of a second is the finest division that reads as a
       measurement rather than as a flicker. */
    this._tick = setInterval(() => {
      let any = false;
      for (const k of Object.keys(this.runs)) {
        const r = this.runs[k];
        if (r?.status === 'running') {
          r.elapsed = (performance.now() - r.t0) / 1000;
          any = true;
          const prog = this.root?.querySelector(`.wi-prog[data-slot="${k}"]`);
          if (!prog) continue;
          const box = prog.querySelector('.el');
          if (box) box.textContent = `${r.elapsed.toFixed(1)} s`;
          const lab = prog.querySelector('.wi-lab');
          if (lab) {
            lab.textContent = `SOLVING ${r.job} OF ${r.total}`
              + (r.partName ? ` · ${r.partName.toUpperCase()}` : '');
          }
        }
      }
      if (!any) this._stopTicker();
    }, 100);
  }

  _stopTicker() { if (this._tick) { clearInterval(this._tick); this._tick = 0; } }

  /** Cancel.
   *
   *  Honest about what this does. The AbortController is passed to the api and
   *  will abort the fetch if the host threads it through; if it does not, the
   *  server keeps solving and we simply stop waiting for the answer. The token
   *  is the mechanism that actually guarantees the abandoned result can never
   *  land in the pane. The copy says "the server may still be solving" for
   *  exactly this reason. */
  _cancel(slot) {
    const run = this.runs[slot];
    if (!run || run.status !== 'running') return;
    this._token++;
    try { run.ctrl?.abort(); } catch { /* an aborted controller is not an error */ }
    run.status = 'cancelled';
    run.elapsed = (performance.now() - run.t0) / 1000;
    this._stopTicker();
    this._render();
  }

  _cancelAll() { Object.keys(this.runs).forEach((k) => this._cancel(k)); }

  // --------------------------------------------------- state 3: design your own

  /* The raw levers, behind a disclosure.
   *
   * Built once and never re-rendered. A pane that rebuilt its own sliders every
   * time the clock ticked would drop the thumb mid-drag, and the bug would look
   * like a broken slider rather than like a render loop, which is a long
   * afternoon.
   *
   * A lever is off until it is switched on, which is exactly the engine's own
   * semantics: a spec is the set of levers you pull and an omitted lever is
   * unchanged. Switching one on seeds it at the value the corresponding preset
   * uses, so the disclosure opens on a plausible measure rather than on a wall
   * with an albedo of 0.05. */

  _buildCustom() {
    const host = this.customEl;
    host.innerHTML = '';
    const head = el('button', 'wi-disc');
    head.setAttribute('aria-expanded', String(this.custom.open));
    head.innerHTML = '<span class="wi-lab">DESIGN YOUR OWN</span><span class="ch"></span>';
    head.onclick = () => {
      this.custom.open = !this.custom.open;
      head.setAttribute('aria-expanded', String(this.custom.open));
      body.hidden = !this.custom.open;
    };
    host.appendChild(head);

    const body = el('div', 'wi-blk wi-levers');
    body.hidden = !this.custom.open;
    host.appendChild(body);

    body.appendChild(el('p', 'wi-lede',
      'The physical levers behind every measure above. They compose: pull several '
      + 'and they are applied together and solved once, which is not the same as '
      + 'adding their separate effects.'));

    for (const L of LEVERS) body.appendChild(this._lever(L));

    // --- period. A single period returns no seasonal split, so the default is
    //     the four seasons: the winter column is the point and defaulting to a
    //     July-only answer would quietly drop it.
    const per = el('div', 'wi-per');
    per.appendChild(el('span', 'wi-lab', 'OVER'));
    const opts = [
      ['event', 'the heat wave', '1 period'],
      ['seasons', 'four seasons', '4 periods'],
      ['year', 'twelve months', '12 periods'],
    ];
    const grp = el('div', 'wi-seg');
    opts.forEach(([k, name, cost]) => {
      const b = el('button', null, `<span>${name}</span><span class="u">${cost}</span>`);
      b.setAttribute('aria-pressed', String(k === this.custom.period));
      b.onclick = () => {
        this.custom.period = k;
        [...grp.children].forEach((c, i) => c.setAttribute('aria-pressed', String(opts[i][0] === k)));
      };
      grp.appendChild(b);
    });
    per.appendChild(grp);
    body.appendChild(per);
    body.appendChild(el('p', 'wi-note',
      'TWELVE MONTHS IS TWELVE TIMES THE WORK AND IS THE ONLY SETTING THAT ANSWERS '
      + 'WHAT THE MEASURE COSTS IN JANUARY'));

    this.customRun = el('div', 'wi-crun');
    body.appendChild(this.customRun);
    this._renderCustomRun();
  }

  _lever(L) {
    const wrap = el('div', 'wi-sl');
    const on = () => this.custom.levers.has(L.key);

    const lab = el('div', 'lab');
    const tog = el('button', 'nm', esc(L.name));
    tog.setAttribute('aria-pressed', String(on()));
    const val = el('span', 'v');
    lab.appendChild(tog);
    lab.appendChild(val);
    wrap.appendChild(lab);

    const input = el('input');
    input.type = 'range';
    input.min = String(L.lo); input.max = String(L.hi); input.step = String(L.step);
    input.value = String(L.preset);
    input.setAttribute('aria-label', L.name);
    wrap.appendChild(input);

    const note = el('p', 'wi-lnote', esc(L.note));
    wrap.appendChild(note);

    const paint = () => {
      const active = on();
      wrap.classList.toggle('on', active);
      tog.setAttribute('aria-pressed', String(active));
      const v = Number(input.value);
      val.innerHTML = active ? esc(L.fmt(v)) : 'unchanged';
      input.disabled = !active;
      const p = (v - L.lo) / (L.hi - L.lo);
      input.style.setProperty('--p', `${(p * 100).toFixed(1)}%`);
      if (active) this.custom.levers.set(L.key, v);
      this._renderCustomRun();
    };
    tog.onclick = () => {
      if (on()) this.custom.levers.delete(L.key);
      else this.custom.levers.set(L.key, Number(input.value));
      paint();
    };
    input.oninput = () => { if (on()) this.custom.levers.set(L.key, Number(input.value)); paint(); };
    paint();
    return wrap;
  }

  _renderCustomRun() {
    if (!this.customRun) return;
    const host = this.customRun;
    host.innerHTML = '';
    const keys = [...this.custom.levers.keys()];
    if (!keys.length) {
      host.appendChild(el('p', 'wi-note', 'NO LEVER PULLED — NOTHING TO SOLVE'));
      return;
    }
    const bin = this._selectedBin();
    const parts = keys.map((k) => {
      const L = LEVERS.find((x) => x.key === k);
      return { key: k, title: L.name, spec: { [k]: this.custom.levers.get(k) } };
    });
    const where = bin
      ? { bins: [bin], label: this._building(bin)?.addr || `BIN ${bin}` }
      : { streets: [this._currentStreet()], label: this._currentStreet() };
    /* The spec, in the engine's own vocabulary and with the engine's own
       numbers. It is deliberately not prettified: this line is the payload that
       is about to be posted, and someone checking an answer against the analyst
       or against `interventions.py` needs to be able to read it as a spec. */
    host.appendChild(el('p', 'wi-note',
      `ON ${esc(String(where.label).toUpperCase())}&nbsp; · &nbsp;${
        esc(keys.map((k) => `${k}=${this.custom.levers.get(k)}`).join('  '))}`));
    host.appendChild(this._runControl('custom', { ...where, parts, period: this.custom.period }));
    host.appendChild(this._runOutput('custom', parts));
  }

  _currentStreet() {
    const S = this.ctx?.d?.scenarios;
    const site = S?.sites?.[Math.min(this.site, (S?.sites?.length || 1) - 1)];
    return String(site?.name || '').replace(/\s+/g, ' ').trim() || 'the study area';
  }
}

// ------------------------------------------------------------ small helpers

function cap(v) { return v ? v[0].toUpperCase() + v.slice(1) : v; }

/** A prescription's title for a table cell: the hand-written short name where
 *  there is one, and otherwise everything before the em dash. */
function shortTitle(p) {
  return PRESC_SHORT[p.key]
    || String(p.title || p.key).split(/\s*—\s*/)[0].replace(/ \(.*/, '');
}

/** A prescription's title for its own row, which keeps the construction detail
 *  because the face is the useful half of it — minus the floor range, which the
 *  line directly underneath already carries in its own column. Printing "floors
 *  6-26" twice in eleven vertical pixels made the row look like a rendering
 *  fault rather than like emphasis. */
function rowTitle(p) {
  return String(p.title || p.key).replace(/,\s*floors?\s+[\d–—-]+\s*$/i, '');
}

/** Uppercase a sentence for a mono note without carrying its full stop into it.
 *  The mono notes in this design are labels, not sentences, and a trailing
 *  period in a letter-spaced uppercase run reads as a stray mark. */
const shout = (s) => String(s || '').replace(/\s*\.\s*$/, '').toUpperCase();

function fmtLever(key, v) {
  const L = LEVERS.find((x) => x.key === key);
  return L ? L.fmt(v) : String(v);
}

/** The preset keys the scenario grid uses are the pipeline's names; the
 *  intervention engine's presets are nearly but not exactly the same set. This
 *  maps the grid's four elemental measures onto specs the engine will accept. */
function presetSpec(key) {
  return ({
    cool_roof: { roof_albedo: 0.70 },
    cool_pavement: { ground_albedo: 0.40 },
    street_trees: { tree_cover: 0.45 },
    facade_shading: { facade_shade: 0.35 },
  })[key] || {};
}

function presetToMeasure(key) { return key; }

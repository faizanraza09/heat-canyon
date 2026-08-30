/* The shared context the decision-layer surfaces are built against.
 *
 * WHY THIS FILE EXISTS
 *
 * Four surfaces were added to this interface at once — the floor schedule, the
 * what-if pane, the portfolio and the building brief. Each needs the same six
 * things: the loaded dataset, the decision products, the scene, the current
 * selection and time, a way to change them, and a way to render a number. Left
 * to themselves, four surfaces reach into `ui.js` for all six, and `ui.js`
 * stops being an interface and becomes a global.
 *
 * So the surfaces get an explicit object instead, and the rule is one-way:
 * `ui.js` builds this and hands it out; nothing that receives it writes to
 * `ui.js`'s DOM or reads its private state. A surface asks for a selection
 * change by calling `select()` and finds out it happened by listening for
 * `'select'` — the same way it would find out if the user had clicked the model.
 * That is what makes them independently testable, and it is why each of them
 * could be built against a hand-made `ctx` before this file was wired in.
 *
 * THE FORMATTERS ARE NOT A CONVENIENCE
 *
 * `fmt` is here rather than in each surface for one specific reason. Every
 * figure in the decision layer that passed through an assumption table — a wall
 * U-value, a window-to-wall ratio, a tariff, a capex band — is a RANGE, and the
 * project's credibility rests on it never being rendered as a midpoint. Four
 * surfaces each with their own `formatMoney` is four chances for one of them to
 * quietly average a range and print a single confident number. There is one
 * `fmt.range`, it is the only way a range reaches the screen, and it always
 * renders both ends.
 */

import { api } from './api.js';
/* An en dash between the ends of a range, and a non-breaking space before the
   unit. Both matter more than they look: a hyphen reads as a minus sign in a
   column of temperature deltas, and a range that wraps between its value and
   its unit at a 340px panel width reads as two numbers. */
const EN = '–';
const NB = ' ';

const num = (v, nd = 0) => (Number.isFinite(v)
  ? v.toLocaleString('en-US', { minimumFractionDigits: nd, maximumFractionDigits: nd })
  : '—');

/** Significant-figure rounding for money, which spans five orders of magnitude
 *  across this layer — a $9,000 roof coating and a $2.4M glazing retrofit are
 *  both ordinary, and neither wants the other's precision. */
function money1(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
}

export const fmt = {
  num,
  pct: (v, nd = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(nd)}%` : '—'),
  temp: (v, nd = 1) => (Number.isFinite(v) ? `${v.toFixed(nd)}${NB}°C` : '—'),
  /* `k` is KELVIN, and the plus sign is deliberate: these are deltas, and a
     measure that adds heat has to say so. It is NOT a "thousands" abbreviator,
     and the name invited exactly that reading once — the portfolio picked
     `fmt.k` up for a person-hour count and rendered 1,434,004 as "+1434004.3 K".
     `count` below is the compact one. The two are kept apart by name rather
     than by comment because a comment does not survive being copied. */
  k: (v, nd = 1) => (Number.isFinite(v)
    ? `${v > 0 ? '+' : ''}${v.toFixed(nd)}${NB}K` : '—'),

  /** A large count, abbreviated. 1,434,004 -> "1.43M"; 5,312 -> "5.3k". */
  count: (v) => {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
    return num(v);
  },
  kw: (v, nd = 1) => (Number.isFinite(v) ? `${num(v, nd)}${NB}kW` : '—'),
  kwh: (v) => (Number.isFinite(v)
    ? (Math.abs(v) >= 1000 ? `${num(v / 1000, 1)}${NB}MWh` : `${num(v)}${NB}kWh`)
    : '—'),
  money: money1,

  /** The one way an assumed range reaches the screen.
   *
   *  `range(4.1, 6.8, 'kW')` -> `4.1–6.8 kW`. A degenerate range renders as a
   *  single value, because `4.1–4.1 kW` is noise; anything else renders both
   *  ends, always. There is deliberately no option to collapse to a midpoint.
   *
   *  `how` selects the formatter for each end, so money ranges get money's
   *  significant figures and kelvin ranges get kelvin's. */
  range(lo, hi, unit = '', how = null) {
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) return '—';
    if (!Number.isFinite(hi) || lo === hi) return how ? how(lo) : `${num(lo, 1)}${unit ? NB + unit : ''}`;
    if (!Number.isFinite(lo)) return how ? how(hi) : `${num(hi, 1)}${unit ? NB + unit : ''}`;
    // Below half a percent apart the two ends are the same number to a reader
    // and printing both looks like an error rather than like precision.
    if (Math.abs(hi - lo) <= Math.abs(hi) * 0.005) {
      return how ? how(hi) : `${num(hi, 1)}${unit ? NB + unit : ''}`;
    }
    if (how) return `${how(lo)}${EN}${how(hi)}`;
    const nd = Math.abs(hi) < 10 ? 1 : 0;
    return `${num(lo, nd)}${EN}${num(hi, nd)}${unit ? NB + unit : ''}`;
  },

  /** A money range. Separate from `range` only so the call sites read as what
   *  they are; it is `range` with money's formatter. */
  moneyRange(lo, hi) { return fmt.range(lo, hi, '', money1); },
};

/** Wrap an assumed figure so the interface marks it as one.
 *
 *  The project labels every figure measured, reanalysis, modelled or composite.
 *  The decision layer adds a fourth and softer tier — `assumed` — and this is
 *  the whole treatment: a dotted underline in the mid-text tone, and a title
 *  naming the assumption it came through. Understated on purpose. A loud badge
 *  on every dollar figure would make the surface unreadable, and these surfaces
 *  are almost entirely dollar figures. */
export function assumed(html, why) {
  const t = String(why || 'Derived through a stated assumption table.')
    .replace(/"/g, '&quot;');
  return `<span class="asm" title="${t}">${html}</span>`;
}

/** Build the context handed to every decision surface.
 *
 *  `host` is the UI instance. It is passed rather than captured so the accessors
 *  read live state — a surface built at boot and shown twenty minutes later must
 *  see the hour the user is actually on, not the one they started at. */
export function makeContext(host) {
  const listeners = new Map();

  const ctx = {
    d: host.d,
    scene: host.scene,
    decision: host.d.decision,
    fmt,
    assumed,

    /* Live, not a snapshot. See above. */
    get state() {
      /* A selection comes in two shapes, and this used to understand only one.
       *
       * `showBuilding` selects a ranked building by its INDEX into
       * `ranked.items`, and any of the other 5,179 footprints by handing over
       * the building's own RECORD — because they have no index to hand over.
       * Reading `ranked.items[sel]` with a record for a subscript yields
       * undefined, so `selectedBin` came out null for 97% of the city: every
       * pane keyed on it behaved as though nothing were selected at all while a
       * building sat lit on screen with its card open beside them. The floor
       * schedule offered "Pick a building" at a building already picked, and
       * `openBrief` was handed null and opened nothing.
       *
       * Both shapes carry a bin; that is the thing every surface downstream
       * actually wants, so resolve it from whichever arrived. `selectedIndex`
       * stays strictly an index into the ranked list, and is null when the
       * selection is not in it — a record's position is not one. */
      const sel = host.selected;
      const item = typeof sel === 'number' ? host.d.ranked.items[sel]
        : (sel && typeof sel === 'object' ? sel : null);
      return {
        selectedIndex: typeof sel === 'number' ? sel : null,
        selectedBin: item && item.bin !== undefined && item.bin !== null
          ? String(item.bin) : null,
        hour: host.hour,
        day: host.d.time?.date || null,
        layer: host.layer,
        aggregate: host.aggregate || 'day',
      };
    },

    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => ctx.off(evt, fn);
    },
    off(evt, fn) { listeners.get(evt)?.delete(fn); },
    emit(evt, payload) {
      for (const fn of listeners.get(evt) || []) {
        // One surface throwing must not stop the others being told. A dead pane
        // is a bug; three dead panes because the first one threw is a bug that
        // takes an afternoon to find.
        try { fn(payload); } catch (e) { console.error(`ctx '${evt}' listener:`, e); }
      }
    },

    /** Ask the interface to select a building, by BIN or by ranked index. */
    select(binOrIndex) {
      if (binOrIndex === null || binOrIndex === undefined) {
        host.clearSelection();
        return;
      }
      let i = binOrIndex;
      if (typeof binOrIndex === 'string') {
        i = host.d.ranked.items.findIndex((it) => String(it.bin) === String(binOrIndex));
      }
      if (i >= 0) host.showDetail(i);
    },

    openBrief(bin) { host.openBrief(bin ?? ctx.state.selectedBin); },
    openPortfolio() { host.openPortfolio(); },

    /* ---------------------------------------------------------------- api

       The server side of the decision layer. Every one of these may legitimately
       be absent — a static export of this application has no Python behind it —
       so each rejects with a message a surface can show rather than throwing
       something only a console reader would understand. A surface that cannot
       reach the live engine falls back to the precomputed products and says so;
       none of them may present the absence as an error. */
    api: {
      intervention: (body, signal) => post('/api/intervention', body, signal),
      prescribe: (body, signal) => post('/api/prescribe', body, signal),
      portfolio: (query, signal) => get('/api/portfolio', query, signal),
      constants: (signal) => get('/api/constants', null, signal),
    },
  };

  return ctx;
}

async function post(path, body, signal) {
  const t0 = performance.now();
  const r = await fetch(api(path), {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return unwrap(r, path, t0);
}

async function get(path, query, signal) {
  const t0 = performance.now();
  const q = query ? `?${new URLSearchParams(query)}` : '';
  return unwrap(await fetch(api(path) + q, { signal }), path, t0);
}

async function unwrap(r, path, t0) {
  if (!r.ok) {
    // 404 is the ordinary case — a build without the server side — and it is
    // worth distinguishing from a real failure, because the two want different
    // sentences in front of the user.
    const kind = r.status === 404 ? 'not available in this build' : `HTTP ${r.status}`;
    const err = new Error(`${path} ${kind}`);
    err.status = r.status;
    err.absent = r.status === 404;
    throw err;
  }
  const out = await r.json();
  // Wall-clock, measured here rather than trusted from the payload: a re-solve
  // takes seconds and the surfaces show a real elapsed time. If the server also
  // reports its own, that one wins — it excludes the network.
  if (out && typeof out === 'object' && out.seconds === undefined) {
    out.seconds = (performance.now() - t0) / 1000;
  }
  return out;
}

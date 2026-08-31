/* The building brief: the one thing in this platform you can hand to someone.
 *
 * WHY THIS EXISTS
 *
 * Everything else here is built for exploration. You fly the model, you scrub
 * the day, you pick a building, you open the floor schedule and argue with it.
 * That is the right shape for the person doing the analysis and the wrong shape
 * for the person the analysis is for. An executive does three things with a
 * finding: reads the headline, decides where the money goes, and *circulates
 * something*. Until this module existed there was nothing to circulate — the
 * work only survived as a browser tab and a person willing to drive it.
 *
 * So this is a document, not a dashboard, and the distinction is load-bearing
 * in every layout decision below. It reads top to bottom rather than being
 * scanned in any order. It has a title, a date and a provenance footer. Its
 * prose is set at a reading measure of roughly 65 characters instead of running
 * the full width of a 1080px window. Its headings are real headings. The three
 * findings are paragraphs, because a paragraph can carry a *because* and a list
 * of fragments cannot, and the because is the whole value of the finding.
 *
 * A facilities manager should be able to print this, put it in front of a
 * board, and hand the same sheets to a contractor with the geometry and the
 * floor ranges already on them.
 *
 * WHAT IT IS A SIBLING OF
 *
 * The analyst (`agent.js`, `#analyst-win`) is a full-screen window over the
 * model, opened and dismissed with Escape. This is the second such window and
 * deliberately uses the identical mechanism: the same scrim, the same inset and
 * geometry, the same 240/320ms entrance on the shared easing, the same `.phead`
 * / `.picons` / `.icon` furniture in its header. Two windows that behave
 * differently would read as two applications. One difference, and it is a fix
 * rather than a divergence: this one traps Tab and restores focus to whatever
 * opened it, which the analyst does not yet do.
 *
 * WHAT IT MUST NOT DO
 *
 * It must not disagree with the selection card in `ui.js` about a single fact.
 * Both surfaces state this building's floors, height, year, homes, peak facade
 * temperature, hours above 35 and its two ranks. They therefore read the same
 * fields — `ranked.items[i]`, `buildings.attrs[i].pr_rank/apr_rank`, and
 * `ranked.n_scored` — rather than recomputing anything, and the prose in the
 * findings is templated from those same fields so the two cannot drift.
 *
 * It also does not follow the map. The selection can change underneath an open
 * brief and the document will not swap: a printed page and a live cursor are
 * different objects, and a document that rewrites itself while it is being read
 * is a bug wearing the clothes of a feature. The header names the building it
 * is about; reopening it on another building is one click.
 *
 * DEGRADATION
 *
 * Every part of `ctx.decision` is optional. With no floor schedule the shape of
 * the building section is dropped and nothing else changes; with no
 * prescriptions the "what to do" section says so in one line and the document
 * still prints. That is the contract in DECISIONS section 9 — a build with no
 * decision layer still produces a working atlas — applied one surface down.
 */

/* ------------------------------------------------------------------ helpers */

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** A date the way a document writes one: 29 August 2026. Never a slash format,
 *  which means two different things on two sides of the Atlantic. */
function longDate(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(+t)) return String(d ?? '');
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}`;
}

/** The same, from an ISO day string, without letting the local timezone move it
 *  back a day — `new Date('2026-07-31')` is midnight UTC and is 31 July in New
 *  York only by luck of the offset's sign. */
function isoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  if (!m) return String(s ?? '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* A scored building that is not one of the ranked 150, in the shape the ranked
 * ones arrive in.
 *
 * NOT A SECOND COMPUTATION, AND THAT IS THE WHOLE POINT
 *
 * `buildings.json`'s compact record carries the same quantities as
 * `ranked.json`, rounded identically, under short names — pipeline.py writes
 * both from the same `Exposure` in the same pass, and added the nine event
 * figures to the compact one precisely so a building outside the top 150 would
 * not open to nothing. This renames them back. Every figure a reader sees still
 * came off the pipeline; nothing here derives anything.
 *
 * Four fields have no compact equivalent: the Heat Vulnerability Index, the
 * annual facade maximum, and the pipeline's own `reasons` sentences. The
 * findings compose clause by clause and drop a clause whose field is missing, so
 * their absence costs those buildings one sentence each rather than a section.
 */
function scoredFromAttrs(a) {
  if (!a || !isNum(a.pr_rank)) return null;      // genuinely outside the scored set
  return {
    bin: a.bin, bbl: a.bbl, addr: a.addr, lon: a.lon, lat: a.lat,
    h: a.h, floors: a.floors, year: a.year, units: a.units, zip: a.zip,
    use: a.use, hvi: a.hvi, material: a.mat,
    exposure: a.ex, vulnerability: a.vu, priority: a.pr,
    measured: {
      exceedance_h: a.exc_h, persistence_h: a.per_h,
      peak_air_c: a.air_c, svf: a.svf,
    },
    modelled: {
      facade_peak_c: a.fac_c, facade_spread_k: a.fac_k,
      mrt_peak_c: a.mrt_c, wbgt_peak_c: a.wbgt_c,
      facade_solar_kwh: a.fac_kwh,
    },
    annual: {
      facade_kh35: a.akh, sun_hours: a.sunh, dose_kwh: a.adose,
      facade_max_c: a.afac_c, month_of_peak: a.mop, swing_k: a.swing,
      exposure: a.aex, priority: a.apr,
      basis: 'whole year, ERA5 bias-corrected anchor, analytic canyon shading '
        + '— see heatcanyon/tiers.py',
    },
    // The prose the ranked 150 carry is not on the compact record. The findings
    // fall back to it only when fewer than two composed clauses survive, and on
    // a scored building they do survive, so this is empty rather than absent.
    reasons: [],
    actions: [],
  };
}

/** 1st, 2nd, 3rd, 158th. A rank written "1th" is the kind of detail that costs
 *  a document its authority in the first paragraph. */
function ord(n) {
  const a = Math.abs(Math.round(n));
  const t = a % 100;
  if (t >= 11 && t <= 13) return `${a}th`;
  return `${a}${['th', 'st', 'nd', 'rd'][a % 10] || 'th'}`;
}

/* How many decimals a figure deserves, from its own magnitude. A window-to-wall
   ratio of 0.20–0.32 printed to one place becomes 0.2–0.3, which is not the
   assumption the model was given — the rounding has to follow the quantity. */
const dpOf = (lo, hi) => {
  const m = Math.max(Math.abs(lo), Math.abs(hi));
  const span = Math.abs(hi - lo);
  if (m < 1) return 2;                 // ratios: 0.20–0.32, not 0.2–0.3
  if (m < 10 || span < 5) return 1;    // an indoor range of 26.3–28.8 °C is not
  return 0;                            // 26–29 °C; the span decides, not the size
};
/** A `[lo, hi]` pair, in the order the interface will read it. */
const pair = (v) => (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]))
  ? (v[0] <= v[1] ? [v[0], v[1]] : [v[1], v[0]])
  : null;

/* ---------------------------------------------------------------- formatting

   `ctx.fmt` is the house style and is authoritative — DECISIONS section 9 makes
   it the single definition of how a range is written, precisely so that an
   assumed figure never appears as a bare midpoint in one surface and a range in
   another. But this module also has to survive being handed a partial `fmt` (a
   test harness, a host built before a formatter existed), and falling over
   because `fmt.pct` was missing would be a poor trade. So every formatter is
   taken from `ctx.fmt` when it is there and reimplemented here when it is not,
   and the fallbacks are written to match the house style rather than to invent
   a second one.                                                              */

function formatters(fmt = {}) {
  const num = fmt.num || ((v, d = 0) => (isNum(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—'));

  /* Dollars are rounded hard on purpose. A capex of $460,992 states a precision
     that a per-square-metre rate applied to a modelled area does not have, and
     printing it invites a reader to treat it as a quote. $461k is the same
     number with its real precision showing. */
  const money = fmt.money || ((v) => {
    if (!isNum(v)) return '—';
    const s = v < 0 ? '−' : '';
    const a = Math.abs(v);
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}k`;
    return `${s}$${num(Math.round(a))}`;
  });

  return {
    num,
    money,
    k: fmt.k || ((v, d = 1) => `${num(v, d)} K`),
    kw: fmt.kw || ((v, d = 0) => `${num(v, d)} kW`),
    kwh: fmt.kwh || ((v, d = 0) => `${num(v, d)} kWh`),
    temp: fmt.temp || ((v, d = 1) => `${num(v, d)} °C`),
    pct: fmt.pct || ((v, d = 0) => `${num(v * 100, d)}%`),
    /* The house form: `4.1–6.8 kW`. One unit, at the end, en dash between. */
    range: fmt.range || ((lo, hi, unit) => {
      const dp = dpOf(lo, hi);
      return `${num(lo, dp)}–${num(hi, dp)}${unit ? ` ${unit}` : ''}`;
    }),
  };
}

/* ============================================================== the document */

export class Brief {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.f = formatters(this.ctx.fmt);
    this.open_ = false;
    this.bin = null;
    this.root = null;
    this._restore = null;
    this._title = null;
    this._hideT = 0;
    this._onKey = this._onKey.bind(this);
  }

  /* ------------------------------------------------------------- the shell

     Built once, on first open, and appended to the body rather than to a host
     element. This is a window over the whole application, exactly like the
     analyst, so it belongs at the top of the document and not inside whichever
     panel happened to summon it.                                             */

  _ensure() {
    if (this.root) return;
    const r = el('div');
    r.id = 'brief';
    r.hidden = true;
    r.innerHTML = `
      <div id="brief-scrim"></div>
      <div id="brief-win" role="dialog" aria-modal="true" aria-labelledby="brief-title">
        <header class="phead">
          <div class="ptop">
            <span class="pname" id="brief-standing">BUILDING BRIEF</span>
            <div class="picons">
              <button id="brief-locate" class="icon" type="button"
                      title="Show this building on the model"
                      aria-label="Show this building on the model"><span class="g">MAP</span></button>
              <button id="brief-print" class="icon" type="button"
                      title="Print, or save as PDF"
                      aria-label="Print this brief"><span class="g">PRINT</span></button>
              <button id="brief-close" class="icon" type="button"
                      title="Close  ·  Esc"
                      aria-label="Close the brief"><span class="g">ESC</span></button>
            </div>
          </div>
        </header>
        <div id="brief-doc" tabindex="-1"></div>
      </div>`;
    document.body.appendChild(r);
    this.root = r;
    this.win = r.querySelector('#brief-win');
    this.doc = r.querySelector('#brief-doc');
    this.standing = r.querySelector('#brief-standing');

    r.querySelector('#brief-scrim').onclick = () => this.close();
    r.querySelector('#brief-close').onclick = () => this.close();
    r.querySelector('#brief-print').onclick = () => this.print();

    const locate = r.querySelector('#brief-locate');
    if (typeof this.ctx.select === 'function') {
      locate.onclick = () => { this.ctx.select(this.bin); this.close(); };
    } else {
      locate.remove();
    }
  }

  /* ------------------------------------------------------------ open / close */

  /** Open the brief for one building. `bin` may be omitted, in which case the
   *  current selection is used — the common case, since the control that opens
   *  this sits on the selected building's card. */
  open(bin) {
    const want = String(bin ?? this.ctx.state?.selectedBin ?? '');
    if (!want) return;
    this._ensure();

    // Remember what had focus before this took it. Restoring focus on Escape is
    // the difference between a dialog and a trap door: without it, dismissing
    // the brief drops the caret at the top of the document and a keyboard user
    // has to walk the whole interface back to where they were.
    if (!this.open_) this._restore = document.activeElement;

    this.bin = want;
    this._render(want);

    if (!this.open_) {
      this.root.hidden = false;
      // One frame later, so the entrance has a state to animate from. Same
      // reasoning, and the same numbers, as `ui.js` openAnalyst().
      requestAnimationFrame(() => this.root.classList.add('on'));
      document.body.classList.add('brief-open');
      document.addEventListener('keydown', this._onKey, true);
      this.open_ = true;
      clearTimeout(this._hideT);
      // Captured once, on the way in, so an open() that swaps the building does
      // not save the brief's own title as the one to restore.
      this._title = document.title;
      setTimeout(() => this.doc?.focus(), 220);
    }
    // The browser prints the document title in its own page header when someone
    // hits Ctrl-P rather than the control, so it is worth being right — and it
    // has to follow a building swap, not just the first open.
    document.title = `Building brief — ${this._b?.addr || `BIN ${want}`}`;
    this.doc.scrollTop = 0;
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.remove('on');
    document.body.classList.remove('brief-open');
    document.removeEventListener('keydown', this._onKey, true);
    if (this._title !== null) { document.title = this._title; this._title = null; }
    // Wait out the exit before leaving the layout, or it vanishes rather than
    // leaving. 260ms is the analyst's number and they should match.
    clearTimeout(this._hideT);
    this._hideT = setTimeout(() => { if (this.root) this.root.hidden = true; }, 260);
    const back = this._restore;
    this._restore = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
  }

  /* Point at a storey, or a run of them, in the floor chart.
   *
   * A cursor, not an encoding — the same distinction the worst-floor marker
   * already makes, and the reason both are allowed to be the accent while
   * nothing else data-adjacent is. It says "this is the row being talked
   * about"; it says nothing about the row's value.
   *
   * Drawn behind the bars rather than over them. A wash on top would tint three
   * measured colours, and a reader comparing a marked row against an unmarked
   * one below it would be comparing two different inks.
   *
   * Called with no argument it takes the cursor away. It is safe to call at any
   * time: a brief that has not rendered a chart yet has nothing to mark, which
   * is not an error, because the walkthrough asks for a floor on the same beat
   * that opens the document.
   */
  markFloors(lo = null, hi = null) {
    const svg = this.root?.querySelector('.brf-chart');
    const g = this._chartGeom;
    if (!svg) return;
    let m = svg.querySelector('.brf-cursor');
    if (lo === null || lo === undefined || !g) { m?.remove(); return; }
    const a = Math.min(lo, hi ?? lo), b = Math.max(lo, hi ?? lo);
    // The chart draws the top floor first, so a row's y is counted from the end.
    const iLo = g.floors.indexOf(a), iHi = g.floors.indexOf(b);
    if (iLo < 0 || iHi < 0) { m?.remove(); return; }
    const yTop = g.mt + (g.n - 1 - iHi) * g.rowH;
    const yBot = g.mt + (g.n - 1 - iLo) * g.rowH + g.rowH;
    if (!m) {
      m = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      m.setAttribute('class', 'brf-cursor');
      svg.insertBefore(m, svg.firstChild);
    }
    m.setAttribute('x', '0');
    m.setAttribute('width', String(g.W));
    m.setAttribute('y', String(yTop));
    m.setAttribute('height', String(Math.max(g.rowH, yBot - yTop)));
  }

  /** The print control, and the answer to the obvious "why not generate a PDF".
   *  A viewer-initiated file download is blocked outright in several of the
   *  contexts this application is embedded in, so a Save button that produced a
   *  file would work on the developer's machine and silently do nothing on a
   *  reviewer's. `window.print()` goes through the browser's own dialogue,
   *  which offers Save as PDF, and cannot be suppressed by an embedder. */
  print() { window.print(); }

  destroy() {
    clearTimeout(this._hideT);
    document.removeEventListener('keydown', this._onKey, true);
    document.body.classList.remove('brief-open');
    if (this._title !== null) { document.title = this._title; this._title = null; }
    this.root?.remove();
    this.root = null; this.win = null; this.doc = null;
    this.open_ = false;
  }

  /* Escape closes; Tab is trapped inside the window.
   *
   * Bound on `document` in the CAPTURE phase, which matters: `ui.js` binds its
   * shortcuts on `window` in the bubble phase, and an Escape that reached them
   * would close the brief AND clear the map selection, so the building the
   * document was about would be deselected behind it. Capturing and stopping
   * the event means the outer handler never sees it. */
  _onKey(e) {
    if (!this.open_) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = this._focusables();
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0];
    const last = f[f.length - 1];
    const a = document.activeElement;
    if (e.shiftKey && (a === first || a === this.doc || !this.win.contains(a))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && a === last) {
      e.preventDefault(); first.focus();
    }
  }

  _focusables() {
    return [...this.win.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((n) => !n.disabled && n.offsetParent !== null);
  }

  /* ------------------------------------------------------------- the render

     One pass, straight into a fragment, in reading order. There is no partial
     update path and there should not be: the document is a snapshot of one
     building at one moment, and every section is cheap to build.             */

  _render(bin) {
    const d = this.ctx.d || {};
    const dec = this.ctx.decision || {};

    // The ranked record is the spine of the document. Everything the selection
    // card states comes from here, so reading the same object is how the two
    // surfaces are kept from disagreeing.
    const idx = (d.ranked?.items || []).findIndex((x) => String(x.bin) === bin);
    const bi = d.binToIndex?.get?.(bin);
    const attr = (bi !== undefined && d.buildings?.attrs) ? d.buildings.attrs[bi] : null;
    // `ranked.json` carries the top 150 and no more, because widening it to all
    // 4,044 scored buildings would be a 16 MB payload for prose almost nobody
    // opens. The other 3,894 scored buildings are not unscored: they carry the
    // same figures on the compact record, which is exactly what those nine
    // numbers were added to buildings.json for. Reading only `ranked` here is
    // what had section 2 telling the owner of a scored building that there was
    // "no scored record, so no findings" over a page of its own measured data.
    const b = idx >= 0 ? d.ranked.items[idx] : scoredFromAttrs(attr);
    this._b = b || attr;

    /* The schedule, bundled or fetched.
     *
     * Only the ranked 150 are in `dec.floors`; every other building keeps its
     * own shard. Read from the bundle when it is there and render immediately —
     * the ranked buildings are the ones a reader opens most, and a document
     * that flickers on the way in is worse than one that is simply there. For
     * the rest, this pass renders the document without its schedule and then
     * re-renders once the shard lands, which is a repaint of a panel nobody has
     * begun reading yet.
     *
     * `_shardFor` guards against the re-render racing a second selection; see
     * below. */
    let sched = dec.floors?.items?.[bin] || null;
    let rx = dec.prescriptions?.items?.[bin] || null;
    if (!sched && this._shard?.bin === bin) {
      sched = this._shard.loads; rx = this._shard.rx;
    }
    if (!sched && typeof dec.floorsFor === 'function' && this._shardFor !== bin) {
      this._shardFor = bin;
      dec.floorsFor(bin).then((got) => {
        // Only if this is still the building on screen, and only if the fetch
        // actually found one — a miss must not loop us back through here.
        if (!got || this.bin !== bin || this._shard?.bin === bin) return;
        this._shard = { bin, loads: got.loads, rx: got.prescriptions || null };
        this._render(bin);
      });
    }

    this.standing.textContent = `BUILDING BRIEF · ${(b?.addr || attr?.addr || `BIN ${bin}`).toUpperCase()}`;

    const doc = el('article', 'brf');
    if (!b && !attr) {
      doc.appendChild(el('p', 'brf-empty',
        `No scored record for BIN ${esc(bin)}. This building is in the model’s `
        + 'geometry but outside the scored population, so there is nothing to brief.'));
      this.doc.innerHTML = '';
      this.doc.appendChild(doc);
      return;
    }

    doc.appendChild(this._masthead(b, attr));
    if (dec.fixture) doc.appendChild(this._fixtureBanner());
    doc.appendChild(this._secBuilding(b, attr, sched));
    doc.appendChild(this._secFindings(b, sched));
    if (sched) doc.appendChild(this._secSchedule(sched, dec));
    doc.appendChild(this._secActions(rx, b, dec));
    doc.appendChild(this._secBasis(b, sched, rx, dec));
    doc.appendChild(this._colophon());

    this.doc.innerHTML = '';
    this.doc.appendChild(doc);

    // The live constants table, if the host exposes the engine. It is fetched
    // after the first paint and folded into the basis section when it lands,
    // because a document that will not render until a network call returns is a
    // document that does not render on a train.
    this._loadConstants();
  }

  /* ------------------------------------------------------------- components */

  /** A mono label in the house register: 10px, uppercase, .12em. */
  _label(text) { return el('div', 'brf-lab', esc(text)); }

  /** A section, headed and numbered, with the print-only fixture marker that
   *  makes a placeholder page impossible to mistake for a real one no matter
   *  which sheet of it a reader is holding. */
  _sec(n, title) {
    const s = el('section', 'brf-sec');
    if (this.ctx.decision?.fixture) {
      s.appendChild(el('p', 'brf-fixrun',
        'PLACEHOLDER DATA — NOT FOR CIRCULATION. SEE “WHAT THIS RESTS ON”.'));
    }
    const h = el('h2', 'brf-h');
    h.innerHTML = `<span class="brf-hn">${esc(n)}</span>${esc(title)}`;
    s.appendChild(h);
    return s;
  }

  /** An assumed range, in the one house form, with the one house treatment.
   *
   *  `.asm` is the dotted underline described in app.css: an assumed figure is
   *  softer than a modelled one and the interface has to say so without
   *  shouting. Money is the one case that does not go through `fmt.range`,
   *  because the house form puts a single unit at the end and dollars carry
   *  their unit at the front — `460,992–893,172 USD` is not how anyone
   *  writes money. It is still an en dash between two ends and never a
   *  midpoint, which is the rule that actually matters. */
  _rng(lo, hi, unit) {
    if (!isNum(lo) || !isNum(hi)) return '<span class="brf-none">—</span>';
    /* An en dash between two negative numbers reads as a subtraction:
       `−$180k–−$40k` is not a range, it is a puzzle. The house form has no
       answer for a signed range, so this one is defined here — the word "to"
       between the ends — and it is used only when a sign is present, so every
       positive range still comes out in exactly the house form. */
    const signed = lo < 0 || hi < 0;
    let text;
    if (unit === '$') {
      const a = this.f.money(lo), b = this.f.money(hi);
      text = signed ? `${a} to ${b}` : `${a}–${b}`;
    } else if (signed) {
      const dp = dpOf(lo, hi);
      text = `${this.f.num(lo, dp)} to ${this.f.num(hi, dp)}${unit ? ` ${unit}` : ''}`
        .replace(/-/g, '\u2212');
    } else {
      text = this.f.range(lo, hi, unit);
    }
    return `<span class="asm" title="Assumed — a range, not a point estimate">${esc(text)}</span>`;
  }

  /** A point estimate that has no solved range. It gets the same soft treatment
   *  and says outright that no range exists, because the alternative — printing
   *  it like a modelled figure — is exactly the bare midpoint this document is
   *  not allowed to contain. */
  _pt(text) {
    return `<span class="asm" title="Assumed — a point estimate, no range solved">${esc(text)}</span>`;
  }

  /* ---------------------------------------------------------------- masthead */

  _masthead(b, attr) {
    const m = this.ctx.d?.meta || {};
    const addr = b?.addr || attr?.addr || `BIN ${this.bin}`;
    const head = el('header', 'brf-mast');
    head.appendChild(el('p', 'brf-kick', 'BUILDING BRIEF'));
    const h1 = el('h1', 'brf-title', esc(addr));
    h1.id = 'brief-title';
    head.appendChild(h1);

    const bits = [];
    bits.push(`BIN ${esc(this.bin)}`);
    if (b?.bbl) bits.push(`BBL ${esc(b.bbl)}`);
    const zip = b?.zip || attr?.zip;
    if (zip) bits.push(`${esc(m.aoi?.label || '')}${m.aoi?.label ? ', ' : ''}NY ${esc(zip)}`);
    head.appendChild(el('p', 'brf-sub', bits.join(' · ')));

    const lines = [`Prepared ${longDate(new Date())}`];
    if (m.event?.label) lines.push(`Event: ${esc(m.event.label)}`);
    if (m.year?.window) {
      lines.push(`Year: ${isoDate(m.year.window[0])} to ${isoDate(m.year.window[1])}`);
    }
    head.appendChild(el('p', 'brf-dateline', lines.join('<br>')));
    return head;
  }

  /* The standing warning. It is the first thing under the title and it is
     repeated once per section in print, because a printed page carrying
     placeholder numbers and no warning is the single most damaging artefact
     this platform could produce — it would look exactly like the real thing and
     it would outlive every caveat spoken over it. */
  _fixtureBanner() {
    const n = el('aside', 'brf-fixture');
    n.innerHTML = `
      <p class="brf-lab">PLACEHOLDER DATA</p>
      <p>The decision layer for this building is running on <b>fixture values</b>:
      the envelope assembly, the load estimates, the effect of each measure and
      every dollar figure below are placeholders written to exercise the
      interface, not results computed for this address. They are dimensionally
      plausible and they are not this building. Nothing on this page may be
      quoted, budgeted against or circulated until the layer is built from
      <span class="brf-mono">heatcanyon/envelope.py</span>,
      <span class="brf-mono">loads.py</span>,
      <span class="brf-mono">prescribe.py</span> and
      <span class="brf-mono">economics.py</span>. The physics above the decision
      layer — the facade temperatures, the exposure, the ranking — is
      solved and is not a fixture.</p>`;
    return n;
  }

  /* ------------------------------------------------- 1 · what this building is */

  _secBuilding(b, attr, sched) {
    const s = this._sec('1', 'What this building is');
    const d = this.ctx.d || {};
    const F = this.f;

    const floors = b?.floors ?? attr?.floors;
    const h = b?.h ?? attr?.h;
    const year = b?.year ?? attr?.year;
    const units = b?.units ?? attr?.units;

    const facts = [
      ['FLOORS', isNum(floors) ? F.num(floors) : '—'],
      ['HEIGHT', isNum(h) ? `${F.num(h)} m` : '—'],
      ['BUILT', year ? String(year) : '—'],
      ['HOMES', isNum(units) && units > 0 ? F.num(units) : 'none'],
      ['USE', b?.use_name || '—'],
      ['FACADE', b?.material ? String(b.material) : '—'],
    ];
    if (sched?.assembly) {
      facts.push(['ASSEMBLY', sched.assembly.label || sched.assembly.key || '—']);
    }
    if (sched?.occupancy) {
      facts.push(['OCCUPANCY', sched.occupancy.label || sched.occupancy.key || '—']);
    }

    const grid = el('div', 'brf-facts');
    for (const [k, v] of facts) {
      grid.appendChild(el('div', 'brf-fact',
        `<div class="brf-lab">${esc(k)}</div><div class="brf-val">${esc(v)}</div>`));
    }
    s.appendChild(grid);

    /* The two ranks. They are the same pair the selection card prints, over the
       whole scored population rather than over the sixty rows of the visible
       list — a rank out of the list reads as a rank out of 4,044 and is not. */
    const n = d.ranked?.n_scored;
    const wave = attr?.pr_rank;
    const yr = attr?.apr_rank;
    if (isNum(wave) && isNum(yr) && isNum(n)) {
      const ranks = el('div', 'brf-ranks');
      ranks.innerHTML = `
        <div class="brf-rank">
          <div class="brf-lab">HEAT-WAVE PRIORITY</div>
          <div class="brf-big">#${F.num(wave)}</div>
          <div class="brf-lab brf-of">OF ${F.num(n)} SCORED</div>
        </div>
        <div class="brf-rank">
          <div class="brf-lab">ANNUAL PRIORITY</div>
          <div class="brf-big">#${F.num(yr)}</div>
          <div class="brf-lab brf-of">OF ${F.num(n)} SCORED</div>
        </div>`;
      s.appendChild(ranks);
      s.appendChild(el('p', 'brf-p', this._rankProse(wave, yr, n)));
    }
    return s;
  }

  /** The sentence that makes the pair of ranks mean something. The two
   *  orderings are different questions — an acute event against a chronic year
   *  — and DECISIONS is explicit that where they disagree the disagreement is
   *  the finding, not noise to be averaged away. */
  _rankProse(wave, yr, n) {
    const F = this.f;
    const pctile = (r) => Math.max(0.1, (r / n) * 100);
    // Agreement is judged in percentiles, not in places. A gap of 157 places is
    // nothing at the bottom of a 4,044-building list and is the difference
    // between "worst in Midtown" and "top four per cent" at the top of it.
    const gap = Math.abs(pctile(wave) - pctile(yr));
    const lead = `Across ${F.num(n)} scored buildings in the study area this one ranks `
      + `<b>${ord(wave)} on the heat wave</b> and <b>${ord(yr)} on the year</b> `
      + `— the top ${F.num(pctile(wave), 1)}% of one ordering and the top `
      + `${F.num(pctile(yr), 1)}% of the other.`;
    if (gap < 2) {
      return `${lead} The two orderings agree closely here, which is the strongest `
        + 'case a building can make: it is a problem during an acute event and it is '
        + 'a problem for the other fifty-one weeks, so a measure taken for one is not '
        + 'borrowed from the other.';
    }
    return wave < yr
      ? `${lead} It scores higher on the event than on the year, so its problem is `
        + 'acute rather than chronic: relief during a wave — cooling, ventilation, '
        + 'shade at street level — buys more here than fabric does.'
      : `${lead} It scores higher on the year than on the event, so its problem is `
        + 'chronic rather than acute: fabric measures, which act on all 8,760 hours, '
        + 'buy more here than event relief does.';
  }

  /* ------------------------------------------------------ 2 · the three findings

     Written, not concatenated.

     `reasons` and `annual.reasons` arrive from the pipeline as complete
     sentences and the selection card prints them as a bulleted list, which is
     the right form for a 340px panel and the wrong one for a page. Joining them
     end to end would produce three clipped fragments with no argument running
     between them. So each finding is composed here from the SAME FIELDS those
     sentences are built from — never from a second computation — and the clauses
     are dropped individually when a field is missing. If too few survive to make
     a paragraph, the pipeline's own sentences are used verbatim as the fallback,
     which is worse prose and still true.                                      */

  _secFindings(b, sched) {
    const s = this._sec('2', 'The three findings');
    if (!b) {
      s.appendChild(el('p', 'brf-p', 'No scored record, so no findings.'));
      return s;
    }
    for (const fnd of this._findings(b, sched)) {
      const blk = el('div', 'brf-find');
      blk.innerHTML = `
        <div class="brf-findfig">
          <div class="brf-big">${fnd.fig}</div>
          <div class="brf-lab">${esc(fnd.figLab)}</div>
        </div>
        <div class="brf-findtext">
          <p class="brf-lab brf-findkick">${esc(fnd.kicker)}</p>
          <p class="brf-p">${fnd.prose}</p>
          ${fnd.basis ? `<p class="brf-basis">${esc(fnd.basis)}</p>` : ''}
        </div>`;
      s.appendChild(blk);
    }
    return s;
  }

  _findings(b, sched) {
    const F = this.f;
    const m = b.measured || {};
    const md = b.modelled || {};
    const a = b.annual || {};
    const meta = this.ctx.d?.meta || {};
    const out = [];

    /* --- one: the event. The measured field, seven days of it. */
    {
      const cl = [];
      const when = meta.event?.wave_start && meta.event?.wave_end
        ? `the seven-day event of ${isoDate(meta.event.wave_start)} to ${isoDate(meta.event.wave_end)}`
        : 'the heat wave';
      if (isNum(m.exceedance_h) && isNum(m.persistence_h)) {
        cl.push(`Across ${when} the air at this building stood above 35 °C for `
          + `<b>${F.num(m.exceedance_h, 1)} hours</b> in total, and the longest unbroken `
          + `run was <b>${F.num(m.persistence_h, 1)} hours</b> — long enough that the `
          + 'building never got a full overnight recovery window, which is the interval '
          + 'that decides whether a wave is survivable indoors.');
      } else if (isNum(m.exceedance_h)) {
        cl.push(`Across ${when} the air at this building stood above 35 °C for `
          + `<b>${F.num(m.exceedance_h, 1)} hours</b>.`);
      }
      if (isNum(m.peak_air_c) && isNum(md.facade_peak_c)) {
        cl.push(`Air at the base peaked at ${F.temp(m.peak_air_c)}; the hottest wall reached `
          + `<b>${F.temp(md.facade_peak_c)}</b>`
          + (isNum(md.facade_spread_k)
            ? `, ${F.k(md.facade_spread_k)} above the coolest face of the same building, so the `
              + 'exposure is one-sided — and so, usefully, is the remedy.'
            : '.'));
      }
      if (isNum(m.svf)) {
        cl.push(`The street outside sees ${F.pct(m.svf)} of the sky, so what the facade `
          + 'radiates at night it largely radiates at the wall opposite.');
      }
      out.push({
        kicker: 'FINDING ONE · THE EVENT',
        fig: isNum(m.persistence_h) ? `${F.num(m.persistence_h, 1)} h` : '—',
        figLab: 'LONGEST UNBROKEN RUN ABOVE 35 °C',
        prose: this._prose(cl, b.reasons, /^(Measured|Modelled|Measured geometry):/),
        basis: 'Measured FortyGuard temperature field over the event, and this project’s '
          + 'own ray-traced surface solve.',
      });
    }

    /* --- two: the year. A different claim on different evidence, and it is
       labelled as one: the event figures rest on a measured field, these rest on
       bias-corrected reanalysis run through the same physics. */
    if (isNum(a.facade_kh35) || isNum(a.sun_hours)) {
      const cl = [];
      if (isNum(a.sun_hours) && isNum(a.dose_kwh)) {
        cl.push(`Over the modelled year an average facade band takes `
          + `<b>${F.num(a.sun_hours)} hours</b> of direct sun and ${F.num(a.dose_kwh)} kWh/m² `
          + 'of shortwave.');
      }
      if (isNum(a.facade_kh35)) {
        cl.push(`Its walls accumulate <b>${F.num(a.facade_kh35)} kelvin-hours above 35 °C</b> `
          + '— modelled surface temperature, not air, and therefore a statement about '
          + 'what the fabric does to the rooms behind it rather than about the weather.');
      }
      if (isNum(a.facade_max_c) && isNum(a.month_of_peak)) {
        cl.push(`It peaks in ${MONTHS[a.month_of_peak - 1]} at ${F.temp(a.facade_max_c)}`
          + (isNum(a.swing_k)
            ? `, and swings ${F.k(a.swing_k)} between its summer and winter means; that swing `
              + 'is why a shading measure fitted for July carries a January cost, and why the '
              + 'cost is stated beside every measure below rather than left implied.'
            : '.'));
      }
      out.push({
        kicker: 'FINDING TWO · THE YEAR',
        fig: isNum(a.facade_kh35) ? `${F.num(a.facade_kh35)}` : '—',
        figLab: 'K·H ABOVE 35 °C ON THE FACADE, PER YEAR',
        prose: this._prose(cl, a.reasons),
        basis: a.basis || '',
      });
    }

    /* --- three: who is behind the wall. The reason any of this is worth
       spending money on, and the section a board reads first. */
    {
      const cl = [];
      const units = b.units;
      if (isNum(units) && units > 0) {
        cl.push(`<b>${F.num(units)} homes</b> sit behind these walls`
          + (b.year ? `, in a building put up in ${b.year}` : '')
          + (isNum(b.hvi) ? `, on a block the city rates ${F.num(b.hvi)} of 5 on its Heat `
            + 'Vulnerability Index' : '')
          + '.');
      }
      if (sched && isNum(sched.person_hours)) {
        cl.push(`Free-running and with no mechanical cooling assumed, the floor schedule `
          + `below puts <b>${F.num(sched.person_hours)} person-hours</b> a year above the `
          + '28 °C indoor threshold — an estimate, and the only honest way to state '
          + 'a resident’s exposure rather than a wall’s.');
      }
      if (isNum(md.mrt_peak_c) && isNum(m.peak_air_c)) {
        cl.push(`At street level the felt temperature is harsher than any air reading: `
          + `mean radiant temperature at the base peaks at ${F.temp(md.mrt_peak_c)}, `
          + `${F.k(md.mrt_peak_c - m.peak_air_c)} above the air`
          + (isNum(md.wbgt_peak_c)
            ? `, and the wet-bulb globe temperature of ${F.temp(md.wbgt_peak_c)} is past the `
              + '32 °C at which occupational guidance calls for outdoor work to stop.'
            : '.'));
      }
      out.push({
        kicker: 'FINDING THREE · WHO IS BEHIND THE WALL',
        fig: isNum(units) && units > 0 ? F.num(units) : '—',
        figLab: 'RESIDENTIAL UNITS',
        prose: this._prose(cl, (b.reasons || []).filter((r) => /^People:/.test(r))),
        basis: 'Homes and year of construction from PLUTO; vulnerability index from the '
          + 'city. Indoor exposure is an estimate — see section 5.',
      });
    }

    return out.slice(0, 3);
  }

  /** Join composed clauses into a paragraph, or fall back to the pipeline's own
   *  sentences when too few clauses survived to make one. */
  _prose(clauses, fallback, strip) {
    if (clauses.length >= 2) return clauses.join(' ');
    const raw = (fallback || []).slice(0, 3)
      .map((r) => esc(strip ? String(r).replace(strip, '').trim() : r));
    if (clauses.length === 1 && !raw.length) return clauses[0];
    if (!raw.length) return '<span class="brf-none">No finding recorded.</span>';
    return [...clauses, ...raw].join(' ');
  }

  /* -------------------------------------------------- 3 · the floor schedule

     Condensed on purpose. The full schedule is an interactive table with ten
     columns and one row per storey and it belongs in the instrument, not on a
     sheet of paper. What a reader needs from it here is the SHAPE: severity up
     the building, the height at which the dominant term stops being longwave
     trapped in the canyon and starts being direct sun on the wall, and which
     floor is worst. Those three facts decide which measure goes where, which is
     the only decision this section feeds.                                     */

  _secSchedule(sched, dec) {
    const s = this._sec('3', 'The floor schedule');
    const F = this.f;
    const rows = sched.floors || [];
    if (!rows.length) {
      s.appendChild(el('p', 'brf-p', 'No floor schedule for this building.'));
      return s;
    }

    const peak = pair(sched.peak_kw);
    const mwh = pair(sched.annual_mwh);
    const stats = el('div', 'brf-facts');
    const put = (k, v) => stats.appendChild(el('div', 'brf-fact',
      `<div class="brf-lab">${esc(k)}</div><div class="brf-val">${v}</div>`));
    put('PEAK ENVELOPE LOAD', peak ? this._rng(peak[0], peak[1], 'kW') : '—');
    put('ANNUAL', mwh ? this._rng(mwh[0], mwh[1], 'MWh') : '—');
    put('PEAK HOUR', isNum(sched.peak_hour_edt) ? `${String(sched.peak_hour_edt).padStart(2, '0')}:00 EDT` : '—');
    put('WORST FLOOR', isNum(sched.worst_floor) ? `${F.num(sched.worst_floor)}` : '—');
    s.appendChild(stats);

    s.appendChild(this._floorChart(rows, sched));

    // The three sentences the chart is evidence for.
    const swap = this._swap(rows);
    const worst = rows.find((r) => r.f === sched.worst_floor) || null;
    const bands = dec.floors?.bands;
    const p = [];
    if (swap) {
      p.push(`The dominant term swaps at <b>floor ${F.num(swap.at.f)}</b>, `
        + `${F.num(swap.at.z_lo)} m above the base: below it the excess is `
        + `${this._termWord(swap.from)}, above it ${this._termWord(swap.to)}. `
        + 'That height is the boundary between the two measures below, and it is why '
        + 'one measure does not cover this building.');
    } else {
      p.push(`Every floor is dominated by the same term, ${this._termWord(rows[0].dom)}, `
        + 'from the pavement to the roof, so a single measure family covers the building.');
    }
    if (worst) {
      const tin = pair(worst.t_in);
      p.push(`The worst floor is <b>${F.num(worst.f)}</b>, at ${F.temp(worst.t_surf)} on the `
        + `wall${tin ? ` and an estimated ${this._rng(tin[0], tin[1], '°C')} indoors` : ''}`
        + `${isNum(worst.hrs) ? `, ${F.num(worst.hrs)} hours a year above the 28 °C indoor threshold` : ''}.`);
    }
    if (isNum(bands) && bands > 0) {
      // The band note has to survive both ends of the building stock. A
      // 26-storey tower puts two or three storeys in each of ten bands; a
      // one-storey taxpayer has fewer storeys than there are bands, and telling
      // its reader it has "two or three storeys per band" would discredit the
      // page on the one sentence whose whole job is candour about resolution.
      const per = rows.length / bands;
      const word = (k) => ['no', 'one', 'two', 'three', 'four', 'five'][k] || F.num(k);
      const how = per <= 1
        ? 'so every storey here sits in a band of its own or shares one with none'
        : `so a ${F.num(rows.length)}-storey building puts `
          + `${word(Math.floor(per))} or ${word(Math.ceil(per))} storeys in each`;
      p.push(`The solve carries ${F.num(bands)} vertical bands, ${how}: the `
        + 'schedule is drawn per storey but resolves per band, and the flat runs in the '
        + 'chart are that, not a coincidence.');
    }
    s.appendChild(el('p', 'brf-p', p.join(' ')));
    return s;
  }

  _termWord(dom) {
    if (dom === 'trap') return '<b>longwave trapped in the canyon</b> — the wall opposite '
      + 'radiating back what it absorbed';
    if (dom === 'solar') return '<b>direct solar</b> on the wall';
    return '<b>ambient air</b>, which no facade measure reaches';
  }

  /** The first floor at which the dominant term stops being the ground floor's. */
  _swap(rows) {
    const from = rows[0]?.dom;
    for (const r of rows) {
      if (r.dom && r.dom !== from) return { at: r, from, to: r.dom };
    }
    return null;
  }

  /* The chart. One row per storey, and three things on it.
   *
   * A diverging bar was chosen over a stacked one because the three attribution
   * terms are not three parts of a whole: two of them heat the wall and the
   * third cools it, and a stack would have to either drop the sky term or draw
   * relief as if it were load. So the axis is zero kelvin, gain runs right and
   * the sky's relief runs left, and the crossover the section is about — solar
   * overtaking trapped longwave partway up — appears as a boundary that moves,
   * which is a shape a reader sees before reading a number.
   *
   * Colour is the causal palette from app.css, not the temperature ramp. These
   * are three CAUSES, and painting them in the ramp would invite reading them as
   * three temperatures. Severity is the separate single-hue ramp for the same
   * reason. Both are aliased through this module's own custom properties so the
   * print sheet can re-ink them in one place.
   */
  _floorChart(rows, sched) {
    const F = this.f;
    const wrap = el('figure', 'brf-fig');
    const n = rows.length;

    const W = 640;
    const rowH = n > 40 ? 7 : (n > 26 ? 9 : 11);
    const mt = 26, mb = 22;
    const H = mt + n * rowH + mb;

    const xNum = 22;        // right edge of the floor number
    const xSev = 27;        // severity swatch
    const x0 = 41;          // left edge of the bar field
    const x1 = 470;         // right edge of the bar field
    const xTxt = W - 2;     // the per-band annotation, right-aligned to the edge

    let gain = 0, relief = 0;
    for (const r of rows) {
      gain = Math.max(gain, (r.solar || 0) + (r.trap || 0));
      relief = Math.max(relief, Math.abs(Math.min(0, r.sky || 0)));
    }
    const span = Math.max(0.5, gain + relief);
    const px = (x1 - x0) / span;
    const zero = x0 + relief * px;

    const parts = [];
    // The zero axis and its two ticks.
    parts.push(`<line class="brf-ax" x1="${zero}" y1="${mt - 8}" x2="${zero}" y2="${H - mb + 4}"/>`);
    parts.push(`<text class="brf-axt" x="${zero}" y="${mt - 12}" text-anchor="middle">0 K</text>`);
    parts.push(`<text class="brf-axt" x="${x1}" y="${mt - 12}" text-anchor="end">+${gain.toFixed(0)} K GAIN</text>`);
    parts.push(`<text class="brf-axt" x="${x0}" y="${mt - 12}" text-anchor="start">−${relief.toFixed(0)} K TO SKY</text>`);

    let lastBand = null;
    rows.forEach((r, i) => {
      // Drawn top floor first: a building reads upwards and a chart of it must
      // too, or floor 26 sits at the bottom of the page and every reader has to
      // invert it in their head.
      const row = n - 1 - i;
      const y = mt + row * rowH;
      const yc = y + rowH / 2;
      const bh = Math.max(3, rowH - 3);
      const by = yc - bh / 2;

      if (r.band !== lastBand) {
        if (lastBand !== null) {
          parts.push(`<line class="brf-band" x1="${xNum + 3}" y1="${y + rowH}" x2="${x1}" y2="${y + rowH}"/>`);
        }
        lastBand = r.band;
      }

      parts.push(`<text class="brf-fnum" x="${xNum}" y="${yc + 3}" text-anchor="end">${r.f}</text>`);
      const sev = Math.max(0, Math.min(4, r.sev | 0));
      // The hairline matters: the lowest severity quintile is a 10%-alpha
      // wash, and without an outline a building that sits in it looks like a
      // building whose severity failed to render.
      parts.push(`<rect class="brf-sw" x="${xSev}" y="${by}" width="6" height="${bh}" `
        + `fill="var(--brf-sev-${sev})" stroke="var(--brf-rule-soft)" stroke-width="0.6"/>`);

      const sky = Math.abs(Math.min(0, r.sky || 0)) * px;
      if (sky > 0.2) {
        parts.push(`<rect x="${(zero - sky).toFixed(1)}" y="${by}" width="${sky.toFixed(1)}" `
          + `height="${bh}" fill="var(--brf-term-sky)"/>`);
      }
      const solar = Math.max(0, r.solar || 0) * px;
      const trap = Math.max(0, r.trap || 0) * px;
      if (solar > 0.2) {
        parts.push(`<rect x="${zero.toFixed(1)}" y="${by}" width="${solar.toFixed(1)}" `
          + `height="${bh}" fill="var(--brf-term-solar)"/>`);
      }
      if (trap > 0.2) {
        parts.push(`<rect x="${(zero + solar).toFixed(1)}" y="${by}" width="${trap.toFixed(1)}" `
          + `height="${bh}" fill="var(--brf-term-trap)"/>`);
      }
    });

    // The per-band indoor estimate, printed once where the band starts rather
    // than repeated down every storey in it: the model has band resolution and
    // the page should not imply otherwise by repetition.
    lastBand = null;
    rows.forEach((r, i) => {
      if (r.band === lastBand) return;
      lastBand = r.band;
      const row = n - 1 - i;
      const y = mt + row * rowH;
      const tin = pair(r.t_in);
      if (!tin) return;
      parts.push(`<text class="brf-rowt" x="${xTxt}" y="${y + rowH - 2}" text-anchor="end">`
        + `${F.num(tin[0], 1)}–${F.num(tin[1], 1)} °C indoors`
        + `${isNum(r.hrs) ? ` · ${F.num(r.hrs)} h` : ''}</text>`);
    });

    // The worst floor, marked in the accent — the one place data-adjacent colour
    // is allowed to be the accent, because this is a cursor onto a row rather
    // than an encoding of a value.
    const worst = rows.findIndex((r) => r.f === sched.worst_floor);
    if (worst >= 0) {
      const y = mt + (n - 1 - worst) * rowH + rowH / 2;
      // In the outer margin, left of the floor number. It used to sit between
      // the number and the severity swatch, which is fine until the building
      // is in the top severity quintile — that swatch is the accent, and an
      // accent marker beside an accent swatch marks nothing.
      parts.push(`<path class="brf-mark" d="M 2 ${y - 3.4} L 8 ${y} L 2 ${y + 3.4} Z"/>`);
    }

    wrap.innerHTML = `
      <svg class="brf-chart" viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Attribution of facade heat by storey: direct solar and trapped longwave against relief to the sky">
        ${parts.join('\n')}
      </svg>`;

    /* The chart's own geometry, kept so `markFloors` can find a storey in it
     * later. Recomputing it there would mean duplicating the row height rule
     * and the top-floor-first inversion, and two copies of an inversion is one
     * copy too many: the day the chart changes its row height, the cursor
     * silently points three storeys off. */
    this._chartGeom = { mt, rowH, n, W, floors: rows.map((r) => r.f) };

    const legend = el('figcaption', 'brf-legend');
    legend.innerHTML = `
      <span class="brf-key"><i style="background:var(--brf-term-solar)"></i>DIRECT SOLAR</span>
      <span class="brf-key"><i style="background:var(--brf-term-trap)"></i>TRAPPED LONGWAVE</span>
      <span class="brf-key"><i style="background:var(--brf-term-sky)"></i>RELIEF TO SKY</span>
      <span class="brf-key"><i class="brf-acc"></i>WORST FLOOR</span>
      <span class="brf-key brf-sevkey">SEVERITY
        <i style="background:var(--brf-sev-0)"></i><i style="background:var(--brf-sev-1)"></i><i
          style="background:var(--brf-sev-2)"></i><i style="background:var(--brf-sev-3)"></i><i
          style="background:var(--brf-sev-4)"></i></span>`;
    wrap.appendChild(legend);
    return wrap;
  }

  /* -------------------------------------------------------- 4 · what to do

     The section the document exists for, and the one given the most room.

     A recommendation without a geometry, an extent, a floor range and a price is
     a topic rather than a decision. So every measure here carries all four, plus
     the two things a contractor's quote will never volunteer: what it costs in
     January, and which floors it leaves untouched.                             */

  _secActions(rx, b, dec) {
    const s = this._sec('4', 'What to do');
    const F = this.f;

    if (!rx || !rx.length) {
      // Fall back to the building-level threshold catalogue, which exists for
      // every scored building even where the decision layer does not reach.
      const acts = b?.actions || [];
      if (!acts.length) {
        s.appendChild(el('p', 'brf-p',
          'No prescription has been generated for this building. The measure catalogue '
          + 'is threshold-triggered and this building crosses none of the thresholds that '
          + 'trigger one.'));
        return s;
      }
      s.appendChild(el('p', 'brf-p',
        'The per-face, per-floor prescription layer has not been built for this building. '
        + 'What follows is the building-level catalogue: the right family of measure, '
        + 'without the geometry, the extent or the price.'));
      for (const a of acts) {
        const blk = el('div', 'brf-presc brf-presc-thin');
        blk.innerHTML = `
          <h3 class="brf-ph">${esc(a.title)}</h3>
          <p class="brf-p">${esc(a.rationale)}</p>
          ${a.effect ? `<p class="brf-p brf-dim">${esc(a.effect)}</p>` : ''}
          ${a.programme ? `<p class="brf-lab">${esc(String(a.programme).toUpperCase())}</p>` : ''}`;
        s.appendChild(blk);
      }
      return s;
    }

    const total = rx.reduce((acc, p) => {
      const c = pair(p.money?.capex_usd);
      if (c) { acc[0] += c[0]; acc[1] += c[1]; acc.n++; }
      return acc;
    }, [0, 0]);
    total.n = rx.reduce((k, p) => k + (pair(p.money?.capex_usd) ? 1 : 0), 0);

    s.appendChild(el('p', 'brf-p',
      `${rx.length === 1 ? 'One measure is' : `${['', 'One', 'Two', 'Three', 'Four', 'Five'][rx.length] || rx.length} measures are`} `
      + 'specified for this building. They are chosen by the attribution rather than by a '
      + 'temperature threshold, which is the reason they differ from floor to floor: two '
      + 'walls at the same temperature for two different reasons need two different '
      + 'measures.'
      + (total.n === rx.length
        ? ` Taken together they carry a capital cost of ${this._rng(total[0], total[1], '$')}.`
        : '')));

    rx.forEach((p, i) => s.appendChild(this._presc(p, i + 1)));

    if (typeof this.ctx.openPortfolio === 'function') {
      const foot = el('p', 'brf-chrome brf-portlink');
      const btn = el('button', 'brf-link', 'SET THIS AGAINST THE REST OF THE PORTFOLIO');
      btn.type = 'button';
      btn.onclick = () => { this.close(); this.ctx.openPortfolio(); };
      foot.appendChild(btn);
      s.appendChild(foot);
    }
    return s;
  }

  /* The reasoning for a measure, in the parts it was written in.
   *
   * prescribe.py composes this out of four or five separate claims — how hot
   * this floor runs and what is driving it, which face carries the load, how the
   * device was sized, what simpler device was rejected on the way, and what
   * overrode the geometry's own choice — and it used to arrive here as a single
   * paragraph with every one of them run together. At 65ch that is a dozen
   * unbroken lines in which the projection a contractor came for is
   * indistinguishable from the argument around it, and the reader has to hold
   * five threads at once to find the one they want.
   *
   * They are five answers to five questions, so they are set as five. The prose
   * is kept as the fallback: a brief rendered against a prescriptions.json built
   * before the parts existed still has to say something.                      */
  _why(p) {
    const parts = (Array.isArray(p.why_parts) ? p.why_parts : [])
      .filter((x) => Array.isArray(x) && x[1]);
    if (!parts.length) return p.why ? `<p class="brf-p">${esc(p.why)}</p>` : '';
    return `<div class="brf-why">${parts.map(([label, text]) => {
      // The sizing part is an equation. Set in the body face it reads as a
      // sentence that happens to contain symbols; the label says which part it
      // is, so nothing here has to guess from the text.
      const kind = String(label).toLowerCase() === 'sizing' ? ' brf-wsum' : '';
      return `<div class="brf-wpart${kind}">`
        + `<p class="brf-lab brf-wlab">${esc(label)}</p>`
        + `<p class="brf-p">${esc(text)}</p></div>`;
    }).join('')}</div>`;
  }

  _presc(p, n) {
    const F = this.f;
    const blk = el('div', 'brf-presc');
    /* The standing warning again, print-only. Section 4 is the one section that
       reliably runs to several pages — a measure per sheet, which is how a
       contractor wants it — so the section's own marker only reaches the first
       of them. A sheet naming a floor range, an area and a price is exactly the
       sheet that must not travel without its caveat. */
    const fixrun = this.ctx.decision?.fixture
      ? '<p class="brf-fixrun">PLACEHOLDER DATA — NOT FOR CIRCULATION. '
        + 'SEE “WHAT THIS RESTS ON”.</p>' : '';
    const g = p.geometry || {};
    const e = p.effect || {};
    const mo = p.money || {};

    // --- the spec line: what a contractor needs before anything else.
    const spec = [];
    if (p.device) spec.push(p.device.toUpperCase());
    // Units keep their own case inside an otherwise uppercase line. "1.50 M"
    // is not a length and "1,441 M²" is not an area; the label register does
    // not get to overrule SI.
    if (isNum(g.projection_m)) spec.push(`${F.num(g.projection_m, 2)} m PROJECTION`);
    if (isNum(g.fin_spacing_m)) spec.push(`${F.num(g.fin_spacing_m, 2)} m FIN SPACING`);
    if (isNum(g.window_head_m)) spec.push(`${F.num(g.window_head_m, 1)} m WINDOW HEAD`);
    if (isNum(g.shgc_target)) spec.push(`SHGC ${F.num(g.shgc_target, 2)}`);
    if (isNum(g.albedo_from) && isNum(g.albedo_to)) {
      spec.push(`ALBEDO ${F.num(g.albedo_from, 2)} → ${F.num(g.albedo_to, 2)}`);
    }
    if (p.faces?.length) spec.push(`${p.faces.join(', ').toUpperCase()} FACE${p.faces.length > 1 ? 'S' : ''}`);
    if (Array.isArray(p.floors)) {
      spec.push(p.floors[0] === p.floors[1]
        ? `FLOOR ${p.floors[0]}` : `FLOORS ${p.floors[0]}–${p.floors[1]}`);
    }
    if (isNum(p.area_m2)) spec.push(`${F.num(p.area_m2)} m² TREATED`);
    if (p.lead_time) spec.push(String(p.lead_time).toUpperCase());

    blk.innerHTML = `
      ${fixrun}
      <h3 class="brf-ph"><span class="brf-pn">${n}</span>${esc(p.title || p.key || 'Measure')}</h3>
      <p class="brf-spec">${esc(spec.join('  ·  '))}</p>
      ${this._why(p)}`;

    // --- what it buys.
    const eff = [];
    const push = (k, v) => eff.push([k, v]);
    if (isNum(e.d_facade_peak_k)) {
      // The sign is in the label rather than on the number: a reader scanning a
      // grid of figures should not have to notice a minus to know which way a
      // measure moves the wall.
      push(e.d_facade_peak_k <= 0 ? 'PEAK FACADE COOLER BY' : 'PEAK FACADE WARMER BY',
        this._pt(`${F.num(Math.abs(e.d_facade_peak_k), 1)} K`));
    }
    const kwh = pair(e.d_annual_kwh);
    if (kwh) {
      const dir = kwh[1] <= 0 ? 'SAVED' : (kwh[0] >= 0 ? 'ADDED' : 'NET');
      push(`ANNUAL ENERGY ${dir}`,
        this._rng(Math.min(Math.abs(kwh[0]), Math.abs(kwh[1])),
          Math.max(Math.abs(kwh[0]), Math.abs(kwh[1])), 'kWh'));
    }
    const kw = pair(e.d_peak_kw);
    if (kw) {
      push('PEAK DEMAND CUT',
        this._rng(Math.min(Math.abs(kw[0]), Math.abs(kw[1])),
          Math.max(Math.abs(kw[0]), Math.abs(kw[1])), 'kW'));
    }
    if (isNum(e.d_person_hours)) {
      push('PERSON-HOURS AVOIDED', this._pt(F.num(Math.abs(e.d_person_hours))));
    }
    const win = pair(e.d_winter_kwh);
    if (win) {
      const penalty = win[1] > 0;
      push(penalty ? 'WINTER HEATING PENALTY' : 'WINTER HEATING SAVED',
        this._rng(Math.min(Math.abs(win[0]), Math.abs(win[1])),
          Math.max(Math.abs(win[0]), Math.abs(win[1])), 'kWh'));
    }
    if (eff.length) {
      blk.appendChild(this._label('WHAT IT BUYS'));
      const grid = el('div', 'brf-facts brf-tight');
      for (const [k, v] of eff) {
        grid.appendChild(el('div', 'brf-fact',
          `<div class="brf-lab">${esc(k)}</div><div class="brf-val">${v}</div>`));
      }
      blk.appendChild(grid);
    }

    // --- what it costs. Kept in its own block and in its own colour, because a
    // dollar is not a temperature and must never borrow the ramp.
    const cash = [];
    const capex = pair(mo.capex_usd);
    if (capex) cash.push(['CAPITAL COST', this._rng(capex[0], capex[1], '$'), 'cost']);
    const en = pair(mo.energy_usd_yr);
    if (en) cash.push(['ENERGY SAVED, PER YEAR', this._rng(en[0], en[1], '$'), 'money']);
    // The demand charge, which on SC-9 is usually the LARGER half of the saving
    // and was missing from this grid for a while. Leaving it out did not just
    // understate the case, it made the card fail to add up: simple payback is
    // computed on energy + demand + LL97, so a reader dividing the capital cost
    // by the two lines shown got several times the number printed beside them.
    // economics.py keeps the two apart precisely so the interface can say which
    // one is carrying a measure; this is the interface holding up its end.
    const dm = pair(mo.demand_usd_yr);
    if (dm) cash.push(['PEAK DEMAND AVOIDED, PER YEAR', this._rng(dm[0], dm[1], '$'), 'money']);
    const ll = pair(mo.ll97_usd_yr);
    if (ll) cash.push(['LL97 PENALTY AVOIDED', this._rng(ll[0], ll[1], '$'), 'money']);
    // The heating-season penalty, in the COST colour, sitting with the three
    // lines it is subtracted from rather than under the January prose below.
    // A solar-control measure rejects January's beam as efficiently as July's,
    // and the prose has always said so while the money silently did not: simple
    // payback was computed on the summer side alone. Priced only where it was
    // computed from the measure's own lever -- economics.py returns (0, 0) for
    // an inferred one, so a zero here means unquantified, not free, and the
    // caveat column says which.
    const wi = pair(mo.winter_usd_yr);
    if (wi && (wi[0] || wi[1])) {
      cash.push(['WINTER HEAT PENALTY', this._rng(wi[0], wi[1], '$'), 'cost']);
    }
    const co2 = pair(mo.carbon_t_yr);
    if (co2) cash.push(['CARBON AVOIDED', this._rng(co2[0], co2[1], 't/yr'), 'money']);
    const pb = pair(mo.payback_yr);
    if (pb) cash.push(['SIMPLE PAYBACK', this._rng(pb[0], pb[1], 'yr'), '']);
    else if (mo.payback_yr === null) cash.push(['SIMPLE PAYBACK', 'never, on energy alone', '']);
    const npv = pair(mo.npv_usd);
    if (npv) cash.push(['NET PRESENT VALUE', this._rng(npv[0], npv[1], '$'), npv[1] > 0 ? 'money' : 'cost']);

    if (cash.length) {
      blk.appendChild(this._label('WHAT IT COSTS'));
      const grid = el('div', 'brf-facts brf-tight');
      for (const [k, v, tone] of cash) {
        grid.appendChild(el('div', 'brf-fact',
          `<div class="brf-lab">${esc(k)}</div>`
          + `<div class="brf-val${tone ? ` brf-${tone}` : ''}">${v}</div>`));
      }
      blk.appendChild(grid);
    }

    // --- the two honest columns.
    const caveats = el('div', 'brf-caveats');
    if (p.winter_cost) {
      caveats.appendChild(el('div', 'brf-caveat',
        `<div class="brf-lab">WHAT IT COSTS IN JANUARY</div>`
        + `<p class="brf-p">${esc(p.winter_cost)}</p>`));
    }
    if (p.does_not_fix) {
      caveats.appendChild(el('div', 'brf-caveat',
        `<div class="brf-lab">WHAT IT DOES NOT FIX</div>`
        + `<p class="brf-p">${esc(p.does_not_fix)}</p>`));
    }
    if (caveats.children.length) blk.appendChild(caveats);

    const tail = [];
    if (p.programme?.length) {
      tail.push(`<span class="brf-lab">FUNDING</span> ${esc(p.programme.join(' · '))}`);
    }
    if (p.also_consider?.length) {
      tail.push(`<span class="brf-lab">ALSO CONSIDER</span> `
        + esc(p.also_consider.map((k) => String(k).replace(/_/g, ' ')).join(' · ')));
    }
    const prov = [];
    if (p.confidence) prov.push(`confidence: ${p.confidence}`);
    if (e.source) prov.push(`effect source: ${e.source}`);
    if (mo.basis) prov.push(`money: ${mo.basis}`);
    if (prov.length) tail.push(`<span class="brf-lab">PROVENANCE</span> ${esc(prov.join(' · '))}`);
    if (tail.length) blk.appendChild(el('p', 'brf-tail', tail.join('<br>')));

    return blk;
  }

  /* ------------------------------------------------ 5 · what this rests on

     Not buried, and not softened. The credibility of the whole project is in
     whether this section is exact, because every figure above it is only worth
     what its labelling is worth. It states the assumptions actually used for
     THIS building — not a generic methodology note — with their sources and the
     date the constants were last set.                                         */

  _secBasis(b, sched, rx, dec) {
    const s = this._sec('5', 'What this rests on');
    const F = this.f;

    s.appendChild(el('p', 'brf-p',
      'A modelled figure and an assumed figure are different kinds of claim and this '
      + 'document does not mix them. Facade temperatures, solar dose, sunlit hours, the '
      + 'canyon geometry and both rankings are <b>solved</b>: ray-traced against LiDAR '
      + 'roof profiles and a measured temperature field. Indoor temperatures, loads in '
      + 'watts, the effect of each measure and <b>every dollar figure on this page are '
      + 'assumed</b> — they follow from an envelope no one has surveyed and a cost '
      + 'table no one has re-quoted. An assumed figure is written as a range with a '
      + '<span class="asm">dotted underline</span>, and it is softer than a modelled one. '
      + 'Read the money as an order of magnitude that decides a sequence, never as a '
      + 'budget line.'));

    const rows = [];
    const A = sched?.assembly;
    if (A) {
      const u = pair(A.u_wall), w = pair(A.wwr), g = pair(A.shgc);
      const src = A.source || A.note || '—';
      if (u) rows.push(['Wall U-value', this._rng(u[0], u[1], 'W/m²K'), src]);
      if (w) rows.push(['Window-to-wall ratio', this._rng(w[0], w[1], ''), src]);
      if (g) rows.push(['Glazing SHGC', this._rng(g[0], g[1], ''), src]);
      if (A.label) rows.push(['Assembly', esc(A.label), A.note || src]);
    }
    const O = sched?.occupancy;
    if (O) {
      const bits = [];
      if (isNum(O.persons)) bits.push(`${F.num(O.persons, 1)} persons per home`);
      if (isNum(O.setpoint_c)) bits.push(`${F.temp(O.setpoint_c)} setpoint`);
      if (O.overnight !== undefined) bits.push(O.overnight ? 'occupied overnight' : 'daytime only');
      rows.push(['Occupancy', esc(bits.join(', ')), esc(O.label || O.key || '—')]);
    }
    if (sched) {
      rows.push(['Indoor temperature',
        'free-running, no mechanical cooling assumed',
        'steady-state balance of envelope gain, ventilation and internal gain — '
        + 'an estimate, not a dynamic building simulation']);
      if (sched.basis) rows.push(['Floor schedule', '—', esc(sched.basis)]);
    }
    if (dec.floors?.severity_basis) {
      rows.push(['Severity stripe', '0–4', esc(dec.floors.severity_basis)]);
    }
    if (dec.floors?.bands) {
      rows.push(['Vertical resolution', `${F.num(dec.floors.bands)} bands`,
        'storeys are mapped to solved bands; the schedule does not have storey resolution']);
    }
    const money0 = rx?.[0]?.money;
    if (money0?.basis) rows.push(['Cost basis', '—', esc(money0.basis)]);
    if (dec.prescriptions?.constants_as_of) {
      const v = String(dec.prescriptions.constants_as_of);
      rows.push(['Constants as of',
        /^\d{4}-\d{2}-\d{2}/.test(v)
          ? esc(isoDate(v))
          : `<span class="brf-warnv">${esc(v)} — no date set</span>`,
        'tariff, grid carbon intensity, LL97 cap and penalty, discount rate, measure life']);
    }
    if (dec.prescriptions?.unverified !== undefined) {
      const u = dec.prescriptions.unverified;
      rows.push(['Unverified constants',
        u < 0 ? '<span class="brf-warnv">not reported</span>' : `<span class="brf-warnv">${F.num(u)}</span>`,
        'every constant ships unverified until it is sourced; Local Law 97’s cap and '
        + 'penalty in particular must be checked against the live rule before any figure '
        + 'here is quoted']);
    }
    const bs = b?.annual?.basis;
    if (bs) rows.push(['Annual physics', '—', esc(bs)]);

    if (rows.length) {
      const tbl = el('table', 'brf-table');
      tbl.innerHTML = `
        <thead><tr><th>QUANTITY</th><th>VALUE</th><th>SOURCE</th></tr></thead>
        <tbody>${rows.map(([k, v, src]) =>
          `<tr><td class="brf-tk">${esc(k)}</td><td class="brf-tv">${v}</td>`
          + `<td class="brf-ts">${src}</td></tr>`).join('')}</tbody>`;
      s.appendChild(tbl);
    }

    // Filled in later if the engine answers. Kept as a stable node so the async
    // result has somewhere to land without re-rendering the section.
    this._constHost = el('div', 'brf-consts');
    s.appendChild(this._constHost);
    return s;
  }

  /** The live constants table, when the host exposes the engine. Optional, and
   *  failure is silent by design: the static basis table above already states
   *  everything this adds detail to, and a dead endpoint should not put an error
   *  on a document someone is about to print. */
  async _loadConstants() {
    const call = this.ctx.api?.constants;
    if (typeof call !== 'function' || !this._constHost) return;
    const host = this._constHost;
    let table = null;
    try {
      const r = await call();
      table = Array.isArray(r) ? r : (Array.isArray(r?.constants) ? r.constants : null);
    } catch { return; }
    if (!table?.length || host !== this._constHost) return;
    host.appendChild(this._label('THE CONSTANTS TABLE ACTUALLY USED'));
    const tbl = el('table', 'brf-table');
    tbl.innerHTML = `
      <thead><tr><th>CONSTANT</th><th>VALUE</th><th>SOURCE</th><th>AS OF</th></tr></thead>
      <tbody>${table.map((c) => {
        const v = Array.isArray(c.value) ? this._rng(c.value[0], c.value[1], c.unit || '')
          : `${esc(this.f.num(c.value, Math.abs(c.value) < 10 ? 3 : 0))}${c.unit ? ` ${esc(c.unit)}` : ''}`;
        const ok = c.verified === true;
        return `<tr><td class="brf-tk">${esc(c.key || '')}</td><td class="brf-tv">${v}</td>`
          + `<td class="brf-ts">${esc(c.source || '—')}${ok ? '' : ' <span class="brf-warnv">(unverified)</span>'}</td>`
          + `<td class="brf-ts">${esc(c.as_of || '—')}</td></tr>`;
      }).join('')}</tbody>`;
    host.appendChild(tbl);
  }

  /* ------------------------------------------------------------- colophon */

  _colophon() {
    const m = this.ctx.d?.meta || {};
    const f = el('footer', 'brf-colophon');
    const bits = [];
    if (m.aoi?.label) {
      bits.push(`${m.aoi.label} · ${m.aoi.area_km2} km² · `
        + `${this.f.num(m.counts?.buildings_scored || 0)} buildings scored`);
    }
    if (m.surface_model?.source) bits.push(`Surface model: ${m.surface_model.source}`);
    if (m.generated) bits.push(`Model generated ${longDate(m.generated)}`);
    const fix = this.ctx.decision?.fixture
      ? '<p class="brf-lab brf-fixfoot">PLACEHOLDER DATA — NOT FOR CIRCULATION</p>' : '';
    f.innerHTML = `
      ${fix}
      <p class="brf-lab">THE URBAN CANYON — BUILDING BRIEF</p>
      <p class="brf-basis">${esc(bits.join('. '))}${bits.length ? '.' : ''}</p>
      <p class="brf-basis">This document states what a model computed. It is not a
      survey, an energy audit or an engineering specification, and no measure on it
      should be let to contract without one.</p>`;
    return f;
  }
}

export default Brief;

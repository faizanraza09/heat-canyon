/* The programme.
 *
 * WHY THIS SURFACE EXISTS
 *
 * Nobody spends money one building at a time. The instrument scores 4,044
 * buildings, ranks 150 of them in the right-hand panel, and then stops — which
 * leaves the reader holding a list and no way to turn it into a decision. A
 * list answers "who is worst". A programme answers "what do we do in the next
 * twelve months, in what order, for how much". Those are different questions
 * and the second one is the one that gets funded.
 *
 * So this view holds four things the ranking cannot.
 *
 *   1. THE COST CURVE. Every candidate — a building crossed with a measure —
 *      ordered by marginal cost per person-hour of exposure avoided, with a
 *      budget line you drag. Everything left of the line is the programme.
 *      It is the most executive-legible object this platform can produce,
 *      because it is the one picture in which "we can afford this much" and
 *      "this is what that buys" are the same gesture.
 *
 *   2. THE TABLE. All of it, filterable, sortable, and out of the browser as a
 *      CSV, because the person who has to defend the number will want it in a
 *      spreadsheet by tomorrow morning and a screenshot is not a deliverable.
 *
 *   3. TWO OBJECTIVES SIDE BY SIDE. `allocate_budget` implements four ways of
 *      ranking the same candidates, and its most valuable output is not any one
 *      of them — it is the disagreement between two. Efficiency and equity pull
 *      apart, and today that trade-off is being made implicitly by whoever
 *      picked the sort order. Showing both columns and naming the buildings that
 *      appear under one and not the other makes it a choice somebody is seen to
 *      make. This project already performs exactly this move once, where the
 *      heat-wave ranking and the annual ranking disagree and `ui.js` prints the
 *      overlap rather than hiding it. This is that idea again, on money.
 *
 *   4. PHASING AND THE LEDGER. Grouping the funded programme by when it can
 *      START — this season, one year, capital cycle — is what turns a list into
 *      a plan; a cool roof you can paint in August and a facade retrofit that
 *      waits for the capital cycle are not the same commitment even at the same
 *      price. And one generated paragraph, in the serif, saying what the whole
 *      thing buys. That paragraph is the sentence that goes in the deck.
 *
 * WHAT IT IS A SIBLING OF
 *
 * The analyst window. Same scrim, same inset, same 4px window on the same
 * hairline, same Escape, opened over the model rather than inside a 366px
 * column, for the same reason: a chart, a 407-row table and two ranked columns
 * are the evidence for a spending decision, and evidence you cannot read is
 * decoration. It differs from the analyst in two ways, both deliberate: it traps
 * focus and restores it to whatever opened it, and it takes the keyboard on the
 * capture phase the way the tour does, so the host's own shortcuts — space to
 * play the day, the arrows to walk the hours — cannot fire underneath a view
 * that binds the arrows to the budget line.
 *
 * A NOTE ON EVERY DOLLAR ON THIS SCREEN
 *
 * Not one of them is measured. Capex, energy saved and carbon avoided all came
 * out of an assumption table with a low and a high, and the cost curve is drawn
 * on the midpoints because a curve needs one number per candidate. That is a
 * drawing convention, not a claim, and it is stated on the screen rather than in
 * a footnote: every assumed figure in this view is rendered as its range with
 * the `.asm` treatment, and the budget line's own reading says plainly that a
 * line set on midpoints commits a range of real capital that straddles it. A
 * bare midpoint anywhere in here is a bug.
 */

/* ------------------------------------------------------------------ helpers */

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
  return n;
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mid = (r) => (Array.isArray(r) ? (r[0] + r[1]) / 2 : Number(r) || 0);

/* The four objectives, in the register the rest of the interface uses: a name
 * that is a name, and one sentence that says what the number MEANS rather than
 * how it was computed. The subtitles matter more here than anywhere else in the
 * application, because the whole section exists to make somebody notice that
 * choosing between these two words is choosing between two programmes. */
const OBJECTIVES = {
  person_hours: {
    label: 'Person-hours',
    gloss: 'Hours of exposure avoided, counted once per person behind the wall.',
  },
  degree_hours: {
    label: 'Degree-hours',
    gloss: 'Total heat load removed from the fabric, regardless of who lives behind it.',
  },
  vulnerable: {
    label: 'Vulnerability',
    gloss: 'The same hours, weighted up where people can least cope with them.',
  },
  peak_relief: {
    label: 'Peak relief',
    gloss: 'Kilowatts taken off the worst hour, which is what the grid feels.',
  },
};

/* Lead time, in the order a plan is actually written: what can start now, what
 * needs a year, and what waits for the capital cycle. The data carries these as
 * free strings; the map is here so an unrecognised one still sorts last rather
 * than disappearing. */
const PHASES = [
  { key: 'this season', label: 'This season', note: 'Can start inside the current cooling season.' },
  { key: 'one year', label: 'One year', note: 'Design, procure and install inside twelve months.' },
  { key: 'capital cycle', label: 'Capital cycle', note: 'Waits for a scheduled envelope or roof replacement.' },
];

const MEASURE_LABEL = {
  cool_roof: 'Cool roof',
  fixed_shading: 'Fixed shading',
  exterior_insulation: 'Exterior insulation',
  night_purge: 'Night purge',
};
const measureLabel = (k) => MEASURE_LABEL[k]
  || String(k || '').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/* ---------------------------------------------------------------- the class */

export class Portfolio {
  /**
   * @param {object} ctx the shared context described in DECISIONS §9. Every
   *   field is treated as optional: this view has to come up against a host
   *   that is still being written, and a missing formatter or a missing scene
   *   must degrade one line, never throw.
   */
  constructor(ctx) {
    this.ctx = ctx || {};
    this.d = this.ctx.d || {};
    this.decision = this.ctx.decision || {};
    this.data = this._data();

    this.fmt = this._formatters();

    this.isOpen = false;
    this.live = null;              // null = not yet asked, true/false = answered
    this.liveNote = '';

    // The two objectives under comparison. Chosen in _pickPair() from what the
    // data actually says rather than hard-coded, for reasons documented there.
    const pair = this._pickPair();
    this.objA = pair[0];
    this.objB = pair[1];
    this.pairNote = pair[2];

    this.scaleMode = 'log';
    this.budget = this._defaultBudget();
    this.hoverIdx = null;
    this.dragging = false;

    this.sort = { key: 'usd_per_person_hour', dir: 1 };
    this.filters = { measure: '', lead: '', q: '', fundedOnly: false };
    this.page = 0;
    /* Twenty-five rows, which is about one windowful.
     *
     * Forty was the first number and it was wrong for a reason worth recording:
     * a sticky table header cannot work here. `.pftable-wrap` carries
     * `overflow-x: auto` so a narrow window can scroll the columns sideways, and
     * that makes IT the nearest scrolling ancestor — so `position: sticky` on a
     * `th` sticks to a box that never scrolls vertically and the header simply
     * leaves with the rest of the table. Rather than nest a second vertical
     * scroller inside a window that already scrolls, the page is short enough
     * that the header is rarely far away. Anyone who wants all four hundred
     * rows at once has the CSV. */
    this.pageSize = 25;

    this._build();
    this._bind();
  }

  /* ------------------------------------------------------------ the dataset

     `ctx.decision.portfolio` is the static product written by the pipeline. The
     candidates carry their own ordering keys, and `curves` carries one index
     order per objective, so nothing here has to re-derive an objective it does
     not own the definition of — this view reads the orderings the model
     produced and never invents one. */

  _data() {
    const p = this.decision.portfolio || {};
    const candidates = Array.isArray(p.candidates) ? p.candidates : [];
    const curves = p.curves && typeof p.curves === 'object' ? p.curves : {};
    // A dataset with candidates but no curves is still usable: the candidates
    // carry `usd_per_person_hour`, which is the ordering key for the default
    // objective, so one curve can always be reconstructed.
    if (!curves.person_hours && candidates.length) {
      curves.person_hours = candidates
        .map((_, i) => i)
        .sort((a, b) => (candidates[a].usd_per_person_hour || 0) - (candidates[b].usd_per_person_hour || 0));
    }
    const objectives = (Array.isArray(p.objectives) ? p.objectives : Object.keys(curves))
      .filter((o) => Array.isArray(curves[o]) && curves[o].length);
    const total = candidates.reduce((s, c) => s + mid(c.capex), 0);
    return {
      candidates,
      curves,
      objectives: objectives.length ? objectives : Object.keys(curves),
      disagreement: p.disagreement || null,
      constants: Array.isArray(p.constants) ? p.constants : [],
      n: p.n ?? candidates.length,
      fixture: !!(this.decision.fixture || p.fixture),
      total,
      buildings: new Set(candidates.map((c) => String(c.bin))).size,
    };
  }

  /* Formatters. `ctx.fmt` is the house style and is used wherever it exists;
     these are the fallbacks, so a harness or a host that has not wired the
     shared formatters yet still renders correct-looking figures instead of
     `[object Object]`. They are deliberately the same shapes the rest of the
     interface uses: money abbreviates, counts group, everything is en-dashed. */
  _formatters() {
    const f = this.ctx.fmt || {};
    const num = f.num || ((v, dp = 0) => (isFinite(v)
      ? Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
      : '—'));
    const money = f.money || ((v) => {
      if (!isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
      if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
      if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
      return `$${Math.round(v)}`;
    });
    // `f.count`, not `f.k`. `ctx.fmt.k` is the KELVIN formatter — it appends a
    // unit and a sign — and reading it as a thousands abbreviator rendered a
    // programme's 1,434,004 avoided person-hours as "+1434004.3 K".
    const k = f.count || ((v) => {
      if (!isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
      if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
      return num(v);
    });
    const kwh = f.kwh || ((v) => (isFinite(v)
      ? (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)} GWh`
        : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)} MWh` : `${num(v)} kWh`)
      : '—'));
    const kw = f.kw || ((v) => (isFinite(v) ? `${num(v, 1)} kW` : '—'));
    const pct = f.pct || ((v) => (isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—'));
    const temp = f.temp || ((v) => (isFinite(v) ? `${num(v, 1)} °C` : '—'));
    // fmt.range renders an assumed band in the one house style — "4.1–6.8 kW".
    const range = f.range || ((lo, hi, unit) => {
      if (!isFinite(lo) || !isFinite(hi)) return '—';
      const dp = Math.max(Math.abs(hi), Math.abs(lo)) < 10 ? 1 : 0;
      return `${num(lo, dp)}–${num(hi, dp)}${unit ? ` ${unit}` : ''}`;
    });
    return { num, money, k, kwh, kw, pct, temp, range };
  }

  /* A money range is composed from `fmt.money` at each end rather than handed to
     `fmt.range`, and the reason is worth recording because it looks like an
     inconsistency. `fmt.range` places a unit AFTER the pair — correct for
     "4.1–6.8 kW", wrong for money, where the symbol is a prefix on each end and
     the house abbreviation ($893k, $1.2M) has to survive. Routing capex through
     it produced "460992–893172 $". Everything that is not money still goes
     through fmt.range, so there is exactly one range style per kind of unit. */
  _money2(lo, hi) {
    const m = this.fmt.money;
    return `${m(lo)}–${m(hi)}`;
  }

  /** An assumed figure, wearing the treatment that says so. Anything wrapped in
   *  this came out of the assumption table with a low and a high; the dotted
   *  underline is the whole visual apparatus and it is enough. */
  _asm(text, title) {
    return `<span class="asm"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;
  }

  /* ------------------------------------------------- which pair to compare

     The dataset nominates a pair in `disagreement.compared`, and the honest
     default is the one the model itself chose to report on. But a nominated
     pair can be DEGENERATE — two objectives that happen to order this dataset
     identically — and opening the most important section of the view on an
     empty finding makes a working module look broken.

     On the fixture shipped with this build that is exactly what happens:
     `person_hours` and `vulnerable` produce byte-identical orderings, because
     every one of the 407 candidates carries the same heat-vulnerability index,
     so the equity weighting has nothing to reweight. That is a fact about the
     placeholder data, not about the method, and the right response is to say so
     and then show a pair that does disagree — not to hide the section and not to
     pretend the empty column is a finding.

     So: take the nominated pair if it disagrees; otherwise fall to the first
     pair that does, and carry a note explaining the substitution. */

  _pickPair() {
    const objs = this.data.objectives;
    if (!objs.length) return ['person_hours', 'degree_hours', ''];
    const nominated = this.data.disagreement?.compared;
    const differs = (a, b) => {
      const x = this.data.curves[a];
      const y = this.data.curves[b];
      if (!x || !y || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return true;
      return false;
    };
    if (Array.isArray(nominated) && nominated.length === 2
        && objs.includes(nominated[0]) && objs.includes(nominated[1])) {
      if (differs(nominated[0], nominated[1])) return [nominated[0], nominated[1], ''];
      const alt = objs.find((o) => o !== nominated[0] && differs(nominated[0], o));
      const note = `The pair this dataset nominates — ${OBJECTIVES[nominated[0]]?.label || nominated[0]} `
        + `against ${OBJECTIVES[nominated[1]]?.label || nominated[1]} — orders these `
        + `${this.data.candidates.length} candidates identically, so there is no choice to show in it. `
        + 'Every candidate carries the same vulnerability index here, which leaves the equity weighting '
        + 'nothing to reweight. The comparison below is set to a pair that does disagree.';
      if (alt) return [nominated[0], alt, note];
      return [nominated[0], nominated[1], note];
    }
    for (let i = 0; i < objs.length; i++) {
      for (let j = i + 1; j < objs.length; j++) {
        if (differs(objs[i], objs[j])) return [objs[i], objs[j], ''];
      }
    }
    return [objs[0], objs[1] || objs[0], ''];
  }

  /* A default budget has to be derived from the data rather than typed in, or
     it is a number that happens to look sensible on one fixture and absurd on
     the next. A quarter of everything on the table is defensible, explicable in
     one clause, and lands in the part of the curve where the marginal cost is
     still climbing gently — which is where the interesting conversation is. */
  _defaultBudget() {
    const t = this.data.total;
    if (!t) return 0;
    const q = t * 0.25;
    const step = q >= 1e7 ? 1e6 : q >= 1e6 ? 1e5 : 1e4;
    return Math.max(step, Math.round(q / step) * step);
  }

  /* ------------------------------------------------------------- allocation

     GREEDY, AND IT STOPS RATHER THAN SKIPS.

     Walk the objective's own curve order and buy until the next candidate does
     not fit. A skip-the-expensive-one rule packs the budget slightly fuller and
     is what a solver would do — and it breaks the one claim the picture makes,
     which is that everything left of the line is the programme. A reader who
     drags the line to $21M and counts 208 bars must get 208 rows in the table.
     The extra fraction of a percent of packing efficiency is not worth making
     the chart lie about its own contents. */

  _alloc(objective, budget) {
    const order = this.data.curves[objective] || [];
    const C = this.data.candidates;
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

  /* ------------------------------------------------------------------ DOM

     Built once, in the constructor, and appended to the body hidden. The
     analyst's markup lives in index.html; this view owns no HTML file, so it
     builds the same furniture — .phead, .ptop, .pname, .picons, .icon, .plede —
     out of the same classes, and the CSS that positions it is a copy of
     #analyst-win's geometry rather than a new idea about how a window sits. */

  _build() {
    const root = el('div', null, '');
    root.id = 'pf';
    root.hidden = true;
    root.innerHTML = `
      <div id="pf-scrim"></div>
      <div id="pf-win" role="dialog" aria-modal="true" aria-labelledby="pf-name">
        <header class="phead">
          <div class="ptop">
            <span class="pname" id="pf-name">
              <!-- The curve itself: three steps climbing, and the budget line
                   standing where the money runs out. The sigil is the thing the
                   window is about, drawn the way the analyst's is. -->
              <svg class="sigil" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 20 L8 20 L8 15 L13 15 L13 9 L18 9 L18 3 L22 3"
                      fill="none" stroke="currentColor" stroke-width="1.3"
                      stroke-linejoin="miter"/>
                <path d="M15 22 L15 2" stroke="currentColor" stroke-width="1.3" opacity=".55"/>
              </svg>
              <span class="wordmark">Programme</span>
              <span class="role">The portfolio &middot; what a budget buys</span>
            </span>
            <div class="picons">
              <button id="pf-close" class="icon" title="Close  &middot;  Esc"
                      aria-label="Close the portfolio"><span class="g">ESC</span></button>
            </div>
          </div>
          <p class="plede">
            Every candidate is one building crossed with one measure, ordered by
            what a dollar buys in exposure avoided. Drag the budget line: everything
            left of it is the programme, and everything below reads off it — what it
            treats, when each part can start, and what the whole thing is worth.
          </p>
          <p class="pfmeta" id="pf-meta"></p>
        </header>
        <div id="pf-body"></div>
      </div>`;
    document.body.appendChild(root);

    this.root = root;
    this.win = root.querySelector('#pf-win');
    this.body = root.querySelector('#pf-body');

    // The top fade in portfolio.css is masked off while the scroller is at rest,
    // so the first heading is never clipped by a fade that has nothing to fade
    // from. Passive because it only writes a class.
    this.body.classList.add('at-top');
    this.body.addEventListener('scroll', () => {
      this.body.classList.toggle('at-top', this.body.scrollTop <= 1);
    }, { passive: true });
    this.metaLine = root.querySelector('#pf-meta');
    this.closeBtn = root.querySelector('#pf-close');

    if (this.data.fixture) {
      // The standing placeholder banner. It is the first thing in the scroller
      // rather than a corner badge, because every figure under it is affected
      // and a badge is something a reader's eye learns to skip.
      const b = el('div', 'pf-fixture');
      b.innerHTML = '<span class="tag">Placeholder data</span>'
        + '<span class="txt">These candidates, costs and savings are a fixture standing in for the '
        + 'solved decision layer. The shapes, the units and the arithmetic are real; the figures are not '
        + 'yet. Nothing on this screen should be quoted.</span>';
      this.body.appendChild(b);
    }

    this.secCurve = el('section', 'pfsec pf-curve');
    this.secLedger = el('section', 'pfsec pf-ledger');
    this.secObj = el('section', 'pfsec pf-obj');
    this.secPhase = el('section', 'pfsec pf-phase');
    this.secTable = el('section', 'pfsec pf-table');
    for (const s of [this.secCurve, this.secLedger, this.secObj, this.secPhase, this.secTable]) {
      this.body.appendChild(s);
    }

    this._buildCurve();
    this._buildObjectives();
    this._buildTable();
  }

  _bind() {
    this.closeBtn.onclick = () => this.close();
    this.root.querySelector('#pf-scrim').onclick = () => this.close();

    /* The keyboard, on the capture phase, the way the tour does it.
     *
     * The host binds space, the arrows and a dozen letters to the clock and the
     * panels. This view binds the arrows to the budget line and gives Escape a
     * different meaning, so it has to win, and winning on the bubble phase is
     * not winning — ui.js listens on window too and both handlers run. Capturing
     * and stopping is the only arrangement in which the host's shortcuts are
     * genuinely off while this is up, and it is the arrangement the tour already
     * uses, so there is one answer to this problem in the codebase and not two.
     */
    this._keys = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        this.close();
        return;
      }
      if (e.key === 'Tab') { this._trap(e); return; }
      const typing = e.target && (e.target.tagName === 'INPUT'
        || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
      if (typing) { e.stopPropagation(); return; }
      // Everything else is simply not the host's any more while this is open.
      e.stopPropagation();
      if (e.target === this.plot || this.plot?.contains(e.target)) this._plotKey(e);
    };
    window.addEventListener('keydown', this._keys, true);
  }

  /* Focus stays inside the dialog. The analyst does not do this and should; a
     modal that lets Tab walk out into the layer list behind the scrim is a
     modal only to the mouse. The order is recomputed on every Tab rather than
     cached, because the table repaginates and the section controls come and go
     underneath. */
  _trap(e) {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, '
      + '[tabindex]:not([tabindex="-1"])';
    const items = [...this.win.querySelectorAll(sel)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const a = document.activeElement;
    if (e.shiftKey && (a === first || !this.win.contains(a))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && a === last) {
      e.preventDefault(); first.focus();
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  open() {
    if (this.isOpen) return;
    // Whatever opened this gets the focus back when it closes. Storing the
    // element rather than an id means it works for the launcher in the tab row,
    // a row in the ranking, or a keyboard shortcut fired from nowhere.
    this._opener = document.activeElement;
    this.root.hidden = false;
    // One frame later, so the entrance has a state to animate from. Copied
    // deliberately from openAnalyst(): setting the class in the same tick as
    // `hidden = false` skips the transition entirely.
    requestAnimationFrame(() => this.root.classList.add('on'));
    this.isOpen = true;
    document.body.classList.add('pf-open');
    this._ask();
    this.render();
    setTimeout(() => { try { this.closeBtn.focus(); } catch { /* torn down */ } }, 220);
    this._highlight();
  }

  close() {
    if (!this.isOpen) return;
    this.root.classList.remove('on');
    this.isOpen = false;
    document.body.classList.remove('pf-open');
    // Wait out the exit before taking it out of the layout, or it vanishes
    // rather than leaving.
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => { this.root.hidden = true; }, 260);
    const o = this._opener;
    this._opener = null;
    if (o && document.contains(o)) { try { o.focus(); } catch { /* gone */ } }
  }

  destroy() {
    window.removeEventListener('keydown', this._keys, true);
    clearTimeout(this._hideTimer);
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    if (this._onSelect) this.ctx.off?.('select', this._onSelect);
    this.root?.remove();
    this.root = null;
    document.body.classList.remove('pf-open');
  }

  /* --------------------------------------------------- the live re-allocator

     `/api/portfolio` re-solves the allocation server-side. It is being written
     in parallel with this view and may not answer, so the contract here is:
     ask once, never block anything on the answer, and SAY which one is
     speaking. A view that silently computes in the browser while implying a
     server solved it is the kind of thing that gets a platform disbelieved. */

  async _ask() {
    if (this.live !== null) return;
    const call = this.ctx.api?.portfolio;
    if (typeof call !== 'function') {
      this.live = false;
      this.liveNote = 'Allocating in the browser from the static portfolio · live re-allocation not wired';
      this._meta();
      return;
    }
    this.live = false;
    this.liveNote = 'Asking the solver…';
    this._meta();
    try {
      const r = await call({ objective: this.objA, budget: this.budget });
      // The endpoint is allowed to be ahead of or behind this view. Anything
      // that does not carry a recognisable allocation is treated as unavailable
      // rather than half-believed.
      if (r && (r.allocation || r.curve || r.ledger)) {
        this.live = true;
        this.serverLedger = typeof r.ledger === 'string' ? r.ledger : null;
        this.liveNote = `Re-allocated by the solver${r.seconds ? ` in ${Number(r.seconds).toFixed(1)} s` : ''}`;
      } else {
        this.liveNote = 'Live re-allocation unavailable — allocating in the browser from the static portfolio';
      }
    } catch {
      this.liveNote = 'Live re-allocation unavailable — allocating in the browser from the static portfolio';
    }
    this._meta();
    this.render();
  }

  _meta() {
    if (!this.metaLine) return;
    const bits = [
      `${this.fmt.num(this.data.candidates.length)} candidates`,
      `${this.fmt.num(this.data.buildings)} buildings`,
      `${this.fmt.num(this.data.n)} scored`,
      `${this.data.objectives.length} objectives`,
    ];
    this.metaLine.innerHTML = `${bits.join(' &middot; ')}<br><span class="src">${esc(this.liveNote)}</span>`;
  }

  /* Light the programme up on the model behind. This is the payoff for the
     instrument being three-dimensional at all: a programme is not a list, it is
     a shape distributed over a city, and forty cool roofs clustered on one
     avenue is a finding the table cannot show you. Debounced, because it fires
     on every frame of a budget drag and re-uploading a selection buffer sixty
     times a second is how the drag started stuttering. */
  _highlight() {
    const scene = this.ctx.scene;
    if (!scene?.highlight) return;
    clearTimeout(this._hlTimer);
    this._hlTimer = setTimeout(() => {
      const map = this.d.binToIndex;
      const a = this._alloc(this.objA, this.budget);
      const out = [];
      for (const b of a.bins) {
        const i = map?.get?.(String(b));
        if (i !== undefined) out.push(i);
      }
      try { scene.highlight(out); } catch { /* the scene may not be up yet */ }
    }, 120);
  }

  /* ================================================================ 1. curve

     Cumulative capital on x, marginal cost-effectiveness on y, stepped. The
     classic marginal-abatement shape, and it earns the name here: the cheapest
     candidate in this dataset avoids a person-hour for $0.37 and the dearest
     for $201, which is a spread of five hundred and forty-five to one. That
     spread IS the argument for having a curve at all — it is the difference
     between a programme designed and a programme assembled alphabetically.

     WHY THERE IS A LOG SWITCH, AND WHY LOG IS THE DEFAULT.

     On a linear axis a 545:1 spread puts nine-tenths of the candidates in the
     bottom two percent of the plot: a flat line along the floor and then a wall
     at the right edge. That is the true and famous shape, and it does say
     something — cheap is very cheap — so it is one button away. But you cannot
     read a single step in it, and steps are what a reader is here to compare.
     Log makes the whole range legible at the cost of flattening the drama, so
     it opens on log and the axis says LOG in its own label. An unlabelled log
     axis on a money chart would be a serious misrepresentation; a labelled one
     is a reading aid.

     AND WHY THE PROGRAMME IS A TINTED COLUMN RATHER THAN A FILLED AREA.

     On a proper MAC curve, x is quantity abated and the area under the curve is
     total cost. Here x is already cost, so the area under this curve is dollars
     squared per person-hour, which is nothing. Filling it would invite exactly
     the reading it cannot support. The funded region is therefore marked by
     tinting the full-height column left of the budget line — unambiguously "this
     region", never "this quantity" — and the curve itself is a line whose funded
     half is simply brighter. */

  _buildCurve() {
    this.secCurve.innerHTML = `
      <div class="pfsec-head">
        <span class="klabel">The cost curve</span>
        <div class="pfscale ordsw" role="group" aria-label="Vertical scale">
          <button type="button" data-scale="log">Log</button>
          <button type="button" data-scale="linear">Linear</button>
        </div>
      </div>
      <p class="pfsec-lede">
        Each step is one building and one measure. Height is what a person-hour of
        avoided exposure costs there; width is what it costs to do. Drag the line.
      </p>
      <div class="pfcurve-grid">
        <div class="pfplot-wrap">
          <div class="pfplot" tabindex="0" role="slider" aria-label="Budget"
               aria-valuemin="0"></div>
          <div class="pfreadout" aria-live="off"></div>
        </div>
        <div class="pfrail"></div>
      </div>`;
    this.plot = this.secCurve.querySelector('.pfplot');
    this.readout = this.secCurve.querySelector('.pfreadout');
    this.rail = this.secCurve.querySelector('.pfrail');

    for (const b of this.secCurve.querySelectorAll('.pfscale button')) {
      b.onclick = () => { this.scaleMode = b.dataset.scale; this._drawCurve(); this._scaleBtns(); };
    }
    this._scaleBtns();

    // Pointer handling lives on the wrapper so a drag that leaves the plot on
    // the way to the far edge of the window keeps tracking. Pointer capture is
    // what makes that work without a document-level listener that outlives the
    // gesture — an earlier version leaked one per drag.
    const pos = (e) => {
      const r = this.plot.getBoundingClientRect();
      return this._xInv(e.clientX - r.left);
    };
    this.plot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.plot.setPointerCapture?.(e.pointerId);
      this.plot.focus();
      this.setBudget(pos(e));
      e.preventDefault();
    });
    this.plot.addEventListener('pointermove', (e) => {
      if (this.dragging) { this.setBudget(pos(e)); return; }
      this._hover(e);
    });
    this.plot.addEventListener('pointerup', (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.plot.releasePointerCapture?.(e.pointerId);
      this._highlight();
    });
    this.plot.addEventListener('pointerleave', () => {
      if (!this.dragging) { this.hoverIdx = null; this._drawCursor(); this._readout(); }
    });

    // The plot resizes with the window, and a chart drawn once at the width it
    // happened to have when the module was constructed is a chart that is wrong
    // the first time somebody resizes. Redrawn, not scaled: the axis labels
    // must not stretch.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => { this._geom(true); this._drawCurve(); });
      this._ro.observe(this.plot);
    }
  }

  _scaleBtns() {
    for (const b of this.secCurve.querySelectorAll('.pfscale button')) {
      b.setAttribute('aria-pressed', String(b.dataset.scale === this.scaleMode));
    }
  }

  /** Arrow keys walk the budget line one candidate at a time, ten with shift,
   *  and Home/End take it to either end. A draggable line that only a mouse can
   *  drag is a control half the audience does not have. */
  _plotKey(e) {
    const cum = this._cum();
    const n = this._fundedCount();
    const set = (i) => {
      const j = clamp(i, 0, cum.length);
      this.setBudget(j <= 0 ? 0 : cum[j - 1]);
    };
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': e.preventDefault(); set(n + step); break;
      case 'ArrowLeft': case 'ArrowDown': e.preventDefault(); set(n - step); break;
      case 'Home': e.preventDefault(); set(0); break;
      case 'End': e.preventDefault(); set(cum.length); break;
      case 'PageUp': e.preventDefault(); set(n + 25); break;
      case 'PageDown': e.preventDefault(); set(n - 25); break;
      default: return;
    }
    this._highlight();
  }

  /** Cumulative capital along the CURRENT objective's order, memoised because
   *  it is read on every pointer move during a drag. */
  _cum() {
    if (this._cumKey === this.objA && this._cumArr) return this._cumArr;
    const order = this.data.curves[this.objA] || [];
    const C = this.data.candidates;
    const out = new Float64Array(order.length);
    let t = 0;
    for (let i = 0; i < order.length; i++) { t += mid(C[order[i]]?.capex); out[i] = t; }
    this._cumKey = this.objA;
    this._cumArr = out;
    return out;
  }

  _fundedCount() {
    const cum = this._cum();
    let n = 0;
    while (n < cum.length && cum[n] <= this.budget) n++;
    return n;
  }

  setBudget(v) {
    const b = clamp(v, 0, this.data.total);
    if (Math.abs(b - this.budget) < 1) return;
    this.budget = b;
    // One render per frame however fast the pointer moves. Without this a drag
    // across the plot queued four hundred full re-renders and the line lagged
    // the cursor by most of a second.
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  /* ---- geometry. Margins are generous on the left because the y labels are
     money and money labels are wide, and generous at the bottom because the x
     axis carries both ticks and a caption. */

  /* Measured once per draw and cached. `_x` is called twice per candidate and
     `clientWidth` is a layout read; asking the browser for it eight hundred
     times while building one path is how a 407-step curve started costing more
     than the frame it was drawn in. `fresh` is passed exactly where the width
     can genuinely have changed — the start of a draw, and the resize observer. */
  _geom(fresh = false) {
    if (!fresh && this._g) return this._g;
    const w = Math.max(320, this.plot?.clientWidth || 700);
    const h = 296;
    const m = { l: 62, r: 18, t: 20, b: 40 };
    this._g = { w, h, m, iw: w - m.l - m.r, ih: h - m.t - m.b };
    return this._g;
  }

  _x(v) { const g = this._geom(); return g.m.l + (this.data.total ? v / this.data.total : 0) * g.iw; }
  _xInv(px) { const g = this._geom(); return ((px - g.m.l) / g.iw) * this.data.total; }

  _yScale() {
    const C = this.data.candidates;
    let lo = Infinity; let hi = -Infinity;
    for (const c of C) {
      const v = c.usd_per_person_hour;
      if (!isFinite(v) || v <= 0) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo)) { lo = 1; hi = 10; }
    const g = this._geom();
    if (this.scaleMode === 'linear') {
      const top = hi * 1.04;
      return { lo: 0, hi: top, y: (v) => g.m.t + (1 - clamp(v, 0, top) / top) * g.ih };
    }
    const l0 = Math.log(lo * 0.85); const l1 = Math.log(hi * 1.15);
    return { lo, hi, log: true, y: (v) => g.m.t + (1 - (Math.log(clamp(v, lo * 0.85, hi * 1.15)) - l0) / (l1 - l0)) * g.ih };
  }

  _yTicks(sc) {
    if (sc.log) {
      const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
      return nice.filter((v) => v >= sc.lo * 0.85 && v <= sc.hi * 1.15);
    }
    const out = [];
    const step = Math.pow(10, Math.floor(Math.log10(sc.hi / 4)));
    const s = sc.hi / step > 40 ? step * 10 : sc.hi / step > 16 ? step * 5 : sc.hi / step > 8 ? step * 2 : step;
    for (let v = 0; v <= sc.hi; v += s) out.push(v);
    return out;
  }

  _drawCurve() {
    if (!this.plot) return;
    const g = this._geom(true);
    const sc = this._yScale();
    const cum = this._cum();
    const order = this.data.curves[this.objA] || [];
    const C = this.data.candidates;
    const n = this._fundedCount();
    const bx = this._x(this.budget);

    const s = svg('svg', {
      width: g.w, height: g.h, viewBox: `0 0 ${g.w} ${g.h}`,
      class: 'pfsvg', role: 'img',
      'aria-label': `Marginal cost curve, ${order.length} candidates`,
    });

    // The funded column, first, so everything else draws over it.
    s.appendChild(svg('rect', {
      x: g.m.l, y: g.m.t, width: Math.max(0, bx - g.m.l), height: g.ih, class: 'pf-funded-col',
    }));

    // Grid. Faint enough to be read past rather than read.
    const yt = this._yTicks(sc);
    for (const v of yt) {
      const y = sc.y(v);
      s.appendChild(svg('line', { x1: g.m.l, x2: g.w - g.m.r, y1: y, y2: y, class: 'pf-grid' }));
      const t = svg('text', { x: g.m.l - 9, y: y + 3, class: 'pf-ytick', 'text-anchor': 'end' });
      t.textContent = v >= 1 ? `$${this.fmt.num(v)}` : `$${v}`;
      s.appendChild(t);
    }
    const xstep = this._xStep();
    for (let v = 0; v <= this.data.total + 1; v += xstep) {
      const x = this._x(v);
      s.appendChild(svg('line', { x1: x, x2: x, y1: g.m.t, y2: g.m.t + g.ih, class: 'pf-grid v' }));
      const t = svg('text', { x, y: g.m.t + g.ih + 15, class: 'pf-xtick', 'text-anchor': 'middle' });
      t.textContent = this.fmt.money(v);
      s.appendChild(t);
    }

    // The stepped path, in two pieces: what the budget buys, and what it does
    // not. Same geometry, different weight — the split is the only encoding the
    // funded/unfunded distinction needs on the line itself.
    const seg = (from, to, cls) => {
      if (to <= from) return;
      let dd = '';
      let px = from === 0 ? g.m.l : this._x(cum[from - 1]);
      for (let i = from; i < to; i++) {
        const c = C[order[i]];
        if (!c) continue;
        const y = sc.y(c.usd_per_person_hour);
        const x = this._x(cum[i]);
        dd += `${dd ? 'L' : 'M'}${px.toFixed(2)},${y.toFixed(2)}L${x.toFixed(2)},${y.toFixed(2)}`;
        px = x;
      }
      if (dd) s.appendChild(svg('path', { d: dd, class: cls }));
    };
    seg(0, n, 'pf-line on');
    // The unfunded half starts at index n, whose own first vertical rises from
    // the funded boundary — so the two paths meet exactly on the budget side of
    // the last funded step and there is no seam to explain.
    seg(n, order.length, 'pf-line off');

    // Axis frame: two hairlines, not a box. A full box would fence the curve in
    // and this sheet does not draw boxes anywhere else.
    s.appendChild(svg('line', {
      x1: g.m.l, x2: g.w - g.m.r, y1: g.m.t + g.ih, y2: g.m.t + g.ih, class: 'pf-axis',
    }));
    s.appendChild(svg('line', { x1: g.m.l, x2: g.m.l, y1: g.m.t, y2: g.m.t + g.ih, class: 'pf-axis' }));

    // The budget line and its handle.
    s.appendChild(svg('line', { x1: bx, x2: bx, y1: g.m.t - 6, y2: g.m.t + g.ih + 4, class: 'pf-budget' }));
    s.appendChild(svg('rect', { x: bx - 4, y: g.m.t - 12, width: 8, height: 10, rx: 1.5, class: 'pf-handle' }));
    const bl = svg('text', {
      x: clamp(bx, g.m.l + 26, g.w - g.m.r - 26), y: g.m.t - 16,
      class: 'pf-budget-label', 'text-anchor': 'middle',
    });
    bl.textContent = this.fmt.money(this.budget);
    s.appendChild(bl);

    // Axis captions.
    const xc = svg('text', {
      x: g.m.l + g.iw / 2, y: g.h - 4, class: 'pf-cap', 'text-anchor': 'middle',
    });
    xc.textContent = 'CUMULATIVE CAPITAL COMMITTED  (MIDPOINT)';
    s.appendChild(xc);
    const yc = svg('text', {
      x: 12, y: g.m.t + g.ih / 2, class: 'pf-cap',
      transform: `rotate(-90 12 ${g.m.t + g.ih / 2})`, 'text-anchor': 'middle',
    });
    yc.textContent = `$ PER PERSON-HOUR${sc.log ? '  ·  LOG' : ''}`;
    s.appendChild(yc);

    this.cursor = svg('g', { class: 'pf-cursor' });
    s.appendChild(this.cursor);

    this.plot.innerHTML = '';
    this.plot.appendChild(s);
    this.svg = s;
    this.scaleY = sc;
    this.plot.setAttribute('aria-valuemax', String(Math.round(this.data.total)));
    this.plot.setAttribute('aria-valuenow', String(Math.round(this.budget)));
    this.plot.setAttribute('aria-valuetext',
      `${this.fmt.money(this.budget)}, ${n} of ${order.length} candidates funded`);
    this._drawCursor();
  }

  /** A round tick interval that yields six to nine gridlines whatever the total
   *  happens to be. Hard-coding $10M worked on this fixture and produced two
   *  ticks on a borough-scale one. */
  _xStep() {
    const t = this.data.total || 1;
    const raw = t / 7;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const r = raw / p;
    return (r > 5 ? 10 : r > 2 ? 5 : r > 1 ? 2 : 1) * p;
  }

  _hover(e) {
    const r = this.plot.getBoundingClientRect();
    const v = this._xInv(e.clientX - r.left);
    const cum = this._cum();
    if (v < 0 || v > this.data.total) { this.hoverIdx = null; } else {
      // Binary search for the first candidate whose cumulative cost passes the
      // cursor: with 407 steps in 700 pixels, several candidates share a column
      // and a linear scan on every pointer move is measurable.
      let lo = 0; let hi = cum.length - 1; let k = 0;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (cum[m] >= v) { k = m; hi = m - 1; } else lo = m + 1;
      }
      this.hoverIdx = k;
    }
    this._drawCursor();
    this._readout();
  }

  _drawCursor() {
    if (!this.cursor) return;
    this.cursor.innerHTML = '';
    if (this.hoverIdx === null) return;
    const order = this.data.curves[this.objA] || [];
    const c = this.data.candidates[order[this.hoverIdx]];
    if (!c) return;
    const g = this._geom();
    const cum = this._cum();
    const x = this._x(cum[this.hoverIdx]);
    const y = this.scaleY.y(c.usd_per_person_hour);
    this.cursor.appendChild(svg('line', { x1: x, x2: x, y1: g.m.t, y2: g.m.t + g.ih, class: 'pf-xhair' }));
    this.cursor.appendChild(svg('circle', { cx: x, cy: y, r: 3, class: 'pf-dot' }));
  }

  /* The readout is a fixed row under the plot rather than a tooltip that floats
     with the cursor. Two reasons: a floating box over a dense stepped chart
     covers the steps either side of the one it describes, and a fixed row can
     carry four figures and a capex RANGE without becoming a card. When nothing
     is hovered it reads the candidate at the margin — the next thing the budget
     would buy — which is the most useful default it could hold. */
  _readout() {
    if (!this.readout) return;
    const order = this.data.curves[this.objA] || [];
    const hovering = this.hoverIdx !== null;
    const a = this._alloc(this.objA, this.budget);
    const i = hovering ? order[this.hoverIdx] : (order[a.idx.length] ?? order[order.length - 1]);
    const c = this.data.candidates[i];
    if (!c) { this.readout.innerHTML = ''; return; }
    const funded = hovering ? this.hoverIdx < a.idx.length : false;
    this.readout.innerHTML = `
      <span class="lab">${hovering ? 'Under the cursor' : 'Next in line'}</span>
      <span class="addr">${esc(c.addr || `BIN ${c.bin}`)}</span>
      <span class="msr">${esc(measureLabel(c.measure))}</span>
      <span class="v">$${this.fmt.num(c.usd_per_person_hour, 2)}<i>/person-hour</i></span>
      <span class="v">${this._asm(this._money2(c.capex?.[0], c.capex?.[1]), 'Capital cost, low to high')}<i>capex</i></span>
      <span class="v">${this.fmt.k(c.person_hours_avoided)}<i>person-hours</i></span>
      <span class="tag ${funded ? 'in' : 'out'}">${funded ? 'In the programme' : 'Not funded'}</span>`;
  }

  /* The rail beside the curve: the programme in six figures. The budget itself
     is set in the serif at display size because it is the one number on this
     screen the reader came to choose, and the rest are monospace because they
     are read down a column. */
  _rail(a) {
    const order = this.data.curves[this.objA] || [];
    const rows = [
      ['Measures funded', `${this.fmt.num(a.idx.length)}<i>of ${this.fmt.num(order.length)}</i>`],
      ['Buildings treated', `${this.fmt.num(a.buildings)}<i>of ${this.fmt.num(this.data.buildings)}</i>`],
      ['Person-hours avoided', `${this.fmt.k(a.ph)}<i>hours of exposure</i>`],
      ['At the margin', a.marginal === null ? '—'
        : `$${this.fmt.num(a.marginal, 2)}<i>per person-hour</i>`],
      ['Committed', `${this._asm(this._money2(a.capex[0], a.capex[1]), 'Sum of the low and high capital estimates')}<i>real capital, not the midpoint</i>`],
    ];
    this.rail.innerHTML = `
      <div class="pfbig">
        <span class="klabel">Budget</span>
        <span class="fig">${this.fmt.money(this.budget)}</span>
        <span class="sub">${this.fmt.pct(this.data.total ? this.budget / this.data.total : 0)} of everything on the table</span>
      </div>
      <dl class="pfstats">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
      </dl>`;
  }

  /* ============================================================= 2. ledger

     One paragraph, in the serif, with room around it. It is the only prose on
     this screen that is meant to be quoted, and it is assembled from the
     allocation rather than written, so it cannot drift from the figures above
     it the way a hand-written summary does.

     Every assumed quantity in it wears its range. The sentence deliberately
     ends on the point that the budget line is drawn on midpoints and the real
     commitment straddles it, because that is the single most misreadable thing
     about a cost curve and burying it in a footnote would be a choice. */

  _ledger(a) {
    if (!a.idx.length) {
      this.secLedger.innerHTML = `
        <div class="pfsec-head"><span class="klabel">The outcome</span></div>
        <p class="pfpara">No budget, no programme. Drag the line to the right and this
        paragraph will say what the money buys.</p>`;
      return;
    }
    const money = this.fmt.money;
    const homes = a.units
      ? ` behind ${this.fmt.num(a.units)} homes`
      : '';
    // Residents rather than homes only if the assumption table actually carries
    // a household size. Inventing one here would put a fabricated constant into
    // the sentence most likely to be quoted, which is worse than saying homes.
    const hh = this.data.constants.find?.((c) => /household_size/i.test(c?.key || c?.name || ''));
    // `economics.constants_table()` spells a banded constant `lo`/`hi` and
    // carries `value` as the two-element band itself. Reading `low`/`high`
    // found neither, multiplied 13,147 homes by undefined, and rendered the
    // resident count as an em dash in the one sentence most likely to be
    // quoted. Every spelling the table has ever used is accepted, and a
    // constant with none of them still degrades to naming homes alone.
    const band = (c) => {
      if (!c) return null;
      const v = c.value;
      if (Array.isArray(v) && v.length === 2) return [Number(v[0]), Number(v[1])];
      const lo = c.lo ?? c.low ?? (typeof v === 'number' ? v : null);
      const hi = c.hi ?? c.high ?? (typeof v === 'number' ? v : null);
      return Number.isFinite(lo) && Number.isFinite(hi) ? [Number(lo), Number(hi)] : null;
    };
    const hhb = band(hh);
    const people = hhb && a.units
      ? ` — about ${this._asm(this.fmt.range(a.units * hhb[0], a.units * hhb[1], 'residents'))}`
      : '';
    const phases = PHASES
      .map((p) => ({ p, n: a.idx.filter((i) => this.data.candidates[i].lead_time === p.key).length }))
      .filter((x) => x.n);
    const soon = phases.find((x) => x.p.key === 'this season');

    this.secLedger.innerHTML = `
      <div class="pfsec-head">
        <span class="klabel">The outcome</span>
        <span class="pfsec-right">${this.live ? 'Solver' : 'Computed in the browser'}</span>
      </div>
      <p class="pfpara">
        At ${money(this.budget)} this programme treats
        <b>${this.fmt.num(a.buildings)}</b> buildings with
        <b>${this.fmt.num(a.idx.length)}</b> measures. It avoids
        <b>${this.fmt.k(a.ph)}</b> person-hours of exposure above 35&nbsp;°C${homes}${people},
        saves ${this._asm(this.fmt.range(a.kwh[0] / 1000, a.kwh[1] / 1000, 'MWh'), 'Electricity avoided, low to high')}
        and ${this._asm(this.fmt.range(a.carbon[0], a.carbon[1], 't CO₂e'), 'Carbon avoided, low to high')} a year, and
        commits ${this._asm(this._money2(a.capex[0], a.capex[1]))} of capital.
        ${soon ? `<b>${this.fmt.num(soon.n)}</b> of those measures can start this season.` : ''}
      </p>
      <p class="pffoot">
        The budget line is drawn on midpoint costs because a curve needs one number
        per candidate. The capital actually committed is the range above, and it
        straddles the line: a ${money(this.budget)} programme is a
        ${this._money2(a.capex[0], a.capex[1])} decision.
      </p>`;
  }

  /* ================================================== 3. the two objectives

     The point of the module.

     This is built as a sibling of the two orderings in the right-hand panel —
     the heat wave against the year — and deliberately so. That control is two
     buttons, an overlap figure printed underneath in monospace, and a per-row
     note saying where the OTHER ordering puts this building. There was no
     reason to invent a second visual language for the same idea applied to
     money, and every reason not to: a reader who has understood one has
     understood both.

     What is different is that here the disagreement has a price. Two objectives
     at the same budget fund two different sets of buildings, and the buildings
     in one set and not the other are the ones somebody is choosing to drop. */

  _buildObjectives() {
    this.secObj.innerHTML = `
      <div class="pfsec-head">
        <span class="klabel">Two objectives, one budget</span>
      </div>
      <p class="pfsec-lede">
        The same candidates, the same money, two definitions of what the money is for.
        Where the two programmes differ, someone is choosing.
      </p>
      <div class="pfobj-picks"></div>
      <p class="note pfobj-stat"></p>
      <div class="pfobj-cols"></div>
      <p class="pfobj-read"></p>`;
    this.objPicks = this.secObj.querySelector('.pfobj-picks');
    this.objStat = this.secObj.querySelector('.pfobj-stat');
    this.objCols = this.secObj.querySelector('.pfobj-cols');
    this.objRead = this.secObj.querySelector('.pfobj-read');
  }

  _objectives(a) {
    const objs = this.data.objectives;
    const pick = (side) => `
      <div class="pfpick">
        <span class="klabel">${side === 'a' ? 'Column A' : 'Column B'}</span>
        <div class="ordsw">
          ${objs.map((o) => `<button type="button" data-side="${side}" data-obj="${o}"
             aria-pressed="${String((side === 'a' ? this.objA : this.objB) === o)}"
             title="${esc(OBJECTIVES[o]?.gloss || o)}">${esc(OBJECTIVES[o]?.label || o)}</button>`).join('')}
        </div>
        <p class="pfgloss">${esc(OBJECTIVES[side === 'a' ? this.objA : this.objB]?.gloss || '')}</p>
      </div>`;
    this.objPicks.innerHTML = pick('a') + pick('b');
    for (const b of this.objPicks.querySelectorAll('button')) {
      b.onclick = () => {
        if (b.dataset.side === 'a') { this.objA = b.dataset.obj; this._cumArr = null; } else this.objB = b.dataset.obj;
        this.render();
        this._highlight();
      };
    }

    const B = this._alloc(this.objB, this.budget);
    const sa = new Set(a.idx);
    const sb = new Set(B.idx);
    const onlyA = a.idx.filter((i) => !sb.has(i));
    const onlyB = B.idx.filter((i) => !sa.has(i));
    const shared = a.idx.filter((i) => sb.has(i)).length;
    const same = onlyA.length === 0 && onlyB.length === 0;

    const nameA = OBJECTIVES[this.objA]?.label || this.objA;
    const nameB = OBJECTIVES[this.objB]?.label || this.objB;

    this.objStat.innerHTML = same
      ? `AT ${this.fmt.money(this.budget).toUpperCase()} THE TWO OBJECTIVES FUND THE SAME `
        + `<b>${a.idx.length}</b> MEASURES. ON THIS DATA THEY DO NOT DISAGREE.`
      : `AT ${this.fmt.money(this.budget).toUpperCase()} THEY SHARE <b>${shared}</b> MEASURES · `
        + `<b>${onlyA.length}</b> FUNDED ONLY BY ${nameA.toUpperCase()} · `
        + `<b>${onlyB.length}</b> ONLY BY ${nameB.toUpperCase()}<br>`
        + `THE DIFFERENCE IS WORTH ${this.fmt.money(onlyA.reduce((s, i) => s + mid(this.data.candidates[i].capex), 0)).toUpperCase()} `
        + `OF CAPITAL AND ${this.fmt.k(Math.abs(a.ph - B.ph)).toUpperCase()} PERSON-HOURS`;

    // The columns. Each lists its own programme in its own order, and a row
    // that the other column does not fund is marked — that mark is the whole
    // section in one glyph, so it is a hairline and a monospace tag rather than
    // a colour, because the accent belongs to the cursor and colour on data
    // here would read as a temperature.
    /* Each column is its own programme in its own order, and then — under a
       rule — the buildings it funds that the other column does not.
     *
     * The second list is not decoration and was not in the first version. With
     * only a ranked top sixteen, the two columns looked almost identical,
     * because the candidates they disagree about are mostly a hundred rows
     * down: the section that exists to show a disagreement was showing an
     * agreement. Naming the divergent buildings explicitly is the whole
     * requirement — "name the buildings that appear under one and not the
     * other" — and a ranked list will not do it on its own. */
    const col = (alloc, other, name) => {
      const set = new Set(other.idx);
      const row = (i, place, only) => {
        const c = this.data.candidates[i];
        return `<li class="${only ? 'only' : ''}">
          <span class="n">${place}</span>
          <span class="a">${esc(c.addr || `BIN ${c.bin}`)}</span>
          <span class="m">${esc(measureLabel(c.measure))}</span>
        </li>`;
      };
      const top = alloc.idx.slice(0, 8)
        .map((i, k) => row(i, k + 1, !set.has(i))).join('');
      const uniq = alloc.idx.map((i, k) => [i, k]).filter(([i]) => !set.has(i));
      const only = uniq.slice(0, 8)
        .map(([i, k]) => row(i, k + 1, true)).join('');
      return `<div class="pfcol">
        <h4>${esc(name)}</h4>
        <ol class="pflist">${top}</ol>
        <p class="pfcolrule">${uniq.length
          ? `Funded here, dropped by ${esc(other === a ? nameA : nameB)}`
          : 'Nothing here that the other column drops'}</p>
        <ol class="pflist">${only}</ol>
        <p class="pfcolfoot">
          <span>${this.fmt.num(alloc.idx.length)} measures ·
            ${this.fmt.num(alloc.buildings)} buildings ·
            ${this.fmt.k(alloc.ph)} person-hours</span>
          <span><b>${uniq.length}</b> the other column drops</span>
        </p>
      </div>`;
    };
    this.objCols.innerHTML = col(a, B, nameA) + col(B, a, nameB);

    // The dataset's own reading, verbatim, plus the note about a degenerate
    // nominated pair when there is one. The reading is the model's sentence and
    // is not paraphrased; the note is this view's and is marked as such by being
    // the smaller of the two.
    const reading = this.data.disagreement?.reading;
    this.objRead.innerHTML = (reading ? `<span class="rd">${esc(reading)}</span>` : '')
      + (this.pairNote ? `<span class="nt">${esc(this.pairNote)}</span>` : '');
  }

  /* ================================================== 4. phasing, by start

     Sorting a programme by benefit tells you what matters. Sorting it by when
     it can START tells you what to do in March, and only one of those is a
     plan. A cool roof and a facade retrofit at the same cost per person-hour
     are not the same commitment, and the phase columns are where that becomes
     visible: on this data almost everything cheap is also immediate, which is
     the happiest finding in the module and worth being able to see. */

  _phasing(a) {
    const C = this.data.candidates;
    const groups = PHASES.map((p) => {
      const idx = a.idx.filter((i) => C[i].lead_time === p.key);
      const capex = idx.reduce((s, i) => [s[0] + (C[i].capex?.[0] ?? 0), s[1] + (C[i].capex?.[1] ?? 0)], [0, 0]);
      const ph = idx.reduce((s, i) => s + (C[i].person_hours_avoided || 0), 0);
      const bins = new Set(idx.map((i) => String(C[i].bin)));
      return { p, idx, capex, ph, bins };
    });
    // Anything whose lead time is not one of the three known strings still has
    // to appear somewhere; it goes in an "unscheduled" column rather than being
    // silently dropped from a plan that claims to be the whole programme.
    const known = new Set(PHASES.map((p) => p.key));
    const rest = a.idx.filter((i) => !known.has(C[i].lead_time));
    if (rest.length) {
      groups.push({
        p: { key: '', label: 'Unscheduled', note: 'No lead time stated in the source.' },
        idx: rest,
        capex: rest.reduce((s, i) => [s[0] + (C[i].capex?.[0] ?? 0), s[1] + (C[i].capex?.[1] ?? 0)], [0, 0]),
        ph: rest.reduce((s, i) => s + (C[i].person_hours_avoided || 0), 0),
        bins: new Set(rest.map((i) => String(C[i].bin))),
      });
    }
    /* The bar is share of the WHOLE programme's benefit, not share of the largest
       phase. Scaling to the largest phase made the bars and the "share of
       benefit" figure printed underneath them disagree — a 64%-long bar over the
       words "30%" — which is the sort of small inconsistency that costs a chart
       its credibility faster than a wrong number does. */
    const totalPh = Math.max(1, a.ph);

    this.secPhase.innerHTML = `
      <div class="pfsec-head">
        <span class="klabel">Phasing — by when it can start</span>
        <span class="pfsec-right">${this.fmt.num(a.idx.length)} measures</span>
      </div>
      <p class="pfsec-lede">
        The same programme sorted by lead time rather than by benefit. This is the
        column a delivery plan is written from.
      </p>
      <div class="pfphases">
        ${groups.map((g) => `
          <div class="pfphase ${g.idx.length ? '' : 'empty'}">
            <div class="ph-h">
              <span class="ph-n">${this.fmt.num(g.idx.length)}</span>
              <span class="ph-l">${esc(g.p.label)}</span>
            </div>
            <p class="pfgloss">${esc(g.p.note)}</p>
            <div class="ph-bar"><i style="width:${((g.ph / totalPh) * 100).toFixed(1)}%"></i></div>
            <dl class="ph-stats">
              <div><dt>Buildings</dt><dd>${this.fmt.num(g.bins.size)}</dd></div>
              <div><dt>Person-hours</dt><dd>${this.fmt.k(g.ph)}</dd></div>
              <div><dt>Capital</dt><dd>${this._asm(this._money2(g.capex[0], g.capex[1]))}</dd></div>
              <div><dt>Share of benefit</dt><dd>${this.fmt.pct(a.ph ? g.ph / a.ph : 0)}</dd></div>
            </dl>
          </div>`).join('')}
      </div>`;
  }

  /* ================================================================ 5. table

     Everything, aligned, and out of the browser as a CSV.

     Paged rather than virtualised. 407 rows is not a virtualisation problem —
     rendering all of them costs about a millisecond — but it IS a scrolling
     problem inside a window that already scrolls, because a 407-row table
     nested in a scroller either steals the wheel or runs 12,000 pixels past the
     end of everything else in the view. Forty rows and a pager keeps the whole
     module one scroll long, and the CSV is there for anyone who wanted all four
     hundred anyway.

     The columns are ordered the way the decision is read: who, what, what it
     costs, what it buys, what it costs per unit bought, when, and who lives
     there. Money is right-aligned and tabular; addresses are not. */

  COLS = [
    { key: 'addr', label: 'Address', cls: 'c-addr' },
    { key: 'measure', label: 'Measure', cls: 'c-msr' },
    { key: 'capex', label: 'Capex', cls: 'c-num', num: true },
    { key: 'person_hours_avoided', label: 'Person-hours', cls: 'c-num', num: true },
    { key: 'usd_per_person_hour', label: '$ / person-h', cls: 'c-num money', num: true },
    { key: 'lead_time', label: 'Lead time', cls: 'c-lead' },
    { key: 'hvi', label: 'HVI', cls: 'c-num', num: true },
    { key: 'units', label: 'Homes', cls: 'c-num', num: true },
  ];

  _buildTable() {
    this.secTable.innerHTML = `
      <div class="pfsec-head">
        <span class="klabel">Every candidate</span>
        <div class="pfsec-right">
          <button type="button" class="link pf-export">Export CSV</button>
        </div>
      </div>
      <div class="pffilters">
        <input type="search" class="pfq" placeholder="Filter by address" aria-label="Filter by address" />
        <div class="pfchips" data-filter="measure"></div>
        <div class="pfchips" data-filter="lead"></div>
        <button type="button" class="pfonly" aria-pressed="false">In the programme only</button>
      </div>
      <div class="pftable-wrap"><table class="pftab"><thead></thead><tbody></tbody></table></div>
      <div class="pfpager"></div>`;

    this.q = this.secTable.querySelector('.pfq');
    this.q.oninput = () => { this.filters.q = this.q.value.trim().toLowerCase(); this.page = 0; this._table(); };
    this.secTable.querySelector('.pf-export').onclick = () => this._csv();
    const only = this.secTable.querySelector('.pfonly');
    only.onclick = () => {
      this.filters.fundedOnly = !this.filters.fundedOnly;
      only.setAttribute('aria-pressed', String(this.filters.fundedOnly));
      this.page = 0; this._table();
    };

    const chips = (host, values, key) => {
      host.innerHTML = [['', 'All']].concat(values.map((v) => [v, key === 'measure' ? measureLabel(v) : v]))
        .map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(this.filters[key] === v)}">${esc(l)}</button>`)
        .join('');
      for (const b of host.querySelectorAll('button')) {
        b.onclick = () => {
          this.filters[key] = b.dataset.v;
          this.page = 0;
          chips(host, values, key);
          this._table();
        };
      }
    };
    const uniq = (f) => [...new Set(this.data.candidates.map(f))].filter(Boolean).sort();
    chips(this.secTable.querySelector('[data-filter="measure"]'), uniq((c) => c.measure), 'measure');
    chips(this.secTable.querySelector('[data-filter="lead"]'),
      PHASES.map((p) => p.key).filter((k) => this.data.candidates.some((c) => c.lead_time === k)), 'lead');

    const head = this.secTable.querySelector('thead');
    head.innerHTML = `<tr>${this.COLS
      .map((c) => `<th class="${c.cls}" data-key="${c.key}" tabindex="0" role="columnheader"><span>${esc(c.label)}</span><i></i></th>`)
      .join('')}</tr>`;
    for (const th of head.querySelectorAll('th')) {
      const go = () => {
        const k = th.dataset.key;
        // Clicking the column you are already sorted on reverses it; clicking a
        // new one starts descending for numbers and ascending for text, which is
        // what a reader means by "sort by cost" without saying which way.
        if (this.sort.key === k) this.sort.dir *= -1;
        else this.sort = { key: k, dir: this.COLS.find((c) => c.key === k)?.num ? -1 : 1 };
        // The one exception: cost-effectiveness reads best cheapest-first,
        // because that is the order the curve is drawn in.
        if (this.sort.key === 'usd_per_person_hour' && k !== this.sort.key) this.sort.dir = 1;
        this.page = 0;
        this._table();
      };
      th.onclick = go;
      th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    }
    this.tbody = this.secTable.querySelector('tbody');
    this.pager = this.secTable.querySelector('.pfpager');
  }

  _rows(a) {
    const funded = new Set(a.idx);
    const f = this.filters;
    let rows = this.data.candidates.map((c, i) => ({ c, i, in: funded.has(i) }));
    if (f.measure) rows = rows.filter((r) => r.c.measure === f.measure);
    if (f.lead) rows = rows.filter((r) => r.c.lead_time === f.lead);
    if (f.fundedOnly) rows = rows.filter((r) => r.in);
    if (f.q) rows = rows.filter((r) => String(r.c.addr || r.c.bin).toLowerCase().includes(f.q));
    const k = this.sort.key;
    const dir = this.sort.dir;
    rows.sort((x, y) => {
      const av = k === 'capex' ? mid(x.c.capex) : x.c[k];
      const bv = k === 'capex' ? mid(y.c.capex) : y.c[k];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      }
      return (((av ?? -Infinity) - (bv ?? -Infinity)) || 0) * dir;
    });
    return rows;
  }

  /* A five-step stripe on the candidate's own priority score. The severity ramp,
     not the temperature ramp: this is a magnitude, and painting it in the heat
     colours would put a second temperature on a panel sitting over a city
     already painted in them.
   *
   * The break points are QUINTILES OF THIS DATASET, not fixed thresholds on an
   * absolute scale. Fixed thresholds were the first version and they were
   * useless here: every candidate in this portfolio scores between 62 and 81,
   * because a candidate only exists for a building that already ranked, so a
   * 0-20-40-60-80 ramp painted four hundred rows the same shade of accent and
   * carried no information at all. A stripe that does not vary is a stripe
   * worth deleting, so it varies across what is actually on screen and the
   * column header says the score it is ramping. */
  _sevBreaks() {
    if (this._breaks) return this._breaks;
    const v = this.data.candidates
      .map((c) => c.priority).filter((x) => isFinite(x)).sort((a, b) => a - b);
    this._breaks = v.length
      ? [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.floor(q * (v.length - 1))])
      : [0, 0, 0, 0];
    return this._breaks;
  }

  _sev(v) {
    if (!isFinite(v)) return 0;
    const b = this._sevBreaks();
    return v >= b[3] ? 4 : v >= b[2] ? 3 : v >= b[1] ? 2 : v >= b[0] ? 1 : 0;
  }

  _table(a = this._alloc(this.objA, this.budget)) {
    const rows = this._rows(a);
    this._filtered = rows;
    const pages = Math.max(1, Math.ceil(rows.length / this.pageSize));
    this.page = clamp(this.page, 0, pages - 1);
    const slice = rows.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    const selected = String(this.ctx.state?.selectedBin ?? '');

    for (const th of this.secTable.querySelectorAll('th')) {
      th.setAttribute('aria-sort',
        th.dataset.key === this.sort.key ? (this.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    }

    this.tbody.innerHTML = slice.map(({ c, i, in: fin }) => `
      <tr data-i="${i}" data-bin="${esc(c.bin)}" class="${fin ? 'in' : ''} ${String(c.bin) === selected ? 'sel' : ''}"
          tabindex="0" title="${esc(c.title || '')}">
        <td class="c-addr"><i class="sev s${this._sev(c.priority)}"></i>${esc(c.addr || `BIN ${c.bin}`)}</td>
        <td class="c-msr">${esc(measureLabel(c.measure))}</td>
        <td class="c-num">${this._asm(this._money2(c.capex?.[0], c.capex?.[1]))}</td>
        <td class="c-num">${this.fmt.num(c.person_hours_avoided)}</td>
        <td class="c-num money">${this.fmt.num(c.usd_per_person_hour, 2)}</td>
        <td class="c-lead">${esc(c.lead_time || '—')}</td>
        <td class="c-num dim">${c.hvi ?? '—'}</td>
        <td class="c-num dim">${this.fmt.num(c.units)}</td>
      </tr>`).join('');

    for (const tr of this.tbody.querySelectorAll('tr')) {
      const go = () => {
        const bin = tr.dataset.bin;
        // Selecting from here drives the model behind the window, so closing it
        // lands on the building you were reading about. The view stays open —
        // picking a row is not a decision to leave.
        try { this.ctx.select?.(bin); } catch { /* host not wired */ }
        const bi = this.d.binToIndex?.get?.(String(bin));
        if (bi !== undefined) { try { this.ctx.scene?.select?.(bi); } catch { /* no scene */ } }
        for (const o of this.tbody.querySelectorAll('tr.sel')) o.classList.remove('sel');
        tr.classList.add('sel');
      };
      tr.onclick = go;
      tr.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    }

    const from = rows.length ? this.page * this.pageSize + 1 : 0;
    const to = Math.min(rows.length, (this.page + 1) * this.pageSize);
    this.pager.innerHTML = `
      <button type="button" class="link" data-d="-1" ${this.page === 0 ? 'disabled' : ''}>Previous</button>
      <span class="pgn">${this.fmt.num(from)}–${this.fmt.num(to)} of ${this.fmt.num(rows.length)}
        · ${this.fmt.num(rows.filter((r) => r.in).length)} in the programme</span>
      <button type="button" class="link" data-d="1" ${this.page >= pages - 1 ? 'disabled' : ''}>Next</button>`;
    for (const b of this.pager.querySelectorAll('button')) {
      b.onclick = () => { this.page += Number(b.dataset.d); this._table(); };
    }
  }

  /* A real download, of exactly what the filters are showing. Exporting the
     whole 407 regardless of the filters was the first implementation and it is
     wrong: someone who has filtered to the cool roofs that can start this season
     and pressed export wants those, and getting the full list back silently is
     the kind of thing that ends up pasted into a board pack.

     The object URL is revoked on the next frame. Revoking it synchronously
     cancelled the download in Safari; not revoking it at all leaked the blob for
     the life of the document. */
  _csv() {
    const a = this._alloc(this.objA, this.budget);
    const rows = this._filtered || this._rows(a);
    const head = ['bin', 'address', 'measure', 'specification', 'capex_low_usd', 'capex_high_usd',
      'capex_midpoint_usd', 'person_hours_avoided', 'usd_per_person_hour', 'kwh_saved_low',
      'kwh_saved_high', 'carbon_t_low', 'carbon_t_high', 'lead_time', 'hvi', 'units',
      'priority', 'in_programme'];
    const q = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(',')];
    for (const { c, in: fin } of rows) {
      lines.push([c.bin, c.addr, c.measure, c.title, c.capex?.[0], c.capex?.[1], mid(c.capex),
        c.person_hours_avoided, c.usd_per_person_hour, c.kwh_saved?.[0], c.kwh_saved?.[1],
        c.carbon_t?.[0], c.carbon_t?.[1], c.lead_time, c.hvi, c.units, c.priority,
        fin ? 'yes' : 'no'].map(q).join(','));
    }
    // The header block records the budget the "in_programme" column was computed
    // against. Without it the file is ambiguous the moment it leaves the browser.
    const meta = `# Urban Canyon portfolio export\n`
      + `# objective,${this.objA}\n# budget_usd,${Math.round(this.budget)}\n`
      + `# candidates_exported,${rows.length}\n`
      + `# note,capex and savings are ranges from the assumption table; the midpoint is a drawing convention\n`
      + (this.data.fixture ? '# WARNING,placeholder fixture data — not for quotation\n' : '');
    const blob = new Blob([meta + lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `portfolio-${this.objA}-${Math.round(this.budget / 1000)}k.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    requestAnimationFrame(() => URL.revokeObjectURL(url));
  }

  /* ------------------------------------------------------------ the render

     One entry point. Every control calls it and it recomputes everything from
     `budget`, `objA` and `objB`, which is affordable because the expensive part
     — 407 candidates through a greedy walk — is a few microseconds, and the
     alternative is five partial update paths and the bugs where they disagree. */

  render() {
    if (!this.root) return;
    const a = this._alloc(this.objA, this.budget);
    this._meta();
    this._drawCurve();
    this._rail(a);
    this._readout();
    this._ledger(a);
    this._objectives(a);
    this._phasing(a);
    this._table(a);
  }

  /** The host may re-select a building from the model while this is open. Kept
   *  as a named method so a host that wires `ctx.on('select', …)` has something
   *  to point at, and called internally by nothing — the view is not the owner
   *  of the selection. */
  update() { if (this.isOpen) this.render(); }
}

export default Portfolio;

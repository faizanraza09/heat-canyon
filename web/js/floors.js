/* The floor schedule.
 *
 * This is the surface that answers the question the whole platform exists for.
 * Someone who manages a building has been told, at length and in colour, that
 * their wall reaches 53 °C. What they say next is always the same thing:
 * "everybody asks me — yeah, what do I do?" A city-wide ranking cannot answer
 * that and neither can a building-level average. A *schedule* can: one row per
 * storey, the same columns every time, dense enough to scan and dull enough to
 * forward to a contractor without editing it first.
 *
 * So this pane is deliberately not a set of cards. It is a document. The visual
 * ambition is spent in three places and nowhere else:
 *
 *   1. THE SEVERITY STRIPE, which must read before any number does. It is a
 *      3px rule down the left edge of each row in --sev-0..4, and because the
 *      rows are flush and unpadded on that edge the stripes form one continuous
 *      column: the shape of the building's problem is visible from across the
 *      room, before a single digit resolves.
 *
 *   2. THE ATTRIBUTION BAR, which is the most valuable object on the surface.
 *      Every row carries solar / trap / sky in kelvin as a stacked bar. The
 *      stack is ALWAYS ordered solar-first outward from the baseline, never
 *      sorted by magnitude, and that ordering is the entire design: in a real
 *      Manhattan canyon the low floors are trap-dominant and the high floors
 *      are solar-dominant, so the amber-to-plum boundary walks steadily
 *      rightward as the eye goes up the building. Sorting the segments, or
 *      giving each row its own scale, would destroy that diagonal — which is
 *      the finding. One scale for the whole building, one segment order, and
 *      the crossover draws itself. Where the dominant term actually flips, a
 *      hairline is drawn between the two rows and named, because a reader who
 *      has not been told what to look at will otherwise look at the numbers.
 *
 *      The sky term is negative. It is relief, not a cause, and stacking it
 *      with the two causes would be a lie of arithmetic — the bar would get
 *      longer as the wall got cooler. It is drawn on the other side of a
 *      baseline, at half the height of the positive stack, so it reads as a
 *      notch taken out rather than as a fourth contribution.
 *
 *   3. THE RANGES. Everything on this surface that passed through the envelope
 *      assumption table — indoor temperature, cooling load, annual energy,
 *      person-hours — is rendered as a range by ctx.fmt.range and carries the
 *      dotted `assumed` underline with the assumption named in its title. A
 *      bare midpoint here would be the single most damaging thing the interface
 *      could do, because a plausible-looking number with no band is exactly
 *      what gets quoted back at a capital committee. Surface temperature and
 *      the attribution terms are NOT marked assumed: they come out of the
 *      solved physics, and flattening the two provenance tiers into one would
 *      throw away the more credible half of the pane. The legend says which is
 *      which, in those words.
 *
 * Two behaviours are worth recording because they were designed for rather than
 * discovered:
 *
 *   - `update()` is called on 'time' as well as 'select', and a played day
 *     fires it twenty-four times. ui.js has already had the bug where
 *     re-rendering a card on every hour tick made it flicker its way through
 *     the day; this module does not re-render on an hour change at all. It
 *     repaints the one thing an hour can affect — which rows peak at the hour
 *     now on the clock — and leaves the DOM, the open floor and the keyboard
 *     cursor alone. Renders are also coalesced into an animation frame, so a
 *     host that calls update() *and* an event subscription that fires cost one
 *     paint between them, not two.
 *
 *   - The schedule is a grid with a roving tabindex rather than a list of
 *     buttons. Forty rows of buttons is forty tab stops before the reader
 *     reaches the prescriptions; one tab stop and arrow keys is how a table is
 *     meant to behave, and it is also how a keyboard user discovers the
 *     crossover, since holding Down walks the boundary across the bar.
 *
 * The module owns web/js/floors.js and web/css/floors.css and writes to no DOM
 * it was not handed. It reads ctx and nothing else — no globals, no ui.js
 * internals — so it can be mounted anywhere a 300–370px column exists.
 */

/* ------------------------------------------------------------------ tools */

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const n0 = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

/* The contract fixes the shape of ctx.fmt.range — "4.1–6.8 kW" — and names the
 * other formatters without fixing their signatures. So range is called
 * directly and everything else goes through this, which takes the host's
 * formatter when it produces a string and falls back to the house convention
 * when it does not. A formatter that throws must not be able to blank the
 * pane; a missing dollar sign is a smaller failure than an empty schedule. */
const via = (fn, args, fallback) => {
  if (typeof fn === 'function') {
    try {
      const s = fn(...args);
      if (typeof s === 'string' && s.length) return s;
      if (Number.isFinite(s)) return String(s);
    } catch { /* fall through */ }
  }
  return fallback;
};

/** A pair may arrive as [lo, hi] or, from an older product, as a scalar. Both
 *  are accepted; a scalar is widened to a degenerate range so that the range
 *  renderer still runs and the figure still reads as a band rather than as a
 *  point. Nothing in this file is allowed to print one end of a pair alone. */
const pair = (v) => (Array.isArray(v)
  ? [Number(v[0]), Number(v[1])]
  : (Number.isFinite(v) ? [Number(v), Number(v)] : null));

const HH = (h) => `${String(h).padStart(2, '0')}h`;

/* Night recovery is a three-state ordinal — how much of the day's heat the
 * envelope sheds overnight — and it decides whether night-purge ventilation is
 * even on the table. Three segments, filled from the left. */
const REC_STEPS = { none: 0, limited: 1, good: 2, unknown: -1 };
const REC_WORDS = {
  none: 'No night recovery: the wall is still warm at dawn, so night-purge '
      + 'ventilation is excluded for this floor.',
  limited: 'Limited night recovery: the wall shed part of the day\'s heat before '
         + 'dawn. Night purge helps here but does not close the gap.',
  good: 'Good night recovery: the wall returns to near air temperature overnight, '
      + 'which is what makes night-purge ventilation worth specifying.',
};

const TERM_WORDS = {
  solar: 'Solar — absorbed shortwave on the wall itself',
  trap: 'Trap — longwave exchanged with the wall opposite, and the street below',
  sky: 'Sky — longwave lost to a cold sky. Negative: relief, not a cause',
  ambient: 'Ambient — no facade term dominates; the air itself is the load',
};

const DOM_TAG = { solar: 'SOL', trap: 'TRP', ambient: 'AMB', sky: 'SKY' };

/* ------------------------------------------------------------------ class */

export class FloorSchedule {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = null;

    this.openFloor = null;   // storey number of the one expanded row, or null
    this.cursor = 0;         // index of the row holding tabindex="0"

    this._renderedBin = undefined;   // undefined = never rendered
    this._hasSchedule = false;
    this._frame = 0;
    this._waiting = false;   // true while decision.ready is outstanding
    this._onChange = () => this._schedule();
  }

  /* --------------------------------------------------------- lifecycle */

  mount(host) {
    this.host = host;
    host.classList.add('fsch');
    const on = this.ctx?.on;
    if (typeof on === 'function') {
      for (const e of ['select', 'time', 'layer']) on.call(this.ctx, e, this._onChange);
    }

    /* The decision products are fetched without being awaited — the atlas is
       40 MB of geometry and these are 1.9 MB of tables nobody can see until a
       building is selected — so `decision.floors` is normally still null at the
       moment this pane is mounted, and `decision.fixture` is still false. Both
       arrive on `decision.ready`. Without waiting on it the pane would sit on
       "not in this build" until the next select event, and a reader who clicked
       a building during that window would be told, wrongly and permanently,
       that their address has no schedule. So the promise is waited on when it
       exists and the pane says it is loading meanwhile — which is a different
       claim from "this build does not have it", and the difference matters. */
    const ready = this.ctx?.decision?.ready;
    if (!this._doc('floors') && ready && typeof ready.then === 'function') {
      this._waiting = true;
      ready.then(() => {
        this._waiting = false;
        if (!this.host) return;         // destroyed while the products landed
        this._renderedBin = undefined;  // force a full render, not the hour path
        this._paint();
      }, () => { this._waiting = false; });
    }

    this._paint();
  }

  /** Called by the host on select / time / layer. Coalesced: see the header. */
  update() { this._schedule(); }

  destroy() {
    const off = this.ctx?.off;
    if (typeof off === 'function') {
      for (const e of ['select', 'time', 'layer']) off.call(this.ctx, e, this._onChange);
    }
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = 0;
    if (this.host) {
      this.host.classList.remove('fsch');
      this.host.textContent = '';
    }
    this.host = null;
    this._body = null;
    this._renderedBin = undefined;
    this._hasSchedule = false;
  }

  _schedule() {
    if (!this.host || this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = 0; this._paint(); });
  }

  /* ------------------------------------------------------------ paint */

  /** The cheap path. An hour tick cannot change a single figure in this pane —
   *  the schedule is a peak-hour artefact — so it must not cost a re-render.
   *  All it changes is which rows are peaking *now*, which is worth showing
   *  because it ties the schedule to the clock along the bottom of the screen. */
  _paint() {
    const bin = this._bin();
    if (bin === this._renderedBin) {
      if (this._hasSchedule) this._paintHour();
      return;
    }
    this._render(bin);
  }

  _bin() {
    const s = this.ctx?.state || {};
    if (typeof s.selectedBin === 'string' || typeof s.selectedBin === 'number') {
      return String(s.selectedBin);
    }
    /* A null selectedBin is a statement — nothing is selected — and must not be
       second-guessed. Falling through to selectedIndex here made the pane open
       on whatever sat at index 0 the moment the user cleared the selection,
       which read as the application refusing to let go of a building. Only an
       ABSENT selectedBin licenses the index route, which exists so the pane
       still works for a host that sets one of the two and not the other. */
    if (s.selectedBin === null) return null;
    const it = this.ctx?.d?.ranked?.items?.[s.selectedIndex];
    return it ? String(it.bin) : null;
  }

  _paintHour() {
    const hour = this.ctx?.state?.hour;
    if (!this._body) return;
    for (const r of this._body.querySelectorAll('.fs-row')) {
      r.classList.toggle('now', Number(r.dataset.hr) === Number(hour));
    }
  }

  /* ----------------------------------------------------------- render */

  _render(bin) {
    const host = this.host;
    if (!host) return;
    host.textContent = '';
    this._body = null;
    this._renderedBin = bin;
    this._hasSchedule = false;

    const doc = this._doc('floors');

    // Absence degrades one pane, never the application: a build with no
    // decision layer is a supported build and says so in one quiet line.
    if (!doc) {
      host.appendChild(this._quiet(this._waiting
        ? 'Reading the floor schedule.'
        : 'The floor schedule is not in this build. It needs web/data/floors.json, '
          + 'which the pipeline writes only when the decision layer runs.'));
      return;
    }
    if (this.ctx?.decision?.fixture || doc.fixture) host.appendChild(this._fixtureBanner());

    if (!bin) {
      host.appendChild(this._quiet(
        'Pick a building to see it storey by storey — what each floor reaches, '
        + 'what it costs to cool, and which term is carrying it.'));
      return;
    }

    const b = (doc.items || doc)[bin];
    if (!b || !Array.isArray(b.floors) || !b.floors.length) {
      const n = doc.n || Object.keys(doc.items || {}).length;
      host.appendChild(this._quiet(
        `No floor schedule for this address. The schedule was solved for the `
        + `${n0(n)} highest-priority buildings only; this one is outside that set.`));
      return;
    }

    this._hasSchedule = true;
    this._b = b;
    this._floors = b.floors;

    host.appendChild(this._headline(bin, b));
    host.appendChild(this._schedule_(b));
    host.appendChild(this._legend(doc));
    const rx = this._prescriptions(bin);
    if (rx) host.appendChild(rx);

    this.cursor = Math.min(this.cursor, this._floors.length - 1);
    this._paintHour();
  }

  /** One of the three decision products, or null.
   *
   *  data.js hands these over as the whole parsed file — `{fixture, n, bands,
   *  items}` — but the interface contract in the brief indexes them straight by
   *  BIN. Rather than pick a side, every call site reads `(doc.items || doc)`,
   *  so a host that hands over either shape works and neither is guessed at
   *  more than once. */
  _doc(key) {
    const v = this.ctx?.decision?.[key];
    if (!v || typeof v !== 'object') return null;
    return v;
  }

  /** The one-line explanation an empty state gets. `pad` is false when the
   *  caller is already inside a padded section — indenting twice put the
   *  sentence 44px in and made it read as a quotation. */
  _quiet(text, pad = true) {
    return el('div', pad ? 'fs-pad fs-quiet' : 'fs-quiet', esc(text));
  }

  /* ---------------------------------------------------------- fixture */

  /* Standing, not dismissible. floors.json currently carries "fixture": true,
   * which means every figure below is a plausible-looking placeholder. An
   * interface that let a reader forget that for even one screenful would be
   * doing the precise thing this project exists not to do. It is not styled as
   * an error either — nothing is broken, the numbers are simply not real yet —
   * so it gets a hairline, a rule in the severity hue and one sentence. */
  _fixtureBanner() {
    const n = el('div', 'fs-fixture');
    n.setAttribute('role', 'note');
    n.innerHTML = `<span class="k">FIXTURE — NOT A SOLVED RESULT</span>
      <p>Every figure below is a placeholder standing in for the real solve.
      The columns, the ranges and the attribution are the ones the finished
      product will carry. The values are not yet measurements of anything, and
      must not be quoted.</p>`;
    return n;
  }

  /* --------------------------------------------------------- headline */

  _headline(bin, b) {
    const box = el('div', 'fs-pad fs-head');
    const d = this.ctx?.d;
    const addr = d?.rankByBin?.get(bin)?.addr
      || d?.buildings?.attrs?.[d?.binToIndex?.get(bin)]?.addr
      || `BIN ${bin}`;

    box.appendChild(el('div', 'fs-addr', esc(addr)));

    const asmWhy = this._assumptionText(b);
    const occ = b.occupancy || {};
    const asm = b.assembly || {};

    /* Storeys first: the two assumed labels are long enough to wrap at 300px,
       and wrapping them last leaves a whole word on the second line rather than
       the orphaned "STOREYS" that ending on the count produced. */
    box.appendChild(el('div', 'fs-sub',
      `${esc(String(b.floors.length))} STOREYS · `
      + `${this._asm(esc(asm.label || 'Envelope unknown'), asmWhy)} · `
      + `${this._asm(esc(occ.label || 'Occupancy unknown'), this._occText(occ))}`));

    /* The one large figure on the surface, and it is a range. A serif midpoint
       here — 453 kW, set at 34px — would be the most over-trusted number in the
       application within a week. The band is the figure. */
    const pk = pair(b.peak_kw);
    const big = el('div', 'fs-big');
    big.innerHTML = `<div class="v">${this._asm(
      pk ? esc(this._range(pk[0], pk[1], '')) : '—', asmWhy)}</div>
      <div class="u">KW PEAK COOLING LOAD · WHOLE BUILDING</div>`;
    box.appendChild(big);

    const mwh = pair(b.annual_mwh);
    const grid = el('div', 'fs-grid');
    const cell = (k, v, why) => {
      grid.appendChild(el('div', null,
        `<div class="k">${esc(k)}</div><div class="v">${why ? this._asm(v, why) : v}</div>`));
    };
    cell('ANNUAL COOLING', mwh ? esc(this._range(mwh[0], mwh[1], 'MWh')) : '—', asmWhy);
    cell('WORST FLOOR', b.worst_floor ? `${esc(String(b.worst_floor))}` : '—',
      'The storey with the highest severity band, which is a quintile of the '
      + 'indoor estimate, the annual dose and the solar term across every floor '
      + 'in this schedule. Assumed, because two of those three are.');
    cell('PEAK AT', b.peak_hour_edt !== undefined ? esc(HH(b.peak_hour_edt)) : '—', null);
    cell('PERSON-HOURS >28 °C', b.person_hours ? esc(n0(b.person_hours)) : '—',
      'Occupied hours above 28 °C indoors, summed over the year and over the '
      + 'assumed household size. Assumed twice over: the indoor estimate and '
      + 'the occupancy schedule.');
    box.appendChild(grid);

    box.appendChild(el('p', 'fs-note',
      'Everything below is <b>assumed</b> — the project\'s fourth and softest '
      + 'provenance tier, under measured, reanalysis and modelled. It means the '
      + 'figure came through a stated assumption table that no measurement in '
      + 'this study constrains, and it is why these are ranges and never single '
      + 'numbers. Dotted underlines carry the assumption; hover one.'));

    return box;
  }

  _assumptionText(b) {
    const a = b.assembly || {};
    const u = pair(a.u_wall); const w = pair(a.wwr); const s = pair(a.shgc);
    const bits = [];
    if (u) bits.push(`U-wall ${n1(u[0])}–${n1(u[1])} W/m²K`);
    if (w) bits.push(`window-to-wall ${w[0].toFixed(2)}–${w[1].toFixed(2)}`);
    if (s) bits.push(`SHGC ${s[0].toFixed(2)}–${s[1].toFixed(2)}`);
    return `Assumed envelope — ${a.label || 'unknown assembly'}`
      + (bits.length ? `: ${bits.join(', ')}.` : '.')
      + (a.note ? ` ${a.note}` : '')
      + ' Every range on this surface is the width of these assumptions.';
  }

  _occText(o) {
    const p = [];
    if (o.setpoint_c !== undefined) p.push(`comfort setpoint ${n1(o.setpoint_c)} °C`);
    if (o.persons !== undefined) p.push(`${n1(o.persons)} persons per unit`);
    if (o.overnight) p.push('occupied overnight');
    return `Assumed occupancy — ${o.label || 'unknown'}`
      + (p.length ? `: ${p.join(', ')}.` : '.')
      + ' A schedule, not a survey.';
  }

  /** Mark an assumed figure.
   *
   *  ctx.js exports the layer's own `assumed()` helper and it is used when the
   *  host provides it, so that all four decision surfaces mark the fourth
   *  provenance tier identically and a change to that treatment lands in one
   *  place. The local fallback exists only for a host that predates it, and
   *  adds `tabindex` so the assumption is reachable without a mouse. */
  _asm(html, why) {
    const f = this.ctx?.assumed;
    if (typeof f === 'function') {
      try {
        const out = f(html, why);
        if (typeof out === 'string' && out) return out;
      } catch { /* fall through to the local treatment */ }
    }
    return `<span class="asm" tabindex="0" title="${esc(why || 'Assumed.')}">${html}</span>`;
  }

  /** The one way a range reaches the screen.
   *
   *  `how` is ctx.fmt.range's own per-end formatter hook, and it is used for
   *  exactly one column. The shared formatter drops to whole numbers above ten,
   *  which is right for a load in kilowatts and wrong for the indoor estimate:
   *  the whole band there is about three kelvin, and rounding both ends to
   *  integers turns 26.6–29.5 into 27–29 and quietly hides a third of the
   *  spread the column exists to show. Everything else takes the house
   *  default, because four surfaces each picking their own precision is how a
   *  layer stops looking like one instrument. */
  _range(lo, hi, unit, how) {
    return via(this.ctx?.fmt?.range, [lo, hi, unit, how],
      how ? `${how(lo)}–${how(hi)}` : `${n1(lo)}–${n1(hi)}${unit ? ` ${unit}` : ''}`);
  }

  /* --------------------------------------------------------- schedule */

  _schedule_(b) {
    const floors = b.floors;
    const wrap = el('div', 'fs-sched');

    /* One scale for the whole building. Per-row normalisation would make every
       bar full width and the crossover would disappear — the reader would see
       twelve identical bars whose colours happened to differ, instead of one
       quantity growing and another shrinking up the elevation. */
    let maxPos = 0; let maxSky = 0;
    for (const f of floors) {
      maxPos = Math.max(maxPos, Math.max(0, f.solar || 0) + Math.max(0, f.trap || 0));
      maxSky = Math.max(maxSky, Math.abs(Math.min(0, f.sky || 0)));
    }
    const span = (maxPos + maxSky) || 1;
    const zero = (maxSky / span) * 100;     // baseline, per cent from the left

    wrap.appendChild(this._schedHead(zero));

    const body = el('div', 'fs-body');
    body.setAttribute('role', 'grid');
    body.setAttribute('aria-label', 'Floor schedule, one row per storey');
    body.setAttribute('aria-rowcount', String(floors.length));
    body.tabIndex = -1;

    /* Top of the building at the top of the list. A schedule that started at
       floor 1 read as a stack seen from underneath; reversed, the column of
       stripes is the elevation, and the crossover is where it is on the
       building. The floor numbers still descend, so nobody has to be told. */
    const order = floors.slice().reverse();
    let prevDom = null;
    let html = '';
    for (let i = 0; i < order.length; i++) {
      const f = order[i];
      const dom = (f.dom || '').toLowerCase();
      // The marker goes between the last solar-dominant row and the first
      // trap-dominant one below it. Reading downward that is a change from
      // solar to trap; reading up the building it is the takeover.
      if (prevDom === 'solar' && dom === 'trap') html += this._crossover(order[i - 1]);
      prevDom = dom;
      html += this._row(f, span, zero, floors.length - 1 - i);
    }
    body.innerHTML = html;

    body.addEventListener('click', (e) => {
      const row = e.target.closest?.('.fs-row');
      if (row && body.contains(row)) this._toggle(Number(row.dataset.f), row);
    });
    body.addEventListener('keydown', (e) => this._key(e));
    body.addEventListener('focusin', (e) => {
      const row = e.target.closest?.('.fs-row');
      if (row) this._setCursor(Number(row.dataset.i), false);
    });

    wrap.appendChild(body);
    this._body = body;
    this._setCursor(this.cursor, false);

    // A floor left open across a re-render stays open: someone comparing two
    // buildings' fourth floors should not have to re-open it each time.
    if (this.openFloor !== null) {
      const row = body.querySelector(`.fs-row[data-f="${this.openFloor}"]`);
      if (row) this._toggle(this.openFloor, row, true);
      else this.openFloor = null;
    }
    return wrap;
  }

  _schedHead(zero) {
    const h = el('div', 'fs-thead');
    /* The units live in the headings, which is what lets the cells themselves
       hold nothing but digits — and a column of nothing but digits is the only
       kind that can be scanned. The two assumed columns carry the dotted
       underline on the heading rather than on nine hundred cells. */
    h.innerHTML = `
      <div class="l1">
        <span class="c-f">FL</span>
        <span class="c-t" title="Peak facade surface temperature on the hottest face of the storey, in degrees Celsius. Modelled by the solver, not assumed.">°C</span>
        <span class="c-h">EDT</span>
        <span class="c-in asm" tabindex="0" title="Free-running indoor air in degrees Celsius, assuming NO mechanical cooling. An estimate: a steady-state balance is not a dynamic building simulation.">INDOOR °C</span>
        <span class="c-kw asm" tabindex="0" title="Peak cooling load for the storey in kilowatts, across the assumed envelope range.">KW</span>
      </div>
      <div class="l2">
        <span class="c-dom">TERM</span>
        <span class="c-bar" style="--zero:${zero.toFixed(2)}%">
          <span class="u-sky">SKY</span><span class="u-pos">SOLAR · TRAP, K</span>
        </span>
        <span class="c-rec">REC</span>
      </div>`;
    return h;
  }

  /** One storey. Two lines: the figures, then the attribution across the full
   *  width. The bar gets the width because the bar is the finding. */
  _row(f, span, zero, i) {
    const dom = (f.dom || '').toLowerCase();
    const sev = Math.max(0, Math.min(4, Number(f.sev) || 0));
    const tin = pair(f.t_in);
    const kw = pair(f.peak_w);
    const hr = this._peakHour(f);
    const solar = Math.max(0, f.solar || 0);
    const trap = Math.max(0, f.trap || 0);
    const sky = Math.abs(Math.min(0, f.sky || 0));
    const pc = (v) => `${((v / span) * 100).toFixed(3)}%`;
    const rec = String(f.rec || 'unknown').toLowerCase();
    const steps = REC_STEPS[rec] ?? -1;

    const kwTxt = kw ? this._range(kw[0] / 1000, kw[1] / 1000, '') : '—';
    const inTxt = tin ? this._range(tin[0], tin[1], '', n1) : '—';
    const band = f.band !== undefined
      ? ` Solved band ${f.band + 1}${f.storeys ? ` of the ten, which covers ${f.storeys} storeys` : ''}.`
      : '';

    const rects = [
      sky > 0 ? `<i class="s-sky" style="right:${(100 - zero).toFixed(3)}%;width:${pc(sky)}"></i>` : '',
      solar > 0 ? `<i class="s-solar" style="left:${zero.toFixed(3)}%;width:${pc(solar)}"></i>` : '',
      trap > 0 ? `<i class="s-trap" style="left:calc(${zero.toFixed(3)}% + ${pc(solar)});width:${pc(trap)}"></i>` : '',
    ].join('');

    return `<div class="fs-row" role="row" tabindex="-1" data-f="${f.f}" data-i="${i}"
        data-hr="${hr ?? ''}" data-dom="${esc(dom)}" aria-expanded="false"
        aria-label="Floor ${f.f}, severity ${sev} of 4, ${n1(f.t_surf)} degrees at the surface, ${esc(dom)} dominant">
      <i class="sev" style="background:var(--sev-${sev})"
         title="Severity ${sev} of 4 — a quintile across every floor in this schedule.${band}"></i>
      <div class="fs-cells">
        <div class="l1">
          <span class="c-f">${f.f}</span>
          <span class="c-t" title="Peak facade surface temperature on the hottest face of this storey. Modelled, not assumed.">${n1(f.t_surf)}</span>
          <span class="c-h">${hr === null ? '—' : HH(hr)}</span>
          <span class="c-in">${esc(inTxt)}</span>
          <span class="c-kw">${esc(kwTxt)}</span>
        </div>
        <div class="l2">
          <span class="c-dom t-${esc(dom)}" title="${esc(TERM_WORDS[dom] || 'Dominant term')}">${esc(DOM_TAG[dom] || '—')}</span>
          <span class="c-bar" title="Solar ${n1(f.solar)} K · trap ${n1(f.trap)} K · sky ${n1(f.sky)} K">
            <i class="axis" style="left:${zero.toFixed(3)}%"></i>${rects}
          </span>
          <span class="c-rec r${steps}" title="${esc(REC_WORDS[rec] || 'Night recovery not stated.')}">
            <i></i><i></i><i></i>
          </span>
        </div>
      </div>
    </div>`;
  }

  /* The moment the surface is designed around, stated in words so that it is
     not left to be noticed. Only the first flip going up is marked: a canyon
     with a set-back can flip twice and two labels would read as noise. */
  _crossover(above) {
    return `<div class="fs-cross" role="presentation">
      <span>SOLAR TAKES OVER AT FLOOR ${above.f}</span>
      <em>below, the wall opposite; above, the sun</em>
    </div>`;
  }

  /** floors.json carries no per-storey peak hour, but it carries the faces and
   *  t_surf is the hottest of them — so the hour is the hour of the face that
   *  matches. Derived rather than approximated with the building-level hour,
   *  which is a different claim: floor 3 in a canyon peaks at 18h off a
   *  north-west wall long after the building as a whole peaked at 15h, and
   *  that displacement is exactly what a schedule is for. */
  _peakHour(f) {
    let best = null; let bt = -Infinity;
    for (const face of f.faces || []) {
      if (Number(face.t) > bt) { bt = Number(face.t); best = face; }
    }
    if (best && Number.isFinite(Number(best.hr))) return Number(best.hr);
    const h = this._b?.peak_hour_edt;
    return Number.isFinite(h) ? h : null;
  }

  /* ------------------------------------------------------ face detail */

  _toggle(floorNo, row, force = false) {
    const open = this.openFloor === floorNo && !force;
    // One at a time. Two open panels at this width turns the schedule into a
    // list of cards, which is the thing it is deliberately not.
    for (const d of this._body.querySelectorAll('.fs-faces')) d.remove();
    for (const r of this._body.querySelectorAll('.fs-row.open')) {
      r.classList.remove('open');
      r.setAttribute('aria-expanded', 'false');
    }
    if (open) { this.openFloor = null; return; }

    const f = this._floors.find((x) => x.f === floorNo);
    if (!f) { this.openFloor = null; return; }
    this.openFloor = floorNo;
    row.classList.add('open');
    row.setAttribute('aria-expanded', 'true');
    row.after(this._faces(f));
  }

  _faces(f) {
    const box = el('div', 'fs-faces');
    box.setAttribute('role', 'presentation');
    /* Annual cooling for one storey runs to tens of thousands of kilowatt-hours,
       and a five-digit range twice over does not fit a 300px line and would not
       be read if it did. Over a megawatt-hour it is quoted in MWh — the same
       unit the headline uses, so the two can be added up by eye. */
    const ann = pair(f.annual_kwh);
    const annTxt = ann
      ? (Math.max(ann[0], ann[1]) >= 1000
        ? this._range(ann[0] / 1000, ann[1] / 1000, 'MWh/yr')
        : this._range(ann[0], ann[1], 'kWh/yr'))
      : '';
    let html = `<div class="fs-fhead">FLOOR ${f.f} · ${n0(f.envelope_m2)} m² OF ENVELOPE`
      + `${annTxt ? ` · <span class="asm" tabindex="0" title="Annual cooling energy for this storey, across the assumed envelope range.">${esc(annTxt)}</span>` : ''}</div>`;

    const faces = (f.faces || []).slice().sort((a, b) => (b.t || 0) - (a.t || 0));
    for (const fa of faces) {
      const w = pair(fa.w);
      const wss = Number(fa.wss);
      html += `<div class="fs-face">
        <div class="a">
          <span class="c">${esc(fa.c || '—')}</span>
          <span class="az">${n0(fa.az)}°</span>
          <span class="t">${n1(fa.t)} °C</span>
          <span class="h">${Number.isFinite(Number(fa.hr)) ? HH(Number(fa.hr)) : '—'}</span>
        </div>
        <div class="b">
          <span>${n0(fa.m2)} m²</span>
          <span class="asm" tabindex="0" title="Peak cooling load through this face, across the assumed envelope range.">${w ? esc(this._range(w[0] / 1000, w[1] / 1000, 'kW')) : '—'}</span>
          <span>${n0(fa.sunh)} SUN H/YR</span>
        </div>
        <div class="c-wss" title="Share of this face's annual sunlit hours that fall in winter. Above about a third, fixed shading starts costing more in January heating than it saves in July, and the prescription moves to an operable device.">
          <i style="width:${Math.max(0, Math.min(1, wss || 0)) * 100}%"></i>
          <span>${Number.isFinite(wss) ? `${Math.round(wss * 100)}% OF SUN IN WINTER` : 'WINTER SHARE —'}</span>
        </div>
      </div>`;
    }
    if (!faces.length) html += '<div class="fs-quiet">No per-face breakdown for this storey.</div>';
    box.innerHTML = html;
    return box;
  }

  /* ------------------------------------------------------------ keys */

  _key(e) {
    const rows = [...this._body.querySelectorAll('.fs-row')];
    if (!rows.length) return;
    // The rows are drawn top-down but numbered bottom-up, so "next" is defined
    // in DOM order: Down moves down the screen, which is down the building.
    const at = rows.findIndex((r) => r === document.activeElement);
    const cur = at >= 0 ? at : rows.findIndex((r) => r.tabIndex === 0);
    let next = null;
    switch (e.key) {
      case 'ArrowDown': next = Math.min(rows.length - 1, cur + 1); break;
      case 'ArrowUp': next = Math.max(0, cur - 1); break;
      case 'PageDown': next = Math.min(rows.length - 1, cur + 8); break;
      case 'PageUp': next = Math.max(0, cur - 8); break;
      case 'Home': next = 0; break;
      case 'End': next = rows.length - 1; break;
      case 'Enter': case ' ':
        e.preventDefault();
        if (rows[cur]) this._toggle(Number(rows[cur].dataset.f), rows[cur]);
        return;
      default: return;
    }
    e.preventDefault();
    const row = rows[next];
    if (!row) return;
    for (const r of rows) r.tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
    this.cursor = Number(row.dataset.i);
    row.scrollIntoView({ block: 'nearest' });
  }

  _setCursor(i, focus) {
    if (!this._body) return;
    const rows = [...this._body.querySelectorAll('.fs-row')];
    if (!rows.length) return;
    const row = rows.find((r) => Number(r.dataset.i) === i) || rows[0];
    for (const r of rows) r.tabIndex = -1;
    row.tabIndex = 0;
    this.cursor = Number(row.dataset.i);
    if (focus) row.focus();
  }

  /* ---------------------------------------------------------- legend */

  _legend(doc) {
    const box = el('div', 'fs-pad fs-legend');
    box.innerHTML = `
      <div class="klabel">HOW TO READ IT</div>
      <div class="fs-keys">
        <span><i style="background:var(--term-solar)"></i>SOLAR</span>
        <span><i style="background:var(--term-trap)"></i>TRAP</span>
        <span><i style="background:var(--term-sky)"></i>SKY, RELIEF</span>
      </div>
      <div class="fs-sev">
        <i style="background:var(--sev-0)"></i><i style="background:var(--sev-1)"></i>
        <i style="background:var(--sev-2)"></i><i style="background:var(--sev-3)"></i>
        <i style="background:var(--sev-4)"></i>
        <span>SEVERITY 0 TO 4</span>
      </div>
      <p>The stack always runs solar first, outward from the baseline, so the
      boundary between the two colours walks across the bar as you read up the
      building. Where it crosses, the measure changes: shade a solar-dominant
      floor, and the trap-dominant floors below it will not notice.</p>
      <p><b>Indoor is an estimate.</b> It is the free-running air temperature
      with no mechanical cooling running, from a steady-state balance — not a
      dynamic simulation, and wrong for a heavy building on a short event.
      Surface temperature and the three attribution terms are modelled by the
      solver; indoor, load and person-hours are <b>assumed</b>, which is why
      they carry ranges.</p>`;
    return box;
  }

  /* --------------------------------------------------- prescriptions */

  _prescriptions(bin) {
    const doc = this._doc('prescriptions');
    const list = doc ? ((doc.items || doc)[bin] || null) : null;
    const box = el('div', 'fs-pad fs-rx');
    box.appendChild(el('div', 'klabel', list?.length
      ? `WHAT TO DO (${list.length})` : 'WHAT TO DO'));

    if (!list || !list.length) {
      box.appendChild(this._quiet('No measure is specified for this building yet.', false));
    } else {
      for (const p of list) {
        const lo = p.floors?.[0]; const hi = p.floors?.[1];
        const item = el('div', 'fs-measure');
        item.innerHTML = `
          <div class="t">${esc(p.title || p.key || 'Measure')}</div>
          <div class="m">${lo !== undefined ? `FLOORS ${esc(String(lo))}–${esc(String(hi))}` : 'WHOLE BUILDING'}
            ${p.faces?.length ? ` · ${esc(p.faces.join(' ').toUpperCase())}` : ''}
            ${p.lead_time ? ` · ${esc(String(p.lead_time).toUpperCase())}` : ''}</div>
          ${p.does_not_fix ? `<div class="nf">Does not fix: ${esc(p.does_not_fix)}</div>` : ''}`;

        /* Hovering a measure lights the storeys it actually reaches. The
           `does_not_fix` sentence is the honest half of a prescription and it
           is much easier to believe when the floors it leaves alone stay dark
           in the schedule above. */
        const mark = (on) => this._markRange(on ? lo : null, hi);
        item.addEventListener('mouseenter', () => mark(true));
        item.addEventListener('mouseleave', () => mark(false));
        box.appendChild(item);
      }
    }

    const btn = el('button', 'fs-brief', 'OPEN THE BUILDING BRIEF');
    btn.type = 'button';
    btn.addEventListener('click', () => this.ctx?.openBrief?.(bin));
    box.appendChild(btn);
    return box;
  }

  _markRange(lo, hi) {
    if (!this._body) return;
    for (const r of this._body.querySelectorAll('.fs-row')) {
      const f = Number(r.dataset.f);
      r.classList.toggle('in-range', lo !== null && f >= lo && f <= hi);
    }
  }
}

export default FloorSchedule;

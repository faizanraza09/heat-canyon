/* The guided tour.
 *
 * The film explains why the city is hot. It says nothing about the instrument,
 * and someone who has just watched ninety seconds of cinema is looking at three
 * panels, six layers, a day on a scrubber and two camera modes, with no idea
 * which one to touch first. This walks them through it: one spotlight and one
 * card per control, in the order you would actually use them.
 *
 * Rules it follows, learned from every onboarding overlay that has ever annoyed
 * anyone:
 *
 *   - It plays once. `hc.tour.v1` in localStorage retires it, and the masthead
 *     keeps a Tour chip so it can be asked for again.
 *   - It never blocks the suite. `?intro=0`, which every Playwright spec uses,
 *     suppresses the tour as well as the film; `?tour=1` forces it back.
 *   - Every step points at a real element, resolved at the moment the step
 *     opens. A control that is hidden or absent — the photoreal block on a
 *     build without it, the fold handles before the UI has made them — drops
 *     its step rather than spotlighting an empty rectangle.
 *   - Steps that talk about a panel first *put* the interface in that state, so
 *     the card describing the scenario table has the scenario table next to it.
 *     Going back re-runs the previous step's `enter`, so the sequence reads the
 *     same in both directions.
 *
 * The dim is painted by a 9999px box-shadow on the spotlight rather than by a
 * scrim with a hole punched in it: one element, one transition, and the
 * highlight glides between targets for free. A separate transparent scrim above
 * it swallows clicks, because a half-guided interface where the user can click
 * anything is worse than one that waits.
 */

const SEEN_KEY = 'hc.tour.v1';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const f0 = (v) => (isFinite(v) ? Math.round(v).toLocaleString() : '—');
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/* ------------------------------------------------------------------ steps */

/* `body` may be a function of the dataset, so the copy can name the actual
   heat wave, the actual peak hour and the actual building count instead of
   describing the software in the abstract. */
const STEPS = [
  {
    id: 'welcome',
    place: 'center',
    dim: 'full',
    kicker: (d) => d.meta.event.label,
    title: 'The instrument',
    body: (d) => `You are looking at ${f0(d.buildings.n)} Midtown buildings on the
      hottest afternoon of the record, with ${f0(d.facades.n)} wall panels solved
      for sun, shade and re-radiation from the street.
      <br /><br />
      Two minutes and you will know where every control is. You can leave at any
      point with <kbd>Esc</kbd>.`,
    next: 'Show me around',
  },
  {
    id: 'city',
    target: '#gl',
    spot: false,
    dim: 'light',
    place: 'center',
    title: 'The model itself',
    body: `<b>Drag in any direction</b> to slide across the city, <b>scroll</b> to zoom,
      <b>right-drag</b> to tilt and turn. <b>Click any building</b> and its file
      opens on the right.
      <br /><br />
      Nothing here is decoration: wall colour is modelled surface temperature at
      the hour on the scrubber, and the ground wash is the measured air-temperature
      field.`,
  },
  {
    id: 'layers',
    target: ['#layers', '#legend'],
    place: 'right',
    tab: 'view',
    enter: (ui) => ui.setLayer('surface'),
    title: 'What is drawn',
    body: `Six views of the same block. The first two are this hour — how hot each
      wall is, and which walls the sun is on. The next two are the whole seven-day
      wave, because duration is what puts people in hospital, not peak.
      <b>Where to act</b> combines exposure with how badly the occupants can cope.
      <br /><br />
      The scale below is fixed for the entire day, so playing the day reads as the
      city changing rather than the legend rescaling underneath it.`,
  },
  {
    id: 'time',
    target: '#time',
    place: 'top',
    title: 'The day',
    body: (d) => `${d.meta.hours.length} hours, ${hh(d.meta.hours[0].edt)} to
      ${hh(d.meta.hours[d.meta.hours.length - 1].edt)} EDT.
      ${hh(d.meta.hours[d.meta.peak_index].edt)} is the peak and where you started
      — air ${d.meta.hours[d.meta.peak_index].t_anchor_c.toFixed(1)} °C, sun
      ${Math.round(d.meta.hours[d.meta.peak_index].sun_alt)}° up.
      <br /><br />
      Press <b>▶</b> to run the day and watch the lit band climb the east walls
      while the west side stays in shade. The row of figures underneath is the
      measured weather that drove that hour.`,
  },
  {
    id: 'camera',
    target: '.camrow',
    place: 'right',
    tab: 'view',
    title: 'Get down into it',
    body: `<b>Walk the street</b> drops the camera to eye level in a real canyon —
      <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to walk,
      <kbd>Q</kbd>/<kbd>E</kbd> to move down/up, drag to look,
      <b>Next street</b> to jump to the next viewpoint. The hint line names the
      canyon and gives the two wall heights and the width between them.
      <br /><br />
      This is the view that makes the point: the temperature you feel on the
      pavement is set by the walls either side of you, not by the forecast.`,
  },
  {
    id: 'ranked',
    target: '#side',
    place: 'left',
    enter: (ui) => ui.showList(),
    title: 'Where to act first',
    body: (d) => `${f0(d.ranked.n_scored)} buildings ranked by heat exposure
      against how badly their occupants can cope — age of stock, homes inside,
      the city's own heat-vulnerability index.
      <br /><br />
      Ranking is not a verdict. It is a queue, and the file behind each row shows
      its whole working.`,
  },
  {
    id: 'detail',
    target: '#side-body',
    place: 'left',
    enter: (ui) => ui.showDetail(0),
    title: 'One building',
    body: `Hours above 35 °C, the longest unbroken run, the hottest wall and the
      difference between its faces, then temperature up the height of the
      building with an uncertainty band, then the reasons it ranks where it does,
      then what can be done about it.
      <br /><br />
      Selecting a row also selects the building in the model, and clicking a
      building in the model opens its file here.`,
  },
  {
    id: 'whatif',
    target: '#tab-whatif',
    place: 'right',
    tab: 'whatif',
    title: 'What if',
    body: `Trees, a cool roof, lighter paving, an awning — each row re-solves that
      canyon at the hour you are on and reports the change in °C on the road, on
      the wall, on the air, and on what a body standing there actually exchanges
      heat with.
      <br /><br />
      Which is why trees do a great deal on a shallow street and almost nothing
      on a deep one already in shade. Same intervention, different street,
      different answer.`,
  },
  {
    id: 'ask',
    target: '#tab-ask',
    place: 'right',
    tab: 'ask',
    title: 'Ask',
    body: `Plain questions against the dataset — the hottest wall, which streets
      never cool down, what a given intervention buys. Answers come back with the
      figures they were computed from, so you can check them against the panels.`,
  },
  {
    id: 'photoreal',
    target: '#photoreal',
    place: 'right',
    tab: 'view',
    title: 'Photoreal context',
    body: `Optional. This drapes the model over Google's 3D city mesh — real
      roads, kerbs, vehicles — so the heat sits on a street you recognise. It
      needs your own Maps API key and it is off until you paste one, so an idle
      session never spends a tile request.`,
  },
  {
    id: 'fold',
    target: () => document.querySelector('#left .fold'),
    place: 'right',
    title: 'Get out of the way',
    body: `The arrows fold either panel away, and <kbd>Esc</kbd> folds both at
      once — the fastest route to just looking at the city. The handles at the
      edge bring them back.`,
  },
  {
    id: 'done',
    place: 'center',
    dim: 'full',
    title: 'That is the whole instrument',
    body: `Start anywhere. If you want one route: leave it on
      <b>Facade temperature</b>, press <b>▶</b> to run the afternoon, then take
      the top-ranked building and walk its street.
      <br /><br />
      <b>Tour</b> and <b>Film</b> in the masthead replay either of these whenever
      you want them.`,
    next: 'Start exploring',
  },
];

/* ------------------------------------------------------------------- tour */

export class Tour {
  /** Whether to run unprompted.
   *
   *  `?intro=0` covers the whole opening sequence, film and tour together: the
   *  Playwright suite sets it and none of those specs should have to dismiss an
   *  overlay before they can click a layer. `?tour=1` forces the tour on for
   *  working on it, `?tour=0` off. Otherwise it is once per browser.
   */
  static wanted(search = location.search) {
    const q = new URLSearchParams(search);
    if (q.get('tour') === '1') return true;
    if (q.get('tour') === '0') return false;
    if (q.get('intro') === '0' || q.get('film') === '0') return false;
    try {
      if (localStorage.getItem(SEEN_KEY)) return false;
    } catch { /* private mode: treat as unseen */ }
    return true;
  }

  static seen() {
    try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* ignore */ }
  }

  constructor(ui) {
    this.ui = ui;
    this.d = ui.d;
    this.i = -1;
    this.active = false;
    this.steps = STEPS;
    this._rect = null;
  }

  /* ------------------------------------------------------------ lifecycle */

  start() {
    if (this.active) return;
    this.active = true;
    document.body.classList.add('tour-running');
    this._build();
    this._keys = (e) => this._onKey(e);
    // Capture, and stopped there: the application binds Escape to folding both
    // panels, and while the tour is up Escape means leave the tour.
    window.addEventListener('keydown', this._keys, true);
    this._onResize = () => this._place(true);
    window.addEventListener('resize', this._onResize);
    this._follow();
    this.go(0);
  }

  /** Take the tour down. `reason` is only for the console. */
  end(reason = 'done') {
    if (!this.active) return;
    this.active = false;
    Tour.seen();
    cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown', this._keys, true);
    window.removeEventListener('resize', this._onResize);
    document.body.classList.remove('tour-running');
    this.root.classList.add('over');
    const root = this.root;
    setTimeout(() => root.remove(), 420);
    this.root = null;
    const chip = $('tour-replay');
    if (chip) chip.hidden = false;
    console.log(`tour ${reason}`);
  }

  next() {
    if (this.i >= this.steps.length - 1) return this.end('finished');
    this.go(this.i + 1, +1);
  }

  back() {
    if (this.i <= 0) return;
    this.go(this.i - 1, -1);
  }

  /** Open a step, skipping past any whose target has gone missing.
   *  `dir` is the direction to keep skipping in. */
  go(i, dir = +1) {
    let n = i;
    while (n >= 0 && n < this.steps.length) {
      const c = this.steps[n];
      // The tab has to be up before the target can be measured — a control in a
      // hidden pane has no box, so the scenario table would read as missing and
      // its step would be skipped — which is why this runs inside the search
      // rather than after it.
      if (c.tab) this.ui.showTab?.(c.tab);
      if (this._usable(c)) break;
      n += dir;
    }
    if (n < 0) return;
    if (n >= this.steps.length) return this.end('finished');

    this.i = n;
    const s = this.steps[n];
    try { s.enter?.(this.ui); } catch (e) { console.warn(`tour step ${s.id}:`, e); }

    this._render(s);
    requestAnimationFrame(() => {
      const t = this._target(s);
      // Controls low in a scrolling panel — the photoreal block, most often —
      // have to be brought into view before there is anything to point at.
      if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      this._place(true);
    });
  }

  /* --------------------------------------------------------------- targets */

  _usable(s) {
    if (!s.target) return true;
    return !!this._target(s);
  }

  /** Resolve a step's target to a single element, or null. Steps may name
   *  several (`['#layers', '#legend']`) and get the union of their boxes. */
  _target(s) {
    const list = this._targets(s);
    return list[0] || null;
  }

  _targets(s) {
    if (!s.target) return [];
    const one = (t) => {
      const n = typeof t === 'function' ? t() : document.querySelector(t);
      if (!n) return null;
      if (n.hidden || n.closest('[hidden]')) return null;
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return n;
    };
    return (Array.isArray(s.target) ? s.target : [s.target]).map(one).filter(Boolean);
  }

  /** Union of a step's target boxes, in viewport coordinates, with padding.
   *
   *  Clipped to whatever scrolls around them, so a control near the bottom of
   *  the left rail's scrolling body gets a highlight that stops at the panel
   *  edge instead of one that runs off past it. If the clip leaves nothing —
   *  the target is scrolled clean out of view and the smooth scroll has not
   *  arrived yet — the unclipped box stands, and the next frame corrects it.
   */
  _box(s) {
    const ns = this._targets(s);
    if (!ns.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const n of ns) {
      const q = n.getBoundingClientRect();
      l = Math.min(l, q.left); t = Math.min(t, q.top);
      r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    }
    const c = this._clipRect(ns[0]);
    if (c) {
      const cl = Math.max(l, c.left), ct = Math.max(t, c.top);
      const cr = Math.min(r, c.right), cb = Math.min(b, c.bottom);
      if (cr - cl > 8 && cb - ct > 8) { l = cl; t = ct; r = cr; b = cb; }
    }
    const p = 8;
    return {
      left: Math.max(2, l - p), top: Math.max(2, t - p),
      width: Math.min(window.innerWidth - 4, r - l + p * 2),
      height: Math.min(window.innerHeight - 4, b - t + p * 2),
    };
  }

  /** The visible rect of the nearest ancestor that clips its content. */
  _clipRect(node) {
    for (let n = node.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n);
      if (/(auto|scroll|hidden)/.test(o.overflowY + o.overflowX)) {
        return n.getBoundingClientRect();
      }
    }
    return null;
  }

  /* ----------------------------------------------------------------- chrome */

  _build() {
    // A tour asked for again while the previous one is still fading out would
    // otherwise leave two #tour subtrees in the document.
    document.getElementById('tour')?.remove();
    const root = el('div', null, '');
    root.id = 'tour';
    root.innerHTML = `
      <div id="tour-scrim"></div>
      <div id="tour-spot"></div>
      <div id="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <i id="tour-arrow"></i>
        <p id="tour-kicker"></p>
        <h2 id="tour-title"></h2>
        <div id="tour-body"></div>
        <div id="tour-foot">
          <div id="tour-dots"></div>
          <div id="tour-btns">
            <button id="tour-quit" class="ghost">Skip tour</button>
            <button id="tour-back" class="ghost">Back</button>
            <button id="tour-next">Next</button>
          </div>
        </div>
      </div>`;
    document.getElementById('app').appendChild(root);
    this.root = root;

    $('tour-next').onclick = () => this.next();
    $('tour-back').onclick = () => this.back();
    $('tour-quit').onclick = () => this.end('skipped');
    // Clicking the dim is not "next": on a tour, an accidental click that eats a
    // step is worse than one that does nothing.
    $('tour-scrim').onclick = (e) => e.stopPropagation();

    const dots = $('tour-dots');
    this.steps.forEach((s, k) => {
      const dot = el('button', 'dot');
      const label = typeof s.title === 'function' ? s.title(this.d) : s.title;
      dot.title = label;
      dot.setAttribute('aria-label', `Step ${k + 1}: ${label}`);
      dot.onclick = () => this.go(k, k > this.i ? +1 : -1);
      dots.appendChild(dot);
    });
  }

  _render(s) {
    const text = (v) => (typeof v === 'function' ? v(this.d) : v || '');
    $('tour-kicker').innerHTML = text(s.kicker);
    $('tour-kicker').hidden = !s.kicker;
    $('tour-title').textContent = text(s.title);
    $('tour-body').innerHTML = text(s.body);

    const nextBtn = $('tour-next');
    nextBtn.textContent = s.next || 'Next';
    $('tour-back').hidden = this.i === 0;
    $('tour-quit').hidden = this.i === this.steps.length - 1;

    const kids = $('tour-dots').children;
    for (let k = 0; k < kids.length; k++) {
      kids[k].classList.toggle('on', k === this.i);
      kids[k].classList.toggle('past', k < this.i);
    }

    this.root.dataset.dim = s.dim || 'mid';
    this.root.dataset.step = s.id;
    // The card animates in on every step; restarting the animation needs the
    // class off for one frame.
    const card = $('tour-card');
    card.classList.remove('in');
    requestAnimationFrame(() => card.classList.add('in'));
    nextBtn.focus({ preventScroll: true });
  }

  /* -------------------------------------------------------------- placement */

  /** Position spotlight and card for the current step.
   *  `force` re-lays out even if the target has not moved. */
  _place(force = false) {
    if (!this.active || !this.root) return;
    const s = this.steps[this.i];
    const spot = $('tour-spot');
    const card = $('tour-card');
    const box = s.spot === false ? null : this._box(s);

    const key = box ? `${box.left}|${box.top}|${box.width}|${box.height}` : 'none';
    if (!force && key === this._rect) return;
    this._rect = key;

    this.root.classList.toggle('nospot', !box);
    if (box) {
      spot.hidden = false;
      Object.assign(spot.style, {
        left: `${box.left}px`, top: `${box.top}px`,
        width: `${box.width}px`, height: `${box.height}px`,
      });
    } else {
      spot.hidden = true;
    }

    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const gap = 18, edge = 16;
    const arrow = $('tour-arrow');

    // Centred steps: no anchor, no arrow.
    if (!box || s.place === 'center') {
      card.style.left = `${Math.round((vw - cw) / 2)}px`;
      card.style.top = `${Math.round((vh - ch) / 2)}px`;
      arrow.hidden = true;
      return;
    }

    // Pick a side. An explicit `place` wins as long as the card fits there;
    // otherwise take whichever side has the most room, which is what keeps the
    // card off the panel it is describing on a narrow window.
    const room = {
      right: vw - (box.left + box.width) - gap - edge,
      left: box.left - gap - edge,
      bottom: vh - (box.top + box.height) - gap - edge,
      top: box.top - gap - edge,
    };
    const need = { right: cw, left: cw, bottom: ch, top: ch };
    let side = s.place && s.place !== 'auto' && room[s.place] >= need[s.place]
      ? s.place
      : Object.keys(room).sort((a, b) => (room[b] - need[b]) - (room[a] - need[a]))[0];

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let x, y;
    if (side === 'right' || side === 'left') {
      x = side === 'right' ? box.left + box.width + gap : box.left - gap - cw;
      y = clamp(box.top + box.height / 2 - ch / 2, edge, vh - ch - edge);
    } else {
      y = side === 'bottom' ? box.top + box.height + gap : box.top - gap - ch;
      x = clamp(box.left + box.width / 2 - cw / 2, edge, vw - cw - edge);
    }
    x = clamp(x, edge, Math.max(edge, vw - cw - edge));
    y = clamp(y, edge, Math.max(edge, vh - ch - edge));
    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;

    // Arrow: on the card edge facing the target, aligned with the target's
    // centre rather than the card's, so it points at the thing.
    arrow.hidden = false;
    arrow.dataset.side = side;
    if (side === 'right' || side === 'left') {
      arrow.style.top = `${Math.round(clamp(box.top + box.height / 2 - y, 16, ch - 16))}px`;
      arrow.style.left = side === 'right' ? '-5px' : `${cw - 5}px`;
    } else {
      arrow.style.left = `${Math.round(clamp(box.left + box.width / 2 - x, 16, cw - 16))}px`;
      arrow.style.top = side === 'bottom' ? '-5px' : `${ch - 5}px`;
    }
  }

  /** Track the target every frame. Panels animate, tab bodies scroll and the
   *  window resizes; a spotlight that lands once and then drifts off its
   *  control is worse than none. The comparison is a string of four numbers, so
   *  a frame where nothing moved costs a `getBoundingClientRect`. */
  _follow() {
    const step = () => {
      if (!this.active) return;
      this._place(false);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  /* ---------------------------------------------------------------- keyboard */

  _onKey(e) {
    if (!this.active) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    // Enter and Space are deliberately absent: the Next button holds focus on
    // every step, so the browser already activates it, and handling them here
    // as well advanced two steps for one press.
    switch (e.key) {
      case 'Escape': stop(); this.end('escaped'); break;
      case 'ArrowRight': case 'PageDown': stop(); this.next(); break;
      case 'ArrowLeft': case 'PageUp': stop(); this.back(); break;
      default: break;
    }
  }
}

/* --------------------------------------------------------------- entry point */

/** Wire the masthead Tour chip and, first time round, run the tour.
 *
 *  Called once the film has left the screen. The panels take about 1.4 s to
 *  come up behind it (see film.css), and a spotlight drawn on a control that is
 *  still sliding into place looks broken, so the first step waits for them.
 */
export function mountTour(ui, { auto = Tour.wanted(), delay = 1500 } = {}) {
  let live = null;
  const run = () => {
    if (live?.active) return live;
    live = new Tour(ui);
    live.start();
    return live;
  };

  const chip = $('tour-replay');
  if (chip) {
    chip.hidden = false;
    chip.onclick = () => run();
  }

  // No `Tour.seen()` on the way past: `?intro=0` is how the test suite and
  // anyone iterating on the app opt out of the opening, and it must not spend
  // the one automatic run this browser gets.
  if (auto) setTimeout(run, delay);

  return { run, current: () => live };
}

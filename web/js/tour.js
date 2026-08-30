/* The guided tour.
 *
 * The film explains why the city is hot. It says nothing about the instrument,
 * and someone who has just watched ninety seconds of cinema is looking at three
 * panels, twelve layers, two time scrubbers and two camera modes, with no idea
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

import { boxOf, targetsOf } from './spot.js';

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
      opens at the top of this panel — the ranking on the right stays put.
      <br /><br />
      Nothing here is decoration: wall colour is modelled surface temperature at
      the hour on the scrubber, and the ground wash is the measured air-temperature
      field.`,
  },
  {
    id: 'layers',
    target: ['#layers', '.lblock'],
    place: 'right',
    tab: 'view',
    enter: (ui) => ui.setLayer('surface'),
    title: 'What is drawn',
    body: `Twelve views of the same block, in two groups. The first six are one
      moment: how hot each wall is, which walls the sun is on, the seven-day wave,
      the air, and where to act during that wave.
      <br /><br />
      The six below the rule are the <b>whole year</b> — sunlit hours, accumulated
      dose, the swing between summer and winter, the month each wall peaks in.
      None of those depends on the clock, so the time controls grey out while one
      is showing.
      <br /><br />
      The colour scale is fixed across the entire year, so scrubbing from July to
      January reads as the city changing rather than the legend rescaling
      underneath it.`,
  },
  {
    id: 'year',
    target: '#time',
    place: 'top',
    title: 'A year, not a day',
    body: (d) => `The strip is the data it selects: one column per day, its height
      the day's temperature range, coloured by the maximum, with the overnight
      minimum as the base — so the ${d.year.annual.tropical_nights} nights the city
      never dropped below 26 °C stand out as thick warm bars rather than as a
      statistic. ${d.year.annual.days_above_35} days of
      ${d.days.length} passed 35 °C, and the pipeline found the heat-wave episodes
      by run length rather than being told where they were.
      <br /><br />
      <b>Drag</b> to scrub. The ticks underneath mark the thirteen days actually
      solved at full facade resolution — the green one is the FortyGuard-measured
      heat-wave day, the grey ones are the twelve monthly representative days. Any
      other date is reconstructed from its month, and the readout says so.
      <br /><br />
      <b>Day / Month / Season / Year</b> changes what is averaged. Press <b>▶</b> on
      the year row and watch the shadow line swing: December's noon sun is 26°
      lower than June's, so a canyon that is half lit in July has a floor in
      permanent shade in January.`,
  },
  {
    id: 'time',
    target: '#hours',
    place: 'top',
    title: 'And the hour within it',
    body: (d) => `${d.meta.hours.length} solved hours per day, ${hh(d.meta.hours[0].edt)}
      to ${hh(d.meta.hours[d.meta.hours.length - 1].edt)}.
      ${hh(d.meta.hours[d.meta.peak_index].edt)} is where you started.
      <br /><br />
      Two axes rather than one slider, because the question worth asking is the
      same hour in different months. The row of figures underneath is the weather
      that drove the hour, and the pill on its right says whether you are looking
      at a measured anchor, a solved day, or a reconstruction.`,
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
      <b>Two orderings, and they disagree.</b> <b>Heat wave</b> asks who is in
      trouble during an acute event; <b>the year</b> asks whose fabric is loaded all
      year. They share
      ${d.ranked.orderings?.agreement?.top50_overlap ?? '—'} of their top fifty.
      Where a building ranks far higher on the year, its problem is chronic and
      fabric measures matter; far higher on the wave, and its problem is acute and
      relief matters.
      <br /><br />
      Ranking is not a verdict. It is a queue, and the file behind each row shows
      its whole working.`,
  },
  {
    id: 'detail',
    target: '#selcard',
    place: 'right',
    // `reveal`, not `enter`: the card does not exist until something is picked,
    // and the step's target has to be measurable before the step is chosen.
    reveal: (ui) => ui.showDetail(0),
    title: 'One building',
    body: `The heat wave first: hours above 35 °C, the longest unbroken run, the
      hottest wall and the difference between its faces. Then <b>the year</b> —
      accumulated facade dose, sunlit hours, the summer-to-winter swing, and a bar
      per month showing when this particular wall actually peaks, which is not
      always July.
      <br /><br />
      Then temperature up the height of the building with its uncertainty band,
      the reasons it ranks where it does on both orderings, and what can be done
      about it.
      <br /><br />
      The file opens here rather than over the ranking, so working down a list of
      sixty addresses does not cost you the list sixty times. <b>Close</b>, or
      <kbd>Esc</kbd>, puts it away.`,
  },
  {
    id: 'diagnose',
    target: '#tab-diagnose',
    place: 'right',
    // Both this step and the next name a pane rather than a tab. There is no
    // Diagnose tab any more — the schedule and the what-if share one called
    // Decide — and `showTab` routes both old names to it, so the two steps still
    // spotlight the right half of one column.
    tab: 'diagnose',
    // No explicit guard needed, and adding one would have been dead code:
    // `targetsOf` already rejects a node that is `hidden` or inside something
    // hidden, and `#tab-diagnose` stays hidden until its module mounts. So on a
    // build without the decision layer this step drops itself, which is exactly
    // the behaviour the missing-target rule was written for.
    reveal: (ui) => ui.showDetail(0),
    title: 'Why, and what to do',
    body: `A temperature is a finding. This is the answer to the question everybody
      actually asks, which is <i>so what do I do</i>.
      <br /><br />
      Every floor of this building, with the load it drives and the
      <b>reason</b> it is hot: how much of its excess over the air came from the
      sun on it, and how much from longwave off the wall opposite. Four buildings
      can all peak at 53 °C for four different reasons, and those four reasons take
      four different measures — shading does nothing for a floor whose heat is
      arriving from the building across the street.
      <br /><br />
      Watch the bars swap as you go up. The lower floors are heated by the canyon;
      the upper floors are heated by the sun. That crossover is where the
      prescription changes, and it is why this is a schedule rather than a
      recommendation.`,
  },
  {
    id: 'whatif',
    target: '#tab-whatif',
    place: 'right',
    tab: 'whatif',
    title: 'What if',
    body: `Trees, a cool roof, lighter paving, an awning — each row re-solves that
      canyon and reports the change in °C on the road, on the wall, on the air, and
      on what a body standing there actually exchanges heat with.
      <br /><br />
      The second table is the one the year makes possible: the same measures at
      every month's peak, so the <b>cost</b> column is real. Facade shading that
      removes 4 K in July removes January's solar gain too, and a plan that reports
      only the July figure is not a plan.
      <br /><br />
      Which is also why trees do a great deal on a shallow street and almost
      nothing on a deep one already in shade. Same intervention, different street,
      different answer.`,
  },
  {
    id: 'ask',
    // The analyst opens over the map now rather than living in the left rail,
    // so the step spotlights the window itself; `tab: 'ask'` still reaches it,
    // because showTab routes that name to openAnalyst.
    target: '#analyst-win',
    place: 'right',
    tab: 'ask',
    title: 'The analyst',
    body: `Not a chat box. It is an agent with this model's physics engine, a shell,
      and twenty tools over the solved fields, and it does work rather than
      lookups: it re-solves an intervention anywhere in the city over any window,
      runs Moran's I and Getis-Ord hotspot statistics, writes its own scripts, and
      allocates a budget.
      <br /><br />
      Every tool call appears in the transcript with its arguments and what came
      back, because the claim is that every number came out of this model and a
      claim like that is worth what the evidence on screen is worth. It can read
      the open web, for context this model does not hold — a programme's funding
      rules, a standard's threshold — and everything it takes from there is
      labelled EXTERNAL. It may never source a <i>figure</i> from it that this
      model can produce itself.
      <br /><br />
      It also <b>drives this map</b>. Ask it where to act and it will set the layer,
      scrub the year to the date it is talking about, and light up the buildings it
      names.`,
  },
  {
    id: 'portfolio',
    target: () => document.getElementById('open-portfolio'),
    place: 'left',
    title: 'The whole programme',
    body: `Nobody spends money one building at a time. Every measure on every
      ranked building becomes a candidate, ordered by what it costs per
      person-hour of exposure it removes, with a budget line you can drag.
      Everything left of the line is the programme.
      <br /><br />
      Two objectives sit side by side and <b>they disagree</b>: efficiency buys the
      most avoided exposure per dollar, equity buys it for the people least able to
      cope, and they do not choose the same buildings. That disagreement is a
      political choice being made either way — the panel puts both columns on
      screen so it is made deliberately.
      <br /><br />
      Every dollar here is <b>assumed</b>, which is a softer tier than measured or
      modelled, and every one of them is shown as a range with the table it came
      through.`,
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
    body: `The chevrons fold this panel, the ranking and the clock away
      individually — or <kbd>[</kbd> <kbd>]</kbd> <kbd>\\</kbd> from the keyboard,
      and <kbd>H</kbd> for all three at once, which is the fastest route to just
      looking at the city.
      <br /><br />
      Each one leaves a labelled tab on the wall it slid off — <b>INSPECT</b>,
      <b>RANKING</b>, the hour — so you can always tell what is coming back.`,
  },
  {
    id: 'done',
    place: 'center',
    dim: 'full',
    title: 'That is the whole instrument',
    body: `Start anywhere. If you want one route: leave it on
      <b>Façade temperature</b>, press <b>▶</b> to run the afternoon, then take
      the top-ranked building and open its file.
      <br /><br />
      The <b>?</b> and <b>▶</b> buttons beside the panel title replay this tour
      and the opening film whenever you want them.`,
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
      //
      // `reveal` is the same idea for a target that does not merely live in a
      // hidden pane but does not exist yet at all: the card about one building's
      // file is about `#selcard`, which carries the `hidden` attribute until a
      // building is picked. Doing that in `enter` was too late — `_usable` had
      // already read the step as missing and skipped straight past it, which is
      // how three steps quietly vanished from a twelve-step tour while the dots
      // still promised twelve.
      if (c.tab) this.ui.showTab?.(c.tab);
      if (c.reveal) {
        try { c.reveal(this.ui); } catch (e) { console.warn(`tour step ${c.id} reveal:`, e); }
      }
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
   *  several (`['#layers', '.lblock']`) and get the union of their boxes. */
  _target(s) {
    const list = targetsOf(s.target);
    return list[0] || null;
  }

  /** The box to light for a step, or null if there is nothing on screen to
   *  light. Delegated to spot.js so the film's walkthrough highlights the same
   *  way, with the same clipping and the same refusal to dim the whole screen
   *  around a hole that is off it. */
  _box(s) {
    return boxOf(s.target);
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

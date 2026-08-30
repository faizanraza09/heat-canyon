/* The interface.
 *
 * Three regions and one rule about where things live.
 *
 * The left panel is the instrument: what is being measured, over what range,
 * from what camera. The right panel is the answer: every address ranked, always
 * on screen. The rail along the bottom is the clock.
 *
 * The rule is that clicking a building must not cost you the ranking. The
 * earlier version replaced the right panel with a dossier on the building you
 * had just clicked, which meant working down a list of sixty addresses involved
 * losing the list sixty times. The picked building now opens as a card at the
 * top of the left panel — beside the controls that change what is being measured
 * about it, which is where you want it — and the ranking on the right stays put
 * with the row highlighted.
 *
 * Everything numeric is monospace. Anything that is a name rather than a label
 * is serif. Labels are monospace, uppercase and letter-spaced. Prose is sans and
 * is allowed at most a sentence or two: the full provenance and the uncertainty
 * discussion live in docs/METHODOLOGY.md, where someone auditing the model will
 * actually read them. The one honesty note that survives in the panels is the
 * uncertainty band on the vertical profile chart, because there it is the point
 * being made rather than a disclaimer about it.
 */

import { RAMPS, css, gradient, norm, SUN_CSS } from './colors.js';
import { findApiKey, resolveApiKey, storeApiKey } from './photoreal.js';
import { YearStrip } from './year.js';
import { AgentConsole } from './agent.js';
import { makeContext } from './ctx.js';
import { mountDecisionSurfaces } from './decision.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const f1 = (v) => (isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v) => (isFinite(v) ? v.toFixed(2) : '—');
const f0 = (v) => (isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const HH = (h) => String(h).padStart(2, '0');

/* Two transports now — the day and the year — so the glyphs are named. */
const PLAY_SVG =
  '<svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">'
  + '<path d="M0 0 L9 5 L0 10 Z" fill="currentColor"></path></svg>';
const PAUSE_SVG =
  '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">'
  + '<rect x="0" y="0" width="2.6" height="10" fill="currentColor"></rect>'
  + '<rect x="5.4" y="0" width="2.6" height="10" fill="currentColor"></rect></svg>';
const cap = (v) => (v ? v[0].toUpperCase() + v.slice(1) : v);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/* ----------------------------------------------------------------- layers

   Names and captions are the design's, verbatim where a counterpart exists.
   Two layers here have no counterpart in it — sun and shade, and air
   temperature — because the prototype's model did not carry them; they are kept
   because this one does, and captioned in the same register.

   The captions are one sentence and they say what the number *means*, not how it
   was computed. "Hours above 35 °C" needs no explanation; "duration harms more
   than peak" is the reason to look at it.                                     */

export const LAYERS = [
  {
    key: 'surface', name: 'Façade temperature', unit: '°C', ramp: 'temperature',
    caption: 'How hot each wall actually gets. A sunlit face runs far hotter than the air standing beside it.',
  },
  {
    key: 'sun', name: 'Sun and shade', unit: '', ramp: 'temperature',
    caption: 'Which walls the sun reaches this hour. Watch the lit band climb as the afternoon goes on.',
  },
  {
    key: 'exceedance', name: 'Hours above 35 °C', unit: 'h', ramp: 'duration',
    caption: 'How long each address stays over the threshold across the heat wave. Duration harms more than peak.',
  },
  {
    key: 'persistence', name: 'Longest unbroken run', unit: 'h', ramp: 'duration',
    caption: 'The stretch with no relief at all. Recovery needs cool hours, not cool minutes.',
  },
  {
    key: 'air', name: 'Air temperature', unit: '°C', ramp: 'temperature',
    caption: 'Measured at 2 m and extended upward. It barely varies with height, which is the point.',
  },
  {
    key: 'priority', name: 'Where to act — heat wave', unit: 'score', ramp: 'priority',
    caption: 'Exposure weighted by how many people live behind each wall and how well they can cope.',
  },

  /* ---- the year. Everything below is a total or an extreme over 8,760 solved
     hours, so none of it depends on which day or hour is selected — the time
     controls go quiet while one of these is showing, which is honest rather than
     a bug. The two orderings deliberately disagree: see meta.year.ordering_agreement. */
  {
    key: 'annual_priority', name: 'Where to act — the year', unit: 'score', ramp: 'priority',
    annual: true, plane: null,
    caption: 'Chronic annual load instead of one heat wave. It ranks a different set of buildings, and the difference is the finding.',
  },
  {
    key: 'sun_hours', name: 'Sunlit hours a year', unit: 'h', ramp: 'duration',
    annual: true, plane: 'sun_hours',
    caption: 'Hours of direct beam on each facade band across the year. A south wall takes three times a north wall.',
  },
  {
    key: 'annual_kh35', name: 'Annual heat dose', unit: 'K·h', ramp: 'duration',
    annual: true, plane: 'degree_hours_35',
    caption: 'Degree-hours the facade spends above 35 °C over the year. Accumulated load, not a peak.',
  },
  {
    key: 'annual_dose', name: 'Annual solar dose', unit: 'kWh/m²', ramp: 'duration',
    annual: true, plane: 'dose_kwh',
    caption: 'Shortwave energy each facade band receives in a year. This is the quantity shading removes.',
  },
  {
    // Not the temperature swing. That turned out to be 25-30 K everywhere,
    // because it is set by the air temperature's own annual cycle and the whole
    // study area shares one of those — a real finding and a uniform map. This is
    // the quantity that varies with geometry, and it is the one a shading
    // decision turns on.
    key: 'winter_sun', name: 'Winter sun share', unit: '', ramp: 'diverging',
    annual: true, plane: 'winter_sun_share',
    caption: 'Winter sunlit hours as a fraction of summer. Near zero means shading in July costs nothing in January; high means it takes away the heating season\'s free gain.',
  },
  {
    key: 'month_of_peak', name: 'Month it peaks', unit: '', ramp: 'temperature',
    annual: true, plane: 'month_of_max',
    caption: 'The month each facade band reaches its annual maximum. Not every wall peaks in July.',
  },
];

/** Which layers are annual totals rather than an hour of a day. */
export const ANNUAL_LAYERS = new Set(
  LAYERS.filter((L) => L.annual).map((L) => L.key));

/* -------------------------------------------------------------------- boot */

export function boot(p, msg) {
  const bar = $('boot-bar');
  if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(3)})`;
  const m = $('boot-msg');
  if (m) m.textContent = (msg || '').toUpperCase();
}
export function bootDone() {
  $('boot')?.classList.add('done');
  setTimeout(() => $('boot')?.remove(), 700);
}

/* ---------------------------------------------------------------------- UI */

export class UI {
  constructor(data, scene) {
    this.d = data;
    this.scene = scene;
    this.layer = 'surface';
    this.hour = data.meta.peak_index;
    this.playing = false;
    this.scenarioSite = 0;
    this.scenarioPick = 'baseline';
    this.selected = null;
    this.showMore = false;
    // Which of the two rankings the right panel is showing. They disagree, and
    // that disagreement is the year's main finding rather than a defect.
    // Kept for the analyst's `map_control`, which can still ask for one
    // ordering by name; the panel itself no longer offers the choice.
    this.ordering = 'wave';

    this._folds();
    this._brand();
    this._tabs();
    this._layers();
    this._hours();
    this._cam();
    this._photoreal();
    this._whatif();
    this._ask();
    this.showList();
    this.setLayer('surface');
    this._keys();
    this._hoverLoop();

    /* The decision layer. Built last and mounted asynchronously, because every
       one of its surfaces is optional: a build without `floors.json` still has
       twelve layers, two time axes, a street camera and an analyst, and the
       atlas must come up at full speed whether or not the decision products
       exist. `mountDecisionSurfaces` resolves the modules dynamically and
       reports what it found, so a missing module degrades one pane rather than
       taking the interface down with a failed static import. */
    this.ctx = makeContext(this);
    mountDecisionSurfaces(this, this.ctx).then((mounted) => {
      this.surfaces = mounted;
      if (this.selected !== null) this._syncSurfaces();
    });
  }

  /** Tell every mounted decision surface the state moved under it.
   *
   *  Called from the four places state actually changes rather than from a
   *  polling loop: selection, hour, date and layer. A surface that is hidden
   *  still gets told — re-rendering an off-screen 40-row table is cheaper than
   *  the class of bug where a pane shows the previous building for one frame
   *  after being revealed. */
  _syncSurfaces(evt = 'select') {
    this.ctx?.emit(evt, this.ctx.state);
  }

  /* --------------------------------------------------------- fold panels

     All three regions fold, and the reopen handle is a labelled tab on the wall
     the panel slid off — INSPECT on the left, RANKING on the right, the current
     hour along the bottom. A named tab rather than a chevron because after a
     minute of looking at the city you have forgotten which side was which.

     The panel bodies keep their own inset; only the wrapper moves, so the
     reopen animation lands the panel exactly where it was.                    */

  _folds() {
    this.open = { left: true, right: true, bottom: true };

    const apply = () => {
      const o = this.open;
      $('left').classList.toggle('folded', !o.left);
      $('side').classList.toggle('folded', !o.right);
      $('time').classList.toggle('folded', !o.bottom);
      $('left').setAttribute('aria-hidden', String(!o.left));
      $('side').setAttribute('aria-hidden', String(!o.right));
      $('unfold-left').hidden = o.left;
      $('unfold-right').hidden = o.right;
      $('unfold-bottom-wrap').hidden = o.bottom;
      // With a side panel folded the rail reclaims the space it was leaving.
      $('time').classList.toggle('wide-left', !o.left);
      $('time').classList.toggle('wide-right', !o.right);
      // The navigation cluster hangs off the same edge as the rail's right
      // margin, so it has to follow the same rule or it ends up underneath a
      // folded panel's ghost.
      $('navpad').classList.toggle('wide-right', !o.right);
      this._bottomLabel();
    };
    this._applyFolds = apply;

    const toggle = (which) => { this.open[which] = !this.open[which]; apply(); };
    this.toggleFold = toggle;

    // Where the panel was before the pointer went down. See `_holdScroll`.
    const scroller = $('left-scroll');
    if (scroller) {
      scroller.addEventListener('pointerdown', () => { this._scrollAt = scroller.scrollTop; }, true);
      scroller.addEventListener('wheel', () => { this._scrollAt = null; }, { passive: true });
    }

    $('fold-left').onclick = () => toggle('left');
    $('fold-right').onclick = () => toggle('right');
    $('fold-bottom').onclick = () => toggle('bottom');
    $('unfold-left').onclick = () => toggle('left');
    $('unfold-right').onclick = () => toggle('right');
    $('unfold-bottom').onclick = () => toggle('bottom');
    apply();
  }

  /** Run something that changes the left panel, without letting the click that
   *  triggered it scroll the panel.
   *
   * Focusing a control makes the browser scroll it into view, and a control that
   * grows the pane as a side effect — a metric row changing the caption's
   * height, a panel revealing a control — is enough to move it. The result was
   * that clicking one jumped the panel and took the selected building's card
   * off the top of it. The focus scroll happens inside the click dispatch, so
   * restoring on the next task wins.
   */
  _holdScroll(fn) {
    const box = $('left-scroll');
    fn();
    if (!box) return;
    // `_scrollAt` is captured on pointerdown, not here: the focus scroll happens
    // between mousedown and click, so by the time a click handler runs the panel
    // has already moved and reading it now would just preserve the jump.
    const at = this._scrollAt ?? box.scrollTop;
    setTimeout(() => { box.scrollTop = at; }, 0);
  }

  /** The bottom reopen tab names the hour it will bring back, so folding the
   *  clock away does not also hide what time it is. */
  _bottomLabel() {
    const h = this.d.meta.hours[this.hour];
    const b = $('unfold-bottom');
    if (b && h) b.textContent = `${HH(h.edt)}:00  ·  HOURS`;
  }

  /** Show or hide everything at once, for looking at nothing but the city. */
  clearView() {
    const any = this.open.left || this.open.right || this.open.bottom;
    this.open = { left: !any, right: !any, bottom: !any };
    this._applyFolds();
  }

  /* ------------------------------------------------------------ keyboard

     The shortcuts are printed in the panel, under the camera controls, which is
     the only reason a keyboard interface in a 3D view is worth having: one that
     is not written down anywhere is one nobody uses.

     Three guards, and each of them is a bug that happened.

     Nothing fires while the caret is in a text field, or the analyst box eats
     its own keystrokes as commands.

     Nothing fires while the guided tour is up — the tour binds the same keys on
     the capture phase and stops them there, and this is the belt to those
     braces.

     And nothing fires while the film is running. The film binds Space and the
     arrows to its own transport, and it plays over a city whose panels are
     hidden rather than absent: pressing H under the closing caption folded all
     three of them, and the interface then assembled itself folded.            */

  _keys() {
    const typing = () => {
      const a = document.activeElement;
      if (!a) return false;
      return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable;
    };

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.analystOpen) {
        e.preventDefault();
        this.closeAnalyst();
        return;
      }
      if (typing()) return;
      const busy = document.body.classList;
      if (busy.contains('tour-running') || busy.contains('film-running')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = this.d.meta.hours.length;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (this.playing) this.stop(); else this.play();
          break;
        case 'Escape':
          if (this.selected !== null) this.clearSelection();
          break;
        case '[': this.toggleFold('left'); break;
        case ']': this.toggleFold('right'); break;
        case '\\': this.toggleFold('bottom'); break;
        case 'h': case 'H': this.clearView(); break;
        // North. The single most useful key in a 3D view of a city whose whole
        // vocabulary is which way a wall faces.
        case 'n': case 'N': this.scene.faceNorth(); break;
        case 'a': case 'A': this.toggleAnalyst(); break;
        case 'ArrowRight':
          // Left and right walk the day.
          e.preventDefault();
          this.stop();
          this.setHour((this.hour + 1) % n);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.stop();
          this.setHour((this.hour + n - 1) % n);
          break;
        default: break;
      }
    });
  }

  /* --------------------------------------------------------------- brand */

  _brand() {
    const m = this.d.meta;
    const y = m.year;
    $('brand-sub').innerHTML =
      `${m.aoi.label} · ${m.aoi.area_km2} km²<br>`
      + `${f0(m.counts.buildings_scored)} buildings · `
      + `${y.window[0].slice(0, 7)} to ${y.window[1].slice(0, 7)}<br>`
      + `<span class="dim">${f0(y.annual.days_above_35)} days over 35 °C · `
      + `${f0(y.annual.tropical_nights)} tropical nights</span>`;
  }

  /* ----------------------------------------------------------------- tabs */

  _tabs() {
    const btns = [...$('tabs').querySelectorAll('button[data-tab]')];

    /* One tab shows one pane, except Decide, which shows two.
     *
     * The floor schedule and the what-if pane are separate MODULES — each owns
     * its own host, its own stylesheet and its own failure — but they are not
     * separate ANSWERS. The schedule says why a building is hot floor by floor;
     * the what-if says what a measure does about it and what that costs. Reading
     * the second needs the first in view, so they stack in one scrolling column
     * in that order rather than sitting behind two tabs a reader has to alternate
     * between.
     *
     * Kept as a table rather than a name match so a build with only one of the
     * two modules mounted still shows the tab and whichever pane it has. */
    const PANES = { view: ['tab-view'], decide: ['tab-diagnose', 'tab-whatif'] };
    const ALL = Object.values(PANES).flat();

    const show = (name) => {
      // The tour and the analyst's map actions still name the old panes, and a
      // step that asked for a tab that no longer exists would silently show
      // nothing. Both route to the tab that now contains them.
      if (name === 'diagnose' || name === 'whatif') name = 'decide';
      if (!PANES[name]) name = 'view';
      for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
      const want = new Set(PANES[name]);
      for (const id of ALL) {
        const pane = $(id);
        if (pane) pane.hidden = !want.has(id);
      }
      // The Diagnose pane is a document about one building and carries its own
      // masthead — the address, the storey count, the assembly. The selection
      // card above it carries the same address, so on that tab the column
      // opened with the building's name printed twice, six pixels apart. The
      // card stays for Measure and What if, where the pane below it is about a
      // layer or a canyon rather than about the building.
      const card = $('selcard');
      if (card) {
        card.classList.toggle('under-doc', name === 'decide');
      }
      // A pane that was hidden while the state moved renders on the way in. The
      // surfaces are told about every change whether or not they are showing,
      // but a freshly mounted one may never have been told anything at all.
      if (name === 'decide') {
        this.surfaces?.diagnose?.update?.();
        this.surfaces?.whatif?.update?.();
      }
    };
    for (const b of btns) b.onclick = () => show(b.dataset.tab);
    this._showTab = show;
    show('view');

    // The analyst is not a pane. It opens over the map, so its entry in the tab
    // row is an action: it never latches, and the tab that was showing stays
    // showing underneath.
    $('analyst-open').onclick = () => this.openAnalyst();
    $('analyst-close').onclick = () => this.closeAnalyst();
    $('analyst-scrim').onclick = () => this.closeAnalyst();
  }

  /* ------------------------------------------------------------- analyst */

  openAnalyst() {
    const w = $('analyst');
    if (!w.hidden) return;
    w.hidden = false;
    // One frame later, so the entrance animation has a state to animate from.
    requestAnimationFrame(() => w.classList.add('on'));
    this.analystOpen = true;
    $('analyst-open').setAttribute('aria-expanded', 'true');
    setTimeout(() => this.agent?.focus(), 220);
  }

  closeAnalyst() {
    const w = $('analyst');
    if (w.hidden) return;
    w.classList.remove('on');
    this.analystOpen = false;
    $('analyst-open').setAttribute('aria-expanded', 'false');
    // Wait out the exit before taking it out of the layout, or it vanishes
    // rather than leaving.
    clearTimeout(this._analystHide);
    this._analystHide = setTimeout(() => { w.hidden = true; }, 260);
  }

  toggleAnalyst() { this.analystOpen ? this.closeAnalyst() : this.openAnalyst(); }

  /** Open the analyst and play a finished turn back into it.
   *
   * The walkthrough's last chapter uses this. Asking live on camera would mean
   * waiting minutes, spending money on every play, and showing whatever the
   * model happened to say that afternoon. The run it replays was genuinely made
   * — the server keeps every turn as JSONL and streams it back frame by frame —
   * so what appears is the real tool calls in the real order with the real
   * figures, just not for the first time.
   */
  replayAnalyst(runId, question) {
    this.openAnalyst();
    setTimeout(() => this.agent?.replay(runId, question), 260);
  }

  /** Switch tabs from outside the panel. The guided tour uses this to put the
   *  left rail on the tab whose card it is about to open. */
  showTab(name) {
    if (name === 'ask') { this.openAnalyst(); return; }
    this._showTab?.(name);
  }

  /* --------------------------------------------------------------- layers */

  _layers() {
    const box = $('layers');
    box.innerHTML = '';
    let ruled = false;
    for (const L of LAYERS) {
      // One rule between the layers that belong to a moment and the layers that
      // belong to the year. Without it the list reads as twelve equivalent
      // choices, and the two halves answer questions that are not comparable.
      if (L.annual && !ruled) {
        ruled = true;
        box.appendChild(el('div', 'layerrule', '<span>the whole year</span>'));
      }
      const b = el('button', null,
        `<span>${L.name}</span><span class="u">${L.unit}</span>`);
      b.setAttribute('aria-pressed', String(L.key === this.layer));
      b.onclick = () => this._holdScroll(() => this.setLayer(L.key));
      b.dataset.key = L.key;
      box.appendChild(b);
    }
  }

  setLayer(key) {
    this.layer = key;
    for (const b of $('layers').children) {
      b.setAttribute('aria-pressed', String(b.dataset.key === key));
    }
    this.scene.setLayer(key);
    this._legend();
    this._syncSurfaces('layer');
  }

  /* The caption sits *above* the ramp, not below it. Read top to bottom you get
     the question, then the scale that answers it, then the numbers on that
     scale — which is the order you need them in. Underneath the ramp the
     caption was an afterthought nobody reached. */
  _legend() {
    const L = LAYERS.find((x) => x.key === this.layer);
    const d = this.d;
    let lo, hi;
    if (L.key === 'exceedance') { const s = d.tiles.stats.exceedance; lo = s.min; hi = s.max; }
    else if (L.key === 'persistence') { const s = d.tiles.stats.persistence; lo = s.min; hi = s.max; }
    else if (L.key === 'priority' || L.key === 'annual_priority') { lo = 0; hi = 85; }
    else if (L.key === 'month_of_peak') { lo = 1; hi = 12; }
    else if (L.annual) { [lo, hi] = this.scene.annualDomain(L.plane); }
    else if (L.key === 'air') { [lo, hi] = this.scene.airDomain; }
    else { [lo, hi] = this.scene.surfaceDomain; }

    if (L.key === 'sun') {
      $('legend-ramp').style.background = SUN_CSS;
      $('legend-ticks').innerHTML = '<span>SHADED</span><span></span><span>DIRECT SUN</span>';
    } else {
      $('legend-ramp').style.background = gradient(L.ramp);
      const u = L.unit ? ` ${L.unit}` : '';
      $('legend-ticks').innerHTML =
        `<span>${f1(lo)}${u}</span><span>${f1((lo + hi) / 2)}${u}</span>`
        + `<span>${f1(hi)}${u}</span>`;
    }
    $('legend-cap').textContent = L.caption;

    // Where a layer is solved on a coarser grid than the thing it is painted
    // on, the panel says so under the scale. One shared ramp means a legend
    // reading "h" also applies to the walls, and the walls get that value by
    // sampling the tile at the address rather than by having one of their own —
    // which is honest, and worth one line of type.
    const note = $('legend-note');
    const ground = L.key === 'exceedance' || L.key === 'persistence';
    note.hidden = !ground;
    if (ground) note.textContent = 'SOLVED PER 60 M TILE · SAMPLED AT EACH ADDRESS';

    // An annual layer has no hour and no day. Saying so, and dimming the
    // controls it ignores, is the alternative to letting somebody scrub the year
    // while looking at a field that cannot change.
    const frozen = !!L.annual;
    $('time').classList.toggle('frozen', frozen);
    const badge = $('time-frozen');
    if (badge) {
      badge.hidden = !frozen;
      badge.textContent = frozen
        ? `${L.name.toUpperCase()} IS A TOTAL OVER ALL 8,760 SOLVED HOURS — `
          + 'THE DATE AND HOUR DO NOT CHANGE IT'
        : '';
    }
  }

  /* ---------------------------------------------------------------- hours */

  _hours() {
    // The year strip owns the date; the hour strip owns the time of day. Two
    // controls because they are two independent axes, and collapsing them into
    // one slider was tried and made the interesting question — the same hour in
    // different months — impossible to ask.
    this.year = new YearStrip($('year-host'), this.d, (date, aggregate) => {
      this.setDate(date, aggregate);
    });

    this._hourButtons();
    $('play').onclick = () => (this.playing ? this.stop() : this.play());
    $('play-year').onclick = () => (this.playingYear ? this.stopYear() : this.playYear());
    this._timeMeta();
  }

  /* Rebuilt whenever the date changes, because the hour labels belong to the
     period: the sun is 26 degrees lower at noon in December than in June, and
     the buttons carry that period's own solar geometry in their tooltips. */
  _hourButtons() {
    const box = $('hours');
    box.innerHTML = '';
    this.d.meta.hours.forEach((h, i) => {
      const b = el('button', null, HH(h.edt));
      b.title = `${HH(h.edt)}:00 EDT`;
      b.setAttribute('aria-pressed', String(i === this.hour));
      b.onclick = () => { this.stop(); this.setHour(i); };
      box.appendChild(b);
    });
  }

  /** Point the whole application at a date, a month, a season or the year.
   *
   * Asynchronous because it may have to fetch a month's binaries — 5 MB the
   * first time you scrub into October, nothing after that. The strip stays
   * responsive during the fetch and the scene repaints when it lands, which is
   * better than blocking the drag.
   */
  async setDate(date, aggregate) {
    const wantAir = this.layer === 'air';
    this.dateBusy = true;
    $('time').classList.add('loading');
    try {
      await this.d.setTime({ date, aggregate, withAir: wantAir });
    } catch (e) {
      console.warn('could not load that period', e);
      $('time').classList.remove('loading');
      this.dateBusy = false;
      return;
    }
    $('time').classList.remove('loading');
    this.dateBusy = false;
    this._hourButtons();
    this.scene.setPeriod();
    this._timeMeta();
    this._legend();
    this._bottomLabel();
    this.year?.draw();
    if (this.selected !== null) this.showDetail(this.selected, true);
    this._syncSurfaces('time');
  }

  setHour(i) {
    this.hour = i;
    const kids = $('hours').children;
    for (let k = 0; k < kids.length; k++) {
      kids[k].setAttribute('aria-pressed', String(k === i));
    }
    this.scene.setHour(i);
    this._timeMeta();
    this._legend();
    this._bottomLabel();
    if (this.selected !== null) this.showDetail(this.selected, true);
    this._syncSurfaces('time');
  }

  play() {
    this.playing = true;
    $('play').innerHTML = PAUSE_SVG;
    $('play').title = 'Pause';
    clearInterval(this._timer);
    this._timer = setInterval(
      () => this.setHour((this.hour + 1) % this.d.meta.hours.length), 1100);
  }
  stop() {
    this.playing = false;
    $('play').innerHTML = PLAY_SVG;
    $('play').title = 'Play the day';
    clearInterval(this._timer);
  }

  /** Play the year: one step every few days, at the selected hour.
   *
   * Six days a step rather than one. A day-by-day animation of 365 frames is
   * ninety seconds of watching almost nothing change, and the fetch of a new
   * month's binaries would stutter it twelve times. Six days crosses the year in
   * about a minute and makes the seasonal swing of the shadow line the thing you
   * actually see. */
  playYear() {
    this.playingYear = true;
    $('play-year').innerHTML = PAUSE_SVG;
    $('play-year').title = 'Pause';
    clearInterval(this._yearTimer);
    this._yearTimer = setInterval(() => {
      if (this.dateBusy) return;
      this.year.select((this.year.index + 6) % this.d.days.length);
    }, 260);
  }
  stopYear() {
    this.playingYear = false;
    $('play-year').innerHTML = PLAY_SVG;
    $('play-year').title = 'Play the year';
    clearInterval(this._yearTimer);
  }

  /* Monospace under the hour chips: the clock, the air temperature, and where
     the sun is — everything the colours on screen depend on, stated in the units
     it was measured in. With a year behind it the line also has to say WHICH day
     it is describing and how firmly that day is known, because the claims are
     not all of one kind: the event day rests on a measured FortyGuard field,
     every other date rests on reanalysis, and a reconstructed date rests on
     reanalysis plus a first-order correction. Three different claims, and the
     pill on the right makes them. */
  _timeMeta() {
    const h = this.d.meta.hours[this.hour];
    const t = this.d.time;
    const day = this.d.days[t.dayIndex];
    const sep = '&nbsp; · &nbsp;';
    const parts = [];

    if (t.aggregate === 'year' || t.aggregate === 'season') {
      parts.push(`${(t.aggregate === 'year' ? 'YEAR MEAN'
        : `${cap(t.aggregateName)} MEAN`).toUpperCase()}`);
      parts.push(`MEAN OF <b>${t.aggregate === 'year' ? 12 : 3}</b> SOLVED MONTHS `
        + `AT ${HH(h.edt)}:00`);
    } else {
      parts.push(`${day ? day.date : ''} ${HH(h.edt)}:00`);
      parts.push(`AIR <b>${f1(h.t_anchor_c)} °C</b>`);
    }
    parts.push(`SUN <b>${f1(h.sun_alt)}°</b>${sep}AZ <b>${f1(h.sun_az)}°</b>`);
    parts.push(`BEAM <b>${f0(h.dni)}</b> W/m²`);

    const second = [];
    if (day && t.aggregate === 'day') {
      second.push(`MAX <b>${f1(day.tmax)} °C</b>`);
      if (day.h35) second.push(`<b>${day.h35} H</b> >35 °C`);
      if (day.trop) second.push('<span class="tropmark">TROPICAL NIGHT</span>');
    }

    // A reconstruction carries its OWN measured error, from the pipeline's
    // 365-day audit against a full re-solve. Printing the day's figure rather
    // than a general caveat is the difference between a disclaimer and a number.
    let prov = (t.aggregate !== 'day') ? 'MONTHLY MEAN'
      : (t.date === this.d.eventDate ? 'MEASURED ANCHOR'
        : (t.reconstructed ? 'RECONSTRUCTED' : 'SOLVED DAY'));
    if (t.reconError && t.reconError.p95 != null) {
      prov += ` ±${f1(t.reconError.p95)} K`;
    }
    const title = t.reconError
      ? 'Measured 95th-percentile error of this day&apos;s reconstruction against '
        + 'a full re-solve. The residual is solar geometry, largest near an equinox.'
      : 'This day was solved at full facade resolution.';

    // Each item is atomic. Left to wrap freely the line broke inside a figure —
    // "BEAM" on one row and "743 W/m²" on the next — which reads as a rendering
    // fault rather than as a wrap.
    const atom = (a) => a.map((x) => `<span class="sp">${x}</span>`).join(sep);
    $('time-meta').innerHTML = atom(parts)
      + (second.length ? `<br>${atom(second)}` : '')
      + `<span class="prov" title="${title}">${prov}</span>`;
  }

  /* --------------------------------------------------------------- camera */

  _cam() {
    const hint = $('cam-hint');

    /* The key legend, written as printed keys rather than a sentence:
     * separated by middots, uppercase, one line per idea, so it can be scanned
     * rather than read. There is one camera now — the fly-over — so this is no
     * longer two texts swapped by mode. */
    hint.innerHTML = 'DRAG TO PAN&nbsp;&nbsp;·&nbsp;&nbsp;SCROLL TO ZOOM<br>'
      + 'RIGHT-DRAG TO TURN&nbsp;&nbsp;·&nbsp;&nbsp;N FACES NORTH<br>'
      + 'DOUBLE-CLICK TO CLOSE IN&nbsp;&nbsp;·&nbsp;&nbsp;CLICK TO INSPECT<br>'
      + 'SPACE PLAYS THE DAY&nbsp;&nbsp;·&nbsp;&nbsp;← → THE HOUR<br>'
      + '[ ] \\ THE PANELS&nbsp;&nbsp;·&nbsp;&nbsp;H CLEARS THE VIEW';

    $('cam-reset').onclick = () => this._holdScroll(() => this.scene.resetView());

    /* The navigation cluster on the canvas. The compass needle is redrawn from
     * the camera every frame rather than on an event, because there is no
     * event: the bearing changes throughout a drag, a flight and a double
     * click alike, and a needle that only updated when something told it to
     * would spend most of its time lying. It is one attribute write against a
     * value that rarely changes, and it is skipped when it has not. */
    const rose = $('nav-rose');
    let shown = null;
    const spin = () => {
      // The rose turns opposite to the camera, so north stays north.
      const b = Math.round(-this.scene.bearing);
      if (b !== shown) {
        shown = b;
        rose.setAttribute('transform', `rotate(${b} 22 22)`);
      }
      requestAnimationFrame(spin);
    };
    requestAnimationFrame(spin);

    $('nav-compass').onclick = () => this.scene.faceNorth();
    $('nav-in').onclick = () => this.scene.zoomBy(0.62);
    $('nav-out').onclick = () => this.scene.zoomBy(1 / 0.62);
  }

  /* ------------------------------------------------------------ photoreal

     The layer is gated on a key the user supplies, for two reasons that both
     point the same way: a key committed here would be a key strangers spend,
     and billing is per session, so the honest default is to issue no request at
     all until someone asks for one.                                          */

  _photoreal() {
    const toggle = $('pr-toggle');
    const keyBox = $('pr-key');
    const look = $('pr-look');
    const status = $('pr-status');
    const input = $('pr-key-input');
    const cpu = $('pr-cpu');
    if (!toggle) return;

    const say = (msg, cls) => {
      status.textContent = msg || '';
      status.className = `note${cls ? ` ${cls}` : ''}`;
    };

    this.scene.onPhotorealStatus = (state, detail) => {
      if (state === 'loading') say(detail || 'Streaming tiles…');
      else if (state === 'ready') say('');
      else if (state === 'error') say(detail || 'Failed', 'bad');
    };

    // Google requires the per-tile credits to be aggregated and shown, and the
    // viewer to be able to tell which part of the picture is theirs. The strip
    // labels both sides rather than running one undifferentiated line.
    this.scene.onAttribution = (list) => {
      const strip = $('credits');
      const g = $('credits-google');
      if (!strip || !g) return;
      if (!list || !list.length) {
        strip.hidden = true;
        g.textContent = '';
        document.body.classList.remove('has-credits');
        return;
      }
      g.textContent = list.join(' · ').toUpperCase();
      strip.hidden = false;
      // The rail sits at the bottom of the frame too; the class lifts it clear.
      document.body.classList.add('has-credits');
    };

    // A key from .env arrives asynchronously; until it does, treat the layer as
    // key-less. Nothing is requested either way, so there is no race to lose.
    let envKey = '';
    resolveApiKey().then((k) => {
      envKey = k || '';
      if (envKey) say('Key loaded from the server environment.');
    });
    const anyKey = () => findApiKey() || envKey;

    const setOn = async (on) => {
      const ok = await this.scene.setPhotoreal(on, anyKey());
      const live = on && ok;
      toggle.setAttribute('aria-pressed', String(live));
      look.hidden = !live;
      if (on && !ok) { keyBox.hidden = false; input?.focus(); }
      return live;
    };

    /* The tile profile, for a machine without a GPU.
     *
     * Google's tiles assume a hardware renderer. On a software one the browser
     * spends its frame budget on partial levels of detail, and a partial LOD is
     * the faceted shard that looks like broken geometry. The layer detects that
     * case itself; this is the manual override for the machines it cannot tell,
     * and it is remembered because a slow machine is slow on every visit.
     *
     * Changing it rebuilds the tileset: the queue depths and error targets are
     * read when the renderer is constructed and cannot be moved underneath one
     * that is already streaming. */
    if (cpu) {
      const saved = () => {
        try { return localStorage.getItem('heatcanyon.photoreal_cpu') === '1'; }
        catch (e) { return false; }
      };
      cpu.checked = saved();
      this.scene.setPhotorealCpuMode(cpu.checked);
      cpu.onchange = () => {
        try {
          localStorage.setItem('heatcanyon.photoreal_cpu', cpu.checked ? '1' : '0');
        } catch (e) { /* private browsing: it applies to this page and no further */ }
        const wasOn = toggle.getAttribute('aria-pressed') === 'true';
        this.scene.setPhotorealCpuMode(cpu.checked);
        if (wasOn) setOn(true);
      };
    }

    toggle.onclick = () => {
      const on = toggle.getAttribute('aria-pressed') !== 'true';
      if (on && !anyKey()) {
        keyBox.hidden = false;
        say('Paste a Google Maps API key to switch this on.');
        input?.focus();
        return;
      }
      setOn(on);
    };

    $('pr-key-save').onclick = () => {
      const v = (input.value || '').trim();
      if (!v) { say('That key looks empty.', 'bad'); return; }
      storeApiKey(v);
      input.value = '';
      keyBox.hidden = true;
      // A key change means a different session, so drop the old tileset first.
      this.scene.photoreal?.dispose();
      setOn(true);
    };
    $('pr-key-clear').onclick = () => {
      storeApiKey('');
      this.scene.photoreal?.dispose();
      setOn(false);
      keyBox.hidden = false;
      say('Key forgotten.');
    };

    const slider = (id, out, fmt, apply) => {
      const r = $(id), oo = $(out);
      const run = () => {
        const v = parseFloat(r.value);
        oo.textContent = fmt(v);
        apply(v);
      };
      r.oninput = run;
      run();
    };
    slider('pr-desat', 'pr-desat-out', (v) => `${Math.round(100 - v)}%`,
      (v) => this.scene.photoreal?.setLook({ desaturate: v / 100 }));
    // Read out as a position on the ramp rather than as a percentage of a
    // wash, because that is what it now is: everything above this point on the
    // legend glows, everything below it stays photograph.
    slider('pr-data', 'pr-data-out', (v) => `${Math.round(v)}% OF RANGE`,
      (v) => this.scene.photoreal?.setLook({ threshold: v / 100 }));
    slider('pr-wash', 'pr-wash-out', (v) => `${Math.round(v)}%`,
      (v) => this.scene.photoreal?.setLook({ fieldWash: v / 100 }));
    $('pr-solids').onchange = (e) => this.scene.setShowSolids(e.target.checked);
    slider('pr-nudge', 'pr-nudge-out', (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} m`,
      (v) => this.scene.photoreal?.setNudge(v));

    if (findApiKey()) say('Key found in this browser.');
  }

  /* ------------------------------------------------------------ what if

     Five interventions, re-solved against one real canyon cross-section rather
     than applied as a fixed figure — which is why trees do a great deal on a
     shallow street and almost nothing on a deep one already in shade, and why
     cool pavement makes the facing wall *hotter*.

     The block ends the way every answering block in this design ends: one large
     serif figure and the change against the baseline beside it.               */

  _whatif() {
    const S = this.d.scenarios;
    const box = $('tab-whatif');
    if (!S.sites?.length) {
      box.innerHTML = '<div class="wblock"><p class="wlede">No scenario sites in this run.</p></div>';
      return;
    }

    const render = () => {
      const site = S.sites[this.scenarioSite];
      const target = this.d.meta.hours[this.hour].edt;
      let row = site.hours[0];
      for (const r of site.hours) {
        if (Math.abs(r.hour_edt - target) < Math.abs(row.hour_edt - target)) row = r;
      }
      box.innerHTML = '';

      const lede = el('div', 'wblock');
      lede.appendChild(el('p', 'wlede',
        'Five interventions the city can actually fund, each re-solved for this '
        + 'canyon rather than applied as a fixed figure. Pick one to see what the '
        + 'wall does.'));
      box.appendChild(lede);

      // Site picker, in the same full-bleed row as the metric list, because it
      // is the same kind of choice: which thing am I looking at.
      const pick = el('div', 'metrics');
      S.sites.forEach((sx, i) => {
        const b = el('button', null,
          `<span>${sx.label}</span><span class="u">${sx.name.replace(/\s+/g, ' ')} · ${f1(sx.w)} M</span>`);
        b.setAttribute('aria-pressed', String(i === this.scenarioSite));
        b.onclick = () => { this.scenarioSite = i; this.scenarioPick = 'baseline'; render(); };
        pick.appendChild(b);
      });
      box.appendChild(pick);

      const body = el('div', 'wblock');

      // Short names for the rows. The pipeline's own titles carry the parameter
      // change — "Cool roofs (albedo 0.25 -> 0.70)" — which belongs in the
      // methodology, not in a 330px column: stripping the parenthetical left
      // "External facade shading on the sunlit face" wrapping to two lines, so
      // the panel names the intervention and the catalogue keeps the specifics.
      const SHORT = {
        cool_roof: 'Cool roofs',
        cool_pavement: 'Cool pavement',
        street_trees: 'Street trees',
        facade_shading: 'Façade shading',
        all_measures: 'Everything at once',
      };

      const t = el('table', 'sctab');
      t.innerHTML = `<thead><tr><th>Change</th><th>road</th><th>wall</th>
        <th>felt</th><th>air</th></tr></thead>`;
      const tb = el('tbody');
      const base = row.results.find((r) => r.key === 'baseline');
      for (const r of row.results) {
        if (r.key === 'baseline') continue;
        const cell = (v) => {
          const c = v < -0.05 ? 'neg' : v > 0.05 ? 'pos' : 'zero';
          return `<td class="${c}">${v > 0 ? '+' : ''}${f1(v)}</td>`;
        };
        const tr = el('tr', this.scenarioPick === r.key ? 'on' : null,
          `<td>${SHORT[r.key] || r.title.replace(/ \(.*/, '')}</td>`
          + cell(r.d_ground) + cell(r.d_facade) + cell(r.d_mrt_sun) + cell(r.d_air));
        tr.style.cursor = 'pointer';
        tr.onclick = () => {
          this.scenarioPick = this.scenarioPick === r.key ? 'baseline' : r.key;
          render();
        };
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      body.appendChild(t);

      body.appendChild(el('p', 'note',
        `CHANGE IN °C AT ${HH(row.hour_edt)}:00&nbsp; · &nbsp;`
        + '<span style="color:var(--good)">GREEN COOLS</span>, '
        + '<span style="color:var(--accent)">RED WARMS</span><br>'
        + '"FELT" IS WHAT A BODY ON THE PAVEMENT EXCHANGES HEAT WITH'));

      /* ---- THE SEASONAL TRADE-OFF, which is the single most useful thing the
         year adds here.

         Every one of these numbers is a full re-solve of this canyon at that
         month's own representative-day peak hour, with that month's real solar
         geometry. It is not the July answer scaled: the noon sun is 26 degrees
         lower in December than in June over Manhattan, so a canyon that is half
         sunlit in July has a floor in permanent shade in January, and the
         physics of every measure changes with it.

         The consequence is the column nobody puts in a brochure. Facade shading
         that removes 4 K of July surface temperature removes January's solar
         gain too, when the building wanted it. A positive winter number is the
         correct sign for a shading measure and it is the cost of the measure. */
      if (site.annual?.length) {
        const at = el('table', 'sctab');
        at.innerHTML = `<thead><tr><th>Across the year</th><th>summer</th>
          <th>winter</th><th>year</th><th>cost</th></tr></thead>`;
        const atb = el('tbody');
        for (const r of site.annual) {
          if (r.key === 'baseline') continue;
          const cell = (v) => {
            if (v === null || v === undefined) return '<td class="zero">—</td>';
            const c = v < -0.05 ? 'neg' : v > 0.05 ? 'pos' : 'zero';
            return `<td class="${c}">${v > 0 ? '+' : ''}${f1(v)}</td>`;
          };
          atb.appendChild(el('tr', null,
            `<td>${SHORT[r.key]
              || (S.catalogue.find((c) => c.key === r.key)?.title || r.key).replace(/ \(.*/, '')}</td>`
            + cell(r.d_mrt_summer) + cell(r.d_mrt_winter) + cell(r.d_mrt_year)
            + cell(r.seasonal_penalty)));
        }
        at.appendChild(atb);
        at.style.marginTop = '18px';
        body.appendChild(at);
        body.appendChild(el('p', 'note',
          'CHANGE IN WHAT A BODY FEELS, °C, AT EACH SEASON&apos;S PEAK HOUR, FROM '
          + 'TWELVE RE-SOLVED MONTHS<br>"COST" IS WINTER MINUS SUMMER: A POSITIVE '
          + 'NUMBER MEANS THE MEASURE DOES LESS GOOD IN WINTER, WHICH FOR SHADING '
          + 'AND CANOPY IS THE CORRECT SIGN AND IS THE PRICE OF IT'));
      }

      // The answering figure. Absolute wall temperature under the chosen
      // intervention, taken from the pipeline's own re-solve rather than
      // recomputed here, so the panel cannot disagree with the model.
      const chosen = row.results.find((r) => r.key === this.scenarioPick) || base;
      const delta = chosen.d_facade;
      const peak = el('div', 'peak');
      peak.innerHTML = `
        <div>
          <div class="klabel">PEAK WALL, ${HH(row.hour_edt)}:00</div>
          <div class="v">${f1(chosen.abs.facade)} °C</div>
        </div>
        <div class="rt">
          <div class="d" style="color:${delta < -0.05 ? 'var(--good)' : delta > 0.05 ? 'var(--accent)' : 'var(--t7)'}">${
            Math.abs(delta) < 0.05 ? 'baseline'
              : `${delta > 0 ? '+' : ''}${f1(delta)} K vs today`}</div>
        </div>`;
      const reset = el('button', 'link', 'RESET');
      reset.style.marginTop = '10px';
      reset.onclick = () => { this.scenarioPick = 'baseline'; render(); };
      peak.querySelector('.rt').appendChild(reset);
      body.appendChild(peak);

      body.appendChild(el('p', 'note',
        'EACH ROW RE-SOLVES THIS CANYON RATHER THAN APPLYING A FIXED FIGURE, '
        + 'WHICH IS WHY TREES DO A GREAT DEAL ON A SHALLOW STREET AND ALMOST '
        + 'NOTHING ON A DEEP ONE ALREADY IN SHADE<br>FOR A MEASURE AT A PLACE OR '
        + 'A SCALE THAT IS NOT IN THIS TABLE, ASK THE ANALYST'));

      box.appendChild(body);
    };
    this._renderScenarios = render;
    render();
  }

  /* ------------------------------------------------------------- analyst

     Claude Code as a library, not a chat box over a summary. The console owns
     the transcript and the streaming; twenty in-process MCP tools over the
     solved model do the work, and the tool calls stay visible so an answer can
     be checked rather than believed.

     The map actions it emits are applied here rather than inside the console,
     because this class is the thing that knows how to change the layer, move
     the year strip and open a building's dossier. The console's job is to
     render the transcript and hand the action over.                          */

  _ask() {
    this.agent = new AgentConsole($('analyst-body'), this.d, (a) => this.applyMapAction(a));
  }

  /** Apply one `map_control` action from the analyst. */
  async applyMapAction(a) {
    if (a.layer && LAYERS.some((L) => L.key === a.layer)) this.setLayer(a.layer);

    if (a.date || a.aggregate || a.period) {
      const aggregate = a.aggregate
        || (a.period && a.period !== 'event' && !a.date ? 'month' : undefined);
      // A period without a date means "that month": use the month's own
      // representative date so the strip lands where the field came from.
      let date = a.date;
      if (!date && a.period) {
        if (a.period === 'event') date = this.d.eventDate;
        else {
          const m = Number(String(a.period).slice(-2));
          date = (this.d.year.periods.months.find((x) => x.month === m) || {}).date;
        }
      }
      if (date) {
        this.year?.syncTo(date, aggregate || this.year.aggregate);
        await this.setDate(date, aggregate);
      } else if (aggregate) {
        this.year?.syncTo(this.d.time.date, aggregate);
        await this.setDate(this.d.time.date, aggregate);
      }
    }

    if (a.hour_slot !== undefined) { this.stop(); this.setHour(a.hour_slot); }
    if (a.camera) this._setCamera?.(a.camera);

    // ONE caption, composed. Setting it from `highlight` and then again from the
    // agent's own note meant the second overwrote the first, so an action that
    // both lit up fourteen buildings and explained why showed only the
    // explanation — and the count, which is the part that confirms the highlight
    // actually landed, disappeared.
    const said = [];
    if (a.highlight_bins?.length) said.push(this.highlight(a.highlight_bins));
    if (a.focus_bin) {
      const idx = this.d.ranked.items.findIndex(
        (it) => String(it.bin) === String(a.focus_bin));
      if (idx >= 0) this.showDetail(idx);
      else said.push(this.highlight([a.focus_bin]));
    }
    if (a.note) said.push(a.note);
    if (said.length) this._agentNote(said.join(' · '));
  }

  /** Light up a set of buildings by BIN. Returns what to say about it.
   *
   *  Distinct from selecting one building, which opens a dossier: "these
   *  fourteen" is the answer to a different kind of question. */
  highlight(bins) {
    const idx = bins
      .map((b) => this.d.binToIndex.get(String(b)))
      .filter((i) => i !== undefined);
    this.scene.setHighlight(idx);
    return `${idx.length} building${idx.length === 1 ? '' : 's'} highlighted`
      + (idx.length < bins.length
        ? ` (${bins.length - idx.length} not in this study area)` : '');
  }

  _agentNote(text) {
    let n = $('agent-note');
    if (!n) {
      n = el('div', null, '');
      n.id = 'agent-note';
      document.getElementById('app').appendChild(n);
    }
    n.textContent = text;
    n.classList.add('show');
    clearTimeout(this._noteTimer);
    this._noteTimer = setTimeout(() => n.classList.remove('show'), 6000);
  }

  /* -------------------------------------------------------- right panel

     The ranking, and it stays. Score colour comes from the same heat ramp the
     city is painted with, so a row's number and the building it names are the
     same colour — which is how you find it in the model.                     */

  showList() {
    $('side-title').textContent = 'WHERE TO ACT FIRST';
    // The design's copy, verbatim. The "click one" instruction it does not carry
    // is not missing: the key legend under the camera controls says CLICK TO
    // INSPECT, which is where someone looking for an affordance will find it,
    // and repeating it here cost the lede a third line.
    $('side-sub').textContent =
      'Heat exposure weighted against how many people live there and how well '
      + 'they can cope, averaged over the heat wave and the year.';
    const body = $('side-body');
    body.innerHTML = '';

    /* ONE LIST, NOT TWO, AND THE DISAGREEMENT MOVED ONTO THE ROW.
     *
     * There used to be a Heat wave / The year switch here, because the two
     * orderings genuinely disagree — they share twelve of their top fifty — and
     * that disagreement is the year's main finding. Putting it at the top of the
     * list was the wrong way to say so. "Where to act first" is a question with
     * one answer, and a panel that opens by asking which of two answers you want
     * has handed the reader a modelling decision they came here to be spared.
     *
     * So the list is ordered by the MEAN of the two priority scores, and the
     * finding survives where it is actually useful: every row carries its rank
     * under both, so a building that sits 1st on the wave and 54th on the year
     * says so on its own line. The agreement figure stays underneath, now as a
     * statement about the ranking rather than as a caption on a control.
     *
     * The two scores are on the same 0-100 scale by construction — both are a
     * geometric mean of an exposure index against the same vulnerability score —
     * so averaging them is defensible rather than convenient. It weights an
     * acute event and a chronic year equally, which is a choice, and it is
     * stated here and in the panel's own subtitle rather than buried. Anyone who
     * wants one ordering alone still has both scores on every row and both
     * orderings in `ranked.json`.
     */
    const agree = this.d.ranked.orderings?.agreement;
    if (agree) {
      const note = el('p', 'note',
        'RANKED BY THE MEAN OF THE EVENT-DAY AND ANNUAL PRIORITY SCORES'
        + `<br>THE TWO DISAGREE — THEY SHARE <b>${agree.top50_overlap}</b> OF THEIR `
        + `TOP FIFTY, SPEARMAN <b>${f2(agree.spearman)}</b> — SO EVERY ROW CARRIES `
        + 'BOTH RANKS. THE YEAR FINDS CHRONIC LOAD; THE WAVE FINDS TRAPPED AIR');
      note.style.margin = '0 22px 14px';
      body.appendChild(note);
    }

    this._rows = [];
    this._rowIndex = [];
    // Sorted on the mean of the two scores. `bin` breaks ties so the list is
    // stable across reloads rather than depending on sort implementation.
    const annualRank = new Map(this.d.annualOrder.map((idx, r) => [idx, r + 1]));
    const combined = (i) => {
      const it = this.d.ranked.items[i];
      return ((it?.priority || 0) + (it?.annual?.priority || 0)) / 2;
    };
    const order = this.d.ranked.items
      .map((_, i) => i)
      .sort((x, y) => (combined(y) - combined(x))
        || String(this.d.ranked.items[x].bin).localeCompare(String(this.d.ranked.items[y].bin)));
    order.slice(0, 60).forEach((idx, place) => {
      const b = this.d.ranked.items[idx];
      if (!b) return;
      const a = b.annual || {};
      const bits = [`${b.floors} floors`, `${f0(b.h)} m`, b.year || null,
                    b.units ? `${f0(b.units)} homes` : null].filter(Boolean);
      // BOTH ranks on every row. This is where the disagreement lives now that
      // the switch is gone, and it is more useful here than it ever was as a
      // control: a building that is 1st on the wave and 54th on the year is
      // saying something specific about itself, and the reader sees it without
      // having to hold two lists in their head.
      const other = `WAVE #${idx + 1} · YEAR #${annualRank.get(idx) ?? '—'}`;
      const sc = Math.round(combined(idx));
      const col = css(RAMPS.priority(norm(sc, 0, 85)));
      const row = el('button', 'rank', `
        <div class="r1">
          <span class="n">${place + 1}</span>
          <span class="a">${b.addr || `BIN ${b.bin}`}</span>
          <span class="sc" style="color:${col}">${sc}</span>
        </div>
        <div class="r2">
          <span class="m">${bits.join(' · ')}</span>
          <span class="bar"><i style="width:${Math.min(100, (sc / 85) * 100).toFixed(0)}%;background:${col}"></i></span>
        </div>
        <div class="r2"><span class="other">${other}</span></div>`);
      row.onclick = () => this.showDetail(idx);
      body.appendChild(row);
      this._rows.push(row);
      this._rowIndex.push(idx);
    });
    this._markRow();
  }

  /** Select any building on screen, whether or not it made the ranked list.
   *
   * `ranked.items` is the top 150. Keying selection on membership meant a click
   * on any of the other 5,179 footprints did nothing at all — not even clear the
   * card already open, so the previous building stayed up and the click read as
   * having selected the wrong one.
   */
  showBuilding(bi) {
    const a = this.d.buildings.attrs[bi];
    if (!a) { this.clearSelection(); return; }
    const idx = this.d.ranked.items.findIndex(
      (it) => String(it.bin) === String(a.bin));
    if (idx >= 0) { this.showDetail(idx); return; }
    /* The measured/modelled pair is present only once the pipeline has been
     * re-run with the nine card figures written onto the footprint record (see
     * pipeline.py, "The nine figures the building card needs"). Until then this
     * degrades to the short card; afterwards the same click gets the full
     * grids, with no further change here. */
    const hasFigures = a.fac_c !== undefined;
    this.showDetail({
      bin: a.bin, addr: a.addr, floors: a.floors, h: a.h, year: a.year,
      units: a.units, priority: a.pr,
      measured: hasFigures ? {
        exceedance_h: a.exc_h, persistence_h: a.per_h,
        peak_air_c: a.air_c, svf: a.svf,
      } : null,
      modelled: hasFigures ? {
        facade_peak_c: a.fac_c, facade_spread_k: a.fac_k,
        mrt_peak_c: a.mrt_c, wbgt_peak_c: a.wbgt_c,
        facade_solar_kwh: a.fac_kwh,
      } : null,
      annual: null, reasons: null, actions: null,
    });
  }

  /* The row marked is the one naming the selected building, which is not the
     row at that position once the list is ordered by the year. */
  _markRow() {
    if (!this._rows) return;
    this._rows.forEach((r, i) =>
      r.classList.toggle('on', this._rowIndex[i] === this.selected));
  }

  clearSelection() {
    this.selected = null;
    this.scene.select(null);
    $('selcard').hidden = true;
    $('selcard').innerHTML = '';
    this._markRow();
    this._syncSurfaces('select');
  }

  /* --------------------------------------------------------- left panel:
                                                      the picked building */

  /** Show a building's card.
   *
   * `i` is a ranked index, or a record shaped like one. The second form exists
   * because `ranked.items` is the top 150, not the scored population: 5,179 of
   * the 5,329 footprints on screen have no entry in it, so keying selection on
   * membership left 97% of the city inert to a click while still answering a
   * hover. `showBuilding` builds the stand-in; everything below renders either.
   */
  showDetail(i, keepScroll = false) {
    const b = typeof i === 'number' ? this.d.ranked.items[i] : i;
    if (!b) return;
    const changed = this.selected !== i;
    this.selected = i;
    this._markRow();

    const bi = this.d.binToIndex.get(String(b.bin));
    if (bi !== undefined) {
      this.scene.select(bi);
      if (!keepScroll && changed) this.scene.focus(bi);
    }

    const card = $('selcard');
    const scroll = keepScroll ? $('left-scroll').scrollTop : 0;
    card.hidden = false;
    card.innerHTML = '';
    // Re-run the entrance only when the building actually changed. Rewriting the
    // contents does not restart a CSS animation on its own, so it is cleared and
    // reflowed first; without the second half of that, re-rendering on every
    // hour tick made the card flicker its way through a played day.
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = changed ? '' : 'none';

    const m = b.measured || {}, md = b.modelled || {};
    const full = !!(b.measured && b.modelled);

    const head = el('div', 'shead');
    const bAttr = bi !== undefined ? this.d.buildings.attrs[bi] : {};
    const addr = el('div', 'addr', b.addr || `BIN ${b.bin}`);
    // ONE pair of ranks, over the whole scored population rather than over the
    // sixty in the list — those read as if they were out of 4,044 and are not.
    if (bAttr?.pr_rank) {
      addr.appendChild(el('div', 'ranks',
        `<span title="Event-day priority across every scored building">WAVE `
        + `#${f0(bAttr.pr_rank)}</span> · `
        + `<span title="Annual priority across every scored building">YEAR `
        + `#${f0(bAttr.apr_rank)}</span> OF ${f0(this.d.ranked.n_scored)}`));
    }
    head.appendChild(addr);
    const close = el('button', 'close', 'CLOSE');
    close.onclick = () => this.clearSelection();
    head.appendChild(close);
    card.appendChild(head);

    // The six figures the design puts in a 2×3 grid: what the building is, and
    // the two numbers that put it on this list.
    const stats = [
      ['FLOORS', `${b.floors}`],
      ['HEIGHT', `${f0(b.h)} m`],
      ['BUILT', b.year ? `${b.year}` : '—'],
      ['HOMES', b.units ? f0(b.units) : 'none'],
    ];
    // The two figures that put a building on the ranked list are the two the
    // stand-in record does not carry. Better a four-cell grid than two cells
    // reading "NaN °C".
    if (full) {
      stats.push(['PEAK FAÇADE', `${f1(md.facade_peak_c)} °C`],
                 ['HOURS ABOVE 35', `${f1(m.exceedance_h)} h`]);
    } else if (b.priority != null) {
      stats.push(['PRIORITY', `${f1(b.priority)}`]);
    }
    const grid = el('div', 'sgrid');
    for (const [k, v] of stats) {
      grid.appendChild(el('div', null, `<div class="k">${k}</div><div class="v">${v}</div>`));
    }
    card.appendChild(grid);

    /* Everything below here is this model's own and has no counterpart in the
       prototype: the vertical profile, the score breakdown, the reasons, the
       actions. It is the reason the ranking can be argued with, and it is worth
       keeping — but it is four hundred pixels of it, and left expanded it pushed
       the metric list, the What-if tab and the analyst box below the fold the
       moment anything was selected. So the card is the design's six figures by
       default and the rest is one disclosure away. The open/closed state is
       remembered, because someone reading dossiers wants them all open. */
    const more = el('button', 'link more');
    card.appendChild(more);
    const box = el('div', 'selmore');
    card.appendChild(box);

    const sec = (label) => {
      const s = el('div', 'sec');
      s.appendChild(el('span', 'klabel', label));
      box.appendChild(s);
      return s;
    };

    const paint = () => {
      box.hidden = !this.showMore;
      more.textContent = this.showMore ? 'LESS' : 'MORE ON THIS BUILDING';
    };
    more.onclick = () => { this.showMore = !this.showMore; paint(); };

    if (full) {
      const heat = sec('THE REST OF THE HEAT');
      const dl = el('div', 'sgrid');
      for (const [k, v] of [
        ['LONGEST RUN', `${f2(m.persistence_h)} h`],
        ['PEAK AIR', `${f1(m.peak_air_c)} °C`],
        ['FACE SPREAD', `${f1(md.facade_spread_k)} K`],
        ['FELT, PAVEMENT', `${f1(md.mrt_peak_c)} °C`],
        ['SKY FROM STREET', `${Math.round(m.svf * 100)}%`],
        ['SCORE', `${f1(b.priority)}`],
      ]) {
        dl.appendChild(el('div', null, `<div class="k">${k}</div><div class="v">${v}</div>`));
      }
      dl.style.marginTop = '0';
      heat.appendChild(dl);
    }

    /* ---- the year, which is a different claim from the heat wave and is
       labelled as one: the wave figures above rest on a measured FortyGuard
       field, these rest on bias-corrected reanalysis and this project's own
       physics. */
    const a = b.annual || {};
    if (a.facade_kh35 !== undefined) {
      const yr = sec('THE YEAR');
      const yl = el('div', 'sgrid');
      for (const [k, v] of [
        ['FAÇADE DOSE >35', `${f0(a.facade_kh35)} K·h`],
        ['SUNLIT HOURS', `${f0(a.sun_hours)} h`],
        ['SOLAR DOSE', `${f0(a.dose_kwh)} kWh/m²`],
        ['HOTTEST WALL', `${f1(a.facade_max_c)} °C`],
        ['SUMMER MEAN', `${f1(a.summer_mean_c)} °C`],
        ['WINTER MEAN', `${f1(a.winter_mean_c)} °C`],
      ]) {
        yl.appendChild(el('div', null, `<div class="k">${k}</div><div class="v">${v}</div>`));
      }
      yl.style.marginTop = '0';
      yr.appendChild(yl);
      yr.appendChild(this._monthlyChart(b, a));
      if (a.reasons?.length) {
        const why = el('ul', 'why');
        for (const r of a.reasons.slice(0, 4)) why.appendChild(el('li', null, r));
        yr.appendChild(why);
      }
    }

    if (full) sec('UP THE BUILDING').appendChild(this._profileChart(b));

    if (b.reasons?.length) {
      const why = sec('WHY IT RANKS HERE');
      why.appendChild(this._bars(b));
      const list = el('ul', 'why');
      for (const r of b.reasons.slice(0, 5)) {
        list.appendChild(el('li', null,
          r.replace(/^(Measured|Modelled|People|Measured geometry):\s*/, '')));
      }
      why.appendChild(list);
    } else {
      /* Say why the card is short, rather than letting it look truncated.
       *
       * The written reasoning, the per-band profile and the component bars are
       * all produced for the ranked fifty; a building outside it has real
       * geometry and a real score and nothing written about it. Silence there
       * reads as a half-loaded card. */
      const note = sec('OUTSIDE THE RANKED LIST');
      note.appendChild(el('p', 'note',
        'This building is scored but does not appear in the ranked list, so the '
        + 'written reasoning and the per-floor profile are not built for it. Its '
        + 'geometry, priority and rank are measured the same way.'));
    }

    if (b.actions?.length) {
      const act = sec(`WHAT TO DO (${b.actions.length})`);
      for (const a of b.actions) {
        act.appendChild(el('div', 'act', `
          <div class="t">${a.title}</div>
          <div class="r">${a.rationale}</div>
          <div class="p">${a.programme.toUpperCase()}</div>`));
      }
    }

    paint();
    $('left-scroll').scrollTop = scroll;
    this._syncSurfaces('select');
  }

  /* ------------------------------------------------- the full-screen views

     The brief and the portfolio are siblings of the analyst window, not tabs:
     each is a document rather than a control, neither fits in a 340px column,
     and both are dismissed the same way the analyst is. `ui.js` owns opening
     them so that the tour, the analyst's map actions and the panes can all ask
     for one without knowing how it is mounted. */

  openBrief(bin) {
    const b = bin || (this.selected !== null
      ? String(this.d.ranked.items[this.selected]?.bin) : null);
    if (!b) return;
    this.surfaces?.brief?.open(b);
  }

  closeBrief() { this.surfaces?.brief?.close(); }

  /* Move a long surface to the part of itself that is being talked about.
   *
   * The brief is five numbered sections and the portfolio is a curve over a
   * ledger; both are documents that open at their masthead and stay there.
   * That is right for a reader, who scrolls, and wrong for the walkthrough,
   * which spends five beats on the floor schedule and the prescription without
   * ever touching a wheel. Left alone the film narrates page four over a
   * picture of page one.
   *
   * Smooth rather than instant, because the movement is the point: seeing the
   * document travel is what tells a viewer these are parts of one thing rather
   * than five panels that happen to look alike. `scrollIntoView` on the child
   * would scroll the page as well as the pane on some engines, so the offset is
   * computed against the scroller and applied to it directly.
   */
  scrollSurface(scrollerId, target, tries = 3) {
    const box = $(scrollerId);
    if (!box) return;
    const node = typeof target === 'string' ? box.querySelector(target) : target;
    // A surface asked to scroll on the same tick it was opened may not have
    // rendered its body yet. Retrying on the next frame costs nothing and is
    // the alternative to a timer, which cannot be used here: a seek replays
    // every act up to where it landed, and a deferred scroll would arrive after
    // the target beat's own and undo it.
    if (!node) {
      if (tries > 0) {
        requestAnimationFrame(() => this.scrollSurface(scrollerId, target, tries - 1));
      }
      return;
    }
    const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTo({ top: Math.max(0, box.scrollTop + top - 28), behavior: 'smooth' });
  }

  /** The nth numbered section of the building brief, 1-based. */
  briefSection(n) {
    this.scrollSurface('brief-doc', `.brf-sec:nth-of-type(${n})`);
  }
  openPortfolio() { this.surfaces?.portfolio?.open(); }
  closePortfolio() { this.surfaces?.portfolio?.close(); }

  /** This building's own facade temperature through the year, month by month.
   *
   * Twelve solved months, so the shape is real rather than interpolated. The bar
   * is the monthly mean over every panel and band the building has; the marker
   * is the month its annual maximum fell in, which is not always July — a wall
   * in a deep north-south canyon can peak in May or October, when the sun is low
   * enough to reach down it and the air is still warm.
   */
  _monthlyChart(b, a) {
    const wrap = el('div');
    const vals = a.monthly_mean_c;
    if (!vals?.length) return wrap;
    const W = 300, H = 96, ml = 26, mr = 6, mt = 8, mb = 16;
    const lo = Math.min(...vals) - 1;
    const hi = Math.max(...vals) + 1;
    const bw = (W - ml - mr) / 12;
    const Y = (v) => H - mb - ((v - lo) / (hi - lo)) * (H - mt - mb);
    const bars = vals.map((v, i) => {
      const c = css(RAMPS.temperature(norm(v, lo, hi)));
      const y = Y(v);
      return `<rect x="${(ml + i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}"
        width="${(bw - 2).toFixed(1)}" height="${(H - mb - y).toFixed(1)}"
        fill="${c}" opacity="${a.month_of_peak === i + 1 ? 1 : 0.82}"/>`;
    }).join('');
    const peak = a.month_of_peak
      ? `<circle cx="${(ml + (a.month_of_peak - 0.5) * bw).toFixed(1)}"
           cy="${(mt - 1).toFixed(1)}" r="2.4" fill="var(--accent)"/>` : '';
    wrap.innerHTML = `
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Monthly mean facade temperature through the year">
        <line x1="${ml}" y1="${H - mb}" x2="${W - mr}" y2="${H - mb}"
              stroke="rgba(237,231,220,.14)"/>
        ${bars}${peak}
        <text x="${ml - 4}" y="${Y(hi - 1).toFixed(1)}" text-anchor="end">${f0(hi - 1)}°</text>
        <text x="${ml - 4}" y="${(H - mb).toFixed(1)}" text-anchor="end">${f0(lo + 1)}°</text>
        ${['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].map((mn, i) =>
          `<text x="${(ml + (i + 0.5) * bw).toFixed(1)}" y="${H - 4}"
             text-anchor="middle">${mn}</text>`).join('')}
      </svg>`;
    wrap.appendChild(el('p', 'note',
      `MONTHLY MEAN FAÇADE SURFACE TEMPERATURE, TWELVE SOLVED MONTHS${
        a.month_of_peak ? ` · PEAKS IN ${MONTHS[a.month_of_peak - 1].toUpperCase()}` : ''}`));
    return wrap;
  }

  /* Temperature against height: the one place a caveat earns its space, because
     the uncertainty band *is* the finding — the air hardly changes up a
     building and the walls change enormously. */
  _profileChart(b) {
    const d = this.d;
    const bi = d.binToIndex.get(String(b.bin));
    const ps = bi !== undefined ? d.panelsOfBuilding.get(bi) : null;
    const wrap = el('div');
    if (!ps?.length) { wrap.innerHTML = '<p class="note">No facade data.</p>'; return wrap; }

    const nb = d.facades.bands;
    const h = b.h;
    const rows = [];
    for (let band = 0; band < nb; band++) {
      let hot = -1e9, cold = 1e9, air = 0, sig = 0;
      for (const p of ps) {
        const t = d.surfaceAt(this.hour, p, band);
        if (t > hot) hot = t;
        if (t < cold) cold = t;
        air += d.airAt(this.hour, p, band);
        sig += d.sigmaAt(this.hour, p, band);
      }
      rows.push({ z: (h * (band + 0.5)) / nb, hot, cold,
                  air: air / ps.length, sig: sig / ps.length });
    }

    const hasAir = rows.every((r) => isFinite(r.air) && isFinite(r.sig));
    const W = 300, H = 160, ml = 32, mr = 8, mt = 6, mb = 20;
    const lo = Math.min(...rows.map((r) => Math.min(
      r.cold, hasAir ? r.air - r.sig : r.cold))) - 1;
    const hi = Math.max(...rows.map((r) => Math.max(
      r.hot, hasAir ? r.air + r.sig : r.hot))) + 1;
    const X = (t) => ml + ((t - lo) / (hi - lo)) * (W - ml - mr);
    const Y = (z) => H - mb - (z / h) * (H - mt - mb);
    const path = (k) => rows.map((r, i) => `${i ? 'L' : 'M'}${X(r[k]).toFixed(1)},${Y(r.z).toFixed(1)}`).join('');
    const bandPath =
      rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.air - r.sig).toFixed(1)},${Y(r.z).toFixed(1)}`).join('')
      + rows.slice().reverse().map((r) => `L${X(r.air + r.sig).toFixed(1)},${Y(r.z).toFixed(1)}`).join('') + 'Z';

    // Both curves come out of the same ramp the city is painted with, so the
    // chart is legible as the same measurement rather than a second scheme.
    // Far enough apart on the ramp to be told apart, and both far enough from
    // the panel's own background to be seen at all: ramp(0.34) put the coolest
    // wall at a near-black plum that simply vanished against #131110.
    const hotC = css(RAMPS.temperature(0.88));
    const coldC = css(RAMPS.temperature(0.52));
    const airC = '#C9C0B4';

    wrap.innerHTML = `
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Temperature against height up the building">
        <line x1="${ml}" y1="${H - mb}" x2="${W - mr}" y2="${H - mb}" stroke="rgba(237,231,220,.14)"/>
        <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${H - mb}" stroke="rgba(237,231,220,.14)"/>
        ${hasAir ? `<path d="${bandPath}" fill="rgba(201,192,180,.10)"/>` : ''}
        ${hasAir ? `<path d="${path('air')}" fill="none" stroke="${airC}"
              stroke-width="1.2" stroke-dasharray="4 3"/>` : ''}
        <path d="${path('hot')}" fill="none" stroke="${hotC}" stroke-width="2"/>
        <path d="${path('cold')}" fill="none" stroke="${coldC}" stroke-width="1.5"/>
        <text x="${ml}" y="${H - 6}" text-anchor="start">${f1(lo)}°</text>
        <text x="${W - mr}" y="${H - 6}" text-anchor="end">${f1(hi)}°</text>
        <text x="${ml - 5}" y="${Y(h) + 3}" text-anchor="end">${f0(h)}m</text>
        <text x="${ml - 5}" y="${H - mb}" text-anchor="end">0</text>
      </svg>
      <p class="clegend">
        <span style="color:${hotC}">━</span> HOTTEST WALL&nbsp;&nbsp;
        <span style="color:${coldC}">━</span> COOLEST WALL${hasAir ? `<br>
        <span style="color:${airC}">┄</span> AIR, BAND IS ±1σ` : ''}
      </p>`;
    return wrap;
  }

  _bars(b) {
    const W = this.d.ranked.weights;
    const box = el('div', 'bars');
    const NICE = {
      dose: 'hours above 35 °C', persistence: 'unbroken run', peak_air: 'peak air',
      facade_solar: 'sun on the walls', mrt: 'felt on the pavement',
      enclosure: 'how enclosed the street is',
      hvi: 'neighbourhood vulnerability', residents: 'people living here',
      age: 'building age', affordability: 'likely to run air conditioning',
    };
    const add = (label, value, colour) => {
      box.appendChild(el('div', 'b', `
        <div class="lab"><span>${label}</span><span>${Math.round(value * 100)}%</span></div>
        <div class="tr"><i style="width:${Math.round(value * 100)}%;background:${colour}"></i></div>`));
    };
    const c = b.components;
    // Exposure bars are drawn from the heat ramp; coping bars from the accent.
    // The distinction is the whole structure of the score, so it is carried by
    // colour rather than by a heading alone.
    box.appendChild(el('p', 'grp', `EXPOSURE ${f1(b.exposure)}`));
    for (const k of Object.keys(W.exposure)) {
      if (c[k] !== undefined) add(NICE[k] || k, c[k], css(RAMPS.temperature(0.72)));
    }
    box.appendChild(el('p', 'grp', `HOW BADLY THEY COPE ${f1(b.vulnerability)}`));
    for (const k of Object.keys(W.vulnerability)) {
      if (c[`vuln_${k}`] !== undefined) add(NICE[k] || k, c[`vuln_${k}`], 'var(--accent)');
    }
    return box;
  }

  /* --------------------------------------------------------------- hover */

  _hoverLoop() {
    const box = $('hover');
    const d = this.d;
    let lastAt = 0, lastX = -1, lastY = -1;
    const step = (t) => {
      const p = this.scene._lastPointer;
      const moved = p && (p.x !== lastX || p.y !== lastY);
      if (!moved && t - lastAt < 90) { requestAnimationFrame(step); return; }
      lastAt = t;
      if (p) { lastX = p.x; lastY = p.y; }

      const hit = this.scene.hitTest();
      if (!hit || !p) {
        box.style.display = 'none';
      } else {
        const a = d.buildings.attrs[hit.building];
        const rank = d.rankByBin.get(String(a?.bin));
        let lines = `<div class="a">${a?.addr || `BIN ${a?.bin ?? '—'}`}</div>`;
        if (hit.kind === 'facade' && hit.panel !== null) {
          const surf = d.surfaceAt(this.hour, hit.panel, hit.band);
          const lit = d.sunlitAt(this.hour, hit.panel, hit.band);
          const hh = Math.max(d.facades.top[hit.panel] - d.facades.base[hit.panel], 0.5);
          const z = (hh * (hit.band + 0.5)) / d.facades.bands;
          lines += `<div class="b">${compass(d.facades.az[hit.panel]).toUpperCase()} WALL`
                +  ` · ${f0(z)} M UP · ${lit ? 'IN SUN' : 'SHADED'}</div>`;
          // An annual layer has no hour, so quoting this hour's surface
          // temperature under it would be answering a different question from
          // the one the colour on the wall is showing.
          const L = LAYERS.find((x) => x.key === this.layer);
          if (L?.annual && L.plane) {
            lines += `<div class="t">${f0(d.annualAt(L.plane, hit.panel, hit.band))} `
                  +  `${L.unit}</div><div class="b">OVER THE WHOLE YEAR</div>`;
          } else {
            lines += `<div class="t">${f1(surf)} °C</div>`;
          }
          lines += `<div class="b">${f0(d.annualAt('sun_hours', hit.panel, hit.band))} H`
                +  ` OF SUN A YEAR · ${f0(d.annualAt('dose_kwh', hit.panel, hit.band))}`
                +  ' KWH/M²</div>';
        } else {
          lines += `<div class="b">ROOF · ${f0(a?.h)} M</div>`;
        }
        // The population ranks, matching the card.
        if (a?.pr_rank) {
          lines += `<div class="b">#${f0(a.pr_rank)} ON THE WAVE · `
                +  `#${f0(a.apr_rank)} ON THE YEAR</div>`;
        } else if (rank) {
          lines += `<div class="b">#${rank.rank} TO ACT ON</div>`;
        }
        box.innerHTML = lines;
        box.style.display = 'block';
        box.style.left = `${Math.min(window.innerWidth - 280, p.x + 14)}px`;
        box.style.top = `${Math.min(window.innerHeight - 110, p.y + 14)}px`;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function compass(az) {
  const n = ['north', 'north-east', 'east', 'south-east',
             'south', 'south-west', 'west', 'north-west'];
  return n[Math.floor((((az % 360) + 22.5) / 45)) % 8];
}

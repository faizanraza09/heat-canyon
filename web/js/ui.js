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

import { RAMPS, css, gradient, norm, SUN_CSS, TEMP_DOMAIN, EXCESS_DOMAIN }
  from './colors.js';
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

/* Round numbers a contour interval is allowed to take.
 *
 * A contour interval has to be a number somebody can do arithmetic with in their
 * head — "every 2 K, so that wall is six kelvin over the one beside it" — which
 * an interval derived straight from the span never is. So the span picks from
 * this ladder rather than dividing. The 2.5 and 25 are there because the gap
 * from 2 to 5 is otherwise wide enough to force either fifteen lines or four. */
const NICE_STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500];
const niceStep = (want) =>
  NICE_STEPS.find((n) => n >= want) || NICE_STEPS[NICE_STEPS.length - 1];
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

/* How long the city takes to travel between two clock states.
 *
 * The scene can dissolve one painted state into another for nothing (see
 * `fadeable` in scene.js), so the only question left here is how long, and the
 * answer is different for a step taken by hand and a step taken by the
 * transport.
 *
 * A step of a PLAYED day or year is one frame of a continuous sweep, so its
 * dissolve is exactly as long as the step and runs linearly: back to back they
 * make one unbroken movement, where an eased dissolve per step would settle and
 * set off again eight times a day and read as a stutter the code does not have.
 *
 * A step taken by hand — an hour chip, an arrow key, an answer that jumps to
 * the hour it is about — is a discrete move and gets a shorter, eased one. Half
 * a second is long enough to see the shadow line travel and short enough that
 * scrubbing the strip still feels like scrubbing.
 */
const DAY_STEP_MS = 1100;
const YEAR_STEP_MS = 260;
const HOUR_FADE_S = 0.55;
const DATE_FADE_S = 0.5;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/* ----------------------------------------------------------------- layers

   Names and captions are the design's, verbatim where a counterpart exists.
   Two layers here have no counterpart in it — sun and shade, and air
   temperature — because the prototype's model did not carry them; they are kept
   because this one does, and captioned in the same register.

   The captions are one sentence and they say what the number *means*, not how it
   was computed. "Hours above 35 °C" needs no explanation; "duration harms more
   than peak" is the reason to look at it.

   EIGHT, DOWN FROM THIRTEEN. Four of them were cut and it is worth saying which
   and why, because each was defensible on its own and the list was not.

     Longest unbroken run   The same duration field as "Hours above 35 °C", over
                            the same wave, sampled from the same 60 m tile at the
                            same address. A refinement of its neighbour rather
                            than a second question.
     Air temperature        Its own caption said it: "it barely varies with
                            height, which is the point". A layer whose finding is
                            that it is uniform is a flat map, it costs 4.7 MB a
                            period, and data.js calls it the one field whose
                            uncertainty exceeds its own signal. The comparison it
                            existed to make — air against the wall beside it —
                            is made far better in the building dossier's height
                            profile, which draws both curves against each other
                            with the uncertainty band on. That chart still loads
                            the field; see `_loadAir`.
     Sunlit hours a year    An input to "Annual solar dose", which is the same
                            geometry multiplied by the irradiance that makes it
                            matter. The dose is the actionable one, so it stays
                            and the hours go. The plane itself is still shipped
                            and still appears in the hover readout.
     Month it peaks         A curiosity rather than a decision, and it painted a
                            month INDEX on the temperature ramp — so December
                            drew deep blue and July drew deep red on a scale
                            whose labels read −20 to 60 °C. That was tolerable
                            while the ramp was abstract; against a fixed absolute
                            scale it is simply wrong.

   The test of the list is that every row answers a question somebody would ask
   out loud. Four rows that were answering a variation of the row above them is
   what "layer fatigue" is.                                                    */

export const LAYERS = [
  {
    key: 'surface', name: 'Façade temperature', unit: '°C', ramp: 'temperature',
    caption: 'How hot each wall actually gets. A sunlit face runs far hotter than the air standing beside it.',
  },
  {
    /* The same solved field as the row above, with the hour's air temperature
       taken out of it.

       It is here because of a measurement rather than a preference. Across the
       104 solved fields, 96% of the facade field's variance is the air
       temperature of the hour — one number, no spatial structure — and 4% is
       everything that separates one wall from another. So the absolute layer
       spends an 80 K scale to show a 4 K city, and on 55 of those 104 fields the
       whole of Midtown lands inside about five just-noticeable colours.

       Subtracting the anchor widens nothing. It lets the DOMAIN close from 80 K
       to 24 K with no colour ever moving between one hour and the next, which is
       5.4x the visible structure for no loss of comparability: a wall 22 K over
       the air in January is the same colour, and the same fact, as one in July.
       See EXCESS_DOMAIN in colors.js. */
    key: 'excess', name: 'Façade excess over air', unit: 'K', ramp: 'excess',
    caption: 'How far each wall runs above the air standing beside it. The day\u2019s own warmth is taken out, so what is left is what the canyon does.',
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
    /* The gain the viewer has CHOSEN, which is not always the gain the scene is
     * drawing: holding X drops the scene to 1 without forgetting this. Keeping
     * the two apart is what lets the legend go on saying what the key will give
     * back, instead of the note vanishing at the moment it is being used. */
    this._gain = 1;
    this._gainHeld = false;
    this._sweepTimer = null;
    this._sweepU = 0;
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
    this._brush();
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
        case 'b': case 'B': this.toggleSweep(); break;
        case 'c': case 'C':
          this.scene.setContoursOn(!this.scene.isoOn);
          this._legend();
          break;
        case 'Escape':
          this.stopSweep();
          if (this.scene.valueBrush) this._setBrush(null);
          else if (this.selected !== null) this.clearSelection();
          break;
        /* G steps the gain and X holds the truth.
         *
         * Two keys rather than one because they are two different acts. The gain
         * is a setting you leave on while you read the city; the measured field
         * is something you check against, for a second, without losing your
         * place. A single toggle would make the second act cost two presses and
         * a memory of which state you were in. */
        case 'g': case 'G': {
          if (this.layer !== 'surface') break;
          this._gain = { 1: 2, 2: 3, 3: 4, 4: 1 }[this._gain] || 2;
          if (!this._gainHeld) this.scene.setDetailGain(this._gain);
          this._legend();
          break;
        }
        case 'x': case 'X':
          // `repeat` guard: a held key fires keydown at the OS repeat rate, and
          // each one would be a full recolour of 294,150 quads.
          if (e.repeat || this._gainHeld) break;
          this._gainHeld = true;
          this.scene.setDetailGain(1);
          this._legend();
          break;
        case '[': this.toggleFold('left'); break;
        case ']': this.toggleFold('right'); break;
        case '\\': this.toggleFold('bottom'); break;
        case 'h': case 'H': this.clearView(); break;
        // North. The single most useful key in a 3D view of a city whose whole
        // vocabulary is which way a wall faces.
        case 'n': case 'N': this.scene.faceNorth(); break;
        /* Turning and tilting, on the keys they sit on in every other 3D view:
         * Q and E either side of the hand, W and S above and below it. The
         * building being turned around is whichever one is selected, so these
         * are the keyboard route to the three walls you cannot see. */
        case 'q': case 'Q': this.scene.turn(-1); break;
        case 'e': case 'E': this.scene.turn(1); break;
        case 'w': case 'W': this.scene.tilt(-1); break;
        case 's': case 'S': this.scene.tilt(1); break;
        case 'o': case 'O': this.scene.toggleSpin(); break;
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

    window.addEventListener('keyup', (e) => {
      if (e.key !== 'x' && e.key !== 'X') return;
      if (!this._gainHeld) return;
      this._gainHeld = false;
      this.scene.setDetailGain(this._gain || 1);
      this._legend();
    });
    /* A key held down while the window loses focus never sends its keyup, and
     * the city would stay at gain 1 with the legend promising otherwise. */
    window.addEventListener('blur', () => {
      if (!this._gainHeld) return;
      this._gainHeld = false;
      this.scene.setDetailGain(this._gain || 1);
      this._legend();
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

  /* The working is a closed drawer, which is right for someone who came for an
   * answer and wrong for the one beat of the film whose whole line is "it shows
   * you what it ran". The film opens it; nothing else does. */
  openWorking() {
    document.querySelector('#analyst-body .workblock')?.setAttribute('open', '');
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
    // The scene drops the brush itself on a layer change — a value on one ramp
    // is not a value on the next. This clears what the panel is saying about it.
    if (key !== this.layer) { this.stopSweep(); this._setBrush(null); }
    this.layer = key;
    for (const b of $('layers').children) {
      b.setAttribute('aria-pressed', String(b.dataset.key === key));
    }
    this.scene.setLayer(key);
    this._legend();
    this._syncSurfaces('layer');
  }

  /** Fetch the air field for the period on screen, then redraw the open dossier.
   *
   * The air profile is 4.7 MB per period and is deliberately not loaded up
   * front — it is the field whose uncertainty exceeds its own signal, and most
   * sessions never need it. It has one consumer now that the air LAYER is gone:
   * the height profile in a building's dossier, which draws the air curve and
   * its uncertainty band against that building's hottest and coolest wall. That
   * chart is where the air-versus-facade comparison actually reads — two curves
   * a few metres apart on the same axis, rather than a flat wash over the whole
   * city — so opening a dossier is the demand that loads it.
   *
   * Before this the only thing that ever asked for it was `setTime`, and only
   * when the date changed while the air layer was already showing. So the
   * obvious gesture loaded nothing: every band read NaN and the chart quietly
   * dropped its air curve, which looks like a chart that has no air data rather
   * than one whose data has not arrived.
   *
   * Guarded on re-entry by `hasAir`, and on the selection having changed under
   * the fetch, so a dossier closed mid-flight does not redraw five seconds later.
   */
  async _loadAir() {
    const want = this.selected;
    $('time').classList.add('loading');
    try {
      await this.d.ensureAir();
    } catch (e) {
      console.warn('could not load the air field', e);
      return;
    } finally {
      $('time').classList.remove('loading');
    }
    if (this.selected === null || this.selected !== want) return;
    this.showDetail(this.selected, true);
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
    else if (L.key === 'priority' || L.key === 'annual_priority') { lo = 0; hi = 85; }
    else if (L.key === 'excess') { [lo, hi] = EXCESS_DOMAIN; }
    else if (L.annual) { [lo, hi] = this.scene.annualDomain(L.plane); }
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

    /* Where the field on screen actually sits on the scale.
     *
     * Only for the two layers whose scale is fixed rather than derived, because
     * they are the only ones where the question arises. Everywhere else the
     * domain IS the data's range and a bracket would span the whole ramp and say
     * nothing.
     *
     * The span comes from the scene's last repaint rather than from a second
     * sweep of the field: `_recolour` has already visited every quad and already
     * normalised every value against this exact domain, so reading its result
     * costs nothing and cannot disagree with what was drawn. Reading it here
     * also means the bracket follows the hour, which is right — three in the
     * morning and three in the afternoon are two very different slices of the
     * same fixed scale, and watching the bracket move up the ramp as the clock
     * runs is the clearest statement of that the panel can make. */
    const span = $('legend-span');
    const here = $('legend-here');
    // The middle 98%, not the outright extremes — see `Scene.coreOf` for the
    // hour that made the difference matter.
    const pr = (L.key === 'surface' || L.key === 'excess') ? this.scene.paintedCore : null;
    span.hidden = !pr;
    here.hidden = !pr;
    if (pr) {
      const [a, b] = pr;
      // A floor on the width so a period that spans two kelvin of an eighty
      // kelvin scale is still a mark you can see rather than a hairline. At
      // 03:00 on the heat-wave day the whole city sits inside 2.1 K, which is
      // 2.6% of the ramp, and that is a true and interesting fact about three in
      // the morning — it should read as "narrow", not as "missing".
      const w = Math.max(0.012, b - a);
      const left = Math.min(1 - w, a);
      span.style.left = `${(left * 100).toFixed(2)}%`;
      span.style.width = `${(w * 100).toFixed(2)}%`;
      const u = L.unit ? ` ${L.unit}` : '';
      /* The rectangle above marks where the COLOURS fall, so it follows the
       * gain. These figures name TEMPERATURES, so they never can: an
       * exaggerated field is still a claim about the ramp, not about the city,
       * and a bracket reading 28 to 52 degC on an hour the model solved at 34 to
       * 42 would be the instrument lying in its own legend. The two are read
       * from two accumulators for exactly this reason, and where they disagree
       * the line says by how much. */
      const gNow = this._gainHeld ? 1 : (this._gain || 1);
      const [ta, tb] = (L.key === 'surface' && this.scene.paintedCoreTrue)
        ? this.scene.paintedCoreTrue : [a, b];
      here.innerHTML =
        `MIDDLE 98% ON SCREEN · ${f1(lo + ta * (hi - lo))} TO ${f1(lo + tb * (hi - lo))}${u}`
        + (gNow > 1 ? ` &nbsp;·&nbsp; DRAWN &times;${gNow} WIDER` : '');
    }

    /* The gain, said out loud whenever it is not 1.
     *
     * This is the whole licence for exaggerating anything. The project deleted a
     * per-period auto-scale because the domain moved and only the small type
     * knew; a detail gain that were not printed here would be the same sin in a
     * subtler form. The held key is the other half — being able to see the
     * measured field at any moment is what makes the exaggerated one readable
     * rather than merely striking. */
    const gainNote = $('legend-gain');
    const g = this._gain || 1;
    const showGain = L.key === 'surface' && g > 1;
    gainNote.hidden = !showGain;
    if (showGain) {
      gainNote.innerHTML = this._gainHeld
        ? 'MEASURED FIELD &nbsp;·&nbsp; RELEASE X FOR '
          + `LOCAL DETAIL &times;${g}`
        : `LOCAL DETAIL &times;${g} &nbsp;·&nbsp; `
          + 'NEIGHBOURHOODS HELD AT TRUE COLOUR &nbsp;·&nbsp; HOLD X FOR THE MEASURED FIELD';
    }

    /* Isotherms, and the interval they are drawn at.
     *
     * Chosen here rather than in the scene because a round interval is a fact
     * about the layer's UNITS, and the scene deals only in the 0..1 domain
     * everything is painted through. Aimed at eight lines across the middle 98%:
     * enough that the spacing reads as a texture and you can see where the field
     * steepens, few enough that they stay lines rather than becoming a hatch.
     *
     * From the MEASURED core, so the interval does not change when the gain
     * does — the whole value of the contours beside a gain is that they are the
     * one thing on screen the exaggeration cannot move.
     *
     * Not on sun and shade, which is categorical: an isotherm needs a field to
     * be continuous before it means anything, and two values are not a field. */
    const core = this.scene.paintedCoreTrue || this.scene.paintedCore;
    let step = 0;
    if (L.key !== 'sun' && core && hi > lo) {
      step = niceStep(((core[1] - core[0]) * (hi - lo)) / 8);
    }
    this.scene.setContour(step > 0 ? step / (hi - lo) : 0);
    const isoNote = $('legend-iso');
    const showIso = step > 0 && this.scene.isoOn;
    isoNote.hidden = !showIso;
    if (showIso) {
      const iu = L.unit ? ` ${L.unit}` : '';
      isoNote.innerHTML =
        `CONTOURS EVERY ${step}${iu} &nbsp;·&nbsp; DRAWN FROM THE MEASURED FIELD`
        + ' &nbsp;·&nbsp; C HIDES THEM';
    }

    this._drawHist(L);

    // Where a layer is solved on a coarser grid than the thing it is painted
    // on, the panel says so under the scale. One shared ramp means a legend
    // reading "h" also applies to the walls, and the walls get that value by
    // sampling the tile at the address rather than by having one of their own —
    // which is honest, and worth one line of type.
    const note = $('legend-note');
    const ground = L.key === 'exceedance';
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

  /** The distribution of what is on screen, drawn on the ramp's own axis.
   *
   * Read straight out of `scene.paintedHist`, which the recolour loop fills
   * while it is already visiting all 294,150 quads and already normalising every
   * value — the same argument as the bracket. A separate sweep would be a second
   * implementation of the ramp and the gain, and it would drift.
   *
   * SQUARE ROOT, NOT LINEAR. The counts are violently skewed: on a clear night
   * the entire city lands in two or three bins, and drawn linearly that is one
   * full-height spike beside ninety-three empty ones — technically the truth and
   * visually a single line. The root keeps zero at zero, keeps the ordering, and
   * leaves the small bins tall enough to have a shape. It is a shape to be read,
   * not a bar to be measured off, and the numbers underneath are the bracket's
   * job. */
  _drawHist(L) {
    const cv = $('legend-hist');
    const h = this.scene.paintedHist;
    const w = cv.clientWidth;
    // The panel can be folded away, in which case there is nothing to draw on
    // and `clientWidth` is 0. Coming back re-runs `_legend`.
    if (!cv || !h || !w) return;
    const H = 34;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);

    let max = 0;
    for (let i = 0; i < h.length; i++) if (h[i] > max) max = h[i];
    if (!max) return;

    // Each bar in the ramp colour of its own bin, so the histogram and the ramp
    // beneath it read as one object rather than as a chart above a key.
    const f = RAMPS[L.ramp] || RAMPS.temperature;
    const bw = w / h.length;
    const k = 1 / Math.sqrt(max);
    for (let i = 0; i < h.length; i++) {
      if (!h[i]) continue;
      // A floor of one pixel: a bin holding forty panels out of 294,150 is a
      // real and often interesting fact — it is usually the hottest wall in
      // Midtown — and rounding it to nothing is how the tail disappears.
      const bh = Math.max(1, Math.sqrt(h[i]) * k * (H - 1));
      ctx.fillStyle = css(f((i + 0.5) / h.length));
      ctx.fillRect(i * bw, H - bh, Math.max(1, bw - 0.5), bh);
    }
  }

  /* The window dragged across the scale, and what it is for.
   *
   * A median hour is about five just-noticeable colours wide across the whole
   * city, so "which walls are in the top two kelvin of this hour" is a question
   * no ramp can be read for at any gain. Dragging a window along the
   * distribution and watching which walls survive answers it in the geometry.
   *
   * The gesture is deliberately the crudest one available — press, drag,
   * release, click to clear — because it is a thing to sweep rather than a thing
   * to set. The interesting reading is the sweep itself: pushing a narrow window
   * up the distribution and watching the surviving walls climb the sunlit flanks
   * is the spatial structure of an hour, delivered one slice at a time. */
  _brush() {
    const host = $('legend-scale');
    if (!host) return;
    let dragging = false;
    let a = 0;
    const xOf = (e) => {
      const r = host.getBoundingClientRect();
      return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
    };
    host.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // Taking hold of the window ends the sweep. Two things moving the same
      // control is not a mode anybody can be in.
      this.stopSweep();
      dragging = true;
      a = xOf(e);
      host.setPointerCapture(e.pointerId);
      this._setBrush(a, a);
    });
    host.addEventListener('pointermove', (e) => {
      if (dragging) this._setBrush(a, xOf(e));
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      // A press that never moved is a click, and a click on the scale clears.
      // Six thousandths of the width is about a pixel and a half at the panel's
      // size — under the hand tremor that turns every click into a tiny drag.
      if (Math.abs(xOf(e) - a) < 0.006) this._setBrush(null);
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
  }

  /* Walk the window up the distribution on its own.
   *
   * The brush answers "which walls are in this slice"; the sweep asks it of
   * every slice in turn, and the answer is the thing the ramp cannot hold. On a
   * flat hour the whole city is five just-noticeable colours wide, so there is
   * no colour to read the spatial structure OFF — but there is an order, and a
   * narrow window climbing that order draws it directly: the surviving walls
   * start at the shaded bases of the deep canyons and finish on the upper west
   * flanks, and you watch them go.
   *
   * PACED IN STEPS, NOT IN KELVIN. Ninety steps across the span whatever the
   * span is, so a two-kelvin night and a twenty-kelvin afternoon take the same
   * six seconds. Tying the rate to the data instead would make exactly the hours
   * that need the sweep most take the least time to show.
   *
   * Seventy milliseconds a step rather than a frame: each one is a full recolour
   * of 294,150 quads plus the ghost upload, which is ~40 ms measured, so a
   * per-frame sweep would simply drop every other frame and read as a stutter.
   * Fourteen a second is smooth enough to follow and leaves the frame budget
   * alone. */
  toggleSweep() {
    if (this._sweepTimer) { this.stopSweep(); return; }
    this._sweepU = 0;
    this._sweepTimer = setInterval(() => this._sweepStep(), 70);
    this._sweepStep();
  }

  stopSweep() {
    if (!this._sweepTimer) return;
    clearInterval(this._sweepTimer);
    this._sweepTimer = null;
    this._setBrush(null);
  }

  _sweepStep() {
    // Re-read the span every step, so a sweep left running while the clock plays
    // follows the hour instead of walking a range that has moved out from under
    // it.
    const core = this.scene.paintedCore || [0, 1];
    const span = Math.max(0.02, core[1] - core[0]);
    // Wide enough to hold a useful number of walls, narrow enough that moving it
    // changes which ones. An eighth of the span, floored at three bins so a very
    // flat hour still has a window rather than a hairline.
    const w = Math.max(3 / 96, span * 0.125);
    const a = core[0] - w;
    const b = core[1];
    const lo = a + this._sweepU * (b - a);
    this._setBrush(lo, lo + w);
    this._sweepU += 1 / 90;
    if (this._sweepU > 1) this._sweepU = 0;
  }

  /** Apply a brush, or clear it with a single null argument, and say in numbers
   *  what the window is keeping. */
  _setBrush(a, b) {
    const note = $('legend-brushnote');
    const bar = $('legend-brush');
    if (a === null) {
      this.scene.setValueBrush(null);
      note.hidden = true;
      bar.hidden = true;
      return;
    }
    const loT = Math.min(a, b), hiT = Math.max(a, b);
    this.scene.setValueBrush([loT, hiT]);
    bar.hidden = false;
    bar.style.left = `${(loT * 100).toFixed(2)}%`;
    bar.style.width = `${Math.max(0.4, (hiT - loT) * 100).toFixed(2)}%`;

    const L = LAYERS.find((x) => x.key === this.layer);
    let lo, hi;
    if (L.key === 'exceedance') { const st = this.d.tiles.stats.exceedance; lo = st.min; hi = st.max; }
    else if (L.key === 'priority' || L.key === 'annual_priority') { lo = 0; hi = 85; }
    else if (L.key === 'excess') { [lo, hi] = EXCESS_DOMAIN; }
    else if (L.annual) { [lo, hi] = this.scene.annualDomain(L.plane); }
    else { [lo, hi] = this.scene.surfaceDomain; }

    // How many panel-bands survived, counted off the same histogram the window
    // was dragged across rather than by re-walking the field.
    const h = this.scene.paintedHist;
    let kept = 0, all = 0;
    if (h) {
      for (let i = 0; i < h.length; i++) {
        all += h[i];
        const c = (i + 0.5) / h.length;
        if (c >= loT && c <= hiT) kept += h[i];
      }
    }
    const u = L.unit ? ` ${L.unit}` : '';
    const pct = all ? (100 * kept) / all : 0;
    note.hidden = false;
    note.innerHTML =
      `KEEPING ${f1(lo + loT * (hi - lo))} TO ${f1(lo + hiT * (hi - lo))}${u}`
      + ` &nbsp;·&nbsp; ${f0(kept)} PANEL-BANDS, ${pct < 0.1 && kept ? '<0.1' : pct.toFixed(1)}%`
      + (this._sweepTimer ? ' &nbsp;·&nbsp; B STOPS THE SWEEP'
        : ' &nbsp;·&nbsp; CLICK THE SCALE TO CLEAR');
  }

  /* ---------------------------------------------------------------- hours */

  _hours() {
    // The year strip owns the date; the hour strip owns the time of day. Two
    // controls because they are two independent axes, and collapsing them into
    // one slider was tried and made the interesting question — the same hour in
    // different months — impossible to ask.
    this.year = new YearStrip($('year-host'), this.d, (date, aggregate) => {
      // A played year is a sweep and a dragged one is a scrub; both want the
      // dissolve to be over by the time the next date lands, so it is the step
      // that sets the length rather than a constant.
      this.setDate(date, aggregate, this.playingYear
        ? { fade: YEAR_STEP_MS / 1000, linear: true }
        : { fade: DATE_FADE_S });
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
  async setDate(date, aggregate, { fade = DATE_FADE_S, linear = false } = {}) {
    /* Carry the air field across a change of period, but never fetch it for a
     * period that was not going to have it anyway. It is 4.7 MB and it belongs
     * to the period, so a scrub from July to January has to re-fetch it or the
     * dossier's height profile silently loses its air curve halfway through a
     * comparison. Keyed on whether we already have it rather than on the layer,
     * because there is no longer an air layer to key on. */
    const wantAir = this.d.hasAir();
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
    this.scene.setPeriod({ fade, linear });
    this._timeMeta();
    this._legend();
    this._bottomLabel();
    this.year?.draw();
    if (this.selected !== null) this.showDetail(this.selected, true);
    this._syncSurfaces('time');
  }

  /** Point the whole application at an hour slot.
   *
   *  `fade` and `linear` reach the scene untouched; every caller that does not
   *  care gets the hand-taken dissolve, which is the right default because a
   *  caller that does not care is a person having clicked something. */
  setHour(i, { fade = HOUR_FADE_S, linear = false } = {}) {
    this.hour = i;
    const kids = $('hours').children;
    for (let k = 0; k < kids.length; k++) {
      kids[k].setAttribute('aria-pressed', String(k === i));
    }
    this.scene.setHour(i, { fade, linear });
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
      () => this.setHour((this.hour + 1) % this.d.meta.hours.length,
        { fade: DAY_STEP_MS / 1000, linear: true }), DAY_STEP_MS);
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
    }, YEAR_STEP_MS);
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
      + 'RIGHT-DRAG OR SHIFT-DRAG TURNS AND TILTS<br>'
      + 'Q E TURN&nbsp;&nbsp;·&nbsp;&nbsp;W S TILT&nbsp;&nbsp;·&nbsp;&nbsp;'
      + 'O ORBITS&nbsp;&nbsp;·&nbsp;&nbsp;N FACES NORTH<br>'
      + 'DOUBLE-CLICK TO CLOSE IN&nbsp;&nbsp;·&nbsp;&nbsp;CLICK TO INSPECT<br>'
      + 'SPACE PLAYS THE DAY&nbsp;&nbsp;·&nbsp;&nbsp;← → THE HOUR<br>'
      + '[ ] \\ THE PANELS&nbsp;&nbsp;·&nbsp;&nbsp;H CLEARS THE VIEW<br>'
      + 'G LOCAL DETAIL&nbsp;&nbsp;·&nbsp;&nbsp;X HOLDS THE MEASURED FIELD<br>'
      + 'C CONTOURS<br>'
      + 'DRAG THE SCALE TO KEEP ONLY THOSE WALLS&nbsp;&nbsp;·&nbsp;&nbsp;B SWEEPS IT';

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

    /* The turn pad. Each press is a flown step rather than a jump, for the same
     * reason every other camera control here is: a cut to the far side of a
     * building loses which side you were on, and the whole point of turning
     * around one building is knowing which wall you have arrived at. */
    $('nav-turn-l').onclick = () => this.scene.turn(-1);
    $('nav-turn-r').onclick = () => this.scene.turn(1);
    $('nav-tilt-up').onclick = () => this.scene.tilt(-1);
    $('nav-tilt-down').onclick = () => this.scene.tilt(1);

    const orbitBtn = $('nav-spin');
    orbitBtn.onclick = () => this.scene.toggleSpin();
    // The button follows the scene rather than its own click, because the
    // revolution stops for a drag, a wheel, a reset and a new selection — all
    // of which happen without the button being touched.
    this.scene.onSpinChange = (on) =>
      orbitBtn.setAttribute('aria-pressed', String(on));
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
      openIfWanted();
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

    /* The layer opens ON wherever a key can be found, and remembers being
     * turned off.
     *
     * The default used to be off, and the reasoning behind that is still on the
     * record above: billing is per session, so the honest thing was to request
     * nothing until asked. What changed is that the photograph is now the view
     * the film hands over to, and a film that ends by revealing untextured
     * blocks is a film that undersells the thing it just spent three minutes
     * introducing.
     *
     * Two properties keep it honest. No key, no request — a build with nothing
     * in `.env` and nothing in this browser behaves exactly as it did, which
     * includes the CDN deploy, where there is no /api/config to answer. And the
     * choice is remembered: switching it off is a decision that survives a
     * reload, so nobody has to keep switching it off on a metered connection.
     *
     * `?photoreal=0` forces it off for one visit without touching the
     * remembered preference, which is what a demo on someone else's quota
     * wants. */
    const PR_PREF = 'heatcanyon.photoreal_on';
    const wantsOn = () => {
      if (new URLSearchParams(location.search).get('photoreal') === '0') return false;
      try { return localStorage.getItem(PR_PREF) !== '0'; } catch (e) { return true; }
    };
    const remember = (on) => {
      try { localStorage.setItem(PR_PREF, on ? '1' : '0'); }
      catch (e) { /* private browsing: it applies to this page and no further */ }
    };

    // Opened once, from whichever key arrives first. `_prAuto` guards the race:
    // a key in this browser resolves synchronously and one from the server does
    // not, and the layer must not be built twice.
    const openIfWanted = async () => {
      if (this._prAuto || !wantsOn() || !anyKey()) return;
      if (toggle.getAttribute('aria-pressed') === 'true') return;
      this._prAuto = true;
      await setOn(true);
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
      remember(on);
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
    /* The reach cap. Read out in kilometres, and the top stop reads NO LIMIT
     * rather than 12.5 km because that is what it is: the cull stands down and
     * the frustum is the only bound again, which is the right picture for a
     * fly-over that wants the horizon in it. */
    slider('pr-radius', 'pr-radius-out', (v) => (v > 12 ? 'NO LIMIT' : `${v.toFixed(1)} KM`),
      (v) => this.scene.photoreal?.setContextRadius(v > 12 ? Infinity : v * 1000));
    $('pr-solids').onchange = (e) => this.scene.setShowSolids(e.target.checked);
    slider('pr-nudge', 'pr-nudge-out', (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} m`,
      (v) => this.scene.photoreal?.setNudge(v));

    if (findApiKey()) say('Key found in this browser.');
    // A key already in this browser needs no round trip; the server's own key
    // arrives later and calls this again, and openIfWanted ignores the second.
    openIfWanted();
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

  /* ------------------------------------------------------- storeys, in the
     model

     The decision layer talks in STOREYS and the solve is in BANDS — ten of them
     on this building, three or four storeys each — and the conversion needs the
     floor count, which lives in the ranking rather than in the geometry. So it
     is done once, here, and nothing downstream has to know that "floor
     twenty-five" is band seven.

     This is what lets the walkthrough point at a floor instead of naming one.
     Five of chapter three's beats are about one storey or one range of them and
     every one of them used to play over a tower lit evenly from pavement to
     roof; the argument was in the caption and the picture was of a building. */

  /** Bands, inclusive, for a run of storeys on one building. Null if the
   *  building is not in the study area or has no stated floor count. */
  _bandsOfFloors(bin, from, to) {
    const i = this.d.binToIndex.get(String(bin));
    if (i === undefined) return null;
    const item = this.d.ranked.items.find((it) => String(it.bin) === String(bin));
    const floors = item?.floors || 0;
    const nBand = this.d.facades?.bands || 0;
    if (!floors || !nBand) return null;
    const band = (f) => Math.max(0, Math.min(nBand - 1,
      Math.floor(((Math.max(1, Math.min(floors, f)) - 1) / floors) * nBand)));
    const lo = band(Math.min(from, to ?? from));
    const hi = band(Math.max(from, to ?? from));
    return { i, lo, hi, floors };
  }

  /** Light one storey, or a run of them, and drain the rest of the building.
   *  Called with no arguments — or with a building that is not here — it takes
   *  the focus away, which is what every beat that stops talking about a floor
   *  wants. */
  focusFloors(bin = null, from = null, to = null) {
    if (bin === null || from === null) {
      this.scene.setBandFocus(null);
      this.surfaces?.brief?.markFloors?.(null);
      return;
    }
    const b = this._bandsOfFloors(bin, from, to);
    if (!b) { this.scene.setBandFocus(null); return; }
    this.scene.setBandFocus(b.i, b.lo, b.hi);
    // The same storeys, marked on the schedule. The document and the model are
    // two views of one claim and they should never be pointing at different
    // parts of it.
    this.surfaces?.brief?.markFloors?.(
      Math.min(from, to ?? from), Math.max(from, to ?? from));
  }

  /** Metres above the pavement at the middle of a storey — what the camera
   *  needs to stand level with the floor the narration just named. */
  floorHeight(bin, f) {
    const i = this.d.binToIndex.get(String(bin));
    if (i === undefined) return null;
    const item = this.d.ranked.items.find((it) => String(it.bin) === String(bin));
    const floors = item?.floors || 0;
    const h = this.d.buildings?.attrs?.[i]?.h || 0;
    if (!floors || !h) return null;
    return h * ((Math.max(1, Math.min(floors, f)) - 0.5) / floors);
  }

  /** The model's own index for a BIN, for the camera calls that want one. */
  indexOf(bin) {
    const i = this.d.binToIndex.get(String(bin));
    return i === undefined ? null : i;
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
     * says so on its own line — which is the disagreement, shown per building,
     * where someone can act on it.
     *
     * The overlap and Spearman figures used to be printed underneath as a
     * paragraph. They are gone. A panel headed "where to act first" opens with
     * a reader who wants to know which building to start on, and three lines of
     * rank-correlation statistics before the first row answers a question
     * nobody asked and reads as the tool hedging. Both numbers are still in
     * `ranked.json`, the per-row ranks still make the same point, and the film
     * still quotes the overlap where it has the time to explain it.
     *
     * The two scores are on the same 0-100 scale by construction — both are a
     * geometric mean of an exposure index against the same vulnerability score —
     * so averaging them is defensible rather than convenient. It weights an
     * acute event and a chronic year equally, which is a choice, and it is
     * stated here and in the panel's own subtitle rather than buried. Anyone who
     * wants one ordering alone still has both scores on every row and both
     * orderings in `ranked.json`.
     */
    /* Unconditional, now that it no longer quotes the agreement figures. It was
     * guarded on `orderings.agreement` because everything in it came from
     * there; what is left is a statement about how this list is sorted, which
     * is true of every build whether or not the agreement block exists. */
    const note = el('p', 'note',
      'RANKED BY THE MEAN OF THE EVENT-DAY AND ANNUAL PRIORITY SCORES');
    note.style.margin = '0 22px 14px';
    body.appendChild(note);

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

    // The dossier's height profile wants the air field, and opening a dossier is
    // the only thing that ever asks for it now. Fired and not awaited: the card
    // is drawn from data already in memory and must not wait 4.7 MB to appear.
    // `_loadAir` redraws it when the field lands, and does nothing if the
    // selection moved on in the meantime.
    if (!this.d.hasAir()) this._loadAir();

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
    const to = Math.max(0, box.scrollTop + top - 28);

    /* A LONG JUMP IS NOT A SCROLL ANYONE FOLLOWS.
     *
     * `smooth` everywhere was costing the walkthrough its whole point. The
     * highlight is a hole cut in a scrim, and `boxOf` refuses a box that is
     * entirely off screen — correctly, because a hole below the fold is a
     * dimmed frame with nothing lit in it. So while a smooth scroll crosses
     * several thousand pixels the target does not exist on screen yet, the
     * highlight is hidden, and the beat opens with a caption naming something
     * the viewer cannot see. Measured over a playthrough that was about six
     * tenths of a second at the head of every beat that changes section, and on
     * one beat the target was moved on again before it ever arrived.
     *
     * Distance decides. Inside about a screen and a half, gliding is legible
     * and worth having — it shows the document is one document and the reader
     * is moving down it. Past that, nobody is tracking the blur; they are
     * waiting for it to stop. So a long move lands immediately and a short one
     * glides, which is also how a person reading a long document actually
     * behaves: page down, then adjust.
     */
    const far = Math.abs(to - box.scrollTop) > box.clientHeight * 1.5;
    box.scrollTo({ top: to, behavior: far ? 'auto' : 'smooth' });
  }

  /** The nth numbered section of the building brief, 1-based. */
  briefSection(n) {
    this.scrollSurface('brief-doc', `.brf-sec:nth-of-type(${n})`);
  }
  /** The programme the portfolio panel is currently showing. Anything that
   *  narrates that panel reads this rather than the stored allocation, so the
   *  words and the picture are the same programme. Null before the decision
   *  layer has landed. */
  programme() { return this.surfaces?.portfolio?.programme?.() || null; }

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
    // Height off this building's own range, colour off the absolute scale — the
    // same split the year strip makes, for the same reason. Colouring the bars
    // against `lo`/`hi` made every building's January bar the coldest colour on
    // the ramp and every building's July bar the hottest, so twelve months of a
    // cool courtyard wall and twelve months of a west-facing tower drew the
    // identical picture. The bar heights already carry the shape; the colour is
    // there to say which of those two walls you are looking at.
    const bars = vals.map((v, i) => {
      const c = css(RAMPS.temperature(norm(v, TEMP_DOMAIN[0], TEMP_DOMAIN[1])));
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
    // Fixed positions rather than the curves' own values, because these two are
    // a hot wall and a cool wall of the same building and the pair has to stay
    // told apart at every hour of every month. Far enough apart on the ramp to
    // be distinguishable, and both far enough from the panel's own background to
    // be seen at all — 0.52 is the pale hinge and 0.88 a strong orange, which
    // both clear #131110 comfortably.
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

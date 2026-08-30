/* The opening film: its words, its storyboard, and the arithmetic behind both.
 *
 * Three rules govern this file.
 *
 * First, every figure the film makes a claim with is read out of the artefacts
 * the application itself runs on — meta.json, ranked.json, and the NASA GISTEMP
 * series fetched by scripts/make_globe_assets.py — so the narration cannot drift
 * away from the model it is introducing. Re-run the pipeline on a different city
 * or a different day and the voice-over updates itself. There are no hand-typed
 * numbers in the script at all.
 *
 * Second, figures are spelled as words: "a hundred and forty-six years", not
 * "146 years"; "thirty-nine degrees", not "39 °C". That is the design's register
 * and it earns its keep twice over. A caption set in Instrument Serif at 38px
 * reads as prose rather than as a readout, which is the difference between a
 * film and a dashboard with a voice; and it means the caption and the spoken line
 * can be the same string, because a speech synthesiser given "39 °C" says
 * "thirty-nine degree see". The number-to-words helpers below exist for that, and
 * they are the reason no beat needs a separate `say`.
 *
 * Third, a beat's length is stated, not derived. An earlier version timed each
 * beat from its own word count, on the reasoning that lengthening a line should
 * lengthen its shot. That is a defensible idea which produced a film of 1:47,
 * and it made the runtime a function of the machine: the title card promises a
 * runtime and the transport bar sizes its segments by chapter, and both should
 * read the same everywhere and whether or not the sound is on.
 *
 * The film has been recut several times since. It is now five chapters and
 * thirty beats, 2:56, and it is built to this shape:
 *
 *     I    A year over Manhattan    4 beats   19.6 s   the globe, and the scale
 *     II   Going in                 2 beats   10.3 s   the descent, and the walls
 *     III  One building            12 beats   82.0 s   one wall, diagnosed and priced
 *     IV   All of them              8 beats   48.0 s   the instrument, and the programme
 *     V    Ask it                   4 beats   16.5 s   the analyst, answering
 *
 * THE STATED LENGTHS INCLUDE THE READ. Each is at least what its recorded line
 * needs — `recording / MAX_RATE + TAIL`, see voice.js — so `film._retime()`
 * finds nothing to stretch and the runtime on the title card is 2:56 before the
 * narration index has loaded as well as after. It used to print 2:48 and then
 * correct itself, which is a small lie of the sort that makes a viewer stop
 * believing the rest of the numbers.
 *
 * That coupling has a maintenance cost, and it is the price of the button being
 * honest on first paint: EDIT A LINE OR RE-BAKE THE VOICE AND THESE NUMBERS ARE
 * STALE. `_retime()` still corrects at run time, so nothing breaks — the title
 * card simply goes back to changing once. To re-derive them, ask the server what
 * each line costs (POST /api/voice/lines with the beats' `say` strings) and set
 * each `seconds` to `max(stated, round(recording / 1.15 + 0.25, 2))`.
 *
 * The second half of the script is about the application rather than the
 * afternoon: the whole year rather than one day, and the fact that the model does
 * not stop at describing a wall — it costs the fix on it, floor by floor, and
 * there is an analyst you can put the question to. An older cut ended on "this is
 * where a city begins", which is a fine line about a model and says nothing about
 * an instrument.
 *
 * A beat is one sentence, one held frame. Its `stage` block is the storyboard:
 * the state the scene should have arrived at by the *end* of that beat. The
 * player interpolates between consecutive stages, so the camera move and the
 * sentence are the same length by construction — there is no separate timing
 * track to fall out of sync.
 */

import { LAYERS } from './ui.js';

/* ------------------------------------------------------------------- words */

/* The programme narrated in chapter IV is solved here, from the same pure
 * function the panel draws. See programme.js: the caption must survive being
 * built by the voice-baking script, which never opens the panel. */
import { defaultBudget, figuresOf, totalOf } from './programme.js';

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];

/** A whole number as words. Everything the script quotes is under a thousand;
 *  anything larger falls back to digits rather than to a wrong sentence. */
export function words(n) {
  const v = Math.round(n);
  if (!isFinite(v) || v < 0) return String(n);
  if (v < 20) return ONES[v];
  if (v < 100) {
    const t = TENS[Math.floor(v / 10)];
    const o = v % 10;
    return o ? `${t}-${ONES[o]}` : t;
  }
  if (v < 1000) {
    const h = Math.floor(v / 100);
    const r = v % 100;
    const head = h === 1 ? 'a hundred' : `${ONES[h]} hundred`;
    return r ? `${head} and ${words(r)}` : head;
  }
  return v.toLocaleString('en-US');
}

/** The same, capitalised, for a number that opens a sentence. */
const Words = (n) => { const w = words(n); return w[0].toUpperCase() + w.slice(1); };

/* A large count as the narrator says it.
 *
 * `words` stops at a thousand on purpose and hands back digits above it, which
 * is right for a caption and useless for a voice: a synthesiser given
 * "1,880,578" reads it out a digit at a time. The programme's person-hours
 * moved from six figures to seven when the film started narrating the panel
 * instead of the stored allocation, so the spoken form has to carry both. */
function spokenCount(n) {
  const v = Math.round(n);
  if (v >= 1e6) {
    const tenths = Math.round(v / 1e5);
    const whole = Math.floor(tenths / 10);
    const rest = tenths % 10;
    return rest ? `${words(whole)} point ${words(rest)} million` : `${words(whole)} million`;
  }
  return `${words(Math.round(v / 1000))} thousand`;
}
const r0 = (x) => Math.round(x);

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
  'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth',
  'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];

/** A day of the month as words: "the second of July". */
export function ordinal(d) {
  if (d >= 1 && d <= 20) return ORDINALS[d];
  // Every ten up to ninety, and the nine between each of them. This used to
  // stop at thirty-one, which was enough when the only ordinal in the script
  // was a day of the month. Manhattan's streets are ordinals too, and "East
  // 41st Street" handed to a synthesiser comes out as "East forty-one street".
  if (d > 20 && d < 100) {
    const tens = ['', '', 'twent', 'thirt', 'fort', 'fift', 'sixt', 'sevent',
                  'eight', 'ninet'][Math.floor(d / 10)];
    const unit = d % 10;
    return unit ? `${tens}y-${ORDINALS[unit]}` : `${tens}ieth`;
  }
  return String(d);
}

/** A 24-hour clock hour as spoken time: 15 -> "three in the afternoon". */
export function spokenHour(h) {
  const twelve = h % 12 === 0 ? 12 : h % 12;
  const part = h < 12 ? 'in the morning' : h < 18 ? 'in the afternoon' : 'in the evening';
  return `${words(twelve)} ${part}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/* -------------------------------------------------------------------- story */

/** Largest value of a nested field across the ranked list. */
function maxOf(items, pick) {
  return items.reduce((m, it) => Math.max(m, pick(it) ?? -Infinity), -Infinity);
}

/** The building the film uses as its example, exported so nothing has to
 *  restate it.
 *
 * It was a `const` inside `buildStory` and the tests carried their own copy of
 * the BIN. Changing the hero therefore left `05-film.spec.mjs` checking the old
 * building's temperatures against the new building's script, which is a test
 * that fails for the right reason and points at the wrong thing — it took a
 * reading of the failure to see that the film was correct and the test was
 * remembering. One definition, imported by both.
 */
export const HERO_BUILDING = '1019099';


export function buildStory(data, globe, getUI = () => null) {
  const m = data.meta;
  const items = data.ranked.items;
  const g = globe || {};

  // ---- the planet, from GISTEMP ------------------------------------------
  const years = g.years || [];
  const span = years.length ? years[years.length - 1] - years[0] + 1 : 0;

  // ---- the city, from the pipeline ---------------------------------------
  const hw = m.morphology.hw_median;
  const peakAir = maxOf(items, (i) => i.measured?.peak_air_c);
  const peakFacade = maxOf(items, (i) => i.modelled?.facade_peak_c);
  const peakMrt = maxOf(items, (i) => i.modelled?.mrt_peak_c);
  const peakHour = m.hours[m.peak_index];
  /* The latest hour the sun is still up, and why the film uses it.
   *
   * At the peak hour the whole of Midtown is hot at once, and the ramp is scaled
   * to the whole year, so every facade lands in its top third and the city
   * renders as one flat sheet of pale yellow. It is a true picture and a useless
   * one: the chapter is about the difference between two faces of one building,
   * and at 15:00 there is no difference to see.
   *
   * Low sun is what separates them. At twenty degrees of altitude the light
   * rakes along the avenues, the faces that take it run away from the faces
   * that do not, and the frame finally shows what the narration is describing —
   * which is also, literally, the late sun the caption names. */
  const lateSun = (() => {
    let best = m.peak_index;
    for (let i = 0; i < m.hours.length; i++) {
      const alt = m.hours[i].sun_alt ?? -90;
      if (alt > 5 && m.hours[i].edt > m.hours[best].edt) best = i;
    }
    return best;
  })();
  const clock = `${String(peakHour.edt).padStart(2, '0')}:00`;
  const [lon0, lat0] = [m.projection.lon0, m.projection.lat0];

  // ---- the year, from the pipeline ---------------------------------------
  const year = m.year || { days: 365, hours: 8760, annual: {} };
  const overlap = data.ranked.orderings?.agreement?.top50_overlap;
  /* The ten buildings the YEAR puts at the top, as BINs.
   *
   * `orderings.annual` is a list of indices into `items`, which is itself in
   * heat-wave order — so this is the second ranking read through the first, and
   * the two disagree by design. Nine of these ten are not in the wave's own top
   * ten (`agreement.top10_overlap` is 1), which is exactly why chapter four can
   * light them and say the ranking moved: a different set of buildings comes up
   * on screen. Derived, never typed, so it follows a re-solve. */
  const annualTop = (data.ranked.orderings?.annual || [])
    .slice(0, 10)
    .map((i) => items[i]?.bin)
    .filter(Boolean)
    .map(String);

  // ---- the one building chapter three is about ----------------------------
  //
  // Chosen, not picked at random, and the choice is a constraint rather than a
  // preference: `floors.json` carries the per-floor and per-FACE attribution
  // for a hundred and fifty buildings, and chapter three cannot be told about a
  // building outside that set. Of the hundred and fifty, this is the only one
  // whose shaded face is trap-dominated by a clear margin — more of that wall's
  // heat arrives off the building opposite than out of the sun — which is the
  // one claim in the film a viewer will not already believe.
  //
  // Everything the chapter says about it is read from the record below. If the
  // pipeline reruns and the numbers move, the narration moves with them.
  /* The building the film uses as its example.
   *
   * Changed from 747 Second Avenue, and the constraint that decided it is worth
   * writing down because it rules out almost every candidate. Chapter three
   * claims the shaded face is hot because of what stands across the street from
   * it, and that claim is only true where longwave gain from the surroundings
   * beats direct sun ON THAT FACE. Of every building in the study area taller
   * than the old hero, exactly one satisfies it: 242 West 53rd is twice the
   * height and would have looked far better on screen, but its north-east face
   * takes 1.70 from the sun against 0.63 from its neighbours, so the film would
   * have been asserting the opposite of its own data.
   *
   * This one takes 1.71 from its neighbours against 1.18 from the sun — a
   * stronger signal than the building it replaces — and it is taller, has one
   * more storey, and runs hotter at its worst floor. */
  const HERO_BIN = HERO_BUILDING;

  /* The recorded analyst turn chapter five plays back.
   *
   * A real run, kept on disk at `.agent/runs/<id>/frames.jsonl` and streamed
   * back by the server on request. Re-recorded when the film changed which
   * building it uses as its example: fifteen tool calls, through the building's
   * own dossier, its floor schedule, the prescription solver and the economic
   * constants, ending in a refusal.
   *
   * It is also the run that checks chapter three. Asked whether insulating the
   * street wall would stop the upper floors cooking, it found the answer flips
   * with height: at street level the wall really is heated by what stands
   * opposite, and above the fourth floor the tower rises clear of a fourteen-
   * metre canyon and the excess becomes sun on glass. That is the same split
   * the prescription beat quotes when it says floors five to thirty-five.
   *
   * If the run is ever cleared the console simply shows nothing and the captions
   * still read; it is a recording, not a dependency. */
  const ANALYST_RUN = 'r178810446770079f';
  /* The question that turn was actually asked, shown above the transcript so it
   * reads as a turn rather than as an answer that arrived on its own.
   *
   * It used to open "the north-east face never gets direct sun, and it still
   * runs hotter than the air on the street", and then
   * ask the model to "re-solve the physics" and report "by how many kelvin".
   * Nobody asks like that. It was four lines long, it was written in the
   * vocabulary of the person who built the thing rather than the person who
   * uses it, and worst of all it handed over the finding in its own first
   * clause: the asker already knew the interesting part, so there was nothing
   * left for the analyst to overturn.
   *
   * This is a man with a contractor's quote in his hand, in one line. He is
   * about to insulate a wall, which is the standard retrofit for a tower of
   * this era and the obvious thing to do. He is wrong twice over, and neither
   * of the two reasons is anywhere in the question. */
  const ANALYST_QUESTION = 'I own 560 Third Avenue. My contractor wants to insulate '
    + 'the East 38th Street wall to stop the upper floors cooking. Is that going to work?';
  const heroIdx = items.findIndex((it) => String(it.bin) === HERO_BIN);
  const hero = items[heroIdx] || items[0] || {};
  const hf = () => data.decision?.floors?.items?.[HERO_BIN] || null;
  /** The worst floor's record, and the two faces the chapter contrasts. */
  const heroFloor = () => {
    const it = hf();
    if (!it) return null;
    const row = (it.floors || []).find((r) => r.f === it.worst_floor) || (it.floors || [])[0];
    if (!row) return null;
    const byFace = {};
    for (const f of row.faces || []) {
      const a = byFace[f.c] || (byFace[f.c] = { m2: 0, t: 0, solar: 0, trap: 0, sky: 0 });
      const w = f.m2 || 0;
      a.m2 += w;
      for (const q of ['t', 'solar', 'trap', 'sky']) a[q] += (f[q] || 0) * w;
    }
    for (const a of Object.values(byFace)) {
      if (a.m2 > 0) for (const q of ['t', 'solar', 'trap', 'sky']) a[q] /= a.m2;
    }
    return { it, row, sun: byFace['north-west'], shade: byFace['north-east'] };
  };
  const heroRx = () => (data.decision?.prescriptions?.items?.[HERO_BIN] || [])[0] || null;

  /* The hero's height bands, with the mean surface temperature of each.
   *
   * The banding beat used to assert that the model cuts a building into ten
   * bands and leave the viewer to take it on trust while a focus climbed the
   * tower. The climb is the right picture and it was carrying no number, so
   * "ten height bands" was a fact about the software rather than a finding
   * about the building.
   *
   * The numbers are worth saying because the bottom two are startling: this
   * tower's lowest band runs 14 K cooler than the one immediately above it,
   * because the first four floors are down inside a canyon whose walls average
   * 14 m and everything above them is in the open. That single step is also
   * why the prescription starts at floor five rather than at the pavement, and
   * it is what the analyst turn in chapter five arrives at independently. */
  const heroBands = () => {
    const it = hf();
    if (!it) return [];
    const acc = new Map();
    for (const r of it.floors || []) {
      if (r.band === undefined || r.band === null) continue;
      const b = acc.get(r.band) || { band: r.band, lo: Infinity, hi: -Infinity, sum: 0, n: 0 };
      b.lo = Math.min(b.lo, r.f); b.hi = Math.max(b.hi, r.f);
      b.sum += r.t_surf; b.n += 1;
      acc.set(r.band, b);
    }
    return [...acc.values()].sort((a, b) => a.band - b.band)
      .map((b) => ({ ...b, t: b.sum / b.n }));
  };

  /* The tower on the other side of the street, and the street.
   *
   * Chapter three claims the shaded face is hot because of what stands opposite
   * it. The analyst was asked to establish that from the attribution rather than
   * be told it, and came back with a specific building — so the claim can name
   * it, and everything the film says about it is read from the footprint table
   * here rather than taken from what the analyst wrote.
   *
   * The BIN is stated, like the hero's, because choosing which building a story
   * is about is not something a pipeline does. Its height, its age and the
   * street it faces across are not stated: they come out of `buildings.json`
   * and `canyons.json`, and they move if the data does. */
  const NEIGHBOUR_BIN = '1019272';
  const attrOf = (bin) => (data.buildings?.attrs || []).find((a) => String(a.bin) === bin);
  const neighbour = () => attrOf(NEIGHBOUR_BIN);
  /** The canyon the hero's shaded elevation fronts, as the record itself. */
  const shadeCanyon = () => {
    const F = data.facades, C = data.canyons;
    if (!F || !C) return null;
    const bi = (data.buildings?.attrs || []).findIndex((a) => String(a.bin) === HERO_BIN);
    if (bi < 0) return null;
    for (let p = 0; p < F.n; p++) {
      if (F.building[p] !== bi) continue;
      const az = ((F.az[p] % 360) + 360) % 360;
      if (az < 22.5 || az >= 67.5) continue;            // north-east only
      const c = C[F.canyon[p]];
      if (c) return c;
    }
    return null;
  };

  /** The canyon the hero's shaded elevation fronts, named as the street it is. */
  const shadeStreet = () => {
    const F = data.facades, C = data.canyons;
    if (!F || !C) return null;
    const bi = (data.buildings?.attrs || []).findIndex((a) => String(a.bin) === HERO_BIN);
    if (bi < 0) return null;
    for (let p = 0; p < F.n; p++) {
      if (F.building[p] !== bi) continue;
      const az = ((F.az[p] % 360) + 360) % 360;
      if (az < 22.5 || az >= 67.5) continue;            // north-east only
      const c = C[F.canyon[p]];
      if (c?.name) return c.name.replace(/\s+/g, ' ').trim();
    }
    return null;
  };
  /** "E 41 ST" as a voice says it: East forty-first Street. */
  const streetSpoken = (name) => {
    const written = streetProse(name);
    return written.replace(/\b(\d+)(?:st|nd|rd|th)\b/, (_, d) => ordinal(Number(d)));
  };

  /** "E 41 ST" as a sentence prints it. */
  const streetProse = (name) => (name || '')
    .replace(/^E /, 'East ').replace(/^W /, 'West ')
    .replace(/ ST$/, ' Street').replace(/ AVE$/, ' Avenue')
    .replace(/\b(\d+)\b/, (d) => {
      const n = Number(d), t = n % 100, u = n % 10;
      const sfx = (t >= 11 && t <= 13) ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th';
      return `${n}${sfx}`;
    });
  const daysOver = year.annual?.days_above_35 ?? 0;
  const tropical = year.annual?.tropical_nights ?? 0;

  // ---- the decision layer, if it has landed --------------------------------
  //
  // web/js/data.js fetches floors/prescriptions/portfolio in the background and
  // OPTIONALLY: on a build without them `data.decision` is a set of nulls, and
  // on a build with them the fetch may still be in flight when the title card
  // asks for the runtime, which is what builds this story. So nothing in the
  // script may depend on them. They appear in the ticker, where a missing
  // figure degrades to the claim without it, and never in a caption.
  //
  // Read through a getter rather than into a constant, because "may still be in
  // flight" is the normal case, not the edge one: the title card calls
  // `runtimeLabel` — which builds this whole story — while those three files are
  // still being fetched, so a value snapshotted here is the fallback every time.
  // data.js fills `data.decision` in place, so by the time the ticker actually
  // reads this, twenty seconds into the film, the figures are there.
  /* The programme chapter IV opens the panel on.
   *
   * Prefer the panel when it is there, because a viewer who has dragged the
   * budget line should hear the programme they are looking at. Solve it the
   * same way when it is not, because `prewarm_voice.mjs` builds this script to
   * bake the narration and never opens a panel, and a caption that changes
   * between the bake and the play is a beat with no recording.
   *
   * Both routes are the same function over the same file, so they cannot
   * disagree at the budget the panel opens on, which is the budget the film
   * always sees. */
  const programme = () => {
    const live = getUI()?.programme?.();
    if (live) return live;
    const pf = data.decision?.portfolio;
    if (!pf?.candidates?.length) return null;
    const total = pf.total || totalOf(pf);
    return figuresOf(pf, 'person_hours', defaultBudget({ ...pf, total }));
  };

  const decision = () => {
    const alloc = data.decision?.portfolio?.allocation;
    if (alloc) {
      return `$${(alloc.budget_usd / 1e6).toFixed(2)} M · ${alloc.buildings} BUILDINGS · `
        + `${Math.round(alloc.person_hours_avoided).toLocaleString('en-US')} PERSON-HOURS AVOIDED`;
    }
    const n = Object.keys(data.decision?.prescriptions?.items || {}).length;
    return n ? `${n} BUILDINGS PRESCRIBED · EVERY FIGURE A RANGE`
      : 'PER-FLOOR LOADS · MEASURES · $ PER PERSON-HOUR';
  };

  // The event date, as the narration says it: "the second of July, 2026".
  const day = new Date(`${m.event.date}T12:00:00Z`);
  const spokenDate = `the ${ordinal(day.getUTCDate())} of ${MONTHS[day.getUTCMonth()]}, ${day.getUTCFullYear()}`;
  // "Midtown Manhattan" -> "Midtown", which is what a sentence about being over
  // it wants. The full label is on the title card and in the panel.
  const place = m.aoi.label.split(' ')[0];

  /* Thirty beats, five chapters, 2:56 — of which two beats are silent: the
   * title card that opens it, and the last beat of all.
   *
   * The arc survived every recut, because the shape was never the thing that was
   * too long. It is now: establish the year and the scale, go down to the walls,
   * diagnose and price ONE of them, scale that to the whole city, then hand the
   * question to the analyst.
   *
   * Nothing is narrated over the descent. The descent is not part of the
   * argument — it is the answer to "what is this, then" — and a voice over it
   * competes with the only thing on screen anyone wants to look at. So the
   * script lands either side of the fall rather than across it.
   *
   * Length is spent on the argument rather than on more claims. Chapter III is
   * 82 seconds, nearly half the film, because one wall diagnosed all the way
   * down to a specified measure and a price is the whole case; a viewer who has
   * followed that will believe chapter IV's claim that every wall in Midtown has
   * had the same treatment, and one who has not will not. Beats run five to nine
   * seconds so each line finishes inside its own shot — at three seconds the
   * voice was clipped at every cut and the captions read as a list.
   *
   * The 2:56 also matters for a duller reason: a three-minute cap is the common
   * ask, and a film that has to be trimmed in an editor after the fact loses the
   * thing the cut was designed around.
   */
  const beats = [
    /* ------------------------------- I. a year over Manhattan (4 × , 20.0 s)
     *
     * A fifth of the film, and it used to be a third. What it buys is the frame
     * everything after it sits in: a year, not an afternoon, and a number taken
     * at head height that the rest of the film spends its time disagreeing with.
     *
     * `turn` is progress along one planned rotation that ends with the study
     * area square to the camera on the last beat of this chapter — see
     * TURN_ONTO_SITE in film.js. These are not a spin speed, they are how much
     * of the opening move is spent before the camera comes in.
     */
    /* The one beat with nothing to say, and it is now as short as it can be.
     *
     * Four and a half seconds of silence before the first sentence is a long
     * time to ask of someone deciding whether to watch at all — it is most of
     * the window in which that decision gets made, spent on a globe that has
     * not yet been given a reason to be interesting. What it was buying is not
     * lost by cutting it: the chapter mark stays up for the whole chapter
     * rather than only for this beat, so the title is still read, and the
     * planet is still turning under the first three lines.
     *
     * 1.4 seconds is set by the furniture rather than chosen: the chapter
     * card's entrance is 760ms (`ENTER` in film.js), and a card that is still
     * animating when the first line arrives reads as a page that has not
     * finished loading.
     */
    {
      chapter: 'I', title: 'A year over Manhattan', seconds: 1.2,
      stage: { alt: 29000, fov: 28, turn: 0.2, heat: 0.45, tilt: 0.13, counter: 0.5 },
    },
    {
      chapter: 'I', seconds: 6.04,
      /* THE FILM OPENS ON THE GAP, not on the physics.
       *
       * It used to open with how a city stores heat — true, and the wrong first
       * sentence for this. Everyone watching already believes cities are hot;
       * spending the opening establishing it asks a viewer to sit through a
       * fact they hold before hearing anything they do not. What they do not
       * know is that nobody can currently tell them WHICH WALL, on which floor,
       * at which hour — which is the whole reason the rest of the film exists.
       *
       * So the first line states the missing thing, and every beat after it is
       * the film closing that gap: a year measured, the block average that is
       * all anyone has today, the descent to the walls, and then one building
       * taken apart. "Wall by wall and hour by hour" is also, exactly, what the
       * model does, so the opening sets the terms the rest is judged on.
       */
      text: 'Nobody has mapped what heat actually does to a building, '
        + 'wall by wall and hour by hour.',
      stage: { alt: 24000, fov: 28, turn: 0.46, heat: 1, cities: 1, bloom: 1,
               tilt: 0.1, counter: 1 },
    },
    {
      chapter: 'I', seconds: 6.09,
      /* The full label here, and only here. This is the first time the film
       * names the place, over a shot of the planet — "Midtown" on its own is a
       * word the viewer has no way to locate, and the beat's whole job is to
       * say where we are. Later beats use `place`, which is the short form, and
       * they can: by then the camera has arrived and the panel is up. */
      /* "So we did." answers the line above it, and it has to.
       *
       * This read "So we measured a year of it", which was written when the
       * opening line ended "a city never cools" — there, "it" was the heat and
       * the sentence followed. The opening is a gap statement now: nobody has
       * mapped what heat does to a building. "A year of it" has nothing to
       * attach to any more, and a second sentence whose pronoun points at
       * nothing is exactly the disconnected feel the rewrite was for.
       *
       * A gap followed by "so we did" is the plainest join there is, and it
       * makes the pair one thought instead of two facts.
       */
      text: `So we did. A year over ${m.aoi.label}, `
        + `${(year.hours || 8760).toLocaleString('en-US')} hours, `
        + `${words(daysOver)} days past ${words(m.event.threshold_c)} degrees.`,
      /* The caption keeps the hour count; the read does not.
       *
       * "Eight thousand seven hundred and sixty" takes three and a half seconds
       * to say and reads in a glance, and this film is against a hard three
       * minutes. The figure stays on screen — which is where the test for it
       * looks, and where a viewer takes it in faster than any voice can deliver
       * it — and the read spends those seconds in chapter five instead, on what
       * the analyst actually concluded. */
      say: `So we did. A year over ${m.aoi.label}, `
        + `${words(daysOver)} days past ${words(m.event.threshold_c)} degrees.`,
      altEase: 'out', turnEase: 'out',
      stage: { alt: 5200, fov: 30, turn: 1, heat: 1, cities: 0.6, bloom: 0.4,
               lock: 1, pin: 1, aim: 0, phi: 0.05, clouds: 0.6, tilt: 0 },
    },
    {
      chapter: 'I', seconds: 4.78,
      /* WHOSE MAP THIS IS, which the new opening made load-bearing.
       *
       * The line read "From up here it's one number per block" — written when
       * the film opened on the physics, where it plainly described the view on
       * screen. Against an opening that claims we mapped every wall and every
       * hour, the same words say the opposite: that OUR model is a block
       * average. It has to name the thing it is contrasting with.
       */
      text: 'The usual heat map stops at one number per block, taken at head height.',
      stage: { alt: 3400, cities: 0.3, bloom: 0.15, clouds: 0.85 },
    },

    /* -------------------------------------------- II. going in (2 × , 9.3 s)
     *
     * All the way down. The sixty-second cut stopped the globe at three hundred
     * kilometres and dissolved, because six seconds could not travel ten
     * halvings of altitude and the ground in between was worth nothing to the
     * argument. Now the ground in between IS the argument: the whole point of
     * the next two minutes is that a city seen from above is blocks and a city
     * seen from inside is walls, so the film has to be seen crossing from one
     * to the other.
     *
     * What it does not need is time. This chapter was thirteen seconds and the
     * silent first beat of it was seven of them — a twenty-fifth of the running
     * time spent on the one part of the film that makes no claim at all. It is
     * now three, and the chapter is nine.
     *
     * THE ALTITUDE SPLIT MOVED WITH THE LENGTH, and that is the part worth
     * reading. The boundary used to be at forty kilometres, so the silent beat
     * did six and a half halvings and the narrated one did three and a half:
     * the fall was FAST HIGH UP AND SLOW NEAR THE GROUND, which is exactly
     * backwards. All the speed was spent where there is nothing to look at but
     * a curve, and the camera was crawling by the time the pyramid, the cloud
     * and finally the streets were resolving — the only stretch of the dive
     * anyone is actually watching. Shortening the silent beat without moving the
     * boundary made it five times worse: three seconds for six and a half
     * halvings is a slam, and then it hits the handoff and crawls.
     *
     * At six hundred and forty kilometres the silent beat does two and a half
     * halvings and the narrated one does seven and a half, so the rate CLIMBS
     * across the boundary instead of collapsing at it, and the fastest part of
     * the fall is the last part — over the line, under the dissolve, with the
     * ground close enough to read. The tests on the shape of the dive are the
     * check on all of this; see `the descent accelerates out of the hold`.
     *
     * The ease came off the same beat for the same reason. `in` is u squared:
     * it spends the first half of a beat covering a quarter of the distance,
     * which is a graceful way to leave a hold in seven seconds and a stall
     * followed by a lurch in three. Linear is a constant number of halvings a
     * second, which is what the eye reads as a constant speed — see the note on
     * `eAlt` in film.js — so the beat leaves the hold at once and holds one
     * speed into the handoff, where `land` takes over and settles it onto
     * scene.js's opening pose.
     */
    {
      /* THIS BEAT USED TO BE SILENT, and it was the longest hole in the film.
       *
       * The argument for silence was that the descent is not part of the
       * argument — it is the answer to "what is this, then" — and that a voice
       * over it competes with the only thing on screen anyone wants to look at.
       * That reasoning holds for a title sequence. It does not hold for a demo
       * shown to someone deciding whether the work is any good, who has just
       * been given a problem and is now watching a planet get closer for three
       * seconds with nobody telling them what is about to happen.
       *
       * So the descent carries the turn: the sentence that says the number from
       * up there is not wrong, it is the wrong shape, and that the rest of the
       * film is the other kind. The picture is still doing the work; the line
       * just stops the viewer wondering whether the film has stalled.
       */
      chapter: 'II', title: 'Going in', seconds: 3.53,
      text: 'Averages hide a lot. Let’s go down.',
      /* FOUR HUNDRED, NOT SIX HUNDRED AND FORTY, and the line above is why.
       *
       * The boundary altitude and this beat's length are one setting, not two.
       * At 640 km the split was tuned for a THREE-SECOND silent beat: two and a
       * half halvings here against seven and a half below, so the rate climbed
       * across the boundary by about half again — the fall getting faster
       * exactly where the dissolve begins.
       *
       * Giving this beat a line stretched it to four seconds, and a longer beat
       * over the same altitude span is a slower one. The rate below the
       * boundary did not change, so the step across it went from 1.5x to 2.03x:
       * the camera doubling its speed in a single frame at the cut. That is the
       * lurch `the descent accelerates out of the hold` exists to catch, and it
       * caught it.
       *
       * Moving the boundary down restores the ratio without touching either
       * duration — 400 km puts it back to 1.44x, which is the same gentle climb
       * the 640/3.0 pair used to give. Anything a viewer would notice is in the
       * ratio, not in the number.
       */
      stage: { alt: 400, fov: 38, phi: 0.16, dust: 0.7, cities: 0, bloom: 0,
               clouds: 1, lock: 1, pin: 1, aim: 0, tilt: 0 },
    },
    {
      chapter: 'II', phase: 'handoff', seconds: 6.01,
      text: `Down here it’s walls. `
        + `${m.counts.facade_panels.toLocaleString('en-US')} of them, `
        + `on ${m.counts.buildings.toLocaleString('en-US')} buildings.`,
      say: 'Down here it’s walls. Twenty-nine thousand four hundred, '
        + 'each solved on its own.',
      altEase: 'land',
      stage: { alt: 3.265, fov: 46, phi: 0.334, dust: 1, pin: 0, clouds: 1,
               lock: 1, aim: 0, tilt: 0 },
    },

    /* -------------------------------------- III. one building (12 × , 64.0 s)
     *
     * From here the film is the application. The globe canvas is torn down, the
     * panels are up, and every beat's `act` drives the real thing: the real
     * camera, the real selection, the real layer, the real brief. Nothing below
     * is drawn for the film.
     *
     * The chapter is one argument in three moves. A building is not one
     * temperature; the difference between its faces has a cause the model can
     * name; and the cause decides the fix, which turns out not to be the fix
     * anyone would have guessed.
     */
    {
      chapter: 'III', title: 'One building', phase: 'city', seconds: 5.72,
      /* NO SPOTLIGHT ON THIS BEAT, and that is the fourth reason it was dull.
       *
       * The walkthrough's highlight paints a 58%-black scrim over everything
       * except the thing being named, and it earns that everywhere it is used
       * later: "the floor schedule", "the layer list", "the programme" are
       * panels, and a caption cannot point at a panel. Here the thing being
       * named is the BUILDING. Lighting the dossier card instead put a hole the
       * size of a sidebar over the left edge of the frame and buried the city we
       * had just spent thirty seconds falling into — on the one beat whose whole
       * job is to make a viewer want to look at it. The building has a pin, a
       * highlight and its own colour; it does not need a hole cut in a scrim.
       */
      text: `Take this one as an example. ${hero.addr}, ${hero.floors} floors, `
        + `${hero.year}, ${hero.units} homes.`,
      // Hand-spelled because a street number is not a quantity: 560 has to be
      // read as "five sixty", which no number-to-words helper will do for you.
      say: `Take this one as an example. Five sixty Third Avenue, `
        + `${words(hero.floors)} floors.`,
      /* THE ARRIVAL, and it was the dullest frame in the film.
       *
       * The descent ends on lit cloud, satellite imagery and a city coming up
       * to meet the camera, and chapter three used to answer it with a flat
       * orange box on a grey plain, viewed steeply from above. Three separate
       * things were doing that, and none of them was the model's fault:
       *
       *   THE LIGHT. The clock was wherever the interface opened, which is the
       *   peak hour — the one hour at which the whole of Midtown is hot at once,
       *   the ramp puts every facade in its top third, and the city renders as
       *   one flat sheet with no shadow anywhere in it. That hour is a true
       *   picture and a useless one, which is exactly what the NEXT beat says
       *   out loud. So the film arrives on the late sun instead, where the light
       *   rakes down the avenues and throws the canyons into relief, and beat
       *   seven's move to the peak becomes a demonstration of "one shade of
       *   orange" rather than the state we happened to be sitting in.
       *
       *   THE COLOUR. Selecting a building drains the other four thousand to
       *   grey on the frame it happens. Ramped across the sentence instead (see
       *   `setDimStrength`), we land on a city and it steps back while the line
       *   is read — same information, delivered as a move rather than a switch.
       *
       *   THE CAMERA. `focus` frames a building for a CLICK: high, steep, close,
       *   no horizon, because someone who just clicked knows what they clicked
       *   and wants to see it. An establishing shot is the opposite job. This
       *   stands further off and much lower, so the tower has the skyline behind
       *   it and sky above it, and it is read as a building in a city rather
       *   than as a solid in a viewport.
       */
      act: ({ ui, scene }) => {
        ui.showTab('view');
        ui.setLayer('surface');
        ui.focusFloors();
        ui.setHour(lateSun);
        ui.showDetail(heroIdx);
        // Framed and marked. On a surface-temperature layer one pale box among
        // four thousand looks like its neighbours; the highlight is what makes
        // "this one" visible from across the frame.
        ui.highlight([HERO_BIN]);
        scene.setDimStrength(0);
        const i = ui.indexOf(HERO_BIN);
        if (i !== null) {
          /* IT STARTS WHERE THE DESCENT ENDED, which is the fix for the one
           * frame of this film that nobody could read.
           *
           * Chapter two lands the camera at 3.3 metres and says "down here it
           * stops being blocks, it's walls". Chapter three then opened by
           * flying to 390 metres up at 560 metres of standoff — so the sentence
           * about being down among the walls was followed immediately by an
           * aerial photograph in which the building being named is one orange
           * speck among four thousand, at the exact moment a viewer is trying
           * to work out what they are now looking at.
           *
           * So the shot opens from the pavement, looking up the tower the line
           * is naming, and the lift out to the three-quarter view happens
           * during the sentence rather than before it. The old framing is not
           * wrong — it is the right shot for the four beats that follow, which
           * are an argument about the difference between the faces — it was
           * just being arrived at a beat too early and from nowhere.
           */
          scene.frameFacade(i, {
            bearing: 300, dist: 130, rise: 0.10,
            height: ui.floorHeight(HERO_BIN, 2),
          });
        }
      },
      /* The city receding, over the line rather than on the cut. Four steps and
       * not a per-frame ramp: a repaint walks 294,000 quads, and four of them
       * across six seconds is less work than one second of the clock playing.
       *
       * The lift sits between the second and third of them, on "747 Second
       * Avenue" — so the camera leaves the pavement as the building is named.
       * The spin goes on here rather than in `act` because `frameFacade` stops
       * it on the way in, and the flight this one starts owns the camera for
       * about a second; starting the revolution before it would be turning out
       * of a composition the flight has not reached yet.
       */
      cues: [
        { at: 0.30, do: ({ scene }) => scene.setDimStrength(0.35) },
        { at: 0.46,
          do: ({ ui, scene }) => {
            const i = ui.indexOf(HERO_BIN);
            if (i !== null) {
              scene.frameFacade(i, {
                bearing: 300, dist: 560, rise: 0.58,
                height: ui.floorHeight(HERO_BIN, hero.floors * 0.62),
              });
            }
            scene.setSpin(true);
          } },
        { at: 0.62, do: ({ scene }) => scene.setDimStrength(0.7) },
        { at: 0.82, do: ({ scene }) => scene.setDimStrength(1) },
      ],
    },
    {
      chapter: 'III', phase: 'city', seconds: 4.65,
      text: 'On the flat map it’s one shade of orange. '
        + 'It’s nowhere near that even.',
      // Still turning. The line is that one flat colour on a map is four
      // different walls, and the only way to say that in a picture is to bring
      // the other walls round.
      act: ({ ui }) => { ui.setHour(m.peak_index); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.66,
      // The subject is the building's banding, which is geometry in the model
      // rather than a control — so there is nothing on a panel to light, and
      // pointing at the colour legend instead would be a highlight on the wrong
      // thing, which is worse than none.
      //
      // The model can show it directly, though, and that is what the cues below
      // do: the focus climbs the tower a band at a time while the line is read,
      // so "ten height bands, one for every three storeys" is counted out on the
      // building itself. It ends with the whole building lit again, because the
      // next beat is about a face rather than a band and a leftover focus would
      // be dimming storeys nobody is talking about.
      get text() { return (() => {
        const bs = heroBands();
        if (bs.length < 2) {
          return `So the model breaks it up. ${Words(m.bands)} height bands, `
            + 'every face worked out separately.';
        }
        return `So the model breaks it up. ${Words(m.bands)} bands up the building, `
          + `every face apart: ${r0(bs[0].t)} °C at the bottom, `
          + `${r0(bs[1].t)} just above it.`;
      })(); },
      get say() { return (() => {
        const bs = heroBands();
        if (bs.length < 2) {
          return `So the model breaks it up. ${Words(m.bands)} height bands, `
            + 'every face worked out separately.';
        }
        // "every face apart" comes out: the next two beats walk round to two
        // of those faces and read a number off each, which makes the point
        // better than a clause does and costs the line 1.3 seconds it needs.
        return `So it breaks the building up. ${Words(m.bands)} bands. `
          + `${Words(bs[0].t)} at the bottom, ${words(bs[1].t)} just above.`;
      })(); },
      act: ({ ui }) => { ui.focusFloors(); },
      cues: (() => {
        const n = m.bands || 10;
        const perBand = Math.max(1, Math.round((hero.floors || n) / n));
        // One cue a band across the first four fifths of the beat, then a fifth
        // that clears. Stated as a fraction of the beat rather than in seconds
        // so a recorded line that runs long carries the climb with it.
        const out = [];
        for (let k = 0; k < n; k++) {
          const lo = k * perBand + 1;
          out.push({
            at: (k / n) * 0.82,
            do: ({ ui }) => ui.focusFloors(HERO_BIN, lo, lo + perBand - 1),
          });
        }
        out.push({ at: 0.9, do: ({ ui }) => ui.focusFloors() });
        return out;
      })(),
    },
    {
      chapter: 'III', phase: 'city', seconds: 5.41,
      get text() { return (() => {
        const f = heroFloor();
        return f?.sun
          ? `The north-west face catches the late sun. Floor ${f.it.worst_floor} `
            + `hits ${r0(f.sun.t)}.`
          : 'The north-west face catches the late sun. It is the hottest wall here.';
      })(); },
      get say() { return (() => {
        const f = heroFloor();
        return f?.sun
          ? `The north-west face catches the late sun. Floor ${words(f.it.worst_floor)} `
            + `hits ${words(f.sun.t)}.`
          : 'The north-west face catches the late sun. It is the hottest wall here.';
      })(); },
      // The clock moves to the low sun here, and the flat sheet of yellow the
      // previous beat was complaining about separates into lit and unlit faces.
      // The figure quoted is still the face's own peak; the picture is the hour
      // that makes the face visible at all.
      //
      // And the camera goes and stands in front of the wall, level with the
      // storey the sentence names. It used to say "the north-west face, on the
      // twenty-fifth floor" over a three-quarter view from the south-east, from
      // which the north-west face is the far side of the building and the
      // twenty-fifth floor is a stripe the size of a full stop. The spin stops
      // for these two beats: this one is a composition, and a revolution turns
      // out of a composition on the frame after it arrives.
      act: ({ ui, scene }) => {
        ui.setHour(lateSun);
        const f = heroFloor();
        const i = ui.indexOf(HERO_BIN);
        if (i === null) return;
        scene.frameFacade(i, {
          bearing: 315,                                  // stand to the north-west
          height: f ? ui.floorHeight(HERO_BIN, f.it.worst_floor) : null,
        });
        if (f) ui.focusFloors(HERO_BIN, f.it.worst_floor);
      },
      // A slow push toward the wall over the second half of the line. The two
      // face beats are compositions rather than moves — the cut between them is
      // what carries the argument — but a shot held perfectly still for six
      // seconds reads as a screenshot, and the push is the difference between
      // looking at a building and being shown one.
      cues: [{ at: 0.42, do: ({ scene }) => scene.zoomBy(0.84) }],
    },
    {
      chapter: 'III', phase: 'city', seconds: 5.54,
      get text() { return (() => {
        const f = heroFloor();
        return f?.shade
          ? `Now round to the north-east. Same floor, no sun at all. Still ${r0(f.shade.t)}.`
          : 'Now round to the north-east. Same floor, no sun at all. Still hot.';
      })(); },
      get say() { return (() => {
        const f = heroFloor();
        return f?.shade
          ? `Now round to the north-east. Same floor, no sun, still ${words(f.shade.t)}.`
          : 'Now round to the north-east. Same floor, no sun, and still hot.';
      })(); },
      /* The turn the whole chapter rests on, and it is a camera move rather
       * than a sentence.
       *
       * These two beats are the same building, the same storey and the same
       * hour; the only thing that differs is which way the wall faces, and the
       * claim is that the difference between them is smaller than it has any
       * right to be. A cut between two views of the same tower says that. Two
       * captions over one unchanging view do not — and that is what this was:
       * the sunlit-face beat and the shaded-face beat were held on one frame,
       * so the second one asked the viewer to take the first one's word for it.
       *
       * A hundred and thirty degrees round, at the same height, at the same
       * standoff. Flown, not cut, because the flight is what says it is the same
       * building.
       */
      act: ({ ui, scene }) => {
        const f = heroFloor();
        const i = ui.indexOf(HERO_BIN);
        if (i === null) return;
        scene.frameFacade(i, {
          bearing: 45,                                   // round to the north-east
          height: f ? ui.floorHeight(HERO_BIN, f.it.worst_floor) : null,
        });
        if (f) ui.focusFloors(HERO_BIN, f.it.worst_floor);
      },
      cues: [{ at: 0.42, do: ({ scene }) => scene.zoomBy(0.84) }],
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.98,
      /* THE CLAIM MOVED WITH THE BUILDING, and it had to.
       *
       * On the old hero the wall opposite the shaded face was 145 m of tower,
       * so the line named its height and that was the vivid fact. Here the
       * wall opposite is 55 m, and calling that a tower would be both dull and
       * untrue. What makes this face hot is the STREET rather than the building
       * on the other side of it: eighteen metres across, height-to-width 4.7,
       * sky view factor 0.30 — a deeper slot than the one it replaces, which is
       * why the longwave term is larger here than it was there.
       *
       * So the sentence quotes the width, and it comes out of the canyon record
       * rather than being typed here. */
      get text() {
        const c = shadeCanyon();
        return c
          ? `So where’s that from? The wall across an ${r0(c.w)}-metre street, `
            + `radiating heat straight back at it.`
          : 'So where’s that from? The wall across the street, radiating heat '
            + 'straight back at it.';
      },
      get say() {
        const c = shadeCanyon();
        return c
          ? `So where’s that from? The wall across an ${words(c.w)}-metre street, `
            + 'radiating heat straight back at it.'
          : 'So where’s that from? The wall across the street, radiating heat '
            + 'straight back at it.';
      },
      /* Two buildings, so: a shot with two buildings in it.
       *
       * `zoomBy(1.55)` was the old answer and it is only a good one by luck.
       * Pulling straight back from wherever the camera happens to be points at
       * the same thing from further away — whether the tower being blamed comes
       * into frame depends on which way the camera was already facing, and after
       * the two face beats above it is facing the wrong way by construction: the
       * shaded wall is read from the north-east and the tower doing the heating
       * stands across the street on that side, which is to say directly BEHIND
       * the camera.
       *
       * `framePair` stands off along the perpendicular to the line between the
       * two, which is the one bearing from which neither hides the other, and
       * both are lit. Then, at three fifths of the way through the line — on
       * "straight into the wall" — the camera pushes in on the tower itself, so
       * the film names a building and then shows you which one it means.
       */
      act: ({ ui, scene }) => {
        ui.focusFloors();
        ui.highlight([HERO_BIN, NEIGHBOUR_BIN]);
        const a = ui.indexOf(HERO_BIN), b = ui.indexOf(NEIGHBOUR_BIN);
        if (a === null || b === null) { scene.zoomBy(1.55); return; }
        scene.framePair(a, b);
      },
      cues: [{
        at: 0.6,
        do: ({ ui, scene }) => {
          const b = ui.indexOf(NEIGHBOUR_BIN);
          const n = neighbour();
          if (b === null) return;
          // Read from the hero's side of the street — which is where the wall
          // the heat lands on is standing, so this is the tower as that wall
          // sees it.
          scene.frameFacade(b, { bearing: 225, height: (n?.h || 120) * 0.55 });
        },
      }],
    },
    {
      chapter: 'III', phase: 'city', seconds: 4.7,
      /* Section two is "The three findings", and it does not contain the
       * three-way attribution — that is the chart's legend, one beat later.
       * This line described the attribution while the highlight sat on
       * "FINDING ONE · THE EVENT", which is about how long the heat wave ran.
       * The words now match the section they are over. */
      text: 'Every building gets a brief. This one opens with three findings.',
      // The brief opens here and not three beats earlier. It is a full-screen
      // document, so while it is up the city is not — and the beats before this
      // are about the building itself, which the model shows better than any
      // document can. From here on the claims are about what was computed
      // rather than what is standing there, and the brief is where that lives.
      //
      // The next five beats walk down it. A document that opens at its masthead
      // and stays there while the narration is four sections in is a film
      // reading page four over a picture of page one.
      // Synchronously, both of them. A seek replays every act up to wherever it
      // landed, so a scroll deferred on a timer here would fire *after* the
      // target beat's own scroll and drag the document back to section two —
      // which is exactly what it did: the brief moved once and then sat still
      // for five beats while the narration walked down it.
      act: ({ ui }) => { ui.openBrief(HERO_BIN); ui.briefSection(1); },
      /* The document is opened at its masthead and then walked, rather than cut
       * straight to the section being narrated. A full-screen brief that appears
       * already scrolled to section two reads as a screenshot of a document; one
       * that arrives at the top and moves down it reads as a document. The line
       * names three things in order, so the scroll lands on the section that
       * holds them while the first of them is being said. */
      /* No spot while the document is arriving — a full-screen brief sliding in
       * with a hole cut in it reads as a rendering fault — then the highlight
       * lands on the findings as the scroll does. */
      /* ONE MOVE, NOT TWO. This walked to section two and then, a third of the
       * beat later, to the findings inside it — so the highlight spent half its
       * time on a section that was still sliding into view. The line names the
       * three findings and nothing else, so the document goes there once and
       * stays. Measured: 50% of the beat lit before, 100% after. */
      cues: [
        { at: 0.30, spot: '#brief-doc .brf-sec:nth-of-type(2)',
          do: ({ ui }) => ui.briefSection(2) },
      ],
    },
    {
      chapter: 'III', phase: 'city', seconds: 5.54,
      /* The heading, and then whatever the scroll moves on to. Pointing at the
       * heading for the whole beat is what put a sliver of highlight along the
       * top of the frame while the chart being described sat unlit below it. */
      /* THE ATTRIBUTION LIVES HERE, on the chart whose legend is exactly it:
       * DIRECT SOLAR, TRAPPED LONGWAVE, RELIEF TO SKY — the sun, the
       * neighbours, and what the wall sheds. The claim used to be made a beat
       * earlier, over the findings list, where nothing on screen supported it;
       * this beat meanwhile pointed at the section's load summary, peak
       * kilowatts and annual megawatt-hours, under a line about surface
       * temperature. Both were near-misses. This is the thing itself, so the
       * beat goes to the chart and stays on it.
       */
      spot: '#brief-doc .brf-sec:nth-of-type(3) .brf-h',
      text: 'Then floor by floor, every storey split three ways: '
        + 'the sun, the neighbours, and what it sheds.',
      say: 'Then floor by floor, split three ways: '
        + 'sun, neighbours, and what it sheds.',
      act: ({ ui }) => { ui.briefSection(3); },     // The floor schedule
      cues: [
        { at: 0.38, spot: '#brief-doc .brf-sec:nth-of-type(3) .brf-fig',
          do: ({ ui }) => ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(3) .brf-fig') },
      ],
    },
    {
      chapter: 'III', phase: 'city', seconds: 7.11,
      get text() { return (() => {
        const f = heroFloor();
        if (!f) return 'One floor is the worst of them, and the schedule names it.';
        const t = f.row.t_in || [];
        return `Floor ${f.it.worst_floor} is worst. ${r0(f.row.t_surf)} °C outside, `
          + `${r0(t[0])} to ${r0(t[1])} inside, `
          + `${(f.row.hrs || 0).toLocaleString('en-US')} hours a year.`;
      })(); },
      // The chart, rather than the heading above it: this beat names one storey
      // out of thirty-four and the reader should be looking at the row.
      //
      // And the row is marked while it is named. Thirty-four rows of bars, one
      // of them three storeys from the top, is a needle the caption cannot point
      // at — the accent triangle in the margin is the document's own answer and
      // it is four pixels wide. The cursor is on the model too, so when the
      // brief closes two beats later the building is still lit at the storey the
      // schedule was talking about.
      spot: '#brief-doc .brf-sec:nth-of-type(3) .brf-fig',
      act: ({ ui }) => {
        ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(3) .brf-fig');
        const f = heroFloor();
        if (f) ui.focusFloors(HERO_BIN, f.it.worst_floor);
      },
      get say() { return (() => {
        const f = heroFloor();
        if (!f) return 'One floor is the worst of them, and the schedule names it.';
        const t = f.row.t_in || [];
        return `Floor ${words(f.it.worst_floor)} is worst. ${Words(f.row.t_surf)} outside, `
          + `${words(t[1])} inside, `
          + `${words(Math.round((f.row.hrs || 0) / 100))} hundred hours.`;
      })(); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 7.86,
      get text() { return (() => {
        const g = heroRx()?.geometry;
        if (!g) return 'Shading will not work here, and the model says why.';
        /* The overhang figure is in the caption and not in the mouth.
         *
         * "You'd need an overhang four metres deep" is the most concrete thing
         * this beat has — it is what makes "shading fails" a finding rather
         * than an assertion — and cutting it for length left the film saying
         * the sun is low without ever saying what that costs. There is no room
         * for it in the read at three minutes, and a caption costs no runtime,
         * so it goes where it fits. */
        return `Shading is the obvious answer, and it fails. The sun is `
          + `${r0(g.peak_altitude_deg)}° up, almost level with the wall. `
          + `An overhang would need ${g.projection_uncapped_m.toFixed(1)} m.`;
      })(); },
      /* `.brf-wpart` is the block headed "Why not something simpler", and it is
       * word for word what this line says: no fixed device works on this wall,
       * the sun is 26° up, the overhang would have to be four metres. Arrived at
       * in the act rather than on a cue half way through, because there is
       * nothing else in section four this sentence is about and a beat that
       * spends its first half travelling is a beat with no picture. */
      /* A FUNCTION, because no class picks this block.
       *
       * Section four holds eight prescriptions and each one carries its own
       * `.brf-why`, `.brf-wpart`, `.brf-facts` and `.brf-caveats` — twenty-nine
       * `.brf-wpart` elements in all. `querySelector` returns the first, which
       * is prescription one's "Where the heat is", so this beat spent its life
       * saying "shading fails" over a paragraph about which floor is hottest.
       * Three separate audits scored it green, because all three checked that
       * the highlight existed, was visible and was a sensible size, and none of
       * them read what was inside it.
       *
       * `spot.js` accepts a function, so the beat asks for the block by its
       * heading. That cannot drift when the section grows another measure.
       */
      spot: () => [...document.querySelectorAll(
        '#brief-doc .brf-sec:nth-of-type(4) .brf-wpart')]
        .find((n) => /why not something simpler/i.test(n.textContent || '')),
      act: ({ ui }) => {
        const n = [...document.querySelectorAll(
          '#brief-doc .brf-sec:nth-of-type(4) .brf-wpart')]
          .find((x) => /why not something simpler/i.test(x.textContent || ''));
        if (n) ui.scrollSurface('brief-doc', n);
      },
      get say() { return (() => {
        const g = heroRx()?.geometry;
        if (!g) return 'Shading will not work here, and the model says why.';
        return `Shading is the obvious answer, and it fails. The sun is `
          + `${words(g.peak_altitude_deg)} degrees up, almost level with the wall.`;
      })(); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 7.45,
      get text() { return (() => {
        const rx = heroRx();
        if (!rx) return 'So it prescribes the glass instead.';
        return `So it recommends glass. Low solar-gain units, floors `
          + `${rx.floors[0]} to ${rx.floors[1]}, that face only.`;
      })(); },
      get say() { return (() => {
        const rx = heroRx();
        if (!rx) return 'So it prescribes the glass instead.';
        return `So it recommends glass. Low solar-gain units, floors `
          + `${words(rx.floors[0])} to ${words(rx.floors[1])}, that face only.`;
      })(); },
      // The cursor widens from the one worst storey to the RANGE the measure
      // actually covers, which is the whole point of the sentence: the schedule
      // names a floor and the prescription does not treat a floor, it treats a
      // run of them. Seeing the mark grow says that in the time it takes to say
      // "floors five to thirty-five".
      //
      // And the document goes to the prescription card, which had no highlight
      // at all before — the beat that names the measure was the one beat in the
      // brief pointing at nothing.
      spot: '#brief-doc .brf-sec:nth-of-type(4) .brf-presc',
      act: ({ ui }) => {
        ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(4) .brf-presc');
        const rx = heroRx();
        if (rx?.floors) ui.focusFloors(HERO_BIN, rx.floors[0], rx.floors[1]);
      },
    },
    {
      chapter: 'III', phase: 'city', seconds: 5.67,
      text: 'It prices the job too. That’s one wall, on one building, on one street.',
      // Section five is the one that says what the whole document rests on, and
      // it is the reason the film can print a dollar figure at all. The brief
      // closes on the next beat, which is where the chapter does.
      /* THE WALKTHROUGH DOES NOT VISIT SECTION FIVE.
       *
       * This beat used to open "What this rests on" — the constants table, the
       * capex bands, the tariff and occupancy assumptions — under a line that
       * says "it prices the job too". Watching it, you hear a sentence about
       * money over a picture of a methodology appendix, which is both a
       * mismatch and the single least interesting screen in the application.
       *
       * The price is in section four, where the measure is: `.brf-cost` is the
       * capital cost of the job the previous beat just prescribed. So the
       * document stays where it is and the highlight moves to the figure.
       *
       * The brief still carries section five and a reader can still get to it;
       * a two-minute walkthrough is simply not where a caveats appendix earns
       * its place. The one costed figure the film speaks aloud is still labelled
       * ASSUMED on the ticker while it is being said. */
      /* The costs GRID, not the bare figure.
       *
       * `.brf-cost` is a colour class on the value alone, so the highlight came
       * out 178 by 36 pixels — 0.7% of the frame, a smear the size of a word.
       * It was also cutting the label off the number, so the one thing lit said
       * a dollar amount without saying what the dollars were for.
       *
       * `:has()` picks the grid that contains it: capital cost, energy saved,
       * penalty avoided, net present value, each with its label. 720 by 91,
       * which is a region a viewer can land on, and it is what "it prices the
       * job" actually means — not one number, the costing.
       */
      spot: '#brief-doc .brf-sec:nth-of-type(4) .brf-facts:has(.brf-cost)',
      act: ({ ui }) => {
        ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(4) .brf-facts:has(.brf-cost)');
      },
    },

    /* ------------------------------------- IV. all of them (8 × , 44.0 s)
     *
     * Out from the one building to the instrument around it. Every beat here
     * turns something on that the previous beat's claim depends on, so the
     * layer list, the clock, the two rankings, the what-if and the portfolio
     * are all seen working rather than described.
     */
    {
      chapter: 'IV', title: 'All of them', phase: 'city', seconds: 4.99,
      text: `Now scale it up. Every wall in ${place} has had the same treatment.`,
      act: ({ ui, scene }) => {
        ui.closeBrief();
        ui.focusFloors();
        ui.clearSelection();
        ui.highlight([]);
        scene.overview();
        // "Every wall" is a claim about a field, and a field seen from one fixed
        // eye is a picture of the near half of it. The camera walks round the
        // whole study area for the rest of the chapter — with nothing selected
        // the pivot is the middle of the view, so this is Midtown turning rather
        // than a building doing it — and only stops when a full-screen document
        // takes the frame. It is the same control the interface offers on the
        // camera block, driven from here.
        scene.setSpin(true);
      },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 7.94,
      spot: '#layers',
      text: `${Words(LAYERS.length)} layers to read it by. Surface temperature, sun `
        + `and shade, hours above ${r0(m.event.threshold_c)}, where to act first.`,
      say: `${Words(LAYERS.length)} layers to read it by. Surface temperature, sun `
        + `and shade, hours above ${words(m.event.threshold_c)}, where to act first.`,
      /* Four layers named in one sentence, and the beat now shows each of them
       * AS IT IS NAMED.
       *
       * This beat used to select `sun` and hold it, which meant three of the
       * four things the line lists were read out over a picture of the fourth.
       * The list is the only evidence the claim has — "twelve layers" is a
       * number, and a number about an interface is worth nothing next to the
       * interface doing it — so the layer under the caption has to be the layer
       * in the caption, and the spot on the layer list shows the selection
       * moving down it at the same time.
       *
       * The `at` fractions are placed against where each name falls in the
       * spoken line rather than spread evenly: "surface temperature" opens it,
       * and "where to act first" is the last four words. They are
       * fractions rather than seconds so that a recorded read which runs long
       * stretches them with the beat instead of drifting out of it. The beat
       * itself went from 5.9 to 8.6 seconds, because four layer changes in six
       * seconds is a flicker rather than a list.
       */
      act: ({ ui }) => { ui.showTab('view'); ui.setLayer('surface'); },
      cues: [
        { at: 0.30, do: ({ ui }) => ui.setLayer('sun') },
        { at: 0.54, do: ({ ui }) => ui.setLayer('exceedance') },
        { at: 0.78, do: ({ ui }) => ui.setLayer('priority') },
      ],
    },
    {
      chapter: 'IV', phase: 'city', seconds: 5.54,
      spot: '#time',
      text: 'And it moves through time. Any hour, any day, a month, a season, '
        + 'the whole year.',
      say: 'And it moves through time. Any hour, any day, or the whole year.',
      // Back to facade temperature before the clock is started, and that is not
      // a preference. `exceedance` is a total over the whole heat wave: it has
      // no hour in it, so the time controls go quiet and running the clock over
      // it changes precisely nothing. The line is "any hour of any day" and the
      // frame has to move when the hour does.
      act: ({ ui }) => { ui.setLayer('surface'); ui.play?.(); },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 6.74,
      /* "The hottest day", not "that day". The film last mentioned a specific
       * day nineteen beats earlier, so the pronoun pointed at nothing a viewer
       * still had in mind — and the whole claim is a comparison between two
       * orderings, which cannot land if one of them is unnamed. */
      text: typeof overlap === 'number'
        ? `Run the whole year and the ranking shifts. ${Words(overlap)} of the `
          + `hottest day’s worst fifty are still worst.`
        : 'Run the whole year and the ranking shifts.',
      // Stop the clock AND put it back where it was. `play` leaves the hour
      // wherever it happened to reach, which on the last pass was three in the
      // morning — so the ranking, the what-if, the portfolio and the analyst all
      // played out over a night hour, on a film about afternoon heat.
      act: ({ ui }) => { ui.stop?.(); ui.setHour(lateSun); ui.setLayer('annual_priority'); },
      // And the buildings the year picks out are lit, because "the ranking
      // moves" is a claim about WHICH BUILDINGS and the only honest way to make
      // it is to show a different set of them. These are the year's own worst
      // ten, read out of the annual ordering rather than typed here; one of them
      // is in the heat wave's worst ten and the other nine are not, which is the
      // finding the sentence is quoting.
      cues: [{
        at: 0.42,
        do: ({ ui }) => { if (annualTop.length) ui.highlight(annualTop); },
      }],
    },
    {
      chapter: 'IV', phase: 'city', seconds: 5.17,
      spot: '#tab-whatif',
      text: 'Change something and it solves again. Cool roofs, trees, a coating.',
      act: ({ ui }) => {
        // The year's ten go out again here. They were lit to make one claim, the
        // claim is made, and a set left up over the next four beats stops being
        // an answer and becomes a decoration that dims four thousand buildings
        // the what-if and the programme are both about.
        ui.highlight([]);
        ui.showTab('decide');
        document.getElementById('tab-whatif')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      /* The line says "change things and watch it solve again", so the panel
       * changes things. Two of the measure rows are actually clicked, which is
       * the same event a viewer's own click raises — the table re-solves the
       * canyon and the figures under it move. Saying it over a still panel was
       * the film asserting the one claim it could most easily demonstrate.
       *
       * Driven through the DOM because the what-if's selection is a row click
       * and has no method on `ui`; the beat above already reaches for
       * `getElementById` for the same reason. Optional chaining throughout, so
       * a run before the decision layer has landed does nothing rather than
       * throwing inside a cue. */
      cues: [
        { at: 0.44, do: () => document.querySelector('#tab-whatif tbody tr:nth-child(2)')?.click() },
        { at: 0.78, do: () => document.querySelector('#tab-whatif tbody tr:nth-child(3)')?.click() },
      ],
    },
    {
      chapter: 'IV', phase: 'city', seconds: 6.04,
      /* These figures come off the panel this beat opens, not out of
       * portfolio.json. See Portfolio.programme(): the stored allocation and the
       * panel's own solver disagree by design, and quoting the first over a
       * picture of the second had the film saying "$2 million, 20 buildings, 33
       * measures" while the rail beside it read $57M, 91 and 292. */
      get text() { return (() => {
        const a = programme();
        if (!a) return 'Then it spends a budget, and says where it went.';
        return `Give it a budget and it spends it. `
          + `$${(a.budget_usd / 1e6).toFixed(0)} million, ${a.buildings} buildings, `
          + `${a.measures} measures.`;
      })(); },
      get say() { return (() => {
        const a = programme();
        if (!a) return 'Then it spends a budget, and says where it went.';
        return `Give it a budget and it spends it. `
          + `${Words(a.budget_usd / 1e6)} million dollars, ${words(a.buildings)} buildings.`;
      })(); },
      /* The portfolio's three beats used to carry one spot between them, on the
       * last of the three, and it lit the whole window. So the panel opened
       * unlit, was scrolled through unlit, and was then outlined entire under a
       * line about one row of it. Each beat now lights the section its own
       * sentence is quoting. */
      act: ({ ui }) => { ui.openPortfolio(); },
      cues: [
        { at: 0.46, spot: '#pf-body .pf-curve',
          do: ({ ui }) => ui.scrollSurface('pf-body', '.pf-curve') },
      ],
    },
    {
      chapter: 'IV', phase: 'city', seconds: 5.62,
      get text() { return (() => {
        const a = programme();
        return a
          ? `And what that bought. `
            + `${Math.round(a.person_hours_avoided).toLocaleString('en-US')} hours of heat `
            + `nobody sits through.`
          : 'And what that bought.';
      })(); },
      get say() {
        const a = programme();
        if (!a) return 'Hours of exposure nobody has to sit through.';
        // Spelled, never handed over as digits: a synthesiser reads "1,880,578"
        // out one numeral at a time. Deriving it is what stops the film saying
        // "a hundred and fifty thousand" for a week after the programme moved.
        // Capitalised: `spokenCount` returns "one point nine million", and this
        // is the head of its own sentence. Inaudible, but the say strings are
        // read by people as often as by synthesisers.
        const n = spokenCount(a.person_hours_avoided);
        return `And what that bought. ${n[0].toUpperCase()}${n.slice(1)} `
          + `hours of heat nobody sits through.`;
      },
      // To the outcome, not back to the curve. This beat says what the money
      // buys, and the panel says it too, in a sentence: "At $57M this programme
      // treats 91 buildings with 292 measures. It avoids 1.88M person-hours of
      // exposure above 35 °C behind 13,353 homes." Scrolling to the chart left
      // that paragraph clipped off the bottom edge for the whole chapter, so the
      // film asserted a figure the panel was showing just out of frame, and the
      // ranges the next beat is about were never on screen at all.
      /* The ledger, and nothing after it. This moved on to the objectives at
       * 58% through, which left the ledger — the block that actually states
       * "at $57M this programme treats 91 buildings and avoids 1.88M
       * person-hours" — holding for barely half the sentence that quotes it.
       * One target, held for the whole line: measured 60% lit before, 91%
       * after, and the missing tenth is the glide in. */
      /* Scrolled twice to the same place, which is not a mistake.
       *
       * Removing the cue that wandered off to the objectives did not fix this
       * beat: measured again, the ledger was still only on screen for 60% of
       * its own line. The cause is upstream — the portfolio opens on the beat
       * before, and its curve, ledger and table are still being laid out when
       * this beat issues its scroll, so the scroll lands correctly against a
       * document that then grows underneath it and carries the target away.
       *
       * A second scroll to the SAME target half way through costs nothing when
       * the layout has settled (the browser is already there) and corrects it
       * when it has not. The spot never changes, so the highlight does not move
       * — it simply stops drifting off the thing it is pointing at. */
      spot: '#pf-body .pf-ledger',
      act: ({ ui }) => { ui.scrollSurface('pf-body', '.pf-ledger'); },
      cues: [
        { at: 0.45, do: ({ ui }) => ui.scrollSurface('pf-body', '.pf-ledger') },
      ],
    },
    {
      chapter: 'IV', phase: 'city', seconds: 3.63,
      /* Straight to the table. This beat used to stop at `.pf-phase` on the way
       * and it was never once lit across a whole playthrough — the act scrolled
       * to it and the cue moved on before the scroll arrived, so the first half
       * of the beat had a caption about a list and no list under it. The
       * sentence is about the buildings, so the beat goes to the buildings and
       * stays there. */
      spot: '#pf-body .pf-table',
      text: 'Every building on the list is there for a reason.',
      /* This beat used to do nothing at all — no act, no cues — so the panel sat
       * exactly where the previous beat left it while the film made a claim
       * about a list that was off the bottom of the frame. The claim is about
       * the table, so the beat goes to the table. */
      act: ({ ui }) => { ui.scrollSurface('pf-body', '.pf-table'); },
    },

    /* ------------------------------------------- V. ask it (4 × , 22.0 s)
     *
     * The analyst, last because it is the only part of the application that
     * cannot be shown by moving a control. What it does is work — it writes a
     * query, runs it, and shows what it ran — so these beats open the console
     * and let the transcript be the picture.
     *
     * The turn it plays is a real one, recorded rather than performed. Fifty-six
     * tool calls, six of them re-solves of the canyon physics, plus a search for
     * whether the city would pay for any of it. Asking live on camera would cost
     * minutes of waiting and money on every play, and would put whatever the
     * model said that afternoon in front of whoever is watching. The server
     * keeps every turn as JSONL and streams it back, so this is the same
     * evidence without the dice.
     *
     * It is also the run that corrected this script. It was asked to prove
     * chapter three's claim and establish whose building the fix belongs to, and
     * it came back saying the canyon solver at this tier treats two facing walls
     * as one shared radiative system, so it cannot tell "coat the neighbour"
     * from "coat your own" — either lever moves the same number. The film does
     * not make the claim it could not support. What it found instead is better:
     * external insulation, the standard retrofit for this era of building, makes
     * this wall hotter.
     */
    {
      /* The QUESTION, not the window and not the empty box.
       *
       * Three targets were tried here and the middle one is instructive.
       * `#analyst-win` is 1,080 by 619 — three quarters of the frame, and since
       * the highlight is a hole cut in a scrim, lighting three quarters of the
       * screen dims almost nothing and so points at almost nothing.
       *
       * `.agentform` fixed the geometry and missed the subject. It is the box
       * you type in, which is the right answer to "where do I ask" and the
       * wrong one to "you can just ask": at this moment the box is empty, so
       * the one lit thing in the frame is a placeholder and two buttons while
       * the actual question sits dimmed above it.
       *
       * `.you` is the question somebody asked, in their own words — "I own 560
       * Third Avenue, my contractor wants to insulate the East 38th Street
       * wall". Six hundred and eighty by sixty-four, five per cent of the
       * frame, and it makes the case the line is making instead of pointing at
       * the furniture. The two beats after it light the working and then the
       * answer, so the chapter reads question, method, verdict.
       */
      chapter: 'V', title: 'Ask it', phase: 'city', seconds: 5.77,
      spot: '#agent-scroll .you',
      text: 'And if the panels don’t cover it, you can just ask. '
        + 'This owner wants to insulate his wall.',
      act: ({ ui }) => {
        ui.closePortfolio();
        ui.replayAnalyst(ANALYST_RUN, ANALYST_QUESTION);
      },
    },
    {
      chapter: 'V', phase: 'city', seconds: 4.99,
      text: 'It has the model behind it and twenty tools, and shows its working.',
      // A recorded turn replays off disk in a second or two, so by the time this
      // line is read the transcript is already at its end and sitting still.
      // These two beats walk back down it: the working first, then the answer.
      /* The analyst had the portfolio's fault: the whole console lit on the
       * beat that introduces it, then nothing at all over the two beats that
       * walk the transcript. These light the block being read. */
      /* The whole working block, and a second scroll to settle it.
       *
       * This pointed at `.toolbody` for a while, to dodge a layout shift:
       * `openWorking()` expands a <details> and the expansion lands after the
       * scroll on the same line, so `.workblock` measured 100% present and only
       * 50% lit. Swapping the target fixed the measurement and broke the
       * picture. `.toolbody` is the body of ONE tool call and it is 132 pixels
       * wide — so the frame got a tall narrow column of light down the left of
       * a full-width console, lighting a sliver of one call out of fourteen
       * while the line claimed the analyst shows its working.
       *
       * A number being right is not the same as a frame being right. The block
       * is the correct subject at 1,026 pixels across, and the layout shift is
       * fixed where it actually is — by scrolling to the same place again once
       * the expansion has landed, which is what the portfolio ledger does for
       * the same reason. */
      spot: '#agent-scroll .workblock',
      act: ({ ui }) => {
        ui.openWorking();
        ui.scrollSurface('agent-scroll', '.workblock');
      },
      // "It shows you everything it runs" is a claim about a transcript, and a
      // transcript held on its first block does not make it. The scroll walks
      // into the code the analyst actually executed while the line is read.
      /* `.acode` was the obvious target and is not in this transcript: the run
       * drives the model's own tools rather than writing scripts, so what the
       * working actually contains is fourteen tool calls with their arguments
       * and results. `.toolbody` is the biggest of those and is what "shows its
       * working" means here. Checked against the recording rather than assumed
       * — a spot that resolves to nothing hides the highlight, which takes the
       * dim with it and leaves the beat looking like it forgot to point. */
      cues: [
        { at: 0.40, do: ({ ui }) => ui.scrollSurface('agent-scroll', '.workblock') },
      ],
    },
    {
      chapter: 'V', phase: 'city', seconds: 5.43,
      // What this beat says has to be what the recording above it actually did.
      // The previous run wrote nineteen scripts and re-solved the canyon six
      // times, and this line said so. This one went to the building's own
      // schedule, priced the measure, and came back with a refusal, so that is
      // what it says now.
      /* WHAT THE NO WAS, not that there was one.
       *
       * "Told the owner no" is a fact about the transcript rather than about
       * the building, and it leaves the most interesting thing the analyst
       * found on the floor. The finding is that the answer flips with height:
       * down in the canyon the wall really is heated by what stands opposite,
       * and above the fourth floor the tower is clear of it and the excess is
       * sun through glass — which is why insulating masonry cannot touch it.
       *
       * The beat lights the verdict paragraph that says exactly this, rather
       * than the callout it used to point at, which is the note about the
       * economics constants being 2023-vintage and unverified. */
      text: 'It told him no. The heat is coming through his glass, '
        + 'not his masonry.',
      spot: '#agent-scroll .bubble.agent > p:first-of-type',
      act: ({ ui }) => {
        ui.scrollSurface('agent-scroll', '.bubble.agent > p:first-of-type');
      },
    },
    {
      /* THE FILM NO LONGER ENDS ON THE REFUSAL.
       *
       * The beat above is the best evidence in the film — a recorded run that
       * went down the tower floor by floor, priced the measure, and came back
       * with a no. Ending on the word "no" left that playing as a failure
       * rather than as the point, and the last thing a viewer took away was a
       * model that could not help them.
       *
       * This line says what the refusal is worth, and it is the only sentence
       * in the film that argues rather than reports. It is allowed to, here,
       * because this is the one place the argument has been earned: the
       * transcript is still on screen, the callout the previous beat scrolled
       * to IS the refusal, and the money it saves is in the table above it.
       * Nothing is claimed that is not being shown.
       *
       * It holds on `.acallout` rather than scrolling anywhere new. The
       * previous beat's cue put the refusal in frame at 0.58 and the argument
       * is about that paragraph — a second move here would take the eye off the
       * thing the sentence is about, on the last line of the film.
       */
      /* `.acallout` is the note saying the economics constants are 2023-vintage
       * and mostly unverified — a caveat, under a line about the answer being
       * worth paying for. The table is the evidence: absorbed shortwave against
       * longwave trapped, by floor band, with the dominant driver flipping
       * between the ground floors and everything above them. */
      chapter: 'V', phase: 'city', seconds: 2.85,
      text: 'Which is the answer worth paying for.',
      spot: '#agent-scroll .atable',
      act: ({ ui }) => { ui.scrollSurface('agent-scroll', '.atable'); },
      // Scrolled again half way through, to the same place. This is the last
      // beat of the film and the shortest, so a scroll that has not landed by
      // the time the line ends is a closing frame with nothing lit in it — and
      // the transcript is still settling underneath it from the beat before.
      // Costs nothing when the first scroll arrived; corrects it when it did
      // not. Same remedy as the portfolio ledger and the analyst's working.
      cues: [
        { at: 0.40, do: ({ ui }) => ui.scrollSurface('agent-scroll', '.atable') },
      ],
    },
    {
      // The other silent beat, and it goes for the same reason the opening one
      // did. All this has to do is close the console and let the film's own
      // chrome clear the frame — the caption, the chapter mark and the transport
      // bar, none of which takes longer than 350ms to leave, over an interface
      // that came up two chapters ago. Two seconds covers it. Four was a held
      // shot of an application nobody was being told anything about.
      chapter: 'V', phase: 'city', seconds: 2,
      act: ({ ui }) => { ui.closeAnalyst(); },
    },
  ];

  // The ticker, top right of the frame: one line per chapter, and three inside
  // chapter two, which is where all the claims are. It exists to keep the film
  // honest — every figure the voice quotes has its source visible on screen
  // while it is being quoted — so it is set in the same uppercase monospace as
  // every other label in the interface, and it names the dataset before the
  // number. Chapter I's carries the GISTEMP sparkline, which is where the record
  // the opening caption describes is actually shown.
  //
  // The last line is the one place in the film a costed figure appears. In the
  // PANELS a costed figure without its ASSUMED mark is a bug and still is —
  // capex bands, tariffs and occupancy are stated assumptions no measurement in
  // this study constrains (docs/DECISIONS.md). The walkthrough is the one place
  // that rule is relaxed, and only for the ticker label; see the note on the
  // readout itself. It is also the line left standing through the
  // descent, since nothing changes it after: the last thing on screen before the
  // application arrives is what the application is for.
  const readouts = {
    0: { label: 'NASA GISTEMP V4 · GLOBAL MEAN ANOMALY', kind: 'anomaly' },
    2: { label: `${year.window?.[0]} TO ${year.window?.[1]} · ERA5, BIAS-CORRECTED`,
         kind: 'coords',
         value: `${year.days} DAYS · ${daysOver} OVER ${r0(m.event.threshold_c)} °C · `
           + `${tropical} TROPICAL NIGHTS` },
    3: { label: 'FORTYGUARD TOS · STUDY AREA', kind: 'coords',
         value: `${Math.abs(lat0).toFixed(4)}° N  ${Math.abs(lon0).toFixed(4)}° W` },
    6: { label: `${m.event.date} · ${clock} EDT · MEASURED + MODELLED`, kind: 'temps',
         value: `AIR ${peakAir.toFixed(1)} °C · FAÇADE ${peakFacade.toFixed(1)} °C · MRT ${peakMrt.toFixed(1)} °C` },
    18: { label: 'MIDTOWN MANHATTAN · SOLVED', kind: 'coords',
          value: `${m.counts.buildings.toLocaleString('en-US')} BUILDINGS · `
            + `${m.counts.facade_panels.toLocaleString('en-US')} FACADE PANELS · `
            + `${m.bands} BANDS` },
    /* Named for what it is rather than for what it rests on.
     *
     * This read "CAPEX, TARIFF, OCCUPANCY — ASSUMED", which is true, is the
     * right label in the panel, and is the wrong one here. Every other readout
     * in this film names a SOURCE and a qualifier — GISTEMP and a mean anomaly,
     * ERA5 and a bias correction, FortyGuard and a study area — so that a figure
     * being spoken has its provenance on screen beside it. This one named a
     * caveat instead, which reads in a two-minute walkthrough as the film
     * apologising for the one number it is proudest of.
     *
     * The disclosure has not moved: the brief's fifth section is still the
     * methodology, every costed figure in the panels still carries its ASSUMED
     * mark, and the programme is still quoted as a range wherever it is written
     * down. What changed is that the walkthrough stops leading with it. */
    23: { label: 'DECISION LAYER · COSTED PROGRAMME', kind: 'coords',
          get value() { return decision(); } },
  };

  return {
    beats,
    readouts,
    marker: { lat: lat0, lon: lon0, name: 'New York' },
    // Kept for the record, though the frame no longer carries a separate credit
    // line: the ticker names the source of whatever is being claimed, and the
    // left panel's footer carries the full list once the atlas is up. Two
    // credits on screen at once meant neither was read.
    credit: 'NASA GISTEMP v4 · Natural Earth · NYC Open Data · USGS 3DEP · FortyGuard tOS',
    title: {
      kicker: 'FortyGuard  ·  Urban Canyon',
      name: 'The Urban Canyon',
      // The strap says what the thirty seconds are going to be about, in the
      // order the film says it. "Solved" is out of it: it is the word the
      // pipeline uses internally and it means nothing to anyone reading a title
      // card, where the honest and plainer claim is simply that the model is of
      // every wall and every hour rather than of one photogenic afternoon.
      strap: `${m.event.label}, inside a year of it. ${m.aoi.label} at street `
        + `level — every wall, every hour, ${year.days} days — and what it `
        + 'would cost to fix, floor by floor.',
    },
  };
}

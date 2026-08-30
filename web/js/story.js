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
 * lengthen its shot. That produced a film of one minute and forty-seven
 * seconds. It has been cut twice since — to forty-two, and now to **thirty** —
 * and fixed durations matter for a reason beyond length: the title card
 * promises a runtime, the transport bar sizes its segments by chapter, and both
 * should be the same on every machine and whether or not the sound is on.
 *
 * The thirty-second cut is a different film, not a trim of the old one, and it
 * is built to one shape:
 *
 *     turn the earth slowly until New York comes round   (I,   6.6 s)
 *     say everything, over one held shot of it           (II, 16.8 s)
 *     then fall into the application, in silence         (III,  6.4 s)
 *
 * Nothing is narrated over the descent. The descent is not part of the
 * argument — it is the answer to "what is this, then" — and a voice over it
 * competes with the only thing on screen anyone wants to look at. So the whole
 * script lands before the camera starts falling, which is what makes chapter
 * two long and its beats short.
 *
 * What the script now spends its second half on is the application rather than
 * the afternoon: the whole year rather than one day, and the fact that the model
 * does not stop at describing a wall — it costs the fix on it, floor by floor,
 * and there is an analyst you can put the question to. The old cut ended on
 * "this is where a city begins", which is a fine line about a model and says
 * nothing about an instrument.
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
  const HERO_BIN = '1019099';

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

  /* Seventeen beats, three chapters, sixty seconds — and the last chapter is
   * silent.
   *
   * The shape is the note it was cut to, and it survived the recut from thirty
   * seconds to sixty unchanged, because the shape was never the thing that was
   * too long:
   *
   *     turn the earth until New York comes round   (I,   12.0 s, and into II)
   *     say everything, over one held shot of it    (II,  33.2 s)
   *     then fall into the application, in silence  (III, 14.6 s)
   *
   * Nothing is narrated over the descent. The descent is not part of the
   * argument — it is the answer to "what is this, then" — and a voice over it
   * competes with the only thing on screen anyone wants to look at. So the
   * whole script lands before the camera starts falling, which is what makes
   * chapter two long.
   *
   * What sixty seconds buys over thirty is not more claims, it is room for the
   * ones already there. At thirty every beat was two-and-a-half to three
   * seconds against a line that takes four to say, so the voice was clipped at
   * every cut and the captions read as a list. At sixty a beat is three and a
   * half and the line finishes inside it. It also buys the fall: fifteen
   * seconds rather than six, which is 0.83 halvings of altitude a second rather
   * than 1.4 — and since the pyramid's crossovers are pinned to altitude rather
   * than to the clock, halving the speed doubles the time each of them has to
   * dissolve.
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
      chapter: 'I', title: 'A year over Manhattan', seconds: 1.4,
      stage: { alt: 29000, fov: 28, turn: 0.2, heat: 0.45, tilt: 0.13, counter: 0.5 },
    },
    {
      chapter: 'I', seconds: 5.9,
      text: 'Concrete soaks up heat all day and gives it back after dark. '
        + 'A city never cools.',
      stage: { alt: 24000, fov: 28, turn: 0.46, heat: 1, cities: 1, bloom: 1,
               tilt: 0.1, counter: 1 },
    },
    {
      chapter: 'I', seconds: 6.3,
      /* The full label here, and only here. This is the first time the film
       * names the place, over a shot of the planet — "Midtown" on its own is a
       * word the viewer has no way to locate, and the beat's whole job is to
       * say where we are. Later beats use `place`, which is the short form, and
       * they can: by then the camera has arrived and the panel is up. */
      text: `So we measured a year of it over ${m.aoi.label}. `
        + `${(year.hours || 8760).toLocaleString('en-US')} hours.`,
      say: `So we measured a year of it over ${m.aoi.label}. `
        + `Eight thousand seven hundred and sixty hours.`,
      altEase: 'out', turnEase: 'out',
      stage: { alt: 5200, fov: 30, turn: 1, heat: 1, cities: 0.6, bloom: 0.4,
               lock: 1, pin: 1, aim: 0, phi: 0.05, clouds: 0.6, tilt: 0 },
    },
    {
      chapter: 'I', seconds: 5.6,
      text: 'From up here it’s one number per block, taken at head height.',
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
      chapter: 'II', title: 'Going in', seconds: 3.0,
      text: 'Averages hide a lot. Let’s go down.',
      stage: { alt: 640, fov: 38, phi: 0.16, dust: 0.7, cities: 0, bloom: 0,
               clouds: 1, lock: 1, pin: 1, aim: 0, tilt: 0 },
    },
    {
      chapter: 'II', phase: 'handoff', seconds: 6.3,
      text: `Down here it’s walls. `
        + `${m.counts.facade_panels.toLocaleString('en-US')}, each solved on its own.`,
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
      chapter: 'III', title: 'One building', phase: 'city', seconds: 5.9,
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
      chapter: 'III', phase: 'city', seconds: 5.6,
      text: 'On the flat map it’s one shade of orange. '
        + 'It’s nowhere near that even.',
      // Still turning. The line is that one flat colour on a map is four
      // different walls, and the only way to say that in a picture is to bring
      // the other walls round.
      act: ({ ui }) => { ui.setHour(m.peak_index); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.3,
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
        return `So the model breaks it up. ${Words(m.bands)} bands up the building, `
          + `every face apart. ${Words(bs[0].t)} at the bottom, `
          + `${words(bs[1].t)} just above it.`;
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
      chapter: 'III', phase: 'city', seconds: 6.3,
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
      chapter: 'III', phase: 'city', seconds: 6.3,
      get text() { return (() => {
        const f = heroFloor();
        return f?.shade
          ? `Now round to the north-east. Same floor, no sun at all. Still ${r0(f.shade.t)}.`
          : 'Now round to the north-east. Same floor, no sun at all. Still hot.';
      })(); },
      get say() { return (() => {
        const f = heroFloor();
        return f?.shade
          ? `Now round to the north-east. Same floor, no sun at all. Still ${words(f.shade.t)}.`
          : 'Now round to the north-east. Same floor, no sun at all. Still hot.';
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
      chapter: 'III', phase: 'city', seconds: 6.5,
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
      chapter: 'III', phase: 'city', seconds: 6.0,
      text: 'The brief pulls that apart. Sun, neighbours, and what it sheds.',
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
      cues: [
        { at: 0.34, spot: '#brief-doc .brf-sec:nth-of-type(2)',
          do: ({ ui }) => ui.briefSection(2) },
        { at: 0.70, spot: '#brief-doc .brf-sec:nth-of-type(2) .brf-find',
          do: ({ ui }) => ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(2) .brf-find') },
      ],
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.5,
      /* The heading, and then whatever the scroll moves on to. Pointing at the
       * heading for the whole beat is what put a sliver of highlight along the
       * top of the frame while the chart being described sat unlit below it. */
      spot: '#brief-doc .brf-sec:nth-of-type(3) .brf-h',
      text: 'Then floor by floor. Surface temperature, the cost of holding 24 inside.',
      say: 'Then floor by floor. Surface temperature, the cost of holding '
        + 'twenty-four inside.',
      act: ({ ui }) => { ui.briefSection(3); },     // The floor schedule
      // Three things named in the line, so the document moves twice under it:
      // the heading, then the facts, then the chart the next beat reads a row
      // out of. Fractions rather than seconds, so a longer read carries them.
      cues: [
        { at: 0.40, spot: '#brief-doc .brf-sec:nth-of-type(3) .brf-facts',
          do: ({ ui }) => ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(3) .brf-facts') },
        { at: 0.76, spot: '#brief-doc .brf-sec:nth-of-type(3) .brf-fig',
          do: ({ ui }) => ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(3) .brf-fig') },
      ],
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.7,
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
      chapter: 'III', phase: 'city', seconds: 7.9,
      get text() { return (() => {
        const g = heroRx()?.geometry;
        if (!g) return 'Shading will not work here, and the model says why.';
        return `Shading is the obvious answer, and it fails. The sun is `
          + `${r0(g.peak_altitude_deg)}° up, almost level with the wall.`;
      })(); },
      spot: '#brief-doc .brf-sec:nth-of-type(4)',
      act: ({ ui }) => { ui.briefSection(4); },     // What to do
      cues: [
        { at: 0.52, spot: '#brief-doc .brf-sec:nth-of-type(4) .brf-facts',
          do: ({ ui }) => ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(4) .brf-facts') },
      ],
      get say() { return (() => {
        const g = heroRx()?.geometry;
        if (!g) return 'Shading will not work here, and the model says why.';
        return `Shading is the obvious answer, and it fails. The sun is `
          + `${words(g.peak_altitude_deg)} degrees up, almost level with the wall.`;
      })(); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.7,
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
      // "floors one to thirty-four".
      act: ({ ui }) => {
        const rx = heroRx();
        if (rx?.floors) ui.focusFloors(HERO_BIN, rx.floors[0], rx.floors[1]);
      },
    },
    {
      chapter: 'III', phase: 'city', seconds: 5.9,
      text: 'It prices the job too. That’s one wall, on one building, on one street.',
      // Section five is the one that says what the whole document rests on, and
      // it is the reason the film can print a dollar figure at all. The brief
      // closes on the next beat, which is where the chapter does.
      spot: '#brief-doc .brf-sec:nth-of-type(5)',
      act: ({ ui }) => { ui.briefSection(5); },
      cues: [
        { at: 0.50, spot: '#brief-doc .brf-sec:nth-of-type(5) .brf-consts',
          do: ({ ui }) => ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(5) .brf-consts') },
      ],
    },

    /* ------------------------------------- IV. all of them (8 × , 44.0 s)
     *
     * Out from the one building to the instrument around it. Every beat here
     * turns something on that the previous beat's claim depends on, so the
     * layer list, the clock, the two rankings, the what-if and the portfolio
     * are all seen working rather than described.
     */
    {
      chapter: 'IV', title: 'All of them', phase: 'city', seconds: 5.0,
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
      chapter: 'IV', phase: 'city', seconds: 8.1,
      spot: '#layers',
      text: `${Words(LAYERS.length)} ways to read it. Surface temperature, sun and `
        + `shade, hours above ${r0(m.event.threshold_c)}, where to act first.`,
      say: `${Words(LAYERS.length)} ways to read it. Surface temperature, sun and `
        + `shade, hours above ${words(m.event.threshold_c)}, where to act first.`,
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
      chapter: 'IV', phase: 'city', seconds: 5.6,
      spot: '#time',
      text: 'And it moves through time. Any hour, any day, or the whole year.',
      // Back to facade temperature before the clock is started, and that is not
      // a preference. `exceedance` is a total over the whole heat wave: it has
      // no hour in it, so the time controls go quiet and running the clock over
      // it changes precisely nothing. The line is "any hour of any day" and the
      // frame has to move when the hour does.
      act: ({ ui }) => { ui.setLayer('surface'); ui.play?.(); },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 6.7,
      text: typeof overlap === 'number'
        ? `Run the year and the ranking shifts. ${Words(overlap)} of that day’s `
          + `worst fifty are still worst.`
        : 'Run the year and the ranking shifts.',
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
      chapter: 'IV', phase: 'city', seconds: 6.3,
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
      chapter: 'IV', phase: 'city', seconds: 5.2,
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
      chapter: 'IV', phase: 'city', seconds: 6.1,
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
        return `And what that bought. ${spokenCount(a.person_hours_avoided)} `
          + `hours of heat nobody sits through.`;
      },
      // To the outcome, not back to the curve. This beat says what the money
      // buys, and the panel says it too, in a sentence: "At $57M this programme
      // treats 91 buildings with 292 measures. It avoids 1.88M person-hours of
      // exposure above 35 °C behind 13,353 homes." Scrolling to the chart left
      // that paragraph clipped off the bottom edge for the whole chapter, so the
      // film asserted a figure the panel was showing just out of frame, and the
      // ranges the next beat is about were never on screen at all.
      spot: '#pf-body .pf-ledger',
      act: ({ ui }) => { ui.scrollSurface('pf-body', '.pf-ledger'); },
      cues: [
        { at: 0.58, spot: '#pf-body .pf-obj',
          do: ({ ui }) => ui.scrollSurface('pf-body', '.pf-obj') },
      ],
    },
    {
      chapter: 'IV', phase: 'city', seconds: 3.6,
      spot: '#pf-body .pf-phase',
      text: 'Every building on the list is there for a reason.',
      /* This beat used to do nothing at all — no act, no cues — so the panel sat
       * exactly where the previous beat left it while the film made a claim
       * about a list that was off the bottom of the frame. The claim is about
       * the table, so the beat goes to the table. */
      act: ({ ui }) => { ui.scrollSurface('pf-body', '.pf-phase'); },
      cues: [
        { at: 0.48, spot: '#pf-body .pf-table',
          do: ({ ui }) => ui.scrollSurface('pf-body', '.pf-table') },
      ],
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
      chapter: 'V', title: 'Ask it', phase: 'city', seconds: 3.9,
      spot: '#analyst-win',
      text: 'And if the panels don’t cover it, you can just ask.',
      act: ({ ui }) => {
        ui.closePortfolio();
        ui.replayAnalyst(ANALYST_RUN, ANALYST_QUESTION);
      },
    },
    {
      chapter: 'V', phase: 'city', seconds: 4.8,
      text: 'It has the model behind it and twenty tools, and shows its working.',
      // A recorded turn replays off disk in a second or two, so by the time this
      // line is read the transcript is already at its end and sitting still.
      // These two beats walk back down it: the working first, then the answer.
      /* The analyst had the portfolio's fault: the whole console lit on the
       * beat that introduces it, then nothing at all over the two beats that
       * walk the transcript. These light the block being read. */
      spot: '#agent-scroll .workblock',
      act: ({ ui }) => { ui.openWorking(); ui.scrollSurface('agent-scroll', '.workblock'); },
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
        { at: 0.50, spot: '#agent-scroll .toolbody',
          do: ({ ui }) => ui.scrollSurface('agent-scroll', '.toolbody') },
      ],
    },
    {
      chapter: 'V', phase: 'city', seconds: 5.8,
      // What this beat says has to be what the recording above it actually did.
      // The previous run wrote nineteen scripts and re-solved the canyon six
      // times, and this line said so. This one went to the building's own
      // schedule, priced the measure, and came back with a refusal, so that is
      // what it says now.
      text: 'This one went down the tower floor by floor, priced the job, '
        + 'and told the owner no.',
      spot: '#agent-scroll .atable',
      act: ({ ui }) => { ui.scrollSurface('agent-scroll', '.atable'); },
      cues: [
        { at: 0.58, spot: '#agent-scroll .acallout',
          do: ({ ui }) => ui.scrollSurface('agent-scroll', '.acallout') },
      ],
    },
    {
      // The other silent beat, and it goes for the same reason the opening one
      // did. All this has to do is close the console and let the film's own
      // chrome clear the frame — the caption, the chapter mark and the transport
      // bar, none of which takes longer than 350ms to leave, over an interface
      // that came up two chapters ago. Two seconds covers it. Four was a held
      // shot of an application nobody was being told anything about.
      chapter: 'V', phase: 'city', seconds: 2.0,
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
  // The last line is the one place in the film a costed figure appears, and it
  // is labelled ASSUMED, because capex bands, tariffs and occupancy are stated
  // assumptions that no measurement in this study constrains (docs/DECISIONS.md).
  // Rendering one of those without the label is a bug, in the film exactly as
  // much as in the panels. It is also the line left standing through the
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
    23: { label: 'DECISION LAYER · CAPEX, TARIFF, OCCUPANCY — ASSUMED', kind: 'coords',
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

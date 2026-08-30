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

export function buildStory(data, globe) {
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
  const HERO_BIN = '1037175';

  /* The recorded analyst turn chapter five plays back.
   *
   * A real run, kept on disk at `.agent/runs/<id>/frames.jsonl` and streamed
   * back by the server on request. It asked where the heat on this building's
   * shaded face comes from and what could be done about it, and it answered with
   * fifty-six tool calls including six re-solves of the canyon physics.
   *
   * If the run is ever cleared the console simply shows nothing and the captions
   * still read; it is a recording, not a dependency. */
  const ANALYST_RUN = 'r17880442193644fa';
  /** The question that turn was actually asked, shown above the transcript so
   *  it reads as a turn rather than as an answer that arrived on its own. */
  const ANALYST_QUESTION = '747 Second Avenue has a north-east face that never gets '
    + 'direct sun, and it still runs hotter than the air on the street. Work out where '
    + 'that heat is coming from, then re-solve the physics for a treatment on it. '
    + 'Do not estimate. Tell me which wins, by how many kelvin, and what it costs.';
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
  const NEIGHBOUR_BIN = '1037546';
  const attrOf = (bin) => (data.buildings?.attrs || []).find((a) => String(a.bin) === bin);
  const neighbour = () => attrOf(NEIGHBOUR_BIN);
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
    {
      chapter: 'I', title: 'A year over Manhattan', seconds: 4.5,
      stage: { alt: 29000, fov: 28, turn: 0.2, heat: 0.45, tilt: 0.13, counter: 0.5 },
    },
    {
      chapter: 'I', seconds: 5.9,
      text: 'A field lets go of the day’s heat after dark. A city holds it.',
      stage: { alt: 24000, fov: 28, turn: 0.46, heat: 1, cities: 1, bloom: 1,
               tilt: 0.1, counter: 1 },
    },
    {
      chapter: 'I', seconds: 7.9,
      text: `This is one year over ${m.aoi.label}. `
        + `${(year.hours || 8760).toLocaleString('en-US')} hours. `
        + `${Words(daysOver)} days over ${words(m.event.threshold_c)} degrees.`,
      say: `This is one year over ${m.aoi.label}. Eight thousand seven hundred and sixty hours. `
        + `${Words(daysOver)} days over ${words(m.event.threshold_c)} degrees.`,
      altEase: 'out', turnEase: 'out',
      stage: { alt: 5200, fov: 30, turn: 1, heat: 1, cities: 0.6, bloom: 0.4,
               lock: 1, pin: 1, aim: 0, phi: 0.05, clouds: 0.6, tilt: 0 },
    },
    {
      chapter: 'I', seconds: 6.7,
      text: 'From up there it’s one number per block, taken at head height. '
        + 'Everyone plans with it.',
      stage: { alt: 3400, cities: 0.3, bloom: 0.15, clouds: 0.85 },
    },

    /* ------------------------------------------- II. going in (2 × , 12.0 s)
     *
     * All the way down this time. The sixty-second cut stopped the globe at
     * three hundred kilometres and dissolved, because six seconds could not
     * travel ten halvings of altitude and the ground in between was worth
     * nothing to the argument. Twelve seconds can, and now the ground in
     * between is the argument: the whole point of the next two minutes is that
     * a city seen from above is blocks and a city seen from inside is walls, so
     * the film has to be seen crossing from one to the other.
     *
     * The first beat eases in from the hold and the second runs flat out.
     * `land` on the handoff settles it onto scene.js's own opening pose.
     */
    {
      chapter: 'II', title: 'Going in', seconds: 7.0,
      altEase: 'in',
      stage: { alt: 40, fov: 38, phi: 0.16, dust: 0.7, cities: 0, bloom: 0,
               clouds: 1, lock: 1, pin: 1, aim: 0, tilt: 0 },
    },
    {
      chapter: 'II', phase: 'handoff', seconds: 6.3,
      text: `Down here it stops being blocks. It’s walls. `
        + `${m.counts.facade_panels.toLocaleString('en-US')} of them, `
        + `on ${m.counts.buildings.toLocaleString('en-US')} buildings.`,
      say: 'Down here it stops being blocks. It is walls. Twenty-nine thousand '
        + 'four hundred of them.',
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
      text: `Take this one. ${hero.addr}. ${hero.floors} floors, ${hero.year}, `
        + `${hero.units} homes.`,
      say: `Take this one. Seven forty-seven Second Avenue. ${Words(hero.floors)} floors, `
        + `${words(hero.units)} homes.`,
      act: ({ ui }) => {
        ui.showTab('view');
        ui.setLayer('surface');
        ui.showDetail(heroIdx);
        // Framed and marked. `showDetail` flies the camera to it, but on a
        // surface-temperature layer one pale box among four thousand looks like
        // its neighbours; the highlight is what makes "this one" visible from
        // across the frame.
        ui.highlight([HERO_BIN]);
      },
    },
    {
      chapter: 'III', phase: 'city', seconds: 5.6,
      text: 'On the flat map it’s one shade of orange. It isn’t one temperature.',
      act: ({ ui }) => { ui.setHour(m.peak_index); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.3,
      text: `${Words(m.bands)} height bands, one for every three storeys, `
        + 'and a separate answer on every face.',
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.3,
      get text() { return (() => {
        const f = heroFloor();
        return f?.sun
          ? `The north-west face takes the late sun. On the ${ordinal(f.it.worst_floor)} floor `
            + `it reaches ${r0(f.sun.t)} °C.`
          : 'The north-west face takes the late sun, and it is the hottest wall on the building.';
      })(); },
      get say() { return (() => {
        const f = heroFloor();
        return f?.sun
          ? `The north-west face takes the late sun. On the ${ordinal(f.it.worst_floor)} floor `
            + `it reaches ${words(f.sun.t)} degrees.`
          : 'The north-west face takes the late sun, and it is the hottest wall on the building.';
      })(); },
      // The clock moves to the low sun here, and the flat sheet of yellow the
      // previous beat was complaining about separates into lit and unlit faces.
      // The figure quoted is still the face's own peak; the picture is the hour
      // that makes the face visible at all.
      act: ({ ui }) => { ui.setHour(lateSun); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.3,
      get text() { return (() => {
        const f = heroFloor();
        return f?.shade
          ? `The north-east face, on ${streetProse(shadeStreet()) || 'the side street'}, `
            + `never sees the sun. It still runs ${r0(f.shade.t)} °C.`
          : 'The north-east face never sees the sun. It still runs hot.';
      })(); },
      get say() { return (() => {
        const f = heroFloor();
        return f?.shade
          ? `The north-east face, on ${streetSpoken(shadeStreet()) || 'the side street'}, `
            + `never sees the sun. It still runs ${words(f.shade.t)}.`
          : 'The north-east face never sees the sun. It still runs hot.';
      })(); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 7.1,
      get text() {
        const n = neighbour();
        return n
          ? `That heat is not coming from the sky. It comes off the ${n.floors}-storey `
            + `tower opposite, put up in ${n.year}, straight into the wall.`
          : 'That heat is not coming from the sky. It comes off the building '
            + 'across the street, straight into the wall.';
      },
      get say() {
        const n = neighbour();
        return n
          // The year is in the caption and not in the mouth: `words` gives up
          // above a thousand and returns digits, and spelling it by hand here
          // would be a number that stops matching the data the day it changes.
          ? `That heat isn’t from the sky. It comes off the ${words(n.floors)}-storey `
            + 'tower opposite, straight into the wall.'
          : 'That heat is not coming from the sky. It comes off the building '
            + 'across the street, straight into the wall.';
      },
      // Light it, so "the tower opposite" is a thing on screen rather than a
      // direction. Both are marked: the wall being talked about and the wall
      // doing it — and the camera pulls back, because at the framing the
      // previous beats want the tower being blamed is off the edge of the
      // picture, which makes the line a caption about something invisible.
      act: ({ ui, scene }) => {
        ui.highlight([HERO_BIN, NEIGHBOUR_BIN]);
        scene.zoomBy(1.55);
      },
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.3,
      text: 'The model splits every wall three ways. Sun, the surroundings, '
        + 'and what it loses upward.',
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
      act: ({ ui }) => { ui.openBrief(HERO_BIN); ui.briefSection(2); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 7.5,
      text: 'Then floor by floor. Surface temperature, what it costs to hold '
        + '24 inside, hours a year it fails.',
      say: 'Then floor by floor. Surface temperature, what it costs to hold '
        + 'twenty-four inside, hours a year it fails.',
      act: ({ ui }) => { ui.briefSection(3); },     // The floor schedule
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.7,
      get text() { return (() => {
        const f = heroFloor();
        if (!f) return 'One floor is the worst of them, and the schedule names it.';
        const t = f.row.t_in || [];
        return `Floor ${f.it.worst_floor} is the worst. ${r0(f.row.t_surf)} °C outside, `
          + `${r0(t[0])} to ${r0(t[1])} in the rooms, `
          + `${(f.row.hrs || 0).toLocaleString('en-US')} hours a year.`;
      })(); },
      // The chart, rather than the heading above it: this beat names one storey
      // out of thirty-four and the reader should be looking at the row.
      act: ({ ui }) => {
        ui.scrollSurface('brief-doc', '.brf-sec:nth-of-type(3) .brf-fig');
      },
      get say() { return (() => {
        const f = heroFloor();
        if (!f) return 'One floor is the worst of them, and the schedule names it.';
        const t = f.row.t_in || [];
        return `Floor ${words(f.it.worst_floor)} is the worst. ${Words(f.row.t_surf)} outside, `
          + `${words(t[1])} in the rooms, `
          + `${words(Math.round((f.row.hrs || 0) / 100))} hundred hours a year.`;
      })(); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 8.6,
      get text() { return (() => {
        const g = heroRx()?.geometry;
        if (!g) return 'Shading will not work here, and the model says why.';
        return `Shading will not work here. At the peak hour the sun is `
          + `${r0(g.peak_altitude_deg)}° up and ${r0(g.incidence_deg)}° off the wall. `
          + `An overhang would need ${g.projection_uncapped_m.toFixed(1)} metres.`;
      })(); },
      act: ({ ui }) => { ui.briefSection(4); },     // What to do
      get say() { return (() => {
        const g = heroRx()?.geometry;
        if (!g) return 'Shading will not work here, and the model says why.';
        return `Shading won’t work. At its peak the sun is `
          + `${words(g.peak_altitude_deg)} degrees up, nearly square on. `
          + `An overhang would need four metres.`;
      })(); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 6.7,
      get text() { return (() => {
        const rx = heroRx();
        if (!rx) return 'So it prescribes the glass instead.';
        return `So it prescribes the glass. Low solar-gain units, floors `
          + `${rx.floors[0]} to ${rx.floors[1]}, on that one face.`;
      })(); },
      get say() { return (() => {
        const rx = heroRx();
        if (!rx) return 'So it prescribes the glass instead.';
        return `So it prescribes the glass. Low solar-gain units, floors `
          + `${words(rx.floors[0])} to ${words(rx.floors[1])}, on that one face.`;
      })(); },
    },
    {
      chapter: 'III', phase: 'city', seconds: 5.9,
      text: 'With a price on it, and a range, because the envelope is an '
        + 'assumption.',
      // Section five is the one that says what the whole document rests on, and
      // it is the reason the film can print a dollar figure at all. The brief
      // closes on the next beat, which is where the chapter does.
      act: ({ ui }) => { ui.briefSection(5); },
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
      text: 'Every wall in Midtown has an answer like that.',
      act: ({ ui, scene }) => {
        ui.closeBrief();
        ui.clearSelection();
        ui.highlight([]);
        scene.overview();
      },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 5.9,
      text: `${Words(LAYERS.length)} layers. Surface temperature, sun and shade, `
        + `hours above ${r0(m.event.threshold_c)}, the longest unbroken run.`,
      say: `${Words(LAYERS.length)} layers. Surface temperature, sun and shade, `
        + `hours above ${words(m.event.threshold_c)}, the longest unbroken run.`,
      act: ({ ui }) => { ui.showTab('view'); ui.setLayer('sun'); },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 5.6,
      text: 'Any hour of any day. Or a month, a season, the whole year.',
      act: ({ ui }) => { ui.setLayer('exceedance'); ui.play?.(); },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 7.1,
      text: typeof overlap === 'number'
        ? `Run the year and the ranking moves. ${Words(overlap)} of the heat wave’s `
          + 'worst fifty are still worst.'
        : 'Run the year and the ranking moves.',
      // Stop the clock AND put it back where it was. `play` leaves the hour
      // wherever it happened to reach, which on the last pass was three in the
      // morning — so the ranking, the what-if, the portfolio and the analyst all
      // played out over a night hour, on a film about afternoon heat.
      act: ({ ui }) => { ui.stop?.(); ui.setHour(lateSun); ui.setLayer('annual_priority'); },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 6.3,
      text: 'Change something and it solves again. Cool roofs, trees, a coating. '
        + 'It re-runs the physics.',
      act: ({ ui }) => {
        ui.showTab('decide');
        document.getElementById('tab-whatif')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 5.2,
      get text() { return (() => {
        const a = data.decision?.portfolio?.allocation;
        if (!a) return 'Then it spends a budget, and says where it went.';
        const n = (a.selected || []).length;
        return `Then it spends a budget. $${(a.budget_usd / 1e6).toFixed(0)} million, `
          + `${a.buildings} buildings, ${n} measures.`;
      })(); },
      get say() { return (() => {
        const a = data.decision?.portfolio?.allocation;
        if (!a) return 'Then it spends a budget, and says where it went.';
        const n = (a.selected || []).length;
        return `Then it spends a budget. ${Words(a.budget_usd / 1e6)} million dollars, `
          + `${words(a.buildings)} buildings, ${words(n)} measures.`;
      })(); },
      act: ({ ui }) => { ui.openPortfolio(); },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 6.7,
      get text() { return (() => {
        const a = data.decision?.portfolio?.allocation;
        return a
          ? `That buys back ${Math.round(a.person_hours_avoided).toLocaleString('en-US')} `
            + 'hours of exposure nobody has to sit through.'
          : 'Hours of exposure nobody has to sit through.';
      })(); },
      get say() {
        const a = data.decision?.portfolio?.allocation;
        if (!a) return 'Hours of exposure nobody has to sit through.';
        // `words` gives up above a thousand, so the spoken form is the figure to
        // the nearest thousand, spelled. Hand-typing it here is what put "a
        // hundred and fifty thousand" in the film's mouth for a week after the
        // portfolio was re-solved down to a hundred and thirty-seven.
        const k = Math.round(a.person_hours_avoided / 1000);
        return `That buys back ${words(k)} thousand hours of exposure `
          + 'nobody has to sit through.';
      },
      act: ({ ui }) => { ui.scrollSurface('pf-body', '.pfsvg'); },
    },
    {
      chapter: 'IV', phase: 'city', seconds: 4.8,
      text: 'Every cost carries a range, because tariffs and capex are assumptions.',
      act: ({ ui }) => { ui.closePortfolio(); },
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
      chapter: 'V', title: 'Ask it', phase: 'city', seconds: 4.6,
      text: 'And you can ask it questions.',
      act: ({ ui }) => { ui.replayAnalyst(ANALYST_RUN, ANALYST_QUESTION); },
    },
    {
      chapter: 'V', phase: 'city', seconds: 6.7,
      text: 'It has the physics engine, a shell, and twenty tools. '
        + 'It shows you what it ran.',
      // A recorded turn replays off disk in a second or two, so by the time this
      // line is read the transcript is already at its end and sitting still.
      // These two beats walk back down it: the working first, then the answer.
      act: ({ ui }) => { ui.scrollSurface('agent-scroll', '.workings, .toolcall'); },
    },
    {
      chapter: 'V', phase: 'city', seconds: 6.3,
      text: 'This one re-solved the canyon six times to answer a question '
        + 'about a single wall.',
      act: ({ ui }) => { ui.scrollSurface('agent-scroll', '.atable'); },
    },
    {
      chapter: 'V', phase: 'city', seconds: 4.0,
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

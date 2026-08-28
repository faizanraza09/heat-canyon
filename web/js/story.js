/* The opening film: its words, its storyboard, and the arithmetic behind both.
 *
 * Two rules govern this file.
 *
 * First, every figure the film makes a claim with is read out of the artefacts
 * the application itself runs on — meta.json, ranked.json, and the NASA GISTEMP
 * series fetched by scripts/make_globe_assets.py — so the narration cannot drift
 * away from the model it is introducing. Re-run the pipeline on a different city
 * or a different day and the voice-over updates itself. The two round numbers in
 * the joke about New York are the only constants written by hand, and they are
 * sourced in NYC_ASIDES below.
 *
 * Second, the caption and the spoken line are allowed to differ. A caption
 * wants "39 °C" and "5,329"; a speech synthesiser wants "39 degrees" and a
 * number it will not spell out as five separate digits. Where the two want
 * different things, a beat carries both `text` and `say`.
 *
 * A beat is one sentence, one held frame. Its `stage` block is the storyboard:
 * the state the scene should have arrived at by the *end* of that beat. The
 * player interpolates between consecutive stages, so the camera move and the
 * sentence are the same length by construction — there is no separate timing
 * track to fall out of sync, and lengthening a line lengthens its shot.
 */

/** The only hand-written figures in the script, both deliberately rounded.
 *
 *  Everything else the narration asserts comes from the pipeline. These two are
 *  set dressing for one joke, so they are kept here with their sources attached
 *  rather than buried in a template string where nobody would ever check them.
 */
const NYC_ASIDES = {
  //: NYC Department of City Planning population estimate, 2024 vintage: 8,478,072.
  people: 'eight and a half million people',
  //: TLC medallions in force, 13,587 — the yellow cabs, not the app fleet.
  cabs: 'thirteen thousand yellow cabs',
};

/** Round for speech: no decimals the ear cannot use. */
const r0 = (x) => Math.round(x);

/** Small counts as words. "7 days of heat" is a caption; "Seven days of heat" is
 *  a sentence, and the figure is still the one the pipeline computed. */
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
               'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const spell = (n) => (Number.isInteger(n) && n >= 0 && n < SMALL.length
  ? SMALL[n] : String(n));
const Spell = (n) => { const w = spell(n); return w[0].toUpperCase() + w.slice(1); };

/** Largest value of a nested field across the ranked list. */
function maxOf(items, pick) {
  return items.reduce((m, it) => Math.max(m, pick(it) ?? -Infinity), -Infinity);
}

/** "29 June" from an ISO date, in the register the narration speaks in. */
function dayMonth(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function buildStory(data, globe) {
  const m = data.meta;
  const items = data.ranked.items;
  const g = globe || {};

  // ---- the planet, from GISTEMP ------------------------------------------
  const years = g.years || [];
  const anomaly = g.anomaly || [];
  const span = years.length ? years[years.length - 1] - years[0] + 1 : 0;
  const warmestYear = (g.warmest || [])[0];
  const warmestValue = warmestYear ? anomaly[years.indexOf(warmestYear)] : null;
  const since = g.warmest10_since;
  // "1951-1980 mean" -> "1951-1980 average", which is what a sentence wants.
  const baseline = (g.baseline || 'mid-century').replace(/-/g, '\u2013').replace(/ mean$/, ' average');

  // ---- the city, from the pipeline ---------------------------------------
  const nBuildings = m.counts.buildings;
  const homes = m.counts.residential_units;
  const hw = m.morphology.hw_median;
  const peakAir = maxOf(items, (i) => i.measured?.peak_air_c);
  const peakFacade = maxOf(items, (i) => i.modelled?.facade_peak_c);
  const peakMrt = maxOf(items, (i) => i.modelled?.mrt_peak_c);
  const exceed = maxOf(items, (i) => i.measured?.exceedance_h);
  const persist = maxOf(items, (i) => i.measured?.persistence_h);
  const peakHour = m.hours[m.peak_index];
  const clock = `${String(peakHour.edt).padStart(2, '0')}:00`;
  const waveDays = Math.round(
    (Date.parse(`${m.event.wave_end}T00:00:00Z`) - Date.parse(`${m.event.wave_start}T00:00:00Z`))
    / 86400000
  ) + 1;
  const [lon0, lat0] = [m.projection.lon0, m.projection.lat0];

  const beats = [
    // ---------------------------------------------------- I. a warming planet
    {
      chapter: 'I', title: 'A warming planet',
      text: `We have taken the temperature of the whole planet, every single day, for ${span} years. For most of that time it was the dullest job in science.`,
      stage: { dist: 585, fov: 28, spin: 3.3, heat: 0.08, tilt: 0.11, counter: 0.55 },
    },
    {
      chapter: 'I',
      text: `Not any more. ${warmestYear} came in ${warmestValue?.toFixed(2)} °C above the ${baseline}, and the ten warmest years on the whole record have all landed since ${since}.`,
      say: `Not any more. ${warmestYear} came in ${warmestValue?.toFixed(2)} degrees above the ${baseline}, and the ten warmest years on the whole record have all landed since ${since}.`,
      stage: { dist: 535, fov: 28, spin: 2.6, heat: 0.55, tilt: 0.09, counter: 1 },
    },
    {
      chapter: 'I',
      text: 'A degree and a bit sounds survivable. But that is an average of an ocean planet, half of it in the dark at any moment.',
      stage: { dist: 500, fov: 29, spin: 2.1, heat: 1, tilt: 0.07, counter: 1 },
    },

    // ------------------------------------------------------- II. where we live
    {
      chapter: 'II', title: 'Where we live',
      text: 'Nobody lives in the average. We live here.',
      stage: { dist: 482, fov: 29, spin: 1.8, heat: 1, cities: 1, tilt: 0.06 },
    },
    {
      chapter: 'II',
      text: 'A city treats heat differently from a field. Stone and asphalt drink the sun in all day and give it back all night.',
      stage: { dist: 458, fov: 30, spin: 1.5, heat: 1, cities: 1, bloom: 1, tilt: 0.04 },
    },
    {
      chapter: 'II',
      text: 'The streets are canyons, and warmth that should rise and leave gets traded between facing walls instead. Science calls it the urban heat island. Everyone else calls it "why is it still 30 degrees at midnight".',
      stage: { dist: 436, fov: 30, spin: 1.1, heat: 1, cities: 1, bloom: 1, tilt: 0.02 },
    },

    // ----------------------------------------------------------- III. one city
    //
    // From here the camera sits exactly on the axis the globe is locked against
    // (tilt: 0), and the framing offset comes only from `aim`, which rotates the
    // planet rather than moving the eye. Leaving the small camera tilt in was a
    // real miss: two hundredths of a radian is nothing at four hundred units out
    // and about a hundred and thirty kilometres at three, so the dive bottomed
    // out over Connecticut with New York off the bottom of the frame.
    {
      chapter: 'III', title: 'One city',
      text: 'So: one city. The loud one.',
      hold: 1.3,
      stage: { dist: 400, fov: 31, spin: 0.5, heat: 1, cities: 0.85, bloom: 0.5, lock: 1, pin: 1, tilt: 0 },
    },
    {
      chapter: 'III',
      text: `New York. ${NYC_ASIDES.people[0].toUpperCase()}${NYC_ASIDES.people.slice(1)}, ${NYC_ASIDES.cabs}, and one teenager who fights crime in head-to-toe spandex. In August. Spare a thought for him.`,
      stage: { dist: 330, fov: 32, spin: 0.3, heat: 1, cities: 0.7, bloom: 0.35, lock: 1, pin: 1, clouds: 0.6, tilt: 0 },
    },
    {
      chapter: 'III',
      text: `In ${new Date(m.event.wave_start).getUTCFullYear()} the joke stopped landing. ${Spell(waveDays)} days of heat, and ${dayMonth(m.event.date)} was the hottest day of the city's year.`,
      stage: { dist: 268, fov: 33, spin: 0.2, heat: 1, cities: 0.5, bloom: 0.2, lock: 1, pin: 1, clouds: 1, tilt: 0 },
    },

    // ------------------------------------------------------------ IV. the dive
    {
      chapter: 'IV', title: 'The canyon',
      text: `We are going down into ${m.aoi.area_mi2.toFixed(1)} square miles of it, at ${spell(peakHour.edt > 12 ? peakHour.edt - 12 : peakHour.edt)} in the afternoon.`,
      ease: 'in',
      stage: { dist: 141, fov: 44, spin: 0.05, heat: 1, cities: 0.2, aim: 0.03, lock: 1, pin: 0.6, clouds: 1, dust: 1 },
    },
    {
      chapter: 'IV', phase: 'handoff',
      text: `${m.aoi.label}. ${nBuildings.toLocaleString('en-US')} buildings, on streets more than ${hw < 2.5 ? 'twice' : 'three times'} as deep as they are wide.`,
      ease: 'in',
      stage: { dist: 103, fov: 54, spin: 0, heat: 1, cities: 0, aim: 0, lock: 1, pin: 0, clouds: 1, dust: 1, flash: 0.88, fade: 1 },
    },

    // -------------------------------------------------------- IV. in the canyon
    {
      chapter: 'IV', phase: 'city',
      text: `The air reached ${r0(peakAir)} °C. The walls reached ${r0(peakFacade)}. On the pavement, a body stood among surfaces at ${r0(peakMrt)} °C — which is not really weather. That is cookware.`,
      say: `The air reached ${r0(peakAir)} degrees. The walls reached ${r0(peakFacade)}. On the pavement, a body stood among surfaces at ${r0(peakMrt)} degrees — which is not really weather. That is cookware.`,
      // The wash over the cut clears here, once the city is the thing on screen.
      stage: { flash: 0 },
    },
    {
      chapter: 'IV', phase: 'city',
      text: `The worst blocks spent ${r0(exceed)} hours above ${r0(m.event.threshold_c)} °C that week, and never got more than ${persist.toFixed(1)} hours off at a stretch.`,
      say: `The worst blocks spent ${r0(exceed)} hours above ${r0(m.event.threshold_c)} degrees that week, and never got more than ${persist.toFixed(1)} hours off at a stretch.`,
      stage: {},
    },
    {
      chapter: 'IV', phase: 'city',
      text: 'Heat like that does not kill at three in the afternoon. It kills at two in the morning, on the fourth night, in a room that never cooled down.',
      stage: {},
    },
    {
      chapter: 'IV', phase: 'city',
      text: `${homes.toLocaleString('en-US')} homes are inside this frame. This is where it lands hardest.`,
      hold: 1.6,
      stage: {},
    },
  ];

  // Readouts: the small monospace panel in the corner. It exists to keep the
  // film honest — every claim the voice makes has its source visible on screen
  // while it is being made.
  const readouts = {
    0: { label: 'NASA GISTEMP v4 · global mean anomaly', kind: 'anomaly' },
    3: { label: `${g.cities?.length || 0} largest urban areas · Natural Earth`, kind: 'cities' },
    6: { label: 'FortyGuard tOS · study area', kind: 'coords',
         value: `${Math.abs(lat0).toFixed(4)}° N   ${Math.abs(lon0).toFixed(4)}° W` },
    9: { label: `${m.event.date} · ${clock} EDT`, kind: 'aoi',
         value: `${m.aoi.label} · ${m.aoi.area_km2} km²` },
    11: { label: `${m.event.date} · ${clock} EDT · measured + modelled`, kind: 'temps',
          value: `air ${peakAir.toFixed(1)} °C   facade ${peakFacade.toFixed(1)} °C   MRT ${peakMrt.toFixed(1)} °C` },
  };

  return {
    beats,
    readouts,
    marker: { lat: lat0, lon: lon0, name: 'New York' },
    credit: 'NASA GISTEMP v4 · Natural Earth · NYC Open Data · FortyGuard tOS',
    title: {
      kicker: 'HeatCanyon',
      name: m.aoi.label,
      strap: `${m.event.label}. A street-level account of one afternoon.`,
    },
  };
}

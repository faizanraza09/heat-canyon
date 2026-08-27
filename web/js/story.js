/* The opening film: its words, its storyboard, and the arithmetic behind both.
 *
 * Two rules govern this file.
 *
 * First, no number in the narration is typed here. Every figure is read out of
 * the same artefacts the application itself runs on — meta.json, ranked.json,
 * and the NASA GISTEMP series fetched by scripts/make_globe_assets.py — so the
 * film cannot drift away from the model it is introducing. Re-run the pipeline
 * with a different city or a different day and the voice-over updates itself.
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

/** Round for speech: no decimals the ear cannot use. */
const r0 = (x) => Math.round(x);

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
      text: `${span} years of continuous measurement. For most of that record, the temperature of the whole planet moved by tenths of a degree.`,
      stage: { dist: 470, fov: 30, spin: 2.6, heat: 0.08, tilt: 0.10, counter: 1 },
    },
    {
      chapter: 'I',
      text: `The warmest year in it is ${warmestYear}, ${warmestValue?.toFixed(2)} °C above the mid-century normal. All ten of the warmest have come since ${since}.`,
      say: `The warmest year in it is ${warmestYear} — ${warmestValue?.toFixed(2)} degrees above the mid-century normal. All ten of the warmest have come since ${since}.`,
      stage: { dist: 390, fov: 30, spin: 2.0, heat: 0.55, tilt: 0.08, counter: 1 },
    },
    {
      chapter: 'I',
      text: 'One degree, averaged across an ocean planet, half of it in darkness. It tells you nothing about what an afternoon feels like on the ground.',
      stage: { dist: 340, fov: 31, spin: 1.6, heat: 1, tilt: 0.05, counter: 1 },
    },

    // ------------------------------------------------------- II. where we live
    {
      chapter: 'II', title: 'Where we live',
      text: 'Because nobody lives on the average. We live here.',
      stage: { dist: 320, fov: 32, spin: 1.4, heat: 1, cities: 1, tilt: 0.04 },
    },
    {
      chapter: 'II',
      text: 'A city takes the sun in all day and gives it back all night. Its streets are canyons; the sky they can see is a strip.',
      stage: { dist: 300, fov: 33, spin: 1.2, heat: 1, cities: 1, bloom: 1, tilt: 0.02 },
    },
    {
      chapter: 'II',
      text: 'Heat that should rise and leave is traded between facing walls instead. The name for the result is the urban heat island.',
      stage: { dist: 285, fov: 33, spin: 0.9, heat: 1, cities: 1, bloom: 1, tilt: 0 },
    },

    // ----------------------------------------------------------- III. one city
    {
      chapter: 'III', title: 'One city',
      text: 'One of them keeps unusually good records.',
      stage: { dist: 265, fov: 33, spin: 0.4, heat: 1, cities: 0.85, bloom: 0.5, lock: 1, pin: 1 },
    },
    {
      chapter: 'III',
      text: `${dayMonth(m.event.wave_start)} ${new Date(m.event.wave_start).getUTCFullYear()}: ${waveDays} days of heat over New York. ${dayMonth(m.event.date)} was the hottest day of the city's summer.`,
      stage: { dist: 205, fov: 34, spin: 0.2, heat: 1, cities: 0.5, bloom: 0.2, lock: 1, pin: 1, clouds: 1 },
    },

    // ------------------------------------------------------------ IV. the dive
    {
      chapter: 'IV', title: 'The canyon',
      text: `We are going to stand in ${m.aoi.area_mi2.toFixed(1)} square miles of it, on that afternoon, at ${clock}.`,
      say: `We are going to stand in ${m.aoi.area_mi2.toFixed(1)} square miles of it, on that afternoon, at ${peakHour.edt > 12 ? peakHour.edt - 12 : peakHour.edt} in the afternoon.`,
      ease: 'in',
      stage: { dist: 118, fov: 46, spin: 0.05, heat: 1, cities: 0.2, lock: 1, pin: 0.6, clouds: 1, dust: 1 },
    },
    {
      chapter: 'IV', phase: 'handoff',
      text: `${m.aoi.label}. ${nBuildings.toLocaleString('en-US')} buildings, on streets more than ${hw < 2.5 ? 'twice' : 'three times'} as deep as they are wide.`,
      ease: 'in',
      stage: { dist: 103, fov: 54, spin: 0, heat: 1, cities: 0, lock: 1, pin: 0, clouds: 1, dust: 1, flash: 1, fade: 1 },
    },

    // -------------------------------------------------------- IV. in the canyon
    {
      chapter: 'IV', phase: 'city',
      text: `${clock}. The air reached ${r0(peakAir)} °C. The walls reached ${r0(peakFacade)} °C. On the pavement, in the sun, a body stood among surfaces at ${r0(peakMrt)} °C.`,
      say: `${peakHour.edt > 12 ? peakHour.edt - 12 : peakHour.edt} in the afternoon. The air reached ${r0(peakAir)} degrees. The walls reached ${r0(peakFacade)}. On the pavement, in the sun, a body stood among surfaces at ${r0(peakMrt)} degrees.`,
      stage: {},
    },
    {
      chapter: 'IV', phase: 'city',
      text: `The worst blocks spent ${r0(exceed)} hours of that week above ${r0(m.event.threshold_c)} °C, and never cooled for more than ${persist.toFixed(1)} hours at a stretch.`,
      say: `The worst blocks spent ${r0(exceed)} hours of that week above ${r0(m.event.threshold_c)} degrees, and never cooled for more than ${persist.toFixed(1)} hours at a stretch.`,
      stage: {},
    },
    {
      chapter: 'IV', phase: 'city',
      text: `${homes.toLocaleString('en-US')} homes are inside this frame. This is where the heat lands hardest.`,
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
    8: { label: `${m.event.date} · ${clock} EDT`, kind: 'aoi',
         value: `${m.aoi.label} · ${m.aoi.area_km2} km²` },
    10: { label: `${m.event.date} · ${clock} EDT · measured + modelled`, kind: 'temps',
          value: `air ${peakAir.toFixed(1)} °C   facade ${peakFacade.toFixed(1)} °C   MRT ${peakMrt.toFixed(1)} °C` },
  };

  return {
    beats,
    readouts,
    marker: { lat: lat0, lon: lon0, name: 'New York', firstBeat: 6 },
    credit: 'NASA GISTEMP v4 · Natural Earth · NYC Open Data · FortyGuard tOS Enterprise API',
    title: {
      kicker: 'HeatCanyon',
      name: m.aoi.label,
      strap: `${m.event.label}. A street-level account of one afternoon.`,
    },
  };
}

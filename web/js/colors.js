/* Colour ramps, and the temperature they are anchored to.
 *
 * One heat ramp, used for every quantity the model draws.
 *
 * This replaces an earlier scheme that gave temperature inferno, duration
 * cividis and priority a third ramp of its own, on the reasoning that different
 * physical quantities should not invite comparison. The design overhaul takes
 * the opposite view and it is the better one for this instrument: the panels
 * carry one legend, in one place, and the viewer learns to read it once. Five
 * ramps meant five things to learn and a legend whose meaning changed under the
 * cursor. Comparability is handled by the axis labels, which always name the
 * unit, rather than by withholding a shared colour language.
 *
 * The ramp runs deep blue through pale blue and a near-neutral cream into amber,
 * orange and a deep red. Cold is blue, hot is red, and the middle is the pale
 * hinge between them.
 *
 * HOW IT GOT HERE, AND WHY THE COLD END IS BLUE
 *
 * It was inferno's family first — near-black indigo, through magenta and orange,
 * into a pale cream — chosen because it is monotonic in lightness and because
 * that order is physically true. Heat a bar of steel and it glows dull red, then
 * orange, then yellow, then white; "red-hot" is the coolest visible glow and
 * "white-hot" the hottest, which is why inferno, magma and FLIR's ironbow all
 * end pale.
 *
 * It was read backwards by everyone who looked at it, so the ramp was turned
 * round: pale straw at the cold end into deep red at the hot end. That fixed the
 * direction and left a different problem, which is the one this version is for.
 * A ramp that begins at pale straw has no cold end. It has a *less hot* end.
 * Straw at the bottom of a January scale and straw at the bottom of a July scale
 * are the same colour standing for temperatures thirty kelvin apart, and nothing
 * in the frame said so. Giving the bottom of the ramp a colour nobody would ever
 * call warm is half of the fix; the other half is TEMP_DOMAIN below, which stops
 * the bottom of the ramp from moving.
 *
 * WHAT THE DIRECTION COSTS, AND WHAT IS DONE ABOUT IT
 *
 *  - It is no longer monotonic in lightness. It cannot be: two saturated ends
 *    and a pale middle is what "diverging" means, and a diverging ramp is what
 *    blue-cold-red-hot is. So a −20 °C wall and a +60 °C wall have the same
 *    luminance and greyscale can no longer tell them apart. The compensation is
 *    that the two ends are now the one pair of hues that survives every common
 *    form of colour blindness, which the straw-to-red version did not: the old
 *    ramp put its whole span in the red-green axis deuteranopes lose.
 *  - Both ends are dark against a near-black shell, where before only the hot
 *    end was. They are held at exactly the same distance from it — rgb(44,82,145)
 *    and rgb(163,26,34) are both 2.58:1 against #0A0908 — so neither end is the
 *    one that vanishes, and the pale middle carries most of the frame anyway.
 *  - Darkness still means two things at once: further from 20 °C, and further
 *    back. Everything that used to push a surface back by darkening it still
 *    works by desaturating instead — see the ambient-occlusion floor and the
 *    dimming rule in scene.js.
 *  - Compositing over the photoreal layer still cannot be additive. See the note
 *    in photoreal.js on why the operator changed and what of the original fix
 *    survives; the argument there was about the hot end being dark, and it now
 *    applies to both ends.
 *
 * It keeps the property that never depended on direction: no saturated green
 * band to throw false edges. The hinge at t=0.5 passes from pale blue to cream
 * through a desaturated neutral — hue jumps 195 deg to 57 deg across two stops at
 * roughly ten per cent saturation — which is a pale grey to the eye rather than
 * the green that makes jet unreadable. The stops stay deliberately uneven, with
 * the warm half stretched, because that is where the finding is.
 *
 * Scenario deltas keep their own diverging ramp, and it is now the same colour
 * language rather than a competing one: blue means cooler in both, which is what
 * a negative delta is.
 */

/** The heat ramp, as [position, rgb] stops. Uneven by design.
 *
 * Read against TEMP_DOMAIN, the positions land on round temperatures: 0.25 is
 * 0 °C, 0.50 is 20 °C, 0.6875 is the 35 °C exceedance threshold — which is why
 * the ramp has turned decisively amber by the time a surface crosses it — and
 * 0.75 is 40 °C. That alignment is the reason the stops sit where they do. */
const CANYON = [
  [0.00, [ 44,  82, 145]],
  [0.16, [ 68, 124, 178]],
  [0.32, [126, 170, 201]],
  [0.44, [186, 205, 214]],
  [0.52, [232, 224, 196]],
  [0.62, [249, 205, 124]],
  [0.74, [245, 158,  76]],
  [0.86, [229, 100,  52]],
  [1.00, [163,  26,  34]],
];

/** The absolute temperature scale, degC. Every temperature the model paints is
 *  read against this and nothing else.
 *
 * THIS IS THE POINT OF THE WHOLE FILE. A colour is worth having only if it means
 * the same thing twice, and until this constant existed it did not.
 *
 * The domain used to be recomputed from whichever period was loaded — the 0.2 to
 * 99.8 percentiles of that month's own solved field. Measured across the thirteen
 * solved periods, that put January's scale at −8.2 to 11.7 °C and July's at 22.2
 * to 45.6 °C. A wall at −2 °C in January and a wall at 28 °C in July therefore
 * landed within a few per cent of each other on the ramp and were painted the
 * same amber. Scrubbing from January to July showed a city that barely changed
 * colour, which is the exact opposite of the truth, and the legend's figures
 * moved underneath to make it arithmetically defensible. Nobody reads the legend
 * on every scrub. They read the colour.
 *
 * So the scale is fixed, and fixed at round numbers, because a viewer who has
 * learned that mid-blue is freezing and amber is dangerous should never have to
 * unlearn it. −20 °C covers the year's coldest solved surface (the annual t_min
 * plane bottoms at −23 °C on a handful of panels on one January night, which
 * clamps); 60 °C covers the hottest (the heat-wave day's 99.8th percentile is
 * 55.9 °C and its maximum 61.2 °C, which also clamps). Clamping the last
 * fractions of a per cent at both ends is the price of round numbers, and it is
 * worth it.
 *
 * WHAT THIS COSTS, STATED PLAINLY. A fixed 80 K scale spends only as much of the
 * ramp on a day as that day actually spans. A January day covers about eight
 * kelvin, so the whole city renders in one narrow band of blue with little
 * internal structure. That was measured before, on a wider domain, and read as
 * "the city is flat". It is not a rendering failure: in January the city IS
 * flat, and eleven per cent of the ramp is the honest amount of colour for eight
 * kelvin of variation. The heat-wave day spans twenty-one kelvin and gets thirty
 * per cent of the ramp, running cream through orange into red, because that is
 * the day where the finding is.
 *
 * Air and surface deliberately share this. A wall at 35 °C and the air at 35 °C
 * are now the same colour, which is the comparison the instrument is built to
 * invite. Air never reaches the top quarter of the scale, and that is not waste
 * — it is the measurement. The one exception is the ground air layer, which
 * spans one to two kelvin across the whole AOI at any hour and is contrast
 * stretched for spatial pattern; scene.js `_paintGround` says so where it does
 * it.
 *
 * Quantities that are not temperatures — sunlit hours, degree-hours, dose,
 * priority — keep their own domains. They share the ramp, not the scale. */
export const TEMP_DOMAIN = [-20, 60];

/** The same stops as a CSS gradient, so a legend swatch and a painted pixel
 *  cannot drift apart. */
export const CANYON_CSS =
  'linear-gradient(90deg, rgb(44,82,145) 0%, rgb(68,124,178) 16%, rgb(126,170,201) 32%,'
  + ' rgb(186,205,214) 44%, rgb(232,224,196) 52%, rgb(249,205,124) 62%,'
  + ' rgb(245,158,76) 74%, rgb(229,100,52) 86%, rgb(163,26,34) 100%)';

/** Sun and shade is categorical, not continuous.
 *
 * These used to be the two ends of the ramp, so the layer visibly belonged to
 * it. They are deliberately no longer, and the exception is worth stating: the
 * ramp's hot end is now dark, and taking it literally would draw sunlit walls
 * darker than shaded ones. Light-means-lit is a more direct mapping than any
 * ramp convention — it is not a convention at all, it is what light does — and
 * an encoding that fought it would be unreadable however consistent it was. So
 * shade stays dark and sun stays bright, and this layer alone sits outside the
 * ramp's direction. */
export const SHADE_RGB = [44, 38, 46];
export const SUNLIT_RGB = [238, 184, 102];
export const SUN_CSS =
  `linear-gradient(90deg, rgb(${SHADE_RGB}) 0 50%, rgb(${SUNLIT_RGB}) 50% 100%)`;

const DIVERGING = [
  [58, 96, 122], [96, 132, 150], [148, 172, 180], [206, 210, 206], [237, 231, 220],
  [236, 198, 168], [223, 155, 116], [206, 108, 70], [176, 62, 44],
];

/** Interpolate a ramp given as [position, rgb] stops. */
function stopped(stops, t) {
  if (!isFinite(t)) return [58, 54, 50];
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      return [
        Math.round(a[1][0] + (b[1][0] - a[1][0]) * k),
        Math.round(a[1][1] + (b[1][1] - a[1][1]) * k),
        Math.round(a[1][2] + (b[1][2] - a[1][2]) * k),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** Interpolate a ramp given as evenly spaced rgb triples. */
function even(list, t) {
  if (!isFinite(t)) return [58, 54, 50];
  t = Math.min(1, Math.max(0, t));
  const x = t * (list.length - 1);
  const i = Math.min(list.length - 2, Math.floor(x));
  const f = x - i;
  const a = list[i], b = list[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export const RAMPS = {
  temperature: (t) => stopped(CANYON, t),
  duration:    (t) => stopped(CANYON, t),
  priority:    (t) => stopped(CANYON, t),
  diverging:   (t) => even(DIVERGING, t),
};

export function css(rgb, alpha) {
  return alpha === undefined
    ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** CSS linear-gradient string for a legend swatch. The heat ramp returns its
 *  authored stops verbatim rather than a resampled approximation of them. */
export function gradient(name, steps = 24) {
  if (name === 'temperature' || name === 'duration' || name === 'priority') return CANYON_CSS;
  const f = RAMPS[name] || RAMPS.temperature;
  const out = [];
  for (let i = 0; i < steps; i++) out.push(css(f(i / (steps - 1))));
  return `linear-gradient(90deg, ${out.join(',')})`;
}

/** Normalise a value into 0..1 against a domain, clamped. */
export function norm(v, lo, hi) {
  if (!isFinite(v) || hi <= lo) return NaN;
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

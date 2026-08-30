/* Colour ramps.
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
 * The ramp runs pale straw through amber and orange into a deep red, and the
 * direction is the point: red is the hot end.
 *
 * It was inferno's family before this — near-black indigo, through magenta and
 * orange, into a pale cream — chosen because it is monotonic in lightness and
 * because that order is physically true. Heat a bar of steel and it glows dull
 * red, then orange, then yellow, then white; "red-hot" is the coolest visible
 * glow and "white-hot" the hottest, which is why inferno, magma and FLIR's
 * ironbow all end pale. It is also what makes those ramps survive greyscale and
 * colour-blindness.
 *
 * It was still read backwards. A viewer looking at this instrument sees red and
 * concludes hot, and no amount of correctness in the encoding survives being
 * misread by the audience it was drawn for. So the convention wins over the
 * physics here, deliberately, and the costs are taken on the chin below.
 *
 * What it costs, and what is done about it:
 *
 *  - The hottest surfaces are now the darkest, on a near-black shell. The hot
 *    end stops at rgb(163,26,34) rather than going deeper, which keeps it about
 *    2.6:1 against #0A0908 — dim, but never lost in it. Going further into
 *    oxblood, which would read as "hotter" still, would put the finding below
 *    the floor of the frame.
 *  - Darkness now means two things at once: hotter, and further back. Anything
 *    that used to push a surface back by darkening it had to stop — see the
 *    ambient-occlusion floor and the dimming rule in scene.js, both of which
 *    now work by desaturating instead.
 *  - Compositing over the photoreal layer can no longer be additive, because
 *    adding a dark red to a photograph does almost nothing. See the note in
 *    photoreal.js on why the operator changed and what of the original fix
 *    survives.
 *
 * It keeps the properties that do not depend on direction: no green band to
 * throw false edges, monotonic in lightness (descending now rather than
 * ascending, so greyscale and colour-blind reading still work), and stops that
 * are deliberately uneven, with the hot end stretched because that is where the
 * finding is.
 *
 * Scenario deltas keep a diverging ramp centred on zero, because there the sign
 * carries the meaning: some interventions make some metrics worse.
 */

/** The heat ramp, as [position, rgb] stops. Uneven by design. */
const CANYON = [
  [0.00, [246, 232, 176]],
  [0.20, [249, 206, 122]],
  [0.42, [244, 160, 78]],
  [0.62, [231, 112, 54]],
  [0.82, [205, 58, 44]],
  [1.00, [163, 26, 34]],
];

/** The same stops as a CSS gradient, so a legend swatch and a painted pixel
 *  cannot drift apart. */
export const CANYON_CSS =
  'linear-gradient(90deg, rgb(246,232,176) 0%, rgb(249,206,122) 20%, rgb(244,160,78) 42%,'
  + ' rgb(231,112,54) 62%, rgb(205,58,44) 82%, rgb(163,26,34) 100%)';

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

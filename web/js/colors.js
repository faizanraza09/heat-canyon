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
 * The ramp itself is inferno's family — near-black indigo through magenta and
 * orange into a pale cream — desaturated and warmed to sit inside the near-black
 * #0A0908 shell without vibrating against it. It keeps the two properties that
 * made inferno the right choice: it is monotonic in lightness, so it survives
 * greyscale and reads unambiguously as "hot", and it has no green band to throw
 * false edges. Its stops are deliberately uneven — the hot end is stretched,
 * because that is where the finding is.
 *
 * Scenario deltas keep a diverging ramp centred on zero, because there the sign
 * carries the meaning: some interventions make some metrics worse.
 */

/** The heat ramp, as [position, rgb] stops. Uneven by design. */
const CANYON = [
  [0.00, [18, 16, 30]],
  [0.22, [62, 26, 64]],
  [0.45, [136, 46, 60]],
  [0.68, [199, 96, 42]],
  [0.86, [232, 166, 78]],
  [1.00, [247, 231, 190]],
];

/** The same stops as a CSS gradient, so a legend swatch and a painted pixel
 *  cannot drift apart. */
export const CANYON_CSS =
  'linear-gradient(90deg, rgb(18,16,30) 0%, rgb(62,26,64) 22%, rgb(136,46,60) 45%,'
  + ' rgb(199,96,42) 68%, rgb(232,166,78) 86%, rgb(247,231,190) 100%)';

/** Sun and shade is categorical, not continuous: two colours taken from the
 *  ends of the same ramp so the layer still belongs to it. */
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

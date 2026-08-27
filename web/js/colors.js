/* Colour ramps.
 *
 * Choices, and why:
 *
 * - Temperature uses **inferno**. It is perceptually uniform (equal steps in
 *   value look like equal steps in colour, so the eye is not misled about where
 *   the gradients are), it is monotonic in lightness so it survives being
 *   printed or screenshotted in greyscale, and it is safe for all three common
 *   forms of colour blindness. It also reads unambiguously as "hot", which
 *   viridis and cividis do not. Turbo is deliberately avoided: it is pretty but
 *   not perceptually uniform, and its green band creates false edges.
 *
 * - Exposure *duration* uses **cividis**, a different ramp on purpose. Hours
 *   above a threshold is a different physical quantity from temperature, and
 *   giving it the same ramp would invite the viewer to compare two things that
 *   are not comparable.
 *
 * - Scenario deltas use a **diverging** ramp centred on zero, because the sign
 *   carries the meaning: some interventions make some metrics worse.
 */

const INFERNO = [
  [0,0,4],[22,11,57],[66,10,104],[106,23,110],[147,38,103],
  [188,55,84],[221,81,58],[243,120,25],[252,165,10],[246,215,70],[252,255,164],
];

const CIVIDIS = [
  [0,32,77],[0,48,111],[57,72,107],[87,93,109],[112,113,115],
  [138,135,121],[166,157,117],[196,181,108],[228,207,91],[255,234,70],
];

const DIVERGING = [
  [49,102,177],[95,145,205],[152,190,224],[209,224,238],[244,244,244],
  [247,220,196],[238,178,143],[218,124,96],[186,66,60],
];

const PRIORITY = [
  [26,26,46],[62,32,62],[100,38,72],[139,44,74],[177,52,70],
  [209,68,64],[232,95,64],[245,132,79],[250,175,110],[253,214,155],
];

function ramp(stops, t) {
  if (!isFinite(t)) return [70, 78, 92];
  t = Math.min(1, Math.max(0, t));
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export const RAMPS = {
  temperature: (t) => ramp(INFERNO, t),
  duration:    (t) => ramp(CIVIDIS, t),
  priority:    (t) => ramp(PRIORITY, t),
  diverging:   (t) => ramp(DIVERGING, t),
};

export function css(rgb, alpha) {
  return alpha === undefined
    ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** CSS linear-gradient string for a legend swatch. */
export function gradient(name, steps = 24) {
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

/* Data loading. Everything arrives pre-solved from the Python pipeline —
 * the browser does no physics, so what is on screen is provably the same field
 * the validation script checked. */

const BASE = './data';

async function json(name) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

async function int16(name, scale = 100) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const raw = new Int16Array(buf);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / scale;
  return out;
}

async function bits(name) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function load(onProgress = () => {}) {
  const steps = [
    ['meta.json',      'study area and provenance'],
    ['buildings.json', 'building footprints'],
    ['facades.json',   'facade panel geometry'],
    ['canyons.json',   'canyon cross-sections'],
    ['tiles.json',     'FortyGuard temperature field'],
    ['ranked.json',    'exposure ranking'],
    ['scenarios.json', 'intervention scenarios'],
    ['thermal.bin',    'facade surface temperatures'],
    ['air.bin',        'air temperature profiles'],
    ['air_sigma.bin',  'uncertainty bands'],
    ['sunlit.bin',     'shadow masks'],
  ];
  const out = {};
  let done = 0;
  const tick = (label) => { done++; onProgress(done / steps.length, label); };

  out.meta = await json('meta.json');            tick('study area');
  out.buildings = await json('buildings.json');  tick('building footprints');
  out.facades = await json('facades.json');      tick('facade geometry');
  out.canyons = await json('canyons.json');      tick('canyon cross-sections');
  out.tiles = await json('tiles.json');          tick('temperature field');
  out.ranked = await json('ranked.json');        tick('exposure ranking');
  out.scenarios = await json('scenarios.json');  tick('scenarios');
  out.thermal = await int16('thermal.bin');      tick('facade temperatures');
  out.air = await int16('air.bin');              tick('air profiles');
  out.airSigma = await int16('air_sigma.bin');   tick('uncertainty');
  out.sunlit = await bits('sunlit.bin');         tick('shadow masks');

  // Index helpers ---------------------------------------------------------
  const nPan = out.facades.n;
  const nBand = out.facades.bands;
  const nHour = out.meta.hours.length;

  out.dims = { nPan, nBand, nHour };

  /** Surface temperature of one band of one panel at one hour, degC. */
  out.surfaceAt = (hour, panel, band) =>
    out.thermal[(hour * nPan + panel) * nBand + band];

  /** Air temperature at the same place, degC (modelled). */
  out.airAt = (hour, panel, band) =>
    out.air[(hour * nPan + panel) * nBand + band];

  /** One-sigma uncertainty on that air temperature, K. */
  out.sigmaAt = (hour, panel, band) =>
    out.airSigma[(hour * nPan + panel) * nBand + band];

  /** Whether that band is in direct sun. */
  out.sunlitAt = (hour, panel, band) => {
    const bit = (hour * nPan + panel) * nBand + band;
    return (out.sunlit[bit >> 3] >> (7 - (bit & 7))) & 1;
  };

  // Per-building panel lists, for selection and per-building statistics.
  const byB = new Map();
  for (let p = 0; p < nPan; p++) {
    const b = out.facades.building[p];
    let a = byB.get(b);
    if (!a) { a = []; byB.set(b, a); }
    a.push(p);
  }
  out.panelsOfBuilding = byB;

  // Ranked lookup by BIN, so clicking a building in 3D finds its dossier.
  out.rankByBin = new Map();
  out.ranked.items.forEach((it, i) => out.rankByBin.set(String(it.bin), { ...it, rank: i + 1 }));

  // Building attribute lookup by index.
  out.attrOf = (i) => out.buildings.attrs[i];
  out.binToIndex = new Map();
  out.buildings.attrs.forEach((a, i) => { if (a.bin) out.binToIndex.set(String(a.bin), i); });

  return out;
}

/** Domain (min/max) of a field across the whole dataset, for a stable legend.
 *  Uses percentiles so a single extreme panel cannot flatten the ramp. */
export function domain(arr, loPct = 1, hiPct = 99, sample = 200000) {
  const n = arr.length;
  const stride = Math.max(1, Math.floor(n / sample));
  const s = [];
  for (let i = 0; i < n; i += stride) if (isFinite(arr[i])) s.push(arr[i]);
  s.sort((a, b) => a - b);
  if (!s.length) return [0, 1];
  return [s[Math.floor(loPct / 100 * (s.length - 1))],
          s[Math.floor(hiPct / 100 * (s.length - 1))]];
}

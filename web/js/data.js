/* Data loading and the time axis.
 *
 * Everything arrives pre-solved from the Python pipeline. The browser does no
 * physics, so what is on screen is provably the same field the validation script
 * checked, and there is no second simplified model in JavaScript that could
 * quietly disagree with the first one.
 *
 * WHAT CHANGED WHEN THE PLATFORM BECAME A YEAR
 *
 * There used to be one day and one set of binaries. There are now thirteen solved
 * days — the FortyGuard-anchored event day plus one representative day per month —
 * and 365 selectable dates between them. Loading all thirteen would be 120 MB
 * before the first frame, so:
 *
 *   the event day loads up front, exactly as it always did;
 *   a month's binaries load the first time you scrub into that month, about
 *     5 MB, and stay;
 *   the air-temperature profile of a month loads only if the air layer is on,
 *     because it is another 4.7 MB and it is the one layer whose uncertainty
 *     exceeds its own signal;
 *   the annual planes — sunlit hours a year, degree-hours, the swing between
 *     summer and winter — are small and load up front, because they are what the
 *     year is for.
 *
 * A DAY THAT IS NOT ONE OF THE THIRTEEN
 *
 * Scrubbing to 14 March must show 14 March, not "March". The field shown is that
 * month's solved field plus a per-panel dT_surface/dT_air, measured by the
 * pipeline by re-solving the scene with the air-temperature anchor lifted 1 K,
 * times that day's air-temperature departure from the month's representative day.
 * One multiply and one add per panel-band. It is a first-order correction with a
 * measured coefficient, `meta.year.sensitivity` carries the coefficient's spread,
 * and the interface labels the day as reconstructed rather than solved.
 */

const BASE = './data';

async function json(name) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

async function i16(name, scale = 100) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const raw = new Int16Array(await r.arrayBuffer());
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / scale;
  return out;
}

async function u16(name, scale = 1) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const raw = new Uint16Array(await r.arrayBuffer());
  if (scale === 1) return raw;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / scale;
  return out;
}

async function bytes(name) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function uint16(name) {
  const r = await fetch(`${BASE}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return new Uint16Array(await r.arrayBuffer());
}

/** The event day's key. Kept as a name rather than a magic string in nine places. */
export const EVENT = 'event';
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const SEASONS = {
  summer: [6, 7, 8], autumn: [9, 10, 11], winter: [12, 1, 2], spring: [3, 4, 5],
};

const monthKey = (m) => `month_${String(m).padStart(2, '0')}`;

export async function load(onProgress = () => {}) {
  const steps = 14;
  let done = 0;
  const tick = (label) => { done++; onProgress(done / steps, label); };

  const out = {};
  out.meta = await json('meta.json');            tick('study area');
  out.year = await json('year.json');            tick('the study year');
  out.buildings = await json('buildings.json');  tick('building footprints');
  out.facades = await json('facades.json');      tick('facade geometry');
  out.canyons = await json('canyons.json');      tick('canyon cross-sections');
  out.tiles = await json('tiles.json');          tick('temperature field');
  out.ranked = await json('ranked.json');        tick('exposure ranking');
  out.scenarios = await json('scenarios.json');  tick('intervention scenarios');
  out.heights = await bytes('heights.bin');      tick('collision grid');
  out.svfBands = await bytes('svf_bands.bin');   tick('sky view factors');
  out.airSigma = await i16('air_sigma.bin');     tick('uncertainty');

  const nPan = out.facades.n;
  const nBand = out.facades.bands;
  const nHour = out.meta.hours.length;
  out.dims = { nPan, nBand, nHour };

  // dT_surface/dT_air, one byte per panel-band. See the module header.
  const sensSpec = out.meta.year.sensitivity || { offset: 0.5, scale: 200 };
  const sensRaw = await bytes('sens.bin');
  out.gamma = new Float32Array(sensRaw.length);
  for (let i = 0; i < sensRaw.length; i++) {
    out.gamma[i] = sensRaw[i] / sensSpec.scale + sensSpec.offset;
  }
  tick('day sensitivity');

  // The annual planes. Small, and they are the whole reason the year is here.
  const spec = out.meta.year.annual_fields;
  out.annual = {};
  const planeNames = Object.keys(spec.planes);
  await Promise.all(planeNames.map(async (name) => {
    const ps = spec.planes[name];
    out.annual[name] = ps.dtype === 'uint16'
      ? await u16(`annual/${name}.bin`, ps.scale)
      : await i16(`annual/${name}.bin`, ps.scale);
  }));
  out.annual.month_of_max = await bytes('annual/month_of_max.bin');
  out.annual.monthly_mean = await i16('annual/monthly_mean.bin', 100);
  tick('annual fields');

  // The event day, eagerly, under the filenames it has always had.
  out.periods = new Map();
  out.periods.set(EVENT, await loadPeriod(out, EVENT, ''));
  tick('the event day');

  /* ------------------------------------------------------ the year index */

  out.days = out.year.days;
  out.months = out.year.months;
  out.dateToDay = new Map(out.days.map((d, i) => [d.date, i]));
  out.hourly = out.year.hourly;
  out.eventDate = out.year.periods.event.date;

  // Air temperature at (date, wall-clock hour), for the day reconstruction. Built
  // as a flat lookup once rather than scanned per repaint: the hour strip is
  // repainted on every scrub and a linear search over 8,760 entries per panel
  // would be the slowest thing in the application.
  const hod = out.hourly.hour_of_day;
  const dayIdx = out.hourly.day_index;
  const tAir = out.hourly.t_air_c;
  const airByDayHour = new Float32Array(out.days.length * 24).fill(NaN);
  for (let i = 0; i < tAir.length; i++) {
    airByDayHour[dayIdx[i] * 24 + hod[i]] = tAir[i];
  }
  out.airAtDayHour = (dateOrIndex, hourEdt) => {
    const di = typeof dateOrIndex === 'number'
      ? dateOrIndex : out.dateToDay.get(dateOrIndex);
    if (di === undefined) return NaN;
    return airByDayHour[di * 24 + (hourEdt % 24)];
  };

  // The same lookup for global irradiance, which the reconstruction's second term
  // needs. Built the same way and for the same reason: a scan of 8,760 entries per
  // repaint would be the slowest thing in the application.
  const ghiSeries = out.hourly.ghi;
  const ghiByDayHour = new Float32Array(out.days.length * 24).fill(NaN);
  for (let i = 0; i < ghiSeries.length; i++) {
    ghiByDayHour[dayIdx[i] * 24 + hod[i]] = ghiSeries[i];
  }
  out.ghiAtDayHour = (dateOrIndex, hourEdt) => {
    const di = typeof dateOrIndex === 'number'
      ? dateOrIndex : out.dateToDay.get(dateOrIndex);
    if (di === undefined) return NaN;
    return ghiByDayHour[di * 24 + (hourEdt % 24)];
  };

  const windSeries = out.hourly.wind_ms;
  const windByDayHour = new Float32Array(out.days.length * 24).fill(NaN);
  for (let i = 0; i < windSeries.length; i++) {
    windByDayHour[dayIdx[i] * 24 + hod[i]] = windSeries[i];
  }
  out.windAtDayHour = (dateOrIndex, hourEdt) => {
    const di = typeof dateOrIndex === 'number'
      ? dateOrIndex : out.dateToDay.get(dateOrIndex);
    if (di === undefined) return NaN;
    return windByDayHour[di * 24 + (hourEdt % 24)];
  };

  /* ------------------------------------------------- period and aggregate */

  const pending = new Map();
  out.ensurePeriod = (key, withAir = false) => {
    const have = out.periods.get(key);
    if (have && (!withAir || have.air)) return Promise.resolve(have);
    const cacheKey = `${key}:${withAir}`;
    if (!pending.has(cacheKey)) {
      pending.set(cacheKey, (async () => {
        const dir = key === EVENT ? '' : `${key}/`;
        const p = have || await loadPeriod(out, key, dir);
        if (withAir && !p.air) p.air = await i16(`${dir}air.bin`);
        out.periods.set(key, p);
        pending.delete(cacheKey);
        return p;
      })());
    }
    return pending.get(cacheKey);
  };

  // A season or the year is the mean of its months at the same hour slot. Built
  // once and cached, because averaging three 1.2 MB hours twelve times over is
  // not something to do on a scrub.
  out.ensureAggregate = async (kind, name) => {
    const key = `${kind}:${name}`;
    const have = out.periods.get(key);
    if (have) return have;
    const months = kind === 'season' ? SEASONS[name] : Array.from({ length: 12 }, (_, i) => i + 1);
    const parts = await Promise.all(months.map((m) => out.ensurePeriod(monthKey(m))));
    const n = nHour * nPan * nBand;
    const surface = new Float32Array(n);
    const litCount = new Float32Array(n);
    for (const p of parts) {
      for (let i = 0; i < n; i++) {
        surface[i] += p.surface[i];
        litCount[i] += bitAt(p.lit, i);
      }
    }
    for (let i = 0; i < n; i++) surface[i] /= parts.length;
    const agg = {
      key, kind, label: kind === 'season'
        ? `${name[0].toUpperCase()}${name.slice(1)} mean`
        : 'Year mean',
      date: null,
      surface,
      litFraction: litCount.map((v) => v / parts.length),
      lit: parts[0].lit,          // the representative month's mask, for the sun layer
      groundSun: parts[Math.floor(parts.length / 2)].groundSun,
      hours: parts[Math.floor(parts.length / 2)].hours,
      members: months,
      reconstructed: false,
      aggregate: true,
    };
    out.periods.set(key, agg);
    return agg;
  };

  /* ---------------------------------------------------------- the clock */

  // The active time. `period` is which solved day's field we are reading,
  // `date` is the calendar day being shown, and `offsetK` is the per-hour air
  // temperature departure that turns the first into the second.
  out.time = {
    period: EVENT,
    aggregate: 'day',
    date: out.eventDate,
    dayIndex: out.dateToDay.get(out.eventDate) ?? 0,
    offsetK: new Float32Array(nHour),      // zero for a solved day
    ratio: new Float32Array(nHour).fill(1),
    reconstructed: false,
    reconError: null,
  };

  /** Point the clock at a date, a month, a season or the year.
   *  Returns a promise: it may have to fetch a month. */
  out.setTime = async ({ date, aggregate, withAir = false } = {}) => {
    const agg = aggregate || out.time.aggregate;
    if (agg === 'year' || agg === 'season') {
      const name = agg === 'season' ? seasonOf(date, out) : 'year';
      const p = await out.ensureAggregate(agg, name);
      out.time = {
        period: p.key, aggregate: agg, date: date || out.time.date,
        dayIndex: out.dateToDay.get(date) ?? out.time.dayIndex,
        offsetK: new Float32Array(nHour),
        ratio: new Float32Array(nHour).fill(1),
        reconstructed: false, reconError: null,
        aggregateName: name,
      };
      out.active = p;
      out._invalidateWindFactor?.();
      return out.time;
    }

    const d = date || out.time.date;
    const isEvent = d === out.eventDate;
    const rec = out.days[out.dateToDay.get(d) ?? 0];
    const key = isEvent ? EVENT : monthKey(rec.month);
    const p = await out.ensurePeriod(key, withAir);

    // The reconstruction, in two scalars per hour. See heatcanyon/tiers.py's
    // `reconstruct`, which is the one definition of this formula: the same
    // arithmetic runs there for the agent and is what
    // `tiers.reconstruction_audit` measures, so the error printed beside the date
    // is the error of the field on screen.
    const offsetK = new Float32Array(nHour);
    const ratio = new Float32Array(nHour).fill(1);
    const windRep = new Float32Array(nHour).fill(NaN);
    const windDay = new Float32Array(nHour).fill(NaN);
    let reconstructed = false;
    if (agg === 'day' && d !== p.date) {
      for (let h = 0; h < nHour; h++) {
        const edt = p.hours[h].edt;
        const want = out.airAtDayHour(d, edt);
        const have = out.airAtDayHour(p.date, edt);
        offsetK[h] = (isFinite(want) && isFinite(have)) ? want - have : 0;
        // The irradiance term. A day 16 K warmer than its month's representative
        // day is usually a clear day against a cloudy one, and the beam differs
        // by hundreds of W/m² — which the air term cannot see. Applied only on
        // lit bands: a shaded band's surface-to-air excess is diffuse and
        // longwave, and scaling it by a beam ratio over-corrects it.
        const gRep = out.ghiAtDayHour(p.date, edt);
        const gDay = out.ghiAtDayHour(d, edt);
        ratio[h] = (isFinite(gRep) && gRep >= 20 && isFinite(gDay))
          ? Math.min(2.5, Math.max(0, gDay / gRep)) : 1;
        // The wind term. The surface-to-air excess goes as 1/h_c and h_c is
        // 5.8 + 3.8u, so a windier day sheds more heat from every surface — lit or
        // shaded, which is why this applies everywhere while the irradiance ratio
        // does not. Measured to take the median day's error from 1.78 K to 1.54 K
        // and the worst day from 17.5 K to 13.5 K.
        windRep[h] = out.windAtDayHour(p.date, edt);
        windDay[h] = out.windAtDayHour(d, edt);
      }
      reconstructed = true;
    }
    const dayRec = out.days[out.dateToDay.get(d) ?? 0];
    out.time = {
      period: key, aggregate: agg, date: d,
      dayIndex: out.dateToDay.get(d) ?? 0,
      offsetK, ratio, windRep, windDay, reconstructed,
      // The measured error of this day's reconstruction, from the pipeline's own
      // 365-day audit. Per day rather than global: the residual is solar geometry
      // and it is several times larger near an equinox than in June.
      reconError: reconstructed
        ? { p50: dayRec?.recon_p50, p95: dayRec?.recon_p95 } : null,
    };
    out.active = p;
    out._invalidateWindFactor?.();
    // `meta.hours` is what the scene and the interface read for solar geometry and
    // the hour labels, and it belongs to the period being shown: the sun is 26
    // degrees lower at noon in December than in June, and painting July's solar
    // angle over December's field would make the shading contradict the physics.
    out.meta.hours = p.hours;
    return out.time;
  };

  out.active = out.periods.get(EVENT);
  out.meta.hours = out.active.hours;

  /* -------------------------------------------------------- accessors */

  /** Surface temperature of one band of one panel at one hour slot, degC.
   *  Reads the active period and applies the day's air-temperature departure. */
  out.surfaceAt = (hour, panel, band) => {
    const i = (hour * nPan + panel) * nBand + band;
    const v = out.active.surface[i];
    const off = out.time.offsetK[hour];
    const r = out.time.ratio ? out.time.ratio[hour] : 1;
    const wf = out._windFactorFor(hour);
    if (!off && r === 1 && !wf) return v;
    let t = v + out.gamma[panel * nBand + band] * off;
    const w = wf ? wf[panel * nBand + band] : 1;
    // The surface-to-air excess is what the radiation and the convection act on,
    // so that is what both ratios scale. Its anchor is the period's own hourly air
    // temperature, the same quantity the physics used. The irradiance ratio
    // applies only where the band is lit; the wind ratio applies everywhere.
    const scale = bitAt(out.active.lit, i) ? r * w : w;
    if (scale !== 1) t += (v - out.active.hours[hour].t_anchor_c) * (scale - 1);
    return t;
  };

  /** Air temperature at the same place, degC (modelled, and the weakest field
   *  in the model — see meta.provenance). Undefined until the air layer asks
   *  for it, because it is 4.7 MB a month. */
  out.airAt = (hour, panel, band) => {
    if (!out.active.air) return NaN;
    const i = (hour * nPan + panel) * nBand + band;
    return out.active.air[i] + (out.time.offsetK[hour] || 0);
  };

  /** The hour's air temperature anchor for the date being shown, degC.
   *
   *  A SCALAR. One number for the whole AOI, which is exactly what makes it
   *  worth having: it is the term that carries 96% of the facade field's
   *  variance and none of its spatial structure. See EXCESS_DOMAIN in colors.js
   *  for the measurement and for what subtracting it buys.
   *
   *  This is the same quantity `surfaceAt` anchors its reconstruction to, and
   *  deliberately not `airAt`. The modelled air field is per-panel, 4.7 MB a
   *  month, and the one field in the model whose uncertainty exceeds its own
   *  signal — differencing against it would fold that uncertainty into every
   *  wall. The anchor has none of those problems and is already in meta.
   *
   *  `offsetK` carries the departure of the date being shown from the solved
   *  period's own day, the same shift `airAt` applies. Note that the surface
   *  does NOT move by the full offset — it moves by `gamma * off`, because a
   *  wall with thermal mass answers an air-temperature departure only partly —
   *  so the excess below is not the stored field minus a constant. It is
   *  computed through `surfaceAt` so it can never disagree with what is drawn. */
  out.anchorAt = (hour) =>
    out.active.hours[hour].t_anchor_c + (out.time.offsetK[hour] || 0);

  /** How much hotter one band of one panel is than the air beside it, K.
   *
   *  Negative where a surface is losing to the sky faster than the air can
   *  resupply it, which is most walls on most clear nights. This is also the
   *  precise quantity `surfaceAt`'s irradiance and wind ratios scale — they act
   *  on the surface-to-air excess, because that is what the radiation and the
   *  convection act on — so painting it is painting the model's own working
   *  variable rather than a quantity derived after the fact. */
  out.excessAt = (hour, panel, band) =>
    out.surfaceAt(hour, panel, band) - out.anchorAt(hour);

  out.hasAir = () => !!out.active.air;
  out.ensureAir = () => out.ensurePeriod(out.time.period, true)
    .then((p) => { out.active = p; return p; });

  /** One-sigma uncertainty on that air temperature, K.
   *
   *  Height and canyon enclosure only, so it does not vary with the hour or the
   *  period and is shipped as ONE (panel, band) plane rather than eight identical
   *  copies. The `hour` argument is kept in the signature so this reads like its
   *  neighbours at every call site. */
  out.sigmaAt = (_hour, panel, band) => out.airSigma[panel * nBand + band];

  /** Sky view factor of one facade band, 0..0.5 (a wall sees at most half). */
  out.svfAt = (panel, band) => (out.svfBands[panel * nBand + band] / 255) * 0.5;

  /** Whether that band is in direct sun this hour. For an aggregate this is the
   *  representative month's mask; `litFractionAt` is the honest version. */
  out.sunlitAt = (hour, panel, band) =>
    bitAt(out.active.lit, (hour * nPan + panel) * nBand + band);

  /** Fraction of the aggregated months in which the band was lit, 0..1. */
  out.litFractionAt = (hour, panel, band) => {
    const i = (hour * nPan + panel) * nBand + band;
    return out.active.litFraction
      ? out.active.litFraction[i] : bitAt(out.active.lit, i);
  };

  /** An annual plane at one panel-band. */
  out.annualAt = (name, panel, band) => {
    const a = out.annual[name];
    return a ? a[panel * nBand + band] : NaN;
  };

  /** The 12 monthly mean surface temperatures at one panel-band. */
  out.monthlyMeanAt = (panel, band) => {
    const stride = nPan * nBand;
    const base = panel * nBand + band;
    const arr = new Float32Array(12);
    for (let m = 0; m < 12; m++) arr[m] = out.annual.monthly_mean[m * stride + base];
    return arr;
  };

  /* ------------------------------------------------------- ground field */

  /** Value of one of the ground fields at a world position, nearest-cell.
   *
   * The duration fields — hours above 35 degC, and the longest unbroken run —
   * are solved on the 60 m tile grid, not per facade panel, and they arrive as a
   * sparse list of [x, y, value] rather than a raster. Painting them on the
   * ground alone left the buildings showing surface temperature under a legend
   * labelled in hours, which is exactly the confusion one shared colour ramp is
   * supposed to remove.
   *
   * So they are sampled at each address instead. That is a real join, not an
   * invented value: a Midtown footprint is smaller than a 60 m cell, and both
   * metrics are per-address quantities to begin with — "how long does this
   * address stay over the threshold" has one answer per building, and this is it.
   *
   * The index is built on first use, per field, from the same point list the
   * ground texture is painted from, so the two cannot disagree.
   */
  const tileIndex = {};
  out.tileValueAt = (field, x, y) => {
    let ix = tileIndex[field];
    if (ix === undefined) {
      const pts = out.tiles[field];
      const g = out.tiles.grid_m;
      if (!pts || !pts.length || !g) { tileIndex[field] = null; return NaN; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < pts.length; k++) {
        const px = pts[k][0], py = pts[k][1];
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      const nx = Math.round((x1 - x0) / g) + 1;
      const ny = Math.round((y1 - y0) / g) + 1;
      const arr = new Float32Array(nx * ny).fill(NaN);
      for (let k = 0; k < pts.length; k++) {
        const j = Math.round((pts[k][0] - x0) / g);
        const i = Math.round((pts[k][1] - y0) / g);
        if (i >= 0 && i < ny && j >= 0 && j < nx) arr[i * nx + j] = pts[k][2];
      }
      ix = tileIndex[field] = { x0, y0, g, nx, ny, arr };
    }
    if (ix === null) return NaN;
    const j = Math.round((x - ix.x0) / ix.g);
    const i = Math.round((y - ix.y0) / ix.g);
    if (i < 0 || i >= ix.ny || j < 0 || j >= ix.nx) return NaN;
    return ix.arr[i * ix.nx + j];
  };

  const sg = out.meta.shadow_grid;
  out.groundSunAt = (hour, x, y) => {
    if (!sg || !out.active.groundSun) return 1;
    const j = Math.floor((x - sg.x0) / sg.res);
    const i = Math.floor((y - sg.y0) / sg.res);
    if (i < 0 || i >= sg.ny || j < 0 || j >= sg.nx) return 1;
    return bitAt(out.active.groundSun, (hour * sg.ny + i) * sg.nx + j);
  };

  // The measured tile field is one day; the year's is that day's measured spatial
  // anomaly carried onto the reanalysis level. `tiles.anomaly[slot]` is the
  // anomaly and `tiles.air[slot]` the measured values, so the event day reads its
  // own numbers and any other date reads the composite. Labelled in the legend.
  const slotOfHour = out.tiles.hours.map((h) => h.edt);
  out.tilesAt = (hour) => {
    if (out.time.period === EVENT && out.time.aggregate === 'day'
        && out.time.date === out.eventDate) {
      return { rows: out.tiles.air[hour], kind: 'measured' };
    }
    const anom = out.tiles.anomaly?.[hour];
    if (!anom) return { rows: out.tiles.air[hour], kind: 'measured' };
    const level = out.time.aggregate === 'day'
      ? out.airAtDayHour(out.time.date, slotOfHour[hour])
      : monthlyLevel(out, hour);
    if (!isFinite(level)) return { rows: out.tiles.air[hour], kind: 'measured' };
    return {
      rows: anom.map(([x, y, dv]) => [x, y, level + dv]),
      kind: 'composite',
    };
  };

  /** An annual per-tile metric, as [x, y, value] rows. */
  out.tileYearAt = (layer) => {
    const vals = out.tiles.year?.[layer];
    if (!vals) return null;
    const pts = out.tiles.exceedance;
    const rows = [];
    for (let i = 0; i < Math.min(vals.length, pts.length); i++) {
      rows.push([pts[i][0], pts[i][1], vals[i]]);
    }
    return rows;
  };

  /* ------------------------------------------------------------ indexes */

  const hg = out.meta.height_grid;
  out.heightAt = (x, y) => {
    if (!hg || !out.heights) return 0;
    const j = Math.floor((x - hg.x0) / hg.res);
    const i = Math.floor((y - hg.y0) / hg.res);
    if (i < 0 || i >= hg.ny || j < 0 || j >= hg.nx) return 0;
    return out.heights[i * hg.nx + j];
  };

  let massingPromise = null;
  out.ensureMassing = () => {
    if (!massingPromise) {
      massingPromise = (async () => {
        const [bid, h, ge] = await Promise.all([
          uint16('massing_bid.bin'), uint16('massing_h.bin'),
          uint16('ground_elev.bin'),
        ]);
        out.massingBid = bid; out.massingH = h; out.groundElev = ge;
      })();
    }
    return massingPromise;
  };

  const mg = out.meta.massing_grid;
  out.groundElevAt = (x, y) => {
    if (!mg || !out.groundElev) return 0;
    const j = Math.floor((x - mg.x0) / mg.res);
    const i = Math.floor((y - mg.y0) / mg.res);
    if (i < 0 || i >= mg.ny || j < 0 || j >= mg.nx) return mg.datum_m || 0;
    return out.groundElev[i * mg.nx + j] * (mg.ground_scale || 0.1);
  };

  /* The canyon properties the day reconstruction's wind term needs, per panel.
   * Built once. The values for a panel with no canyon within 90 m mirror the
   * open-ground fallback the physics used, so the browser's wind blend is the same
   * one heatcanyon/yearsolve.py's `wind_profile` computes. */
  const canyonById = new Map(out.canyons.map((c) => [c.i, c]));
  out.panelAspect = new Float32Array(nPan).fill(0.25);
  out.panelHMean = new Float32Array(nPan).fill(10);
  out.bandZ = new Float32Array(nPan * nBand);
  for (let p = 0; p < nPan; p++) {
    const ci = out.facades.canyon[p];
    const c = ci >= 0 ? canyonById.get(ci) : null;
    if (c) {
      out.panelAspect[p] = c.hw;
      out.panelHMean[p] = Math.max((c.hl + c.hr) / 2, 4);
    }
    const hWall = Math.max(out.facades.top[p] - out.facades.base[p], 3);
    for (let b = 0; b < nBand; b++) {
      out.bandZ[p * nBand + b] = (hWall * (b + 0.5)) / nBand;
    }
  }

  /* h_c(reference wind) / h_c(the day's wind), per panel and band, for one hour.
   *
   * Memoised on the hour: it is 294,150 elements and `surfaceAt` is called once
   * per panel-band per repaint, so recomputing it inside the accessor would put an
   * exponential in the inner loop. Invalidated whenever the clock moves. */
  let wfHour = -1;
  let wfArr = null;
  const hcOf = (u10, p, b) => {
    const uBase = Math.max(0.3, u10 * Math.exp(-0.386 * Math.max(out.panelAspect[p], 0)));
    const frac = Math.min(1, out.bandZ[p * nBand + b] / Math.max(out.panelHMean[p], 1));
    const u = uBase + (u10 - uBase) * frac ** 1.5;
    return 5.8 + 3.8 * Math.max(u, 0);
  };
  out._windFactorFor = (hour) => {
    if (wfHour === hour && wfArr) return wfArr;
    const uRep = out.time.windRep ? out.time.windRep[hour] : NaN;
    const uDay = out.time.windDay ? out.time.windDay[hour] : NaN;
    if (!isFinite(uRep) || !isFinite(uDay) || Math.abs(uRep - uDay) < 0.01) {
      wfHour = hour; wfArr = null;
      return null;
    }
    const arr = new Float32Array(nPan * nBand);
    for (let p = 0; p < nPan; p++) {
      for (let b = 0; b < nBand; b++) {
        arr[p * nBand + b] = hcOf(uRep, p, b) / Math.max(hcOf(uDay, p, b), 1e-6);
      }
    }
    wfHour = hour; wfArr = arr;
    return arr;
  };
  out._invalidateWindFactor = () => { wfHour = -1; wfArr = null; };

  const byB = new Map();
  for (let p = 0; p < nPan; p++) {
    const b = out.facades.building[p];
    let a = byB.get(b);
    if (!a) { a = []; byB.set(b, a); }
    a.push(p);
  }
  out.panelsOfBuilding = byB;

  out.rankByBin = new Map();
  out.ranked.items.forEach((it, i) => out.rankByBin.set(String(it.bin), { ...it, rank: i + 1 }));
  out.annualOrder = out.ranked.orderings?.annual || out.ranked.items.map((_, i) => i);

  out.attrOf = (i) => out.buildings.attrs[i];
  out.binToIndex = new Map();
  out.buildings.attrs.forEach((a, i) => { if (a.bin) out.binToIndex.set(String(a.bin), i); });

  /* ------------------------------------------------------ the decision layer

     Three products that turn the solved field into a prescription with a price
     on it: the per-floor schedule, the measures, and the programme. See
     docs/DECISIONS.md.

     OPTIONAL BY CONSTRUCTION. Every one of these is fetched with `optional`,
     which resolves to null on any failure rather than rejecting. A build that
     has not run the decision stage still produces a working atlas: the Diagnose
     pane says the schedule is not in this build and the eight layers, the year
     strip, the street camera and the analyst are all untouched. That is a
     deliberate property and it is asserted in the tests — a data product whose
     absence takes the application down is not optional, whatever the loader
     claims.

     Not awaited before the first frame either. The atlas is 40 MB of geometry
     and these are 1.9 MB of tables nobody can see until they select a building,
     so they are started here and land when they land; `ctx.decision` carries a
     `ready` promise for the panes that need to wait on it. */
  out.decision = { floors: null, prescriptions: null, portfolio: null,
                   fixture: false, ready: null };
  out.decision.ready = Promise.all([
    optional('floors.json'), optional('prescriptions.json'), optional('portfolio.json'),
  ]).then(([floors, prescriptions, portfolio]) => {
    Object.assign(out.decision, { floors, prescriptions, portfolio });
    // One flag, true if ANY product is still fixture output. The interface shows
    // a standing warning while it is set, and it is deliberately not per-file:
    // a page mixing one real table with one placeholder table and warning about
    // neither is exactly the failure this guards against.
    out.decision.fixture = [floors, prescriptions, portfolio]
      .some((p) => p && p.fixture === true);
    return out.decision;
  });

  /* One building's schedule, fetched when somebody asks for that building.
   *
   * `floors.json` bundles the ranked 150 so the buildings most likely to be
   * opened are already in hand. Every other scored building has its own ~24 KB
   * shard, written one to a file by the pipeline, and it is fetched on the
   * select that needs it — the only moment the answer is wanted.
   *
   * Cached by BIN, including the misses: a building with no shard is a fact
   * about the build, and re-asking the network for it on every reselect would
   * turn one honest empty state into a request per click. In flight requests
   * are cached too, so the double render a select can produce makes one fetch
   * rather than two. */
  const shards = new Map();
  out.decision.floorsFor = (bin) => {
    const key = String(bin);
    const bundled = out.decision.floors?.items?.[key];
    if (bundled) return Promise.resolve({ loads: bundled,
      prescriptions: out.decision.prescriptions?.items?.[key] || [] });
    if (shards.has(key)) return shards.get(key);
    const p = fetch(`${BASE}/floors/${encodeURIComponent(key)}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    shards.set(key, p);
    return p;
  };

  return out;
}

/** Fetch a JSON product that may legitimately not exist in this build.
 *
 *  Resolves to null rather than rejecting, and says so once in the console. A
 *  404 here is a build without the decision stage, which is a supported
 *  configuration, not an error — but a silent null is how a missing product
 *  becomes an empty pane nobody can explain, so it is logged. */
async function optional(name) {
  try {
    const r = await fetch(`${BASE}/${name}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.info(`${name} not in this build (${e.message}) — the pane that reads `
                 + 'it will say so. See docs/DECISIONS.md.');
    return null;
  }
}

async function loadPeriod(out, key, dir) {
  const nPan = out.facades.n;
  const nBand = out.facades.bands;
  const nHour = out.meta.hours.length;
  const [surface, litBits, gsBits] = await Promise.all([
    i16(`${dir}thermal.bin`),
    bytes(`${dir}sunlit.bin`),
    bytes(`${dir}ground_sun.bin`),
  ]);
  const info = key === EVENT
    ? out.year.periods.event
    : out.year.periods.months.find((m) => m.month === Number(key.slice(-2)));
  return {
    key,
    date: info.date,
    label: key === EVENT ? 'Heat wave day' : `${info.label} (${info.date})`,
    anchor: info.anchor_source,
    hours: info.hours,
    surface,
    lit: litBits,
    groundSun: gsBits,
    air: null,
    reconstructed: false,
  };
}

function bitAt(bits, i) {
  return (bits[i >> 3] >> (7 - (i & 7))) & 1;
}

function seasonOf(date, out) {
  const m = out.days[out.dateToDay.get(date) ?? 0]?.month
    ?? Number((date || '2026-07-02').slice(5, 7));
  for (const [name, months] of Object.entries(SEASONS)) {
    if (months.includes(m)) return name;
  }
  return 'summer';
}

function monthlyLevel(out, hour) {
  // The AOI-mean air temperature for the aggregate being shown, at this hour slot.
  const p = out.active;
  if (!p) return NaN;
  if (p.aggregate) {
    const vals = p.members
      .map((m) => {
        const rec = out.months.find((x) => x.month === m);
        return rec ? rec.diurnal_c[out.tiles.hours[hour].edt] : NaN;
      })
      .filter(isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  }
  return out.airAtDayHour(p.date, out.tiles.hours[hour].edt);
}

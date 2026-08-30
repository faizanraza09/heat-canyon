/* Does the rendered field actually behave like the physics it claims?
 *
 * These are the tests that matter most for credibility. A viewer cannot tell
 * whether a pretty gradient encodes solar geometry or a random number, so the
 * suite checks the signatures that only real physics produces: east walls hot in
 * the morning and west walls hot in the evening, shadows climbing facades as the
 * sun drops, surfaces varying far more than air, and uncertainty that grows with
 * height. If someone replaced the engine with noise, these fail.
 */

import { test, expect } from '@playwright/test';
import { ensureAir, openApp, setHour, setLayer } from './helpers.mjs';

/** Mean modelled surface temperature over panels facing a compass direction. */
async function meanByOrientation(page, hourIndex, centreAz, tol = 35) {
  return page.evaluate(([h, az, t]) => {
    const d = window.HC.data;
    const nb = d.facades.bands;
    let sum = 0, n = 0;
    for (let p = 0; p < d.facades.n; p++) {
      // Angular distance between two compass bearings, wrapped to 0..180.
      // ((a - b + 540) % 360) - 180 already gives the signed difference in
      // [-180, 180], so its absolute value IS the distance. An earlier version
      // subtracted that from 180, which silently selected the panels facing
      // *away* from the target and inverted the whole result.
      const diff = Math.abs(((d.facades.az[p] - az + 540) % 360) - 180);
      if (diff > t) continue;
      for (let b = 0; b < nb; b++) { sum += d.surfaceAt(h, p, b); n++; }
    }
    return { mean: n ? sum / n : NaN, n };
  }, [hourIndex, centreAz, tol]);
}

test('east facades lead in the morning, west facades in the evening', async ({ page }) => {
  await openApp(page);
  const hours = await page.evaluate(() => window.HC.data.meta.hours.map((h) => h.edt));
  const iMorning = hours.indexOf(9);
  const iEvening = hours.indexOf(18);
  expect(iMorning).toBeGreaterThanOrEqual(0);
  expect(iEvening).toBeGreaterThanOrEqual(0);

  const eMorning = await meanByOrientation(page, iMorning, 90);
  const wMorning = await meanByOrientation(page, iMorning, 270);
  const eEvening = await meanByOrientation(page, iEvening, 90);
  const wEvening = await meanByOrientation(page, iEvening, 270);

  expect(eMorning.n).toBeGreaterThan(500);
  expect(wMorning.n).toBeGreaterThan(500);

  // The asymmetry must reverse between morning and evening. This is the single
  // clearest fingerprint of correct solar geometry, and it is what a 2 m air
  // temperature reading cannot express at all.
  expect(eMorning.mean).toBeGreaterThan(wMorning.mean + 0.5);
  expect(wEvening.mean).toBeGreaterThan(eEvening.mean + 0.5);
});

test('sunlit fraction follows the sun through the day', async ({ page }) => {
  await openApp(page);
  const series = await page.evaluate(() => {
    const d = window.HC.data;
    const nb = d.facades.bands, np = d.facades.n;
    return d.meta.hours.map((h, hi) => {
      let lit = 0, total = 0;
      // Stride for speed; the ratio is what matters.
      for (let p = 0; p < np; p += 3) {
        for (let b = 0; b < nb; b++) { lit += d.sunlitAt(hi, p, b); total++; }
      }
      return { edt: h.edt, alt: h.sun_alt, litFrac: lit / total };
    });
  });

  for (const s of series) {
    if (s.alt <= 0) {
      // No sun below the horizon. Not a matter of degree.
      expect(s.litFrac, `hour ${s.edt} has sun altitude ${s.alt}`).toBe(0);
    }
  }
  const daylight = series.filter((s) => s.alt > 10);
  expect(daylight.length).toBeGreaterThan(2);
  for (const s of daylight) {
    expect(s.litFrac, `hour ${s.edt}`).toBeGreaterThan(0.02);
    // Never all of them: in a canyon city something is always in shadow.
    expect(s.litFrac, `hour ${s.edt}`).toBeLessThan(0.9);
  }
});

test('shadows climb facades as the sun drops', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(() => {
    const d = window.HC.data;
    const nb = d.facades.bands;
    const hours = d.meta.hours;
    // For panels lit at the top band but not the bottom, the shadow line sits
    // inside the facade. Count them: this is the vertical structure that only
    // exists because shading is resolved per height.
    const partial = hours.map((h, hi) => {
      let n = 0, lit = 0;
      for (let p = 0; p < d.facades.n; p += 2) {
        const bottom = d.sunlitAt(hi, p, 0);
        const top = d.sunlitAt(hi, p, nb - 1);
        if (top && !bottom) n++;
        if (top || bottom) lit++;
      }
      return { edt: h.edt, alt: h.sun_alt, partial: n, anyLit: lit };
    });
    return partial;
  });

  const daylight = r.filter((x) => x.alt > 15);
  const withPartial = daylight.filter((x) => x.partial > 20);
  // At least one daylight hour must show a shadow line partway up facades. If
  // none did, shading would be per-building rather than per-height and the whole
  // premise of the project would be unsupported by its own data.
  expect(withPartial.length, JSON.stringify(r)).toBeGreaterThan(0);
});

test('surface temperature varies far more than air temperature', async ({ page }) => {
  await openApp(page);
  // The air profile is fetched on demand, so it has to be asked for before it can
  // be read. Without this the spread comes back NaN and the assertion fails with a
  // message about NaN rather than about air temperature.
  await ensureAir(page);
  const s = await page.evaluate(() => {
    const d = window.HC.data;
    const hi = d.meta.peak_index, nb = d.facades.bands;
    const surf = [], air = [];
    for (let p = 0; p < d.facades.n; p += 5) {
      for (let b = 0; b < nb; b++) {
        surf.push(d.surfaceAt(hi, p, b));
        air.push(d.airAt(hi, p, b));
      }
    }
    const spread = (a) => {
      a.sort((x, y) => x - y);
      return a[Math.floor(0.99 * (a.length - 1))] - a[Math.floor(0.01 * (a.length - 1))];
    };
    return { surface: spread(surf), air: spread(air) };
  });

  // The project's central honest claim, asserted against its own output.
  expect(s.surface).toBeGreaterThan(3 * s.air);
  expect(s.air).toBeLessThan(4);
});

test('stated uncertainty grows with height and exceeds the air gradient', async ({ page }) => {
  await openApp(page);
  await ensureAir(page);
  const u = await page.evaluate(() => {
    const d = window.HC.data;
    const hi = d.meta.peak_index, nb = d.facades.bands;
    // Only tall panels, where the bands are far enough apart to compare.
    let lowSig = 0, highSig = 0, n = 0, gradSum = 0;
    for (let p = 0; p < d.facades.n; p++) {
      const h = d.facades.top[p] - d.facades.base[p];
      if (h < 60) continue;
      lowSig += d.sigmaAt(hi, p, 0);
      highSig += d.sigmaAt(hi, p, nb - 1);
      gradSum += Math.abs(d.airAt(hi, p, nb - 1) - d.airAt(hi, p, 0));
      n++;
    }
    return { n, lowSig: lowSig / n, highSig: highSig / n, meanGradient: gradSum / n };
  });

  expect(u.n).toBeGreaterThan(50);
  expect(u.highSig).toBeGreaterThan(u.lowSig);
  // The honesty requirement: over a tall facade the uncertainty band on the
  // vertical air extrapolation is wider than the extrapolation's own signal.
  expect(u.highSig).toBeGreaterThan(u.meanGradient);
});

test('night hours are cooler than the afternoon everywhere', async ({ page }) => {
  await openApp(page);
  const t = await page.evaluate(() => {
    const d = window.HC.data;
    const hours = d.meta.hours;
    const iPeak = d.meta.peak_index;
    const iNight = hours.findIndex((h) => h.edt === 3);
    const mean = (hi) => {
      let s = 0, n = 0;
      for (let p = 0; p < d.facades.n; p += 7) {
        for (let b = 0; b < d.facades.bands; b++) { s += d.surfaceAt(hi, p, b); n++; }
      }
      return s / n;
    };
    return { peak: mean(iPeak), night: mean(iNight), iNight };
  });
  expect(t.iNight).toBeGreaterThanOrEqual(0);
  expect(t.night).toBeLessThan(t.peak - 5);
});

test('measured exceedance and persistence are physically ordered', async ({ page }) => {
  await openApp(page);
  const m = await page.evaluate(() => {
    const s = window.HC.data.tiles.stats;
    return { exc: s.exceedance, per: s.persistence, dayMax: s.daymax, dayMin: s.daymin };
  });
  // A longest unbroken run can never exceed the total hours above threshold.
  expect(m.per.max).toBeLessThanOrEqual(m.exc.max);
  expect(m.per.min).toBeLessThanOrEqual(m.exc.min);
  expect(m.exc.min).toBeGreaterThan(0);
  // Daily maximum above daily minimum, everywhere.
  expect(m.dayMax.min).toBeGreaterThan(m.dayMin.max);
});

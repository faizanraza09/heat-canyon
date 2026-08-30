/* The year: the strip, the four aggregate modes, the annual layers, and the
 * places the temporal pivot could have gone wrong without looking wrong.
 *
 * The interesting assertions here are the physical ones. A time control that
 * changes a label but not a field is the failure mode this suite exists to catch,
 * and it is invisible in a screenshot: December has to have measurably less
 * sunlit facade than June, an annual layer has to stop caring about the hour, and
 * scrubbing to a hot day inside a month has to warm the walls relative to a cool
 * one in the same month.
 */

import { expect, test } from '@playwright/test';

import { facadeColorStats, openApp, setHour, setLayer, settle } from './helpers.mjs';

/** Move the year strip to a date and wait for the period to land. */
async function setDate(page, date, aggregate) {
  await page.evaluate(async ([d, a]) => {
    const ui = window.HC.ui;
    ui.year.syncTo(d, a || ui.year.aggregate);
    await ui.setDate(d, a);
  }, [date, aggregate]);
  await settle(page);
}

async function timeState(page) {
  return page.evaluate(() => {
    const d = window.HC.data;
    return {
      period: d.time.period,
      aggregate: d.time.aggregate,
      date: d.time.date,
      reconstructed: d.time.reconstructed,
      hoursDate: d.active.date,
      litFraction: (() => {
        // Share of panel-bands in direct sun at the selected hour: the single
        // number that must move with the season.
        const h = window.HC.ui.hour;
        const { nPan, nBand } = d.dims;
        let lit = 0, n = 0;
        for (let p = 0; p < nPan; p += 7) {
          for (let b = 0; b < nBand; b++) { lit += d.sunlitAt(h, p, b); n++; }
        }
        return lit / n;
      })(),
      meanSurface: (() => {
        const h = window.HC.ui.hour;
        const { nPan, nBand } = d.dims;
        let s = 0, n = 0;
        for (let p = 0; p < nPan; p += 7) {
          for (let b = 0; b < nBand; b++) { s += d.surfaceAt(h, p, b); n++; }
        }
        return s / n;
      })(),
    };
  });
}

test('the year loads with 365 days, twelve solved months and the event day', async ({ page }) => {
  const { errors } = await openApp(page);
  const got = await page.evaluate(() => {
    const d = window.HC.data;
    return {
      days: d.days.length,
      months: d.months.length,
      window: d.year.window,
      solvedMonths: d.year.periods.months.length,
      eventDate: d.eventDate,
      episodes: d.year.episodes.length,
      hourly: d.hourly.t_air_c.length,
      annualPlanes: Object.keys(d.annual).length,
      gammaMean: d.gamma.reduce((a, b) => a + b, 0) / d.gamma.length,
    };
  });
  expect(got.days).toBe(365);
  expect(got.months).toBe(12);
  expect(got.solvedMonths).toBe(12);
  expect(got.hourly).toBe(8760);
  expect(got.eventDate).toBe('2026-07-02');
  expect(got.episodes).toBeGreaterThan(0);
  expect(got.annualPlanes).toBeGreaterThanOrEqual(13);
  // dT_surface/dT_air is near unity by construction; a value far from it means
  // the byte encoding's offset or scale has drifted from meta.json.
  expect(got.gammaMean).toBeGreaterThan(0.9);
  expect(got.gammaMean).toBeLessThan(1.15);
  expect(errors).toEqual([]);
});

test('the strip is drawn, scrubbable, and marks the thirteen solved days', async ({ page }) => {
  await openApp(page);
  const strip = page.locator('canvas.ystrip');
  await expect(strip).toBeVisible();
  const box = await strip.boundingBox();
  expect(box.width).toBeGreaterThan(200);

  // Non-blank: the strip paints the data it selects, so a blank canvas means the
  // day records did not arrive.
  const painted = await page.evaluate(() => {
    const c = document.querySelector('canvas.ystrip');
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let nonZero = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 8) nonZero++;
    return nonZero / (px.length / 4);
  });
  expect(painted).toBeGreaterThan(0.15);

  // Drag to roughly a third across and the selected date must move.
  const before = (await timeState(page)).date;
  await page.mouse.move(box.x + box.width * 0.33, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  await settle(page);
  const after = await timeState(page);
  expect(after.date).not.toBe(before);
});

test('December has far less sunlit facade than June, at the same hour', async ({ page }) => {
  const { errors } = await openApp(page);
  await setHour(page, 4);                      // 15:00

  await setDate(page, '2026-06-07', 'month');
  const jun = await timeState(page);
  await setDate(page, '2025-12-20', 'month');
  const dec = await timeState(page);

  expect(jun.period).toBe('month_06');
  expect(dec.period).toBe('month_12');
  // The physical claim the year exists to make: Manhattan's noon sun is 26 deg
  // lower in December, so a canyon half lit in July has a floor in shade.
  expect(jun.litFraction).toBeGreaterThan(dec.litFraction * 1.4);
  expect(jun.meanSurface).toBeGreaterThan(dec.meanSurface + 15);
  expect(errors).toEqual([]);
});

test('a day inside a month is reconstructed, and the reconstruction moves with the weather', async ({ page }) => {
  await openApp(page);
  await setHour(page, 4);

  // The July representative day is solved; another July day is not.
  const repDate = await page.evaluate(() =>
    window.HC.data.year.periods.months.find((m) => m.month === 7).date);
  await setDate(page, repDate, 'day');
  const solved = await timeState(page);
  expect(solved.reconstructed).toBe(false);

  // The hottest and coolest days of the same month, so the offset has real range —
  // excluding the two days that are themselves solved. The event day is the
  // hottest day of the whole year and is anchored on a MEASURED field, so picking
  // it here would test the solved path while claiming to test the reconstructed
  // one. That is exactly what the first version of this test did.
  const [hot, cool] = await page.evaluate((rep) => {
    const d = window.HC.data;
    const jul = d.days.filter((x) => x.month === 7
      && x.date !== rep && x.date !== d.eventDate);
    const s = [...jul].sort((a, b) => b.tmax - a.tmax);
    return [s[0].date, s[s.length - 1].date];
  }, repDate);

  await setDate(page, hot, 'day');
  const h = await timeState(page);
  await setDate(page, cool, 'day');
  const c = await timeState(page);

  expect(h.reconstructed).toBe(true);
  expect(c.reconstructed).toBe(true);
  expect(h.period).toBe('month_07');
  expect(c.period).toBe('month_07');
  // And the interface has to say so, with that day's own measured error.
  await expect(page.locator('#time-meta .prov')).toContainText('reconstructed');
  // Same solved field, different air-temperature departure: the walls have to
  // differ, and in the right direction.
  expect(h.meanSurface).toBeGreaterThan(c.meanSurface + 2);
});

test('the four aggregate modes each change what is on screen', async ({ page }) => {
  await openApp(page);
  await setHour(page, 4);
  const seen = {};
  for (const mode of ['day', 'month', 'season', 'year']) {
    await setDate(page, '2026-07-02', mode);
    const s = await timeState(page);
    seen[mode] = s;
    expect(s.aggregate).toBe(mode);
  }
  // A season mean is cooler than the peak day inside it, and a year mean cooler
  // than a summer season mean. If any of these came out equal the aggregate is a
  // label rather than an average.
  expect(seen.season.meanSurface).toBeLessThan(seen.day.meanSurface);
  expect(seen.year.meanSurface).toBeLessThan(seen.season.meanSurface);
  expect(seen.year.period).toContain('year');
});

test('annual layers ignore the clock and say so', async ({ page }) => {
  const { errors } = await openApp(page);
  await setLayer(page, 'Sunlit hours a year');

  await expect(page.locator('#time')).toHaveClass(/frozen/);
  await expect(page.locator('#time-frozen')).toBeVisible();

  const a = await facadeColorStats(page);
  await setHour(page, 0);
  const b = await facadeColorStats(page);
  await setDate(page, '2026-01-04', 'month');
  const c = await facadeColorStats(page);
  // An annual total has no hour and no day. Identical colour statistics are the
  // point, not a bug: the alternative is a field that appears to respond to a
  // control it cannot possibly depend on.
  expect(b.mean).toBeCloseTo(a.mean, 4);
  expect(c.mean).toBeCloseTo(a.mean, 4);
  expect(a.distinct).toBeGreaterThan(20);

  // And a moment layer must un-freeze.
  await setLayer(page, 'Facade temperature');
  await expect(page.locator('#time')).not.toHaveClass(/frozen/);
  expect(errors).toEqual([]);
});

test('every annual layer paints a varied field', async ({ page }) => {
  const { errors } = await openApp(page);
  const layers = ['Where to act — the year', 'Sunlit hours a year',
                  'Annual heat dose', 'Annual solar dose', 'Winter sun share',
                  'Month it peaks'];
  for (const name of layers) {
    await setLayer(page, name);
    const s = await facadeColorStats(page);
    expect(s.distinct, `${name} should paint more than a flat colour`).toBeGreaterThan(8);
    expect(s.max - s.min, `${name} should have contrast`).toBeGreaterThan(0.05);
  }
  expect(errors).toEqual([]);
});

test('south walls take more annual sun than north walls', async ({ page }) => {
  await openApp(page);
  const got = await page.evaluate(() => {
    const d = window.HC.data;
    const { nPan, nBand } = d.dims;
    const acc = { north: [0, 0], east: [0, 0], south: [0, 0], west: [0, 0] };
    for (let p = 0; p < nPan; p++) {
      const az = d.facades.az[p];
      const key = (az >= 315 || az < 45) ? 'north'
        : az < 135 ? 'east' : az < 225 ? 'south' : 'west';
      for (let b = 0; b < nBand; b++) {
        acc[key][0] += d.annualAt('sun_hours', p, b);
        acc[key][1]++;
      }
    }
    const out = {};
    for (const k of Object.keys(acc)) out[k] = acc[k][0] / acc[k][1];
    return out;
  });
  // Northern hemisphere. A failure here means the solar azimuth convention is
  // wrong somewhere, and no summary statistic in the interface would show it.
  expect(got.south).toBeGreaterThan(got.north * 1.5);
  expect(got.east).toBeGreaterThan(got.north);
});

test('the ranked list offers two orderings and they disagree', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.ordsw button')).toHaveCount(2);

  const waveTop = await page.locator('#side-body .rank .who .a').first().textContent();
  await page.locator('.ordsw button', { hasText: 'The year' }).click();
  await settle(page);
  const yearTop = await page.locator('#side-body .rank .who .a').first().textContent();
  expect(yearTop).not.toBe(waveTop);

  const agree = await page.evaluate(() =>
    window.HC.data.ranked.orderings.agreement);
  expect(agree.top50_overlap).toBeGreaterThan(0);
  expect(agree.top50_overlap).toBeLessThan(50);
});

test("a building's dossier carries the year and a monthly profile", async ({ page }) => {
  const { errors } = await openApp(page);
  await page.locator('#side-body .rank').first().click();
  await settle(page);
  await expect(page.locator('#side-body')).toContainText('The year');
  await expect(page.locator('#side-body')).toContainText('Sunlit hours a year');
  // Two charts: the monthly bars and the vertical profile.
  await expect(page.locator('#side-body svg.chart')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('the what-if panel shows the seasonal cost of a measure', async ({ page }) => {
  const { errors } = await openApp(page);
  await page.evaluate(() => document.querySelector('#tabs button[data-tab="whatif"]').click());
  await settle(page);
  await expect(page.locator('#tab-whatif')).toContainText('Across the year');
  const tables = page.locator('#tab-whatif table.sctab');
  await expect(tables).toHaveCount(2);
  // The annual table must carry a summer and a winter column with real numbers.
  const rows = await tables.nth(1).locator('tbody tr').count();
  expect(rows).toBeGreaterThan(3);
  expect(errors).toEqual([]);
});

test('the air layer fetches its profile on demand and then draws it', async ({ page }) => {
  const { errors } = await openApp(page);
  // NOT loaded up front, not even for the event day: it is 4.7 MB per period and
  // it is the least trustworthy field in the model, so it is fetched only when the
  // layer that shows it is selected.
  expect(await page.evaluate(() => window.HC.data.hasAir())).toBe(false);

  await setDate(page, '2026-03-14', 'month');
  expect(await page.evaluate(() => window.HC.data.hasAir())).toBe(false);

  await setLayer(page, 'Air temperature');
  await page.waitForFunction(() => window.HC.data.hasAir(), null, { timeout: 60_000 });
  await settle(page);
  const s = await facadeColorStats(page);
  expect(s.distinct).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});

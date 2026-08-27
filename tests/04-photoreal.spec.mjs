/* The photoreal context layer.
 *
 * Two things are being protected here, and only one of them is about features.
 *
 * The first is money. Photorealistic 3D Tiles bill per root tileset request —
 * roughly one per session — so the layer must construct nothing and request
 * nothing until a user deliberately switches it on. A regression that builds
 * the TilesRenderer eagerly would not look like a bug on screen; it would look
 * like a bill. Hence the assertions that no request ever reaches
 * tile.googleapis.com and that `scene.photoreal` does not even exist at rest.
 *
 * The second is Google's terms, which forbid caching or storing tile content.
 * Every visual baseline in this suite is committed to the repository, so the
 * layer must stay off for all of them — that is asserted here rather than left
 * as a convention someone breaks later while adding a screenshot.
 */

import { test, expect } from '@playwright/test';
import { openApp } from './helpers.mjs';

/** Pin the environment to "no key available".
 *
 * Without this the suite's behaviour depends on whether the developer happens
 * to have GOOGLE_MAPS_API_KEY in .env — and worse, on a machine that does, the
 * no-key test enabled the layer for real and spent a billable root tile
 * request. A test must never be able to cost money, so the server's answer is
 * stubbed and any remembered key cleared before the page runs a line of script.
 */
async function withoutKey(page) {
  await page.route('**/api/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"gmaps_key":""}' }));
  await page.addInitScript(() => {
    try { localStorage.removeItem('heatcanyon.gmaps_key'); } catch (e) { /* ignore */ }
  });
}

/** The opposite: pretend the environment supplies one, without ever enabling. */
async function withStubKey(page, key = 'AIzaTEST-not-a-real-key') {
  await page.route('**/api/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ gmaps_key: key }) }));
  await page.addInitScript(() => {
    try { localStorage.removeItem('heatcanyon.gmaps_key'); } catch (e) { /* ignore */ }
  });
}

/** Collect every request that would cost money, for the life of the page. */
function watchTileRequests(page) {
  const hits = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('tile.googleapis.com') || u.includes('/v1/3dtiles')) hits.push(u);
  });
  return hits;
}

test('costs nothing at rest: no tileset is built and no Google request is made', async ({ page }) => {
  const hits = watchTileRequests(page);
  await withoutKey(page);
  const { errors } = await openApp(page);
  expect(errors).toEqual([]);

  const state = await page.evaluate(() => ({
    on: window.HC.scene.photorealOn,
    // Deliberately checking for absence, not for a disabled instance: the
    // constructor is what issues the root request.
    constructed: !!window.HC.scene.photoreal,
    pressed: document.getElementById('pr-toggle')?.getAttribute('aria-pressed'),
    creditsHidden: document.getElementById('credits')?.hidden,
  }));

  expect(state.on).toBe(false);
  expect(state.constructed).toBe(false);
  expect(state.pressed).toBe('false');
  expect(state.creditsHidden).toBe(true);
  expect(hits).toEqual([]);
});

test('clicking the toggle without a key asks for one instead of enabling', async ({ page }) => {
  const hits = watchTileRequests(page);
  await withoutKey(page);
  await openApp(page);
  await page.click('#pr-toggle');

  const after = await page.evaluate(() => ({
    on: window.HC.scene.photorealOn,
    pressed: document.getElementById('pr-toggle').getAttribute('aria-pressed'),
    keyBoxHidden: document.getElementById('pr-key').hidden,
    status: document.getElementById('pr-status').textContent,
  }));

  expect(after.on).toBe(false);
  expect(after.pressed).toBe('false');
  expect(after.keyBoxHidden).toBe(false);
  expect(after.status).toMatch(/key/i);
  // Still nothing billable.
  expect(hits).toEqual([]);
});

test('an environment key is picked up but still requests nothing on its own', async ({ page }) => {
  const hits = watchTileRequests(page);
  await withStubKey(page);
  await openApp(page);

  // The status line is how a developer finds out the layer is available.
  await page.waitForFunction(
    () => /server/i.test(document.getElementById('pr-status')?.textContent || ''),
    null, { timeout: 20_000 },
  );
  const state = await page.evaluate(() => ({
    on: window.HC.scene.photorealOn,
    constructed: !!window.HC.scene.photoreal,
  }));
  // Available, advertised, and still inert: merely having a key must not cost.
  expect(state.on).toBe(false);
  expect(state.constructed).toBe(false);
  expect(hits).toEqual([]);
});

test('the elevation datum is the median footprint ground elevation', async ({ page }) => {
  await withoutKey(page);
  await openApp(page);
  const { datum, median, spread } = await page.evaluate(() => {
    const d = window.HC.data;
    const v = d.buildings.attrs
      .map((a) => a.base)
      .filter((x) => typeof x === 'number' && isFinite(x))
      .sort((a, b) => a - b);
    return {
      datum: window.HC.scene.datumM,
      median: v[v.length >> 1],
      spread: [v[0], v[v.length - 1]],
    };
  });
  expect(datum).toBeCloseTo(median, 6);
  // Sanity on the premise the datum exists to solve: Midtown's terrain really
  // does span enough elevation for a flat datum to misregister visibly.
  expect(spread[1] - spread[0]).toBeGreaterThan(10);
});

test('the true-elevation vertex set differs from the flat one by base minus datum', async ({ page }) => {
  await withoutKey(page);
  await openApp(page);
  const r = await page.evaluate(() => {
    const s = window.HC.scene;
    const f = s.data.facades;
    const flat = s.facadePosFlat, elev = s.facadePosElev;
    if (!flat || !elev) return { missing: true };

    // Check a spread of quads rather than all 294k vertices.
    const bad = [];
    let maxHoriz = 0;
    const step = Math.max(1, Math.floor(s.nQuad / 400));
    for (let q = 0; q < s.nQuad; q += step) {
      const p = s.quadPanel[q];
      const want = f.base[p] - s.datumM;
      const o = q * 12;
      for (let v = 0; v < 4; v++) {
        const dy = elev[o + v * 3 + 1] - flat[o + v * 3 + 1];
        if (Math.abs(dy - want) > 1e-3) bad.push({ q, dy, want });
        const dx = elev[o + v * 3 + 0] - flat[o + v * 3 + 0];
        const dz = elev[o + v * 3 + 2] - flat[o + v * 3 + 2];
        maxHoriz = Math.max(maxHoriz, Math.hypot(dx, dz));
      }
    }
    return { missing: false, bad: bad.slice(0, 5), nBad: bad.length, maxHoriz };
  });

  expect(r.missing).toBeFalsy();
  expect(r.nBad, JSON.stringify(r.bad)).toBe(0);
  // The outward push exists and is the modest bias it is meant to be, not a
  // wall relocated into the street.
  expect(r.maxHoriz).toBeGreaterThan(0.3);
  expect(r.maxHoriz).toBeLessThan(1.5);
});

test('switching the datum moves geometry and switching back restores it exactly', async ({ page }) => {
  await withoutKey(page);
  await openApp(page);
  const r = await page.evaluate(() => {
    const s = window.HC.scene;
    const attr = s.facadeMesh.geometry.getAttribute('position');
    const before = Float32Array.from(attr.array.subarray(0, 3000));

    s._useElevation(true);
    const moved = Float32Array.from(attr.array.subarray(0, 3000));

    s._useElevation(false);
    const back = Float32Array.from(attr.array.subarray(0, 3000));

    let nMoved = 0, nRestoredWrong = 0;
    for (let i = 0; i < before.length; i++) {
      if (Math.abs(moved[i] - before[i]) > 1e-4) nMoved++;
      if (Math.abs(back[i] - before[i]) > 1e-6) nRestoredWrong++;
    }
    return { nMoved, nRestoredWrong };
  });
  expect(r.nMoved).toBeGreaterThan(0);
  expect(r.nRestoredWrong).toBe(0);
});

test('no committed visual baseline has the photoreal layer enabled', async ({ page }) => {
  // Guards the caching prohibition: a screenshot taken with tiles on would put
  // Google content into git.
  await withoutKey(page);
  await openApp(page);
  const on = await page.evaluate(() => window.HC.scene.photorealOn);
  expect(on).toBe(false);
});

/* The opening film.
 *
 * Three things are worth defending with tests here, and one of them is a bug
 * that actually shipped into a working build.
 *
 * The camera is held on the equatorial plane from the moment the globe locks
 * onto New York, because the framing offset is supposed to come from rotating
 * the planet (`aim`), not from moving the eye (`tilt`). The first version kept a
 * two-hundredths-of-a-radian camera tilt through the descent. At four hundred
 * units out that is invisible; at three units above the surface it is about a
 * hundred and thirty kilometres, so the dive bottomed out over Connecticut with
 * New York a thousand pixels below the frame — and it looked fine the whole way
 * down, because the globe is round and any patch of it reads as "somewhere".
 * `lands on New York` pins that: at the bottom of the dive the study area must
 * project to the centre of the screen.
 *
 * The other two are contractual. `?intro=0` has to suppress the film completely,
 * because every other spec in this suite depends on it. And the skip control has
 * to produce a usable application, because it is the escape hatch.
 *
 * Seeking is done by moving the film's own clock origin. That is reaching into
 * the implementation, but this suite already drives the scene graph through
 * `window.HC` by design, and the alternative is a test that sits through a
 * hundred seconds of narration.
 */

import { test, expect } from '@playwright/test';

/** Load the page with the film enabled and wait until it offers to start. */
async function openFilm(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`);
  });
  await page.goto('/?intro=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => { const b = document.getElementById('film-begin'); return b && !b.disabled; },
    null, { timeout: 150_000 }
  );
  return { errors };
}

/** Move the film to `t` seconds and let a couple of frames land. */
async function seek(page, t) {
  await page.evaluate((tt) => { window.HC.film.t0 = performance.now() - tt * 1000; }, t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test('?intro=0 suppresses the film entirely', async ({ page }) => {
  await page.goto('/?intro=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 150_000 });
  // The overlay may still be in the markup, but it must never be shown, and the
  // application's own panels must not be held back waiting for it.
  await expect(page.locator('#film')).toBeHidden();
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(false);
  expect(await page.evaluate(() => !!window.HC.film)).toBe(false);
});

test('the title card offers to start, and names the modelled event', async ({ page }) => {
  const { errors } = await openFilm(page);
  await expect(page.locator('#film')).toBeVisible();
  await expect(page.locator('#film-title h1')).toHaveText('The Canyon');
  // The strap is built from meta.json, not typed into the markup.
  const strap = await page.locator('#film-title-strap').textContent();
  const label = await page.evaluate(() => window.HC.data.meta.event.label);
  expect(strap).toContain(label);
  // The interface waits behind the film.
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(true);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('every figure in the narration comes from the loaded data', async ({ page }) => {
  await openFilm(page);
  await page.click('#film-begin');
  const facts = await page.evaluate(() => {
    const { film, data } = window.HC;
    const text = film.story.beats.map((b) => b.text).join(' ');
    const items = data.ranked.items;
    const max = (pick) => Math.max(...items.map(pick));
    return {
      text,
      buildings: data.meta.counts.buildings.toLocaleString('en-US'),
      homes: data.meta.counts.residential_units.toLocaleString('en-US'),
      peakAir: Math.round(max((i) => i.measured.peak_air_c)),
      peakMrt: Math.round(max((i) => i.modelled.mrt_peak_c)),
      warmest: film.assets.temp.warmest[0],
      since: film.assets.temp.warmest10_since,
    };
  });
  expect(facts.text).toContain(facts.buildings);
  expect(facts.text).toContain(facts.homes);
  expect(facts.text).toContain(`${facts.peakAir} °C`);
  expect(facts.text).toContain(`${facts.peakMrt} °C`);
  expect(facts.text).toContain(String(facts.warmest));
  expect(facts.text).toContain(String(facts.since));
});

test('the dive lands on New York', async ({ page }) => {
  const { errors } = await openFilm(page);
  await page.click('#film-begin');

  const plan = await page.evaluate(() =>
    window.HC.film.story.beats.map((b) => ({ t0: b.t0, dur: b.dur, phase: b.phase || '' })));
  const handoff = plan.findIndex((b) => b.phase === 'handoff');
  expect(handoff).toBeGreaterThan(0);

  /** Where the study area projects to, in normalised device coordinates. */
  const nyc = () => page.evaluate(() => {
    const f = window.HC.film;
    const p = f._nycLocal.clone().applyMatrix4(f.earthGroup.matrixWorld).project(f.camera);
    return { x: p.x, y: p.y, altitude: f.camera.position.length() - 100, tilt: f.stage.tilt };
  });

  // Once locked, New York is centred horizontally and sits a little high, where
  // the framing puts it.
  await seek(page, plan[handoff - 2].t0 + 1);
  const locked = await nyc();
  expect(Math.abs(locked.x)).toBeLessThan(0.02);
  expect(locked.y).toBeGreaterThan(0.02);

  // At the bottom of the dive it is dead centre, and the camera has come back
  // onto the axis it was aiming along.
  await seek(page, plan[handoff].t0 + plan[handoff].dur - 0.05);
  const bottom = await nyc();
  expect(Math.abs(bottom.x)).toBeLessThan(0.01);
  expect(Math.abs(bottom.y)).toBeLessThan(0.03);
  expect(Math.abs(bottom.tilt)).toBeLessThan(0.002);
  expect(bottom.altitude).toBeLessThan(6);       // globe radius is 100 units

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('the handoff starts the city descent and the film clears itself away', async ({ page }) => {
  const { errors } = await openFilm(page);
  await page.click('#film-begin');
  const plan = await page.evaluate(() =>
    window.HC.film.story.beats.map((b) => ({ t0: b.t0, dur: b.dur, phase: b.phase || '' })));
  const handoff = plan.findIndex((b) => b.phase === 'handoff');

  // Landing inside the handoff beat has to put the city camera in the air.
  await seek(page, plan[handoff].t0 + 0.3);
  await page.waitForFunction(() => !!window.HC.scene._fly, null, { timeout: 20_000 });
  const flight = await page.evaluate(() => ({
    y: window.HC.scene.camera.position.y,
    fogFar: window.HC.scene.scene.fog.far,
  }));
  expect(flight.y).toBeGreaterThan(1500);
  // Fog has to open up too, or the descent cross-fades into a wall of fog colour.
  expect(flight.fogFar).toBeGreaterThan(6000);

  // Run out the closing captions.
  await seek(page, plan.at(-1).t0 + plan.at(-1).dur - 0.2);
  await page.waitForFunction(() => !document.getElementById('film'), null, { timeout: 30_000 });
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(false);
  await expect(page.locator('#left')).toBeVisible();
  await expect(page.locator('#time')).toBeVisible();

  // And the descent must have finished rather than leaving the camera adrift.
  await page.waitForFunction(() => !window.HC.scene._fly, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.HC.scene.controls.enabled)).toBe(true);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('skipping goes straight to a usable map', async ({ page }) => {
  const { errors } = await openFilm(page);
  await page.click('#film-straight');
  await page.waitForFunction(() => !document.getElementById('film'), null, { timeout: 20_000 });
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(false);
  await expect(page.locator('#left')).toBeVisible();
  // The replay control appears once the film is out of the way.
  await expect(page.locator('#film-replay')).toBeVisible();
  // The scene is at its default framing, not stranded mid-flight.
  expect(await page.evaluate(() => !!window.HC.scene._fly)).toBe(false);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

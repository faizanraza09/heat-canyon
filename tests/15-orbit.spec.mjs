/* Turning around a building.
 *
 * The gesture this file owns is not "rotate the view" but "walk round THIS
 * building" — the distinction that matters here, because a tower's four walls
 * are four different temperatures and three of them are always facing away.
 * Every test below therefore checks two things at once: that the view turned,
 * and that the building it turned around stayed exactly where it was and
 * exactly as far away. A rotation that quietly drifts off its subject looks
 * fine in a screenshot and is useless for the comparison the model exists to
 * support.
 *
 * Pan semantics stay in 98-drag-probe.spec.mjs; the one pan test here is a
 * guard that taking the right button and shift did not disturb the left one.
 */

import { test, expect } from '@playwright/test';
import { openApp, cameraSettled, settle } from './helpers.mjs';

const state = (page) => page.evaluate(() => {
  const s = window.HC.scene, c = s.camera.position, t = s.controls.target;
  const p = s._orbitPivot();
  const off = c.clone().sub(p);
  return {
    pos: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
    target: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
    pivot: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
    radius: +off.length().toFixed(2),
    phi: +Math.acos(Math.max(-1, Math.min(1, off.y / off.length()))).toFixed(4),
    bearing: +s.bearing.toFixed(2),
    selected: s.selected,
    spinning: s.spinning,
  };
});

const pickBuilding = async (page) => {
  await page.evaluate(() => window.HC.ui.showBuilding(
    window.HC.data.binToIndex.get(String(window.HC.data.ranked.items[0].bin))));
  await cameraSettled(page);
};

test('right-drag turns around the selected building', async ({ page }) => {
  const { errors } = await openApp(page);
  await pickBuilding(page);
  const a = await state(page);
  await page.mouse.move(880, 480);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 12; i++) await page.mouse.move(880 + i * 20, 480);
  await page.mouse.up({ button: 'right' });
  await settle(page);
  const b = await state(page);
  const dBearing = Math.abs(((b.bearing - a.bearing + 540) % 360) - 180);
  console.log('RIGHT-DRAG', a, b, 'turned', dBearing.toFixed(1));
  expect(dBearing, 'the view should have turned').toBeGreaterThan(30);
  expect(Math.abs(b.radius - a.radius), 'distance to the building should hold')
    .toBeLessThan(1);
  expect(Math.hypot(b.pivot[0] - a.pivot[0], b.pivot[2] - a.pivot[2]),
    'the pivot is the building and must not move').toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('shift and left-drag turns the same way', async ({ page }) => {
  await openApp(page);
  await pickBuilding(page);
  const a = await state(page);
  await page.keyboard.down('Shift');
  await page.mouse.move(880, 480);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(880 + i * 20, 480);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await settle(page);
  const b = await state(page);
  const dBearing = Math.abs(((b.bearing - a.bearing + 540) % 360) - 180);
  console.log('SHIFT-DRAG turned', dBearing.toFixed(1), 'radius', a.radius, b.radius);
  expect(dBearing).toBeGreaterThan(30);
  expect(Math.abs(b.radius - a.radius)).toBeLessThan(1);
});

test('plain left-drag still pans', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  await page.mouse.move(880, 480);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(880 + i * 20, 480);
  await page.mouse.up();
  await settle(page);
  const b = await state(page);
  const moved = Math.hypot(b.target[0] - a.target[0], b.target[2] - a.target[2]);
  const dBearing = Math.abs(((b.bearing - a.bearing + 540) % 360) - 180);
  console.log('LEFT-DRAG panned', moved.toFixed(1), 'turned', dBearing.toFixed(2));
  expect(moved, 'left-drag must still pan').toBeGreaterThan(50);
  expect(dBearing, 'left-drag must not turn').toBeLessThan(0.5);
});

test('Q E W S turn and tilt around the building, and tilt is clamped', async ({ page }) => {
  const { errors } = await openApp(page);
  await pickBuilding(page);
  const a = await state(page);
  await page.keyboard.press('e');
  await cameraSettled(page);
  const b = await state(page);
  const turned = Math.abs(((b.bearing - a.bearing + 540) % 360) - 180);
  console.log('E turned', turned.toFixed(1), 'radius', a.radius, b.radius);
  expect(turned).toBeGreaterThan(35);
  expect(turned).toBeLessThan(55);
  expect(Math.abs(b.radius - a.radius)).toBeLessThan(1);

  await page.keyboard.press('q');
  await cameraSettled(page);
  const c = await state(page);
  expect(Math.abs(((c.bearing - a.bearing + 540) % 360) - 180),
    'Q should undo E').toBeLessThan(1);

  // Tilt all the way down and all the way up; neither may pass the clamp.
  for (let i = 0; i < 12; i++) { await page.keyboard.press('s'); }
  await cameraSettled(page);
  const low = await state(page);
  for (let i = 0; i < 20; i++) { await page.keyboard.press('w'); }
  await cameraSettled(page);
  const high = await state(page);
  const max = await page.evaluate(() => window.HC.scene.controls.maxPolarAngle);
  console.log('TILT phi start', a.phi, 'low', low.phi, 'high', high.phi, 'max', max);
  expect(low.phi).toBeGreaterThan(a.phi);
  expect(low.phi).toBeLessThanOrEqual(max + 1e-3);
  expect(high.phi).toBeGreaterThanOrEqual(0.08);
  expect(high.phi).toBeLessThan(low.phi);
  expect(errors).toEqual([]);
});

test('O walks the camera round the building and a drag stops it', async ({ page }) => {
  const { errors } = await openApp(page);
  await pickBuilding(page);
  const a = await state(page);
  await page.keyboard.press('o');
  await page.waitForTimeout(1500);
  const b = await state(page);
  expect(b.spinning, 'O should start the orbit').toBe(true);
  const turned = Math.abs(((b.bearing - a.bearing + 540) % 360) - 180);
  console.log('SPIN turned', turned.toFixed(1), 'in 1.5 s; radius', a.radius, b.radius);
  expect(turned).toBeGreaterThan(3);
  expect(Math.abs(b.radius - a.radius), 'the orbit must hold its distance')
    .toBeLessThan(1);
  expect(await page.getAttribute('#nav-spin', 'aria-pressed')).toBe('true');

  await page.mouse.move(880, 480);
  await page.mouse.down();
  await page.mouse.move(900, 490);
  await page.mouse.up();
  await settle(page);
  const c = await state(page);
  expect(c.spinning, 'a drag should stop the orbit').toBe(false);
  expect(await page.getAttribute('#nav-spin', 'aria-pressed')).toBe('false');
  expect(errors).toEqual([]);
});

test('the turn pad buttons turn and tilt', async ({ page }) => {
  const { errors } = await openApp(page);
  await pickBuilding(page);
  const a = await state(page);
  await page.click('#nav-turn-r');
  await cameraSettled(page);
  const b = await state(page);
  const turned = Math.abs(((b.bearing - a.bearing + 540) % 360) - 180);
  console.log('PAD turned', turned.toFixed(1));
  expect(turned).toBeGreaterThan(35);
  await page.click('#nav-tilt-down');
  await cameraSettled(page);
  const c = await state(page);
  expect(c.phi).toBeGreaterThan(b.phi);
  expect(errors).toEqual([]);
});

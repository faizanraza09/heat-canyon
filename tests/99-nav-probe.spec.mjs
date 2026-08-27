/* Street-mode navigation, probed with real input events.
 *
 * Orbit-mode drag semantics live in 98-drag-probe.spec.mjs, which owns them and
 * checks them more rigorously. They used to be duplicated here, and when the
 * left-drag binding changed from orbit to pan the copy in this file was left
 * asserting the old behaviour — two suites making contradictory claims about
 * the same control. One owner per behaviour.
 */

import { test, expect } from '@playwright/test';
import { openApp, settle } from './helpers.mjs';

const cam = (page) => page.evaluate(() => {
  const s = window.HC.scene, c = s.camera.position, t = s.controls.target;
  return {
    mode: s.mode,
    pos: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
    target: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
    dist: +c.distanceTo(t).toFixed(2),
    yaw: +s.fp.yaw.toFixed(4), pitch: +s.fp.pitch.toFixed(4),
    selected: s.selected,
    fwd: (() => { const v = new (c.constructor)(); s.camera.getWorldDirection(v);
      return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; })(),
  };
});

test('STREET: W moves forward along the view direction', async ({ page }) => {
  await openApp(page);
  await page.click('#cam-street');
  await page.waitForTimeout(800);
  const a = await cam(page);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(900);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(200);
  const b = await cam(page);
  const dx = b.pos[0]-a.pos[0], dz = b.pos[2]-a.pos[2];
  const moved = Math.hypot(dx, dz);
  const dot = (dx*a.fwd[0] + dz*a.fwd[2]) / (moved || 1);
  console.log('WALK moved', moved.toFixed(1), 'm; alignment with view dir =', dot.toFixed(3));
  console.log('  fwd', a.fwd, 'delta', [dx.toFixed(1), dz.toFixed(1)]);
  expect(moved).toBeGreaterThan(1);
  expect(dot, 'W must move along where the camera is looking').toBeGreaterThan(0.9);
});

test('STREET: mouse drag right turns the view right', async ({ page }) => {
  await openApp(page);
  await page.click('#cam-street');
  await page.waitForTimeout(800);
  const a = await cam(page);
  await page.mouse.move(900, 500);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) { await page.mouse.move(900 + i*20, 500); await page.waitForTimeout(30); }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const b = await cam(page);
  // Dragging right should rotate the view clockwise: the forward vector should
  // rotate from a.fwd toward its right-hand side.
  const cross = a.fwd[0]*b.fwd[2] - a.fwd[2]*b.fwd[0];
  console.log('LOOK yaw', a.yaw, '->', b.yaw, ' fwd', a.fwd, '->', b.fwd, ' cross', cross.toFixed(4));
  expect(Math.abs(b.yaw - a.yaw), 'yaw must change').toBeGreaterThan(0.05);
  expect(cross, 'drag right should turn view right (clockwise)').toBeGreaterThan(0);
});

test('STREET: scroll wheel should do something useful', async ({ page }) => {
  await openApp(page);
  await page.click('#cam-street');
  await page.waitForTimeout(800);
  const a = await cam(page);
  await page.mouse.move(900, 500);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(80); }
  await page.waitForTimeout(300);
  const b = await cam(page);
  const moved = Math.hypot(b.pos[0]-a.pos[0], b.pos[2]-a.pos[2]);
  console.log('STREET SCROLL moved', moved.toFixed(2), 'm  pos', a.pos, '->', b.pos);
  expect(moved, 'scroll should move the walker, not be inert').toBeGreaterThan(0.5);
});

test('KEYS must not steer the camera while typing in the analyst box', async ({ page }) => {
  await openApp(page);
  await page.click('#cam-street');
  await page.waitForTimeout(800);
  const a = await cam(page);
  await page.evaluate(() => document.querySelector('#tabs button[data-tab="ask"]').click());
  await page.waitForTimeout(300);
  await page.click('#tab-ask textarea');
  await page.keyboard.type('why is west 47th street so warm', { delay: 25 });
  await page.waitForTimeout(400);
  const b = await cam(page);
  const moved = Math.hypot(b.pos[0]-a.pos[0], b.pos[2]-a.pos[2]);
  const text = await page.inputValue('#tab-ask textarea');
  console.log('TYPING moved camera', moved.toFixed(2), 'm; textarea =', JSON.stringify(text));
  expect(text).toContain('west 47th');
  expect(moved, 'typing must not move the camera').toBeLessThan(0.5);
});

test('STREET: walker cannot pass through a building', async ({ page }) => {
  await openApp(page);
  await page.click('#cam-street');
  await page.waitForTimeout(800);
  // Walk sideways hard into the canyon wall.
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyD');
  await page.waitForTimeout(300);
  const inside = await page.evaluate(() => {
    const s = window.HC.scene, d = window.HC.data;
    const p = s.camera.position;
    // Is the eye inside any building footprint?
    const x = p.x, y = -p.z;
    for (let i = 0; i < d.buildings.rings.length; i++) {
      const r = d.buildings.rings[i], n = r.length / 2;
      if (n < 3) continue;
      let hit = false;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const xa = r[a*2], ya = r[a*2+1], xb = r[b*2], yb = r[b*2+1];
        if (((ya > y) !== (yb > y)) && (x < (xb-xa)*(y-ya)/(yb-ya)+xa)) hit = !hit;
      }
      if (hit && d.buildings.attrs[i].h > 2) return { inside: true, building: i, h: d.buildings.attrs[i].h };
    }
    return { inside: false };
  });
  console.log('after walking into the wall:', JSON.stringify(inside));
  expect(inside.inside, 'the walker should not end up inside a building').toBe(false);
});

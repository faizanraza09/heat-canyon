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

test('ORBIT: scroll wheel zooms', async ({ page }) => {
  await openApp(page);
  const a = await cam(page);
  await page.mouse.move(900, 500);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
  await settle(page); await page.waitForTimeout(400);
  const b = await cam(page);
  console.log('ZOOM dist', a.dist, '->', b.dist);
  expect(b.dist).toBeLessThan(a.dist * 0.95);
});

test('ORBIT: left-drag rotates', async ({ page }) => {
  await openApp(page);
  const a = await cam(page);
  await page.mouse.move(900, 500);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) { await page.mouse.move(900 + i * 25, 500); await page.waitForTimeout(30); }
  await page.mouse.up();
  await settle(page); await page.waitForTimeout(500);
  const b = await cam(page);
  console.log('ROTATE pos', a.pos, '->', b.pos);
  const moved = Math.hypot(b.pos[0]-a.pos[0], b.pos[1]-a.pos[1], b.pos[2]-a.pos[2]);
  expect(moved).toBeGreaterThan(50);
});

test('ORBIT: drag must NOT select a building', async ({ page }) => {
  await openApp(page);
  await page.mouse.move(900, 500);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) { await page.mouse.move(900 + i*25, 500 + i*8); await page.waitForTimeout(30); }
  await page.mouse.up();
  await page.waitForTimeout(600);
  const b = await cam(page);
  console.log('after drag, selected =', b.selected);
  expect(b.selected, 'a drag should not count as a click-to-select').toBeNull();
});

test('ORBIT: right-drag pans the target', async ({ page }) => {
  await openApp(page);
  const a = await cam(page);
  await page.mouse.move(900, 500);
  await page.mouse.down({ button: 'right' });
  for (let i = 0; i < 8; i++) { await page.mouse.move(900 + i*20, 500 + i*20); await page.waitForTimeout(30); }
  await page.mouse.up({ button: 'right' });
  await settle(page); await page.waitForTimeout(400);
  const b = await cam(page);
  console.log('PAN target', a.target, '->', b.target);
  const moved = Math.hypot(b.target[0]-a.target[0], b.target[2]-a.target[2]);
  expect(moved).toBeGreaterThan(5);
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

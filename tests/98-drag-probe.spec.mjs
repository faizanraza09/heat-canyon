/* Does dragging do what a hand expects?
 *
 * The complaint this encodes: dragging left should move the view left, and
 * dragging up should move it up. With plain OrbitControls a left-drag orbited
 * instead, so the city rotated about its centre and the direction of travel
 * depended on where you happened to be standing. These tests assert on the
 * actual sign of the motion, which is the only thing that settles it.
 */

import { test, expect } from '@playwright/test';
import { openApp, settle } from './helpers.mjs';

const state = (page) => page.evaluate(() => {
  const s = window.HC.scene;
  const c = s.camera.position, t = s.controls.target;
  return {
    cam: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
    target: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
    dist: +c.distanceTo(t).toFixed(2),
    // Screen-space right and up vectors of the camera, so "left" and "up" can
    // be asked about in the viewer's frame rather than in world axes.
    right: (() => {
      const m = s.camera.matrixWorld.elements;
      return [+m[0].toFixed(3), +m[1].toFixed(3), +m[2].toFixed(3)];
    })(),
  };
});

async function drag(page, dx, dy, button = 'left') {
  await page.mouse.move(880, 480);
  await page.mouse.down({ button });
  const N = 12;
  for (let i = 1; i <= N; i++) {
    await page.mouse.move(880 + (dx * i) / N, 480 + (dy * i) / N);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button });
  await settle(page);
  await page.waitForTimeout(50);
}

test('drag right slides the view right', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  await drag(page, 260, 0);
  const b = await state(page);

  const move = [b.target[0] - a.target[0], 0, b.target[2] - a.target[2]];
  // Project the target's motion onto the camera's own right vector. Dragging
  // the mouse right must carry the view's centre to the LEFT in camera space,
  // because the content follows the hand.
  const along = move[0] * a.right[0] + move[2] * a.right[2];
  console.log('drag right: target', a.target, '->', b.target, ' along-right =', along.toFixed(1));
  expect(Math.hypot(move[0], move[2]), 'the view must move at all').toBeGreaterThan(20);
  expect(along, 'dragging right should move the view centre left (content goes right)').toBeLessThan(0);
  // A pan is a translation, so the distance to the target must be preserved.
  expect(Math.abs(b.dist - a.dist), 'panning must not change zoom').toBeLessThan(a.dist * 0.06);
});

test('drag left moves the camera right so the map follows the hand', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  await drag(page, -260, 0);
  const b = await state(page);

  const move = [b.target[0] - a.target[0], 0, b.target[2] - a.target[2]];
  const along = move[0] * a.right[0] + move[2] * a.right[2];
  console.log('drag left: target', a.target, '->', b.target, ' along-right =', along.toFixed(1));
  expect(Math.hypot(move[0], move[2]), 'the view must move at all').toBeGreaterThan(20);
  expect(along, 'dragging left should move the camera/view centre right').toBeGreaterThan(0);
});

test('drag down slides the ground down', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  await drag(page, 0, 240);
  const b = await state(page);

  // To make the ground appear LOWER on screen the camera travels forward over
  // it, so the target moves AWAY along the view direction. That is the same
  // grab-the-map convention as the horizontal gesture.
  const fwd = await page.evaluate(() => {
    const v = new (window.HC.scene.camera.position.constructor)();
    window.HC.scene.camera.getWorldDirection(v);
    const l = Math.hypot(v.x, v.z);
    return [v.x / l, v.z / l];
  });
  const move = [b.target[0] - a.target[0], b.target[2] - a.target[2]];
  const along = move[0] * fwd[0] + move[1] * fwd[1];
  console.log('drag down: target', a.target, '->', b.target, ' along-view =', along.toFixed(1));
  expect(Math.hypot(...move), 'the view must move at all').toBeGreaterThan(20);
  expect(along, 'dragging down should carry the view forward over the ground').toBeGreaterThan(0);
  expect(Math.abs(b.dist - a.dist), 'panning must not change zoom').toBeLessThan(a.dist * 0.06);
});

test('drag up slides the ground up', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  const fwd = await page.evaluate(() => {
    const v = new (window.HC.scene.camera.position.constructor)();
    window.HC.scene.camera.getWorldDirection(v);
    const l = Math.hypot(v.x, v.z);
    return [v.x / l, v.z / l];
  });
  await drag(page, 0, -220);
  const b = await state(page);

  const move = [b.target[0] - a.target[0], b.target[2] - a.target[2]];
  const along = move[0] * fwd[0] + move[1] * fwd[1];
  console.log('drag up: target', a.target, '->', b.target, ' along-view =', along.toFixed(1));
  expect(Math.hypot(...move), 'vertical dragging must move the view').toBeGreaterThan(20);
  expect(along, 'dragging up should carry the view backward so the ground follows up').toBeLessThan(0);
});

test('pan stops on mouseup instead of drifting', async ({ page }) => {
  await openApp(page);
  await page.mouse.move(880, 480);
  await page.mouse.down();
  await page.mouse.move(1060, 560, { steps: 10 });
  await page.mouse.up();
  const released = await state(page);
  await page.waitForTimeout(500);
  const later = await state(page);
  const drift = Math.hypot(
    later.target[0] - released.target[0],
    later.target[2] - released.target[2]
  );
  expect(drift, 'the camera should stop with the pointer').toBeLessThan(0.5);
});

test('left-drag pans, it does not orbit', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  await drag(page, 300, 0);
  const b = await state(page);

  // A pan translates camera and target together, so the vector between them is
  // unchanged. An orbit would swing the camera while the target sat still.
  const camMove = [b.cam[0] - a.cam[0], b.cam[2] - a.cam[2]];
  const tgtMove = [b.target[0] - a.target[0], b.target[2] - a.target[2]];
  const diff = Math.hypot(camMove[0] - tgtMove[0], camMove[1] - tgtMove[1]);
  console.log('camera moved', camMove.map((v) => v.toFixed(1)),
              ' target moved', tgtMove.map((v) => v.toFixed(1)),
              ' rigidity error', diff.toFixed(2));
  expect(Math.hypot(...tgtMove)).toBeGreaterThan(20);
  expect(diff, 'camera and target must translate together').toBeLessThan(6);
});

test('right-drag still rotates, and keeps its distance', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  await drag(page, 260, 0, 'right');
  const b = await state(page);
  const tgtMove = Math.hypot(b.target[0] - a.target[0], b.target[2] - a.target[2]);
  const camMove = Math.hypot(b.cam[0] - a.cam[0], b.cam[2] - a.cam[2]);
  console.log('right-drag: target moved', tgtMove.toFixed(2), ' camera moved', camMove.toFixed(1),
              ' dist', a.dist, '->', b.dist);
  expect(camMove, 'right-drag should swing the camera').toBeGreaterThan(50);
  expect(tgtMove, 'right-drag should leave the target put').toBeLessThan(6);
  expect(Math.abs(b.dist - a.dist), 'rotating must not change zoom').toBeLessThan(a.dist * 0.06);
});

test('the first pan cancels a camera flight and is not swallowed', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => window.HC.scene.flyIn({ seconds: 10 }));
  await page.waitForTimeout(150);
  await drag(page, 180, 0);
  const v = await page.evaluate(() => {
    const s = window.HC.scene;
    return {
      flying: !!s._fly,
      enabled: s.controls.enabled,
      targetTravel: Math.hypot(s.controls.target.x, s.controls.target.z),
      fog: [s.scene.fog.near, s.scene.fog.far],
    };
  });
  expect(v.flying, 'direct input should own the camera immediately').toBe(false);
  expect(v.enabled).toBe(true);
  expect(v.targetTravel, 'the cancelling drag itself should pan').toBeGreaterThan(20);
  expect(v.fog).toEqual([1400, 4800]);
});

test('panning cannot wander off the study area', async ({ page }) => {
  await openApp(page);
  await drag(page, 6000, 0);
  const b = await state(page);
  const lim = await page.evaluate(() => window.HC.scene._panLimit);
  console.log('after a hard edge drag, target', b.target, ' limit', lim);
  expect(Math.abs(b.target[0])).toBeLessThanOrEqual(lim.x + 1);
  expect(Math.abs(b.target[2])).toBeLessThanOrEqual(lim.z + 1);

  await drag(page, -80, 0);
  const c = await state(page);
  const reversed = (c.target[0] - b.target[0]) * b.right[0]
    + (c.target[2] - b.target[2]) * b.right[2];
  expect(reversed, 'reversing at the boundary should respond immediately').toBeGreaterThan(5);
});

/* --------------------------------------------------------------- folding */

test('either panel folds away and comes back', async ({ page }) => {
  await openApp(page);

  const vis = () => page.evaluate(() => {
    const f = (id) => {
      const e = document.getElementById(id);
      return e ? !e.classList.contains('folded') : null;
    };
    const handle = (id) => {
      const e = document.getElementById(id);
      return e ? !e.hidden : null;
    };
    return {
      left: f('left'), right: f('side'),
      leftHandle: handle('unfold-left'), rightHandle: handle('unfold-right'),
    };
  });

  expect(await vis()).toEqual(
    { left: true, right: true, leftHandle: false, rightHandle: false });

  // Fold the left panel. Its reopen handle must appear, because a control
  // living inside a folded panel is a control you cannot reach.
  await page.click('#left .fold');
  await page.waitForTimeout(400);
  let v = await vis();
  expect(v.left).toBe(false);
  expect(v.leftHandle).toBe(true);
  expect(v.right).toBe(true);

  await page.click('#unfold-left');
  await page.waitForTimeout(400);
  v = await vis();
  expect(v.left).toBe(true);
  expect(v.leftHandle).toBe(false);

  // The right panel folds independently.
  await page.click('#side .fold');
  await page.waitForTimeout(400);
  v = await vis();
  expect(v.right).toBe(false);
  expect(v.rightHandle).toBe(true);
  expect(v.left).toBe(true);
  await page.click('#unfold-right');
  await page.waitForTimeout(400);

  // Escape folds both, and restores both.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  v = await vis();
  expect(v.left).toBe(false);
  expect(v.right).toBe(false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  v = await vis();
  expect(v.left).toBe(true);
  expect(v.right).toBe(true);
});

test('Escape does not fold panels while typing a question', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => document.querySelector('#tabs button[data-tab="ask"]').click());
  await page.waitForTimeout(300);
  await page.click('#tab-ask textarea');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const folded = await page.evaluate(() =>
    document.getElementById('left').classList.contains('folded'));
  expect(folded, 'Escape in a text field must not fold the panel away').toBe(false);
});

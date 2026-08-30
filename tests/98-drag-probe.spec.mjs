/* Does dragging do what a hand expects?
 *
 * The complaint this encodes: dragging left should move the view left, and
 * dragging up should move it up. With plain OrbitControls a left-drag orbited
 * instead, so the city rotated about its centre and the direction of travel
 * depended on where you happened to be standing. These tests assert on the
 * actual sign of the motion, which is the only thing that settles it.
 *
 * Turning is a different gesture with a different pivot and lives in
 * 15-orbit.spec.mjs. One owner per behaviour.
 */

import { test, expect } from '@playwright/test';
import { openApp, settle, cameraSettled } from './helpers.mjs';

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
    const d = s.camera.position.distanceTo(s.controls.target);
    return {
      flying: !!s._fly,
      enabled: s.controls.enabled,
      targetTravel: Math.hypot(s.controls.target.x, s.controls.target.z),
      fog: [s.scene.fog.near, s.scene.fog.far],
      dist: d,
    };
  });
  expect(v.flying, 'direct input should own the camera immediately').toBe(false);
  expect(v.enabled).toBe(true);
  expect(v.targetTravel, 'the cancelling drag itself should pan').toBeGreaterThan(20);
  // The haze reopens to the fly-over's own range. It is no longer a fixed pair:
  // once the camera could stand twelve kilometres off, a fog that saturated at
  // a fixed distance buried the whole model long before you got there, so both
  // ends scale with the viewing distance. At the default framing that is very
  // close to the base pair, which is what this checks — the flight's own much
  // deeper fog has been let go of.
  expect(v.fog[0], 'near haze re-opened').toBeGreaterThan(1800);
  expect(v.fog[0]).toBeLessThan(4200);
  expect(v.fog[1], 'far haze re-opened').toBeGreaterThan(8000);
  expect(v.fog[1] / v.fog[0], 'and keeps its shape').toBeCloseTo(11000 / 2400, 1);
});

/* --------------------------------------------------- fly-over conventions */

test('double click closes in on what is under the pointer', async ({ page }) => {
  await openApp(page);
  const a = await state(page);
  await page.mouse.dblclick(880, 620);
  await cameraSettled(page);
  const b = await state(page);
  console.log('dblclick dist', a.dist, '->', b.dist, ' target', a.target, '->', b.target);
  expect(b.dist, 'a double click should close in').toBeLessThan(a.dist * 0.8);
  // Zoom-to-cursor: the target moves toward the point clicked, which is what
  // makes the gesture read as "go there" rather than "get closer to the middle".
  expect(Math.hypot(b.target[0] - a.target[0], b.target[2] - a.target[2]),
    'the pivot should move toward the pointer').toBeGreaterThan(5);
});

test('the compass reads the bearing and puts the camera back on north', async ({ page }) => {
  await openApp(page);
  // Turn well off north.
  await drag(page, 300, 0, 'right');
  await cameraSettled(page);
  const turned = await page.evaluate(() => window.HC.scene.bearing);
  const rose = await page.getAttribute('#nav-rose', 'transform');
  console.log('bearing', turned.toFixed(1), ' rose', rose);
  expect(Math.min(turned, 360 - turned), 'the drag should leave us off north')
    .toBeGreaterThan(4);
  // The needle turns opposite to the camera so that north stays north.
  expect(rose).toMatch(/^rotate\(-?\d+ 22 22\)$/);
  const shown = Number(rose.match(/rotate\((-?\d+)/)[1]);
  expect(Math.abs(((-shown - turned + 540) % 360) - 180), 'the needle must agree with the camera')
    .toBeLessThan(2);

  const before = await state(page);
  await page.click('#nav-compass');
  await cameraSettled(page);
  const after = await state(page);
  const north = await page.evaluate(() => window.HC.scene.bearing);
  console.log('after facing north: bearing', north.toFixed(2), ' dist', after.dist);
  expect(Math.min(north, 360 - north), 'the compass must face north').toBeLessThan(0.5);
  // Facing north is a turn, not a move: the framing has to survive it.
  expect(after.dist).toBeCloseTo(before.dist, 0);
  expect(Math.hypot(after.target[0] - before.target[0],
    after.target[2] - before.target[2]), 'the pivot stays put').toBeLessThan(1);
});

test('N faces north from the keyboard too', async ({ page }) => {
  await openApp(page);
  await drag(page, 260, 0, 'right');
  await cameraSettled(page);
  await page.keyboard.press('n');
  await cameraSettled(page);
  const north = await page.evaluate(() => window.HC.scene.bearing);
  expect(Math.min(north, 360 - north)).toBeLessThan(0.5);
});

test('the zoom buttons step in and out and stay within the limits', async ({ page }) => {
  await openApp(page);
  const d0 = (await state(page)).dist;
  await page.click('#nav-in');
  await cameraSettled(page);
  const d1 = (await state(page)).dist;
  await page.click('#nav-out');
  await cameraSettled(page);
  const d2 = (await state(page)).dist;
  console.log('zoom', d0, '->', d1, '->', d2);
  expect(d1, '+ closes in').toBeLessThan(d0 * 0.85);
  expect(d2, '− opens back out').toBeGreaterThan(d1 * 1.15);
  expect(d2, 'and lands back where it started').toBeCloseTo(d0, 0);

  // Hammering the button must not run off the end of the range.
  for (let i = 0; i < 14; i++) { await page.click('#nav-out'); }
  await cameraSettled(page);
  const far = await page.evaluate(() => ({
    d: window.HC.scene.camera.position.distanceTo(window.HC.scene.controls.target),
    max: window.HC.scene.controls.maxDistance,
  }));
  expect(far.d).toBeLessThanOrEqual(far.max + 1);
});

test('the fly-over may roam well past the study area', async ({ page }) => {
  await openApp(page);
  const lim = await page.evaluate(() => window.HC.scene._panLimit);
  const aoi = await page.evaluate(() => window.HC.data.meta.aoi);
  // The old boundary was the study area plus 900 m — about one block outside
  // the modelled buildings, which is close enough to meet on an ordinary drag.
  // There is ground under the camera for kilometres, so the guard rail should
  // be somewhere you have to go looking for.
  expect(lim.x - aoi.width_m / 2, 'roaming room east and west').toBeGreaterThan(3000);
  expect(lim.z - aoi.height_m / 2, 'roaming room north and south').toBeGreaterThan(3000);

  for (let i = 0; i < 4; i++) await drag(page, 0, -320);
  const b = await state(page);
  console.log('after four hard drags, target', b.target, 'limit', lim);
  expect(Math.hypot(b.target[0], b.target[2]),
    'four drags should not have hit the wall').toBeLessThan(
    Math.hypot(lim.x, lim.z) - 10);
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
      left: f('left'), right: f('side'), bottom: f('time'),
      leftHandle: handle('unfold-left'), rightHandle: handle('unfold-right'),
      bottomHandle: handle('unfold-bottom-wrap'),
    };
  });

  expect(await vis()).toEqual({
    left: true, right: true, bottom: true,
    leftHandle: false, rightHandle: false, bottomHandle: false,
  });

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

  // The clock folds too, and names the hour it will bring back.
  await page.click('#fold-bottom');
  await page.waitForTimeout(400);
  v = await vis();
  expect(v.bottom).toBe(false);
  expect(v.bottomHandle).toBe(true);
  expect(await page.locator('#unfold-bottom').textContent()).toMatch(/^\d\d:00/);
  await page.click('#unfold-bottom');
  await page.waitForTimeout(400);
  expect((await vis()).bottom).toBe(true);

  // The bracket keys fold each region on its own — they are printed in the
  // panel, under the camera controls, so they are part of the contract.
  for (const [key, which] of [['[', 'left'], [']', 'right'], ['\\', 'bottom']]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    expect((await vis())[which], `${key} should fold ${which}`).toBe(false);
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    expect((await vis())[which], `${key} should restore ${which}`).toBe(true);
  }

  // H clears the whole view, and restores it.
  await page.keyboard.press('h');
  await page.waitForTimeout(500);
  v = await vis();
  expect(v.left).toBe(false);
  expect(v.right).toBe(false);
  expect(v.bottom).toBe(false);
  await page.keyboard.press('h');
  await page.waitForTimeout(500);
  v = await vis();
  expect(v.left).toBe(true);
  expect(v.right).toBe(true);
  expect(v.bottom).toBe(true);
});

test('Escape drops the selected building without folding anything', async ({ page }) => {
  await openApp(page);
  await page.click('#side-body .rank >> nth=0');
  await page.waitForTimeout(700);
  // Whatever the first row happens to be, not index 0. The ranking is a merged
  // ordering of the wave and the year, so the row at the top of the list is
  // not the first entry of the underlying array — this asserted `.toBe(0)` and
  // failed on the ordering rather than on anything about the Escape key.
  const picked = await page.evaluate(() => window.HC.ui.selected);
  expect(picked, 'clicking a row selects it').not.toBeNull();
  await expect(page.locator('#selcard')).toBeVisible();

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.HC.ui.selected)).toBe(null);
  await expect(page.locator('#selcard')).toBeHidden();
  await expect(page.locator('#left')).not.toHaveClass(/folded/);
  await expect(page.locator('#side')).not.toHaveClass(/folded/);
});

test('the shortcuts stay out of the analyst box', async ({ page }) => {
  await openApp(page);
  // The analyst is no longer a tab in the left panel — it opens in its own
  // window over the map — so this reaches for the button that opens it. The old
  // selector returned null and the test failed on a TypeError rather than on
  // anything about keyboard focus.
  await page.evaluate(() => document.getElementById('analyst-open').click());
  await page.waitForTimeout(300);
  await page.click('#analyst-body textarea');
  // Every single-character shortcut is also a character someone might type.
  await page.keyboard.type('h[]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    left: document.getElementById('left').classList.contains('folded'),
    right: document.getElementById('side').classList.contains('folded'),
    typed: document.querySelector('#analyst-body textarea').value,
  }));
  expect(state.left, 'a shortcut typed into a text field must not fold a panel').toBe(false);
  expect(state.right).toBe(false);
  expect(state.typed, 'the keystrokes should have reached the field').toBe('h[]');
});

/* Camera navigation that 98-drag-probe does not own.
 *
 * Drag semantics live in 98-drag-probe.spec.mjs, which owns them and checks
 * them more rigorously. They used to be duplicated here, and when the left-drag
 * binding changed from orbit to pan the copy in this file was left asserting
 * the old behaviour — two suites making contradictory claims about the same
 * control. One owner per behaviour.
 *
 * The bulk of this file was the first-person street walker: forward motion,
 * strafing, collision, click-to-move, the zenith clamp, wedging. That mode has
 * been removed, and its tests with it.
 */

import { test, expect } from '@playwright/test';
import { openApp } from './helpers.mjs';

const cam = (page) => page.evaluate(() => {
  const s = window.HC.scene, c = s.camera.position, t = s.controls.target;
  return {
    pos: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
    target: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
    dist: +c.distanceTo(t).toFixed(2),
    selected: s.selected,
    fwd: (() => { const v = new (c.constructor)(); s.camera.getWorldDirection(v);
      return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; })(),
  };
});


test('KEYS must not steer the camera while typing in the analyst box', async ({ page }) => {
  await openApp(page);
  const a = await cam(page);
  // The analyst is no longer a tab in the left panel — it opens in its own
  // window over the map — so this reaches for the button that opens it. The old
  // selector returned null and the test failed on a TypeError rather than on
  // anything about keyboard focus.
  await page.evaluate(() => document.getElementById('analyst-open').click());
  await page.waitForTimeout(300);
  await page.click('#analyst-body textarea');
  await page.keyboard.type('why is west 47th street so warm', { delay: 25 });
  await page.waitForTimeout(400);
  const b = await cam(page);
  const moved = Math.hypot(b.pos[0]-a.pos[0], b.pos[2]-a.pos[2]);
  const text = await page.inputValue('#analyst-body textarea');
  console.log('TYPING moved camera', moved.toFixed(2), 'm; textarea =', JSON.stringify(text));
  expect(text).toContain('west 47th');
  expect(moved, 'typing must not move the camera').toBeLessThan(0.5);
});


/* --------------------------------------------------- gestures that end

   The bug these hold shut: a look-drag whose pointerup never arrived — the
   button released outside the window, or a context menu eating it — left the
   drag open, and from then on every ordinary mouse movement turned the camera
   with no button held. The view span as you reached for a control, so W walked
   you somewhere the frame was no longer pointing and the movement keys looked
   wrong. It is a stuck gesture, and it is invisible in the code that causes it.
*/



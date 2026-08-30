/* The clock moves the city rather than cutting to it.
 *
 * Stepping the hour used to replace 294,150 painted quads in one frame. The
 * scene now carries the hour it came from and the hour it is going to at the
 * same time and slides a uniform between them (see `fadeable` in scene.js), so
 * these tests are about the dissolve being real, monotonic, and — the part that
 * is easy to get wrong — always terminating on its destination however it is
 * interrupted. A mix stranded below 1 is a city permanently showing a blend of
 * two hours, which is the one failure mode that would be worse than the cut.
 */

import { test, expect } from '@playwright/test';
import { openApp, settle } from './helpers.mjs';

/** Park the mix by hand. The frame clock owns it while a dissolve is live, so
 *  it has to be taken off first or `tick` overwrites the value before the frame
 *  is drawn. */
async function frameAt(page, mix) {
  await page.evaluate(async (m) => {
    const s = window.HC.scene;
    s._fade = null;
    s._mixU.value = m;
    await new Promise((r) => requestAnimationFrame(r));
  }, mix);
}

test('a settled scene shows the buffer it painted, with no dissolve pending',
  async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => ({
      fading: window.HC.scene.fading, mix: window.HC.scene._mixU.value,
    }))).toEqual({ fading: false, mix: 1 });
  });

test('an hour step draws intermediate frames rather than cutting', async ({ page }) => {
  const { errors } = await openApp(page);
  await page.evaluate(() => window.HC.ui.setHour(3));
  await settle(page);
  await page.evaluate(() => window.HC.ui.setHour(6));

  /* Three frames off one parked dissolve. The ends are the two hours; the
     middle has to be neither of them, which is the whole claim. The clip is the
     city rather than the whole viewport so a panel repaint cannot be what makes
     the frames differ. */
  const shots = [];
  for (const m of [0, 0.5, 1]) {
    await frameAt(page, m);
    shots.push((await page.screenshot({
      clip: { x: 420, y: 200, width: 760, height: 560 },
    })).toString('base64'));
  }
  expect(new Set(shots).size).toBe(3);
  expect(errors).toEqual([]);
});

test('the mix runs forward to 1 and the dissolve ends', async ({ page }) => {
  await openApp(page);
  await settle(page);
  const trace = await page.evaluate(async () => {
    const s = window.HC.scene;
    window.HC.ui.setHour(1);
    const out = [];
    // Software GL runs this scene at a few frames a second, so the sample count
    // is a property of the machine and only the trajectory is asserted.
    for (let i = 0; i < 400 && s.fading; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push(s._mixU.value);
    }
    return { out, fading: s.fading, mix: s._mixU.value };
  });
  expect(trace.out.length).toBeGreaterThan(0);
  expect(trace.out.every((v, i) => i === 0 || v >= trace.out[i - 1])).toBe(true);
  expect(trace.fading).toBe(false);
  expect(trace.mix).toBe(1);
});

test('interrupting a dissolve restarts it rather than stranding the mix',
  async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const s = window.HC.scene;
      window.HC.ui.setHour(1);
      await new Promise((rs) => requestAnimationFrame(rs));
      // Half way across, change your mind. The picture on screen is a blend
      // that exists in neither buffer and has to be pinned into the one being
      // left behind.
      s._mixU.value = 0.4;
      window.HC.ui.setHour(5);
      const restarted = s._mixU.value;
      for (let i = 0; i < 400 && s.fading; i++) {
        await new Promise((rs) => requestAnimationFrame(rs));
      }
      return { restarted, fading: s.fading, mix: s._mixU.value };
    });
    expect(r.restarted).toBe(0);
    expect(r.fading).toBe(false);
    expect(r.mix).toBe(1);
  });

test('a repaint that is not a time change lands whole', async ({ page }) => {
  await openApp(page);
  // A selection writes only the destination half, so leaving a dissolve part
  // way would blend a selected city with an unselected one.
  const r = await page.evaluate(async () => {
    const s = window.HC.scene;
    window.HC.ui.setHour(2);
    await new Promise((rs) => requestAnimationFrame(rs));
    s.select(12);
    return { fading: s.fading, mix: s._mixU.value };
  });
  expect(r).toEqual({ fading: false, mix: 1 });
});

test('?smooth=0 puts the cut back', async ({ page }) => {
  await page.goto('/?intro=0&smooth=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 150_000 });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 30_000 });
  const r = await page.evaluate(() => {
    const s = window.HC.scene;
    window.HC.ui.setHour((window.HC.ui.hour + 1) % window.HC.data.meta.hours.length);
    return { fading: s.fading, mix: s._mixU.value };
  });
  expect(r).toEqual({ fading: false, mix: 1 });
});

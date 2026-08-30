import { test } from '@playwright/test';
import { openApp } from './helpers.mjs';
test.setTimeout(300_000);
test('compass at several bearings', async ({ page }) => {
  await openApp(page);
  for (const theta of [0, 45, 90, 180, 270]) {
    await page.evaluate((deg) => {
      const s = window.HC.scene;
      const off = s.camera.position.clone().sub(s.controls.target);
      const r = Math.hypot(off.x, off.z), rad = deg * Math.PI / 180;
      s.camera.position.set(s.controls.target.x + r * Math.sin(rad),
                            s.controls.target.y + off.y,
                            s.controls.target.z + r * Math.cos(rad));
      s.controls.update();
    }, theta);
    await page.waitForTimeout(300);
    const b = await page.evaluate(() => +window.HC.scene.bearing.toFixed(0));
    await page.locator('#nav-compass').screenshot({ path: `tests/screenshots/_c_${b}.png` });
    console.log('theta', theta, 'bearing', b);
  }
});

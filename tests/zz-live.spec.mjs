/* TEMPORARY live check — spends a billable root tile request and captures
 * Google tile content. Deleted after running. */

import { test } from '@playwright/test';
import fs from 'node:fs';

const OUT = '/tmp/claude-1000/-home-faizan-passion-temperature-api-quickstart/e677dd13-e25c-49d8-a741-9a976bb20b54/scratchpad';

test('projection lands on the real mesh', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`);
  });

  await page.goto('/?film=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 150_000 });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 30_000 });
  await page.waitForFunction(
    () => /server/i.test(document.getElementById('pr-status')?.textContent || ''),
    null, { timeout: 20_000 });

  await page.click('#pr-toggle');
  await page.waitForFunction(() => window.HC.scene.photorealOn === true, null, { timeout: 20_000 });

  // Wait for a decent amount of refined geometry, not just the root slabs.
  await page.waitForFunction(() => {
    const pr = window.HC.scene.photoreal;
    if (!pr || !pr.tiles) return false;
    let m = 0;
    pr.tiles.group.traverse((o) => { if (o.isMesh) m++; });
    return m > 120;
  }, null, { timeout: 180_000 }).catch(() => {});

  await page.waitForTimeout(25000);

  const info = await page.evaluate(() => {
    const s = window.HC.scene, pr = s.photoreal;
    let meshes = 0;
    pr.tiles.group.traverse((o) => { if (o.isMesh) meshes++; });
    // How much of the lookup table actually carries data?
    let filled = 0;
    const d = pr.lut.image.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) filled++;
    return {
      meshes,
      lutCells: d.length / 4,
      lutFilled: filled,
      lutFilledPct: +(100 * filled / (d.length / 4)).toFixed(1),
      facadeVisible: s.facadeMesh.visible,
      roofVisible: s.roofMesh.visible,
      gridOk: !!pr.grid,
      paramsOk: !!pr.params,
      dataWash: pr.dataWash,
    };
  });
  console.log('PROJECTION:', JSON.stringify(info, null, 2));
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 6));

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/proj-fly.png`, clip: { x: 430, y: 0, width: 1000, height: 1000 } });

  // Street level: the case that was worst before.
  await page.evaluate(() => document.getElementById('cam-street')?.click());
  await page.waitForTimeout(30000);
  await page.screenshot({ path: `${OUT}/proj-street.png`, clip: { x: 430, y: 0, width: 1000, height: 1000 } });
});

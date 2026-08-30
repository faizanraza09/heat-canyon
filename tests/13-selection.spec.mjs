/* Clicking a building.
 *
 * `ranked.items` is the top 150, not the scored population. Selection used to be
 * keyed on membership in it — `findIndex(...); if (idx >= 0) showDetail(idx)` —
 * so 5,179 of the 5,329 footprints on screen answered a hover with a name and a
 * height and then did nothing at all when clicked. Not even clear the card
 * already open, so the previously selected building stayed up and the click read
 * as having picked the wrong one.
 *
 * That included One Vanderbilt at 427 m, 338 5th Avenue at priority 53.1 and
 * 395 Lexington at 47.4 — buildings scoring above plenty of the list. They
 * simply had not made the cut.
 */

import { test, expect } from '@playwright/test';
import { openApp } from './helpers.mjs';

/** A building index that is in the ranked list, and one that is not. */
const pair = (page) => page.evaluate(() => {
  const d = window.HC.data;
  const ranked = new Set(d.ranked.items.map((it) => String(it.bin)));
  let inList = null, outOfList = null;
  d.buildings.attrs.forEach((a, i) => {
    if (a.in_aoi !== 1) return;
    if (inList === null && ranked.has(String(a.bin))) inList = i;
    // Deliberately a big one: the failure was most visible on towers.
    if (outOfList === null && !ranked.has(String(a.bin)) && (a.h || 0) > 150) outOfList = i;
  });
  return { inList, outOfList, ranked: d.ranked.items.length,
           footprints: d.buildings.attrs.length };
});

test('the ranked list is far smaller than the city, which is why this matters',
  async ({ page }) => {
    await openApp(page);
    const p = await pair(page);
    expect(p.inList).not.toBeNull();
    expect(p.outOfList).not.toBeNull();
    // If ranked.json ever grows to hold every scored building this test's
    // premise dissolves — and that would be a fine thing, but it should be a
    // deliberate change rather than a silent one.
    expect(p.ranked).toBeLessThan(p.footprints);
  });

test('a building in the ranked list opens its full card', async ({ page }) => {
  const { errors } = await openApp(page);
  const { inList } = await pair(page);
  await page.evaluate((i) => window.HC.ui.showBuilding(i), inList);

  const card = page.locator('#selcard');
  await expect(card).toBeVisible();
  // The written reasoning is the part only the ranked list carries.
  await expect(card).toContainText(/WHY IT RANKS HERE/i);
  expect(errors).toEqual([]);
});

test('a building outside the ranked list still opens a card', async ({ page }) => {
  const { errors } = await openApp(page);
  const { outOfList } = await pair(page);
  await page.evaluate((i) => window.HC.ui.showBuilding(i), outOfList);

  const card = page.locator('#selcard');
  await expect(card).toBeVisible();

  /* What it must show: the building. What it must not show: "NaN °C" where a
   * measured peak would go, or an empty reasoning section that reads as a card
   * which failed to finish loading. */
  await expect(card).toContainText(/OUTSIDE THE RANKED LIST/i);
  await expect(card).not.toContainText(/NaN/);
  await expect(card).not.toContainText(/undefined/);

  const shown = await page.evaluate(() => ({
    text: document.getElementById('selcard').textContent,
    selected: window.HC.scene.selected,
  }));
  // Selected in the 3D scene too, not just described in the panel.
  expect(shown.selected).not.toBeNull();
  expect(errors).toEqual([]);
});

test('picking an unranked building replaces the previous card rather than leaving it',
  async ({ page }) => {
    await openApp(page);
    const { inList, outOfList } = await pair(page);

    await page.evaluate((i) => window.HC.ui.showBuilding(i), inList);
    const first = await page.locator('#selcard .addr').first().textContent();

    await page.evaluate((i) => window.HC.ui.showBuilding(i), outOfList);
    const second = await page.locator('#selcard .addr').first().textContent();

    /* The bug this pins: with the old handler the second click did nothing, so
     * `second` would still have been the first building's address and the user
     * would have been looking at a card for a building they had not clicked. */
    expect(second).not.toBe(first);
  });

/* The floor schedule, for every building rather than for the ranked 150.
 *
 * The schedule used to be solved only for the top 150, and the other 97% of the
 * city was told its address was "outside that set" — which reads as a half-built
 * model rather than as the download budget it actually was. Solving a building
 * costs about a quarter of a second, so the whole scored population is a
 * quarter of an hour; the only real constraint was that `floors.json` is
 * fetched whole at boot and could not carry a hundred megabytes.
 *
 * So it is sharded: the ranked 150 stay bundled for the instant path, and every
 * other building is a ~24 KB file fetched on the select that needs it. What is
 * protected here is that the fetch actually happens and actually renders — a
 * shard that 404s, or a pane that keeps its empty state after the shard lands,
 * both look exactly like the bug this replaced.
 */
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.mjs';

/** A building in the ranked set, and one that is definitely not. */
async function twoBuildings(page) {
  return page.evaluate(() => {
    const d = window.HC.ui.d;
    const ranked = new Set(d.ranked.items.map((it) => String(it.bin)));
    const attrs = d.buildings.attrs;
    let inList = null, outList = null;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (!a || !a.bin) continue;
      if (!inList && ranked.has(String(a.bin))) inList = { i, bin: String(a.bin) };
      if (!outList && !ranked.has(String(a.bin))) outList = { i, bin: String(a.bin) };
      if (inList && outList) break;
    }
    return { inList, outList, ranked: d.ranked.items.length };
  });
}

test('a building outside the ranked set still gets its own schedule', async ({ page }) => {
  await openApp(page);
  const { inList, outList, ranked } = await twoBuildings(page);
  expect(ranked, 'the bundled set is still the ranked 150').toBe(150);

  await page.evaluate(async () => { await window.HC.ui.d.decision.ready; });

  // The bundled file must NOT carry it — otherwise this test proves nothing.
  const bundled = await page.evaluate((bin) =>
    !!window.HC.ui.d.decision.floors?.items?.[bin], outList.bin);
  expect(bundled, 'the unranked building is not in floors.json').toBe(false);

  // The host resolves it anyway, by fetching that building's own shard.
  const got = await page.evaluate(async (bin) => {
    const one = await window.HC.ui.d.decision.floorsFor(bin);
    return one && one.loads
      ? { floors: one.loads.floors?.length ?? 0, rx: (one.prescriptions || []).length }
      : null;
  }, outList.bin);
  console.log('unranked', outList.bin, '->', JSON.stringify(got));
  expect(got, 'a shard exists for an unranked building').not.toBeNull();
  expect(got.floors, 'and it carries real storeys').toBeGreaterThan(0);

  // A ranked building still resolves without any fetch at all.
  const inGot = await page.evaluate(async (bin) => {
    const one = await window.HC.ui.d.decision.floorsFor(bin);
    return one?.loads?.floors?.length ?? 0;
  }, inList.bin);
  expect(inGot, 'the bundled path still works').toBeGreaterThan(0);
});

test('the Decide pane renders the schedule for an unranked building', async ({ page }) => {
  await openApp(page);
  const { outList } = await twoBuildings(page);
  await page.evaluate(async () => { await window.HC.ui.d.decision.ready; });

  await page.evaluate((i) => window.HC.ui.showBuilding(i), outList.i);
  // The shard is a network round trip, so the pane paints twice: "reading",
  // then the schedule. Wait for the second.
  await page.waitForFunction(() => {
    const h = document.getElementById('tab-diagnose');
    return h && !/Reading this building/.test(h.textContent);
  }, null, { timeout: 20_000 });

  const txt = await page.evaluate(() =>
    document.getElementById('tab-diagnose').textContent.replace(/\s+/g, ' ').trim());
  console.log('pane says:', JSON.stringify(txt.slice(0, 140)));

  expect(txt, 'no longer claims the building is out of scope')
    .not.toMatch(/highest-priority buildings only/);
  expect(txt, 'no longer asks for a building that is already picked')
    .not.toMatch(/Pick a building to see it storey by storey/);
  expect(txt.length, 'and has actually rendered something').toBeGreaterThan(80);
});


test('the brief carries a schedule for an unranked building too', async ({ page }) => {
  await openApp(page);
  const { outList } = await twoBuildings(page);
  await page.evaluate(async () => { await window.HC.ui.d.decision.ready; });

  await page.evaluate((i) => window.HC.ui.showBuilding(i), outList.i);
  await page.waitForTimeout(400);
  await page.evaluate((bin) => window.HC.ui.openBrief(bin), outList.bin);

  // The document renders at once and re-renders when the shard lands; wait for
  // the second pass, which is the one carrying the schedule.
  await page.waitForFunction(() => {
    const r = document.getElementById('brief');
    return r && !r.hidden && /ASSEMBLY|OCCUPANCY/.test(r.textContent);
  }, null, { timeout: 20_000 });

  const txt = await page.evaluate(() =>
    document.getElementById('brief').textContent.replace(/\s+/g, ' ').trim());
  console.log('brief says:', JSON.stringify(txt.slice(0, 160)));
  expect(txt).toMatch(/ASSEMBLY|OCCUPANCY/);
});

/* Shared fixtures.
 *
 * `openApp` is the important one: it waits for the boot overlay to be *removed*,
 * which main.js only does after the scene is constructed and the first frame is
 * queued. Waiting on a timeout instead would make every test flaky on slow
 * software GL, and waiting on `load` would pass before any geometry existed.
 *
 * It also installs console/pageerror collectors, because an exception thrown
 * inside a requestAnimationFrame callback does not fail a Playwright action —
 * the page carries on looking fine while doing nothing. Several tests assert on
 * `errors` for exactly that reason.
 *
 * `?intro=0` suppresses the opening film. Every test in this suite is about the
 * application, and none of them should have to click past ninety seconds of
 * cinema first — nor should a screenshot comparison be at the mercy of which
 * frame of a cross-fade it happened to catch. The film has its own spec.
 */

export async function openApp(page, { hour, layer } = {}) {
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));

  await page.goto('/?intro=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 150_000 });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 30_000 });
  // One extra frame so the first recolour has certainly landed.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  if (hour !== undefined) await setHour(page, hour);
  if (layer) await setLayer(page, layer);

  return { errors, failedRequests };
}

/** Select a layer by (partial) label. Switches to the Measure tab first, since
 *  the layer list lives inside it and is hidden while another tab is showing.
 *
 *  Matching is diacritic- and case-insensitive: the panel says "Façade
 *  temperature" and a spec that asks for "Facade temperature" means the same
 *  layer. Requiring the cedilla at every call site would make the suite fail on
 *  a copy-edit rather than on a defect. */
export async function setLayer(page, label) {
  await page.evaluate((l) => {
    const flat = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    document.querySelector('#tabs button[data-tab="view"]')?.click();
    const b = [...document.querySelectorAll('#layers button')]
      .find((x) => flat(x.textContent).includes(flat(l)));
    if (!b) {
      const have = [...document.querySelectorAll('#layers button')]
        .map((x) => x.textContent.trim()).join(' | ');
      throw new Error(`no layer button matching "${l}". Available: ${have}`);
    }
    b.click();
  }, label);
  await settle(page);
}

/** Switch the left panel to a named tab: view | whatif | ask. */
export async function setTab(page, name) {
  await page.evaluate((n) => {
    // 'ask' is not a pane: the analyst opens in its own window over the map.
    const sel = n === 'ask' ? '#analyst-open' : `#tabs button[data-tab="${n}"]`;
    const b = document.querySelector(sel);
    if (!b) throw new Error(`no tab ${n}`);
    b.click();
  }, name);
  await settle(page);
}

export async function setHour(page, index) {
  await page.evaluate((i) => {
    const b = document.querySelectorAll('#hours button')[i];
    if (!b) throw new Error(`no hour button at index ${i}`);
    b.click();
  }, index);
  await settle(page);
}

/** Make sure the vertical air profile is loaded before reading it.
 *
 * It is fetched on demand — 4.7 MB per period, and it is the least trustworthy
 * field in the model — so `data.airAt` returns NaN until something asks for it.
 * Three tests read it directly and started returning NaN when the fetch became
 * lazy, which surfaced as `expect(...).toBeGreaterThan(NaN)` rather than as
 * anything about air temperature.
 */
export async function ensureAir(page) {
  await page.evaluate(() => window.HC.data.ensureAir());
  await page.waitForFunction(() => window.HC.data.hasAir(), null, { timeout: 60_000 });
  await settle(page);
}

/** Wait until the camera has stopped flying itself somewhere.
 *
 * Resetting the view and focusing a building are short flights rather than
 * cuts, so a fixed timeout after clicking one of those controls is a race — and
 * on software GL it is a race the test loses. `scene.transitioning` covers both
 * those flights and the opening descent, so this is the one thing to wait on.
 */
export async function cameraSettled(page) {
  await page.waitForFunction(() => !window.HC.scene.transitioning, null, { timeout: 20_000 });
  await settle(page);
}

/** Wait for two animation frames — enough for a recolour to be uploaded. */
export async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Statistics over the facade mesh's vertex colours, as the GPU would see them. */
export async function facadeColorStats(page) {
  return page.evaluate(() => {
    const s = window.HC.scene;
    const a = s.facadeColors.array;
    let min = 1e9, max = -1e9, sum = 0;
    const buckets = new Set();
    // Every 4th vertex: one sample per quad, which is what varies.
    for (let i = 0; i < a.length; i += 12) {
      const v = (a[i] + a[i + 1] + a[i + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      buckets.add(Math.round(a[i] * 24) + ',' + Math.round(a[i + 1] * 24) + ',' + Math.round(a[i + 2] * 24));
    }
    const n = Math.floor(a.length / 12);
    return { n, min: +min.toFixed(4), max: +max.toFixed(4), mean: +(sum / n).toFixed(4), distinct: buckets.size };
  });
}

/* The decision layer, in the browser.
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING
 *
 * Four surfaces were added at once — the floor schedule, the what-if pane, the
 * portfolio and the building brief — and each of them can fail in a way that
 * looks like success. A pane that renders beautifully from a stale building. A
 * range quietly averaged into a confident midpoint. A dollar figure with no
 * label saying it came through an assumption table. A placeholder build shipped
 * with its warning styled away. None of those throw, and none of them show up
 * in a screenshot diff.
 *
 * So the assertions here are mostly about HONESTY rather than about rendering,
 * because rendering is the part a person notices. The load-bearing ones:
 *
 *   - the atlas still comes up when the decision products are absent, which is
 *     the property `decision.js` exists to provide and the one most likely to
 *     be quietly lost;
 *   - a range never reaches the screen as a midpoint;
 *   - a fixture build says so, everywhere, and cannot be dismissed;
 *   - selecting a building actually moves every surface, rather than leaving
 *     one showing the previous address.
 */

/* A NOTE ON THE THREE 03-visual FAILURES, so nobody re-investigates them.
 *
 * They fail on this build and they are not caused by the decision layer.
 * `03-visual.spec.mjs` screenshots `VIEWPORT_CLIP = {x: 430, y: 0, ...}`, which
 * excludes every UI panel — the left panel ends at x=390 at the 1600px test
 * viewport — so the added Diagnose tab, the portfolio button and the new CSS
 * tokens cannot put a pixel inside the sampled region. And the field behind
 * those pixels is bit-for-bit what it was before this work: `thermal.bin` and
 * `air.bin` are 100.00% identical to a backup taken before any physics change,
 * worst difference 0.000 K.
 *
 * That identity is not free. Adding the attribution briefly switched on a
 * per-canyon surroundings iteration in the vector engine, which moved the
 * painted field by -0.31 K mean and 48% of panel-bands by more than half a
 * kelvin. It was reverted: see the comment in `tiers.solve_day`, which records
 * both why it was tempting and why it went back off.
 */

import { expect, test } from '@playwright/test';
import { openApp, settle } from './helpers.mjs';

/** Whether this build has the decision products at all. Every test below is
 *  skipped rather than failed when it does not: a build without them is a
 *  supported configuration, and the suite has to pass in it. */
async function decision(page) {
  return page.evaluate(() => ({
    floors: !!window.HC?.data?.decision?.floors,
    prescriptions: !!window.HC?.data?.decision?.prescriptions,
    portfolio: !!window.HC?.data?.decision?.portfolio,
    fixture: !!window.HC?.data?.decision?.fixture,
    surfaces: Object.keys(window.HC?.ui?.surfaces || {}),
  }));
}

async function selectTop(page) {
  await page.evaluate(() => window.HC.ui.showDetail(0));
  await settle(page);
}

test.describe('the decision layer', () => {
  test('the atlas comes up whether or not the layer is in the build', async ({ page }) => {
    const { errors } = await openApp(page);
    const d = await decision(page);

    // The layer list, the two time axes and the model are all untouched by
    // whatever the decision surfaces did or did not do. This is the assertion
    // that makes every product below optional in fact rather than in intent.
    // A floor rather than an equality, because the point is "the map still
    // works", not "the map has exactly this many layers" — which is asserted
    // once, in the design spec, and should not be asserted twice.
    expect(await page.locator('#layers button').count()).toBeGreaterThanOrEqual(6);
    expect(await page.locator('#hours button').count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.HC.scene.nQuad)).toBeGreaterThan(1000);

    // A missing module logs at info and mounts nothing. It must never throw.
    expect(errors).toEqual([]);

    // The Decide tab holds both decision panes and is present exactly when at
    // least one of them mounted.
    const tabHidden = await page.locator('#tabs button[data-tab="decide"]')
      .evaluate((n) => n.hidden);
    const anyPane = d.surfaces.includes('diagnose') || d.surfaces.includes('whatif');
    expect(tabHidden).toBe(!anyPane);

    // Two tabs, not three. A four-item row makes choosing one a decision in
    // itself, and this is the assertion that stops a fourth creeping back.
    const visible = await page.locator('#tabs button[data-tab]').evaluateAll(
      (ns) => ns.filter((n) => !n.hidden).map((n) => n.dataset.tab));
    expect(visible).toEqual(['view', 'decide']);
  });

  test('selecting a building moves the schedule with it', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);
    test.skip(!d.surfaces.includes('diagnose'), 'no floor schedule in this build');

    await page.evaluate(() => window.HC.ui.showTab('decide'));
    await selectTop(page);
    const first = await page.locator('#tab-diagnose').innerText();

    // A different building, chosen by index rather than by clicking the model,
    // so the test does not depend on where the camera happens to be.
    await page.evaluate(() => window.HC.ui.showDetail(7));
    await settle(page);
    const second = await page.locator('#tab-diagnose').innerText();

    expect(second.length).toBeGreaterThan(200);
    expect(second).not.toEqual(first);

    // The pane is about the selected building, and says which. Comparing
    // against the ranking's own record rather than against a literal, so the
    // test survives a rebuild on different data.
    const addr = await page.evaluate(() => window.HC.data.ranked.items[7].addr);
    if (addr) expect(second).toContain(addr);
  });

  test('Decide shows both halves of the answer at once', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);
    test.skip(!d.surfaces.includes('diagnose') || !d.surfaces.includes('whatif'),
      'both decision panes are needed for this one');

    await page.evaluate(() => window.HC.ui.showTab('decide'));
    await selectTop(page);

    // The schedule says why, the what-if says what to do. Reading the second
    // needs the first in view, which is why they share one scrolling column
    // rather than two tabs.
    for (const id of ['tab-diagnose', 'tab-whatif']) {
      expect(await page.locator(`#${id}`).evaluate((n) => n.hidden),
        `#${id} should be visible under Decide`).toBe(false);
    }
    expect(await page.locator('#tab-view').evaluate((n) => n.hidden)).toBe(true);

    // The old tab names still route, because the tour and the analyst use them.
    for (const legacy of ['diagnose', 'whatif']) {
      await page.evaluate((t) => window.HC.ui.showTab('view') || window.HC.ui.showTab(t), legacy);
      expect(await page.locator('#tab-diagnose').evaluate((n) => n.hidden),
        `showTab('${legacy}') should reach the Decide pane`).toBe(false);
    }
  });

  test('the schedule reports a driver, not just a temperature', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);
    test.skip(!d.surfaces.includes('diagnose'), 'no floor schedule in this build');

    await page.evaluate(() => window.HC.ui.showTab('decide'));
    await selectTop(page);

    // The whole claim of the layer: a floor carries the REASON it is hot, so a
    // measure can be selected against something other than the temperature.
    const rows = await page.evaluate(() => {
      const b = window.HC.data.decision.floors.items[
        String(window.HC.data.ranked.items[0].bin)];
      // `dom`, not `dominant`: the wire format is the short-key shape
      // docs/DECISIONS.md section 7 states, which is what the renderer reads.
      return (b?.floors || []).map((f) => f.dom);
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(['solar', 'trap', 'ambient']).toContain(r);

    // "ambient" everywhere means the attribution planes are missing and the
    // schedule is reporting a driver it cannot actually name. That is a valid
    // build and an invalid finding, so it is surfaced here rather than passing
    // quietly.
    const named = rows.filter((r) => r !== 'ambient').length;
    expect(named, 'every floor reported "ambient" — the attribution planes are '
      + 'probably missing from this build').toBeGreaterThan(0);
  });

  test('an assumed figure never reaches the screen as a midpoint', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);
    test.skip(!d.floors, 'no floor schedule in this build');

    // The layer's one non-negotiable property, checked at the source rather
    // than by scraping text: a wall U-value is an era rule, not a survey, and a
    // single confident number derived from a guess is the easiest thing in this
    // system to over-trust.
    const bad = await page.evaluate(() => {
      const out = [];
      const items = window.HC.data.decision.floors.items || {};
      for (const [bin, rec] of Object.entries(items)) {
        for (const k of ['peak_kw', 'annual_mwh']) {
          if (!Array.isArray(rec[k]) || rec[k].length !== 2) out.push(`${bin}.${k}`);
        }
        for (const f of (rec.floors || []).slice(0, 3)) {
          for (const k of ['peak_w', 'annual_kwh', 't_in']) {
            if (!Array.isArray(f[k]) || f[k].length !== 2) out.push(`${bin}.${f.f}.${k}`);
          }
        }
      }
      return out.slice(0, 8);
    });
    expect(bad).toEqual([]);
  });

  test('a placeholder build says so, and cannot be dismissed', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);
    test.skip(!d.surfaces.includes('diagnose'), 'no floor schedule in this build');
    test.skip(!d.fixture, 'this build carries real decision data');

    await page.evaluate(() => window.HC.ui.showTab('decide'));
    await selectTop(page);

    const pane = await page.locator('#tab-diagnose').innerText();
    expect(pane.toLowerCase()).toMatch(/fixture|placeholder/);

    // No close control on the warning. A dismissible caveat on a page of
    // invented numbers is a caveat that will be dismissed once and never seen
    // again, which is the same as not having one.
    const dismissible = await page.evaluate(() => {
      const banner = document.querySelector('#tab-diagnose [class*="fixture"], '
        + '#tab-diagnose [class*="placeholder"]');
      return !!banner?.querySelector('button, [role="button"]');
    });
    expect(dismissible).toBe(false);
  });

  test('the portfolio opens over the model and Escape gives it back', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);
    test.skip(!d.surfaces.includes('portfolio'), 'no portfolio in this build');

    // A building has to be selected BEFORE the view opens, or the assertion at
    // the end — that Escape closed the view and nothing else — passes
    // vacuously against a selection that was never made.
    await selectTop(page);
    expect(await page.evaluate(() => window.HC.ui.selected)).not.toBeNull();

    // Openness is read off the DOM rather than off a property name. The two
    // views spell their own flag differently — `isOpen` on one, `open_` on the
    // other — and a test that asserted on either would be testing an
    // implementation detail that is allowed to change.
    const isUp = () => page.evaluate(() => {
      const n = document.getElementById('pf');
      return !!n && !n.hidden && getComputedStyle(n).display !== 'none';
    });

    await page.evaluate(() => window.HC.ui.openPortfolio());
    await settle(page);
    expect(await isUp()).toBe(true);

    await page.keyboard.press('Escape');
    await settle(page);
    expect(await isUp()).toBe(false);

    // Escape closed the view and nothing else. The atlas underneath kept its
    // selection, which is the bug that appears the moment a full-screen view
    // lets its key handler bubble into the application's own.
    expect(await page.evaluate(() => window.HC.ui.selected)).not.toBeNull();
  });

  test('the brief opens for a building and prints without the chrome', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);
    test.skip(!d.surfaces.includes('brief'), 'no brief in this build');

    await selectTop(page);
    const bin = await page.evaluate(() => String(window.HC.data.ranked.items[0].bin));
    await page.evaluate((b) => window.HC.ui.openBrief(b), bin);
    await settle(page);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain(bin);
    // The section the whole document exists for.
    expect(text.toLowerCase()).toMatch(/what to do|what this rests on/);

    // The print stylesheet has to release the scroller and drop the scrim, or
    // the printed page is one screenful of a dialog. Emulating print media is
    // the only way to see that from a test.
    await page.emulateMedia({ media: 'print' });
    await settle(page);
    const printed = await page.evaluate(() => {
      const scrim = document.querySelector('[class*="scrim"]');
      return {
        scrimVisible: !!scrim && getComputedStyle(scrim).display !== 'none'
          && getComputedStyle(scrim).opacity !== '0',
        bodyOverflow: getComputedStyle(document.body).overflow,
      };
    });
    expect(printed.scrimVisible).toBe(false);
    expect(printed.bodyOverflow).not.toBe('hidden');
    await page.emulateMedia({ media: 'screen' });
  });

  test('the guided tour still covers the interface it is describing', async ({ page }) => {
    await openApp(page);
    const d = await decision(page);

    // The tour drops a step whose target is missing rather than spotlighting an
    // empty rectangle, so on a build with the decision layer it must GAIN the
    // steps about it — and on a build without, it must not. Either way the
    // count of steps it can actually show has to match what is on screen.
    // `mountTour` returns { run, current }, and `current()` is null until the
    // tour has actually been started — it does not run unasked after the first
    // visit. So it is started here and stopped again; reading a `steps` array
    // off the handle would read undefined and pass vacuously, which is how the
    // first version of this test reported an empty list as a success.
    const shown = await page.evaluate(async () => {
      const t = window.HC.tour || window.HC.ui.tour;
      if (!t?.run) return null;
      t.run();
      await new Promise((r) => requestAnimationFrame(r));
      const live = t.current?.();
      const ids = (live?.steps || []).map((s) => s.id);
      live?.end?.('test');
      return ids;
    });
    test.skip(!shown || !shown.length, 'no tour instance on this build');

    if (d.surfaces.includes('diagnose')) expect(shown).toContain('diagnose');
    if (d.surfaces.includes('portfolio')) expect(shown).toContain('portfolio');
  });
});

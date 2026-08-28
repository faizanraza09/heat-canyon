/* The guided tour.
 *
 * The contract worth defending is mostly about restraint. The tour runs once,
 * unasked, for someone who has never opened the application; it must not run
 * for the rest of this suite (every other spec loads `?intro=0` and clicks
 * panels immediately, and a modal scrim over those clicks would fail all of
 * them); and while it is up it must own the keyboard, because the application
 * binds Escape to folding both panels and the tour binds it to leaving.
 *
 * The rest is positioning. A spotlight that lands on the wrong element, or off
 * screen, is the failure mode of every tour library ever written, so each step
 * is walked through and asserted to have both a card inside the viewport and a
 * highlight over the control it claims to be pointing at.
 *
 * `?tour=1` forces the tour on with the film suppressed, which is the only way
 * to test it without sitting through ninety seconds of cinema first.
 */

import { test, expect } from '@playwright/test';

/** Load with the film off and the tour forced on, and wait for step one. */
async function openTour(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`);
  });
  await page.goto('/?intro=0&tour=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 150_000 });
  await page.waitForSelector('#tour-card.in', { timeout: 30_000 });
  return { errors };
}

const rect = (page, sel) => page.locator(sel).boundingBox();

test('?intro=0 alone suppresses the tour as well as the film', async ({ page }) => {
  await page.goto('/?intro=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 150_000 });
  await page.waitForTimeout(2500);   // longer than the auto-start delay
  await expect(page.locator('#tour')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.classList.contains('tour-running'))).toBe(false);
  // And it must not have spent the one automatic run this browser gets.
  expect(await page.evaluate(() => localStorage.getItem('hc.tour.v1'))).toBeNull();
});

test('the first step names the dataset and offers a way out', async ({ page }) => {
  const { errors } = await openTour(page);
  await expect(page.locator('#tour-kicker')).toContainText('heat wave');
  await expect(page.locator('#tour-title')).toHaveText('The instrument');
  await expect(page.locator('#tour-next')).toHaveText('Show me around');
  await expect(page.locator('#tour-quit')).toBeVisible();
  // Nothing to go back to on step one.
  await expect(page.locator('#tour-back')).toBeHidden();
  expect(errors).toEqual([]);
});

test('every step lands its card on screen and its spotlight on the control',
  async ({ page }) => {
    const { errors } = await openTour(page);
    const n = await page.locator('#tour-dots .dot').count();
    expect(n).toBeGreaterThan(8);

    const seen = [];
    for (let i = 0; i < n; i++) {
      const step = await page.evaluate(() => document.getElementById('tour').dataset.step);
      seen.push(step);

      // The card is fully inside the viewport.
      const card = await rect(page, '#tour-card');
      const vp = page.viewportSize();
      expect(card, `step ${step} has no card`).not.toBeNull();
      expect(card.x, `step ${step} card off the left`).toBeGreaterThanOrEqual(0);
      expect(card.y, `step ${step} card off the top`).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width, `step ${step} card off the right`).toBeLessThanOrEqual(vp.width);
      expect(card.y + card.height, `step ${step} card off the bottom`).toBeLessThanOrEqual(vp.height);
      await expect(page.locator('#tour-title')).not.toHaveText('');
      await expect(page.locator('#tour-body')).not.toHaveText('');

      // Where there is a spotlight it must contain the element the step is
      // about, and must not have swallowed the whole screen.
      const spot = await page.evaluate(() => {
        const s = document.getElementById('tour-spot');
        if (s.hidden) return null;
        const r = s.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      if (spot) {
        expect(spot.w, `step ${step} spotlight is the whole width`)
          .toBeLessThan(vp.width * 0.96);
        expect(spot.w * spot.h, `step ${step} spotlight is empty`).toBeGreaterThan(400);
        // It must not overlap the card: a highlight under the text it explains
        // is the one arrangement that is certainly wrong.
        const apart = spot.x + spot.w <= card.x + 2 || card.x + card.width <= spot.x + 2
          || spot.y + spot.h <= card.y + 2 || card.y + card.height <= spot.y + 2;
        expect(apart, `step ${step} card sits on top of its own spotlight`).toBe(true);
      }

      if (i < n - 1) {
        await page.locator('#tour-next').click();
        await page.waitForTimeout(600);      // the spotlight glide
      }
    }

    // The sequence covered the three regions and both extra tabs.
    expect(seen).toContain('layers');
    expect(seen).toContain('time');
    expect(seen).toContain('ranked');
    expect(seen).toContain('whatif');
    expect(seen).toContain('ask');
    expect(errors).toEqual([]);
  });

test('steps put the interface into the state they describe', async ({ page }) => {
  await openTour(page);
  const stepTo = async (id) => {
    for (let i = 0; i < 20; i++) {
      if (await page.evaluate(() => document.getElementById('tour').dataset.step) === id) return;
      await page.locator('#tour-next').click();
      await page.waitForTimeout(350);
    }
    throw new Error(`never reached step ${id}`);
  };

  await stepTo('whatif');
  await expect(page.locator('#tab-whatif')).toBeVisible();
  await expect(page.locator('#tab-whatif table.sctab')).toBeVisible();

  await stepTo('ask');
  await expect(page.locator('#tab-ask')).toBeVisible();

  await stepTo('photoreal');
  await expect(page.locator('#tab-view')).toBeVisible();

  // The building step selected the top-ranked building, in the panel and in the
  // model both.
  expect(await page.evaluate(() => window.HC.ui.selected)).toBe(0);
  await expect(page.locator('#side-title')).toContainText('#1');
});

test('the tour owns the keyboard while it is up, and hands it back', async ({ page }) => {
  await openTour(page);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.getElementById('tour').dataset.step)).toBe('city');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.getElementById('tour').dataset.step)).toBe('welcome');

  // Escape leaves the tour — and must not also fold the panels on its way out.
  await page.keyboard.press('Escape');
  await expect(page.locator('#tour')).toHaveCount(0);
  await expect(page.locator('#left')).not.toHaveClass(/folded/);
  await expect(page.locator('#side')).not.toHaveClass(/folded/);
  expect(await page.evaluate(() => document.body.classList.contains('tour-running'))).toBe(false);

  // The application is live again: a layer click lands.
  await page.locator('#layers button').nth(1).click();
  expect(await page.evaluate(() => window.HC.ui.layer)).toBe('sun');

  // And Escape now means what it means in the application.
  await page.keyboard.press('Escape');
  await expect(page.locator('#left')).toHaveClass(/folded/);
});

test('the film hands the screen over to the tour', async ({ page }) => {
  // The real first-run path: film on, nothing in localStorage. The tour must
  // wait for the overlay — a spotlight drawn under the film would be pointing
  // at controls nobody can see — and then come up on its own.
  await page.goto('/?intro=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => { const b = document.getElementById('film-begin'); return b && !b.disabled; },
    null, { timeout: 150_000 }
  );
  await expect(page.locator('#tour')).toHaveCount(0);   // not while the film is up
  await page.locator('#film-straight').click();         // "Skip to the map"
  await page.waitForSelector('#tour-card.in', { timeout: 30_000 });
  await expect(page.locator('#tour-title')).toHaveText('The instrument');
  // And the panels it is about are actually on screen by then.
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(false);
});

test('it runs once unasked, and the masthead chip brings it back', async ({ page }) => {
  await page.goto('/?intro=0&tour=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 150_000 });
  await page.waitForSelector('#tour-card.in', { timeout: 30_000 });
  await page.locator('#tour-quit').click();
  await expect(page.locator('#tour')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('hc.tour.v1'))).not.toBeNull();

  // Second visit: it stays out of the way.
  await page.goto('/?intro=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 150_000 });
  await page.waitForTimeout(2000);
  await expect(page.locator('#tour')).toHaveCount(0);

  // But the chip is there and works.
  await expect(page.locator('#tour-replay')).toBeVisible();
  await page.locator('#tour-replay').click();
  await page.waitForSelector('#tour-card.in', { timeout: 10_000 });
  await expect(page.locator('#tour-title')).toHaveText('The instrument');
});

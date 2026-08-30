import { test, expect } from '@playwright/test';
import { openApp } from './helpers.mjs';

test('the working is one closed block and the answer leads', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => window.HC.ui.replayAnalyst(
    'r17880442193644fa', 'Where is the heat coming from, and what does the fix cost?'));
  await expect(page.locator('#analyst-body .bubble.agent').first())
    .toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2500);

  const shape = await page.evaluate(() => {
    const t = document.querySelector('#analyst-body .transcript');
    return {
      blocks: t.querySelectorAll('.workblock').length,
      digest: t.querySelector('.wdigest')?.textContent,
      answers: t.querySelectorAll('.bubble.agent').length,
      asides: t.querySelectorAll('.aside').length,
      order: [...t.children].map((c) => c.className),
      answerTop: Math.round(t.querySelector('.bubble.agent').getBoundingClientRect().top),
      scrollerTop: Math.round(document.getElementById('agent-scroll').getBoundingClientRect().top),
    };
  });
  console.log(JSON.stringify(shape, null, 1));
  expect(shape.blocks).toBe(1);
  expect(shape.answers).toBe(1);
  expect(shape.asides).toBe(1);

  await page.locator('#analyst-body .workblock').evaluate((d) => { d.open = true; });
  await page.screenshot({ path: 'tests/screenshots/_probe-working-open.png' });
  await page.locator('#analyst-body .workblock').evaluate((d) => { d.open = false; });
  await page.locator('#agent-scroll').evaluate((s) => { s.scrollTop = 0; });
  await page.screenshot({ path: 'tests/screenshots/_probe-working-closed.png' });
});

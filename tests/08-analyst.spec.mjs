/* The analyst console.
 *
 * Two halves, deliberately separated. Everything up to `agent turn` is about the
 * console itself and runs with no credential at all: the header, the fallback
 * message, the suggestions, and — the important one — that a `map_control` action
 * really does move the map, which is testable by injecting the frame the agent
 * would have produced.
 *
 * The live turn is skipped unless the server reports the analyst available, so
 * the suite passes on a machine with no `claude` login and no API key. That is the
 * normal case in CI, and a test that fails there would be deleted rather than
 * fixed.
 */

import { expect, test } from '@playwright/test';

import { openApp, setTab, settle } from './helpers.mjs';

async function openAnalyst(page) {
  await setTab(page, 'ask');
  await page.waitForSelector('#analyst-body .agentform textarea', { timeout: 15_000 });
}

async function envelope(page) {
  return page.evaluate(() => fetch('/api/agent/envelope').then((r) => r.json()));
}

test('the console mounts, and says what it is running on', async ({ page }) => {
  const { errors } = await openApp(page);
  await openAnalyst(page);

  await expect(page.locator('#analyst-body textarea')).toBeVisible();
  await expect(page.locator('#analyst-body button.primary')).toHaveText('ASK');
  await expect(page.locator('#analyst-body .agentchips button').first()).toBeVisible();

  const env = await envelope(page);
  if (env.available) {
    // The header has to name the model and the tool count: a console that does
    // not say what it is running on is a console you cannot audit.
    await expect(page.locator('#analyst-body .afacts')).toContainText(env.model);
    await expect(page.locator('#analyst-body .ahrow')).toContainText('TOOLS');
    await expect(page.locator('#analyst-body .ahrow')).toContainText('NO WEB');
    expect(env.tools.length).toBeGreaterThanOrEqual(15);
    expect(env.subagents.length).toBeGreaterThan(0);
    expect(env.web_access).toBe(false);
  } else {
    // Unavailable is a state the interface has to handle out loud rather than by
    // showing a dead button.
    await expect(page.locator('#analyst-body .anote')).toBeVisible();
    expect(env.unavailable_because).toBeTruthy();
  }
  expect(errors).toEqual([]);
});

test('the envelope describes budgets and containment without leaking a secret', async ({ page }) => {
  await openApp(page);
  const env = await envelope(page);
  expect(env.turn_budget_usd).toBeGreaterThan(0);
  expect(env.session_budget_usd).toBeGreaterThanOrEqual(env.turn_budget_usd);
  expect(env.disallowed_tools).toContain('WebSearch');
  expect(env.disallowed_tools).toContain('WebFetch');
  const json = JSON.stringify(env);
  expect(json).not.toMatch(/sk-ant/);
  expect(json).not.toMatch(/ANTHROPIC_API_KEY=/);
});

test('a map_control action moves the map', async ({ page }) => {
  const { errors } = await openApp(page);
  await openAnalyst(page);

  const bins = await page.evaluate(() =>
    window.HC.data.ranked.items.slice(3, 8).map((b) => String(b.bin)));

  // The frame the agent's `map_control` produces, applied through the same path
  // the live stream uses. This is the assertion that matters: the claim is that
  // the analyst drives the city, and it is worth exactly as much as this test.
  await page.evaluate(async ([bs]) => {
    await window.HC.ui.applyMapAction({
      kind: 'map',
      layer: 'annual_kh35',
      aggregate: 'year',
      highlight_bins: bs,
      note: 'the walls this is about',
    });
  }, [bins]);
  await settle(page);

  const got = await page.evaluate(() => ({
    layer: window.HC.ui.layer,
    aggregate: window.HC.data.time.aggregate,
    highlighted: window.HC.scene.highlighted ? window.HC.scene.highlighted.size : 0,
    frozen: document.getElementById('time').classList.contains('frozen'),
    note: document.getElementById('agent-note')?.textContent || '',
  }));
  expect(got.layer).toBe('annual_kh35');
  expect(got.aggregate).toBe('year');
  expect(got.highlighted).toBe(5);
  expect(got.frozen).toBe(true);
  expect(got.note).toContain('highlighted');
  expect(errors).toEqual([]);
});

test('a map_control action can scrub to a date and open a building', async ({ page }) => {
  const { errors } = await openApp(page);
  await openAnalyst(page);
  const bin = await page.evaluate(() => String(window.HC.data.ranked.items[0].bin));

  await page.evaluate(async ([b]) => {
    await window.HC.ui.applyMapAction({
      kind: 'map', layer: 'surface', date: '2026-01-15', aggregate: 'day',
      hour_slot: 4, focus_bin: b,
    });
  }, [bin]);
  await settle(page);

  const got = await page.evaluate(() => ({
    date: window.HC.data.time.date,
    period: window.HC.data.time.period,
    hour: window.HC.ui.hour,
    selected: window.HC.scene.selected,
    stripIndex: window.HC.ui.year.index,
  }));
  expect(got.date).toBe('2026-01-15');
  expect(got.period).toBe('month_01');
  expect(got.hour).toBe(4);
  expect(got.selected).not.toBeNull();
  // The strip must follow, or the interface is telling two different stories.
  expect(got.stripIndex).toBe(await page.evaluate(() =>
    window.HC.data.dateToDay.get('2026-01-15')));
  await expect(page.locator('#side-body')).toContainText('The year');
  expect(errors).toEqual([]);
});

test('an unknown BIN in a highlight is reported rather than silently dropped', async ({ page }) => {
  await openApp(page);
  await openAnalyst(page);
  await page.evaluate(async () => {
    await window.HC.ui.applyMapAction({
      kind: 'map', highlight_bins: ['9999999', String(window.HC.data.ranked.items[0].bin)],
    });
  });
  await settle(page);
  const note = await page.evaluate(() =>
    document.getElementById('agent-note')?.textContent || '');
  expect(note).toContain('1 building highlighted');
  expect(note).toContain('not in this study area');
});

test('the suggestions are the ones the year made possible', async ({ page }) => {
  await openApp(page);
  const j = await page.evaluate(() => fetch('/api/suggestions').then((r) => r.json()));
  expect(j.suggestions.length).toBeGreaterThan(4);
  const all = j.suggestions.join(' ').toLowerCase();
  // At least one about the year, one about testing a pattern, and one about an
  // intervention: the three capabilities the previous analyst did not have.
  expect(all).toMatch(/year|january|october|annual/);
  expect(all).toMatch(/test it|prove it|clustered|pattern/);
  expect(all).toMatch(/shading|trees|intervention|buys/);
});

test('run history and interrupt-all answer even with nothing running', async ({ page }) => {
  await openApp(page);
  const runs = await page.evaluate(() => fetch('/api/agent/runs').then((r) => r.json()));
  expect(Array.isArray(runs.runs)).toBe(true);
  expect(runs.budget_usd).toBeGreaterThan(0);

  // Never an error: it exists so somebody can be sure nothing is running.
  const stopped = await page.evaluate(() =>
    fetch('/api/agent/interrupt-all', { method: 'POST' }).then((r) => r.json()));
  expect(stopped.stopped).toBeGreaterThanOrEqual(0);
});

test('a live turn streams, calls tools, and answers', async ({ page }) => {
  await openApp(page);
  const env = await envelope(page);
  test.skip(!env.available,
    `analyst unavailable: ${env.unavailable_because}. This test needs either a `
    + 'logged-in claude CLI or ANTHROPIC_API_KEY.');

  await openAnalyst(page);
  // Deliberately narrow, so the turn is cheap and its answer is checkable.
  await page.fill('#analyst-body textarea',
    'In one sentence: how many days of the study year passed 35 °C? '
    + 'Use area_summary and nothing else.');
  await page.click('#analyst-body button.primary');

  // The transcript must show the work, and the answer must not be behind it: the
  // working is one closed block carrying a count of what it ran, and opening it
  // is where the calls are.
  await expect(page.locator('#analyst-body .workblock').first())
    .toBeVisible({ timeout: 180_000 });
  await expect(page.locator('#analyst-body .toolcall').first()).toBeHidden();
  await page.locator('#analyst-body .workblock').first().evaluate((d) => { d.open = true; });
  await expect(page.locator('#analyst-body .toolcall').first()).toBeVisible();
  await page.locator('#analyst-body .workblock').first().evaluate((d) => { d.open = false; });
  await expect(page.locator('#analyst-body .bubble.agent').first())
    .toBeVisible({ timeout: 240_000 });
  await expect(page.locator('#analyst-body .runstatus.done').first())
    .toBeVisible({ timeout: 240_000 });

  const shown = await page.locator('#analyst-body .bubble.agent').first().textContent();
  const expected = await page.evaluate(() =>
    String(window.HC.data.year.annual.days_above_35));
  // The figure has to be the one in the data. An analyst whose numbers do not
  // match the model it is describing is the whole failure this project is built
  // to avoid.
  expect(shown).toContain(expected);

  // And the run must be on disk, replayable.
  const runs = await page.evaluate(() => fetch('/api/agent/runs').then((r) => r.json()));
  expect(runs.runs.length).toBeGreaterThan(0);
  const rid = runs.runs[0].run_id;
  const frames = await page.evaluate((id) =>
    fetch(`/api/agent/runs/${id}/frames`).then((r) => r.json()), rid);
  expect(frames.frames.length).toBeGreaterThan(2);
  expect(frames.frames.some((f) => f.type === 'tool_use')).toBe(true);
  expect(frames.status.state).toBe('finished');
  expect(frames.status.cost_usd).toBeGreaterThan(0);
});

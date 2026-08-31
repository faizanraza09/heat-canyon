/* Restate the film's beat lengths from the recordings that exist right now.
 *
 *   node scripts/retime.mjs --dry     # what would change
 *   node scripts/retime.mjs           # change it
 *
 * story.js states every beat as `seconds`, and the convention — set out at the
 * top of that file — is that a spoken beat's stated length is its recording
 * plus GAP. That is what keeps `film._retime()` a no-op and the title card
 * honest: the runtime printed on the Begin button before the narration index
 * has loaded is the runtime the film actually runs.
 *
 * The convention is a convention, not a mechanism. Nothing enforces it, and it
 * is stale by exactly the amount the recordings moved every time a line is
 * rewritten or the cache is re-baked or the tails are trimmed. Doing it by hand
 * across thirty-one beats is how it drifts.
 *
 * So: open the application, take the script the film actually settles on, ask
 * the server how long each of those recordings is, and write the numbers back.
 * Silent beats are left exactly as the edit set them — their length is a
 * decision about the camera, not about a voice.
 *
 * Run it after `prewarm_voice.mjs` and after `trim_voice_tails.py`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const PORT = process.env.HC_PORT || '8000';
const BASE = process.env.HC_BASE || `http://127.0.0.1:${PORT}`;
const DRY = process.argv.includes('--dry');
const STORY = 'web/js/story.js';

/* The arithmetic lives in voice.js, not here.
 *
 * A beat's stated length is its recording at the cut's tempo plus the gap
 * (`RATE` and `GAP`), and `Narrator.beatLength` is the one place that knows it.
 * This script used to hold its own copy of the gap, which is two places to
 * change and one of them silent — the film would keep playing at a tempo the
 * stated lengths no longer described, and the only symptom is a runtime that
 * quietly reprints itself. So the lengths are read off a running film. */

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) { console.error(`No server at ${BASE}. Start one:  heatcanyon serve\n`); process.exit(1); }

/* The settled script, not the first one asked for. Same reasoning as
 * prewarm_voice.mjs: five sentences in chapter three are their fallback wording
 * until floors.json lands, and retiming against those is retiming against a
 * film nobody sees. */
const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
         '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
let lines = null;
let at = 0;
await page.route('**/api/voice/lines', async (r) => {
  lines = JSON.parse(r.request().postData() || '{}').lines || [];
  at = Date.now();
  return r.continue();                     // reads the cache; never spends
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120 && !(lines && Date.now() - at > 9_000); i++) await page.waitForTimeout(500);
if (!lines) { console.error('The film never asked for its script.'); await browser.close(); process.exit(1); }
const want = await page.evaluate(() =>
  window.HC.film.story.beats.map((b, i) => window.HC.film.narrator.beatLength(i)));
await browser.close();


/* Positional, and the source is read positionally too: the Nth `seconds:` in
 * story.js is the Nth beat, because that is the only order the file has. A
 * count that disagrees with the script the page built is a refusal rather than
 * a guess — writing thirty-one numbers into the wrong thirty-one places would
 * be very hard to see and very easy to ship. */
const src = readFileSync(STORY, 'utf8');
const hits = [...src.matchAll(/seconds:\s*([\d.]+)/g)];
if (hits.length !== lines.length) {
  console.error(`story.js has ${hits.length} beats, the film built ${lines.length}. Not touching it.`);
  process.exit(1);
}

let out = '';
let cursor = 0;
let total = 0;
let changed = 0;
console.log('beat    stated      now    delta   line');
for (const [i, h] of hits.entries()) {
  const was = Number(h[1]);
  const text = (lines[i] || '').trim();
  const now = (text && want[i]) ? want[i] : was;
  total += now;
  const tag = !text ? '(silent, left alone)'
    : !want[i] ? '(no recording, left alone)'
    : text.slice(0, 40);
  if (Math.abs(now - was) > 0.005) changed++;
  console.log(`  ${String(i).padStart(2)}  ${was.toFixed(2).padStart(7)}  ${now.toFixed(2).padStart(7)}  `
    + `${(now - was >= 0 ? '+' : '') + (now - was).toFixed(2)}`.padStart(7) + `   ${tag}`);
  out += src.slice(cursor, h.index) + `seconds: ${now}`;
  cursor = h.index + h[0].length;
}
out += src.slice(cursor);

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`\n${changed} beats restated. Runtime ${mmss(total)} (${total.toFixed(1)} s).`);
if (DRY) { console.log('Dry run: story.js not written.'); }
else { writeFileSync(STORY, out); console.log(`Written to ${STORY}.`); }

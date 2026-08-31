/* Write out the script the film actually settles on, as JSON.
 *
 *   node scripts/settled_script.mjs /tmp/settled.json
 *
 * The narration does not exist as text on disk — story.js builds every sentence
 * out of meta.json, ranked.json, floors.json and the GISTEMP series at run time
 * — so the only way to know what the film says is to build the film. And it
 * asks twice: once from `_prepare` while the title card is up, before the
 * decision layer has landed and five sentences are still their fallback
 * wording, and again with the real figures. This waits for the second.
 *
 * Positional, including the empty entries for the silent beats of the descent,
 * which have to keep their places or nothing downstream lines up.
 *
 * `trim_voice_tails.py` needs this and cannot get it for itself: it is Python,
 * and the browser is where the script exists.
 */

import { writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node scripts/settled_script.mjs <out.json>'); process.exit(1); }

const BASE = process.env.HC_BASE || `http://127.0.0.1:${process.env.HC_PORT || '8000'}`;
if (!(await fetch(`${BASE}/api/health`).catch(() => null))?.ok) {
  console.error(`No server at ${BASE}. Start one:  heatcanyon serve\n`);
  process.exit(1);
}

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
await browser.close();

if (!lines) { console.error('The film never asked for its script.'); process.exit(1); }
writeFileSync(OUT, JSON.stringify(lines));
console.log(`${lines.length} beats, ${lines.filter((l) => (l || '').trim()).length} spoken -> ${OUT}`);

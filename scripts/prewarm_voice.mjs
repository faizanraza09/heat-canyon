/* Bake the film's voice-over into web/data/vo/.
 *
 *   node scripts/prewarm_voice.mjs --dry     # what it would say, and what it costs
 *   node scripts/prewarm_voice.mjs           # say it, and cache it
 *
 * Why a browser rather than a Python script: the narration does not exist as
 * text anywhere on disk. story.js builds every sentence out of meta.json,
 * ranked.json and the GISTEMP series at run time — that is the whole point of
 * it, and it is why re-running the pipeline on a different city re-writes the
 * script — so the only way to know what the film says is to build the film.
 *
 * Which makes this script very nearly nothing. It opens the application and the
 * film prepares itself exactly as it would for a viewer — and then this rewrites
 * the film's own request to set `synthesise`, which is the one thing the film
 * cannot do for itself.
 *
 * That asymmetry is the whole design. A page load reads the cache; only this
 * script fills it. Otherwise every visitor, every reload and every run of the
 * Playwright suite would be spending characters out of a monthly allowance —
 * which is not a hypothetical, it is how the first three and a half thousand of
 * this account's ten thousand went.
 *
 * Run it after a pipeline build. The MP3s are committed, so a clone plays the
 * real read with no key — but they are keyed by the exact sentence, and a
 * rebuild that moves a number moves the sentence with it.
 */

import { chromium } from '@playwright/test';

const PORT = process.env.HC_PORT || '8000';
const BASE = process.env.HC_BASE || `http://127.0.0.1:${PORT}`;
const DRY = process.argv.includes('--dry');

const bytes = (n) => `${(n / 1024).toFixed(0)} kB`;
const MARK = { cached: '·', made: '+', missing: '!' };

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No server at ${BASE}. Start one:  heatcanyon serve\n`);
  process.exit(1);
}

const before = await fetch(`${BASE}/api/voice`).then((r) => r.json());
if (!before.enabled) {
  console.error('Voice-over is off. Set ELEVENLABS_API_KEY (or unset HEATCANYON_VOICE=0).');
  process.exit(1);
}
console.log(`voice ${before.voice_id}  model ${before.model_id}`);
console.log(`cache ${before.cache.lines} lines, ${bytes(before.cache.bytes)}\n`);

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
         '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

let reply = null;
let lines = null;
let linesAt = 0;
// Intercepted rather than read out of the page, because this is the exact array
// the film sends — including its empty entries for the silent beats of the
// descent, which have to keep their places or the reply stops being positional.
await page.route('**/api/voice/lines', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  lines = body.lines || [];
  linesAt = Date.now();
  reply = null;      // this request's verdict, not the previous one's
  /* PASSED THROUGH UNTOUCHED, EVEN ON A REAL RUN, AND THAT IS THE FIX.
   *
   * This used to add `synthesise: true` here, to every request the film made.
   * The film makes two — the fallback script while the title card is up, then
   * the real one when the decision layer lands — so a bake bought BOTH, and the
   * first one is a script the film never says. Measured on the current script:
   * 2,413 characters against the 2,219 that are actually needed, with the
   * difference spent on sentences that exist only until floors.json arrives. It
   * has been much worse than that; the note below this route is a whole
   * paragraph about the same two passes causing a different bug.
   *
   * The film's own request costs nothing (the endpoint reads the cache unless
   * told otherwise) and it is still the only way to learn which lines are
   * genuinely missing rather than guessing from the text. So observe here, and
   * spend once, below, on the script that settled. */
  return route.continue();
});

page.on('response', async (r) => {
  if (!r.url().includes('/api/voice/lines') || !r.ok()) return;
  reply = await r.json().catch(() => null);
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
// The film prepares its script while the title card is up, so this is a wait on
// the request having happened, not on the film having played.
await page.waitForFunction(() => window.__hcVoiceSeen || true, null, { timeout: 5_000 })
  .catch(() => {});
const deadline = Date.now() + 180_000;
while (!lines && Date.now() < deadline) await page.waitForTimeout(250);

/* THE FILM ASKS TWICE, AND THE FIRST SCRIPT IS NOT THE ONE IT SAYS.
 *
 * `_prepare` runs while the title card is up, which is before floors.json,
 * prescriptions.json and portfolio.json have landed. Every sentence built out of
 * the decision layer is still its own fallback at that moment: "Then it spends a
 * budget, and says where it went", where the film will actually say "$57
 * million, 91 buildings, 292 measures". The script is rebuilt when those files
 * arrive, and that second one is the film.
 *
 * Baking the first is how the cache fills with recordings of sentences the film
 * never says, and the beats carrying the figures drop to the browser voice on
 * the night while the test that would have caught it reports them as recorded.
 * It used to depend on which request happened to arrive first, which is a race
 * this had been winning and lost as soon as the data got slower.
 *
 * So take the last thing it asked for, not the first: wait until the film has
 * gone quiet, then bake that. */
const QUIET_MS = 12_000;
while (Date.now() < deadline && Date.now() - linesAt < QUIET_MS) {
  await page.waitForTimeout(250);
}
while (lines && !reply && Date.now() < deadline) await page.waitForTimeout(250);
await browser.close();

if (!lines) {
  console.error('The film never asked for its script — is the opening film disabled?');
  process.exit(1);
}

/* And now, once, on the settled script.
 *
 * Everything above this line is observation: the page has closed, `lines` is
 * the last thing the film asked for, and nothing has been synthesised. This is
 * the only request in the project that spends, and it is made by hand rather
 * than by the page so that it can be made exactly once.
 */
if (!DRY) {
  const res = await fetch(`${BASE}/api/voice/lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines, synthesise: true }),
  });
  if (!res.ok) {
    console.error(`Baking the script failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  reply = await res.json();
}

// Positional the whole way: the reply is indexed by the request, so a line and
// its verdict are found by the same index rather than by matching on text.
let missing = 0;
let missingChars = 0;
lines.forEach((line, i) => {
  const text = (line || '').trim();
  if (!text) return;                       // the silent beats of the descent
  const r = reply?.lines?.[i];
  const state = r?.url ? (r.cached ? 'cached' : 'made') : 'missing';
  if (state === 'missing') { missing++; missingChars += text.length; }
  console.log(`${MARK[state]} ${text}`);
});

const spoken = lines.filter((l) => l && l.trim());
const chars = spoken.reduce((n, l) => n + l.trim().length, 0);
console.log(`\n${spoken.length} lines, ${chars} characters`);
console.log(`${MARK.cached} already recorded   ${MARK.made} recorded now   ${MARK.missing} `
  + 'not recorded (the film reads these with the browser voice)');

const after = await fetch(`${BASE}/api/voice`).then((r) => r.json());
if (DRY) {
  console.log(`\n${missing} lines missing, ${missingChars} characters to buy.`);
  console.log('Dry run: nothing was synthesised or spent. Drop --dry to bake them.');
} else {
  console.log(`\ncache now ${after.cache.lines} lines, ${bytes(after.cache.bytes)}`);
  console.log(`spent ${after.spent_chars} characters this server process`);
  console.log('Commit web/data/vo/ — that is what stops it ever being bought again.');
}

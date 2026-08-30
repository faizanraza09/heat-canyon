/* Fill the voice cache with a free voice, for testing the film's timing.
 *
 *   node scripts/prewarm_voice_local.mjs          # bake with Edge's neural voice
 *   node scripts/prewarm_voice_local.mjs --voice en-GB-SoniaNeural
 *
 * WHY THIS EXISTS ALONGSIDE prewarm_voice.mjs
 *
 * The ElevenLabs bake is the real read and it is paid for out of a ten-thousand
 * character allowance. That allowance buys the *final* script, once. What it
 * must not buy is a rehearsal: a run to find out whether a beat is too short
 * for its sentence, whether the captions drift, whether the descent still lands
 * on the right frame. Those questions need audio of roughly the right length in
 * roughly the right voice, and nothing more.
 *
 * So this bakes the same script with Microsoft Edge's read-aloud voices, which
 * cost nothing and need no key, and writes them into the same cache under a
 * DIFFERENT voice id. That last part is the whole trick — see local_voice.py.
 *
 * It is deliberately a second script rather than a flag on the first. The one
 * flag in this project that is allowed to spend lives in prewarm_voice.mjs, and
 * a file that can either spend or not spend depending on an argument is a file
 * someone eventually runs the wrong way round.
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.HC_PORT || '8000';
const BASE = process.env.HC_BASE || `http://127.0.0.1:${PORT}`;
const vIdx = process.argv.indexOf('--voice');
const VOICE = vIdx > -1 ? process.argv[vIdx + 1] : 'en-GB-RyanNeural';

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No server at ${BASE}. Start one:  heatcanyon serve\n`);
  process.exit(1);
}

/* The server has to be keying the cache the same way this script is about to
 * write it, or the film will ask for a key nothing on disk answers to. Both
 * read HEATCANYON_VOICE_ID, so the check is just that they agree. */
const status = await fetch(`${BASE}/api/voice`).then((r) => r.json());
const want = process.env.HEATCANYON_VOICE_ID || `local-${VOICE}`;
if (status.voice_id !== want) {
  console.error(`The server is keying its cache for voice "${status.voice_id}", but this run
would write files for "${want}" — the film would ask for one and find the other.

Restart the server with the same id, then run this again:

  HEATCANYON_VOICE_ID=${want} python3 -m heatcanyon.cli serve --port ${PORT}
`);
  process.exit(1);
}
console.log(`voice ${status.voice_id}  (Edge: ${VOICE})`);
console.log(`cache ${status.cache.lines} lines\n`);

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
         '--mute-audio', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

/* Observed rather than intercepted. prewarm_voice.mjs has to rewrite the body
 * to set the spending flag; this script never spends through the server at all,
 * so it only needs to overhear what the film asked for. */
let lines = null;
let linesAt = 0;
page.on('request', (r) => {
  if (!r.url().includes('/api/voice/lines') || r.method() !== 'POST') return;
  try {
    lines = JSON.parse(r.postData() || '{}').lines || [];
    linesAt = Date.now();
  } catch (e) { /* a body we cannot read is a request we did not want */ }
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const deadline = Date.now() + 180_000;
while (!lines && Date.now() < deadline) await page.waitForTimeout(250);

/* The film asks twice and the first script is not the one it says: `_prepare`
 * runs while the title card is up, before floors.json, prescriptions.json and
 * portfolio.json land, so every sentence built out of the decision layer is
 * still its own fallback. Take the last thing it asked for. The reasoning is
 * prewarm_voice.mjs's and is written out in full there. */
const QUIET_MS = 12_000;
while (Date.now() < deadline && Date.now() - linesAt < QUIET_MS) {
  await page.waitForTimeout(250);
}
await browser.close();

if (!lines) {
  console.error('The film never asked for its script — is the opening film disabled?');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'hc-voice-'));
const file = join(dir, 'lines.json');
writeFileSync(file, JSON.stringify(lines));
console.log(`${lines.filter((l) => l && l.trim()).length} lines captured\n`);

/* The keying, the synthesis and the transcode all live in Python, because
 * `key_for` does and a second implementation of a cache key is a cache that
 * silently misses. */
const py = spawn('python3', ['scripts/local_voice.py', file, '--voice', VOICE], {
  stdio: 'inherit',
  env: { ...process.env, HEATCANYON_VOICE_ID: want },
});
py.on('exit', (code) => process.exit(code ?? 1));

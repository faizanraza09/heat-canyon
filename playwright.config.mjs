/* Playwright configuration.
 *
 * The suite drives the real application against the real pipeline output, so it
 * needs the server running. `webServer` starts it on a dedicated port and tears
 * it down afterwards, which also guarantees the tests can never collide with a
 * server the developer happens to have open.
 *
 * Software GL (SwiftShader) is forced so the suite behaves identically on a
 * machine with no GPU, which is the normal case in CI. It is slow — hence the
 * generous timeouts — but it is deterministic.
 */

import { existsSync } from 'node:fs';

import { defineConfig } from '@playwright/test';

const PORT = process.env.HC_TEST_PORT || '8791';

/* Which Python runs the server.
 *
 * `.venv/bin/python` was hard-coded, which meant the suite could not run at all
 * on a checkout that installed into the system interpreter or a conda
 * environment — and the failure was a Playwright timeout waiting for
 * /api/health, which reads as "the app is broken" rather than "there is no
 * .venv". `HC_PYTHON` overrides; otherwise the venv is used when it exists and
 * `python3` when it does not.
 */
const PYTHON = process.env.HC_PYTHON
  || (existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
      ],
    },
  },
  webServer: {
    // Pass the port as a flag, not via PORT, so this command line differs
    // textually from the one a developer types. Playwright's teardown kills the
    // server by matching the command it spawned, and while both were identical
    // every test run also killed whatever dev server happened to be open.
    command: `${PYTHON} -m heatcanyon.cli serve --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

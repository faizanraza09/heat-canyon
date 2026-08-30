# Working in this repo

## Do not run the Playwright suite to check your work

The full suite is 147 browser tests driving a real WebGL scene through SwiftShader
(software GL, forced in `playwright.config.mjs` so it is deterministic on a machine
with no GPU). **It takes about 28 minutes.** Several suites take 5–15 minutes on
their own.

Running it is almost never the right way to find out whether a change works, and
blocking a reply on it wastes far more of the user's time than the change took.

**Default: do not run tests at all.** Make the change, say what you changed, and
stop. The user runs the suite when the user wants the suite.

### When you do need to check something

In this order, stopping as soon as you have your answer:

1. **Read the code.** Most questions are answered by `grep` and reading.
2. **Syntax-check.** Fast and catches the common break:
   ```sh
   cp web/js/thing.js /tmp/chk.mjs && node --check /tmp/chk.mjs
   ```
3. **Compute it offline.** The binaries in `web/data/` are plain little-endian
   `int16`/`uint16` — `numpy` reads them in one line. Percentiles, domains and
   colour ranges are all far quicker to check here than in a browser.
4. **One targeted test**, with `-g` narrowing it further:
   ```sh
   npx playwright test 09-design -g "one heat ramp"     # ~20 s
   ```
   Write a throwaway `tests/_probe_*.spec.mjs` that gathers everything you need in
   a single page load rather than running several real specs. Delete it afterwards.

**Never** run bare `npx playwright test`. If you genuinely believe a full run is
warranted, ask first and say how long it will take.

### If a test run is unavoidable

Run it in the background, keep working, and report without waiting on it. Do not
sit in a polling loop.

## The suite is not a clean baseline

Several sessions edit this tree at once and the suite drifts behind the app. As of
2026-08-30 about 40 of 147 tests fail on `main` for reasons unrelated to whatever
you are doing:

- renamed tabs and panels, a fifth film chapter, a re-baked narration
- new in-flight specs (`15-orbit`, `15-floor-shards`, `16-smooth-time`)
- `GoogleCloudAuth: Failed to load data with error code 429` — the photoreal tile
  API rate-limiting this machine. Environmental, not a code fault.

So **a failing test is not evidence that you broke something**, and a passing suite
is not available to be preserved. Before you "fix" a failure, establish that your
change caused it. Before you delete a test, establish that it is not catching a
real bug — one of these was (selecting the Air layer never loaded its data).

## Style

The codebase comments *why*, at length, including what was tried and measured and
rejected. Match that register when you touch a file. A comment that restates the
code is noise here; a comment carrying a measurement or a discarded alternative is
the house style.

/* Mounting the decision-layer surfaces, and surviving their absence.
 *
 * Four modules — the floor schedule, the what-if pane, the portfolio and the
 * building brief — are mounted here rather than imported at the top of
 * `ui.js`, and the reason is not tidiness.
 *
 * A static `import` that fails takes the whole module graph with it. `ui.js`
 * failing to parse means no panels, no layers, no year strip, no analyst and no
 * model: a blank screen, with a console message about one file. These four
 * surfaces are the newest and least load-bearing part of the application and
 * they read data products that a build may legitimately not have produced, so
 * having them able to black out the atlas is exactly the wrong risk to carry.
 *
 * A dynamic import in a try/catch cannot do that. A module that is missing,
 * that throws while evaluating, or whose constructor fails, costs one pane and
 * says so in the console; everything else comes up. `docs/DECISIONS.md` states
 * this as a requirement — "a build with no decision layer available still
 * produces a working atlas" — and this file is where it is actually enforced.
 *
 * WHAT EACH MODULE HAS TO EXPORT
 *
 * The panes:            class with (ctx) constructor, mount(host), update(), destroy()
 * The full-screen views: class with (ctx) constructor, open(...), close(), destroy()
 *
 * Nothing here reaches into a surface beyond that. See `ctx.js` for what they
 * are handed and why the traffic only goes one way.
 */

const $ = (id) => document.getElementById(id);

/** Load one module and construct one surface, or return null and say why. */
async function surface(label, path, name, make) {
  try {
    const mod = await import(path);
    const Cls = mod[name];
    if (typeof Cls !== 'function') {
      throw new Error(`${path} does not export ${name}`);
    }
    return make(Cls);
  } catch (e) {
    // `info`, not `warn`. A build without the decision stage is a supported
    // configuration and a yellow console is how a supported configuration starts
    // looking like a broken one.
    console.info(`decision surface "${label}" unavailable: ${e.message}`);
    return null;
  }
}

/**
 * Mount every decision surface that is present, and return what was mounted.
 *
 * The returned object is keyed by the name `ui.js` uses to reach a surface —
 * `diagnose` and `whatif` are tab names, `brief` and `portfolio` are views — so
 * `this.surfaces?.[name]?.update?.()` in the tab switcher needs no mapping
 * table. A key is absent when its module is.
 */
export async function mountDecisionSurfaces(ui, ctx) {
  const out = {};

  // WAIT FOR THE PRODUCTS BEFORE BUILDING ANYTHING THAT READS THEM.
  //
  // `data.js` starts the three decision fetches but does not await them, so the
  // atlas can paint its first frame without 1.9 MB of tables it cannot show
  // yet. That is right for the atlas and wrong here: a surface constructed
  // before they land reads `decision.portfolio` as null, renders "0 candidates,
  // 0 objectives", and — because the products arrive a moment later with no
  // event to say so — never renders anything else. The portfolio came up empty
  // for exactly that reason while `portfolio.json` sat on disk with 769 rows in
  // it.
  //
  // Awaiting costs nothing the atlas can feel: this whole function already runs
  // after the scene is built, and `ready` never rejects — `optional()` resolves
  // to null on any failure, so a build without the products falls through to
  // the same absent-module path as before.
  try { await ctx.decision?.ready; } catch { /* optional() cannot reject */ }

  // The two panes live in the left column and need a host element that exists.
  // A pane whose host is missing from the markup is a wiring error rather than
  // an optional product, so it is reported differently.
  const paneHost = (id) => {
    const n = $(id);
    if (!n) console.warn(`decision: no #${id} in the markup — pane not mounted`);
    return n;
  };

  const [floors, whatif, portfolio, brief] = await Promise.all([
    surface('floor schedule', './floors.js', 'FloorSchedule', (C) => new C(ctx)),
    surface('what if', './whatif.js', 'WhatIf', (C) => new C(ctx)),
    surface('portfolio', './portfolio.js', 'Portfolio', (C) => new C(ctx)),
    surface('brief', './brief.js', 'Brief', (C) => new C(ctx)),
  ]);

  const dh = floors && paneHost('tab-diagnose');
  if (dh) { floors.mount(dh); out.diagnose = floors; }

  const wh = whatif && paneHost('tab-whatif');
  if (wh) {
    // The pane owns the whole tab body from here. `ui.js`'s own `_whatif()` had
    // already written the three-site preset grid into it at construction time,
    // and leaving that in place put two what-if panes in one column — the old
    // one on top, silently reading a different selection from the new one.
    wh.innerHTML = '';
    whatif.mount(wh);
    out.whatif = whatif;
  }

  if (portfolio) out.portfolio = portfolio;
  if (brief) out.brief = brief;

  // Decide holds BOTH panes, so it is hidden only when neither module mounted.
  // The tab is in the markup unconditionally so the row does not reflow when the
  // modules land a few hundred milliseconds after first paint.
  const tab = document.querySelector('#tabs button[data-tab="decide"]');
  if (tab) tab.hidden = !(out.diagnose || out.whatif);

  // Ways in to the two views, from the places a reader is when they want one.
  const pb = $('open-portfolio');
  if (pb) {
    pb.hidden = !out.portfolio;
    pb.onclick = () => ui.openPortfolio();
  }

  // NO ESCAPE HANDLER HERE, deliberately.
  //
  // Both full-screen views already register their own on `document` in the
  // capture phase, which is the right place: Escape has to mean "leave this
  // view" rather than what it means in the atlas underneath, and the same rule
  // is why the tour owns the key while it is up.
  //
  // A handler here would be on `window`, and window capture runs BEFORE
  // document capture — so it would close the view first and stop propagation,
  // and the view's own handler would never run. That handler is what restores
  // focus to whatever opened it and puts `document.title` back. The result
  // would be a view that closes correctly and leaves the keyboard nowhere,
  // which is a bug that only shows up for someone navigating without a mouse.

  const names = Object.keys(out);
  console.log('decision surfaces:', names.length ? names.join(', ') : 'none in this build');
  return out;
}

/* How the photoreal layer streams, as opposed to whether it exists.
 *
 * 04-photoreal.spec.mjs guards the two things that must never happen: a
 * billable request the user did not ask for, and Google tile content in a
 * committed screenshot. It therefore never turns the layer on, which left the
 * whole of the streaming configuration untested — and that is exactly where the
 * defects were. The layer shipped throttling downloads to an eighth of the
 * library default and parsing to a fifth, listening for a tileset event that
 * this version of the library does not dispatch, and asking a pedestrian view
 * for full pixel accuracy over a fourteen-kilometre frustum. Measured at street
 * level: 989 tiles queued, 357 waiting to parse, 123 loaded after forty
 * seconds, and a grey box where Midtown should be.
 *
 * None of that shows up in a "does the toggle work" test, and all of it shows
 * up in the numbers the TilesRenderer keeps about itself. So this spec builds a
 * real TilesRenderer against a stubbed tileset — every request to
 * tile.googleapis.com is intercepted and answered locally, so the suite still
 * costs nothing and still stores no Google content — and asserts on the
 * settings and the control loop rather than on pixels.
 */

import { test, expect } from '@playwright/test';
import { openApp } from './helpers.mjs';

/* A valid, empty 3D Tiles 1.1 tileset.
 *
 * Empty is the point: the root has no content and no children, so the renderer
 * initialises fully — plugins run, queues are installed, the root-tileset event
 * fires — and then asks for nothing further. There is no second request to
 * intercept and no geometry to store. */
const STUB_TILESET = JSON.stringify({
  asset: { version: '1.1' },
  geometricError: 4000,
  root: {
    boundingVolume: { box: [0, 0, 0, 500, 0, 0, 0, 500, 0, 0, 0, 500] },
    geometricError: 2000,
    refine: 'REPLACE',
    children: [],
  },
});

/** Answer Google locally, and record anything that got past us. */
async function stubGoogle(page) {
  const escaped = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('tile.googleapis.com') || u.includes('/v1/3dtiles')) escaped.push(u);
  });
  await page.route('**tile.googleapis.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: STUB_TILESET,
  }));
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ gmaps_key: 'AIzaSTUB-intercepted-never-sent' }),
  }));
  return escaped;
}

/** Bring the layer up against the stub and hand back the live tileset. */
async function enable(page) {
  await page.evaluate(() => window.HC.scene.setPhotoreal(true, 'AIzaSTUB-intercepted-never-sent'));
  await page.waitForFunction(() => !!window.HC.scene.photoreal?.tiles, null, { timeout: 30_000 });
}

/** Everything the streaming configuration is supposed to be, in one read. */
const readConfig = (page) => page.evaluate(() => {
  const t = window.HC.scene.photoreal.tiles;
  return {
    parseJobs: t.parseQueue.maxJobs,
    downloadsPerOrigin: t.downloadQueue.maxJobsPerOrigin,
    loadSiblings: t.loadSiblings,
    loadAncestors: t.loadAncestors,
    errorTarget: t.errorTarget,
    errorFalloff: t.errorFalloff,
    errorFalloffDensity: t.errorFalloffDensity,
  };
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.removeItem('heatcanyon.gmaps_key'); } catch (e) { /* ignore */ }
  });
});

test('the tile queues are deep enough to converge, and are this layer\'s own', async ({ page }) => {
  const escaped = await stubGoogle(page);
  const { errors } = await openApp(page);
  await enable(page);
  const cfg = await readConfig(page);

  /* The regression this exists for. `downloadQueue.maxJobs` is a deprecated
   * alias for `maxJobsPerOrigin` in this version of the library, so the old
   * code's "let more of it happen at once" silently cut concurrency from 25 to
   * 3. Both numbers are asserted as floors rather than as exact values so the
   * profiles stay free to be tuned upward, and never back down. */
  expect(cfg.parseJobs).toBeGreaterThanOrEqual(5);
  expect(cfg.downloadsPerOrigin).toBeGreaterThanOrEqual(12);

  /* And the queues must belong to this tileset. The library's exported
   * defaults are module-level singletons shared by every TilesRenderer in the
   * page; tuning those in place would outlive dispose() and reconfigure
   * anything else that ever streams tiles. */
  const globalsUntouched = await page.evaluate(async () => {
    const m = await import('3d-tiles-renderer');
    const t = window.HC.scene.photoreal.tiles;
    return {
      ownParse: t.parseQueue !== m.DEFAULT_PARSE_QUEUE,
      ownDownload: t.downloadQueue !== m.DEFAULT_DOWNLOAD_QUEUE,
      ownCache: t.lruCache !== m.DEFAULT_LRU_CACHE,
      defaultParseJobs: m.DEFAULT_PARSE_QUEUE.maxJobs,
      defaultCacheBytes: m.DEFAULT_LRU_CACHE.maxBytesSize,
      cacheBytes: t.lruCache.maxBytesSize,
      // Borrowed rather than reinvented: eviction order decides that the tile
      // behind you goes before the one in front of you.
      hasEviction: typeof t.lruCache.unloadPriorityCallback === 'function',
    };
  });
  expect(globalsUntouched.ownParse).toBe(true);
  expect(globalsUntouched.ownDownload).toBe(true);
  expect(globalsUntouched.ownCache).toBe(true);
  expect(globalsUntouched.defaultParseJobs).toBe(5);
  // The shared default must still be the library's, not this layer's setting.
  expect(globalsUntouched.defaultCacheBytes).toBeCloseTo(0.4 * 1024 ** 3, 0);
  expect(globalsUntouched.cacheBytes).toBeGreaterThanOrEqual(0.4 * 1024 ** 3);
  expect(globalsUntouched.hasEviction).toBe(true);

  expect(errors).toEqual([]);
  // Nothing reached Google, so the whole spec is free.
  expect(escaped.filter((u) => !u.includes('tile.googleapis.com'))).toEqual([]);
});

test('the detail budget is spent by distance, not spread over the frustum', async ({ page }) => {
  await stubGoogle(page);
  await openApp(page);
  await enable(page);

  const cfg = await readConfig(page);
  const floor = await page.evaluate(() => window.HC.scene.photoreal.profile.errorTarget);

  /* Without a falloff, a tile at the horizon is held to the same pixel accuracy
   * as the block below the camera, and with a 14 km far plane that is most of
   * the borough competing for one queue.
   *
   * Measured against the profile's floor, not against `tiles.errorTarget`: the
   * live target is wherever the ramp has walked to, which on a freshly enabled
   * layer is still the ceiling. The discount is subtractive, so it has to be a
   * real fraction of the floor to bite once the ramp has arrived there. */
  expect(cfg.errorFalloff).toBeGreaterThan(0);
  expect(cfg.errorFalloff).toBeGreaterThanOrEqual(floor * 0.5);
  expect(cfg.errorFalloffDensity).toBeGreaterThan(0);

  /* Siblings are tiles the frustum does not contain, fetched so that turning
   * the head finds them already there. They compete with what is on screen for
   * the same queue. Ancestors stay on regardless: a parent tile is what stands
   * in for its children while they are in flight. */
  expect(cfg.loadSiblings).toBe(false);
  expect(cfg.loadAncestors).toBe(true);
});

test('the detail ramp only ever walks one way: down', async ({ page }) => {
  await stubGoogle(page);
  await openApp(page);
  await enable(page);

  const ramp = await page.evaluate(() => {
    const pr = window.HC.scene.photoreal;
    const t = pr.tiles;
    // Drive the controller directly with a known progress rather than waiting
    // on a real stream: the loop under test is "what does it do with this
    // number", and a stub tileset reports 1 immediately.
    const run = (progress, seconds) => {
      Object.defineProperty(t, 'loadProgress', { value: progress, configurable: true });
      let now = performance.now();
      pr._rampAt = now;
      for (let i = 0; i < seconds * 10; i++) { now += 100; pr._rampDetail(now); }
      return t.errorTarget;
    };

    pr.setDetail();
    const opening = t.errorTarget;
    const floor = pr.profile.errorTarget;

    const settled = run(1.0, 12);     // the queues drained: tighten to the floor
    const starved = run(0.0, 20);     // a fresh batch in flight: must NOT rise
    const midway = run(0.7, 20);      // partway through one: must NOT rise
    return { opening, floor, settled, starved, midway };
  });

  // It opens above the floor, because Google's tiles refine by REPLACE: a level
  // appears only once every sibling in it has arrived, so asking for a depth
  // the pipeline cannot finish yields no picture rather than a coarse one.
  expect(ramp.opening).toBeGreaterThan(ramp.floor * 1.5);
  // A machine keeping up reaches full detail.
  expect(ramp.settled).toBeCloseTo(ramp.floor, 5);

  /* And then it stays there. This is the regression that matters.
   *
   * The ramp used to loosen on low `loadProgress`, which is not "how much of
   * the city has arrived" but a batch-completion ratio whose denominator resets
   * whenever the queues drain — so requesting anything at all from a settled
   * state sends it to ~0.01. Raising the target is not a gentle degradation
   * either: measured on a settled tileset with the camera untouched and no
   * network activity, 9 -> 24 dropped the drawn set from 548 meshes to 117
   * inside one frame, with all 861 tiles still resident. Together those made a
   * self-triggering limit cycle that collapsed and rebuilt the view every few
   * seconds, and hard on every pan or rotate. */
  expect(ramp.starved).toBeCloseTo(ramp.floor, 5);
  expect(ramp.midway).toBeCloseTo(ramp.floor, 5);
});

test('the layer says what it is doing, and stops saying it when done', async ({ page }) => {
  await stubGoogle(page);
  await openApp(page);

  const seen = [];
  await page.exposeFunction('__prStatus', (state, detail) => seen.push([state, detail]));
  await page.evaluate(() => {
    const prev = window.HC.scene.onPhotorealStatus;
    window.HC.scene.onPhotorealStatus = (s, d) => { window.__prStatus(s, d); prev?.(s, d); };
  });
  await enable(page);
  // The stub tileset completes immediately, so the ready state is one frame away.
  await page.waitForFunction(
    () => document.getElementById('pr-status')?.textContent === '', null, { timeout: 20_000 });

  /* The old code waited on `load-tile-set`, which this library has never
   * dispatched — the names are `load-root-tileset` and `load-tileset` — so the
   * panel sat on "requesting tiles" forever and a session that was streaming
   * perfectly looked exactly like one whose key had been refused. */
  expect(seen.some(([s]) => s === 'loading')).toBe(true);
  expect(seen.some(([s]) => s === 'ready')).toBe(true);
  expect(seen.some(([s]) => s === 'error')).toBe(false);
});

test('streamed materials are released when their tiles are', async ({ page }) => {
  await stubGoogle(page);
  await openApp(page);
  await enable(page);

  const r = await page.evaluate(async () => {
    const pr = window.HC.scene.photoreal;
    const THREE = await import('three');
    // Stand in for one streamed tile: a group holding a mesh, patched on the
    // way in and forgotten on the way out, exactly as the two model events do.
    const mesh = { isMesh: true, material: new THREE.MeshBasicMaterial() };
    const model = { traverse(fn) { fn(this); fn(mesh); } };

    const before = pr._mats.size;
    pr._patchMaterials(model);
    const patched = pr._mats.size;
    pr._forgetMaterials(model);
    return { before, patched, after: pr._mats.size };
  });

  /* Without the release the set grows by one entry per tile ever streamed, for
   * the life of the session, long after the GPU memory behind each is gone —
   * and it is walked in full every time a look slider moves. */
  expect(r.patched).toBe(r.before + 1);
  expect(r.after).toBe(r.before);
});

test('the sky survives the photoreal layer', async ({ page }) => {
  await stubGoogle(page);
  await openApp(page);

  const before = await page.evaluate(() => window.HC.scene.sky.visible);
  await enable(page);
  const after = await page.evaluate(() => ({
    sky: window.HC.scene.sky.visible,
    ground: window.HC.scene.ground?.visible,
    backdrop: window.HC.scene.backdrop?.visible,
  }));

  /* The ground plane, the backdrop and the drawn streets all stand in for a
   * real world that the tiles now supply, and go. The sky does not: Google's
   * mesh contains no sky, so hiding the dome leaves the slot between two towers
   * as the raw clear colour — one flat grey band in the middle of the frame, in
   * the place a street-canyon model has most to say. */
  expect(before).toBe(true);
  expect(after.sky).toBe(true);
  expect(after.ground).toBe(false);
  expect(after.backdrop).toBe(false);
});

/* Everything above runs on this machine's real renderer, which under Playwright
 * is SwiftShader — so it only ever exercises the software profile. The profile
 * a visitor with a graphics card actually gets was therefore the one path never
 * tested, which is the wrong way round. Lying about the renderer string is the
 * cheapest honest way to reach it: `isSoftwareRenderer` reads exactly two GL
 * parameters, and nothing else in the layer cares where the answer came from. */
async function pretendGpu(page) {
  await page.addInitScript(() => {
    const GL_RENDERER = 0x1F01;
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    const FAKE = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)';
    for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Ctx) continue;
      const real = Ctx.prototype.getParameter;
      Ctx.prototype.getParameter = function patched(p) {
        if (p === GL_RENDERER || p === UNMASKED_RENDERER_WEBGL) return FAKE;
        return real.call(this, p);
      };
    }
  });
}

test('a machine with a graphics card gets the fuller profile', async ({ page }) => {
  await pretendGpu(page);
  await stubGoogle(page);
  const { errors } = await openApp(page);
  await enable(page);

  const hw = await page.evaluate(() => {
    const pr = window.HC.scene.photoreal;
    const t = pr.tiles;
    return {
      software: pr.softwareRenderer,
      parseJobs: t.parseQueue.maxJobs,
      anisotropy: pr.profile.anisotropy,
      errorTarget: pr.profile.errorTarget,
      // Cross-fading LOD transitions is pleasant on a GPU and doubles the
      // raster work a software renderer is already losing to. Matched on the
      // plugin's own `name`, not its constructor's: the build is minified, so
      // `constructor.name` is a single letter.
      fading: t.plugins.some((p) => p.name === 'FADE_TILES_PLUGIN'),
      // And the resolution the rest of the application draws at is only worth
      // sacrificing when a CPU is doing the rasterising.
      pixelRatioBorrowed: pr._priorPixelRatio !== null,
    };
  });

  expect(hw.software).toBe(false);
  expect(hw.parseJobs).toBeGreaterThan(6);
  expect(hw.anisotropy).toBeGreaterThan(1);
  expect(hw.errorTarget).toBeLessThan(14);
  expect(hw.fading).toBe(true);
  expect(hw.pixelRatioBorrowed).toBe(false);
  expect(errors).toEqual([]);
});

test('the street wash measures height above the road, not above the datum', async ({ page }) => {
  await stubGoogle(page);
  await openApp(page);
  await enable(page);

  const r = await page.evaluate(async () => {
    const pr = window.HC.scene.photoreal;
    const THREE = await import('three');
    // One streamed tile's worth of material, patched the way a real one is.
    const mesh = { isMesh: true, material: new THREE.MeshBasicMaterial() };
    pr._patchMaterials({ traverse(fn) { fn(this); fn(mesh); } });

    // Already non-zero on arrival: the frame loop pushes the terrain height
    // under the fly-over camera, which over Midtown is a metre or so.
    const before = mesh.material.userData.uniforms.uGroundY.value;
    pr.setGroundY(18.5);
    const after = mesh.material.userData.uniforms.uGroundY.value;
    pr.setGroundY(18.52);            // below the threshold worth an update
    const ignored = mesh.material.userData.uniforms.uGroundY.value;

    // And the scene has to be the thing that knows where the ground is.
    const supplied = typeof pr.o.groundYAt === 'function';
    return { before, after, ignored, supplied };
  });

  /* The falloff term reads `vWorldPR.y - uGroundY`. It used to read
   * `vWorldPR.y` alone — height above y = 0, which is the flat datum and not
   * the ground. Midtown's terrain spans 0-26 m and the falloff saturates at
   * 22 m, so on the high ground the roadway took essentially none of the
   * measured field: the data quietly drained out of the streets as you walked
   * north, which looks like the layer working and is not. */
  expect(r.supplied).toBe(true);
  expect(Number.isFinite(r.before)).toBe(true);
  expect(r.after).toBeCloseTo(18.5, 5);
  expect(r.after).not.toBeCloseTo(r.before, 3);
  expect(r.ignored).toBeCloseTo(18.5, 5);
});

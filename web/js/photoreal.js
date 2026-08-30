/* Google Photorealistic 3D Tiles as an optional context layer.
 *
 * Why this exists, and why it is a layer rather than the basemap
 * -------------------------------------------------------------
 * scene.js argues, correctly, that a photographic basemap fights the data for
 * attention. That argument still holds — which is why this ships switched off
 * and behind an explicit toggle. What it buys when switched on is recognition:
 * a client who cannot read a sky view factor can absolutely read "that is the
 * north side of 42nd Street", and the roads, kerbs, vehicles and street trees
 * come along for free because they are part of the same photogrammetry mesh.
 *
 * Why Google's 3D Tiles rather than Street View
 * --------------------------------------------
 * Street View panoramas cannot take a WebGL overlay: `WebGLOverlayView` binds
 * to a vector `Map`, never to a `StreetViewPanorama`, and the panorama's depth
 * buffer is not exposed. Anything drawn over a panorama therefore floats in
 * front of every foreground object, misregisters by a few metres as the pose
 * drifts, and cannot move continuously because panoramas are ~10 m apart.
 * Photorealistic 3D Tiles are real geometry, so occlusion is correct by
 * construction and the existing first-person walker keeps working unchanged.
 *
 * Cost
 * ----
 * Billing is per *root tileset request*, roughly one per session, not per
 * tile — a visitor streaming hundreds of megabytes for an hour is one billable
 * event, against a free allowance of 1,000/month. That is why the layer
 * defaults to off and constructs no TilesRenderer until enabled: with the
 * toggle untouched, no root request is ever issued and the session costs
 * nothing. Callers should still set a quota cap on root tile requests.
 *
 * Terms that shape the code below
 * -------------------------------
 * - Attribution from each tile's `asset.copyright` must be aggregated and
 *   shown, and the viewer has to be able to tell Google's basemap apart from
 *   our data. Hence `onAttribution` and the separate credit line in the UI.
 * - Tiles may not be cached, so the Playwright visual baselines deliberately
 *   never enable this layer.
 * - Geometry may not be "extracted, traced, or otherwise derived" from the
 *   tiles. Nothing here reads back from them; the surface model that feeds the
 *   physics comes from public LiDAR (see heatcanyon/lidar.py).
 */

import { api } from './api.js';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  TilesRenderer, PriorityQueue, DownloadPriorityQueue, unifiedPriorityCallback,
  LRUCache, DEFAULT_LRU_CACHE,
} from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import {
  GLTFExtensionsPlugin, TileCompressionPlugin, TilesFadePlugin, ReorientationPlugin,
} from '3d-tiles-renderer/three/plugins';
import { CUT_GLSL } from './cut.js';

const DEG = Math.PI / 180;

/* Geoid separation for Manhattan (GEOID18): ellipsoidal height minus NAVD88
 * orthometric height. The footprint table's ground_elevation and the LiDAR are
 * both NAVD88; ReorientationPlugin wants height above the WGS84 ellipsoid. The
 * two differ by about this much across the city, and getting the sign wrong
 * sinks the whole tileset 65 m. Exposed as a nudge in the UI because a single
 * constant cannot be right everywhere and the residual is easier to dial out by
 * eye than to model. */
const GEOID_NAVD88_M = -32.4;

/* Azimuth buckets the facade field is aggregated into before projection.
 * Eight is the smallest number that keeps the four Manhattan grid orientations
 * distinct from the four diagonals, which matters because the entire
 * east-morning / west-evening asymmetry the model exists to show lives in the
 * difference between opposite buckets. */
const N_BUCKETS = 8;

/* Screen-space error target, in pixels: how much geometric error, projected to
 * the screen, is acceptable before a tile is refined.
 *
 * Google's recommended value is 20, and it is tuned for a flat map view rather
 * than for an oblique one of a city. Measured against this scene it is far too
 * loose to be called photoreal: at 20, the drawn tiles came back at 16 to 64 m
 * of geometric error with a median of 32, while the finest level Google
 * publishes here is 2.006 m. Not one drawn tile was at the floor. That is four
 * to five levels of detail left unrequested, and it is the whole of the answer
 * to "why is the mesh soft" from the air — at altitude the limit is this
 * number, not the dataset.
 *
 * Tightening it costs bandwidth and nothing else. Billing is per session, so a
 * detailed session is the same single billable event as a coarse one, and the
 * ramp below protects a machine that cannot keep up: an ambitious floor is safe
 * precisely because nothing is obliged to reach it.
 *
 * Measured at 20, then 6, then 3, on the fly-over's default framing:
 *
 *     target   tiles drawn   median gErr   finest gErr   under 8 m
 *       20         163          32.1          16.1           0
 *        6         300          16.1           8.0          27
 *
 * Each halving of the target buys about one LOD level across the frame. Three
 * is chosen rather than the 2.006 m floor of the dataset because the target is
 * screen-space: from a kilometre up, an 8 m tile already projects to about four
 * pixels, so past a point the request buys sub-pixel geometry at four times the
 * tile count. Three keeps the near half of the frame refining while the far
 * half, which the falloff has already discounted, stops.
 */
const ERROR_TARGET = 3;

/* Distance falloff on that target, as {amount in pixels, 1/metres}.
 *
 * The error target is a screen-space budget spread evenly over the frustum, so
 * without a falloff a tile at the horizon is held to the same pixel accuracy as
 * the block below the camera. `errorFalloff` subtracts from a tile's error as
 * `amount * (1 - exp(-(d * density)^2))`, flat near the eye and saturating past
 * `1/density`, so the budget is spent where it can be seen.
 *
 * Expressed as a fraction of the profile's target rather than as a fixed number
 * of pixels, because a subtractive discount of five pixels means something
 * quite different against a target of 14 than against one of 6. At 3.5 km the
 * discount reaches most of that fraction, which softens the far edge of the
 * study area without touching the middle distance the fly-over actually frames.
 */
const ERROR_FALLOFF = { fraction: 0.8, density: 1 / 3500 };

/* Google Photorealistic Tiles are designed for a hardware WebGL renderer. A
 * software renderer (SwiftShader, WARP, llvmpipe, etc.) can still show the
 * layer, but asking it to decode, blend and rasterise the same dense tile set
 * makes the browser spend its time on partial LODs. Those partial LODs are the
 * faceted shards that look like broken geometry. Keep the real mesh, but use a
 * bounded context-quality profile that a CPU can finish drawing.
 *
 * The job counts are the library's own defaults, restated here rather than
 * inherited, because the previous version *lowered* both by mistake. It set
 * `downloadQueue.maxJobs`, believing the default to be six; in this version
 * that property is a deprecated alias for `maxJobsPerOrigin`, whose default is
 * twenty-five, so "let more of it happen at once" cut concurrency by eight. The
 * parse queue went the same way, from five to one. Measured at street level the
 * result was 989 tiles queued, 357 waiting to parse and 123 loaded after forty
 * seconds: a pipeline that could not converge, in a scene that therefore never
 * looked like anything.
 *
 * The parse counts are above the library default rather than at it, because
 * parsing is where the time actually goes: measured on this scene, a tile takes
 * 170 ms to decode when the queue is quiet and around 600 ms once the renderer
 * is busy, and the work is mostly in Draco workers rather than on the main
 * thread. Raising the fly-over from three concurrent parses to eight took the
 * view from "still 240 tiles short after a minute" to fully resolved in forty
 * seconds. Downloads are left near the default: they finish long before parsing
 * does, so more of them only deepens the queue behind the real constraint.
 */
const GIB = 1024 * 1024 * 1024;

/* Tile cache size, in bytes.
 *
 * The library's default is 0.3–0.4 GiB, and that was sized for the error target
 * it also ships with. Asking for finer geometry raises the resident set roughly
 * in step: at a target of 20 the fly-over held about 160 tiles, at 3 it holds
 * several times that, and a cache that cannot fit the visible set evicts tiles
 * that are still on screen — which shows up as geometry flickering out and
 * being re-fetched while the camera is not even moving. A machine with a
 * graphics card can afford the headroom; one without keeps the default, because
 * there the constraint is the rasteriser rather than memory.
 */
const SOFTWARE_PROFILE = {
  errorTarget: 14,
  errorFalloff: ERROR_FALLOFF,
  downloadsPerOrigin: 20,
  parseJobs: 6,
  anisotropy: 1,
  pixelRatio: 1,
  lruBytes: { min: 0.3 * GIB, max: 0.4 * GIB },
};
const HARDWARE_PROFILE = {
  errorTarget: ERROR_TARGET,
  errorFalloff: ERROR_FALLOFF,
  downloadsPerOrigin: 25,
  parseJobs: 10,
  anisotropy: 8,
  pixelRatio: null,
  lruBytes: { min: 0.65 * GIB, max: 0.85 * GIB },
};

/* The detail ramp: where the target opens, and what walks it toward the floor.
 *
 * `ceiling` is the loosest the layer ever asks for and is only ever an
 * *opening* value. The ramp is one-way: it walks the target down and never back
 * up. That is not a stylistic preference, it is the whole lesson of the bug
 * this shape replaced.
 *
 * The previous version also loosened, on low `loadProgress`, to let a machine
 * that could not keep up settle above the floor. Two things were wrong with it.
 *
 * First, raising the target is not a gentle degradation — it is a demolition.
 * Measured on a settled tileset with the camera untouched and no network
 * activity at all, moving the target from 9 to 24 took the drawn set from 548
 * meshes and 1.25 M triangles to 117 and 0.32 M inside a single 250 ms frame,
 * with every one of the 861 cached tiles still resident. Nothing was unloaded;
 * the renderer simply stopped drawing three quarters of what it had.
 *
 * Second, and worse, `loadProgress` is not the quantity the old comment here
 * claimed. The library computes
 *
 *     1 - (queued + downloading + parsing) / (inCacheSinceLoad + isLoading)
 *
 * and `inCacheSinceLoad` is reset to zero every time the queues drain. So it is
 * a *batch completion ratio*, not "how much of the city has arrived": from a
 * settled state, asking for N more tiles gives 1 - N/(N+1) ~ 0 however much is
 * already on screen. Progress therefore jumps from 1.0 straight past both
 * thresholds to about 0.01, which no width of dead band can damp — and since
 * tightening is itself what requests those tiles, the loop self-triggered. The
 * result was a limit cycle that coarsened and re-refined the whole view every
 * few seconds with nobody touching the camera, and a hard collapse on every
 * pan or rotate.
 *
 * One-way has none of that. Tightening pauses while a batch is in flight and
 * resumes when it lands, so a machine that cannot reach the floor simply stops
 * climbing down and holds the finest level it did reach. It never retires
 * geometry it has already drawn, which is the only failure the viewer sees. */
const RAMP = { ceiling: 24, tightenAbove: 0.9, perSecond: 0.45 };

const DRACO_PATH = 'https://unpkg.com/three@0.170.0/examples/jsm/libs/draco/gltf/';


/** Where the API key comes from, in precedence order.
 *
 * Deliberately never a literal in the repo. A key committed to a public
 * repository is a key someone else spends. */
export function findApiKey() {
  try {
    const q = new URLSearchParams(location.search).get('gmaps_key');
    if (q) {
      localStorage.setItem('heatcanyon.gmaps_key', q);
      return q;
    }
    return localStorage.getItem('heatcanyon.gmaps_key') || '';
  } catch (e) {
    return '';
  }
}

/** Resolve a key, consulting the server as a last resort.
 *
 * Order matters and is deliberate: an explicit `?gmaps_key=` beats a remembered
 * one, a remembered one beats the server's, and the server is asked only when
 * the browser has nothing — so a developer's `.env` makes the layer available
 * locally without a paste, while a deployment that sets no key simply leaves it
 * off. The server value is not written to localStorage, so removing it from the
 * environment actually removes it rather than leaving a copy behind in every
 * browser that ever loaded the page.
 */
export async function resolveApiKey() {
  const local = findApiKey();
  if (local) return local;
  try {
    const r = await fetch(api('./api/config'), { cache: 'no-store' });
    if (!r.ok) return '';
    const j = await r.json();
    return (j && j.gmaps_key) || '';
  } catch (e) {
    return '';
  }
}

export function storeApiKey(key) {
  try {
    if (key) localStorage.setItem('heatcanyon.gmaps_key', key);
    else localStorage.removeItem('heatcanyon.gmaps_key');
  } catch (e) { /* private browsing; the key just will not persist */ }
}

function isSoftwareRenderer(renderer) {
  const gl = renderer?.getContext?.();
  if (!gl) return false;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const name = debug
    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  return /swiftshader|software|llvmpipe|microsoft basic render|\bwarp\b/i.test(String(name));
}

export class Photoreal {
  /**
   * @param {object} o
   * @param {THREE.Scene}    o.scene
   * @param {THREE.Camera}   o.camera
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {object}         o.meta        parsed meta.json
   * @param {number}         o.datumM      NAVD88 elevation that the scene's y=0 represents
   * @param {THREE.Texture}  o.fieldTex    the measured 2 m field, washed onto the streets
   * @param {object}         o.fieldRect   {x0, y0, w, h} of fieldTex in local metres
   * @param {function}       o.onAttribution called with an array of credit strings
   * @param {function}       o.onStatus     called with ('loading'|'ready'|'error', detail)
   */
  constructor(o) {
    this.o = o;
    this.softwareRenderer = Boolean(o.forceCpu) || isSoftwareRenderer(o.renderer);
    this.profile = this.softwareRenderer ? SOFTWARE_PROFILE : HARDWARE_PROFILE;
    // Null while we are not holding it. See _borrowPixelRatio.
    this._priorPixelRatio = null;
    this.tiles = null;
    this.enabled = false;
    this.nudgeM = 0;
    /* The live error target the ramp is walking down toward the profile's
     * floor. Kept on the instance rather than read off the tileset each frame
     * so the ramp survives a rebuild mid-flight. */
    /* Local terrain height under the eye, relative to the scene datum. The
     * street field wash falls off with height above the *road*, and once the
     * layer is on there is real terrain between the two. */
    this.groundY = 0;
    this._et = RAMP.ceiling;
    this._rampAt = 0;
    this._creditsAt = 0;
    this._progress = -1;
    this._done = false;
    /* Defaults that let the photograph survive.
     *
     * These started at 0.55 desaturation and 0.85 data wash, which was a
     * mistake worth recording: at that strength the heat colour is paint, not a
     * tint. It covers the windows, cornices and stonework that are the entire
     * reason for bringing in a photographic mesh, and the result reads as flat
     * coloured cardboard — which looks like the tiles failed to refine even
     * when they refined perfectly.
     *
     * Multiplying the heat colour over the retained luminance instead keeps the
     * building legible as a building and the field legible as a field. */
    this.desaturate = 0.35;
    this.fieldWash = 0.40;
    this.dataWash = 0.55;
    this._credits = [];
    this._mats = new Set();

    /* Lookup tables for painting our field onto geometry we did not author.
     *
     * `grid` answers "which building is at this ground position, and how tall
     * is its surface here" — the refined LiDAR massing, straight off the
     * pipeline. `params` carries each building's ground elevation and wall
     * height so a fragment's world Y can be turned into the same height band
     * the physics solved. `lut` is the colour of every
     * (building, azimuth bucket, band) cell, rebuilt whenever the hour or layer
     * changes.
     *
     * Splitting it this way keeps the per-frame work at zero and the per-hour
     * work at one small texture upload, instead of rewriting a vertex colour
     * buffer for geometry that is streamed in and out from under us. */
    this.grid = null;
    this.params = null;
    this.lut = null;
    this.lutSum = null;
    this.lutCount = null;

    /* The plugin orients the tileset with X facing *west* and Z facing north.
     * This scene's frame is (east, up, -north). A half turn about Y takes one
     * to the other: (x, y, z) -> (-x, y, -z). Doing it on a parent rather than
     * on tiles.group matters, because ReorientationPlugin writes group.matrix
     * directly and would overwrite anything set there. */
    this.root = new THREE.Group();
    this.root.rotation.y = Math.PI;
    this.root.visible = false;
    o.scene.add(this.root);
  }

  /* --------------------------------------------------------- lookup tables */

  /** Pack the two massing rasters into one RGBA byte texture.
   *
   * One texture rather than two because a fragment needs both values at the
   * same position, and a single fetch is both faster and impossible to get out
   * of sync. Building index goes in R,G (little-endian, 65535 = none) and
   * surface height in decimetres goes in B,A.
   *
   * NearestFilter throughout, and no mipmaps: these are indices, not colour.
   * Interpolating a building index produces a building that does not exist. */
  _buildGrid() {
    const d = this.o.data;
    const g = d.meta.massing_grid;
    if (!g || !d.massingBid || !d.massingH) return null;

    const n = g.nx * g.ny;
    const NONE = 65535;

    /* Dilate the building index outward by two cells before packing.
     *
     * The fragment shader probes this grid from a surface it does not own.
     * Google's mesh is an approximation of the same wall — at coarse LOD a very
     * crude one — so a probe near a footprint edge lands a cell or two off and
     * reads "street" where the wall plainly is. Unwidened, that produced
     * vertical stripes along every large slab at street level, one stripe per
     * 3 m cell boundary, because neighbouring fragments disagreed about whether
     * a building was there at all.
     *
     * Index and height are widened together, carrying the same neighbour's
     * pair, so the "is anything solid here" test survives the widening instead
     * of being dropped. That test still matters: it is what keeps the road, the
     * street trees and the vehicles in Google's mesh out of the tint, since
     * none of them sit under a building index with height on it.
     */
    const bid = Uint16Array.from(d.massingBid);
    const hgt = Uint16Array.from(d.massingH);
    for (let pass = 0; pass < 2; pass++) {
      const src = Uint16Array.from(bid);
      const srcH = Uint16Array.from(hgt);
      for (let i = 0; i < g.ny; i++) {
        for (let j = 0; j < g.nx; j++) {
          const k = i * g.nx + j;
          if (src[k] !== NONE) continue;
          let found = NONE;
          let foundH = 0;
          for (let dy = -1; dy <= 1 && found === NONE; dy++) {
            const ii = i + dy;
            if (ii < 0 || ii >= g.ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const jj = j + dx;
              if (jj < 0 || jj >= g.nx) continue;
              const kk = ii * g.nx + jj;
              const v = src[kk];
              if (v !== NONE) { found = v; foundH = srcH[kk]; break; }
            }
          }
          bid[k] = found;
          if (found !== NONE) hgt[k] = foundH;
        }
      }
    }

    const buf = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const b = bid[i];
      const h = hgt[i];
      const o = i * 4;
      buf[o] = b & 255;
      buf[o + 1] = (b >> 8) & 255;
      buf[o + 2] = h & 255;
      buf[o + 3] = (h >> 8) & 255;
    }
    const tex = new THREE.DataTexture(buf, g.nx, g.ny, THREE.RGBAFormat,
                                      THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** Per-building ground elevation (relative to the scene datum) and wall height. */
  _buildParams() {
    const attrs = this.o.data.buildings.attrs;
    const nB = attrs.length;
    const buf = new Float32Array(nB * 4);
    for (let i = 0; i < nB; i++) {
      const a = attrs[i];
      buf[i * 4] = (a && typeof a.base === 'number' ? a.base : 0) - this.o.datumM;
      buf[i * 4 + 1] = Math.max(a && a.h ? a.h : 1, 1);
    }
    const tex = new THREE.DataTexture(buf, 1, nB, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  _buildLut() {
    const nB = this.o.data.buildings.attrs.length;
    const nBands = this.o.data.facades.bands;
    const w = N_BUCKETS * nBands;
    this.lutSum = new Float32Array(w * nB * 3);
    this.lutCount = new Uint16Array(w * nB);
    const buf = new Uint8Array(w * nB * 4);
    const tex = new THREE.DataTexture(buf, w, nB, THREE.RGBAFormat,
                                      THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.lutW = w;
    this.lutH = nB;
    this.nBands = nBands;
    return tex;
  }

  /** Zero the accumulators. Called by the scene before it recolours. */
  beginLut() {
    if (!this.lut) return false;
    this.lutSum.fill(0);
    this.lutCount.fill(0);
    return true;
  }

  /** Average the samples and upload. One ~1.7 MB texture write per hour change. */
  commitLut() {
    if (!this.lut) return;
    const out = this.lut.image.data;
    const sum = this.lutSum, cnt = this.lutCount;
    for (let i = 0, n = cnt.length; i < n; i++) {
      const c = cnt[i];
      const o = i * 4, s = i * 3;
      if (c === 0) { out[o + 3] = 0; continue; }
      out[o] = Math.min(255, (sum[s] / c) * 255) | 0;
      out[o + 1] = Math.min(255, (sum[s + 1] / c) * 255) | 0;
      out[o + 2] = Math.min(255, (sum[s + 2] / c) * 255) | 0;
      out[o + 3] = 255;
    }
    this.lut.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ setup */

  enable(apiKey) {
    if (!apiKey) {
      this.o.onStatus?.('error', 'No Google Maps API key set.');
      return false;
    }
    if (!this.tiles) {
      try {
        this._build(apiKey);
      } catch (err) {
        this.o.onStatus?.('error', String(err && err.message ? err.message : err));
        return false;
      }
    }
    this.enabled = true;
    this.root.visible = true;
    this._borrowPixelRatio();
    // Re-open the detail ramp: a layer switched back on is a fresh arrival, and
    // the progress line has to be able to move off whatever it last said.
    this._progress = -1;
    this._done = false;
    this._rampAt = 0;
    this.setDetail();
    this.o.onStatus?.(
      'loading',
      this.softwareRenderer
        ? 'Streaming lighter tiles for this machine…'
        : 'Requesting Google’s mesh…',
    );
    return true;
  }

  /* Rendering at 1x is worth it while a software renderer is drawing Google's
   * tiles, and costs the rest of the application its resolution the moment it is
   * not. So the ratio is borrowed when the layer goes live and handed straight
   * back when it does not: switched off, disposed, or rebuilt onto the other
   * profile. Held once, released once, whichever of those happens first. */
  _borrowPixelRatio() {
    const r = this.o.renderer;
    if (!this.softwareRenderer || !r?.setPixelRatio || this._priorPixelRatio != null) return;
    this._priorPixelRatio = r.getPixelRatio?.() ?? null;
    if (this._priorPixelRatio != null) r.setPixelRatio(this.profile.pixelRatio);
  }

  _returnPixelRatio() {
    if (this._priorPixelRatio == null) return;
    this.o.renderer?.setPixelRatio(this._priorPixelRatio);
    this._priorPixelRatio = null;
  }

  disable() {
    this.enabled = false;
    this.root.visible = false;
    this._returnPixelRatio();
    this.o.onAttribution?.([]);
  }

  /** Tear the tileset down completely, releasing GPU memory and stopping
   *  every in-flight request. A fresh enable() starts a new session, and
   *  therefore a new billable root request, so this is only for a key change. */
  dispose() {
    this._returnPixelRatio();
    if (this.tiles) {
      this.root.remove(this.tiles.group);
      this.tiles.dispose();
      this.tiles = null;
    }
    // The Draco decoder holds web workers. Dropping the TilesRenderer does not
    // reach them, so a CPU/GPU profile switch would otherwise leave a set of
    // idle workers behind for every rebuild.
    this._draco?.dispose();
    this._draco = null;
    this._mats.clear();
    this._creditKey = null;
    this._progress = -1;
    this._done = false;
    this.disable();
  }

  _build(apiKey) {
    const { camera, renderer, meta } = this.o;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({
      apiToken: apiKey,
      // All this actually does in this version is set errorTarget to 20 — the
      // overhead-view figure — and it does it in `init`, so both of our own
      // targets below have to be applied after registration to survive.
      useRecommendedSettings: true,
      autoRefreshToken: true,
    }));

    // Google's tiles are Draco-compressed glTF. Without a decoder every tile
    // parses to nothing and the scene stays silently empty — which reads as
    // "the key is wrong" and sends you debugging the wrong thing.
    //
    // `preload` fetches the wasm decoder now rather than on the first tile. It
    // is a couple of hundred kilobytes from a third-party CDN, and paying for
    // it inside the first parse job stalls the whole parse queue at the exact
    // moment the scene has nothing on screen to show for itself.
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    // Decoding is the binding constraint, so give it the cores the machine
    // actually has, less a couple for the main thread and the compositor. The
    // loader's own default is a flat four, which idles most of a modern
    // desktop and oversubscribes a small laptop.
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    draco.setWorkerLimit(Math.max(2, Math.min(this.softwareRenderer ? 6 : 10, cores - 2)));
    draco.preload();
    this._draco = draco;
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));

    // Re-index attributes to smaller types where possible, and cross-fade LOD
    // transitions rather than popping — a hard pop next to a static data layer
    // reads as the data itself flickering.
    //
    // The fade was once suspected of causing the pale shards over the road at
    // street level, on the theory that parent and child tiles are both drawn
    // translucently mid-transition. Removing it changed the picture not at all,
    // and the reason is now clear: the shards are coarse-LOD photogrammetry of
    // street clutter, and nothing about them could improve while the settings
    // below were preventing the tileset from refining at all.
    tiles.registerPlugin(new TileCompressionPlugin());
    // Cross-fading draws parent and child tile geometry together. It is pleasant
    // on a GPU, but doubles raster work while a software renderer is refining.
    if (!this.softwareRenderer) tiles.registerPlugin(new TilesFadePlugin());

    // Put the AOI centre at the scene origin, at the elevation the flat datum
    // stands for, so our geometry and Google's terrain share a ground plane.
    tiles.registerPlugin(new ReorientationPlugin({
      lat: meta.projection.lat0 * DEG,
      lon: meta.projection.lon0 * DEG,
      height: this._ellipsoidHeight(),
    }));

    /* Screen-space error target, in pixels, and its distance falloff. Google's
     * recommended setting is tuned for a map-like overhead view; at street
     * level it leaves root-level slabs filling the frame, which is far worse
     * here than elsewhere because this scene's whole argument happens between
     * two facades six metres apart.
     *
     * Lowering it asks for finer tiles sooner. That costs bandwidth and nothing
     * else — billing is per session, so a more detailed session is the same
     * single billable event as a coarse one. What it must *not* cost is the
     * near geometry: see ERROR_FALLOFF for why the budget has to be spent by
     * distance rather than spread evenly over the frustum.
     *
     * Both are applied at the foot of this method by `setDetail`, once
     * `this.tiles` exists for it to reach — and after plugin registration, so
     * that `useRecommendedSettings` cannot overwrite them. */

    /* Loading siblings pulls in tiles the frustum does not contain, so that
     * turning the head finds them already there. That is the right trade at
     * altitude, where the visible set changes slowly and a sibling is a
     * neighbouring district. At eye level a sibling is another kilometre of
     * city behind a wall, and fetching it competes with the pavement in front
     * of you for the same queue. Ancestors are still loaded — they are what
     * stands in for a tile while its children are in flight. */
    tiles.loadSiblings = false;

    /* Private queues rather than the library's module-level singletons.
     *
     * `DEFAULT_DOWNLOAD_QUEUE` and `DEFAULT_PARSE_QUEUE` are shared by every
     * TilesRenderer in the page and outlive any one of them, so tuning them in
     * place leaves the settings behind after `dispose()` and silently applies
     * this layer's profile to anything else that ever streams tiles. Owning the
     * queues also means the CPU/GPU profile switch genuinely starts clean. */
    const downloads = new DownloadPriorityQueue();
    downloads.maxJobsPerOrigin = this.profile.downloadsPerOrigin;
    downloads.priorityCallback = unifiedPriorityCallback;
    tiles.downloadQueue = downloads;

    const parses = new PriorityQueue();
    parses.maxJobs = this.profile.parseJobs;
    parses.priorityCallback = unifiedPriorityCallback;
    tiles.parseQueue = parses;

    /* And this layer's own tile cache, for the same reason and sized to the
     * detail being asked for. `DEFAULT_LRU_CACHE` is another module-level
     * singleton, so raising its limits in place would apply them to anything
     * else in the page that ever streams tiles and would outlive `dispose()`.
     * The eviction order is borrowed from the default rather than reinvented:
     * it is what decides that the tile behind you goes before the one in front,
     * and getting it wrong is worse than not tuning the size at all. */
    const cache = new LRUCache();
    cache.unloadPriorityCallback = DEFAULT_LRU_CACHE.unloadPriorityCallback;
    cache.minSize = DEFAULT_LRU_CACHE.minSize;
    cache.maxSize = DEFAULT_LRU_CACHE.maxSize;
    cache.minBytesSize = this.profile.lruBytes.min;
    cache.maxBytesSize = this.profile.lruBytes.max;
    tiles.lruCache = cache;

    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);

    tiles.addEventListener('load-model', ({ scene }) => this._patchMaterials(scene));
    // Materials are patched per streamed model and held in a Set so the look
    // sliders can reach them; without this they accumulate for the life of the
    // session, one entry per tile ever loaded, long after the GPU memory
    // behind them has been released.
    tiles.addEventListener('dispose-model', ({ scene }) => this._forgetMaterials(scene));
    /* The tileset arrived: push the first credits as soon as there is anything
     * to credit.
     *
     * The old code listened for `load-tile-set`, which is not an event this
     * library has ever dispatched — the names are `load-root-tileset` and
     * `load-tileset` — so this handler simply never ran, the status line never
     * left "requesting tiles", and a session streaming perfectly looked exactly
     * like one whose key had been refused. Progress is reported from the frame
     * loop now (see `_pushProgress`), which is a truer signal than any single
     * event: what a viewer wants to know is how much of the city has arrived,
     * not that a manifest parsed. */
    tiles.addEventListener('load-root-tileset', () => this._pushCredits());
    tiles.addEventListener('load-error', (e) => {
      // A 401/403 here is nearly always the key: missing billing, or the Map
      // Tiles API not enabled on the project.
      this.o.onStatus?.('error',
        'Tile request failed — check the key has billing enabled and the Map Tiles API turned on.');
      if (typeof console !== 'undefined') console.warn('[photoreal]', e);
    });

    this.root.add(tiles.group);
    this.tiles = tiles;
    this.setDetail();
  }

  _ellipsoidHeight() {
    return this.o.datumM + GEOID_NAVD88_M + this.nudgeM;
  }

  /* -------------------------------------------------------------- materials */

  /** Desaturate the photogrammetry, and wash the measured field onto the ground.
   *
   * Two jobs, one shader patch.
   *
   * The desaturation is the price of admission. Full-colour photogrammetry is
   * saturated brown and green everywhere, which competes directly with an
   * inferno ramp; pulling it toward grey leaves the only strong colour in frame
   * belonging to the data. That is a legibility decision, not a stylistic one.
   *
   * The field wash paints the FortyGuard 2 m field onto up-facing surfaces near
   * the ground, so the roads and plazas carry the measured layer the way the
   * flat ground plane used to. Restricting it by normal and height is what
   * keeps it off the building flanks and roofs, where a plan-view field would
   * be meaningless.
   */
  _patchMaterials(root) {
    const { fieldTex, fieldRect, data } = this.o;
    if (!this.grid) {
      this.grid = this._buildGrid();
      this.params = this._buildParams();
      this.lut = this._buildLut();
      this.o.onLutReady?.();
    }
    const g = data.meta.massing_grid;

    root.traverse((child) => {
      const mat = child.material;
      if (!mat || mat.userData.prPatched) return;
      mat.userData.prPatched = true;
      /* Anisotropic filtering on the photograph.
       *
       * Every surface that matters at eye level is seen at a grazing angle:
       * the roadway, the pavement, the crossing markings, the kerb. Isotropic
       * mipmapping picks a level from the *worst* axis, so those surfaces
       * collapse into a smeared band a few metres ahead of the walker, which
       * reads as the tiles having failed to refine when in fact they refined
       * perfectly and are being sampled badly. Eight taps is the knee of the
       * cost curve; a software renderer gets one, because there it is the
       * rasteriser and not the sampler that has no headroom. */
      this._setAnisotropy(mat);
      const uniforms = {
        uDesat: { value: this.desaturate },
        uWash: { value: fieldTex ? this.fieldWash : 0 },
        uDataWash: { value: this.grid ? this.dataWash : 0 },
        uField: { value: fieldTex || null },
        uFieldRect: {
          value: new THREE.Vector4(
            fieldRect ? fieldRect.x0 : 0, fieldRect ? fieldRect.y0 : 0,
            fieldRect ? fieldRect.w : 1, fieldRect ? fieldRect.h : 1),
        },
        uGrid: { value: this.grid },
        uGridRect: { value: new THREE.Vector4(g.x0, g.y0, g.res, 0) },
        uGridSize: { value: new THREE.Vector2(g.nx, g.ny) },
        uParams: { value: this.params },
        uLut: { value: this.lut },
        uLutSize: { value: new THREE.Vector2(this.lutW, this.lutH) },
        uNBands: { value: this.nBands },
        uGroundY: { value: this.groundY },
        // Whether the massing rasters exist at all. The cut's column test reads
        // them directly rather than through uDataWash, which the viewer can
        // slide to zero — and a cut that stopped cutting when you turned the
        // tint down would be a baffling thing to debug.
        uHasGrid: { value: this.grid ? 1 : 0 },
        ...(this.o.cut ? this.o.cut.uniforms() : {}),
      };
      mat.userData.uniforms = uniforms;
      this._mats.add(mat);

      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>',
            '#include <common>\nvarying vec3 vWorldPR;')
          .replace('#include <worldpos_vertex>',
            `#include <worldpos_vertex>
             vec4 wpPR = modelMatrix * vec4( transformed, 1.0 );
             vWorldPR = wpPR.xyz;`);

        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>',
            `#include <common>
             varying vec3 vWorldPR;
             uniform float uDesat;
             uniform float uWash;
             uniform float uDataWash;
             uniform sampler2D uField;
             uniform vec4 uFieldRect;
             uniform sampler2D uGrid;
             uniform vec4 uGridRect;
             uniform vec2 uGridSize;
             uniform sampler2D uParams;
             uniform sampler2D uLut;
             uniform vec2 uLutSize;
             uniform float uNBands;
             uniform float uGroundY;
             uniform float uHasGrid;
             ${CUT_GLSL}`)
          /* ---- the cut: inside it, this building is not ours to draw
           *
           * See cut.js for why the two representations are separated rather
           * than blended. Placed at `clipping_planes_fragment`, the first thing
           * in the fragment main, for the same reason the prism side is: a
           * fragment that is about to be thrown away should not first pay for
           * the material's whole texture and lighting chain. It also puts the
           * two halves of the cut in structurally the same place, which is the
           * only way the claim that they are mirror images stays true.
           *
           * The test is a *column* test — is there a modelled building in this
           * vertical column, and is this fragment above its pavement. It
           * deliberately does not use the derivative normal the tint relies on:
           * that normal is noise at coarse LOD, which costs the tint some
           * speckle and would cost a discard a ragged silhouette.
           *
           * Terrain, roadway, vehicles and street trees are never cut. They are
           * the one ground both representations stand on, and swapping them too
           * would put a step at every boundary, because our own ground plane is
           * flat at the datum while this layer stands on real terrain across a
           * 26 m range. */
          .replace('#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
             float cutSd = cutSigned( vWorldPR );
             if ( uCutMode != 0 && cutSd > 0.0 && uHasGrid > 0.5 ) {
               vec2 cCell = floor( vec2(
                 ( vWorldPR.x - uGridRect.x ) / uGridRect.z,
                 ( ( -vWorldPR.z ) - uGridRect.y ) / uGridRect.z ) );
               if ( all( greaterThanEqual( cCell, vec2( 0.0 ) ) ) &&
                    all( lessThan( cCell, uGridSize ) ) ) {
                 vec4 cg = texture2D( uGrid, ( cCell + 0.5 ) / uGridSize );
                 float cb = cg.r * 255.0 + cg.g * 255.0 * 256.0;
                 if ( cb < 65535.0 ) {
                   // Params .r is the building's ground elevation relative to
                   // the scene datum. A 1.5 m sill above it clears the kerb, the
                   // parked cars and the podium grille without ever clipping a
                   // wall we mean to replace.
                   vec4 cp = texture2D( uParams,
                     vec2( 0.5, ( cb + 0.5 ) / uLutSize.y ) );
                   if ( vWorldPR.y > cp.r + 1.5 ) discard;
                 }
               }
             }`)
          .replace('#include <dithering_fragment>',
            `#include <dithering_fragment>
             {
               vec3 c = gl_FragColor.rgb;
               float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

               // Geometric normal from world-position derivatives. Google's
               // photoreal tiles are unlit and ship no normal attribute, so
               // there is nothing to read; the derivative of the interpolated
               // world position is the only normal available.
               vec3 dPRx = dFdx( vWorldPR );
               vec3 dPRy = dFdy( vWorldPR );
               vec3 nPR = cross( dPRx, dPRy );
               float nlen = length( nPR );
               nPR = nlen > 1e-9 ? nPR / nlen : vec3( 0.0, 1.0, 0.0 );
               float horiz = abs( nPR.y );

               // ---- look up the modelled facade field for this fragment
               //
               // Done before anything is altered, because how much of the
               // photograph to keep depends on whether this surface is carrying
               // data at all.
               //
               // This is the whole point of the layer. Rather than drawing our
               // own prisms next to Google's buildings and letting the two
               // shapes fight, the field is looked up per fragment and applied
               // to whatever surface is actually there. The colour therefore
               // lands on real setbacks, real cornices and real towers, and
               // nothing can interpenetrate because there is only one set of
               // geometry in the frame.
               float wall = 1.0 - smoothstep( 0.30, 0.62, horiz );
               vec3 tinted = c;
               float dataAmt = 0.0;
               if ( uDataWash > 0.0 && wall > 0.001 ) {
                 // Two probe depths, shallow first. A shallow probe keeps the
                 // lookup on the right building where footprints are only metres
                 // apart; a deeper one rescues the case where Google's wall sits
                 // well outside ours. Taking the first hit rather than blending
                 // avoids averaging two different buildings into a colour that
                 // belongs to neither.
                 float bidx = 65535.0;
                 float hLocal = 0.0;
                 for ( int probeStep = 0; probeStep < 2; probeStep++ ) {
                   float depth = probeStep == 0 ? 2.5 : 6.0;
                   vec3 probe = vWorldPR - nPR * depth;
                   vec2 cell = floor( vec2(
                     ( probe.x - uGridRect.x ) / uGridRect.z,
                     ( ( -probe.z ) - uGridRect.y ) / uGridRect.z ) );
                   if ( any( lessThan( cell, vec2( 0.0 ) ) ) ||
                        any( greaterThanEqual( cell, uGridSize ) ) ) continue;
                   vec4 gt = texture2D( uGrid, ( cell + 0.5 ) / uGridSize );
                   float b0 = gt.r * 255.0 + gt.g * 255.0 * 256.0;
                   float h0 = ( gt.b * 255.0 + gt.a * 255.0 * 256.0 ) * 0.1;
                   if ( b0 < 65535.0 && h0 > 2.0 ) { bidx = b0; hLocal = h0; break; }
                 }
                 // hLocal is metres of surface above local ground (the raster
                 // stores decimetres; the 0.1 above converts). A 2 m floor
                 // clears kerbs, cars and shrubs without excluding any wall.
                 if ( bidx < 65535.0 && hLocal > 2.0 ) {
                   vec4 bp = texture2D( uParams,
                     vec2( 0.5, ( bidx + 0.5 ) / uLutSize.y ) );
                   float baseRel = bp.r;
                   float hWall = max( bp.g, 1.0 );
                   float rel = ( vWorldPR.y - baseRel ) / hWall;
                   if ( rel > -0.08 && rel < 1.12 ) {
                     float band = clamp( floor( rel * uNBands ), 0.0, uNBands - 1.0 );
                     // Azimuth of the outward normal, degrees clockwise from
                     // north, in the scene frame where -Z is north.
                     float az = degrees( atan( nPR.x, -nPR.z ) );
                     az = mod( az + 360.0, 360.0 );
                     float bucket = floor( mod( az + 22.5, 360.0 ) / 45.0 );
                     float col = bucket * uNBands + band;
                     vec4 heat = texture2D( uLut,
                       vec2( ( col + 0.5 ) / uLutSize.x,
                             ( bidx + 0.5 ) / uLutSize.y ) );
                     // Alpha 0 marks a cell no panel ever contributed to —
                     // a wall orientation this building does not have. Tinting
                     // it would invent data.
                     dataAmt = uDataWash * wall * heat.a;
                     // Restore the surface's own light and shade by modulating
                     // with its luminance. A straight mix() throws that away and
                     // the wall goes flat; keeping it means a window reveal, a
                     // cornice shadow and a sunlit spandrel all still read
                     // through the tint.
                     //
                     // The floor was 0.45 against a gain of 1.6, which put every
                     // luminance below about 0.06 on the same value — and a
                     // masonry facade in canyon shade spends most of its area
                     // down there. So the exact detail a photographic mesh is
                     // brought in to provide was being flattened out again by
                     // the tint that sits on top of it. A lower floor and a
                     // wider gain spend more of the range on the dark end,
                     // where the structure actually is.
                     float shade = clamp( l * 1.9 + 0.24, 0.30, 1.45 );
                     tinted = heat.rgb * shade;
                   }
                 }
               }

               // ---- desaturate, but only where the data is going
               //
               // Pulling the whole frame toward grey is what lets an inferno
               // ramp read against saturated photogrammetry. Applied
               // indiscriminately it also drains the things that are not
               // carrying data, and the worst victims are street trees: Google
               // renders foliage as spiky geometry, and stripped of its green
               // that geometry stops looking like a tree and starts looking
               // like broken glass heaped along the kerb. Weighting the
               // desaturation by how much tint this fragment is about to
               // receive keeps the trees green, the vehicles coloured, and the
               // walls neutral enough for the ramp to dominate.
               float desatW = uDesat * mix( 0.25, 1.0, clamp( dataAmt * 2.0, 0.0, 1.0 ) );

               /* A wall the model has nothing to say about is desaturated as
                * hard as one it does, rather than as softly as a street tree.
                *
                * The weighting above exists to protect foliage and vehicles,
                * and it does that by leaving anything untinted at full colour.
                * That is right for a plane tree and wrong for a tower: a
                * hundred metres of saturated photographic facade standing among
                * tinted neighbours reads as the layer having failed on that
                * building, when what has actually happened is that the model
                * does not cover it. Midtown has real cases — a footprint whose
                * height the city records as a fifth of the building's, so the
                * bands stop a third of the way up and the rest is raw
                * photograph. Neutral says "outside the study"; saturated says
                * "broken", and only one of those is true. */
               float wallNoData = wall * ( 1.0 - clamp( dataAmt * 3.0, 0.0, 1.0 ) );
               desatW = max( desatW, uDesat * wallNoData );

               c = mix( c, vec3( l ), desatW );
               c = mix( c, tinted, dataAmt );

               // ---- the measured field, washed onto roads and plazas
               if ( uWash > 0.0 ) {
                 // Up-facing surfaces take the full wash — they are the road,
                 // the pavement, the plaza. Near-ground surfaces facing
                 // sideways take a reduced share rather than none, so kerbside
                 // clutter that belongs to no building still reads as part of
                 // the street.
                 float up = mix( 0.32, 1.0, smoothstep( 0.55, 0.85, horiz ) );
                 // Height above the *road*, not above the scene datum.
                 //
                 // This read vWorldPR.y directly, which is height above y = 0 —
                 // and y = 0 is the flat datum, not the ground. The photoreal
                 // layer is the one place that distinction bites, because it is
                 // the only place the scene stands on real terrain: Midtown
                 // spans 0-26 m, so the same roadway that took the full wash
                 // downtown took almost none of it on the high ground, and the
                 // measured field simply faded out of the streets as you walked
                 // north. uGroundY carries the local terrain height so the
                 // falloff measures what it always meant to.
                 float low = 1.0 - smoothstep( 6.0, 22.0, vWorldPR.y - uGroundY );
                 vec2 uv = vec2(
                   ( vWorldPR.x - uFieldRect.x ) / uFieldRect.z,
                   ( ( -vWorldPR.z ) - uFieldRect.y ) / uFieldRect.w );
                 if ( all( greaterThanEqual( uv, vec2( 0.0 ) ) ) &&
                      all( lessThanEqual( uv, vec2( 1.0 ) ) ) ) {
                   vec3 f = texture2D( uField, uv ).rgb;
                   c = mix( c, f, uWash * up * low * ( 1.0 - dataAmt ) );
                 }
               }

               /* ---- the boundary, named rather than left to be inferred
                *
                * Drawn on every surviving surface within a feather of the
                * boundary, terrain included, so the lens reads as a pool of
                * light on the street and the section as a line ruled down an
                * avenue. Without it the eye has to work out for itself where
                * one representation stopped and the other began, and at a
                * distance where both are dim that reading is not available. */
               if ( uCutMode != 0 ) {
                 c = mix( c, uCutRim,
                          ( 1.0 - smoothstep( 0.0, uCutFeather, abs( cutSd ) ) ) * 0.7 );
               }

               gl_FragColor.rgb = c;
             }`);
      };
      mat.needsUpdate = true;
    });
  }

  /** Give one streamed material's textures the profile's anisotropy. */
  _setAnisotropy(mat) {
    const max = this.o.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    const want = Math.max(1, Math.min(this.profile.anisotropy, max));
    for (const slot of ['map', 'emissiveMap']) {
      const tex = mat[slot];
      if (tex && tex.anisotropy !== want) {
        tex.anisotropy = want;
        tex.needsUpdate = true;
      }
    }
  }

  /** Drop a streamed model's materials from the look-control set. */
  _forgetMaterials(root) {
    if (!root) return;
    root.traverse((child) => {
      if (child.material) this._mats.delete(child.material);
    });
  }

  /** Tell the shader where the road is, so the street wash falls off from it.
   *
   * One uniform for the whole frame rather than a per-fragment lookup: the term
   * it feeds only matters within twenty metres of the eye, and over that span
   * Midtown's terrain is flat to well under a metre. A ground-elevation texture
   * would be exact and would cost a fetch per fragment to fix nothing visible.
   */
  setGroundY(y) {
    if (!Number.isFinite(y) || Math.abs(y - this.groundY) < 0.05) return;
    this.groundY = y;
    for (const mat of this._mats) {
      const u = mat.userData.uniforms;
      if (u && u.uGroundY) u.uGroundY.value = y;
    }
  }

  /** Live-adjust the two look controls without rebuilding the tileset. */
  setLook({ desaturate, fieldWash, dataWash }) {
    if (desaturate !== undefined) this.desaturate = desaturate;
    if (fieldWash !== undefined) this.fieldWash = fieldWash;
    if (dataWash !== undefined) this.dataWash = dataWash;
    // Iterate the materials we patched rather than the scene graph: tiles are
    // streamed in and out constantly, and a material can be alive in the LRU
    // cache while detached from the group.
    for (const mat of this._mats) {
      const u = mat.userData.uniforms;
      if (!u) continue;
      if (desaturate !== undefined) u.uDesat.value = desaturate;
      if (fieldWash !== undefined) u.uWash.value = fieldWash;
      if (dataWash !== undefined) u.uDataWash.value = dataWash;
    }
  }

  /** Push the cut's state into every material this layer has patched.
   *
   * Same iteration as setLook and for the same reason: tiles stream in and out
   * constantly, and a material can be alive in the LRU cache while detached
   * from the group, so the live set is the authority and the scene graph is
   * not. Materials patched *after* this call pick the state up from
   * `cut.uniforms()` at patch time, which is why that path exists.
   */
  setCut(cut) {
    for (const mat of this._mats) {
      const u = mat.userData.uniforms;
      if (u) cut.writeTo(u);
    }
  }

  /** Apply the detail settings and re-open the ramp at its ceiling.
   *
   * This took a mode argument — `orbit` or `street` — because a pedestrian and
   * a map want genuinely different budgets. There is one camera now, so what
   * remains is the reset: put the target back at the known-good ceiling and let
   * the ramp walk it down to the floor as tiles land.
   */
  setDetail() {
    if (!this.tiles) return;
    const { fraction, density } = this.profile.errorFalloff;
    this.tiles.errorFalloff = this.profile.errorTarget * fraction;
    this.tiles.errorFalloffDensity = density;
    this._et = RAMP.ceiling;
    this.tiles.errorTarget = this._et;
  }

  /** Walk the live error target down toward the profile's floor, one way only.
   *
   * Time-based rather than frame-based, so a machine drawing four frames a
   * second refines at the same rate as one drawing sixty — the tile pipeline is
   * bound by network and decoding, not by how often we ask.
   *
   * `loadProgress` is used only as a "is a batch still in flight" gate, which
   * is the one thing it reliably reports. See RAMP for why it cannot be read as
   * a fraction of the city and what happened when it was.
   */
  _rampDetail(nowMs) {
    const t = this.tiles;
    if (!t) return;
    const dt = this._rampAt ? Math.min(0.5, (nowMs - this._rampAt) / 1000) : 0;
    this._rampAt = nowMs;
    if (dt <= 0) return;

    /* Queue depth was the first signal tried here and is also wrong: it dips to
     * nothing every time a wave of downloads finishes and before the next is
     * requested, which reads as "keeping up" when nothing of the sort is true.
     * `loadProgress` at least goes to 1 only when the queues are genuinely
     * empty, which is all this gate needs of it. */
    const progress = Math.max(0, Math.min(1, t.loadProgress));
    const floor = this.profile.errorTarget;

    if (progress > RAMP.tightenAbove && this._et > floor) {
      this._et = Math.max(floor, this._et * (1 - RAMP.perSecond * dt));
      t.errorTarget = this._et;
    }
  }

  /** Report how much of what the eye has asked for has actually arrived.
   *
   * `loadProgress` is the library's own measure and it is the only honest
   * answer to "is this working". The layer used to say nothing at all after
   * "requesting tiles", because it was waiting on an event name that does not
   * exist, so a session that was streaming perfectly and one whose key had been
   * refused looked identical from the panel.
   */
  _pushProgress() {
    const t = this.tiles;
    if (!t) return;
    const p = Math.round(Math.max(0, Math.min(1, t.loadProgress)) * 100);
    /* Settle on "ready" only once the queues are genuinely empty, not merely
     * once the percentage rounds to a hundred — and watch that emptiness as
     * well as the number, because the last few tiles land while the figure is
     * already reading 100. Keying the change detection on the percentage alone
     * left the panel saying "Streaming — 100%" for the rest of the session. */
    const done = p >= 100 && !t.downloadQueue.running && !t.parseQueue.running;
    if (p === this._progress && done === this._done) return;
    this._progress = p;
    this._done = done;
    if (done) {
      this.o.onStatus?.('ready', '');
    } else {
      this.o.onStatus?.('loading', this.softwareRenderer
        ? `Streaming lighter tiles for this machine — ${p}%`
        : `Streaming Google’s mesh — ${p}%`);
    }
  }

  /** Vertical nudge, metres. Dials out the residual geoid/datum mismatch. */
  setNudge(m) {
    this.nudgeM = m;
    if (!this.tiles) return;
    const plugin = this.tiles.plugins.find((p) => p instanceof ReorientationPlugin);
    if (plugin) {
      plugin.height = this._ellipsoidHeight();
      plugin.transformLatLonHeightToOrigin(
        this.o.meta.projection.lat0 * DEG,
        this.o.meta.projection.lon0 * DEG,
        plugin.height,
      );
    }
  }

  /* ----------------------------------------------------------------- frame */

  update() {
    if (!this.enabled || !this.tiles) return;
    // The camera's world matrix must be current before the tileset reads it.
    // scene.tick() positions the camera with position.copy() and lookAt(), and
    // neither updates matrixWorld — three.js does that inside render(), which
    // runs *after* this. Without the explicit update the tileset selects tiles
    // against last frame's viewpoint, which at walking speed means it is always
    // refining where the eye just was.
    this.o.camera.updateMatrixWorld();
    this.tiles.setResolutionFromRenderer(this.o.camera, this.o.renderer);
    this.tiles.update();

    /* Everything below is bookkeeping, and none of it needs to run at frame
     * rate: the detail ramp is deliberately time-based, the progress line is
     * unreadable if it changes sixty times a second, and rebuilding the credit
     * string every frame allocates an array and a join per frame for a value
     * that changes a handful of times a session. */
    const now = performance.now();
    if (now - this._creditsAt > 400) {
      this._creditsAt = now;
      this.setGroundY(this.o.groundYAt?.(this.o.camera.position.x, this.o.camera.position.z) ?? 0);
      this._rampDetail(now);
      this._pushCredits();
      this._pushProgress();
    }
  }

  _pushCredits() {
    if (!this.tiles) return;
    let list = [];
    try {
      const raw = this.tiles.getAttributions() || [];
      list = raw.map((a) => (typeof a === 'string' ? a : a && a.value))
        .filter((v) => typeof v === 'string' && v.length);
    } catch (e) {
      list = [];
    }
    // Only notify on change; this runs every frame.
    const key = list.join('|');
    if (key !== this._creditKey) {
      this._creditKey = key;
      this.o.onAttribution?.(list);
    }
  }
}

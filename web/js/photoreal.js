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

import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import {
  GLTFExtensionsPlugin, TileCompressionPlugin, TilesFadePlugin, ReorientationPlugin,
} from '3d-tiles-renderer/three/plugins';

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

/* Screen-space error target, in pixels, per camera mode.
 *
 * Google's recommended value is tuned for a map-like overhead view. It is far
 * too loose for a pedestrian: at street level the whole frame is near geometry,
 * and a loose target leaves root-level slabs standing where the road should be.
 * Asking for more detail costs bandwidth and nothing else — billing is per
 * session, so a detailed session is the same single billable event as a coarse
 * one. */
const ERROR_TARGET = { orbit: 12, street: 5 };

/* Google Photorealistic Tiles are designed for a hardware WebGL renderer. A
 * software renderer (SwiftShader, WARP, llvmpipe, etc.) can still show the
 * layer, but asking it to decode, blend and rasterise the same dense tile set
 * makes the browser spend its time on partial LODs. Those partial LODs are the
 * faceted shards that look like broken geometry. Keep the real mesh, but use a
 * bounded context-quality profile that a CPU can finish drawing. */
const SOFTWARE_PROFILE = {
  errorTarget: { orbit: 20, street: 12 },
  downloadJobs: 3,
  parseJobs: 1,
  pixelRatio: 1,
};
const HARDWARE_PROFILE = {
  errorTarget: ERROR_TARGET,
  downloadJobs: 12,
  parseJobs: 4,
  pixelRatio: null,
};

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
    const r = await fetch('./api/config', { cache: 'no-store' });
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
    if (this.softwareRenderer) o.renderer.setPixelRatio(this.profile.pixelRatio);
    this.tiles = null;
    this.enabled = false;
    this.nudgeM = 0;
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
    this.o.onStatus?.(
      'loading',
      this.softwareRenderer
        ? 'software WebGL: loading efficient context tiles'
        : 'requesting tiles',
    );
    return true;
  }

  disable() {
    this.enabled = false;
    this.root.visible = false;
    this.o.onAttribution?.([]);
  }

  /** Tear the tileset down completely, releasing GPU memory and stopping
   *  every in-flight request. A fresh enable() starts a new session, and
   *  therefore a new billable root request, so this is only for a key change. */
  dispose() {
    if (this.tiles) {
      this.root.remove(this.tiles.group);
      this.tiles.dispose();
      this.tiles = null;
    }
    this.disable();
  }

  _build(apiKey) {
    const { camera, renderer, meta } = this.o;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({
      apiToken: apiKey,
      // Google's own recommended renderer settings for this dataset; without
      // them the error target is far too tight and the tile count explodes.
      useRecommendedSettings: true,
      autoRefreshToken: true,
    }));

    // Google's tiles are Draco-compressed glTF. Without a decoder every tile
    // parses to nothing and the scene stays silently empty — which reads as
    // "the key is wrong" and sends you debugging the wrong thing.
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));

    // Re-index attributes to smaller types where possible, and cross-fade LOD
    // transitions rather than popping — a hard pop next to a static data layer
    // reads as the data itself flickering.
    //
    // The fade was suspected of causing the pale shards that hang over the road
    // at street level, on the theory that parent and child tiles are both drawn
    // translucently mid-transition. Removing it changed the picture not at all,
    // so that was wrong: the shards are coarse-LOD photogrammetry of street
    // clutter, and they resolve as the tileset refines.
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

    /* Screen-space error target, in pixels. Google's recommended setting is
     * tuned for a map-like overhead view; at street level it leaves root-level
     * slabs filling the frame, which is far worse here than elsewhere because
     * this scene's whole argument happens between two facades six metres apart.
     *
     * Lowering it asks for finer tiles sooner. That costs bandwidth and nothing
     * else — billing is per session, so a more detailed session is the same
     * single billable event as a coarse one. Set after the plugin so it wins
     * over useRecommendedSettings. */
    tiles.errorTarget = this.profile.errorTarget.orbit;

    // Refinement is the binding constraint at street level, so let more of it
    // happen at once. The defaults are tuned for an overhead view where the
    // visible set changes slowly; standing in a canyon, almost every tile in
    // frame is near and wants depth, and a shallow queue means the block you are
    // standing in stays an unrefined blob with no streets carved out of it —
    // which looks, from inside, like being sealed in a dark box.
    if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = this.profile.downloadJobs;
    if (tiles.parseQueue) tiles.parseQueue.maxJobs = this.profile.parseJobs;

    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);

    tiles.addEventListener('load-model', ({ scene }) => this._patchMaterials(scene));
    tiles.addEventListener('load-tile-set', () => {
      this.o.onStatus?.('ready', '');
      this._pushCredits();
    });
    tiles.addEventListener('load-error', (e) => {
      // A 401/403 here is nearly always the key: missing billing, or the Map
      // Tiles API not enabled on the project.
      this.o.onStatus?.('error',
        'Tile request failed — check the key has billing enabled and the Map Tiles API turned on.');
      if (typeof console !== 'undefined') console.warn('[photoreal]', e);
    });

    this.root.add(tiles.group);
    this.tiles = tiles;
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
             uniform float uNBands;`)
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
                     float shade = clamp( l * 1.6 + 0.35, 0.45, 1.35 );
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
                 float low = 1.0 - smoothstep( 6.0, 22.0, vWorldPR.y );
                 vec2 uv = vec2(
                   ( vWorldPR.x - uFieldRect.x ) / uFieldRect.z,
                   ( ( -vWorldPR.z ) - uFieldRect.y ) / uFieldRect.w );
                 if ( all( greaterThanEqual( uv, vec2( 0.0 ) ) ) &&
                      all( lessThanEqual( uv, vec2( 1.0 ) ) ) ) {
                   vec3 f = texture2D( uField, uv ).rgb;
                   c = mix( c, f, uWash * up * low * ( 1.0 - dataAmt ) );
                 }
               }

               gl_FragColor.rgb = c;
             }`);
      };
      mat.needsUpdate = true;
    });
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

  /** Ask for more or less detail, according to how close the eye is.
   *
   * Kept as two named values rather than a continuous function of altitude
   * because the two cases are genuinely different: an overhead view wants
   * breadth and a pedestrian wants depth, and interpolating between them just
   * means never being right for either. */
  setDetail(mode) {
    if (!this.tiles) return;
    this.tiles.errorTarget = this.profile.errorTarget[mode]
      ?? this.profile.errorTarget.orbit;
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

  /** World Y of Google's own ground surface beneath a point, or null.
   *
   * Every other way of placing the walker is an estimate stacked on an
   * estimate: the footprint table's ground elevation, plus a single global
   * geoid constant, against terrain that varies continuously. Errors of a
   * couple of metres are enough to bury the eye in a roadbed or float it above
   * one, and no amount of care in the constants fixes the general case.
   *
   * Asking the geometry is exact by construction. This is ordinary runtime
   * collision — the same thing every 3D-tiles walker does to stand on a
   * surface — not an extraction of geometry into anything that outlives the
   * frame.
   */
  groundAt(x, z, fromY = 400) {
    if (!this.tiles || !this.enabled) return null;
    if (!this._ray) {
      this._ray = new THREE.Raycaster();
      this._ray.far = 1200;
      this._down = new THREE.Vector3(0, -1, 0);
      this._origin = new THREE.Vector3();
    }
    this._origin.set(x, fromY, z);
    this._ray.set(this._origin, this._down);
    const hits = this._ray.intersectObject(this.tiles.group, true);
    if (!hits.length) return null;
    // Highest surface below the probe start: the roadbed rather than a basement
    // face or the underside of an overpass.
    return hits[0].point.y;
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
    this._pushCredits();
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

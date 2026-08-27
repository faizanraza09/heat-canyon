/* The 3D scene.
 *
 * Why three.js rather than deck.gl or MapLibre fill-extrusion: this project's
 * whole point is that temperature varies *across a single facade* — up its
 * height and by which way it faces. Both deck.gl's extruded polygon layers and
 * MapLibre's fill-extrusion assign one colour per building, and MapLibre's
 * `fill-extrusion-vertical-gradient` is a fixed shading darkening, not a
 * data-driven ramp. Getting a real per-band, per-orientation field out of either
 * means injecting custom GLSL into someone else's shader.
 *
 * Building the facade geometry directly as coloured triangles removes that
 * fight entirely: every band of every wall is its own quad with its own vertex
 * colours, so the vertical structure the physics computed is exactly what gets
 * drawn. The cost is having to supply our own basemap, which is fine here —
 * a photographic basemap would fight the data for attention anyway.
 *
 * Coordinates: the pipeline exports a local east-north-up frame in metres. Map
 * it to three.js's Y-up convention as (east, up, -north).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RAMPS, norm } from './colors.js';

/** Contrast curve, indexed 0-255. A smoothstep-weighted lift: dark values fall
 *  away faster, bright values are left nearly alone, nothing clips. Built once
 *  because it is applied to every one of ~700,000 vertices on every recolour. */
const CONTRAST = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const sm = x * x * (3 - 2 * x);
    t[i] = Math.min(1, (x * 0.40 + sm * 0.60) * 1.05);
  }
  return t;
})();

/** Table index for a 0..1 value, clamped so an over-bright input cannot run off
 *  the end of the curve. */
const curve = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0);

export class Scene {
  constructor(canvas, data) {
    this.data = data;
    this.canvas = canvas;
    this.hour = data.meta.peak_index;
    this.layer = 'surface';
    this.selected = null;
    this.mode = 'orbit';
    this.viewpointIndex = 0;

    this._initRenderer();
    this._initScene();
    this._buildGround();
    this._buildFacades();
    this._buildRoofs();
    this._initCameras();
    this._initPicking();

    // Colour domains must exist before the first recolour. The scene derives
    // its own defaults from the data so it is valid the moment it is
    // constructed; setDomains() can still override them afterwards. Depending
    // on an external call ordering here was a real bug — the constructor
    // recolours, so a domain set later arrives too late.
    this._defaultDomains();
    this.setHour(this.hour);
    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  // ------------------------------------------------------------- plumbing

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x07090d, 1);
    // Shadows come from the data, not from a shadow map: the pipeline already
    // ray-traced them through the same surface model the physics used, which is
    // both exact and free at render time.
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping, deliberately. ACES was tried here and made things
    // markedly worse: it expects linear HDR input, whereas these vertex colours
    // come straight from a display-space colour ramp, so it lifted and
    // desaturated the whole scene into pale pastel and cancelled the ambient
    // occlusion it was meant to complement. Contrast is shaped in the colour
    // computation instead, where it applies to the data rather than the frame.
    this.renderer.toneMapping = THREE.NoToneMapping;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    // Fog does real work here: at street level it stops the far side of
    // Midtown reading as a wall of noise, and it gives depth cues that a flat
    // unlit colour field otherwise lacks.
    this.scene.fog = new THREE.Fog(0x07090d, 1400, 4800);

    // No lights. Every mesh that carries data uses MeshBasicMaterial with
    // vertex colours, so scene lighting would have nothing to act on — the
    // depth cues come from baked shading and from fog instead.
    this._buildSky();
  }

  /** A large inward-facing sphere carrying a vertical gradient.
   *
   * A flat black clear colour made the skyline look cut out with scissors.
   * Real air has depth; a horizon that lifts slightly toward a warm haze gives
   * the buildings something to sit against and reads as atmosphere.
   */
  _buildSky() {
    const geo = new THREE.SphereGeometry(9000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x05070b) },
        horizon: { value: new THREE.Color(0x1a1a24) },
        glow: { value: new THREE.Color(0x2e2422) },
      },
      vertexShader: `
        varying float vH;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vH = normalize(world.xyz).y;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 glow;
        varying float vH;
        void main() {
          float h = clamp(vH, -1.0, 1.0);
          // Warm band hugging the horizon, cooling upward into near-black.
          vec3 c = mix(horizon, top, smoothstep(0.0, 0.55, h));
          c = mix(c, glow, smoothstep(0.10, -0.05, h) * 0.6);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  // ---------------------------------------------------------------- ground

  _buildGround() {
    const meta = this.data.meta;
    const w = meta.aoi.width_m, h = meta.aoi.height_m;
    const pad = 600;

    // Backdrop plane, so the city does not float in a void.
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(w + pad * 4, h + pad * 4),
      new THREE.MeshBasicMaterial({ color: 0x0a0d13 })
    );
    back.rotation.x = -Math.PI / 2;
    back.position.y = -0.8;
    this.scene.add(back);

    // The FortyGuard 2 m field, painted onto the ground as a texture. This is
    // the measured layer, and it is drawn *under* the modelled facades so the
    // two are never visually confused.
    this.groundCanvas = document.createElement('canvas');
    this.groundCanvas.width = 2048;
    this.groundCanvas.height = 2048;
    this.groundTex = new THREE.CanvasTexture(this.groundCanvas);
    this.groundTex.colorSpace = THREE.SRGBColorSpace;
    // Mipmapping and anisotropy are both essential here, and leaving them off
    // was a real bug: a single 2 km plane viewed at a grazing angle undersamples
    // its own texture badly, and with plain LinearFilter (which suppresses
    // mipmaps) that aliasing appeared as long bright streaks shooting across the
    // city, which read exactly like broken geometry. Trilinear filtering plus
    // the driver's maximum anisotropy removes it completely.
    this.groundTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.groundTex.magFilter = THREE.LinearFilter;
    this.groundTex.generateMipmaps = true;
    this.groundTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // Deliberately semi-transparent over the dark backdrop: the ground carries
    // the measured 2 m field, but the facades carry the finding, and a fully
    // opaque ground at peak hour drowns them.
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: this.groundTex, transparent: true, opacity: 0.62 })
    );
    g.rotation.x = -Math.PI / 2;
    g.position.y = -0.25;
    this.scene.add(g);
    this.ground = g;

    // Street centre lines, drawn as thin bright lines. They read as a street
    // map and make the canyon structure legible from above.
    const pts = [];
    for (const c of this.data.canyons) {
      const a = (c.bearing * Math.PI) / 180;
      const dx = Math.sin(a) * 11, dy = Math.cos(a) * 11;
      pts.push(c.x - dx, 0.15, -(c.y - dy), c.x + dx, 0.15, -(c.y + dy));
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.streets = new THREE.LineSegments(
      lg, new THREE.LineBasicMaterial({ color: 0x2c3547, transparent: true, opacity: 0.85 })
    );
    this.scene.add(this.streets);
  }

  _paintGround() {
    const { tiles, meta } = this.data;
    const ctx = this.groundCanvas.getContext('2d');
    const W = this.groundCanvas.width, H = this.groundCanvas.height;
    ctx.clearRect(0, 0, W, H);

    const layer = this.groundLayer || 'exceedance';
    let pts, dom, rampName;
    if (layer === 'persistence') {
      pts = tiles.persistence;
      const s = tiles.stats.persistence;
      dom = [s.min, s.max]; rampName = 'duration';
    } else if (layer === 'air') {
      // Air temperature across the AOI spans only about 1-2.6 K at any one
      // hour. Painted against the whole-day domain it saturates to a single
      // flat colour, which hides the very spatial pattern a 60 m grid exists to
      // show. So this layer alone is contrast-stretched to the hour's own
      // range, and the interface says so wherever it is selected. Absolute
      // values stay available in the scrubber readout and on hover.
      pts = tiles.air[this.hour];
      const st = tiles.stats.air[this.hour];
      dom = st ? [st.p10, st.p90] : this.airDomain;
      rampName = 'temperature';
    } else {
      pts = tiles.exceedance;
      const s = tiles.stats.exceedance;
      dom = [s.min, s.max]; rampName = 'duration';
    }
    this.groundDomain = dom;
    this.groundRamp = rampName;
    const f = RAMPS[rampName];

    const aw = meta.aoi.width_m, ah = meta.aoi.height_m;
    // Slight overlap between neighbouring tiles so the 60 m lattice reads as a
    // continuous field rather than a grid of separated squares.
    const cell = (tiles.grid_m / aw) * W * 1.08;
    for (const [x, y, v] of pts) {
      // Local metres -> texture pixels. The plane's UV origin is bottom-left
      // in world terms, which after the -PI/2 rotation means +y maps upward.
      const px = ((x + aw / 2) / aw) * W;
      const py = H - ((y + ah / 2) / ah) * H;
      const c = f(norm(v, dom[0], dom[1]));
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.95)`;
      ctx.fillRect(px - cell / 2, py - cell / 2, cell, cell);
    }

    // Cast building shadows, from the ray-traced masks the pipeline exported.
    // This is the single largest realism gain available here: the 60 m
    // temperature lattice is far too coarse to look like a street, whereas the
    // 6 m shadow mask draws the actual pattern of towers falling across the
    // ground at this hour. It is the same geometry that decided which facade
    // bands are sunlit, so none of it is decorative.
    const sg = meta.shadow_grid;
    if (sg && this.data.groundSun && this.data.meta.hours[this.hour].sun_alt > 0) {
      const sw = (sg.res / aw) * W + 1;
      ctx.fillStyle = 'rgba(4,5,9,0.44)';
      for (let i = 0; i < sg.ny; i++) {
        const wy = sg.y0 + (i + 0.5) * sg.res;
        const py2 = H - ((wy + ah / 2) / ah) * H;
        if (py2 < -sw || py2 > H + sw) continue;
        // Merge contiguous shaded cells into one rectangle per run: far fewer
        // fill calls than one per cell, and no visible seams between them.
        let runStart = -1;
        for (let j = 0; j <= sg.nx; j++) {
          const shaded = j < sg.nx
            && !this.data.groundSunAt(this.hour, sg.x0 + (j + 0.5) * sg.res, wy);
          if (shaded && runStart < 0) runStart = j;
          if (!shaded && runStart >= 0) {
            const pxa = ((sg.x0 + runStart * sg.res + aw / 2) / aw) * W;
            const pxb = ((sg.x0 + j * sg.res + aw / 2) / aw) * W;
            ctx.fillRect(pxa, py2 - sw / 2, Math.max(pxb - pxa, 1), sw);
            runStart = -1;
          }
        }
      }
    }

    // Repainting the canvas invalidates the mipmap chain as well as the base
    // level, so both have to be re-uploaded.
    this.groundTex.needsUpdate = true;
    this.groundTex.generateMipmaps = true;
  }

  // --------------------------------------------------------------- facades

  _buildFacades() {
    const { facades, buildings, dims } = this.data;
    const nPan = facades.n, nBand = facades.bands;
    const xy = facades.xy, base = facades.base, top = facades.top;

    const nQuad = nPan * nBand;
    const pos = new Float32Array(nQuad * 4 * 3);
    const col = new Float32Array(nQuad * 4 * 3);
    const idx = new Uint32Array(nQuad * 6);
    // Per-vertex panel and band index, so picking and recolouring can go
    // straight from a vertex back to the physics cell it came from.
    this.quadPanel = new Int32Array(nQuad);
    this.quadBand = new Uint8Array(nQuad);
    this.quadBuilding = new Int32Array(nQuad);

    let q = 0;
    for (let p = 0; p < nPan; p++) {
      const x0 = xy[p * 4], y0 = xy[p * 4 + 1];
      const x1 = xy[p * 4 + 2], y1 = xy[p * 4 + 3];
      // Render on a flat datum: walls run from 0 to their height above their own
      // local ground, not from their NAVD88 ground elevation.
      //
      // This matters. Midtown's terrain sits 0-26 m above the datum, so drawing
      // each building from its absolute base left 98% of the city floating a
      // median 13 m above the ground plane — and the bright measured field
      // painted on that plane showed through the gap as streaks along every
      // street. There is no terrain mesh here, and every quantity the physics
      // computes is a height above local ground, so a flat datum is both the
      // honest choice and the consistent one. The absolute elevation is kept in
      // the data for anyone who needs it.
      const hh = Math.max(top[p] - base[p], 0.5);
      const zb = 0;
      const bi = facades.building[p];
      for (let b = 0; b < nBand; b++) {
        const za = zb + (hh * b) / nBand;
        const zc = zb + (hh * (b + 1)) / nBand;
        const o = q * 12;
        // Quad corners: bottom-left, bottom-right, top-right, top-left.
        pos[o + 0] = x0; pos[o + 1] = za; pos[o + 2] = -y0;
        pos[o + 3] = x1; pos[o + 4] = za; pos[o + 5] = -y1;
        pos[o + 6] = x1; pos[o + 7] = zc; pos[o + 8] = -y1;
        pos[o + 9] = x0; pos[o + 10] = zc; pos[o + 11] = -y0;
        const v = q * 4, e = q * 6;
        idx[e] = v; idx[e + 1] = v + 1; idx[e + 2] = v + 2;
        idx[e + 3] = v; idx[e + 4] = v + 2; idx[e + 5] = v + 3;
        this.quadPanel[q] = p;
        this.quadBand[q] = b;
        this.quadBuilding[q] = bi;
        q++;
      }
    }

    // Ambient occlusion, from the sky view factor the physics already computed
    // for every band. This replaced a fixed "notional light from the
    // north-west", which lit every wall in the city identically regardless of
    // how enclosed it was, and was the main reason the scene read as flat
    // cardboard. A band deep in a canyon genuinely receives very little diffuse
    // light, and drawing that is both more truthful and far more legible,
    // because it is what makes a canyon look deep.
    //
    // Wall SVF runs 0 to 0.5, so it is normalised against 0.5 first. The floor
    // of 0.26 keeps the deepest bands readable rather than crushed to black,
    // and the exponent is there because perceived brightness does not track
    // irradiance linearly.
    this.quadAO = new Float32Array(nQuad);
    this.quadNX = new Float32Array(nQuad);
    this.quadNZ = new Float32Array(nQuad);
    for (let q = 0; q < nQuad; q++) {
      const p = this.quadPanel[q], b = this.quadBand[q];
      const svf = Math.min(1, this.data.svfAt(p, b) / 0.5);
      // The floor is a bounce term, not a fudge. A wall that sees almost no sky
      // still receives light reflected from the road and the facade opposite,
      // which is why a real deep canyon is dim rather than pitch black. Without
      // it the deepest canyons rendered as unreadable murk.
      this.quadAO[q] = 0.34 + 0.66 * Math.pow(svf, 0.58);
      const a = (facades.az[p] * Math.PI) / 180;
      this.quadNX[q] = Math.sin(a);
      this.quadNZ[q] = -Math.cos(a);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // MeshBasicMaterial, not Lambert: on this mesh the colour *is* the
    // measurement, and letting a light source multiply it would mean a facade's
    // apparent temperature depended on which way the camera was facing. Form
    // instead comes from a fixed shading factor baked into the vertex colours
    // per panel orientation (see _shadeFor), which is constant per surface and
    // therefore cannot be mistaken for data.
    this.facadeMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    }));
    this.scene.add(this.facadeMesh);
    this.facadeColors = geo.getAttribute('color');
    this.nQuad = nQuad;
  }

  // ----------------------------------------------------------------- roofs

  _buildRoofs() {
    const { buildings } = this.data;
    const rings = buildings.rings, attrs = buildings.attrs;
    const pos = [], col = [], idx = [];
    this.roofVertBuilding = [];
    let vbase = 0;
    this.roofRange = [];

    for (let i = 0; i < rings.length; i++) {
      const flat = rings[i];
      const n = flat.length / 2;
      if (n < 3) { this.roofRange.push([vbase, 0]); continue; }
      const contour = [];
      for (let k = 0; k < n; k++) contour.push(new THREE.Vector2(flat[k * 2], flat[k * 2 + 1]));

      // Pass a COPY. THREE.ShapeUtils.triangulateShape mutates the array it is
      // given — it pops a duplicate end point when the first and last vertices
      // coincide — and that mutation was the source of a genuinely nasty bug:
      // the loop pushed contour.length vertices but advanced the write cursor
      // by the original n, so from the first affected footprint onward every
      // building's indices pointed into a neighbour's vertices. The result was
      // roof triangles with edges up to 3 km, spanning the whole study area and
      // slicing across the city as bright streaks that looked for all the world
      // like a data problem rather than an off-by-one.
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour.slice(), []); }
      catch (e) { tris = []; }

      // Flat datum, matching the facades — see the note in _buildFacades.
      const zt = attrs[i].h;
      const start = vbase;
      for (const v of contour) {
        pos.push(v.x, zt, -v.y);
        col.push(0, 0, 0);
        this.roofVertBuilding.push(i);
      }
      const count = contour.length;
      for (const t of tris) {
        // Belt and braces: never emit an index outside this footprint's own
        // vertices, so a future change to the triangulator cannot silently
        // reintroduce cross-building geometry.
        if (t[0] >= count || t[1] >= count || t[2] >= count) continue;
        idx.push(start + t[0], start + t[2], start + t[1]);
      }
      vbase += count;
      this.roofRange.push([start, count]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.roofMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    }));
    this.scene.add(this.roofMesh);
    this.roofColors = geo.getAttribute('color');
  }

  // --------------------------------------------------------------- cameras

  _initCameras() {
    const aspect = window.innerWidth / window.innerHeight;
    // A tight near plane matters at street level; a far plane of 12 km is
    // plenty and keeps depth precision comfortable across the city.
    this.camera = new THREE.PerspectiveCamera(46, aspect, 0.8, 14000);
    // Start outside and above the study area looking north-east across it, so
    // the first frame reads as a city rather than as the inside of one building.
    // The default used to sit among the towers, which put 70 m facade panels
    // right against the near plane and looked like abstract sheets.
    this.camera.position.set(-1500, 1250, 1750);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.015;  // never go under the ground
    this.controls.minDistance = 30;
    this.controls.maxDistance = 6000;
    this.controls.target.set(0, 40, 0);

    // First-person street walker.
    this.fp = {
      pos: new THREE.Vector3(0, 1.7, 0),
      yaw: 0, pitch: 0,
      keys: new Set(),
      speed: 11,   // brisk walking pace; Shift for a jog
    };
    this._initFirstPerson();
  }

  _initFirstPerson() {
    const el = this.renderer.domElement;

    // Never steal keystrokes from a form field. Without this guard, typing a
    // question into the analyst box both drove the camera and lost characters
    // to preventDefault — "why is west 47th street so warm" arrived as
    // "hyiet47thtreetorm".
    const typing = () => {
      const a = document.activeElement;
      if (!a) return false;
      const tag = a.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || a.isContentEditable;
    };

    const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft'];
    window.addEventListener('keydown', (e) => {
      if (this.mode !== 'street' || typing()) return;
      this.fp.keys.add(e.code);
      if (MOVE_KEYS.includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.fp.keys.delete(e.code));
    // Losing focus must not leave a key stuck down.
    window.addEventListener('blur', () => this.fp.keys.clear());

    el.addEventListener('mousemove', (e) => {
      if (this.mode !== 'street' || !this._dragging) return;
      // Yaw must INCREASE when the pointer moves right. Forward is
      // (sin yaw, 0, -cos yaw), so a growing yaw swings the view clockwise,
      // which is what dragging right should do. The original subtracted here
      // and turned the view the wrong way, which is a large part of why the
      // street view felt broken.
      this.fp.yaw += e.movementX * 0.0028;
      this.fp.pitch = Math.max(-1.3, Math.min(1.3, this.fp.pitch - e.movementY * 0.0028));
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) this._dragging = true;
    });
    window.addEventListener('mouseup', () => { this._dragging = false; });

    // Scroll should do something in street mode too. With OrbitControls
    // disabled the wheel was simply inert, which reads as a broken control, so
    // it dollies the walker along the view direction.
    el.addEventListener('wheel', (e) => {
      if (this.mode !== 'street') return;
      e.preventDefault();
      const step = -Math.sign(e.deltaY) * 6.0;
      const fwd = new THREE.Vector3(Math.sin(this.fp.yaw), 0, -Math.cos(this.fp.yaw));
      this._tryMove(fwd, step);
    }, { passive: false });
  }

  /** Move the walker if the destination is not inside a building.
   *
   * Collision is a lookup against the coarse height grid the pipeline exports
   * from the same surface model the physics used. Without it the walker strolled
   * straight through a 109 m tower, which makes the street view feel like a
   * rendering rather than a place.
   */
  _tryMove(dir, dist) {
    const f = this.fp;
    const R = 1.4;                      // shoulder clearance, metres
    const nx = f.pos.x + dir.x * dist;
    const nz = f.pos.z + dir.z * dist;
    const blocked = (x, z) => this.data.heightAt(x, -z) > f.pos.y + 0.4;

    // Try the full move, then each axis alone, so sliding along a wall works
    // instead of stopping dead.
    if (!blocked(nx + Math.sign(dir.x) * R, nz + Math.sign(dir.z) * R)
        && !blocked(nx, nz)) {
      f.pos.x = nx; f.pos.z = nz;
      return;
    }
    if (!blocked(nx + Math.sign(dir.x) * R, f.pos.z)) f.pos.x = nx;
    if (!blocked(f.pos.x, nz + Math.sign(dir.z) * R)) f.pos.z = nz;
  }

  setMode(mode, at) {
    this.mode = mode;
    if (mode === 'street') {
      this.controls.enabled = false;
      const p = at || this._findStreetPoint();
      this.fp.pos.set(p.x, 1.7, -p.y);
      this.fp.yaw = ((p.bearing || 0) * Math.PI) / 180;
      // A pedestrian looking down a canyon naturally takes in the facades above
      // as well as the pavement ahead, and a dead-level view of a 90 m wall
      // reads as a flat wash. A slight upward tilt shows the vertical structure
      // the model exists to resolve.
      this.fp.pitch = 0.16;
      this.scene.fog.near = 40; this.scene.fog.far = 1100;
    } else {
      this.controls.enabled = true;
      this.scene.fog.near = 1400; this.scene.fog.far = 4800;
      if (at) this.controls.target.set(at.x, Math.min(at.h || 40, 120), -at.y);
    }
  }

  /** Pick a canyon worth standing in, and a position that is actually in it.
   *
   * Two things went wrong in the first version and both are worth recording.
   * It seated the eye on the street centreline sample point, but NYC's
   * centreline is not always the middle of the space between the buildings, so
   * the camera could end up inside a wall — a frame filled edge to edge with
   * one flat facade. And it preferred the deepest canyon it could find, which
   * in Midtown means a 20 m slot between towers: correct, and unreadable.
   *
   * So: prefer a canyon wide enough to see along, and offset the eye to the
   * measured midpoint between the two walls using the exported distances.
   */
  _findStreetPoint() {
    // Use the viewpoints the pipeline validated against the surface model.
    // Deriving one here from canyon attributes alone put the eye inside a
    // building twice, because the street centreline is not reliably the middle
    // of the space between the facades and the browser has no way to check.
    const vps = this.data.meta.viewpoints || [];
    if (vps.length) {
      const v = vps[this.viewpointIndex % vps.length];
      return { x: v.x, y: v.y, bearing: v.bearing, name: v.name };
    }
    const pool = this.data.canyons.filter((c) => c.canyon && c.dl > 4 && c.dr > 4);
    if (!pool.length) return { x: 0, y: 0, bearing: 0 };
    return this._seatIn(pool.reduce((a, b) => (b.hw > a.hw ? b : a)));
  }

  /** Step to the next validated viewpoint, for the "next street" control. */
  nextViewpoint() {
    const vps = this.data.meta.viewpoints || [];
    if (!vps.length) return null;
    this.viewpointIndex = (this.viewpointIndex + 1) % vps.length;
    const v = vps[this.viewpointIndex];
    this.setMode('street', { x: v.x, y: v.y, bearing: v.bearing });
    return v;
  }

  get currentViewpoint() {
    const vps = this.data.meta.viewpoints || [];
    return vps.length ? vps[this.viewpointIndex % vps.length] : null;
  }

  /** Eye position at the measured centre of a canyon cross-section. */
  _seatIn(c) {
    const ang = (c.bearing * Math.PI) / 180;
    // Unit vector across the street, to the right of the axis direction.
    const nx = Math.cos(ang), ny = -Math.sin(ang);
    // Positive shift moves right; centre the eye between the two walls.
    const shift = ((c.dr || 0) - (c.dl || 0)) / 2;
    return { x: c.x + nx * shift, y: c.y + ny * shift, bearing: c.bearing };
  }

  /** Move the street camera to a specific canyon by index. */
  gotoCanyon(i) {
    const c = this.data.canyons[i];
    if (!c) return;
    this.setMode('street', this._seatIn(c));
  }

  // --------------------------------------------------------------- picking

  _initPicking() {
    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-9, -9);
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      );
      this._lastPointer = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerleave', () => { this.pointer.set(-9, -9); });

    // Distinguish a click from the end of a drag. Orbiting the camera ends in a
    // mouseup that the browser also reports as a click, so without this a
    // camera move would select or deselect a building every time.
    let downAt = null;
    el.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      const held = performance.now() - downAt.t;
      downAt = null;
      if (moved > 6 || held > 500) return;   // that was a drag, not a click
      const hit = this.hitTest();
      if (this.onPick) this.onPick(hit);
    });
  }

  /** Ray-cast into the facade mesh and resolve the hit back to a physics cell.
   *
   * Called from a throttled loop rather than every frame: the facade mesh has
   * no acceleration structure, so each call is a linear scan over roughly
   * 350,000 triangles. `far` is clamped so the scan gives up before testing
   * geometry on the far side of the city that no tooltip would ever describe.
   */
  hitTest() {
    if (this.pointer.x < -2) return null;
    this.ray.setFromCamera(this.pointer, this.camera);
    this.ray.far = 3000;
    const hits = this.ray.intersectObjects([this.facadeMesh, this.roofMesh], false);
    if (!hits.length) return null;
    const h = hits[0];
    if (h.object === this.roofMesh) {
      const b = this.roofVertBuilding[h.face.a];
      return { building: b, panel: null, band: null, kind: 'roof', point: h.point };
    }
    const quad = Math.floor(h.face.a / 4);
    return {
      building: this.quadBuilding[quad],
      panel: this.quadPanel[quad],
      band: this.quadBand[quad],
      kind: 'facade',
      point: h.point,
    };
  }

  // ------------------------------------------------------------- colouring

  /** Sampled percentile domain over a large typed array. */
  static _domain(arr, loPct = 1, hiPct = 99, sample = 120000) {
    const stride = Math.max(1, Math.floor(arr.length / sample));
    const s = [];
    for (let i = 0; i < arr.length; i += stride) if (isFinite(arr[i])) s.push(arr[i]);
    if (!s.length) return [0, 1];
    s.sort((a, b) => a - b);
    return [s[Math.floor((loPct / 100) * (s.length - 1))],
            s[Math.floor((hiPct / 100) * (s.length - 1))]];
  }

  _defaultDomains() {
    // Wide percentiles for the same reason main.js gives: a tight window puts
    // the whole afternoon in the top of the ramp and clips the hottest walls.
    this.surfaceDomain = Scene._domain(this.data.thermal, 0.5, 99.8);
    this.airDomain = Scene._domain(this.data.air, 0.5, 99.5);
  }

  setDomains(d) {
    if (d?.surface) this.surfaceDomain = d.surface;
    if (d?.air) this.airDomain = d.air;
    this._recolour();
    this._paintGround();
  }

  setLayer(layer) {
    this.layer = layer;
    // The ground shows whichever measured field pairs with the chosen facade
    // layer. For the modelled layers it shows exceedance, because that is the
    // measured field with real spatial structure and it grounds the modelled
    // surfaces in something observed.
    this.groundLayer = (layer === 'persistence') ? 'persistence'
                     : (layer === 'air') ? 'air'
                     : 'exceedance';
    this._recolour();
    this._paintGround();
  }

  setHour(h) {
    this.hour = h;
    this._recolour();
    this._paintGround();
  }

  _recolour() {
    const d = this.data;
    const nBand = d.facades.bands;
    const arr = this.facadeColors.array;
    const layer = this.layer;
    const dom = layer === 'air' ? this.airDomain : this.surfaceDomain;
    const f = (layer === 'priority') ? RAMPS.priority : RAMPS.temperature;

    // Selection highlight: everything not selected desaturates, so the chosen
    // building stands out without changing its data colour.
    const sel = this.selected;

    // Directional term from the *actual* solar position this hour, so the form
    // the eye reads agrees with the physics instead of contradicting it: the
    // faces that look brightest are the faces the sun is really on. Below the
    // horizon it falls back to ambient occlusion alone.
    const Hh = d.meta.hours[this.hour];
    const sunUp = Hh.sun_alt > 0;
    const altR = (Hh.sun_alt * Math.PI) / 180;
    const azR = (Hh.sun_az * Math.PI) / 180;
    const sx = Math.cos(altR) * Math.sin(azR);
    const sz = -Math.cos(altR) * Math.cos(azR);

    for (let q = 0; q < this.nQuad; q++) {
      const p = this.quadPanel[q], b = this.quadBand[q];
      let c;
      if (layer === 'priority') {
        const bi = this.quadBuilding[q];
        const a = d.buildings.attrs[bi];
        c = f(norm(a && a.pr !== undefined ? a.pr : NaN, 0, 85));
      } else if (layer === 'air') {
        c = f(norm(d.airAt(this.hour, p, b), dom[0], dom[1]));
      } else if (layer === 'sun') {
        c = d.sunlitAt(this.hour, p, b)
          ? [252, 200, 90] : [46, 54, 70];
      } else {
        c = f(norm(d.surfaceAt(this.hour, p, b), dom[0], dom[1]));
      }
      let sh = this.quadAO[q];
      if (sunUp) {
        const facing = Math.max(0, this.quadNX[q] * sx + this.quadNZ[q] * sz);
        const lit = (layer === 'sun') ? 1 : (d.sunlitAt(this.hour, p, b) ? 1 : 0);
        sh *= 1.0 + 0.38 * facing * lit;
      }
      let r = (c[0] / 255) * sh, g = (c[1] / 255) * sh, bl = (c[2] / 255) * sh;
      // Gentle S-curve. Multiplying a colour ramp by an occlusion factor pulls
      // everything toward mid grey and reads as chalky; deepening the low end
      // while holding the top restores the sense that a shaded canyon is dark
      // and a sunlit wall is bright, without shifting the hue that carries the
      // measurement.
      // Clamp before indexing. The solar term can push the shading factor above
      // 1.0, so an unclamped index ran off the end of the 256-entry table and
      // returned undefined, which propagated as NaN into the colour buffer.
      r = CONTRAST[curve(r)]; g = CONTRAST[curve(g)]; bl = CONTRAST[curve(bl)];
      if (sel !== null && this.quadBuilding[q] !== sel) {
        const grey = (r + g + bl) / 3;
        r = r * 0.34 + grey * 0.18; g = g * 0.34 + grey * 0.18; bl = bl * 0.34 + grey * 0.22;
      }
      const o = q * 12;
      for (let k = 0; k < 4; k++) { arr[o + k * 3] = r; arr[o + k * 3 + 1] = g; arr[o + k * 3 + 2] = bl; }
    }
    this.facadeColors.needsUpdate = true;
    this._recolourRoofs();
  }

  _recolourRoofs() {
    const d = this.data;
    const arr = this.roofColors.array;
    const sel = this.selected;
    const dom = this.layer === 'air' ? this.airDomain : this.surfaceDomain;

    for (let i = 0; i < this.roofRange.length; i++) {
      const [start, n] = this.roofRange[i];
      if (!n) continue;
      const a = d.buildings.attrs[i];
      let c;
      if (this.layer === 'priority') {
        c = RAMPS.priority(norm(a && a.pr !== undefined ? a.pr : NaN, 0, 85));
      } else if (this.layer === 'sun') {
        c = [252, 200, 90];   // roofs are always the most exposed surface
      } else {
        // A roof sees the whole sky and nothing shades it, so it sits near the
        // top of the range whenever the sun is up. Taken from the panels of the
        // same building at their highest band, which is the closest solved
        // value to roof level.
        const ps = d.panelsOfBuilding.get(i);
        let t = NaN;
        if (ps && ps.length) {
          let sum = 0, cnt = 0;
          for (const p of ps) {
            const v = this.layer === 'air'
              ? d.airAt(this.hour, p, d.facades.bands - 1)
              : d.surfaceAt(this.hour, p, d.facades.bands - 1);
            if (isFinite(v)) { sum += v; cnt++; }
          }
          if (cnt) t = sum / cnt;
        }
        c = RAMPS.temperature(norm(t, dom[0], dom[1]));
      }
      // Roofs are the least obstructed surface in the city, so they carry
      // nearly the full value — trimmed only enough to stop them flaring
      // against the occluded facades below.
      const rs = 0.94;
      let r = (c[0] / 255) * rs, g = (c[1] / 255) * rs, bl = (c[2] / 255) * rs;
      if (sel !== null && i !== sel) {
        const grey = (r + g + bl) / 3;
        r = r * 0.34 + grey * 0.18; g = g * 0.34 + grey * 0.18; bl = bl * 0.34 + grey * 0.22;
      }
      for (let k = 0; k < n; k++) {
        const o = (start + k) * 3;
        arr[o] = r; arr[o + 1] = g; arr[o + 2] = bl;
      }
    }
    this.roofColors.needsUpdate = true;
  }

  select(buildingIndex) {
    this.selected = buildingIndex;
    this._recolour();
  }

  focus(buildingIndex) {
    const a = this.data.buildings.attrs[buildingIndex];
    if (!a) return;
    const ps = this.data.panelsOfBuilding.get(buildingIndex);
    let x = 0, y = 0;
    if (ps && ps.length) {
      const xy = this.data.facades.xy;
      for (const p of ps) { x += xy[p * 4]; y += xy[p * 4 + 1]; }
      x /= ps.length; y /= ps.length;
    }
    const h = a.h;
    this.setMode('orbit');
    this.controls.target.set(x, Math.min(h * 0.55, 140), -y);
    const dist = Math.max(150, h * 2.4);
    this.camera.position.set(x + dist * 0.75, h * 1.05 + 90, -y + dist * 0.75);
  }

  // ------------------------------------------------------------------ loop

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick(dt) {
    if (this.mode === 'street') {
      const f = this.fp, k = f.keys;
      const sp = f.speed * dt * (k.has('ShiftLeft') ? 3.0 : 1);
      // Forward and right on the ground plane, from the yaw. World axes are
      // x = east, z = -north, so a compass bearing maps to (sin, 0, -cos).
      const fwd = new THREE.Vector3(Math.sin(f.yaw), 0, -Math.cos(f.yaw));
      const rgt = new THREE.Vector3(Math.cos(f.yaw), 0, Math.sin(f.yaw));
      if (k.has('KeyW')) this._tryMove(fwd, sp);
      if (k.has('KeyS')) this._tryMove(fwd, -sp);
      if (k.has('KeyD')) this._tryMove(rgt, sp);
      if (k.has('KeyA')) this._tryMove(rgt, -sp);
      if (k.has('KeyE')) f.pos.y = Math.min(420, f.pos.y + sp);
      if (k.has('KeyQ')) f.pos.y = Math.max(1.7, f.pos.y - sp);
      // If a roof has been climbed onto, stand on it rather than inside it.
      const ground = this.data.heightAt(f.pos.x, -f.pos.z);
      if (ground > 0 && f.pos.y < ground + 1.7) f.pos.y = ground + 1.7;
      // Aim with lookAt rather than composing Euler rotations.
      //
      // This was a genuine bug and an instructive one. A yaw applied as
      // rotateY(yaw) turns the camera's default -Z forward into
      // (-sin yaw, 0, -cos yaw), while the movement vector above is
      // (+sin yaw, 0, -cos yaw). The two are mirror images across the north
      // axis, so the camera walked east while looking west — and since a
      // validated viewpoint sits in the middle of a canyon, looking 90 degrees
      // off-axis meant staring at the wall two metres away. The screenshot was
      // a single flat rectangle of colour, which is exactly what it looked like.
      //
      // Deriving the look target from the same forward vector that drives
      // movement makes the two impossible to disagree.
      this.camera.position.copy(f.pos);
      const look = f.pos.clone()
        .addScaledVector(fwd, Math.cos(f.pitch) * 50)
        .add(new THREE.Vector3(0, Math.sin(f.pitch) * 50, 0));
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(look);
    } else {
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

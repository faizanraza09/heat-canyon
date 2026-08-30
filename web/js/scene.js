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
// MapControls supplies right-drag orbit, wheel zoom and touch navigation. The
// desktop left-drag pan is implemented below: its distance-based approximation
// made the city slip away from the pointer at oblique camera angles.
import { MapControls } from 'three/addons/controls/MapControls.js';
import { RAMPS, norm, SHADE_RGB, SUNLIT_RGB } from './colors.js';
import { Photoreal, findApiKey } from './photoreal.js';

/** Contrast curve, indexed 0-255. A smoothstep-weighted lift: dark values fall
 *  away faster, bright values are left nearly alone, nothing clips. Built once
 *  because it is applied to every one of ~700,000 vertices on every recolour. */
/* How far the coloured facade skin is pushed out from the wall it represents,
 * in metres, when the photoreal layer is on. Large enough to beat depth-buffer
 * precision at street level against Google's mesh, small enough that it is not
 * visible as a gap: the photogrammetry facade and the footprint edge already
 * disagree by more than this. */
const FACADE_OUTWARD_M = 0.7;

/* How far the rest of the city recedes while one building is selected.
 *
 * A flat multiply, deliberately: the previous version mixed each colour toward
 * its own grey, which was fine against a cool blue-black shell and wrong against
 * a warm one — desaturating a ramp that runs indigo → magenta → cream lands the
 * whole city on a flat mauve, and mauve is a colour the ramp itself uses. Scaling
 * the value alone keeps every wall's hue exactly where the measurement put it,
 * so the unselected city stays readable as data while clearly stepping back. */
const DIM = 0.46;

/* The other half of the same decision. Dimming five thousand buildings is how a
 * selection is shown, but it is not enough to show a SET — the analyst routinely
 * lights up fourteen buildings at once, and on a dark scene "everything else is
 * darker" reads as "nothing happened". So the members of a highlighted set are
 * lifted as well as the rest dimmed, warm-biased so the lift cannot be mistaken
 * for a hotter measurement. */

const PAN_SPEED = 0.72;

/* Aerial perspective, as near/far metres.
 *
 * These were five duplicated literal pairs before the sky started carrying the
 * hour's light. That was survivable while the haze was the same near-black as
 * the clear colour and therefore invisible; it stopped being survivable the
 * moment the fog took a daylight colour, because then every place that forgot
 * to be updated showed as a band of the wrong weather.
 *
 * The fly-over pair is deliberately long. Midtown is about 2.2 km across and
 * the default camera stands 2.6 km off it, so a haze that saturated at 4.8 km
 * — which is what the near-black pair did — now buries the far half of the
 * study area in sky colour. Depth should be a cue, not a curtain.
 */
/* The fly-over's field of view. */
const ORBIT_FOV = 46;

const FOG_ORBIT = { near: 2400, far: 11000 };

const CONTRAST = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const sm = x * x * (3 - 2 * x);
    // A smoothstep-weighted lift, shaped so it reaches exactly 1 at 1.
    //
    // This used to be `min(1, base * 1.05)`, and `base` is already 1 at x = 1 —
    // so the gain did nothing at the top of the range except clip it. Everything
    // above about 0.95 came out pure white, which threw away the cream the heat
    // ramp actually ends on (247, 231, 190) and flattened the hottest walls in
    // the city into one indistinguishable band. The exponent lifts the midtones
    // by very nearly the same amount — 0.523 against 0.525 at the midpoint —
    // and leaves the top of the ramp where the design put it.
    t[i] = Math.pow(x * 0.40 + sm * 0.60, 0.94);
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
    this.photorealOn = false;
    this.showSolids = false;
    this.forceCpuPhotoreal = false;

    /* The NAVD88 elevation that this scene's y = 0 stands for.
     *
     * The scene draws every building on a flat datum (see _buildFacades), which
     * is the right call on its own but leaves the question of *which* elevation
     * that datum represents unanswered — it never had to be answered, because
     * nothing else in the scene knew about real elevations. The photoreal layer
     * does, so the median building ground elevation becomes the answer: it puts
     * the tileset's terrain at the height most of Midtown actually sits at, and
     * makes the residual error symmetric instead of one-sided. */
    this.datumM = Scene._medianBase(data);

    this._initRenderer();
    this._initScene();
    this._buildGround();
    this._buildFacades();
    this._buildRoofs();
    this._buildPin();
    this._buildWalkMarker();
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
    // The warm near-black the whole interface sits on. A cool blue-black here
    // put a second blue in the frame that competed with the cold end of the
    // heat ramp; #0A0908 is a colour the ramp never reaches, so the shell
    // recedes and the measurement is the only saturated thing on screen.
    this.renderer.setClearColor(0x0a0908, 1);
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
    this.scene.fog = new THREE.Fog(0x0a0908, FOG_ORBIT.near, FOG_ORBIT.far);

    // No lights. Every mesh that carries data uses MeshBasicMaterial with
    // vertex colours, so scene lighting would have nothing to act on — the
    // depth cues come from baked shading and from fog instead.
    this._buildSky();
  }

  /** The sky, carrying the hour's real sun.
   *
   * This began as a fixed near-black gradient, and the fixture was wrong in a
   * way that mattered rather than merely looking flat. The subject of this
   * model is how much sky a wall can see, and where the sun is standing when
   * it heats it — and yet walking into a canyon and looking up gave a black
   * slot at every hour of the year. Noon and midnight rendered identically.
   * The one quantity the scene most needed to show was the one it drew as
   * nothing.
   *
   * So the sky reads `meta.hours[hour]`, which already carries the solar
   * altitude and azimuth the pipeline ray-traced its shadows with, and draws a
   * gradient whose brightness follows that altitude, a haze glow banked on the
   * sun's own bearing rather than spread evenly, and the sun itself at its
   * true position and true angular size. Standing in a canyon and watching the
   * disc cross the slot is the model's central claim made directly visible,
   * and it costs one sphere.
   *
   * The palette is deliberately restrained. A photographic blue would put a
   * second saturated field on screen competing with the heat ramp, which is
   * the one thing the design forbids. These are desaturated slate and warm
   * grey: bright enough to read unmistakably as sky and to give the skyline
   * something to stand against, never bright enough to be mistaken for data.
   */
  _buildSky() {
    const geo = new THREE.SphereGeometry(9000, 48, 24);
    const mat = new THREE.ShaderMaterial({
      // depthTest off, drawn first: the sky can then never punch through the
      // city regardless of where the far plane ends up, which during the
      // opening descent ranges over three orders of magnitude.
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(0x080706) },
        horizon: { value: new THREE.Color(0x1a1613) },
        below: { value: new THREE.Color(0x0a0908) },
        glow: { value: new THREE.Color(0x2b1d18) },
        sunDir: { value: new THREE.Vector3(0, -1, 0) },
        discGain: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          // The sky sphere is re-centred on the camera every frame, so the
          // offset from the eye to a vertex is exactly the view ray through
          // it. Normalising per fragment rather than per vertex keeps the
          // gradient smooth across a coarse tessellation.
          vec4 world = modelMatrix * vec4(position, 1.0);
          vDir = world.xyz - cameraPosition;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec3 zenith; uniform vec3 horizon; uniform vec3 below;
        uniform vec3 glow; uniform vec3 sunDir; uniform float discGain;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0);
          // The exponent is what makes the bright band hug the horizon: real
          // sky luminance falls off fast over the first few degrees up.
          vec3 c = mix(horizon, zenith, pow(smoothstep(0.0, 0.62, h), 0.72));
          // Below the horizon the backdrop plane covers the sphere almost
          // everywhere — but not at street level looking down a long avenue,
          // so it still has to be a colour rather than a seam.
          c = mix(below, c, smoothstep(-0.055, 0.008, h));

          float cs = dot(d, sunDir);
          // Two glows, both banked on the sun's bearing. The wide one is the
          // forward-scattered haze that tells you which way the sun is even
          // when a tower stands in front of it; the tight one is the aureole.
          float lit = smoothstep(-0.12, 0.05, sunDir.y);
          c += glow * pow(max(cs, 0.0), 4.0) * 0.50 * lit;
          c += glow * pow(max(cs, 0.0), 90.0) * 0.80 * lit;

          // The disc, at the sun's true angular radius of 0.267 degrees. Left
          // true it is a small hard dot, which is both correct and exactly
          // what it looks like from a street; the soft outer edge is one pixel
          // of antialiasing, not a bloom.
          float ang = acos(clamp(cs, -1.0, 1.0));
          c = mix(c, vec3(1.0, 0.97, 0.90),
                  (1.0 - smoothstep(0.0042, 0.0064, ang)) * discGain);
          gl_FragColor = vec4(c, 1.0);
          // A ShaderMaterial gets no output conversion for free: three appends
          // the encoding chunk to its own materials, not to a hand-written one.
          // Without this line every uniform above is written to an sRGB
          // framebuffer as though it were already sRGB, and since the uniforms
          // are linear that renders each colour at roughly half the brightness
          // it was specified at — which is most of why the original sky read as
          // flat black however it was tuned.
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.scene.add(this.sky);
    this._updateSky();
  }

  /** Sky colour against solar altitude, in degrees: [alt, zenith, horizon,
   *  glow]. The fourth band the shader needs — what lies *below* the horizon —
   *  is not in the table: it is the fog colour, which is both what infinite
   *  haze looks like and what the backdrop plane has already faded to by its
   *  own far edge, so the two meet without a seam at any hour.
   *
   * A table rather than a scattering model, because the interesting part of
   * the curve is the twenty degrees either side of the horizon, where a
   * physical model would need parameters this project cannot measure and a
   * linear ramp would skip civil twilight altogether.
   */
  static SKY_KEYS = [
    [-18, 0x050509, 0x0a0a10, 0x120f1a],
    [-8, 0x08090f, 0x161522, 0x2c1d2c],
    [-3, 0x101220, 0x33232a, 0x60301c],
    [0, 0x191d2e, 0x553420, 0x8e4520],
    [6, 0x212c40, 0x74604c, 0x7d4a22],
    [20, 0x27374f, 0x7d7264, 0x5c4a32],
    [45, 0x2a3f60, 0x877f74, 0x483f30],
  ];

  /** Point the sky at the sun this hour is standing under.
   *
   * Called from setHour and setPeriod rather than from the frame loop: the sun
   * only moves when the clock does, and the interpolation is cheap but not
   * free.
   */
  _updateSky() {
    const hours = this.data.meta.hours;
    const h = hours && hours[this.hour];
    if (!this.sky || !h) return;
    const alt = h.sun_alt ?? -20;
    const az = h.sun_az ?? 0;
    const cloud = Math.max(0, Math.min(1, h.cloud ?? 0));

    const K = Scene.SKY_KEYS;
    // Built once: constructing eight Colors per hour change is pointless, and
    // constructing them per frame would be worse if this ever moves.
    const SKY_COL = Scene._skyCol || (Scene._skyCol = K.map(
      (row) => row.map((v, n) => (n === 0 ? v : new THREE.Color(v)))));
    let i = 0;
    while (i < K.length - 2 && alt > K[i + 1][0]) i++;
    const a = K[i], b = K[i + 1];
    const t = Math.max(0, Math.min(1, (alt - a[0]) / (b[0] - a[0])));
    const u = this.sky.material.uniforms;
    // Three's colour management converts a hex literal from sRGB into the
    // linear working space on construction, so these lerps are already in
    // linear light — which is where a gradient between two sky states belongs.
    // Converting again by hand, as the first draft did, applies the transfer
    // function twice and lands noon somewhere near midnight.
    const lerpKey = (n, target) => {
      target.copy(SKY_COL[i][n]).lerp(SKY_COL[i + 1][n], t);
    };
    lerpKey(1, u.zenith.value);
    lerpKey(2, u.horizon.value);
    lerpKey(3, u.glow.value);

    // Overcast flattens the gradient toward the horizon's own value and puts
    // the sun out. `cloud` is the reanalysis cover fraction for this hour, the
    // same one the diffuse fraction in the energy balance is driven by, so an
    // overcast hour looks overcast and reads consistently with the numbers in
    // the panel beneath it.
    if (cloud > 0) {
      const flat = u.horizon.value.clone().lerp(u.zenith.value, 0.5);
      u.zenith.value.lerp(flat, cloud * 0.65);
      u.horizon.value.lerp(flat, cloud * 0.40);
      u.glow.value.multiplyScalar(1 - 0.6 * cloud);
    }

    // Compass azimuth to world: x = east, z = -north, so a bearing maps to
    // (sin, ·, -cos).
    const ar = THREE.MathUtils.degToRad(alt);
    const zr = THREE.MathUtils.degToRad(az);
    u.sunDir.value.set(
      Math.cos(ar) * Math.sin(zr), Math.sin(ar), -Math.cos(ar) * Math.cos(zr));
    // The disc appears as the limb clears the horizon and is extinguished by
    // cloud. Refraction lifts the apparent disc about half a degree, which is
    // why the fade starts below zero.
    u.discGain.value = Math.max(0, Math.min(1, (alt + 0.9) / 1.4))
      * (1 - 0.94 * cloud);

    // Fog has to be the colour of the thing behind it or the far city ends in
    // a seam. It is the horizon darkened rather than the horizon itself: a
    // haze at full sky brightness would swallow the skyline it exists to give
    // depth to, and would sit close enough to the warm end of the heat ramp to
    // be misread as a measurement.
    // These uniforms are linear, and a scalar there is not the perceptual
    // fraction it looks like: 0.30 in linear light is roughly 0.58 of the
    // horizon's apparent brightness.
    this.scene.fog.color.copy(u.horizon.value).multiplyScalar(0.30);
    this.renderer.setClearColor(this.scene.fog.color, 1);
    // Below the horizon you are looking through unlimited haze, so that is
    // what you see: the fog colour exactly. It also happens to be the colour
    // the backdrop plane has already faded to by its own far edge, so the two
    // meet without a seam — which they did not when this was a separate entry
    // in the table, and the join drew a hard line across the horizon.
    u.below.value.copy(this.scene.fog.color);
  }

  /** The selection pin: a hairline mast off the roof of the chosen building with
   *  an accent dot on top.
   *
   * Dimming the rest of the city says "not this one" but it does not say which
   * one, and at a fly-over altitude a single lit block among four thousand is
   * genuinely hard to find. The mast is the design's answer and it is the right
   * one: it is visible from any angle, it never occludes the wall whose
   * temperature is the point, and it survives being behind a tower because it is
   * excluded from the fog and drawn last.
   */
  _buildPin() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3));
    const mast = new THREE.Line(g, new THREE.LineBasicMaterial({
      color: 0xf2ede4, transparent: true, opacity: 0.8, fog: false,
    }));
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xd9542e, fog: false })
    );
    this.pin = new THREE.Group();
    this.pin.add(mast, dot);
    this.pin.visible = false;
    this.pin.renderOrder = 10;
    this._pinMast = mast;
    this._pinDot = dot;
    this.scene.add(this.pin);
  }

  /** The pavement marker: a flat ring on the ground where a click would land.
   *
   * Click-to-move is the gesture everyone already knows from a street
   * panorama, and it is also completely invisible — nothing about a rendered
   * street says that tapping the road ahead will take you there. Every
   * panorama solves this the same way, by drawing the destination under the
   * cursor before the click, and so does this: the ring appears only where a
   * step is actually available, so it doubles as the answer to "can I get
   * there from here", which against a wall or across a block is no.
   */
  _buildWalkMarker() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.45, 40),
      new THREE.MeshBasicMaterial({
        color: 0xf2ede4, transparent: true, opacity: 0.55,
        depthWrite: false, fog: false, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    ring.renderOrder = 9;
    this.scene.add(ring);
  }


  /** Put the pin on a building, or nowhere. */
  _placePin(buildingIndex) {
    if (!this.pin) return;
    if (buildingIndex === null || buildingIndex === undefined) {
      this.pin.visible = false;
      return;
    }
    const a = this.data.buildings.attrs[buildingIndex];
    if (!a) { this.pin.visible = false; return; }
    const ps = this.data.panelsOfBuilding.get(buildingIndex);
    let x = 0, y = 0;
    if (ps && ps.length) {
      const xy = this.data.facades.xy;
      for (const p of ps) { x += xy[p * 4]; y += xy[p * 4 + 1]; }
      x /= ps.length; y /= ps.length;
    }
    // Tall buildings get a proportionally taller mast, so the dot clears the
    // skyline around them rather than being lost among their neighbours.
    const mast = Math.max(26, Math.min(90, a.h * 0.3));
    this.pin.position.set(x, a.h + 3, -y);
    this._pinMast.scale.set(1, mast, 1);
    this._pinDot.position.set(0, mast + 2.6, 0);
    this._pinDot.scale.setScalar(2.4);
    this.pin.visible = true;
  }

  // ---------------------------------------------------------------- ground

  _buildGround() {
    const meta = this.data.meta;
    const w = meta.aoi.width_m, h = meta.aoi.height_m;
    const pad = 600;

    // Backdrop plane, so the city does not float in a void.
    //
    // Sized for the two views that leave the study area behind rather than for
    // the default one: the opening film starts about five kilometres up, and
    // the fly-over may now stand twelve kilometres off. A plane merely padded
    // around the study area ends well inside either frame, and the city
    // arrives sitting on a visible rectangle. It is one flat quad, so the
    // extra sixty kilometres are free.
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(w + pad * 4 + 60000, h + pad * 4 + 60000),
      new THREE.MeshBasicMaterial({ color: 0x0d0b0a })
    );
    back.rotation.x = -Math.PI / 2;
    back.position.y = -0.8;
    this.scene.add(back);
    // Kept as a handle so the photoreal layer can hide it; it exists only to
    // stop the city floating in a void, which stops being a problem once a
    // real world is underneath.
    this.backdrop = back;

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
      lg, new THREE.LineBasicMaterial({ color: 0x3a322c, transparent: true, opacity: 0.85 })
    );
    this.scene.add(this.streets);
  }

  /* ---------------------------------------------------- photographic ground

     Two satellite planes under the data, on only for the opening descent.

     They exist so the film's last frame and this scene's first frame are the
     same frame. The film falls onto Midtown over a satellite mosaic; if what it
     dissolved onto were a dark abstract plane, the dissolve would read as a cut
     no matter how well the two cameras agreed. With the same two mosaics lying
     on this ground, the handover is a photograph becoming a measurement — the
     buildings stand up out of the picture and the picture turns into the field.

     They are the same two files the film uses, at the same two extents, so the
     browser fetches each once. The wide one holds the corners of the frame,
     which at three kilometres up reach six from the middle; the sharp one holds
     the middle. And they are graded with exactly the film's grade, constant for
     constant, because a tonal jump in the middle of a dissolve is the one thing
     that would give it away. */

  /** Fetch and lay the descent's basemap. Called only when the film is going to
   *  play; the application on its own never asks for these three megabytes. */
  async loadBasemap() {
    if (this._basemap) return this._basemap;
    this._basemap = (async () => {
      const meta = await fetch('./data/approach/meta.json').then((r) => {
        if (!r.ok) throw new Error(`approach/meta.json: ${r.status}`);
        return r.json();
      });
      // The manifest marks which levels the application lays on its own ground:
      // the widest one, sized to the backdrop plane, and the sharpest. Taken by
      // flag rather than by name so re-cutting the pyramid in
      // scripts/fetch_approach.py cannot silently leave this reading two levels
      // that no longer exist.
      const want = meta.levels.filter((l) => l.app).sort((a, b) => b.span_m - a.span_m);
      const planes = [];
      for (const lv of want) {
        const key = lv.key;
        const tex = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error(lv.file));
          im.src = `./data/approach/${lv.file}`;
        }).then((im) => {
          const t = new THREE.Texture(im);
          // Sampled raw, not linearised. Every other shader in this scene
          // authors its colours in display space and writes them straight out,
          // and the grade below is a look rather than a light transport, so the
          // whole chain stays in one space and matches the film's byte for byte.
          t.colorSpace = THREE.NoColorSpace;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.magFilter = THREE.LinearFilter;
          t.generateMipmaps = true;
          t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          t.needsUpdate = true;
          return t;
        });
        const mat = new THREE.ShaderMaterial({
          fog: true,
          transparent: true, depthWrite: false,
          uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            map: { value: tex },
            opacity: { value: 0 },
            exposure: { value: 0.82 * (lv.gain ?? 1) },
          },
          vertexShader: `
            #include <common>
            #include <fog_pars_vertex>
            varying vec2 vUv;
            void main() {
              vUv = uv;
              vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
              gl_Position = projectionMatrix * mvPosition;
              #include <fog_vertex>
            }`,
          fragmentShader: `
            #include <common>
            #include <fog_pars_fragment>
            uniform sampler2D map; uniform float opacity; uniform float exposure;
            varying vec2 vUv;
            void main() {
              vec3 t = texture2D(map, vUv).rgb;
              float lum = dot(t, vec3(0.299, 0.587, 0.114));
              // film.js, _buildApproach: desaturate a little, deepen the
              // shadows, hold the exposure back, tint for a lit hemisphere, and
              // mix toward the heat ramp at 0.64 — which is where the film's
              // fully warmed globe sits by the time it gets here.
              vec3 c = mix(vec3(lum), t, 0.84);
              c = pow(c, vec3(1.16)) * exposure;
              c *= vec3(1.03, 0.99, 0.94);
              c = mix(c, vec3(0.737, 0.342, 0.177) * (0.34 + 0.92 * lum), 0.22);
              // Radial, matching film.js: a square edge would read as a cut
              // exactly where this has to be invisible.
              float r = length(vUv - 0.5) * 2.0;
              gl_FragColor = vec4(c, opacity * (1.0 - smoothstep(0.70, 0.98, r)));
              #include <fog_fragment>
            }`,
        });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(lv.span_m, lv.span_m), mat);
        m.rotation.x = -Math.PI / 2;
        // Between the backdrop (-0.8) and the measured field (-0.25), wide
        // under sharp, so the whole stack is one ordered set of decals.
        const rank = want.indexOf(lv);
        m.position.y = -0.62 + rank * 0.18;
        m.renderOrder = -10 + rank;
        m.visible = false;
        this.scene.add(m);
        planes.push({ key, mesh: m, mat, tex });
      }
      this.basemap = planes;
      this.setBasemap(this._basemapK || 0);
      return planes;
    })().catch((e) => {
      console.warn('descent basemap unavailable:', e);
      this.basemap = [];
      return [];
    });
    return this._basemap;
  }

  /** How much of the ground is photograph, 0..1.
   *
   * Not just the planes' opacity: the measured field and the street lines step
   * back as the photograph comes up, because at full strength they would draw
   * over it and the frame the film is dissolving onto would be a data frame
   * again. On the way back down the reverse happens, and what the viewer sees is
   * the photograph resolving into the measurement it stands for. */
  setBasemap(k) {
    this._basemapK = k;
    for (const p of this.basemap || []) {
      p.mat.uniforms.opacity.value = k;
      p.mesh.visible = k > 0.002;
    }
    if (this.ground) this.ground.material.opacity = 0.62 * (1 - 0.80 * k);
    if (this.streets) this.streets.material.opacity = 0.85 * (1 - k);
  }

  /* ------------------------------------------------------------- descent

     The opening film owns this camera for the last five seconds of its
     descent. It is not "the film ends and a fly-in starts": the film computes
     its own pose in this scene's east-north-up metres and hands it over frame
     by frame, so while both canvases are up they are two renderings of one
     viewpoint, and the globe canvas dissolving costs the shot nothing. */

  /** Compile and upload everything the handoff is about to need, now.
   *
   * The application does not render at all while the film has the screen —
   * main.js parks `tick`, because a full-resolution city behind an opaque
   * overlay is pure waste and on a weak GPU it is the difference between the
   * opening playing at speed and playing in slow motion. The cost of that is
   * paid all at once on the first frame after the handoff: every program in
   * this scene compiles, every buffer and texture uploads, and the photographic
   * ground — which `beginDescent` makes visible for the very first time —
   * brings two more shaders and two 2048-pixel mosaics with it.
   *
   * Measured, that first tick took 394 ms. Four hundred milliseconds of frozen
   * frame, landing precisely at the moment the camera is supposed to be falling
   * through sixty kilometres, which is the one moment in the film where a
   * stutter cannot be mistaken for anything else.
   *
   * So it is paid up front instead, behind the loading screen, where a single
   * long frame costs nothing: bring the ground up, compile against the camera
   * that will actually be used, draw one frame to force the uploads, and put
   * the ground back where it was. The programs and textures stay resident, so
   * `beginDescent` is then only a visibility flag.
   */
  async prime() {
    if (this._primed || !this.renderer) return;
    this._primed = true;
    try {
      await this.loadBasemap();
      const k = this._basemapK || 0;
      this.setBasemap(1);
      this.sky.position.copy(this.camera.position);
      this.renderer.compile(this.scene, this.camera);
      this.renderer.render(this.scene, this.camera);
      this.setBasemap(k);
    } catch (e) {
      // Priming is an optimisation. A scene that cannot be primed still runs;
      // it just pays for its first frame at the worst possible moment.
      console.warn('scene prime skipped:', e);
    }
  }

  /** Put the camera into the fly-over's own state, optionally over a place.
   *
   * What is left of `setMode('orbit', at)` now that there is one camera. The
   * street branch is gone, so what used to be the larger half of a two-way
   * switch is the whole method, and it is small: the controls come back on, the
   * target moves if somewhere was named, and the fog returns to the pair the
   * fly-over is tuned for. `tick` recomputes that pair from the camera distance
   * on the next frame anyway (`_orbitFog`), so this only has to be right enough
   * to survive until then.
   *
   * Every caller in this file passes `{ animate: false }` and moves the camera
   * itself afterwards, because each knows a destination this method cannot:
   * `showBuilding` frames a building, `resetView` restores the opening pose,
   * `flyIn` *is* a flight, and `beginDescent` hands the camera to the film. They
   * capture their own `from` pose first and start their own transit once the
   * camera is where they want it — which is why `showBuilding` says in so many
   * words that a transition from here would fly to the wrong pose. `animate` is
   * honoured for a caller with no such destination of its own, a bare "come
   * back to the fly-over", and is currently taken by none of them.
   */
  setView(at = null, { animate = false } = {}) {
    const from = animate ? this._modePose() : null;
    this.controls.enabled = true;
    this.scene.fog.near = FOG_ORBIT.near;
    this.scene.fog.far = FOG_ORBIT.far;
    if (at) {
      this.controls.target.set(
        at.x,
        Math.min(at.h || 40, 120) + this._elevOffsetAt(at.x, at.y),
        -at.y);
    }
    this.controls.update();
    if (from) this._beginTransit(from);
  }

  /** Take the camera off its controls and give it to the film. */
  beginDescent() {
    this._abortFly(true);
    this.setView(null, { animate: false });
    this.controls.enabled = false;
    this._descent = true;
    this.setBasemap(1);
  }

  /** One frame of the film's descent, in metres east / up / -north. */
  setDescentPose(p) {
    if (!this._descent) return;
    this.camera.fov = p.fov;
    // Near and far follow the height, or a camera three kilometres up renders
    // the whole city inside one depth-buffer step.
    this.camera.near = Math.min(200, Math.max(0.8, p.y * 0.02));
    this.camera.far = Math.max(14000, p.y * 8);
    this.camera.updateProjectionMatrix();
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.lookAt(0, 0, 0);
    // Fog opens with the altitude. The default pair is tuned for an eye a
    // couple of kilometres out; left alone at sixty it renders the entire city
    // as one flat wash, which is precisely the empty grey frame the old
    // cross-fade used to land on.
    this.scene.fog.near = Math.max(FOG_ORBIT.near, p.y * 0.7);
    this.scene.fog.far = Math.max(FOG_ORBIT.far, p.y * 5.5);
  }

  /** The film is finished with the camera. Carry on from wherever it left it
   *  into the opening view rather than snapping there. */
  endDescent(seconds = 3.4, fadeDelay = 0) {
    if (!this._descent) return;
    this._descent = false;
    this.camera.near = 0.8;
    this.camera.far = 14000;
    this.camera.fov = ORBIT_FOV;
    this.camera.updateProjectionMatrix();
    this.flyIn({
      seconds,
      from: {
        target: new THREE.Vector3(0, 0, 0),
        sph: new THREE.Spherical().setFromVector3(this.camera.position.clone()),
        fog: { near: this.scene.fog.near, far: this.scene.fog.far },
        swing: 0,
      },
    });
    // The photograph gives way to the measurement — slower than the flight, so
    // the two do not resolve at once.
    //
    // `fadeDelay` holds it off while the film is still dissolving onto it. The
    // opening now hands over as a dissolve rather than as one camera, so for a
    // couple of seconds the globe is fading off a frame this scene is already
    // drawing; if the photographic ground were fading at the same time, what
    // the globe dissolved onto would be a bare measured plane, and the join
    // would be the one thing it exists not to be.
    if (fadeDelay > 0) setTimeout(() => this._fadeBasemap(4.2), fadeDelay * 1000);
    else this._fadeBasemap(4.2);
  }

  _fadeBasemap(seconds) {
    const t0 = performance.now();
    const from = this._basemapK;
    const step = () => {
      const u = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      this.setBasemap(from * (1 - u * u * (3 - 2 * u)));
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
      //
      // On the event day these are FortyGuard's measured values. On any other
      // date they are that day's measured spatial anomaly carried onto the
      // reanalysis level — a composite, and `tilesAt` says which it handed back.
      const got = this.data.tilesAt(this.hour);
      pts = got.rows;
      this.groundKind = got.kind;
      const vals = pts.map((r) => r[2]).sort((a, b) => a - b);
      dom = vals.length
        ? [vals[Math.floor(vals.length * 0.1)], vals[Math.floor(vals.length * 0.9)]]
        : this.airDomain;
      rampName = 'temperature';
    } else if (this.groundYearLayer) {
      // An annual per-tile metric: hours above 35 C across the year, tropical
      // nights, the annual mean. Same composite caveat as the air layer.
      const rows = this.data.tileYearAt(this.groundYearLayer);
      if (rows) {
        pts = rows;
        const vals = rows.map((r) => r[2]).sort((a, b) => a - b);
        dom = [vals[0], vals[vals.length - 1]];
        rampName = 'duration';
        this.groundKind = 'composite';
      } else {
        pts = tiles.exceedance;
        const st = tiles.stats.exceedance;
        dom = [st.min, st.max]; rampName = 'duration';
      }
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
    if (sg && this.data.active?.groundSun
        && this.data.meta.hours[this.hour].sun_alt > 0) {
      const sw = (sg.res / aw) * W + 1;
      ctx.fillStyle = 'rgba(9,8,7,0.44)';
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

    // Azimuth bucket per panel, matching the eight the projection LUT uses.
    // Precomputed because the recolour loop runs it 294,150 times per hour.
    this.panelBucket = new Uint8Array(nPan);
    for (let p = 0; p < nPan; p++) {
      this.panelBucket[p] = Math.floor(((facades.az[p] + 22.5) % 360) / 45) & 7;
    }

    // A second copy of the vertices, on true NAVD88 elevations and pushed a
    // little way out along each panel's outward normal. This is what gets used
    // when the photoreal layer is on.
    //
    // Both offsets are needed and for unrelated reasons. The elevation offset
    // undoes the flat datum: Google's mesh carries real terrain, so a city
    // drawn flat would sink or float by up to 13 m against it, which is four
    // storeys of misregistration. The outward offset stops the coloured skin
    // from z-fighting the photogrammetry facade it is meant to sit on — the two
    // surfaces are within centimetres of each other by design, and without a
    // bias they interleave into speckle.
    //
    // These are real vertex positions rather than a vertex-shader offset
    // because picking raycasts against the CPU-side geometry: offsetting in the
    // shader would leave every click landing on the pre-offset wall.
    const posElev = new Float32Array(pos.length);
    posElev.set(pos);
    for (let qq = 0; qq < nQuad; qq++) {
      const p = this.quadPanel[qq];
      const dy = base[p] - this.datumM;
      const ox = this.quadNX[qq] * FACADE_OUTWARD_M;
      const oz = this.quadNZ[qq] * FACADE_OUTWARD_M;
      const o = qq * 12;
      for (let v = 0; v < 4; v++) {
        posElev[o + v * 3 + 0] += ox;
        posElev[o + v * 3 + 1] += dy;
        posElev[o + v * 3 + 2] += oz;
      }
    }
    this.facadePosFlat = pos;
    this.facadePosElev = posElev;

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
    this._buildPickIndex();
  }

  // ----------------------------------------------------------------- roofs

  _buildRoofs() {
    const { buildings } = this.data;
    const rings = buildings.rings, attrs = buildings.attrs;
    const pos = [], posElev = [], col = [], idx = [];
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
      const dyElev = (attrs[i].base || 0) - this.datumM;
      const start = vbase;
      for (const v of contour) {
        pos.push(v.x, zt, -v.y);
        posElev.push(v.x, zt + dyElev, -v.y);
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
    this.roofPosFlat = new Float32Array(pos);
    this.roofPosElev = new Float32Array(posElev);
  }

  // --------------------------------------------------------------- cameras

  _initCameras() {
    const aspect = window.innerWidth / window.innerHeight;
    // A tight near plane matters at street level; a far plane of 12 km is
    // plenty and keeps depth precision comfortable across the city.
    this.camera = new THREE.PerspectiveCamera(ORBIT_FOV, aspect, 0.8, 14000);
    // Start outside and above the study area looking north-east across it, so
    // the first frame reads as a city rather than as the inside of one building.
    // The default used to sit among the towers, which put 70 m facade panels
    // right against the near plane and looked like abstract sheets.
    this.camera.position.set(-1500, 1250, 1750);

    this.controls = new MapControls(this.camera, this.renderer.domElement);
    // Camera input should stop when the hand stops. Damped pan deltas kept
    // running into the study-area clamp after mouseup, which made reversing at
    // an edge feel sticky and made short adjustments overshoot.
    this.controls.enableDamping = false;
    // Stop well short of the horizon. Panning runs along the ground plane, and
    // as the camera approaches grazing incidence that plane intersection races
    // toward infinity, turning a small drag into an enormous jump.
    // Stop just short of the horizon rather than well short of it. The
    // original 0.14 rad of margin was there because MapControls pans along the
    // ground plane, and that intersection races to infinity at grazing
    // incidence — but the desktop pan is _initGrabPan's fixed metres-per-pixel
    // now, which has no such singularity, so the clamp only has to keep the
    // remaining touch pan sane. Three degrees does that, and it buys the view
    // that matters most now the sky carries the hour: a near-level look along
    // the skyline with the horizon in the frame.
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 12000;
    this.controls.panSpeed = PAN_SPEED;
    this.controls.rotateSpeed = 0.65;
    this.controls.zoomSpeed = 0.85;
    this.controls.screenSpacePanning = false;   // pan across the ground, not the screen
    this.controls.zoomToCursor = true;          // zoom toward what is under the pointer
    // Left mouse is owned by _initGrabPan. Right mouse remains MapControls'
    // orbit gesture, and the built-in one-finger touch pan is unchanged.
    this.controls.mouseButtons.LEFT = null;
    this.controls.target.set(0, 20, 0);
    this.controls.update();
    /* How far the fly-over may roam, as metres from the centre of the study
     * area.
     *
     * This used to be the study area plus 900 m, which put a wall about one
     * city block outside the modelled buildings. It was justified as stopping
     * the camera drifting into empty space, but in practice it stopped
     * something much more ordinary: looking at the edge of the model from
     * outside it. Approaching Midtown from the south, or standing off the
     * west side to see how the avenues line up, both ran into an invisible
     * stop within a couple of drags, and a boundary you meet that often stops
     * reading as a guard rail and starts reading as a bug.
     *
     * The generous limit is the honest one. The backdrop plane is 18.5 km
     * across, so there is ground under the camera for kilometres in every
     * direction and nothing to fall off; the model simply sits where it sits
     * and you can look at it from wherever you like. RESET VIEW is one click
     * away for anyone who does roam far enough to lose it.
     */
    this._panLimit = {
      x: this.data.meta.aoi.width_m / 2 + 5000,
      z: this.data.meta.aoi.height_m / 2 + 5000,
    };

    // Any deliberate input during the opening descent takes the camera back.
    // A cinematic that ignores the mouse is a cinematic that feels broken.
    const bail = () => { this._abortFly(true); this._endTransit(); };
    // Capture is important: controls are disabled during a flight, so the
    // cancelling input must re-enable them before their own listener sees it.
    this.renderer.domElement.addEventListener('pointerdown', bail, { capture: true });
    this.renderer.domElement.addEventListener('wheel', bail, { capture: true, passive: true });
    window.addEventListener('keydown', bail);

    this._initGrabPan();
    this._initZoomGestures();
  }

  /** Predictable desktop map pan in the camera's horizontal frame.
   *
   * A literal ray/ground intersection sounds ideal, but perspective makes an
   * upward drag accelerate sharply as the pointer approaches the horizon. A
   * fixed metres-per-pixel scale for the whole gesture makes left/right and
   * up/down equally responsive. The scale still follows zoom level, as it does
   * in a normal map, and movement ends exactly when the pointer does.
   */
  _initGrabPan() {
    const el = this.renderer.domElement;
    const right = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const move = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let drag = null;

    el.addEventListener('pointerdown', (e) => {
      // Touch retains MapControls' one-finger gesture; running both handlers
      // for the same contact would double the movement.
      if (e.pointerType === 'touch'
          || e.button !== 0 || !this.controls.enabled) return;
      const r = el.getBoundingClientRect();
      this.camera.updateMatrixWorld();
      right.setFromMatrixColumn(this.camera.matrixWorld, 0);
      right.y = 0;
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      right.normalize();
      forward.crossVectors(up, right).normalize();
      const distance = this.camera.position.distanceTo(this.controls.target);
      const metresPerPx = 2 * Math.max(40, distance)
        * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))
        / Math.max(1, r.height) * PAN_SPEED;
      drag = {
        id: e.pointerId, x: e.clientX, y: e.clientY, metresPerPx,
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        right: right.clone(), forward: forward.clone(),
      };
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('is-panning');
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // Dragging right moves the camera left, and vice versa: the city itself
      // follows the hand, matching a normal 2D map. The same rule applies up
      // and down, with down moving the view centre forward over the ground.
      const dx = (e.clientX - drag.x) * drag.metresPerPx;
      const dy = (e.clientY - drag.y) * drag.metresPerPx;
      move.copy(drag.right).multiplyScalar(-dx)
        .addScaledVector(drag.forward, dy);
      this.camera.position.copy(drag.position).add(move);
      this.controls.target.copy(drag.target).add(move);

      const clamped = this._clampOrbitView();
      // Do not accumulate invisible overscroll at the boundary. Rebasing the
      // anchor there makes the first reverse pixel move the map immediately.
      if (clamped) {
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.position.copy(this.camera.position);
        drag.target.copy(this.controls.target);
      }
      e.preventDefault();
    });

    const end = (e) => {
      if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
      if (el.hasPointerCapture?.(drag.id)) el.releasePointerCapture(drag.id);
      drag = null;
      el.classList.remove('is-panning');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('blur', () => {
      drag = null;
      el.classList.remove('is-panning');
    });
  }

  /** Open the haze out with the camera.
   *
   * A fixed near/far pair is only right at one distance. It was tuned for the
   * default framing 2.6 km off the city, and once the fly-over was allowed to
   * pull back to twelve kilometres the same pair buried the entire model in
   * sky colour long before you got there — the zoom-out ended in an empty
   * frame, which reads as the renderer giving up rather than as distance.
   * Scaling both ends with the viewing distance keeps aerial perspective
   * saying the same thing at every altitude: near is clear, far is hazy.
   */
  _orbitFog() {
    const k = Math.max(1, this.camera.position.distanceTo(this.controls.target) / 2600);
    this.scene.fog.near = FOG_ORBIT.near * k;
    this.scene.fog.far = FOG_ORBIT.far * k;
  }

  /* ------------------------------------------------- fly-over conventions

     Three gestures a 3D map is expected to have and this one did not: double
     click to close in on what is under the pointer, a compass that says which
     way north is and puts you back facing it, and a pair of zoom buttons for
     anyone without a wheel — which includes every touch device and every
     keyboard-only viewer. All three route through the same short flight as the
     mode change, so the camera never jumps.
  */

  /** The camera's compass bearing, degrees clockwise from north. */
  get bearing() {
    const dx = this.camera.position.x - this.controls.target.x;
    const dz = this.camera.position.z - this.controls.target.z;
    // The camera looks from its position toward the target, so the direction
    // of view is the negative of this offset; the bearing is that direction as
    // a compass angle, using the same (sin, -cos) mapping as everything else.
    return (THREE.MathUtils.radToDeg(Math.atan2(-dx, dz)) + 360) % 360;
  }

  /** Swing round to north-up, keeping the distance and the tilt. */
  faceNorth() {
    const from = this._modePose();
    const off = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    // theta measured from +z: a camera due south of its target looks north.
    sph.theta = 0;
    this.camera.position.copy(this.controls.target)
      .add(new THREE.Vector3().setFromSpherical(sph));
    this.controls.update();
    this._beginTransit(from);
  }

  /** Step the fly-over's distance by a factor, flying rather than jumping. */
  zoomBy(factor, at = null) {
    const from = this._modePose();
    const t = this.controls.target;
    if (at) {
      // Zooming toward a point means the point stays under the pointer, which
      // is the whole reason a double click reads as "go there": the target
      // slides toward it by the same fraction the distance shrinks.
      const k = 1 - factor;
      t.set(t.x + (at.x - t.x) * k, t.y + (at.y - t.y) * k, t.z + (at.z - t.z) * k);
    }
    const off = this.camera.position.clone().sub(t);
    const d = Math.max(this.controls.minDistance,
      Math.min(this.controls.maxDistance, off.length() * factor));
    this.camera.position.copy(t).add(off.setLength(d));
    this._clampOrbitView();
    this.controls.update();
    this._beginTransit(from);
  }

  /** Double click closes in on what is under the pointer; with shift, out. */
  _initZoomGestures() {
    const el = this.renderer.domElement;
    el.addEventListener('dblclick', (e) => {
      if (!this.controls.enabled) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      this.pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1);
      const hit = this.hitTest();
      // A double click on the sky still zooms — on the ground under it, which
      // is what a map does. Falling through to "do nothing" would make the
      // gesture feel broken exactly where the city is thinnest.
      const at = hit ? hit.point : this._groundUnderPointer();
      this.zoomBy(e.shiftKey ? 1 / 0.55 : 0.55, at);
    });
  }

  /** Where the pointer's ray meets the ground plane, or null. */
  _groundUnderPointer() {
    this.ray.setFromCamera(this.pointer, this.camera);
    const d = this.ray.ray.direction;
    if (d.y >= -1e-4) return null;
    const t = -this.camera.position.y / d.y;
    return new THREE.Vector3(
      this.camera.position.x + d.x * t, 0, this.camera.position.z + d.z * t);
  }

  /** Clamp a fly-over translation without changing its angle or zoom. */
  _clampOrbitView() {
    const t = this.controls.target, L = this._panLimit;
    const dx = Math.min(L.x, Math.max(-L.x, t.x)) - t.x;
    const dz = Math.min(L.z, Math.max(-L.z, t.z)) - t.z;
    if (!dx && !dz) return false;
    t.x += dx; t.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
    return true;
  }

  /** Fly the camera from a captured pose to wherever setView just put it. */
  _beginTransit(from) {
    // Someone who has asked their system for less motion has asked for this
    // too: the flight is the thing that moves, and the destination is reached
    // either way. The project already suppresses the opening film on the same
    // signal, so honouring it here is consistency rather than a new policy.
    if (Scene._reducedMotion()) return;
    const to = this._modePose();
    const drop = from.pos.distanceTo(to.pos);
    // Nothing worth animating if the camera barely moved, and nothing worth
    // watching beyond about a second.
    if (drop < 25) return;
    this._transit = {
      from, to, t: 0, t0: performance.now(),
      dur: Math.min(1.15, 0.45 + drop / 4200),
      // A straight line from an aerial view down to a street runs through
      // whatever tower stands between the two. Bowing the path upward keeps it
      // over the rooflines until the last moment, which is also the shape an
      // aerial camera actually flies.
      bow: Math.min(220, drop * 0.14),
    };
  }

  static _reducedMotion() {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** The camera pose the current view implies, as position and orientation. */
  _modePose() {
    return {
      pos: this.camera.position.clone(),
      quat: Scene._lookQuat(this.camera.position, this.controls.target),
      fov: this.camera.fov,
      fog: { near: this.scene.fog.near, far: this.scene.fog.far },
    };
  }

  /** The orientation a camera at `eye` looking at `at` would have. */
  static _lookQuat(eye, at) {
    const m = new THREE.Matrix4().lookAt(eye, at, new THREE.Vector3(0, 1, 0));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  /** One frame of the flight between the two views. Returns false when done. */
  _stepTransit() {
    const tr = this._transit;
    if (!tr) return false;
    // Wall clock, not accumulated frame time, for the same reason the opening
    // descent uses it: a clamped delta on a slow renderer stretches a
    // one-second move into several and leaves the camera still falling long
    // after the viewer has decided the button did not work.
    tr.t = Math.min(tr.dur, (performance.now() - tr.t0) / 1000);
    const u = tr.dur > 0 ? tr.t / tr.dur : 1;
    const e = u * u * (3 - 2 * u);
    this.camera.position.lerpVectors(tr.from.pos, tr.to.pos, e);
    this.camera.position.y += Math.sin(Math.PI * u) * tr.bow;
    this.camera.quaternion.copy(tr.from.quat).slerp(tr.to.quat, e);
    this.camera.fov = tr.from.fov + (tr.to.fov - tr.from.fov) * e;
    this.camera.updateProjectionMatrix();
    this.scene.fog.near = tr.from.fog.near + (tr.to.fog.near - tr.from.fog.near) * e;
    this.scene.fog.far = tr.from.fog.far + (tr.to.fog.far - tr.from.fog.far) * e;
    if (tr.t >= tr.dur) { this._endTransit(); return false; }
    return true;
  }

  /** Land the flight where it was always going, at once. */
  _endTransit() {
    if (!this._transit) return;
    const to = this._transit.to;
    this._transit = null;
    this.camera.position.copy(to.pos);
    this.camera.quaternion.copy(to.quat);
    this.camera.fov = to.fov;
    this.camera.updateProjectionMatrix();
    this.scene.fog.near = to.fog.near;
    this.scene.fog.far = to.fog.far;
    this.controls.update();
  }

  /** Is the camera in the middle of a move it is flying rather than cutting? */
  get transitioning() { return !!(this._transit || this._fly); }


  // --------------------------------------------------------------- picking

  /** Median ground elevation across the footprints, metres NAVD88. */
  static _medianBase(data) {
    const attrs = (data.buildings && data.buildings.attrs) || [];
    const v = [];
    for (const a of attrs) {
      const b = a && a.base;
      if (typeof b === 'number' && isFinite(b)) v.push(b);
    }
    if (!v.length) return 0;
    v.sort((x, y) => x - y);
    return v[v.length >> 1];
  }

  /* -------------------------------------------------------- photoreal layer */

  /** Build the layer lazily. No TilesRenderer is constructed and no root tile
   *  request is issued until the user actually switches it on, which is what
   *  keeps the default state free of charge. */
  _ensurePhotoreal() {
    if (this.photoreal) return this.photoreal;
    const meta = this.data.meta;
    const w = meta.aoi.width_m, h = meta.aoi.height_m;
    this.photoreal = new Photoreal({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      meta,
      data: this.data,
      datumM: this.datumM,
      fieldTex: this.groundTex,
      forceCpu: this.forceCpuPhotoreal,
      // The ground texture spans the AOI exactly, centred on the origin, and is
      // drawn north-up — the same rectangle _buildGround gives its plane.
      fieldRect: { x0: -w / 2, y0: -h / 2, w, h },
      // Where the road is under a given world point, relative to the flat
      // datum. The tile shader's street wash falls off with height above the
      // ground, and this layer is the only place in the scene where the ground
      // is not y = 0.
      groundYAt: (x, z) => this._elevOffsetAt(x, -z),
      onAttribution: (list) => { this.onAttribution?.(list); },
      onStatus: (state, detail) => { this.onPhotorealStatus?.(state, detail); },
      // The lookup tables are built on the first tile load, which is after the
      // scene's own first recolour, so the table has to be filled once more the
      // moment it exists or the first tiles paint with an empty LUT.
      onLutReady: () => { this._recolour(); },
    });
    return this.photoreal;
  }

  /** Recreate the streamed tiles when their CPU/GPU performance profile changes.
   * The profile determines decoder queues and LOD targets, so it cannot be
   * safely changed on an already-streaming TilesRenderer. */
  setPhotorealCpuMode(on) {
    const next = Boolean(on);
    if (next === this.forceCpuPhotoreal) return false;
    this.forceCpuPhotoreal = next;
    if (this.photoreal) {
      this.photoreal.dispose();
      this.photoreal = null;
    }
    return true;
  }

  /** Switch the photoreal context layer on or off.
   *
   * Turning it on also moves our own geometry onto true elevations and hides
   * the synthetic ground, backdrop and sky, because all three exist only to
   * substitute for a real world that is now present. Leaving the ground plane
   * in would drive a flat sheet through Google's terrain. */
  async setPhotoreal(on, apiKey) {
    const want = !!on;
    if (want) {
      // Key check stays synchronous and first: the no-key path must not depend
      // on a fetch, and nothing billable may be requested before it passes.
      const key = apiKey || findApiKey();
      if (!key) {
        this.onPhotorealStatus?.('error', 'No Google Maps API key set.');
        return false;
      }
      if (this.data.ensureMassing) {
        this.onPhotorealStatus?.('loading', 'loading massing grids');
        await this.data.ensureMassing();
      }
      const pr = this._ensurePhotoreal();
      if (!pr.enable(key)) return false;
    } else if (this.photoreal) {
      this.photoreal.disable();
    }
    this.photorealOn = want;

    this._useElevation(want);
    if (this.ground) this.ground.visible = !want;
    if (this.backdrop) this.backdrop.visible = !want;
    if (this.streets) this.streets.visible = !want;
    /* The sky stays. It was switched off with the rest of the synthetic world
     * on the reasoning that all of it substitutes for a real one now present —
     * true of the ground plane, the backdrop and the drawn streets, and false
     * of the sky, because Google's tiles contain no sky at all. Without it the
     * slot between two towers is the raw clear colour: one flat grey band in
     * the middle of the frame, in the exact place a street-canyon model has
     * most to say. It cannot interfere with the photograph either — the dome is
     * drawn first, at renderOrder -1000, with depth testing and depth writing
     * both off, so every tile in the frame paints straight over it. */
    this._applySolids();
    if (want) this._recolour();
    return true;
  }

  /* Our extruded prisms and Google's photogrammetry cannot both be drawn.
   *
   * They describe the same buildings with different geometry — ours a flat-lidded
   * prism on the footprint, theirs the measured surface — so wherever they
   * disagree the two interpenetrate: a real roof slices through flat colour, a
   * real wall pokes out of ours, and the seam flickers as the camera moves.
   * There is no offset that fixes it, because the problem is shape, not depth
   * bias.
   *
   * So when the real geometry is present, ours steps aside and the field is
   * projected onto theirs instead (see Photoreal._patchMaterials). The data is
   * unchanged; only the surface carrying it is. `showSolids` exists because
   * comparing the two is the fastest way to check registration by eye. */
  _applySolids() {
    const hide = this.photorealOn && !this.showSolids;
    if (this.facadeMesh) this.facadeMesh.visible = !hide;
    if (this.roofMesh) this.roofMesh.visible = !hide;
  }


  /** Metres the real ground sits above the flat datum at a world point.
   *
   * Zero unless the photoreal layer is on, because without real terrain in the
   * frame the flat datum *is* the ground and shifting the eye would only break
   * a view that was already correct. */
  _elevOffsetAt(x, y) {
    if (!this.photorealOn || !this.data.groundElevAt) return 0;
    return this.data.groundElevAt(x, y) - this.datumM;
  }

  setShowSolids(on) {
    this.showSolids = !!on;
    this._applySolids();
  }

  /** Swap both meshes between the flat datum and true NAVD88 elevations. */
  _useElevation(on) {
    const swap = (mesh, flat, elev) => {
      if (!mesh || !flat || !elev) return;
      const attr = mesh.geometry.getAttribute('position');
      attr.array.set(on ? elev : flat);
      attr.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
      mesh.geometry.computeBoundingBox();
    };
    swap(this.facadeMesh, this.facadePosFlat, this.facadePosElev);
    swap(this.roofMesh, this.roofPosFlat, this.roofPosElev);
    // The plan-view index holds each panel's footprint, and the elevated copy
    // is pushed 0.7 m out along its own normal, so the footprints move.
    this._buildPickIndex();
  }

  /* ------------------------------------------------------ picking index

     Why this exists: three's raycaster has no acceleration structure, so
     asking the facade mesh what is under the pointer was a linear scan over
     588,300 triangles — 15 ms, every frame the pointer moved. The hover
     read-out runs on pointer movement, and pointer movement is exactly when
     the camera is being dragged, so the scene paid a dropped frame for every
     frame of every drag and of every look-around on the street. It was the
     single largest thing making the navigation feel heavy, and it was invisible
     as a bug because nothing was wrong with the picture.

     A uniform grid over the panels fixes it. Panels are vertical, so all ten
     bands of one panel share one footprint in plan and the index only has to
     hold 29,415 entries rather than 294,150. Walking the grid along the ray and
     stopping at the first cell that yields a hit tests a few hundred quads
     instead of every quad in Midtown.
  */

  /** Build the plan-view grid of panel indices. Cheap, and rebuilt whenever the
   *  vertex positions swap between the flat datum and true elevations. */
  _buildPickIndex() {
    const nPan = this.data.facades.n, nBand = this.data.facades.bands;
    const pos = this.facadeMesh.geometry.getAttribute('position').array;
    const x0 = new Float32Array(nPan), x1 = new Float32Array(nPan);
    const z0 = new Float32Array(nPan), z1 = new Float32Array(nPan);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let p = 0; p < nPan; p++) {
      // Corners 0 and 1 of the panel's first quad are its two ends in plan;
      // every band above shares them, and so does the outward-offset copy.
      const o = p * nBand * 12;
      const ax = pos[o], az = pos[o + 2], bx = pos[o + 3], bz = pos[o + 5];
      x0[p] = Math.min(ax, bx); x1[p] = Math.max(ax, bx);
      z0[p] = Math.min(az, bz); z1[p] = Math.max(az, bz);
      if (x0[p] < minX) minX = x0[p];
      if (x1[p] > maxX) maxX = x1[p];
      if (z0[p] < minZ) minZ = z0[p];
      if (z1[p] > maxZ) maxZ = z1[p];
    }
    const CELL = 24;
    const nx = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
    const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);
    const cellOf = (v, lo) => Math.floor((v - lo) / CELL);

    // Counting sort into a CSR layout: one Int32Array of starts and one of
    // panel indices, rather than nx*nz JavaScript arrays.
    const counts = new Int32Array(nx * nz + 1);
    const span = (p, fn) => {
      const cx0 = Math.max(0, cellOf(x0[p], minX)), cx1 = Math.min(nx - 1, cellOf(x1[p], minX));
      const cz0 = Math.max(0, cellOf(z0[p], minZ)), cz1 = Math.min(nz - 1, cellOf(z1[p], minZ));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * nx + cx);
    };
    for (let p = 0; p < nPan; p++) span(p, (c) => { counts[c + 1]++; });
    for (let i = 0; i < nx * nz; i++) counts[i + 1] += counts[i];
    const items = new Int32Array(counts[nx * nz]);
    const cursor = counts.slice(0, nx * nz);
    for (let p = 0; p < nPan; p++) span(p, (c) => { items[cursor[c]++] = p; });

    this._pick = {
      nx, nz, minX, minZ, cell: CELL, starts: counts, items,
      stamp: new Int32Array(nPan), tick: 0,
    };
  }

  /** Nearest facade quad along a ray, or null. Walks the plan grid.
   *
   * Agrees with three's own raycaster on 99.2% of a 500-sample sweep across
   * five camera poses; every disagreement is two panels at an identical
   * distance to thirteen decimal places, which is a party wall shared by two
   * adjacent buildings and modelled twice. Which of two coincident surfaces
   * wins is arbitrary in both implementations.
   */
  _pickFacade(ray) {
    const g = this._pick;
    if (!g) return null;
    const pos = this.facadeMesh.geometry.getAttribute('position').array;
    const nBand = this.data.facades.bands;
    const o = ray.ray.origin, d = ray.ray.direction;
    const far = ray.far;

    // Enter the grid: clip the ray against the index's own plan bounds so a
    // camera outside the city does not march empty cells to get there.
    const loX = g.minX, hiX = g.minX + g.nx * g.cell;
    const loZ = g.minZ, hiZ = g.minZ + g.nz * g.cell;
    let tMin = 0, tMax = far;
    for (const [ov, dv, lo, hi] of [[o.x, d.x, loX, hiX], [o.z, d.z, loZ, hiZ]]) {
      if (Math.abs(dv) < 1e-9) { if (ov < lo || ov > hi) return null; continue; }
      let ta = (lo - ov) / dv, tb = (hi - ov) / dv;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      tMin = Math.max(tMin, ta); tMax = Math.min(tMax, tb);
      if (tMin > tMax) return null;
    }

    const px = o.x + d.x * tMin, pz = o.z + d.z * tMin;
    let cx = Math.min(g.nx - 1, Math.max(0, Math.floor((px - g.minX) / g.cell)));
    let cz = Math.min(g.nz - 1, Math.max(0, Math.floor((pz - g.minZ) / g.cell)));
    const stepX = d.x > 0 ? 1 : -1, stepZ = d.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(d.x) < 1e-9 ? Infinity : Math.abs(g.cell / d.x);
    const tDeltaZ = Math.abs(d.z) < 1e-9 ? Infinity : Math.abs(g.cell / d.z);
    const bx = g.minX + (cx + (stepX > 0 ? 1 : 0)) * g.cell;
    const bz = g.minZ + (cz + (stepZ > 0 ? 1 : 0)) * g.cell;
    let tNextX = Math.abs(d.x) < 1e-9 ? Infinity : (bx - o.x) / d.x;
    let tNextZ = Math.abs(d.z) < 1e-9 ? Infinity : (bz - o.z) / d.z;

    const stamp = g.stamp, mark = ++g.tick;
    let bestT = Infinity, bestQuad = -1;

    while (true) {
      const c = cz * g.nx + cx;
      for (let i = g.starts[c]; i < g.starts[c + 1]; i++) {
        const p = g.items[i];
        if (stamp[p] === mark) continue;
        stamp[p] = mark;
        for (let bnd = 0; bnd < nBand; bnd++) {
          const q = p * nBand + bnd;
          const t = Scene._rayQuad(o, d, pos, q * 12);
          if (t > 0 && t < bestT) { bestT = t; bestQuad = q; }
        }
      }
      const tExit = Math.min(tNextX, tNextZ);
      // Everything in a further cell is further away, so a hit inside this one
      // is final. This is what turns the march into a handful of cells.
      if (bestQuad >= 0 && bestT <= tExit) break;
      if (tExit > tMax) break;
      if (tNextX < tNextZ) { cx += stepX; tNextX += tDeltaX; } else { cz += stepZ; tNextZ += tDeltaZ; }
      if (cx < 0 || cx >= g.nx || cz < 0 || cz >= g.nz) break;
    }
    if (bestQuad < 0 || bestT > far) return null;
    return {
      quad: bestQuad, t: bestT,
      point: new THREE.Vector3(o.x + d.x * bestT, o.y + d.y * bestT, o.z + d.z * bestT),
    };
  }

  /** Möller–Trumbore against the two triangles of one quad, reading the mesh's
   *  own vertices so the flat and elevated positions are both exact. */
  static _rayQuad(o, d, pos, off) {
    const t1 = Scene._rayTri(o, d, pos, off, off + 3, off + 6);
    const t2 = Scene._rayTri(o, d, pos, off, off + 6, off + 9);
    if (t1 > 0 && t2 > 0) return Math.min(t1, t2);
    return t1 > 0 ? t1 : t2;
  }

  static _rayTri(o, d, p, a, b, c) {
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const e1x = p[b] - ax, e1y = p[b + 1] - ay, e1z = p[b + 2] - az;
    const e2x = p[c] - ax, e2y = p[c + 1] - ay, e2z = p[c + 2] - az;
    const hx = d.y * e2z - d.z * e2y;
    const hy = d.z * e2x - d.x * e2z;
    const hz = d.x * e2y - d.y * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    // No back-face cull: these walls are drawn DoubleSide and a camera inside a
    // courtyard has to be able to pick the wall it is looking at.
    if (det > -1e-9 && det < 1e-9) return -1;
    const inv = 1 / det;
    const sx = o.x - ax, sy = o.y - ay, sz = o.z - az;
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }

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
    const wall = this._pickFacade(this.ray);
    // The roof mesh is an eighth the size of the facade mesh and has no
    // vertical structure to index, so three's own scan is fast enough for it.
    const roofs = this.ray.intersectObject(this.roofMesh, false);
    const roof = roofs.length ? roofs[0] : null;
    if (roof && (!wall || roof.distance < wall.t)) {
      return {
        building: this.roofVertBuilding[roof.face.a],
        panel: null, band: null, kind: 'roof', point: roof.point,
      };
    }
    if (!wall) return null;
    return {
      building: this.quadBuilding[wall.quad],
      panel: this.quadPanel[wall.quad],
      band: this.quadBand[wall.quad],
      kind: 'facade',
      point: wall.point,
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
    // Wide percentiles, but over the loaded period rather than the year: a tight
    // window clips the hottest walls, and a year-wide one spends most of the
    // ramp on temperatures this layer never draws. See setPeriod for the
    // measurement behind that, and for why rescaling per period does not break
    // the comparison the instrument actually rests on.
    this.surfaceDomain = Scene._domain(this.data.active.surface, 0.2, 99.8);
    this.airDomain = this.data.active.air
      ? Scene._domain(this.data.active.air, 0.5, 99.5)
      : [this.surfaceDomain[0], this.surfaceDomain[0] + 12];
  }

  setDomains(d) {
    if (d?.surface) this.surfaceDomain = d.surface;
    if (d?.air) this.airDomain = d.air;
    this._recolour();
    this._paintGround();
  }

  //: Which annual per-tile metric pairs with each annual facade layer. The ground
  //: and the walls should be answering the same question: painting a year of
  //: facade dose over a single heat wave's exceedance invites the eye to read one
  //: as the cause of the other.
  static GROUND_FOR_ANNUAL = {
    sun_hours: 'degree_hours_35',
    annual_kh35: 'degree_hours_35',
    annual_dose: 'hours_above_35',
    winter_sun: 'mean_c',
    month_of_peak: 'max_c',
    annual_priority: 'hours_above_35',
  };

  setLayer(layer) {
    this.layer = layer;
    // The ground shows whichever measured field pairs with the chosen facade
    // layer. For the modelled layers it shows exceedance, because that is the
    // measured field with real spatial structure and it grounds the modelled
    // surfaces in something observed. For the annual layers it shows the matching
    // annual tile metric instead.
    this.groundYearLayer = Scene.GROUND_FOR_ANNUAL[layer] || null;
    this.groundLayer = (layer === 'persistence') ? 'persistence'
                     : (layer === 'air') ? 'air'
                     : this.groundYearLayer ? 'year'
                     : 'exceedance';
    this._recolour();
    this._paintGround();
  }

  setHour(h) {
    this.hour = h;
    this._updateSky();
    this._recolour();
    this._paintGround();
  }

  /** The active period or aggregate changed under us. Repaint everything that
   *  reads it, which is the facades, the roofs and the ground.
   *
   * The facade domain is recomputed here, and that is a deliberate change of
   * meaning worth spelling out.
   *
   * main.js used to fix it once, at startup, to the widest range any period
   * could produce — the annual t_min and t_max planes — so that loading a
   * January week could never clip. That is a real requirement and it is why the
   * widening existed. What it cost was measured: over −21.2 to 61.4 °C, the
   * whole city at the peak hour of a July heat wave lands between 0.72 and 0.90
   * of the ramp. Seventeen per cent of the scale for every wall on screen, in
   * the amber-to-cream end of it — which is why Midtown came out a single flat
   * cream and nothing could be told from anything else. Half the ramp was held
   * in reserve for a January north wall that this layer never draws.
   *
   * Recomputing per period keeps the clipping guarantee, because the domain is
   * always the period's own 0.2–99.8 percentiles, and it spends the ramp on the
   * data actually in front of the viewer: the same peak hour now spans 0.39 to
   * 0.89.
   *
   * The invariant main.js was protecting is kept. Its comment asks that the
   * ramp not rescale "as the clock moves", and it does not: the domain is
   * constant across all eight hours of a period, so 03:00 and 15:00 stay
   * directly comparable, which is the comparison the instrument is built on.
   * Loading a different week does rescale it — but that is a deliberate act,
   * not a scrub of the clock, and the legend's own figures move with it, so the
   * change is visible rather than silent.
   */
  setPeriod() {
    this.surfaceDomain = Scene._domain(this.data.active.surface, 0.2, 99.8);
    if (this.data.active.air) {
      this.airDomain = Scene._domain(this.data.active.air, 0.5, 99.5);
    }
    this._updateSky();
    this._recolour();
    this._paintGround();
  }

  /** Highlight a set of building indices — what the analyst uses to point.
   *
   *  Distinct from `select`, which is one building and opens its dossier. A
   *  highlight is a set and carries no dossier, because "these fourteen" is the
   *  answer to a different kind of question. */
  setHighlight(indices) {
    this.highlighted = (indices && indices.length) ? new Set(indices) : null;
    this._recolour();
  }

  /** The 1-99 percentile domain of an annual plane, cached per plane. */
  annualDomain(plane) {
    if (!plane) return [0, 85];
    this._annualDomains = this._annualDomains || {};
    if (!this._annualDomains[plane]) {
      const arr = this.data.annual[plane];
      if (!arr) return [0, 1];
      const stride = Math.max(1, Math.floor(arr.length / 60000));
      const s = [];
      for (let i = 0; i < arr.length; i += stride) if (isFinite(arr[i])) s.push(arr[i]);
      s.sort((a, b) => a - b);
      this._annualDomains[plane] = s.length
        ? [s[Math.floor(0.01 * (s.length - 1))], s[Math.floor(0.99 * (s.length - 1))]]
        : [0, 1];
    }
    return this._annualDomains[plane];
  }

  _recolour() {
    const d = this.data;
    const nBand = d.facades.bands;
    const arr = this.facadeColors.array;

    // Only pay for the projection table when something is going to read it.
    const pr = this.photorealOn && this.photoreal && this.photoreal.beginLut()
      ? this.photoreal : null;
    const lutSum = pr ? pr.lutSum : null;
    const lutCount = pr ? pr.lutCount : null;
    const lutT = pr ? pr.lutT : null;
    const aggPeak = pr ? pr.aggPeak : null;
    const layer = this.layer;
    // Which annual plane, if any, this layer paints. Resolved once per repaint
    // rather than per quad: 294,150 string comparisons per frame is not free.
    const annualPlane = {
      sun_hours: 'sun_hours', annual_kh35: 'degree_hours_35',
      annual_dose: 'dose_kwh', winter_sun: 'winter_sun_share',
      month_of_peak: 'month_of_max',
    }[layer] || null;
    const annualArr = annualPlane ? d.annual[annualPlane] : null;
    const annualDom = annualPlane ? this.annualDomain(annualPlane) : null;

    const dom = layer === 'air' ? this.airDomain : this.surfaceDomain;
    const f = (layer === 'priority' || layer === 'annual_priority') ? RAMPS.priority
      : (layer === 'winter_sun') ? RAMPS.diverging
      : (layer === 'sun_hours' || layer === 'annual_kh35'
         || layer === 'annual_dose') ? RAMPS.duration
      : RAMPS.temperature;
    // The duration layers read their value from the tile under each address
    // rather than from the panel, and against their own domain rather than the
    // temperature one.
    const durField = (layer === 'exceedance' || layer === 'persistence') ? layer : null;
    const durSample = durField ? this._panelField(durField) : null;
    const durDom = durField ? this._durationDomain(durField) : null;

    // Selection highlight: everything not selected desaturates, so the chosen
    // building stands out without changing its data colour. A highlight SET does
    // the same for several buildings at once, which is what the analyst uses to
    // point at an answer.
    const sel = this.selected;
    const hi = this.highlighted;

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
      /* The same value the colour was chosen from, on its own 0..1 domain.
       *
       * Carried because the photoreal shader now decides *whether* to paint a
       * surface, not only what colour to paint it, and a threshold needs a
       * quantity. Recovering it from the colour is nearly possible — the ramp
       * is monotonic in lightness — and "nearly" is not a basis for a rule that
       * silently drops surfaces. Sun and shade is categorical, so it takes the
       * two ends of the domain it is already drawn with. */
      let tv;
      if (layer === 'priority' || layer === 'annual_priority') {
        const bi = this.quadBuilding[q];
        const a = d.buildings.attrs[bi];
        const v = layer === 'priority' ? a?.pr : a?.apr;
        tv = norm(v !== undefined ? v : NaN, 0, 85);
        c = f(tv);
      } else if (annualArr) {
        // An annual total. No hour, no day: the same value whatever the clock
        // says, which is why the time controls grey out while one is showing.
        tv = norm(annualArr[p * nBand + b], annualDom[0], annualDom[1]);
        c = f(tv);
      } else if (layer === 'air') {
        tv = norm(d.airAt(this.hour, p, b), dom[0], dom[1]);
        c = f(tv);
      } else if (layer === 'sun') {
        const lit = d.sunlitAt(this.hour, p, b);
        tv = lit ? 1 : 0;
        c = lit ? SUNLIT_RGB : SHADE_RGB;
      } else if (durField) {
        tv = norm(durSample[p], durDom[0], durDom[1]);
        c = f(tv);
      } else {
        tv = norm(d.surfaceAt(this.hour, p, b), dom[0], dom[1]);
        c = f(tv);
      }
      let sh = this.quadAO[q];
      /* The directional lift applies only where the value on the wall is this
         hour's value.
         
         On the two hourly layers it is doing real work: it makes the faces that
         look brightest the faces the sun is actually on, so the form the eye
         reads agrees with the physics. Anywhere else it is at best decoration
         and at worst a lie — a 38% boost keyed to the solar azimuth on a
         seven-day total says the sun's position this afternoon matters to a
         figure that covers a week — and it costs real data either way, because a
         38% lift on top of the pale end of the ramp clips to flat white. On
         sun-and-shade it was also simply redundant: the colour there is already
         categorical. Those layers keep the baked ambient occlusion, which is
         geometry rather than a claim about the hour. */
      if (sunUp && (layer === 'surface' || layer === 'air')) {
        const facing = Math.max(0, this.quadNX[q] * sx + this.quadNZ[q] * sz);
        const lit = d.sunlitAt(this.hour, p, b) ? 1 : 0;
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
      const dimmed = (sel !== null && this.quadBuilding[q] !== sel)
        || (sel === null && hi && !hi.has(this.quadBuilding[q]));
      if (dimmed) {
        r *= DIM; g *= DIM; bl *= DIM;
      } else if (hi && hi.has(this.quadBuilding[q])) {
        // Lift the highlighted set rather than only dimming the rest: on a dark
        // scene a set of fourteen buildings picked out by dimming five thousand
        // others is a set nobody can find.
        r = Math.min(1, r * 1.18 + 0.05);
        g = Math.min(1, g * 1.14 + 0.05);
        bl = Math.min(1, bl * 1.05);
      }
      const o = q * 12;
      for (let k = 0; k < 4; k++) { arr[o + k * 3] = r; arr[o + k * 3 + 1] = g; arr[o + k * 3 + 2] = bl; }

      // Accumulate the projection lookup from the very same numbers. Deriving
      // it here rather than in a second pass is deliberate: a separate
      // implementation of the ramp, the shading and the contrast curve would
      // drift, and the projected colour would stop agreeing with the geometry's
      // colour in ways nobody would notice until a screenshot looked wrong.
      if (lutSum !== null) {
        const bIdx = this.quadBuilding[q];
        if (bIdx >= 0) {
          const cell = (bIdx * 8 + this.panelBucket[p]) * nBand + b;
          const s3 = cell * 3;
          lutSum[s3] += r; lutSum[s3 + 1] += g; lutSum[s3 + 2] += bl;
          lutCount[cell]++;
          const t = isFinite(tv) ? tv : 0;
          lutT[cell] += t;
          // The building's aggregate is its peak, not its mean. A tower with one
          // scorching west flank and three cool ones is a tower worth marking,
          // and averaging is exactly the operation that would hide it.
          if (t > aggPeak[bIdx]) aggPeak[bIdx] = t;
        }
      }
    }
    this.facadeColors.needsUpdate = true;
    if (lutSum !== null) {
      this.photoreal.commitLut();
      this._commitAggregate(pr, f);
    }
    this._recolourRoofs();
  }

  /** One row per building: the ramp colour at its peak facade value.
   *
   * This is what the photoreal layer paints on roofs from altitude, where a
   * whole building is twenty pixels wide and a per-band, per-orientation field
   * is resolving a distinction no pixel can hold. One flat colour per building
   * is the most legible thing that can be put in those twenty pixels.
   *
   * Filled here, from the ramp function this repaint is already using, for the
   * same reason the facade table is: a second implementation of the ramp in
   * GLSL would drift from this one, and the drift would surface as a screenshot
   * that looked subtly wrong months later. Alpha is the peak value offset by
   * one, so zero keeps its meaning of "no panel of this building was ever
   * solved" — which is a different claim from "its peak is at the bottom of the
   * domain", and painting the two alike would invent data.
   */
  _commitAggregate(pr, f) {
    const buf = pr.aggBuf, peak = pr.aggPeak;
    for (let i = 0, n = peak.length; i < n; i++) {
      const o = i * 4;
      const t = peak[i];
      if (!(t >= 0)) { buf[o + 3] = 0; continue; }
      const c = f(t);
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
      buf[o + 3] = 1 + Math.min(254, Math.round(t * 254));
    }
    pr.commitAgg();
  }

  _recolourRoofs() {
    const d = this.data;
    const arr = this.roofColors.array;
    const sel = this.selected;
    const dom = this.layer === 'air' ? this.airDomain : this.surfaceDomain;
    const rDurField = (this.layer === 'exceedance' || this.layer === 'persistence')
      ? this.layer : null;
    const rDurSample = rDurField ? this._buildingField(rDurField) : null;
    const rDurDom = rDurField ? this._durationDomain(rDurField) : null;

    const annualPlane = {
      sun_hours: 'sun_hours', annual_kh35: 'degree_hours_35',
      annual_dose: 'dose_kwh', winter_sun: 'winter_sun_share',
      month_of_peak: 'month_of_max',
    }[this.layer] || null;
    const annualArr = annualPlane ? d.annual[annualPlane] : null;
    const annualDom = annualPlane ? this.annualDomain(annualPlane) : null;
    const annualRamp = (this.layer === 'winter_sun') ? RAMPS.diverging
      : (this.layer === 'sun_hours' || this.layer === 'annual_kh35'
         || this.layer === 'annual_dose') ? RAMPS.duration
      : RAMPS.temperature;
    const hi = this.highlighted;
    const nBand = d.facades.bands;

    for (let i = 0; i < this.roofRange.length; i++) {
      const [start, n] = this.roofRange[i];
      if (!n) continue;
      const a = d.buildings.attrs[i];
      let c;
      if (this.layer === 'priority' || this.layer === 'annual_priority') {
        const v = this.layer === 'priority' ? a?.pr : a?.apr;
        c = RAMPS.priority(norm(v !== undefined ? v : NaN, 0, 85));
      } else if (annualArr) {
        // The roof takes the mean of its own building's top-band values, which is
        // the closest solved quantity to roof level in an annual plane.
        const ps = d.panelsOfBuilding.get(i);
        let sum = 0, cnt = 0;
        if (ps) {
          for (const p of ps) {
            const v = annualArr[p * nBand + (nBand - 1)];
            if (isFinite(v)) { sum += v; cnt++; }
          }
        }
        c = annualRamp(norm(cnt ? sum / cnt : NaN, annualDom[0], annualDom[1]));
      } else if (this.layer === 'sun') {
        c = SUNLIT_RGB;   // roofs are always the most exposed surface
      } else if (rDurField) {
        c = RAMPS.duration(norm(rDurSample[i], rDurDom[0], rDurDom[1]));
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
      const dimmed = (sel !== null && i !== sel) || (sel === null && hi && !hi.has(i));
      if (dimmed) {
        r *= DIM; g *= DIM; bl *= DIM;
      } else if (hi && hi.has(i)) {
        r = Math.min(1, r * 1.18 + 0.05);
        g = Math.min(1, g * 1.14 + 0.05);
        bl = Math.min(1, bl * 1.05);
      }
      for (let k = 0; k < n; k++) {
        const o = (start + k) * 3;
        arr[o] = r; arr[o + 1] = g; arr[o + 2] = bl;
      }
    }
    this.roofColors.needsUpdate = true;
  }

  /* ------------------------------------------------- ground-field samples

     The two duration layers live on the 60 m tile grid. Both the facades and the
     roofs read them through a sample taken at the address, so one legend covers
     the whole frame — see the note on `tileValueAt` in data.js for why that is a
     join rather than an invention.

     Cached per field. There are 29,415 panels and the lookup is a couple of
     divisions, so building it costs nothing; doing it inside the recolour loop
     on every hour tick would not. */

  _panelField(field) {
    this._pf = this._pf || {};
    if (this._pf[field]) return this._pf[field];
    const { facades } = this.data;
    const xy = facades.xy;
    const out = new Float32Array(facades.n);
    for (let p = 0; p < facades.n; p++) {
      out[p] = this.data.tileValueAt(field, xy[p * 4], xy[p * 4 + 1]);
    }
    this._pf[field] = out;
    return out;
  }

  _buildingField(field) {
    this._bf = this._bf || {};
    if (this._bf[field]) return this._bf[field];
    const n = this.data.buildings.attrs.length;
    const out = new Float32Array(n).fill(NaN);
    const xy = this.data.facades.xy;
    for (let i = 0; i < n; i++) {
      const ps = this.data.panelsOfBuilding.get(i);
      if (!ps || !ps.length) continue;
      let x = 0, y = 0;
      for (const p of ps) { x += xy[p * 4]; y += xy[p * 4 + 1]; }
      out[i] = this.data.tileValueAt(field, x / ps.length, y / ps.length);
    }
    this._bf[field] = out;
    return out;
  }

  /** The domain a duration layer is drawn against — the field's own, which is
   *  also what the legend prints. */
  _durationDomain(field) {
    const st = this.data.tiles.stats?.[field];
    return st ? [st.min, st.max] : [0, 1];
  }

  select(buildingIndex) {
    this.selected = buildingIndex;
    this._placePin(buildingIndex);
    this._recolour();
  }

  focus(buildingIndex) {
    const a = this.data.buildings.attrs[buildingIndex];
    if (!a) return;
    // Whatever is already flying loses the camera here.
    //
    // Without this, a building picked while the opening fly-in is still running
    // is framed for one frame and then overwritten every frame until the flight
    // ends — and the flight ends at the overview, so the selection silently
    // undoes itself and the camera sits a mile up. It is invisible in normal
    // use because nobody clicks during the three seconds the flight lasts; it
    // is not invisible in the walkthrough, whose third chapter selects a
    // building the instant the descent hands over.
    this._abortFly(true);
    const from = this._modePose();
    const ps = this.data.panelsOfBuilding.get(buildingIndex);
    let x = 0, y = 0;
    if (ps && ps.length) {
      const xy = this.data.facades.xy;
      for (const p of ps) { x += xy[p * 4]; y += xy[p * 4 + 1]; }
      x /= ps.length; y /= ps.length;
    }
    const h = a.h;
    // No transition from setView: it would fly to the pose the view implies,
    // which is not the pose this method is about to set. The flight is started
    // here instead, once the camera is where the building wants it.
    this.setView(null, { animate: false });
    this.controls.target.set(x, Math.min(h * 0.55, 140), -y);
    const dist = Math.max(150, h * 2.4);
    this.camera.position.set(x + dist * 0.75, h * 1.05 + 90, -y + dist * 0.75);
    this.controls.update();
    this._beginTransit(from);
  }

  /** Back to the opening view.
   *
   * The design puts a RESET VIEW control at the head of the camera block, and
   * it has to mean the same thing every time it is pressed: not "re-frame
   * whatever I am looking at" but "put the camera back where it started". So it
   * restores
   * the constructor's position and target verbatim rather than deriving
   * anything from the current view, and it cancels an opening flight in
   * progress, which would otherwise carry on and overwrite it a frame later.
   */
  resetView() {
    this._abortFly(true);
    const from = this._modePose();
    this.setView(null, { animate: false });
    this.camera.position.set(-1500, 1250, 1750);
    this.controls.target.set(0, 20, 0);
    this.scene.fog.near = FOG_ORBIT.near;
    this.scene.fog.far = FOG_ORBIT.far;
    this.controls.update();
    // Flown, not cut, for the same reason the mode change is: the control
    // means "put the camera back where it started", and watching it travel
    // there is what tells you where you had got to.
    this._beginTransit(from);
  }

  /** Frame the whole study area, close enough that it is still there.
   *
   * `resetView` restores the constructor's pose, which is 2,613 m from the
   * middle of the city — and `_orbitFog` puts the fog's near plane at 2,412 at
   * that distance, so the near edge of Midtown starts fading on the frame it
   * appears in and the far side is gone entirely. As an opening state that is
   * survivable, because the first thing anyone does is scroll. As a shot in a
   * film it is a black rectangle: the walkthrough's fourth chapter opens on
   * "every wall in Midtown has an answer like that" over nothing at all.
   *
   * So this is the same idea from 1,520 m, where the whole study area sits
   * inside the near plane and reads as a city. Flown rather than cut, for the
   * same reason `resetView` is — watching the camera travel is what connects
   * the building it was just looking at to the field it is part of.
   */
  overview({ animate = true } = {}) {
    this._abortFly(true);
    const from = this._modePose();
    this.setView(null, { animate: false });
    this.camera.position.set(-900, 700, 1050);
    this.controls.target.set(0, 60, 0);
    this.controls.update();
    this._orbitFog();
    if (animate) this._beginTransit(from);
  }

  // -------------------------------------------------------------- fly-in

  /** The descent the opening film hands over to.
   *
   * Interpolating the camera position directly would draw a straight line
   * through the air, which reads as a dolly on rails. Interpolating the offset
   * from the look-at point in *spherical* coordinates instead keeps the city
   * centred while the camera loses altitude and swings around it, which is what
   * an aerial shot actually does. The extra `swing` term bows the azimuth out
   * and back so the arc is not a monotonic turn either.
   *
   * Fog has to be animated along with it. The default near/far pair is tuned
   * for an eye-level view a couple of kilometres out; left alone at five
   * kilometres up it renders the entire city as flat fog colour, so the film
   * would cross-fade into an empty grey frame.
   */
  flyIn({ seconds = 9, from = null } = {}) {
    // Never animated: this method IS the animation, and a mode transition
    // would own the camera in the frame loop ahead of it.
    this.setView(null, { animate: false });
    const to = {
      pos: new THREE.Vector3(-1500, 1250, 1750),
      target: new THREE.Vector3(0, 40, 0),
    };
    const toSph = new THREE.Spherical().setFromVector3(to.pos.clone().sub(to.target));
    // The default start is the one the film lands on, written the other way
    // round: 3,400 m out at 0.34 off the vertical. It is only used when nothing
    // hands a pose in — a film that could not load its imagery, or a call from
    // the console. When the film does hand one in, `from` is literally where its
    // camera is at that instant, so this flight continues a move already in
    // progress rather than starting a new one.
    from = from || {
      target: new THREE.Vector3(0, 60, 0),
      sph: new THREE.Spherical(3400, 0.34, toSph.theta - 0.85),
      fog: { near: 3200, far: 20000 },
    };
    this._fly = {
      t: 0, t0: performance.now(), dur: seconds,
      // No bow in the azimuth when the film hands over: the camera is already
      // moving on a line the viewer has been watching for five seconds, and
      // swinging it out and back at the join is the one thing that would make
      // the join visible.
      swing: from.swing ?? 0.22,
      fromTarget: from.target, toTarget: to.target,
      fromSph: from.sph, toSph,
      fog: [from.fog || { near: 3200, far: 20000 }, { ...FOG_ORBIT }],
      cur: from.target.clone(),
    };
    this.controls.enabled = false;
    this._stepFly();
    return seconds;
  }

  _stepFly() {
    const f = this._fly;
    if (!f) return;
    // Wall clock rather than accumulated frame time, for the same reason the
    // film uses one: this descent runs underneath narration that the platform
    // speaks in real seconds. Clamped frame deltas on a slow renderer would
    // stretch a ten-second flight into two minutes and leave the camera still
    // falling long after the closing caption.
    f.t = Math.min(f.dur, (performance.now() - f.t0) / 1000);
    const u = f.dur > 0 ? f.t / f.dur : 1;
    const e = u * u * (3 - 2 * u);
    const mix = (a, b) => a + (b - a) * e;

    const tgt = f.cur.lerpVectors(f.fromTarget, f.toTarget, e);
    let dth = f.toSph.theta - f.fromSph.theta;
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    const off = new THREE.Vector3().setFromSphericalCoords(
      mix(f.fromSph.radius, f.toSph.radius),
      mix(f.fromSph.phi, f.toSph.phi),
      f.fromSph.theta + dth * e + Math.sin(Math.PI * u) * f.swing
    );
    this.camera.position.copy(tgt).add(off);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(tgt);

    this.scene.fog.near = mix(f.fog[0].near, f.fog[1].near);
    this.scene.fog.far = mix(f.fog[0].far, f.fog[1].far);

    if (f.t >= f.dur) {
      this._fly = null;
      this.controls.target.copy(f.toTarget);
      this.controls.enabled = true;
      this.controls.update();
    }
  }

  /** Stop the descent. Direct input cancels immediately so its first gesture
   * is never swallowed; programmatic cancellation may retain the short settle. */
  _abortFly(immediate = false) {
    const f = this._fly;
    if (!f || f.t >= f.dur - 0.05) return;
    if (immediate) {
      this._fly = null;
      this.controls.target.copy(f.cur);
      this.controls.enabled = true;
      this.scene.fog.near = FOG_ORBIT.near;
      this.scene.fog.far = FOG_ORBIT.far;
      this.controls.update();
      return;
    }
    const remaining = 0.7;
    f.fromTarget = f.cur.clone();
    f.fromSph = new THREE.Spherical().setFromVector3(
      this.camera.position.clone().sub(f.cur));
    f.fog[0] = { near: this.scene.fog.near, far: this.scene.fog.far };
    f.swing = 0;
    f.dur = remaining;
    f.t = 0;
    f.t0 = performance.now();
  }

  // ------------------------------------------------------------------ loop

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick(dt) {
    // A flight owns the camera outright while it runs, so it is checked before
    // anything else: the orbit controls' update would otherwise drag the camera
    // back to their end of the move on the very frame it started.
    if (this._transit && !this._descent) {
      this._stepTransit();
      if (this.photorealOn && this.photoreal) this.photoreal.update();
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this._descent) {
      // The opening film owns the camera outright here — see setDescentPose.
      // Nothing in this loop may touch it, including the boundary clamp, which
      // is written for a camera inside the study area and would drag one that
      // is sixty kilometres above it straight back down.
    } else if (this._fly) {
      // OrbitControls damps toward its own idea of where the camera should be,
      // so it must not run while the flight owns the transform.
      this._stepFly();
    } else {
      this.controls.update();
      // Touch pan and cursor zoom still pass through MapControls, so apply the
      // same boundary invariant after its update.
      this._clampOrbitView();
      this._orbitFog();
    }
    if (this.photorealOn && this.photoreal) this.photoreal.update();
    // The sky rides with the eye. A fixed 9 km sphere works from inside the
    // study area and nowhere else — the opening descent starts sixty kilometres
    // up, outside it, where a static sphere would render as a ball of sky
    // hanging in front of the camera. Re-centring it also lets the vertex
    // shader treat a vertex offset as the view ray through it.
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}

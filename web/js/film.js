/* The opening film.
 *
 * A short documentary that runs before the application: a globe, the real
 * warming record drawn on top of it, the cities lighting up, and then a dive
 * through the atmosphere into the Midtown model the rest of the app is about.
 *
 * Design notes worth keeping:
 *
 * - It renders into its **own** canvas and its own WebGLRenderer, stacked over
 *   the application's. Sharing one renderer between a globe and a city means
 *   sharing one scene graph, one fog, one camera rig and one set of shaders,
 *   all of which want opposite settings. Two contexts cost one extra canvas for
 *   about ninety seconds, and the film's renderer is disposed the moment the
 *   handoff finishes, so the steady state is exactly what it was before.
 *
 * - There is no transition. The film descends the whole way — from thirty-four
 *   thousand kilometres to three, without a stall — and the application's camera
 *   is driven from the film's own descent while it does, so the two renderers
 *   are showing the same viewpoint of the same place at the same moment. What
 *   used to be a cross-fade between two different shots is now a dissolve
 *   between two materials of one shot: the photograph becomes the model, the
 *   buildings stand up out of it, and the camera never stops moving.
 *
 *   That needed two things. The descent is parameterised in ALTITUDE, not in
 *   globe radii, and interpolated geometrically, so the perceived rate of zoom
 *   is constant instead of grinding to a halt in the last two seconds — a
 *   linear approach to a surface looks like an approach that gives up. And it
 *   needed something to look at below ten kilometres per pixel, which is where
 *   the land mask runs out: hence `_buildApproach`, a five-level satellite
 *   pyramid baked by scripts/fetch_approach.py, whose two finest levels are the
 *   same two images the application lays on its own ground for the handover.
 *
 * - Nothing about the timing is hard-coded to seconds. Each beat is as long as
 *   its sentence takes to say, and the camera interpolates across whatever that
 *   turns out to be, so editing the narration cannot desynchronise the visuals.
 *   That matters because the sentences are generated from the data.
 *
 * - Speech is an enhancement, never a dependency. Plenty of installs have no
 *   voices at all (headless Chromium has none, which is also how the test suite
 *   sees this file), so captions carry the whole script on their own and the
 *   pacing tightens when there is nothing to wait for.
 *
 * - The narration is a real read. voice.js fetches the script from the server
 *   as ElevenLabs audio, cached to disk so a play costs nothing after the first,
 *   and the film falls back to `speechSynthesis` **per line** — not per film —
 *   for anything it did not get. The stated beat lengths are unchanged by any of
 *   it: a recording that runs long is hurried a few percent to fit its shot, and
 *   the runtime on the title card is the same whether the voice is Daniel, the
 *   platform's, or nothing at all.
 */

import * as THREE from 'three';
import { buildStory } from './story.js';
import { Narrator } from './voice.js';
import { RAMPS, css } from './colors.js';

const $ = (id) => document.getElementById(id);

/** Globe radius, in the film's own units. Everything else is a multiple. */
const R = 100;

/** Top of the atmosphere shell, as a multiple of R. R is 6,371 km, so this
 *  is 573 km up. `_animate`'s air fade has to finish above it — see there. */
const ATMO = 1.09;

/** The heat ramp, as GLSL — the same stops, at the same positions, as
 *  `CANYON` in colors.js.
 *
 * It has to be the same ramp. The film's last act cross-fades a warming globe
 * into the live model, and for a few seconds both are on screen: if the planet
 * is painted with one temperature ramp and the facades with another, the cut is
 * a cut in the colour language as well as in the camera, and the viewer has to
 * learn the legend twice. The stops here are uneven, exactly as they are in
 * colors.js — 0.22, 0.45, 0.68, 0.86 — because a resampled approximation of them
 * drifts, and drift is what makes two implementations of one ramp disagree in
 * the frame where they overlap.
 */
const RAMP_GLSL = `
vec3 heatRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.071, 0.063, 0.118);
  vec3 c1 = vec3(0.243, 0.102, 0.251);
  vec3 c2 = vec3(0.533, 0.180, 0.235);
  vec3 c3 = vec3(0.780, 0.376, 0.165);
  vec3 c4 = vec3(0.910, 0.651, 0.306);
  vec3 c5 = vec3(0.969, 0.906, 0.745);
  if (t < 0.22) return mix(c0, c1, t / 0.22);
  if (t < 0.45) return mix(c1, c2, (t - 0.22) / 0.23);
  if (t < 0.68) return mix(c2, c3, (t - 0.45) / 0.23);
  if (t < 0.86) return mix(c3, c4, (t - 0.68) / 0.18);
  return mix(c4, c5, (t - 0.86) / 0.14);
}`;

/** Cheap value noise, for the cloud shell. Good enough at this distance and it
 *  keeps the dive from dissolving into a blurry texture: the land mask runs out
 *  of resolution around 10 km per pixel, and procedural cloud does not. */
const NOISE_GLSL = `
float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}`;

/** The state the scene interpolates through. A beat's `stage` block in story.js
 *  overrides some of these; everything unmentioned holds its previous value. */
/** Where the globe is facing when the film opens, as a rotation about its axis.
 *
 *  This is not decoration. The spin rates in the storyboard carry the globe
 *  through roughly a hundred degrees before it locks onto New York, and if it
 *  starts in the wrong place the chapter about cities plays out over the empty
 *  middle of the Pacific — which is exactly what the first cut did. Opening on
 *  south and east Asia puts the densest part of the city list under the camera
 *  when the lights come up, and drifts west through Europe and the Atlantic to
 *  arrive at the Americas just as the narration does.
 */
/** Where the idle globe behind the title card sits when the page opens. The
 *  film does not inherit it — see TURN_ONTO_SITE. */
const SPIN0 = -186 * Math.PI / 180;

/** How far the earth turns, in radians, between the film's first frame and the
 *  moment the study area is square to the camera.
 *
 * The turn onto New York is the film's opening move and it is authored, not
 * emergent. An accumulated free spin cannot be: where the globe has got to by
 * the time the lock begins depends on how long the title card sat there, so the
 * remaining angle was anything between nothing and a full revolution, and the
 * old code covered that by slerping to the answer — which took the short way
 * round and therefore, about half the time, ran the planet backwards.
 *
 * Planning it instead fixes both. The film opens with the site exactly this far
 * short of facing the camera and closes the angle over the first three beats, so
 * the rotation is one direction, one authored speed, every time. A little under
 * sixty degrees: slow enough to read as a planet turning rather than a globe
 * being spun, wide enough that New York visibly comes round rather than
 * already being there. */
const TURN_ONTO_SITE = 1.0;

/** Globe units per kilometre. R units is one earth radius. */
const UNITS_PER_KM = R / 6371;

/** Where the descent ends, and therefore where the application begins.
 *
 * These three numbers are the whole handover. They are the study area's own
 * east-north-up frame — the frame scene.js works in — so the pose the film
 * finishes on can be handed to the application's camera verbatim, with no
 * projection between them and nothing to drift. They are also, deliberately,
 * scene.js's opening view: 3,265 m up, 1,134 m west, which is
 * `new Spherical(3400, 0.34, …)` written the other way round.
 */
const LANDING = { alt_km: 3.265, phi: 0.3340, az: -1.5831 };

const STAGE0 = {
  alt: 34400,    // camera altitude above the surface, kilometres
  fov: 27,
  tilt: 0.14,    // camera elevation above the equatorial plane, radians
  turn: 0,       // progress along the planned turn onto the study area, 0..1
  heat: 0,       // warming tint, 0..1
  cities: 0,     // how many of the world's cities have lit
  bloom: 0,      // city-light pulsing
  lock: 0,       // how firmly the globe is held with New York facing us
  aim: 0.12,     // where on screen the locked point sits, up from centre
  phi: 0.05,     // how far off the vertical the descent stands, radians
  az: LANDING.az, // which way it stands off, radians clockwise from north
  pin: 0,        // New York marker
  clouds: 0,
  dust: 0,       // atmospheric streaking during the dive
  counter: 0,    // progress along the GISTEMP series
};

/** Which channels are interpolated in the log domain rather than linearly.
 *
 * Altitude, and only altitude. Halving the height above a city doubles what it
 * fills of the frame, so a camera that loses height at a constant rate appears
 * to accelerate wildly and then stop dead; one that loses it at a constant
 * *ratio* appears to move at a constant speed. This is the single change that
 * turns the old arrive-and-stall into a fall.
 */
const LOG_CHANNELS = new Set(['alt']);

/** When each level of the satellite pyramid comes up, in kilometres of
 *  altitude: [start fading in, fully in]. Each is chosen so the level is still
 *  sharper than the screen when it arrives and still wider than the frame when
 *  the next one takes over, which is what makes the chain seamless. Once a
 *  level is in it stays in — the coarse ones hold the corners of the frame
 *  long after the fine ones have taken the middle. */
const APPROACH_FADE = {
  l0: [6200, 2600],
  l1: [2800, 1050],
  l2: [950, 350],
  l3: [320, 112],
  l4: [92, 33],
  l5: [33, 12],
};

/* Every level is faded out RADIALLY, toward a disc inscribed in its own square.
 *
 * A level comes up at roughly twice the height at which it covers the frame, so
 * for a second or two its border is inside the shot — and a rectangular border
 * is the one shape the eye cannot help reading as an edit. A square feathered
 * on its four sides is still a square. A disc is not a shape at all: it reads as
 * the picture simply being sharper in the middle, which is what a real descent
 * through progressively finer imagery looks like anyway.
 *
 * The fade runs from 0.70 to 0.98 of the inscribed radius, which also keeps the
 * outer tenth of every mosaic off screen. That tenth is where the imagery is
 * least trustworthy — it is where NAIP's coverage frays into the sea and where
 * a bounding box picks up captures from a different season — so retiring it
 * early costs nothing the level beneath cannot supply. */
const FEATHER_IN = 0.50;
const FEATHER_OUT = 0.98;

/* 0.50, not 0.70, and both numbers are the answer to the same complaint.
 *
 * The pyramid's job is to be invisible: what should read is one fall through
 * one continuous picture, not six pictures taking turns. Two things gave the
 * turns away, and the second is why these bands are half again as wide as they
 * were and why the feather now starts at half the radius rather than at seven
 * tenths.
 *
 * The first was the mosaics themselves — l3's sea came back paved in flight
 * lines, which is fixed in scripts/fetch_approach.py rather than here.
 *
 * The second is subtler and survives perfect mosaics: two levels can be matched
 * on their shared *mean* (which is what chain_gains does) and still differ in
 * how that mean is distributed, so where one level's disc lies over the next
 * there is a step. Over a narrow feather that step is an edge — a visible
 * circle in the middle of the frame, which the eye reads as a lens, not as
 * ground. Spread over half the radius it is a gradient, and a gradient across a
 * continent is weather. Nothing is lost but a little of each level's sharp
 * core, and the levels arrive at about twice the height at which they cover the
 * frame, so there is core to spare.
 */

/** How long the dissolve into the application lasts, in seconds.
 *
 * Long, and it is now the whole handover rather than the last moment of one.
 *
 * It used to be 1.3 seconds and deliberately late, because by the time it
 * started both renderers were looking at the same square kilometre of Midtown
 * from the same point in the air — a dissolve between two materials, not
 * between two shots. That is a better idea than this one and it is gone for a
 * reason that has nothing to do with quality: being one camera means travelling
 * the whole way down, and travelling it at a speed the eye can follow costs
 * fifteen seconds of a sixty second film, spent on ground the study says
 * nothing about.
 *
 * So this is a dissolve between two shots after all, and the length is what
 * makes it read as one move: the globe is still scaling when it starts to go,
 * the application is already descending when it arrives, and for two seconds
 * both are on screen travelling the same way. Shorter than that and the eye
 * catches the swap; longer and the double exposure is legible as one. */
const HANDOVER_S = 2.0;

/** Master level for the score. Loud enough to be part of the film rather than a
 *  rumour of one, and still well under the narration it sits beneath. */
const SCORE_LEVEL = 0.55;

/** How far the score drops under a spoken line. Not silence: the drone is what
 *  holds the shots together, and a bed that vanishes whenever anyone talks makes
 *  every caption sound like a different film. */
const DUCK = 0.42;

/** How warm the planet is behind the title card, before the film starts. */
const IDLE_HEAT = 0.45;

/** M:SS, the only clock format the transport bar uses. */
const clock = (sec) => {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Re-run a CSS animation from the start. Used for the caption and the chapter
 *  mark, both of which change their text in place and have to re-enter rather
 *  than swapping silently. */
const restart = (el, anim) => {
  if (!el) return;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = anim;
};
const ENTER = 'hcCap 760ms cubic-bezier(0.16,1,0.3,1) both';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (t) => t * t * (3 - 2 * t);
const easeIn = (t) => t * t;

/** Constant rate, then a landing.
 *
 * The descent has to hold one speed for most of a beat and arrive without
 * slamming into the ground, and `smoothstep` cannot do that — it is slow at
 * both ends, and slow at the *start* of the last beat is exactly the stall this
 * whole rewrite exists to remove. So: a constant slope up to `a`, then a
 * straight ramp of that slope down to zero at the end. The opening slope is
 * 2/(1+a) rather than 1 because the decelerating tail covers only half the
 * ground its length would suggest, and the two pieces are C1 at the join, so
 * there is no visible kink where the camera starts to settle.
 */
const easeLand = (u, a = 0.6) => {
  const s = 2 / (1 + a);
  if (u <= a) return s * u;
  const v = (u - a) / (1 - a);
  return s * a + s * (1 - a) * (v - v * v / 2);
};

const easeOut = (t) => 1 - (1 - t) * (1 - t);
const EASES = { in: easeIn, out: easeOut, land: easeLand, lin: (t) => t, smooth };

/** Interpolate a ratio rather than a difference. Falls back to a plain lerp if
 *  either end is non-positive, which is what a channel that is legitimately
 *  zero wants. */
const logLerp = (a, b, t) => (a > 0 && b > 0 ? a * Math.pow(b / a, t) : lerp(a, b, t));

/** Unit vector for a lat/lon on the globe, matching SphereGeometry's own UV
 *  layout so the marker lands exactly where the land mask draws the coast. */
function lonLatToVec3(lon, lat, radius = R) {
  const phi = ((lon + 180) / 360) * Math.PI * 2;
  const theta = ((90 - lat) / 180) * Math.PI;
  return new THREE.Vector3(
    -radius * Math.cos(phi) * Math.sin(theta),
    radius * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

const ORIGIN = new THREE.Vector3(0, 0, 0);
const UP_Y = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const _m4 = new THREE.Matrix4();

/** The rotation a camera at `eye` needs in order to be looking at `target`.
 *  Matrix4.lookAt builds the basis; the quaternion is what can be slerped. */
const _look = (eye, target, up) => _m4.lookAt(eye, target, up);
const _q = (m) => new THREE.Quaternion().setFromRotationMatrix(m);
const _qx = new THREE.Quaternion();

export class Film {
  /** Whether the film should play at all.
   *
   *  `?intro=0` turns it off — the Playwright suite uses that, and so does
   *  anyone iterating on the application who does not want ninety seconds of
   *  cinema between them and a reload. Reduced-motion preferences opt out too;
   *  a flying camera is exactly what that setting is asking us not to do.
   */
  static wanted() {
    const q = new URLSearchParams(location.search);
    if (q.get('intro') === '0' || q.get('film') === '0') return false;
    if (q.get('intro') === '1' || q.get('film') === '1') return true;
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  /** `?voice=0` runs the film on its stated beat lengths with no recorded
   *  narration — the shorter, unstretched cut, read by the platform voice or by
   *  nobody.
   *
   *  It is here for the tests as much as for a viewer. Two of them are about the
   *  film's *geometry* — how long it runs, and the shape of the descent — and
   *  both are claims about the design's own timing rather than about however
   *  long somebody happened to take to read line two. Pinning them to the
   *  unvoiced cut keeps them measuring the thing they were written to measure.
   */
  static voiceWanted() {
    return new URLSearchParams(location.search).get('voice') !== '0';
  }

  constructor() {
    this.root = $('film');
    this.canvas = $('film-gl');
    this.sound = localStorage.getItem('hc.film.sound') !== 'off';
    this.beatIndex = -1;
    this.t = 0;
    this.running = false;
    this.paused = false;
    this.disposed = false;
    this.nodes = [];
    this.stage = { ...STAGE0 };
    this.patches = [];
    this._spin = SPIN0;
    // The planned turn, computed in `play` once the study area is known. Null
    // until then, which is also what tells `_animate` to leave the globe alone
    // — the idle loop is driving it.
    this._yawFrom = this._yawTo = null;
    this._onResize = () => this._resize();
  }

  // ------------------------------------------------------------------ assets

  async load(onProgress = () => {}) {
    const [mask, cities, temp] = await Promise.all([
      this._image('./data/world_land.png').then((im) => { onProgress(0.4, 'continents'); return im; }),
      fetch('./data/world_cities.json').then((r) => r.json()).then((j) => { onProgress(0.6, 'cities'); return j; }),
      fetch('./data/global_temp.json').then((r) => r.json()).then((j) => { onProgress(0.75, 'temperature record'); return j; }),
    ]);
    this.assets = { mask, cities: cities.items, temp };
    await this._loadApproach(onProgress);
    return this.assets;
  }

  /** The satellite pyramid the descent falls through.
   *
   * Split in two on purpose. The three coarse levels are 600 kB between them
   * and the first of them is wanted inside the opening chapter, so they are
   * part of the load. The two fine ones are 2.5 MB and are not wanted until
   * about twenty-five seconds in, so they are fetched in the background while
   * the film is already playing and simply appear when they arrive.
   *
   * The whole thing is optional. If any of it fails — no network, a stale
   * checkout with no `approach/` directory — the descent still happens; it just
   * arrives over a land mask instead of over a photograph, which is what the
   * film did before. Nothing here is allowed to stop the piece from playing.
   */
  async _loadApproach(onProgress = () => {}) {
    const EARLY = new Set(['l0', 'l1', 'l2', 'l3']);
    try {
      const meta = await fetch('./data/approach/meta.json').then((r) => {
        if (!r.ok) throw new Error(`approach/meta.json: ${r.status}`);
        return r.json();
      });
      this.approach = meta;
      const grab = async (lv) => {
        try { lv.image = await this._image(`./data/approach/${lv.file}`); }
        catch (e) { console.warn('approach level unavailable:', lv.file, e); }
      };
      await Promise.all(meta.levels.filter((l) => EARLY.has(l.key)).map(grab));
      onProgress(0.9, 'imagery');
      // Deliberately not awaited: the film starts without them.
      this._fineLevels = Promise.all(
        meta.levels.filter((l) => !EARLY.has(l.key)).map(grab)
      ).then(() => { if (this.renderer) this._buildApproach(); });
    } catch (e) {
      console.warn('descent imagery unavailable, falling back to the mask:', e);
      this.approach = null;
    }
  }

  _image(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error(`${src}: failed to load`));
      im.src = src;
    });
  }

  // ------------------------------------------------------------------- build

  build() {
    const { mask } = this.assets;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: false,
      powerPreference: 'high-performance',
      // The camera crosses seven orders of magnitude between the title card and
      // the last frame — 34,000 km down to 3 km, with a near plane that has to
      // follow it down to a few metres. No fixed near/far pair survives that
      // range; a logarithmic buffer does, and costs one instruction.
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x020306, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      STAGE0.fov, window.innerWidth / window.innerHeight, 0.5, 6000);

    this.sunDir = new THREE.Vector3(-0.55, 0.26, 0.79).normalize();

    // Two nested groups, not one. The globe has to do two rotations at once —
    // an axial tilt and a spin about that tilted axis — and stacking both onto a
    // single object's Euler angles gives precession instead: the pole itself
    // swings around the screen. A tilt group holding a spin group composes them
    // in the right order for free.
    this.tiltGroup = new THREE.Group();
    this.earthGroup = new THREE.Group();
    this.tiltGroup.add(this.earthGroup);
    this.scene.add(this.tiltGroup);

    const tex = new THREE.Texture(mask);
    tex.colorSpace = THREE.NoColorSpace;   // it is a mask, not a picture
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    this.landTex = tex;

    this._buildStars();
    this._buildEarth();
    this._buildApproach();
    this._buildDots();
    this._buildCityLights();
    this._buildClouds();
    this._buildAtmosphere();
    this._buildMarker();

    this._resize();
    window.addEventListener('resize', this._onResize);
  }

  _buildStars() {
    // Fewer and fainter than they were. At 2,600 bright points the field was
    // competing with the globe for contrast — brightest exactly where it passed
    // in front of the halo — and a star field is depth, not subject matter.
    const N = 1700;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      // Uniform on the sphere: acos of a uniform cosine, not a uniform angle.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = 1400 + Math.random() * 1400;
      pos[i * 3] = r * s * Math.cos(a);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s * Math.sin(a);
      const b = (0.16 + Math.pow(Math.random(), 3.1) * 0.62) * 0.86;
      const warm = Math.random() < 0.15;
      col[i * 3] = b * (warm ? 1.0 : 0.82);
      col[i * 3 + 1] = b * 0.88;
      col[i * 3 + 2] = b * (warm ? 0.82 : 1.0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.7, sizeAttenuation: false, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  _buildEarth() {
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        land: { value: this.landTex },
        sunDir: { value: this.sunDir },
        heat: { value: 0 },
        // 1 while the globe is an instrument, 0 once it is a photograph.
        detail: { value: 1 },
      },
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform sampler2D land; uniform vec3 sunDir; uniform float heat;
        uniform float detail;
        varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
        ${RAMP_GLSL}
        void main() {
          float l = smoothstep(0.35, 0.62, texture2D(land, vUv).r);
          vec3 N = normalize(vN);
          float day = smoothstep(-0.14, 0.30, dot(N, sunDir));

          // Both surfaces are much darker on the day side than they were. The
          // globe here is an instrument, and the things that carry the reading
          // — the graticule, the dot field, the cities, the halo — are all
          // additive, so every stop the ground gives back is a stop they gain.
          // A lit tan continent also drags the eye to Africa, which is nowhere
          // this film is going.
          vec3 ocean = mix(vec3(0.006, 0.015, 0.032), vec3(0.020, 0.044, 0.080), day);
          vec3 soil  = mix(vec3(0.026, 0.027, 0.032), vec3(0.086, 0.081, 0.073), day);
          vec3 c = mix(ocean, soil, l);

          // The warming tint is weighted toward the tropics and toward land,
          // because that is where the anomaly is actually lived. A uniform wash
          // would be a lie the shader tells for free.
          float lat = abs(vUv.y - 0.5) * 2.0;
          float w = 1.0 - smoothstep(0.15, 0.95, lat);
          // Times detail, so the warming tint goes out with the graticule and
          // the dots. Once the satellite pyramid is carrying the picture, a
          // heat-tinted land mask showing round the edge of it is not a warmer
          // planet, it is an orange border on a photograph.
          float amount = heat * mix(0.22, 1.0, w) * detail;
          c = mix(c, heatRamp(0.30 + 0.45 * amount),
                  amount * mix(0.10, 0.50, l) * mix(0.40, 1.0, day));

          // Graticule every 15 degrees, at the edge of visibility. It reads as
          // an instrument rather than a photograph, which is what this is.
          vec2 gv = vUv * vec2(24.0, 12.0);
          vec2 gd = abs(fract(gv) - 0.5) / max(fwidth(gv), 1e-5);
          float line = 1.0 - min(min(gd.x, gd.y), 1.0);
          c += vec3(0.10, 0.14, 0.20) * line * 0.30 * (0.30 + 0.70 * day) * detail;

          vec3 V = normalize(cameraPosition - vPos);
          float rim = 1.0 - max(dot(V, N), 0.0);
          c *= mix(1.0, 0.52, pow(rim, 2.0));
          c += mix(vec3(0.16, 0.24, 0.42), vec3(0.42, 0.20, 0.10), heat * 0.7)
               * pow(rim, 4.0) * 0.55 * detail;

          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(R, 160, 96), this.earthMat);
    this.earthGroup.add(this.earth);
  }

  /** The satellite pyramid, as curved patches sitting on the globe.
   *
   * One mesh per level, all of them centred on the study area, drawn coarse
   * first and never taken away again: the wide ones hold the corners of the
   * frame while the narrow ones hold the middle, so at three kilometres up the
   * picture is 4 m/px where the eye is and 9 m/px at the edges rather than
   * being 8 km wide with nothing beyond it.
   *
   * Three details that are not obvious and all of which were bugs first:
   *
   * - Vertices are built about the patch's own centre and the centre goes in
   *   `mesh.position`. Built about the earth's centre instead, a coordinate of
   *   ~100 in float32 quantises to about 0.8 m, which at three kilometres up is
   *   a visible shimmer across the whole image. Three.js composes the model-view
   *   matrix in double precision on the CPU, so moving the offset there costs
   *   nothing and removes the cancellation entirely.
   *
   * - The patches are coplanar with the sphere, so they cannot depth-test
   *   against it. They do not need to: they are decals with a strict order, and
   *   nothing in the film is ever between the camera and the ground. Instead of
   *   a depth test they are hidden when the study area is on the far side of the
   *   planet, which is the only case the test would have caught.
   *
   * - Every level's alpha is feathered at its own border. Without it a level
   *   arriving is a bright rectangle appearing on a planet.
   */
  _buildApproach() {
    if (!this.approach || !this.earthGroup) return;
    this.patches = this.patches || [];
    // Ordered by extent, widest first, not by the order the file lists them:
    // the draw order is what makes a fine level a decal on a coarse one rather
    // than the other way about, and the application's basemap (19 km) is baked
    // after the film's finest level (8 km) in the manifest.
    const wide = [...this.approach.levels].sort((a, b) => b.span_m - a.span_m);
    wide.forEach((lv, i) => {
      if (!lv.image || this.patches.some((p) => p.key === lv.key)) return;

      const tex = new THREE.Texture(lv.image);
      // Sampled raw, exactly as scene.js samples the same two files. Marked
      // sRGB, the sampler linearises it and this shader — which is a raw one,
      // and so does no output conversion — writes the linear values straight to
      // an sRGB framebuffer. The picture comes out a stop and a half dark, and
      // because the application does not make the same mistake, the dissolve
      // that is supposed to be invisible ends in a visible lift.
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;

      const N = lv.span_m > 100000 ? 72 : 32;
      const centre = lonLatToVec3((lv.west + lv.east) / 2, (lv.south + lv.north) / 2, R);
      const pos = new Float32Array((N + 1) * (N + 1) * 3);
      const uv = new Float32Array((N + 1) * (N + 1) * 2);
      const idx = [];
      for (let r = 0; r <= N; r++) {
        for (let c = 0; c <= N; c++) {
          const fx = c / N, fy = r / N;
          const p = lonLatToVec3(lerp(lv.west, lv.east, fx), lerp(lv.south, lv.north, fy), R);
          const k = r * (N + 1) + c;
          pos[k * 3] = p.x - centre.x;
          pos[k * 3 + 1] = p.y - centre.y;
          pos[k * 3 + 2] = p.z - centre.z;
          uv[k * 2] = fx;
          uv[k * 2 + 1] = fy;   // the mosaic's first row is its northern edge
        }
      }
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const a = r * (N + 1) + c, b = a + 1, d = a + N + 1, e = d + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: tex },
          origin: { value: centre.clone() },
          sunDir: { value: this.sunDir },
          heat: { value: 0 },
          opacity: { value: 0 },
          // One grade for the whole pyramid, times the per-level gain that
          // scripts/fetch_approach.py measured by matching each level to the
          // next over the ground they share. Without it the two sources differ
          // by a quarter of a stop and every cross-fade is a flash.
          exposure: { value: 0.82 * (lv.gain ?? 1) },

        },
        // Double-sided because the winding of a lon/lat grid depends on which
        // hemisphere it is built in and this is a decal either way: the normal
        // the shader shades with is the radial one, taken from the position,
        // not the face normal. Single-sided, the whole pyramid was culled and
        // the descent arrived over a bare land mask with nothing to show.
        side: THREE.DoubleSide,
        transparent: true, depthWrite: false, depthTest: false,
        vertexShader: `
          uniform vec3 origin;
          varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
          void main() {
            vUv = uv;
            // The surface normal is the direction of the point from the earth's
            // centre, which the offset origin has to be added back to recover.
            vN = normalize(mat3(modelMatrix) * (position + origin));
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          uniform sampler2D map; uniform vec3 sunDir;
          uniform float heat; uniform float opacity; uniform float exposure;
          varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
          ${RAMP_GLSL}
          void main() {
            vec3 t = texture2D(map, vUv).rgb;
            float lum = dot(t, vec3(0.299, 0.587, 0.114));
            vec3 N = normalize(vN);
            float day = smoothstep(-0.14, 0.30, dot(N, sunDir));

            // Graded into the film's palette rather than dropped in raw. The
            // globe either side of it is a near-black instrument; an ungraded
            // Esri mosaic is a bright grey-green photograph, and the join
            // between them reads as a paste-up. A gamma lift deepens the
            // shadows, a little desaturation pulls the vegetation back, and the
            // night side goes almost out.
            vec3 c = mix(vec3(lum), t, 0.84);
            c = pow(c, vec3(1.16)) * exposure;
            c *= mix(vec3(0.10, 0.11, 0.15), vec3(1.03, 0.99, 0.94), day);
            // The same warming the earth shader applies, so a globe that is
            // one degree hotter is one degree hotter here too.
            c = mix(c, heatRamp(0.30 + 0.34 * heat) * (0.34 + 0.92 * lum), heat * 0.22);

            vec3 V = normalize(cameraPosition - vPos);
            float face = dot(V, N);
            // Nothing over the horizon, and nothing edge-on to it.
            //
            // The widest level is sixteen degrees of arc, and from ninety
            // kilometres up the horizon is a thousand away — so a good part of
            // that patch is behind the curve of the earth. These decals cannot
            // depth-test (they are coplanar with the sphere), so without this
            // the far side of each one is projected through the planet and lands
            // in the frame as a field of hard rectangular slabs. Discarding on
            // the facing term is the depth test that geometry actually needs.
            if (face <= 0.02) discard;
            float rim = 1.0 - max(face, 0.0);
            c *= mix(1.0, 0.52, pow(rim, 2.0));

            float r = length(vUv - 0.5) * 2.0;
            float edge = 1.0 - smoothstep(${FEATHER_IN}, ${FEATHER_OUT}, r);
            gl_FragColor = vec4(c, opacity * edge * smoothstep(0.02, 0.22, face));
          }`,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(centre);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10 + i;
      mesh.visible = false;
      this.earthGroup.add(mesh);
      const fade = APPROACH_FADE[lv.key] || [1e9, 1e9];
      this.patches.push({ key: lv.key, mesh, mat, tex, centre, fade });
    });
    this.patches.sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder);
  }

  /** Land dots, sampled uniformly over the sphere and kept where the mask says
   *  land. A latitude/longitude grid was tried first and clumps badly at the
   *  poles — Greenland ends up denser than Africa, which inverts the whole
   *  point. A Fibonacci spiral is uniform by construction. */
  _buildDots() {
    const { mask } = this.assets;
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(mask, 0, 0, cv.width, cv.height);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;

    const N = 90000;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const pos = [], seed = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      const x = Math.cos(th) * rad, z = Math.sin(th) * rad;
      // Invert the sphere mapping to find this direction's pixel in the mask.
      const lat = Math.asin(y) * 180 / Math.PI;
      const phi = Math.atan2(z, -x);
      const lon = (phi / (Math.PI * 2)) * 360 - 180;
      const u = Math.floor(((lon + 180) / 360) * cv.width) % cv.width;
      const v = Math.floor(((90 - lat) / 180) * cv.height);
      const s = px[(Math.min(cv.height - 1, Math.max(0, v)) * cv.width + u) * 4];
      if (s < 128) continue;
      const rr = R * 1.004;
      pos.push(x * rr, y * rr, z * rr);
      seed.push(Math.random());
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    this.nDots = seed.length;

    this.dotMat = new THREE.ShaderMaterial({
      uniforms: {
        heat: { value: 0 }, uSize: { value: 1.55 }, sunDir: { value: this.sunDir },
        // The dot shell sits 25 km off the surface, so below about that it is
        // *above* the camera and reads as confetti hanging over the city. It is
        // an instrument-scale mark in any case: it goes out during the descent.
        fade: { value: 1 },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aSeed;
        uniform float heat; uniform float uSize; uniform vec3 sunDir; uniform float fade;
        varying vec3 vC; varying float vB;
        ${RAMP_GLSL}
        void main() {
          vec3 n = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = max(-mv.z, 1.0);
          gl_PointSize = min(uSize * (320.0 / d) * (0.55 + 0.95 * aSeed), 34.0);
          float night = smoothstep(0.28, -0.22, dot(normalize(mat3(modelMatrix) * n), sunDir));
          float lat = abs(n.y);
          float w = 1.0 - smoothstep(0.15, 0.95, lat);
          float t = 0.22 + 0.58 * heat * mix(0.30, 1.0, w) + 0.14 * aSeed;
          vC = mix(vec3(0.27, 0.23, 0.21), heatRamp(t), heat * 0.95);
          // The night weighting used to be most of the brightness, which meant
          // the field only existed along the terminator and the lit half of the
          // planet read as a plain sphere. Night still counts — a dot is a lit
          // mark — but the floor is high enough that the instrument covers the
          // whole disc, which is what makes it read as a measurement of the
          // world rather than a rim effect.
          vB = (0.36 + 0.34 * night) * fade;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vB;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.10, d);
          if (a <= 0.001) discard;
          gl_FragColor = vec4(vC, a * vB);
        }`,
    });
    this.dots = new THREE.Points(geo, this.dotMat);
    this.dots.renderOrder = 15;
    this.earthGroup.add(this.dots);
  }

  /** The world's largest cities, igniting in order of size. */
  _buildCityLights() {
    const cities = this.assets.cities;
    const maxPop = Math.max(...cities.map((c) => c.pop));
    const pos = [], pop = [], seed = [];
    cities.forEach((c, i) => {
      const v = lonLatToVec3(c.lon, c.lat, R * 1.006);
      pos.push(v.x, v.y, v.z);
      pop.push(Math.pow(c.pop / maxPop, 0.55));
      // Ignition order follows population, with a little scatter so the front
      // does not sweep the map like a progress bar. Compressed into the lower
      // two thirds of the range so that at full ignition even the smallest city
      // on the list is properly lit rather than still fading up.
      seed.push(clamp01((i / cities.length) * 0.66 + (Math.random() - 0.5) * 0.12));
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aPop', new THREE.Float32BufferAttribute(pop, 1));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));

    this.cityMat = new THREE.ShaderMaterial({
      uniforms: { ignite: { value: 0 }, bloom: { value: 0 }, time: { value: 0 }, uSize: { value: 15.0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aPop; attribute float aSeed;
        uniform float ignite; uniform float bloom; uniform float time; uniform float uSize;
        varying float vA; varying vec3 vC;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = max(-mv.z, 1.0);
          float lit = smoothstep(aSeed, aSeed + 0.30, ignite);
          float pulse = 1.0 + 0.30 * bloom * sin(time * 1.6 + aSeed * 41.0);
          gl_PointSize = min(uSize * (0.42 + 1.70 * aPop) * (330.0 / d) * lit * pulse, 120.0);
          vA = lit * (0.55 + 0.45 * aPop);
          // Warm, but never as warm as the land underneath: at full heat the
          // continents are already orange, and an orange light on an orange
          // ground is an invisible light. The core goes to white in the
          // fragment stage, which is what makes each one read as a source.
          vC = mix(vec3(1.00, 0.86, 0.58), vec3(1.00, 0.60, 0.24), aPop);
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = smoothstep(0.32, 0.0, d);
          float halo = pow(smoothstep(1.0, 0.0, d), 2.4);
          float a = clamp(core * 1.0 + halo * 0.55, 0.0, 1.0) * vA;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(mix(vC, vec3(1.0, 0.97, 0.90), core * 0.85), a);
        }`,
    });
    this.cityLights = new THREE.Points(geo, this.cityMat);
    this.cityLights.renderOrder = 16;
    this.earthGroup.add(this.cityLights);
  }

  _buildClouds() {
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        amount: { value: 0 }, time: { value: 0 }, sunDir: { value: this.sunDir },
      },
      transparent: true, depthWrite: false, side: THREE.FrontSide,
      vertexShader: `
        varying vec3 vN; varying vec3 vL; varying vec3 vPos;
        void main() {
          vL = normalize(position);
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float amount; uniform float time; uniform vec3 sunDir;
        varying vec3 vN; varying vec3 vL; varying vec3 vPos;
        ${NOISE_GLSL}
        void main() {
          if (amount <= 0.001) discard;
          vec3 p = vL * 2.6 + vec3(0.0, 0.0, time * 0.012);
          float f = fbm(p) * 0.62 + fbm(p * 3.7 + 11.3) * 0.38;
          float a = smoothstep(0.50, 0.86, f) * amount;
          if (a <= 0.004) discard;
          float day = smoothstep(-0.10, 0.35, dot(normalize(vN), sunDir));
          vec3 c = mix(vec3(0.10, 0.12, 0.17), vec3(0.86, 0.86, 0.90), day);
          vec3 V = normalize(cameraPosition - vPos);
          a *= mix(0.35, 1.0, pow(max(dot(V, normalize(vN)), 0.0), 0.6));
          gl_FragColor = vec4(c, a * 0.85);
        }`,
    });
    // 25 km up rather than the old 1,270 km. At orbital distance the two are
    // indistinguishable, and the descent now goes low enough that the old shell
    // would have been punched through — a front-faced sphere seen from inside
    // culls, so the entire cloud layer would have vanished in one frame at
    // about a thousand kilometres. `_animate` fades it out well above this.
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.004, 96, 56), this.cloudMat);
    this.clouds.renderOrder = 20;
    this.earthGroup.add(this.clouds);
  }

  _buildAtmosphere() {
    this.atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        heat: { value: 0 }, power: { value: 1.0 },
        rInner: { value: R }, rOuter: { value: R * ATMO },
      },
      side: THREE.BackSide, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      /* Distance from the limb, not a fresnel.
       *
       * This used to be pow(1 - |dot(V, N)|, k) on a back-faced shell, which is
       * the standard trick and is wrong for what the design asks for: on a back
       * face that term is *largest* at the shell's own silhouette, so the glow
       * came out as a ring with its bright edge at the outside and a hard cut
       * where the geometry ended — a bubble drawn around the planet. Widening
       * the shell only made the bubble bigger.
       *
       * What the reference frame has is air: brightest exactly on the horizon
       * and falling away outward into black. That is a function of how close
       * the view ray passes to the planet, so measure it directly. The globe is
       * at the world origin, so the perpendicular distance from the origin to
       * the ray through this fragment is one cross product. It is `rInner` at
       * the limb and `rOuter` at the edge of the shell, and everything nearer
       * than the limb is behind the planet and depth-tested away.
       */
      fragmentShader: `
        uniform float heat; uniform float power; uniform float rInner; uniform float rOuter;
        varying vec3 vPos;
        void main() {
          vec3 W = normalize(vPos - cameraPosition);
          float b = length(cross(cameraPosition, W));
          float t = clamp((b - rInner) / (rOuter - rInner), 0.0, 1.0);
          // 2.6 rather than a linear falloff: the first tenth of the way out
          // holds most of the light, which is what makes it sit *on* the horizon
          // instead of hovering above it.
          float f = pow(1.0 - t, 2.6);
          // Both endpoints are still the design's — a muted slate for a cold
          // planet, a terracotta for a warm one. What changed is the path
          // between them: linear in heat, chapter one sits at 0.4 and draws a
          // mauve halfway colour that is neither of the two authored ones. The
          // gamma puts the warm end most of the way in by the time the planet is
          // visibly warming, and still leaves the slate at the top of the film.
          //
          // The cold end is the design's rgb(38,66,126) taken down to the value
          // it lands at once its 0.5 alpha is applied — additive blending has no
          // alpha to apply, so the colour has to carry it. The warm end is the
          // design's rgb(206,108,78) unmodified.
          vec3 c = mix(vec3(0.105, 0.165, 0.315), vec3(0.808, 0.424, 0.306),
                       pow(clamp(heat, 0.0, 1.0), 0.62));
          gl_FragColor = vec4(c * f * power, 1.0);
        }`,
    });
    // R is 6,371 km, so this shell reaches 573 km up rather than the 319 km it
    // used to. That is not a free number: `_animate` has to take the halo away
    // *above* it, or the descent crosses into a back-faced sphere and the glow
    // becomes a flat terracotta wash over the whole frame. The fade band there
    // moved with this constant; the two are one decision.
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(R * ATMO, 64, 40), this.atmoMat);
    this.atmo.renderOrder = 30;
    this.scene.add(this.atmo);
  }

  /** A ring sitting flat on the surface at the study area, plus a short mast, so
   *  the place has a mark on the globe before the camera commits to it. */
  _buildMarker() {
    this.markerGroup = new THREE.Group();
    this.markerGroup.renderOrder = 40;
    this.markerGroup.visible = false;
    this.earthGroup.add(this.markerGroup);

    const mat = () => new THREE.MeshBasicMaterial({
      color: 0xffb257, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.markerRings = [];
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 72), mat());
      ring.userData.phase = i / 3;
      this.markerRings.push(ring);
      this.markerGroup.add(ring);
    }
    /* A bright core exactly on the surface point, and a much shorter mast.
     *
     * The rings lie flat against the globe; the mast stands up out of it. Seen
     * from anywhere but straight overhead — which is every frame of the film,
     * since the descent is oblique — a tall mast puts its bright tip well to
     * one side of the rings it rises from, and the mark reads as badly
     * centred rather than as a pin standing on a planet. It was seven units
     * against an inner ring barely two units across, so the tip cleared the
     * whole circle.
     *
     * The core is the fix: an unambiguous point of light at y = 0, which is
     * where the coordinate actually is. The mast is kept because it is what
     * makes the mark read as standing on a sphere rather than painted onto
     * one, but shortened to under the inner ring's radius so its lean stays
     * inside the circle instead of escaping it. */
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.62, 32), mat());
    core.rotation.x = -Math.PI / 2;
    core.position.y = 0.02;
    this.markerCore = core;
    this.markerGroup.add(core);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.7, 6), mat());
    mast.position.y = 0.85;
    this.markerMast = mast;
    this.markerGroup.add(mast);
  }

  /** Place the marker group tangent to the surface at a lat/lon. */
  placeMarker(lon, lat) {
    const p = lonLatToVec3(lon, lat, R * 1.002);
    this.markerLocal = lonLatToVec3(lon, lat, R * 1.01);
    this.markerGroup.position.copy(p);
    // The group's local +Y should point away from the centre; rings are drawn in
    // its XY plane, so they also need laying flat against the surface.
    this.markerGroup.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), p.clone().normalize());
    for (const ring of this.markerRings) ring.rotation.x = -Math.PI / 2;
    this.markerGroup.visible = true;
  }

  /** Render the globe slowly behind the title card while the city loads.
   *
   *  It costs one rotating sphere and buys the whole first impression: the page
   *  opens on a planet turning under a title, rather than on a progress bar. */
  startIdle() {
    if (this.idling || !this.renderer) return;
    this.idling = true;
    let last = performance.now();
    const step = (now) => {
      if (!this.idling || this.running || this.disposed || !this.renderer) return;
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      const t = (this._idleT = (this._idleT || 0) + dt);

      this._spin = (this._spin || 0) + (1.7 * Math.PI / 180) * dt;
      this.earthGroup.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._spin);
      this.tiltGroup.rotation.z = 0.41;

      // A very slow push-in, so the shot is never quite still.
      const dist = 720 - 70 * smooth(clamp01(t / 40));
      this.camera.fov = STAGE0.fov;
      this._idleFraming();
      this.camera.position.set(0, Math.sin(0.16) * dist, Math.cos(0.16) * dist);
      this.camera.lookAt(0, 0, 0);

      // Half-warmed, not cold. The title card is not chapter one — the film
      // opens on a cold planet and warms it — but a wholly cold globe behind
      // the words "The Urban Canyon" is the wrong promise, and the design's own
      // title state sits at about half heat for exactly that reason.
      this.earthMat.uniforms.heat.value = IDLE_HEAT;
      this.dotMat.uniforms.heat.value = IDLE_HEAT;
      // The limb has to be warmed with them. Left at 0 it stayed the cold
      // rgb(38,66,126) end of the ramp, which over a near-black planet is a
      // clear electric blue rim — the one saturated thing on a title card whose
      // whole point is that the shell recedes.
      this.atmoMat.uniforms.heat.value = IDLE_HEAT;
      this.cityMat.uniforms.time.value = t;
      this.atmoMat.uniforms.power.value = 1.0;
      this.stars.rotation.y = t * 0.004;

      this.renderer.render(this.scene, this.camera);
      this.idleRaf = requestAnimationFrame(step);
    };
    this.idleRaf = requestAnimationFrame(step);
  }

  /** Push the idle globe to the right of the frame.
   *
   * The title card is set left — kicker, headline, rule, strap, two buttons —
   * and a globe centred behind it is a globe with a paragraph written across it.
   * A frustum offset moves the planet without moving the camera, so the
   * push-in and the spin are unaffected and there is no second camera to keep in
   * sync. Skipped on a narrow viewport, where there is no clear quarter of the
   * frame to move it into and the text sits over it either way.
   */
  _idleFraming() {
    const w = window.innerWidth, h = window.innerHeight;
    if (w > 900) this.camera.setViewOffset(w, h, -w * 0.18, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  _stopIdle() {
    this.idling = false;
    cancelAnimationFrame(this.idleRaf);
    // The film proper frames the globe centrally; leaving the title card's
    // offset in place put New York off the side of the dive.
    this.camera?.clearViewOffset();
    this.camera?.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ layout

  _resize() {
    if (!this.renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------- score

  /** A small procedural score. No audio files ship with this project and none
   *  should: a drone, a sub, and filtered noise are a few dozen lines of
   *  WebAudio, and they can follow the camera in a way a fixed recording cannot.
   *  Started from the Begin click, which is also what unlocks audio at all. */
  _startScore() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || this.ac) return;
    let ac;
    try { ac = new AC(); } catch { return; }
    this.ac = ac;
    // Created inside the Begin click, so it should already be running; a
    // suspended context here means the browser wanted a gesture it did not see.
    if (ac.state === 'suspended') ac.resume().catch(() => {});

    const master = ac.createGain();
    master.gain.value = 0;
    // A limiter on the end of the chain. The score has to sit at a level you can
    // actually hear under a voice-over, and the dive stacks a sub, a drone and a
    // noise bed on top of each other — without this, that sum clips.
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(ac.destination);
    this.master = master;
    // The voice goes into the same limiter but NOT through `master`: the score's
    // level is a knob on the music, and the narration is not music. Attached
    // here because this is the first moment there is a context to attach to, and
    // it is inside the Begin click, so it is one the browser will run.
    this.limiter = limiter;
    this.narrator?.attach(ac, limiter);

    const filt = ac.createBiquadFilter();
    // 520 Hz, not 300. Almost all of this drone's energy sits below 130 Hz,
    // which a laptop speaker cannot reproduce at all — the first version was
    // mixed for headphones and simply inaudible on anything else. Opening the
    // filter and adding a partial up at 220 puts real content in the band small
    // speakers actually pass.
    filt.type = 'lowpass'; filt.frequency.value = 520; filt.Q.value = 0.8;
    filt.connect(master);

    // A minor-ish stack, detuned in pairs so it beats slowly instead of sitting
    // still. Anything more consonant starts to sound like a product video.
    [[55, 'sawtooth', 0.20], [82.4, 'sawtooth', 0.12],
     [110, 'triangle', 0.09], [130.8, 'triangle', 0.06],
     [220, 'triangle', 0.045]].forEach(([f, type, g], i) => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = f * (i % 2 ? 1.003 : 0.997);
      const gain = ac.createGain(); gain.gain.value = g;
      o.connect(gain); gain.connect(filt); o.start();
      this.nodes.push(o);
    });

    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.043;
    const lfoGain = ac.createGain(); lfoGain.gain.value = 260;
    lfo.connect(lfoGain); lfoGain.connect(filt.frequency); lfo.start();
    this.nodes.push(lfo);

    // Air: white noise through a band-pass that opens during the descent.
    const len = ac.sampleRate * 4;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * 0.5;
    const noise = ac.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 780; bp.Q.value = 0.6;
    this.airGain = ac.createGain(); this.airGain.gain.value = 0;
    noise.connect(bp); bp.connect(this.airGain); this.airGain.connect(master);
    noise.start(); this.nodes.push(noise);

    const sub = ac.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 36;
    this.subGain = ac.createGain(); this.subGain.gain.value = 0;
    sub.connect(this.subGain); this.subGain.connect(master);
    sub.start(); this.nodes.push(sub);

    master.gain.setValueAtTime(0, ac.currentTime);
    master.gain.linearRampToValueAtTime(this.sound ? SCORE_LEVEL : 0, ac.currentTime + 2.5);
  }

  /** A soft hit, used when a chapter turns over. */
  _accent(freq = 98, gain = 0.5) {
    const ac = this.ac;
    if (!ac || !this.sound) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(freq * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.5);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 2);
  }

  /** Pull the score down under a spoken line and let it back up between them.
   *
   * A voice-over is not two things playing at once; it is one of them making
   * room for the other. Four tenths of a second down, seven back up: quick
   * enough that the line never starts over full music, slow enough that the
   * drone does not pump between beats. */
  _duck(on) {
    if (!this.ac || !this.master) return;
    const t = this.ac.currentTime;
    const level = this.sound ? SCORE_LEVEL * (on ? DUCK : 1) : 0;
    try {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(level, t + (on ? 0.4 : 0.7));
    } catch { /* a closed context is not an error worth reporting */ }
  }

  _stopScore(fade = 2.2) {
    if (!this.ac || !this.master) return;
    const t = this.ac.currentTime;
    try {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(0, t + fade);
    } catch { /* a closed context is not an error worth reporting */ }
    setTimeout(() => {
      for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } }
      this.nodes = [];
      try { this.ac.close(); } catch { /* idem */ }
      this.ac = null;
    }, fade * 1000 + 200);
  }

  setSound(on) {
    this.sound = on;
    localStorage.setItem('hc.film.sound', on ? 'on' : 'off');
    if (this.master && this.ac) {
      const t = this.ac.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(on ? SCORE_LEVEL : 0, t + 0.4);
    }
    if (!on && window.speechSynthesis) window.speechSynthesis.cancel();
    this.narrator?.setMuted(!on);
    this._soundLabel();
  }

  // ------------------------------------------------------------------ speech

  _pickVoice() {
    const synth = window.speechSynthesis;
    if (!synth) return null;
    const voices = synth.getVoices() || [];
    if (!voices.length) return null;
    // A documentary wants an unhurried, low, English voice. These are the names
    // the common platforms give theirs; anything English will do as a fallback.
    const wanted = ['Daniel', 'Arthur', 'Google UK English Male', 'Microsoft Ryan',
                    'Microsoft George', 'Oliver', 'Alex', 'Google US English'];
    for (const name of wanted) {
      const v = voices.find((x) => x.name.includes(name));
      if (v) return v;
    }
    return voices.find((v) => /^en[-_]GB/i.test(v.lang))
        || voices.find((v) => /^en/i.test(v.lang))
        || voices[0];
  }

  /** Say this beat's line, however it can.
   *
   * Three outcomes, in order of preference: the ElevenLabs recording of this
   * exact line; the platform synthesiser; silence with the caption carrying it.
   * The fallback is per line rather than per film because that is the difference
   * between one unmade sentence and thirty — see voice.js.
   */
  _speak(beat, index) {
    if (!this.sound) return;
    // A silent beat still has to stop whatever is being said, or the last line
    // of narration runs on over a descent that is supposed to be wordless.
    if (!beat.text) {
      this.narrator?.cancel();
      try { window.speechSynthesis?.cancel(); } catch { /* */ }
      return;
    }
    // The real read. `speak` returns false when there is no recording for this
    // line, and only then does the platform voice get a turn.
    if (this.narrator?.speak(index, beat.dur, beat.say || beat.text)) {
      try { window.speechSynthesis?.cancel(); } catch { /* */ }
      return;
    }
    if (!window.speechSynthesis) return;
    if (!this.voice) return;
    try {
      // Cancel whatever is still speaking first. `speak` queues rather than
      // interrupting, and the beats are now the design's fixed lengths rather
      // than however long each line takes to say — so without this the voice
      // fell progressively further behind the captions until it was reading
      // chapter two over chapter four. Cutting the tail of a line is a much
      // smaller fault than narrating the wrong shot.
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(beat.say || beat.text);
      u.voice = this.voice;
      u.lang = this.voice.lang || 'en-GB';
      // A shade quicker than before, because the shots are shorter. The script
      // spells its figures as words, so nothing here has to pronounce "°C".
      u.rate = 0.94; u.pitch = 0.82; u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch { /* speech is a bonus, never a dependency */ }
  }

  // -------------------------------------------------------------------- play

  /** Run the film. Resolves when the last caption has cleared, or immediately
   *  on a skip. `hooks.onHandoff` fires as the dive bottoms out and is where the
   *  city takes over; `hooks.onReveal` fires as the last beat begins. */
  /** Build the script and time it. Idempotent, because the title card needs the
   *  runtime on its button before anyone has pressed anything. */
  _prepare(data) {
    if (this._prepared) return;
    this._prepared = true;
    this.story = buildStory(data, {
      years: this.assets.temp.years,
      anomaly: this.assets.temp.anomaly,
      warmest: this.assets.temp.warmest,
      warmest10_since: this.assets.temp.warmest10_since,
      baseline: this.assets.temp.baseline,
      cities: this.assets.cities,
    });
    this.voice = this._pickVoice();
    this._prepareBeats();
    this.chapters = this._groupChapters();

    /* And ask the server to read it.
     *
     * Deliberately not awaited. This runs while the title card is on screen, so
     * there is usually a good few seconds of someone reading a strap line before
     * anything has to be spoken — but the film must start on time even if there
     * is not, and a line whose audio has not arrived is simply a line the
     * platform voice takes instead. Nothing here can delay a frame.
     *
     * The lines are sent in beat order, and what comes back is indexed the same
     * way, so `_speak` needs nothing but the beat's index to find its recording.
     */
    if (!Film.voiceWanted()) return;
    this.narrator = new Narrator();
    this.narrator.onSpeaking = (on) => this._duck(on);
    /* Asked for twice, and the whole thing is one promise.
     *
     * `narration` resolves when the script has been asked for as many times as
     * it is going to be. Nothing in the player waits on it — the film starts on
     * time regardless, and an unrecorded line is one the platform voice takes —
     * but it exists so that something *can*: the test for the voiced cut has to
     * read the finished state rather than whichever of the two passes happened
     * to have landed when it looked, and "wait for the narrator to report
     * enabled" is not that, because the first pass enables it.
     */
    this.narration = this._narrate().then(() => this._renarrate(data));

    /* And again once the decision layer lands.
     *
     * Five beats in chapter three read their sentence out of floors.json and
     * prescriptions.json, which data.js fetches in the background — so at the
     * moment the title card asks for the runtime, those five are still their
     * fallback wording, and asking for a recording of the fallback gets nothing
     * (it is not in the cache, and the cache is all this may read).
     *
     * The first version waited on `decision.ready` before asking at all, with a
     * timeout for the builds where those files do not exist. That is a race with
     * two bad ends: too short and the five beats are unvoiced, too long and a
     * viewer who clicks Begin promptly gets no narration at all. Asking twice
     * has neither end. The first call voices everything that does not depend on
     * those files, immediately; the second corrects the five that do, and costs
     * nothing, because a second look at the same cache is a second look at the
     * same cache.
     */
  }

  _renarrate(data) {
    const ready = data?.decision?.ready;
    if (!ready) return null;
    return ready
      .then(() => (this.running ? null : this._narrate()))
      .catch(() => { /* no decision layer on this build; the first call stands */ });
  }

  /** Ask the server to read the script as it currently stands.
   *
   * Deliberately not awaited by anything. It runs while the title card is on
   * screen, and the film must start on time whether or not it has finished: a
   * line whose audio has not arrived is simply a line the platform voice takes
   * instead. Nothing here can delay a frame.
   *
   * The lines go in beat order and come back indexed the same way, so `_speak`
   * needs nothing but the beat's index to find its recording — and voice.js
   * checks the sentence as well as the index before it plays one.
   */
  _narrate() {
    return this.narrator.prepare(this.story.beats.map((b) => b.say || b.text || ''))
      .then((ok) => {
        if (!ok) return;
        if (this.ac) this.narrator.attach(this.ac, this.limiter);
        this._creditVoice();
        this._retime();
        console.info(`film: narrated by ElevenLabs, ${this.narrator.clips.filter(Boolean).length} lines`);
      })
      .catch(() => { /* the platform voice is already the fallback */ });
  }

  /** The film's length, as the title card prints it. */
  runtimeLabel(data) {
    this._prepare(data);
    return clock(this.total);
  }

  /* Give every line a shot long enough to say it in.
   *
   * The beat lengths in story.js are stated rather than derived, for reasons
   * that are still good: the title card promises a runtime, the transport bar
   * sizes its segments by chapter, and neither should depend on the machine.
   * But they were stated against `speechSynthesis` at rate 0.94, which is a
   * good deal faster than a person reading — and the design accepted the
   * consequence, that a line running past its shot gets cut, on the grounds
   * that a clipped tail beats narrating the wrong frame.
   *
   * With a real read that trade stops being reasonable. Measured against the
   * ElevenLabs recordings, twenty-two of the twenty-seven spoken beats ran over,
   * several of them by more than double: the second line is fourteen seconds of
   * audio in a five-and-a-half-second beat, so two thirds of the sentence that
   * opens the film would never be heard. Thirty percent of a documentary's
   * sentences ending mid-word is not a film with a small timing fault, it is a
   * broken one.
   *
   * So the recording sets a floor on the beat, and only a floor: a beat already
   * long enough is left exactly as story.js wrote it, and a beat with no
   * recording — the three silent ones of the descent, or any line the cache does
   * not have — keeps its stated length too. The film is therefore the design's
   * shape, stretched only where a sentence needs the room.
   *
   * What this costs is that a voiced film is longer than an unvoiced one: about
   * three minutes fifty against two minutes forty-two. The title card is
   * re-printed from the new total rather than left holding the old one, and
   * since the audio is cached and committed, the figure it prints is still the
   * same on every machine that has the cache.
   *
   * Only ever before the film starts. Moving the beats under a running clock
   * would jump the camera and the captions apart.
   */
  _retime() {
    if (this.running || !this.narrator?.enabled) return;
    const beats = this.story.beats;
    let stretched = 0;
    for (let i = 0; i < beats.length; i++) {
      const need = this.narrator.needs(i);
      if (need > beats[i].dur + 0.01) { beats[i].dur = +need.toFixed(2); stretched++; }
    }
    if (!stretched) return;
    let t = 0;
    for (const b of beats) { b.t0 = t; t += b.dur; }
    this.total = t;
    this.chapters = this._groupChapters();
    // The title card is already on screen with the unvoiced runtime on its
    // button. Tell whoever put it there, rather than leaving the film to run a
    // minute past what it promised.
    this.hooks?.onRuntime?.(clock(this.total));
    this.onRuntime?.(clock(this.total));
    console.info(`film: ${stretched} beats stretched to fit the read, runtime now ${clock(this.total)}`);
  }

  /** Beats grouped into the four chapters, with the length of each.
   *
   * The transport bar's segments are sized from these rather than being four
   * equal thirds-of-a-bar: a chapter that runs half as long as its neighbour
   * should look half as long, or the scrubber is lying about where you are.
   */
  _groupChapters() {
    const out = [];
    for (const b of this.story.beats) {
      const last = out[out.length - 1];
      if (!last || last.n !== b.chapter) {
        out.push({ n: b.chapter, title: b.title || '', t0: b.t0, end: b.t0 + b.dur });
      } else {
        last.end = b.t0 + b.dur;
        if (b.title && !last.title) last.title = b.title;
      }
    }
    for (const c of out) c.dur = Math.max(0.001, c.end - c.t0);
    return out;
  }

  play(data, hooks = {}) {
    this.hooks = hooks;
    // What the beats drive. Handed in rather than imported, because film.js has
    // no business knowing how the interface is constructed — it only needs the
    // three objects the storyboard names.
    this.actx = hooks.ctx || null;
    this._prepare(data);
    this.placeMarker(this.story.marker.lon, this.story.marker.lat);
    this._nycLocal = lonLatToVec3(this.story.marker.lon, this.story.marker.lat, R);
    // Local north at the study area, taken as a finite difference rather than
    // differentiated by hand: the sphere's parameterisation is stated in exactly
    // one place (lonLatToVec3) and this cannot drift out of step with it.
    this._northLocal = lonLatToVec3(this.story.marker.lon, this.story.marker.lat + 0.01, R)
      .sub(this._nycLocal).normalize();

    /* Plan the turn.
     *
     * `_yawTo` is the yaw that swings the site's meridian onto the camera axis:
     * rotating (n.x, n.z) by it puts the site at x = 0, z = +|n.xz|. `_yawFrom`
     * is simply that less TURN_ONTO_SITE, so the opening frame is a fixed angle
     * short of the city and the whole rotation is one forward sweep — no
     * wrapping, no nearest-equivalent-angle, nothing that can resolve backwards.
     *
     * It does mean the film's first frame does not continue the idle globe's
     * rotation, and that is deliberate: the cut from the title card already
     * moves the planet (the idle shot is pushed to the right of frame by a
     * frustum offset and stands 720 units off, the film opens centred at 640),
     * so the orientation may as well be part of the same cut rather than
     * leaving the opening pose to depend on how long someone read the strap. */
    const n = this._nycLocal.clone().normalize();
    this._nycNormal = n;
    this._siteLat = Math.atan2(n.y, Math.hypot(n.x, n.z));
    this._yawTo = Math.atan2(-n.x, n.z);
    this._yawFrom = this._yawTo - TURN_ONTO_SITE;
    // Nothing washes over this cut, because there is no longer a cut.
    const flash = $('film-flash');
    if (flash) flash.style.opacity = '0';

    this._stopIdle();
    const { lat, lon } = this.story.marker;
    $('film-marker-name').textContent = this.story.marker.name.toUpperCase();
    $('film-marker-coords').textContent =
      `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
    $('film-hud').hidden = false;
    // The ticker is on for the whole film, not only on the beats that change
    // it: its job is to have the source of the current claim on screen at all
    // times, and a source that blinks out between beats is not doing that.
    $('film-readout').classList.add('in');
    this.root.classList.add('playing');
    this._buildSegments();
    this._soundLabel();

    this._startScore();
    this.running = true;
    this.paused = false;
    this.t = 0;
    this.beatIndex = -1;
    this.t0 = this.last = performance.now();
    this._loop();

    return new Promise((resolve) => { this._resolve = resolve; });
  }

  /** Lay the beats out on the clock.
   *
   * A beat's length is whatever story.js states. It used to be derived from the
   * beat's own word count instead, which sounds principled — a longer line gets
   * a longer shot — and had two costs that outweighed it. The film came out at
   * one minute forty-seven against the thirty seconds the design asks for;
   * and the length changed with the sound setting, because a spoken line needs
   * longer than a read one, so the runtime on the title card and the widths of
   * the four segments on the transport bar were both a function of whether the
   * viewer had audio on. Stated durations are the same on every machine.
   *
   * The fallback is kept for a beat that states none, so an added line still
   * gets a sane shot rather than a zero-length one.
   */
  _prepareBeats() {
    let t = 0;
    let stage = { ...STAGE0 };
    this.story.beats.forEach((b) => {
      // The fallback is for a beat that states no length. It counts words, so a
      // beat that carries none — the descent's two, which are silent — gets the
      // floor rather than a division by nothing.
      const words = (b.text || '').trim().split(/\s+/).filter(Boolean).length;
      b.dur = b.seconds ?? Math.max(2.6, words / 3.4 + 0.7);
      b.t0 = t;
      b.from = stage;
      stage = { ...stage, ...b.stage };
      b.to = stage;
      t += b.dur;
    });
    this.total = t;
  }

  _loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    // Wall clock, not accumulated frame deltas.
    //
    // Accumulating a clamped dt was the obvious way to write this and it is
    // wrong: on a machine slow enough to clamp — software GL, say — the film
    // runs in slow motion while the narration, which the platform speaks in
    // real time, sails on ahead of the captions. Reading the clock instead
    // means a dropped frame costs a frame of animation, never a beat of sync.
    if (!this.paused) this.t = (now - this.t0) / 1000;
    this._advance();
    this._animate(this.paused ? 0 : dt);
    this._paintTransport();
    if (this.renderGlobe !== false) this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this._loop);
  };

  /** Beat bookkeeping: captions, chapter cards, readouts, speech, handoff. */
  _advance() {
    const beats = this.story.beats;
    let i = beats.length - 1;
    for (let k = 0; k < beats.length; k++) {
      if (this.t < beats[k].t0 + beats[k].dur) { i = k; break; }
    }
    if (this.t >= this.total) { this._finish(); return; }
    if (i === this.beatIndex) return;

    this.beatIndex = i;
    const b = beats[i];

    // A beat may carry no line. The last chapter is the dive, and the dive is
    // silent by design — everything the film has to say has been said by the
    // time it starts falling, so that the descent is an arrival at the
    // application rather than a place to keep talking over. An empty caption is
    // removed rather than set to an empty string: it has padding and a rule
    // under it, and both of those are visible with nothing between them.
    const cap = $('film-caption');
    cap.hidden = !b.text;
    if (b.text) {
      cap.textContent = b.text;
      restart(cap, ENTER);         // rise, unblur, settle — the design's entrance
    }

    // Chapter cards and readouts are attached to particular beats, but a beat
    // can be stepped over: a single frame that takes longer than a short beat
    // does it, and so does anything that seeks the clock. So rather than firing
    // only on an exact hit, both look backwards for the most recent one that
    // should be showing — which makes them correct at any point in the film
    // rather than only if every beat was entered in order.
    if (b.chapter !== this._chapter) {
      this._chapter = b.chapter;
      const titled = beats.slice(0, i + 1).reverse().find((x) => x.title);
      if (titled) {
        $('film-chapno').textContent = titled.chapter;
        $('film-chapter').textContent = titled.title;
        // The mark stays up for the whole chapter rather than fading out after
        // five seconds. Someone who joins mid-chapter should still be able to
        // see which chapter they are in.
        restart($('film-chaptercard'), ENTER);
        this._accent(i === 0 ? 116 : 92);
      }
    }

    let ro = null;
    for (let k = i; k >= 0 && !ro; k--) ro = this.story.readouts[k] || null;
    if (ro && ro !== this.readout) {
      this.readout = ro;
      $('film-readout-label').textContent = ro.label;
      $('film-readout-value').textContent = ro.value || '';
      $('film-spark').hidden = ro.kind !== 'anomaly';
    }

    this._speak(b, i);

    /* The city phase is entered before the beat acts, and the order is load-
     * bearing.
     *
     * `_enterCity` is what hands scene.js its camera back: it fires `onLanded`,
     * which ends the descent and flies from wherever the film left the camera
     * to the application's opening view. That flight takes three and a half
     * seconds. The first city beat is also the one that selects a building and
     * frames it — so with the act running first, the framing happened and the
     * flight then overwrote it every frame and finished a mile up. Chapter
     * three played out over the overview instead of over the building it spends
     * a minute describing, and every probe that paused the film immediately
     * after seeking reported the camera in the right place, because the flight
     * had not had a frame to run in yet.
     *
     * Landing first and acting second means the act aborts that flight (see
     * scene.focus) and owns the camera from there.
     */
    if (b.phase === 'city' && !this._cityPhase) {
      this._enterCity();
      // The panels come up here rather than under the closing line. They used
      // to arrive last because the film was a film and the application was what
      // came after it; now two thirds of the film is the application, so it has
      // to be on screen for the beats that talk about it.
      this._revealed = true;
      this.hooks.onReveal?.();
    }

    if (b.phase === 'handoff' && !this._handedOver) {
      this._handedOver = true;
      // From here the application's camera is a slave to this one — see the
      // handover block in `_animate`. It renders the whole beat behind an opaque
      // globe, which is waste for three seconds and is what buys the last one:
      // when the globe finally goes, the frame underneath is not a frame the
      // application chose, it is this frame with buildings in it.
      this.hooks.onHandoff?.(b.dur);
      if (this.airGain && this.ac) {
        const t = this.ac.currentTime;
        this.airGain.gain.linearRampToValueAtTime(0.12, t + b.dur * 0.7);
        this.subGain.gain.linearRampToValueAtTime(0.34, t + b.dur * 0.6);
        this.airGain.gain.linearRampToValueAtTime(0.0, t + b.dur + 3.0);
        this.subGain.gain.linearRampToValueAtTime(0.04, t + b.dur + 3.0);
      }
    }
    /* And the beat acts on the application.
     *
     * From chapter three on, the film is not a picture of the tool, it is the
     * tool: the globe canvas is gone, the panels are up, and each beat calls
     * `act` to move the real camera, select the real building, switch the real
     * layer, open the real brief. Everything on screen from here is the working
     * application being driven, which is the only way a walkthrough can claim
     * to show what a thing does rather than a drawing of it.
     *
     * Guarded, because a beat that throws must not take the film down with it.
     * A walkthrough with one dead step is worth far more than a black screen,
     * and the caption for that step is already on screen saying what should be
     * happening — which is also how you find out which one broke.
     */
    if (b.act && this.actx) {
      try { b.act(this.actx); }
      catch (e) { console.warn(`film: beat ${i} (${b.chapter}) could not act:`, e); }
    }
    // The film's own chrome steps aside on the closing beat. The interface is
    // already up by then — it came in with the city phase — so this is only
    // the caption, the chapter mark and the transport bar clearing the frame.
    if (i === beats.length - 1 && !this._closing) {
      this._closing = true;
      this.root.classList.add('closing');
      if (!this._revealed) { this._revealed = true; this.hooks.onReveal?.(); }
    }
  }

  /** The descent is over: give the application its camera back.
   *
   * Fired by a beat marked `phase: 'city'` and, failing that, by `_finish`.
   * The second path is not a belt-and-braces guard, it is the normal one now
   * that the film ends on the dive: there is no chapter after the landing to
   * carry the mark, and `onLanded` is what unslaves scene.js's camera from this
   * one. A film that ended without it left the application holding the last
   * pose of a descent for ever.
   */
  _enterCity() {
    if (this._cityPhase) return;
    this._cityPhase = true;
    // The application's camera is its own again, and carries on from the pose
    // the film left it in.
    this.hooks.onLanded?.();
    // Captions lift clear of where the time scrubber is about to appear.
    this.root.classList.add('overcity');
    // The globe's context is no longer contributing anything; give it back.
    setTimeout(() => this._teardownGL(), 1400);
  }

  /** Interpolate the storyboard and drive everything that moves. */
  _animate(dt) {
    const beats = this.story.beats;
    const b = beats[Math.min(this.beatIndex, beats.length - 1)] || beats[0];
    const u = clamp01((this.t - b.t0) / b.dur);
    const e = (EASES[b.ease] || smooth)(u);
    // Altitude gets its own curve, and by default that curve is a straight
    // line. Every other channel wants to ease in and out of its beat; altitude
    // wants a constant number of halvings per second, because that is what a
    // constant apparent speed is, and a `smoothstep` on it puts a dead stop at
    // every beat boundary — which is precisely how the old descent came to a
    // halt two beats before it was over.
    const eAlt = (EASES[b.altEase] || EASES.lin)(u);

    // The turn gets its own curve too, and for the same reason altitude does: a
    // smoothstep per beat is a rotation that stalls at every beat boundary, and
    // a planet that hesitates three times on its way round is worse than one
    // that never turns at all. Linear by default; the beat that arrives on the
    // site asks for `out`, so the turn settles instead of stopping.
    const eTurn = (EASES[b.turnEase] || EASES.lin)(u);

    const s = this.stage;
    for (const k in STAGE0) {
      s[k] = LOG_CHANNELS.has(k) ? logLerp(b.from[k], b.to[k], eAlt)
        : k === 'turn' ? lerp(b.from[k], b.to[k], eTurn)
        : lerp(b.from[k], b.to[k], e);
    }

    // --- earth orientation ------------------------------------------------
    //
    // One turn, one direction, ending square on the study area.
    //
    // `turn` is progress along a planned rotation rather than a rate, and the
    // rotation is decomposed into two exact pieces:
    //
    //   yaw    about the polar axis, from an opening angle TURN_ONTO_SITE short
    //          of the site's meridian to the meridian itself. Both ends are
    //          computed once, in `play`, so there is no modular arithmetic and
    //          nothing to take the short way round.
    //   pitch  about the screen horizontal, lifting the site's latitude to the
    //          aim point. Orthogonal to the yaw by construction: after the yaw
    //          the site lies in the plane the pitch turns in.
    //
    // What this replaced was a free-running spin slerped toward a fixed "site
    // faces the camera" quaternion as the lock came up. Slerp takes the short
    // way round, and from wherever an accumulated spin had reached that was as
    // often backwards as forwards — the planet turned steadily one way, stopped,
    // and swung back to present the city. Under a dive that was already moving
    // nobody caught it; hold the camera still while it happens, which is what
    // this cut does, and it is the first thing anyone sees.
    // The two ride different channels, and that is the whole of the framing.
    //
    // `turn` carries the yaw and starts at the first frame: the planet turns,
    // for six and a half seconds, while the film talks about planets. `lock`
    // carries the pitch, and it is also what unwinds the axial tilt below and
    // what blends the camera from orbit to the site's own frame — so all three
    // of the things that stop this being a globe and make it a place happen
    // together, on the beat that arrives.
    //
    // Putting the pitch on `turn` instead, which is what the first version of
    // this did, rolls the planet forty degrees south over the opening while the
    // axis is still tilted and the camera is still in orbit. The globe appears
    // to be tipping over rather than turning, and by the end of chapter one it
    // is looking at the south Atlantic with New York up near the limb.
    if (this._yawTo !== null) {
      const yaw = lerp(this._yawFrom, this._yawTo, clamp01(s.turn));
      // The aim vector is (0, aim, 1) normalised, so its angle off +Z is
      // atan2(aim, 1); the site's, after the yaw, is its own latitude. The
      // difference is the whole of the remaining correction.
      const pitch = (Math.atan2(s.aim, 1) - this._siteLat) * smooth(clamp01(s.lock));
      this.earthGroup.quaternion
        .setFromAxisAngle(UP_Y, yaw)
        .premultiply(_qx.setFromAxisAngle(AXIS_X, pitch));
    }
    // A small axial tilt, because a globe spinning about the screen vertical
    // looks like a spinning ball and a tilted one looks like a planet. It
    // unwinds as the globe locks onto New York, so that when the dive begins the
    // aim vector is exact rather than 23 degrees off.
    this.tiltGroup.rotation.z = 0.41 * (1 - clamp01(s.lock));

    // --- camera -----------------------------------------------------------
    this.scene.updateMatrixWorld();
    this._placeCamera(s);

    // --- materials --------------------------------------------------------
    //
    // Three of these are altitude fades rather than storyboard channels, and
    // they are altitude fades because they are all the same bug: a shell drawn
    // around the planet is a lie that only holds from outside it. The dot layer
    // stands 25 km off the surface, the cloud layer likewise, and the air shell
    // 320 km; a camera that ends up three kilometres above Midtown is under all
    // three. Tying them to height rather than to a beat means they cannot be
    // left switched on by an edit to the script.
    const time = this.t;
    const groundward = (hi, lo) => smooth(clamp01((hi - s.alt) / (hi - lo)));
    this.earthMat.uniforms.heat.value = s.heat;
    this.dotMat.uniforms.heat.value = s.heat;
    this.dotMat.uniforms.uSize.value = 1.55 + s.dust * 2.4;
    // The instrument layers — the land dots, the city lights and the graticule
    // — hand over to the photograph rather than sitting on top of it. They are
    // a way of drawing a planet you have no picture of; once there is a picture,
    // they are furniture. All three go out across the same band, so the change
    // reads as one change.
    const instrument = 1 - groundward(7000, 3000);
    this.dotMat.uniforms.fade.value = instrument;
    this.earthMat.uniforms.detail.value = instrument;
    this.cityMat.uniforms.ignite.value = s.cities * instrument;
    this.cityMat.uniforms.bloom.value = s.bloom;
    this.cityMat.uniforms.time.value = time;
    // Cloud goes the same way and for the same reason: the shell is 25 km up.
    this.cloudMat.uniforms.amount.value = s.clouds * (1 - groundward(400, 120));
    this.cloudMat.uniforms.time.value = time;
    this.atmoMat.uniforms.heat.value = s.heat;

    // --- the satellite pyramid --------------------------------------------
    let showing = false;
    for (const p of this.patches || []) {
      const o = smooth(clamp01((p.fade[0] - s.alt) / (p.fade[0] - p.fade[1])));
      p.mat.uniforms.opacity.value = o;
      p.mat.uniforms.heat.value = s.heat;
      // Coplanar decals cannot depth-test, so this stands in for the one case
      // the test would have caught: the study area on the far side of the world.
      p.mesh.visible = o > 0.002 && this._siteFacing();
      showing = showing || p.mesh.visible;
    }
    // The credit comes up with the first frame that has imagery in it.
    if (showing !== this._crediting) {
      this._crediting = showing;
      this.root.classList.toggle('imagery', showing);
    }
    // Base 1.0, not 1.4. Additive blending multiplies the limb colour by this,
    // so 1.4 pushed the design's authored rgb(38,66,126) cold limb out to a
    // clear mid-blue and its rgb(206,108,78) warm limb past the top of the heat
    // ramp. At 1.0 the rim on screen is exactly the colour the design specifies;
    // `dust` still blows it out for the dive, which is the one place it should.
    // ... and taken away entirely before the camera crosses into it. A fresnel
    // shell is a halo on the limb seen from outside and a flat additive wash
    // over the whole frame seen from inside, and the inside is where the last
    // three hundred kilometres of this descent happen — the first cut of it
    // arrived over Midtown through a solid terracotta screen with the city
    // nowhere in it.
    // 2000 → 620 km, not 1200 → 320. The lower bound has to clear the top of
    // the atmosphere shell (573 km at R * 1.09) with room to spare: the halo is
    // gone before the camera can get inside the geometry that draws it.
    const air = 1 - groundward(2000, 620);
    this.atmoMat.uniforms.power.value = (1.0 + s.dust * 3.2) * air;
    this.atmo.visible = air > 0.004;
    this.stars.rotation.y = time * 0.004;

    // --- marker -----------------------------------------------------------
    //
    // Both the size and the life of the mark are altitude's business now. Its
    // rings were authored to read against a whole globe — the widest is seven
    // hundred kilometres across — and the descent no longer stops at a height
    // where that is a mark on a planet. Below about six thousand kilometres it
    // shrinks with the approach and then goes out, well before it would become
    // a pair of orange hoops around Manhattan.
    const pinScale = Math.min(1, Math.max(0.06, s.alt / 14000));
    const pin = s.pin * (1 - groundward(6000, 1500));
    this.markerGroup.visible = pin > 0.01;
    if (this.markerGroup.visible) {
      this.markerRings.forEach((ring, k) => {
        const p = (time * 0.42 + ring.userData.phase) % 1;
        const sc = (2.0 + p * 9.0) * pinScale;
        ring.scale.set(sc, sc, sc);
        ring.material.opacity = pin * (1 - p) * 0.85;
      });
      this.markerMast.material.opacity = pin * 0.8;
      this.markerMast.scale.setScalar(pinScale);
      // The core carries the mark's centre, so it stays the brightest thing in
      // it and shrinks on the same curve as everything else.
      this.markerCore.material.opacity = pin * 0.95;
      this.markerCore.scale.setScalar(pinScale);
    }
    this._placeLabel(pin);

    // --- the handover -----------------------------------------------------
    //
    // Not a transition. The application's camera is driven from this descent,
    // in the study area's own east-north-up frame — which is the frame scene.js
    // already works in, so the pose crosses without a projection and without
    // anything to drift. For the last seconds of the fall both renderers draw
    // the same viewpoint of the same square kilometre, and the globe canvas
    // dissolving is a photograph becoming a model, with the buildings standing
    // up out of it and the camera still moving.
    //
    // The sixty-second cut could not afford this: one camera has to travel the
    // whole ten halvings from orbit to Midtown, and six seconds could not. The
    // three-minute cut gives chapter two twelve seconds, which can — and the
    // walkthrough that follows needs the camera to arrive over the city anyway,
    // because everything after the handoff happens down there.
    if (this._handedOver && !this._cityPhase && s.lock > 0.995) {
      const h = s.alt * 1000;
      const lat = h * Math.tan(s.phi);
      this.hooks.onPose?.({
        x: Math.sin(s.az) * lat, y: h, z: -Math.cos(s.az) * lat,
        fov: s.fov,
      });
    }
    let dissolve = this._cityPhase || !this.renderer ? 1 : 0;
    if (b.phase === 'handoff') {
      // Longer when there is no satellite pyramid to fall through. The dissolve
      // is late and short because what it dissolves off is a photograph of the
      // same square kilometre; with only the land mask underneath there is
      // nothing down there worth holding on to, so the application — which is
      // already drawing the right frame — takes over sooner.
      const span = this.patches?.length ? HANDOVER_S : HANDOVER_S * 2.6;
      dissolve = clamp01((this.t - (b.t0 + b.dur - span)) / span);
    }
    this.canvas.style.opacity = String(1 - smooth(dissolve));
    if (this.readout?.kind === 'anomaly') this._drawSpark(s.counter);
  }

  /** Is the study area on this side of the planet? */
  _siteFacing() {
    if (!this._nycLocal) return false;
    const n = this._nycLocal.clone().applyMatrix4(this.earthGroup.matrixWorld).normalize();
    return n.dot(this.camera.position.clone().normalize()) > 0.1;
  }

  /** Where the camera goes.
   *
   * Two rigs, blended on `lock`, because the film asks two different things of
   * the camera and neither can do the other's job.
   *
   * Above, it orbits the earth's centre at a stated altitude and looks at the
   * middle of the planet: that is the shot for a chapter whose subject is the
   * whole world, and the globe turns under it.
   *
   * Below, once the globe has locked, the camera sits in the study area's own
   * east-north-up frame — a height, an angle off the vertical and a bearing —
   * and looks at the study area. That is not decoration either: it is the frame
   * the application's camera lives in, so the last pose of the film is a pose
   * the application can simply be given. `LANDING` is that pose, and it is
   * scene.js's own opening view written in spherical terms.
   *
   * The two are blended as a position lerp and a quaternion *slerp*, not as two
   * lerped up-vectors. Slerp takes the short way round, so the roll needed to
   * get from "north is up" to "the approach bearing is up" is spread evenly
   * across the beat instead of being spent all at once at the end — and, more
   * to the point, a lerped up-vector passes through the view axis on a camera
   * that is looking straight down, where `lookAt` has no answer at all.
   */
  _placeCamera(s) {
    const dist = R + s.alt * UNITS_PER_KM;
    const orbit = new THREE.Vector3(0, Math.sin(s.tilt) * dist, Math.cos(s.tilt) * dist);
    const w = this._nycLocal ? smooth(clamp01(s.lock)) : 0;

    // Near plane tracks the altitude. Seven orders of magnitude of it, which is
    // why the renderer runs a logarithmic depth buffer.
    const h = Math.max(s.alt * UNITS_PER_KM, 1e-5);
    this.camera.near = Math.min(0.5, Math.max(2e-4, h * 0.05));
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();

    if (w <= 0.0005) {
      this.camera.position.copy(orbit);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      return;
    }

    const M = this.earthGroup.matrixWorld;
    const site = this._nycLocal.clone().applyMatrix4(M);
    const up = site.clone().normalize();
    const north = this._northLocal.clone().transformDirection(M);
    const east = north.clone().cross(up).normalize();
    north.crossVectors(up, east).normalize();

    const lateral = h * Math.tan(s.phi);
    const dive = site.clone()
      .addScaledVector(up, h)
      .addScaledVector(east, Math.sin(s.az) * lateral)
      .addScaledVector(north, Math.cos(s.az) * lateral);

    const qa = _q(_look(orbit, ORIGIN, UP_Y));
    const qb = _q(_look(dive, site, up));
    this.camera.position.lerpVectors(orbit, dive, w);
    this.camera.quaternion.slerpQuaternions(qa, qb, w);
    // The renderer would do this at draw time, but the marker label projects a
    // world point through the camera before then and would otherwise be placed
    // with last frame's matrices — which at the speeds this thing moves is a
    // label trailing a visible distance behind its own mark.
    this.camera.updateMatrixWorld(true);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
  }

  /** The DOM label that rides on top of the marker. Projecting a world point to
   *  screen space and moving an HTML element keeps the type crisp and lets it
   *  use the same fonts as the rest of the interface. */
  _placeLabel(pin) {
    const el = $('film-marker');
    if (!this._nycLocal || pin < 0.02) { el.style.opacity = '0'; return; }
    const world = this._nycLocal.clone().applyMatrix4(this.earthGroup.matrixWorld);
    const toCam = this.camera.position.clone().sub(world).normalize();
    const normal = world.clone().normalize();
    const facing = toCam.dot(normal);
    const p = world.clone().project(this.camera);
    const x = (p.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-p.y * 0.5 + 0.5) * window.innerHeight;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.style.opacity = String(pin * clamp01((facing - 0.05) * 4));
  }

  /** The GISTEMP sparkline, drawn up to the point the narration has reached. */
  _drawSpark(progress) {
    const cv = $('film-spark');
    const { years, anomaly } = this.assets.temp;
    const dpr = Math.min(window.devicePixelRatio, 2);
    // Read the box the stylesheet gave it. Hard-coding 340x62 here while the CSS
    // said 300x54 drew the curve into a canvas the browser then squashed.
    const W = Math.round(cv.clientWidth) || 300;
    const H = Math.round(cv.clientHeight) || 54;
    if (cv.width !== Math.round(W * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const lo = Math.min(...anomaly), hi = Math.max(...anomaly);
    const n = Math.max(2, Math.round(clamp01(progress) * anomaly.length));
    const X = (i) => (i / (anomaly.length - 1)) * (W - 2) + 1;
    const Y = (v) => H - 6 - ((v - lo) / (hi - lo)) * (H - 14);

    // Zero line, so the curve is read against the baseline it is measured from.
    ctx.strokeStyle = 'rgba(237,231,220,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();

    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    for (let i = 1; i < n; i++) {
      // Coloured by the same ramp as everything else, rather than by the
      // hand-rolled gradient that used to be here: this curve is a temperature
      // series, so it reads on the legend the rest of the piece teaches.
      const t = clamp01((anomaly[i] - lo) / (hi - lo));
      ctx.strokeStyle = css(RAMPS.temperature(0.12 + t * 0.84));
      ctx.beginPath();
      ctx.moveTo(X(i - 1), Y(anomaly[i - 1]));
      ctx.lineTo(X(i), Y(anomaly[i]));
      ctx.stroke();
    }
    const i = n - 1;
    ctx.fillStyle = css(RAMPS.temperature(0.9));
    ctx.beginPath(); ctx.arc(X(i), Y(anomaly[i]), 2.6, 0, Math.PI * 2); ctx.fill();

    $('film-readout-value').textContent =
      `${years[i]}    ${anomaly[i] > 0 ? '+' : ''}${anomaly[i].toFixed(2)} K`;
  }

  // ---------------------------------------------------------------- shutdown

  /* -------------------------------------------------------- transport bar

     A real transport bar: four segments sized by chapter length, a running
     clock, chapter stepping, pause, sound and the exit. The previous version
     offered SOUND and SKIP only, which meant the sole way to see a chapter
     again was to reload the page — and that reloaded the whole city with it.  */

  _buildSegments() {
    const box = $('film-segs');
    if (!box) return;
    box.innerHTML = '';
    this._segs = this.chapters.map((c, i) => {
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.flex = String(c.dur);
      seg.title = c.title ? `${c.n} · ${c.title}` : c.n;
      seg.innerHTML = `<span class="tr"><i></i></span><span class="n">${c.n}</span>`;
      seg.onclick = () => this._seek(c.t0 + 0.001);
      box.appendChild(seg);
      return { el: seg, fill: seg.querySelector('i'), c, i };
    });
  }

  _paintTransport() {
    if (!this._segs) return;
    for (const s of this._segs) {
      const p = clamp01((this.t - s.c.t0) / s.c.dur);
      s.fill.style.transform = `scaleX(${p.toFixed(4)})`;
      s.el.classList.toggle('on', this.t >= s.c.t0 && this.t < s.c.end);
    }
    const time = $('film-time');
    if (time) time.textContent = `${clock(Math.min(this.t, this.total))} / ${clock(this.total)}`;
  }

  /** Move the clock. Everything else follows from it: `t0` is rebased so the
   *  wall-clock loop reads the new time, and `beatIndex` is invalidated so the
   *  caption, chapter mark, ticker and narration all re-fire for wherever we
   *  have landed rather than only if the beat happened to be entered in order. */
  _seek(t) {
    if (!this.running) return;
    this.t = Math.max(0, Math.min(this.total - 0.05, t));
    this.t0 = performance.now() - this.t * 1000;
    this.beatIndex = -1;
    this._chapter = null;
    this.readout = null;
    // Stepping back over the handover has to undo it. Without this, going back
    // a chapter from the city left the globe canvas dissolved to nothing and the
    // application's camera still holding the last pose of a descent that was
    // about to happen again — a black screen with a caption on it.
    const handoff = this.story.beats.find((x) => x.phase === 'handoff');
    if (handoff && this.t < handoff.t0 && this.renderer) {
      this._handedOver = false;
      this._cityPhase = false;
      this.root.classList.remove('overcity');
    }
    // The turn needs nothing undone here: it is a function of `stage.turn` and
    // two angles fixed at `play`, so any point on the clock reproduces exactly
    // the orientation it had the first time through.
    //
    // The application is not a function of the clock, though, and that is what
    // the replay below is for. From chapter three on, each beat's `act` moves
    // the real interface — selects a building, opens a document, changes a
    // layer — and those are edits, not renders: nothing puts them back. Seek
    // past them and the caption talks about a panel that never opened; seek
    // backwards and a document stays up over the chapter that followed it.
    //
    // So a seek re-runs every act from the beginning up to wherever it landed.
    // They are setters and idempotent by construction, so running the whole
    // prefix costs a few dozen calls and leaves the interface in exactly the
    // state that point in the film describes. It is the only way the scrubber
    // and the chapter buttons can be honest about two thirds of the running
    // time.
    if (this.actx) {
      const upto = this.story.beats.findIndex((x) => this.t < x.t0 + x.dur);
      const last = upto < 0 ? this.story.beats.length - 1 : upto;
      for (let k = 0; k <= last; k++) {
        const act = this.story.beats[k].act;
        if (!act) continue;
        try { act(this.actx); }
        catch (e) { console.warn(`film: replaying beat ${k} failed:`, e); }
      }
    }
    this.narrator?.cancel();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (this.paused) this._setPaused(false);
  }

  _chapterIndexAt(t) {
    for (let i = this.chapters.length - 1; i >= 0; i--) {
      if (t >= this.chapters[i].t0) return i;
    }
    return 0;
  }

  /** Back a chapter — or to the start of this one, if we are more than a moment
   *  into it. Which is what the same button does on every music player, and the
   *  reason it does is that "back" almost always means "play that again". */
  prevChapter() {
    const i = this._chapterIndexAt(this.t);
    const local = this.t - this.chapters[i].t0;
    const target = local > 1.6 ? i : Math.max(0, i - 1);
    this._seek(this.chapters[target].t0 + 0.001);
  }

  nextChapter() {
    const i = this._chapterIndexAt(this.t);
    if (i >= this.chapters.length - 1) { this.skip(); return; }
    this._seek(this.chapters[i + 1].t0 + 0.001);
  }

  _setPaused(on) {
    if (on === this.paused) return;
    this.paused = on;
    if (on) {
      this.narrator?.pause();
      if (window.speechSynthesis) window.speechSynthesis.pause?.();
    } else {
      // Rebase so the elapsed time picks up where it was left, rather than
      // jumping forward by however long the pause lasted.
      this.t0 = performance.now() - this.t * 1000;
      this.narrator?.resume();
      if (window.speechSynthesis) window.speechSynthesis.resume?.();
    }
    const b = $('film-play');
    if (b) {
      b.title = on ? 'Play' : 'Pause';
      b.innerHTML = on
        ? '<svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true">'
          + '<path d="M0 0 L10 5.5 L0 11 Z" fill="currentColor"></path></svg>'
        : '<svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true">'
          + '<rect x="0" y="0" width="3" height="11" fill="currentColor"></rect>'
          + '<rect x="6" y="0" width="3" height="11" fill="currentColor"></rect></svg>';
    }
  }

  togglePlay() { this._setPaused(!this.paused); }

  _soundLabel() {
    const b = $('film-sound');
    if (!b) return;
    b.textContent = this.sound ? 'SOUND ON' : 'SOUND OFF';
    b.setAttribute('aria-pressed', String(this.sound));
  }

  /** Wire the bar. Called once, by main.js, before the film starts: the buttons
   *  are inert until `running`, and `_seek` guards on that. */
  bindTransport() {
    $('film-prev')?.addEventListener('click', () => this.prevChapter());
    $('film-next')?.addEventListener('click', () => this.nextChapter());
    $('film-play')?.addEventListener('click', () => this.togglePlay());
    $('film-skip')?.addEventListener('click', () => this.skip());
    const snd = $('film-sound');
    if (snd) {
      snd.addEventListener('click', () => this.setSound(!this.sound));
      this._soundLabel();
    }
    // Space pauses, the arrows step chapters — the same keys the atlas uses for
    // the same ideas, so the two halves of the piece are one instrument.
    this._transportKeys = (e) => {
      if (!this.running) return;
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
      if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.nextChapter(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.prevChapter(); }
    };
    window.addEventListener('keydown', this._transportKeys);
  }

  _finish() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this._enterCity();
    this.hooks.onReveal?.();
    this.root.classList.add('over');
    this._report();
    this._stopScore(2.4);
    setTimeout(() => this._destroy(), 1600);
    this._resolve?.('ended');
  }

  /** Add the voice to the on-screen credit, and only if it is actually being
   *  used. The line already names whose satellite imagery the descent is flown
   *  over, on the principle that a credit belongs in the frame rather than in a
   *  file; a synthesised voice is the same kind of borrowing, and ElevenLabs
   *  asks for the attribution on the free plan besides. It is appended here
   *  rather than written into index.html because a build with no key and no
   *  cached audio is narrated by the browser, and crediting ElevenLabs for that
   *  would be a false claim on screen for ninety seconds. */
  _creditVoice() {
    const el = $('film-credit');
    if (!el || el.dataset.voiced) return;
    el.dataset.voiced = '1';
    el.insertAdjacentHTML('beforeend',
      '<span class="sep">\u00a0\u00a0·\u00a0\u00a0</span>VOICE\u00a0\u00a0·\u00a0\u00a0ELEVENLABS');
  }

  /** What the voice-over could not do, said once, at the end.
   *
   * Not a warning and not an error: it is a note to whoever edits story.js. An
   * overrun names a beat whose recording will not fit its shot even hurried, and
   * a mismatch names one whose sentence changed after it was recorded. Both are
   * fixed in the script rather than here — shorten the line, or accept that the
   * browser reads that one. */
  _report() {
    const n = this.narrator;
    if (!n?.enabled) return;
    const over = n.overruns(this.story.beats);
    if (over.length) console.info('film: lines longer than their shot', over);
    if (n.mismatched.length) {
      console.info('film: lines that changed after they were recorded', n.mismatched);
    }
  }

  /** Abandon the film. Everything the city needs has already been built, so
   *  this only has to get the overlay out of the way in a hurry. */
  skip() {
    if (this.disposed) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.narrator?.destroy();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this._stopIdle();
    this._stopScore(0.5);
    this.hooks?.onSkip?.();
    this.hooks?.onReveal?.();
    this.root.classList.add('over');
    setTimeout(() => this._destroy(), 700);
    this._resolve?.('skipped');
  }

  _teardownGL() {
    if (!this.renderer) return;
    this.renderGlobe = false;
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.landTex?.dispose();
    for (const p of this.patches || []) p.tex.dispose();
    this.patches = [];
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer = null;
    this.canvas.remove();
  }

  _destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this._stopIdle();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    if (this._transportKeys) window.removeEventListener('keydown', this._transportKeys);
    this.narrator?.destroy();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this._teardownGL();
    this._stopScore(0.4);
    this.root.remove();
  }
}

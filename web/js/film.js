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
 * - The transition is a real cross-fade, not a cut. The city camera starts its
 *   descent roughly a second *before* the globe canvas fades, so what appears
 *   underneath is already moving. A cut to a static frame reads as a page load;
 *   a fade to a moving frame reads as the same shot continuing.
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
 */

import * as THREE from 'three';
import { buildStory } from './story.js';

const $ = (id) => document.getElementById(id);

/** Globe radius, in the film's own units. Everything else is a multiple. */
const R = 100;

/** Inferno, as GLSL. The same ramp the application uses for temperature, so the
 *  planet warming in the opening and the facades in the model speak one
 *  colour language. Five interior stops is plenty at globe scale. */
const INFERNO_GLSL = `
vec3 inferno(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.000, 0.000, 0.016);
  vec3 c1 = vec3(0.259, 0.039, 0.408);
  vec3 c2 = vec3(0.576, 0.149, 0.404);
  vec3 c3 = vec3(0.867, 0.318, 0.227);
  vec3 c4 = vec3(0.988, 0.647, 0.039);
  vec3 c5 = vec3(0.988, 1.000, 0.644);
  if (t < 0.2) return mix(c0, c1, t / 0.2);
  if (t < 0.4) return mix(c1, c2, (t - 0.2) / 0.2);
  if (t < 0.6) return mix(c2, c3, (t - 0.4) / 0.2);
  if (t < 0.8) return mix(c3, c4, (t - 0.6) / 0.2);
  return mix(c4, c5, (t - 0.8) / 0.2);
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
const SPIN0 = -186 * Math.PI / 180;

const STAGE0 = {
  dist: 640,     // camera distance from the earth's centre
  fov: 27,
  tilt: 0.14,    // camera elevation above the equatorial plane, radians
  spin: 3.2,     // idle rotation, degrees per second
  heat: 0,       // warming tint, 0..1
  cities: 0,     // how many of the world's cities have lit
  bloom: 0,      // city-light pulsing
  lock: 0,       // how firmly the globe is held with New York facing us
  aim: 0.12,     // where on screen the locked point sits, up from centre
  pin: 0,        // New York marker
  clouds: 0,
  dust: 0,       // atmospheric streaking during the dive
  flash: 0,      // warm wash over the cut
  fade: 0,       // globe canvas dissolve
  counter: 0,    // progress along the GISTEMP series
};

/** Master level for the score. Loud enough to be part of the film rather than a
 *  rumour of one, and still well under the narration it sits beneath. */
const SCORE_LEVEL = 0.55;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (t) => t * t * (3 - 2 * t);
const easeIn = (t) => t * t;

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

  constructor() {
    this.root = $('film');
    this.canvas = $('film-gl');
    this.sound = localStorage.getItem('hc.film.sound') !== 'off';
    this.beatIndex = -1;
    this.t = 0;
    this.running = false;
    this.disposed = false;
    this.nodes = [];
    this.stage = { ...STAGE0 };
    this._spin = SPIN0;
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
    return this.assets;
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
    this._buildDots();
    this._buildCityLights();
    this._buildClouds();
    this._buildAtmosphere();
    this._buildMarker();

    this._resize();
    window.addEventListener('resize', this._onResize);
  }

  _buildStars() {
    const N = 2600;
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
      const b = 0.25 + Math.pow(Math.random(), 2.4) * 0.75;
      const warm = Math.random() < 0.15;
      col[i * 3] = b * (warm ? 1.0 : 0.82);
      col[i * 3 + 1] = b * 0.88;
      col[i * 3 + 2] = b * (warm ? 0.82 : 1.0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 2.4, sizeAttenuation: false, vertexColors: true,
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
        varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
        ${INFERNO_GLSL}
        void main() {
          float l = smoothstep(0.35, 0.62, texture2D(land, vUv).r);
          vec3 N = normalize(vN);
          float day = smoothstep(-0.14, 0.30, dot(N, sunDir));

          vec3 ocean = mix(vec3(0.006, 0.017, 0.036), vec3(0.039, 0.086, 0.145), day);
          vec3 soil  = mix(vec3(0.030, 0.032, 0.038), vec3(0.176, 0.166, 0.145), day);
          vec3 c = mix(ocean, soil, l);

          // The warming tint is weighted toward the tropics and toward land,
          // because that is where the anomaly is actually lived. A uniform wash
          // would be a lie the shader tells for free.
          float lat = abs(vUv.y - 0.5) * 2.0;
          float w = 1.0 - smoothstep(0.15, 0.95, lat);
          float amount = heat * mix(0.22, 1.0, w);
          c = mix(c, inferno(0.30 + 0.45 * amount),
                  amount * mix(0.10, 0.50, l) * mix(0.40, 1.0, day));

          // Graticule every 15 degrees, at the edge of visibility. It reads as
          // an instrument rather than a photograph, which is what this is.
          vec2 gv = vUv * vec2(24.0, 12.0);
          vec2 gd = abs(fract(gv) - 0.5) / max(fwidth(gv), 1e-5);
          float line = 1.0 - min(min(gd.x, gd.y), 1.0);
          c += vec3(0.10, 0.14, 0.20) * line * 0.30 * (0.30 + 0.70 * day);

          vec3 V = normalize(cameraPosition - vPos);
          float rim = 1.0 - max(dot(V, N), 0.0);
          c *= mix(1.0, 0.52, pow(rim, 2.0));
          c += mix(vec3(0.16, 0.24, 0.42), vec3(0.42, 0.20, 0.10), heat * 0.7)
               * pow(rim, 4.0) * 0.55;

          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(R, 160, 96), this.earthMat);
    this.earthGroup.add(this.earth);
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
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aSeed;
        uniform float heat; uniform float uSize; uniform vec3 sunDir;
        varying vec3 vC; varying float vB;
        ${INFERNO_GLSL}
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
          vC = mix(vec3(0.26, 0.31, 0.39), inferno(t), heat * 0.9);
          vB = 0.28 + 0.46 * night;
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
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.02, 96, 56), this.cloudMat);
    this.clouds.renderOrder = 2;
    this.earthGroup.add(this.clouds);
  }

  _buildAtmosphere() {
    this.atmoMat = new THREE.ShaderMaterial({
      uniforms: { heat: { value: 0 }, power: { value: 1.5 } },
      side: THREE.BackSide, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec3 vN; varying vec3 vPos;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float heat; uniform float power;
        varying vec3 vN; varying vec3 vPos;
        void main() {
          vec3 V = normalize(cameraPosition - vPos);
          float f = pow(clamp(1.0 - abs(dot(V, normalize(vN))), 0.0, 1.0), 2.4);
          vec3 c = mix(vec3(0.20, 0.42, 0.90), vec3(0.98, 0.46, 0.18), heat * 0.65);
          gl_FragColor = vec4(c * f * power, 1.0);
        }`,
    });
    // 1.03, not 1.085. A shell much larger than the globe reads as a bubble
    // around it — a second hard-edged circle standing off the limb — rather than
    // as air. Close in, the fresnel band lands on the horizon where it belongs.
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.03, 64, 40), this.atmoMat);
    this.atmo.renderOrder = 3;
    this.scene.add(this.atmo);
  }

  /** A ring sitting flat on the surface at the study area, plus a short mast, so
   *  the place has a mark on the globe before the camera commits to it. */
  _buildMarker() {
    this.markerGroup = new THREE.Group();
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
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 7, 6), mat());
    mast.position.y = 3.5;
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
      this.camera.updateProjectionMatrix();
      this.camera.position.set(0, Math.sin(0.16) * dist, Math.cos(0.16) * dist);
      this.camera.lookAt(0, 0, 0);

      this.earthMat.uniforms.heat.value = 0;
      this.dotMat.uniforms.heat.value = 0;
      this.cityMat.uniforms.time.value = t;
      this.atmoMat.uniforms.power.value = 1.4;
      this.stars.rotation.y = t * 0.004;

      this.renderer.render(this.scene, this.camera);
      this.idleRaf = requestAnimationFrame(step);
    };
    this.idleRaf = requestAnimationFrame(step);
  }

  _stopIdle() {
    this.idling = false;
    cancelAnimationFrame(this.idleRaf);
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

  _speak(beat) {
    if (!this.sound || !this.voice || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(beat.say || beat.text);
      u.voice = this.voice;
      u.lang = this.voice.lang || 'en-GB';
      u.rate = 0.86; u.pitch = 0.82; u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch { /* speech is a bonus, never a dependency */ }
  }

  // -------------------------------------------------------------------- play

  /** Run the film. Resolves when the last caption has cleared, or immediately
   *  on a skip. `hooks.onHandoff` fires as the dive bottoms out and is where the
   *  city takes over; `hooks.onReveal` fires as the last beat begins. */
  play(data, hooks = {}) {
    this.hooks = hooks;
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
    this.placeMarker(this.story.marker.lon, this.story.marker.lat);
    this._nycLocal = lonLatToVec3(this.story.marker.lon, this.story.marker.lat, R);

    this._stopIdle();
    const { lat, lon } = this.story.marker;
    $('film-credit').textContent = this.story.credit;
    $('film-marker-name').textContent = this.story.marker.name.toUpperCase();
    $('film-marker-coords').textContent =
      `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
    $('film-hud').hidden = false;
    this.root.classList.add('playing');

    this._startScore();
    this.running = true;
    this.t = 0;
    this.beatIndex = -1;
    this.t0 = this.last = performance.now();
    this._loop();

    return new Promise((resolve) => { this._resolve = resolve; });
  }

  /** Beat durations come from their own sentences: long lines get long shots. */
  _prepareBeats() {
    const speaking = !!this.voice && this.sound;
    // Measured against the platform voices at rate 0.84; the silent pace is what
    // a comfortable reader needs, which is quicker.
    const wps = speaking ? 2.6 : 3.4;
    let t = 0;
    let stage = { ...STAGE0 };
    this.story.beats.forEach((b) => {
      const words = b.text.trim().split(/\s+/).length;
      b.dur = Math.max(2.6, words / wps + (b.hold ?? 0.7));
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
    this.t = (now - this.t0) / 1000;
    this._advance();
    this._animate(dt);
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

    const cap = $('film-caption');
    cap.textContent = b.text;
    cap.classList.remove('in');
    void cap.offsetWidth;          // restart the fade-in transition
    cap.classList.add('in');

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
        const card = $('film-chaptercard');
        card.classList.remove('in');
        void card.offsetWidth;
        card.classList.add('in');
        this._accent(i === 0 ? 116 : 92);
      }
    }

    let ro = null;
    for (let k = i; k >= 0 && !ro; k--) ro = this.story.readouts[k] || null;
    if (ro && ro !== this.readout) {
      this.readout = ro;
      $('film-readout-label').textContent = ro.label;
      $('film-readout-value').textContent = ro.value || '';
      $('film-readout').classList.add('in');
      $('film-spark').hidden = ro.kind !== 'anomaly';
    }

    this._speak(b);

    if (b.phase === 'handoff' && !this._handedOver) {
      this._handedOver = true;
      // The city starts moving before it is visible. By the time the globe has
      // dissolved, its camera is already mid-descent, so the two shots read as
      // one continuous move rather than a cut to a still frame.
      this.hooks.onHandoff?.(b.dur);
      if (this.airGain && this.ac) {
        const t = this.ac.currentTime;
        this.airGain.gain.linearRampToValueAtTime(0.12, t + b.dur * 0.7);
        this.subGain.gain.linearRampToValueAtTime(0.34, t + b.dur * 0.6);
        this.airGain.gain.linearRampToValueAtTime(0.0, t + b.dur + 3.0);
        this.subGain.gain.linearRampToValueAtTime(0.04, t + b.dur + 3.0);
      }
    }
    if (b.phase === 'city' && !this._cityPhase) {
      this._cityPhase = true;
      // Captions lift clear of where the time scrubber is about to appear. The
      // readouts stay: the panels are still hidden, and the figures the voice is
      // quoting are worth having on screen while it quotes them.
      this.root.classList.add('overcity');
      // The globe's context is no longer contributing anything; give it back.
      setTimeout(() => this._teardownGL(), 1400);
    }
    // The interface assembles under the closing line rather than the first one
    // after the cut, so the middle of the last chapter still has the frame to
    // itself. Everything of the film's that wants a corner steps aside here.
    if (i === beats.length - 1 && !this._revealed) {
      this._revealed = true;
      this.root.classList.add('closing');
      this.hooks.onReveal?.();
    }
  }

  /** Interpolate the storyboard and drive everything that moves. */
  _animate(dt) {
    const beats = this.story.beats;
    const b = beats[Math.min(this.beatIndex, beats.length - 1)] || beats[0];
    const u = clamp01((this.t - b.t0) / b.dur);
    const e = b.ease === 'in' ? easeIn(u) : smooth(u);

    const s = this.stage;
    for (const k in STAGE0) s[k] = lerp(b.from[k], b.to[k], e);
    // The wash over the cut is the one channel that must not share the beat's
    // easing. It arrives with the cut and has to be gone a moment later; ridden
    // out over a nine-second caption it leaves the city looking sepia-toned for
    // the whole first line.
    if (b.to.flash < b.from.flash) {
      s.flash = lerp(b.from.flash, b.to.flash, smooth(clamp01(u * 3.4)));
    }

    // --- earth orientation ------------------------------------------------
    this._spin = (this._spin || 0) + (s.spin * Math.PI / 180) * dt;
    const spinQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._spin);
    if (s.lock > 0.0005 && this._nycLocal) {
      const aim = new THREE.Vector3(0, s.aim, 1).normalize();
      const lockQ = new THREE.Quaternion().setFromUnitVectors(
        this._nycLocal.clone().normalize(), aim);
      this.earthGroup.quaternion.copy(spinQ).slerp(lockQ, smooth(clamp01(s.lock)));
    } else {
      this.earthGroup.quaternion.copy(spinQ);
    }
    // A small axial tilt, because a globe spinning about the screen vertical
    // looks like a spinning ball and a tilted one looks like a planet. It
    // unwinds as the globe locks onto New York, so that when the dive begins the
    // aim vector is exact rather than 23 degrees off.
    this.tiltGroup.rotation.z = 0.41 * (1 - clamp01(s.lock));

    // --- camera -----------------------------------------------------------
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, Math.sin(s.tilt) * s.dist, Math.cos(s.tilt) * s.dist);
    this.camera.lookAt(0, 0, 0);

    // --- materials --------------------------------------------------------
    const time = this.t;
    this.earthMat.uniforms.heat.value = s.heat;
    this.dotMat.uniforms.heat.value = s.heat;
    this.dotMat.uniforms.uSize.value = 1.55 + s.dust * 2.4;
    this.cityMat.uniforms.ignite.value = s.cities;
    this.cityMat.uniforms.bloom.value = s.bloom;
    this.cityMat.uniforms.time.value = time;
    this.cloudMat.uniforms.amount.value = s.clouds;
    this.cloudMat.uniforms.time.value = time;
    this.atmoMat.uniforms.heat.value = s.heat;
    this.atmoMat.uniforms.power.value = 1.4 + s.dust * 3.2;
    this.stars.rotation.y = time * 0.004;

    // --- marker -----------------------------------------------------------
    this.markerGroup.visible = s.pin > 0.01;
    if (this.markerGroup.visible) {
      this.markerRings.forEach((ring, k) => {
        const p = (time * 0.42 + ring.userData.phase) % 1;
        const sc = 2.0 + p * 9.0;
        ring.scale.set(sc, sc, sc);
        ring.material.opacity = s.pin * (1 - p) * 0.85;
      });
      this.markerMast.material.opacity = s.pin * 0.8;
    }
    // The label is projected from world space, so the matrices it reads must be
    // this frame's, not the renderer's from the last one.
    this.scene.updateMatrixWorld();
    this._placeLabel(s.pin);

    // --- overlays ---------------------------------------------------------
    $('film-flash').style.opacity = String(s.flash);
    this.canvas.style.opacity = String(1 - s.fade);
    if (this.readout?.kind === 'anomaly') this._drawSpark(s.counter);
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
    const W = 340, H = 62;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const lo = Math.min(...anomaly), hi = Math.max(...anomaly);
    const n = Math.max(2, Math.round(clamp01(progress) * anomaly.length));
    const X = (i) => (i / (anomaly.length - 1)) * (W - 2) + 1;
    const Y = (v) => H - 6 - ((v - lo) / (hi - lo)) * (H - 14);

    // Zero line, so the curve is read against the baseline it is measured from.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();

    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    for (let i = 1; i < n; i++) {
      const t = clamp01((anomaly[i] - lo) / (hi - lo));
      ctx.strokeStyle = `rgb(${Math.round(120 + 135 * t)},${Math.round(120 - 40 * t)},${Math.round(150 - 110 * t)})`;
      ctx.beginPath();
      ctx.moveTo(X(i - 1), Y(anomaly[i - 1]));
      ctx.lineTo(X(i), Y(anomaly[i]));
      ctx.stroke();
    }
    const i = n - 1;
    ctx.fillStyle = '#ffd08a';
    ctx.beginPath(); ctx.arc(X(i), Y(anomaly[i]), 2.6, 0, Math.PI * 2); ctx.fill();

    $('film-readout-value').textContent =
      `${years[i]}    ${anomaly[i] > 0 ? '+' : ''}${anomaly[i].toFixed(2)} K`;
  }

  // ---------------------------------------------------------------- shutdown

  _finish() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.hooks.onReveal?.();
    this.root.classList.add('over');
    this._stopScore(2.4);
    setTimeout(() => this._destroy(), 1600);
    this._resolve?.('ended');
  }

  /** Abandon the film. Everything the city needs has already been built, so
   *  this only has to get the overlay out of the way in a hurry. */
  skip() {
    if (this.disposed) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
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
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this._teardownGL();
    this._stopScore(0.4);
    this.root.remove();
  }
}

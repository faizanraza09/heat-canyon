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
import { RAMPS, norm, SHADE_RGB, SUNLIT_RGB, TEMP_DOMAIN, EXCESS_DOMAIN } from './colors.js';
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
/* Dimming is now mostly a drain of colour and only a little a drop in
 * brightness, because both ends of the ramp are dark and brightness is spoken
 * for. DIM alone at 0.46 is what made a dimmed hot wall indistinguishable from
 * the shell behind it, and on the blue-to-red ramp it would do the same to a
 * dimmed freezing one. */
const DIM = 0.72;
const DIM_DESAT = 0.72;

/* How much of that recession is currently applied, 0 to 1.
 *
 * For the interface this is always 1 and always was: a click selects, and the
 * city steps back on the frame the click lands. Nothing about that changes.
 *
 * It exists for the film, and for one specific fault. The walkthrough arrives
 * out of a two-and-a-half-minute-per-halving fall through cloud and satellite
 * imagery into a lit city — the best-looking thing in the whole piece — and
 * then, on the frame chapter three begins, selects a building and drains four
 * thousand others to grey. The cut from the descent to the walkthrough was a cut
 * from a photograph to a diagram, and it landed on the sentence that is supposed
 * to make you interested. Ramped over the sentence instead, the city is still a
 * city when we arrive and has stepped back by the time the line is finished,
 * which is the same information delivered as a move rather than as a switch. */
const DIM_FULL = 1;

/* And how much of the rest of the city you can see *through*, while one
 * building is selected.
 *
 * Draining colour says "not the subject", which is the whole job as long as the
 * subject is visible. In Midtown it routinely is not: the thing that hides a
 * tower is the tower in front of it, and no amount of desaturation moves an
 * opaque wall out of the way. So a selection also makes everything else
 * see-through, and the answer to "which building is that" stops depending on
 * where the camera happens to be standing.
 *
 * Stippled rather than blended, which is the part worth explaining. The city is
 * two merged meshes of some five thousand buildings; turning either one
 * `transparent` moves it into the sorted pass, where a single mesh cannot be
 * sorted against itself — the draw order becomes the index order, and the
 * result is five thousand buildings blending in whatever sequence they happened
 * to be built in. Hashed alpha keeps both meshes in the opaque pass with the
 * depth buffer doing the sorting exactly as it does now, and spends alpha as a
 * fraction of pixels kept instead. The dither is stable in world space, so it
 * sits on the surface like a screen tint rather than crawling as the camera
 * moves, and the selected building is written at full alpha and stays solid.
 *
 * 0.42 is where a sweep put it, and the number is only half the answer — see
 * `_selOverlay` for the other half. Alpha spent as a fraction of pixels
 * MULTIPLIES down a line of sight: at 0.55 a selected tower standing behind two
 * ghosted neighbours reached the screen through 0.45 x 0.45 of their holes, so
 * a fifth of its pixels survived and the subject came out sparser than the
 * things hiding it. Lower alpha widens the holes, but it cannot fix that on its
 * own — three layers deep the product is small at any setting worth looking at.
 * So the overlay guarantees the subject and this number is free to be chosen
 * for the CONTEXT alone: low enough that the city clearly steps back, high
 * enough that it still reads as buildings rather than as noise. */
const GHOST = 0.42;

/* Give one of the city's merged meshes a per-vertex see-through amount.
 *
 * `aGhost` is carried as its own attribute rather than as a fourth colour
 * channel on purpose: every recolour path in this file writes colour in threes,
 * and widening that attribute would mean rewriting each of them for a value
 * that changes only when the selection does.
 *
 * The multiply lands after `color_fragment`, which is where three has just
 * folded the vertex colour into `diffuseColor`, and before `alphahash_fragment`
 * reads the alpha back out to decide whether to keep the pixel. */
/* The selected building again, drawn last and never occluded.
 *
 * Hashed alpha sorts correctly but it spends alpha as pixels, and pixels
 * compound: whatever stands in front of the subject removes a fraction of it,
 * and two ordinary neighbours are enough to reduce the one building the view is
 * about to a stipple fainter than its surroundings. No value of GHOST fixes
 * that, because the loss is a product and the fix has to be a guarantee.
 *
 * So the subject is drawn a second time from the SAME geometry — no extra
 * buffers, one more draw call, and only while something is selected — with the
 * depth test off so nothing can take pixels from it. `vGhost` is already the
 * flag this needs: the recolour writes 1 on the selection and GHOST everywhere
 * else, so keeping only the full-alpha fragments isolates the subject without a
 * second attribute to keep in step. The mesh is hidden when nothing is
 * selected, which is also when that test would let the whole city through. */
function selOverlay(mat) {
  /* Drawn last, against a depth buffer of its own.
   *
   * The first version simply switched the depth test off, which is wrong the
   * moment a building is not convex — and Manhattan buildings are routinely not:
   * setbacks, L-plans, light wells, re-entrant corners. With no depth test a
   * building's own far wall paints over its near one, so the subject came out
   * looking like a cut-away with its inside showing.
   *
   * What the overlay actually needs is not "no depth" but "no depth from
   * anything else": the rest of the city must not occlude it, while its own
   * walls must still occlude each other. So the depth buffer is cleared once,
   * immediately before it draws, and the normal test and write are left on.
   *
   * That clear is only safe because these two meshes are the last thing in the
   * frame — hence `transparent`, which moves them into the sorted pass, and a
   * render order past everything in it. Nothing is drawn afterwards, so nothing
   * can find the depth it needed gone. */
  mat.transparent = true;
  mat.depthTest = true;
  mat.depthWrite = true;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aGhost;\nvarying float vGhost;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvGhost = aGhost;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vGhost;')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\nif ( vGhost < 0.999 ) discard;');
  };
  return mat;
}

/* Isotherms over the painted ramp, drawn in the fragment shader.
 *
 * WHY THE SCENE NEEDS A CHANNEL THAT IS NOT COLOUR.
 *
 * The fixed scale is 80 K wide and integrates to about 102 dE in OKLab, so one
 * just-noticeable difference is roughly 0.8 K. The median solved field spans
 * 4.0 K from its 1st to its 99th percentile. Five distinguishable colours, for
 * 29,415 panels, on 55 of the 104 solved fields. No ramp fixes that — a
 * perceptually even respacing of the stops buys about 2x and the theoretical
 * ceiling is the ceiling.
 *
 * Contours are the answer cartography reached for the identical problem, which
 * is a hypsometric tint that cannot carry relief. They add structure without
 * touching a single hue, so nothing about the absolute scale is given up, and
 * they do something the ramp and the gain both cannot: they make FLATNESS
 * legible. A January night under four widely spaced lines reads as a shallow
 * field, where the same night as an undifferentiated blue wash reads as a
 * broken instrument. Density is the variable.
 *
 * They are drawn from the MEASURED value and never from the gained one, which
 * is the reason they are worth having alongside the gain rather than instead of
 * it. Whatever the exaggeration is doing to the colour, a line is still an
 * isotherm and the spacing between two lines is still the interval printed on
 * the legend. The gain shows you where the structure is; the contours tell you
 * what it is worth.
 *
 * The line is an anti-aliased distance to the nearest multiple of the interval,
 * measured in screen space through `fwidth` so it stays one pixel wide at every
 * zoom rather than thickening as a wall comes closer. `fwidth` is core in
 * WebGL2, which is what three r170 asks for here.
 *
 * THE GUARD IS NOT OPTIONAL. Where the field is flat across a quad — every
 * panel clamped at an end of the domain, which is thousands of them on the
 * heat-wave afternoon — the derivative is zero, and dividing by it turns the
 * whole clamped region into a solid line the moment its value happens to sit
 * near a multiple. So a quad with no gradient draws nothing, which is also the
 * truthful answer: there is no isotherm crossing a surface that is all one
 * temperature. */
function contoured(mat, isoU, isoKU) {
  const inner = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, renderer) => {
    if (inner) inner(sh, renderer);
    sh.uniforms.uIso = isoU;
    sh.uniforms.uIsoK = isoKU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aVal;\nvarying float vVal;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvVal = aVal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vVal;\nuniform float uIso;\nuniform float uIsoK;')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n'
        // The derivative is taken in UNIFORM control flow and the validity
        // test comes after it. GLSL leaves fwidth undefined when fragments of
        // the same 2x2 quad took different branches, and `vVal >= 0.0` is
        // exactly such a branch — it is per-quad, so it divides the fragment
        // quads that straddle the edge of an unsolved panel. `uIso` is a
        // uniform, so the branch that remains around it is the same for every
        // fragment in the frame. -1 differentiates like any other number; it is
        // discarded a line later.
        + 'if ( uIso > 0.0 ) {\n'
        + '  float xs = vVal / uIso;\n'
        + '  float w = fwidth( xs );\n'
        + '  if ( vVal >= 0.0 && w > 1e-5 ) {\n'
        + '    float d = abs( fract( xs - 0.5 ) - 0.5 ) / w;\n'
        + '    float line = 1.0 - clamp( d, 0.0, 1.0 );\n'
        // Fade the lines out as they approach the pixel grid, or they invert.
        // Once one pixel spans most of an interval, every fragment is within a
        // line-width of a multiple, `line` goes to 1 everywhere, and a wall that
        // should show a dense pattern instead goes uniformly 55% darker. That is
        // the standard failure of a screen-space grid at high frequency, and it
        // would have hit the two views the app spends most of its time in: the
        // whole-AOI overview, and any wall seen at a glancing angle. Fading from
        // a third of an interval per pixel to nine tenths gives back a plain
        // ramp colour where the contours can no longer resolve, which is the
        // honest thing to draw when they cannot.
        + '    line *= 1.0 - smoothstep( 0.35, 0.9, w );\n'
        + '    diffuseColor.rgb *= 1.0 - 0.55 * line * uIsoK;\n'
        + '  }\n'
        + '}');
  };
  /* Written by hand for the reason `fadeable` gives, and chained onto whatever
   * key was already there: two meshes wrapped by the same closure have
   * identical `toString()`, so deriving a key from this wrapper alone would
   * hand the overlay the ghosted mesh's compiled program. */
  mat.customProgramCacheKey = () => `hciso|${prevKey ? prevKey() : ''}`;
  return mat;
}

function ghostable(mat) {
  mat.alphaHash = true;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aGhost;\nvarying float vGhost;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvGhost = aGhost;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vGhost;')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.a *= vGhost;');
  };
  return mat;
}

/* Let a data mesh hold TWO painted states at once and dissolve between them.
 *
 * WHY IT IS DONE ON THE GPU AND NOT BY REPAINTING
 *
 * Stepping the clock used to be a cut: `_recolour` rewrote 294,150 quads and
 * the city changed in one frame. That is a hard edit in the middle of a
 * continuous physical process — the sun does not jump three hours — and it
 * costs the viewer the very thing the hourly axis exists to show, which is
 * which walls warm first and how the shadow line sweeps.
 *
 * The obvious fix is to repaint at a fractional hour every frame. It is not
 * affordable: `_recolour` is ~40 ms on this mesh (measured), so a per-frame
 * repaint caps the whole scene at 25 fps and pins a core doing it. What IS
 * affordable is paying for the repaint once per step and letting the GPU
 * interpolate: the mesh carries the hour it came from in `color` and the hour
 * it is going to in `aColorTo`, and one uniform slides between them. A frame of
 * the dissolve then costs a single float upload.
 *
 * Interpolating COLOUR rather than temperature is an approximation, and worth
 * naming. Two adjacent slots differ by a few kelvin on any given wall, which is
 * a short move along the ramp, and a straight line between two nearby ramp
 * colours is within a byte or two of the ramp itself. It would be wrong across
 * the whole domain — the ramp is diverging, so the midpoint of deep blue and
 * deep red is a mauve the ramp never contains — and that is exactly why the
 * dissolve is only ever run between two states a step apart.
 *
 * The cache key has to be written by hand. Three derives its default program
 * cache key from `onBeforeCompile.toString()`, and every material wrapped here
 * gets the same wrapper source, so a ghosted mesh and an overlay mesh would
 * otherwise be handed each other's compiled program.
 */
function fadeable(mat, mixU) {
  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, renderer) => {
    if (inner) inner(sh, renderer);
    sh.uniforms.uMix = mixU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute vec3 aColorTo;\nuniform float uMix;')
      .replace('#include <color_vertex>',
        '#include <color_vertex>\n#ifdef USE_COLOR\n'
        + 'vColor.xyz = mix( vColor.xyz, aColorTo, uMix );\n#endif');
  };
  mat.customProgramCacheKey = () => `hcfade|${inner ? inner.toString() : ''}`;
  return mat;
}

/* The other half of the same decision. Dimming five thousand buildings is how a
 * selection is shown, but it is not enough to show a SET — the analyst routinely
 * lights up fourteen buildings at once, and on a dark scene "everything else is
 * darker" reads as "nothing happened". So the members of a highlighted set are
 * lifted as well as the rest dimmed, warm-biased so the lift cannot be mistaken
 * for a hotter measurement. */

const PAN_SPEED = 0.72;

/* How far the orbit may tilt, as polar angle from straight up.
 *
 * The floor is not zero: at exactly zero the camera is over its pivot and the
 * bearing is undefined, so a tilt that reached it would lose which way the
 * building faces — the one thing this model is about. Five degrees short of
 * vertical still reads as a plan view and still has a north. The ceiling is
 * `controls.maxPolarAngle`, three degrees short of level, which is what puts
 * the eye on a facade rather than on a roof.
 */
const ORBIT_MIN_PHI = 0.09;

/* One press of a turn or tilt control, in radians. An eighth of a turn: four
 * presses take you to the opposite face, eight all the way round, and each
 * step is large enough to be worth the animation that carries it. */
const ORBIT_STEP = Math.PI / 4;
const TILT_STEP = Math.PI / 9;

/* Seconds for one full automatic revolution. Slow enough to read a facade as
 * it goes past, short enough that watching all four is not a commitment. */
const SPIN_PERIOD = 22;

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
    // above about 0.95 came out pure white, which flattened the brightest end of
    // the ramp into one indistinguishable band. The exponent lifts the midtones
    // by very nearly the same amount — 0.523 against 0.525 at the midpoint —
    // and leaves the ends of the ramp where the design put them. That still
    // matters with the ramp reversed: the bright end is now the *cool* end, and
    // clipping it would erase the difference between a cool wall and a very
    // cool one.
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
    /* Local detail gain, and the value brush. Both are ways of reading the
     * spatial structure inside one hour; see `setDetailGain` and `setValueBrush`
     * for what they are for and what they cost. Identity and off by default, so
     * a scene nobody has touched is the measured field. */
    this.detailGain = 1;
    this.valueBrush = null;
    this._hist = new Uint32Array(Scene.HIST_BINS);
    /* A second histogram, filled only while a gain is on, holding the field as
     * the model solved it. The legend's FIGURES come from this one and its
     * rectangle from the other; see `paintedCore` below. */
    this._histTrue = new Uint32Array(Scene.HIST_BINS);
    this.paintedHist = null;
    this.paintedCore = null;
    this.paintedCoreTrue = null;
    this.selected = null;
    /* The selection the ghost attributes were last written for. `undefined`
     * rather than null so the first repaint writes them. */
    this._ghostSel = null;
    this._hidden = false;
    this._spin = null;
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

    /* The dissolve between the last painted state of the city and the next one.
     *
     * `_mixU` is shared by every material that carries data — both facade
     * meshes, both roof meshes and the ground plane — so one float moves all of
     * them together and they can never disagree about what time it is. It rests
     * at 1, meaning "show the buffer the last repaint wrote"; a faded repaint
     * drops it to 0 and `_stepFade` walks it back up. See `fadeable`.
     */
    this._mixU = { value: 1 };
    /* Contour interval, on the drawn 0..1 domain, and how hard the lines are
     * drawn. Zero interval is off. The interval is chosen by the panel, which is
     * the only place that knows the layer's units — see `setContour`. */
    this._isoU = { value: 0 };
    this._isoKU = { value: 1 };
    this.isoOn = true;
    this._fade = null;
    /* The solar state currently on screen, which is not `meta.hours[hour]`
     * while a dissolve is running. Held so an interrupted dissolve can start
     * from where the sky actually is rather than from where it was going. */
    this._skyNow = null;

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
  /** The solar state one hour slot of the loaded period stands under. */
  _skyStateAt(hour) {
    const h = this.data.meta.hours?.[hour];
    if (!h) return null;
    return {
      alt: h.sun_alt ?? -20,
      az: h.sun_az ?? 0,
      cloud: Math.max(0, Math.min(1, h.cloud ?? 0)),
    };
  }

  _updateSky() {
    this._applySky(this._skyStateAt(this.hour));
  }

  /** Put the sky under a given sun, rather than under the current hour's.
   *
   * Split out from `_updateSky` so a dissolve can drive it with an intermediate
   * sun: three hours of the clock is up to forty degrees of solar altitude, and
   * a sky that cut between two of those while the walls dissolved smoothly
   * would be the hard edit moved rather than removed. Everything here is a
   * handful of uniforms, so unlike the facade repaint it IS affordable per
   * frame, and the interpolation is done on the sun rather than on the
   * resulting colours — the same inputs the hour slots carry.
   */
  _applySky(state) {
    if (!this.sky || !state) return;
    this._skyNow = state;
    const { alt, az, cloud } = state;

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
    /* The mast is as long as the NEIGHBOURS make it, not as long as the
     * building is.
     *
     * It used to be `a.h * 0.3`, capped at 90 m, on the reasoning that a tall
     * building needs a tall mast to clear the skyline around it. That gets the
     * relationship backwards. The mast exists so the dot is not lost among
     * whatever stands nearby, and a building that is already taller than
     * everything around it has nothing to clear — so the rule spent its whole
     * budget exactly where it was least needed. On the Empire State it hit the
     * cap: a dot floating ninety-three metres over the spire, far enough off
     * the roof to read as a bug rather than as a marker.
     *
     * So the height grid is asked what is actually there. Eight bearings at two
     * radii is sixteen lookups into an array that is already in memory, and it
     * answers the only question the mast has: how far above this roof does the
     * marker have to sit before nothing else is in front of it. A tower gets a
     * short mast and a brownstone in a canyon gets a long one, which is what
     * the original comment wanted and the opposite of what it did.
     */
    const around = (() => {
      const at = this.data.heightAt;
      if (!at) return a.h;
      let top = 0;
      for (const r of [60, 140]) {
        for (let k = 0; k < 8; k++) {
          const t = (k / 8) * Math.PI * 2;
          top = Math.max(top, at(x + Math.cos(t) * r, y + Math.sin(t) * r) || 0);
        }
      }
      return top;
    })();
    // Sixteen metres of daylight over whatever is in the way, and never less
    // than eighteen so the dot is never sitting on the roof itself.
    const mast = Math.max(18, Math.min(90, (around - a.h) + 16));
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

    /* The same canvas again, holding the state the ground is dissolving FROM.
     *
     * The ground is not a passive backdrop across an hour step: the ray-traced
     * building shadows are painted into it, and they are the fastest-moving
     * thing in the frame. Cutting them while the facades dissolve would put the
     * one hard edit back in exactly the place the eye is watching.
     *
     * It is a copy rather than a ping-pong pair because `groundTex` is also
     * handed to the photoreal layer as its street wash, and an identity that
     * changes every hour would have to be chased through that shader too. One
     * 2048-square blit per step is the price of leaving it alone.
     */
    this.groundPrevCanvas = document.createElement('canvas');
    this.groundPrevCanvas.width = this.groundCanvas.width;
    this.groundPrevCanvas.height = this.groundCanvas.height;
    this.groundPrevTex = new THREE.CanvasTexture(this.groundPrevCanvas);
    this.groundPrevTex.colorSpace = THREE.SRGBColorSpace;
    this.groundPrevTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.groundPrevTex.magFilter = THREE.LinearFilter;
    this.groundPrevTex.generateMipmaps = true;
    this.groundPrevTex.anisotropy = this.groundTex.anisotropy;

    // Deliberately semi-transparent over the dark backdrop: the ground carries
    // the measured 2 m field, but the facades carry the finding, and a fully
    // opaque ground at peak hour drowns them.
    const gmat = new THREE.MeshBasicMaterial({
      map: this.groundTex, transparent: true, opacity: 0.62,
    });
    /* Same dissolve as the facades, one level lower: the plane samples both
     * canvases and mixes on the shared uniform. Both textures are sRGB and are
     * therefore decoded by the sampler before the mix, so this interpolates in
     * linear light — the same space the vertex colours are mixed in. */
    gmat.onBeforeCompile = (sh) => {
      sh.uniforms.uMix = this._mixU;
      sh.uniforms.uMapPrev = { value: this.groundPrevTex };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>',
          '#include <common>\nuniform float uMix;\nuniform sampler2D uMapPrev;')
        .replace('#include <map_fragment>',
          '#ifdef USE_MAP\n'
          + 'diffuseColor *= mix( texture2D( uMapPrev, vMapUv ),'
          + ' texture2D( map, vMapUv ), uMix );\n#endif');
    };
    gmat.customProgramCacheKey = () => 'hcground';
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w, h), gmat);
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
    if (this.groundYearLayer) {
      // An annual per-tile metric: hours above 35 C across the year, tropical
      // nights, the annual mean. These are a composite: on the event day they
      // are FortyGuard's measured values, and on any other date that day's
      // measured spatial anomaly carried onto the reanalysis level.
      const rows = this.data.tileYearAt(this.groundYearLayer);
      if (rows) {
        pts = rows;
        const vals = rows.map((r) => r[2]).sort((a, b) => a - b);
        dom = [vals[0], vals[vals.length - 1]];
        rampName = 'duration';
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
      /* A shallow floor, raised from 0.34 when the ramp turned round.
       *
       * Ambient occlusion says "this surface sees little sky" by darkening it,
       * and on the inferno ramp that was unambiguous because darkness carried no
       * data — the hot end was cream. It does now, at both ends: the hottest
       * walls and the coldest are the darkest on a diverging ramp whose middle
       * is pale, so a deep floor multiplied a dark red down into the shell and
       * the exact surfaces the model exists to find — hot walls in shaded
       * canyons — were the ones it made invisible. A floor of 0.62 keeps enough
       * of the form to read the geometry while leaving the darkness channel
       * mostly to the measurement. */
      this.quadAO[q] = 0.62 + 0.38 * Math.pow(svf, 0.58);
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
    // The second painted state, for the dissolve. See `fadeable`.
    geo.setAttribute('aColorTo', new THREE.Float32BufferAttribute(col.slice(), 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // MeshBasicMaterial, not Lambert: on this mesh the colour *is* the
    // measurement, and letting a light source multiply it would mean a facade's
    // apparent temperature depended on which way the camera was facing. Form
    // instead comes from a fixed shading factor baked into the vertex colours
    // per panel orientation (see _shadeFor), which is constant per surface and
    // therefore cannot be mistaken for data.
    // Opaque until something is selected: see `ghostable` and GHOST.
    geo.setAttribute('aGhost',
      new THREE.BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1));

    /* The measured value at each vertex, for the isotherms.
     *
     * Interpolated VERTICALLY and not horizontally, because that is where the
     * data has somewhere to interpolate to. A quad is one panel at one band and
     * holds one solved number; its neighbours in height are the next bands of
     * the same panel, so a quad's bottom edge takes the mean of its own value
     * and the band below and its top edge the mean with the band above. Across a
     * wall the neighbours are different panels, which is the model's horizontal
     * resolution rather than a finer field to sample — so contours step at panel
     * boundaries and run smoothly up a facade, which is the right way round: an
     * isotherm on a wall is very nearly horizontal. */
    geo.setAttribute('aVal',
      new THREE.BufferAttribute(new Float32Array(pos.length / 3).fill(-1), 1));

    this.facadeMesh = new THREE.Mesh(geo,
      contoured(fadeable(ghostable(new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide,
      })), this._mixU), this._isoU, this._isoKU));
    this.scene.add(this.facadeMesh);
    /* `facadeColors` is the buffer a repaint WRITES, which at rest is also the
     * buffer the GPU shows — `_mixU` sits at 1. During a dissolve it is the
     * destination and `color` is the state being left behind. */
    this.facadeGeo = geo;
    this.facadeColors = geo.getAttribute('aColorTo');
    this.facadeGhost = geo.getAttribute('aGhost');
    this.facadeVal = geo.getAttribute('aVal');
    this._vals = new Float32Array(nQuad);

    /* The same geometry a second time, for the selected building alone.
     *
     * FrontSide here where the mesh below is DoubleSide, because this copy has
     * no depth test and therefore no way to sort its own faces: drawn
     * DoubleSide as the mesh below, so the subject looks exactly as it would
     * with nothing in front of it — which is the whole claim the overlay makes.
     * That is only sound because it keeps a real depth test; see `selOverlay`.
     *
     * This is the mesh that clears the depth buffer, and it must therefore draw
     * before the roof copy, which shares the buffer it clears. */
    this.facadeTop = new THREE.Mesh(geo,
      contoured(fadeable(selOverlay(new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide,
      })), this._mixU), this._isoU, this._isoKU));
    this.facadeTop.renderOrder = 999;
    this.facadeTop.visible = false;
    this.facadeTop.onBeforeRender = (renderer) => renderer.clearDepth();
    this.scene.add(this.facadeTop);
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
    geo.setAttribute('aColorTo', new THREE.Float32BufferAttribute(col.slice(), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.setAttribute('aGhost',
      new THREE.BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1));

    this.roofMesh = new THREE.Mesh(geo, fadeable(ghostable(new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    })), this._mixU));
    this.scene.add(this.roofMesh);
    this.roofGeo = geo;
    this.roofColors = geo.getAttribute('aColorTo');

    // No depth clear of its own: it shares the one the facade copy just made,
    // so a roof and its walls occlude each other the way they should.
    this.roofTop = new THREE.Mesh(geo, fadeable(selOverlay(new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    })), this._mixU));
    this.roofTop.renderOrder = 1000;
    this.roofTop.visible = false;
    this.scene.add(this.roofTop);
    this.roofGhost = geo.getAttribute('aGhost');
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
    // Both mouse buttons are owned by _initGrabPan now: left pans, right turns
    // around the building. MapControls' own rotate turns around
    // `controls.target`, which after a pan is not the building any more — see
    // the orbiting section. Its two-finger touch gesture is unchanged.
    this.controls.mouseButtons.LEFT = null;
    this.controls.mouseButtons.RIGHT = null;
    this.controls.minPolarAngle = ORBIT_MIN_PHI;
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
    // Reaching for the wheel is reaching for the camera: the revolution stops.
    // Keydown is deliberately not on this list, because the key that starts the
    // revolution is a keydown.
    this.renderer.domElement.addEventListener(
      'wheel', () => this.setSpin(false), { passive: true });
    window.addEventListener('keydown', bail);

    this._initGrabPan();
    this._initZoomGestures();
  }

  /** Predictable desktop map pan in the camera's horizontal frame, and the
   *  turn-around-the-building gesture that shares its plumbing.
   *
   * A literal ray/ground intersection sounds ideal, but perspective makes an
   * upward drag accelerate sharply as the pointer approaches the horizon. A
   * fixed metres-per-pixel scale for the whole gesture makes left/right and
   * up/down equally responsive. The scale still follows zoom level, as it does
   * in a normal map, and movement ends exactly when the pointer does.
   *
   * The right button — and shift with the left, for anyone on a trackpad or a
   * one-button mouse — turns instead of panning, around the selected building.
   * Both live in one handler because they are one gesture with two meanings:
   * the same capture, the same rebasing on each move, the same end.
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
      if (e.pointerType === 'touch' || !this.controls.enabled) return;
      if (e.button !== 0 && e.button !== 2) return;
      // A hand on the camera ends the automatic revolution, always. The
      // alternative is a view that keeps drifting under a drag, which reads as
      // the model fighting back.
      this.setSpin(false);
      const turning = e.button === 2 || e.shiftKey;
      if (turning) {
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, turn: true };
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('is-turning');
        e.preventDefault();
        return;
      }
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
      if (drag.turn) {
        /* Radians per pixel, against the viewport height on both axes so a
         * diagonal drag turns and tilts by the same amount per pixel. A full
         * drag down the height of the window is one revolution, which is the
         * convention every 3D viewer in this shape uses. */
        const k = 2 * Math.PI * this.controls.rotateSpeed
          / Math.max(1, el.getBoundingClientRect().height);
        // Dragging right walks the camera anticlockwise around the building, so
        // the near face slides left — the building turns with the hand, exactly
        // as the ground does under a pan.
        this.orbitBy(-(e.clientX - drag.x) * k, -(e.clientY - drag.y) * k);
        drag.x = e.clientX;
        drag.y = e.clientY;
        e.preventDefault();
        return;
      }
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
      el.classList.remove('is-panning', 'is-turning');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('blur', () => {
      drag = null;
      el.classList.remove('is-panning', 'is-turning');
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
    this.setSpin(false);
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

  /* ------------------------------------------------------------- orbiting

     Turning around a building is not the same gesture as turning the map, and
     the difference is the pivot. MapControls turns around `controls.target`,
     which is wherever the last pan left it — so after walking the view across
     two blocks, "turn right" swings the selected tower out of frame instead of
     showing you its next wall. Everything below turns around the building
     itself when one is selected, and around the view centre when none is.

     The rotation is applied to the camera AND the target as one rigid body, so
     a turn changes which face you are looking at without changing what is
     centred, and nothing jumps at the start of the gesture.                  */

  /** The point the view turns around: the selected building, or the centre of
   *  the view when nothing is selected. */
  _orbitPivot() {
    if (this.selected !== null && this.data.buildings.attrs[this.selected]) {
      return this._buildingAnchor(this.selected);
    }
    return this.controls.target.clone();
  }

  /** Turn `dTheta` around the pivot and tilt `dPhi` toward the horizon.
   *
   * Positive `dPhi` lowers the eye — larger polar angle, from overhead toward
   * level — which is the direction a facade comes into view. The tilt is
   * clamped first and the yaw derived from where the clamp landed, so a
   * gesture that runs into the limit still turns rather than sticking.
   */
  orbitBy(dTheta, dPhi, { animate = false } = {}) {
    if (!this.controls.enabled) return;
    const from = animate ? this._modePose() : null;
    const pivot = this._orbitPivot();
    const off = this.camera.position.clone().sub(pivot);
    if (off.lengthSq() < 1e-6) return;
    const sph = new THREE.Spherical().setFromVector3(off);
    const phi = Math.min(this.controls.maxPolarAngle,
      Math.max(ORBIT_MIN_PHI, sph.phi + dPhi));
    const next = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(sph.radius, phi, sph.theta + dTheta));
    // The same rotation that moved the eye moves the look-at point, which is
    // what keeps the pair rigid. Deriving it from the two offsets rather than
    // composing axis rotations by hand means the two can never disagree.
    const q = new THREE.Quaternion().setFromUnitVectors(
      off.clone().normalize(), next.clone().normalize());
    const tOff = this.controls.target.clone().sub(pivot).applyQuaternion(q);
    this.camera.position.copy(pivot).add(next);
    this.controls.target.copy(pivot).add(tOff);
    this.controls.update();
    if (from) this._beginTransit(from);
  }

  /** One step round the building, flown. `dir` is +1 for clockwise from above,
   *  which is what "turn right" means when the ground is not turning. */
  turn(dir) {
    this.setSpin(false);
    this.orbitBy(-dir * ORBIT_STEP, 0, { animate: true });
  }

  /** One step of tilt. `dir` is +1 to drop toward street level and see the
   *  facade, -1 to climb and see the roof and the shadow it throws. */
  tilt(dir) {
    this.setSpin(false);
    this.orbitBy(0, dir * TILT_STEP, { animate: true });
  }

  /** Is the camera walking itself round the building? */
  get spinning() { return !!this._spin; }

  /** Circle the pivot once, hands-free.
   *
   * Four walls at four different temperatures is the finding this model exists
   * to show, and reaching all four by hand means four deliberate drags. One
   * revolution, at a speed you can read, is the version of that which needs no
   * hands — and it stops the moment anything else touches the camera, so it can
   * never be in the way.
   */
  setSpin(on) {
    if (on && !this.controls.enabled) return;
    /* Reduced motion is honoured everywhere else in this project — the opening
     * film, every flown camera move — and deliberately not here. Those are
     * motion the interface decides to add to something you asked for; this is
     * motion that IS the thing you asked for, from a button whose only function
     * is to produce it. Refusing would leave a control that looks broken. The
     * flown step on the turn pad remains the still alternative. */
    const next = on ? { dir: 1 } : null;
    if (!!next === !!this._spin) return;
    this._spin = next;
    this.onSpinChange?.(this.spinning);
  }

  toggleSpin() { this.setSpin(!this._spin); }

  /** One frame of the automatic revolution. */
  _stepSpin(dt) {
    if (!this._spin) return;
    if (!this.controls.enabled) { this.setSpin(false); return; }
    this.orbitBy(this._spin.dir * (2 * Math.PI / SPIN_PERIOD)
      * Math.min(0.1, dt), 0);
  }

  /** Step the fly-over's distance by a factor, flying rather than jumping. */
  zoomBy(factor, at = null) {
    this.setSpin(false);
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
      /* The isotherm uniforms, handed over as the very same objects the massing
       * shader holds rather than as values. The photograph IS the main surface
       * here — the massing mesh is hidden whenever it is on, see `_applySolids`
       * — so contours that lived only on the prisms were contours that almost
       * nobody would ever see. One pair of uniforms, two shaders, no way for the
       * interval on the legend to disagree with the interval on screen. */
      isoU: this._isoU,
      isoKU: this._isoKU,
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
      /* A layer built after the click it has to agree with.
       *
       * The dissolve is pushed at the moment the selection changes, and until
       * this line there was nothing to push it to: the Photoreal is constructed
       * on the first switch-on, so a viewer who picked a building and then
       * turned the photograph on got the dimming without the see-through half —
       * the one sequence in which the two halves of a selection came apart. */
      pr.setSubject(this._subjectSet());
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
    this._hidden = hide;
    this._syncSelOverlay();
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
      downAt = { x: e.clientX, y: e.clientY, max: 0 };
    });
    // How far the pointer has strayed since it went down, at its furthest.
    // Its own listener rather than a line in the one above, so the variable it
    // reads is declared before it and the gesture code stays in one place.
    el.addEventListener('pointermove', (e) => {
      if (!downAt) return;
      const d = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      if (d > downAt.max) downAt.max = d;
    });
    el.addEventListener('pointerup', (e) => {
      if (!downAt) return;
      const moved = Math.max(downAt.max,
        Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y));
      downAt = null;
      /* Distance travelled, not time held, and the peak rather than the end.
       *
       * This was 6 px OR half a second, and the time half was both the fragile
       * part and the unnecessary one. A press that never moves is a click by
       * any reading — people steady the pointer before clicking a sliver of sky
       * between two towers, and half a second is easy to exceed — so the clock
       * was throwing away deliberate clicks. Measured: a 700 ms press and an
       * 8 px wobble were each discarded, and the click meant to clear the
       * selection did nothing, which is why the selection looked stuck.
       *
       * The clock was only ever standing in for one case the old distance check
       * could not see: a slow drag that wanders off and comes back, whose start
       * and end are the same point. Tracking the FURTHEST the pointer strayed
       * catches that directly and needs no timer, so the gesture is decided by
       * the one thing that actually distinguishes it. Orbiting and panning move
       * hundreds of pixels; ten is a wobble. */
      if (moved > 10) return;   // that was a drag, not a click
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

  /* The temperature scale. One scale, fixed, shared by the walls, the roofs and
   * the air — see TEMP_DOMAIN in colors.js, which is where the argument for it
   * and the measurements behind it live.
   *
   * These stay as instance fields rather than becoming direct reads of the
   * constant because eleven call sites already destructure them, and because a
   * scale is the kind of thing that wants exactly one place to be overridden
   * from if it ever needs to be again. They are copies, so nothing downstream
   * can mutate the shared constant. */
  _defaultDomains() {
    this.surfaceDomain = TEMP_DOMAIN.slice();
  }

  setDomains(d) {
    if (d?.surface) this.surfaceDomain = d.surface;
    this._recolour();
    this._paintGround();
  }

  //: Which annual per-tile metric pairs with each annual facade layer. The ground
  //: and the walls should be answering the same question: painting a year of
  //: facade dose over a single heat wave's exceedance invites the eye to read one
  //: as the cause of the other.
  /* Bins in the legend histogram. Ninety-six because the ramp is drawn about
   * 250 px wide in the panel, so a bin is two or three pixels — fine enough to
   * show the sun/shade gap on an afternoon, coarse enough that a bin still holds
   * a few thousand of the 294,150 quads and the shape is not sampling noise. */
  static HIST_BINS = 96;

  /** The middle 98% of a histogram, as a [lo, hi] pair on the drawn 0..1 domain.
   *
   * The bracket used to be the outright min and max, and on a fixed scale that
   * is a statistic one panel can destroy. It routinely did: the heat-wave hour
   * has walls clamped at both ends of the excess scale, so the marker spanned
   * the entire ramp and the line under it read "-4.0 TO 20.0 K" — arithmetically
   * true, and a sentence that says nothing about any hour in particular. One
   * panel in 294,150 was setting the width of the only widget on the panel whose
   * job is to say how wide the hour is.
   *
   * Trimming a per cent off each end gives it back. It costs the extremes, which
   * are not what a bracket is for — the extremes are a question about one wall,
   * and the dossier answers that about the wall you clicked.
   *
   * Read off the histogram rather than by sorting 294,150 values, so the figures
   * are quantised to a bin: 0.83 K on the temperature scale, 0.25 K on the
   * excess one. That is a summary widget's worth of precision and the reason the
   * line says MIDDLE 98% rather than pretending to a reading. */
  static coreOf(hist) {
    let tot = 0;
    for (let i = 0; i < hist.length; i++) tot += hist[i];
    if (!tot) return null;
    const need = tot * 0.01;
    let c = 0, lo = 0, hi = hist.length - 1;
    for (let i = 0; i < hist.length; i++) {
      c += hist[i];
      if (c >= need) { lo = i; break; }
    }
    c = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      c += hist[i];
      if (c >= need) { hi = i; break; }
    }
    if (hi < lo) hi = lo;
    return [lo / hist.length, (hi + 1) / hist.length];
  }

  static GROUND_FOR_ANNUAL = {
    annual_kh35: 'degree_hours_35',
    annual_dose: 'hours_above_35',
    winter_sun: 'mean_c',
    annual_priority: 'hours_above_35',
  };

  /** How far the temperature layer exaggerates a wall's distance from the air.
   *
   * 1 is the measured field. The argument for anything above it, and the reasons
   * it is not the auto-scaling this project deleted, are in `_recolour` at the
   * branch that applies it. The caller is responsible for saying so on the
   * legend — a gain nobody is told about is exactly the failure mode the fixed
   * scale exists to prevent. */
  setDetailGain(g) {
    const v = Math.max(1, Math.min(8, Number(g) || 1));
    if (v === this.detailGain) return;
    this.detailGain = v;
    this._recolour();
  }

  /** Keep only the walls whose value falls in [lo, hi] on the drawn 0..1 domain;
   *  everything else drains and goes see-through. Null clears it.
   *
   * This is the answer to a question colour cannot hold. A median hour spans
   * about five just-noticeable differences across the whole city, so "which
   * walls are in the top two kelvin of this hour" is not a question any ramp can
   * be read for. Dragging a window along the distribution and watching which
   * walls survive answers it directly, and answers it in the geometry rather
   * than in a table.
   *
   * The domain is the drawn one rather than kelvin so that this works unchanged
   * on every layer — the histogram it is dragged across is in the same units. */
  setValueBrush(range) {
    const r = range && isFinite(range[0]) && isFinite(range[1])
      ? [Math.max(0, Math.min(range[0], range[1])), Math.min(1, Math.max(range[0], range[1]))]
      : null;
    const same = (!r && !this.valueBrush)
      || (r && this.valueBrush && r[0] === this.valueBrush[0] && r[1] === this.valueBrush[1]);
    if (same) return;
    this.valueBrush = r;
    this._recolour();
  }

  /** Set the isotherm interval, on the drawn 0..1 domain. Zero turns them off.
   *
   * The interval is decided by the panel rather than here, because choosing a
   * round one means knowing the layer's units — 1 K on the temperature scale,
   * 2 K on the excess scale, five score points on priority — and this class
   * deals only in the normalised domain everything is painted through. */
  setContour(interval01) {
    const v = isFinite(interval01) && interval01 > 0 ? interval01 : 0;
    const wasOn = this._isoU.value > 0;
    if (v === this._isoU.value) return;
    this._isoU.value = v;
    // Turning them on needs the attribute filled, which only a repaint does.
    // Changing the interval on an attribute that is already correct is a single
    // uniform and no repaint at all.
    if (!wasOn && v > 0) this._recolour();
  }

  /** Whether isotherms are drawn at all. Separate from the interval so that
   *  turning them off and on again does not have to re-derive one. */
  setContoursOn(on) {
    const v = !!on;
    if (v === this.isoOn) return;
    this.isoOn = v;
    this._isoKU.value = v ? 1 : 0;
    if (v) this._recolour();
  }

  setLayer(layer) {
    /* A brush is a range of values, and a value on one layer is not a value on
     * the next — 0.6 of the temperature ramp is 40 degC and 0.6 of the priority
     * ramp is a score of 51. Carrying it across would silently reinterpret the
     * viewer's window as a different question, so it is dropped. It also ends
     * the per-repaint ghost upload, which is the other reason not to leave one
     * lying around. */
    if (layer !== this.layer) this.valueBrush = null;
    this.layer = layer;
    // The ground shows whichever measured field pairs with the chosen facade
    // layer. For the modelled layers it shows exceedance, because that is the
    // measured field with real spatial structure and it grounds the modelled
    // surfaces in something observed. For the annual layers it shows the matching
    // annual tile metric instead.
    this.groundYearLayer = Scene.GROUND_FOR_ANNUAL[layer] || null;
    this.groundLayer = this.groundYearLayer ? 'year' : 'exceedance';
    this._recolour();
    this._paintGround();
  }

  setHour(h, { fade = 0, linear = false } = {}) {
    this.hour = h;
    this._repaintTime(fade, { linear });
  }

  /** The active period or aggregate changed under us. Repaint everything that
   *  reads it, which is the facades, the roofs and the ground.
   *
   * The colour scale is deliberately NOT recomputed here, and that is the whole
   * point of the method being this short.
   *
   * It used to be. Every period got its own 0.2-99.8 percentiles, on the
   * argument that a fixed scale spends most of the ramp on temperatures the
   * loaded period never reaches — which is true, and measured: over the widest
   * fixed domain then available, the whole city at the peak hour of a July heat
   * wave landed between 0.72 and 0.90 of the ramp, and Midtown rendered as one
   * flat cream.
   *
   * What that argument missed is that it buys within-period contrast with the
   * one thing the colour is for. Rescaling per period made January's scale
   * −8.2 to 11.7 °C and July's 22.2 to 45.6 °C, so a −2 °C wall in January and a
   * 28 °C wall in July came out the same amber. Scrubbing across the year showed
   * a city that did not change colour, which is false: those two days are thirty
   * kelvin apart and that is the finding. The legend's figures did move, which
   * made it defensible, but a legend that has to be re-read on every scrub is
   * not a legend, and nobody re-read it.
   *
   * So the scale is fixed at −20 to 60 °C for every period and every hour, and
   * the flatness is accepted where it is real. A January day genuinely spans
   * about eight kelvin and genuinely gets a narrow band of blue; a heat-wave day
   * spans twenty-one and runs from cream through orange into red. The contrast
   * now tracks the physics instead of the loaded file.
   */
  setPeriod({ fade = 0, linear = false } = {}) {
    this._repaintTime(fade, { linear });
  }

  /* ------------------------------------------------------------- dissolve */

  /** Is a dissolve still running? Anything that wants the settled picture —
   *  a screenshot, a pixel assertion — has to wait for this to go false. */
  get fading() { return this._fade !== null; }

  /** How long a dissolve may actually last, in seconds.
   *
   *  Zero for a caller that asked for a cut, and zero for a viewer who has
   *  asked their system not to animate: a dissolve is decoration to them and a
   *  motion trigger to some of them, and the cut loses nothing but the pleasure
   *  of it. `?smooth=0` is the same escape hatch for a screenshot run. */
  _fadeSeconds(want) {
    if (!(want > 0)) return 0;
    if (Scene._noMotion === undefined) {
      Scene._noMotion = (() => {
        try {
          if (new URLSearchParams(location.search).get('smooth') === '0') return true;
          return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        } catch { return false; }
      })();
    }
    return Scene._noMotion ? 0 : want;
  }

  /** Repaint for a new time — an hour, a date, a period — over `fade` seconds.
   *
   * The repaint itself is unchanged and still costs what it always did. What
   * changes is where its result lands: with a dissolve asked for, the state
   * currently on screen is pinned into the `from` half of every data mesh
   * first, the repaint fills the `to` half, and `_stepFade` walks the mix
   * across. With no dissolve the repaint goes straight to the screen, which is
   * what every internal caller still gets by default — only the interface asks
   * for a dissolve, so nothing else in this file changed behaviour.
   *
   * `linear` matters more than it looks. A single step of a played day is one
   * frame of a continuous sweep, and easing each of them in and out would make
   * the clock visibly pulse eight times a day. An hour picked by hand is a
   * discrete move and gets the smoothstep.
   */
  _repaintTime(fade = 0, { linear = false } = {}) {
    const secs = this._fadeSeconds(fade);
    if (secs > 0) this._pinFadeStart();
    else { this._fade = null; this._mixU.value = 1; }

    this._recolour();
    this._paintGround();

    if (secs > 0) {
      this._skyTo = this._skyStateAt(this.hour) || this._skyNow;
      this._fade = { t: 0, dur: secs, linear };
      this._stepFade(0);
    } else {
      this._updateSky();
    }
  }

  /** Freeze what is on screen right now into the `from` half of every dissolve.
   *
   * The common case is cheap and is the reason the buffers are a pair rather
   * than a source and a scratch: a settled scene is already showing the `to`
   * half, so the two attributes simply change places and nothing is copied.
   *
   * Interrupting a dissolve — scrubbing the hour strip, or a played day being
   * paused onto another hour — is the case that costs, because the picture on
   * screen is a blend that exists nowhere in memory. It has to be evaluated
   * into `from` before the repaint overwrites `to`. Half a million vertices of
   * lerp, once, only when the viewer changes their mind mid-dissolve.
   */
  _pinFadeStart() {
    const mix = this._fade ? this._mixU.value : 1;
    const settle = (geo, target) => {
      if (!geo) return target;
      const from = geo.getAttribute('color');
      const to = geo.getAttribute('aColorTo');
      if (mix >= 1) {
        // Settled: the shown buffer becomes the one left behind. No upload —
        // both buffers are already on the GPU and only the binding changes.
        geo.setAttribute('color', to);
        geo.setAttribute('aColorTo', from);
        return from;
      }
      const a = from.array, b = to.array;
      for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * mix;
      from.needsUpdate = true;
      return to;
    };
    this.facadeColors = settle(this.facadeGeo, this.facadeColors);
    this.roofColors = settle(this.roofGeo, this.roofColors);

    /* The ground is a texture, so the same argument plays out in 2D. Settled,
     * the current canvas is copied over the previous one; mid-dissolve, it is
     * composited over it at the mix, which lands on the same blend the shader
     * was drawing. (That composite is in sRGB where the shader's is in linear
     * light — a fraction of a byte apart on an image that is about to be
     * dissolved away, and not worth a second full-resolution pass to fix.) */
    if (this.groundPrevCanvas) {
      const pctx = this.groundPrevCanvas.getContext('2d');
      if (mix >= 1) {
        pctx.globalCompositeOperation = 'copy';
        pctx.drawImage(this.groundCanvas, 0, 0);
        pctx.globalCompositeOperation = 'source-over';
      } else {
        pctx.globalAlpha = mix;
        pctx.drawImage(this.groundCanvas, 0, 0);
        pctx.globalAlpha = 1;
      }
      this.groundPrevTex.needsUpdate = true;
      this.groundPrevTex.generateMipmaps = true;
    }

    this._skyFrom = this._skyNow || this._skyStateAt(this.hour);
    this._mixU.value = 0;
    // The old dissolve has now been folded into the `from` half and is over.
    // `_repaintTime` starts the new one once the repaint has landed; until then
    // the scene is legitimately fade-free, which is what lets `_recolour` treat
    // a live fade as evidence that something OTHER than the clock moved.
    this._fade = null;
  }

  /** Abandon a dissolve and stand on its destination.
   *
   * The dissolve is only meaningful between two states of the same picture. Any
   * repaint that changes what is being drawn rather than when — a selection, a
   * layer, a highlight, the film's recession — writes only the destination
   * half, so leaving the mix part-way would blend the new picture with an old
   * one and show a city half-selected. Landing first is the honest answer, and
   * it costs at most the tail of a half-second dissolve. */
  _endFade() {
    this._fade = null;
    this._mixU.value = 1;
    this._updateSky();
  }

  /** Advance the dissolve by one frame. Driven from `tick`, so it runs on
   *  elapsed time and a dropped frame costs no progress. */
  _stepFade(dt) {
    const f = this._fade;
    if (!f) return;
    f.t = Math.min(f.dur, f.t + dt);
    const u = f.dur > 0 ? f.t / f.dur : 1;
    const e = f.linear ? u : u * u * (3 - 2 * u);
    this._mixU.value = e;

    const a = this._skyFrom, b = this._skyTo;
    if (a && b) {
      // Azimuth is a bearing, so it is interpolated the short way round: the
      // sun crossing from 350 to 10 degrees must not sweep backwards through
      // south, which is what a straight lerp would draw.
      let d = ((b.az - a.az + 540) % 360) - 180;
      this._applySky({
        alt: a.alt + (b.alt - a.alt) * e,
        az: a.az + d * e,
        cloud: a.cloud + (b.cloud - a.cloud) * e,
      });
    }
    if (u >= 1) {
      this._fade = null;
      this._mixU.value = 1;
      // Land on the hour's own solar state rather than on the last lerp of it,
      // so the settled sky is exactly what `_updateSky` would have drawn.
      this._updateSky();
    }
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

  /** How far the unselected city is pushed back, 0 (not at all) to 1 (fully).
   *
   *  One caller: the opening film, which ramps it up across the sentence that
   *  introduces the building rather than letting the selection switch it on. The
   *  interface never touches it, and it is reset to 1 by `clearSelection` — a
   *  half-applied dim left behind by a film that was skipped mid-beat would be a
   *  city that never quite comes back. */
  setDimStrength(k) {
    const v = Math.max(0, Math.min(1, k));
    if (this.dimK === v) return;
    this.dimK = v;
    this._recolour();
  }

  /** Pick out a run of BANDS on one building — a floor, or a range of them.
   *
   * The model already answers "which building" twice over, with `select` and
   * with `setHighlight`. It had no way to answer "which part of it", and the
   * decision layer spends most of its time on exactly that: the schedule names
   * one storey out of thirty-four, the prescription names a range of them on a
   * single face, and both were being read out over a building lit uniformly
   * from pavement to roof. A viewer told "floor twenty-five is the worst" and
   * shown a whole tower has been told a fact and shown a shape.
   *
   * Bands rather than storeys, because bands are what the solve has: ten of
   * them here, three or four storeys each. Converting is the caller's job — it
   * needs the building's floor count, which is in the ranking rather than in
   * the geometry — and the two ends are inclusive.
   *
   * The treatment is deliberately the same one `setHighlight` uses between
   * buildings: the named part keeps its measured colour and lifts, the rest of
   * the same building drains toward grey. Inventing a second visual language
   * for "not the subject" would mean a facade that is dim for one reason
   * sitting beside a facade that is dim for another.
   */
  setBandFocus(buildingIndex, lo = null, hi = null) {
    this.bandFocus = (buildingIndex === null || buildingIndex === undefined || lo === null)
      ? null
      : { b: buildingIndex, lo: Math.min(lo, hi ?? lo), hi: Math.max(lo, hi ?? lo) };
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
    // Only `_repaintTime` may repaint into a live dissolve; see `_endFade`.
    if (this._fade) this._endFade();
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
      annual_kh35: 'degree_hours_35', annual_dose: 'dose_kwh',
      winter_sun: 'winter_sun_share',
    }[layer] || null;
    const annualArr = annualPlane ? d.annual[annualPlane] : null;
    const annualDom = annualPlane ? this.annualDomain(annualPlane) : null;

    const dom = this.surfaceDomain;
    const f = (layer === 'priority' || layer === 'annual_priority') ? RAMPS.priority
      : (layer === 'winter_sun') ? RAMPS.diverging
      : (layer === 'excess') ? RAMPS.excess
      : (layer === 'annual_kh35' || layer === 'annual_dose') ? RAMPS.duration
      : RAMPS.temperature;

    /* The hour's air anchor, and the gain read against it.
     *
     * Hoisted because it is one number for the whole city and `excessAt` would
     * look it up 294,150 times to return the same value. Resolved to 0 when
     * neither the excess layer nor a gain is asking for it, so an ordinary
     * repaint does not touch `meta.hours` at all.
     *
     * The gain applies to the temperature layer only. On the excess layer it
     * would be gain on gain, and on a duration, a priority or an annual total
     * there is no air anchor to be an excess OVER — multiplying those about a
     * temperature would be arithmetic with no physical reading. */
    const gain = (layer === 'surface') ? (this.detailGain || 1) : 1;
    const anchored = layer === 'excess' || gain !== 1;
    const anchor = anchored ? d.anchorAt(this.hour) : 0;
    const exDom = EXCESS_DOMAIN;
    // The duration layers read their value from the tile under each address
    // rather than from the panel, and against their own domain rather than the
    // temperature one.
    const durField = (layer === 'exceedance') ? layer : null;
    const durSample = durField ? this._panelField(durField) : null;
    const durDom = durField ? this._durationDomain(durField) : null;

    // Selection highlight: everything not selected desaturates, so the chosen
    // building stands out without changing its data colour. A highlight SET does
    // the same for several buildings at once, which is what the analyst uses to
    // point at an answer.
    const sel = this.selected;
    const hi = this.highlighted;
    const ga = this.facadeGhost.array;
    // The run of bands one building is currently being asked about, if any.
    // Resolved once per repaint rather than per quad, like everything else here.
    const bf = this.bandFocus || null;
    /* How far the recession is taken this repaint. Interpolated toward 1
     * rather than switched on, so the film can arrive on a city and let it step
     * back over a sentence; everywhere else `dimK` is 1 and these are exactly
     * the two constants. At k = 0 both reduce to the identity, so an undimmed
     * repaint is the measured colour and not an approximation of it. */
    const k = this.dimK === undefined ? DIM_FULL : this.dimK;
    const dim = 1 + (DIM - 1) * k;
    const desat = DIM_DESAT * k;

    /* The ghost is rewritten only when what is being pointed AT changes.
     *
     * It depends on the selection, the highlighted set and the band focus, and
     * on nothing else — not the hour, not the layer, not the ramp — while
     * everything around it in this loop depends on all three of those. Left
     * ungated it added a 4.7 MB attribute upload to every hour tick, which on a
     * scrubbed timeline is sixty a second to say the same thing sixty times. */
    const brush = this.valueBrush;
    const ghostKey = (sel === null && !brush)
      ? ''
      : `${sel}|${hi ? [...hi].join(',') : ''}|${bf ? bf.b : ''}|${brush ? brush.join(':') : ''}`;
    /* A value brush cannot be cached against a key, and is the one thing here
     * that defeats the gate below.
     *
     * Everything else the ghost depends on is an identity — a building, a set, a
     * band run — and identities survive an hour tick. A brush selects by the
     * NUMBER on the wall, and that number changes with the hour, the date, the
     * gain and the layer, so the same brush over the same city is a different
     * set of quads one hour later. While one is up the ghost is rewritten every
     * repaint, which is the 4.7 MB upload the gate exists to avoid. It is the
     * right price for as long as somebody is actually holding the brush, and
     * for no longer — which is why the brush clears on a layer change. */
    let ghostDirty = this._ghostSel !== ghostKey || !!brush;
    this._ghostSel = ghostKey;
    this._ghostDirty = ghostDirty;
    /* The photograph dissolves on the same terms, and off the same key.
     *
     * Ghosting is a property of the selection rather than of the surface
     * carrying the measurement, so switching to the photoreal layer must not
     * quietly drop it — a tower picked out of the massing model and then looked
     * at photographically is the same tower, and having it disappear behind its
     * neighbours the moment the picture arrives is the layer contradicting the
     * click. The dimming half already survives the switch for free, because the
     * projected colours are read out of this very loop after it has drained
     * them; only the see-through half has to be handed over.
     *
     * Sent to the layer whether or not it is currently on, so a viewer who
     * selects a building and then enables the photograph gets a frame that
     * already agrees with the one they were looking at. */
    if (ghostDirty && this.photoreal) this.photoreal.setSubject(this._subjectSet());

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

    /* What share of the ramp this pass actually used, on the drawn 0..1 domain.
     *
     * A fixed temperature scale means the legend no longer says anything about
     * the period in front of you — it reads −20 to 60 °C in January and in July,
     * which is the entire point and also a real loss, because the old moving
     * legend did carry that. This hands it back without moving the scale: the
     * interface brackets the span on the ramp, so a January city is a narrow
     * blue slice of a scale whose hot end is visibly not being used.
     *
     * Accumulated here rather than measured separately because this loop already
     * visits every quad and already has the value in hand. */
    let tvLo = Infinity, tvHi = -Infinity;
    let ttLo = Infinity, ttHi = -Infinity;

    /* The distribution, not just its ends.
     *
     * The bracket says WHERE on the ramp the hour falls and how wide it is. It
     * cannot say what the hour looks like inside that width, and the difference
     * matters: a clear night is one tall spike, a sunlit afternoon is two lobes
     * with a gap where the sun/shade boundary is, and those are the same bracket.
     * Ninety-six bins accumulated in the loop that is already visiting every quad
     * and already normalising every value, for the same reason the bracket is —
     * a second sweep would be a second implementation to drift. */
    const isoOn = this.isoOn && this._isoU.value > 0;
    const vals = this._vals;
    const hist = this._hist;
    hist.fill(0);
    const HB = Scene.HIST_BINS;
    // The measured field's own histogram, and only when that is a different
    // thing from the drawn one. At gain 1 the two are identical and the second
    // increment would be pure cost on the hot path.
    const histT = gain !== 1 ? this._histTrue : hist;
    if (histT !== hist) histT.fill(0);

    for (let q = 0; q < this.nQuad; q++) {
      const p = this.quadPanel[q], b = this.quadBand[q];
      let c;
      /* The same value the colour was chosen from, on its own 0..1 domain.
       *
       * Carried because the photoreal shader now decides *whether* to paint a
       * surface, not only what colour to paint it, and a threshold needs a
       * quantity. It used to be nearly recoverable from the colour, back when
       * the ramp was monotonic in lightness, and "nearly" was already not a
       * basis for a rule that silently drops surfaces. The blue-to-red ramp is
       * not monotonic in lightness at all — −20 degC and +60 degC have the same
       * luminance — so it is not recoverable even in principle now. Sun and
       * shade is categorical, so it takes the two ends of the domain it is
       * already drawn with. */
      let tv;
      /* The same value with no gain applied, which is the one the bracket's
       * NUMBERS are read from. The bracket's rectangle marks where the colours
       * on screen fall, so it has to follow the exaggeration; its label names
       * temperatures, and there is no gain at which it may name one the model
       * did not solve. Equal to `tv` everywhere except the gained branch. */
      let tvTrue;
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
      } else if (layer === 'sun') {
        const lit = d.sunlitAt(this.hour, p, b);
        tv = lit ? 1 : 0;
        c = lit ? SUNLIT_RGB : SHADE_RGB;
      } else if (durField) {
        tv = norm(durSample[p], durDom[0], durDom[1]);
        c = f(tv);
      } else if (layer === 'excess') {
        // How far this wall is from the air beside it. Read against its own
        // fixed 24 K domain — see EXCESS_DOMAIN in colors.js for why that domain
        // and why its zero is not in the middle.
        tv = norm(d.surfaceAt(this.hour, p, b) - anchor, exDom[0], exDom[1]);
        c = f(tv);
      } else {
        /* The temperature, optionally with its local detail exaggerated.
         *
         * At gain 1 this is the measured field and the expression reduces to
         * the identity, which is why the multiply is not gated on a branch.
         *
         * Above 1 it is the one operation in this file that draws a number the
         * model did not solve, so it is worth being exact about what it does.
         * It scales the wall's distance from the hour's air anchor and leaves
         * the anchor alone. The anchor carries 96% of the field's variance and
         * all of its seasonality, so January stays blue and July stays red and
         * the legend's fixed scale keeps meaning what it says; what stretches is
         * only the 4% that separates one wall from the next. It is local tone
         * mapping, and it is here for the reason a photographer lifts shadows
         * rather than re-exposing: the scale must not move, but a median hour
         * spans 4 K of an 80 K ramp and 4 K is about five just-noticeable
         * differences for 29,415 panels.
         *
         * It is NOT the per-period auto-scaling this project deleted. That moved
         * the domain underneath the viewer and only the small type knew. This
         * moves nothing: the domain is TEMP_DOMAIN whatever the gain, the base
         * is a physical quantity the solver itself anchors to rather than a
         * percentile of the visible field, and the factor is printed on the
         * legend with a key held down to drop it back to the truth.
         *
         * Safe to amplify because the field is smooth. Median band-to-band step
         * within a panel is 11% of a field's own sd across all 104 solved
         * fields, so the structure being multiplied is solved structure and not
         * the solver's noise floor. */
        const t = d.surfaceAt(this.hour, p, b);
        tvTrue = norm(t, dom[0], dom[1]);
        tv = gain === 1 ? tvTrue : norm(anchor + (t - anchor) * gain, dom[0], dom[1]);
        c = f(tv);
      }
      if (tvTrue === undefined) tvTrue = tv;
      if (tv < tvLo) tvLo = tv;
      if (tv > tvHi) tvHi = tv;
      if (tvTrue < ttLo) ttLo = tvTrue;
      if (tvTrue > ttHi) ttHi = tvTrue;
      // Kept for the isotherm pass below. -1 rather than NaN so an unsolved
      // panel is a value the shader can test rather than one that poisons
      // `fwidth` for the whole quad.
      if (isoOn) vals[q] = tvTrue >= 0 ? tvTrue : -1;
      // `tv >= 0` rather than isFinite: norm already clamped to 0..1, and NaN
      // fails the comparison, so an unsolved panel is excluded for free.
      if (tv >= 0) hist[tv >= 1 ? HB - 1 : (tv * HB) | 0]++;
      if (histT !== hist && tvTrue >= 0) histT[tvTrue >= 1 ? HB - 1 : (tvTrue * HB) | 0]++;
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
      if (sunUp && (layer === 'surface' || layer === 'excess')) {
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
      /* A band focus is a THIRD reason a quad can be pushed back, and it is the
       * only one that can push back part of the very building the camera is
       * pointed at. It applies on top of the other two rather than instead of
       * them: a storey outside the named run is not the subject whether or not
       * its building is. */
      const qb = this.quadBuilding[q];
      const offBand = bf && qb === bf.b && (b < bf.lo || b > bf.hi);
      /* Selected OR highlighted is the subject; everything else steps back.
       *
       * The `or` is the part worth stating. A highlight used to be ignored
       * entirely while anything was selected — the rule was "dim everything
       * that is not the selection", so a set of fourteen buildings picked out by
       * the analyst while one of them was open in the dossier came out as one
       * building and thirteen dimmed ones. It is most visible in the
       * walkthrough, where the beat that says the heat comes off the tower
       * opposite marks both towers and used to render one: the tower being
       * blamed was drained to grey by the fact that the tower being heated was
       * selected, which is precisely backwards. */
      const isHi = !!hi && hi.has(qb);
      const isSel = sel !== null && qb === sel;
      const subject = hi ? (isHi || isSel) : (sel === null || isSel);
      /* A brushed-out wall steps back on both channels the scene already owns —
       * drained here and made see-through below. One alone was not enough: the
       * whole point of a brush is that the walls it keeps are a small minority
       * scattered through five thousand buildings, and desaturation on its own
       * still leaves five thousand solid buildings in front of them. */
      const outOfBrush = !!brush && !(tv >= brush[0] && tv <= brush[1]);
      const dimmed = offBand || !subject || outOfBrush;
      if (dimmed) {
        /* Pushed back by draining the colour, not by darkening it.
         *
         * A multiply toward black was right while the ramp's hot end was cream:
         * dark meant "not the subject" and nothing else. With deep red at the
         * hot end and deep blue at the cold one, darkness is the measurement at
         * both extremes, so dimming by darkening pushed every unselected
         * building away from 20 degC in whichever direction it already leaned,
         * and made a dimmed hot or freezing one vanish into the shell entirely.
         * Desaturating says "not the subject" using a channel the data is not
         * speaking on. */
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r += (y - r) * desat; g += (y - g) * desat; bl += (y - bl) * desat;
        r *= dim; g *= dim; bl *= dim;
      } else if (isHi || (bf && qb === bf.b)) {
        // Lift the highlighted set rather than only dimming the rest: on a dark
        // scene a set of fourteen buildings picked out by dimming five thousand
        // others is a set nobody can find. The same argument holds a storey at a
        // time — a band lit only by the thirty-three around it going grey is a
        // band you have to be told about to see.
        r = Math.min(1, r * 1.18 + 0.05);
        g = Math.min(1, g * 1.14 + 0.05);
        bl = Math.min(1, bl * 1.05);
      }
      const o = q * 12;
      for (let k = 0; k < 4; k++) { arr[o + k * 3] = r; arr[o + k * 3 + 1] = g; arr[o + k * 3 + 2] = bl; }

      /* See-through only for a single selection, and never for a highlight set
       * or a band focus.
       *
       * Those two answer "which of these", and their members are scattered
       * across the whole model — making everything else see-through would put
       * the entire city into stipple to pick out fourteen buildings that are
       * already lifted, and stipple everywhere is just a noisier city. One
       * selected building is the case where something specific is being hidden
       * by something specific, and it is the case this is for. */
      /* Everything the view is pointing at stays solid, not only the selection.
       *
       * A highlighted set and a band focus are the other two ways this model
       * says "look here", and they routinely run WITH a selection — the
       * walkthrough selects one building and lights the tower opposite in the
       * same beat. Ghosting on the selection alone put that tower into stipple
       * while the lift meant to pick it out was still being applied to it, so
       * the one building being argued about came out blown-out and half
       * dissolved. Whatever is being pointed at is the subject; the ghost is
       * for everything else. */
      if (ghostDirty) {
        const b0 = this.quadBuilding[q];
        const subject = b0 === sel || (hi && hi.has(b0)) || (bf && b0 === bf.b);
        ga[q * 4] = ga[q * 4 + 1] = ga[q * 4 + 2] = ga[q * 4 + 3] =
          ((sel !== null && !subject) || outOfBrush) ? GHOST : 1;
      }

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
    // Clamped to the ramp, because a value off the end of a fixed scale is drawn
    // at the end of it and the bracket has to agree with what is on screen.
    this.paintedRange = (tvLo <= tvHi)
      ? [Math.max(0, tvLo), Math.min(1, tvHi)] : null;
    // What the model actually solved, whatever the gain drew. The legend takes
    // its figures from here and its rectangle from `paintedRange`.
    this.paintedRangeTrue = (ttLo <= ttHi)
      ? [Math.max(0, ttLo), Math.min(1, ttHi)] : null;
    /* Vertex values for the isotherms, from the per-quad values just collected.
     *
     * A second pass rather than work inside the loop above, because a quad needs
     * its NEIGHBOURS and the loop only has itself. Quads run panel-major and
     * band-minor, so band b-1 and b+1 of the same panel are simply q-1 and q+1 —
     * no adjacency table, one linear sweep, and no ramp evaluation in it. It
     * costs about a millisecond against the forty the loop above takes.
     *
     * Gated on the contours actually being on: the attribute is 1.2 MB and
     * uploading it beside the 3.5 MB of colour on every hour tick is a third
     * again of the per-step cost, to feed a shader branch that is switched off. */
    if (isoOn) {
      const nb = this.data.facades.bands;
      const va = this.facadeVal.array;
      for (let q = 0; q < this.nQuad; q++) {
        const v = vals[q];
        const b = this.quadBand[q];
        // An unsolved quad stays unsolved rather than borrowing a neighbour's
        // value, which would draw a contour across a gap in the model.
        if (v < 0) {
          va[q * 4] = va[q * 4 + 1] = va[q * 4 + 2] = va[q * 4 + 3] = -1;
          continue;
        }
        const below = b > 0 && vals[q - 1] >= 0 ? vals[q - 1] : v;
        const above = b < nb - 1 && vals[q + 1] >= 0 ? vals[q + 1] : v;
        // Corners are bottom-left, bottom-right, top-right, top-left.
        const vb = (v + below) * 0.5, vt = (v + above) * 0.5;
        va[q * 4] = vb; va[q * 4 + 1] = vb;
        va[q * 4 + 2] = vt; va[q * 4 + 3] = vt;
      }
      this.facadeVal.needsUpdate = true;
    }
    this.paintedHist = hist;
    this.paintedCore = Scene.coreOf(hist);
    this.paintedCoreTrue = histT === hist ? this.paintedCore : Scene.coreOf(histT);
    this.facadeColors.needsUpdate = true;
    if (ghostDirty) this.facadeGhost.needsUpdate = true;
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

    /* On the same absolute scale as everything else, and NOT ranked.
     *
     * This used to contrast-stretch each building's peak across the city's own
     * 2nd-98th percentiles, so the colour was a building's POSITION AMONG ITS
     * NEIGHBOURS rather than a temperature. That was done for a real reason —
     * at the peak hour of a heat wave the peaks crowd into a strip a few per
     * cent wide near the top of the domain, and a fixed scale renders them all
     * the same deep orange. Ranking spread them out and the far view said
     * something again.
     *
     * It was still the wrong trade, for two reasons that only show up away from
     * that one hour.
     *
     * A rank cannot be compared with itself across time. On a February day the
     * hottest wall in Midtown is about five degrees, and a stretch puts it at
     * the top of the ramp — so the city came out the same red in winter as at
     * the peak of a heat wave, and the tooltip beside it said 5.4 degC. A scale
     * that means something different on every date is not a scale.
     *
     * And it disagreed with the rest of the frame. The facade field this same
     * shader paints up close is absolute, so one building changed colour as you
     * flew toward it, with nothing on screen to say why.
     *
     * So: the raw position on the domain, the same number the panels are drawn
     * from. The crowding at the peak hour is real and is now shown as what it
     * is — at the worst hour of a heat wave most walls in Midtown ARE near the
     * top, and a picture that says so is more honest than one that manufactures
     * a spread. Discrimination at that hour is what the threshold slider is
     * for, and it now means what its label says: show me everything above this
     * position on the legend.
     */
    /* The selection drains this table too, on the same terms as the geometry.
     *
     * The facade LUT gets it for free — those colours are accumulated inside
     * the repaint loop, after it has desaturated everything that is not the
     * subject — and it was tempting to assume this table did as well. It does
     * not: a building's aggregate is written here, straight off the ramp at its
     * peak, and the ramp knows nothing about what is selected.
     *
     * The frame that showed it is the far view with a tower selected. Every
     * other building went see-through, exactly as asked, and stayed a fully
     * saturated red while doing it — so the context turned into a field of
     * bright red noise, which is the loudest thing that can be put on a screen
     * next to the one building it is supposed to be stepping back from. The
     * dissolve was working and the frame still pointed at the wrong thing.
     *
     * Two halves, both needed: the dissolve says "you can see past this", the
     * drain says "and it is not what you are looking at". */
    const sel = this.selected;
    const hi = this.highlighted;
    const bf = this.bandFocus || null;
    const k = this.dimK === undefined ? DIM_FULL : this.dimK;
    const dim = 1 + (DIM - 1) * k;
    const desat = DIM_DESAT * k;

    for (let i = 0, n = peak.length; i < n; i++) {
      const o = i * 4;
      const t = peak[i];
      if (!(t >= 0)) { buf[o + 3] = 0; continue; }
      const st = t;
      const c = f(st);
      let r = c[0], g = c[1], b = c[2];
      // Selected OR highlighted is the subject, exactly as in `_recolour`.
      const isHi = !!hi && hi.has(i);
      const isSel = sel !== null && i === sel;
      const subject = hi ? (isHi || isSel) : (sel === null || isSel);
      if (!subject) {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = (r + (y - r) * desat) * dim;
        g = (g + (y - g) * desat) * dim;
        b = (b + (y - b) * desat) * dim;
      } else if (isHi || (bf && i === bf.b)) {
        // The same lift the geometry gets: a set picked out only by everything
        // else receding is a set nobody can find on a dark scene.
        r = Math.min(255, r * 1.18 + 13);
        g = Math.min(255, g * 1.14 + 13);
        b = Math.min(255, b * 1.05);
      }
      buf[o] = r | 0; buf[o + 1] = g | 0; buf[o + 2] = b | 0;
      /* Alpha is untouched by any of this, and that is deliberate: it carries
       * the measured value the threshold slider compares against, not the
       * colour. Draining a building must not also change whether it is above
       * the cut, or the threshold would move every time something was
       * selected. */
      buf[o + 3] = 1 + Math.min(254, Math.round(st * 254));
    }
    pr.commitAgg();
  }

  _recolourRoofs() {
    const d = this.data;
    const arr = this.roofColors.array;
    const rga = this.roofGhost.array;
    const sel = this.selected;
    // Set by _recolour, the only caller. See the note there.
    const ghostDirty = this._ghostDirty;
    const dom = this.surfaceDomain;
    const rDurField = (this.layer === 'exceedance') ? this.layer : null;
    const rDurSample = rDurField ? this._buildingField(rDurField) : null;
    const rDurDom = rDurField ? this._durationDomain(rDurField) : null;

    const annualPlane = {
      annual_kh35: 'degree_hours_35', annual_dose: 'dose_kwh',
      winter_sun: 'winter_sun_share',
    }[this.layer] || null;
    const annualArr = annualPlane ? d.annual[annualPlane] : null;
    const annualDom = annualPlane ? this.annualDomain(annualPlane) : null;
    const annualRamp = (this.layer === 'winter_sun') ? RAMPS.diverging
      : (this.layer === 'annual_kh35' || this.layer === 'annual_dose') ? RAMPS.duration
      : RAMPS.temperature;
    const hi = this.highlighted;
    const bf = this.bandFocus || null;
    // The same three, on the same terms as the walls. A roof left at gain 1
    // while the walls below it were exaggerated, or left solid while the walls
    // were brushed away, is the city disagreeing with itself from altitude.
    const rGain = (this.layer === 'surface') ? (this.detailGain || 1) : 1;
    const rAnchor = (this.layer === 'excess' || rGain !== 1) ? d.anchorAt(this.hour) : 0;
    const rBrush = this.valueBrush;
    // The same interpolated strength the facades use — see `_recolour`. Roofs
    // and walls have to recede together or the city half-fades.
    const k = this.dimK === undefined ? DIM_FULL : this.dimK;
    const dim = 1 + (DIM - 1) * k;
    const desat = DIM_DESAT * k;
    const nBand = d.facades.bands;
    const nBandTop = nBand - 1;

    for (let i = 0; i < this.roofRange.length; i++) {
      const [start, n] = this.roofRange[i];
      if (!n) continue;
      const a = d.buildings.attrs[i];
      let c;
      // The roof's own normalised value, for the brush. Left NaN on the layers
      // that do not go through the temperature branch — brushing those is a
      // question about facade bands, and a roof has none.
      let rtv = NaN;
      if (this.layer === 'priority' || this.layer === 'annual_priority') {
        const v = this.layer === 'priority' ? a?.pr : a?.apr;
        rtv = norm(v !== undefined ? v : NaN, 0, 85);
        c = RAMPS.priority(rtv);
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
        rtv = norm(cnt ? sum / cnt : NaN, annualDom[0], annualDom[1]);
        c = annualRamp(rtv);
      } else if (this.layer === 'sun') {
        rtv = 1;
        c = SUNLIT_RGB;   // roofs are always the most exposed surface
      } else if (rDurField) {
        rtv = norm(rDurSample[i], rDurDom[0], rDurDom[1]);
        c = RAMPS.duration(rtv);
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
            const v = d.surfaceAt(this.hour, p, d.facades.bands - 1);
            if (isFinite(v)) { sum += v; cnt++; }
          }
          if (cnt) t = sum / cnt;
        }
        if (this.layer === 'excess') {
          rtv = norm(t - rAnchor, EXCESS_DOMAIN[0], EXCESS_DOMAIN[1]);
          c = RAMPS.excess(rtv);
        } else {
          rtv = norm(rAnchor + (t - rAnchor) * rGain, dom[0], dom[1]);
          c = RAMPS.temperature(rtv);
        }
      }
      // Roofs are the least obstructed surface in the city, so they carry
      // nearly the full value — trimmed only enough to stop them flaring
      // against the occluded facades below.
      const rs = 0.94;
      let r = (c[0] / 255) * rs, g = (c[1] / 255) * rs, bl = (c[2] / 255) * rs;
      // A roof belongs to the top band, so it joins the focus only when the top
      // band is inside it. A lit roof over a building whose lit storeys are all
      // near the pavement points at the wrong end of the tower.
      const offBand = bf && i === bf.b && bf.hi < nBandTop;
      // Selected OR highlighted, exactly as in `_recolour` — see the note there.
      const isHi = !!hi && hi.has(i);
      const isSel = sel !== null && i === sel;
      const rOut = !!rBrush && !(rtv >= rBrush[0] && rtv <= rBrush[1]);
      const dimmed = offBand || !(hi ? (isHi || isSel) : (sel === null || isSel)) || rOut;
      if (dimmed) {
        // Desaturate then dim, for the reason given in _recolour: darkness now
        // carries the measurement and cannot also carry "not the subject".
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r += (y - r) * desat; g += (y - g) * desat; bl += (y - bl) * desat;
        r *= dim; g *= dim; bl *= dim;
      } else if (isHi || (bf && i === bf.b)) {
        r = Math.min(1, r * 1.18 + 0.05);
        g = Math.min(1, g * 1.14 + 0.05);
        bl = Math.min(1, bl * 1.05);
      }
      const subject = i === sel || (hi && hi.has(i)) || (bf && i === bf.b);
      const gv = ((sel !== null && !subject) || rOut) ? GHOST : 1;
      for (let k = 0; k < n; k++) {
        const o = (start + k) * 3;
        arr[o] = r; arr[o + 1] = g; arr[o + 2] = bl;
        if (ghostDirty) rga[start + k] = gv;
      }
    }
    this.roofColors.needsUpdate = true;
    if (ghostDirty) {
      this.roofGhost.needsUpdate = true;
      this._syncSelOverlay();
    }
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

  /** Show the never-occluded copy of the subject only while there is one.
   *
   * With nothing selected every vertex carries full alpha, so the overlay's
   * "keep the full-alpha fragments" test would let the entire city through and
   * draw it over itself with no depth test — the one state in which this mesh
   * must not be on. It also follows the massing's own visibility, so switching
   * to the photoreal layer does not leave one building hanging in the air. */
  /** The buildings the view is pointing at, or null when nothing is selected.
   *
   * The same rule the repaint applies quad by quad, in one place: a selection,
   * whatever is highlighted alongside it, and any building under a band focus.
   * Read by the photoreal layer, which cannot re-derive it — it has no vertex
   * to hang the answer on and would otherwise be a second copy of a rule that
   * has already changed once (see the note on `subject` in `_recolour`). */
  _subjectSet() {
    if (this.selected === null) return null;
    const hi = this.highlighted, bf = this.bandFocus;
    return new Set([this.selected, ...(hi || []), ...(bf ? [bf.b] : [])]);
  }

  _syncSelOverlay() {
    const on = this.selected !== null && !this._hidden;
    if (this.facadeTop) this.facadeTop.visible = on;
    if (this.roofTop) this.roofTop.visible = on;
  }

  select(buildingIndex) {
    // Nothing left to walk around once the selection is gone.
    if (buildingIndex === null) this.setSpin(false);
    // A band focus belongs to the building it was set on. Carrying it across a
    // selection would drain a run of storeys on a building nobody asked about,
    // which reads as a rendering fault rather than as an answer.
    if (this.bandFocus && this.bandFocus.b !== buildingIndex) this.bandFocus = null;
    // A partial dim is a thing the film sets up and takes down across one beat.
    // Deselecting is the end of that, and of every other reason to be dimmed, so
    // the strength goes back to full here — a film skipped part way through its
    // ramp must not leave the city permanently half-drained.
    if (buildingIndex === null) this.dimK = DIM_FULL;
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
    this.setSpin(false);
    this._abortFly(true);
    const from = this._modePose();
    const c = this._buildingAnchor(buildingIndex);
    const h = a.h;
    // No transition from setView: it would fly to the pose the view implies,
    // which is not the pose this method is about to set. The flight is started
    // here instead, once the camera is where the building wants it.
    this.setView(null, { animate: false });
    this.controls.target.copy(c);
    const dist = Math.max(150, h * 2.4);
    this.camera.position.set(c.x + dist * 0.75, h * 1.05 + 90, c.z + dist * 0.75);
    this.controls.update();
    this._beginTransit(from);
  }

  /* Frame ONE FACE of one building, at ONE HEIGHT on it.
   *
   * `focus` frames a whole building from a fixed corner, which is the right
   * answer to a click: it does not know which wall you meant, so it takes the
   * three-quarter view that shows two of them. The walkthrough always knows.
   * It says "the north-west face takes the late sun" and then "the north-east
   * face never sees the sun at all", and those are two sentences about two
   * walls that a single corner view either shows badly or does not show at all
   * — the second of them is round the back.
   *
   * `bearing` is where the CAMERA STANDS, as a compass bearing from the
   * building, so a north-west face is read from 315 and a north-east one from
   * 45. Scene x is east and scene −z is north, so a bearing lands the eye at
   * (sin, −cos), which is the one line here worth checking against the
   * projection note at the top of this file.
   *
   * `height` is metres above the pavement, and it is what makes the floor
   * beats mean anything: told the twenty-fifth storey of a thirty-four storey
   * tower is the worst one, the camera should be level with it rather than
   * looking down on the whole building from the height of its roof.
   */
  frameFacade(buildingIndex, { bearing = 225, height = null, dist = null,
                               rise = 0.72 } = {}) {
    const a = this.data.buildings.attrs[buildingIndex];
    if (!a) return;
    // A frame is a deliberate composition; an automatic revolution would start
    // turning out of it on the next frame. The caller turns the spin back on
    // when it wants the shot to move.
    this.setSpin(false);
    this._abortFly(true);
    const from = this._modePose();
    const c = this._buildingAnchor(buildingIndex);
    const y = height === null ? c.y : Math.max(12, height);
    /* Standoff and eye height, and the two of them together are the whole
     * problem this method has.
     *
     * A wall in Midtown is almost never visible from in front of it. Stand a
     * camera at street level at the bearing the wall faces and what fills the
     * frame is whatever is built on the other side of that street — which on
     * this block is a forty-five-storey tower, and it is the tower the chapter
     * is about to blame for the heat. Backing further off makes this worse, not
     * better: every extra metre of standoff is another building between the eye
     * and the wall. The first two attempts here both did that, at 1.55 and then
     * 2.5 heights, and produced a shot of a pale box with a small orange stripe
     * behind it.
     *
     * So the eye goes UP instead of back. `rise` is the height gained per metre
     * of standoff, and at 0.72 the camera clears the roofline of the block in
     * front and looks down the face at about forty degrees — which is both the
     * angle from which a whole wall is visible at once, and the angle an aerial
     * unit would actually shoot it from.
     *
     * These two numbers are tighter than they look. 0.62 and 1.8 heights was
     * tried, to show more wall and less roof, and put the neighbouring block's
     * roof straight back across the middle of the frame. There is not much room
     * between "too low to see over the street" and "too high to see the wall". */
    const d = dist === null ? Math.max(210, a.h * 2.0) : dist;
    const az = (bearing * Math.PI) / 180;
    this.setView(null, { animate: false });
    this.controls.target.set(c.x, y, c.z);
    this.camera.position.set(
      c.x + Math.sin(az) * d,
      y + d * rise,
      c.z - Math.cos(az) * d);
    this._clampOrbitView();
    this.controls.update();
    this._orbitFog();
    this._beginTransit(from);
  }

  /** Frame two buildings at once, from the side that has both in it.
   *
   * Chapter three's turn is that the shaded wall is hot because of the tower
   * standing opposite it, and a claim about two buildings needs a shot with two
   * buildings in it. Pulling back from one of them by a fixed factor does not
   * reliably produce that — whether the other is in frame depends on which way
   * the camera happened to be pointing — so this stands the camera off along
   * the perpendicular to the line between them, which is the one bearing from
   * which neither hides the other.
   */
  framePair(aIndex, bIndex, { rise = 0.42, pad = 2.3 } = {}) {
    const A = this._buildingAnchor(aIndex);
    const B = this._buildingAnchor(bIndex);
    const ha = this.data.buildings.attrs[aIndex]?.h || 60;
    const hb = this.data.buildings.attrs[bIndex]?.h || 60;
    this.setSpin(false);
    this._abortFly(true);
    const from = this._modePose();
    const mid = A.clone().add(B).multiplyScalar(0.5);
    mid.y = Math.max(ha, hb) * 0.5;
    // Perpendicular, in plan, to the line joining them.
    const dx = B.x - A.x, dz = B.z - A.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len, pz = dx / len;
    const d = Math.max(220, (len * 0.5 + Math.max(ha, hb) * 0.5) * pad);
    this.setView(null, { animate: false });
    this.controls.target.copy(mid);
    this.camera.position.set(mid.x + px * d, mid.y + d * rise, mid.z + pz * d);
    this._clampOrbitView();
    this.controls.update();
    this._orbitFog();
    this._beginTransit(from);
  }

  /** The point a building is looked at, and turned around: the centre of its
   *  footprint at a little over half its height.
   *
   *  Half height rather than ground, because a pivot on the pavement swings the
   *  tower through the top of the frame as soon as the camera tilts; and the
   *  centroid of the facade panels rather than of the footprint polygon,
   *  because the panels are what is being read. The 140 m ceiling keeps the
   *  pivot on the part of a very tall tower that fits on screen. */
  _buildingAnchor(buildingIndex) {
    const a = this.data.buildings.attrs[buildingIndex];
    const ps = this.data.panelsOfBuilding.get(buildingIndex);
    let x = 0, y = 0;
    if (ps && ps.length) {
      const xy = this.data.facades.xy;
      for (const p of ps) { x += xy[p * 4]; y += xy[p * 4 + 1]; }
      x /= ps.length; y /= ps.length;
    }
    return new THREE.Vector3(x, Math.min((a ? a.h : 0) * 0.55, 140), -y);
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
    this.setSpin(false);
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

  /* Stream Google's tiles without drawing the city.
   *
   * The opening film parks `tick` entirely — the application is a
   * full-resolution render behind an opaque overlay for those twenty-five
   * seconds, which is pure waste and, on a weak GPU, the difference between the
   * film playing at speed and playing in slow motion. Parking it also parked
   * the tileset, because that is updated from inside `tick`, so the layer began
   * streaming from nothing at the exact moment the film handed the screen over
   * and the first shot of the city was the detail ramp opening: blurry, then
   * popping into focus over the better part of a minute.
   *
   * This is the part of `tick` the film can afford. `update()` moves the camera
   * matrix, re-reads the screen-space error and asks the tileset to refine —
   * network and parsing, no draw call — so the warm-up happens against the pose
   * the app is already holding while the globe has the screen. What the pause
   * exists to prevent is the render, and that stays prevented. */
  warmPhotoreal() {
    if (this.photorealOn && this.photoreal) this.photoreal.update();
  }

  tick(dt) {
    // The dissolve between two clock states runs on the frame clock rather than
    // on a timer, so it keeps time with the render and a stalled frame costs it
    // no progress. It touches uniforms only — see `fadeable`.
    if (this._fade) this._stepFade(dt);
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
      this._stepSpin(dt);
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

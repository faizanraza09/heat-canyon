/* The cut: one world-space region that separates the two representations.
 *
 * Why this exists
 * ---------------
 * photoreal.js paints the modelled field onto Google's mesh per fragment, and
 * that is the right answer at street level — the comments in `_patchMaterials`
 * argue it well and the result holds up when a single facade fills the frame.
 * It does not hold up from the air, for reasons that are not parameters:
 *
 *  - Every wall the model covers is tinted, always. From altitude that is every
 *    wall in frame, so colour stops being a mark and becomes the paper. There
 *    is no neutral left for the eye to discriminate against.
 *  - The aerial frame is mostly roofs, and roofs are excluded by construction
 *    (`wall = 1 - smoothstep(0.30, 0.62, horiz)`). The street wash that would
 *    carry them is gated off 22 m above the road. So the surfaces the view can
 *    actually resolve are the ones carrying no data.
 *  - `tinted = heat.rgb * shade` multiplies the ramp's lightness — the one
 *    property colors.js relies on to make it monotonic — by the photograph's
 *    baked luminance. Oblique photogrammetry is largely in its own shadow, so
 *    the whole ramp collapses toward the same dark brown.
 *
 * Three symptoms, one cause: a facade-shaped encoding asked to work in a view
 * that cannot see facades. Turning the tint up, down, or greyer cannot fix
 * that, because the problem is that both representations are competing for the
 * same pixel.
 *
 * So stop overlaying. Give each representation its own region of the world and
 * a boundary between them. Inside the cut the city is ours: LiDAR massing,
 * ramp-coloured facades and *coloured roofs* (see Scene._recolourRoofs), which
 * is exactly the encoding an aerial view needs and exactly what the tint cannot
 * provide. Outside it, the photograph is left alone to do the only job it was
 * ever good at, which is recognition.
 *
 * Why a world-space region rather than a screen-space swipe
 * --------------------------------------------------------
 * A screen-space divider needs either two render passes or a scissor plus a
 * pair of asymmetric frusta, and it reads as a widget laid over the picture —
 * it does not move with the city, so the eye never accepts it as part of the
 * scene. A world-space region costs no extra pass (both sides are a `discard`
 * in shaders that are already being patched), parallaxes correctly, and reads
 * as a cut through Midtown rather than a control. Buildings that straddle the
 * boundary come out half photograph and half prism, which is a striking image
 * and a free registration check besides.
 *
 * Why the terrain is never cut
 * ----------------------------
 * Only *buildings* are removed inside the cut. The road, the pavement, the
 * vehicles and the street trees in Google's mesh stay, and our prisms stand on
 * them. That is not an aesthetic preference, it is what makes the seam
 * survivable: the scene's own ground plane is flat at the datum while the
 * photoreal layer stands on real NAVD88 terrain across a 26 m range, so
 * swapping ground as well as buildings would put a visible step at every
 * boundary. Leaving one shared ground under both representations removes the
 * question. It also produces the better picture — measured towers standing in a
 * real, photographed street.
 *
 * Why the "is this a building" test is a column test
 * --------------------------------------------------
 * The tint's probe walks backwards along the fragment's normal, and that normal
 * comes from `dFdx`/`dFdy` of a soft coarse-LOD mesh. It is noisy, which is
 * survivable for a colour (you get speckle) and not survivable for a `discard`
 * (you get a ragged silhouette). So the cut asks a question about position
 * alone: is there a modelled building in this vertical column, and is this
 * fragment above its pavement. No normal, no noise, and it cuts roofs — which
 * the normal-based wall mask explicitly cannot.
 *
 * Buildings the model does not cover survive inside the cut as photograph. That
 * is deliberate and it is honest: an uncut building is one we have nothing to
 * say about, and inventing a prism for it would be worse than admitting the
 * gap.
 */

import * as THREE from 'three';

export const CUT_OFF = 0;
export const CUT_LENS = 1;
export const CUT_SECTION = 2;

/* The rim colour, as display-space components rather than a THREE.Color.
 *
 * Both shaders inject at `#include <dithering_fragment>`, which three places
 * *after* `<colorspace_fragment>` — so `gl_FragColor` is already in output
 * space by the time the rim is mixed in. A THREE.Color built from a hex literal
 * is converted to the linear working space on construction, and uploading one
 * here would land a visibly darker, duller line than the swatch it is named
 * after. A Vector3 of sRGB components is not converted by anything and matches
 * the pixels it is being mixed with.
 *
 * The value is SUNLIT_RGB from colors.js: the boundary belongs to the same
 * colour language as everything else the instrument draws, and the hot end of
 * the ramp is the one place a bright line cannot be mistaken for data.
 */
const RIM_SRGB = new THREE.Vector3(238 / 255, 184 / 255, 102 / 255);

/* GLSL shared by both sides of the cut.
 *
 * `cutSigned` returns metres into the data region: positive inside, negative
 * outside. The off case returns a large negative rather than -1 so that callers
 * which forget to guard the rim band still get zero rim instead of a frame-wide
 * wash — a -1 there put the whole city one metre outside a six-metre feather
 * and painted everything orange.
 */
export const CUT_GLSL = `
  uniform int   uCutMode;
  uniform vec3  uCutCenter;
  uniform vec3  uCutNormal;
  uniform float uCutRadius;
  uniform float uCutFeather;
  uniform vec3  uCutRim;

  float cutSigned( vec3 p ) {
    if ( uCutMode == 1 ) return uCutRadius - length( p.xz - uCutCenter.xz );
    if ( uCutMode == 2 ) return dot( p - uCutCenter, uCutNormal );
    return -1e6;
  }
`;

/** State for the cut, plus the plumbing to push it into any patched material.
 *
 * Deliberately not a registry of the materials it drives. The photoreal layer
 * streams materials in and out constantly and already keeps its own live set
 * (`Photoreal._mats`, pruned in `_forgetMaterials`); a second set here would
 * hold disposed materials alive for the life of the session, which is the exact
 * shape of leak this codebase has been bitten by before. Each owner iterates
 * its own materials and calls `writeTo`.
 */
export class Cut {
  constructor(onChange) {
    this.onChange = onChange || null;
    this.mode = CUT_OFF;
    /* Whether the cut is allowed to act at all. The prisms are the *whole*
     * scene when the photoreal layer is off, so a cut applied then would carve
     * the city away and leave the clear colour behind. Scene sets this from
     * photorealOn; `mode` stays whatever the user chose, so switching the layer
     * back on restores the cut they had rather than resetting it. */
    this.enabled = false;
    this.center = new THREE.Vector3(0, 0, 0);
    /* Perpendicular to the section's street. See setBearing. */
    this.normal = new THREE.Vector3(1, 0, 0);
    this.radius = 260;
    /* Metres either side of the boundary that carry the rim. Six is about a
     * storey: wide enough to read from the air, narrow enough at street level
     * that it does not become a stripe painted across the facade in front of
     * you. */
    this.feather = 6;
    /* Whether the lens tracks the pointer. Off freezes it where it stands,
     * which is what you want the moment you go to point at something in it. */
    this.follow = true;
  }

  /** True when the cut is actually carving something this frame. */
  get active() {
    return this.enabled && this.mode !== CUT_OFF;
  }

  /** A fresh uniform group for one material, already carrying current state. */
  uniforms() {
    const u = {
      uCutMode: { value: CUT_OFF },
      uCutCenter: { value: new THREE.Vector3() },
      uCutNormal: { value: new THREE.Vector3(1, 0, 0) },
      uCutRadius: { value: this.radius },
      uCutFeather: { value: this.feather },
      uCutRim: { value: RIM_SRGB.clone() },
    };
    this.writeTo(u);
    return u;
  }

  /** Copy current state into one material's uniform group. */
  writeTo(u) {
    if (!u || !u.uCutMode) return;
    u.uCutMode.value = this.enabled ? this.mode : CUT_OFF;
    u.uCutCenter.value.copy(this.center);
    u.uCutNormal.value.copy(this.normal);
    u.uCutRadius.value = this.radius;
    u.uCutFeather.value = this.feather;
  }

  /** Point the section plane along a street.
   *
   * `deg` is a street bearing — degrees clockwise from north, the convention
   * the canyon table uses. The scene's frame is (east, up, -north), so a street
   * on bearing b runs along (sin b, 0, -cos b) and the plane that *contains* it
   * has normal (cos b, 0, sin b).
   *
   * Along the street rather than across it, because the seam has to land
   * somewhere and the roadway is the only place in Midtown where it can land
   * without slicing a tower in half. A cut through a building shows the inside
   * of Google's hollow mesh wherever our prism fails to fill it; a cut down an
   * avenue shows a kerb.
   */
  setBearing(deg) {
    const a = (deg * Math.PI) / 180;
    this.normal.set(Math.cos(a), 0, Math.sin(a)).normalize();
    this.bearing = deg;
  }

  /** Apply a patch and notify. Every field is optional. */
  set(patch) {
    if (!patch) return;
    if (patch.mode !== undefined) this.mode = patch.mode;
    if (patch.enabled !== undefined) this.enabled = !!patch.enabled;
    if (patch.radius !== undefined) this.radius = patch.radius;
    if (patch.feather !== undefined) this.feather = patch.feather;
    if (patch.follow !== undefined) this.follow = !!patch.follow;
    if (patch.bearing !== undefined) this.setBearing(patch.bearing);
    if (patch.center) this.center.set(patch.center.x, patch.center.y || 0, patch.center.z);
    this.onChange?.();
  }
}

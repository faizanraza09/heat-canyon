/* How the photoreal layer encodes the measurement.
 *
 * Everything here runs without a Google key and without a billable request. The
 * layer's shader patch and its lookup tables are both reachable by constructing
 * a Photoreal and calling into it directly — the constructor issues nothing, by
 * design — so the parts most likely to break silently can be tested for free.
 *
 * Two things are being protected.
 *
 * The first is that the shader compiles at all. It is assembled by string
 * substitution into three.js's own chunks, so a mistake in it is not a
 * type error or a failed assertion: it is a material that fails to link, and a
 * tileset that streams perfectly and draws nothing. The only visible symptom is
 * a console error from the shader compiler. A stray backtick inside a GLSL
 * comment took the whole file out once already.
 *
 * The second is the contract between the scene and the shader. The shader no
 * longer only asks "what colour is this cell" — it asks "how hot is it", so it
 * can decide whether to paint the surface at all, and it asks the same of a
 * whole building so it can mark a roof from the air. Both answers are packed
 * into texture alpha with zero reserved for "never solved", and both are
 * written by the scene from the ramp it drew the geometry with. If that packing
 * drifts the frame does not break, it quietly paints the wrong buildings.
 */

import { test, expect } from '@playwright/test';
import { openApp, settle } from './helpers.mjs';

/** Build a Photoreal against the live scene and patch one ordinary material.
 *
 * A MeshStandardMaterial stands in for a streamed glTF tile: it is the class
 * the tiles actually arrive as, and it runs through the same three.js chunk
 * chain, so it exercises every substitution the real thing does.
 */
async function patchProbe(page) {
  return page.evaluate(async () => {
    const THREE = await import('three');
    const { Photoreal } = await import('./js/photoreal.js');
    const s = window.HC.scene;
    if (s.data.ensureMassing) await s.data.ensureMassing();
    const w = s.data.meta.aoi.width_m, h = s.data.meta.aoi.height_m;
    const pr = new Photoreal({
      scene: s.scene, camera: s.camera, renderer: s.renderer,
      meta: s.data.meta, data: s.data, datumM: s.datumM,
      fieldTex: s.groundTex, fieldRect: { x0: -w / 2, y0: -h / 2, w, h },
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(60, 120, 60),
      new THREE.MeshStandardMaterial({ color: 0x999999 }));
    mesh.position.set(0, 60, 0);
    const root = new THREE.Group();
    root.add(mesh);
    pr._patchMaterials(root);
    s.scene.add(root);
    s.renderer.render(s.scene, s.camera);

    const gl = s.renderer.getContext();
    const props = s.renderer.properties.get(mesh.material);
    const cp = props.currentProgram;
    const prog = cp && cp.program;
    const uniforms = cp ? Object.keys(cp.getUniforms().map) : [];
    let frag = '';
    if (prog) {
      const srcs = gl.getAttachedShaders(prog).map((sh) => gl.getShaderSource(sh));
      frag = srcs.find((x) => !x.includes('gl_Position')) || '';
    }
    const out = {
      linked: prog ? !!gl.getProgramParameter(prog, gl.LINK_STATUS) : null,
      uniforms,
      // The three fixes, each identifiable in the compiled source.
      // The measurement is blended in as a colour, never multiplied by the
      // photograph's own baked luminance — which is the defect the additive
      // rewrite existed to remove and which survives the operator change.
      hasBlend: /mix\( c, glow \/ max\( wSum/.test(frag),
      hasLadder: /wFar|wMid|wNear/.test(frag),
      hasFootprintAzimuth: /prSolid\( cellF/.test(frag),
      // And the thing that must be gone.
      hasOldMultiply: /heat\.rgb \* shade/.test(frag),
    };
    s.scene.remove(root);
    pr.dispose();
    return out;
  });
}

test('the tile shader compiles, and carries all three encodings',
  async ({ page }) => {
    const billable = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('tile.googleapis.com') || u.includes('/v1/3dtiles')) billable.push(u);
    });
    const { errors } = await openApp(page);
    const out = await patchProbe(page);

    expect(out.linked, 'the patched material links').toBe(true);
    expect(errors, 'no shader compiler output on the console').toEqual([]);

    // Additive rather than multiplicative compositing.
    expect(out.hasBlend, 'the measurement is blended over the photograph').toBe(true);
    expect(out.hasOldMultiply, 'the ramp is no longer multiplied by baked luminance')
      .toBe(false);
    // The ladder, and the footprint-derived wall orientation.
    expect(out.hasLadder).toBe(true);
    expect(out.hasFootprintAzimuth).toBe(true);

    // The uniforms each of those depends on have to survive to the program.
    for (const u of ['uThreshold', 'uEyeHeight', 'uAgg', 'uHasGrid', 'uLut', 'uGrid']) {
      expect(out.uniforms, `uniform ${u} reaches the program`).toContain(u);
    }
    expect(billable, 'nothing billable was requested').toEqual([]);
  });

test('the lookup tables carry a value, not just a colour',
  async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
      const { Photoreal } = await import('./js/photoreal.js');
      const s = window.HC.scene;
      if (s.data.ensureMassing) await s.data.ensureMassing();
      const w = s.data.meta.aoi.width_m, h = s.data.meta.aoi.height_m;
      const pr = new Photoreal({
        scene: s.scene, camera: s.camera, renderer: s.renderer,
        meta: s.data.meta, data: s.data, datumM: s.datumM,
        fieldTex: s.groundTex, fieldRect: { x0: -w / 2, y0: -h / 2, w, h },
      });
      // Build the tables the way a first tile load would, then drive one real
      // repaint through them.
      pr.grid = pr._buildGrid();
      pr.params = pr._buildParams();
      pr.lut = pr._buildLut();
      pr.agg = pr._buildAgg();
      s.photoreal = pr;
      s.photorealOn = true;
      s._recolour();
      s.photorealOn = false;
      s.photoreal = null;

      const lut = pr.lut.image.data;
      let solved = 0, unsolved = 0, alphaMin = 255, alphaMax = 0;
      for (let i = 0; i < lut.length; i += 4) {
        const a = lut[i + 3];
        if (a === 0) { unsolved++; continue; }
        solved++;
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
      }
      const agg = pr.aggBuf;
      let bSolved = 0, bUnsolved = 0, aggMin = 255, aggMax = 0;
      for (let i = 0; i < agg.length; i += 4) {
        const a = agg[i + 3];
        if (a === 0) { bUnsolved++; continue; }
        bSolved++;
        if (a < aggMin) aggMin = a;
        if (a > aggMax) aggMax = a;
      }
      pr.dispose();
      return { solved, unsolved, alphaMin, alphaMax,
               bSolved, bUnsolved, aggMin, aggMax, nB: agg.length / 4 };
    });

    // Both kinds of cell have to exist, or the "zero means never solved"
    // reservation is untested by construction.
    expect(out.solved, 'cells a panel contributed to').toBeGreaterThan(1000);
    expect(out.unsolved, 'cells for orientations a building does not have')
      .toBeGreaterThan(1000);

    /* Alpha is a value, not a flag. The old table wrote 255 everywhere it had
     * data, so a threshold reading it would have found every solved surface
     * equally hot and painted the entire city — which is the failure this
     * packing exists to prevent. A real spread is the assertion. */
    expect(out.alphaMin).toBeGreaterThanOrEqual(1);
    expect(out.alphaMax).toBeLessThanOrEqual(255);
    expect(out.alphaMax - out.alphaMin, 'facade values span a real range')
      .toBeGreaterThan(60);

    // The per-building aggregate covers most of the city and spans a range too.
    expect(out.bSolved).toBeGreaterThan(out.nB * 0.5);
    expect(out.aggMax - out.aggMin, 'building peaks differ from each other')
      .toBeGreaterThan(40);
  });

test('the aggregate is each building\'s peak, never its mean',
  async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
      const { Photoreal } = await import('./js/photoreal.js');
      const s = window.HC.scene;
      if (s.data.ensureMassing) await s.data.ensureMassing();
      const w = s.data.meta.aoi.width_m, h = s.data.meta.aoi.height_m;
      const pr = new Photoreal({
        scene: s.scene, camera: s.camera, renderer: s.renderer,
        meta: s.data.meta, data: s.data, datumM: s.datumM,
        fieldTex: s.groundTex, fieldRect: { x0: -w / 2, y0: -h / 2, w, h },
      });
      pr.grid = pr._buildGrid();
      pr.params = pr._buildParams();
      pr.lut = pr._buildLut();
      pr.agg = pr._buildAgg();
      s.photoreal = pr;
      s.photorealOn = true;
      s._recolour();
      s.photorealOn = false;
      s.photoreal = null;

      /* For every building, the peak recorded in the aggregate must be at least
       * the largest per-cell mean in its own row of the facade table.
       *
       * At least, and usually more: a cell is the mean of every quad that fell
       * in it, while the aggregate is the maximum over those same quads before
       * any averaging. So the peak sits above the largest cell mean wherever a
       * cell mixes a hot band with a cooler one, which is most of them. Only
       * the inequality is a contract; the excess is the averaging showing
       * through, and is measured here rather than forbidden. */
      /* aggPeak holds the raw peak, on the same domain the facade table uses.
       * aggBuf's alpha holds that peak *after* the across-buildings contrast
       * stretch, which is a different scale by design — so the two halves of
       * this contract have to be checked against different things. */
      const lut = pr.lut.image.data;
      const wCells = pr.lutW;
      const agg = pr.aggBuf, peak = pr.aggPeak;
      let checked = 0, violations = 0, strictlyAbove = 0;
      const pairs = [];
      for (let b = 0; b < pr.lutH; b++) {
        if (agg[b * 4 + 3] === 0) continue;
        let rowMax = 0;
        for (let x = 0; x < wCells; x++) {
          const al = lut[((b * wCells) + x) * 4 + 3];
          if (al > rowMax) rowMax = al;
        }
        if (rowMax === 0) continue;
        checked++;
        // Raw peak against the hottest cell mean, both as 1 + 254t.
        const rawByte = 1 + Math.min(254, Math.round(peak[b] * 254));
        if (rawByte < rowMax - 1) violations++;
        if (rawByte > rowMax + 1) strictlyAbove++;
        pairs.push([peak[b], agg[b * 4 + 3]]);
      }

      // Does the stretch actually spend the ramp, and does it preserve order?
      pairs.sort((x, y) => x[0] - y[0]);
      let inversions = 0;
      for (let i = 1; i < pairs.length; i++) if (pairs[i][1] < pairs[i - 1][1]) inversions++;
      const alphas = pairs.map((x) => x[1]);
      const stretchedSpan = Math.max(...alphas) - Math.min(...alphas);
      const rawSpan = 254 * (pairs[pairs.length - 1][0] - pairs[0][0]);

      pr.dispose();
      return { checked, violations, strictlyAbove, inversions,
               stretchedSpan, rawSpan: Math.round(rawSpan) };
    });

    expect(out.checked).toBeGreaterThan(500);
    expect(out.violations, 'no building is marked cooler than its own hottest cell')
      .toBe(0);

    /* And the aggregate really is a peak rather than another average.
     *
     * If it were a mean it would sit *below* the largest cell mean on any
     * building whose flanks disagree — which is the failure worth guarding,
     * because a mean is precisely what hides the tower with one scorching west
     * face and three cool ones. Requiring that a good share of buildings come
     * out strictly above their hottest cell mean is the positive form of that
     * check: it can only happen if the maximum is taken before the averaging. */
    // Measured at about 19% of buildings; the rest have a hottest cell that
    // holds a single quad, or quads that agree, so peak and mean coincide there
    // legitimately. A tenth is a floor with real headroom under that.
    expect(out.strictlyAbove, 'peaks sit above cell means, so a max was taken first')
      .toBeGreaterThan(out.checked * 0.1);

    /* And the far regime's scale is the city's own, not the panel domain's.
     *
     * This is the assertion that would have caught the flat cream city: on the
     * peak hour every building's peak sits between 0.77 and 0.92 of the panel
     * domain, so an unstretched aggregate spends about a seventh of the ramp on
     * the whole of Midtown and every building comes out the same colour. The
     * stretch has to widen that materially while leaving the ranking alone. */
    expect(out.inversions, 'the stretch is monotonic, so it cannot reorder buildings')
      .toBe(0);
    expect(out.stretchedSpan, 'the stretched aggregate spends most of the ramp')
      .toBeGreaterThan(230);
    expect(out.stretchedSpan, 'and it is a real widening of the raw spread')
      .toBeGreaterThan(out.rawSpan * 1.5);
  });

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
      // The selection dissolve: the hash, and the discard it feeds.
      hasGhost: /uGhost < prHashThreshold/.test(frag),
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
    expect(out.hasGhost, 'the selection dissolve reaches the compiled shader').toBe(true);

    // The uniforms each of those depends on have to survive to the program.
    for (const u of ['uThreshold', 'uEyeHeight', 'uAgg', 'uHasGrid', 'uLut', 'uGrid',
                     'uGhost']) {
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
      /* aggPeak and aggBuf's alpha are now the SAME scale, and that is the
       * point: both are the raw position on the panel domain. They used to
       * differ, because the alpha carried an across-buildings contrast stretch.
       * See the assertion at the foot of this test for why that went. */
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

      // Is the published aggregate the raw value, unrescaled?
      pairs.sort((x, y) => x[0] - y[0]);
      let inversions = 0, drift = 0;
      for (let i = 1; i < pairs.length; i++) if (pairs[i][1] < pairs[i - 1][1]) inversions++;
      for (const [raw, alpha] of pairs) {
        const expected = 1 + Math.min(254, Math.round(raw * 254));
        drift = Math.max(drift, Math.abs(alpha - expected));
      }
      const alphas = pairs.map((x) => x[1]);
      const publishedSpan = Math.max(...alphas) - Math.min(...alphas);
      const rawSpan = 254 * (pairs[pairs.length - 1][0] - pairs[0][0]);

      pr.dispose();
      return { checked, violations, strictlyAbove, inversions, drift,
               publishedSpan, rawSpan: Math.round(rawSpan) };
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

    /* And the far regime is on the ABSOLUTE scale, not a rank within the city.
     *
     * This assertion is the reverse of the one it replaces, and the reversal is
     * the point. The aggregate used to be contrast-stretched across the city's
     * own 2nd-98th percentiles so the far view would discriminate at the peak
     * hour, where every building has some wall near the top of the domain and a
     * fixed scale renders them all the same deep orange.
     *
     * What that bought at one hour it lost at every other. A rank cannot be
     * compared with itself across time: on a February day the hottest wall in
     * Midtown is a few degrees, and the stretch painted it the same red as the
     * peak of a heat wave, with the tooltip beside it reading 5.4 degC. It also
     * disagreed with the facade field this same shader paints up close, which
     * is absolute — so one building changed colour as the camera flew toward
     * it.
     *
     * So the contract now is that the published alpha IS the raw position on
     * the panel domain, to within the rounding of a byte. The crowding at the
     * peak hour is real and is shown as what it is; separating buildings there
     * is the threshold slider's job. */
    expect(out.inversions, 'the aggregate is monotonic in the raw value').toBe(0);
    expect(out.drift, 'the published aggregate is the raw value, not a rescaling of it')
      .toBeLessThanOrEqual(1);
    expect(out.publishedSpan, 'so it spans exactly what the raw values span')
      .toBeLessThanOrEqual(Math.round(out.rawSpan) + 2);
  });

/* The dissolve survives the switch to the photograph.
 *
 * Selecting a building dims the rest of the city AND makes it see-through, and
 * only the first half comes across to this layer for free — the projected
 * colours are read out of the same repaint that drains them, while the
 * see-through half lives in a vertex attribute on geometry the photoreal view
 * does not draw. So the flag the shader reads has to be written by the scene on
 * every selection, and it is the kind of link that breaks silently: the layer
 * keeps working, the frame just stops answering the click.
 *
 * Checked against the texture the shader actually samples rather than against
 * an internal set, because the packing (third channel of the params row) is the
 * contract, and a set that is right while the texture is stale is the exact
 * failure this is for.
 */
test('a selection dissolves the photograph around it', async ({ page }) => {
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

    const flags = () => {
      const b = pr.paramsBuf;
      let solid = 0;
      for (let i = 0; i < b.length / 4; i++) if (b[i * 4 + 2] > 0.5) solid++;
      return solid;
    };
    const nB = pr.paramsBuf.length / 4;

    // A building with facades, so it is one the model actually solved.
    let target = -1;
    for (const [b, ps] of s.data.panelsOfBuilding) {
      if (ps && ps.length > 4) { target = b; break; }
    }
    const atRest = { solid: flags(), ghost: pr.ghost };

    s.select(target);
    const selected = { solid: flags(), ghost: pr.ghost,
                       subjectIsSolid: pr.paramsBuf[target * 4 + 2] > 0.5 };

    // A highlighted set is pointed at too, and must not dissolve with the rest.
    const set = new Set([target]);
    for (const [b, ps] of s.data.panelsOfBuilding) {
      if (b !== target && ps && ps.length > 4) { set.add(b); }
      if (set.size >= 4) break;
    }
    s.highlighted = set;
    s._recolour();
    const highlit = { solid: flags() };

    s.highlighted = null;
    s.select(null);
    const cleared = { solid: flags(), ghost: pr.ghost };

    s.photoreal = null;
    pr.dispose();
    return { nB, atRest, selected, highlit, cleared, target };
  });

  // Nothing selected: the photograph is whole, and the comparison in the shader
  // is one no fragment can fail.
  expect(out.atRest.ghost, 'no dissolve at rest').toBe(1);
  expect(out.atRest.solid, 'every building solid at rest').toBe(out.nB);

  // Selected: the subject stays, the city goes.
  expect(out.selected.ghost, 'the dissolve is switched on').toBeLessThan(1);
  expect(out.selected.ghost, 'and is see-through, not invisible').toBeGreaterThan(0.1);
  expect(out.selected.subjectIsSolid, 'the subject is what stays solid').toBe(true);
  expect(out.selected.solid, 'and it is the only thing that does').toBe(1);

  // A highlighted set is the subject as well — the same rule the massing view
  // applies, and the one the walkthrough depends on when it marks two towers.
  expect(out.highlit.solid, 'every highlighted building stays solid').toBe(4);

  // Deselecting puts the photograph back.
  expect(out.cleared.ghost).toBe(1);
  expect(out.cleared.solid).toBe(out.nB);
});

/* And the dissolve actually removes pixels.
 *
 * The test above checks the bookkeeping — the flag the scene writes and the
 * uniform it sets. Neither says the frame changed: a hashed discard is a
 * fragment-level decision, and every way it can fail quietly (a threshold that
 * clamps to zero, a comparison the wrong way round, a derivative that comes
 * back degenerate on a software rasteriser) leaves the flags perfect and the
 * city solid. So this one stands a fake tile inside a real building, renders it
 * off-screen, and counts.
 *
 * The count is the contract as well as the check. Alpha spent as a fraction of
 * pixels is what lets the subject be seen through two ghosted neighbours at
 * once — the fraction has to come out near PR_GHOST rather than merely be
 * nonzero, because a dissolve that keeps four fifths hides the subject and one
 * that keeps a twentieth erases the city.
 */
test('the dissolve spends alpha as pixels, on the surfaces it should',
  async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
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

      // The tallest well-solved building, so the fake tile stands well clear of
      // the two-metre sill the dissolve is gated on.
      let b = -1, bh = 0;
      s.data.buildings.attrs.forEach((a, i) => {
        const ps = s.data.panelsOfBuilding.get(i);
        if (ps && ps.length > 8 && a.h > bh) { bh = a.h; b = i; }
      });
      const ring = s.data.buildings.rings[b];
      let cx = 0, cy = 0;
      for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cy += ring[i + 1]; }
      cx /= ring.length / 2; cy /= ring.length / 2;
      const base = (s.data.buildings.attrs[b].base || 0) - s.datumM;

      // A box, patched exactly as a streamed tile is, standing half way up that
      // building's own column — which is what the shader probes to decide whose
      // surface it is looking at.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(8, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xbbbbbb }));
      box.position.set(cx, base + bh * 0.5, -cy);
      const root = new THREE.Group();
      root.add(box);
      pr._patchMaterials(root);
      const probe = new THREE.Scene();
      probe.add(root);
      probe.add(new THREE.AmbientLight(0xffffff, 2));
      const cam = new THREE.PerspectiveCamera(45, 1, 0.5, 500);
      cam.position.set(cx + 20, base + bh * 0.5 + 6, -cy + 20);
      cam.lookAt(box.position);

      const rt = new THREE.WebGLRenderTarget(256, 256);
      const buf = new Uint8Array(256 * 256 * 4);
      const clear = new THREE.Color();
      const cover = () => {
        const alpha = s.renderer.getClearAlpha();
        s.renderer.getClearColor(clear);
        s.renderer.setClearColor(0x000000, 1);
        s.renderer.setRenderTarget(rt);
        s.renderer.clear(true, true, true);
        s.renderer.render(probe, cam);
        s.renderer.readRenderTargetPixels(rt, 0, 0, 256, 256, buf);
        s.renderer.setRenderTarget(null);
        s.renderer.setClearColor(clear, alpha);
        let n = 0;
        for (let i = 0; i < buf.length; i += 4) {
          if (buf[i] + buf[i + 1] + buf[i + 2] > 30) n++;
        }
        return n;
      };

      const whole = cover();
      pr.setSubject(new Set([b]));
      const asSubject = cover();
      pr.setSubject(new Set([b === 0 ? 1 : 0]));
      const ghosted = cover();
      pr.setSubject(null);
      const back = cover();

      rt.dispose();
      pr.dispose();
      return { whole, asSubject, ghosted, back, ghost: pr.constructor === Photoreal ? 0.30 : 0 };
    });

    // The tile has to be drawing something in the first place, or every number
    // below is trivially satisfied.
    expect(out.whole, 'the unpatched-selection frame draws the tile').toBeGreaterThan(2000);

    // The subject keeps every pixel it had. Not "most": the guarantee the
    // massing view buys with a second draw is bought here by the subject never
    // being touched at all, and a subject that is even slightly stippled has
    // lost that.
    expect(out.asSubject, 'the subject is untouched').toBe(out.whole);

    // Everything else keeps about PR_GHOST of its pixels.
    const kept = out.ghosted / out.whole;
    expect(kept, 'a ghosted building is thinned, not erased').toBeGreaterThan(0.20);
    expect(kept, 'and thinned enough to see through').toBeLessThan(0.42);

    // And it all comes back. A dissolve that leaks is worse than no dissolve:
    // the city would be permanently stippled after one click.
    expect(out.back, 'deselecting restores the photograph').toBe(out.whole);
  });

/* The cut.
 *
 * Two representations of the same city, separated by a region rather than
 * blended into each other. The rationale is in web/js/cut.js; what is protected
 * here is the part that can silently break everything.
 *
 * The shader patch is the risk. Both the facade and the roof material get their
 * GLSL rewritten at construction, which means a malformed injection does not
 * break "the cut" — it breaks the entire application, with the photoreal layer
 * switched off and no Google key anywhere near it, because a material that
 * fails to compile takes the frame down with it. That failure surfaces only as
 * a console error from three's shader compiler, which no assertion about
 * geometry would ever catch. Hence a spec that opens the app and reads the
 * console before it looks at a single pixel.
 *
 * The second thing worth protecting is that the cut does nothing until it is
 * asked to. The prisms are the whole scene when the photoreal layer is off, so
 * a cut that engaged on its own would carve the city away and leave the clear
 * colour behind — a spectacular regression that a user with no API key would
 * hit on first load. So the default is asserted directly, and every test that
 * wants a live cut has to enable it by hand.
 *
 * Nothing here touches Google. The cut is exercised against our own geometry,
 * which is the side the shader patch lives on, so the whole spec costs nothing
 * and needs no key.
 */

import { test, expect } from '@playwright/test';
import { openApp, settle } from './helpers.mjs';

/** Fraction of the frame that is not the clear colour.
 *
 * Read with readPixels immediately after an explicit render, in the same task,
 * because the renderer is built without preserveDrawingBuffer — toDataURL and
 * a screenshot both come back empty or composited, and the difference between
 * "the city is gone" and "the capture was empty" is the entire point of the
 * measurement.
 */
async function inkFraction(page) {
  return page.evaluate(() => {
    const s = window.HC.scene;
    s.renderer.render(s.scene, s.camera);
    const gl = s.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // The shell is #0A0908 and the sky dome sits just off it, so the threshold
    // has to clear both: anything within a few levels of the clear colour is
    // background, anything past it is city.
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 24 || px[i + 1] > 22 || px[i + 2] > 20) ink++;
    }
    return ink / (w * h);
  });
}

/** Frame the whole study area, and leave nothing in it but the prisms.
 *
 * The cut acts on our facade and roof meshes and on nothing else — the ground,
 * the backdrop and the sky are deliberately never clipped, because with the
 * photoreal layer on the terrain is the one surface both representations stand
 * on and cutting it would put a step at every boundary. That is correct and it
 * makes them noise here: they cover most of the frame, so a measurement taken
 * over the whole picture reports the ground plane rather than the geometry
 * under test. A 220 m lens removed a third of the *city* and only a quarter of
 * the *frame*, which is a true statement about the wrong thing.
 *
 * Stripping them leaves ink that is the prisms and only the prisms.
 */
async function overview(page) {
  await page.evaluate(() => {
    const s = window.HC.scene;
    s.camera.position.set(0, 1600, 1900);
    s.camera.lookAt(0, 0, 0);
    s.camera.updateMatrixWorld();
    for (const m of [s.ground, s.backdrop, s.streets, s.sky]) if (m) m.visible = false;
  });
  await settle(page);
}

test('the shader patch compiles: the app opens clean with the cut in every material',
  async ({ page }) => {
    const { errors } = await openApp(page);
    // three reports a failed compile through console.error, and the frame after
    // it is blank rather than thrown. An empty error list is the assertion that
    // matters; the pixel check below is what proves the frame is real.
    expect(errors).toEqual([]);
    expect(await inkFraction(page)).toBeGreaterThan(0.05);
  });

test('does nothing until asked: no cut is live with the photoreal layer off',
  async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => window.HC.scene.cut.active)).toBe(false);

    await overview(page);
    const before = await inkFraction(page);

    // Choosing a mode is not the same as enabling one. With no photograph
    // underneath there is nothing for the cut to separate our geometry *from*,
    // so the mode is remembered and the frame is untouched.
    await page.evaluate(() => window.HC.scene.setCut({ mode: 1, radius: 300 }));
    await settle(page);
    expect(await page.evaluate(() => window.HC.scene.cut.active)).toBe(false);
    expect(await inkFraction(page)).toBeCloseTo(before, 2);
  });

test('the lens clips our geometry to a disc, and releasing it restores the city',
  async ({ page }) => {
    const { errors } = await openApp(page);
    await overview(page);
    const full = await inkFraction(page);
    expect(full).toBeGreaterThan(0.05);

    /* `enabled` is what the photoreal layer would set. Setting it directly is
     * the whole reason this spec costs nothing: the clip lives in our own
     * materials, so it can be proven without a tile ever being requested. */
    await page.evaluate(() => window.HC.scene.setCut({
      enabled: true, mode: 1, follow: false, radius: 220, center: { x: 0, y: 0, z: 0 },
    }));
    await settle(page);
    const lensed = await inkFraction(page);

    // A 220 m disc against a study area kilometres across: most of the city has
    // to be gone, and something has to be left.
    expect(lensed).toBeLessThan(full * 0.5);
    expect(lensed).toBeGreaterThan(0);

    // Widening it puts the city back, monotonically.
    await page.evaluate(() => window.HC.scene.setCut({ radius: 900 }));
    await settle(page);
    expect(await inkFraction(page)).toBeGreaterThan(lensed);

    await page.evaluate(() => window.HC.scene.setCut({ enabled: false }));
    await settle(page);
    expect(await inkFraction(page)).toBeCloseTo(full, 2);
    expect(errors).toEqual([]);
  });

test('the section keeps one side of the plane and drops the other',
  async ({ page }) => {
    await openApp(page);
    await overview(page);
    const full = await inkFraction(page);

    await page.evaluate(() => window.HC.scene.setCut({
      enabled: true, mode: 2, bearing: 0, center: { x: 0, y: 0, z: 0 },
    }));
    await settle(page);
    const half = await inkFraction(page);
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(0);

    // Flipping the plane end for end keeps the complementary half. The two do
    // not have to be equal — the camera is oblique and the city is not
    // symmetric — but together they have to account for the whole frame, which
    // is what proves the boundary is a plane and not a fade.
    await page.evaluate(() => window.HC.scene.setCut({ bearing: 180 }));
    await settle(page);
    const other = await inkFraction(page);
    expect(other).toBeGreaterThan(0);
    expect(half + other).toBeGreaterThan(full * 0.85);
  });

test('the alignment check suspends the cut rather than being clipped by it',
  async ({ page }) => {
    await openApp(page);

    // Both are conditions the scene applies to the same geometry, and the
    // alignment check exists to draw both representations on top of each other.
    // A cut left live underneath it would clip half the comparison away.
    await page.evaluate(() => {
      const s = window.HC.scene;
      s.photorealOn = true;                       // pretend the layer is on
      s.setCut({ enabled: true, mode: 1, radius: 300 });
      s.setShowSolids(true);
    });
    expect(await page.evaluate(() => window.HC.scene.cut.active)).toBe(false);
    // The chosen mode survives, so switching the check off brings it back.
    await page.evaluate(() => window.HC.scene.setShowSolids(false));
    expect(await page.evaluate(() => window.HC.scene.cut.active)).toBe(true);
    expect(await page.evaluate(() => window.HC.scene.cut.mode)).toBe(1);
  });

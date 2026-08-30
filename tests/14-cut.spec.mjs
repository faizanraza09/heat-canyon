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
 *
 * The default camera is used throughout and nothing is hidden. An earlier
 * version of this spec framed its own overview and switched off the ground, the
 * backdrop and the sky, on the reasoning that the cut acts on the prisms alone
 * and everything else is noise. It measured 100% ink in every condition and
 * reported the shader as dead when the shader was in fact working perfectly.
 * Measuring what the application actually draws, and subtracting an empty
 * frame taken the same way, is both simpler and honest about what it counts.
 */
async function inkFraction(page) {
  return page.evaluate(() => {
    const s = window.HC.scene;
    s.renderer.render(s.scene, s.camera);
    const gl = s.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // The shell is #0A0908, so anything within a few levels of it is
    // background and anything past it is something the scene drew.
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 24 || px[i + 1] > 22 || px[i + 2] > 20) ink++;
    }
    return ink / (w * h);
  });
}

const setCut = (page, patch) =>
  page.evaluate((p) => window.HC.scene.setCut(p), patch).then(() => settle(page));

/** Ink with every prism cut away: the ground, the backdrop and the sky, which
 *  the cut deliberately never touches. Subtracting it leaves the city alone. */
async function emptyFloor(page) {
  await setCut(page, { enabled: true, mode: 1, follow: false, radius: -1e9 });
  const floor = await inkFraction(page);
  await setCut(page, { enabled: false });
  return floor;
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
    const before = await inkFraction(page);

    // Choosing a mode is not the same as enabling one. With no photograph
    // underneath there is nothing for the cut to separate our geometry *from*,
    // so the mode is remembered and the frame is untouched.
    await setCut(page, { mode: 1, radius: 300 });
    expect(await page.evaluate(() => window.HC.scene.cut.active)).toBe(false);
    expect(await inkFraction(page)).toBeCloseTo(before, 3);
  });

test('the lens clips our geometry to a disc, and releasing it restores the city',
  async ({ page }) => {
    const { errors } = await openApp(page);
    const full = await inkFraction(page);
    const floor = await emptyFloor(page);
    const city = full - floor;
    expect(city).toBeGreaterThan(0.1);

    /* `enabled` is what the photoreal layer would set. Setting it directly is
     * the whole reason this spec costs nothing: the clip lives in our own
     * materials, so it can be proven without a tile ever being requested. */
    await setCut(page, {
      enabled: true, mode: 1, follow: false, radius: 220, center: { x: 0, y: 0, z: 0 },
    });
    const lensed = await inkFraction(page) - floor;

    // A 220 m disc against a study area two and a half kilometres across: all
    // but a few per cent of the city has to be gone, and something has to be
    // left standing inside the disc.
    expect(lensed).toBeLessThan(city * 0.2);
    expect(lensed).toBeGreaterThan(0);

    // Widening it puts the city back, monotonically.
    await setCut(page, { radius: 900 });
    const wider = await inkFraction(page) - floor;
    expect(wider).toBeGreaterThan(lensed);
    expect(wider).toBeLessThan(city);

    await setCut(page, { enabled: false });
    expect(await inkFraction(page)).toBeCloseTo(full, 3);
    expect(errors).toEqual([]);
  });

test('the section keeps one side of the plane and drops the other',
  async ({ page }) => {
    await openApp(page);
    const full = await inkFraction(page);
    const floor = await emptyFloor(page);
    const city = full - floor;

    await setCut(page, { enabled: true, mode: 2, bearing: 0, center: { x: 0, y: 0, z: 0 } });
    const half = await inkFraction(page) - floor;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(city);

    /* Flipping the plane end for end keeps the complementary half. The two do
     * not have to be equal — the camera is oblique and Midtown is not
     * symmetric about the origin — but together they have to account for the
     * whole city, which is what proves the boundary is a plane through the
     * scene rather than a fade or a global dimming. */
    await setCut(page, { bearing: 180 });
    const other = await inkFraction(page) - floor;
    expect(other).toBeGreaterThan(0);
    expect(half + other).toBeGreaterThan(city * 0.9);
  });

test('the alignment check suspends the cut rather than being clipped by it',
  async ({ page }) => {
    await openApp(page);

    // Both conditions act on the same geometry, and the alignment check exists
    // to draw our prisms and Google's mesh on top of each other so their
    // disagreement can be read directly. A cut left live underneath it would
    // clip half the comparison away.
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

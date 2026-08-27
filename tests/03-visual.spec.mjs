/* Visual tests.
 *
 * The other two suites assert on numbers in memory. These render the page and
 * inspect the pixels, because several of the worst bugs in this project were
 * invisible to data assertions and obvious the moment someone looked: corrupt
 * roof triangles that drew 3 km streaks across the city, a colour ramp that
 * clipped the whole afternoon to flat white, and a ground plane whose texture
 * aliased into bright stripes. All three produced perfectly valid arrays.
 *
 * Every test writes a PNG to tests/screenshots/ so the run leaves behind an
 * artefact a human can page through, and asserts on measurable image properties
 * rather than a golden-file hash — a hash would break on every GPU and tell you
 * nothing about what changed.
 */

import { test, expect } from '@playwright/test';
import { openApp, setHour, setLayer, settle } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = 'tests/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });

/** Only the 3D viewport, excluding the UI panels that frame it. */
const VIEWPORT_CLIP = { x: 430, y: 0, width: 1000, height: 1000 };

async function shoot(page, name, clip = VIEWPORT_CLIP) {
  const file = path.join(SHOTS, `${name}.png`);
  // Playwright rejects an explicit clip: null, so omit the key entirely when a
  // caller wants the whole page rather than just the 3D viewport.
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  return file;
}

/** Decode a PNG with the browser's own canvas and return pixel statistics. */
async function pixelStats(page, file) {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;

    let lit = 0, sumR = 0, sumG = 0, sumB = 0, n = 0, blown = 0;
    const hues = new Set();
    // Row-to-row luminance differences, used to detect horizontal striping.
    const rowMean = new Float64Array(c.height);
    for (let y = 0; y < c.height; y++) {
      let rs = 0;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = px[i], g = px[i + 1], bl = px[i + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        rs += lum;
        n++; sumR += r; sumG += g; sumB += bl;
        if (r > 26 || g > 28 || bl > 34) lit++;
        if (r > 250 && g > 250 && bl > 250) blown++;
        if (lum > 40) hues.add((r >> 4) + ',' + (g >> 4) + ',' + (bl >> 4));
      }
      rowMean[y] = rs / c.width;
    }
    return {
      width: c.width, height: c.height,
      litPct: +(100 * lit / n).toFixed(2),
      blownPct: +(100 * blown / n).toFixed(3),
      meanRGB: [Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)],
      distinctColours: hues.size,
    };
  }, b64);
}

test.describe('visual appearance', () => {
  test('default view renders a substantial, varied city', async ({ page }) => {
    const { errors } = await openApp(page);
    expect(errors).toEqual([]);
    const f = await shoot(page, '01-default-surface-15h');
    const s = await pixelStats(page, f);

    // The city must actually occupy the frame. A black viewport passed every
    // data assertion in an earlier build while drawing nothing at all.
    expect(s.litPct, 'share of viewport covered by geometry').toBeGreaterThan(20);
    // ...but not fill it entirely; sky and street shadow must survive.
    expect(s.litPct).toBeLessThan(96);
    // Rich colour variation, i.e. the ramp is being used rather than clipped.
    expect(s.distinctColours, 'distinct quantised colours').toBeGreaterThan(120);
    // Almost nothing may be blown out to pure white.
    expect(s.blownPct, 'share of pure-white pixels').toBeLessThan(0.6);
  });

  test('sun and shade layer is markedly less continuous than temperature', async ({ page }) => {
    await openApp(page);
    // 09:00 EDT: sun low in the east, so the lit/shaded split is at its clearest.
    await setHour(page, 2);

    await setLayer(page, 'Facade temperature');
    const cont = await pixelStats(page, await shoot(page, '02a-temperature-09h'));

    await setLayer(page, 'Sun and shade');
    const binary = await pixelStats(page, await shoot(page, '02b-sun-shade-09h'));

    // The sun layer assigns one of two colours per band, so it must render as a
    // markedly less continuous image than the temperature ramp at the same
    // hour. Asserted relatively, not against a fixed colour count: the per-panel
    // orientation shading baked into the vertex colours means even a two-valued
    // field legitimately produces a spread of rendered tones, and the ground
    // plane underneath stays continuous regardless.
    expect(binary.distinctColours).toBeLessThan(cont.distinctColours * 0.75);
    expect(binary.litPct).toBeGreaterThan(20);

    // Sunlit gold must actually be on screen: warmer than it is blue.
    expect(binary.meanRGB[0]).toBeGreaterThan(binary.meanRGB[2]);
  });

  test('night is visibly cooler-toned than mid-afternoon', async ({ page }) => {
    await openApp(page, { layer: 'Facade temperature' });
    await setHour(page, 0);                       // 03:00 EDT
    const nf = await shoot(page, '03-night-03h');
    const night = await pixelStats(page, nf);
    await setHour(page, 4);                       // 15:00 EDT
    const df = await shoot(page, '04-afternoon-15h');
    const day = await pixelStats(page, df);

    // On the inferno ramp, cool maps to dark purple and hot to bright yellow,
    // so the afternoon frame must be both brighter and much less blue-dominant.
    const warmth = (s) => s.meanRGB[0] - s.meanRGB[2];
    expect(warmth(day)).toBeGreaterThan(warmth(night));
    expect(day.meanRGB[1]).toBeGreaterThan(night.meanRGB[1]);
  });

  test('no long thin bright streaks across the scene', async ({ page }) => {
    // Guards the roof-index bug directly. Corrupt triangles drew near-straight
    // bright lines hundreds of pixels long over unrelated geometry, which no
    // array assertion noticed.
    await openApp(page, { layer: 'Facade temperature' });
    const f = await shoot(page, '05-streak-check');
    const b64 = fs.readFileSync(f).toString('base64');
    const streaks = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      const lum = (x, y) => {
        const i = (y * c.width + x) * 4;
        return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      };
      // A streak is a bright run on a row whose neighbours directly above and
      // below are dark: a one-to-two-pixel-tall bright line. Real building
      // edges are short; corrupt triangles produced runs spanning the frame.
      let worst = 0;
      for (let y = 2; y < c.height - 2; y++) {
        let run = 0;
        for (let x = 0; x < c.width; x++) {
          const here = lum(x, y);
          const above = lum(x, y - 2), below = lum(x, y + 2);
          if (here > 90 && above < 45 && below < 45) {
            run++;
            if (run > worst) worst = run;
          } else {
            run = 0;
          }
        }
      }
      return { longestThinBrightRun: worst, width: c.width };
    }, b64);

    // Allow for genuine thin highlights on distant rooflines, but nothing
    // remotely approaching a frame-spanning line.
    expect(streaks.longestThinBrightRun,
      'longest 1px-tall bright horizontal run (corrupt-geometry signature)')
      .toBeLessThan(streaks.width * 0.12);
  });

  test('measured exceedance layer has real spatial structure', async ({ page }) => {
    await openApp(page);
    await setLayer(page, 'Hours above');
    const f = await shoot(page, '06-exceedance');
    const s = await pixelStats(page, f);
    // If this layer were flat, the whole impact argument would rest on a
    // uniform field. It must show variation.
    expect(s.distinctColours).toBeGreaterThan(60);
  });

  test('street-level camera looks down a canyon, not into a wall', async ({ page }) => {
    await openApp(page, { layer: 'Facade temperature' });
    await page.click('#cam-street');
    await settle(page);
    await page.waitForTimeout(1200);
    const f = await shoot(page, '07-street-level');
    const s = await pixelStats(page, f);
    const cam = await page.evaluate(() => {
      const c = window.HC.scene.camera.position;
      return { y: c.y, mode: window.HC.scene.mode };
    });

    expect(cam.mode).toBe('street');
    // Eye height, not a helicopter.
    expect(cam.y).toBeLessThan(3);
    expect(cam.y).toBeGreaterThan(1);
    expect(s.litPct, 'facades should occupy much of the frame').toBeGreaterThan(30);

    // The assertion that actually matters, and the one the first version of
    // this test lacked. Seated against a wall, the frame is a single flat
    // facade filling every edge — which trivially satisfies "facades dominate"
    // while being a useless view. Looking *along* a canyon instead gives depth:
    // sky at the top of the frame, and receding walls that produce many more
    // distinct tones than one flat surface can.
    const composition = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      const band = (y0, y1) => {
        let dark = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (px[i] < 30 && px[i + 1] < 32 && px[i + 2] < 40) dark++;
            n++;
          }
        }
        return dark / n;
      };
      return { skyDarkFrac: band(0, Math.floor(c.height * 0.14)) };
    }, fs.readFileSync(f).toString('base64'));

    // Some sky must be visible above the rooflines.
    expect(composition.skyDarkFrac,
      'dark fraction in the top of the frame — sky above the canyon')
      .toBeGreaterThan(0.06);
    // And the view must have depth rather than being one flat surface.
    expect(s.distinctColours,
      'distinct tones — a single flat wall would give very few')
      .toBeGreaterThan(70);
  });

  test('selecting a building isolates it visually', async ({ page }) => {
    await openApp(page, { layer: 'Facade temperature' });
    const before = await pixelStats(page, await shoot(page, '08a-before-select'));
    await page.click('#side-body .rank >> nth=0');
    await settle(page);
    await page.waitForTimeout(1500);
    const after = await pixelStats(page, await shoot(page, '08b-after-select'));

    // Everything except the selected building desaturates, so the frame as a
    // whole must lose colour variety and brightness.
    expect(after.distinctColours).toBeLessThan(before.distinctColours);
    const sel = await page.evaluate(() => window.HC.scene.selected);
    expect(sel).not.toBeNull();
  });

  test('full-page composition at 1600x1000 has no layout overflow', async ({ page }) => {
    await openApp(page, { layer: 'Facade temperature' });
    await page.click('#side-body .rank >> nth=0');
    await settle(page);
    await page.waitForTimeout(1200);
    await shoot(page, '09-full-page-detail', null);

    const overflow = await page.evaluate(() => {
      const bad = [];
      for (const id of ['left', 'side', 'time']) {
        const el = document.getElementById(id);
        if (!el) { bad.push(`${id}: missing`); continue; }
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(`${id}: horizontal`);
        if (r.bottom > window.innerHeight + 1 || r.top < -1) bad.push(`${id}: vertical`);
        if (r.width < 40 || r.height < 20) bad.push(`${id}: collapsed`);
      }
      // Panels must not overlap each other. The first layout positioned the
      // left rail at a fixed top offset that assumed the masthead above it was
      // a particular height; once its text wrapped one more line the two
      // collided, and the camera row landed on the time scrubber.
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const hits = (a, b) => !(a.right <= b.left || b.right <= a.left
                            || a.bottom <= b.top || b.bottom <= a.top);
      const L = r('left'), S = r('side'), T = r('time');
      if (hits(L, S)) bad.push('left overlaps side');
      if (hits(L, T)) bad.push('left overlaps time');
      if (hits(S, T)) bad.push('side overlaps time');

      return {
        bad,
        bodyScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    expect(overflow.bad, overflow.bad.join('; ')).toEqual([]);
    expect(overflow.bodyScrollsX).toBe(false);
  });

  test('all eight hours render without error and each differs', async ({ page }) => {
    const { errors } = await openApp(page, { layer: 'Facade temperature' });
    const seen = [];
    for (let i = 0; i < 8; i++) {
      await setHour(page, i);
      await page.waitForTimeout(500);
      const f = await shoot(page, `10-hour-${String(i).padStart(2, '0')}`);
      seen.push(await pixelStats(page, f));
    }
    expect(errors, errors.join('\n')).toEqual([]);
    // No two hours may be pixel-identical: that would mean the time control is
    // not actually driving the field.
    const sigs = seen.map((s) => `${s.meanRGB.join(',')}|${s.distinctColours}`);
    expect(new Set(sigs).size, `signatures: ${sigs.join('  ')}`).toBe(8);
  });
});

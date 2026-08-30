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

    let lit = 0, sumR = 0, sumG = 0, sumB = 0, n = 0, blown = 0, gold = 0;
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
        // Distinctly warm pixels. Counting them is the direct way to ask whether
        // sunlit gold is on screen; the mean red-versus-blue is not, because on a
        // dark scene it is dominated by the shaded blue-grey and flips sign at a
        // lit fraction of about 13%. It read 53 against 54 and failed a scene that
        // was rendering perfectly well.
        if (r > bl + 30 && r > 60) gold++;
        if (lum > 40) hues.add((r >> 4) + ',' + (g >> 4) + ',' + (bl >> 4));
      }
      rowMean[y] = rs / c.width;
    }
    return {
      width: c.width, height: c.height,
      litPct: +(100 * lit / n).toFixed(2),
      blownPct: +(100 * blown / n).toFixed(3),
      meanRGB: [Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)],
      goldPct: +(100 * gold / n).toFixed(3),
      distinctColours: hues.size,
    };
  }, b64);
}

/** Statistics over just the pixels the data meshes drew.
 *
 * Whole-frame statistics stopped being statistics about the data once the sky
 * started carrying the hour: a third of the frame is now air, and it moves with
 * the clock. The mask is exact rather than heuristic — render the same frame
 * twice, once with the facade and roof meshes hidden, and keep the pixels that
 * changed — so it cannot drift as the palette does.
 *
 * It also returns two figures the plain pixel statistics do not:
 *
 *   `sat`, mean saturation. This is what separates a two-valued field from a
 *   ramp far more reliably than counting distinct colours does, because the
 *   per-panel orientation shading baked into the vertex colours gives even a
 *   two-valued field a spread of rendered tones.
 *
 *   `top8`, the share of pixels in the eight commonest colour buckets. A field
 *   that assigns one of two colours concentrates; a ramp does not.
 */
async function cityStats(page) {
  const shot = async () => (await page.screenshot({ clip: VIEWPORT_CLIP })).toString('base64');
  const show = async (on) => {
    await page.evaluate((v) => {
      const s = window.HC.scene;
      s.facadeMesh.visible = v; s.roofMesh.visible = v;
    }, on);
    await settle(page);
    await page.waitForTimeout(120);
  };
  await show(false);
  const bg = await shot();
  await show(true);
  const fg = await shot();

  return page.evaluate(async ([a, c]) => {
    const decode = async (d) => {
      const img = new Image();
      img.src = `data:image/png;base64,${d}`;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const x = cv.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, cv.width, cv.height).data;
    };
    const B = await decode(a), F = await decode(c);
    let n = 0, sr = 0, sg = 0, sb = 0, lum = 0, sat = 0;
    const hist = new Map();
    for (let i = 0; i < F.length; i += 4) {
      if (Math.abs(F[i] - B[i]) + Math.abs(F[i + 1] - B[i + 1])
          + Math.abs(F[i + 2] - B[i + 2]) < 12) continue;
      const r = F[i], g = F[i + 1], bl = F[i + 2];
      n++; sr += r; sg += g; sb += bl;
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      sat += mx ? (mx - mn) / mx : 0;
      const k = `${r >> 3},${g >> 3},${bl >> 3}`;
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const top = [...hist.values()].sort((x, y) => y - x);
    return {
      cityPct: +((100 * n) / (F.length / 4)).toFixed(1),
      meanRGB: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
      lum: +(lum / n).toFixed(1),
      sat: +(sat / n).toFixed(3),
      buckets: hist.size,
      top8: +((100 * top.slice(0, 8).reduce((x, y) => x + y, 0)) / n).toFixed(1),
    };
  }, [bg, fg]);
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

    /* The sun layer assigns one of two colours per band, so it must render as a
     * markedly less continuous image than the temperature ramp at the same
     * hour. Asserted relatively, not against a fixed colour count.
     *
     * It used to be asserted as a ratio of distinct quantised colours over the
     * whole frame, and that stopped working: the per-panel orientation shading
     * baked into the vertex colours gives even a two-valued field a spread of
     * rendered tones, the continuous ground plane is in both frames, and now so
     * is a sky that moves with the clock. The ratio sat at 0.85 against a
     * threshold of 0.75 — measuring the frame rather than the field.
     *
     * Saturation is the honest measure and a much wider one. The sun layer
     * paints two flat colours, one warm and one cool, whose mean is close to
     * grey; the ramp runs indigo through magenta to cream and stays saturated
     * most of the way. Measured over the pixels the data actually drew, the
     * separation is 0.18 against 0.49 — a factor of nearly three, where the
     * colour-count ratio was a few per cent.
     */
    const sunCity = await cityStats(page);          // the layer showing now
    await setLayer(page, 'Facade temperature');
    const tempCity = await cityStats(page);
    console.log('temperature', JSON.stringify(tempCity));
    console.log('sun/shade  ', JSON.stringify(sunCity));

    expect(sunCity.sat, 'a two-valued field averages toward grey')
      .toBeLessThan(tempCity.sat * 0.65);
    // And it concentrates: a larger share of its pixels lands in a handful of
    // colour buckets than a ramp's does.
    expect(sunCity.top8, 'a two-valued field concentrates into few colours')
      .toBeGreaterThan(tempCity.top8 * 1.12);
    expect(binary.litPct).toBeGreaterThan(20);

    // Sunlit gold must actually be on screen, counted rather than inferred from
    // the frame's mean colour. The mean is dominated by the shaded blue-grey that
    // most of a 9 a.m. Midtown facade set is in, so red-versus-blue flips sign
    // around a 13% lit fraction and says nothing about whether the gold rendered.
    // Measured: 11% of the frame at 09:00, against 38% on the temperature ramp.
    // The sun layer having LESS gold than the ramp is correct and was briefly
    // asserted the other way round: inferno is warm across most of its range while
    // the sun layer paints every shaded band cool blue-grey, and at nine in the
    // morning most of Midtown's facade set is shaded. The claim worth testing is
    // just that the gold rendered at all.
    expect(binary.goldPct).toBeGreaterThan(1.0);
  });

  test('night is visibly cooler-toned than mid-afternoon', async ({ page }) => {
    await openApp(page, { layer: 'Facade temperature' });
    await setHour(page, 0);                       // 03:00 EDT
    const nf = await shoot(page, '03-night-03h');
    const night = await pixelStats(page, nf);
    await setHour(page, 4);                       // 15:00 EDT
    const df = await shoot(page, '04-afternoon-15h');
    const day = await pixelStats(page, df);

    /* What "cooler-toned" means on the ramp this project actually uses.
     *
     * This asserted that the afternoon frame was less blue-dominant than the
     * night one, on the grounds that "on the inferno ramp, cool maps to dark
     * purple and hot to bright yellow". The ramp is no longer inferno: it runs
     * indigo through magenta to cream, and red-minus-blue is not monotonic
     * along it. Midtown's walls sit near 30 °C at three in the morning, which
     * lands in the ramp's *orange*, and near 50 °C at three in the afternoon,
     * which lands in its cream — so the night frame measures marginally the
     * warmer of the two by that metric, 35 against 33, and the test failed on
     * a description of a palette that had been replaced rather than on
     * anything about the rendering. Restoring the old sky reproduces the same
     * two numbers, which is how it was established that this was not the sky's
     * doing.
     *
     * What is true, and is what a viewer sees, is that the afternoon has
     * climbed the ramp: brighter, and desaturated toward the cream at the top
     * of it. Both are large, both are measured over the pixels the data drew.
     */
    const dayCity = await cityStats(page);          // the hour showing now
    await setHour(page, 0);
    const nightCity = await cityStats(page);
    console.log('night', JSON.stringify(nightCity));
    console.log('day  ', JSON.stringify(dayCity));

    /* All three of these read the opposite way round to how they once did, and
     * the reversal is the ramp's, not a regression.
     *
     * The heat ramp used to run near-black indigo up to a pale cream, so a hot
     * afternoon was the *brighter*, *less saturated* frame and the green channel
     * climbed with the heat. It now runs pale straw down to a deep red, because
     * an audience reads red as hot however faithful the blackbody order was. So
     * the hot hour is now the darker, more saturated one, and green falls as the
     * measurement rises rather than climbing with it.
     *
     * What is actually under test is unchanged and is the thing worth keeping:
     * that 03:00 and 15:00 render as visibly different frames on a fixed domain,
     * so the clock moves the picture. Only the direction of each difference is
     * restated. */
    expect(nightCity.lum, 'the cool hour sits at the pale end of the heat ramp')
      .toBeGreaterThan(dayCity.lum * 1.15);
    expect(dayCity.sat, 'and the hot hour at the saturated red end')
      .toBeGreaterThan(nightCity.sat * 1.05);
    // The green channel now carries most of the fall, because the ramp runs from
    // a straw that is rich in green to a red that has almost none.
    expect(night.meanRGB[1]).toBeGreaterThan(day.meanRGB[1]);
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

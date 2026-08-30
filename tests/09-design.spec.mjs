/* The design contract.
 *
 * Every other spec in this suite is about whether the model is right. This one is
 * about whether the interface is the one that was designed, and it exists because
 * the two failure modes are completely different: a physics regression shows up
 * as a wrong number, and a design regression shows up as nothing at all — a token
 * quietly reverting, a panel's third region losing its fold, a control keeping
 * its old label — until someone opens a screenshot and notices.
 *
 * So it asserts the things a redesign is *made of* rather than how it looks: the
 * palette actually in the cascade, the type roles, the three-region fold
 * contract with all four of its keys, the layout arithmetic that keeps the rail
 * clear of the panels, and the film's transport bar. Where a value comes
 * straight from the design it is written out here as a literal, so changing it
 * has to be deliberate.
 */

import { test, expect } from '@playwright/test';
import { openApp, setTab, settle } from './helpers.mjs';

/* Resolved custom properties, as the browser computes them. */
const tokens = (page, names) => page.evaluate((ns) => {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const n of ns) out[n] = cs.getPropertyValue(n).trim();
  return out;
}, names);

const styleOf = (page, sel, props) => page.evaluate(({ s, ps }) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const out = {};
  for (const p of ps) out[p] = cs.getPropertyValue(p).trim();
  return out;
}, { s: sel, ps: props });

/* ------------------------------------------------------------------ palette */

test('the palette is the designed one, and the old one is gone', async ({ page }) => {
  await openApp(page);

  const t = await tokens(page, ['--bg', '--accent', '--t0', '--t7', '--good', '--panel']);
  expect(t['--bg'].toLowerCase()).toBe('#0a0908');
  expect(t['--accent'].toLowerCase()).toBe('#d9542e');
  expect(t['--t0'].toLowerCase()).toBe('#f2ede4');
  expect(t['--t7'].toLowerCase()).toBe('#6b6259');
  expect(t['--good'].toLowerCase()).toBe('#7fa66a');
  expect(t['--panel']).toContain('13, 12, 11');

  // The shell is the warm near-black, not the cool blue-black it replaced.
  const body = await styleOf(page, 'body', ['background-color']);
  expect(body['background-color']).toBe('rgb(10, 9, 8)');

  const scene = await page.evaluate(async () => {
    const THREE = await import('three');
    const s = window.HC.scene;
    return {
      clear: s.renderer.getClearColor(new THREE.Color()).getHexString(),
      fog: s.scene.fog.color.getHexString(),
    };
  });
  /* Clear colour and fog must be the SAME colour, so there is no seam where a
   * panel's blur meets the model behind it. That is the invariant; the value is
   * not. Both used to be the shell's own #0A0908 and both were asserted as that
   * literal, which stopped being true when the sky started driving them — the
   * fog now takes the horizon of whatever hour is showing, at 30%, so it is a
   * warm grey at three in the afternoon and near-black at three in the morning.
   * See `_updateSky` in scene.js. Asserting they agree is what this test was
   * actually for. */
  expect(scene.clear).toBe(scene.fog);
});

test('one heat ramp carries every quantity, and it is the designed one', async ({ page }) => {
  await openApp(page);
  const ramp = await page.evaluate(async () => {
    const m = await import('/js/colors.js');
    const at = (name, t) => m.RAMPS[name](t).join(',');
    return {
      cold: at('temperature', 0),
      hot: at('temperature', 1),
      // Duration and priority share it: the design carries one legend, in one
      // place, and the viewer learns to read it once.
      sameDuration: at('duration', 0.45) === at('temperature', 0.45),
      samePriority: at('priority', 0.68) === at('temperature', 0.68),
      // The stops are uneven on purpose — the warm half is stretched, because
      // that is where the finding is.
      mid: at('temperature', 0.45),
      css: m.CANYON_CSS,
      // Read against TEMP_DOMAIN the ramp's landmarks fall on round numbers,
      // which is the whole reason the scale is fixed at −20..60 rather than at
      // whatever the loaded period happens to span.
      domain: m.TEMP_DOMAIN.join(','),
    };
  });
  // Cold is blue and hot is red, in that order. Both ends are deliberately the
  // same distance from the #0A0908 shell — 2.58:1 — so neither is the one that
  // disappears into it.
  expect(ramp.cold).toBe('44,82,145');
  expect(ramp.hot).toBe('163,26,34');
  // The hinge: a near-neutral pale, not a saturated green. A ramp that crosses
  // blue to red through green throws false edges wherever it passes the middle.
  expect(ramp.mid).toBe('192,207,212');
  expect(ramp.sameDuration).toBe(true);
  expect(ramp.samePriority).toBe(true);
  // The legend swatch is the authored stops, not a resampling of them.
  expect(ramp.css).toContain('rgb(186,205,214) 44%');
  expect(ramp.domain).toBe('-20,60');
});

/* --------------------------------------------------------------------- type */

test('type roles: serif for names, mono for figures, sans for prose', async ({ page }) => {
  await openApp(page);
  await page.click('#side-body .rank >> nth=0');
  await settle(page);

  const addr = await styleOf(page, '#selcard .addr', ['font-family', 'font-size']);
  expect(addr['font-family']).toContain('Instrument Serif');
  expect(addr['font-size']).toBe('26px');

  const value = await styleOf(page, '#selcard .sgrid .v', ['font-family', 'font-size']);
  expect(value['font-family']).toContain('IBM Plex Mono');
  expect(value['font-size']).toBe('15px');

  const label = await styleOf(page, '#selcard .sgrid .k', ['font-family', 'letter-spacing']);
  expect(label['font-family']).toContain('IBM Plex Mono');
  // Labels are letter-spaced; that is what separates them from figures.
  expect(parseFloat(label['letter-spacing'])).toBeGreaterThan(1);

  const prose = await styleOf(page, '.mdesc', ['font-family']);
  expect(prose['font-family']).toContain('Instrument Sans');

  // And the accent is never spent on a figure: it marks the active tab and the
  // selected row, nothing else.
  const tab = await styleOf(page, '#tabs button[aria-pressed="true"]', ['border-bottom-color']);
  expect(tab['border-bottom-color']).toBe('rgb(217, 84, 46)');
});

/* ------------------------------------------------------------------- layout */

test('three regions, and the rail is clear of both panels', async ({ page }) => {
  await openApp(page);
  const boxes = await page.evaluate(() => {
    const r = (id) => {
      const b = document.getElementById(id).getBoundingClientRect();
      return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) };
    };
    return { left: r('left'), side: r('side'), rail: r('time'), vw: innerWidth, vh: innerHeight };
  });

  // 24px inset on every edge the design gives one to.
  expect(boxes.left.l).toBe(24);
  expect(boxes.left.t).toBe(24);
  expect(boxes.side.r).toBe(boxes.vw - 24);
  // The ranking runs to the same 24px inset as everything else. It used to stop
  // 128px short, to clear a rail that spanned the full width; the rail is inset
  // between the panels now, so the reason for the gap went with it. What still
  // has to hold is the assertion below: the rail is clear of both panels.
  expect(boxes.side.b).toBe(boxes.vh - 24);

  // The rail sits in the gap, not under a panel — the whole reason its margins
  // are derived from the panel widths rather than hand-copied.
  expect(boxes.rail.l).toBeGreaterThanOrEqual(boxes.left.r);
  expect(boxes.rail.r).toBeLessThanOrEqual(boxes.side.l);
});

test('the panels are hairline-and-blur, not cards on a shadow', async ({ page }) => {
  await openApp(page);
  const pnl = await styleOf(page, '#left .pnl',
    ['border-top-width', 'border-radius', 'box-shadow', 'backdrop-filter']);
  expect(pnl['border-top-width']).toBe('1px');
  expect(pnl['border-radius']).toBe('4px');
  expect(pnl['box-shadow']).toBe('none');
  expect(pnl['backdrop-filter']).toContain('blur');
});

/* ------------------------------------------------------------- the controls */

test('the metric list is the designed row, unit and all', async ({ page }) => {
  await openApp(page);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#layers button')].map((b) => ({
    name: b.querySelector('span:first-child').textContent,
    unit: b.querySelector('.u').textContent,
    // The unit has to be *inside* the panel: `all: unset` drops box-sizing, and
    // with it the row overflowed and took the unit off the edge with it.
    inside: b.querySelector('.u').getBoundingClientRect().right
      <= document.getElementById('left').getBoundingClientRect().right,
    height: Math.round(b.getBoundingClientRect().height),
  })));

  /* Eight rows, and this list is meant to be edited by hand when a layer is
   * added or cut. That is the job of a design spec: a change to the instrument's
   * front door should have to be typed out somewhere a reviewer will read.
   *
   * It was thirteen. Four were cut as redundant — see the note above LAYERS in
   * ui.js for which and why — and one, "Where to act first", was split into a
   * heat-wave and an annual version that deliberately disagree. */
  expect(rows.map((r) => r.name)).toEqual([
    'Façade temperature', 'Sun and shade', 'Hours above 35 °C',
    'Where to act — heat wave',
    'Where to act — the year', 'Annual heat dose', 'Annual solar dose',
    'Winter sun share',
  ]);
  expect(rows.map((r) => r.unit)).toEqual(
    ['°C', '', 'h', 'score', 'score', 'K·h', 'kWh/m²', '']);
  for (const r of rows) {
    expect(r.inside, `"${r.name}" unit is outside the panel`).toBe(true);
    // 13px of padding either side of an 18px line: the design's 44px row.
    expect(r.height, `"${r.name}" row height`).toBeLessThanOrEqual(46);
  }
});

test('the ranking keeps its whole meta line and colours the score by the ramp',
  async ({ page }) => {
    await openApp(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#side-body .rank')]
      .slice(0, 12).map((r) => ({
        meta: r.querySelector('.m').textContent,
        // No elision: the number of homes behind the wall is half the reason the
        // row ranks where it does, so the line wraps rather than losing it.
        clipped: r.querySelector('.m').scrollWidth > r.querySelector('.m').clientWidth + 1,
        score: r.querySelector('.sc').textContent,
        colour: r.querySelector('.sc').style.color,
      })));
    expect(rows.length).toBeGreaterThan(8);
    for (const r of rows) {
      expect(r.clipped, `"${r.meta}" is being clipped`).toBe(false);
      expect(r.meta).toMatch(/homes|floors/);
      expect(r.colour, `row "${r.score}" has no ramp colour`).toMatch(/^rgb\(/);
    }
    /* A high score is further up the ramp than a low one.
     *
     * Measured as red minus blue rather than as total brightness. Brightness
     * was the right test while the ramp ended pale, and it is the wrong one on
     * a diverging ramp: the blue end and the red end have the same luminance by
     * construction, so a sum over the channels can order them either way round
     * or not at all. Red minus blue runs −101 at the cold end through +20 at
     * the hinge to +129 at the hot end, monotonically, which is the property
     * this assertion actually wants. */
    const top = rows[0].colour.match(/\d+/g).map(Number);
    const bottom = rows[rows.length - 1].colour.match(/\d+/g).map(Number);
    expect(top[0] - top[2]).toBeGreaterThan(bottom[0] - bottom[2]);
  });

test('picking a building opens a card on the left and keeps the ranking',
  async ({ page }) => {
    await openApp(page);
    const before = await page.locator('#side-body .rank').count();

    await page.click('#side-body .rank >> nth=2');
    await settle(page);

    // The ranking is untouched, with the row marked.
    expect(await page.locator('#side-body .rank').count()).toBe(before);
    await expect(page.locator('#side-body .rank').nth(2)).toHaveClass(/on/);
    await expect(page.locator('#side-title')).toHaveText('WHERE TO ACT FIRST');

    // Six figures, in the design's order.
    const keys = await page.evaluate(() =>
      [...document.querySelectorAll('#selcard .sgrid .k')].slice(0, 6).map((k) => k.textContent));
    expect(keys).toEqual(['FLOORS', 'HEIGHT', 'BUILT', 'HOMES', 'PEAK FAÇADE', 'HOURS ABOVE 35']);

    // The deep detail is behind one disclosure, so the controls below the card
    // stay reachable. The metric list must still be on screen.
    await expect(page.locator('#selcard .selmore')).toBeHidden();
    const reachable = await page.evaluate(() => {
      const p = document.getElementById('left').getBoundingClientRect();
      const m = document.querySelector('#layers button').getBoundingClientRect();
      return m.top < p.bottom;
    });
    expect(reachable, 'the metric list was pushed off the panel').toBe(true);

    await page.click('#selcard .more');
    await expect(page.locator('#selcard .selmore')).toBeVisible();
    // Two charts now — the monthly bars and the vertical height profile — so this
    // has to name one rather than resolving to both and failing strict mode.
    await expect(page.locator('#selcard .selmore .chart').first()).toBeVisible();

    // And the model marks it: dimmed neighbours plus a pin over the roof.
    const pin = await page.evaluate(() => {
      const p = window.HC.scene.pin;
      return { visible: p.visible, y: Math.round(p.position.y) };
    });
    expect(pin.visible).toBe(true);
    expect(pin.y).toBeGreaterThan(0);
  });

/* ------------------------------------------------------------------ the day */

test('the rail carries the clock, the hours and the sun line', async ({ page }) => {
  await openApp(page);
  const hours = await page.evaluate(() =>
    [...document.querySelectorAll('#hours button')].map((b) => b.textContent));
  expect(hours).toEqual(['03', '06', '09', '12', '15', '18', '21', '00']);

  /* The clock, the air, the sun. The zone suffix and the word BEARING both went
   * from this line — it reads "2026-07-02 15:00 · AIR 38.7 °C · SUN 53.9° · AZ
   * 252.4° · BEAM 743 W/m²" now. The date carries the day and the hour chips
   * carry the zone, so repeating EDT on every readout was three characters
   * spent saying what nothing else in the interface contradicts. */
  const line = await page.locator('#time-meta').textContent();
  expect(line).toMatch(/\d{4}-\d{2}-\d{2}\s+\d{2}:00/);
  expect(line).toMatch(/AIR/);
  expect(line).toMatch(/SUN/);
  expect(line).toMatch(/AZ/);

  // Space runs the day, and the arrows walk it.
  await page.keyboard.press('ArrowRight');
  await settle(page);
  expect(await page.evaluate(() => window.HC.ui.hour)).toBe(5);
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  expect(await page.evaluate(() => window.HC.ui.hour)).toBe(4);
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.HC.ui.playing)).toBe(true);
  await page.keyboard.press(' ');
  expect(await page.evaluate(() => window.HC.ui.playing)).toBe(false);
});

/* ------------------------------------------------------- the printed keys */

test('the key legend in the panel is the contract the app actually keeps',
  async ({ page }) => {
    await openApp(page);
    const printed = (await page.locator('#cam-hint').textContent()).replace(/\s+/g, ' ');
    // Everything the panel promises has a test somewhere in this suite; this
    // asserts the promise itself is still on screen, because a keyboard
    // interface nobody can see is one nobody uses.
    for (const claim of ['DRAG TO PAN', 'SCROLL TO ZOOM', 'CLICK TO INSPECT',
                         'SPACE PLAYS THE DAY', 'THE HOUR', 'THE PANELS',
                         'H CLEARS THE VIEW']) {
      expect(printed, `the panel no longer says "${claim}"`).toContain(claim);
    }
  });

test('RESET VIEW puts the camera back where it started', async ({ page }) => {
  await openApp(page);
  const home = await page.evaluate(() => {
    const c = window.HC.scene.camera.position;
    return [Math.round(c.x), Math.round(c.y), Math.round(c.z)];
  });
  expect(home).toEqual([-1500, 1250, 1750]);

  await page.mouse.move(800, 500);
  await page.mouse.down();
  await page.mouse.move(500, 300, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  const moved = await page.evaluate(() => {
    const c = window.HC.scene.camera.position;
    return [Math.round(c.x), Math.round(c.y), Math.round(c.z)];
  });
  expect(moved).not.toEqual(home);

  await page.click('#cam-reset');
  await settle(page);
  const back = await page.evaluate(() => {
    const c = window.HC.scene.camera.position;
    return [Math.round(c.x), Math.round(c.y), Math.round(c.z)];
  });
  expect(back).toEqual(home);
});

/* -------------------------------------------------------------- what if */

test('What if ends on the wall temperature the intervention actually buys',
  async ({ page }) => {
    await openApp(page);
    // What if is a pane inside the Decide tab; it used to be a tab of its own.
    await setTab(page, 'decide');

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#tab-decide tbody tr')].map((r) => r.cells[0].textContent));
    expect(rows).toEqual(['Cool roofs', 'Cool pavement', 'Street trees',
                          'Façade shading', 'Everything at once']);

    const baseline = await page.locator('.peak .v').textContent();
    await expect(page.locator('.peak .d')).toHaveText('baseline');

    // Cool roofs on a deep canyon cools the facing wall, and the figure has to
    // come from the pipeline's own re-solve rather than being recomputed here.
    await page.click('#tab-whatif tbody tr >> nth=0');
    await settle(page);
    const cooled = await page.locator('.peak .v').textContent();
    expect(cooled).not.toBe(baseline);
    await expect(page.locator('.peak .d')).toContainText('K vs today');
    const expected = await page.evaluate(() => {
      const ui = window.HC.ui;
      const site = window.HC.data.scenarios.sites[ui.scenarioSite];
      const target = window.HC.data.meta.hours[ui.hour].edt;
      let row = site.hours[0];
      for (const r of site.hours) {
        if (Math.abs(r.hour_edt - target) < Math.abs(row.hour_edt - target)) row = r;
      }
      return row.results.find((r) => r.key === 'cool_roof').abs.facade.toFixed(1);
    });
    expect(cooled).toContain(expected);

    // Cool pavement makes the wall hotter, which is the point of re-solving.
    await page.click('#tab-whatif tbody tr >> nth=1');
    await settle(page);
    await expect(page.locator('.peak .d')).toContainText('+');

    await page.click('.peak .link');
    await settle(page);
    await expect(page.locator('.peak .d')).toHaveText('baseline');
  });

/* ------------------------------------------------------------------ hover */

test('hovering a wall reads out its own temperature', async ({ page }) => {
  await openApp(page);

  // Which pixels are over a building depends on the default camera, so this
  // walks a coarse grid of the middle of the frame until something is under the
  // cursor rather than betting on one point.
  let hover = null;
  for (const [x, y] of [[800, 620], [760, 660], [860, 580], [700, 700],
                        [900, 660], [820, 540], [660, 620], [940, 600]]) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(180);
    await page.mouse.move(x + 3, y + 3);
    await page.waitForTimeout(220);
    const h = await page.evaluate(() => {
      const n = document.getElementById('hover');
      return { shown: getComputedStyle(n).display !== 'none', text: n.textContent };
    });
    if (h.shown) { hover = h; break; }
  }

  expect(hover, 'nothing in the middle of the frame was hoverable').not.toBeNull();
  expect(hover.text).toMatch(/WALL|ROOF/);
  // A wall names its aspect, its height and its temperature; a roof names its
  // height. Either way the readout is the panel's own figure, not a label.
  expect(hover.text).toMatch(/\d/);
});

/* ------------------------------------------------------------------- film */

test('the film runs under a real transport bar', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  await page.goto('/?intro=1&tour=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => { const b = document.querySelector('#film-begin'); return b && !b.disabled; },
    null, { timeout: 150_000 });

  // The runtime is on the button, so choosing to watch is an informed choice,
  // and it is the film's own length rather than a number typed in the markup.
  const label = await page.locator('#film-begin').textContent();
  expect(label).toMatch(/Watch the film.*\d+:\d\d/);
  const total = await page.evaluate(() => Math.round(window.HC.film.total));
  const shown = label.match(/(\d+):(\d\d)/);
  expect(Number(shown[1]) * 60 + Number(shown[2])).toBe(total);

  await page.click('#film-begin');
  await page.waitForTimeout(1500);

  // Five segments, each sized by its own chapter's length.
  const segs = await page.evaluate(() => [...document.querySelectorAll('#film-segs .seg')]
    .map((s) => ({ label: s.querySelector('.n').textContent, w: Math.round(s.getBoundingClientRect().width) })));
  expect(segs.map((s) => s.label)).toEqual(['I', 'II', 'III', 'IV', 'V']);
  expect(new Set(segs.map((s) => s.w)).size).toBeGreaterThan(1);

  // The clock runs, chapter stepping seeks, and pause holds.
  await expect(page.locator('#film-time')).toContainText('/');
  await page.click('#film-next');
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.HC.film._chapterIndexAt(window.HC.film.t))).toBe(1);
  await page.click('#film-prev');
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.HC.film._chapterIndexAt(window.HC.film.t))).toBe(0);

  await page.click('#film-play');
  const held = await page.evaluate(() => window.HC.film.t);
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.HC.film.t)).toBeCloseTo(held, 1);
  await page.click('#film-play');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.HC.film.t)).toBeGreaterThan(held);

  // The caption is the film's voice: serif, set left, not a centred subtitle.
  const cap = await styleOf(page, '#film-caption', ['font-family', 'text-align']);
  expect(cap['font-family']).toContain('Instrument Serif');
  expect(cap['text-align']).toBe('start');

  await page.click('#film-skip');
  await page.waitForTimeout(1200);
  await expect(page.locator('#film')).toHaveCount(0);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

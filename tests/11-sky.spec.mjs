/* The sky.
 *
 * It used to be a fixed near-black gradient. That was not merely flat, it was
 * wrong about the only thing the sky in this application is for: the model's
 * subject is how much sky a wall can see and where the sun is standing when it
 * heats it, and yet noon and midnight rendered identically, and walking into a
 * canyon and looking up gave a black slot at every hour of the year.
 *
 * So these tests are not about whether it looks nice. They ask whether the sky
 * is telling the truth — whether the sun is where the hour says it is, whether
 * it goes out when the sun sets, and whether the sun the sky draws is the same
 * sun the pipeline ray-traced its shadows with. The last of those is the one
 * that matters: a beautiful sky with the sun on the wrong side of the street
 * would quietly contradict every temperature in the panel beside it.
 */

import { test, expect } from '@playwright/test';
import { openApp, setHour, settle } from './helpers.mjs';

/** Point the camera exactly along the sun direction and read the centre pixel.
 *
 * Reading the framebuffer rather than a uniform is the point: it is the only
 * way to find out what was actually drawn, and the first version of this sky
 * failed exactly here — every colour it was handed rendered at about half the
 * brightness it was specified at, because a hand-written ShaderMaterial gets
 * no output colour-space conversion unless it asks for one.
 */
const lookAtSun = (page, hour) => page.evaluate((h) => {
  const s = window.HC.scene;
  s.setHour(h);
  const d = s.sky.material.uniforms.sunDir.value;
  s.setView(null, { animate: false });
  s.camera.position.set(0, 900, 0);
  s.controls.target.set(d.x * 3000, 900 + d.y * 3000, d.z * 3000);
  s.camera.up.set(0, 1, 0);
  s.camera.lookAt(s.controls.target);
  s.renderer.render(s.scene, s.camera);

  const gl = s.renderer.getContext();
  const el = s.renderer.domElement;
  const px = new Uint8Array(4);
  gl.readPixels(Math.floor(el.width / 2), Math.floor(el.height / 2),
    1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const meta = window.HC.data.meta.hours[h];
  return {
    edt: meta.edt, alt: meta.sun_alt, az: meta.sun_az, cloud: meta.cloud,
    sun: [+d.x.toFixed(4), +d.y.toFixed(4), +d.z.toFixed(4)],
    centre: [px[0], px[1], px[2]],
    lum: 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2],
  };
}, hour);

test('the sun is drawn where the hour says it is, and only when it is up', async ({ page }) => {
  const { errors } = await openApp(page);
  const n = await page.evaluate(() => window.HC.data.meta.hours.length);
  const rows = [];
  for (let h = 0; h < n; h++) rows.push(await lookAtSun(page, h));

  for (const r of rows) {
    // The direction the sky points at must be the hour's own solar geometry,
    // in the same east-north-up frame everything else in this scene uses:
    // x = east, z = -north, so a compass bearing maps to (sin, ·, -cos).
    const a = (r.alt * Math.PI) / 180, z = (r.az * Math.PI) / 180;
    expect(r.sun[0], `${r.edt}h east component`).toBeCloseTo(Math.cos(a) * Math.sin(z), 3);
    expect(r.sun[1], `${r.edt}h altitude`).toBeCloseTo(Math.sin(a), 3);
    expect(r.sun[2], `${r.edt}h north component`).toBeCloseTo(-Math.cos(a) * Math.cos(z), 3);

    console.log(`${String(r.edt).padStart(2, '0')}:00  alt ${String(r.alt).padStart(6)}°`
      + `  az ${String(r.az).padStart(6)}°  cloud ${r.cloud}  centre ${r.centre}`);
    if (r.alt > 3) {
      // Looking straight at it, the disc must be there and must be bright.
      expect(r.lum, `the sun should be visible at ${r.edt}h`).toBeGreaterThan(150);
    } else if (r.alt < -3) {
      // And gone once it has set — a disc hanging in a night sky would be a
      // decoration rather than a reading.
      expect(r.lum, `no sun below the horizon at ${r.edt}h`).toBeLessThan(45);
    }
  }
  expect(errors).toEqual([]);
});

test('the sky the viewer sees is the sun the physics used', async ({ page }) => {
  /* The cross-check that makes the rest of it mean something.
   *
   * The pipeline ray-traced which facade bands are in direct sun, hours before
   * this scene existed and without reference to it. If the sky's sun agrees
   * with that field, the two are the same sun; if it does not, the render is
   * quietly contradicting the numbers printed beside it, and a viewer standing
   * in a canyon watching the disc cross the slot would be watching a lie.
   */
  await openApp(page);
  const r = await page.evaluate(() => {
    const d = window.HC.data, s = window.HC.scene;
    const out = [];
    for (let h = 0; h < d.meta.hours.length; h++) {
      const meta = d.meta.hours[h];
      if (meta.sun_alt < 10) continue;          // no meaningful beam near the horizon
      s.setHour(h);
      let facingLit = 0, facingN = 0, awayLit = 0, awayN = 0;
      // Sample the upper bands, which see the most sky and are least confused
      // by the canyon geometry that is the whole point of the model.
      const band = d.facades.bands - 1;
      for (let p = 0; p < d.facades.n; p += 3) {
        let delta = Math.abs(((d.facades.az[p] - meta.sun_az + 540) % 360) - 180);
        const lit = d.sunlitAt(h, p, band) ? 1 : 0;
        if (delta < 45) { facingN++; facingLit += lit; }
        else if (delta > 135) { awayN++; awayLit += lit; }
      }
      out.push({
        edt: meta.edt, az: meta.sun_az, alt: meta.sun_alt,
        facing: facingN ? facingLit / facingN : 0,
        away: awayN ? awayLit / awayN : 0,
        facingN, awayN,
      });
    }
    return out;
  });

  expect(r.length, 'the day must contain some daylight hours').toBeGreaterThan(2);
  for (const h of r) {
    console.log(`${String(h.edt).padStart(2, '0')}:00 az ${h.az}°  walls facing the sun `
      + `${(100 * h.facing).toFixed(0)}% lit (n=${h.facingN}),  walls facing away `
      + `${(100 * h.away).toFixed(0)}% lit (n=${h.awayN})`);
    // A wall turned toward the sky's sun must be far more likely to be in the
    // shadow field's sun than one turned away from it. If the azimuth
    // convention were mirrored — the easiest possible mistake to make with a
    // compass bearing in a y-up scene, and one this project has made before —
    // these two numbers would swap.
    expect(h.facing, `${h.edt}h: walls facing the sun should be lit`)
      .toBeGreaterThan(h.away + 0.25);
  }
});

test('every hour of the day has its own sky', async ({ page }) => {
  await openApp(page);
  const sigs = await page.evaluate(() => {
    const s = window.HC.scene;
    const u = s.sky.material.uniforms;
    const out = [];
    for (let h = 0; h < window.HC.data.meta.hours.length; h++) {
      s.setHour(h);
      out.push([u.zenith.value.getHexString(), u.horizon.value.getHexString(),
        +u.discGain.value.toFixed(2)].join('/'));
    }
    return out;
  });
  console.log(sigs.join('\n'));
  // Eight hours, eight skies. The old fixture produced one signature repeated
  // eight times and no test noticed, because nothing was asking.
  expect(new Set(sigs).size, `signatures: ${sigs.join('  ')}`).toBe(sigs.length);
});

test('the horizon has no seam where the ground ends', async ({ page }) => {
  await openApp(page);
  // Below the horizon the sky is the fog colour, which is also what the
  // backdrop plane has faded to by its own far edge. Getting this wrong drew a
  // hard black band across the horizon at every daylight hour, and it is
  // invisible in any assertion about geometry.
  const v = await page.evaluate(() => {
    const s = window.HC.scene;
    return {
      below: s.sky.material.uniforms.below.value.getHexString(),
      fog: s.scene.fog.color.getHexString(),
    };
  });
  expect(v.below).toBe(v.fog);
});

test('a night sky is dark and a noon sky is not', async ({ page }) => {
  await openApp(page);
  const read = (h) => page.evaluate((hh) => {
    const s = window.HC.scene;
    s.setHour(hh);
    s.setView(null, { animate: false });
    // Level, facing north, so the frame is mostly sky.
    s.camera.position.set(0, 400, 0);
    s.controls.target.set(0, 700, -2000);
    s.camera.lookAt(s.controls.target);
    s.renderer.render(s.scene, s.camera);
    const gl = s.renderer.getContext(), el = s.renderer.domElement;
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(el.width / 2), Math.floor(el.height * 0.75),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
  }, h);

  const hours = await page.evaluate(() => window.HC.data.meta.hours.map((x) => x.sun_alt));
  const night = hours.indexOf(Math.min(...hours));
  const noon = hours.indexOf(Math.max(...hours));
  const lNight = await read(night);
  const lNoon = await read(noon);
  console.log('sky luminance: night', lNight.toFixed(1), ' noon', lNoon.toFixed(1));
  expect(lNoon, 'daylight must actually be lighter').toBeGreaterThan(lNight * 3);
  expect(lNight, 'and night must stay dark').toBeLessThan(40);
});

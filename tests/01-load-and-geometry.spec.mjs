/* Loading, and the structural integrity of the generated geometry.
 *
 * The geometry assertions here are not decoration. A bug in this project's first
 * build had THREE.ShapeUtils.triangulateShape silently mutate the contour array
 * it was given, which desynchronised the roof vertex cursor and produced
 * triangles with 3 km edges stitched between unrelated buildings. Nothing threw,
 * the page looked plausible, and it was only visible as odd streaks. These tests
 * encode the invariants that make that class of bug impossible to reintroduce
 * unnoticed.
 */

import { test, expect } from '@playwright/test';
import { openApp, facadeColorStats } from './helpers.mjs';

test('boots with no page errors or failed requests', async ({ page }) => {
  const { errors, failedRequests } = await openApp(page);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
  expect(failedRequests, `failed requests:\n${failedRequests.join('\n')}`).toEqual([]);
  await expect(page.locator('#boot')).toHaveCount(0);
});

test('data arrays are internally consistent', async ({ page }) => {
  await openApp(page);
  const d = await page.evaluate(() => {
    const { data } = window.HC;
    return {
      buildings: data.buildings.n,
      ringCount: data.buildings.rings.length,
      attrCount: data.buildings.attrs.length,
      panels: data.facades.n,
      bands: data.facades.bands,
      hours: data.meta.hours.length,
      thermal: data.thermal.length,
      air: data.air.length,
      sigma: data.airSigma.length,
      sunlitBytes: data.sunlit.length,
      xy: data.facades.xy.length,
      azLen: data.facades.az.length,
      baseLen: data.facades.base.length,
      topLen: data.facades.top.length,
    };
  });

  expect(d.ringCount).toBe(d.buildings);
  expect(d.attrCount).toBe(d.buildings);
  // Every panel needs exactly one temperature per band per hour.
  expect(d.thermal).toBe(d.panels * d.bands * d.hours);
  expect(d.air).toBe(d.thermal);
  expect(d.sigma).toBe(d.thermal);
  // Sunlit is a bit per cell, packed to bytes.
  expect(d.sunlitBytes).toBe(Math.ceil(d.thermal / 8));
  // Four coordinates per panel: two endpoints.
  expect(d.xy).toBe(d.panels * 4);
  expect(d.azLen).toBe(d.panels);
  expect(d.baseLen).toBe(d.panels);
  expect(d.topLen).toBe(d.panels);
});

test('facade mesh has one quad per panel-band and no stray geometry', async ({ page }) => {
  await openApp(page);
  const g = await page.evaluate(() => {
    const s = window.HC.scene, d = window.HC.data;
    const geo = s.facadeMesh.geometry;
    geo.computeBoundingBox();
    const expectedQuads = d.facades.n * d.facades.bands;
    return {
      expectedQuads,
      quads: s.nQuad,
      verts: geo.getAttribute('position').count,
      indices: geo.index.count,
      box: {
        min: geo.boundingBox.min.toArray(),
        max: geo.boundingBox.max.toArray(),
      },
      aoiW: d.meta.aoi.width_m,
      aoiH: d.meta.aoi.height_m,
      tallest: Math.max(...d.buildings.attrs.map((a) => a.h)),
    };
  });

  expect(g.quads).toBe(g.expectedQuads);
  expect(g.verts).toBe(g.expectedQuads * 4);
  expect(g.indices).toBe(g.expectedQuads * 6);

  // Nothing may sit below the datum, and nothing above the tallest building.
  expect(g.box.min[1]).toBeGreaterThanOrEqual(-0.01);
  expect(g.box.max[1]).toBeLessThanOrEqual(g.tallest + 1);

  // Horizontal extent must stay inside the padded study area. The pipeline pads
  // the footprint query beyond the AOI so boundary streets have both walls, so
  // allow that margin but not more.
  const padX = g.aoiW / 2 + 400, padY = g.aoiH / 2 + 400;
  expect(Math.abs(g.box.min[0])).toBeLessThan(padX);
  expect(Math.abs(g.box.max[0])).toBeLessThan(padX);
  expect(Math.abs(g.box.min[2])).toBeLessThan(padY);
  expect(Math.abs(g.box.max[2])).toBeLessThan(padY);
});

test('roof triangles are flat and confined to their own building', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(() => {
    const s = window.HC.scene;
    const geo = s.roofMesh.geometry;
    const pos = geo.getAttribute('position'), idx = geo.index;
    let maxEdge = 0, maxYSpan = 0, crossBuilding = 0;
    const P = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (let t = 0; t < idx.count; t += 3) {
      const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
      const A = P(i0), B = P(i1), C = P(i2);
      maxEdge = Math.max(maxEdge, dist(A, B), dist(B, C), dist(C, A));
      maxYSpan = Math.max(maxYSpan,
        Math.abs(A[1] - B[1]), Math.abs(B[1] - C[1]), Math.abs(C[1] - A[1]));
      const b0 = s.roofVertBuilding[i0];
      if (s.roofVertBuilding[i1] !== b0 || s.roofVertBuilding[i2] !== b0) crossBuilding++;
    }
    return { triangles: idx.count / 3, maxEdge: +maxEdge.toFixed(1), maxYSpan: +maxYSpan.toFixed(3), crossBuilding };
  });

  expect(r.triangles).toBeGreaterThan(10_000);
  // A roof is horizontal by construction. Any height span means the triangle
  // has stitched vertices from buildings of different heights together.
  expect(r.maxYSpan).toBeLessThan(0.01);
  // No triangle may join vertices belonging to two different footprints.
  expect(r.crossBuilding).toBe(0);
  // No Manhattan footprint is 400 m across; this catches city-spanning slivers.
  expect(r.maxEdge).toBeLessThan(400);
});

test('every facade quad is finite and non-degenerate', async ({ page }) => {
  await openApp(page);
  const q = await page.evaluate(() => {
    const s = window.HC.scene;
    const pos = s.facadeMesh.geometry.getAttribute('position');
    let nonFinite = 0, zeroArea = 0, tooWide = 0;
    for (let v = 0; v < pos.count; v += 4) {
      const x0 = pos.getX(v), y0 = pos.getY(v), z0 = pos.getZ(v);
      const x1 = pos.getX(v + 1), y1 = pos.getY(v + 1), z1 = pos.getZ(v + 1);
      const y2 = pos.getY(v + 2);
      if (![x0, y0, z0, x1, y1, z1, y2].every(Number.isFinite)) { nonFinite++; continue; }
      const w = Math.hypot(x1 - x0, z1 - z0);
      const h = Math.abs(y2 - y0);
      if (w < 0.01 || h < 0.001) zeroArea++;
      if (w > 45) tooWide++;   // the pipeline splits panels at 40 m
    }
    return { quads: pos.count / 4, nonFinite, zeroArea, tooWide };
  });
  expect(q.nonFinite).toBe(0);
  expect(q.zeroArea).toBe(0);
  expect(q.tooWide).toBe(0);
});

test('facade colours are varied rather than saturated flat', async ({ page }) => {
  await openApp(page, { layer: 'Facade surface temperature' });
  const c = await facadeColorStats(page);
  // A flat or clipped field is the failure this guards against: the first build
  // mapped the whole afternoon into the top of the ramp and read as one colour.
  expect(c.distinct).toBeGreaterThan(150);
  expect(c.max - c.min).toBeGreaterThan(0.25);
  expect(c.mean).toBeGreaterThan(0.05);
  expect(c.mean).toBeLessThan(0.97);
});

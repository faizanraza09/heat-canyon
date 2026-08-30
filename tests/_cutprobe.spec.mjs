import { test } from '@playwright/test';
import { openApp, settle } from './helpers.mjs';

const ink = (page) => page.evaluate(() => {
  const s = window.HC.scene;
  s.renderer.render(s.scene, s.camera);
  const gl = s.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 24 || px[i+1] > 22 || px[i+2] > 20) n++;
  }
  const at = (fx, fy) => { const x = (fx*w)|0, y = (fy*h)|0, o = (y*w+x)*4;
    return [px[o], px[o+1], px[o+2], px[o+3]]; };
  return { ink: n / (w*h), topL: at(0.02,0.97), topR: at(0.97,0.97), mid: at(0.5,0.5),
           vis: { fac: s.facadeMesh?.visible, roof: s.roofMesh?.visible },
           u: (() => { const q = s.facadeMesh.material.userData.cutUniforms;
                 return q ? [q.uCutMode.value, q.uCutRadius.value,
                             q.uCutCenter.value.toArray()] : 'none'; })(),
           prog: (() => { const pr = s.renderer.properties.get(s.facadeMesh.material);
                 const keys = pr?.currentProgram ? Object.keys(pr.currentProgram.getUniforms().map) : [];
                 return { hasCut: keys.includes('uCutMode'),
                          sameObj: pr?.uniforms?.uCutMode === s.facadeMesh.material.userData.cutUniforms.uCutMode,
                          n: keys.length }; })(),
           nMats: s._cutMats.length, cam: [s.camera.position.x|0, s.camera.position.y|0, s.camera.position.z|0],
           tgt: [s.controls.target.x|0, s.controls.target.y|0, s.controls.target.z|0] };
});

test('probe', async ({ page }) => {
  await openApp(page);
  console.log('initial', await ink(page));
  await page.evaluate(() => {
    const s = window.HC.scene;
    s.controls.target.set(0,0,0);
    s.camera.position.set(0, 1600, 1900);
    s.controls.update();
    for (const m of [s.ground, s.backdrop, s.streets, s.sky]) if (m) m.visible = false;
  });
  await settle(page);
  console.log('overview+strip', await ink(page));
  await page.evaluate(() => window.HC.scene.setCut({ enabled:true, mode:1, follow:false, radius:220, center:{x:0,y:0,z:0} }));
  await settle(page);
  console.log('lens220', await ink(page));
  await page.evaluate(() => window.HC.scene.setCut({ radius: 900 }));
  await settle(page);
  console.log('lens900', await ink(page));
  await page.evaluate(() => window.HC.scene.setCut({ enabled:false }));
  await settle(page);
  console.log('off', await ink(page));
});

/* Wiring. */

import { load, domain } from './data.js';
import { Scene } from './scene.js';
import { UI, boot, bootDone } from './ui.js';

async function start() {
  let data;
  try {
    data = await load((p, label) => boot(p * 0.85, label));
  } catch (e) {
    boot(1, `failed: ${e.message}`);
    document.getElementById('boot-msg').style.color = '#e8674f';
    return;
  }

  boot(0.9, 'building geometry');
  await new Promise((r) => setTimeout(r, 30));

  const canvas = document.getElementById('gl');
  const scene = new Scene(canvas, data);

  // One colour scale for the whole day, so the ramp means the same thing at
  // 03:00 as at 15:00 and playing the day reads as the city changing rather
  // than the legend rescaling underneath it.
  //
  // The percentiles are wide on purpose. A 1-99 window came out at 28-45 degC,
  // but peak-hour surfaces sit at 40-45, which crushed the entire hour of
  // interest into the top third of the ramp and clipped the hottest 3% to flat
  // white — the sunlit walls that are the whole point. Going out to 99.8
  // captures the real daily range (about 28-50 degC) and puts mid-afternoon in
  // the middle of the ramp, where there is contrast to spend.
  scene.setDomains({
    surface: domain(data.thermal, 0.5, 99.8),
    air: domain(data.air, 0.5, 99.5),
  });

  boot(0.97, 'ready');
  const ui = new UI(data, scene);

  scene.onPick = (hit) => {
    if (!hit) { ui.showList(); return; }
    const a = data.buildings.attrs[hit.building];
    const idx = data.ranked.items.findIndex((it) => String(it.bin) === String(a?.bin));
    if (idx >= 0) ui.showDetail(idx);
  };

  let last = performance.now();
  const loop = (t) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    scene.tick(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Debug handle. Exposed deliberately: this is a visualisation whose output is
  // geometry, and being able to poke at the scene graph from the console is how
  // you find out why something looks wrong.
  window.HC = { data, scene, ui };

  bootDone();
  console.log('HeatCanyon ready', {
    buildings: data.buildings.n,
    panels: data.facades.n,
    quads: scene.nQuad,
    hours: data.meta.hours.length,
  });
}

start();

import { test } from '@playwright/test';
test.setTimeout(420_000);
test('linear audit', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  await page.goto('/?intro=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const b = document.getElementById('film-begin'); return b && !b.disabled; }, null, { timeout: 150_000 });
  await page.click('#film-begin');
  const rows = []; const seen = new Set();
  while (true) {
    const st = await page.evaluate(() => {
      const f = window.HC.film; if (!f || !f.running) return null;
      const s = window.HC.scene, cap = document.getElementById('film-caption');
      const bd = document.getElementById('brief-doc'), as = document.getElementById('agent-scroll');
      const b = f.story.beats[f.beatIndex] || {};
      return { i: f.beatIndex, u: (f.t - b.t0) / b.dur,
        cap: cap && !cap.hidden ? cap.textContent.trim() : '',
        want: b.text || '', dist: Math.round(s.camera.position.distanceTo(s.controls.target)),
        hour: s.hour, layer: s.layer, sel: window.HC.ui.selected,
        brief: document.getElementById('brief')?.hidden ? null : Math.round(bd?.scrollTop || 0),
        agent: document.getElementById('analyst')?.hidden ? null : Math.round(as?.scrollTop || 0),
        pf: !document.getElementById('pf')?.hidden };
    });
    if (!st) break;
    if (st.i >= 0 && !seen.has(st.i) && st.u > 0.55) {
      seen.add(st.i);
      rows.push(`${String(st.i).padStart(2)} ${st.cap === st.want ? 'SYNC' : 'DESYNC'} dist=${String(st.dist).padStart(5)} hr=${String(st.hour).padStart(2)} ${String(st.layer).padEnd(16)} sel=${String(st.sel).padStart(4)} brief=${String(st.brief).padStart(5)} agent=${String(st.agent).padStart(5)} pf=${st.pf ? 'Y' : 'n'}  ${st.cap.slice(0, 46)}`);
      await page.screenshot({ path: `tests/_film/L${String(st.i).padStart(2, '0')}.png` });
    }
    await page.waitForTimeout(300);
  }
  console.log(rows.join('\n'));
  console.log('ERRORS ' + (errs.join('\n') || '(none)'));
});

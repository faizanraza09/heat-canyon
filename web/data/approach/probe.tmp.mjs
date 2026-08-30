import { chromium } from '@playwright/test';
const b = await chromium.launch({ args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1440,height:810} });
p.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0,400)));
await p.goto('http://127.0.0.1:8000/?intro=1&tour=0', { waitUntil:'load' });
await p.waitForFunction(()=>window.HC?.film && !document.getElementById('film-begin').disabled, null, {timeout:180000});
await p.click('#film-begin');
await p.evaluate(()=>{ window.HC.film._seek(0); window.HC.film._setPaused(true); });
await p.waitForFunction(()=>window.HC.film.patches?.length >= 5, null, {timeout:120000});
for (const t of process.argv.slice(2).map(Number)) {
  await p.evaluate((tt)=>{ window.HC.film._seek(tt); window.HC.film._setPaused(true); }, t);
  await p.waitForTimeout(700);
  const st = await p.evaluate(()=>({ alt:+window.HC.film.stage.alt.toFixed(2), canv:document.getElementById('film-gl')?.style.opacity }));
  console.log(t, JSON.stringify(st));
  await p.screenshot({ path:`/tmp/f${String(t*10|0).padStart(4,'0')}.png` });
}
await b.close();

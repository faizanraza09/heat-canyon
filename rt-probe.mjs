import { chromium } from '@playwright/test';
const b = await chromium.launch({ args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errs.push('c:'+m.text().slice(0,140));});
await p.goto('http://127.0.0.1:8000',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(38000);
// press Begin
const clicked = await p.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /begin|watch|play/i.test(x.textContent||''));
  if (b) { b.click(); return b.textContent.trim().slice(0,30); } return null;
});
await p.waitForTimeout(9000);
const o = await p.evaluate(() => {
  const f = window.HC.film;
  return { clicked: true, running: f.running, acState: f.ac?.state ?? 'no ac',
    master: f.master ? +f.master.gain.value.toFixed(3) : 'none',
    nodes: f.nodes?.length ?? 0, total: f.total };
});
console.log('begin button:', clicked);
console.log(JSON.stringify(o,null,1));
console.log(errs.length ? 'ERRORS:\n  '+errs.slice(0,4).join('\n  ') : 'no page errors');
await b.close();

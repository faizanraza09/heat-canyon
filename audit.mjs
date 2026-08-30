import { chromium } from '@playwright/test';
const b = await chromium.launch({ args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:8000',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.HC?.film?.story, null, {timeout:150000});
await p.waitForTimeout(6000);
await p.evaluate(()=>{const x=[...document.querySelectorAll('button')].find(y=>/walkthrough|begin|watch/i.test(y.textContent||'')); x&&x.click();});
await p.waitForTimeout(3000);
const n = await p.evaluate(()=>window.HC.film.story.beats.length);
const rows=[];
for (let i=0;i<n;i++){
  const info = await p.evaluate(async (idx)=>{
    const f=window.HC.film, b=f.story.beats[idx];
    f._seek(b.t0 + b.dur*0.75);            // three-quarters in: cues have fired
    return new Promise(r=>setTimeout(()=>{
      const vis=(sel)=>{const el=document.querySelector(sel); if(!el) return null;
        const r2=el.getBoundingClientRect(); return (r2.width>2&&r2.height>2&&!el.closest('[hidden]'))?r2:null;};
      // which full-screen surface is up
      let surface='city';
      if (vis('#brief-doc')) surface='brief';
      else if (vis('#pf-body')) surface='portfolio';
      else if (vis('#agent-scroll')) surface='analyst';
      // what is at the top of that surface's scroller
      let showing='';
      const box=document.querySelector('#brief-doc,#pf-body,#agent-scroll');
      if (box && surface!=='city'){
        const bt=box.getBoundingClientRect().top;
        let best=null,bd=1e9;
        box.querySelectorAll('h1,h2,h3,.brf-h,.pfsec,.pf-h,section').forEach(el=>{
          const d=Math.abs(el.getBoundingClientRect().top-bt);
          if(d<bd){bd=d;best=el;}});
        showing=(best?.className||'')+' | '+((best?.textContent||'').trim().slice(0,44));
      }
      const spotEl=document.getElementById('film-spot');
      r({ i:idx, ch:b.chapter, text:(b.text||'').slice(0,96),
          spot:f._spot||null, spotShown: spotEl? !spotEl.hidden : false,
          surface, showing });
    }, 900));
  }, i);
  rows.push(info);
}
for (const r of rows){
  console.log(`\n#${String(r.i).padStart(2)} ${r.ch}  [${r.surface}]`);
  console.log(`   SAY : ${r.text}`);
  console.log(`   SPOT: ${r.spot||'(none)'}${r.spot?(r.spotShown?'  [visible]':'  [HIDDEN]'):''}`);
  if (r.showing) console.log(`   SHOW: ${r.showing}`);
}
await b.close();

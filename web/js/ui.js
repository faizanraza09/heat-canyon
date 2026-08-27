/* All the panels. Kept apart from the 3D scene so the visual language and the
 * rendering can be reasoned about separately.
 *
 * A rule this file follows throughout: every number carries a MEASURED or
 * MODELLED tag, and the two never share a colour. The project's honest claim is
 * that the vertical dimension is an estimate, and an interface that blurred that
 * would undo the claim no matter what the README said. */

import { RAMPS, css, gradient, norm } from './colors.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const f1 = (v) => (isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v) => (isFinite(v) ? v.toFixed(2) : '—');
const f0 = (v) => (isFinite(v) ? Math.round(v).toLocaleString() : '—');

/* ------------------------------------------------------------------ layers */

export const LAYERS = [
  {
    key: 'surface', name: 'Facade surface temperature', unit: '°C',
    kind: 'modelled', ramp: 'temperature',
    caption: 'Surface temperature of every facade band, from a coupled energy balance. '
           + 'This is where the real variation is — a sunlit wall runs far hotter than '
           + 'the air beside it.',
  },
  {
    key: 'air', name: 'Air temperature', unit: '°C',
    kind: 'mixed', ramp: 'temperature',
    caption: 'Measured by FortyGuard at 2 m, extended upward by similarity theory. '
           + 'The vertical gradient is small — under 1 K per 100 m — and its uncertainty '
           + 'exceeds it above about 50 m. Shown because that honesty matters.',
  },
  {
    key: 'sun', name: 'Direct sun / shade', unit: '',
    kind: 'modelled', ramp: 'temperature',
    caption: 'Which facade bands the sun actually reaches this hour, ray-traced through '
           + 'the real 3D scene. The band of light climbing a facade as the afternoon '
           + 'goes on is the mechanism behind everything else here.',
  },
  {
    key: 'exceedance', name: 'Hours above 35 °C', unit: 'h',
    kind: 'measured', ramp: 'duration',
    caption: 'Total hours each 60 m cell spent above 35 °C across the seven-day heat wave. '
           + 'Duration, not peak, is what the epidemiology links to mortality — and it '
           + 'discriminates across this area far more sharply than the snapshot does.',
  },
  {
    key: 'persistence', name: 'Longest unbroken run', unit: 'h',
    kind: 'measured', ramp: 'duration',
    caption: 'The longest continuous stretch above 35 °C. A night that never drops below '
           + 'the threshold is what removes the recovery window.',
  },
  {
    key: 'priority', name: 'Intervention priority', unit: 'score',
    kind: 'derived', ramp: 'priority',
    caption: 'Exposure × vulnerability, as a geometric mean so a building must score on '
           + 'both. Click any building for the full decomposition.',
  },
];

const KIND_TAG = {
  measured: '<span class="tag m">measured</span>',
  modelled: '<span class="tag d">modelled</span>',
  mixed: '<span class="tag m">measured</span> <span class="tag d">extended</span>',
  derived: '<span class="tag d">derived</span>',
};

/* ------------------------------------------------------------------- boot */

export function boot(p, msg) {
  $('boot-bar').style.width = `${Math.round(p * 100)}%`;
  $('boot-msg').textContent = msg;
}
export function bootDone() {
  $('boot').classList.add('done');
  setTimeout(() => $('boot').remove(), 600);
}

/* --------------------------------------------------------------------- UI */

export class UI {
  constructor(data, scene) {
    this.d = data;
    this.scene = scene;
    this.layer = 'surface';
    this.hour = data.meta.peak_index;
    this.playing = false;
    this.scenarioSite = 0;

    this._head();
    this._layers();
    this._hours();
    this._cam();
    this._prov();
    this._scenarios();
    this._ai();
    this.showList();
    this.setLayer('surface');
    this._hoverLoop();
  }

  /* ------------------------------------------------------------- masthead */

  _head() {
    const m = this.d.meta;
    const spend = (m.spend?.calls || []).reduce((a, c) => a + (c.credits_delta || 0), 0);
    $('head-where').innerHTML = `
      <span>${m.aoi.label} · ${m.aoi.area_km2} km² · ${f0(m.counts.buildings_scored)} buildings</span>
      <span>${m.event.label}</span>
      <span>${f0(m.counts.facade_panels)} facade panels × ${m.bands} bands × ${m.hours.length} hours</span>
      <span>${f0(spend)} of 2,000,000 API credits spent</span>`;
  }

  /* --------------------------------------------------------------- layers */

  _layers() {
    const box = $('layers');
    box.innerHTML = '';
    for (const L of LAYERS) {
      const b = el('button', null,
        `<span class="k">${L.name}</span><span class="u">${L.unit}</span>`);
      b.setAttribute('aria-pressed', String(L.key === this.layer));
      b.onclick = () => this.setLayer(L.key);
      b.dataset.key = L.key;
      box.appendChild(b);
    }
  }

  setLayer(key) {
    this.layer = key;
    const L = LAYERS.find((x) => x.key === key);
    for (const b of $('layers').children) {
      b.setAttribute('aria-pressed', String(b.dataset.key === key));
    }
    this.scene.setLayer(key);
    this._legend(L);
  }

  _legend(L) {
    const d = this.d;
    let lo, hi, unit = L.unit;
    if (L.key === 'exceedance') { const s = d.tiles.stats.exceedance; lo = s.min; hi = s.max; }
    else if (L.key === 'persistence') { const s = d.tiles.stats.persistence; lo = s.min; hi = s.max; }
    else if (L.key === 'priority') { lo = 0; hi = 85; }
    else if (L.key === 'sun') { lo = 0; hi = 1; }
    else if (L.key === 'air') { [lo, hi] = this.scene.airDomain; }
    else { [lo, hi] = this.scene.surfaceDomain; }

    if (L.key === 'sun') {
      $('legend-ramp').style.background =
        'linear-gradient(90deg, rgb(46,54,70) 0%, rgb(46,54,70) 50%, rgb(252,200,90) 50%, rgb(252,200,90) 100%)';
      $('legend-ticks').innerHTML = '<span>shaded</span><span>direct sun</span>';
    } else {
      $('legend-ramp').style.background = gradient(L.ramp);
      const mid = (lo + hi) / 2;
      $('legend-ticks').innerHTML =
        `<span>${f1(lo)}${unit}</span><span>${f1(mid)}${unit}</span><span>${f1(hi)}${unit}</span>`;
    }
    let cap = `${KIND_TAG[L.kind]} ${L.caption}`;
    if (L.key === 'air' && this.scene.groundDomain) {
      const [glo, ghi] = this.scene.groundDomain;
      cap += ` <b style="color:var(--text-2)">The ground plane is contrast-stretched to
        this hour's own range (${f1(glo)}–${f1(ghi)} °C)</b> — across the whole area the
        measured field spans barely 1–3 K at any instant, so on the absolute scale it
        would be one flat colour. Absolute values are in the readout below and on hover.`;
    }
    $('legend-cap').innerHTML = cap;
  }

  /* ---------------------------------------------------------------- hours */

  _hours() {
    const box = $('hours');
    box.innerHTML = '';
    this.d.meta.hours.forEach((h, i) => {
      const b = el('button', null, `${String(h.edt).padStart(2, '0')}:00`);
      b.setAttribute('aria-pressed', String(i === this.hour));
      b.onclick = () => { this.stop(); this.setHour(i); };
      box.appendChild(b);
    });
    $('play').onclick = () => (this.playing ? this.stop() : this.play());
    this._timeMeta();
  }

  setHour(i) {
    this.hour = i;
    for (let k = 0; k < $('hours').children.length; k++) {
      $('hours').children[k].setAttribute('aria-pressed', String(k === i));
    }
    this.scene.setHour(i);
    this._timeMeta();
    if (this.selected !== undefined && this.selected !== null) this.showDetail(this.selected, true);
    const L = LAYERS.find((x) => x.key === this.layer);
    if (L) this._legend(L);
  }

  play() {
    this.playing = true;
    $('play').innerHTML = '&#10074;&#10074;';
    this._timer = setInterval(() => {
      this.setHour((this.hour + 1) % this.d.meta.hours.length);
    }, 1100);
  }
  stop() {
    this.playing = false;
    $('play').innerHTML = '&#9658;';
    clearInterval(this._timer);
  }

  _timeMeta() {
    const h = this.d.meta.hours[this.hour];
    $('time-meta').innerHTML = `
      <span><b>${String(h.edt).padStart(2, '0')}:00 EDT</b> (API hour ${String(h.gmt5).padStart(2, '0')}:00 GMT−5)</span>
      <span>air <b>${f1(h.t_anchor_c)} °C</b></span>
      <span>sun <b>${f1(h.sun_alt)}°</b> alt / <b>${f1(h.sun_az)}°</b> az</span>
      <span>beam <b>${f0(h.dni)}</b> W/m²</span>
      <span>cloud <b>${Math.round(h.cloud * 100)}%</b></span>
      <span>RH <b>${f0(h.rh)}%</b></span>
      <span>sky <b>${f1(h.sky_c)} °C</b></span>`;
  }

  /* ---------------------------------------------------------------- camera */

  _cam() {
    const o = $('cam-orbit'), s = $('cam-street');
    const set = (mode) => {
      o.setAttribute('aria-pressed', String(mode === 'orbit'));
      s.setAttribute('aria-pressed', String(mode === 'street'));
      $('cam-hint').textContent = mode === 'street'
        ? 'W A S D to walk · drag to look · Q E for height · Shift to run'
        : 'drag to orbit · scroll to zoom';
      this.scene.setMode(mode);
    };
    o.onclick = () => set('orbit');
    s.onclick = () => set('street');
  }

  /* ------------------------------------------------------------ provenance */

  _prov() {
    const box = $('prov');
    box.innerHTML = '';
    const m = this.d.meta;
    const groups = [
      ['FortyGuard Temperature API', m.provenance.filter((p) => p.source.startsWith('FortyGuard')), 'm'],
      ['Free public data', m.provenance.filter((p) => !p.source.startsWith('FortyGuard')), 'm'],
    ];
    for (const [title, rows, tag] of groups) {
      box.appendChild(el('div', 'small dim', `<b style="color:var(--text-2)">${title}</b>`));
      const ul = el('div', 'why');
      for (const p of rows) {
        ul.appendChild(el('li', tag === 'm' ? 'm' : 'd',
          `<b style="color:var(--text-2)">${p.source.replace('FortyGuard ', '')}</b> — ${p.provides}`));
      }
      box.appendChild(ul);
    }
    box.appendChild(el('div', 'note',
      `<b>What is modelled.</b> ${m.env_series.heat_index_caveat}`));
    box.appendChild(el('div', 'note warn',
      '<b>What nothing validates.</b> There is no public measured air temperature at '
      + 'height anywhere in Manhattan. The horizontal field can be checked against '
      + "NYC's 84 street-level sensors; the vertical extrapolation cannot be checked "
      + 'against anything, and its stated uncertainty grows to roughly 3 K by 150 m — '
      + 'larger than the gradient it is describing. Facade *surface* temperature, driven '
      + 'by exact solar geometry, is the field carrying real signal.'));
  }

  /* ------------------------------------------------------------- scenarios */

  _scenarios() {
    const S = this.d.scenarios;
    if (!S.sites?.length) { $('scenarios').innerHTML = '<p class="small dim">No scenario sites.</p>'; return; }
    const box = $('scenarios');
    const render = () => {
      const site = S.sites[this.scenarioSite];
      $('sc-site').textContent = `· ${site.name || site.label}`;
      // Pick the row closest to the current hour.
      let row = site.hours[0];
      for (const r of site.hours) {
        if (Math.abs(r.hour_edt - this.d.meta.hours[this.hour].edt)
            < Math.abs(row.hour_edt - this.d.meta.hours[this.hour].edt)) row = r;
      }
      box.innerHTML = '';
      const pick = el('div', 'seg');
      S.sites.forEach((s, i) => {
        const b = el('button', null,
          `<span class="k">${s.label}</span><span class="u">H/W ${f1(s.hw)}</span>`);
        b.setAttribute('aria-pressed', String(i === this.scenarioSite));
        b.onclick = () => { this.scenarioSite = i; render(); };
        pick.appendChild(b);
      });
      box.appendChild(pick);

      box.appendChild(el('div', 'small dim',
        `<span class="mono">${site.name}</span> · W ${f1(site.w)} m · SVF ${f2(site.svf)}
         · asymmetry ${f2(site.asym)} · trees now ${Math.round(site.trees_now * 100)}%
         · at ${row.hour_edt}:00 EDT`));

      const t = el('table', 'sctab');
      t.innerHTML = `<thead><tr><th>Intervention</th><th>roof</th><th>ground</th>
        <th>facade</th><th>MRT</th><th>air</th><th>WBGT</th></tr></thead>`;
      const tb = el('tbody');
      for (const r of row.results) {
        if (r.key === 'baseline') continue;
        const cell = (v) => {
          const c = v < -0.05 ? 'neg' : v > 0.05 ? 'pos' : 'zero';
          return `<td class="${c}">${v > 0 ? '+' : ''}${f1(v)}</td>`;
        };
        const tr = el('tr', null,
          `<td title="${(this.d.scenarios.catalogue.find((c) => c.key === r.key) || {}).caveat || ''}">${r.title.replace(/ \(.*/, '')}</td>`
          + cell(r.d_roof) + cell(r.d_ground) + cell(r.d_facade)
          + cell(r.d_mrt_sun) + cell(r.d_air) + cell(r.d_wbgt));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      box.appendChild(t);
      box.appendChild(el('div', 'small dim',
        'Change from baseline, kelvin. <span style="color:var(--measured)">Green cools</span>, '
        + '<span style="color:var(--warn)">red warms</span>. '
        + 'MRT is mean radiant temperature — what a body actually exchanges heat with.'));
      box.appendChild(el('div', 'note',
        '<b>Why the numbers differ so much between sites.</b> These are not published '
        + 'coefficients applied to an output; each one re-solves the canyon. That is why '
        + 'trees do a great deal on a shallow street and almost nothing on a deep one '
        + 'whose floor is already in shade, and why cool pavement can lower ground '
        + 'temperature while raising the radiant load on people — the reflected shortwave '
        + 'has to go somewhere.'));
    };
    this._renderScenarios = render;
    render();
  }

  /* -------------------------------------------------------------------- AI */

  _ai() {
    const box = $('ai');
    box.innerHTML = '';
    const form = el('div');
    const input = el('textarea');
    input.rows = 2;
    input.placeholder = 'Ask about the study area…';
    Object.assign(input.style, {
      width: '100%', background: 'rgba(255,255,255,.04)', color: 'var(--text)',
      border: '1px solid var(--line)', borderRadius: 'var(--r1)', padding: '8px 10px',
      fontFamily: 'var(--sans)', fontSize: '12px', resize: 'vertical', outline: 'none',
    });
    const send = el('button', null, 'Ask');
    Object.assign(send.style, {
      all: 'unset', cursor: 'pointer', marginTop: '8px', padding: '5px 14px',
      borderRadius: 'var(--r1)', background: 'var(--accent-dim)', color: 'var(--text)',
      border: '1px solid rgba(78,168,222,.4)', fontSize: '12px',
    });
    const out = el('div');
    out.style.marginTop = '12px';

    form.append(input, send, out);
    box.appendChild(form);

    const chips = el('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px';
    box.appendChild(chips);

    const ask = async (q) => {
      input.value = q;
      out.innerHTML = '<div class="small dim mono">thinking…</div>';
      send.textContent = '…';
      try {
        const r = await fetch('/api/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q }),
        });
        const j = await r.json();
        out.innerHTML = '';
        if (j.error) {
          out.appendChild(el('div', 'note warn', j.error));
        } else {
          const body = el('div');
          body.style.cssText = 'font-size:12px;line-height:1.55;color:var(--text-2)';
          body.innerHTML = (j.answer || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--text)">$1</b>')
            .replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
          out.appendChild(body);
          if (j.trace?.length) {
            const tr = el('details');
            tr.innerHTML = `<summary class="small dim mono" style="cursor:pointer;margin-top:10px">
              ${j.trace.length} data quer${j.trace.length === 1 ? 'y' : 'ies'} — show trace</summary>`;
            const list = el('div', 'why');
            list.style.marginTop = '8px';
            for (const t of j.trace) {
              list.appendChild(el('li', t.error ? 'd' : 'm',
                `<span class="mono" style="color:var(--text-2)">${t.tool}</span>(${
                  Object.entries(t.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
                }) → ${t.summary}`));
            }
            tr.appendChild(list);
            out.appendChild(tr);
          }
        }
      } catch (e) {
        out.innerHTML = '';
        out.appendChild(el('div', 'note warn', `Request failed: ${e.message}. Is the server running?`));
      }
      send.textContent = 'Ask';
    };
    send.onclick = () => input.value.trim() && ask(input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send.onclick();
    };

    fetch('/api/health').then((r) => r.json()).then((h) => {
      const tag = $('ai-state');
      if (h.ai_available) {
        tag.textContent = h.ai_model;
        tag.className = 'tag m';
      } else {
        tag.textContent = 'no API key';
        tag.className = 'tag d';
        out.appendChild(el('div', 'note',
          'The analyst needs an Anthropic API key. Set <span class="mono">ANTHROPIC_API_KEY</span> '
          + 'and restart the server. Every other feature here works without it.'));
      }
    }).catch(() => {
      $('ai-state').textContent = 'server offline';
      out.appendChild(el('div', 'note',
        'No server detected. Run <span class="mono">python -m heatcanyon.cli serve</span> '
        + 'to enable the analyst. The 3D model works from static files either way.'));
    });

    fetch('/api/suggestions').then((r) => r.json()).then((j) => {
      for (const s of j.suggestions.slice(0, 4)) {
        const c = el('button', null, s.length > 46 ? s.slice(0, 44) + '…' : s);
        c.title = s;
        Object.assign(c.style, {
          all: 'unset', cursor: 'pointer', fontSize: '10.5px', padding: '3px 8px',
          borderRadius: '999px', border: '1px solid var(--line)', color: 'var(--text-3)',
        });
        c.onmouseenter = () => { c.style.color = 'var(--text)'; };
        c.onmouseleave = () => { c.style.color = 'var(--text-3)'; };
        c.onclick = () => ask(s);
        chips.appendChild(c);
      }
    }).catch(() => {});
  }

  /* ------------------------------------------------------------ right panel */

  showList() {
    this.selected = null;
    this.scene.select(null);
    const d = this.d;
    $('side-title').textContent = 'Priority buildings';
    $('side-sub').innerHTML =
      `Exposure × vulnerability across ${f0(d.ranked.n_scored)} scored buildings. `
      + 'Click one for its dossier, or click any building in the model.';
    const body = $('side-body');
    body.innerHTML = '';
    d.ranked.items.slice(0, 60).forEach((b, i) => {
      const row = el('div', 'rank', `
        <div class="n">${i + 1}</div>
        <div class="who">
          <div class="a">${b.addr || `BIN ${b.bin}`}</div>
          <div class="b">${b.floors} fl · ${f0(b.h)} m · ${b.year || '—'} ·
            ${b.units ? `${f0(b.units)} units` : (b.use_name || '').slice(0, 22)}</div>
        </div>
        <div class="sc"><div class="v">${f0(b.priority)}</div><div class="l">priority</div></div>`);
      row.onclick = () => this.showDetail(i);
      body.appendChild(row);
    });
  }

  showDetail(i, keepScroll = false) {
    const b = this.d.ranked.items[i];
    if (!b) return;
    this.selected = i;
    const bi = this.d.binToIndex.get(String(b.bin));
    if (bi !== undefined) {
      this.scene.select(bi);
      if (!keepScroll) this.scene.focus(bi);
    }

    $('side-title').textContent = `#${i + 1} · ${b.addr || `BIN ${b.bin}`}`;
    $('side-sub').innerHTML = `Priority ${f1(b.priority)} = √(exposure ${f1(b.exposure)}
       × vulnerability ${f1(b.vulnerability)})`;

    const body = $('side-body');
    const scroll = keepScroll ? body.scrollTop : 0;
    body.innerHTML = '';
    const D = el('div');
    D.id = 'detail';

    const back = el('button', 'back', '← all buildings');
    back.onclick = () => this.showList();
    D.appendChild(back);

    D.appendChild(el('div', 'sub',
      `${b.floors} floors · ${f0(b.h)} m · built ${b.year || 'unknown'} ·
       ${b.units ? `${f0(b.units)} residential units` : 'non-residential'} ·
       ZIP ${b.zip || '—'} · HVI ${b.hvi ?? '—'}/5 · ${b.use_name || ''} ·
       assumed facade ${b.material.replace('_', ' ')}`));

    // Measured -----------------------------------------------------------
    D.appendChild(el('h3', null, 'Measured'));
    const m = b.measured;
    const dl1 = el('dl', 'kv');
    dl1.innerHTML = `
      <dt><span class="tag m">FG</span> Hours above 35 °C</dt><dd>${f1(m.exceedance_h)} h</dd>
      <dt><span class="tag m">FG</span> Longest unbroken run</dt><dd>${f2(m.persistence_h)} h</dd>
      <dt><span class="tag m">FG</span> Peak air temperature</dt><dd>${f1(m.peak_air_c)} °C</dd>
      <dt><span class="tag m">NYC</span> Sky view factor</dt><dd>${f2(m.svf)}</dd>`;
    D.appendChild(dl1);

    // Modelled -----------------------------------------------------------
    D.appendChild(el('h3', null, 'Modelled'));
    const md = b.modelled;
    const dl2 = el('dl', 'kv');
    dl2.innerHTML = `
      <dt><span class="tag d">mod</span> Peak facade surface</dt><dd>${f1(md.facade_peak_c)} °C</dd>
      <dt><span class="tag d">mod</span> Spread across faces</dt><dd>${f1(md.facade_spread_k)} K</dd>
      <dt><span class="tag d">mod</span> Mean radiant temp at base</dt><dd>${f1(md.mrt_peak_c)} °C</dd>
      <dt><span class="tag d">mod</span> WBGT at base</dt><dd>${f1(md.wbgt_peak_c)} °C</dd>`;
    D.appendChild(dl2);
    if (md.wbgt_peak_c >= 32) {
      D.appendChild(el('div', 'note warn',
        `WBGT ${f1(md.wbgt_peak_c)} °C is past the 32 °C mark at which occupational heat `
        + 'guidance calls for work to stop. That is a modelled figure for the sidewalk at '
        + 'this address, not a measurement.'));
    }

    // Vertical profile ---------------------------------------------------
    D.appendChild(el('h3', null, 'Vertical profile'));
    D.appendChild(this._profileChart(b));
    D.appendChild(el('div', 'note',
      'Surface temperature (solid) is driven by solar geometry and varies strongly with '
      + 'height as the shadow line moves. Air temperature (dashed, with its uncertainty '
      + 'band) barely varies at all — and the band is wider than the variation. '
      + 'That contrast is the finding, not a defect in the chart.'));

    // Score decomposition ------------------------------------------------
    D.appendChild(el('h3', null, 'Why it ranks here'));
    D.appendChild(this._bars(b));

    const why = el('ul', 'why');
    for (const r of b.reasons) {
      const kind = r.startsWith('Measured') ? 'm' : r.startsWith('People') ? '' : 'd';
      why.appendChild(el('li', kind, r));
    }
    D.appendChild(why);

    // Actions ------------------------------------------------------------
    if (b.actions?.length) {
      D.appendChild(el('h3', null, `Recommended actions (${b.actions.length})`));
      for (const a of b.actions) {
        D.appendChild(el('div', 'act', `
          <div class="t">${a.title}</div>
          <div class="r">${a.rationale}</div>
          <div class="p">${a.programme}</div>
          <div class="e">${a.effect}</div>`));
      }
      D.appendChild(el('div', 'note',
        'These are threshold-triggered, not generated: each one fires on a specific '
        + 'measured or modelled value crossing a stated cutoff, so the same building '
        + 'always yields the same advice and any of it can be traced back to the number '
        + 'that triggered it.'));
    }

    body.appendChild(D);
    body.scrollTop = scroll;
  }

  /* Inline SVG chart: surface + air vs height, with the uncertainty band. */
  _profileChart(b) {
    const d = this.d;
    const bi = d.binToIndex.get(String(b.bin));
    const ps = bi !== undefined ? d.panelsOfBuilding.get(bi) : null;
    const wrap = el('div');
    if (!ps || !ps.length) { wrap.innerHTML = '<p class="small dim">No facade panels.</p>'; return wrap; }

    const nb = d.facades.bands;
    const h = b.h;
    // Hottest and coolest face at this hour, plus the air profile.
    const rows = [];
    for (let band = 0; band < nb; band++) {
      let hot = -1e9, cold = 1e9, air = 0, sig = 0;
      for (const p of ps) {
        const t = d.surfaceAt(this.hour, p, band);
        if (t > hot) hot = t;
        if (t < cold) cold = t;
        air += d.airAt(this.hour, p, band);
        sig += d.sigmaAt(this.hour, p, band);
      }
      rows.push({
        z: (h * (band + 0.5)) / nb,
        hot, cold, air: air / ps.length, sig: sig / ps.length,
      });
    }

    const W = 340, H = 190, ml = 34, mr = 10, mt = 8, mb = 22;
    const lo = Math.min(...rows.map((r) => Math.min(r.cold, r.air - r.sig))) - 1;
    const hi = Math.max(...rows.map((r) => Math.max(r.hot, r.air + r.sig))) + 1;
    const X = (t) => ml + ((t - lo) / (hi - lo)) * (W - ml - mr);
    const Y = (z) => H - mb - (z / h) * (H - mt - mb);

    const path = (key) => rows.map((r, i) => `${i ? 'L' : 'M'}${X(r[key]).toFixed(1)},${Y(r.z).toFixed(1)}`).join('');
    const bandPath =
      rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.air - r.sig).toFixed(1)},${Y(r.z).toFixed(1)}`).join('')
      + rows.slice().reverse().map((r) => `L${X(r.air + r.sig).toFixed(1)},${Y(r.z).toFixed(1)}`).join('')
      + 'Z';

    const hotC = css(RAMPS.temperature(0.85));
    const coldC = css(RAMPS.temperature(0.35));

    wrap.innerHTML = `
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Temperature against height up the facade">
        <line x1="${ml}" y1="${H - mb}" x2="${W - mr}" y2="${H - mb}" stroke="rgba(255,255,255,.14)"/>
        <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${H - mb}" stroke="rgba(255,255,255,.14)"/>
        <path d="${bandPath}" fill="rgba(78,168,222,.16)"/>
        <path d="${path('air')}" fill="none" stroke="#4ea8de" stroke-width="1.4" stroke-dasharray="4 3"/>
        <path d="${path('hot')}" fill="none" stroke="${hotC}" stroke-width="2"/>
        <path d="${path('cold')}" fill="none" stroke="${coldC}" stroke-width="1.6"/>
        <text x="${ml}" y="${H - 7}" text-anchor="start">${f1(lo)} °C</text>
        <text x="${W - mr}" y="${H - 7}" text-anchor="end">${f1(hi)} °C</text>
        <text x="${ml - 5}" y="${Y(h)}" text-anchor="end">${f0(h)} m</text>
        <text x="${ml - 5}" y="${H - mb}" text-anchor="end">0</text>
      </svg>
      <div class="small" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:-6px">
        <span style="color:${hotC}">— hottest face</span>
        <span style="color:${coldC}">— coolest face</span>
        <span style="color:#4ea8de">-- air temperature ±1σ</span>
      </div>`;
    return wrap;
  }

  _bars(b) {
    const W = this.d.ranked.weights;
    const box = el('div', 'bars');
    const add = (label, value, weight, colour) => {
      const b2 = el('div', 'b', `
        <div class="lab"><span>${label}</span><span>${f2(value)} × ${f2(weight)}</span></div>
        <div class="tr"><i style="width:${Math.round(value * 100)}%;background:${colour}"></i></div>`);
      box.appendChild(b2);
    };
    const c = b.components;
    box.appendChild(el('div', 'small dim',
      `<b style="color:var(--text-2)">Exposure ${f1(b.exposure)}</b> — physics`));
    for (const [k, w] of Object.entries(W.exposure)) {
      if (c[k] === undefined) continue;
      const meas = ['dose', 'persistence', 'peak_air', 'enclosure'].includes(k);
      add(k.replace(/_/g, ' '), c[k], w, meas ? 'var(--measured)' : 'var(--modelled)');
    }
    box.appendChild(el('div', 'small dim',
      `<b style="color:var(--text-2)">Vulnerability ${f1(b.vulnerability)}</b> — people`));
    for (const [k, w] of Object.entries(W.vulnerability)) {
      const key = `vuln_${k}`;
      if (c[key] === undefined) continue;
      add(k.replace(/_/g, ' '), c[key], w, 'var(--accent)');
    }
    box.appendChild(el('div', 'small dim',
      'Green bars are measured inputs, amber modelled, blue the people terms. '
      + 'Weights are fixed and stated — nothing here is learned.'));
    return box;
  }

  /* ------------------------------------------------------------- hover */

  _hoverLoop() {
    const box = $('hover');
    const d = this.d;
    // Throttled deliberately. hitTest() ray-casts against the facade mesh,
    // which is ~350,000 triangles with no BVH, so doing it every animation
    // frame starves the render loop for no benefit — a tooltip does not need
    // to update at 60 Hz. Recast only when the pointer has actually moved, and
    // at most ~12 times a second.
    let lastAt = 0, lastX = -1, lastY = -1;
    const step = (t) => {
      const p = this.scene._lastPointer;
      const moved = p && (p.x !== lastX || p.y !== lastY);
      const due = t - lastAt > 80;
      if (!moved && !due) { requestAnimationFrame(step); return; }
      lastAt = t;
      if (p) { lastX = p.x; lastY = p.y; }

      const hit = this.scene.hitTest();
      if (!hit || !this.scene._lastPointer) {
        box.style.display = 'none';
      } else {
        const a = d.buildings.attrs[hit.building];
        const rank = d.rankByBin.get(String(a?.bin));
        let lines = `<div class="a">${a?.addr || `BIN ${a?.bin ?? '—'}`}</div>`;
        if (hit.kind === 'facade' && hit.panel !== null) {
          const t = d.surfaceAt(this.hour, hit.panel, hit.band);
          const air = d.airAt(this.hour, hit.panel, hit.band);
          const sig = d.sigmaAt(this.hour, hit.panel, hit.band);
          const lit = d.sunlitAt(this.hour, hit.panel, hit.band);
          const az = d.facades.az[hit.panel];
          const hh = Math.max(d.facades.top[hit.panel] - d.facades.base[hit.panel], 0.5);
          const z = (hh * (hit.band + 0.5)) / d.facades.bands;
          lines += `<div class="b">${compass(az)}-facing · ${f0(z)} m up · ${lit ? 'in sun' : 'shaded'}</div>`
                +  `<div class="a">surface ${f1(t)} °C</div>`
                +  `<div class="b">air ${f1(air)} ± ${f1(sig)} °C (modelled)</div>`;
        } else {
          lines += `<div class="b">roof · ${f0(a?.h)} m</div>`;
        }
        if (rank) lines += `<div class="b">priority ${f1(rank.priority)} · rank #${rank.rank}</div>`;
        box.innerHTML = lines;
        box.style.display = 'block';
        box.style.left = `${Math.min(window.innerWidth - 280, this.scene._lastPointer.x + 14)}px`;
        box.style.top = `${this.scene._lastPointer.y + 14}px`;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function compass(az) {
  const n = ['north', 'north-east', 'east', 'south-east',
             'south', 'south-west', 'west', 'north-west'];
  return n[Math.floor((((az % 360) + 22.5) / 45)) % 8];
}

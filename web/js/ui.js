/* The interface.
 *
 * Deliberately spare. An earlier version put the full data provenance, an
 * uncertainty essay, and a measured/modelled badge on every figure directly in
 * the panels. All of it was true and none of it belonged there: it buried the
 * controls, pushed the panels into each other, and left no obvious place to
 * look. That material now lives in docs/METHODOLOGY.md, where someone who wants
 * to audit the model will actually read it.
 *
 * What is left is three tabs and a ranked list. Layer captions are one sentence.
 * The one honesty note that survives is the uncertainty band drawn on the
 * vertical profile chart, because there it is the point being made rather than
 * a disclaimer about it.
 */

import { RAMPS, css, gradient, norm } from './colors.js';
import { findApiKey, resolveApiKey, storeApiKey } from './photoreal.js';

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
    key: 'surface', name: 'Facade temperature', unit: '°C', ramp: 'temperature',
    caption: 'How hot each wall actually gets. A sunlit face runs far hotter than the air beside it.',
  },
  {
    key: 'sun', name: 'Sun and shade', unit: '', ramp: 'temperature',
    caption: 'Which walls the sun reaches this hour. Watch the lit band climb as the afternoon goes on.',
  },
  {
    key: 'exceedance', name: 'Hours above 35 °C', unit: 'h', ramp: 'duration',
    caption: 'Total hours over the seven-day heat wave. Duration is what harms people, not peak.',
  },
  {
    key: 'persistence', name: 'Longest unbroken run', unit: 'h', ramp: 'duration',
    caption: 'The longest stretch that never dropped below 35 °C — no overnight recovery.',
  },
  {
    key: 'air', name: 'Air temperature', unit: '°C', ramp: 'temperature',
    caption: 'Measured at 2 m and extended upward. It barely varies with height, which is the point.',
  },
  {
    key: 'priority', name: 'Where to act', unit: 'score', ramp: 'priority',
    caption: 'Heat exposure combined with how badly the occupants can cope.',
  },
];

/* ------------------------------------------------------------------- boot */

export function boot(p, msg) {
  $('boot-bar').style.width = `${Math.round(p * 100)}%`;
  $('boot-msg').textContent = msg;
}
export function bootDone() {
  $('boot').classList.add('done');
  setTimeout(() => $('boot')?.remove(), 600);
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
    this.selected = null;

    this._folds();
    this._brand();
    this._tabs();
    this._layers();
    this._hours();
    this._cam();
    this._photoreal();
    this._whatif();
    this._ask();
    this.showList();
    this.setLayer('surface');
    this._hoverLoop();
  }

  /* ------------------------------------------------------- fold panels */

  /** Let either side panel be folded away.
   *
   * Built here rather than in the markup so it cannot be lost to an edit of
   * index.html, and so the reopen handle can be created as a sibling of the
   * panel — a control inside a folded panel is a control you cannot reach.
   * Escape folds both at once, which is the fastest way to just look at the
   * city.
   */
  _folds() {
    const mk = (panelId, handleId, label, cls) => {
      const panel = $(panelId);
      if (!panel || panel.querySelector('.fold')) return;

      const fold = el('button', 'fold', label.close);
      fold.title = 'Hide this panel';
      fold.setAttribute('aria-label', 'Hide this panel');
      panel.appendChild(fold);

      const open = el('button', 'unfold', label.open);
      open.id = handleId;
      open.title = 'Show this panel';
      open.hidden = true;
      panel.parentNode.appendChild(open);

      const set = (folded) => {
        panel.classList.toggle('folded', folded);
        open.hidden = !folded;
        $('time').classList.toggle(cls, folded);
        panel.setAttribute('aria-hidden', String(folded));
      };
      fold.onclick = () => set(true);
      open.onclick = () => set(false);
      return set;
    };

    const setLeft = mk('left', 'unfold-left', { close: '‹', open: '›' }, 'wide-left');
    const setRight = mk('side', 'unfold-right', { close: '›', open: '‹' }, 'wide-right');

    let bothHidden = false;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
      bothHidden = !bothHidden;
      setLeft?.(bothHidden);
      setRight?.(bothHidden);
    });
  }

  /* ------------------------------------------------------------- brand */

  _brand() {
    const m = this.d.meta;
    $('brand-sub').innerHTML =
      `Midtown Manhattan · ${m.aoi.area_km2} km²<br>`
      + `${f0(m.counts.buildings_scored)} buildings · 2 July 2026 heat wave`;
  }

  /* --------------------------------------------------------- photoreal */

  /* The layer is gated on a key the user supplies, for two reasons that both
   * point the same way: a key committed here would be a key strangers spend,
   * and billing is per session, so the honest default is to issue no request
   * at all until someone asks for one. */
  _photoreal() {
    const toggle = $('pr-toggle');
    const keyBox = $('pr-key');
    const look = $('pr-look');
    const status = $('pr-status');
    const input = $('pr-key-input');
    const cpu = $('pr-cpu');
    if (!toggle) return;

    const say = (msg, cls) => {
      status.textContent = msg || '';
      status.className = `prstatus${cls ? ` ${cls}` : ''}`;
    };

    this.scene.onPhotorealStatus = (state, detail) => {
      if (state === 'loading') say(detail || 'streaming tiles…');
      else if (state === 'ready') say('');
      else if (state === 'error') say(detail || 'failed', 'bad');
    };

    // Google requires the per-tile credits to be aggregated and shown, and the
    // viewer to be able to tell which part of the picture is theirs. The strip
    // labels both sides rather than running one undifferentiated line.
    this.scene.onAttribution = (list) => {
      const strip = $('credits');
      const g = $('credits-google');
      if (!strip || !g) return;
      if (!list || !list.length) { strip.hidden = true; g.textContent = ''; return; }
      g.textContent = list.join(' · ');
      strip.hidden = false;
    };

    // A key from .env arrives asynchronously; until it does, treat the layer as
    // key-less. Nothing is requested either way, so there is no race to lose.
    let envKey = '';
    resolveApiKey().then((k) => {
      envKey = k || '';
      if (envKey) say('Key loaded from the server environment.');
    });
    const anyKey = () => findApiKey() || envKey;

    const savedCpuMode = () => {
      try { return localStorage.getItem('heatcanyon.photoreal_cpu') === '1'; }
      catch (e) { return false; }
    };
    if (cpu) {
      cpu.checked = savedCpuMode();
      this.scene.setPhotorealCpuMode(cpu.checked);
      cpu.onchange = () => {
        try { localStorage.setItem('heatcanyon.photoreal_cpu', cpu.checked ? '1' : '0'); }
        catch (e) { /* preference applies for this page even if storage is unavailable */ }
        const wasOn = toggle.getAttribute('aria-pressed') === 'true';
        this.scene.setPhotorealCpuMode(cpu.checked);
        if (wasOn) setOn(true);
      };
    }

    const setOn = async (on) => {
      const ok = await this.scene.setPhotoreal(on, anyKey());
      const live = on && ok;
      toggle.setAttribute('aria-pressed', String(live));
      look.hidden = !live;
      if (on && !ok) { keyBox.hidden = false; input?.focus(); }
      return live;
    };

    toggle.onclick = () => {
      const on = toggle.getAttribute('aria-pressed') !== 'true';
      if (on && !anyKey()) {
        keyBox.hidden = false;
        say('Paste a Google Maps API key to switch this on.');
        input?.focus();
        return;
      }
      setOn(on);
    };

    $('pr-key-save').onclick = () => {
      const v = (input.value || '').trim();
      if (!v) { say('That key looks empty.', 'bad'); return; }
      storeApiKey(v);
      input.value = '';
      keyBox.hidden = true;
      // A key change means a different session, so drop the old tileset first.
      this.scene.photoreal?.dispose();
      setOn(true);
    };
    $('pr-key-clear').onclick = () => {
      storeApiKey('');
      this.scene.photoreal?.dispose();
      setOn(false);
      keyBox.hidden = false;
      say('Key forgotten.');
    };

    const slider = (id, out, fmt, apply) => {
      const r = $(id), o = $(out);
      const run = () => {
        const v = parseFloat(r.value);
        o.textContent = fmt(v);
        apply(v);
      };
      r.oninput = run;
      run();
    };
    slider('pr-desat', 'pr-desat-out', (v) => `${Math.round(100 - v)}%`,
      (v) => this.scene.photoreal?.setLook({ desaturate: v / 100 }));
    slider('pr-data', 'pr-data-out', (v) => `${Math.round(v)}%`,
      (v) => this.scene.photoreal?.setLook({ dataWash: v / 100 }));
    slider('pr-wash', 'pr-wash-out', (v) => `${Math.round(v)}%`,
      (v) => this.scene.photoreal?.setLook({ fieldWash: v / 100 }));
    $('pr-solids').onchange = (e) => this.scene.setShowSolids(e.target.checked);
    slider('pr-nudge', 'pr-nudge-out', (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} m`,
      (v) => this.scene.photoreal?.setNudge(v));

    if (findApiKey()) say('Key found in this browser.');
  }

  /* -------------------------------------------------------------- tabs */

  _tabs() {
    const btns = [...$('tabs').querySelectorAll('button')];
    const show = (name) => {
      for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
      for (const t of ['view', 'whatif', 'ask']) {
        $(`tab-${t}`).hidden = t !== name;
      }
      if (name === 'whatif') this._renderScenarios?.();
    };
    for (const b of btns) b.onclick = () => show(b.dataset.tab);
    this._showTab = show;
    show('view');
  }

  /** Switch tabs from outside the panel. The guided tour uses this to put the
   *  left rail on the tab whose card it is about to open. */
  showTab(name) {
    this._showTab?.(name);
  }

  /* ------------------------------------------------------------ layers */

  _layers() {
    const box = $('layers');
    box.innerHTML = '';
    for (const L of LAYERS) {
      const b = el('button', null, `<span>${L.name}</span><span class="u">${L.unit}</span>`);
      b.setAttribute('aria-pressed', String(L.key === this.layer));
      b.onclick = () => this.setLayer(L.key);
      b.dataset.key = L.key;
      box.appendChild(b);
    }
  }

  setLayer(key) {
    this.layer = key;
    for (const b of $('layers').children) {
      b.setAttribute('aria-pressed', String(b.dataset.key === key));
    }
    this.scene.setLayer(key);
    this._legend();
  }

  _legend() {
    const L = LAYERS.find((x) => x.key === this.layer);
    const d = this.d;
    let lo, hi;
    if (L.key === 'exceedance') { const s = d.tiles.stats.exceedance; lo = s.min; hi = s.max; }
    else if (L.key === 'persistence') { const s = d.tiles.stats.persistence; lo = s.min; hi = s.max; }
    else if (L.key === 'priority') { lo = 0; hi = 85; }
    else if (L.key === 'air') { [lo, hi] = this.scene.airDomain; }
    else { [lo, hi] = this.scene.surfaceDomain; }

    if (L.key === 'sun') {
      $('legend-ramp').style.background =
        'linear-gradient(90deg,rgb(46,54,70) 0 50%,rgb(252,200,90) 50% 100%)';
      $('legend-ticks').innerHTML = '<span>shaded</span><span>direct sun</span>';
    } else {
      $('legend-ramp').style.background = gradient(L.ramp);
      $('legend-ticks').innerHTML =
        `<span>${f1(lo)}${L.unit}</span><span>${f1((lo + hi) / 2)}${L.unit}</span>`
        + `<span>${f1(hi)}${L.unit}</span>`;
    }
    $('legend-cap').textContent = L.caption;
  }

  /* ------------------------------------------------------------- hours */

  _hours() {
    const box = $('hours');
    box.innerHTML = '';
    this.d.meta.hours.forEach((h, i) => {
      const b = el('button', null, `${String(h.edt).padStart(2, '0')}`);
      b.title = `${String(h.edt).padStart(2, '0')}:00 EDT`;
      b.setAttribute('aria-pressed', String(i === this.hour));
      b.onclick = () => { this.stop(); this.setHour(i); };
      box.appendChild(b);
    });
    $('play').onclick = () => (this.playing ? this.stop() : this.play());
    this._timeMeta();
  }

  setHour(i) {
    this.hour = i;
    const kids = $('hours').children;
    for (let k = 0; k < kids.length; k++) {
      kids[k].setAttribute('aria-pressed', String(k === i));
    }
    this.scene.setHour(i);
    this._timeMeta();
    this._legend();
    if (this.selected !== null) this.showDetail(this.selected, true);
    if (!$('tab-whatif').hidden) this._renderScenarios?.();
  }

  play() {
    this.playing = true;
    $('play').innerHTML = '&#10074;&#10074;';
    this._timer = setInterval(
      () => this.setHour((this.hour + 1) % this.d.meta.hours.length), 1100);
  }
  stop() {
    this.playing = false;
    $('play').innerHTML = '&#9658;';
    clearInterval(this._timer);
  }

  _timeMeta() {
    const h = this.d.meta.hours[this.hour];
    $('time-meta').innerHTML = `
      <span><b>${String(h.edt).padStart(2, '0')}:00 EDT</b></span>
      <span>air <b>${f1(h.t_anchor_c)} °C</b></span>
      <span>sun <b>${f1(h.sun_alt)}°</b> up, <b>${f1(h.sun_az)}°</b> bearing</span>
      <span>beam <b>${f0(h.dni)}</b> W/m²</span>
      <span>humidity <b>${f0(h.rh)}%</b></span>`;
  }

  /* ------------------------------------------------------------ camera */

  _cam() {
    const o = $('cam-orbit'), s = $('cam-street'), n = $('cam-next');
    const hint = $('cam-hint');
    const describe = () => {
      const v = this.scene.currentViewpoint;
      return v
        ? `${v.name} — walls ${f0(v.h_left)} m and ${f0(v.h_right)} m, ${f0(v.width_m)} m apart.
           W A S D walk · Q E down/up · drag to look · scroll to move`
        : 'W A S D walk · Q E down/up · drag to look · scroll to move';
    };
    const set = (mode) => {
      o.setAttribute('aria-pressed', String(mode === 'orbit'));
      s.setAttribute('aria-pressed', String(mode === 'street'));
      n.hidden = mode !== 'street';
      this.scene.setMode(mode);
      hint.textContent = mode === 'street'
        ? describe() : 'Drag any direction to pan · scroll to zoom · right-drag to tilt and turn';
    };
    o.onclick = () => set('orbit');
    s.onclick = () => set('street');
    n.onclick = () => { this.scene.nextViewpoint(); hint.textContent = describe(); };
    set('orbit');
  }

  /* --------------------------------------------------------- scenarios */

  _whatif() {
    const S = this.d.scenarios;
    const box = $('tab-whatif');
    if (!S.sites?.length) { box.innerHTML = '<p class="small dim">No scenario sites.</p>'; return; }

    const render = () => {
      const site = S.sites[this.scenarioSite];
      const target = this.d.meta.hours[this.hour].edt;
      let row = site.hours[0];
      for (const r of site.hours) {
        if (Math.abs(r.hour_edt - target) < Math.abs(row.hour_edt - target)) row = r;
      }
      box.innerHTML = '';

      const pick = el('div', 'seg');
      S.sites.forEach((sx, i) => {
        const b = el('button', null,
          `<span>${sx.name}</span><span class="u">${f1(sx.w)} m wide</span>`);
        b.setAttribute('aria-pressed', String(i === this.scenarioSite));
        b.onclick = () => { this.scenarioSite = i; render(); };
        pick.appendChild(b);
      });
      box.appendChild(pick);

      const t = el('table', 'sctab');
      t.innerHTML = `<thead><tr><th>Change</th><th>road</th><th>wall</th>
        <th>felt</th><th>air</th></tr></thead>`;
      const tb = el('tbody');
      for (const r of row.results) {
        if (r.key === 'baseline') continue;
        const cell = (v) => {
          const c = v < -0.05 ? 'neg' : v > 0.05 ? 'pos' : 'zero';
          return `<td class="${c}">${v > 0 ? '+' : ''}${f1(v)}</td>`;
        };
        tb.appendChild(el('tr', null,
          `<td>${r.title.replace(/ \(.*/, '')}</td>`
          + cell(r.d_ground) + cell(r.d_facade) + cell(r.d_mrt_sun) + cell(r.d_air)));
      }
      t.appendChild(tb);
      box.appendChild(t);

      box.appendChild(el('p', 'hint',
        'Change in °C at ' + row.hour_edt + ':00. '
        + '<span style="color:var(--measured)">Green cools</span>, '
        + '<span style="color:var(--warn)">red warms</span>. '
        + '"Felt" is what a body on the pavement exchanges heat with.'));
      box.appendChild(el('p', 'hint',
        'Each row re-solves this canyon rather than applying a fixed figure, '
        + 'which is why trees do a great deal on a shallow street and almost '
        + 'nothing on a deep one already in shade.'));
    };
    this._renderScenarios = render;
    render();
  }

  /* ---------------------------------------------------------------- ask */

  _ask() {
    const box = $('tab-ask');
    box.innerHTML = '';

    const input = el('textarea');
    input.rows = 3;
    input.placeholder = 'Ask about Midtown…';
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
    out.style.marginTop = '14px';
    const chips = el('div');
    chips.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:12px';

    box.append(input, send, out, chips);

    const ask = async (q) => {
      input.value = q;
      out.innerHTML = '<p class="hint">thinking…</p>';
      send.textContent = '…';
      try {
        const r = await fetch('/api/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q }),
        });
        const j = await r.json();
        out.innerHTML = '';
        if (j.error) {
          out.appendChild(el('p', 'hint', j.error));
        } else {
          const body = el('div');
          body.style.cssText = 'font-size:12px;line-height:1.6;color:var(--text-2)';
          body.innerHTML = (j.answer || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--text)">$1</b>')
            .replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
          out.appendChild(body);
          if (j.trace?.length) {
            out.appendChild(el('p', 'hint',
              `Answered from ${j.trace.length} quer${j.trace.length === 1 ? 'y' : 'ies'} `
              + `against the model: ${j.trace.map((t) => t.tool).join(', ')}.`));
          }
        }
      } catch (e) {
        out.innerHTML = '';
        out.appendChild(el('p', 'hint', `Request failed: ${e.message}`));
      }
      send.textContent = 'Ask';
    };
    send.onclick = () => input.value.trim() && ask(input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send.onclick();
    };

    fetch('/api/health').then((r) => r.json()).then((h) => {
      if (!h.ai_available) {
        out.appendChild(el('p', 'hint',
          'Set ANTHROPIC_API_KEY and restart the server to enable this. '
          + 'Everything else works without it.'));
      }
    }).catch(() => {
      out.appendChild(el('p', 'hint', 'Server not reachable.'));
    });

    fetch('/api/suggestions').then((r) => r.json()).then((j) => {
      for (const s of j.suggestions.slice(0, 4)) {
        const c = el('button', null, s);
        Object.assign(c.style, {
          all: 'unset', cursor: 'pointer', fontSize: '11px', padding: '6px 9px',
          borderRadius: 'var(--r1)', border: '1px solid var(--line)',
          color: 'var(--text-3)', lineHeight: '1.45',
        });
        c.onmouseenter = () => { c.style.color = 'var(--text)'; };
        c.onmouseleave = () => { c.style.color = 'var(--text-3)'; };
        c.onclick = () => ask(s);
        chips.appendChild(c);
      }
    }).catch(() => {});
  }

  /* --------------------------------------------------------- right panel */

  showList() {
    this.selected = null;
    this.scene.select(null);
    $('side-title').textContent = 'Where to act first';
    $('side-sub').textContent =
      `${f0(this.d.ranked.n_scored)} buildings ranked by heat exposure and how badly `
      + 'their occupants can cope. Click one, or click any building in the model.';
    const body = $('side-body');
    body.innerHTML = '';
    this.d.ranked.items.slice(0, 60).forEach((b, i) => {
      const bits = [`${b.floors} floors`, `${f0(b.h)} m`, b.year || null,
                    b.units ? `${f0(b.units)} homes` : null].filter(Boolean);
      const row = el('div', 'rank', `
        <div class="n">${i + 1}</div>
        <div class="who">
          <div class="a">${b.addr || `BIN ${b.bin}`}</div>
          <div class="b">${bits.join(' · ')}</div>
        </div>
        <div class="sc"><div class="v">${f0(b.priority)}</div><div class="l">score</div></div>`);
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
    $('side-sub').textContent =
      `Score ${f1(b.priority)} — exposure ${f1(b.exposure)}, coping ${f1(b.vulnerability)}`;

    const body = $('side-body');
    const scroll = keepScroll ? body.scrollTop : 0;
    body.innerHTML = '';
    const D = el('div');
    D.id = 'detail';

    const back = el('button', 'back', '← all buildings');
    back.onclick = () => this.showList();
    D.appendChild(back);

    D.appendChild(el('p', 'sub',
      [`${b.floors} floors`, `${f0(b.h)} m`, b.year ? `built ${b.year}` : null,
       b.units ? `${f0(b.units)} homes` : 'non-residential',
       b.zip ? `ZIP ${b.zip}` : null,
       b.hvi ? `vulnerability ${b.hvi}/5` : null].filter(Boolean).join(' · ')));

    const m = b.measured, md = b.modelled;
    D.appendChild(el('h3', null, 'Heat'));
    const dl = el('dl', 'kv');
    dl.innerHTML = `
      <dt>Hours above 35 °C</dt><dd>${f1(m.exceedance_h)} h</dd>
      <dt>Longest unbroken run</dt><dd>${f2(m.persistence_h)} h</dd>
      <dt>Peak air temperature</dt><dd>${f1(m.peak_air_c)} °C</dd>
      <dt>Hottest wall</dt><dd>${f1(md.facade_peak_c)} °C</dd>
      <dt>Difference between faces</dt><dd>${f1(md.facade_spread_k)} °C</dd>
      <dt>Felt on the pavement</dt><dd>${f1(md.mrt_peak_c)} °C</dd>
      <dt>Sky visible from the street</dt><dd>${Math.round(m.svf * 100)}%</dd>`;
    D.appendChild(dl);

    D.appendChild(el('h3', null, 'Up the building'));
    D.appendChild(this._profileChart(b));

    D.appendChild(el('h3', null, 'Why it ranks here'));
    D.appendChild(this._bars(b));
    const why = el('ul', 'why');
    for (const r of b.reasons.slice(0, 5)) {
      why.appendChild(el('li', null, r.replace(/^(Measured|Modelled|People|Measured geometry):\s*/, '')));
    }
    D.appendChild(why);

    if (b.actions?.length) {
      D.appendChild(el('h3', null, `What to do (${b.actions.length})`));
      for (const a of b.actions) {
        D.appendChild(el('div', 'act', `
          <div class="t">${a.title}</div>
          <div class="r">${a.rationale}</div>
          <div class="p">${a.programme}</div>`));
      }
    }

    body.appendChild(D);
    body.scrollTop = scroll;
  }

  /* Temperature against height: the one place a caveat earns its space. */
  _profileChart(b) {
    const d = this.d;
    const bi = d.binToIndex.get(String(b.bin));
    const ps = bi !== undefined ? d.panelsOfBuilding.get(bi) : null;
    const wrap = el('div');
    if (!ps?.length) { wrap.innerHTML = '<p class="hint">No facade data.</p>'; return wrap; }

    const nb = d.facades.bands;
    const h = b.h;
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
      rows.push({ z: (h * (band + 0.5)) / nb, hot, cold,
                  air: air / ps.length, sig: sig / ps.length });
    }

    const W = 300, H = 160, ml = 30, mr = 8, mt = 6, mb = 20;
    const lo = Math.min(...rows.map((r) => Math.min(r.cold, r.air - r.sig))) - 1;
    const hi = Math.max(...rows.map((r) => Math.max(r.hot, r.air + r.sig))) + 1;
    const X = (t) => ml + ((t - lo) / (hi - lo)) * (W - ml - mr);
    const Y = (z) => H - mb - (z / h) * (H - mt - mb);
    const path = (k) => rows.map((r, i) => `${i ? 'L' : 'M'}${X(r[k]).toFixed(1)},${Y(r.z).toFixed(1)}`).join('');
    const bandPath =
      rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.air - r.sig).toFixed(1)},${Y(r.z).toFixed(1)}`).join('')
      + rows.slice().reverse().map((r) => `L${X(r.air + r.sig).toFixed(1)},${Y(r.z).toFixed(1)}`).join('') + 'Z';

    const hotC = css(RAMPS.temperature(0.85));
    const coldC = css(RAMPS.temperature(0.35));

    wrap.innerHTML = `
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Temperature against height up the building">
        <line x1="${ml}" y1="${H - mb}" x2="${W - mr}" y2="${H - mb}" stroke="rgba(255,255,255,.14)"/>
        <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${H - mb}" stroke="rgba(255,255,255,.14)"/>
        <path d="${bandPath}" fill="rgba(78,168,222,.16)"/>
        <path d="${path('air')}" fill="none" stroke="#4ea8de" stroke-width="1.3" stroke-dasharray="4 3"/>
        <path d="${path('hot')}" fill="none" stroke="${hotC}" stroke-width="2"/>
        <path d="${path('cold')}" fill="none" stroke="${coldC}" stroke-width="1.5"/>
        <text x="${ml}" y="${H - 6}" text-anchor="start">${f1(lo)}°</text>
        <text x="${W - mr}" y="${H - 6}" text-anchor="end">${f1(hi)}°</text>
        <text x="${ml - 4}" y="${Y(h) + 3}" text-anchor="end">${f0(h)}m</text>
        <text x="${ml - 4}" y="${H - mb}" text-anchor="end">0</text>
      </svg>
      <p class="hint">
        <span style="color:${hotC}">━ hottest wall</span> &nbsp;
        <span style="color:${coldC}">━ coolest wall</span> &nbsp;
        <span style="color:#4ea8de">┄ air (band = uncertainty)</span>
      </p>`;
    return wrap;
  }

  _bars(b) {
    const W = this.d.ranked.weights;
    const box = el('div', 'bars');
    const NICE = {
      dose: 'hours above 35 °C', persistence: 'unbroken run', peak_air: 'peak air',
      facade_solar: 'sun on the walls', mrt: 'felt on the pavement',
      enclosure: 'how enclosed the street is',
      hvi: 'neighbourhood vulnerability', residents: 'people living here',
      age: 'building age', affordability: 'likely to run air conditioning',
    };
    const add = (label, value, colour) => {
      box.appendChild(el('div', 'b', `
        <div class="lab"><span>${label}</span><span>${Math.round(value * 100)}%</span></div>
        <div class="tr"><i style="width:${Math.round(value * 100)}%;background:${colour}"></i></div>`));
    };
    const c = b.components;
    box.appendChild(el('p', 'hint', `Exposure ${f1(b.exposure)}`));
    for (const k of Object.keys(W.exposure)) {
      if (c[k] !== undefined) add(NICE[k] || k, c[k], 'var(--modelled)');
    }
    box.appendChild(el('p', 'hint', `How badly they cope ${f1(b.vulnerability)}`));
    for (const k of Object.keys(W.vulnerability)) {
      if (c[`vuln_${k}`] !== undefined) add(NICE[k] || k, c[`vuln_${k}`], 'var(--accent)');
    }
    return box;
  }

  /* ------------------------------------------------------------- hover */

  _hoverLoop() {
    const box = $('hover');
    const d = this.d;
    let lastAt = 0, lastX = -1, lastY = -1;
    const step = (t) => {
      const p = this.scene._lastPointer;
      const moved = p && (p.x !== lastX || p.y !== lastY);
      if (!moved && t - lastAt < 90) { requestAnimationFrame(step); return; }
      lastAt = t;
      if (p) { lastX = p.x; lastY = p.y; }

      const hit = this.scene.hitTest();
      if (!hit || !p) {
        box.style.display = 'none';
      } else {
        const a = d.buildings.attrs[hit.building];
        const rank = d.rankByBin.get(String(a?.bin));
        let lines = `<div class="a">${a?.addr || `BIN ${a?.bin ?? '—'}`}</div>`;
        if (hit.kind === 'facade' && hit.panel !== null) {
          const surf = d.surfaceAt(this.hour, hit.panel, hit.band);
          const lit = d.sunlitAt(this.hour, hit.panel, hit.band);
          const hh = Math.max(d.facades.top[hit.panel] - d.facades.base[hit.panel], 0.5);
          const z = (hh * (hit.band + 0.5)) / d.facades.bands;
          lines += `<div class="b">${compass(d.facades.az[hit.panel])} wall`
                +  ` · ${f0(z)} m up · ${lit ? 'in sun' : 'shaded'}</div>`
                +  `<div class="a">${f1(surf)} °C</div>`;
        } else {
          lines += `<div class="b">roof · ${f0(a?.h)} m</div>`;
        }
        if (rank) lines += `<div class="b">#${rank.rank} to act on</div>`;
        box.innerHTML = lines;
        box.style.display = 'block';
        box.style.left = `${Math.min(window.innerWidth - 270, p.x + 14)}px`;
        box.style.top = `${Math.min(window.innerHeight - 90, p.y + 14)}px`;
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

/* The year strip: 365 days you can scrub, drawn from the data it selects.
 *
 * WHY A CANVAS AND NOT 365 BUTTONS
 *
 * The first version of this was a row of month buttons and a day slider, and it
 * was useless in the way that most time controls are useless: it let you choose a
 * day without telling you which day was worth choosing. A year of Manhattan heat
 * is five days above 35 degC and four tropical nights out of 365, and a control
 * that hides where they are makes the user hunt for them.
 *
 * So the strip IS the data. Each day is a column whose height is its maximum air
 * temperature and whose colour is the same temperature ramp the city uses, with
 * the night minimum drawn underneath as a second, darker band — so the days when
 * the city failed to cool overnight are visible as a thick warm base rather than
 * as a statistic. Heat-wave episodes, found by run length in the pipeline rather
 * than declared here, are bracketed above the strip. The thirteen days the model
 * actually solved are ticked below it, and the FortyGuard-anchored event day is
 * marked differently from the twelve reanalysis-anchored ones, because they do not
 * rest on the same evidence.
 *
 * WHAT THE FOUR AGGREGATE MODES MEAN, PHYSICALLY
 *
 *   Day     the selected date. One of the thirteen solved days shows its solved
 *           field; any other day shows its month's field plus that day's
 *           air-temperature departure, and the strip says "reconstructed".
 *   Month   the month's representative day, solved. No reconstruction.
 *   Season  the mean of the three member months' solved fields at the same hour.
 *   Year    the mean of all twelve. The hour strip is disabled, because a mean
 *           over the year has no hour and pretending otherwise would be a lie
 *           the interface tells for free.
 *
 * The distinction matters most in winter. December's noon sun is 26 degrees lower
 * than June's over Manhattan, so a canyon that is half sunlit in July has a floor
 * in permanent shade in January. Scrub the year with the sun-and-shade layer on
 * and that is the thing you see.
 */

import { RAMPS, css, norm } from './colors.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

export const AGGREGATES = [
  { key: 'day', label: 'Day', hint: 'One date. Solved days are ticked; the rest are reconstructed from their month.' },
  { key: 'month', label: 'Month', hint: "That month's representative day, solved in full." },
  { key: 'season', label: 'Season', hint: 'Mean of the three months, at the same hour.' },
  { key: 'year', label: 'Year', hint: 'Mean of all twelve months. No hour: a year has no time of day.' },
];

const MONTH_SHORT = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const DPR = () => Math.min(2, window.devicePixelRatio || 1);

export class YearStrip {
  /**
   * @param {HTMLElement} host      where to mount
   * @param {object} data           the loaded dataset
   * @param {(date:string)=>void} onPick   called with a date string
   */
  constructor(host, data, onPick) {
    this.d = data;
    this.onPick = onPick;
    this.days = data.days;
    this.aggregate = 'day';
    this.index = data.dateToDay.get(data.eventDate) ?? 0;
    this.hover = null;

    this.el = el('div', 'yearstrip');
    this.canvas = el('canvas');
    this.canvas.className = 'ystrip';
    this.tip = el('div', 'ytip');
    this.tip.hidden = true;
    this.ruler = el('div', 'yruler');
    this.modes = el('div', 'ymodes');
    this.el.append(this.modes, this.canvas, this.ruler, this.tip);
    host.appendChild(this.el);

    this._domain();
    this._modes();
    this._ruler();
    this._events();
    this.resize();
  }

  /* The colour and height scale, from the year's own range rather than a guess.
   * Fixed once: a scale that rescaled as you scrubbed would make January look
   * like July. */
  _domain() {
    const tmax = this.days.map((d) => d.tmax);
    const tmin = this.days.map((d) => d.tmin);
    this.lo = Math.min(...tmin);
    this.hi = Math.max(...tmax);
    // The ramp is anchored on the same absolute temperatures the city's legend
    // uses, so a warm colour means the same thing in both places.
    this.rampLo = Math.max(-10, this.lo);
    this.rampHi = this.hi;
  }

  _modes() {
    this.modes.innerHTML = '';
    for (const a of AGGREGATES) {
      const b = el('button', null, a.label);
      b.title = a.hint;
      b.setAttribute('aria-pressed', String(a.key === this.aggregate));
      b.onclick = () => this.setAggregate(a.key);
      this.modes.appendChild(b);
    }
    const label = el('span', 'ynow');
    this.nowLabel = label;
    this.modes.appendChild(label);
  }

  _ruler() {
    this.ruler.innerHTML = '';
    // One tick per month, positioned by the day index its first day sits at, so
    // the ruler cannot drift from the strip when the window starts mid-month.
    let last = null;
    this.days.forEach((d, i) => {
      if (d.month === last) return;
      last = d.month;
      const t = el('i', null, MONTH_SHORT[d.month - 1]);
      t.style.left = `${(i / (this.days.length - 1)) * 100}%`;
      t.title = `${d.date}`;
      this.ruler.appendChild(t);
    });
  }

  _events() {
    const pick = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      return Math.round(f * (this.days.length - 1));
    };
    let dragging = false;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.select(pick(e));
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const i = pick(e);
      if (dragging) this.select(i);
      else this._showTip(i, e.clientX);
    });
    this.canvas.addEventListener('pointerup', () => { dragging = false; });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null; this.tip.hidden = true; this.draw();
    });
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft' && e.shiftKey) { this.select(this.index - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight' && e.shiftKey) { this.select(this.index + 1); e.preventDefault(); }
    });
    window.addEventListener('resize', () => this.resize());
  }

  _showTip(i, clientX) {
    const d = this.days[i];
    if (!d) return;
    this.hover = i;
    const ep = this._episodeAt(i);
    // The provenance of the day, in the tooltip, because that is where somebody
    // deciding whether to scrub here is looking. A solved day and a reconstructed
    // one are different claims, and the reconstructed one carries the error the
    // pipeline measured for that specific day rather than a general caveat.
    const solved = d.solved || d.date === this.d.eventDate;
    const prov = d.date === this.d.eventDate ? '<span class="solved">measured</span>'
      : solved ? '<span class="solved">solved</span>'
      : (d.recon_p95 != null
        ? `<span class="recon">reconstructed ±${d.recon_p95.toFixed(1)} K</span>`
        : '<span class="recon">reconstructed</span>');
    this.tip.innerHTML =
      `<b>${d.date}</b> · max <b>${d.tmax.toFixed(1)} °C</b> · min <b>${d.tmin.toFixed(1)} °C</b>`
      + (d.h35 ? ` · <b>${d.h35}h</b> over 35 °C` : '')
      + (d.trop ? ' · <span class="trop">tropical night</span>' : '')
      + (ep ? ` · <span class="ep">${ep.days}-day episode</span>` : '')
      + ` · ${prov}`;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 90), r.width - 90);
    this.tip.style.left = `${x}px`;
    this.tip.hidden = false;
    this.draw();
  }

  _episodeAt(i) {
    const date = this.days[i]?.date;
    if (!date) return null;
    return (this.d.year.episodes || []).find((e) => date >= e.start && date <= e.end);
  }

  setAggregate(key) {
    this.aggregate = key;
    for (const b of this.modes.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.textContent ===
        AGGREGATES.find((a) => a.key === key).label));
    }
    this.onPick(this.days[this.index].date, key);
    this.draw();
  }

  select(i) {
    const idx = Math.min(this.days.length - 1, Math.max(0, i));
    if (idx === this.index) { this.draw(); return; }
    this.index = idx;
    this.onPick(this.days[idx].date, this.aggregate);
    this.draw();
  }

  /** Move to a date without firing the callback — used when the agent sets it. */
  syncTo(date, aggregate) {
    const i = this.d.dateToDay.get(date);
    if (i !== undefined) this.index = i;
    if (aggregate) {
      this.aggregate = aggregate;
      for (const b of this.modes.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b.textContent ===
          AGGREGATES.find((a) => a.key === aggregate)?.label));
      }
    }
    this.draw();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = DPR();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(48 * dpr));
    this.draw();
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    const dpr = DPR();
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const n = this.days.length;
    const bw = W / n;
    const pad = 5 * dpr;
    const usable = H - pad * 2 - 7 * dpr;

    const span = Math.max(1e-6, this.hi - this.lo);
    const yOf = (t) => pad + usable * (1 - (t - this.lo) / span);

    // Season bands, so the eye finds July without reading the ruler.
    const seasonColour = {
      12: 'rgba(78,168,222,.05)', 1: 'rgba(78,168,222,.05)', 2: 'rgba(78,168,222,.05)',
      6: 'rgba(232,103,79,.06)', 7: 'rgba(232,103,79,.06)', 8: 'rgba(232,103,79,.06)',
    };
    for (let i = 0; i < n; i++) {
      const c = seasonColour[this.days[i].month];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(i * bw, 0, bw + 0.6, H);
    }

    // The 18 degC balance point: above it the city is cooling, below it heating.
    // Drawn because it is the line the degree-day metrics are defined against.
    ctx.strokeStyle = 'rgba(255,255,255,.09)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, yOf(18)); ctx.lineTo(W, yOf(18)); ctx.stroke();

    for (let i = 0; i < n; i++) {
      const d = this.days[i];
      const x = i * bw;
      const yTop = yOf(d.tmax);
      const yMin = yOf(d.tmin);
      // The day's range as a column, coloured by its maximum.
      const c = RAMPS.temperature(norm(d.tmax, this.rampLo, this.rampHi));
      ctx.fillStyle = css(c);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, yTop, Math.max(bw - 0.35, 0.7), Math.max(yMin - yTop, dpr));
      // The overnight minimum as a darker base. A tropical night is a thick warm
      // one, and that is the metric the epidemiology cares about most.
      ctx.globalAlpha = d.trop ? 0.95 : 0.35;
      ctx.fillStyle = d.trop ? '#e8674f' : 'rgba(255,255,255,.20)';
      ctx.fillRect(x, yMin, Math.max(bw - 0.35, 0.7), Math.max(pad + usable - yMin, dpr));
      ctx.globalAlpha = 1;
    }

    // Heat-wave episodes, bracketed. Found by run length in the pipeline.
    ctx.fillStyle = 'rgba(232,103,79,.85)';
    for (const ep of (this.d.year.episodes || [])) {
      const a = this.d.dateToDay.get(ep.start);
      const b = this.d.dateToDay.get(ep.end);
      if (a === undefined || b === undefined) continue;
      ctx.fillRect(a * bw, 1 * dpr, Math.max((b - a + 1) * bw, 2 * dpr), 2 * dpr);
    }

    // The thirteen solved days. The event day is a different mark from the twelve
    // monthly ones because it does not rest on the same evidence: FortyGuard
    // measured it, and reanalysis anchors the rest.
    const solved = [{ date: this.d.eventDate, event: true }].concat(
      (this.d.year.periods.months || []).map((m) => ({ date: m.date, event: false })));
    for (const s of solved) {
      const i = this.d.dateToDay.get(s.date);
      if (i === undefined) continue;
      ctx.fillStyle = s.event ? '#5ad1a5' : 'rgba(154,165,184,.75)';
      const w = s.event ? 2.4 * dpr : 1.6 * dpr;
      ctx.fillRect(i * bw + bw / 2 - w / 2, H - 5 * dpr, w, 4 * dpr);
    }

    // Hover, then the selection on top.
    if (this.hover !== null && this.hover !== this.index) {
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(this.hover * bw + bw / 2, 0);
      ctx.lineTo(this.hover * bw + bw / 2, H);
      ctx.stroke();
    }
    const selX = this.index * bw + bw / 2;
    ctx.strokeStyle = '#4ea8de';
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    ctx.moveTo(selX, 0); ctx.lineTo(selX, H); ctx.stroke();
    ctx.fillStyle = '#4ea8de';
    ctx.beginPath();
    ctx.arc(selX, 3.5 * dpr, 2.6 * dpr, 0, Math.PI * 2);
    ctx.fill();

    // When an aggregate is showing, the whole span it covers is lit rather than
    // one column, because that is what is on screen.
    const span2 = this._activeSpan();
    if (span2) {
      ctx.fillStyle = 'rgba(78,168,222,.10)';
      ctx.fillRect(span2[0] * bw, 0, (span2[1] - span2[0] + 1) * bw, H);
    }

    this._label();
  }

  _activeSpan() {
    if (this.aggregate === 'day') return null;
    const d = this.days[this.index];
    if (this.aggregate === 'year') return [0, this.days.length - 1];
    const months = this.aggregate === 'month'
      ? [d.month]
      : (Object.values({ summer: [6, 7, 8], autumn: [9, 10, 11], winter: [12, 1, 2], spring: [3, 4, 5] })
        .find((ms) => ms.includes(d.month)) || [d.month]);
    let lo = Infinity, hi = -Infinity;
    this.days.forEach((x, i) => {
      if (months.includes(x.month)) { lo = Math.min(lo, i); hi = Math.max(hi, i); }
    });
    return isFinite(lo) ? [lo, hi] : null;
  }

  _label() {
    const d = this.days[this.index];
    const t = this.d.time || {};
    const bits = [];
    if (this.aggregate === 'year') bits.push('Whole year');
    else if (this.aggregate === 'season') bits.push(`${cap(t.aggregateName || '')} mean`);
    else if (this.aggregate === 'month') {
      const m = this.d.months.find((x) => x.month === d.month);
      bits.push(`${m ? m.label : ''} — ${m ? m.rep_date : ''}`);
    } else bits.push(d.date);

    if (this.aggregate === 'day') {
      bits.push(d.date === this.d.eventDate
        ? 'measured anchor'
        : (t.reconstructed ? 'reconstructed from its month' : 'solved'));
    }
    this.nowLabel.innerHTML = bits.map((b, i) => i === 0
      ? `<b>${b}</b>` : `<span class="dim">${b}</span>`).join(' · ');
  }
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

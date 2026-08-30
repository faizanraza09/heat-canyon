/* The analyst console: a streaming transcript that also drives the city.
 *
 * WHAT THIS IS NOT
 *
 * It is not a chat box. A chat box takes a question, shows a spinner, and prints
 * a paragraph, and everything that made the answer trustworthy happens where
 * nobody can see it. The whole claim this project makes about its analyst is that
 * every number came out of the model, and a claim like that is worth exactly as
 * much as the evidence on screen.
 *
 * So the transcript shows the work. Every tool call appears as it is made, with
 * its arguments and a digest of what came back, in order. The summarised
 * reasoning appears too, because watching the analyst choose between
 * `query_buildings` and a script is most of how a reviewer decides whether to
 * believe the answer. A reader who wants to check a figure can read the query
 * that produced it and run it themselves.
 *
 * AND IT DRIVES THE MAP
 *
 * When the agent calls `map_control`, that arrives here as a frame like any other
 * and is applied to the scene: the layer changes, the year scrubs to the date, the
 * buildings it is naming light up. The answer happens on the city rather than
 * beside it. There is no second channel and no polling — a map action is a
 * transcript entry, which also means a console that reconnects mid-run replays the
 * actions in the order they were issued and ends up in the right state.
 *
 * TWO BACKENDS, ONE INTERFACE
 *
 * `/api/agent/*` is the real analyst: a Claude Agent SDK turn with a shell, a
 * workspace, twenty tools and three specialists. `/api/ask` is the older
 * single-shot loop, kept because it needs nothing but an API key. If the agent
 * cannot start, this falls back to the single-shot path and says which one
 * answered rather than pretending the capability is there.
 */

import { api } from './api.js';
/* What each call is called on the record.
 *
 * The transcript is the evidence for an answer, so it stays: a figure you cannot
 * trace is a figure you should not act on. But the evidence is what the analyst
 * DID, not the symbol the function happens to carry, and `query_buildings
 * scope=scored sort_by=annual_facade_kh35` is the second of those. Each call is
 * named in the analyst's own register, and the raw call is still one click away
 * underneath for anyone who wants to check the arguments. */
const WORKINGS = {
  area_summary: 'Took in the whole study area',
  data_dictionary: 'Checked what the model holds',
  query_buildings: 'Searched the buildings',
  get_building: 'Pulled a building\u2019s file',
  canyon_stats: 'Measured the street canyons',
  year_series: 'Followed it through the year',
  climatology: 'Went to the climatology',
  compare_periods: 'Set two periods against each other',
  panel_field: 'Read the facade panels',
  tile_field: 'Read the ground tiles',
  scenario_results: 'Looked up the solved scenarios',
  spatial_pattern: 'Tested whether the pattern is real',
  run_intervention: 'Re-solved the physics for a measure',
  intervention_catalogue: 'Consulted the catalogue of measures',
  allocate_budget: 'Allocated the budget',
  map_control: 'Moved the map',
  consult_specialist: 'Called in a specialist',
  methodology: 'Checked how that was computed',
  run_python: 'Wrote and ran a script',
  chart: 'Drew a chart',
  building_schedule: 'Went through a building floor by floor',
  prescribe_building: 'Worked out what to do about it',
  programme_allocation: 'Spread a budget across the portfolio',
  economic_constants: 'Checked the money table',
  WebSearch: 'Searched the web',
  WebFetch: 'Read a page off the web',
  Bash: 'Ran a command',
  Read: 'Read a file it had written',
  Write: 'Wrote a file',
  Edit: 'Edited a file',
  Glob: 'Looked through its workspace',
  Grep: 'Searched its workspace',
};

/* The same calls again, phrased for the one line the collapsed working shows.
 *
 * A digest is a list of the KINDS of work a turn was made of, so these carry no
 * article and no singular: four of them have to read as one sentence about the
 * turn, not as four sentences about four calls. "Wrote and ran a script" is the
 * right caption for one chip and the wrong third of a sentence that also has to
 * say the analyst did it nineteen times.                                      */
const DIGESTS = {
  area_summary: 'took in the study area',
  data_dictionary: 'checked what the model holds',
  query_buildings: 'searched the buildings',
  get_building: 'pulled building files',
  canyon_stats: 'measured the street canyons',
  year_series: 'followed it through the year',
  climatology: 'went to the climatology',
  compare_periods: 'set periods against each other',
  panel_field: 'read the facade panels',
  tile_field: 'read the ground tiles',
  scenario_results: 'looked up solved scenarios',
  spatial_pattern: 'tested whether the pattern is real',
  run_intervention: 're-solved the physics',
  intervention_catalogue: 'consulted the catalogue of measures',
  allocate_budget: 'allocated the budget',
  map_control: 'moved the map',
  consult_specialist: 'called in specialists',
  methodology: 'checked how things were computed',
  run_python: 'wrote and ran scripts',
  chart: 'drew charts',
  building_schedule: 'went through buildings floor by floor',
  prescribe_building: 'worked out what to do about them',
  programme_allocation: 'spread budgets across the portfolio',
  economic_constants: 'checked the money table',
  WebSearch: 'searched the web',
  WebFetch: 'read pages off the web',
  Bash: 'worked in the shell',
  Read: 'read files back',
  Write: 'wrote files',
  Edit: 'edited files',
  Glob: 'looked through its workspace',
  Grep: 'searched its workspace',
};

/** A call's kind, phrased for the digest line. */
function digest(name) {
  const bare = String(name || '').replace(/^mcp__[a-z0-9_]+__/i, '');
  if (DIGESTS[bare]) return DIGESTS[bare];
  const w = working(bare);
  return w.charAt(0).toLowerCase() + w.slice(1);
}

/** A call's name on the record. Anything unlisted is de-jargonised rather than
 *  dropped, so a new tool reads as a sentence on the day it is added. */
function working(name) {
  const bare = String(name || '').replace(/^mcp__[a-z0-9_]+__/i, '');
  if (WORKINGS[bare]) return WORKINGS[bare];
  const words = bare.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : 'Worked';
}

/* Calls that are plumbing rather than evidence, and are kept off the record. */
const UNLOGGED = new Set(['ToolSearch', 'TodoWrite']);

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Markdown, as much of it as an analyst actually writes.
 *
 * The previous renderer knew about bold, code and bullets, so an answer that
 * organised itself under headings and put its numbers in a table arrived as
 * literal "## What it buys in July" and a wall of pipes. The analyst is
 * instructed to structure its answers; this is the half that keeps that promise.
 *
 * Block level: headings, fenced code, tables, blockquotes, rules, ordered and
 * unordered lists. Inline: bold, italic, code, links. Everything is escaped
 * first and the markup is built from the escaped text, so a stray < in a result
 * cannot become an element.                                                   */

const INLINE = (t) => t
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\(hc:building\/(\d+)\)/g,
           '<button type="button" class="hcbuilding" data-bin="$2">$1</button>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
           '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  // A link to nowhere is a dead control. If one gets written anyway, it goes out
  // as plain text rather than as something that looks clickable and is not.
  .replace(/\[([^\]]+)\]\(#?\)/g, '$1');

/** Split a table row on unescaped pipes. */
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Does line `j` open a block, and so end the paragraph running into it?
 *
 *  A paragraph ends at a blank line, not at a line break, and that is not a
 *  detail. The renderer used to close a `<p>` on every newline, so a sentence
 *  the model had soft-wrapped arrived as two paragraphs and the second one
 *  started with whatever word the wrap happened to fall on: a lower-case
 *  fragment sitting where a paragraph should be. The block openers are listed
 *  here rather than guessed at, and a table only counts as one when the
 *  delimiter row underneath it is actually there.                            */
const OPENS_BLOCK = (lines, j) => {
  const l = lines[j];
  if (/^\s*```/.test(l)) return true;
  if (/^\s*#{1,4}\s/.test(l)) return true;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return true;
  if (/^\s*&gt;\s?/.test(l)) return true;
  if (/^\s*[-*+]\s+/.test(l)) return true;
  if (/^\s*\d+[.)]\s+/.test(l)) return true;
  return /\|/.test(l) && j + 1 < lines.length && /\|/.test(lines[j + 1])
    && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[j + 1]);
};

function md(text) {
  const lines = esc(String(text ?? '')).split('\n');
  const out = [];
  let i = 0;
  let list = null;          // 'ul' | 'ol' | null

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // ---- fenced code
    const fence = line.match(/^\s*```+\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      closeList();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre class="acode"><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    // ---- table: a header row, a delimiter row, then body rows
    if (/\|/.test(line) && i + 1 < lines.length
        && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      closeList();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (
        /^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : 'left'));
      i += 2;
      const body = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) body.push(cells(lines[i++]));
      const th = head.map((c, k) =>
        `<th style="text-align:${align[k] || 'left'}">${INLINE(c)}</th>`).join('');
      const tr = body.map((r) => `<tr>${r.map((c, k) =>
        `<td style="text-align:${align[k] || 'left'}">${INLINE(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="atable"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }

    // ---- heading
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = Math.min(h[1].length + 1, 5);
      out.push(`<h${lvl} class="ah${h[1].length}">${INLINE(h[2].replace(/\s*#+\s*$/, ''))}</h${lvl}>`);
      i++;
      continue;
    }

    // ---- rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList(); out.push('<hr class="arule">'); i++; continue;
    }

    // ---- blockquote, which is where a caveat belongs
    if (/^\s*&gt;\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="acallout">${INLINE(body.join(' '))}</blockquote>`);
      continue;
    }

    // ---- lists
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${INLINE(bullet ? bullet[1] : num[1])}</li>`);
      i++;
      continue;
    }

    // ---- paragraph, which runs on until a blank line or another block
    closeList();
    if (line.trim()) {
      const para = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !OPENS_BLOCK(lines, i)) {
        para.push(lines[i].trim());
        i++;
      }
      out.push(`<p>${INLINE(para.join(' '))}</p>`);
      continue;
    }
    i++;
  }
  closeList();
  return out.join('');
}


export class AgentConsole {
  /**
   * @param {HTMLElement} host
   * @param {object} data
   * @param {(action:object)=>void} onMapAction
   */
  constructor(host, data, onMapAction) {
    this.d = data;
    this.onMapAction = onMapAction || (() => {});
    this.envelope = null;
    this.sessionId = null;      // carries the conversation forward
    this.runId = null;
    this.stream = null;
    this.toolNodes = new Map();
    this.mode = 'agent';
    this.work = null;       // this turn's working, one block for the whole turn
    this.pending = null;    // the last text block, until a call demotes it
    this.workKinds = new Map();
    this.workSteps = 0;

    host.innerHTML = '';
    host.classList.add('agentconsole');
    this.el = host;

    /* Three bands, and only the middle one scrolls.
     *
     * It used to be header, composer, six suggestion chips, THEN the transcript,
     * all inside the panel's own scroller — so an answer arrived below the
     * onboarding, off the bottom of a page you had to scroll to reach, in a box
     * with a second scrollbar of its own. A conversation reads top to bottom and
     * is typed at the bottom, so that is the shape: a fixed header, the
     * transcript taking whatever height is left, and the composer pinned under
     * it. The suggestions are an empty state rather than furniture — they are
     * there to start the first question and gone once there is a thread. */
    this.head = el('div', 'agenthead');
    this.scroll = el('div', 'ascroll');
    // Named so the walkthrough can scroll it. The console scrolls itself while
    // a turn streams, which is right for a reader watching one arrive and wrong
    // for a film: a recorded turn replays off disk in a second or two, so by the
    // time the narration says anything the transcript is already at the bottom
    // and never moves again.
    this.scroll.id = 'agent-scroll';
    this.empty = el('div', 'aempty');
    this.transcript = el('div', 'transcript');
    this.scroll.append(this.empty, this.transcript);
    this.form = el('div', 'agentform');
    this.input = el('textarea');
    this.input.rows = 3;
    this.input.placeholder = 'Ask Umbra about a building, a street, or a measure\u2026';
    this.send = el('button', 'primary', 'ASK');
    this.stop = el('button', 'ghost', 'STOP');
    this.stop.hidden = true;
    this.newThread = el('button', 'ghost', 'NEW THREAD');
    this.newThread.title = 'Forget the conversation so far and start clean';
    const btns = el('div', 'agentbtns');
    btns.append(this.send, this.stop, this.newThread);
    this.chips = el('div', 'agentchips');
    this.form.append(this.input, btns);

    this.el.append(this.head, this.scroll, this.form);

    this.send.onclick = () => this.ask(this.input.value.trim());
    this.stop.onclick = () => this.interrupt();
    this.newThread.onclick = () => {
      this.sessionId = null;
      this.transcript.innerHTML = '';
      this.work = null;
      this.pending = null;
      this._syncEmpty();
      this._note('New thread. The analyst has forgotten the conversation; the model '
                 + 'itself is unchanged.');
    };
    this.input.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.send.onclick();
    };

    // Delegated, so it covers bubbles that do not exist yet.
    this.transcript.addEventListener('click', (e) => {
      const b = e.target.closest?.('.hcbuilding');
      if (!b) return;
      e.preventDefault();
      this.onMapAction?.({ focus_bin: b.dataset.bin });
    });

    this._loadEnvelope();
  }

  /** Put the caret in the composer. Called when the window opens. */
  focus() { this.input?.focus(); }

  async _loadEnvelope() {
    try {
      const r = await fetch(api('/api/agent/envelope'));
      this.envelope = await r.json();
    } catch (e) {
      this.envelope = { available: false, unavailable_because: 'Server not reachable.' };
    }
    this._renderHead();
    this._renderChips();
    if (!this.envelope.available) {
      // Fall back rather than disabling the tab: the single-shot analyst still
      // answers questions, and saying which one answered is more useful than
      // hiding the feature.
      try {
        const h = await (await fetch(api('/api/health'))).json();
        this.mode = h.legacy_ai_available ? 'single-shot' : 'none';
      } catch { this.mode = 'none'; }
      // Enough for the person in front of it to know what they have lost, and a
      // pointer for whoever runs the server. The authentication details live in
      // the documentation rather than on a stranger's screen.
      this._note(this.envelope.unavailable_because
        + (this.mode === 'single-shot'
          ? ' A reduced analyst is answering instead: it can read the model, but '
            + 'it cannot re-solve interventions, run statistics or write scripts.'
          : ' The analyst is not reachable from this server. Everything else in '
            + 'the application works without it; see docs/AGENT.md to enable it.'));
    }
  }

  /* What the header says, and what it deliberately does not.
   *
   * It used to read CLAUDE-SONNET-5 · 20 TOOLS · 3 SPECIALISTS · NO WEB · $0.99
   * / $40.00, which is a description of the machinery rather than of the
   * analyst. None of it is anything the person asking about a building wants,
   * and a running meter above the composer makes a question feel metered.
   *
   * What is left is a state: whether it is listening or working, and one
   * standing claim about the answers rather than about the machinery — that the
   * figures come out of the model and anything read outside it is labelled as
   * such. That is a promise the reader can check, which is the only kind worth
   * printing. */
  _renderHead() {
    const e = this.envelope || {};
    this.head.innerHTML = '';
    const row = el('div', 'ahrow');

    this.state = el('span', 'astate');
    row.appendChild(this.state);

    if (e.available) {
      row.appendChild(el('span', 'aprov',
        'EVERY FIGURE TRACED TO A COMPUTATION · OUTSIDE SOURCES CITED'));
    }
    this.head.appendChild(row);
    this._setState(e.available ? 'ready' : 'down');
  }

  /** Listening, working, or not here. The only status the window carries. */
  _setState(kind, text) {
    if (!this.state) return;
    const LABEL = { ready: 'READY', working: 'WORKING', down: 'UNAVAILABLE' };
    this.state.className = `astate ${kind}`;
    this.state.textContent = text || LABEL[kind] || '';
  }

  /* The empty state: what this thing does, and six ways to start. Both are
     onboarding, so both are inside the scroller and both go away for good the
     moment there is a thread to read. */
  _renderChips() {
    const e = this.envelope || {};
    const s = e.suggestions || [];
    // No lede here: the window's own header carries it, and saying it twice on
    // the same screen is worse than not saying it at all.
    this.empty.innerHTML = '';
    this.chips.innerHTML = '';
    if (s.length) {
      this.empty.appendChild(el('span', 'klabel', 'TRY ONE'));
      for (const q of s.slice(0, 6)) {
        const c = el('button', null, q);
        c.onclick = () => this.ask(q);
        this.chips.appendChild(c);
      }
      this.empty.appendChild(this.chips);
    }
    this._syncEmpty();
  }

  /** The onboarding is showing exactly while there is nothing else to show. */
  _syncEmpty() {
    this.empty.hidden = this.transcript.children.length > 0;
  }

  /* ------------------------------------------------------------- asking */

  async ask(question) {
    if (!question || this.runId) return;
    this.empty.hidden = true;
    this.input.value = '';
    // One working per turn, so the next question opens a fresh one rather than
    // reopening the last turn's drawer and appending to it.
    this.work = null;
    this.pending = null;
    this._bubble('you', md(question));

    if (this.mode === 'single-shot') return this._askSingleShot(question);
    if (this.mode === 'none') {
      this._note('No analyst backend is available.');
      return;
    }

    this.send.disabled = true;
    this.stop.hidden = false;
    const status = this._status('Reading the question');
    try {
      const r = await fetch(api('/api/agent/ask'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, resume: this.sessionId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
      this.runId = j.run_id;
      status.textContent = j.state === 'queued'
        ? `queued behind ${j.ahead_of_you} other question(s)…` : 'working…';
      this._listen(j.run_id, status);
    } catch (e) {
      status.remove();
      this._note(`Could not start: ${e.message}`);
      this._finish();
    }
  }

  /** Play a finished run back into the transcript.
   *
   * The server keeps every turn as JSONL and replays it to any listener that
   * asks, which is there so a dropped connection costs nothing. It also means a
   * turn that has already been done can be shown again exactly as it happened —
   * the same tool calls in the same order, the same figures, the same answer.
   *
   * The walkthrough uses this for its last chapter. Asking the analyst live on
   * camera would mean waiting minutes for a real turn, spending money every
   * time the film plays, and putting whatever the model said that afternoon in
   * front of whoever is watching. Replaying a run that was genuinely made is
   * the same evidence without any of that. It is not a mock: every frame in it
   * came back from the real agent doing real work.
   */
  replay(runId, question) {
    if (!runId || this.runId) return;
    try { this.stream?.close(); } catch { /* already gone */ }
    this.stream = null;
    this.transcript.innerHTML = '';
    this.empty.hidden = true;
    this.work = null;
    this.pending = null;
    // The question first, so the transcript reads as a turn rather than as an
    // answer that arrived on its own.
    if (question) this._bubble('you', md(question));
    this.send.disabled = true;
    this.stop.hidden = false;
    this.runId = runId;
    // `_listen` writes the run's progress into a status line and is handed one
    // by `ask`. Replaying has to supply the same thing: without it the first
    // frame off the wire sets `.textContent` on undefined and the whole replay
    // dies silently behind an unhandled rejection.
    this._listen(runId, this._status('Replaying'));
  }

  _listen(runId, status) {
    // EventSource rather than fetch+ReadableStream: it reconnects on its own, and
    // the server replays from the run's JSONL on reconnect, so a dropped
    // connection costs nothing. The one thing it cannot do is stop by itself, so
    // the terminal frame closes it explicitly.
    const es = new EventSource(api(`/api/agent/runs/${runId}/events`));
    this.stream = es;
    let sawText = false;
    let live = false;

    es.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      switch (f.type) {
        case 'replay_done':
          live = true;
          break;
        case 'run_started':
          status.textContent = 'Working';
          this._setState('working');
          break;
        case 'thinking':
          this._thinking(f.text);
          break;
        case 'text':
          sawText = true;
          this._bubble('agent', md(f.text));
          break;
        case 'tool_use':
          this._tool(f);
          break;
        case 'tool_result':
          this._toolResult(f);
          break;
        case 'map':
          this._mapFrame(f);
          break;
        case 'chart':
          this._chart(f);
          break;
        case 'blocked':
          this._note(`Refused: ${f.reason}`, 'warn');
          break;
        case 'usage':
          // The count belongs to the working, which is already showing it and
          // showing what the steps were. Two counts on adjacent lines, taken
          // from two different tallies, read as an inconsistency rather than as
          // progress, so the status line keeps only the state.
          break;
        case 'turn_complete':
          if (f.session_id) this.sessionId = f.session_id;
          break;
        case 'error':
          this._note(f.message, 'warn');
          break;
        case 'run_finished':
          if (f.session_id) this.sessionId = f.session_id;
          this._closeRun(f, status, sawText);
          es.close();
          break;
        default:
          break;
      }
      this._scroll();
    };
    es.onerror = () => {
      // EventSource retries on its own; only report if the run is already done.
      if (!this.runId) es.close();
    };
  }

  _closeRun(f, status, sawText) {
    const bits = [];
    if (f.state && f.state !== 'finished') bits.push(f.state.replace('_', ' '));
    if (f.seconds != null) bits.push(`${Math.round(f.seconds)}s`);
    status.textContent = bits.join(' · ') || 'Done';
    status.classList.add('done');
    if (f.state === 'cut_off') {
      this._note('This turn reached its limit. What it had produced is above; '
                 + 'ask a narrower question to finish the '
                 + 'thought.', 'warn');
    } else if (f.state === 'timeout') {
      this._note('The turn ran past its time limit and was stopped.', 'warn');
    } else if (f.state === 'interrupted') {
      this._note('Stopped.', 'warn');
    } else if (f.error) {
      this._note(f.error, 'warn');
    } else if (!sawText) {
      this._note('The turn finished without producing an answer. Ask again.', 'warn');
    }
    this._finish();
  }

  async _askSingleShot(question) {
    this.send.disabled = true;
    const status = this._status('thinking…');
    try {
      const r = await fetch(api('/api/ask'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const j = await r.json();
      status.remove();
      if (j.error) this._note(j.error, 'warn');
      else {
        this._bubble('agent', md(j.answer || ''));
        if (j.trace?.length) {
          this._note(`Answered from ${j.trace.length} quer`
            + `${j.trace.length === 1 ? 'y' : 'ies'}: `
            + j.trace.map((t) => t.tool).join(', ') + '.');
        }
      }
    } catch (e) {
      status.remove();
      this._note(`Request failed: ${e.message}`, 'warn');
    }
    this.send.disabled = false;
  }

  async interrupt() {
    if (!this.runId) return;
    try {
      await fetch(api(`/api/agent/runs/${this.runId}/interrupt`), { method: 'POST' });
    } catch { /* the stream will report the state */ }
  }

  _finish() {
    this._setState(this.envelope?.available ? 'ready' : 'down');
    this.runId = null;
    this.send.disabled = false;
    this.stop.hidden = true;
    if (this.stream) { this.stream.close(); this.stream = null; }
  }

  /* ------------------------------------------------------- rendering */

  /* THE WORKING, AS ONE CLOSED DRAWER
   *
   * A turn can be fifty-six calls. As a wrapping row of chips that was six
   * lines of apparatus; as two rows split by a note the analyst made to itself
   * mid-run it was the whole panel, and the answer — the thing the person
   * opened the window for — began somewhere below the fold. The evidence has to
   * stay, because an untraceable figure is the one failure this project cannot
   * have. It does not have to be the first thing on screen.
   *
   * So a turn has exactly one working: a single closed block, carrying a line
   * that says how many steps it took and what kinds of work they were, holding
   * every chip, every burst of reasoning, every map move and every aside. Shut,
   * it is one line and the answer sits directly under it. Open, it is the same
   * record it always was, in the same order it happened.                      */
  _work() {
    if (this.work && this.work.isConnected) return this.work;
    const d = el('details', 'workblock');
    const sum = el('summary');
    sum.innerHTML = '<span class="wlabel">The working</span>'
      + '<span class="wdigest"></span>';
    d.appendChild(sum);
    const row = el('div', 'workings');
    d.appendChild(row);
    this.transcript.appendChild(d);
    this.work = d;
    this.workKinds = new Map();
    this.workSteps = 0;
    this._syncWork();
    return d;
  }

  /** The chip row inside this turn's working. */
  _workings() { return this._work().querySelector('.workings'); }

  /* What the closed drawer says it contains.
   *
   * Not "42 tool calls", which is a fact about the machinery and tells a reader
   * nothing they can use. The count, and then the four kinds of work the turn
   * was mostly made of, in the analyst's own register: "56 steps: wrote and ran
   * scripts, worked in the shell, pulled building files, re-solved the physics".
   * That is a description of an afternoon's work, and it is enough to decide
   * whether you want to open it. It is rebuilt on every step, so a turn still
   * running reads as a live account of what it is doing.                      */
  _syncWork() {
    if (!this.work) return;
    const line = this.work.querySelector('.wdigest');
    const n = this.workSteps;
    if (!n) { line.textContent = 'getting its bearings'; return; }
    const kinds = [...this.workKinds.entries()].sort((a, b) => b[1] - a[1]);
    const lead = kinds.slice(0, 4).map(([k]) => k);
    const rest = kinds.length - lead.length;
    line.textContent = `${n} step${n === 1 ? '' : 's'}: ${lead.join(', ')}`
      + (rest > 0 ? `, and ${rest} other kind${rest === 1 ? '' : 's'} of work` : '');
  }

  /** Count one step towards the digest. */
  _step(name) {
    const k = digest(name);
    this.workKinds.set(k, (this.workKinds.get(k) || 0) + 1);
    this.workSteps += 1;
    this._syncWork();
  }

  /* A paragraph the analyst wrote on its way to the answer is working, not
   * answer, and the difference is only knowable in hindsight: text that turns
   * out to be followed by more calls was a note to itself. So every text block
   * arrives as the answer and is demoted the moment the next call proves it was
   * not one. That is what keeps "Good, index 3412 = building. Now find panels
   * of this building" out of the same typeface as the finding it led to.      */
  _demote() {
    const b = this.pending;
    this.pending = null;
    if (!b || !b.isConnected) return;
    b.classList.remove('bubble', 'agent');
    b.classList.add('aside');
    this._workings().appendChild(b);
  }

  _bubble(who, html) {
    // Two text blocks with nothing between them are one answer arriving in two
    // pieces, and printing them as two bubbles puts a gap through the middle of
    // it and sets the second half's opening line as a second lede.
    if (who === 'agent' && this.pending
        && this.pending === this.transcript.lastElementChild) {
      this.pending.insertAdjacentHTML('beforeend', html);
      this._scroll();
      return this.pending;
    }
    const b = el('div', `bubble ${who}`);
    b.innerHTML = html;
    this.transcript.appendChild(b);
    if (who === 'agent') this.pending = b;
    this._scroll();
    return b;
  }

  _status(text) {
    const s = el('div', 'runstatus', text);
    this.transcript.appendChild(s);
    return s;
  }

  _note(text, kind) {
    const n = el('p', `anote ${kind || ''}`, esc(text));
    this.transcript.appendChild(n);
    this._scroll();
    return n;
  }

  _thinking(text) {
    // Collapsed by default and one node per burst: the reasoning is worth having
    // available and not worth pushing the answer off screen.
    this._demote();
    const row = this._workings();
    let node = row.lastElementChild;
    if (!node || !node.classList.contains('thinkblock')) {
      node = el('details', 'thinkblock');
      node.appendChild(el('summary', null, 'reasoning'));
      node.appendChild(el('div', 'thinkbody'));
      row.appendChild(node);
    }
    node.querySelector('.thinkbody').appendChild(el('p', null, esc(text)));
  }

  _tool(f) {
    if (UNLOGGED.has(String(f.name).replace(/^mcp__[a-z0-9_]+__/i, ''))) {
      this.toolNodes.set(f.id, null);
      return;
    }
    this._demote();
    this._work();
    this._step(f.name);
    const node = el('details', 'toolcall');
    const sum = el('summary');
    // The face of the chip is what was done. The arguments are real evidence and
    // they are also forty characters of `scope=scored sort_by=annual_priority`,
    // which at chip size is a wrapped line of noise: they live inside.
    sum.innerHTML = `<span class="tname">${esc(working(f.name))}</span>`;
    node.appendChild(sum);
    const body = el('div', 'toolbody');
    body.appendChild(el('p', 'tcall', esc(String(f.name).replace(/^mcp__[a-z0-9_]+__/i, ''))));
    body.appendChild(el('pre', 'in', esc(pretty(f.input))));
    node.appendChild(body);
    this._workings().appendChild(node);
    this.toolNodes.set(f.id, node);
  }

  _toolResult(f) {
    if (this.toolNodes.has(f.tool_use_id) && !this.toolNodes.get(f.tool_use_id)) return;
    const row = this.toolNodes.get(f.tool_use_id);
    // A result whose call never arrived — a console that connected mid-run, a
    // frame lost — still belongs with the working rather than loose in the
    // transcript, where it would sit between the working and the answer.
    const target = row ? row.querySelector('.toolbody') : this._workings();
    const pre = el('pre', `out ${f.is_error ? 'err' : ''}`, esc(pretty(f.content)));
    target.appendChild(pre);
    if (row && f.is_error) row.classList.add('failed');
  }

  _mapFrame(f) {
    const { type, at, ...action } = f;
    const parts = Object.entries(action)
      .filter(([k]) => k !== 'kind' && k !== 'unknown_bins')
      .map(([k, v]) => `${k} ${Array.isArray(v) ? `${v.length}` : v}`);
    const n = el('div', 'mapact');
    n.innerHTML = `<b>map</b> ${esc(parts.join(' · '))}`
      + (action.note ? `<span class="mnote">${esc(action.note)}</span>` : '');
    // A map move is something the analyst did, not something it said: it belongs
    // in the record with the calls, and its effect is already on the city.
    this._demote();
    this._workings().appendChild(n);
    try { this.onMapAction(action); } catch (e) { console.warn('map action', e); }
  }

  _chart(f) {
    const w = el('figure', 'agentchart');
    const img = el('img');
    img.src = f.url;
    img.alt = f.title || 'chart';
    w.appendChild(img);
    if (f.title) w.appendChild(el('figcaption', null, esc(f.title)));
    this.transcript.appendChild(w);
  }

  _scroll() {
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }
}

function shortArgs(input) {
  const o = parseMaybe(input);
  if (!o || typeof o !== 'object') return typeof input === 'string' ? clip(input, 70) : '';
  const bits = Object.entries(o).slice(0, 4).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}=[${v.length}]`;
    if (v && typeof v === 'object') return `${k}={…}`;
    return `${k}=${clip(String(v), 22)}`;
  });
  return bits.join(' ');
}

function pretty(v) {
  const o = parseMaybe(v);
  if (o && typeof o === 'object') {
    try { return JSON.stringify(o, null, 1); } catch { /* fall through */ }
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function parseMaybe(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function clip(s, n) { return s.length > n ? `${s.slice(0, n)}…` : s; }

/* The film's voice.
 *
 * The opening film was narrated by `window.speechSynthesis`: free, keyless, and
 * the reason several people watched it with the sound off. This module gives it
 * a real read — ElevenLabs, synthesised server-side and cached to disk, arriving
 * here as thirty small MP3s — while keeping every property the old path had.
 *
 * Four things it is careful about.
 *
 * NEVER A DEPENDENCY, AND NEVER ALL-OR-NOTHING. `prepare` asks the server what
 * it can do and comes back with one entry per line, any of which may be null: no
 * key, no cache, no network, one line that failed. The film asks `speak(i)` and
 * gets back true or false, and false means "read it yourself" — so a script with
 * one unmade line is twenty-nine lines properly read and one in the browser
 * voice, rather than a fallback for the whole film. Nothing here is awaited by
 * the player; the whole preparation is fire-and-forget and the film starts on
 * time whether or not it has finished.
 *
 * THE STATED DURATIONS STILL WIN. Beat lengths are the design's, not the
 * recording's — the title card promises a runtime, the transport bar sizes its
 * segments by chapter, and both have to be the same on every machine and whether
 * or not there is sound. So a clip that runs longer than its shot is *sped up*,
 * up to a limit, rather than being allowed to push the film out of shape; past
 * that limit it is cut, exactly as the synthesiser's was. Pitch is preserved, so
 * a few percent is inaudible, and a few percent is all it ever needs.
 *
 * IT GOES THROUGH THE SCORE'S GRAPH. The film runs a WebAudio drone under the
 * narration. Left as a bare `<audio>` element the voice would play beside it at
 * whatever level the mix happened to land on; routed into the same limiter, the
 * score can duck under each line and come back up between them, which is what
 * the difference between a voice-over and two things playing at once actually
 * is. If the context cannot be had, the element plays on its own — quieter mix,
 * same film.
 *
 * CUTS ARE FADED. A synthesised voice cut mid-word sounds like a synthesised
 * voice. A real one cut mid-word sounds like a fault, so every stop is a fifteen
 * hundredths of a second ramp rather than a `pause()`.
 *
 * AND IT PLAYS FROM MEMORY, NOT FROM A MEDIA ELEMENT. This used to be thirty
 * `<audio>` elements with `preload = 'auto'`, which is a request and not a
 * guarantee: Chrome will not keep thirty detached media elements loaded, and
 * every line arrived at its beat with `readyState` 1 — metadata only, nothing
 * to play — then fired a `waiting` and buffered while it was supposed to be
 * speaking. Measured on the finished film, with the whole cache on localhost
 * and every byte already in the HTTP cache: the twenty-nine lines played 3.15
 * to 6.85 seconds of a clip that was 5.28 to 8.23 seconds long, so a beat with
 * half a second of designed slack was cutting up to 2.13 seconds off its own
 * sentence. That is the hiccup between sentences, and no amount of retiming
 * fixes it, because the beat was always long enough — the audio was late.
 *
 * The clips are three megabytes in total. Fetched as bytes, decoded once into
 * AudioBuffers and played through `AudioBufferSourceNode`, there is no stream
 * to starve, no `readyState`, and a start is sample-accurate. The element path
 * is kept for the case where there is no AudioContext to decode into, which is
 * the same case it was already the fallback for.
 */

import { api } from './api.js';
/** How much a line may be hurried to fit its shot. Beyond about fifteen percent
 *  the read stops sounding unhurried, which is the whole reason for using this
 *  voice; a line that needs more than that is a line to shorten in story.js. */
const MAX_RATE = 1.15;

/** Headroom left at the end of a beat, so a line lands before the cut rather
 *  than into it. */
const TAIL = 0.25;

/* The read's tempo, and it is an edit decision rather than a guard.
 *
 * MAX_RATE below is the emergency: a line that will not fit its shot at all.
 * This is the speed the film is CUT at, applied to every line whether it needs
 * it or not, so that the pacing is one decision made once instead of an
 * accident of how briskly the synthesiser felt like reading each sentence.
 *
 * Why it is not 1. Restoring every figure the captions show — the hour count,
 * both wall counts, the building's year and homes, the overhang depth, the full
 * 2,272,818 — added about twenty-one seconds of speech, and put the film at
 * 3:07 against a three-minute limit it has been designed around since the first
 * cut. The alternatives were to drop figures again, which is the bug that was
 * being fixed, or to cut sentences the argument needs. Five percent is the
 * cheapest ten seconds in the film: it is a third of the fifteen percent this
 * file already calls the point where a read stops sounding unhurried, pitch is
 * preserved so nothing about the voice changes, and George reads slowly enough
 * that it lands as trimmed rather than hurried. Measured: 2:56.
 *
 * `scripts/retime.mjs` lays the beats out from `beatLength`, which divides by
 * this — so changing it here re-times the whole film, and nothing else needs to
 * know. */
const RATE = 1.05;

/* The longest silence allowed INSIDE a line, in seconds.
 *
 * ElevenLabs pauses about three-quarters of a second at a full stop, and
 * several of these lines are two or three sentences. Measured on the finished
 * film: silences of 0.80 s inside "It prices the job too", 0.77 s inside
 * "Shading is the obvious answer", 0.73 s inside "And it moves through time" —
 * every one of them LONGER than the 0.58 s the edit leaves between one beat and
 * the next.
 *
 * That inversion is the whole fault. A pause inside a sentence that is bigger
 * than the pause between sentences does not read as phrasing, it reads as the
 * speaker losing their place, and no amount of work on the gaps between beats
 * touches it — which is why the breaks were still there after the gaps had been
 * made uniform to a hundredth of a second.
 *
 * Capped rather than removed. The pause is doing something; it just must not be
 * the biggest silence in earshot. 0.35 sits comfortably under GAP, so the
 * largest break a listener hears is always the cut, which is the one that is
 * supposed to mean something.
 *
 * Done here, on the decoded samples, rather than on the MP3s: it costs no
 * credits, no re-encode and no generation of quality, and `duration` reports
 * the tightened length so the beats lay themselves out from what will actually
 * be heard. */
const MAX_PAUSE = 0.35;

/* The silence between the last word of one line and the first of the next.
 *
 * TAIL plus the air after it, and every beat in the film gets exactly this much
 * — which is only true since the clips were trimmed (`scripts/trim_voice_tails.py`).
 * ElevenLabs leaves 0.39 s of dead air on the end of a line on average and up
 * to 0.77 s, and while that was sitting on top of the gap, the pauses ran 0.56 s
 * to 1.36 s. The unevenness is what a listener hears: a film whose pauses vary
 * by three-quarters of a second sounds like something is buffering.
 *
 * Was 0.55. The 0.10 s of natural decay the trim deliberately leaves on each
 * clip means the audible gap is still 0.55, which is what it always sounded
 * like — the ten hundredths came off the dead air, not off the breath. */
const GAP = 0.45;

/** The cut fade, in seconds. */
const FADE = 0.15;

/** The same normalisation the server applies before it synthesises, so that
 *  "did this sentence change" is asked of the string that was actually read
 *  rather than of the typography around it. Kept deliberately small: it only has
 *  to agree with heatcanyon/voice.py on whitespace, which is the only thing that
 *  moves between a caption and the line sent for it. */
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

export class Narrator {
  constructor() {
    this.enabled = false;      // did the server give us anything at all
    this.status = null;        // what GET /api/voice said
    this.clips = [];           // one <audio> or null per line, positional
    this.buffers = [];         // the same recordings decoded, once there is a context
    this.bytes = [];           // and the undecoded bytes, fetched before there is one
    this.lines = [];           // the exact sentences those recordings are of
    this.seconds = [];         // how long each one runs, measured server-side
    this.mismatched = [];      // beats whose line changed after it was recorded
    this._gen = 0;             // so a slow reply cannot overwrite a newer one
    this.current = null;
    this.muted = false;
    this.ac = null;
    this.dest = null;
    this.gain = null;
    /** Called with true when a line starts and false when it stops, so the
     *  film can duck its score. */
    this.onSpeaking = null;
  }

  /** Ask the server for the script as audio.
   *
   * `lines` is positional and stays positional the whole way through: the beats
   * hand in their sentences in order, the server synthesises each with its
   * neighbours for prosody, and what comes back is indexed the same way. Never
   * throws — a failure here is silence from this object and the platform voice
   * in the film, which is the pre-ElevenLabs behaviour and a perfectly good one.
   */
  /* SECOND PASS, AND IT USED TO CUT THE FILM'S THROAT.
   *
   * The film asks for its script twice — the second time when the decision
   * layer lands and five sentences in chapter three stop being their fallback
   * wording. This method answers in two network round-trips: 1.7 s against a
   * server on the same machine, and against Cloud Run through a cold start it
   * is tens of seconds. `_renarrate` checks `film.running` before calling, but
   * that check is that whole round-trip stale by the time the reply lands.
   *
   * So the old `this.destroy()` here ran mid-film: `src = ''` on the element
   * that was speaking, mid-word, with no fade, and every later beat falling to
   * the platform voice until the replacements had loaded. Reproduced directly —
   * a prepare() during beat one took the narrator from `playing, 3.41 s in` to
   * `playing: false`. On the deployed site the window is long enough to land in
   * chapter three, which is where it was reported: silence from 0:48.
   *
   * Refusing the second pass while running was the first fix and it was the
   * wrong one — it is precisely the five corrected sentences that would be lost,
   * which is what the second pass exists for.
   *
   * REUSE BY URL instead. A recording is identified by its file, so the
   * twenty-four lines that did not change keep the very elements they are
   * already playing from — nothing to tear down, nothing to re-download, and
   * the one that is speaking cannot be touched because it is the same object.
   * Only the genuinely new lines are built, and only clips the new script has
   * no use for are discarded — never the one currently in the air, which is
   * left to finish and is dropped by `cancel` at the next cut like any other. */
  async prepare(lines) {
    const gen = ++this._gen;
    const stale = () => gen !== this._gen;
    try {
      const s = await fetch(api('/api/voice')).then((r) => (r.ok ? r.json() : null));
      if (stale()) return this.enabled;
      this.status = s;
      if (!s || !s.enabled) return false;

      const res = await fetch(api('/api/voice/lines'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      });
      if (!res.ok) return false;
      const body = await res.json();
      if (stale()) return this.enabled;
      if (!body.enabled || !Array.isArray(body.lines)) return false;

      const spare = new Map();
      for (const el of this.clips) if (el && el._url) spare.set(el._url, el);
      const next = body.lines.map((l) => {
        if (!l || !l.url) return null;
        const keep = spare.get(l.url);
        if (!keep) return this._element(l.url);
        spare.delete(l.url);
        return keep;
      });
      for (const el of spare.values()) {
        if (el === this.current) continue;      // still speaking; `cancel` has it
        try { el._g?.disconnect(); } catch { /* */ }
        try { el.pause(); el.src = ''; } catch { /* */ }
      }

      this.lines = lines.map((l) => norm(l));
      // Measured by the server from the file itself, not read off the element.
      // `HTMLAudioElement.duration` is NaN until enough of the file has been
      // fetched to say, and the film needs these lengths *before* it starts —
      // it lays its beats out from them, and the title card prints the total.
      this.seconds = body.lines.map((l) => (l && l.seconds) || 0);
      this.clips = next;
      // Positional, so a script that moved a line has moved its buffer. The
      // bytes survive in `_bytesFor`, keyed by URL, so refilling these is a
      // decode and not a download.
      this.buffers = [];
      this.bytes = [];
      this.enabled = this.clips.some(Boolean);
      if (this.enabled && this.ac) this.clips.forEach((c) => c && this._route(c));
      // The real playback path. Not awaited — a line whose bytes have not
      // arrived falls back to its element for that line only, which is the same
      // per-line degradation as everything else here.
      this._load(body.lines.map((l) => (l && l.url) || null));
      return this.enabled;
    } catch {
      return false;              // offline, no server, no route: not an error here
    }
  }

  /* Fetch every clip's bytes, then decode them if there is already a context.
   *
   * Positional, like everything else here. Cached by URL in `_bytesFor` so that
   * the second script — which changes five sentences out of twenty-nine — does
   * not re-download the twenty-four that did not, exactly as `prepare` does not
   * rebuild their elements.
   *
   * Six at a time. All twenty-nine at once is thirty megabits on a cold load,
   * arriving while the title card is still measuring the runtime, and the point
   * of doing this at all is that the first line is ready when the film starts —
   * so they are asked for in the order they will be spoken.
   */
  async _load(urls) {
    const gen = this._gen;
    const want = urls.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
    const seen = this._bytesFor || (this._bytesFor = new Map());
    const next = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < want.length) {
        const i = want[cursor++];
        const url = urls[i];
        try {
          let ab = seen.get(url);
          if (!ab) {
            ab = await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null));
            if (ab) seen.set(url, ab);
          }
          if (gen !== this._gen) return;
          this.bytes[i] = ab || null;
          if (ab) await this._decode(i);
        } catch { this.bytes[i] = null; }   // this line keeps its element
      }
    };
    for (let k = 0; k < 6; k++) next.push(worker());
    await Promise.all(next);
  }

  /** Decode one line into an AudioBuffer. `decodeAudioData` detaches the
   *  ArrayBuffer it is given, so it is always handed a copy — the same bytes
   *  are decoded again whenever the context is rebuilt. */
  async _decode(i) {
    const ab = this.bytes[i];
    if (!ab || this.buffers[i]) return;
    /* Decoded into an OfflineAudioContext, not the film's.
     *
     * The film's context does not exist until the Begin click, and the beats
     * have to be laid out before that — `scripts/retime.mjs` reads `beatLength`
     * off a film that has never been started, and the title card prints the
     * runtime while the viewer is still deciding. An offline context needs no
     * gesture. AudioBuffers move between contexts freely, and a source node
     * resamples one whose rate differs from the context it is played in. */
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = this.ac || (OAC ? new OAC(1, 1, 44100) : null);
    if (!ctx) return;
    try {
      this.buffers[i] = this._tighten(ctx, await ctx.decodeAudioData(ab.slice(0)));
    } catch { this.buffers[i] = null; }
  }

  /** Cap the silences inside a line at MAX_PAUSE, returning a new buffer.
   *
   * Half of the allowance is kept on each side of the cut, so the decay of the
   * word before and the room tone leading into the word after both survive —
   * the splice happens in the middle of the quiet, where the samples are three
   * thousandths of full scale and joining them cannot click. Nothing is faded
   * or interpolated: these are the original samples with some of the middle of
   * each long silence taken out. */
  _tighten(ctx, buf) {
    const sr = buf.sampleRate;
    const cap = Math.round(MAX_PAUSE * sr);
    const src = buf.getChannelData(0);
    const hop = Math.max(1, Math.round(sr * 0.005));
    const frames = Math.floor(src.length / hop);
    let peak = 0;
    const env = new Float32Array(frames);
    for (let k = 0; k < frames; k++) {
      let m = 0;
      for (let j = k * hop; j < (k + 1) * hop; j++) { const a = Math.abs(src[j]); if (a > m) m = a; }
      env[k] = m;
      if (m > peak) peak = m;
    }
    const quiet = Math.max(peak * 0.01, 0.003);

    // The runs to keep, as [start, end) sample ranges.
    const keep = [];
    let at = 0;
    let k = 0;
    while (k < frames) {
      if (env[k] > quiet) { k++; continue; }
      let j = k;
      while (j < frames && env[j] <= quiet) j++;
      const a = k * hop;
      const b = j * hop;
      if (b - a > cap && a > 0 && j < frames) {     // never the head or the tail
        keep.push([at, a + (cap >> 1)]);
        at = b - (cap >> 1);
      }
      k = j;
    }
    if (!keep.length) return buf;
    keep.push([at, src.length]);

    const length = keep.reduce((n, [a, b]) => n + (b - a), 0);
    const out = ctx.createBuffer(buf.numberOfChannels, length, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const from = buf.getChannelData(c);
      const to = out.getChannelData(c);
      let w = 0;
      for (const [a, b] of keep) { to.set(from.subarray(a, b), w); w += b - a; }
    }
    return out;
  }

  _element(url) {
    const a = new Audio(url);
    a._url = url;                  // how `prepare` knows this clip is unchanged
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';   // required before a MediaElementSource is taken
    // Hurrying a line must not raise it. Every engine but old Safari defaults to
    // true; the two vendor spellings cost a line each and one of them is why the
    // sped-up lines came out a semitone high the first time.
    a.preservesPitch = true;
    a.mozPreservesPitch = true;
    a.webkitPreservesPitch = true;
    a.load();
    return a;
  }

  /** Route the voice into the film's own audio graph.
   *
   * Called once the score's context exists — which is inside the Begin click, so
   * it is a context the browser will actually run. `dest` is the score's limiter
   * rather than its master gain: the voice must not be attenuated by the knob
   * that sets the level of the music it is sitting on top of, but it should be
   * inside the same limiter, because the sum is what clips.
   */
  attach(ac, dest) {
    if (!ac || this.ac) return;
    try {
      this.ac = ac;
      this.dest = dest || ac.destination;
      this.gain = ac.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.dest);
      this.clips.forEach((c) => c && this._route(c));

    } catch {
      this.ac = null; this.gain = null;   // play bare instead
    }
  }

  /* Each clip gets its own gain on the way into the shared one.
   *
   * The fade promised at the top of this file was being cancelled by the thing
   * that caused the cut. Every mid-film stop comes from `speak` calling
   * `cancel` and then starting the next line, and both were reaching for the
   * SAME gain node: `cancel` scheduled the ramp to zero, `speak` called
   * `cancelScheduledValues` and pinned it back to 1 four lines later — it had
   * to, the incoming line needs full level — and the outgoing element then ran
   * on at full volume until the `setTimeout` in `cancel` paused it. So the cut
   * was not faded at all. It was two voices for a hundred and seventy
   * milliseconds and then a hard `pause()` mid-waveform, which is a click.
   *
   * With a gain per element the two stop fighting: the outgoing line fades on
   * its own node while the incoming one comes up on a different one. */
  _route(el) {
    if (!this.ac || !this.gain || el._routed) return;
    try {
      const g = this.ac.createGain();
      g.gain.value = 1;
      this.ac.createMediaElementSource(el).connect(g);
      g.connect(this.gain);
      el._g = g;
      el._routed = true;
    } catch { /* already sourced, or a context that will not take it */ }
  }

  /** How long line `i` runs, in seconds. Zero if there is no recording.
   *
   * The DECODED length when there is one, because that is the audio the film
   * will actually play — `_tighten` shortens a line by however much of its
   * internal silence was over the cap, and a beat laid out from the server's
   * measurement of the untouched file would sit through the difference. Falls
   * back to the server's number for a line still in flight or playing from its
   * element. */
  duration(i) {
    if (this.buffers[i]) return this.buffers[i].duration;
    return this.clips[i] ? (this.seconds[i] || 0) : 0;
  }

  /** Is there a real recording of *this* sentence, in this position?
   *
   * The text is checked, not just the index. Five of the film's beats are
   * written against files that data.js fetches in the background, so the
   * sentence for those beats can change between the moment the script was sent
   * to be read and the moment it is spoken — and a recording of the earlier
   * wording is worse than no recording at all, because the caption underneath it
   * will be the later one. A refusal here costs that line the platform voice;
   * saying the wrong sentence would cost the film its credibility.
   */
  has(i, text) {
    if (!this.clips[i]) return false;
    if (text === undefined) return true;
    return norm(text) === this.lines[i];
  }

  /** Speak line `i`, fitted to a beat of `dur` seconds.
   *
   * Returns false if there is nothing to play, which is the film's signal to
   * fall back to the platform synthesiser for this line and this line only.
   */
  speak(i, dur, text) {
    // Whatever happens next, the previous line stops here. Returning false
    // without cancelling would leave the last recording running underneath a
    // beat the platform voice is about to read — two narrators at once, which
    // is worse than either of them alone.
    this.cancel();
    if (this.muted) return false;
    if (!this.has(i, text)) {
      if (this.clips[i] && text !== undefined) this.mismatched.push(i);
      return false;
    }
    // Fit the read to the shot. RATE is the cut's tempo and applies to every
    // line; the MAX_RATE branch is the guard for a beat that is short even at
    // that tempo, which the stated lengths are built never to be.
    // `duration`, not `seconds`: the tightened buffer is what will be played,
    // and sizing the rate off the server's measurement of the untouched file
    // hurries a line to fit room it no longer needs. Line 15 would have been
    // read at 1.10 to squeeze 9.77 s into a beat holding 9.08 s of audio.
    const d = this.duration(i);
    const room = Math.max(0.5, (dur || 0) - TAIL);
    const rate = (isFinite(d) && d > 0 && d / RATE > room)
      ? Math.min(MAX_RATE, d / room)
      : RATE;
    if (this.buffers[i] && this.ac && this.gain) return this._playBuffer(i, rate);
    return this._playElement(i, rate);
  }

  /** The real path: a decoded buffer, which cannot stall. `offset` is only ever
   *  non-zero on a resume, where it is where the pause stopped it. */
  _playBuffer(i, rate, offset = 0) {
    try {
      // A gain per line, so the fade on the outgoing one is not undone by the
      // incoming one coming up to full — see `_route` for the same reasoning on
      // the element path.
      const gain = this.ac.createGain();
      gain.gain.value = 1;
      gain.connect(this.gain);
      const src = this.ac.createBufferSource();
      src.buffer = this.buffers[i];
      src.playbackRate.value = rate;
      src.connect(gain);
      src.onended = () => {
        try { gain.disconnect(); } catch { /* */ }
        if (this.current === src) {
          this.current = null; this.playing = null; this.onSpeaking?.(false);
        }
      };
      src.start(0, offset);
      this.playing = { kind: 'buffer', src, gain, i, rate, at: this.ac.currentTime, offset };
      this.current = src;
      this.onSpeaking?.(true);
      return true;
    } catch {
      this.current = null; this.playing = null;
      return false;
    }
  }

  /** The fallback: the media element, for a line whose bytes never arrived or a
   *  film with no AudioContext to decode into. */
  _playElement(i, rate) {
    const el = this.clips[i];
    if (!el) return false;
    this.current = el;
    try {
      el.currentTime = 0;
      el.playbackRate = rate;
      if (el._g) {
        const t = this.ac.currentTime;
        el._g.gain.cancelScheduledValues(t);
        el._g.gain.setValueAtTime(1, t);
      } else {
        el.volume = 1;
      }
      el.onended = () => {
        if (this.current === el) {
          this.current = null; this.playing = null; this.onSpeaking?.(false);
        }
      };
      const p = el.play();
      if (p && p.catch) p.catch(() => { /* a blocked play is a silent line, not a crash */ });
      this.playing = { kind: 'element', el, gain: el._g, i, rate };
      this.onSpeaking?.(true);
      return true;
    } catch {
      this.current = null; this.playing = null;
      return false;
    }
  }

  /** Stop whatever is being said, on a short ramp so a cut mid-word does not
   *  click. The source is stopped after the ramp, not before it. */
  cancel() {
    const play = this.playing;
    this.playing = null;
    const cur = this.current;
    this.current = null;
    if (!play && !cur) return;
    this.onSpeaking?.(false);
    const stop = () => {
      if (play?.kind === 'buffer') {
        try { play.src.onended = null; play.src.stop(); } catch { /* already ended */ }
        try { play.gain.disconnect(); } catch { /* */ }
      } else {
        const el = play?.el || cur;
        try { el.pause(); el.currentTime = 0; } catch { /* */ }
      }
    };
    const g = play?.gain;
    if (g && this.ac) {
      const t = this.ac.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0.0001, t + FADE);
      } catch { /* */ }
      setTimeout(stop, FADE * 1000 + 20);
    } else {
      stop();
    }
  }

  /* A BufferSource has no pause, so the film's pause button has to fake one:
   * note how far in the read had got, stop the source, and start a fresh one
   * from that offset on resume. Cheaper than it sounds — the buffer is already
   * decoded and a source node is a few bytes. */
  pause() {
    const p = this.playing;
    if (!p) return;
    if (p.kind === 'element') { try { p.el.pause(); } catch { /* */ } return; }
    if (p.paused != null) return;
    const played = (this.ac.currentTime - p.at) * p.rate + p.offset;
    p.paused = Math.min(played, p.src.buffer.duration);
    try { p.src.onended = null; p.src.stop(); } catch { /* */ }
    try { p.gain.disconnect(); } catch { /* */ }
  }

  resume() {
    const p = this.playing;
    if (!p) return;
    if (p.kind === 'element') {
      const q = p.el.play();
      if (q && q.catch) q.catch(() => {});
      return;
    }
    if (p.paused == null) return;
    const off = p.paused;
    this.playing = null;
    this.current = null;
    this._playBuffer(p.i, p.rate, off);
  }

  /** The film's SOUND OFF. Mutes the voice and stops the current line; the
   *  clips stay loaded, because sound comes back on as often as it goes off. */
  setMuted(on) {
    this.muted = !!on;
    if (on) this.cancel();
  }

  /** Lines whose recording does not fit its shot even at the maximum rate.
   *
   * Printed once, after the film, and it is a note to whoever edits story.js
   * rather than a fault: it names the beats where a sentence is being cut, which
   * is the only thing about this arrangement that a reader would notice. */
  overruns(beats) {
    const out = [];
    this.clips.forEach((el, i) => {
      const b = beats[i];
      const d = this.duration(i);
      if (!d || !b) return;
      const room = Math.max(0.5, b.dur - TAIL);
      if (d > room * MAX_RATE) {
        out.push({ beat: i, needs: +(d / MAX_RATE + TAIL).toFixed(2), has: +b.dur.toFixed(2) });
      }
    });
    return out;
  }

  /** How long beat `i` should be stated as, in seconds: the line at the cut's
   *  tempo, plus the gap. The single source of truth for the numbers in
   *  story.js — `scripts/retime.mjs` reads them straight off a running film so
   *  that RATE and GAP are decided in exactly one place. Zero for a beat with
   *  no recording, whose length is a decision about the camera. */
  beatLength(i) {
    const d = this.duration(i);
    return d ? +(d / RATE + GAP).toFixed(2) : 0;
  }

  /** The length a beat needs if its line is to be spoken in full: the recording,
   *  allowed to be hurried by at most `MAX_RATE`, plus the tail that keeps the
   *  last word off the cut. Zero for a line with no recording, which is the
   *  film's signal to leave that beat's stated length alone. */
  needs(i) {
    const d = this.duration(i);
    return d ? d / MAX_RATE + TAIL : 0;
  }

  destroy() {
    this.cancel();
    this.buffers = [];
    this.bytes = [];
    this.clips.forEach((el) => {
      if (!el) return;
      try { el._g?.disconnect(); } catch { /* */ }
      try { el.pause(); el.src = ''; } catch { /* */ }
    });
    this.clips = [];
    this.lines = [];
    this.seconds = [];
    this.enabled = false;
  }
}

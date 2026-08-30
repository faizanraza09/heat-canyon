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
 */

import { api } from './api.js';
/** How much a line may be hurried to fit its shot. Beyond about fifteen percent
 *  the read stops sounding unhurried, which is the whole reason for using this
 *  voice; a line that needs more than that is a line to shorten in story.js. */
const MAX_RATE = 1.15;

/** Headroom left at the end of a beat, so a line lands before the cut rather
 *  than into it. */
const TAIL = 0.25;

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
  async prepare(lines) {
    const gen = ++this._gen;
    try {
      const s = await fetch(api('/api/voice')).then((r) => (r.ok ? r.json() : null));
      if (gen !== this._gen) return this.enabled;
      this.status = s;
      if (!s || !s.enabled) return false;

      const res = await fetch(api('/api/voice/lines'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      });
      if (!res.ok) return false;
      const body = await res.json();
      if (gen !== this._gen) return this.enabled;
      if (!body.enabled || !Array.isArray(body.lines)) return false;

      this.destroy();
      this.lines = lines.map((l) => norm(l));
      // Measured by the server from the file itself, not read off the element.
      // `HTMLAudioElement.duration` is NaN until enough of the file has been
      // fetched to say, and the film needs these lengths *before* it starts —
      // it lays its beats out from them, and the title card prints the total.
      this.seconds = body.lines.map((l) => (l && l.seconds) || 0);
      this.clips = body.lines.map((l) => (l && l.url ? this._element(l.url) : null));
      this.enabled = this.clips.some(Boolean);
      if (this.enabled && this.ac) this.clips.forEach((c) => c && this._route(c));
      return this.enabled;
    } catch {
      return false;              // offline, no server, no route: not an error here
    }
  }

  _element(url) {
    const a = new Audio(url);
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

  _route(el) {
    if (!this.ac || !this.gain || el._routed) return;
    try {
      this.ac.createMediaElementSource(el).connect(this.gain);
      el._routed = true;
    } catch { /* already sourced, or a context that will not take it */ }
  }

  /** How long line `i` runs, in seconds. Zero if there is no recording. */
  duration(i) { return this.clips[i] ? (this.seconds[i] || 0) : 0; }

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
    const el = this.clips[i];
    this.current = el;
    try {
      el.currentTime = 0;
      // Fit the read to the shot. The film lays its beats out from these same
      // lengths, so this should almost always come out at 1 — it is the guard
      // for the case where it did not, not the mechanism.
      const d = this.seconds[i] || el.duration;
      const room = Math.max(0.5, (dur || 0) - TAIL);
      el.playbackRate = (isFinite(d) && d > room)
        ? Math.min(MAX_RATE, d / room)
        : 1;
      if (this.gain) {
        const t = this.ac.currentTime;
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setValueAtTime(1, t);
      } else {
        el.volume = 1;
      }
      el.onended = () => { if (this.current === el) { this.current = null; this.onSpeaking?.(false); } };
      const p = el.play();
      if (p && p.catch) p.catch(() => { /* a blocked play is a silent line, not a crash */ });
      this.onSpeaking?.(true);
      return true;
    } catch {
      this.current = null;
      return false;
    }
  }

  /** Stop whatever is being said, on a short ramp so a cut mid-word does not
   *  click. The element is stopped after the ramp, not before it. */
  cancel() {
    const el = this.current;
    this.current = null;
    if (!el) return;
    this.onSpeaking?.(false);
    const stop = () => { try { el.pause(); el.currentTime = 0; } catch { /* */ } };
    if (this.gain && this.ac) {
      const t = this.ac.currentTime;
      try {
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setValueAtTime(this.gain.gain.value, t);
        this.gain.gain.linearRampToValueAtTime(0.0001, t + FADE);
      } catch { /* */ }
      setTimeout(stop, FADE * 1000 + 20);
    } else {
      stop();
    }
  }

  pause() { try { this.current?.pause(); } catch { /* */ } }

  resume() {
    const p = this.current?.play();
    if (p && p.catch) p.catch(() => {});
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
    this.clips.forEach((el) => { if (el) { try { el.pause(); el.src = ''; } catch { /* */ } } });
    this.clips = [];
    this.lines = [];
    this.seconds = [];
    this.enabled = false;
  }
}

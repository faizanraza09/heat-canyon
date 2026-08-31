"""Cut the dead air off the end of the film's narration clips.

WHY THIS EXISTS. ElevenLabs leaves silence on the end of a line — measured
across the film's twenty-nine: 0.39 s on average, up to 0.77 s, and wildly
uneven. story.js states each beat as `recording + 0.55 s`, so that dead air
lands on top of the gap the edit already asked for, and the silence a viewer
actually hears between one sentence and the next ran from 0.56 s to 1.36 s.
It is the unevenness that hurts. A film whose pauses vary by three-quarters of
a second does not sound edited, it sounds like something is buffering, and that
is how it was reported: "pauses, some uu sound between sentences, not smooth".

WHAT IT DOES. Finds the last audible sample in each MP3 the current script
uses, and cuts the file there plus `KEEP` seconds of natural decay. `-c copy`,
so this is a frame-boundary cut and not a re-encode: the audio that remains is
bit-for-bit the audio that was bought. The cache key is a hash of the SENTENCE,
not of the file, so a trimmed clip is still the recording of its line and
nothing has to be synthesised again.

The manifest's `seconds` is rewritten too. `lookup` prefers it over re-parsing
the file, so leaving it stale would have the film laying out its beats from the
untrimmed lengths — the exact bug this is here to fix, and a silent one.

AFTER RUNNING IT, restate the `seconds` in story.js: they are still
`recording + 0.55`, but the recordings are shorter now. `scripts/retime.mjs`
prints the new numbers.

    node scripts/settled_script.mjs /tmp/settled.json
    python -m scripts.trim_voice_tails --script /tmp/settled.json
    python -m scripts.trim_voice_tails --script /tmp/settled.json --dry

Needs ffmpeg. imageio-ffmpeg ships one and is already a dependency of the
plotting stack; nothing in the server imports this file.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from heatcanyon import voice

# Left on the end of every clip. A cut at the last audible sample takes the
# natural decay of the final consonant with it and the line ends abruptly; this
# is enough to keep the release and far less than what is being removed.
KEEP = 0.10

# Below this fraction of the clip's own peak counts as silence. Absolute
# thresholds do not survive a quiet line — the softest of these peaks at -7.8
# dBFS and the loudest at -2.5.
FLOOR = 0.01

# And above THIS fraction of the peak is unambiguously speech rather than a
# breath. The two thresholds are what separates the end of the sentence from the
# noise after it; see `speech_end`.
HOT = 0.12

# A silence at least this long ends the sentence. Anything audible after it is a
# separate event, not the decay of the last word.
BREAK = 0.06


def ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def speech_end(path: Path, ff: str) -> tuple[float, float]:
    """Where the sentence ends, and where the file's last audible thing ends.

    THESE ARE NOT THE SAME, and the difference is the bug this function was
    rewritten for. ElevenLabs sometimes appends a breath: on beat seven the last
    word finishes at 4.21 s, the clip falls to -82 dBFS for a seventh of a
    second, and then a -35 dB "ah" runs from 4.37 to 4.53. Cutting at "the last
    sample above a floor" keeps it, which is what was reported as a hiccup
    between sentences — the film went quiet, breathed, and then started the next
    line.

    So: find the last frame that is unambiguously speech (`HOT`), walk forward
    through its decay, and stop at the first silence of `BREAK` or more. Anything
    after that gap is a separate event and goes. The second number is returned
    only so the caller can say how much of what it removed was noise rather than
    room tone.
    """
    raw = subprocess.run(
        [ff, "-v", "quiet", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    if not len(x):
        return 0.0, 0.0
    hop = 16000 // 200                      # 5 ms
    env = np.abs(x[: len(x) // hop * hop].reshape(-1, hop)).max(axis=1)
    peak = float(env.max()) or 1.0
    step = hop / 16000
    quiet = max(peak * FLOOR, 0.003)

    audible = np.nonzero(env > quiet)[0]
    last_audible = float((audible[-1] + 1) * step) if len(audible) else float(len(env) * step)

    hot = np.nonzero(env > peak * HOT)[0]
    if not len(hot):
        return last_audible, last_audible
    i = int(hot[-1])
    gap = int(round(BREAK / step))
    while i + 1 < len(env):
        if env[i + 1] > quiet:
            i += 1
            continue
        # A dip. Only the end of the sentence if nothing comes back soon.
        j = i + 1
        while j < len(env) and env[j] <= quiet:
            j += 1
        if j - (i + 1) >= gap or j >= len(env):
            break
        i = j
    return float((i + 1) * step), last_audible


def main(argv: list[str]) -> int:
    dry = "--dry" in argv
    ff = ffmpeg()
    lines = json.loads(Path(sys.argv[sys.argv.index("--script") + 1]).read_text())
    spoken = [t for t in lines if (t or "").strip()]

    man = voice.manifest()
    total_before = total_after = 0.0
    moved = 0
    breaths = 0
    print(f"{'clip':22} {'was':>7} {'now':>7} {'cut':>7}   line")
    for i, text in enumerate(spoken):
        prev = spoken[i - 1] if i else ""
        nxt = spoken[i + 1] if i + 1 < len(spoken) else ""
        key = voice.key_for(text, previous=prev, following=nxt)
        p = voice.path_for(key)
        if not p.exists():
            print(f"{key[:20]:22} {'—':>7} {'—':>7} {'—':>7}   MISSING: {text[:44]}")
            continue
        was = voice.mp3_seconds(p)
        spoken_to, audible_to = speech_end(p, ff)
        if audible_to - spoken_to > 0.05:
            breaths += 1
            print(f"{'':22} {'':>7} {'':>7} {'':>7}   ^ breath after the last word, "
                  f"{spoken_to:.2f}s -> {audible_to:.2f}s, removed")
        end = min(was, spoken_to + KEEP)
        total_before += was
        if was - end < 0.05:                       # nothing worth a rewrite
            total_after += was
            print(f"{key[:20]:22} {was:7.2f} {was:7.2f} {0.0:7.2f}   {text[:44]}")
            continue
        if not dry:
            tmp = p.with_suffix(".trim.mp3")
            subprocess.run([ff, "-v", "error", "-y", "-i", str(p), "-t", f"{end:.3f}",
                            "-c", "copy", str(tmp)], check=True)
            tmp.replace(p)
            now = voice.mp3_seconds(p)
            if key in man:
                man[key]["seconds"] = now
        else:
            now = end
        total_after += now
        moved += 1
        print(f"{key[:20]:22} {was:7.2f} {now:7.2f} {was - now:7.2f}   {text[:44]}")

    if not dry:
        voice.MANIFEST.write_text(
            json.dumps(dict(sorted(man.items())), indent=1, ensure_ascii=False) + "\n")

    print(f"\n{breaths} trailing breaths removed.")
    print(f"{moved} clips trimmed. Narration {total_before:.1f} s -> {total_after:.1f} s "
          f"({total_before - total_after:.1f} s of dead air removed).")
    if dry:
        print("Dry run: nothing was written.")
    else:
        print("Now restate the beat lengths in story.js — run scripts/retime.mjs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

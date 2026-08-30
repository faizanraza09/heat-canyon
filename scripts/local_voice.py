"""Bake the film's script with a free voice, into the same cache.

Driven by scripts/prewarm_voice_local.mjs, which is the half that knows what the
film says. This half knows where to put it.

WHY IT CANNOT COLLIDE WITH THE REAL RECORDINGS

`voice.key_for` hashes the voice id, the model, the output format and the voice
settings along with the sentence and its two neighbours. So the cache key for a
line under `HEATCANYON_VOICE_ID=local-en-GB-RyanNeural` is a different key from
the same line under the ElevenLabs voice, and the two sets of files sit in the
same directory without ever being mistaken for one another.

That is not a tidiness argument, it is the point. `voice.script()` only spends
on lines it cannot find, so if a rehearsal bake had written itself under the
real keys, the paid run afterwards would have looked at a cache full of Edge
recordings, concluded the script was already bought, and left the film narrated
by the wrong voice on the night — having reported success.

WHY THE AUDIO IS TRANSCODED

`voice.mp3_seconds` counts frames and skips anything that is not MPEG-1 Layer
III, because that is what ElevenLabs returns and the parser is deliberately
strict rather than approximate. Edge returns 24 kHz mono, which is MPEG-2, and a
24 kHz file does not measure as short — it measures as nearly nothing: a 7.4
second line came back as 0.315 s, because the parser found a handful of byte
pairs that happened to look like MPEG-1 sync words and counted those. The film
takes that number as the length of the shot, so the rehearsal would have run at
a fortieth of the right pace and the timing test would have been worthless.

So everything is transcoded to 44.1 kHz, which is MPEG-1, and the duration is
verified with the project's own parser before the file is kept.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from heatcanyon import voice  # noqa: E402


def transcode(src: Path, dest: Path) -> None:
    """Edge's 24 kHz MPEG-2 to the 44.1 kHz MPEG-1 the reader expects.

    `-write_xing 0` because a Xing/LAME header is a frame that carries no audio,
    and the frame counter would count it as 26 ms of silence at the head of
    every line. Small, but it is 26 ms times twenty-seven beats of drift in a
    film whose whole argument is that the timing is right.
    """
    import imageio_ffmpeg

    subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(src),
         "-ar", "44100", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "128k",
         "-write_xing", "0", str(dest)],
        check=True,
    )


"""How fast the rehearsal reads, as an edge-tts rate adjustment.

A rehearsal is only worth running if it is the length the real thing will be,
and Edge and ElevenLabs do not read at the same speed. Measured over the two
sets sitting in this cache: Edge 12.60 characters a second, ElevenLabs 11.95 —
so an uncorrected rehearsal comes in about five per cent short, which on a
three-minute film is nine seconds of runtime that appears from nowhere on the
paid bake. Nine seconds is the difference between a submission that fits and one
that gets rejected, so it is not a rounding error.

Recompute it if the paid voice or model changes:

    python3 - <<'EOF'
    import json; m = json.load(open('web/data/vo/lines.json'))
    for local in (True, False):
        r = [v for v in m.values()
             if str(v.get('voice_id','')).startswith('local-') is local]
        print(sum(len(v['text']) for v in r) / sum(v['seconds'] for v in r))
    EOF
"""
DEFAULT_RATE = "-5%"


async def say(text: str, edge_voice: str, dest: Path, rate: str = DEFAULT_RATE) -> None:
    import edge_tts

    await edge_tts.Communicate(text, edge_voice, rate=rate).save(str(dest))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lines_json", type=Path)
    ap.add_argument("--voice", default="en-GB-RyanNeural")
    ap.add_argument("--rate", default=DEFAULT_RATE,
                    help="edge-tts rate adjustment; the default matches the paid voice")
    args = ap.parse_args()

    lines: list[str] = json.loads(args.lines_json.read_text())

    if not os.environ.get("HEATCANYON_VOICE_ID", "").startswith("local-"):
        print("HEATCANYON_VOICE_ID must be set to a local- id, or this would write\n"
              "over the keys the paid bake needs. Run it through prewarm_voice_local.mjs.",
              file=sys.stderr)
        return 1

    voice.CACHE.mkdir(parents=True, exist_ok=True)
    made = kept = 0
    total = 0.0

    with tempfile.TemporaryDirectory() as tmp:
        for i, raw in enumerate(lines):
            text = voice.normalise(raw)
            if not text:
                continue  # the silent beats of the descent keep their places
            # Neighbours by index, exactly as voice.script() pairs them — a
            # different pairing here is a cache that never hits.
            prev = voice.normalise(lines[i - 1]) if i > 0 else ""
            nxt = voice.normalise(lines[i + 1]) if i + 1 < len(lines) else ""
            key = voice.key_for(raw, previous=prev, following=nxt)
            dest = voice.path_for(key)

            if dest.exists():
                kept += 1
                total += voice.mp3_seconds(dest)
                print(f"· {text}")
                continue

            src = Path(tmp) / f"{key}.raw.mp3"
            asyncio.run(say(text, args.voice, src, args.rate))
            transcode(src, dest)

            secs = voice.mp3_seconds(dest)
            if secs <= 0:
                # Better no file than a file the film believes is instantaneous.
                dest.unlink(missing_ok=True)
                print(f"! {text}\n  (unreadable duration — not kept)", file=sys.stderr)
                continue

            voice._record(key, text)
            made += 1
            total += secs
            print(f"+ {text}")

    print(f"\n{made} recorded, {kept} already there, {total:.1f}s of narration")
    print(f"voice id {os.environ['HEATCANYON_VOICE_ID']} — the paid cache is untouched.")
    print("To clear these:  python3 scripts/local_voice.py --purge")
    return 0


def purge() -> int:
    """Remove every recording made under a local- voice id, and its index rows.

    Keyed off the manifest rather than off the filenames, because the filenames
    are hashes and carry no voice in them — which is exactly the rot the
    manifest was written to stop.
    """
    m = voice.manifest()
    gone = [k for k, v in m.items() if str(v.get("voice_id", "")).startswith("local-")]
    for k in gone:
        voice.path_for(k).unlink(missing_ok=True)
        m.pop(k, None)
    voice.MANIFEST.write_text(json.dumps(dict(sorted(m.items())), indent=1,
                                         ensure_ascii=False) + "\n")
    print(f"removed {len(gone)} rehearsal recordings")
    return 0


if __name__ == "__main__":
    sys.exit(purge() if "--purge" in sys.argv else main())

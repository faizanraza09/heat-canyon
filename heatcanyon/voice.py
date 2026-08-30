"""The film's voice: ElevenLabs text-to-speech, cached to disk.

The opening film used to be narrated by `window.speechSynthesis`, which is free,
needs no key, and sounds like a railway station. This module replaces it with a
real read, and does so under three constraints that shape every decision here.

DOING IT ONCE. Synthesis costs credits, the free plan gives ten thousand
characters a month, and the whole script is about fifteen hundred — so a demo
left open in a tab must not spend a character per play. Every line is keyed by
the SHA-256 of exactly what was sent (text, voice, model, format, and the
neighbouring lines used for prosody) and written to `web/data/vo/<key>.mp3`. A
key that already exists on disk is never re-synthesised, the cache is served by
the same static mount as the rest of `web/data`, and it is committed for the
same reason the FortyGuard responses are: a fresh clone plays the film with the
real voice, offline, having spent nothing.

That also means this file has no invalidation logic. There is nothing to
invalidate — a changed line is a different key and a new file, and the old one
is simply never asked for again. `heatcanyon voice --prune` sweeps them when the
directory gets untidy.

NEVER BEING A DEPENDENCY. The film has to play with no key, no network and no
cache. So the client asks first (`GET /api/voice`), takes back a per-line map
that may be full of nulls, and falls back to the platform synthesiser line by
line rather than all-or-nothing. Nothing in the film awaits a synthesis.

A CEILING THAT IS NOT THE PLAN'S. `HEATCANYON_VOICE_BUDGET_CHARS` bounds what
one server process can spend, whatever asks it to. The plan's own quota is the
backstop; this is the guard that stops a loop, a hostile tab, or a mistake in
this file from finding it.

AND, ABOVE ALL: A PAGE LOAD CANNOT SPEND. `script()` reads the cache and nothing
else unless the caller passes `synthesise_missing=True`, which the film never
does and `scripts/prewarm_voice.mjs` always does. This is not caution in the
abstract, it is observed behaviour — the cache in this repository was first
filled by a Playwright suite in another terminal, which opened the application,
played the film, and spent three and a half thousand characters of a ten
thousand character monthly allowance without anybody asking it to. Baking the
voice is a deliberate act, taken once, by someone who meant to. Playing the film
is not.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

API = "https://api.elevenlabs.io/v1"

CACHE = Path("web") / "data" / "vo"

# Adam. Overridable with HEATCANYON_VOICE_ID, and `heatcanyon voice --voices`
# prints the ids on the account.
#
# CHANGING THIS RETIRES THE WHOLE CACHE, and that is by design rather than by
# accident: `key_for` hashes the voice id along with the sentence, so every
# recording made under the previous voice becomes unreachable rather than being
# silently mixed in with the new one. A film half in one voice and half in
# another is the failure that guarantees, and it cannot happen.
#
# It was Daniel before this. Nothing is lost by the change — the script had
# already moved far enough that none of those recordings matched a line the film
# still says — but if it is changed again after a paid bake, that bake is spent.
# THERE ARE TWO ADAMS, and only one of them works on a free key.
#
# `wBXNqKUATyqu0RtYt25i` is the community-library Adam — narrative, deep, and the
# better read for this script. The API refuses it with 402 paid_plan_required:
# "Free users cannot use library voices via the API." That refusal costs nothing
# and is per line, so the bake completes, records nothing, and reports success
# with every line still missing. `heatcanyon voice --voices` is what tells the
# two apart: the library one is tagged `professional`, this one `premade`.
# George: British, middle-aged, tagged narrative_story — the register the script
# is actually written in. Adam (premade) read it as social-media firm.
DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"

# `eleven_multilingual_v2` is the expensive one (one credit per character) and
# the one that sounds like a person reading rather than a person announcing.
# `eleven_turbo_v2_5` halves the cost if the budget is what matters more.
DEFAULT_MODEL = "eleven_multilingual_v2"

# 128 kbps MP3 at 44.1 kHz: the default tier, available on the free plan, and
# indistinguishable from anything higher under a synth drone.
DEFAULT_FORMAT = "mp3_44100_128"

# One line of narration is a sentence. Anything an order of magnitude past that
# is a bug in the caller, and refusing it costs nothing.
MAX_CHARS = 800

_lock = threading.Lock()
_spent = 0


def api_key() -> str:
    return (os.environ.get("ELEVENLABS_API_KEY") or "").strip()


def voice_id() -> str:
    return (os.environ.get("HEATCANYON_VOICE_ID") or DEFAULT_VOICE).strip()


def model_id() -> str:
    return (os.environ.get("HEATCANYON_VOICE_MODEL") or DEFAULT_MODEL).strip()


def output_format() -> str:
    return (os.environ.get("HEATCANYON_VOICE_FORMAT") or DEFAULT_FORMAT).strip()


def budget_chars() -> int:
    try:
        return max(0, int(os.environ.get("HEATCANYON_VOICE_BUDGET_CHARS", "6000")))
    except ValueError:
        return 6000


def enabled() -> bool:
    """Is the voice-over switched on at all?

    Off means the film narrates itself with the platform synthesiser, exactly as
    it did before this file existed. `HEATCANYON_VOICE=0` is the explicit off
    switch; otherwise the voice is on if it can either synthesise (a key) or
    replay (a non-empty cache), because a clone with the committed audio and no
    key should still get the real read.
    """
    if os.environ.get("HEATCANYON_VOICE", "1").strip() in {"0", "off", "false", "no"}:
        return False
    return bool(api_key()) or bool(_cache_files())


def _cache_files() -> list[Path]:
    if not CACHE.exists():
        return []
    return sorted(CACHE.glob("*.mp3"))


def _voice_settings() -> dict:
    """Documentary settings, and the reasoning is the same for all four.

    High stability and no style exaggeration, because the script's job is to be
    believed. The performative end of this model reads a sentence about
    thirty-nine degrees as though it were a trailer, and the film already has a
    score doing the emotional work; the voice is there to be trusted.
    """
    def num(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name, default))
        except (TypeError, ValueError):
            return default

    return {
        "stability": num("HEATCANYON_VOICE_STABILITY", 0.55),
        "similarity_boost": num("HEATCANYON_VOICE_SIMILARITY", 0.80),
        "style": num("HEATCANYON_VOICE_STYLE", 0.0),
        "use_speaker_boost": True,
    }


# ------------------------------------------------------------------- the text

# What the synthesiser should not have to guess at. story.js already spells its
# figures as words — that was done for `speechSynthesis` and it pays off again
# here — so this only has to deal with the typography the captions are set in:
# an em dash is a pause, a middot is a separator, and a degree sign read aloud
# is "degree see".
_SUBS = [
    (re.compile(r"\s*—\s*"), ", "),
    (re.compile(r"\s*·\s*"), ", "),
    (re.compile(r"°\s*C\b"), " degrees Celsius"),
    (re.compile(r"[“”]"), '"'),
    (re.compile(r"[‘’]"), "'"),
    (re.compile(r"\s+"), " "),
]


def normalise(text: str) -> str:
    out = (text or "").strip()
    for pattern, repl in _SUBS:
        out = pattern.sub(repl, out)
    return out.strip()


# ------------------------------------------------------------------ the cache


def key_for(text: str, *, previous: str = "", following: str = "") -> str:
    """The cache key: everything that changes the audio, and nothing else.

    The neighbours are in it because they are sent to the API as prosody context
    (see `synthesise`), so two identical sentences in different places in the
    script are genuinely different recordings and must not share a file.
    """
    h = hashlib.sha256()
    for part in (voice_id(), model_id(), output_format(),
                 json.dumps(_voice_settings(), sort_keys=True),
                 normalise(previous), normalise(text), normalise(following)):
        h.update(part.encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()[:20]


def path_for(key: str) -> Path:
    return CACHE / f"{key}.mp3"


# The cache is twenty-eight files named after a hash, which is unreadable, and
# unreadable is how a cache rots: nobody can tell which file is which line, so
# nobody dares delete any of them. This is the index — key to the sentence it is
# a recording of, plus the voice and the day it was made. It is written beside
# the audio, committed with it, and read by nothing at run time. It exists so a
# person can look.
MANIFEST = CACHE / "lines.json"


def manifest() -> dict:
    try:
        return json.loads(MANIFEST.read_text())
    except Exception:  # noqa: BLE001 - a missing or broken index is not a failure
        return {}


def _record(key: str, text: str) -> None:
    import datetime

    m = manifest()
    m[key] = {
        "text": text,
        "chars": len(text),
        # Measured once and written down, so the film's timing does not depend on
        # re-parsing three megabytes of MP3 on every page load.
        "seconds": mp3_seconds(path_for(key)),
        "voice_id": voice_id(),
        "model_id": model_id(),
        "made": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
    }
    MANIFEST.write_text(json.dumps(dict(sorted(m.items())), indent=1, ensure_ascii=False) + "\n")


def url_for(key: str) -> str:
    """Where the browser finds it. `web/data` is mounted at `/data`, so the
    cache is served by the static mount with no route of its own."""
    return f"/data/vo/{key}.mp3"


# ------------------------------------------------------------ how long it is

# MPEG-1 Layer III, which is what every file in this cache is. Index by the
# four-bit field in the frame header; the holes are the reserved values.
_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
_RATES = {0: 44100, 1: 48000, 2: 32000}


def mp3_seconds(path: Path) -> float:
    """How long a recording runs, by counting its frames.

    The film needs this and needs it *before* it starts, because a shot has to
    be at least as long as the sentence spoken over it — and `HTMLAudioElement`
    only knows the duration once it has fetched enough of the file to say, which
    is after the title card has already printed a runtime. So the server
    measures it here and sends it with the URL.

    Counted rather than divided. Bytes over bitrate is one line and is right to
    within a tenth of a second for constant-bitrate audio, which this is — but
    it is silently wrong by whole seconds the day someone sets
    HEATCANYON_VOICE_FORMAT to a variable-bitrate one, and the failure would
    show up as a film whose captions drift, which is a horrible thing to debug.
    Walking the frames is thirty lines and cannot be wrong either way.
    """
    try:
        data = path.read_bytes()
    except OSError:
        return 0.0

    i = 0
    # Skip an ID3v2 tag: "ID3", two version bytes, flags, then four
    # syncsafe length bytes (seven bits each, high bit always clear).
    if data[:3] == b"ID3" and len(data) > 10:
        size = 0
        for b in data[6:10]:
            size = (size << 7) | (b & 0x7F)
        i = 10 + size

    seconds = 0.0
    n = len(data)
    while i + 4 <= n:
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
            i += 1                      # not a sync word; walk on
            continue
        version = (data[i + 1] >> 3) & 0x03      # 3 = MPEG-1
        layer = (data[i + 1] >> 1) & 0x03        # 1 = Layer III
        bitrate = _BITRATES[(data[i + 2] >> 4) & 0x0F]
        rate = _RATES.get((data[i + 2] >> 2) & 0x03, 0)
        pad = (data[i + 2] >> 1) & 0x01
        if version != 3 or layer != 1 or not bitrate or not rate:
            i += 1
            continue
        length = (144 * bitrate * 1000) // rate + pad
        if length <= 4:
            i += 1
            continue
        seconds += 1152 / rate           # samples per Layer III frame
        i += length
    return round(seconds, 3)


@dataclass
class Line:
    key: str
    url: str
    chars: int
    cached: bool
    seconds: float = 0.0


def lookup(text: str, *, previous: str = "", following: str = "") -> Line | None:
    """The cache, without the network. Returns None on a miss."""
    if not normalise(text):
        return None
    key = key_for(text, previous=previous, following=following)
    p = path_for(key)
    if p.exists() and p.stat().st_size > 0:
        rec = manifest().get(key) or {}
        return Line(key=key, url=url_for(key), chars=len(normalise(text)), cached=True,
                    seconds=rec.get("seconds") or mp3_seconds(p))
    return None


def spent_chars() -> int:
    return _spent


def synthesise(text: str, *, previous: str = "", following: str = "") -> Line:
    """One line, cached. Raises on anything that stops it being audio.

    `previous_text` and `next_text` are the reason the film sounds like one read
    rather than thirty clips: they give the model the sentences either side, so
    it lands the cadence of a line that continues and the fall of one that ends
    a chapter. They are context, not content — they are not spoken and not
    billed — but they do change the output, which is why they are in the key.
    """
    global _spent

    body_text = normalise(text)
    if not body_text:
        raise ValueError("nothing to say")
    if len(body_text) > MAX_CHARS:
        raise ValueError(f"line is {len(body_text)} characters, over the {MAX_CHARS} cap")

    hit = lookup(text, previous=previous, following=following)
    if hit:
        return hit

    key = api_key()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set, and this line is not cached")

    with _lock:
        if _spent + len(body_text) > budget_chars():
            raise RuntimeError(
                f"voice budget spent: {_spent} of {budget_chars()} characters this process"
            )
        _spent += len(body_text)

    import requests

    payload = {
        "text": body_text,
        "model_id": model_id(),
        "voice_settings": _voice_settings(),
    }
    if normalise(previous):
        payload["previous_text"] = normalise(previous)
    if normalise(following):
        payload["next_text"] = normalise(following)

    r = requests.post(
        f"{API}/text-to-speech/{voice_id()}",
        params={"output_format": output_format()},
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    if r.status_code != 200:
        # Give back what ElevenLabs actually said. A quota refusal and a bad
        # voice id are both a 401-ish wall of nothing without it.
        detail = r.text[:400].replace("\n", " ")
        with _lock:
            _spent -= len(body_text)   # it was not spent; do not hold it against the budget
        raise RuntimeError(f"ElevenLabs returned {r.status_code}: {detail}")

    audio = r.content
    if len(audio) < 512:
        with _lock:
            _spent -= len(body_text)
        raise RuntimeError(f"ElevenLabs returned {len(audio)} bytes, which is not audio")

    CACHE.mkdir(parents=True, exist_ok=True)
    dest = path_for(cache_key := key_for(text, previous=previous, following=following))
    # Written beside and renamed, so a killed process cannot leave a half file in
    # the cache under a key that then reads as a hit for ever.
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(audio)
    tmp.replace(dest)
    _record(cache_key, body_text)
    logger.info("voice: synthesised %d chars -> %s", len(body_text), dest.name)
    return Line(key=cache_key, url=url_for(cache_key), chars=len(body_text), cached=False,
                seconds=mp3_seconds(dest))


def script(lines: list[str], *, synthesise_missing: bool = False) -> list[dict]:
    """A whole script, in order, each line given its neighbours as context.

    Returns one entry per input line, in the same order, `url` being null for
    anything that is not available. A line that fails does not stop the ones
    after it: the film falls back per line, so thirty lines minus one is
    twenty-nine read properly and one read by the browser, which is a far better
    outcome than none.

    `synthesise_missing` is the spending switch, and it is off. Left off, this is
    a pure cache read: it costs nothing, needs no key, works offline, and cannot
    be made to spend by anything a visitor does. The prewarm script turns it on,
    once, on purpose.
    """
    out: list[dict] = []
    for i, raw in enumerate(lines):
        text = normalise(raw)
        if not text:
            out.append({"url": None, "cached": False, "chars": 0, "seconds": 0, "error": None})
            continue
        prev = normalise(lines[i - 1]) if i > 0 else ""
        nxt = normalise(lines[i + 1]) if i + 1 < len(lines) else ""
        hit = lookup(raw, previous=prev, following=nxt)
        if hit:
            # A cache hit is also how the index gets rebuilt. The recordings are
            # the durable artefact and the index is derived from them, so it can
            # be lost, hand-edited or arrive from a clone made before it existed,
            # and the next read of the current script restores it — without
            # spending anything, because the audio is already there.
            if hit.key not in manifest():
                _record(hit.key, text)
            out.append({"url": hit.url, "cached": True, "chars": hit.chars,
                        "seconds": hit.seconds, "error": None})
            continue
        if not synthesise_missing:
            out.append({"url": None, "cached": False, "chars": 0, "seconds": 0,
                        "error": "not cached"})
            continue
        try:
            line = synthesise(raw, previous=prev, following=nxt)
            out.append({"url": line.url, "cached": line.cached, "chars": line.chars,
                        "seconds": line.seconds, "error": None})
        except Exception as e:  # noqa: BLE001 - one bad line must not sink the read
            logger.warning("voice: line %d could not be synthesised: %s", i, e)
            out.append({"url": None, "cached": False, "chars": 0, "seconds": 0,
                        "error": str(e)})
    return out


# ------------------------------------------------------------- the account


def voices() -> list[dict]:
    """The voices on the account. Costs nothing; used by the CLI to print ids."""
    key = api_key()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    import requests

    r = requests.get(f"{API}/voices", headers={"xi-api-key": key}, timeout=30)
    r.raise_for_status()
    items = r.json().get("voices", [])
    return [
        {
            "voice_id": v.get("voice_id"),
            "name": v.get("name"),
            "category": v.get("category"),
            "labels": v.get("labels") or {},
        }
        for v in items
    ]


def subscription() -> dict:
    """Characters used and remaining on the plan. The real ceiling, as opposed
    to this process's own."""
    key = api_key()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    import requests

    r = requests.get(f"{API}/user/subscription", headers={"xi-api-key": key}, timeout=30)
    r.raise_for_status()
    d = r.json()
    used = d.get("character_count", 0)
    limit = d.get("character_limit", 0)
    return {
        "tier": d.get("tier"),
        "used": used,
        "limit": limit,
        "remaining": max(0, limit - used),
        "resets_unix": d.get("next_character_count_reset_unix"),
    }


def cache_report() -> dict:
    files = _cache_files()
    return {
        "dir": str(CACHE),
        "lines": len(files),
        "bytes": sum(f.stat().st_size for f in files),
    }


def orphans() -> list[Path]:
    """Recordings the index no longer names.

    A line that is edited leaves its old recording behind for ever, because the
    key is the sentence. That is the right behaviour — the old file is what makes
    an undo free — but it does mean the directory only ever grows, and after a
    few passes over the script most of it is nothing. These are the files the
    index has forgotten; the ones it still names are the current script.
    """
    known = set(manifest())
    return [f for f in _cache_files() if f.stem not in known]


def status() -> dict:
    """What `GET /api/voice` hands the browser."""
    return {
        "enabled": enabled(),
        "can_synthesise": bool(api_key()),
        "voice_id": voice_id(),
        "model_id": model_id(),
        "format": output_format(),
        "budget_chars": budget_chars(),
        "spent_chars": spent_chars(),
        "cache": cache_report(),
    }

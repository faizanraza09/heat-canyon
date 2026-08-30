"""Single entry point: fetch, build, validate, serve."""

from __future__ import annotations

import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser(prog="heatcanyon", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="run the pipeline into web/data (no API calls)")
    b.add_argument("--aoi", default="midtown")
    b.add_argument("--no-lidar", action="store_true",
                   help="flat footprint extrusion instead of measured roof profiles")
    # The annual accumulation is the only minutes-long step in the build. A
    # stride lets someone iterating on the renderer skip most of it; anything but
    # 1 is recorded in meta.json under `year.sampled`, so a sampled build cannot
    # be mistaken for a full one.
    b.add_argument("--year-stride", type=int, default=1,
                   help="solve every Nth hour of the year (1 = all 8,760)")

    sv = sub.add_parser("serve", help="serve the web app and AI analyst")
    # An explicit --port, distinct from the PORT env var, so an automated run can
    # invoke the server with a command line that differs textually from a
    # developer's. Playwright's webServer teardown kills by matching the command
    # it spawned, and with both using the identical string it was terminating
    # the dev server on every test run — six times in one session before the
    # cause was pinned down.
    sv.add_argument("--port", type=int, default=None)
    sub.add_parser("validate", help="run every validation check")
    sub.add_parser("spend", help="print the FortyGuard credit ledger")

    # The film's voice-over. Everything here is diagnostic or one-off: the film
    # itself asks the server for its script and the server answers from the
    # committed cache, so nothing below has to be run for the voice to work.
    v = sub.add_parser("voice", help="the opening film's ElevenLabs voice-over")
    v.add_argument("--voices", action="store_true",
                   help="list the voices on the account and their ids")
    v.add_argument("--plan", action="store_true",
                   help="characters used and remaining on the ElevenLabs plan")
    v.add_argument("--say", metavar="TEXT",
                   help="synthesise one line into the cache and print its path")
    v.add_argument("--lines", action="store_true",
                   help="print the cached script, line by line")
    v.add_argument("--prune", action="store_true",
                   help="delete recordings the index no longer names")
    v.add_argument("--all", action="store_true",
                   help="with --prune, delete the whole cache (it must then be re-bought)")

    args = ap.parse_args()

    if args.cmd == "build":
        from . import pipeline
        pipeline.build(args.aoi, use_lidar=not args.no_lidar,
                       year_stride=max(1, args.year_stride))
        return 0
    if args.cmd == "serve":
        from .server import main as serve
        serve(port=args.port)
        return 0
    if args.cmd == "validate":
        from scripts.validate import main as val  # type: ignore
        return val()
    if args.cmd == "spend":
        from . import fg
        print(fg.spend_report())
        return 0
    if args.cmd == "voice":
        return _voice(args)
    return 1


def _voice(args) -> int:
    """`heatcanyon voice`. Reports by default; only --say ever spends."""
    from dotenv import load_dotenv

    load_dotenv()
    from . import voice

    if args.voices:
        for v in voice.voices():
            labels = ", ".join(f"{k}={x}" for k, x in (v["labels"] or {}).items())
            print(f'{v["voice_id"]}  {v["name"]:<18} {v["category"] or "":<10} {labels}')
        return 0

    if args.plan:
        s = voice.subscription()
        print(f'tier      {s["tier"]}')
        print(f'used      {s["used"]:,} of {s["limit"]:,}')
        print(f'remaining {s["remaining"]:,}')
        return 0

    if args.lines:
        m = voice.manifest()
        for key, rec in m.items():
            mark = "ok " if voice.path_for(key).exists() else "GONE"
            print(f'{mark} {key}  {rec["chars"]:>4}  {rec["text"]}')
        print(f"\n{len(m)} lines indexed")
        return 0

    if args.prune:
        if args.all:
            files = list(voice.CACHE.glob("*.mp3"))
            note = "the whole cache. Re-baking it costs characters"
        else:
            files = voice.orphans()
            note = "recordings no longer in the index"
        n = sum(f.stat().st_size for f in files)
        for f in files:
            f.unlink()
        if args.all and voice.MANIFEST.exists():
            voice.MANIFEST.unlink()
        print(f"removed {len(files)} files ({n / 1024:.0f} kB) — {note}")
        return 0

    if args.say:
        line = voice.synthesise(args.say)
        state = "cached" if line.cached else f"synthesised, {line.chars} characters"
        print(f"{voice.path_for(line.key)}  ({state})")
        return 0

    st = voice.status()
    print(f'enabled     {st["enabled"]}')
    print(f'can synth   {st["can_synthesise"]}  (ELEVENLABS_API_KEY)')
    print(f'voice       {st["voice_id"]}')
    print(f'model       {st["model_id"]}')
    print(f'format      {st["format"]}')
    print(f'cache       {st["cache"]["lines"]} lines, {st["cache"]["bytes"] / 1024:.0f} kB in {st["cache"]["dir"]}')
    print(f'budget      {st["spent_chars"]} of {st["budget_chars"]} characters this process')
    return 0


if __name__ == "__main__":
    sys.exit(main())

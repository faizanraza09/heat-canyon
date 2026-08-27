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

    args = ap.parse_args()

    if args.cmd == "build":
        from . import pipeline
        pipeline.build(args.aoi, use_lidar=not args.no_lidar)
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
    return 1


if __name__ == "__main__":
    sys.exit(main())

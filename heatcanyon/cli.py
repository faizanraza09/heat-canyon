"""Single entry point: fetch, build, validate, serve."""

from __future__ import annotations

import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser(prog="heatcanyon", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="run the pipeline into web/data (no API calls)")
    b.add_argument("--aoi", default="midtown")

    sub.add_parser("serve", help="serve the web app and AI analyst")
    sub.add_parser("validate", help="run every validation check")
    sub.add_parser("spend", help="print the FortyGuard credit ledger")

    args = ap.parse_args()

    if args.cmd == "build":
        from . import pipeline
        pipeline.build(args.aoi)
        return 0
    if args.cmd == "serve":
        from .server import main as serve
        serve()
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

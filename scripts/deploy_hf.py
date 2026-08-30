"""Ship The Urban Canyon to a Hugging Face Space.

WHY THIS EXISTS RATHER THAN A `git push`

The Space is not a mirror of the GitHub repository and cannot be one, for two
reasons that pull in opposite directions.

It needs LESS: `data/` is 200 MB of LiDAR tiles, NYC footprints and cached
FortyGuard responses that only the pipeline reads. None of it is reachable from
a running server, and the credit ledger in `data/manhattan/_ledger.json` has no
business on a public host.

And it needs MORE: `web/data/*.bin` — the solved fields, 189 MB across thirteen
periods — are deliberately gitignored, because they are build output and the
repository is not a place to keep a binary that changes every time the pipeline
runs. The Space is the one place they have to exist, because the deployed server
cannot rebuild them: it has neither the sources nor the hours.

So this assembles a third tree from both halves and uploads that.

The Space card is the last piece. Hugging Face reads a Space's title, SDK and
port out of YAML frontmatter at the top of README.md, and the repository's own
README is the FortyGuard quickstart. Rather than put a block of platform
metadata above it on GitHub, the card is written here and only here.

    python scripts/deploy_hf.py --space <user>/urbancanyon

Credentials come from the environment (HF_TOKEN) or a prior `hf auth login`.
Application secrets are pushed to the Space's own secret store, never into the
tree — see `--set-secret`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT / ".deploy" / "space"

#: What the running server actually reads. Anything not matched here is absent
#: from the image, which is the point: an allowlist fails closed, and the thing
#: being kept out is a directory of paid API responses.
INCLUDE = [
    "heatcanyon/",       # the application and the analyst
    "web/",              # the interface and every solved field, .bin included
    "scripts/",          # the agent's shell can read them; they are small
    "docs/",             # ditto — the methodology the analyst cites
    "requirements.txt",
    "Dockerfile",
    ".dockerignore",
    "LICENSE",
    ".agent/runs/r178810446770079f/",  # the run chapter five replays
]

#: Pruned from the staged tree after copying. These are inside INCLUDE'd
#: directories, so an exclude is the only way to reach them.
PRUNE = [
    "--exclude=__pycache__", "--exclude=*.pyc", "--exclude=.pytest_cache",
    "--exclude=.ruff_cache", "--exclude=*.zip", "--exclude=*:Zone.Identifier",
    "--exclude=.env",
]

CARD = """---
title: The Urban Canyon
emoji: 🌆
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: A year of 3D street-canyon heat exposure in Midtown Manhattan
---

# The Urban Canyon

A three-dimensional exposure model of Midtown Manhattan across a whole year, and
an analyst that re-solves the physics to answer questions about it.

Street-canyon geometry is reconstructed from NYC Open Data footprints, street
widths and 2017 airborne LiDAR. A coupled surface energy balance is solved for
29,415 facade panels in ten height bands, buildings are ranked against the city's
Heat Vulnerability Index, and interventions are tested by re-solving rather than
by applying published coefficients.

**It covers 8,760 hours, not one afternoon.** The temporal axis is ERA5
reanalysis from Open-Meteo, bias-corrected against FortyGuard's 2 m air
temperature on the one day both cover, and resolved at three tiers. The first
thing the year said was that the fifty buildings most at risk during a heat wave
and the fifty most loaded across the year overlap by about a quarter — so a
programme designed against either one misses the other.

**It says what to do about it.** Linearising the emission term splits each
surface's excess over the air into absorbed sun, longwave off the wall opposite,
and radiation to a cold sky, and that decomposition is what selects a measure.
A floor heated by the building across the street will not notice any amount of
shading; its intervention is a coating on somebody else's facade.

Open it and the film runs first: the NASA GISTEMP warming record on a globe, then
one unbroken fall from thirty-four thousand kilometres onto Midtown, with no cut
at the bottom — the film hands the camera to the application mid-descent.

Source: <https://github.com/faizanraza09/heat-canyon>

## Running it

Everything except the analyst works with no configuration at all. The analyst is
Claude Code as a library — twenty in-process MCP tools over the solved model —
and needs one credential, set as a Space secret:

| Secret | What it unlocks | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | the agent console | the console answers from the single-shot analyst, or says it is unavailable |
| `GOOGLE_MAPS_API_KEY` | Google's Photorealistic 3D Tiles under the data | the toggle is absent; the model renders on its own massing |
| `ELEVENLABS_API_KEY` | *nothing at runtime* | the film still has its real voice — every line is cached in `web/data/vo/` |

Spend is bounded in three places rather than one, because a public URL is a
public URL: `HEATCANYON_AGENT_BUDGET_USD` caps one turn,
`HEATCANYON_AGENT_TASK_BUDGET_TOKENS` gives the model a countdown it can see so
it wraps up instead of being cut off, and `HEATCANYON_AGENT_SESSION_BUDGET_USD`
caps this whole server process across every visitor. Set `HEATCANYON_AGENT=0` to
switch the analyst off entirely; everything else still works.

Built on the [FortyGuard tOS Enterprise API](https://api.fortyguard.com). The
deployed server never calls it — the pipeline's responses are cached and
committed, so no visitor can spend a credit.
"""


def stage() -> None:
    """Assemble the upload tree. Rebuilt from scratch every run, deliberately:
    an incremental sync leaves a file that was deleted upstream sitting in the
    Space forever, and the failure mode is a stale solved field."""
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    for item in INCLUDE:
        src = ROOT / item
        if not src.exists():
            if item.startswith(".agent/"):
                print(f"  ! {item} missing — chapter five will replay empty")
                continue
            sys.exit(f"missing: {item}")
        dst = STAGE / item
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            subprocess.run(
                ["rsync", "-a", *PRUNE, f"{src}/", f"{dst}/"], check=True)
        else:
            shutil.copy2(src, dst)
    (STAGE / "README.md").write_text(CARD)

    n = sum(1 for _ in STAGE.rglob("*") if _.is_file())
    mb = sum(f.stat().st_size for f in STAGE.rglob("*") if f.is_file()) / 1e6
    big = [f for f in STAGE.rglob("*") if f.is_file() and f.stat().st_size > 10e6]
    print(f"  staged {n} files, {mb:.0f} MB")
    # Hugging Face rejects a non-LFS file over 10 MB. Nothing here is close —
    # the largest solved field is 6.7 MB — but the pipeline could produce one,
    # and finding that out from a push rejection is a bad way to find it out.
    for f in big:
        print(f"  ! >10MB, needs LFS: {f.relative_to(STAGE)} "
              f"({f.stat().st_size/1e6:.1f} MB)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--space", required=True, help="owner/name, e.g. you/urbancanyon")
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--set-secret", action="append", default=[], metavar="KEY",
                    help="push this variable from the local environment into the "
                         "Space's secret store (repeatable)")
    ap.add_argument("--stage-only", action="store_true",
                    help="assemble the tree and stop, for inspection")
    ap.add_argument("--logs", action="store_true", help="follow the build after upload")
    args = ap.parse_args()

    print(f"→ staging {args.space}")
    stage()
    if args.stage_only:
        print(f"  {STAGE}")
        return 0

    from huggingface_hub import HfApi
    api = HfApi(token=os.getenv("HF_TOKEN") or True)

    print("→ ensuring the Space exists")
    api.create_repo(repo_id=args.space, repo_type="space", space_sdk="docker",
                    private=args.private, exist_ok=True)

    for key in args.set_secret:
        val = os.getenv(key)
        if not val:
            print(f"  ! {key} not in the environment — skipped")
            continue
        api.add_space_secret(repo_id=args.space, key=key, value=val)
        print(f"  secret {key} set")

    print("→ uploading (189 MB of solved fields; the first run is the slow one)")
    api.upload_folder(repo_id=args.space, repo_type="space", folder_path=str(STAGE),
                      commit_message="Deploy The Urban Canyon")

    url = f"https://huggingface.co/spaces/{args.space}"
    sub = args.space.replace("/", "-").replace(".", "-").lower()
    print(f"\n  {url}\n  https://{sub}.hf.space\n")

    if args.logs:
        follow(api, args.space)
    return 0


def follow(api, space: str) -> None:
    """Poll the Space's stage until it settles. `fetch_space_logs` needs the
    build to have started, so the stage is what is watched."""
    print("→ building")
    last, t0 = None, time.time()
    while time.time() - t0 < 1800:
        stage_now = api.get_space_runtime(repo_id=space).stage
        if stage_now != last:
            print(f"  {stage_now}")
            last = stage_now
        if stage_now in ("RUNNING", "RUNNING_BUILDING"):
            print("  up")
            return
        if stage_now in ("BUILD_ERROR", "RUNTIME_ERROR", "CONFIG_ERROR"):
            print(f"\n  failed at {stage_now}. Build log:\n")
            try:
                print(api.fetch_space_logs(repo_id=space, log_type="build")[-6000:])
            except Exception as exc:  # noqa: BLE001
                print(f"  (could not fetch logs: {exc})")
            return
        time.sleep(10)
    print("  timed out waiting for the build")


if __name__ == "__main__":
    raise SystemExit(main())

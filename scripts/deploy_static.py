"""Build the static half of the deployment, and push it to a CDN.

THE SPLIT

`heatcanyon serve` is one process and one origin. Deployed, the application is
two halves that want opposite things from a host:

* `web/` is 164 files and 189 MB of interface and solved fields. It never
  changes between deploys, it is pure bytes, and it wants a CDN — somewhere with
  free egress and a copy in every city.
* `/api` re-solves the energy balance and drives the analyst. It wants memory
  and a CPU, and it serves kilobytes of JSON.

Putting both on the compute host means paying egress on every visit for 189 MB
that never change. So the static half goes to a CDN and is handed the API's
origin on the way out.

HOW THE ORIGIN IS HANDED OVER

One line of injected script sets `window.__API_BASE__`, and `web/js/api.js`
reads it. It is injected into `<head>` ahead of the importmap, because classic
inline scripts run before deferred modules and `api.js` must see the value on
first evaluation. Nothing else in the bundle differs from the tree, which is
what makes the local single-origin case the same code path: with no injection
the value is absent, the base is the empty string, and every path stays
root-relative.

TARGETS

    --target gh-pages    force-push an orphan branch to the repo's origin.
                         Needs no account that a GitHub user does not already
                         have. Bandwidth is a soft 100 GB/month.
    --target cloudflare  `wrangler pages deploy`. Unlimited free egress and a
                         better network; needs a Cloudflare account and a
                         `wrangler login`.
    --target none        build the bundle and stop.

The orphan branch is rebuilt from a single commit every time rather than
appended to. 189 MB of binaries added to history on each deploy would grow the
repository without bound, and none of it is worth a second version.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / ".deploy" / "static"

MARKER = "<script type=\"importmap\">"


def build(api_base: str) -> None:
    if BUNDLE.exists():
        shutil.rmtree(BUNDLE)
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsync", "-a", "--exclude=__pycache__",
                    f"{ROOT / 'web'}/", f"{BUNDLE}/"], check=True)

    index = BUNDLE / "index.html"
    html = index.read_text()
    if MARKER not in html:
        sys.exit("index.html has no importmap to inject ahead of")

    base = api_base.rstrip("/")
    inject = (
        "<!-- Injected by scripts/deploy_static.py. The API is on another\n"
        "     origin; web/js/api.js reads this and every /api path resolves\n"
        "     against it. Absent locally, where the server is the same origin. -->\n"
        f"<script>window.__API_BASE__ = {base!r};</script>\n\n"
    ).replace("'", '"')
    index.write_text(html.replace(MARKER, inject + MARKER, 1))

    n = sum(1 for f in BUNDLE.rglob("*") if f.is_file())
    mb = sum(f.stat().st_size for f in BUNDLE.rglob("*") if f.is_file()) / 1e6
    print(f"  bundle: {n} files, {mb:.0f} MB, API -> {base or '(same origin)'}")


def gh_pages(branch: str) -> str:
    """Force-push the bundle as a single-commit orphan branch."""
    remote = subprocess.run(["git", "-C", str(ROOT), "remote", "get-url", "origin"],
                            capture_output=True, text=True, check=True).stdout.strip()
    # .nojekyll or GitHub Pages drops every path beginning with an underscore.
    (BUNDLE / ".nojekyll").write_text("")

    git = ["git", "-C", str(BUNDLE)]
    subprocess.run(git + ["init", "-q", "-b", branch], check=True)
    subprocess.run(git + ["add", "-A"], check=True)
    subprocess.run(git + ["-c", "user.name=deploy",
                          "-c", "user.email=deploy@localhost",
                          "commit", "-q", "-m", "The Urban Canyon — static bundle"],
                   check=True)
    print(f"  pushing {branch} to {remote.split('@')[-1]}")
    subprocess.run(git + ["push", "-q", "--force", remote, f"{branch}:{branch}"],
                   check=True)

    slug = remote.rstrip("/").removesuffix(".git").split(":")[-1].split("/")
    user, repo = slug[-2], slug[-1]
    return f"https://{user}.github.io/{repo}/"


def _wrangler(*args: str):
    """Run wrangler, streaming its output rather than capturing it.

    Captured-and-truncated output is how the first Cloudflare attempt reported
    "run `npx wrangler login` first" when the real error was that the Pages
    project did not exist yet — the banner filled the tail and the message fell
    off the top. A deploy tool that guesses at its own failures is worse than
    one that prints them.
    """
    return subprocess.run(["npx", "--yes", "wrangler@latest", *args], text=True)


def cloudflare(project: str) -> str:
    # `pages deploy` will not create the project, and its error for a missing one
    # suggests logging in again, which sends you looking in the wrong place.
    # Creating first is idempotent enough: an existing project makes this fail
    # harmlessly and the deploy below is what matters.
    _wrangler("pages", "project", "create", project, "--production-branch", "main")

    r = _wrangler("pages", "deploy", str(BUNDLE), "--project-name", project,
                  "--branch", "main", "--commit-dirty=true")
    if r.returncode != 0:
        sys.exit(f"wrangler exited {r.returncode} — see its output above. If it "
                 f"reports an auth problem, run `npx wrangler login`.")
    return f"https://{project}.pages.dev/"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default="",
                    help="origin of the API, e.g. https://x.run.app")
    ap.add_argument("--target", choices=("gh-pages", "cloudflare", "none"),
                    default="none")
    ap.add_argument("--branch", default="gh-pages")
    ap.add_argument("--project", default="urbancanyon")
    args = ap.parse_args()

    print(f"→ building the static bundle")
    build(args.api_base)

    if args.target == "gh-pages":
        url = gh_pages(args.branch)
    elif args.target == "cloudflare":
        url = cloudflare(args.project)
    else:
        print(f"  {BUNDLE}")
        return 0

    print(f"\n  {url}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

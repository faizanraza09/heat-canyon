"""Containment, and the frames a blocked call produces.

WHAT NEEDS CONTAINING AND WHY

The analyst has Bash and Write, and it needs them: the whole point of the shell
is that a script which computes the answer beats a tool that nearly does. But a
shell in a repository is a shell that can rewrite the repository, and a demo
whose agent can overwrite ``web/data`` can be asked one careless question and
come back with a different model than the one that was validated.

So two hooks:

``PreToolUse`` on Write, Edit and NotebookEdit refuses any path outside the run's
workspace. The workspace is per run, under ``.agent/runs/<run_id>``, so two
concurrent questions cannot tread on each other's scripts either.

``PreToolUse`` on Bash refuses a command that names a path outside the workspace
in a WRITING position, and refuses the small set of commands that are destructive
regardless of path. Reading anywhere in the repository is allowed on purpose: the
agent should be able to open ``heatcanyon/physics.py`` and check what a
coefficient actually is, and that is a strength rather than a leak.

WITH ONE EXCEPTION, AND IT WAS A HOLE.

``options.child_env`` is careful to hand the agent exactly one credential and
nothing else — an agent that can run bash should not also hold a Maps key. But
``.env`` sits in the root of this repository with the FortyGuard, Google Maps and
ElevenLabs keys in it, reading the repository was allowed, and nothing guarded a
read. ``cat .env`` is not a write and not a destructive command, so both existing
hooks waved it through, and the contents would have gone into the run transcript
— which is streamed over SSE and readable afterwards at
``/api/agent/runs/<id>/frames`` with no authentication. The environment was being
scrubbed at the front door while the filesystem held the back door open.

So ``PreToolUse`` on Read, Grep and Glob refuses a secret path, and the Bash
guard refuses a command that so much as names one. ``.env.example`` stays
readable: it is committed, it documents the variables, and it holds no values.

THE LIMIT OF THIS, said plainly because the rest of this file says it too: a
matcher on a command line does not stop an agent that means it. ``python -c
"print(open('.env').read())"`` names the file and is caught; a program that
assembles the string at runtime is not. A recursive Grep over the repository
could still surface a line from a secret this list has not heard of. The
honest fix is for the secret not to be on a path the agent can read at all —
keep ``.env`` outside the repository, or run the agent as a user that cannot
open it. This hook closes the easy door, which is the one that gets opened by a
question phrased carelessly or by a web page the agent was asked to read.

WHY NOT SIMPLY DENY BASH

Because then the agent cannot compute, and an analyst that cannot compute is a
chatbot with a database. The containment is a boundary around where it may
WRITE, not a removal of its ability to work.

WHAT THIS DOES NOT PRETEND TO BE

This is not a sandbox. A determined agent with a Python interpreter can defeat
any pattern match on a command line, and pretending otherwise would be worse than
saying so. It is a guard against carelessness, not against intent, and the real
boundary is that the process runs as a local user on a local demo with no
credentials in its environment beyond the one it needs. A deployment that exposes
this publicly should run the agent under the SDK's own sandbox settings and give
it a container, and ``options.py`` says the same.
"""

from __future__ import annotations

import re
import shlex
from pathlib import Path

from . import knobs

#: Commands refused outright, whatever their arguments. Not a security boundary
#: (see the module docstring) but the difference between a careless answer and a
#: lost afternoon.
FORBIDDEN = {"rm", "rmdir", "mv", "dd", "mkfs", "shutdown", "reboot", "kill",
             "killall", "pkill", "chown", "chmod", "sudo", "su", "systemctl",
             "crontab", "shred", "truncate"}

#: Git is read-only for the agent. `git log` and `git show` are legitimate ways to
#: find out when a coefficient changed; `git checkout` and `git clean` destroy
#: work that is not the agent's.
GIT_READONLY = {"log", "show", "diff", "status", "blame", "describe", "rev-parse",
                "ls-files", "cat-file", "shortlog", "config"}

#: Shell redirections and pipes into a file are how a Bash call writes without
#: naming a writing command, so they are inspected for their target.
_REDIRECT = re.compile(r"(?:>>?|\btee\b)\s*([^\s;&|]+)")

#: Files whose whole content is a credential. Matched on the basename, so the
#: path they are reached by does not matter.
SECRET_NAMES = {".env", ".envrc", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
                "credentials", "credentials.json", "service-account.json",
                "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts"}

#: Committed, valueless, and genuinely useful to the agent: `.env.example` is how
#: it finds out what a variable is called. Checked before SECRET_PREFIXES.
SECRET_EXEMPT = {".env.example", ".env.sample", ".env.template", ".env.dist"}

#: `.env`, `.env.local`, `.env.production` — the family, not just the bare name.
SECRET_PREFIXES = (".env.",)

SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".asc")

#: Any path passing through one of these is somebody's credential store.
SECRET_DIRS = {".ssh", ".aws", ".gnupg", ".gcloud", ".azure", ".kube", ".docker"}

#: THE CONTAINER'S VERSION OF THE SAME HOLE, and it is the one that matters in
#: production rather than on a laptop.
#:
#: `.dockerignore` keeps `.env` out of the image — deliberately, "the image gets
#: its credentials from the platform's secret store" — so on Cloud Run there is
#: no file to read and everything above this line is guarding a laptop. But
#: secrets from a secret store arrive as ENVIRONMENT, `options.child_env` strips
#: them from the agent's own environment, and the server process it was forked
#: from still holds every one of them: FortyGuard, Google Maps, ElevenLabs.
#:
#: `/proc/<pid>/environ` is readable by the user that owns the process, and in
#: that container the server and the agent are the same uid 1000. So
#: `cat /proc/1/environ` hands back the exact set of keys `child_env` went to the
#: trouble of withholding, and prints them into a transcript the browser is
#: served. Scrubbing the environment and leaving /proc open is scrubbing one copy
#: of a thing that has two.
_PROC_ENVIRON = re.compile(r"/proc/[^/\s]+/environ")


def _is_secret(path: str | Path) -> bool:
    """Does this path name something whose content is a credential?

    Errs towards refusing: a path that cannot even be parsed is refused, because
    the cost of a false positive here is the agent asking for a different file
    and the cost of a false negative is a key in a public transcript.
    """
    try:
        p = Path(str(path)).expanduser()
    except (OSError, RuntimeError, ValueError):
        return True
    low = p.name.lower()
    if low in SECRET_EXEMPT:
        return False
    if low in SECRET_NAMES or low.startswith(SECRET_PREFIXES):
        return True
    if low.endswith(SECRET_SUFFIXES):
        return True
    if _PROC_ENVIRON.search(p.as_posix()):
        return True
    return bool({q.lower() for q in p.parts} & SECRET_DIRS)


#: The same names, for a Bash command line where there is no argument to inspect
#: — only text. Deliberately broader than `_is_secret` and deliberately crude.
_SECRET_TEXT = re.compile(
    r"(?<![\w.-])\.env(?!\.example|\.sample|\.template|\.dist)(?![\w-])"
    r"|(?<![\w.-])\.(?:netrc|npmrc|pypirc|envrc|git-credentials)(?![\w-])"
    r"|(?<![\w.-])id_(?:rsa|dsa|ecdsa|ed25519)(?![\w-])"
    r"|(?<![\w/.-])\.(?:ssh|aws|gnupg|gcloud|azure|kube|docker)/"
    r"|[\w./-]+\.(?:pem|p12|pfx|keystore|jks)(?![\w-])"
    r"|/proc/[^/\s\"\']+/environ",
    re.IGNORECASE)


def _inside(path: str | Path, root: Path) -> bool:
    try:
        p = Path(path).expanduser()
        p = p if p.is_absolute() else (root / p)
        return root.resolve() in p.resolve().parents or p.resolve() == root.resolve()
    except (OSError, RuntimeError, ValueError):
        return False


def _deny(reason: str) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def build_hooks(workspace: Path, *, run_id: str | None = None,
                on_block=None) -> dict:
    """The hook matchers for one run, bound to its workspace."""
    from claude_agent_sdk import HookMatcher

    root = Path(workspace).resolve()

    def blocked(reason: str) -> dict:
        if on_block is not None:
            try:
                on_block(run_id, reason)
            except Exception:      # noqa: BLE001 - a dead stream must not fail a hook
                pass
        return _deny(reason)

    async def guard_writes(payload: dict, tool_use_id, context) -> dict:
        args = (payload or {}).get("tool_input") or {}
        target = args.get("file_path") or args.get("path") or args.get("notebook_path")
        if not target:
            return {}
        if _inside(target, root):
            return {}
        return blocked(
            f"Writing outside your workspace is refused. Your workspace is {root} "
            f"and you asked to write {target}. Everything you produce — scripts, "
            f"notes, charts — belongs in the workspace; the model's own data files "
            f"are read-only because the field on screen has to stay the one the "
            f"validation checked."
        )

    def secret_refusal(what: str) -> dict:
        return blocked(
            f"Reading {what} is refused. That file is a credential, not evidence. "
            f"Every number you state has to come out of the model, and nothing in "
            f"this analysis needs an API key — if you are looking for what a "
            f"variable is called, .env.example is readable and documents all of "
            f"them. Note also that your transcript is served to the browser, so a "
            f"key read here would be a key published."
        )

    async def guard_reads(payload: dict, tool_use_id, context) -> dict:
        """Read, Grep and Glob, which is where a credential actually leaks.

        The write hooks never looked at reads, and `child_env` withholding a key
        counts for nothing if the agent can open the file it came from. See the
        module docstring.
        """
        args = (payload or {}).get("tool_input") or {}
        for key in ("file_path", "path", "notebook_path", "pattern"):
            target = args.get(key)
            if target and _is_secret(target):
                return secret_refusal(str(target))
        return {}

    async def guard_bash(payload: dict, tool_use_id, context) -> dict:
        cmd = ((payload or {}).get("tool_input") or {}).get("command") or ""
        if not cmd.strip():
            return {}

        # Before anything else: does this command so much as name a credential?
        # Checked against the raw text rather than the parsed tokens, because
        # `cat "$HOME/.env"` and `cat .env` parse very differently and leak
        # identically.
        hit = _SECRET_TEXT.search(cmd)
        if hit:
            return secret_refusal(f"`{hit.group(0)}`")
        try:
            parts = shlex.split(cmd)
        except ValueError:
            parts = cmd.split()

        # Every word that looks like a command: the first token, and the first
        # token after a shell separator.
        heads: list[int] = [0]
        for i, tok in enumerate(parts):
            if tok in (";", "&&", "||", "|") and i + 1 < len(parts):
                heads.append(i + 1)
        for i in heads:
            if i >= len(parts):
                continue
            head = Path(parts[i]).name
            if head in FORBIDDEN:
                return blocked(
                    f"`{head}` is refused. If you need to remove something you "
                    f"created, write over it or leave it; nothing in this workspace "
                    f"needs deleting for the analysis to work.")
            if head == "git":
                sub = parts[i + 1] if i + 1 < len(parts) else ""
                if sub not in GIT_READONLY:
                    return blocked(
                        f"`git {sub}` is refused. Read-only git is available "
                        f"({', '.join(sorted(GIT_READONLY))}) and is genuinely "
                        f"useful for finding out when a coefficient changed, but "
                        f"this agent does not alter the repository.")

        for m in _REDIRECT.finditer(cmd):
            target = m.group(1)
            if target in ("/dev/null", "/dev/stderr", "/dev/stdout"):
                continue
            if not _inside(target, root):
                return blocked(
                    f"That command writes to {target}, which is outside your "
                    f"workspace ({root}). Redirect into the workspace instead.")
        return {}

    return {
        "PreToolUse": [
            HookMatcher(matcher="Write", hooks=[guard_writes]),
            HookMatcher(matcher="Edit", hooks=[guard_writes]),
            HookMatcher(matcher="NotebookEdit", hooks=[guard_writes]),
            HookMatcher(matcher="Bash", hooks=[guard_bash]),
            HookMatcher(matcher="Read", hooks=[guard_reads]),
            HookMatcher(matcher="Grep", hooks=[guard_reads]),
            HookMatcher(matcher="Glob", hooks=[guard_reads]),
        ],
    }

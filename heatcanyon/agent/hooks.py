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

    async def guard_bash(payload: dict, tool_use_id, context) -> dict:
        cmd = ((payload or {}).get("tool_input") or {}).get("command") or ""
        if not cmd.strip():
            return {}
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
        ],
    }

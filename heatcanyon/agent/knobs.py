"""Every configurable thing about the agent, in one file, all from the environment.

Spread across the modules that use them these turn into a dozen ``os.getenv``
calls nobody can enumerate, and "what model does this run on and what may it
spend" stops having a single answer. So they live here, each with its default and
its reason.
"""

from __future__ import annotations

import os
from pathlib import Path


def _s(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v.strip() if v and v.strip() else default


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(float(os.environ.get(name) or default))
    except (TypeError, ValueError):
        return default


def _b(name: str, default: bool) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    if not v:
        return default
    return v not in ("0", "false", "no", "off")


def enabled() -> bool:
    """Whether the agent surface is served at all. On by default: it degrades to a
    clear message when no credential is present, which is more useful than a
    feature that silently is not there."""
    return _b("HEATCANYON_AGENT", True)


def model() -> str:
    """PINNED. An unset model means the CLI's own default, which is not a decision
    this project gets to leave to the harness."""
    return _s("HEATCANYON_AGENT_MODEL", "claude-sonnet-5")


def effort() -> str:
    return _s("HEATCANYON_AGENT_EFFORT", "high")


def auth_mode() -> str:
    """``cli`` inherits the machine's own ``claude`` login and is the local
    default — it is what makes this demo work on a laptop with no key in the
    environment. ``api_key`` and ``oauth`` inject exactly one credential and are
    what a deployment uses."""
    return _s("HEATCANYON_AGENT_AUTH", "cli").lower()


def turn_budget_usd() -> float:
    """A real cap the harness enforces, unlike max_turns, which is a cliff that
    discards unwritten work."""
    return _f("HEATCANYON_AGENT_BUDGET_USD", 2.50)


def session_budget_usd() -> float:
    """Across every run this process serves. A public demo should not be able to
    spend without bound because somebody left a tab open asking questions."""
    return _f("HEATCANYON_AGENT_SESSION_BUDGET_USD", 40.0)


def turn_timeout_s() -> int:
    return _i("HEATCANYON_AGENT_TIMEOUT_S", 900)


def task_budget_tokens() -> int:
    """A countdown the model can SEE, so it wraps up and answers rather than being
    guillotined mid-sentence by the dollar cap. The API minimum is 20,000."""
    return _i("HEATCANYON_AGENT_TASK_BUDGET_TOKENS", 400_000)


def max_concurrent() -> int:
    return _i("HEATCANYON_AGENT_MAX_CONCURRENT", 3)


def subagents() -> bool:
    return _b("HEATCANYON_AGENT_SUBAGENTS", True)


def thinking() -> str:
    """``summarized`` forwards a summary of the reasoning to the transcript, which
    is worth a great deal here: watching the analyst decide which query to run is
    most of how a reviewer judges whether to trust the answer."""
    return _s("HEATCANYON_AGENT_THINKING", "summarized")


def workspace_root() -> Path:
    """Where runs keep their scratch files, scripts, charts and notes.

    Inside the repository rather than /tmp, because the agent's output — a script
    that produced a finding, a chart somebody wants to keep — is worth surviving
    a reboot, and because a path under the repo is a path the containment hook
    can reason about.
    """
    return Path(_s("HEATCANYON_AGENT_WORKSPACE", ".agent")).resolve()


def data_root() -> Path:
    return Path(_s("HEATCANYON_DATA", "web/data")).resolve()


def describe() -> dict:
    """The operating envelope, for the interface to show. No secrets."""
    return {
        "enabled": enabled(),
        "model": model(),
        "effort": effort(),
        "auth_mode": auth_mode(),
        "thinking": thinking(),
        "turn_budget_usd": turn_budget_usd(),
        "session_budget_usd": session_budget_usd(),
        "turn_timeout_s": turn_timeout_s(),
        "task_budget_tokens": task_budget_tokens(),
        "max_concurrent": max_concurrent(),
        "subagents": subagents(),
        "workspace_root": str(workspace_root()),
        "data_root": str(data_root()),
    }

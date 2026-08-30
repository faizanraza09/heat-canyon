"""Build the ``ClaudeAgentOptions`` for one turn — the one place spend and auth live.

Everything cost- or credential-shaped is here so there is exactly one answer to
"what model does this run on, what may it spend, and whose credential does it
use". Four of those answers are enforced rather than left to a caller, and each
one is a mistake that is easy to make and expensive to find:

* **the model is pinned**, because an unset model means the CLI's own default and
  that is not a decision this project should leave to the harness;
* **``max_budget_usd`` is always set**, because ``max_turns`` is a cliff that
  discards work the agent was holding rather than a budget;
* **``task_budget`` is also set**, because ``max_budget_usd`` is invisible to the
  model and cuts mid-sentence, while a token countdown the model can see makes it
  wrap up and answer;
* **the credential is chosen by mode and injected exclusively**, because an
  injected API key OUTRANKS the machine's own login rather than supplementing it,
  so "inject nothing" is not the same as "use the CLI login" once anything has
  loaded a .env.

And one containment decision that is not about cost at all: ``setting_sources=[]``
plus ``CLAUDE_CODE_DISABLE_AUTO_MEMORY``. Without them a turn in this repository
loads the repository's own CLAUDE.md and the operator's private Claude Code memory
files into the analyst's context. That is somebody's working notes, it is not this
model's evidence, and an analyst that can answer a question out of it is an
analyst producing numbers with no provenance. The skills, plugins and tools this
agent gets are the ones chosen here, enumerated, and nothing else.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from . import agents as agent_registry
from . import knobs
from . import tools as tool_registry
from .hooks import build_hooks
from .persona import system_prompt

logger = logging.getLogger(__name__)

#: Built-in tools the analyst gets. Bash, Read, Write, Edit, Glob and Grep are
#: what make "write a script that computes it" real; the containment hooks bound
#: where they may write.
#:
#: No delegation tool. The specialists are reached through
#: ``mcp__heatcanyon__consult_specialist``, which blocks until the specialist is
#: done — see ``agents.py`` for the turn that was lost finding out why the built-in
#: route cannot work here.
BUILTIN_TOOLS = ("Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite",
                 "WebSearch", "WebFetch")

#: Denied by name. `allowed_tools` is NOT a complete allowlist for the harness's
#: own tools, so the ones that reach outside this process — other sessions, other
#: machines, schedules, the network — are refused explicitly.
#:
#: `Agent` heads the list and it cost a turn to learn why. Registering the
#: specialists through `ClaudeAgentOptions(agents=...)` made them reachable only
#: through `Agent`, which is ASYNCHRONOUS: the analyst delegated two jobs,
#: announced that both were running in the background, and ended its turn with
#: nothing in it. There is no cross-turn notification a server-driven run can wait
#: for. `consult_specialist` replaces it and blocks. `Task`, `ScheduleWakeup` and
#: `Workflow` are refused for the same reason — every one of them implies
#: asynchronous work that does not exist here.
#:
#: WebSearch and WebFetch were refused here for a long time, and the reason is
#: worth keeping on the record now that they are not: this analyst's authority
#: comes from the fact that every number it states came out of this model, and an
#: agent that can read the open web will eventually answer a question about
#: Manhattan from a news article.
#:
#: They are allowed by explicit instruction, so the guard moves from the tool list
#: into the prompt: the web is for context the model does not hold (a programme's
#: funding rules, a standard's threshold, what a borough announced last week), it
#: is labelled EXTERNAL wherever it appears, and it may never supply a figure that
#: the model itself is capable of producing. See the WHEN YOU USE THE WEB section
#: in persona.py, which is the half of this that actually does the work.
DISALLOWED_TOOLS = ("Agent", "Task", "ListAgents", "SendMessage", "Monitor",
                    "TaskOutput", "TaskStop", "ScheduleWakeup", "Workflow",
                    "CronCreate", "CronList", "CronDelete",
                    "PushNotification", "RemoteTrigger", "EnterWorktree",
                    "ExitWorktree", "Artifact", "EndConversation", "Skill",
                    "ShareOnboardingGuide", "ReportFindings")

#: Non-credential environment the child needs. Everything else in os.environ is
#: withheld: an agent that can run bash should not also hold a Maps key.
PASSTHROUGH_ENV = ("PATH", "HOME", "LANG", "LC_ALL", "NODE_PATH", "ANTHROPIC_BASE_URL")

REPO_ROOT = Path(__file__).resolve().parents[2]


class AuthError(RuntimeError):
    pass


def child_env() -> dict[str, str]:
    """The child's environment, carrying EXACTLY ONE credential family."""
    env = {k: os.environ[k] for k in PASSTHROUGH_ENV if os.environ.get(k)}
    # The repository importable, so a script the agent writes can do
    # `import heatcanyon.agent.dataset`. This grants no capability it lacked — it
    # can already run any file in the repo by absolute path — and it removes the
    # single most common reason a generated script fails.
    env["PYTHONPATH"] = os.pathsep.join(
        filter(None, [str(REPO_ROOT), os.environ.get("PYTHONPATH", "")]))
    env["HEATCANYON_REPO"] = str(REPO_ROOT)
    env["HEATCANYON_DATA"] = str(knobs.data_root())
    # See the module docstring: the operator's own Claude Code notes are not this
    # model's evidence.
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"

    mode = knobs.auth_mode()
    if mode == "api_key":
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise AuthError("HEATCANYON_AGENT_AUTH=api_key but ANTHROPIC_API_KEY is "
                            "not set.")
        env["ANTHROPIC_API_KEY"] = key
    elif mode == "oauth":
        token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
        if not token:
            raise AuthError("HEATCANYON_AGENT_AUTH=oauth but CLAUDE_CODE_OAUTH_TOKEN "
                            "is not set.")
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    elif mode == "cli":
        # Injecting nothing is NOT enough. `ClaudeAgentOptions.env` is MERGED onto
        # os.environ, and anything that loaded .env has already put
        # ANTHROPIC_API_KEY there — the child would inherit it and be shadowed. So
        # it is removed from this process rather than merely omitted here.
        for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
            os.environ.pop(var, None)
    else:
        raise AuthError(f"HEATCANYON_AGENT_AUTH={mode!r} — expected cli | api_key | "
                        f"oauth.")
    return env


def available() -> tuple[bool, str]:
    """Whether a turn can run at all, and why not if it cannot.

    Checked before a run starts so the console can say something specific rather
    than showing a spinner that ends in a stack trace.
    """
    if not knobs.enabled():
        return (False, "The analyst is switched off (HEATCANYON_AGENT=0).")
    try:
        import claude_agent_sdk  # noqa: F401
    except ImportError:
        return (False, "claude-agent-sdk is not installed. `pip install "
                       "claude-agent-sdk`, then restart the server.")
    mode = knobs.auth_mode()
    if mode == "api_key" and not os.environ.get("ANTHROPIC_API_KEY"):
        return (False, "HEATCANYON_AGENT_AUTH=api_key but ANTHROPIC_API_KEY is not "
                       "set.")
    if mode == "oauth" and not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return (False, "HEATCANYON_AGENT_AUTH=oauth but CLAUDE_CODE_OAUTH_TOKEN is "
                       "not set.")
    if mode == "cli":
        from shutil import which
        if not which("claude"):
            return (False, "HEATCANYON_AGENT_AUTH=cli needs the `claude` CLI on PATH "
                           "and logged in. Install Claude Code and run `claude` once, "
                           "or set ANTHROPIC_API_KEY and "
                           "HEATCANYON_AGENT_AUTH=api_key.")
    return (True, "")


def build_options(workspace: Path, *, run_id: str | None = None,
                  resume: str | None = None, on_block=None,
                  include_subagents: bool | None = None):
    """Assemble the options for one turn, in ``workspace``."""
    from claude_agent_sdk import ClaudeAgentOptions

    workspace = Path(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    task_tokens = knobs.task_budget_tokens()
    subs = knobs.subagents() if include_subagents is None else include_subagents

    thinking_cfg = None
    if knobs.thinking() in ("summarized", "summarised"):
        # Summarised rather than off, because the transcript showing which query
        # the analyst chose is most of how a reviewer judges the answer.
        thinking_cfg = {"type": "adaptive", "display": "summarized"}
    elif knobs.thinking() == "off":
        thinking_cfg = {"type": "disabled"}

    return ClaudeAgentOptions(
        cwd=str(workspace),
        model=knobs.model(),
        effort=knobs.effort(),
        # The runaway guard: real, harness-enforced, and INVISIBLE to the model, so
        # it cuts mid-tool-call. `task_budget` below is what the model paces against.
        max_budget_usd=knobs.turn_budget_usd(),
        # A countdown the model can see mid-generation, so it wraps up and answers
        # instead of being guillotined holding the finding. The API minimum is 20,000.
        task_budget=({"total": max(20_000, task_tokens)} if task_tokens else None),
        permission_mode="acceptEdits",
        # Nothing from the filesystem. See the module docstring: this is a
        # containment decision about whose notes end up in the analyst's context,
        # not a tidiness one.
        setting_sources=[],
        mcp_servers={"heatcanyon": tool_registry.build_server(
            run_id=run_id, workspace=workspace)},
        allowed_tools=list(BUILTIN_TOOLS) + tool_registry.allowed_tool_names(),
        disallowed_tools=list(DISALLOWED_TOOLS),
        # None, always. The specialists are a TOOL, not an SDK subagent roster:
        # registering them here makes them reachable only through the asynchronous
        # `Agent`, and it also adds the machine's own built-in agents to the
        # analyst's roster, which is a containment leak on top of a correctness one.
        agents=None,
        hooks=build_hooks(workspace, run_id=run_id, on_block=on_block),
        env=child_env(),
        thinking=thinking_cfg,
        # A `run_python` result over the whole facade field, or a `Read` of
        # year.json, comfortably exceeds the 1 MB default — and that failure is
        # FATAL to the session rather than a recoverable tool error.
        max_buffer_size=32 * 1024 * 1024,
        # A FULL system prompt, not `{"preset": "claude_code", "append": ...}`.
        # The preset is Claude Code's software-engineering prompt and appending a
        # persona to it produces an engineer wearing a hat: asked about heat, it
        # reaches for the repository. See persona.py.
        system_prompt=system_prompt(),
        resume=resume,
    )


def describe_envelope() -> dict:
    """The operating envelope, for the console to show. No secrets."""
    ok, why = available()
    return {
        **knobs.describe(),
        "available": ok,
        "unavailable_because": why or None,
        "tools": tool_registry.TOOL_NAMES,
        "builtin_tools": list(BUILTIN_TOOLS),
        "disallowed_tools": list(DISALLOWED_TOOLS),
        "specialists": ([{"name": k, "description": v["description"],
                          "tools": len(v["tools"])}
                         for k, v in agent_registry.specialists().items()]
                        if knobs.subagents() else []),
        "specialists_reached_by": "mcp__heatcanyon__consult_specialist (blocking)",
        "subagents": list(agent_registry.AGENT_NAMES) if knobs.subagents() else [],
        "web_access": True,
        "web_access_note": (
            "The analyst can search and fetch the open web, for context the model "
            "does not hold: what a programme funds, what a standard sets as a "
            "threshold, what the city announced. It may not be the source of a "
            "figure the model can produce itself, and anything read outside the "
            "model is labelled EXTERNAL with its source named. The authority still "
            "comes from every number having come out of this model."
        ),
    }

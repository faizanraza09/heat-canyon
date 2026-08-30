"""SDK messages translated into the frames the console renders.

One frame shape, so the browser has a single switch and adding an SDK message
type cannot break it:

    {"type": "<kind>", ...payload}

Kinds: ``run_started`` ``text`` ``thinking`` ``tool_use`` ``tool_result``
``map`` ``chart`` ``blocked`` ``usage`` ``turn_complete`` ``run_finished``
``replay_done`` ``ping`` ``error``.

``turn_complete`` is the SDK's own end of turn; ``run_finished`` is the stream's
authoritative last frame, read from the status file once the task has settled.
Only the second one is terminal for a consumer.

Three deliberate choices.

**Thinking is forwarded when it is available.** The raw chain of thought is not
returned by the model; what arrives is the summary, and it is worth showing here
in a way it usually is not. Watching the analyst decide which query to run is
most of how a reviewer judges whether to trust the answer.

**Tool inputs are truncated, results are truncated harder.** A ``run_python``
result can be tens of thousands of characters. The console wants to show that it
happened and roughly what came back; the full text is in the run's JSONL on disk.

**Map actions and charts are frames like any other.** They arrive in the
transcript, in order, beside the sentence that produced them, and a console that
connects late replays them in the same order. That is why the agent driving the
map needs no second channel.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

TEXT_CAP = 24_000
INPUT_CAP = 2_000
RESULT_CAP = 3_000


def _clip(value: Any, cap: int) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text if len(text) <= cap else text[:cap] + f"… [+{len(text) - cap} chars]"


def frame(kind: str, **payload: Any) -> dict:
    return {"type": kind, **payload}


#: Terminal reasons that mean the agent finished rather than the harness stopping
#: it. This set is the vocabulary's only owner: it lives beside the frame that
#: carries it, and ``run_finished`` ships the verdict as ``cut_off`` so no
#: consumer has to know the words. A truthiness check on ``terminal_reason`` shows
#: "stopped early" under every clean turn, because ``completed`` is a reason too.
CLEAN_TERMINAL_REASONS = frozenset({"completed", "end_turn", "stop_sequence"})


def is_cut_off(terminal_reason: str | None, is_error: bool = False) -> bool:
    return bool(is_error) or (terminal_reason is not None
                              and terminal_reason not in CLEAN_TERMINAL_REASONS)


def to_frames(message: Any) -> Iterator[dict]:
    """Zero or more console frames for one SDK message."""
    from claude_agent_sdk import (AssistantMessage, ResultMessage, SystemMessage,
                                 TextBlock, ThinkingBlock, ToolResultBlock,
                                 ToolUseBlock, UserMessage)

    if isinstance(message, SystemMessage):
        if message.subtype == "init":
            data = message.data or {}
            yield frame("run_started",
                        model=data.get("model"),
                        tools=len(data.get("tools") or []),
                        agents=data.get("agents") or [],
                        cwd=data.get("cwd"))
        return

    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, TextBlock):
                if block.text.strip():
                    yield frame("text", text=_clip(block.text, TEXT_CAP))
            elif isinstance(block, ThinkingBlock):
                if (block.thinking or "").strip():
                    yield frame("thinking", text=_clip(block.thinking, TEXT_CAP))
            elif isinstance(block, ToolUseBlock):
                yield frame("tool_use", id=block.id, name=_short(block.name),
                            full_name=block.name,
                            input=_clip(block.input, INPUT_CAP))
        return

    if isinstance(message, UserMessage):
        content = message.content
        if isinstance(content, list):
            for block in content:
                if isinstance(block, ToolResultBlock):
                    yield frame("tool_result",
                                tool_use_id=getattr(block, "tool_use_id", None),
                                is_error=bool(getattr(block, "is_error", False)),
                                content=_clip(getattr(block, "content", ""),
                                              RESULT_CAP))
        return

    if isinstance(message, ResultMessage):
        yield frame("usage",
                    cost_usd=round(message.total_cost_usd or 0.0, 6),
                    turns=message.num_turns,
                    duration_ms=message.duration_ms,
                    stop_reason=message.stop_reason)
        reason = getattr(message, "terminal_reason", None)
        # `turn_complete`, NOT `run_finished`. The stream emits its own
        # `run_finished` as the authoritative last frame, read from the status file
        # after the task has settled, and having the SDK's own end-of-turn message
        # carry the same name meant a console saw two terminal frames with
        # different fields filled in — the first with no state and the second with
        # no cut_off. One name, one meaning.
        yield frame("turn_complete",
                    session_id=message.session_id,
                    is_error=bool(message.is_error),
                    terminal_reason=reason,
                    cut_off=is_cut_off(reason, bool(message.is_error)))
        return


def _short(name: str) -> str:
    """``mcp__heatcanyon__query_buildings`` reads as ``query_buildings`` in the UI."""
    return name.split("__")[-1] if name.startswith("mcp__") else name


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, default=str)}\n\n"

"""Run a turn in the background and stream it. Never synchronously.

WHY BACKGROUND IS NOT OPTIONAL

A question like "where should the city act first, and what does each measure buy
across the year" is minutes of work: a dozen queries, several physics re-solves, a
statistical test, a chart. A synchronous HTTP endpoint cannot express that. Any
proxy in front of this server cuts an idle connection long before the answer
exists, and even without one, a request that returns nothing for four minutes is
indistinguishable from a hang.

So ``start_turn`` returns a ``run_id`` immediately and the work continues in a
task. The console streams ``/events`` and may reconnect freely.

DURABILITY WITHOUT A DATABASE

Every frame is appended to ``.agent/runs/<run_id>/frames.jsonl`` as it is
produced, and the status to ``status.json``. That buys three things for the cost
of one append: a reconnecting console replays from the file and misses nothing, a
process restart leaves a readable record rather than a silent gap, and a run
killed at its budget cliff still shows what it had done. There is no worker and no
table to reconcile against, so the file IS the state.

THREE BOUNDS ON SPEND, AND THEY HAD TO BE RECONCILED

``max_budget_usd`` bounds one SDK run inside the harness, invisibly to the model,
by killing it mid-tool-call. ``session_budget_usd`` bounds this whole process
across every run and is checked here, before one starts — a demo left open in a
tab should not be able to spend without limit. Between them sits ``task_budget``
(see ``options.py``), a token countdown the model can SEE, so it wraps up and
answers rather than being guillotined holding the work.

CONVERSATION CONTINUITY

A thread is the SDK session id carried forward. ``start_turn(resume=...)`` picks
up the previous turn's session, so a follow-up question does not re-derive the
answer to the first. A session the CLI can no longer load is retried cold exactly
once, because otherwise one bad id breaks every future turn in that conversation —
and because an empty resumed turn is indistinguishable from a broken one, and
showing somebody nothing at all is the worst available answer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

from . import gate, knobs
from . import tools as tool_registry
from .events import frame, is_cut_off, to_frames
from .options import available, build_options

logger = logging.getLogger(__name__)

#: Every state a run can end in. ``cut_off`` is the harness stopping the agent —
#: budget or timeout — and is NOT success. ``orphaned`` is a process that went
#: away. All of them are terminal, so a stream must not tail them for ever.
TERMINAL_STATES = ("finished", "cut_off", "failed", "interrupted", "timeout",
                   "orphaned")

#: How long a stream may be silent before it sends a keepalive. A live turn can
#: legitimately produce no frames for a minute — one long `run_intervention` over
#: twelve months — and without a heartbeat the console's connection dies mid-turn
#: while the agent is still working.
HEARTBEAT_S = 15

#: How long a run claiming to be running may go without a frame before it is
#: presumed dead. Generous, because a single tool call can be slow; the point is
#: only to catch a run whose process is gone.
ORPHAN_AFTER_S = 600


@dataclass
class _InFlight:
    task: asyncio.Task | None
    started_at: float
    question: str
    reserved_usd: float


_RUNNING: dict[str, _InFlight] = {}
_PENDING: list[str] = []


class BudgetExceeded(RuntimeError):
    pass


class Busy(RuntimeError):
    """Too many turns already waiting. A 429, not a failure — see gate.py."""


class Unavailable(RuntimeError):
    pass


# ------------------------------------------------------------------ storage


def runs_dir() -> Path:
    d = knobs.workspace_root() / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def run_dir(run_id: str) -> Path:
    d = runs_dir() / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _status_path(run_id: str) -> Path:
    return run_dir(run_id) / "status.json"


def _frames_path(run_id: str) -> Path:
    return run_dir(run_id) / "frames.jsonl"


def read_status(run_id: str) -> dict | None:
    try:
        return json.loads(_status_path(run_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_status(run_id: str, **fields) -> dict:
    status = read_status(run_id) or {"run_id": run_id}
    status.update(fields)
    _status_path(run_id).write_text(json.dumps(status, indent=2, default=str),
                                   encoding="utf-8")
    return status


def append_frame(run_id: str, payload: dict) -> None:
    with _frames_path(run_id).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, default=str) + "\n")


def read_frames(run_id: str) -> list[dict]:
    out: list[dict] = []
    try:
        with _frames_path(run_id).open("r", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except OSError:
        return []
    return out


def session_cost_so_far() -> float:
    """What this process has spent, summed over the run directory.

    Runs flagged ``exhibit`` are skipped, and that flag exists for exactly one
    run: the transcript chapter five of the film replays, which is committed
    because a run directory is not reproducible. It cost $1.89 when it was
    recorded and it costs nothing to serve, but the sum here gates admission —
    so without the flag every deployment boots having already spent that money,
    for ever, against a budget it never used. A checked-in exhibit is not spend.
    """
    total = 0.0
    for d in runs_dir().glob("*/status.json"):
        try:
            rec = json.loads(d.read_text(encoding="utf-8"))
            if rec.get("exhibit"):
                continue
            total += float(rec.get("cost_usd") or 0.0)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            continue
    for rec in _RUNNING.values():
        total += rec.reserved_usd
    return round(total, 6)


def list_runs(limit: int = 40, *, client: str | None = None) -> list[dict]:
    """This client's runs, newest first.

    Unscoped, this returned every question this server had ever been asked, to
    anybody who asked for the list. The demo question names a building and a
    contractor; people type their own into that box. A run recorded before runs
    had owners has no `client` and is shown to nobody rather than to everybody —
    the operator can still read them off disk, and the alternative is a leak that
    survives the fix.
    """
    out = []
    for p in runs_dir().glob("*/status.json"):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if client is not None and rec.get("client") != client:
            continue
        out.append(rec)
    out.sort(key=lambda s: s.get("started_at") or 0, reverse=True)
    return out[:limit]


def owns(run_id: str, client: str | None) -> bool:
    """May this client see this run? Unowned runs are nobody's; see `list_runs`."""
    if client is None:
        return True                     # an operator-side caller, not a request
    st = read_status(run_id)
    return bool(st) and st.get("client") == client


# ------------------------------------------------------- the live action sink
#
# Tools that reach the browser (map_control, chart) publish through here so their
# effect lands in the transcript, in order, beside the sentence that produced it.

def _publish_action(run_id: str, action: dict) -> None:
    append_frame(run_id or "anonymous", frame(action.get("kind", "map"), **action))


def _publish_block(run_id: str | None, reason: str) -> None:
    if run_id:
        append_frame(run_id, frame("blocked", reason=reason))


tool_registry.set_action_sink(_publish_action)


# ------------------------------------------------------------------ the turn


def _is_dead_resume(resume: str | None, useful_frames: int) -> bool:
    """A resumed session that returned nothing at all.

    Measured on a live study in the reference implementation this borrows from: a
    resume came back in 48 ms with zero turns, no output and no cost. Whatever the
    cause, an empty resumed turn is indistinguishable from a broken one, and the
    right response is to retry cold once rather than show the person nothing.
    """
    return bool(resume) and useful_frames == 0


async def _drive(run_id: str, question: str, resume: str | None) -> None:
    from claude_agent_sdk import ClaudeSDKClient

    ws = run_dir(run_id) / "workspace"
    ws.mkdir(parents=True, exist_ok=True)
    started = time.time()
    cost = 0.0
    session_id = resume
    terminal_reason: str | None = None
    is_error = False
    frames_seen = 0
    useful = 0

    async def consume(resume_id: str | None) -> None:
        nonlocal cost, session_id, terminal_reason, is_error, frames_seen, useful
        options = build_options(ws, run_id=run_id, resume=resume_id,
                               on_block=_publish_block)
        async with ClaudeSDKClient(options=options) as client:
            await client.query(question)
            async for message in client.receive_response():
                for payload in to_frames(message):
                    frames_seen += 1
                    if payload["type"] in ("text", "thinking", "tool_use"):
                        useful += 1
                    if payload["type"] == "usage":
                        cost = float(payload.get("cost_usd") or 0.0)
                    if payload["type"] == "turn_complete":
                        session_id = payload.get("session_id") or session_id
                        terminal_reason = payload.get("terminal_reason") or terminal_reason
                        is_error = bool(payload.get("is_error")) or is_error
                    append_frame(run_id, payload)

    try:
        try:
            await asyncio.wait_for(consume(resume), timeout=knobs.turn_timeout_s())
            if _is_dead_resume(resume, useful):
                logger.warning("[AGENT] run %s resumed %s and produced nothing — "
                               "retrying cold", run_id, resume)
                append_frame(run_id, frame(
                    "text",
                    text="_The previous conversation could not be picked up, so this "
                         "turn starts fresh. The model itself is unchanged._"))
                await asyncio.wait_for(consume(None),
                                       timeout=knobs.turn_timeout_s())
        except asyncio.TimeoutError:
            _write_status(run_id, state="timeout", cost_usd=cost,
                          seconds=round(time.time() - started, 1),
                          error=f"The turn passed {knobs.turn_timeout_s()}s and was "
                                f"stopped. Everything it had produced is above.")
            append_frame(run_id, frame("error", message="turn timed out"))
            return
        except asyncio.CancelledError:
            _write_status(run_id, state="interrupted", cost_usd=cost,
                          seconds=round(time.time() - started, 1),
                          stopped_by="user")
            append_frame(run_id, frame("error", message="stopped"))
            raise
        except Exception as exc:      # noqa: BLE001
            # A DEAD SESSION MUST NOT KILL THE THREAD. `resume` carries the previous
            # turn's session id, and a session the CLI can no longer load would
            # otherwise fail every future turn in that conversation. Retried once
            # cold, and only when nothing had been produced yet, so this can never
            # replay work that already happened.
            if not resume or frames_seen:
                raise
            logger.warning("[AGENT] run %s could not resume %s (%s) — retrying cold",
                           run_id, resume, exc)
            append_frame(run_id, frame(
                "text",
                text="_The previous conversation could not be resumed, so this turn "
                     "starts fresh._"))
            await asyncio.wait_for(consume(None), timeout=knobs.turn_timeout_s())

        state = "cut_off" if is_cut_off(terminal_reason, is_error) else "finished"
        _write_status(run_id, state=state, cost_usd=cost,
                      seconds=round(time.time() - started, 1),
                      session_id=session_id, terminal_reason=terminal_reason,
                      frames=frames_seen)
    except asyncio.CancelledError:
        raise
    except Exception as exc:          # noqa: BLE001
        logger.exception("[AGENT] run %s failed", run_id)
        _write_status(run_id, state="failed", cost_usd=cost,
                      seconds=round(time.time() - started, 1),
                      error=f"{type(exc).__name__}: {exc}")
        append_frame(run_id, frame("error", message=f"{type(exc).__name__}: {exc}"))
    finally:
        _RUNNING.pop(run_id, None)
        _start_pending()


def _start_pending() -> None:
    """Promote a queued run now that a slot is free."""
    while _PENDING and len(_RUNNING) < knobs.max_concurrent():
        run_id = _PENDING.pop(0)
        status = read_status(run_id)
        if not status or status.get("state") != "queued":
            continue
        _launch(run_id, status.get("question") or "", status.get("resume"))


def _launch(run_id: str, question: str, resume: str | None) -> None:
    _write_status(run_id, state="running", started_at=time.time())
    task = asyncio.get_running_loop().create_task(_drive(run_id, question, resume))
    _RUNNING[run_id] = _InFlight(task=task, started_at=time.time(),
                                 question=question,
                                 reserved_usd=knobs.turn_budget_usd())


def start_turn(question: str, *, resume: str | None = None,
               title: str | None = None, client: str | None = None) -> dict:
    """Admit a turn and start or queue it. Returns immediately.

    ``client`` is recorded on the run so a transcript can be shown to the person
    who asked for it and not to everybody else. It is scoping, not identity —
    see ``gate.py``.
    """
    ok, why = available()
    if not ok:
        raise Unavailable(why)

    spent = session_cost_so_far()
    cap = knobs.session_budget_usd()
    if spent >= cap:
        raise BudgetExceeded(
            f"This server has spent ${spent:.2f} of its ${cap:.2f} session budget on "
            f"the analyst. Raise HEATCANYON_AGENT_SESSION_BUDGET_USD and restart, or "
            f"clear {runs_dir()}. Everything else in the application still works.")

    # BEFORE anything is written to disk. The queue check used to come after the
    # status file and the frame log had been created, so a request that was never
    # going to be served still cost two files — which made a loop against this
    # endpoint a disk-filler as well as a budget-drainer. Nothing is created for
    # a turn that is being refused.
    if len(_PENDING) >= gate.max_queue():
        raise Busy(
            f"{len(_PENDING)} questions are already waiting and that is the queue "
            f"limit. The analyst answers {knobs.max_concurrent()} at a time and "
            f"each one takes minutes; joining a queue this long would be a worse "
            f"answer than being told to come back.")

    run_id = f"r{int(time.time())}{uuid.uuid4().hex[:6]}"
    _write_status(run_id, question=question, title=title or question[:80],
                  state="queued", queued_at=time.time(), resume=resume,
                  model=knobs.model(), cost_usd=0.0, client=client,
                  session_budget_usd=cap, session_spent_usd=spent)
    _frames_path(run_id).touch()

    # Beyond the concurrency ceiling a turn QUEUES rather than being refused:
    # each run is an SDK subprocess with a 32 MB buffer, so parallelism has a
    # real ceiling, but hitting it is a scheduling fact and not an error the
    # person asking should have to handle.
    if len(_RUNNING) >= knobs.max_concurrent():
        _PENDING.append(run_id)
        return {"run_id": run_id, "state": "queued",
                "ahead_of_you": len(_PENDING) - 1 + len(_RUNNING)}
    _launch(run_id, question, resume)
    return {"run_id": run_id, "state": "running"}


def interrupt(run_id: str) -> dict:
    rec = _RUNNING.get(run_id)
    if rec is None:
        if run_id in _PENDING:
            _PENDING.remove(run_id)
            _write_status(run_id, state="interrupted", stopped_by="user",
                          error="Cancelled before it started; nothing was spent.")
            return {"run_id": run_id, "stopped": True, "was": "queued"}
        return {"run_id": run_id, "stopped": False,
                "state": (read_status(run_id) or {}).get("state")}
    if rec.task is not None:
        rec.task.cancel()
    return {"run_id": run_id, "stopped": True, "was": "running"}


def interrupt_all(*, client: str | None = None) -> dict:
    """Stop this client's work. Unscoped, one POST cancelled everybody's."""
    ids = [r for r in list(_RUNNING) + list(_PENDING) if owns(r, client)]
    for rid in ids:
        interrupt(rid)
    return {"stopped": len(ids), "run_ids": ids}


# ------------------------------------------------------------------ streaming


def reconcile_orphans() -> int:
    """Mark runs left running by a process that no longer exists.

    ``_RUNNING`` lives in this process, so a restart mid-turn leaves a status that
    says "running" for ever and ``stream`` tails it indefinitely — the console
    shows a live spinner on a turn that died with the old process. There is no
    worker to reconcile from, so the test is the two things knowable from here:
    this process is not running it, and its frame log has gone quiet. Done at read
    time rather than at boot, so it also covers a crash nothing recovered from.
    """
    changed = 0
    now = time.time()
    for p in sorted(runs_dir().glob("*/status.json")):
        try:
            status = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        run_id = status.get("run_id") or p.parent.name
        state = status.get("state")
        if state == "queued" and run_id not in _PENDING:
            status.update(state="orphaned",
                          error="This turn was waiting for a slot when the server "
                                "exited. Nothing was spent; ask again.")
        elif state == "running" and run_id not in _RUNNING:
            fr = _frames_path(run_id)
            try:
                last = fr.stat().st_mtime if fr.exists() else (status.get("started_at") or 0)
            except OSError:
                last = status.get("started_at") or 0
            if now - float(last or 0) < ORPHAN_AFTER_S:
                continue
            status.update(state="orphaned",
                          error="The server process running this turn exited before "
                                "it finished. What it had already written is above.")
        else:
            continue
        try:
            p.write_text(json.dumps(status, indent=2, default=str), encoding="utf-8")
            changed += 1
        except OSError:
            pass
    return changed


async def stream(run_id: str, *, poll_seconds: float = 0.25) -> AsyncIterator[dict]:
    """Replay everything recorded so far, then tail until the run is terminal.

    Replay-then-tail rather than tail-only: a console that connects late, or
    reconnects after a dropped connection, must not silently miss frames.

    THE BOUNDARY IS ANNOUNCED. Replaying an in-flight run dumps hundreds of frames
    in one burst, and a UI that renders those the way it renders live output looks
    like an agent having a seizure. One ``replay_done`` frame after the first pass
    tells the console where history ends, so it can render the catch-up quietly. A
    run with nothing recorded still gets it: the frame means "you are now live",
    not "something was replayed".
    """
    path = _frames_path(run_id)
    offset = 0
    replayed = False
    last_beat = time.time()

    def drain(at: int) -> tuple[list[dict], int]:
        out: list[dict] = []
        if not path.exists():
            return out, at
        with path.open("r", encoding="utf-8") as fh:
            fh.seek(at)
            for line in fh:
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
            return out, fh.tell()

    while True:
        batch, offset = drain(offset)
        for payload in batch:
            yield payload
        if batch:
            last_beat = time.time()
        elif time.time() - last_beat >= HEARTBEAT_S:
            last_beat = time.time()
            yield frame("ping")

        if not replayed:
            replayed = True
            st = read_status(run_id) or {}
            yield frame("replay_done", count=len(batch), state=st.get("state"))

        st = read_status(run_id) or {}
        if st.get("state") in ("running", "queued"):
            reconcile_orphans()
            st = read_status(run_id) or {}
        if st.get("state") in TERMINAL_STATES:
            batch, offset = drain(offset)
            for payload in batch:
                yield payload
            yield frame("run_finished", state=st.get("state"),
                        terminal_reason=st.get("terminal_reason"),
                        stopped_by=st.get("stopped_by"),
                        error=st.get("error"),
                        cost_usd=st.get("cost_usd"), seconds=st.get("seconds"),
                        session_id=st.get("session_id"),
                        session_spent_usd=session_cost_so_far(),
                        session_budget_usd=knobs.session_budget_usd())
            return
        await asyncio.sleep(poll_seconds)


#: Questions worth putting in front of somebody who has just arrived. Each one
#: exercises a different capability and produces an answer the map alone cannot
#: give — and the last three are only answerable because the platform now covers a
#: year rather than an afternoon.
SUGGESTED = [
    "Which five buildings should the city act on first, and what exactly should it do?",
    "Where would street trees achieve the least, and why?",
    "Is the exposure pattern actually spatially clustered, or does it just look that way? Test it.",
    "Compare July with October on the same walls, and tell me how much of the difference is the sun rather than the weather.",
    "Which facades take the most sun over the whole year, and does that agree with which ones are worst during the heat wave?",
    "If we fit external shading to the worst pre-war residential buildings, what does it buy in July and what does it cost in January?",
    "Find me a pattern in this data that I would not have guessed, and prove it.",
    "I have money for twenty buildings. Where does it go, and how does the answer change if I optimise for equity instead?",
]

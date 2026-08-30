"""Local server: the web app, and the analyst that works over it.

Deliberately thin. The heavy work is all precomputed, so this process hands out
static files, answers structured queries against the loaded model, and drives
agent turns. It never calls FortyGuard — the cached-only client is used everywhere
downstream of the pipeline, so a running demo cannot spend credits no matter what
a visitor does.

TWO ANALYST SURFACES, AND WHY BOTH EXIST

``/api/agent/*`` is the real one: a Claude Agent SDK turn with a shell, a
workspace, twenty model-specific tools, three specialists and a streaming
transcript. It can test an intervention, run a spatial statistic and drive the
map.

``/api/ask`` is the old single-shot tool-use loop against the Messages API. It is
kept because it needs nothing but an API key — no ``claude`` CLI, no subprocess,
no streaming — so the application still answers questions on a machine where the
agent cannot start. The console falls back to it automatically and says which one
answered.

The agent's endpoints are ASYNCHRONOUS by necessity, not by taste. A goal-directed
question is minutes of work; ``POST /api/agent/ask`` returns a ``run_id`` and the
console reads ``GET /api/agent/runs/{id}/events``.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .ai import SUGGESTED as LEGACY_SUGGESTED, Analyst, Store

logger = logging.getLogger(__name__)

# Load .env so `heatcanyon serve` picks up GOOGLE_MAPS_API_KEY and the agent's own
# knobs the same way the notebooks pick up the FortyGuard key. Optional import:
# the server has always run without dotenv installed.
try:  # pragma: no cover - trivial
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # noqa: BLE001
    pass

WEB = Path("web")

app = FastAPI(title="The Urban Canyon", version="2.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

_store: Store | None = None
_analyst: Analyst | None = None


def store() -> Store:
    global _store
    if _store is None:
        if not (WEB / "data" / "meta.json").exists():
            raise HTTPException(
                503,
                "No pipeline output found. Run `python -m heatcanyon.cli build` first.",
            )
        _store = Store()
    return _store


def analyst() -> Analyst:
    global _analyst
    if _analyst is None:
        _analyst = Analyst(store())
    return _analyst


def dataset():
    from .agent.dataset import load
    try:
        return load()
    except FileNotFoundError as exc:
        raise HTTPException(503, str(exc)) from exc


class Question(BaseModel):
    # One character, not three. The floor was three, and the first thing anyone
    # types into a console with a text box in it is "hi" — two characters, so
    # the analyst's opening move was a 422 raised by Pydantic before the
    # endpoint ran, which the console could only render as
    # "Could not start: [object Object]". A guard whose only observed catch is
    # the greeting people actually send is not guarding anything.
    #
    # What it was standing in for is spend, and spend is bounded where it can
    # actually be bounded: HEATCANYON_AGENT_BUDGET_USD caps the turn,
    # TASK_BUDGET_TOKENS gives the model a countdown it can see, and
    # SESSION_BUDGET_USD caps the process across every visitor. A character
    # count never bounded any of that — "hello there" was always free to cost
    # a dollar fifty.
    question: str = Field(min_length=1, max_length=4000)
    resume: str | None = None


# ------------------------------------------------------------------- basics


@app.get("/api/health")
def health() -> dict:
    s = store()
    a = analyst()
    from .agent import options as agent_options
    from .agent import session as agent_session
    ok, why = agent_options.available()
    return {
        "ok": True,
        "study_area": s.meta["aoi"]["label"],
        "buildings_scored": s.meta["counts"]["buildings_scored"],
        "year": s.meta.get("year", {}).get("window"),
        "periods": 1 + len(s.meta.get("year", {}).get("periods", {}).get("months", [])),
        "agent_available": ok,
        "agent_unavailable_because": why or None,
        "agent_model": agent_options.knobs.model() if ok else None,
        "agent_spent_usd": agent_session.session_cost_so_far(),
        "legacy_ai_available": a.available,
        "credits_spent": sum(
            (c.get("credits_delta") or 0) for c in s.meta.get("spend", {}).get("calls", [])
        ),
    }


@app.get("/api/config")
def config() -> dict:
    """Client configuration, currently just the optional Google Maps key.

    A Maps Platform key used from a browser is necessarily visible to that
    browser — there is no arrangement in which the page can request tiles without
    holding the key. So this endpoint is not a secrecy leak, it is the normal
    shape of the thing; the protections that actually matter are on the key
    itself: restrict it to the Map Tiles API, add an HTTP-referrer restriction,
    and cap the root-tile-request quota.
    """
    return {"gmaps_key": os.environ.get("GOOGLE_MAPS_API_KEY", "")}


# ------------------------------------------------------------------- the voice


class VoiceLines(BaseModel):
    """The film's whole script, in order.

    In order matters twice. Each line is synthesised with its neighbours as
    prosody context, so a line only sounds right where it actually sits; and the
    reply is positional, so the client can hand the array straight back to its
    beats without matching on text.
    """

    lines: list[str] = Field(default_factory=list, max_length=120)
    # The spending switch. The film does not set it and must not: a page load is
    # not a decision to spend, and a test suite opening the application in a loop
    # is emphatically not one. `scripts/prewarm_voice.mjs` sets it.
    synthesise: bool = False


@app.get("/api/voice")
def voice_status() -> dict:
    """Whether the film has a real voice, and what it costs to keep it.

    The client asks this before it asks for anything to be spoken, and takes
    `enabled: false` as its cue to narrate with the browser's own synthesiser —
    which is what it did before ElevenLabs was wired in, and still the only
    thing that works on a machine with no key and no cached audio.
    """
    from . import voice
    return voice.status()


@app.post("/api/voice/lines")
def voice_lines(body: VoiceLines) -> dict:
    """Synthesise (or, nearly always, look up) the script.

    A lookup, unless asked otherwise: `web/data/vo/` is committed, so on an
    unmodified script this endpoint spends nothing, needs no key and answers from
    disk. It reaches ElevenLabs only when `synthesise` is set, which is
    `scripts/prewarm_voice.mjs` and nothing else — see the note on the field.

    Errors are per line, never for the request. One line that is not there comes
    back with a null url and the film reads that one with the browser voice; the
    other twenty-nine are still the real read.
    """
    from . import voice
    if not voice.enabled():
        return {"enabled": False, "lines": [], "spent_chars": 0}
    lines = voice.script(body.lines, synthesise_missing=body.synthesise)
    return {
        "enabled": True,
        "lines": lines,
        "spent_chars": voice.spent_chars(),
        "budget_chars": voice.budget_chars(),
    }


# ------------------------------------------------------------------ the agent


@app.get("/api/agent/envelope")
async def agent_envelope() -> dict:
    """Model, budgets, tools, subagents. What the console shows in its header."""
    from .agent import options as agent_options
    from .agent import session as agent_session
    return {
        **agent_options.describe_envelope(),
        "spent_usd": agent_session.session_cost_so_far(),
        "suggestions": agent_session.SUGGESTED,
        "running": len(agent_session._RUNNING),
    }


@app.post("/api/agent/ask")
async def agent_ask(q: Question) -> JSONResponse:
    """Start a turn. Returns a run_id immediately; stream it from /events.

    ASYNC, and it has to be. FastAPI runs a `def` endpoint in a worker thread
    where there is no running event loop, and `session.start_turn` schedules the
    turn with `asyncio.get_running_loop().create_task`. Declared `def`, every
    request came back as "RuntimeError: no running event loop" — which the console
    showed as "Could not start", giving no hint that the cause was a missing
    keyword four characters long.
    """
    from .agent import session as agent_session
    dataset()          # fail fast and clearly if the pipeline has not been run
    try:
        started = agent_session.start_turn(q.question, resume=q.resume)
    except agent_session.Unavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except agent_session.BudgetExceeded as exc:
        raise HTTPException(402, str(exc)) from exc
    except Exception as exc:      # noqa: BLE001
        logger.exception("[AGENT] could not start a turn")
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    return JSONResponse(started)


@app.get("/api/agent/runs")
async def agent_runs(limit: int = 40) -> dict:
    from .agent import knobs, session as agent_session
    agent_session.reconcile_orphans()
    return {
        "runs": agent_session.list_runs(limit),
        "spent_usd": agent_session.session_cost_so_far(),
        "budget_usd": knobs.session_budget_usd(),
    }


@app.get("/api/agent/runs/{run_id}/events")
async def agent_events(run_id: str) -> StreamingResponse:
    """Replay this run's frames, then tail it live. Reconnect freely."""
    from .agent import session as agent_session
    from .agent.events import sse
    if agent_session.read_status(run_id) is None:
        raise HTTPException(404, f"no such run: {run_id}")

    async def gen():
        async for payload in agent_session.stream(run_id):
            yield sse(payload)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        # Any reverse proxy in front of this buffers SSE by default, which holds
        # every frame until the response ends and makes a streaming endpoint behave
        # exactly like the blocking one it replaced.
        "X-Accel-Buffering": "no",
    })


@app.get("/api/agent/runs/{run_id}/frames")
def agent_frames(run_id: str) -> dict:
    """One run's frames in full, for a console reopening a finished answer."""
    from .agent import session as agent_session
    if agent_session.read_status(run_id) is None:
        raise HTTPException(404, f"no such run: {run_id}")
    return {"run_id": run_id, "status": agent_session.read_status(run_id),
            "frames": agent_session.read_frames(run_id)}


@app.post("/api/agent/runs/{run_id}/interrupt")
async def agent_interrupt(run_id: str) -> dict:
    """Async for the same reason as `ask`, plus one of its own: `Task.cancel` is
    not thread-safe, so it must be called from the loop that owns the task."""
    from .agent import session as agent_session
    return agent_session.interrupt(run_id)


@app.post("/api/agent/interrupt-all")
async def agent_interrupt_all() -> dict:
    """Stop everything this server is doing. Never an error."""
    from .agent import session as agent_session
    return agent_session.interrupt_all()


@app.get("/api/agent/artifact/{path:path}")
def agent_artifact(path: str) -> FileResponse:
    """A chart or file the agent produced. Confined to the workspace root."""
    from .agent import knobs
    root = knobs.workspace_root().resolve()
    target = (root / path).resolve()
    if root not in target.parents or not target.is_file():
        raise HTTPException(404, "no such artifact")
    return FileResponse(target)


# ------------------------------------------------ the legacy single-shot path


@app.get("/api/suggestions")
def suggestions() -> dict:
    from .agent import session as agent_session
    return {"suggestions": agent_session.SUGGESTED,
            "legacy": LEGACY_SUGGESTED}


@app.post("/api/ask")
def ask(q: Question) -> JSONResponse:
    """The single-shot analyst. Kept as the fallback when the agent cannot start."""
    a = analyst().ask(q.question)
    return JSONResponse({
        "answer": a.text,
        "trace": a.trace,
        "error": a.error,
        "usage": a.usage,
        "mode": "single-shot",
    })


# --------------------------------------------------- the decision layer
#
# THE ROUTING PROBLEM THESE ENDPOINTS EXIST TO FIX
#
# `agent/interventions.py` is a first-class planning engine: it changes an
# albedo, a canopy fraction, a shading factor or a wall admittance and re-solves
# the surface energy balance for the canyons you selected, over any window, with
# the seasonal split and the spread across canyons. Until these endpoints it was
# reachable only by asking an LLM in prose — so a planner who had selected a
# building and wanted to know what shading does to THAT building had to type a
# paragraph into a chat window and wait for a model to decide to call the tool.
#
# That was never a modelling problem. The engine was right there. See
# docs/DECISIONS.md section 8.
#
# These are SYNCHRONOUS, unlike the agent endpoints above, and that is the right
# choice for a different reason than it looks: a re-solve is seconds, not
# minutes, and a run identifier the browser has to poll would cost more latency
# than the solve. The browser shows a real progress state and the response
# carries `seconds` so it can report what it actually took.


class Intervention(BaseModel):
    """The same selector grammar `run_intervention` already accepts."""

    spec: object
    streets: list[str] | None = None
    bins: list[str] | None = None
    near: list[float] | None = None
    radius_m: float | None = None
    filters: dict | None = None
    whole_aoi: bool = False
    period: str = "event"
    window: str = "peak"
    # The cap is a real bound on the work, not a hint. Above it `run` takes a
    # stratified sample by aspect ratio rather than solving everything, which is
    # what keeps a `whole_aoi` request from being a denial of service against a
    # laptop. 120 is generous for an interactive request and is enforced here as
    # well as defaulted, because the field arrives from a browser.
    max_canyons: int = Field(default=40, ge=1, le=120)


def _decision_module(name: str):
    """Import one decision-layer module, or explain what is missing.

    Every one of these is optional: the atlas, the twelve layers, the year and
    the analyst all work without them, and a build that has not run the decision
    stage should say so in one sentence rather than raising an ImportError into
    a browser console.
    """
    import importlib
    try:
        return importlib.import_module(f".{name}", package="heatcanyon")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            503,
            f"heatcanyon.{name} is not available in this build ({exc}). "
            f"See docs/DECISIONS.md.",
        ) from exc


@app.post("/api/intervention")
def intervention(body: Intervention) -> dict:
    """Re-solve the physics for an intervention, anywhere, over any window."""
    import time

    from .agent import interventions as IV

    d = dataset()
    selector = {k: v for k, v in {
        "streets": body.streets, "bins": body.bins, "near": body.near,
        "radius_m": body.radius_m, "filters": body.filters,
        "whole_aoi": body.whole_aoi,
    }.items() if v not in (None, False)}
    if not selector:
        raise HTTPException(
            422,
            "Say where. Pass streets, bins, near+radius_m, filters, or "
            "whole_aoi: true. An intervention with no selection is not a "
            "question this model can answer.",
        )
    t0 = time.time()
    try:
        out = IV.run(d, spec=body.spec, period=body.period, window=body.window,
                     max_canyons=body.max_canyons, **selector)
    except (KeyError, ValueError) as exc:
        # A bad lever name or an unknown period is the caller's error and it
        # should read as one. `catalogue()` is what tells them the valid set.
        raise HTTPException(422, f"{exc}. Call /api/intervention/catalogue "
                                 f"for the levers, presets and windows.") from exc
    out["seconds"] = round(time.time() - t0, 2)
    return out


@app.get("/api/intervention/catalogue")
def intervention_catalogue() -> dict:
    """The levers a spec may pull, their ranges, and their stated trade-offs."""
    from .agent import interventions as IV
    return IV.catalogue()


@app.post("/api/prescribe")
def prescribe(body: dict) -> dict:
    """The measures for one building, with their geometry, extent and price."""
    import time

    bin_ = str(body.get("bin") or "").strip()
    if not bin_:
        raise HTTPException(422, "Pass a building BIN.")
    DE = _decision_module("decide")
    t0 = time.time()
    try:
        out = DE.serve_building(dataset(), bin_, measures=body.get("measures"))
    except KeyError as exc:
        raise HTTPException(404, f"No building {bin_} in the model.") from exc
    out["seconds"] = round(time.time() - t0, 2)
    return out


@app.get("/api/portfolio")
def portfolio(objective: str = "person_hours", budget: float = 2_000_000.0,
              residential_only: bool = False, min_hvi: int | None = None,
              built_before: int | None = None, zip: str | None = None) -> dict:
    """Where a budget should go, and where two objectives disagree about it."""
    import time

    DE = _decision_module("decide")
    t0 = time.time()
    constraint = {k: v for k, v in {
        "residential_only": residential_only or None, "min_hvi": min_hvi,
        "built_before": built_before, "zip": zip,
    }.items() if v is not None}
    try:
        out = DE.serve_portfolio(dataset(), objective=objective,
                                 budget_usd=budget, constraint=constraint)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    out["seconds"] = round(time.time() - t0, 2)
    return out


@app.get("/api/warming")
def warming(bin: str | None = None) -> dict:
    """The same city under warmer air, at four uniform offsets.

    Seconds rather than a rebuild, because the pipeline already measured the
    coefficient this needs — see `heatcanyon/warming.py`. Every row carries the
    sentence that this is not a climate projection; a client that renders the
    figures without it is misreporting them.
    """
    import numpy as np

    W = _decision_module("warming")
    d = dataset()
    hourly = d.year["hourly"]
    t_air = np.asarray(hourly["t_air_c"], dtype=np.float64)
    hod = np.asarray(hourly["hour_of_day"], dtype=np.int64)
    di = np.asarray(hourly["day_index"], dtype=np.int64)

    if not bin:
        rows = [W.year_summary(t_air, hod, di, k) for k in W.LEVELS]
        return {"scope": "study area", "levels": list(W.LEVELS),
                "results": [_as_dict(r) for r in rows], "basis": W.BASIS}

    # One building: its own measured indoor-to-air offset, and its own facade.
    DE = _decision_module("decide")
    try:
        bl = DE.building_loads(d, str(bin))
    except KeyError as exc:
        raise HTTPException(404, f"No building {bin} in the model.") from exc
    # The offset the warming is applied through is INDOOR MINUS AIR, which is
    # what `loads` counts its annual exceedance with. The first version
    # subtracted the SETPOINT instead and got 16.6 K, because a free-running
    # building on a 39 degC afternoon sits far above the temperature a machine
    # would have held it at — that is the whole point of the free-running
    # estimate, and it is not an offset above the weather. It put the building
    # over the indoor threshold for 4,902 hours a year before any warming at all.
    worst = max(bl.floors, key=lambda f: f.t_indoor_free_c[1], default=None)
    peak_air = float(d.meta["hours"][int(d.meta["peak_index"])]["t_anchor_c"])
    offset = max(0.0, (worst.t_indoor_free_c[1] - peak_air)) if worst else 0.0

    rows = W.building_exposure(t_air=t_air, hour_of_day=hod, day_index=di,
                               indoor_offset_k=float(offset))
    out = {"scope": "building", "bin": str(bin), "levels": list(W.LEVELS),
           "indoor_offset_k": round(float(offset), 2),
           "results": [_as_dict(r) for r in rows], "basis": W.BASIS}
    # The number an owner actually acts on: where a threshold is first crossed.
    for name, thr in (("indoor_hours_over", 500.0), ("days_above_35", 10.0)):
        out[f"crosses_{name}"] = W.crossing(rows, attribute=name, threshold=thr)
    return out


def _as_dict(o) -> dict:
    import dataclasses
    return dataclasses.asdict(o)


@app.get("/api/constants")
def constants() -> dict:
    """Every monetary and carbon constant, with its source and its date.

    Served rather than baked into the bundle because it is the thing a reviewer
    most needs to check and the thing most likely to go stale. `unverified` is
    reported first-class: an interface showing dollar figures drawn from
    constants nobody has sourced must be able to say so.
    """
    E = _decision_module("economics")
    rows = E.constants_table()
    return {
        "constants": rows,
        "unverified": sum(1 for r in rows if not r.get("verified")),
        "note": ("Every figure downstream of this table is labelled 'assumed', "
                 "which is a softer tier than measured, reanalysis or modelled. "
                 "See docs/DECISIONS.md."),
    }


class NoStore(StaticFiles):
    """StaticFiles that forbids caching of the application's own source.

    Starlette sends `last-modified` and `etag` but no `Cache-Control`, and a
    response with no explicit freshness is one the browser is entitled to guess
    at: the heuristic is a tenth of the age since it was last modified, so a
    file edited hours ago is served from disk for tens of minutes without so
    much as a conditional request. On a development server that is a trap. It
    produced a session where the panel showed newly written text while the 3D
    scene was still running the previous build's JavaScript — an interface and
    a renderer from different hours, which is indistinguishable from a bug in
    whichever half you happen to be looking at, and survives an ordinary
    reload.

    The data directory keeps the default: those files are large, immutable in
    practice, and re-fetching forty megabytes of typed arrays on every reload
    would make the application slower to no purpose.
    """

    def file_response(self, *args, **kwargs):  # type: ignore[override]
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response


# Static files last, so /api/* wins.
if WEB.exists():
    app.mount("/data", StaticFiles(directory=str(WEB / "data")), name="data")
    app.mount("/js", NoStore(directory=str(WEB / "js")), name="js")
    app.mount("/css", NoStore(directory=str(WEB / "css")), name="css")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(
            WEB / "index.html",
            headers={"Cache-Control": "no-store, must-revalidate"},
        )


def main(port: int | None = None) -> None:
    """Run the server.

    The host defaults to loopback and has to be asked for explicitly. A
    development server that binds every interface is a development server
    reachable from the rest of the network, and that is not a thing to acquire
    by accident on a laptop — so the container sets ``HEATCANYON_HOST=0.0.0.0``
    and nothing else does.
    """
    import uvicorn
    port = int(port or os.getenv("PORT", "8000"))
    host = os.getenv("HEATCANYON_HOST", "127.0.0.1")
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print(f"The Urban Canyon -> http://{shown}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()

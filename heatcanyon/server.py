"""Local server: serves the web app and the AI analyst endpoint.

Deliberately minimal. The heavy work is all precomputed, so this process only
has to hand out static files and proxy questions to the analyst. It never calls
FortyGuard — the cached-only client is used everywhere downstream of the
pipeline, so a running demo cannot spend credits no matter what a visitor does.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .ai import SUGGESTED, Analyst, Store

# Load .env so `heatcanyon serve` picks up GOOGLE_MAPS_API_KEY the same way the
# notebooks pick up the FortyGuard key. Optional import: the server has always
# run without dotenv installed, and a missing photoreal key is a valid state.
try:  # pragma: no cover - trivial
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # noqa: BLE001
    pass

WEB = Path("web")

app = FastAPI(title="HeatCanyon", version="1.0.0")
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


class Question(BaseModel):
    question: str = Field(min_length=3, max_length=2000)


@app.get("/api/health")
def health() -> dict:
    s = store()
    a = analyst()
    return {
        "ok": True,
        "study_area": s.meta["aoi"]["label"],
        "buildings_scored": s.meta["counts"]["buildings_scored"],
        "ai_available": a.available,
        "ai_model": a.model if a.available else None,
        "credits_spent": sum(
            (c.get("credits_delta") or 0) for c in s.meta.get("spend", {}).get("calls", [])
        ),
    }


@app.get("/api/config")
def config() -> dict:
    """Client configuration, currently just the optional Google Maps key.

    A Maps Platform key used from a browser is necessarily visible to that
    browser — there is no arrangement in which the page can request tiles
    without holding the key. So this endpoint is not a secrecy leak, it is the
    normal shape of the thing; the protections that actually matter are on the
    key itself: restrict it to the Map Tiles API, add an HTTP-referrer
    restriction, and cap the root-tile-request quota.

    Absent from the environment, the response simply carries no key and the
    photoreal layer stays off, which is also the free-by-default state.
    """
    return {"gmaps_key": os.environ.get("GOOGLE_MAPS_API_KEY", "")}


@app.get("/api/suggestions")
def suggestions() -> dict:
    return {"suggestions": SUGGESTED}


@app.post("/api/ask")
def ask(q: Question) -> JSONResponse:
    a = analyst().ask(q.question)
    return JSONResponse({
        "answer": a.text,
        "trace": a.trace,
        "error": a.error,
        "usage": a.usage,
    })


# Static files last, so /api/* wins.
if WEB.exists():
    app.mount("/data", StaticFiles(directory=str(WEB / "data")), name="data")
    app.mount("/js", StaticFiles(directory=str(WEB / "js")), name="js")
    app.mount("/css", StaticFiles(directory=str(WEB / "css")), name="css")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB / "index.html")


def main(port: int | None = None) -> None:
    import uvicorn
    port = int(port or os.getenv("PORT", "8000"))
    print(f"HeatCanyon -> http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()

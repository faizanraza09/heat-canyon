"""The AI analyst: a grounded, tool-using agent over the computed heat model.

Design stance. An LLM bolted onto a data project is usually decoration — it
paraphrases numbers it was handed and invents the ones it wasn't. This one is
built so it *cannot* do that:

* It has no numbers in its context to begin with. Every figure it reports has to
  come back from a tool call against the pipeline's own output.
* The tools return structured records, not prose, so there is nothing to
  paraphrase creatively.
* The recommendation catalogue is declarative and lives in ``exposure.py``. The
  model selects and explains from that catalogue; it does not author
  interventions. Same building, same advice, every time.
* Every tool call is recorded and returned to the browser, so a reviewer can see
  exactly which queries produced the answer and check them.

What that buys is the thing a heat map cannot do on its own: a planner can ask
"which pre-war residential buildings have more than four hours of unbroken
exceedance and a west-facing wall over 45 °C, and what should I do about the
worst one" and get an answer traceable to specific rows.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DATA = Path("web/data")
MODEL = "claude-opus-5"


# ----------------------------------------------------------------- data access


class Store:
    """Loads the pipeline output once and answers structured queries over it."""

    def __init__(self, root: Path = DATA) -> None:
        self.root = root
        self.meta = json.loads((root / "meta.json").read_text())
        self.ranked = json.loads((root / "ranked.json").read_text())
        self.canyons = json.loads((root / "canyons.json").read_text())
        self.scenarios = json.loads((root / "scenarios.json").read_text())
        self.tiles_stats = json.loads((root / "tiles.json").read_text())["stats"]
        self.items = self.ranked["items"]

    # ------------------------------------------------------------- queries
    def area_summary(self) -> dict:
        m, c, mo = self.meta, self.meta["counts"], self.meta["morphology"]
        peak = m["hours"][m["peak_index"]]
        return {
            "study_area": m["aoi"]["label"],
            "area_km2": m["aoi"]["area_km2"],
            "event": m["event"],
            "buildings_scored": c["buildings_scored"],
            "facade_panels": c["facade_panels"],
            "true_canyons": c["true_canyons"],
            "residential_units": c["residential_units"],
            "street_trees": c["trees"],
            "morphology": mo,
            "peak_hour_edt": peak["edt"],
            "peak_anchor_air_c": peak["t_anchor_c"],
            "measured_air_temperature_stats_by_hour": [
                {"edt": h["edt"], "median_c": h["t_anchor_c"]} for h in m["hours"]
            ],
            "measured_exceedance_hours_above_35c": self.tiles_stats["exceedance"],
            "measured_persistence_hours_above_35c": self.tiles_stats["persistence"],
            "note": (
                "Air temperature, exceedance and persistence are FortyGuard products. "
                "Facade surface temperature, mean radiant temperature and WBGT are "
                "modelled by this project's physics engine."
            ),
        }

    def query_buildings(
        self,
        limit: int = 10,
        min_persistence_h: float | None = None,
        min_exceedance_h: float | None = None,
        max_svf: float | None = None,
        min_units: int | None = None,
        built_before: int | None = None,
        min_hvi: int | None = None,
        residential_only: bool = False,
        min_facade_peak_c: float | None = None,
        min_wbgt_c: float | None = None,
        sort_by: str = "priority",
    ) -> dict:
        rows = self.items
        def keep(b: dict) -> bool:
            m, d = b["measured"], b["modelled"]
            if min_persistence_h is not None and m["persistence_h"] < min_persistence_h: return False
            if min_exceedance_h is not None and m["exceedance_h"] < min_exceedance_h: return False
            if max_svf is not None and m["svf"] > max_svf: return False
            if min_units is not None and (b.get("units") or 0) < min_units: return False
            if built_before is not None and not (b.get("year") and b["year"] < built_before): return False
            if min_hvi is not None and (b.get("hvi") or 0) < min_hvi: return False
            if residential_only and not (b.get("units") or 0) > 0: return False
            if min_facade_peak_c is not None and d["facade_peak_c"] < min_facade_peak_c: return False
            if min_wbgt_c is not None and d["wbgt_peak_c"] < min_wbgt_c: return False
            return True

        sel = [b for b in rows if keep(b)]
        keyf = {
            "priority": lambda b: -b["priority"],
            "exposure": lambda b: -b["exposure"],
            "vulnerability": lambda b: -b["vulnerability"],
            "persistence": lambda b: -b["measured"]["persistence_h"],
            "exceedance": lambda b: -b["measured"]["exceedance_h"],
            "facade_temp": lambda b: -b["modelled"]["facade_peak_c"],
            "units": lambda b: -(b.get("units") or 0),
            "svf": lambda b: b["measured"]["svf"],
        }.get(sort_by, lambda b: -b["priority"])
        sel.sort(key=keyf)

        return {
            "matched": len(sel),
            "of_total_scored": self.ranked["n_scored"],
            "returned": min(limit, len(sel)),
            "buildings": [self._brief(b) for b in sel[:limit]],
        }

    def _brief(self, b: dict) -> dict:
        return {
            "bin": b["bin"], "address": b["addr"], "priority": b["priority"],
            "exposure": b["exposure"], "vulnerability": b["vulnerability"],
            "floors": b["floors"], "height_m": b["h"], "year_built": b["year"],
            "residential_units": b.get("units"), "zip": b.get("zip"),
            "hvi": b.get("hvi"), "land_use": b.get("use_name"),
            "measured": b["measured"], "modelled": b["modelled"],
        }

    def get_building(self, bin_or_address: str) -> dict:
        q = str(bin_or_address).strip().lower()
        for b in self.items:
            if str(b["bin"]) == q or (b["addr"] or "").lower() == q:
                return b
        # Substring fallback on address.
        for b in self.items:
            if q and q in (b["addr"] or "").lower():
                return b
        return {"error": f"No building matching {bin_or_address!r} in the ranked set "
                         f"(the ranked set holds the top {len(self.items)} by priority)."}

    def canyon_stats(self, name_contains: str | None = None, limit: int = 12) -> dict:
        rows = [c for c in self.canyons if c["canyon"]]
        if name_contains:
            k = name_contains.strip().lower()
            rows = [c for c in rows if k in (c["name"] or "").lower()]
        if not rows:
            return {"matched": 0, "streets": []}
        by: dict[str, list[dict]] = {}
        for c in rows:
            by.setdefault(c["name"] or "(unnamed)", []).append(c)
        def med(v):
            v = sorted(v); return v[len(v) // 2] if v else None
        out = []
        for name, cs in by.items():
            out.append({
                "street": name, "cross_sections": len(cs),
                "width_facade_to_facade_m": med([c["w"] for c in cs]),
                "width_curb_to_curb_m": med([c["w_curb"] for c in cs if c["w_curb"]]),
                "wall_height_m": med([(c["hl"] + c["hr"]) / 2 for c in cs]),
                "aspect_ratio_hw": med([c["hw"] for c in cs]),
                "sky_view_factor": med([c["svf"] for c in cs]),
                "asymmetry": med([c["asym"] for c in cs]),
                "bearing_deg": med([c["bearing"] for c in cs]),
                "tree_cover": med([c["trees"] for c in cs]),
            })
        out.sort(key=lambda r: -(r["cross_sections"] or 0))
        return {"matched": len(rows), "streets": out[:limit]}

    def scenario_results(self, site_label: str | None = None) -> dict:
        sites = self.scenarios["sites"]
        if site_label:
            k = site_label.strip().lower()
            sites = [s for s in sites
                     if k in s["label"].lower() or k in (s["name"] or "").lower()] or sites
        return {
            "catalogue": self.scenarios["catalogue"],
            "published_effect_ranges_for_checking": self.scenarios["expected_ranges"],
            "sites": sites,
            "reading_note": (
                "All d_* values are the change from baseline, in kelvin. Positive means "
                "the intervention made that metric worse. Cool pavement raising mean "
                "radiant temperature in a deep canyon is a real, documented trade-off, "
                "not an error."
            ),
        }

    def methodology(self, topic: str = "overview") -> dict:
        t = (topic or "overview").lower()
        notes = {
            "overview": (
                "FortyGuard supplies 2 m air temperature on a 60 m grid. Building "
                "heights come from NYC Open Data footprints and street widths from NYC "
                "Centerline, both measured. From those we rasterise a digital surface "
                "model at 3 m, compute sky view factor by horizon scanning, compute "
                "shadows per hour from the 3D scene, then solve a coupled surface energy "
                "balance for every facade band. Air temperature is extended vertically "
                "using Monin-Obukhov similarity above roof level and a canyon-mixing "
                "model below."
            ),
            "uncertainty": (
                "The vertical air temperature extrapolation is unvalidated and labelled "
                "as such. No public dataset measures air temperature at height in "
                "Manhattan. Its stated one-sigma uncertainty grows from 0.5 K at the 2 m "
                "anchor to roughly 3 K at 150 m, which is LARGER than the modelled "
                "vertical gradient itself. That is the honest position: the vertical air "
                "temperature signal is weak and uncertain. The surface temperature and "
                "mean radiant temperature fields are where the real variation is, and "
                "they are driven by solar geometry, which is exact."
            ),
            "svf": (
                "Sky view factor is computed as the mean of cos^2(horizon elevation) over "
                "32 azimuths. That is the cosine-weighted solid-angle fraction for a "
                "horizontal surface and it reduces exactly to the closed-form "
                "infinite-canyon solution cos(atan(2H/W)). The commonly quoted "
                "mean(1 - sin(beta)) form under-estimates SVF by about 35% and is not "
                "used here. Facades use Hottel's infinite-strip weighting instead, "
                "(1 - sin(alpha))/2, because a vertical surface has a different view "
                "factor from a horizontal one."
            ),
            "validation": (
                "Three checks are run. (1) The raster sky view factor agrees with the "
                "analytic canyon solution to 0.09 mean absolute difference across 2,826 "
                "canyons. (2) The reconstructed solar irradiance tracks ERA5 reanalysis "
                "to 7.3% RMS with no fitted parameters. (3) The 14:00 GMT-5 temperature "
                "field matches the independently fetched full-day per-tile maximum "
                "exactly, confirming the timezone convention. The horizontal air "
                "temperature field can be checked against NYC's 84 Manhattan street "
                "sensors; the vertical dimension cannot be checked against anything."
            ),
            "timezone": (
                "The FortyGuard heatmap endpoint interprets start_time in local standard "
                "time, GMT-5, year-round. New York is on EDT (GMT-4) in July, so a "
                "start_time of 14:00 is 15:00 wall clock. This was established with a "
                "control call rather than assumed, because getting it wrong would put "
                "the sun on the wrong facade."
            ),
            "scoring": (
                "Exposure and vulnerability are scored separately and multiplied as a "
                "geometric mean, so a building must score on both to rank highly. "
                "Exposure weights duration most heavily (0.32 dose + 0.20 persistence) "
                "because duration, not peak, is what the epidemiology links to "
                "mortality. Vulnerability weights the DOHMH Heat Vulnerability Index at "
                "0.40 and residential unit count at 0.28. All weights are stated and "
                "every score is returned decomposed."
            ),
        }
        return {
            "topic": t,
            "explanation": notes.get(t, notes["overview"]),
            "available_topics": sorted(notes),
            "provenance": self.meta["provenance"],
        }


# ----------------------------------------------------------------- tool specs

TOOLS: list[dict[str, Any]] = [
    {
        "name": "area_summary",
        "description": (
            "Headline facts about the study area: the heat event, counts of buildings and "
            "canyons, morphology statistics, the measured air-temperature median for each "
            "of the eight hours, and the measured exceedance and persistence ranges. "
            "Call this first for any question about the area as a whole."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "query_buildings",
        "description": (
            "Filter and sort the scored buildings. Use this for every question of the form "
            "'which buildings...'. All thresholds are optional and combine with AND. "
            "Returns the matched count so you can report how selective a filter was."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "How many to return, default 10."},
                "min_persistence_h": {"type": "number", "description": "Minimum unbroken hours above 35 C (measured)."},
                "min_exceedance_h": {"type": "number", "description": "Minimum total hours above 35 C over the heat wave (measured)."},
                "max_svf": {"type": "number", "description": "Maximum sky view factor, 0-1. Lower means more enclosed."},
                "min_units": {"type": "integer", "description": "Minimum residential units."},
                "built_before": {"type": "integer", "description": "Only buildings constructed before this year."},
                "min_hvi": {"type": "integer", "description": "Minimum DOHMH Heat Vulnerability Index, 1-5."},
                "residential_only": {"type": "boolean", "description": "Restrict to buildings with residential units."},
                "min_facade_peak_c": {"type": "number", "description": "Minimum modelled peak facade surface temperature, C."},
                "min_wbgt_c": {"type": "number", "description": "Minimum modelled WBGT at the base, C."},
                "sort_by": {
                    "type": "string",
                    "enum": ["priority", "exposure", "vulnerability", "persistence",
                             "exceedance", "facade_temp", "units", "svf"],
                    "description": "Sort key. 'svf' sorts ascending (most enclosed first); the rest descending.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_building",
        "description": (
            "Full dossier for one building by BIN or street address: every measured and "
            "modelled figure, the complete score decomposition, the plain-language reasons "
            "it ranks where it does, and its triggered intervention list. Use this before "
            "recommending anything for a specific building."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"bin_or_address": {"type": "string"}},
            "required": ["bin_or_address"],
            "additionalProperties": False,
        },
    },
    {
        "name": "canyon_stats",
        "description": (
            "Street-canyon morphology, aggregated per street: facade-to-facade width, "
            "curb-to-curb width, wall height, aspect ratio H/W, sky view factor, "
            "asymmetry, bearing, and existing tree cover. Optionally filter by street "
            "name. Use this for questions about streets rather than buildings."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name_contains": {"type": "string", "description": "Case-insensitive substring, e.g. 'MADISON' or '42 ST'."},
                "limit": {"type": "integer"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "scenario_results",
        "description": (
            "What-if intervention results at representative canyons, as changes from "
            "baseline in kelvin, for three hours of the day. Covers cool roofs, cool "
            "pavement, street trees, facade shading, and all combined. Also returns the "
            "published effect ranges these were checked against. Use this for any "
            "question about what an intervention would achieve."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"site_label": {"type": "string", "description": "Optional site or street filter."}},
            "additionalProperties": False,
        },
    },
    {
        "name": "methodology",
        "description": (
            "How a given part of the model works and how confident to be in it. Topics: "
            "overview, uncertainty, svf, validation, timezone, scoring. Call this whenever "
            "the user asks how something was computed, how reliable it is, or challenges "
            "a result — and cite the limitation rather than defending the number."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"topic": {"type": "string"}},
            "additionalProperties": False,
        },
    },
]

SYSTEM = """You are the analyst for HeatCanyon, a 3D street-canyon heat exposure model of Midtown Manhattan. You advise urban planners, building owners and public-health staff.

You have no data in your context. Every number you state must come from a tool result in this conversation. If a tool did not return it, say you do not have it and offer the query that would get it. Never estimate, interpolate, or recall a figure from general knowledge and present it as a result of this model.

Always preserve the distinction the model itself maintains:
- MEASURED: 2 m air temperature, hours above 35 C, unbroken-run persistence (all FortyGuard); building heights and street widths (NYC Open Data); residential units, year built, Heat Vulnerability Index (NYC Open Data).
- MODELLED: facade surface temperature, air temperature above 2 m, mean radiant temperature, WBGT, solar irradiance, sky view factor.

Say which one you are using. When you report a modelled figure whose uncertainty matters — anything about air temperature above 2 m especially — state the limitation in the same breath. The vertical air-temperature extrapolation is unvalidated and its uncertainty exceeds its own gradient above about 50 m; do not let a user walk away believing it is measured.

Do not invent interventions. get_building returns a triggered action list with rationales and the public programme that funds each one. Select from it, explain why the numbers triggered it, and add the practical caveat. If nothing triggered, say so.

Be direct and quantitative. Lead with the answer. Use short paragraphs, and a compact list when you are ranking things. Round sensibly — 33.4 hours, not 33.44. Give units. No preamble, no restating the question, no offers of further help unless there is a specific next query worth naming.

If a result is counter-intuitive, say why rather than smoothing it over. Cool pavement raising mean radiant temperature in a deep canyon, or street trees achieving almost nothing on a street whose floor is already shaded, are correct findings and among the most useful things this model produces."""


# ---------------------------------------------------------------- agent loop


@dataclass
class Answer:
    text: str
    trace: list[dict] = field(default_factory=list)
    error: str | None = None
    usage: dict = field(default_factory=dict)


class Analyst:
    """Manual tool-use loop.

    Written as an explicit loop rather than with the SDK's tool runner because
    the browser shows the trace: every tool call, its arguments and a digest of
    what came back. That transparency is the point — a reviewer can confirm the
    answer came from the data and re-run the same queries by hand.
    """

    def __init__(self, store: Store | None = None, model: str = MODEL) -> None:
        self.store = store or Store()
        self.model = model
        self._client = None

    @property
    def available(self) -> bool:
        return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))

    @property
    def client(self):
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic()
        return self._client

    def _dispatch(self, name: str, args: dict) -> Any:
        s = self.store
        if name == "area_summary":
            return s.area_summary()
        if name == "query_buildings":
            return s.query_buildings(**args)
        if name == "get_building":
            return s.get_building(**args)
        if name == "canyon_stats":
            return s.canyon_stats(**args)
        if name == "scenario_results":
            return s.scenario_results(**args)
        if name == "methodology":
            return s.methodology(**args)
        return {"error": f"Unknown tool {name!r}"}

    def ask(self, question: str, max_turns: int = 8) -> Answer:
        if not self.available:
            return Answer(
                text="",
                error=("No Anthropic credential found. Set ANTHROPIC_API_KEY, or run "
                       "`ant auth login`, then restart the server. Everything else in "
                       "this application works without it — the AI analyst is the only "
                       "feature that needs a key."),
            )
        import anthropic

        messages: list[dict] = [{"role": "user", "content": question}]
        trace: list[dict] = []
        usage = {"input_tokens": 0, "output_tokens": 0}

        try:
            for _ in range(max_turns):
                resp = self.client.messages.create(
                    model=self.model,
                    max_tokens=16000,
                    system=SYSTEM,
                    tools=TOOLS,
                    thinking={"type": "adaptive"},
                    output_config={"effort": "high"},
                    messages=messages,
                    cache_control={"type": "ephemeral"},
                )
                usage["input_tokens"] += resp.usage.input_tokens
                usage["output_tokens"] += resp.usage.output_tokens

                if resp.stop_reason == "refusal":
                    return Answer(text="", trace=trace, usage=usage,
                                  error="The request was declined by safety classifiers.")

                messages.append({"role": "assistant", "content": resp.content})

                calls = [b for b in resp.content if b.type == "tool_use"]
                if not calls:
                    text = "\n\n".join(b.text for b in resp.content if b.type == "text").strip()
                    return Answer(text=text, trace=trace, usage=usage)

                # Execute every requested tool, then return all results in one
                # user message — splitting them teaches the model to stop
                # requesting tools in parallel.
                results = []
                for c in calls:
                    args = dict(c.input or {})
                    try:
                        out = self._dispatch(c.name, args)
                        err = None
                    except Exception as exc:  # noqa: BLE001 — surface to the model
                        out, err = {"error": f"{type(exc).__name__}: {exc}"}, str(exc)
                    trace.append({
                        "tool": c.name,
                        "args": args,
                        "summary": _digest(out),
                        "error": err,
                    })
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": c.id,
                        "content": json.dumps(out, default=str)[:120000],
                        **({"is_error": True} if err else {}),
                    })
                messages.append({"role": "user", "content": results})

            return Answer(text="", trace=trace, usage=usage,
                          error=f"Gave up after {max_turns} tool-use turns.")
        except anthropic.AuthenticationError:
            return Answer(text="", trace=trace, error="Anthropic credential rejected (401).")
        except anthropic.RateLimitError:
            return Answer(text="", trace=trace, error="Rate limited by the Anthropic API. Retry shortly.")
        except anthropic.APIStatusError as exc:
            return Answer(text="", trace=trace, error=f"Anthropic API error {exc.status_code}: {exc.message}")
        except anthropic.APIConnectionError:
            return Answer(text="", trace=trace, error="Could not reach the Anthropic API.")


def _digest(out: Any) -> str:
    """One-line description of a tool result, for the visible trace."""
    if isinstance(out, dict):
        if "error" in out:
            return f"error: {out['error']}"
        if "buildings" in out:
            return f"{out.get('matched')} matched, returned {len(out['buildings'])}"
        if "streets" in out:
            return f"{out.get('matched')} cross-sections across {len(out['streets'])} streets"
        if "sites" in out:
            return f"{len(out['sites'])} sites x {len(out.get('catalogue', []))} scenarios"
        if "explanation" in out:
            return f"methodology: {out.get('topic')}"
        if "study_area" in out:
            return f"{out['study_area']}, {out['buildings_scored']} buildings scored"
        if "addr" in out:
            return f"dossier: {out.get('addr') or out.get('bin')}"
        return f"{len(out)} fields"
    return type(out).__name__


#: Questions worth putting in front of a first-time user. Each one exercises a
#: different tool path and produces an answer the map alone cannot give.
SUGGESTED = [
    "Which five buildings should the city act on first, and what exactly should it do?",
    "Where would street trees achieve the least, and why?",
    "Compare Madison Avenue and West 47th Street as heat canyons.",
    "How much of this is measured and how much is modelled?",
    "Find pre-war residential buildings with over four hours of unbroken exceedance.",
    "What is the single most counter-intuitive result in this model?",
]

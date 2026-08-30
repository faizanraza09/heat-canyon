"""The in-process MCP server: HeatCanyon's own capabilities, callable by the agent.

Built-in tools already give the agent files, a shell and the web. Everything here
is the part that makes it a HEAT analyst rather than a general one: the solved
fields, the year, the statistics, a real intervention re-solve, and the map the
person asking is looking at.

These run inside the FastAPI process via ``create_sdk_mcp_server``, which is why
they can hold 120 MB of solved facade field and a warm dataset index while the
agent's own sandbox holds none of it. The agent asks; we execute.

THE REGISTRY IS SHORT ON PURPOSE

A tool's schema is in every request, for the whole conversation. A skill's body,
or a documented dataset the agent can import, costs nothing until it is used. So
a tool earns its place only if it wraps an engine of OURS or enforces a shape of
OURS. Anything the agent can do with pandas and a documented array is left to
pandas and a documented array, and ``data_dictionary`` is what makes that
possible.

Two classes, with different failure behaviour:

  Model-native (everything reading the pipeline output) - always works, because
  the pipeline output is committed.

  Side-effecting (map_control, chart) - reach the browser and the filesystem.
  They degrade to a clear message rather than raising, because an agent told
  "the map is not connected" routes around it and one facing a stack trace at
  connect time cannot.
"""

from __future__ import annotations

import json
import time
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import analysis as AN
from . import interventions as IV
from . import knobs
from . import queries as Q
from .dataset import Dataset, load as load_dataset

#: How large a tool result may be before it is truncated. Generous, because the
#: SDK buffer is raised to 32 MB for exactly this reason, but bounded: a request
#: for every panel in the AOI is 294,150 numbers and nobody reads them.
RESULT_CAP = 200_000


@dataclass(frozen=True)
class TurnContext:
    """Who is calling. ``run_id`` is how a map action or a chart finds its way back
    to the browser session that asked for it."""

    run_id: str | None = None
    workspace: Path | None = None


_CTX: ContextVar[TurnContext | None] = ContextVar("hc_tool_ctx", default=None)


def _ctx() -> TurnContext:
    return _CTX.get() or TurnContext()


def _d() -> Dataset:
    return load_dataset()


def _ok(payload: Any) -> dict:
    text = payload if isinstance(payload, str) else json.dumps(
        payload, default=_jsonable, separators=(",", ":"))
    if len(text) > RESULT_CAP:
        text = text[:RESULT_CAP] + (
            f'… [truncated at {RESULT_CAP} characters; narrow the query, raise a '
            f'threshold, or compute the summary you actually need in a script]')
    return {"content": [{"type": "text", "text": text}]}


def _err(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "is_error": True}


def _jsonable(o: Any):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return round(float(o), 6)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return str(o)


# ------------------------------------------------------- the map action queue
#
# The agent can drive the visualisation, and the visualisation is in a browser
# this process does not call out to. So actions are queued per run and delivered
# as frames on the run's existing SSE stream, which the console is already
# reading. One channel, no polling, and an action arrives in the transcript
# beside the sentence that produced it.

_ACTIONS: dict[str, list[dict]] = {}
_ACTION_SINK = None          # set by session.py to publish frames live


def set_action_sink(fn) -> None:
    """Register the callback that publishes a map action as a stream frame."""
    global _ACTION_SINK
    _ACTION_SINK = fn


def actions_for(run_id: str) -> list[dict]:
    return list(_ACTIONS.get(run_id, ()))


def _queue_action(action: dict) -> None:
    rid = _ctx().run_id or "anonymous"
    _ACTIONS.setdefault(rid, []).append(action)
    if _ACTION_SINK is not None:
        try:
            _ACTION_SINK(rid, action)
        except Exception:      # noqa: BLE001 - a dead stream must not fail a tool
            pass


# --------------------------------------------------------------- the handlers


async def _area_summary(args: dict) -> dict:
    return _ok(Q.area_summary(_d()))


async def _data_dictionary(args: dict) -> dict:
    return _ok(Q.data_dictionary(_d()))


async def _methodology(args: dict) -> dict:
    return _ok(Q.methodology(_d(), args.get("topic") or "overview"))


async def _query_buildings(args: dict) -> dict:
    a = {k: v for k, v in args.items() if v is not None}
    limit = a.pop("limit", 10)
    sort_by = a.pop("sort_by", "priority")
    scope = a.pop("scope", "ranked")
    return _ok(Q.query_buildings(_d(), limit=limit, sort_by=sort_by, scope=scope, **a))


async def _get_building(args: dict) -> dict:
    key = args.get("bin_or_address")
    if not key:
        return _err("bin_or_address is required")
    return _ok(Q.get_building(_d(), str(key)))


async def _canyon_stats(args: dict) -> dict:
    return _ok(Q.canyon_stats(_d(), args.get("name_contains"),
                              int(args.get("limit") or 12),
                              args.get("sort_by") or "sections"))


async def _year_series(args: dict) -> dict:
    return _ok(Q.year_series(_d(), args.get("metric") or "tmax",
                             args.get("resolution") or "daily",
                             args.get("start"), args.get("end"),
                             args.get("month")))


async def _climatology(args: dict) -> dict:
    return _ok(Q.climatology(_d()))


async def _compare_periods(args: dict) -> dict:
    a, b = args.get("a"), args.get("b")
    if not a or not b:
        return _err("both `a` and `b` are required; they may be 'event', a month "
                    "number, a month name, or a date inside the study year")
    try:
        return _ok(Q.compare_periods(_d(), str(a), str(b), args.get("hour_slot")))
    except (ValueError, FileNotFoundError) as exc:
        return _err(str(exc))


async def _panel_field(args: dict) -> dict:
    try:
        return _ok(Q.panel_field(_d(), args.get("plane") or "sun_hours",
                                 args.get("group_by") or "aspect",
                                 args.get("period"), args.get("hour_slot"),
                                 int(args.get("limit") or 20)))
    except (KeyError, ValueError) as exc:
        return _err(str(exc))


async def _tile_field(args: dict) -> dict:
    return _ok(Q.tile_field(_d(), args.get("layer") or "hours_above_35",
                            int(args.get("top") or 12)))


async def _scenario_results(args: dict) -> dict:
    return _ok(Q.scenario_results(_d(), args.get("site_label")))


async def _spatial_pattern(args: dict) -> dict:
    d = _d()
    method = (args.get("method") or "moran").lower()
    try:
        if method == "moran":
            return _ok(AN.moran(d, args["variable"],
                                band_m=float(args.get("band_m") or AN.DEFAULT_BAND_M),
                                scope=args.get("scope") or "scored",
                                permutations=int(args.get("permutations") or 999)))
        if method in ("hotspots", "getis", "gi"):
            return _ok(AN.hotspots(d, args["variable"],
                                   band_m=float(args.get("band_m") or AN.DEFAULT_BAND_M),
                                   scope=args.get("scope") or "scored",
                                   fdr=float(args.get("fdr") or 0.05),
                                   top=int(args.get("top") or 25)))
        if method in ("regress", "ols", "regression"):
            return _ok(AN.regress(d, args["variable"], args.get("predictors") or [],
                                  scope=args.get("scope") or "ranked",
                                  robust=bool(args.get("robust", True))))
        if method in ("cluster", "kmeans"):
            return _ok(AN.cluster(d, args.get("variables") or [],
                                  k=int(args.get("k") or 5),
                                  scope=args.get("scope") or "ranked"))
        if method in ("correlate", "correlation"):
            return _ok(AN.correlate(d, args.get("variables") or [],
                                    scope=args.get("scope") or "ranked",
                                    method=args.get("correlation") or "spearman"))
        if method in ("variables", "list"):
            return _ok({"variables": {k: v[0] for k, v in
                                      AN.variable_table(d).items()},
                        "scopes": {
                            "scored": ("all 4,044 buildings inside the AOI, but only "
                                       "the compact fields; the honest scope for "
                                       "anything spatial"),
                            "ranked": ("the top 150 by event-day priority, with every "
                                       "field; a SELECTED sample, so a spatial "
                                       "statistic over it partly measures the "
                                       "selection")}})
        return _err(f"unknown method {method!r}; use moran | hotspots | regress | "
                    f"cluster | correlate | variables")
    except KeyError as exc:
        return _err(f"missing or unknown variable: {exc}. Call with "
                    f"method='variables' to list them.")
    except Exception as exc:      # noqa: BLE001 - surface to the model
        return _err(f"{type(exc).__name__}: {exc}")


async def _run_intervention(args: dict) -> dict:
    d = _d()
    spec = args.get("spec")
    if spec is None:
        return _err("spec is required: a preset name, a list of them, or a dict of "
                    "levers. Call intervention_catalogue to see both.")
    selector = {k: args[k] for k in
                ("streets", "bins", "near", "radius_m", "filters", "whole_aoi")
                if k in args and args[k] is not None}
    if not selector:
        return _err("say where: streets, bins, near+radius_m, filters, or "
                    "whole_aoi=true")
    try:
        return _ok(IV.run(d, spec=spec, period=args.get("period") or "event",
                          window=args.get("window") or "peak",
                          max_canyons=int(args.get("max_canyons") or 40),
                          **selector))
    except IV.SpecError as exc:
        return _err(str(exc))
    except Exception as exc:      # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}")


async def _intervention_catalogue(args: dict) -> dict:
    return _ok(IV.catalogue())


async def _allocate_budget(args: dict) -> dict:
    try:
        return _ok(AN.allocate(_d(), budget=int(args.get("budget") or 20),
                               objective=args.get("objective") or "person_hours",
                               per_unit_effect_k=float(
                                   args.get("assumed_facade_reduction_k") or 3.0),
                               constraint=args.get("constraint") or {}))
    except Exception as exc:      # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}")


# ------------------------------------------------------- the decision layer
#
# Four tools that sit downstream of the physics: the per-floor schedule, the
# specified measure, the programme that funds it, and the money table all four
# are priced against. They are thin on purpose. Every one of them is a call into
# ``heatcanyon.decide``, which is the adapter the pipeline and the HTTP endpoints
# already go through, so a figure the analyst quotes and a figure the interface
# renders come out of the same computation rather than out of two that agree
# today. See docs/DECISIONS.md for the chain and for what each stage may assume.
#
# WHY THE IMPORT IS INSIDE THE HANDLER
#
# ``decide`` pulls in envelope, loads, prescribe, portfolio and economics, and
# through the resolver it reaches the intervention engine as well. That is a lot
# of module to import for an analyst who may only ever be asked how hot a wall
# gets, and — the reason that actually matters — a build without the decision
# layer must still start the analyst with its physics tools intact. The contract
# says the layer adds and never subtracts: its absence degrades one pane, not the
# application. So the import happens on the call and its failure is returned as a
# tool error naming the contract, not raised.

_NO_DECISION_LAYER = (
    "The decision layer is not available in this build ({exc}). That is the "
    "chain which turns a solved surface temperature into a per-floor schedule, a "
    "specified measure and a price; docs/DECISIONS.md is its contract and says "
    "what each stage needs. Nothing upstream of it is affected, so the physical "
    "question is still answerable: answer that, and say plainly that the costed "
    "part is not present in this build rather than estimating it."
)


def _decide():
    """The decision layer, imported on the call. Raises ImportError if absent."""
    from .. import decide as DE
    return DE


def _bin_of(d: Dataset, key: str) -> str | None:
    """A BIN from a BIN or a street address.

    The decision layer is keyed on BIN and a person is not. ``get_building``
    already does the address matching, including the substring fallback, so this
    borrows it rather than growing a second matcher that could disagree with the
    dossier about which building '10 Park' is.
    """
    k = str(key).strip()
    if k in d.bin_to_index:
        return k
    got = Q.get_building(d, k)
    b = got.get("bin") or (got.get("attrs") or {}).get("bin")
    return str(b) if b else None


def _attribution_state(floors: list[dict]) -> dict:
    """Whether this build actually carries the surface-term decomposition.

    A build written before the attribution stage has no ``dt_solar_peak`` plane,
    so ``loads`` receives no terms, every floor reports ``dominant='ambient'``
    and the three kelvin figures are zero. That reads exactly like a building
    which genuinely sits at air temperature, which is the most misleading thing
    this surface could do quietly: the measure family is selected by the
    attribution, so a missing attribution silently removes every facade measure
    from the prescription. It is reported as its own field.
    """
    seen = any(abs(f.get("dt_solar") or 0.0) + abs(f.get("dt_trap") or 0.0)
               + abs(f.get("dt_sky") or 0.0) > 1e-9 for f in floors)
    if seen:
        return {"available": True}
    return {
        "available": False,
        "note": ("This build carries no surface-term attribution planes, so "
                 "dt_solar, dt_trap and dt_sky are zero and every floor reads "
                 "'ambient'. That is a MISSING INPUT, not a finding: do not "
                 "report these floors as sitting at air temperature. Facade "
                 "measures are selected by attribution, so prescribe_building "
                 "will offer only operational and mechanical measures until the "
                 "planes are built."),
    }


async def _building_schedule(args: dict) -> dict:
    """One building, floor by floor."""
    key = args.get("bin_or_address")
    if not key:
        return _err("bin_or_address is required")
    try:
        DE = _decide()
    except Exception as exc:      # noqa: BLE001 — an absent layer is an answer
        return _err(_NO_DECISION_LAYER.format(exc=f"{type(exc).__name__}: {exc}"))

    d = _d()
    b = _bin_of(d, key)
    if b is None:
        return _err(f"No building matching {key!r}. Use query_buildings to find "
                    f"one, or pass a BIN.")
    try:
        # `_jsonable` is the layer's own serialiser and it is used deliberately:
        # it is the one that carries a (lo, hi) through as a two-element list
        # instead of averaging it, which is the property this whole tool exists
        # to preserve.
        loads = DE._jsonable(DE.building_loads(d, b))
    except KeyError as exc:
        return _err(str(exc))
    except Exception as exc:      # noqa: BLE001 — surface it to the model
        return _err(f"{type(exc).__name__}: {exc}")

    rows: list[dict] = loads.get("floors") or []
    worst = loads.get("worst_floor")
    lo = int(args.get("floor_from") or 1)
    hi = int(args.get("floor_to") or 10**6)
    want_faces = bool(args.get("include_faces"))
    out_floors = []
    for f in rows:
        n = int(f.get("floor") or 0)
        if not (lo <= n <= hi):
            continue
        # The per-face rows are two thirds of the payload — 122 kB for a
        # 26-storey building, and this building is not a tall one. They are
        # carried for the floors that were asked for and always for the worst
        # floor, because "which wall" is the question the schedule is usually
        # being read to answer and the worst floor is where it is asked.
        out_floors.append(f if (want_faces or n == worst)
                          else {k: v for k, v in f.items() if k != "faces"})

    attrs = d.attrs[d.bin_to_index[b]] if b in d.bin_to_index else {}
    return _ok({
        "bin": b,
        "address": attrs.get("addr"),
        "storeys": len(rows),
        "bands_solved": 10,
        "assembly": loads.get("assembly"),
        "occupancy": loads.get("occupancy"),
        "peak_kw": loads.get("peak_kw"),
        "annual_mwh": loads.get("annual_mwh"),
        "peak_hour_edt": loads.get("peak_hour_edt"),
        "worst_floor": worst,
        "person_hours": loads.get("person_hours"),
        "floors": out_floors,
        "floors_shown": len(out_floors),
        "roof": loads.get("roof"),
        "basis": loads.get("basis"),
        "notes": loads.get("notes"),
        "attribution": _attribution_state(rows),
        "faces_note": ("Per-face rows are attached to the worst floor and to any "
                       "range you asked for with include_faces; ask for a narrow "
                       "floor_from/floor_to rather than the whole building."
                       if not want_faces else None),
        "how_to_read": (
            "Every pair is a low and a high, and it is a SPREAD between the "
            "corners of an assumed envelope table, not a confidence interval. "
            "Quote both ends. There is no midpoint in this result and inventing "
            "one is the one thing this layer must never be used for. "
            "t_indoor_free_c is a steady-state ESTIMATE with no mechanical "
            "cooling and biases high; t_surface_peak_c is modelled and solved. "
            "Floors map to the ten solved bands, so several storeys share a "
            "band and the schedule says which."),
    })


async def _prescribe_building(args: dict) -> dict:
    """What to do about one building, specified and priced."""
    key = args.get("bin_or_address")
    if not key:
        return _err("bin_or_address is required")
    try:
        DE = _decide()
    except Exception as exc:      # noqa: BLE001
        return _err(_NO_DECISION_LAYER.format(exc=f"{type(exc).__name__}: {exc}"))

    d = _d()
    b = _bin_of(d, key)
    if b is None:
        return _err(f"No building matching {key!r}. Use query_buildings to find "
                    f"one, or pass a BIN.")
    t0 = time.time()
    try:
        got = DE.prescriptions_for(
            d, b,
            period=args.get("period") or "seasons",
            max_canyons=int(args.get("max_canyons") or 12))
    except KeyError as exc:
        return _err(str(exc))
    except Exception as exc:      # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}")

    pres = got.get("prescriptions") or []
    # `prescriptions_for` accepts a `measures` argument and does not apply it, so
    # the filtering is done here rather than passed down. Filtering after the
    # solve rather than before it is also the honest order: the model should be
    # told what it did not ask for, so `available_measures` lists every key that
    # triggered whether or not it survived the filter.
    wanted = [str(m) for m in (args.get("measures") or [])]
    shown = [p for p in pres if not wanted or p.get("key") in wanted]
    loads = got.get("loads") or {}
    floors = loads.get("floors") or []

    return _ok({
        "bin": b,
        "address": (d.attrs[d.bin_to_index[b]].get("addr")
                    if b in d.bin_to_index else None),
        "prescriptions": shown,
        "available_measures": [p.get("key") for p in pres],
        "filtered_out": ([p.get("key") for p in pres
                          if wanted and p.get("key") not in wanted] or None),
        "building": {
            "assembly": (loads.get("assembly") or {}).get("label"),
            "era": (loads.get("assembly") or {}).get("era"),
            "occupancy": (loads.get("occupancy") or {}).get("label"),
            "peak_kw": loads.get("peak_kw"),
            "annual_mwh": loads.get("annual_mwh"),
            "worst_floor": loads.get("worst_floor"),
            "storeys": len(floors),
            "person_hours": loads.get("person_hours"),
        },
        "attribution": _attribution_state(floors),
        "resolve_errors": got.get("resolve_errors") or None,
        "seconds": round(time.time() - t0, 1),
        "basis": got.get("basis"),
        "how_to_read": (
            "These measures are triggered, not authored: the attribution and the "
            "geometry selected them and the same rules select the same measures "
            "again. Select from this list, explain it and price it; do not add "
            "one of your own, and if the measure someone expected is absent say "
            "what would have had to be true for it to trigger. Each `effect` is a "
            "RE-SOLVE of the surface energy balance, not a published coefficient; "
            "an `effect` of null with an `effect_note` means the model has no "
            "lever for that measure and a number was deliberately not invented. "
            "`money` is assumed throughout, every figure a low and a high, and "
            "`winter_cost` is what the measure takes away in January. Call "
            "economic_constants before quoting any of the dollar figures."),
    })


async def _programme_allocation(args: dict) -> dict:
    """A budget across the portfolio, and where a second objective disagrees."""
    try:
        DE = _decide()
    except Exception as exc:      # noqa: BLE001
        return _err(_NO_DECISION_LAYER.format(exc=f"{type(exc).__name__}: {exc}"))

    d = _d()
    t0 = time.time()
    try:
        got = DE.programme(
            d,
            objective=args.get("objective") or "person_hours",
            budget_usd=float(args.get("budget_usd") or 2_000_000.0),
            constraint=args.get("constraint") or None)
    except Exception as exc:      # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}")

    if got.get("error"):
        # The empty programme has two ordinary causes and they are different
        # problems, so both are named rather than left for the model to guess.
        # A build with no attribution planes triggers only operational and
        # mechanical measures, which carry no capex and are not candidates; and
        # a build in which nothing has priced yet — `prescribe` leaves `money`
        # None for `economics.price` to fill — produces measures with a real
        # geometry and no cost, which are equally not candidates.
        return _err(
            f"{got['error']}. The programme is built from PRICED measures, so it "
            f"is empty whenever nothing priced. Two ordinary causes: this build "
            f"has no surface-term attribution, so only operational and mechanical "
            f"measures triggered and none of those carries a capex; or the "
            f"measures triggered and were never costed, in which case each one "
            f"comes back from prescribe_building with a geometry and a null "
            f"`money`. Call prescribe_building on one building and look at "
            f"`money` before concluding anything about the portfolio, and do not "
            f"describe the portfolio as empty of opportunities: it is empty of "
            f"prices.")

    top = max(1, min(int(args.get("top") or 25), 200))
    curve = got.get("curve") or []
    alloc = got.get("allocation") or {}
    selected = alloc.get("selected") or []
    dis = got.get("disagreement") or {}
    only_in = {k: v[:top] for k, v in (dis.get("only_in") or {}).items()}

    return _ok({
        "objective": got.get("objective"),
        "budget_usd": got.get("budget_usd"),
        "curve": curve[:top],
        "curve_length": len(curve),
        "allocation": {k: v for k, v in alloc.items()
                       if k not in ("selected", "marginal")},
        "selected": selected[:top],
        "selected_count": len(selected),
        "marginal_usd_per_unit": (alloc.get("marginal") or [])[:top],
        "phases": {k: {"n": len(v), "measures": [c.get("measure") for c in v][:top]}
                   for k, v in (got.get("phases") or {}).items()},
        "disagreement": {**{k: v for k, v in dis.items()
                            if k not in ("only_in", "allocations", "moved")},
                         "only_in": only_in,
                         "moved": (dis.get("moved") or [])[:top]},
        "ledger": got.get("ledger"),
        "constants_unverified": got.get("constants_unverified"),
        "seconds": round(time.time() - t0, 1),
        "truncated_to": top,
        "how_to_read": (
            "The curve is ordered by cost per unit of the objective, so the "
            "buildings at the top are where the money buys the most and the "
            "shape of the curve is the finding, not the total. The DISAGREEMENT "
            "is the point of the tool: two objectives over one budget pick "
            "different buildings, and the names in only_in are the buildings a "
            "choice of objective adds or drops. That choice is political and is "
            "currently made implicitly; say who is in one list and not the other "
            "rather than reporting a single ranking as the answer. Every capex, "
            "saving and payback here is assumed and carries a low and a high: "
            "report both ends, and call economic_constants first."),
    })


async def _economic_constants(args: dict) -> dict:
    """The money table, with each constant's source, date and verified flag."""
    try:
        from .. import economics as EC
    except Exception as exc:      # noqa: BLE001
        return _err(_NO_DECISION_LAYER.format(exc=f"{type(exc).__name__}: {exc}"))

    rows = EC.constants_table()
    q = (args.get("key_contains") or "").strip().lower()
    if q:
        rows = [r for r in rows if q in r["key"].lower()]
    if args.get("unverified_only"):
        rows = [r for r in rows if not r["verified"]]
    total = EC.constants_table()
    unverified = sum(1 for r in total if not r["verified"])
    return _ok({
        "constants": rows,
        "shown": len(rows),
        "in_table": len(total),
        "unverified": unverified,
        "verified": len(total) - unverified,
        "table_as_of": EC.as_of(),
        "how_to_read": (
            f"{unverified} of the {len(total)} constants in this table are NOT "
            f"VERIFIED: they carry a stated source and a defensible band, and "
            f"nobody has yet checked them against the live rule or the current "
            f"price. The table is only as fresh as its oldest entry, "
            f"{EC.as_of()}. Say so beside any dollar figure you quote, name the "
            f"constant's own as_of date, and treat the Local Law 97 cap and "
            f"penalty as the two where staleness would be actively damaging. "
            f"Ranges are ranges: quote the low and the high."),
    })

async def _map_control(args: dict) -> dict:
    """Drive the visualisation the person is looking at."""
    d = _d()
    action: dict[str, Any] = {"kind": "map", "at": round(time.time(), 3)}
    if args.get("layer"):
        action["layer"] = str(args["layer"])
    if args.get("period"):
        try:
            action["period"] = d.resolve_period(args["period"])
        except ValueError as exc:
            return _err(str(exc))
    if args.get("date"):
        if args["date"] not in d.date_to_day:
            return _err(f"{args['date']} is outside the study year "
                        f"{d.year['window'][0]}..{d.year['window'][1]}")
        action["date"] = args["date"]
    if args.get("hour_slot") is not None:
        action["hour_slot"] = max(0, min(int(args["hour_slot"]), d.n_hour - 1))
    if args.get("aggregate"):
        action["aggregate"] = str(args["aggregate"])
    if args.get("highlight_bins"):
        bins = [str(b) for b in args["highlight_bins"]][:200]
        unknown = [b for b in bins if b not in d.bin_to_index]
        action["highlight_bins"] = [b for b in bins if b in d.bin_to_index]
        if unknown:
            action["unknown_bins"] = unknown[:20]
    if args.get("focus_bin"):
        b = str(args["focus_bin"])
        if b not in d.bin_to_index:
            return _err(f"{b} is not a BIN in this study area")
        action["focus_bin"] = b
    if args.get("camera"):
        action["camera"] = str(args["camera"])
    if args.get("note"):
        action["note"] = str(args["note"])[:280]
    if len(action) <= 2:
        return _err("nothing to do: pass at least one of layer, period, date, "
                    "hour_slot, aggregate, highlight_bins, focus_bin, camera, note")
    _queue_action(action)
    return _ok({
        "applied": action,
        "note": ("Queued for the browser and delivered on this run's event stream. "
                 "It takes effect immediately if a console is watching, and is "
                 "replayed if one connects later."),
        "available": {
            "layer": ["surface", "air", "sun", "exceedance", "persistence",
                      "priority", "annual_priority", "sun_hours", "annual_dose",
                      "annual_kh35", "swing", "month_of_peak"],
            "period": ["event"] + [f"month_{m:02d}" for m in range(1, 13)],
            "aggregate": ["day", "month", "season", "year"],
            "camera": ["orbit", "street"],
        },
    })


async def _run_python(args: dict) -> dict:
    """Run a Python snippet with the dataset already loaded.

    A dedicated tool as well as the shell, because the shell path costs the agent
    a Write, a Bash and a sys.path preamble every time, and the failure mode of
    getting that preamble wrong is an ImportError that looks like a missing
    dataset. Here ``d`` is already the loaded Dataset and the project modules are
    already importable.
    """
    code = args.get("code")
    if not code:
        return _err("code is required")
    import contextlib
    import io
    import traceback

    ws = _ctx().workspace or knobs.workspace_root()
    ws.mkdir(parents=True, exist_ok=True)

    from .. import physics as P
    from .. import solar as S
    from .. import year as YR
    from .. import yearsolve as YS

    env = {
        "np": np, "d": _d(), "Q": Q, "AN": AN, "IV": IV,
        "P": P, "S": S, "YS": YS, "YR": YR, "json": json, "Path": Path,
        "WORKSPACE": ws,
        "__name__": "__hc_agent__",
    }
    buf = io.StringIO()
    t0 = time.time()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            exec(compile(str(code), "<agent>", "exec"), env)  # noqa: S102
    except Exception:             # noqa: BLE001 - the traceback is the answer
        return _ok({
            "stdout": buf.getvalue()[-40_000:],
            "error": traceback.format_exc(limit=6)[-4_000:],
            "seconds": round(time.time() - t0, 2),
            "hint": ("`d` is the loaded Dataset, `np` NumPy, `Q` queries, `AN` "
                     "analysis, `IV` interventions, `P` physics, `YS` the "
                     "vectorised solver, `WORKSPACE` your directory. Call "
                     "data_dictionary for the array layout."),
        })
    out = buf.getvalue()
    return _ok({
        "stdout": out[-60_000:] or "(no output — print what you want to see)",
        "truncated": len(out) > 60_000,
        "seconds": round(time.time() - t0, 2),
    })


async def _chart(args: dict) -> dict:
    """Render a chart into the run's workspace and register it for display."""
    code = args.get("code")
    title = str(args.get("title") or "chart")
    if not code:
        return _err("code is required: matplotlib code that draws onto `fig`")
    import io
    import traceback

    ws = _ctx().workspace or knobs.workspace_root()
    charts = ws / "charts"
    charts.mkdir(parents=True, exist_ok=True)
    slug = "".join(c if c.isalnum() else "-" for c in title.lower())[:48].strip("-")
    path = charts / f"{slug or 'chart'}-{int(time.time())}.png"

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as exc:      # noqa: BLE001
        return _err(f"matplotlib unavailable: {exc}")

    fig = plt.figure(figsize=(float(args.get("width_in") or 9.0),
                              float(args.get("height_in") or 5.0)), dpi=140)
    env = {"np": np, "d": _d(), "Q": Q, "AN": AN, "IV": IV,
           "fig": fig, "plt": plt, "title": title}
    try:
        exec(compile(str(code), "<chart>", "exec"), env)  # noqa: S102
        fig.savefig(path, bbox_inches="tight", facecolor="#0b0e13")
    except Exception:             # noqa: BLE001
        plt.close(fig)
        return _ok({"error": traceback.format_exc(limit=6)[-3_000:],
                    "hint": "Draw onto the provided `fig`. `d` is the Dataset."})
    plt.close(fig)

    rel = path.relative_to(knobs.workspace_root())
    _queue_action({"kind": "chart", "title": title, "path": str(rel),
                   "url": f"/api/agent/artifact/{rel.as_posix()}",
                   "at": round(time.time(), 3)})
    return _ok({"saved": str(path), "shown_in_console": True, "title": title})


# ------------------------------------------------------------------- schemas
#
# EVERY PARAMETER IS OPTIONAL UNLESS IT IS NAMED IN ``required``, and that has to
# be said explicitly. ``tool(name, description, {"limit": int})`` builds a schema
# in which EVERY key is required — measured on the first live turn, where
# ``query_buildings(limit=3, sort_by='annual_priority')`` came back as
# "'min_persistence_h' is a required property" and the model's next move was to
# pass a zero for all seventeen filters, which silently changed the query. A
# filter tool whose filters are mandatory is not a filter tool.
#
# Writing the JSON Schema out also buys per-parameter descriptions, which is where
# a threshold's units and sign convention belong: in the schema the model reads
# when it is choosing the value, not in the prose it read a thousand tokens ago.

def schema(props: dict[str, tuple[str, str]], required: tuple[str, ...] = ()) -> dict:
    """Build a JSON Schema from {name: (json_type, description)}."""
    return {
        "type": "object",
        "properties": {
            name: ({"type": t, "description": desc} if t != "any"
                   else {"description": desc})
            for name, (t, desc) in props.items()
        },
        "required": list(required),
        "additionalProperties": False,
    }


#: Shorthands, so the specs below read as tables rather than as nested dicts.
def _s(desc: str) -> tuple[str, str]: return ("string", desc)
def _i(desc: str) -> tuple[str, str]: return ("integer", desc)
def _n(desc: str) -> tuple[str, str]: return ("number", desc)
def _b(desc: str) -> tuple[str, str]: return ("boolean", desc)
def _a(desc: str) -> tuple[str, str]: return ("array", desc)
def _o(desc: str) -> tuple[str, str]: return ("object", desc)
def _any(desc: str) -> tuple[str, str]: return ("any", desc)


# --------------------------------------------------------- the specialists
#
# A nested SDK client, driven to completion inside the tool call. See
# ``agents.py`` for why this rather than ``ClaudeAgentOptions(agents=...)``: the
# built-in route is asynchronous, and the analyst used it by announcing that two
# jobs were running in the background and then ending its turn with nothing.


async def _consult(args: dict) -> dict:
    from claude_agent_sdk import (AssistantMessage, ClaudeSDKClient, ResultMessage,
                                 TextBlock, ToolUseBlock)

    from . import agents as registry
    from . import options as opt

    name = str(args.get("specialist") or "").strip().lower()
    question = str(args.get("question") or "").strip()
    roster = registry.specialists()
    if name not in roster:
        return _err(f"no specialist called {name!r}. Available: "
                    + "; ".join(f"{k} — {v['description']}" for k, v in roster.items()))
    if len(question) < 12:
        return _err("give the specialist a full question. It has no context beyond "
                    "what you write here: it cannot see this conversation, the map, "
                    "or anything you have already looked up. State the question, the "
                    "place or period it applies to, and what you want back.")

    spec = roster[name]
    ws = (_ctx().workspace or knobs.workspace_root()) / "specialists" / name
    ws.mkdir(parents=True, exist_ok=True)

    from claude_agent_sdk import ClaudeAgentOptions
    options = ClaudeAgentOptions(
        cwd=str(ws),
        model=knobs.model(),
        effort=knobs.effort(),
        # Half the parent's turn budget. A specialist that spends the whole
        # envelope leaves the analyst unable to write the answer it produced.
        max_budget_usd=max(0.25, knobs.turn_budget_usd() / 2.0),
        permission_mode="acceptEdits",
        setting_sources=[],
        mcp_servers={"heatcanyon": build_server(run_id=_ctx().run_id, workspace=ws)},
        allowed_tools=list(spec["tools"]),
        disallowed_tools=list(opt.DISALLOWED_TOOLS),
        agents=None,
        hooks=None,
        env=opt.child_env(),
        thinking={"type": "disabled"},
        max_buffer_size=32 * 1024 * 1024,
        system_prompt=spec["prompt"],
    )

    said: list[str] = []
    used: list[str] = []
    cost = 0.0
    t0 = time.time()
    try:
        async with ClaudeSDKClient(options=options) as client:
            await client.query(question)
            async for message in client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text.strip():
                            said.append(block.text)
                        elif isinstance(block, ToolUseBlock):
                            used.append(block.name.split("__")[-1])
                elif isinstance(message, ResultMessage):
                    cost = float(message.total_cost_usd or 0.0)
    except Exception as exc:      # noqa: BLE001 — the analyst must be able to route around it
        return _err(f"the {name} could not be reached ({type(exc).__name__}: {exc}). "
                    f"Do the work yourself with the tools you have.")

    answer = "\n\n".join(said).strip()
    if not answer:
        return _err(f"the {name} returned nothing. Ask it again with a narrower "
                    f"question, or do the work yourself.")
    return _ok({
        "specialist": name,
        "answer": answer,
        "tools_it_used": used,
        "cost_usd": round(cost, 6),
        "seconds": round(time.time() - t0, 1),
        "note": ("This is the specialist's own answer, produced in its own context "
                 "against the same model. Check its figures the way you would check "
                 "your own: it can be wrong, and it cannot see anything you have "
                 "not told it."),
    })


# ------------------------------------------------------------------ registry
#
# (name, description, schema, handler). The description is what the model reads
# to decide whether to call it, so it says what the tool is FOR and what the
# result means, not merely what its arguments are.

TOOL_SPECS: list[tuple[str, str, dict, Any]] = [
    ("area_summary",
     "Headline facts about the study area: the heat event and its eight measured "
     "hours, the year's totals, monthly and seasonal aggregates, heat-wave "
     "episodes found by run length, counts of buildings and canyons, and the "
     "morphology statistics. Call this first for almost any question. It also "
     "tells you which temporal tier answers what, which you need before quoting "
     "any figure.",
     schema({}), _area_summary),

    ("data_dictionary",
     "Everything that exists in this model, where it is, in what units, and how to "
     "reach it from a script. Call this when a question needs something the other "
     "tools do not return, before writing code against the arrays. It lists the "
     "thirteen solved periods, the annual planes and their meanings, the building "
     "and canyon field names, and the exact import lines.",
     schema({}), _data_dictionary),

    ("methodology",
     "How a part of the model works and how confident to be in it, with the "
     "measured figures attached. Topics: overview, year, bias_correction, "
     "uncertainty, convection, svf, validation, shading, timezone, scoring, "
     "tile_transfer. Call this whenever someone asks how something was computed, "
     "how reliable it is, or challenges a result, and cite the limitation rather "
     "than defending the number.",
     schema({"topic": _s("overview | year | bias_correction | uncertainty | "
                           "convection | svf | validation | shading | timezone | "
                           "scoring | tile_transfer")}),
     _methodology),

    ("query_buildings",
     "Filter and sort the scored buildings. Use it for every question of the form "
     "'which buildings'. Thresholds are optional and combine with AND. Two "
     "orderings exist and they disagree: sort_by='priority' is the event-day heat "
     "wave, sort_by='annual_priority' is the whole year. Returns the matched count "
     "so you can report how selective a filter was. Filters: min_persistence_h, "
     "min_exceedance_h, min_svf, max_svf, min_units, min_hvi, min_facade_peak_c, "
     "min_wbgt_c, min_height_m, max_height_m, built_before, built_after, "
     "residential_only, min_annual_kh35, min_annual_sun_hours, min_annual_swing_k, "
     "min_annual_priority, month_of_peak, land_use_name, zip, address_contains.",
     schema({
         "limit": _i("how many to return, 1-60, default 10"),
         "sort_by": _s("priority (event-day) | annual_priority | exposure | "
                       "annual_exposure | vulnerability | persistence | exceedance | "
                       "facade_temp | annual_facade_kh35 | annual_sun_hours | "
                       "annual_swing | units | svf | height | year_built"),
         "scope": _s("'ranked' (default) searches the 150 buildings with full "
                     "dossiers, selected by EVENT-DAY priority — so it is a biased "
                     "sample for an annual question. 'scored' searches all 4,044 "
                     "scored buildings using the compact fields, and is the right "
                     "scope for 'which buildings in the whole area'. The compact "
                     "fields include both annual scores, annual facade degree-hours, "
                     "annual solar dose, sunlit hours, swing and month of peak."),
         "min_persistence_h": _n("minimum unbroken hours above 35 C, measured"),
         "min_exceedance_h": _n("minimum total hours above 35 C over the heat wave, "
                                "measured"),
         "min_svf": _n("minimum sky view factor 0-1"),
         "max_svf": _n("maximum sky view factor 0-1; lower means more enclosed"),
         "min_units": _i("minimum residential units"),
         "min_hvi": _i("minimum DOHMH Heat Vulnerability Index, 1-5"),
         "min_facade_peak_c": _n("minimum modelled peak facade surface temp, degC"),
         "min_wbgt_c": _n("minimum modelled WBGT at the base, degC"),
         "min_height_m": _n("minimum building height, metres"),
         "max_height_m": _n("maximum building height, metres"),
         "built_before": _i("only buildings constructed before this year"),
         "built_after": _i("only buildings constructed after this year"),
         "residential_only": _b("restrict to buildings with residential units"),
         "min_annual_kh35": _n("minimum annual facade degree-hours above 35 C, K.h"),
         "min_annual_sun_hours": _n("minimum annual sunlit hours per facade band"),
         "min_annual_swing_k": _n("minimum summer-minus-winter facade mean, K"),
         "min_annual_priority": _n("minimum annual priority score, 0-100"),
         "month_of_peak": _i("only buildings whose annual facade maximum falls in "
                             "this month, 1-12"),
         "land_use_name": _s("substring of the PLUTO land-use name"),
         "zip": _s("exact ZIP code"),
         "address_contains": _s("case-insensitive substring of the address"),
     }),
     _query_buildings),

    ("get_building",
     "Full dossier for one building by BIN or street address: every measured and "
     "modelled figure, both score decompositions, its rank on the heat wave and on "
     "the year, the plain-language reasons for each, its facade broken down by "
     "aspect with annual sun hours per aspect, its worst panel and band, its "
     "canyon, and its triggered intervention list with the public programme that "
     "funds each measure. Call this before recommending anything for a specific "
     "building.",
     schema({"bin_or_address": _s("a BIN like '1025009', or a street address")},
            required=("bin_or_address",)),
     _get_building),

    ("canyon_stats",
     "Street-canyon morphology aggregated per street: facade-to-facade and "
     "curb-to-curb width, wall height, aspect ratio H/W, sky view factor, "
     "asymmetry, bearing, existing tree cover, and the annual facade load and "
     "sunlit hours of the walls on that street. Use it for questions about streets "
     "rather than buildings. sort_by: sections, aspect, svf, annual_load, "
     "sun_hours, trees.",
     schema({
         "name_contains": _s("case-insensitive substring, e.g. 'MADISON' or "
                             "'47 STREET'"),
         "limit": _i("how many streets to return, default 12"),
         "sort_by": _s("sections | aspect | svf | annual_load | sun_hours | trees"),
     }),
     _canyon_stats),

    ("year_series",
     "Any quantity as a function of time across the study year. resolution: daily "
     "(365 values; metrics tmax, tmin, tmean, h35, h32, kh35, trop, cdd, hdd, "
     "ghi_kwh, rh, wind, cloud, precip, dni_peak, daylight, noon_alt, tmax_h), "
     "monthly (12 values, any monthly field), or hourly (8,760 values; t_air_c, "
     "t_air_raw_c, apparent_c, rh, wind_ms, cloud, ghi, dni, dhi, plus "
     "facade_mean_c which is the scene-mean modelled facade temperature). Optional "
     "start, end and month narrow it. This is the tool the year exists for: ask "
     "for the series, not a summary of it.",
     schema({
         "metric": _s("see the description for the list appropriate to each "
                      "resolution"),
         "resolution": _s("daily (default) | monthly | hourly"),
         "start": _s("first date, YYYY-MM-DD, inside the study year"),
         "end": _s("last date, YYYY-MM-DD"),
         "month": _i("restrict to one calendar month, 1-12"),
     }),
     _year_series),

    ("climatology",
     "The year summarised: annual totals, twelve monthly records, four seasons, "
     "the heat-wave episodes found by run length over the daily maxima, the "
     "hottest and coldest days, every tropical night by date, the diurnal range "
     "and noon sun altitude by month, and where the modelled event day sits in the "
     "year's own ranking.",
     schema({}), _climatology),

    ("compare_periods",
     "Two solved periods side by side over every panel and band, hour by hour: "
     "each one's surface-temperature distribution, its sunlit fraction, and the "
     "difference between them in kelvin. Periods are 'event', a month number, a "
     "month name, or a date. Use it for 'how does July differ from October' — and "
     "read the lit_fraction rows before attributing a difference to the weather, "
     "because most of a monthly difference is solar geometry.",
     schema({
         "a": _s("'event', a month number or name, or a date"),
         "b": _s("the period to compare against"),
         "hour_slot": _i("0-7; omit for all eight hours. Slot 4 is 15:00 EDT, the "
                         "event day's peak"),
     }, required=("a", "b")),
     _compare_periods),

    ("panel_field",
     "A facade field aggregated the way you need it. Either an annual plane "
     "(sun_hours, dose_kwh, absorbed_kwh, degree_hours_35, degree_hours_40, "
     "hours_above_35, t_max, t_min, t_mean, summer_mean, winter_mean, swing, "
     "month_of_max) or, by passing `period`, one solved hour's surface or air "
     "field. group_by: aspect, band, material, street, building, canyon_depth, "
     "height_band, none. This is how you find out that west walls take twice the "
     "annual dose of north walls, with the number.",
     schema({
         "plane": _s("an annual plane name, or 'surface'/'air' together with "
                     "`period`"),
         "group_by": _s("aspect | band | material | street | building | "
                        "canyon_depth | height_band | none"),
         "period": _s("set this to read one solved hour instead of an annual plane"),
         "hour_slot": _i("0-7, with `period`; defaults to the middle of the day"),
         "limit": _i("how many groups to return, default 20"),
     }),
     _panel_field),

    ("tile_field",
     "The 60 m tile field: the measured event-wave layers (exceedance, "
     "persistence) or an annual composite metric (hours_above_35, hours_above_32, "
     "degree_hours_35, tropical_nights, mean_c, max_c, cdd). Returns the "
     "distribution and the hottest and coolest tiles with coordinates. The annual "
     "layers are a composite of FortyGuard's measured spatial anomaly and the "
     "reanalysis level; say so when you quote them.",
     schema({
         "layer": _s("exceedance | persistence | hours_above_35 | hours_above_32 | "
                     "degree_hours_35 | tropical_nights | mean_c | max_c | cdd"),
         "top": _i("how many extreme tiles at each end, default 12"),
     }),
     _tile_field),

    ("scenario_results",
     "The precomputed what-if grid: six interventions at three representative "
     "canyons, at three hours of the event day and at all twelve monthly peaks, "
     "with the annual and seasonal roll-up and the published effect ranges the "
     "model's response was checked against. Use it for the general picture. For an "
     "intervention at a particular place or scale, use run_intervention, which "
     "re-solves rather than interpolating.",
     schema({"site_label": _s("optional site or street filter")}),
     _scenario_results),

    ("spatial_pattern",
     "Test whether a spatial pattern is real, locate it, or model it. "
     "method='moran' is global Moran's I with a permutation test — run it before "
     "claiming clustering exists. method='hotspots' is Getis-Ord Gi* with a "
     "Benjamini-Hochberg false-discovery correction, which locates clusters and "
     "separates hot from cold. method='regress' is OLS with robust standard "
     "errors, variance inflation factors and the extreme residuals named, which is "
     "usually where the finding is. method='cluster' is k-means on standardised "
     "variables. method='correlate' is a screening matrix. method='variables' "
     "lists what you can ask about. scope='scored' is all 4,044 buildings and is "
     "the honest scope for anything spatial; scope='ranked' is the top 150 with "
     "every field but is a selected sample.",
     schema({
         "method": _s("moran | hotspots | regress | cluster | correlate | variables"),
         "variable": _s("the variable to test, or the dependent variable for "
                        "regress. Call method='variables' to list them"),
         "predictors": _a("regress only: the independent variables"),
         "variables": _a("cluster and correlate only: the variables to use"),
         "scope": _s("scored (all 4,044, the honest scope for anything spatial) | "
                     "ranked (top 150, every field, but a selected sample)"),
         "band_m": _n("spatial weights distance band in metres, default 150"),
         "permutations": _i("moran only, default 999"),
         "fdr": _n("hotspots only: Benjamini-Hochberg q, default 0.05"),
         "top": _i("hotspots only: how many clusters at each end"),
         "k": _i("cluster only: how many clusters, 2-12"),
         "robust": _b("regress only: HC1 standard errors, default true"),
         "correlation": _s("correlate only: spearman (default) | pearson"),
     }, required=("method",)),
     _spatial_pattern),

    ("run_intervention",
     "Re-solve the physics for an intervention anywhere in the model, over any "
     "window. This is the tool that makes the platform a planning instrument "
     "rather than a map: it changes an albedo, a canopy fraction, a shading factor "
     "or a wall admittance and solves the surface energy balance again for the "
     "canyons you selected. It does not apply a published coefficient. "
     "`spec` is a preset name, a list of them, or a dict of levers "
     "(intervention_catalogue lists both). Say where with `streets`, `bins`, "
     "`near`+`radius_m`, `filters` (any query_buildings filter), or "
     "`whole_aoi`. `period` is 'event', a month, a list, 'seasons', or 'year' — "
     "use 'year' or 'seasons' for anything but a single-hour question, because a "
     "measure that removes 4 K in July may remove January's solar gain too and the "
     "July figure alone is not an answer. Returns deltas in kelvin with the spread "
     "across canyons, the per-canyon table so you can say where it fails, the "
     "seasonal split, and the population-weighted exposure change.",
     schema({
         "spec": _any("a preset name, a list of preset names, or an object of "
                      "levers such as {'tree_cover': 0.45, 'facade_shade': 0.35}. "
                      "intervention_catalogue lists both"),
         "streets": _a("street names, substring matched, e.g. ['MADISON AVE']"),
         "bins": _a("building BINs"),
         "near": _a("[x, y] in local metres"),
         "radius_m": _n("with `near`, default 200"),
         "filters": _o("any query_buildings filter object"),
         "whole_aoi": _b("treat the entire study area"),
         "period": _s("event | month_01..month_12 | seasons | year"),
         "window": _s("peak (default) | afternoon | daylight | day"),
         "max_canyons": _i("cap on canyons solved, default 40; a stratified sample "
                           "by aspect ratio is taken above it"),
     }, required=("spec",)),
     _run_intervention),

    ("intervention_catalogue",
     "The levers an intervention spec may pull, each with its physical meaning, "
     "its valid range and its known trade-off; the named presets; the windows; and "
     "the selectors. Call this before run_intervention if you are unsure what to "
     "ask for.",
     schema({}), _intervention_catalogue),

    ("allocate_budget",
     "Where a fixed budget of building-level interventions should go, by marginal "
     "benefit. objective='person_hours' weights avoided facade dose by residents "
     "and is the default; 'degree_hours' ignores who lives there; 'vulnerable' "
     "weights by the Heat Vulnerability Index; 'peak_relief' optimises the acute "
     "event rather than the year. Run two objectives and compare: where the "
     "orderings differ is where efficiency and equity pull apart. "
     "assumed_facade_reduction_k is an INPUT — get it from run_intervention first, "
     "then allocate.",
     schema({
         "budget": _i("how many buildings the money covers, default 20"),
         "objective": _s("person_hours (default) | degree_hours | vulnerable | "
                         "peak_relief"),
         "assumed_facade_reduction_k": _n("the facade cooling the measure delivers, "
                                          "K; get it from run_intervention first"),
         "constraint": _o("{residential_only, min_hvi, built_before, zip}"),
     }),
     _allocate_budget),

    ("map_control",
     "Drive the visualisation the person is looking at. Set `layer`, `period` "
     "(event or a month), `date` (any day in the study year), `hour_slot` (0-7), "
     "`aggregate` (day, month, season, year), `camera` (orbit or street); "
     "`highlight_bins` to light up the buildings you are naming; `focus_bin` to "
     "select one and open its dossier; `note` for a one-line caption. Call this "
     "whenever your answer is about a place, a time or a set of buildings: an "
     "answer they watch happen on the city is worth more than the same answer in "
     "prose.",
     schema({
         "layer": _s("surface | air | sun | exceedance | persistence | priority | "
                     "annual_priority | sun_hours | annual_dose | annual_kh35 | "
                     "swing | month_of_peak"),
         "period": _s("event | month_01..month_12"),
         "date": _s("any day in the study year, YYYY-MM-DD"),
         "hour_slot": _i("0-7; slot 4 is 15:00 EDT"),
         "aggregate": _s("day | month | season | year"),
         "highlight_bins": _a("BINs to light up, up to 200"),
         "focus_bin": _s("one BIN to select and open"),
         "camera": _s("orbit | street"),
         "note": _s("a one-line caption, up to 280 characters"),
     }),
     _map_control),

    ("run_python",
     "Run Python with the model already loaded. `d` is the Dataset (see "
     "data_dictionary for its layout), `np` NumPy, `Q` the query surface, `AN` the "
     "statistics, `IV` the interventions, `P` the physics engine, `YS` the "
     "vectorised solver, `WORKSPACE` your directory. print what you want to see. "
     "Use this for anything the tools do not cover — a custom aggregation, a join, "
     "a distribution, a bespoke statistic. A script that produces a number is a "
     "better answer than a tool that nearly does.",
     schema({"code": _s("Python source. print what you want to see")},
            required=("code",)),
     _run_python),

    ("consult_specialist",
     "Hand one well-scoped question to a specialist and get its answer back before "
     "you continue. The call BLOCKS until it is done, so its answer is in your "
     "context before you write a word — there is nothing to wait for and nothing to "
     "poll. Three specialists: `geographer` finds and TESTS spatial patterns and "
     "goes after the residuals; `physicist` re-solves interventions across the "
     "seasons and reports where they fail as prominently as where they work; "
     "`reviewer` is read-only and checks a draft answer for figures that cannot be "
     "traced, provenance labels that are wrong, and figures quoted from the wrong "
     "temporal tier. Each has its own tool set and its own budget. It cannot see "
     "this conversation, the map, or anything you have already looked up, so write "
     "the whole question. Use it when a question has a distinct sub-problem worth "
     "someone's full attention; do the ordinary work yourself.",
     schema({
         "specialist": _s("geographer | physicist | reviewer"),
         "question": _s("the whole question, with its place, period and what you "
                        "want back. The specialist has no other context."),
     }, required=("specialist", "question")),
     _consult),

    ("chart",
     "Render a matplotlib chart into the console beside your answer. Write code "
     "that draws onto the provided `fig`; `d`, `np`, `Q`, `AN` and `IV` are in "
     "scope. Use it when a shape is the finding — a seasonal curve, a "
     "distribution, an intervention's response across canyons — and prose would "
     "only describe it.",
     schema({
         "code": _s("matplotlib source drawing onto the provided `fig`"),
         "title": _s("chart title, also the filename"),
         "width_in": _n("figure width in inches, default 9"),
         "height_in": _n("figure height in inches, default 5"),
     }, required=("code",)),
     _chart),

    # --------------------------------------------------- the decision layer
    #
    # Physics into watts, watts into a measure, a measure into money, money into
    # a programme. Everything below this line is ASSUMED in the sense
    # docs/DECISIONS.md defines: it passed through a table of stated assumptions
    # that no measurement in this study constrains, and it therefore arrives as a
    # low and a high rather than as a number. The descriptions say so, in every
    # one of the four, because the model reads these when it is deciding what to
    # call and not when it is deciding how to write.

    ("building_schedule",
     "One building's cooling schedule, floor by floor: the assumed envelope "
     "assembly and occupancy it was computed from, the peak cooling load and the "
     "annual cooling energy for the whole building, and for every storey its peak "
     "facade surface temperature, its free-running indoor estimate, its load, "
     "which of the three surface terms its heat is ARRIVING FROM, and whether it "
     "recovers overnight. This is how you answer 'what should I do about this "
     "building' at floor resolution: floor 3 and floor 22 of one tower are "
     "usually two different problems, and the schedule is where that shows. Every "
     "figure here is ASSUMED — the envelope, the glazing, the occupancy and the "
     "tariffs are era rules, not a survey of this building — so every one arrives "
     "as a low and a high and must be reported as both. The indoor temperature is "
     "a steady-state estimate with no mechanical cooling and biases high. Ten "
     "solved height bands carry the storeys, so several storeys share a band and "
     "the result says which. Follow it with prescribe_building for what to do.",
     schema({
         "bin_or_address": _s("a BIN like '1017105', or a street address"),
         "floor_from": _i("first storey to return, 1-based; default 1"),
         "floor_to": _i("last storey to return, inclusive; default the top"),
         "include_faces": _b("attach the per-face rows (aspect, treated area, "
                             "peak temperature, conduction, solar gain, annual "
                             "sun hours) to every floor returned. Off by default "
                             "because it triples the size; the worst floor always "
                             "carries them. Narrow the floor range before turning "
                             "this on."),
     }, required=("bin_or_address",)),
     _building_schedule),

    ("prescribe_building",
     "The measures specified for one building: for each, the device and its "
     "geometry, the faces and the floor range it covers, the treated area, the "
     "effect from a RE-SOLVE of the physics, what it costs in winter, the capex, "
     "the payback and the public programme that funds it. A recommendation "
     "without a geometry, an extent and a price is a topic rather than a "
     "decision, and this is the tool that turns one into the other. The measure "
     "family is chosen by the ATTRIBUTION, never by a temperature: four floors at "
     "53 C can need four different measures, and shading a floor whose heat "
     "arrives as longwave from the building opposite buys almost nothing. It "
     "re-solves the canyon energy balance once per measure, so it TAKES A FEW "
     "SECONDS; that is a real solve, not a coefficient. You do not author "
     "measures: this returns them and you select, explain and price from what it "
     "returned. Every money figure is assumed and is a low and a high. Call "
     "building_schedule first if you want the floor detail, and economic_constants "
     "before you quote a dollar.",
     schema({
         "bin_or_address": _s("a BIN like '1017105', or a street address"),
         "measures": _a("optional: only return these measure keys. A key repeats "
                        "when one measure is specified separately for different "
                        "faces or floor ranges, and asking for it returns all of "
                        "them. Everything that triggered is listed in "
                        "available_measures either way"),
         "period": _s("which window the effect is re-solved over: 'seasons' "
                      "(default, and the honest one, because a shading measure "
                      "removes January's solar gain too), 'year', 'event', or a "
                      "month"),
         "max_canyons": _i("cap on canyons solved per measure, default 12; raise "
                           "it for a building on a long street, at a cost in "
                           "seconds"),
     }, required=("bin_or_address",)),
     _prescribe_building),

    ("programme_allocation",
     "The portfolio: every priced measure in the study area ordered into a cost "
     "curve, a budget allocated down it under one objective, and — the reason to "
     "call it — where a SECOND objective would have spent the same money "
     "differently. It returns the curve, the selected measures with their "
     "marginal cost per unit of benefit, the buildings that appear under one "
     "objective and not the other, the phasing by lead time (this season, one "
     "year, capital cycle) and a generated outcome ledger you can quote. The "
     "disagreement between two objectives is a political choice currently being "
     "made implicitly, so report both columns and name who moves rather than "
     "presenting one ranking as the answer. The first call in a process prices "
     "every ranked building and takes tens of seconds; after that it is cached. "
     "Every capex and saving is assumed and carries a low and a high.",
     schema({
         "objective": _s("person_hours (default; avoided indoor exposure weighted "
                         "by residents) | degree_hours (ignores who lives there) | "
                         "vulnerable (weighted by the Heat Vulnerability Index) | "
                         "peak_relief (the acute event rather than the year)"),
         "budget_usd": _n("the capital budget in dollars, default 2,000,000"),
         "constraint": _o("{residential_only, min_hvi, built_before, zip} — "
                          "restricts which candidates are eligible"),
         "top": _i("how many rows of the curve, the selection and each "
                   "disagreement list to return, default 25"),
     }),
     _programme_allocation),

    ("economic_constants",
     "The money table: every constant the decision layer prices with, each with "
     "its value or its range, its unit, its source, the date it is current as of, "
     "and whether anyone has VERIFIED it. Call this before you quote any dollar "
     "figure, without exception. A MAJORITY OF THIS TABLE IS CURRENTLY "
     "UNVERIFIED: the entries carry a stated source and a defensible band, and "
     "nobody has yet checked them against the live rule or the current price, so "
     "a payback quoted from them is an arithmetic result and not a market fact. "
     "The table is only as fresh as its oldest entry and a stale tariff is a "
     "wrong answer that looks right. Local Law 97's emissions cap and its penalty "
     "are the two where staleness would be actively damaging; check those against "
     "the live rule on the web before quoting them, and label what you find "
     "EXTERNAL.",
     schema({
         "key_contains": _s("substring of the constant key, e.g. 'capex', "
                            "'ll97', 'electricity'"),
         "unverified_only": _b("only the constants nobody has checked yet"),
     }),
     _economic_constants),
]

TOOL_NAMES = [name for name, _, _, _ in TOOL_SPECS]


def _bound(handler, ctx: TurnContext):
    """Bind a handler to its run for the duration of the call, not for the turn.

    Set inside the call rather than once per server, because we do not control
    which task the SDK runs a handler on: a ContextVar assigned when the server
    was built is visible only to handlers the SDK happens to schedule on the same
    task. Two consoles asking questions at once is the ordinary case here, and a
    map action landing in the wrong browser is exactly the bug this shape avoids.
    """
    async def call(args):
        token = _CTX.set(ctx)
        try:
            return await handler(args)
        finally:
            _CTX.reset(token)

    call.__name__ = getattr(handler, "__name__", "tool")
    call.__doc__ = getattr(handler, "__doc__", None)
    return call


def build_server(name: str = "heatcanyon", *, run_id: str | None = None,
                 workspace: Path | None = None):
    """Create the in-process MCP server for one turn."""
    from claude_agent_sdk import create_sdk_mcp_server, tool

    ctx = TurnContext(run_id=run_id, workspace=workspace)
    tools = [tool(n, desc, schema)(_bound(handler, ctx))
             for n, desc, schema, handler in TOOL_SPECS]
    return create_sdk_mcp_server(name=name, version="1.0.0", tools=tools)


def allowed_tool_names(server_name: str = "heatcanyon") -> list[str]:
    """MCP tools are namespaced ``mcp__<server>__<tool>``."""
    return [f"mcp__{server_name}__{n}" for n in TOOL_NAMES]

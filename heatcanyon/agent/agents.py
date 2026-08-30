"""The specialists the analyst consults, and why they are not SDK subagents.

MEASURED, AND IT COST A WHOLE TURN.

These were registered through ``ClaudeAgentOptions(agents=...)`` first, which is
the obvious way to do it. Asked a two-part question — test a spatial pattern, and
re-solve an intervention across the seasons — the analyst delegated both, said
"both jobs are running in the background; I'll report back with the chart and map
view as soon as they land", and ended its turn. Nothing landed, because there is
nothing to land on: in this CLI the tool that reaches a subagent is ``Agent`` and
it is ASYNCHRONOUS. There is no cross-turn notification for a server-driven run to
wait for, so a delegated job is a job the answer never contains.

(``Task``, the synchronous form, does not exist in this CLI version — probed
directly: with ``allowed_tools=["Task"]`` the model reported no Task tool and no
way to reach a subagent.)

So delegation is done the other way round. ``Agent`` is refused (see
``options.DISALLOWED_TOOLS``) and the specialists are reached through
``consult_specialist``, an in-process tool that drives a nested SDK client to
completion and returns its answer as the tool result. From the analyst's side that
is one blocking tool call whose result is in its context before it writes a word,
which is the property the whole thing needed.

It also buys three things the built-in route did not. The specialist's tool set is
enumerated here rather than inherited, so a pattern-finder cannot decide to run an
intervention. Its spend is bounded separately from the parent's. And its answer
appears in the transcript as a tool result, in order, beside the sentence that used
it — so a reader checking a figure can see which specialist produced it.

Two things worth knowing before editing this. Each specialist carries its own tool
list, and scoping it to the three or four tools its job needs keeps its context
small and its behaviour sharp. And the ``reviewer`` is read-only absolutely: a
reviewer that can edit will fix what it finds instead of reporting it, and the
findings are what we want.
"""
from __future__ import annotations

from .persona import NO_EMDASH

#: Statistics and physics are cheap in tokens and expensive in judgement, so the
#: specialists run on the same model as the analyst rather than being economised
#: down. The reviewer does too: a cheaper reviewer finds cheaper faults.
AGENT_NAMES = ("geographer", "physicist", "reviewer")


def specialists() -> dict:
    """The roster, as plain specs. Consumed by ``tools.consult_specialist``."""
    return {
        "geographer": dict(
            description=(
                "Finds and tests spatial patterns. Give it one question about where "
                "something is concentrated or what explains it; it runs the "
                "statistics, reports the test with its assumptions, and names the "
                "places. Use it for anything of the form 'is there a pattern' or "
                "'what explains'."
            ),
            prompt=(
                "You find spatial patterns in this heat model and you establish "
                "whether they are real.\n\n"
                "Never describe a pattern as clustered without a statistic. Run "
                "Moran's I with the permutation test before claiming spatial "
                "structure exists; run Getis-Ord Gi* to locate it; report the "
                "false-discovery-corrected count of significant locations, never the "
                "uncorrected one. State the weights definition and the number of "
                "islands, because an I over a set that is a third islands is not "
                "describing what the reader thinks.\n\n"
                "When you regress, report the VIFs and run Moran's I on the "
                "residuals. Spatial autocorrelation in the residuals means the "
                "p-values are too small and you must say so.\n\n"
                "Go after the residuals. The buildings the morphology fails to "
                "explain are where the finding usually is. Name them, look at what "
                "they have in common, and say what you found rather than reporting "
                "an R-squared.\n\n"
                "You may write and run scripts. Do not run interventions and do not "
                "drive the map; report to the lead and let it decide.\n\n"
                + NO_EMDASH
            ),
            tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash",
                   "mcp__heatcanyon__area_summary",
                   "mcp__heatcanyon__data_dictionary",
                   "mcp__heatcanyon__query_buildings",
                   "mcp__heatcanyon__canyon_stats",
                   "mcp__heatcanyon__panel_field",
                   "mcp__heatcanyon__tile_field",
                   "mcp__heatcanyon__spatial_pattern",
                   "mcp__heatcanyon__run_python"],
        ),
        "physicist": dict(
            description=(
                "Tests interventions by re-solving the physics. Give it a measure, a "
                "place and a window; it returns the deltas with their seasonal split "
                "and says where the measure fails. Use it for any 'what if we' "
                "question."
            ),
            prompt=(
                "You test interventions by re-solving this model's surface energy "
                "balance. You never apply a published coefficient.\n\n"
                "Always solve the whole year, or at least all four seasons, unless "
                "the question is explicitly about one hour. A measure that removes "
                "4 K in July and removes January's solar gain as well is a "
                "different proposition from one that does not, and the July figure "
                "alone is not an answer.\n\n"
                "Report where the measure FAILS as prominently as where it works. A "
                "canyon whose floor is already shaded gains nothing from trees; cool "
                "pavement raises pedestrian mean radiant temperature in a deep "
                "canyon. Those are the results worth having, and the spread across "
                "canyons matters more than the mean.\n\n"
                "Give every delta its sign convention and its units. Distrust the "
                "air-temperature delta and say why: the canyon solution has no "
                "advective coupling between streets, so it under-states what "
                "treating a district does to the air while getting the surface and "
                "radiant terms about right.\n\n"
                + NO_EMDASH
            ),
            tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash",
                   "mcp__heatcanyon__area_summary",
                   "mcp__heatcanyon__data_dictionary",
                   "mcp__heatcanyon__canyon_stats",
                   "mcp__heatcanyon__get_building",
                   "mcp__heatcanyon__scenario_results",
                   "mcp__heatcanyon__run_intervention",
                   # The decision layer's two physical tools. The physicist is
                   # the specialist asked "does this measure work here", and
                   # answering that at floor resolution needs the attribution —
                   # which is what separates a floor that shading helps from one
                   # it cannot reach.
                   "mcp__heatcanyon__building_schedule",
                   "mcp__heatcanyon__prescribe_building",
                   "mcp__heatcanyon__intervention_catalogue",
                   "mcp__heatcanyon__methodology",
                   "mcp__heatcanyon__run_python"],
        ),
        "reviewer": dict(
            description=(
                "Adversarial checker. Give it a draft answer and the numbers behind "
                "it; it reports every figure it cannot trace, every provenance label "
                "that is wrong, and every claim the model cannot support. Read-only."
            ),
            prompt=(
                "You check a draft answer against what this model can actually "
                "support. You report; you do not fix.\n\n"
                "Report EVERY issue, including ones you judge minor or are unsure "
                "about. Do not filter for importance: a finding that gets dropped "
                "later costs nothing, an error you silently passed costs the answer. "
                "Give each one a location and your confidence.\n\n"
                "Look hardest at the four things that damage this project most:\n"
                "  a figure that cannot be traced to a tool result;\n"
                "  a modelled quantity described as measured, or an annual figure "
                "described as measured when the year is reanalysis;\n"
                "  a number quoted from the wrong temporal tier, especially an "
                "annual total presented as an event-day figure;\n"
                "  an air-temperature-above-2-m claim stated without its "
                "uncertainty, which exceeds its own gradient above 50 m.\n\n"
                "Verify the numbers by re-running the query yourself where you can.\n\n"
                + NO_EMDASH
            ),
            tools=["Read", "Glob", "Grep",
                   "mcp__heatcanyon__area_summary",
                   "mcp__heatcanyon__data_dictionary",
                   "mcp__heatcanyon__query_buildings",
                   "mcp__heatcanyon__get_building",
                   "mcp__heatcanyon__year_series",
                   "mcp__heatcanyon__climatology",
                   # Read-only, and the reviewer's job is exactly what it is for:
                   # a draft quoting a payback from a table two-thirds of which
                   # nobody has verified is a draft with an unstated caveat in it.
                   "mcp__heatcanyon__economic_constants",
                   "mcp__heatcanyon__methodology"],
        ),
    }

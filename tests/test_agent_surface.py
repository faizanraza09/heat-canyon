"""The analyst's tool surface, tested against the real pipeline output.

WHAT THESE TESTS ARE FOR

Not the model's behaviour — that needs a credential and a live turn, and
``tests/08-analyst.spec.mjs`` covers it. These test the surface the model is given,
which is where the errors that matter live:

* a schema that makes every filter mandatory, which turned a three-argument query
  into a seventeen-argument one and silently changed what it asked;
* a rank reported from a selected sample and labelled as if it were from the
  population;
* an intervention that returns a plausible number for a spec it did not apply;
* a statistic that reports an uncorrected significance count.

Every one of those is invisible from outside and every one of them produces a
confident wrong answer.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

DATA = Path("web/data")
pytestmark = pytest.mark.skipif(
    not (DATA / "meta.json").exists() or not (DATA / "year.json").exists(),
    reason="no pipeline output; run `python -m heatcanyon.cli build` first",
)


@pytest.fixture(scope="module")
def d():
    from heatcanyon.agent import dataset
    return dataset.load()


# ------------------------------------------------------------------ schemas


def test_every_tool_has_a_json_schema_with_an_explicit_required_list():
    """A filter tool whose filters are mandatory is not a filter tool.

    ``tool(name, desc, {"limit": int})`` builds a schema in which EVERY key is
    required. Measured on the first live turn: ``query_buildings(limit=3,
    sort_by='annual_priority')`` came back as "'min_persistence_h' is a required
    property", and the model's next move was to pass a zero for all seventeen
    filters — which is a different query with the same name.
    """
    from heatcanyon.agent import tools

    for name, desc, schema, _handler in tools.TOOL_SPECS:
        assert schema.get("type") == "object", name
        assert isinstance(schema.get("required"), list), f"{name} has no required list"
        assert schema.get("additionalProperties") is False, name
        for key, spec in (schema.get("properties") or {}).items():
            assert spec.get("description"), f"{name}.{key} has no description"
        # Only the arguments a tool cannot work without may be required.
        assert set(schema["required"]) <= set(schema.get("properties") or {}), name
        assert len(schema["required"]) <= 2, f"{name} requires too much: {schema['required']}"
        assert len(desc) > 120, f"{name}'s description is too thin to choose from"


def test_tool_names_are_namespaced_for_the_allowlist():
    from heatcanyon.agent import tools
    allowed = tools.allowed_tool_names()
    assert len(allowed) == len(tools.TOOL_NAMES)
    assert all(a.startswith("mcp__heatcanyon__") for a in allowed)


def test_specialist_tool_grants_all_exist():
    """A grant naming a tool the server does not serve is a silent dead end."""
    from heatcanyon.agent import agents, options, tools

    served = set(tools.allowed_tool_names()) | set(options.BUILTIN_TOOLS)
    for name, spec in agents.specialists().items():
        assert spec["description"] and spec["prompt"]
        for t in spec["tools"]:
            assert t in served, f"{name} is granted {t}, which nothing serves"


def test_asynchronous_delegation_is_refused():
    """The tool that lost a turn, and everything shaped like it.

    Registering the specialists through ``ClaudeAgentOptions(agents=...)`` made
    them reachable only through ``Agent``, which is asynchronous: the analyst
    delegated two jobs, said both were running in the background, and ended its
    turn with nothing in it. There is no cross-turn notification a server-driven
    run can wait for.
    """
    from heatcanyon.agent import options, tools

    for name in ("Agent", "Task", "ScheduleWakeup", "Workflow", "Monitor",
                 "TaskOutput", "ListAgents"):
        assert name in options.DISALLOWED_TOOLS, name
    assert "consult_specialist" in tools.TOOL_NAMES
    spec = next(sc for n, _d, sc, _h in tools.TOOL_SPECS
                if n == "consult_specialist")
    assert set(spec["required"]) == {"specialist", "question"}
    desc = next(d for n, d, _s, _h in tools.TOOL_SPECS if n == "consult_specialist")
    # The description has to say it blocks, or the model will treat it as a
    # fire-and-forget launch exactly as it did before.
    assert "BLOCKS" in desc


def test_the_web_is_allowed_but_guarded_in_the_prompt():
    """The analyst may read the web; it may not source a FIGURE from it.

    This test used to assert the opposite, because for a long time the web was
    refused at the tool list. That was a defensible containment: the analyst's
    authority is that every number it states came out of this model, and an
    agent that can read the open web will eventually answer a question about
    Manhattan from a news article.

    The web is now allowed deliberately — a recommendation that ignores what is
    actually fundable is worth less than one that does not — and the guard moved
    from the tool list into the prompt. So what has to be checked moved with it:
    that the envelope reports the capability honestly rather than claiming a
    containment it no longer has, and that the persona still carries the rule
    that does the actual work. A prompt-level guard nobody asserts is a guard
    that will be edited away without anyone noticing.
    """
    from heatcanyon.agent import options, persona
    assert "WebSearch" in options.BUILTIN_TOOLS
    assert "WebFetch" in options.BUILTIN_TOOLS
    env = options.describe_envelope()
    assert env["web_access"] is True
    assert env["web_access_note"]

    prompt = persona.system_prompt() if callable(
        getattr(persona, "system_prompt", None)) else persona.PROMPT
    assert "WHEN YOU USE THE WEB" in prompt
    # The two halves of the rule: everything from the web is labelled, and it
    # may never supply a number this model can produce itself.
    assert "EXTERNAL" in prompt


# ----------------------------------------------------------------- queries


def test_area_summary_carries_both_the_event_and_the_year(d):
    from heatcanyon.agent import queries as Q
    s = Q.area_summary(d)
    assert s["event_day"]["date"] == "2026-07-02"
    assert s["event_day"]["kind"].startswith("measured")
    assert s["year"]["days"] == 365
    assert "reanalysis" in s["year"]["kind"]
    assert len(s["year"]["months"]) == 12
    # The provenance note has to name every kind, or a reader cannot tell them
    # apart in an answer that mixes them.
    for word in ("FortyGuard", "reanalysis", "Facade surface temperature"):
        assert word in s["provenance_note"]


def test_query_buildings_scopes_are_different_populations(d):
    from heatcanyon.agent import queries as Q
    ranked = Q.query_buildings(d, limit=5, sort_by="annual_priority", scope="ranked")
    scored = Q.query_buildings(d, limit=5, sort_by="annual_priority", scope="scored")
    assert ranked["scope"] == "ranked"
    assert scored["scope"] == "scored"
    assert scored["of_scored"] > ranked["of_ranked"]
    # The ranked set is selected by EVENT-DAY priority, so the annual leader of the
    # whole population need not be in it. If these agree the scopes are the same
    # thing under two names.
    assert scored["of_scored"] >= 4000
    assert ranked["ranked_set_note"].startswith("THIS IS A SELECTED SAMPLE")


def test_query_buildings_filters_are_optional_and_combine(d):
    from heatcanyon.agent import queries as Q
    base = Q.query_buildings(d, limit=60)
    tight = Q.query_buildings(d, limit=60, residential_only=True, min_hvi=4,
                              built_before=1945)
    assert tight["matched"] <= base["matched"]
    for b in tight["buildings"]:
        assert (b["residential_units"] or 0) > 0
        assert (b["hvi"] or 0) >= 4
        assert b["year_built"] < 1945


def test_query_buildings_reports_ignored_filters_in_the_scored_scope(d):
    """Silently dropping a filter is worse than refusing it."""
    from heatcanyon.agent import queries as Q
    got = Q.query_buildings(d, limit=5, scope="scored", min_persistence_h=3.0)
    assert "min_persistence_h" in got["ignored_filters"]
    assert "IGNORED" in got["note"]


def test_get_building_labels_which_population_a_rank_is_from(d):
    """Two ranks that differ by sixty places must not share a name.

    Measured on the first live turn: the analyst computed an annual rank of 98
    over all 4,044 scored buildings while the dossier said 39, because the dossier
    ranked within the 150. It noticed; it should not have had to.
    """
    from heatcanyon.agent import queries as Q
    b = Q.query_buildings(d, limit=1)["buildings"][0]
    got = Q.get_building(d, str(b["bin"]))
    assert got["in_ranked_set"] is True
    assert got["scored_population"] >= 4000
    assert got["rank_annual_of_scored"] is not None
    assert got["rank_annual_within_ranked_150"] is not None
    assert "_of_scored" in got["rank_note"]
    assert got["facade_orientations"]
    # Orientation breakdown must be ordered by load and cover real wall length.
    loads = [o["annual_degree_hours_35_mean"] for o in got["facade_orientations"]]
    assert loads == sorted(loads, reverse=True)
    assert sum(o["wall_length_m"] for o in got["facade_orientations"]) > 20


def test_get_building_by_address_and_by_nonsense(d):
    from heatcanyon.agent import queries as Q
    b = Q.query_buildings(d, limit=1)["buildings"][0]
    if b["address"]:
        assert Q.get_building(d, b["address"])["bin"] == b["bin"]
    assert "error" in Q.get_building(d, "not a building at all")


def test_year_series_returns_the_series_not_a_summary(d):
    from heatcanyon.agent import queries as Q
    daily = Q.year_series(d, "tmax", "daily")
    assert daily["n"] == 365
    assert len(daily["values"]) == 365
    assert daily["stats"]["max"] >= 35.0
    monthly = Q.year_series(d, "tmean", "monthly")
    assert len(monthly["months"]) == 12
    hourly = Q.year_series(d, "t_air_c", "hourly", month=7)
    assert hourly["n"] > 700
    bad = Q.year_series(d, "not_a_metric", "daily")
    assert "error" in bad and bad["available"]


def test_climatology_finds_the_study_day_near_the_top_of_its_own_year(d):
    from heatcanyon.agent import queries as Q
    c = Q.climatology(d)
    assert c["event_day_in_year"]["rank_by_tmax"] <= 5
    assert len(c["hottest_days"]) == 15
    assert len(c["months"]) == 12
    assert c["episodes"]


def test_compare_periods_reports_the_lit_fraction_as_well(d):
    """Most of a monthly difference is solar geometry, not weather."""
    from heatcanyon.agent import queries as Q
    got = Q.compare_periods(d, "month_07", "month_01", hour_slot=4)
    row = got["hours"][0]
    assert row["a"]["lit_fraction"] > row["b"]["lit_fraction"]
    assert row["surface_difference_k"]["mean"] < -10
    assert "lit_fraction" in got["reading_note"]


def test_panel_field_groups_by_aspect_and_orders_physically(d):
    from heatcanyon.agent import queries as Q
    got = Q.panel_field(d, "sun_hours", "aspect")
    by = {g["group"]: g["mean"] for g in got["groups"]}
    assert by["south"] > by["north"] * 1.5
    for how in ("band", "material", "height_band", "canyon_depth", "street"):
        rows = Q.panel_field(d, "degree_hours_35", how)["groups"]
        assert rows, how


def test_tile_field_labels_the_composite(d):
    from heatcanyon.agent import queries as Q
    measured = Q.tile_field(d, "exceedance")
    assert measured["kind"].startswith("measured")
    annual = Q.tile_field(d, "hours_above_35")
    assert "composite" in annual["kind"]
    assert annual["hottest"][0]["value"] >= annual["coolest"][-1]["value"]


def test_methodology_covers_every_topic_it_advertises(d):
    from heatcanyon.agent import queries as Q
    topics = Q.methodology(d)["available_topics"]
    for t in topics:
        got = Q.methodology(d, t)
        assert got["topic"] == t
        assert len(got["explanation"]) > 200
    for needed in ("year", "bias_correction", "shading", "convection", "tile_transfer"):
        assert needed in topics


def test_data_dictionary_tells_the_agent_how_to_reach_the_arrays(d):
    from heatcanyon.agent import queries as Q
    dd = Q.data_dictionary(d)
    assert dd["layout"]["counts"]["facade_panels"] > 20000
    assert len(dd["layout"]["periods"]) == 13
    assert "import heatcanyon.agent.dataset" in dd["layout"]["python"]["import"]
    assert "winter_sun_share" in dd["annual_planes"]


# ---------------------------------------------------------------- analysis


def test_moran_reports_its_weights_and_its_permutation_test(d):
    from heatcanyon.agent import analysis as AN
    got = AN.moran(d, "annual_priority", scope="scored", permutations=99)
    assert got["permutations"] == 99
    assert "distance band" in got["weights"]["definition"]
    assert "islands" in got["weights"]
    assert 0 < got["p_value"] <= 1
    assert got["interpretation"]
    # Exposure in a dense grid is clustered. If this comes out negative the
    # weights or the geography are wrong.
    assert got["I"] > 0


def test_hotspots_reports_both_the_corrected_and_uncorrected_counts(d):
    """Testing four thousand locations at p<0.05 finds two hundred in noise."""
    from heatcanyon.agent import analysis as AN
    got = AN.hotspots(d, "annual_priority", scope="scored", top=5)
    assert got["uncorrected_at_p05"] >= got["significant_locations"]
    assert "Benjamini-Hochberg" in got["note"]
    assert got["statistic"].startswith("Getis-Ord")
    if got["hot_clusters"]:
        assert got["hot_clusters"][0]["gi_star"] > 0
        assert got["hot_clusters"][0]["significant_after_fdr"] is True


def test_regress_returns_vifs_robust_errors_and_the_residuals(d):
    from heatcanyon.agent import analysis as AN
    got = AN.regress(d, "annual_kh35",
                     ["annual_sun_hours", "svf", "height_m", "year_built"])
    assert got["standard_errors"].startswith("HC1")
    assert 0 <= got["r_squared"] <= 1
    terms = {c["term"]: c for c in got["coefficients"]}
    assert terms["annual_sun_hours"]["vif"] is not None
    # More annual sun must associate with more annual dose. A negative sign here
    # means the planes have been transposed somewhere.
    assert terms["annual_sun_hours"]["estimate"] > 0
    assert len(got["extreme_residuals"]) == 10
    assert any("spatial autocorrelation" in c for c in got["cautions"])


def test_cluster_and_correlate_carry_their_cautions(d):
    from heatcanyon.agent import analysis as AN
    cl = AN.cluster(d, ["annual_sun_hours", "svf", "height_m"], k=4)
    assert sum(c["n"] for c in cl["clusters"]) == cl["n"]
    assert "no cluster structure" in cl["caution"]
    co = AN.correlate(d, ["annual_kh35", "annual_sun_hours", "svf", "hvi"])
    assert co["pairs_by_strength"]
    assert abs(co["pairs_by_strength"][0]["r"]) >= abs(co["pairs_by_strength"][-1]["r"])


def test_allocate_says_its_effect_size_is_an_assumption(d):
    from heatcanyon.agent import analysis as AN
    people = AN.allocate(d, budget=10, objective="person_hours")
    dose = AN.allocate(d, budget=10, objective="degree_hours")
    assert len(people["allocation"]) == 10
    assert "assumption you supplied" in people["caution"]
    # The equity story: optimising for residents and for dose pick different
    # buildings. If they agreed the objective would be doing nothing.
    a = [x["bin"] for x in people["allocation"]]
    b = [x["bin"] for x in dose["allocation"]]
    assert a != b
    # And a constraint has to bite.
    tight = AN.allocate(d, budget=10, constraint={"residential_only": True,
                                                 "min_hvi": 4})
    assert tight["eligible_candidates"] <= people["eligible_candidates"]


def test_variable_table_labels_every_variable_by_kind(d):
    from heatcanyon.agent import analysis as AN
    table = AN.variable_table(d)
    kinds = {k: v[0] for k, v in table.items()}
    assert kinds["exceedance_h"] == "measured"
    assert kinds["facade_peak_c"] == "modelled"
    assert "annual" in kinds["annual_kh35"]


# ----------------------------------------------------------- interventions


def test_spec_resolution_refuses_nonsense_and_bounds_the_levers():
    from heatcanyon.agent import interventions as IV
    assert IV.resolve_spec("street_trees") == {"tree_cover": 0.45}
    assert IV.resolve_spec(["cool_roof", "cool_pavement"]) == {
        "roof_albedo": 0.70, "ground_albedo": 0.40}
    with pytest.raises(IV.SpecError):
        IV.resolve_spec({"tree_cover": 3.0})          # outside the physical range
    with pytest.raises(IV.SpecError):
        IV.resolve_spec({"magic_paint": 1.0})
    with pytest.raises(IV.SpecError):
        IV.resolve_spec("unicorn_canopy")


def test_selection_by_street_and_by_filter(d):
    from heatcanyon.agent import interventions as IV
    sel = IV.select(d, streets=["MADISON AVE"])
    assert sel.canyon_sections if hasattr(sel, "canyon_sections") else True
    assert len(sel.canyons) > 5
    assert len(sel.panels) > 50
    assert sel.wall_area_m2 > 1000
    with pytest.raises(IV.SpecError):
        IV.select(d, streets=["NOT A STREET IN MANHATTAN"])
    with pytest.raises(IV.SpecError):
        IV.select(d)                                   # empty selection


def test_trees_help_a_shallow_canyon_more_than_a_deep_one(d):
    """The finding that makes this a planning instrument rather than a table.

    A canyon whose floor is already shaded gains almost nothing from canopy, and
    the only way to know that is to solve that canyon. If this assertion ever
    fails the interventions have stopped re-solving and started interpolating.
    """
    from heatcanyon.agent import interventions as IV
    got = IV.run(d, spec="street_trees", period="month_07", window="peak",
                 whole_aoi=True, max_canyons=24)
    rows = got["per_canyon"]
    assert len(rows) >= 12
    deep = [r for r in rows if r["aspect_ratio_hw"] > 2.0]
    shallow = [r for r in rows if r["aspect_ratio_hw"] < 1.0]
    assert deep and shallow
    mean_deep = float(np.mean([r["d_mrt_mean_k"] for r in deep]))
    mean_shallow = float(np.mean([r["d_mrt_mean_k"] for r in shallow]))
    # Both cool; the shallow street cools more.
    assert mean_shallow < 0
    assert mean_shallow < mean_deep
    assert got["overall"]["mrt"]["best"] < got["overall"]["mrt"]["worst"]


def test_shading_costs_something_in_winter(d):
    """The number a year makes possible and a single day cannot produce."""
    from heatcanyon.agent import interventions as IV
    got = IV.run(d, spec="deep_shading", period="seasons", window="peak",
                 streets=["MADISON AVE"], max_canyons=8)
    s = got["seasonal"]
    assert s["summer_d_mrt_k"] is not None and s["winter_d_mrt_k"] is not None
    # Shading removes July's beam and January's with it, so it does less good in
    # winter: the penalty is positive and that is the correct sign.
    assert s["seasonal_penalty_k"] > 0
    assert "cost of the measure" in s["reading"]


def test_cool_pavement_can_raise_what_a_body_feels(d):
    """A documented trade-off the model has to be able to reproduce."""
    from heatcanyon.agent import interventions as IV
    got = IV.run(d, spec="cool_pavement", period="month_07", window="peak",
                 whole_aoi=True, max_canyons=24)
    ground = got["overall"]["ground"]["mean"]
    mrt_worst = got["overall"]["mrt"]["worst"]
    assert ground < -1.0                     # the road gets cooler, reliably
    assert mrt_worst > 0                     # and somewhere a pedestrian gets hotter
    assert got["overall"]["mrt"]["made_worse_fraction"] > 0


def test_composing_levers_is_not_adding_them(d):
    """Trees shade the pavement a cool coating was meant to fix.

    Asserted PER CANYON rather than on the mean, and that distinction was learned
    here. Averaged over Madison Avenue the combination came within 0.008 K of the
    sum of the parts, which looks like a broken test and is in fact a correct
    result: in a canyon whose floor is already shaded, canopy and pavement albedo
    act on nearly disjoint terms, so their effects really are additive there.
    The interaction lives where the floor is sunlit, and a mean over a mixed
    population hides it. So the claim is that the combination differs from the sum
    SOMEWHERE, which is what non-additivity means.
    """
    from heatcanyon.agent import interventions as IV
    kw = dict(period="month_07", window="peak", whole_aoi=True, max_canyons=20)
    trees = {r["canyon"]: r["d_mrt_mean_k"]
             for r in IV.run(d, spec="street_trees", **kw)["per_canyon"]}
    pave = {r["canyon"]: r["d_mrt_mean_k"]
            for r in IV.run(d, spec="cool_pavement", **kw)["per_canyon"]}
    both = {r["canyon"]: r["d_mrt_mean_k"]
            for r in IV.run(d, spec=["street_trees", "cool_pavement"], **kw)["per_canyon"]}
    shared = set(trees) & set(pave) & set(both)
    assert len(shared) >= 10
    gaps = {c: abs(both[c] - (trees[c] + pave[c])) for c in shared}
    worst = max(gaps.values())
    assert worst > 0.1, (
        f"the combination equals the sum at every one of {len(shared)} canyons "
        f"(worst gap {worst:.3f} K), so it is not being re-solved")


def test_run_carries_its_limitations_and_its_exposure_effect(d):
    from heatcanyon.agent import interventions as IV
    got = IV.run(d, spec="cool_walls", period="event", window="peak",
                 filters={"residential_only": True}, max_canyons=8)
    assert any("advective" in x for x in got["limitations"])
    assert got["exposure_effect"]["residential_units_behind_treated_wall"] >= 0
    assert "arithmetic, not physics" in got["exposure_effect"]["method"]
    assert got["selection"]["facade_panels"] > 0


def test_catalogue_documents_every_lever_with_its_tradeoff():
    from heatcanyon.agent import interventions as IV
    cat = IV.catalogue()
    for name, spec in cat["levers"].items():
        assert spec["meaning"] and spec["note"]
        lo, hi = spec["range"]
        assert lo < hi
    assert "less than the sum" in cat["composition_note"]
    for preset in cat["presets"].values():
        for lever in preset:
            assert lever in cat["levers"]


# -------------------------------------------------------------- the dataset


def test_the_day_reconstruction_uses_a_measured_coefficient(d):
    got = d.sensitivity
    assert got.shape == (d.n_panel, d.n_band)
    # A facade tracks the air almost one for one once the radiation term is fixed.
    assert 0.9 < float(got.mean()) < 1.15


def test_surface_on_any_day_differs_from_its_month(d):
    rep = next(m for m in d.year["periods"]["months"] if m["month"] == 7)["date"]
    month = d.period("month_07").surface[4]
    hot = max((x for x in d.days if x["month"] == 7), key=lambda x: x["tmax"])["date"]
    recon = d.surface_on(hot, 4)
    assert recon.shape == month.shape
    if hot != rep:
        assert abs(float(recon.mean() - month.mean())) > 0.2


def test_period_resolution_accepts_the_names_a_person_would_use(d):
    assert d.resolve_period("event") == "event"
    assert d.resolve_period("july") == "month_07"
    assert d.resolve_period("Jul") == "month_07"
    assert d.resolve_period(7) == "month_07"
    assert d.resolve_period("2026-01-15") == "month_01"
    assert d.resolve_period("2026-07-02") == "event"
    with pytest.raises(ValueError):
        d.resolve_period("nonsense")


def test_no_annual_plane_is_clipped(d):
    """A quantisation that cannot represent its input saturates at a plausible number."""
    spec = d.meta["year"]["annual_fields"]["planes"]
    for name, ps in spec.items():
        arr = d.plane(name)
        ceiling = (65535 if ps.get("dtype") == "uint16" else 32767) / ps["scale"]
        at = float((arr >= ceiling - 1e-9).mean())
        assert at < 1e-5, f"{name} has {at:.2%} of cells at its representable ceiling"


# ------------------------------------------------------- the decision layer
#
# The four tools that put a floor, a measure and a price on a solved wall. What
# is tested here is the same class of thing as everything above: not that the
# arithmetic is right — heatcanyon/loads, prescribe, economics and portfolio own
# that — but that the SURFACE the model is handed cannot quietly mislead it.
#
# Two of these assert prompt text rather than code, which looks like testing a
# string and is not. The layer's one non-negotiable property, that a range is
# never reported as its midpoint, is not enforceable by any schema: the tool
# returns [lo, hi] and the model writes the sentence. The only thing standing
# between "4.1 to 6.8 kW" and a confident "about 5.5 kW" is a rule in the system
# prompt, and a prompt-level guard nobody asserts is a guard that gets edited
# away in a tidying pass without anyone noticing. Same precedent as
# ``test_the_web_is_allowed_but_guarded_in_the_prompt``.


DECISION_TOOLS = ("building_schedule", "prescribe_building",
                  "programme_allocation", "economic_constants")


def _spec(name):
    from heatcanyon.agent import tools
    return next(s for n, _d, s, _h in tools.TOOL_SPECS if n == name)


def _desc(name):
    from heatcanyon.agent import tools
    return next(d for n, d, _s, _h in tools.TOOL_SPECS if n == name)


def _call(handler, args):
    """Drive one async tool handler to completion and parse its result."""
    import asyncio

    got = asyncio.run(handler(args))
    text = got["content"][0]["text"]
    if got.get("is_error"):
        return {"error": text}
    return json.loads(text)


def test_the_decision_tools_are_registered_and_ask_for_the_right_things():
    from heatcanyon.agent import tools

    for name in DECISION_TOOLS:
        assert name in tools.TOOL_NAMES, f"{name} is not registered"
        assert len(_desc(name)) > 300, f"{name}'s description is too thin"
    # A schedule and a prescription are about ONE building and cannot be produced
    # without knowing which. The programme and the money table are about the
    # whole study area and must not require anything.
    assert _spec("building_schedule")["required"] == ["bin_or_address"]
    assert _spec("prescribe_building")["required"] == ["bin_or_address"]
    assert _spec("programme_allocation")["required"] == []
    assert _spec("economic_constants")["required"] == []
    # No existing tool may have been renamed or re-scoped to make room.
    for name in ("get_building", "run_intervention", "allocate_budget"):
        assert name in tools.TOOL_NAMES


def test_the_decision_tool_descriptions_carry_their_own_warnings():
    """Each of the four has one thing the model must know before it calls it."""
    assert "ASSUMED" in _desc("building_schedule")
    # A re-solve is seconds, and an agent that does not expect that reports a
    # working engine as a hang.
    assert "SECONDS" in _desc("prescribe_building")
    assert "ATTRIBUTION" in _desc("prescribe_building")
    assert "objective" in _desc("programme_allocation")
    assert "UNVERIFIED" in _desc("economic_constants")


def test_the_persona_carries_the_decision_layers_guards():
    """The rules no schema can enforce, asserted where they actually live."""
    from heatcanyon.agent import persona

    prompt = persona.system_prompt()
    assert "THE DECISION LAYER" in prompt
    # The fifth provenance class. Softer than measured, reanalysis, modelled and
    # composite, and the one a dollar figure always carries.
    assert "ASSUMED" in prompt
    assert "currency symbol" in prompt
    # The one non-negotiable property of the layer.
    assert "MIDPOINT" in prompt
    assert "A RANGE IS NEVER REPORTED AS A MIDPOINT" in prompt
    # The attribution selects the measure, not the temperature; and the specific
    # error that follows from forgetting it.
    assert "ATTRIBUTION SELECTS THE MEASURE" in prompt
    assert "trap-dominant" in prompt
    # It does not author measures, exactly as rule 6 already says of get_building.
    assert "You do not author measures" in prompt
    for name in DECISION_TOOLS:
        assert name in prompt, f"{name} is not named in the prompt"


def test_building_schedule_returns_a_floor_resolved_schedule_with_ranges(d):
    """Every assumed figure arrives as a pair, and the pair survives the tool.

    The serialiser is the place a range would be lost silently: a generic encoder
    that helpfully averaged a (lo, hi) tuple would defeat the layer's one rule in
    a spot nobody would look. So the shape is asserted here, at the surface the
    model reads.
    """
    from heatcanyon.agent import tools

    got = _call(tools._building_schedule, {"bin_or_address": "1017105"})
    assert "error" not in got, got
    assert got["bin"] == "1017105"
    assert got["storeys"] >= 1
    assert got["floors"], "no floors in the schedule"
    for key in ("peak_kw", "annual_mwh"):
        lo, hi = got[key]
        assert lo <= hi, key
    f = got["floors"][0]
    for key in ("peak_w", "annual_kwh", "t_indoor_free_c"):
        lo, hi = f[key]
        assert lo <= hi, key
    assert f["dominant"] in ("solar", "trap", "ambient")
    assert f["night_recovery"] in ("good", "limited", "none")
    assert isinstance(f["band"], int) and 0 <= f["band"] <= 9
    # The basis and the how-to-read carry the labelling the interface would
    # otherwise have to invent.
    assert "assumed" in (got["basis"] or "").lower()
    assert "ESTIMATE" in got["how_to_read"]
    assert "midpoint" in got["how_to_read"].lower()
    # Whether the build carries the surface-term attribution is reported rather
    # than implied by three zeroes, which read exactly like a wall at air
    # temperature.
    assert isinstance(got["attribution"]["available"], bool)
    # A narrow floor range is honoured, and the worst floor keeps its faces.
    narrow = _call(tools._building_schedule,
                   {"bin_or_address": "1017105", "floor_from": 1, "floor_to": 3})
    assert [x["floor"] for x in narrow["floors"]] == [1, 2, 3]
    assert _call(tools._building_schedule,
                 {"bin_or_address": "no such building"}).get("error")


def test_prescribe_building_returns_measures_it_does_not_invent(d):
    from heatcanyon.agent import tools

    got = _call(tools._prescribe_building, {"bin_or_address": "1017105"})
    assert "error" not in got, got
    assert got["bin"] == "1017105"
    keys = got["available_measures"]
    assert keys, "nothing triggered at all, which is itself a finding to check"
    assert [p["key"] for p in got["prescriptions"]] == keys
    for p in got["prescriptions"]:
        assert p["title"] and p["family"] and p["device"]
        assert len(p["floors"]) == 2 and p["floors"][0] <= p["floors"][1]
        assert p["why"], f"{p['key']} has no rationale"
        # A measure with no effect figure says why rather than quoting a
        # coefficient the model did not compute.
        assert p.get("effect") is not None or p.get("effect_note")
        assert p["confidence"] in ("modelled", "assumed")
    # The filter is applied here, not passed down, so it has to actually bite.
    #
    # It selects a MEASURE FAMILY, not a single prescription, and one building
    # legitimately gets several of the same family: operable shading on the west
    # face over floors 4-11 and on the north face over floors 20-26 are two
    # different work orders with two different areas and two different prices.
    # An earlier version of this asserted exactly one row came back and failed
    # against a building with eight of them, which would have been read as a
    # broken filter rather than as a building with eight faces.
    one = _call(tools._prescribe_building,
                {"bin_or_address": "1017105", "measures": [keys[0]]})
    filtered = [p["key"] for p in one["prescriptions"]]
    assert filtered, "the filter returned nothing for a key that was in the full list"
    assert set(filtered) == {keys[0]}
    assert len(filtered) == keys.count(keys[0])
    assert "do not author" in got["how_to_read"] or "not author" in got["how_to_read"]
    assert "economic_constants" in got["how_to_read"]


def test_economic_constants_says_how_much_of_the_table_is_unverified(d):
    """The tool exists to stop a dollar figure being quoted as if it were sourced."""
    from heatcanyon.agent import tools
    from heatcanyon import economics as EC

    got = _call(tools._economic_constants, {})
    assert got["in_table"] == len(EC.constants_table())
    assert got["unverified"] == sum(1 for r in EC.constants_table()
                                    if not r["verified"])
    # The premise of the tool's own description: most of it is not yet checked.
    assert got["unverified"] > got["verified"]
    assert got["table_as_of"] == EC.as_of()
    for row in got["constants"]:
        assert row["source"] and row["as_of"]
        assert isinstance(row["verified"], bool)
    only = _call(tools._economic_constants, {"unverified_only": True})
    assert all(not r["verified"] for r in only["constants"])
    ll97 = _call(tools._economic_constants, {"key_contains": "ll97"})
    assert ll97["shown"] and all("ll97" in r["key"] for r in ll97["constants"])


def test_the_decision_tools_report_a_missing_layer_rather_than_raising(monkeypatch):
    """A build without the decision layer must still start the analyst.

    The contract's closing rule: the layer adds, and its absence degrades one
    pane rather than the application. So the import is inside the handler and its
    failure comes back as a tool error naming the contract, which is something
    the model can route around, rather than as a traceback at connect time.
    """
    from heatcanyon.agent import tools

    def missing():
        raise ImportError("No module named 'heatcanyon.decide'")

    monkeypatch.setattr(tools, "_decide", missing)
    for handler in (tools._building_schedule, tools._prescribe_building,
                    tools._programme_allocation):
        got = _call(handler, {"bin_or_address": "1017105"})
        assert "docs/DECISIONS.md" in got["error"]


# ----------------------------------------------------- the film's recorded run


def test_the_run_the_film_replays_is_the_one_that_ships():
    """`ANALYST_RUN` in story.js must name a run that is tracked in git.

    Chapter five replays a real turn from `.agent/runs/<id>/frames.jsonl` rather
    than asking live on camera. `.agent/` is ignored, so that one run is
    re-included by four lines in .gitignore and named again in .dockerignore,
    .gcloudignore and deploy_hf.py's INCLUDE list. Five places, no link between
    them, and the id is a hex string nobody reads.

    They drifted. The turn was re-recorded against a better question, story.js
    was pointed at the new id, and the five ignore/include entries were left on
    the old one. On a laptop that is invisible: every run this machine ever made
    is still in .agent/runs/ and the server replays it happily. Deployed, the
    container holds only what those entries name, so the film asked for a run
    that had never shipped, got a 404, and chapter five played to an empty
    console.

    This is the check that was missing, and it is a filesystem check on purpose:
    "tracked in git" is exactly the property that the deploys inherit.
    """
    import re
    import subprocess

    story = Path("web/js/story.js").read_text()
    m = re.search(r"ANALYST_RUN\s*=\s*'([^']+)'", story)
    assert m, "story.js no longer declares ANALYST_RUN in a form this can read"
    run_id = m.group(1)

    tracked = subprocess.run(
        ["git", "ls-files", f".agent/runs/{run_id}/"],
        capture_output=True, text=True, check=True).stdout.split()
    assert tracked, (
        f"story.js replays {run_id}, which is not tracked in git. Deployed, the "
        f"console will 404 and chapter five will play empty. Re-point the four "
        f"lines in .gitignore, the entries in .dockerignore and .gcloudignore, "
        f"and INCLUDE in scripts/deploy_hf.py, then `git add -f` the run."
    )
    # The replay reads exactly these two; the workspace of scratch scripts the
    # turn wrote is deliberately not shipped.
    assert f".agent/runs/{run_id}/frames.jsonl" in tracked
    assert f".agent/runs/{run_id}/status.json" in tracked

    # And the question printed above the transcript has to be the question that
    # turn was actually asked, or the film shows an answer to something else.
    status = json.loads(Path(f".agent/runs/{run_id}/status.json").read_text())
    q = re.search(r"ANALYST_QUESTION\s*=\s*'([^']*)'\s*\+?\s*'?([^']*)'?", story)
    assert q, "story.js no longer declares ANALYST_QUESTION in a form this can read"
    asked = (q.group(1) + q.group(2)).strip()
    assert asked and asked in status["question"], (
        f"story.js prints a different question from the one {run_id} was asked"
    )

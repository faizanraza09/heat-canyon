"""The Urban Canyon analyst — Claude Code as a library, over the computed model.

WHAT CHANGED, AND WHY IT IS NOT COSMETIC

The previous analyst was a hand-written tool-use loop against the Messages API
with six read-only queries. It was carefully built and it did one thing well:
it could not invent a number, because it had none in its context and every
figure had to come back from a query. That property is kept.

What it could not do is *work*. It could report the ranking; it could not test an
intervention. It could describe a canyon; it could not find the spatial pattern
across four thousand of them. It could quote a monthly mean; it could not write
the script that regressed exposure on morphology, look at the residuals, and
notice that the outliers are all on avenues running north-east. Every one of
those is a task, not a lookup, and a single-shot question-answer loop over fixed
queries has no way to express a task.

So the analyst is now an agent, built on the Claude Agent SDK — the same harness
Claude Code itself runs on. It has files, a shell, and a workspace of its own; it
has this project's physics engine importable; and it has a set of in-process
tools that reach the parts of the model a shell cannot: the solved fields, the
year, a real intervention re-solve, and the visualisation the person asking is
looking at.

THE FIVE THINGS THAT MAKE IT AN ANALYST RATHER THAN A CHATBOT

1. It cannot invent a figure. Nothing is preloaded into its context. Every number
   in an answer came back from a tool call or a script it ran, and the transcript
   shows which.

2. It re-solves the physics. ``run_intervention`` changes an albedo, a tree
   canopy or a shading device and solves the surface energy balance again, for
   the hour, the month, the season or the whole year. It does not multiply a
   published coefficient. That is why it can say trees on Madison Avenue buy
   almost nothing and trees on West 47th Street buy a great deal.

3. It does statistics properly. ``spatial_pattern`` runs Moran's I with a
   permutation test, Getis-Ord Gi* with a false-discovery correction, and OLS with
   robust standard errors and the residuals returned — not a correlation
   coefficient with an anecdote attached.

4. It drives the map. ``map_control`` sets the layer, the day, the hour and the
   camera, and highlights the buildings it is talking about. The person asking
   watches the answer happen on the city rather than reading about it.

5. It says which tier a number came from. Event day, month, or annual
   accumulation; measured, reanalysis, or modelled. The system prompt makes this
   non-optional and the tools return the provenance beside every value so it
   cannot be lost.

MODULE MAP

  knobs         configuration, one place, all of it from the environment
  dataset       every pipeline output, loaded once, indexed
  queries       the structured read surface over that data
  analysis      spatial statistics and optimisation, in numpy
  interventions arbitrary what-ifs, re-solved
  persona       the system prompt
  tools         the in-process MCP server the agent calls
  agents        the specialists it consults, and why they are not SDK subagents
  hooks         containment, and the frames a blocked call produces
  events        SDK messages -> the frames the browser renders
  session       background runs, durable transcripts, replay-then-tail streaming
"""

__all__ = ["knobs", "dataset", "queries", "analysis", "interventions",
           "persona", "tools", "agents", "hooks", "events", "session"]

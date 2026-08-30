# The analyst

*How HeatCanyon's AI went from a tool-use loop to an agent that does work, what
it can reach, and the five things that stop it being a chatbot with a database.*

---

## What was there before, and why it was not enough

The previous analyst was a hand-written tool-use loop against the Messages API
with six read-only queries. It was carefully built and it did one thing very
well: **it could not invent a number.** It had none in its context, and every
figure had to come back from a query against the pipeline's own output.

That property is kept. What it could not do is *work*.

- It could report the ranking. It could not test an intervention.
- It could describe a canyon. It could not find the spatial pattern across four
  thousand of them.
- It could quote a monthly mean. It could not write the script that regressed
  exposure on morphology, look at the residuals, and notice that the outliers
  all sit on avenues running north-east.

Every one of those is a **task**, not a lookup, and a single-shot
question-answer loop over a fixed query set has no way to express a task.

So the analyst is now an agent, built on the **Claude Agent SDK** — the same
harness Claude Code itself runs on. It has files, a shell, and a workspace of its
own; it has this project's physics engine importable; and it has twenty
in-process tools that reach the parts of the model a shell cannot.

---

## The five things that make it an analyst

### 1. It cannot invent a figure

Nothing is preloaded into its context. Every number in an answer came back from a
tool call or a script it ran, and the transcript shows which. The system prompt
makes this non-optional and the tools return structured records rather than
prose, so there is nothing to paraphrase creatively.

### 2. It re-solves the physics

`run_intervention` changes an albedo, a canopy fraction, a shading factor or a
wall admittance and **solves the surface energy balance again** — for the hour,
the month, the season or the whole year, at the canyons you selected. It does not
multiply a published coefficient.

That is why it can say trees on Madison Avenue buy almost nothing and trees on
West 47th Street buy a great deal: the deep canyon's floor was already shaded and
the shallow one's was not, and only re-solving that canyon can know it.

Selection is by street name, building BIN, a radius around a point, any
`query_buildings` filter, or the whole AOI. The levers compose, and composing
them is **not** the same as adding their separate effects — trees shade the
pavement a cool coating was meant to fix, so the combination delivers less than
the sum. The tool solves the combination.

### 3. It does statistics properly

`spatial_pattern` is not a correlation coefficient with an anecdote attached.

- **`moran`** — global Moran's I with a 999-permutation test, because the
  analytic variance of I assumes a normally distributed variable and almost
  nothing here is one. Reports the weights definition and the island count,
  since an I over a set that is a third islands is not describing what a reader
  thinks.
- **`hotspots`** — Getis-Ord Gi\*, which locates clusters and separates hot from
  cold, with a **Benjamini-Hochberg** correction. Not optional: testing four
  thousand locations at *p* < 0.05 finds about two hundred "significant"
  clusters in pure noise, which is roughly what an uncorrected Gi\* map of
  anything shows. Both counts are returned.
- **`regress`** — OLS with HC1 heteroskedasticity-consistent standard errors, and
  **the extreme residuals returned by name**. Those are the useful output: the
  buildings the morphology fails to explain are where the finding lives.
- **`cluster`** — k-means on standardised variables, best of ten k-means++
  starts, with the caution that k-means always returns *k* clusters including
  when the data has none.
- **`correlate`** — Spearman by default, as a screen, with its own caution
  printed.

`scope` matters and the tools say so. `ranked` is the 150 buildings with full
dossiers — but they were *selected by event-day priority*, so a spatial statistic
over them partly measures the selection. `scored` is all 4,044 and is the honest
scope for anything spatial.

### 4. It drives the map

`map_control` sets the layer, the period, the date, the hour, the aggregate and
the camera, highlights the buildings it is naming, and drops a caption. The
person asking **watches the answer happen on the city** rather than reading about
it.

There is no second channel. A map action is a transcript frame like any other, in
order, beside the sentence that produced it — which also means a console that
reconnects mid-run replays the actions in the order they were issued and ends up
in the right state.

### 5. It says which tier a number came from

Event day, month, or annual accumulation. Measured, reanalysis, modelled, or
composite. The system prompt makes the label part of the sentence carrying the
figure, and the tools return the provenance *inside* the result — a payload
saying `{"value": 38.7, "kind": "measured", "source": "FortyGuard /v1/heatmap"}`
cannot lose its provenance on the way into prose.

---

## Architecture

```
heatcanyon/agent/
  knobs.py          every configurable thing, all from the environment
  dataset.py        every pipeline output, loaded once, indexed
  queries.py        the structured read surface
  analysis.py       spatial statistics and optimisation, in NumPy
  interventions.py  arbitrary what-ifs, re-solved
  persona.py        the system prompt
  agents.py         the three specialists
  tools.py          the in-process MCP server
  hooks.py          containment
  events.py         SDK messages -> console frames
  options.py        ClaudeAgentOptions: the one place spend and auth live
  session.py        background runs, durable transcripts, replay-then-tail SSE
```

### Why the tools run in-process

They are registered with `create_sdk_mcp_server`, so they execute inside the
FastAPI process. That is what lets them hold 120 MB of solved facade field and a
warm dataset index while the agent's own sandbox holds none of it. The agent
asks; we execute.

`build_server` binds each handler to its run **inside the call**, via a
`ContextVar` set per invocation rather than once per server. Two consoles asking
questions at once is the ordinary case here, and a map action landing in the
wrong browser is exactly the bug that shape avoids.

### Why the registry is short

A tool's schema is in every request for the whole conversation. A documented
dataset the agent can import costs nothing until it is used. So a tool earns its
place only if it wraps an engine of *ours* or enforces a shape of *ours*.
Anything the agent can do with NumPy and a documented array is left to NumPy and
a documented array, and `data_dictionary` — which returns the on-disk layout,
the units, and the exact import lines — is what makes that viable.

### The twenty tools

| | |
|---|---|
| `area_summary` | the study area, the event, the year, and which tier answers what |
| `data_dictionary` | everything that exists, where, in what units, and how to reach it from a script |
| `methodology` | how a part of the model works and how confident to be in it, with figures |
| `query_buildings` | filter and sort, on either ordering, over either scope |
| `get_building` | one building's full dossier, both ranks, facade by aspect, worst panel |
| `canyon_stats` | morphology per street, with the annual load of its walls |
| `year_series` | any quantity as a function of time: daily, monthly, or 8,760 hourly |
| `climatology` | monthly and seasonal aggregates, extremes, heat-wave episodes |
| `compare_periods` | two solved periods panel by panel, with the lit fractions |
| `panel_field` | a facade field grouped by aspect, band, material, street, depth… |
| `tile_field` | the 60 m field: measured layers or annual composites |
| `scenario_results` | the precomputed what-if grid, with its seasonal roll-up |
| `spatial_pattern` | Moran's I, Gi\*, OLS, k-means, correlation |
| `run_intervention` | re-solve any measure, anywhere, over any window |
| `intervention_catalogue` | the levers, their ranges, and their known trade-offs |
| `allocate_budget` | greedy marginal-benefit allocation under four objectives |
| `map_control` | drive the visualisation |
| `run_python` | Python with the dataset already loaded |
| `consult_specialist` | hand one sub-problem to a specialist, blocking |
| `chart` | a matplotlib figure rendered into the transcript |

### The three specialists, and why they are not SDK subagents

They were, and it cost a whole turn. Registered through
`ClaudeAgentOptions(agents=…)`, asked a two-part question — test a spatial
pattern, and re-solve an intervention across the seasons — the analyst delegated
both, said *"both jobs are running in the background; I'll report back with the
chart and map view as soon as they land"*, and ended its turn. Nothing landed,
because there is nothing to land on: in this CLI the tool that reaches a subagent
is `Agent` and it is **asynchronous**. There is no cross-turn notification a
server-driven run can wait for, so a delegated job is a job the answer never
contains. (`Task`, the synchronous form, does not exist in this CLI version —
probed directly.)

So `Agent` is refused, along with `Task`, `ScheduleWakeup`, `Workflow`, `Monitor`
and everything else shaped like asynchronous work, and the specialists are reached
through **`consult_specialist`** — an in-process tool that drives a nested SDK
client to completion and returns its answer as the tool result. From the analyst's
side that is one blocking call whose answer is in its context before it writes a
word, which is the property the whole thing needed.

It buys three more things the built-in route did not. The specialist's tool set is
enumerated rather than inherited, so a pattern-finder cannot decide to run an
intervention. Its spend is bounded separately, at half the parent's turn budget, so
it cannot leave the analyst unable to write up what it produced. And its answer
lands in the transcript as a tool result, in order, beside the sentence that used
it.

Registering them the built-in way had a second cost worth recording: it also added
the *machine's own* built-in agents — `Explore`, `general-purpose`, `Plan` — to the
analyst's roster, which is a containment leak on top of a correctness one.

Each specialist carries its own tool list: an agent holding the intervention tools
is an agent that will occasionally run one when it was asked to find a pattern.

- **`geographer`** — finds and tests spatial patterns. Told never to describe a
  pattern as clustered without a statistic, always to report the
  FDR-corrected count, and to go after the residuals.
- **`physicist`** — tests interventions by re-solving. Told to solve the whole
  year unless the question is explicitly about one hour, to report where the
  measure **fails** as prominently as where it works, and to distrust the
  air-temperature delta and say why.
- **`reviewer`** — read-only, adversarial. Told to report *every* issue including
  minor and uncertain ones, because a finding that gets filtered later costs
  nothing and an error silently passed costs the answer. A reviewer that can
  edit will fix what it finds instead of reporting it.

---

## Spend, auth and containment

### Three bounds on spend, reconciled

- **`max_budget_usd`** bounds one SDK run inside the harness. Real and enforced,
  but invisible to the model, so it cuts mid-tool-call. The runaway guard.
- **`task_budget`** injects a token countdown the model can **see**, so it wraps
  up and answers rather than being guillotined holding the finding.
- **`HEATCANYON_AGENT_SESSION_BUDGET_USD`** bounds this whole process across
  every run, checked before one starts. A demo left open in a tab should not be
  able to spend without limit.

### Auth

`HEATCANYON_AGENT_AUTH` selects the mode.

- **`cli`** (default) inherits the machine's own `claude` login. This is what
  makes the demo work on a laptop with nothing in the environment.
- **`api_key`** / **`oauth`** inject exactly one credential.

`cli` mode does not merely *omit* `ANTHROPIC_API_KEY` — it **removes it from this
process**, because `ClaudeAgentOptions.env` is merged onto `os.environ` and
anything that loaded a `.env` has already put a key there. The child would
inherit it and be shadowed.

### Nothing from the filesystem

`setting_sources=[]` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Without them a
turn in this repository loads the repository's own `CLAUDE.md` and the operator's
private Claude Code memory files into the analyst's context. That is somebody's
working notes; it is not this model's evidence, and an analyst that can answer a
question out of it is an analyst producing numbers with no provenance. The
skills, plugins and tools it gets are the ones chosen in `options.py` and nothing
else.

### Web access, and the rule that makes it safe

`WebSearch` and `WebFetch` are allowed. They were not, for a long time, and the
reason is worth stating because it is the reason the rule below exists: the
analyst's authority comes entirely from the fact that every number it states came
out of this model, and an agent that can read the open web will eventually answer
a question about Manhattan from a news article.

So the guard moved out of the tool list and into the prompt, where it can be
specific rather than absolute. The web is for two things: what the model does not
hold (what a programme funds, what a standard sets as a threshold, what the city
announced, what a paper measured elsewhere), and combining — an external fact set
against a model result, which is often the whole answer. It is never the source
of a figure this model can produce itself. Ask how hot a wall gets and the number
comes out of the physics or it does not get said.

Everything taken from outside is cited in the sentence that makes the claim, as a
markdown link with the date it was read, and labelled `EXTERNAL` alongside
`MEASURED`, `MODELLED`, `REANALYSIS` and `COMPOSITE` — so a reader scanning the
provenance labels can see which sentences came from the model and which did not.
An external number and a model number may share a sentence; they may never be
merged into one figure without the arithmetic being shown and both inputs
labelled. The console marks external links with an arrow for the same reason.

The prompt is passed the current date, because a citation dated from a model's
own sense of "now" is dated from whenever its training stopped.

### Containment, and what it is not

`PreToolUse` hooks confine `Write`, `Edit` and `NotebookEdit` to the run's own
workspace (`.agent/runs/<run_id>/workspace`), refuse a `Bash` command that writes
outside it or that names a destructive command, and allow read-only `git`.
Reading anywhere in the repository is allowed on purpose: the agent should be
able to open `heatcanyon/physics.py` and check what a coefficient actually is.

**This is not a sandbox.** A determined agent with a Python interpreter can
defeat any pattern match on a command line, and pretending otherwise would be
worse than saying so. It is a guard against carelessness. A deployment that
exposes this publicly should run the agent under the SDK's own `sandbox` settings
and give it a container.

---

## Running a turn

Asynchronous by necessity. A question like *"where should the city act first, and
what does each measure buy across the year"* is minutes of work: a dozen queries,
several re-solves, a statistical test, a chart. A synchronous endpoint cannot
express that — any proxy cuts an idle connection long before the answer exists,
and even without one a request that returns nothing for four minutes is
indistinguishable from a hang.

```
POST /api/agent/ask                     -> { run_id, state }
GET  /api/agent/runs/{id}/events        -> SSE: replay, then tail
GET  /api/agent/runs/{id}/frames        -> the whole transcript, for a reopen
POST /api/agent/runs/{id}/interrupt
POST /api/agent/interrupt-all
GET  /api/agent/envelope                -> model, budgets, tools, subagents
GET  /api/agent/artifact/{path}         -> a chart the agent produced
POST /api/ask                           -> the single-shot fallback
```

### Durability without a database

Every frame is appended to `.agent/runs/<run_id>/frames.jsonl` as it is produced,
and the status to `status.json`. That buys three things for the cost of one
append: a reconnecting console replays from the file and misses nothing, a
process restart leaves a readable record rather than a silent gap, and a run
killed at its budget cliff still shows what it had done. There is no worker and
no table, so **the file is the state**.

### Replay-then-tail, with the boundary announced

Replaying an in-flight run dumps hundreds of frames in one burst, and a UI that
renders those the way it renders live output looks like an agent having a
seizure. One `replay_done` frame after the first pass tells the console where
history ends. A run with nothing recorded still gets it: the frame means *you are
now live*, not *something was replayed*.

### Conversation continuity

A thread is the SDK session id carried forward, so a follow-up question does not
re-derive the first answer. A session the CLI can no longer load is retried
**cold exactly once** — otherwise one bad id breaks every future turn in that
conversation, and an empty resumed turn is indistinguishable from a broken one.

---

## The console

`web/js/agent.js`. Not a chat box: the transcript is the point, so it gets the
space.

Every tool call appears as it is made, collapsed to its name and a digest of its
arguments, expanding to the full input and result. The summarised reasoning
appears too, collapsed — watching the analyst choose between `query_buildings`
and a script is most of how a reviewer decides whether to believe the answer. Map
actions render as a note *and* are applied. Charts render inline.

If the agent cannot start, the console falls back to `/api/ask` — the older
single-shot loop, which needs nothing but an API key — and says which one
answered rather than pretending the capability is there.

---

## Configuration

| variable | default | what it does |
|---|---|---|
| `HEATCANYON_AGENT` | `1` | serve the analyst at all |
| `HEATCANYON_AGENT_MODEL` | `claude-sonnet-5` | pinned; unset would mean the CLI's own default |
| `HEATCANYON_AGENT_EFFORT` | `high` | |
| `HEATCANYON_AGENT_AUTH` | `cli` | `cli` \| `api_key` \| `oauth` |
| `HEATCANYON_AGENT_BUDGET_USD` | `2.50` | one turn |
| `HEATCANYON_AGENT_SESSION_BUDGET_USD` | `40` | this whole process |
| `HEATCANYON_AGENT_TIMEOUT_S` | `900` | one turn |
| `HEATCANYON_AGENT_TASK_BUDGET_TOKENS` | `400000` | the countdown the model can see |
| `HEATCANYON_AGENT_MAX_CONCURRENT` | `3` | beyond this a turn queues rather than failing |
| `HEATCANYON_AGENT_SUBAGENTS` | `1` | |
| `HEATCANYON_AGENT_THINKING` | `summarized` | `summarized` \| `off` |
| `HEATCANYON_AGENT_WORKSPACE` | `.agent` | |

`GET /api/agent/envelope` returns all of it, with no secrets, which is what the
console's header shows.

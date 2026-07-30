# Jaroku

**A local-first workbench for building, running, tracing, editing and evaluating LangGraph agents.**

You describe an agent in plain English. Jaroku plans it, writes it as a real LangGraph
project on your disk, runs it, and shows you every LLM call, tool call, routing decision and
state mutation it made — with real token counts and real dollar costs. Then you can pause a
run mid-graph, fork it from any step with an edited state, ask for a code change and review
the diff before it lands, and fan the whole thing out across providers to compare quality,
latency and cost side by side.

The generated projects import nothing from Jaroku. They are plain LangGraph you can copy out
of the repo and run yourself.

```
  you ──▶ plan ──▶ generate ──▶ run ──▶ trace ──▶ edit ──▶ eval
           │          │          │        │        │        │
        review     validated   traced   stepped  diffed  compared
        before     before      live     through  before  across
        writing    landing              & forked applying providers
```

---

## Table of contents

- [Why it exists](#why-it-exists)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Try it in 60 seconds](#try-it-in-60-seconds)
- [Repository layout](#repository-layout)
- [Architecture](#architecture)
- [The event schema](#the-event-schema)
- [The Python runtime](#the-python-runtime)
- [The agent contract](#the-agent-contract)
- [The Node server](#the-node-server)
- [The build pipeline: plan → generate → validate](#the-build-pipeline-plan--generate--validate)
- [The fix loop: propose → apply → undo](#the-fix-loop-propose--apply--undo)
- [Debug depth: pause, resume, branch](#debug-depth-pause-resume-branch)
- [The eval engine](#the-eval-engine)
- [Cost accounting](#cost-accounting)
- [Connectors](#connectors)
- [The React client](#the-react-client)
- [WebSocket protocol](#websocket-protocol)
- [Configuration](#configuration)
- [Running things by hand](#running-things-by-hand)
- [Tests](#tests)
- [Developing for free (fixtures)](#developing-for-free-fixtures)
- [Where data lives](#where-data-lives)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why it exists

Most agent frameworks give you a way to *write* an agent. Almost none give you a way to
*see* one. When an agent misbehaves you are usually left reading print statements and
guessing which tool call went wrong, what the state looked like before it, and what it cost.

Jaroku is built around one primitive: **the trace**. Every run emits a frozen, versioned
event stream — one JSON object per line — describing every step the agent took. Everything
else in the product is a consumer of that stream:

- the **timeline** renders it live,
- the **state diff** view reads `state_before` / `state_after`,
- the **eval dashboard** aggregates it across providers,
- the **cost** figures are summed from it,
- the **branch** feature forks from a checkpoint correlated to it.

A few principles the codebase holds to consistently, because they are the difference between
a tool you trust and one you don't:

| Principle | What it means in practice |
|---|---|
| **The trace never lies** | The tracer never crashes the agent it observes, and never guesses. A router classification that can't be proven is emitted as a `state_update`, not a wrong label. |
| **Unknown ≠ zero** | An unpriced model reports `null` cost, never `$0.00`. A judge failure is *unscored*, never a score of 0. Both survive CSV export. |
| **Nothing lands unreviewed** | Generation shows you a plan first. Edits show you a diff first. Both stage to a temp directory and atomic-swap only after validation passes. |
| **stdout is sacred** | stdout carries trace events and nothing else. The runner `dup2`s fd 1 to stderr before importing any generated code, so a stray `print()` physically cannot corrupt the stream. |
| **Money asks first** | The free dry-run path is one click. Spending real money requires picking providers, seeing an estimate, and setting a hard budget ceiling the server enforces. |

---

## Requirements

| Tool | Version | Why |
|---|---|---|
| **Node.js** | **22+** (24 recommended) | The server uses the built-in `node:sqlite` module — no native build step, no `better-sqlite3`. |
| **Python** | **3.12+** | Pinned in `runtime/.python-version`. |
| **uv** | any recent | The server spawns every agent as `uv run python -m jaroku_runner …`. Install from [astral.sh/uv](https://docs.astral.sh/uv/). |
| **Anthropic API key** | optional | Needed for planning, generation, editing, explain and the eval judge. Everything else — running agents on the dry-run provider, the trace pipeline, the graph view, the whole UI — works with no key at all. |

macOS and Linux are the tested platforms. On macOS the server prepends `/opt/homebrew/bin`
to `PATH` when spawning Python so a Homebrew-installed `uv` is always found.

---

## Quick start

```bash
git clone https://github.com/jackeddisciple/jaroku.git
cd jaroku
```

**1 — Python runtime**

```bash
cd runtime
uv sync                      # LangGraph, LangChain, the SQLite checkpointer
uv sync --extra connectors   # optional: Gmail / Slack / Postgres SDKs
cd ..
```

The connector SDKs are deliberately kept out of the base install. Each connector template
lazy-imports its SDK and returns a clear message when it is absent, so the trace pipeline and
the dry-run path never depend on them.

**2 — Node server** (install this before the client — the client's test scripts borrow the
server's `tsx` binary)

```bash
cd server
npm install
cd ..
```

**3 — React client**

```bash
cd client
npm install
cd ..
```

**4 — Provider keys** (optional, but needed for anything that calls a model)

Create `runtime/.env`:

```bash
# Planning, generation, editing, explain, and the eval judge all use this key.
ANTHROPIC_API_KEY=sk-ant-...

# Only needed to run agents on the OpenAI provider.
OPENAI_API_KEY=sk-...

# Only needed by the connectors you actually select.
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
SLACK_BOT_TOKEN=
DATABASE_URL=postgres://...
```

`runtime/.env` is gitignored. Both the Node side (`server/src/env.ts`) and the Python side
(`runtime/jaroku_interceptor/env.py`) read it with identical precedence rules: **a variable
already present in the environment always wins**, so shell env and CI secrets still override
the file. Neither loader ever logs a value — only the *names* of the keys it set.

**5 — Run it**

Two terminals:

```bash
# terminal 1 — pipeline + WebSocket relay on :4317
cd server && npm run dev
```

```bash
# terminal 2 — UI on :5173
cd client && npm run dev
```

Open **http://localhost:5173**.

There is also a dependency-free fallback UI served directly by the relay at
**http://localhost:4317** (`server/debug-client.html`) — useful for confirming the pipeline
is alive without running Vite.

On startup the server fires one run of the hand-written fixture agent so you see a live trace
immediately. Set `JAROKU_NO_AUTORUN=1` to suppress it.

---

## Try it in 60 seconds

**Watch a trace, with no API key and no cost.** Select **Example Agent** in the sidebar,
switch the composer to **Test**, type `What time is it in Europe/Paris?` and hit send. The
right panel switches to **Trace** and fills in live: an `llm_call`, a `router` decision, a
`tool_call`, a `state_update`. Click any step to slide in its detail panel with the full
input, output, and a before/after state diff.

**See the graph.** Switch the right panel to **Graph**. The topology is introspected from the
real compiled LangGraph object (never guessed from the source), with conditional edges
labelled by their branch condition.

**Generate an agent.** With no agent selected, type into the composer:

```
A support agent that looks up order status in Postgres and drafts a reply
```

You get a **plan card** first — the tools it will create, the state fields, the graph shape,
in plain language. Revise it by typing feedback; the plan updates. Press **Generate** and the
files stream in as they are written. Nothing lands on disk until validation passes.

**Edit it.** With the agent selected, type `add a tool that summarises the last 5 orders`.
You get a **diff card** — per-file hunks, additions and deletions — and nothing changes until
you press **Apply**. **Undo** restores the previous version from a snapshot.

**Compare providers.** Go to the **Evals** tab, add a few example inputs to a dataset, pick
providers, read the estimate, set a ceiling, and run. You get a comparison table of quality,
cost, latency and token counts per provider, exportable to CSV or JSON.

---

## Repository layout

```
jaroku/
├── schema/
│   └── events.md              # THE frozen v1 event schema — the product's primitive
│
├── runtime/                   # Python: the observed side
│   ├── pyproject.toml         # uv project (LangGraph, LangChain, SQLite checkpointer)
│   ├── pricing.json           # single source of truth for model pricing (read by BOTH sides)
│   ├── .env                   # provider keys (gitignored)
│   │
│   ├── jaroku_interceptor/    # turns LangChain callbacks into trace events
│   │   ├── schema.py          # Run/Step dataclasses + the NDJSON transport
│   │   ├── callback.py        # JarokuTracer — the callback handler
│   │   ├── pricing.py         # Python reader of pricing.json
│   │   └── env.py             # .env loader
│   │
│   ├── jaroku_runner/         # runs GENERATED agents; owns all trace wiring
│   │   ├── __main__.py        # the entrypoint the server spawns
│   │   ├── contract.py        # loads an agent module and proves it is runnable
│   │   ├── guard.py           # the stdout guard (dup2 fd 1 → stderr)
│   │   ├── models.py          # provider selection (fake / anthropic / openai)
│   │   ├── fake.py            # schema-driven dry-run model — free, deterministic
│   │   ├── debug.py           # checkpointed driver: pause / resume / branch
│   │   └── graph.py           # static topology introspection for the Graph view
│   │
│   ├── tool_templates/        # reviewed connectors, copied verbatim into projects
│   │   ├── catalog.json       # the registry: ids, env, tool signatures
│   │   ├── gmail.py  slack.py  postgres.py
│   │
│   ├── test_agent/            # hand-written 2-tool fixture; traces itself
│   └── agents/                # generated projects land here
│       └── example_agent/     # hand-written reference implementation of the contract
│
├── server/                    # Node/TypeScript: the control plane
│   ├── src/                   # (see "The Node server" below)
│   ├── fixtures/              # recorded model responses for free development
│   ├── debug-client.html      # dependency-free fallback UI on :4317
│   └── jaroku.db              # SQLite: traces + eval control plane (gitignored)
│
└── client/                    # React 19 + Vite + Tailwind + Zustand
    └── src/
        ├── components/        # the three-column UI
        ├── store/             # zustand stores, one per concern
        └── lib/               # socket, intent routing, formatting, export
```

---

## Architecture

Three processes, one direction of data flow.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  BROWSER — React 19 / Vite / Zustand                    localhost:5173    │
│  three columns: agents+runs · build & conversation · graph/trace/evals    │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │  one WebSocket, many logical channels
                                │  trace · gen · edit · debug · eval · reply …
┌───────────────────────────────┴───────────────────────────────────────────┐
│  NODE SERVER — process manager + relay + store          localhost:4317    │
│                                                                           │
│   RunPool (N slots, slot 0 reserved for the interactive run)              │
│   Planner → Generator → Validator → atomic swap                          │
│   Editor  → staged proposal → diff → apply/undo with linear history      │
│   EvalRunner → persisted job queue → per-provider caps → judge           │
│   TraceStore + EvalStore  (one SQLite file, one writer)                  │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │  uv run python -m jaroku_runner <agent>
                                │  ← NDJSON trace events on stdout
                                │  ← control events + logs on stderr
┌───────────────────────────────┴───────────────────────────────────────────┐
│  PYTHON RUNTIME — the observed side                                       │
│                                                                           │
│   jaroku_runner   guard → contract → model → checkpointed driver         │
│   JarokuTracer    LangChain callbacks → Run/Step events                  │
│   the agent       plain LangGraph. Imports nothing from Jaroku.          │
└───────────────────────────────────────────────────────────────────────────┘
```

The separation is load-bearing in both directions. The agent knows nothing about Jaroku, so
generated projects stay portable. Jaroku knows nothing about the agent's internals, so it
observes through LangChain's public callback interface and LangGraph's public
`get_graph()` — never by patching or introspecting private state.

---

## The event schema

`schema/events.md` defines schema **version 1**, and it is frozen. The trace pipeline, the
timeline UI, eval aggregation and cost accounting all read this shape.

The transport is **newline-delimited JSON on stdout** — exactly one JSON object per line.
Every line is one of three kinds:

```jsonc
{ "kind": "run_start", "schema_version": 1, "run":  Run  }
{ "kind": "step",      "schema_version": 1, "step": Step }
{ "kind": "run_end",   "schema_version": 1, "run":  Run  }
```

Ordering within a run is guaranteed: `run_start` → `step` (seq 0..N ascending) → `run_end`.

**Run**

| Field | Type | Notes |
|---|---|---|
| `id` | string | uuid4, stable for the whole run |
| `agent_id` | string | e.g. `"example_agent"` |
| `provider` / `model` | string | `"anthropic"` / `"claude-haiku-4-5"` |
| `status` | `running \| completed \| error` | |
| `started_at` / `ended_at` | ISO-8601 UTC | `ended_at` is null until `run_end` |
| `cost` / `tokens` | number | aggregated across steps |
| `error` | string \| null | top-level failure |

**Step**

| Field | Type | Notes |
|---|---|---|
| `id` / `run_id` | string | |
| `seq` | number | monotonic per run from 0, assigned at *start* time so steps sort causally |
| `type` | `llm_call \| tool_call \| state_update \| router` | |
| `name` | string | node / tool / model name |
| `input` / `output` | json | |
| `state_before` / `state_after` | json \| null | drives the state-diff view |
| `tokens` / `cost` | number \| null | `llm_call` only; **null means unknown, not free** |
| `latency_ms` | number | |
| `error` | string \| null | |
| `parent_step_id` | string \| null | resolved through LangChain's parent run-id chain |
| `started_at` | ISO-8601 UTC | |

Everything added since — pause/resume checkpoints, branching, the entire eval engine — went
into **new tables and new WebSocket channels beside the schema**, never into the event shape.
That discipline is stated explicitly at the top of `store.ts`, `evalStore.ts` and `wsRelay.ts`.

---

## The Python runtime

### `jaroku_interceptor` — turning execution into events

`JarokuTracer` is a `BaseCallbackHandler`. The mapping:

| LangChain callback | Emitted step |
|---|---|
| `on_chat_model_start` / `on_llm_start` + `on_llm_end` | `llm_call` |
| `on_tool_start` + `on_tool_end` | `tool_call` |
| `on_chain_start` (LangGraph node) + `on_chain_end` | `state_update` |
| `on_chain_start` (conditional edge) + `on_chain_end` | `router` |

Three details worth knowing:

- **`seq` is assigned at start time**, but the `Step` is emitted at end time (when output,
  latency and errors are known). So steps sort in causal order regardless of nesting.
- **Router classification is exact when it can be.** Passing the compiled graph
  (`JarokuTracer(run, graph=app)`) lets the tracer read `graph.builder.branches` and know
  precisely which `(node, branch)` pairs are conditional edges. Without it, a conservative
  heuristic proposes candidates that must still pass an end-time output-shape check —
  anything that fails is emitted as a `state_update` exactly as before. A step's `type` is
  only materialised at finish, so a rejected guess costs nothing, not even a `seq`.
- **The tracer never crashes the agent it observes.** Payload capture is best-effort;
  anything unserialisable falls back to its `repr`.

### `jaroku_runner` — running generated agents

The order of operations in `__main__.py` is load-bearing:

```
1. load_env()               provider keys from runtime/.env (values never logged)
2. install_stdout_guard()   BEFORE any generated code is imported
3. emit_run_start()         so a run appears in the UI even if step 4 fails
4. load_agent()             import + contract check
5. build model + graph, invoke with the tracer attached
6. emit_run_end()           in a finally, always
```

Steps 3 and 6 bracket everything, so a contract violation, an import error, or a crash
mid-graph surfaces as a run with `status: "error"` rather than as silence.

**The stdout guard** (`guard.py`) is the hard guarantee. However emphatic a system prompt is
about "never write to stdout", a prompt is a request, not an invariant. So before importing
any generated module the runner:

1. `os.dup(1)` — takes a private copy of the real stdout fd and pins it as the event stream,
2. `os.dup2(2, 1)` — repoints fd 1 at stderr, so even a C-level write from a native
   extension lands on stderr,
3. `sys.stdout = sys.stderr` — the Python-level view, so `print()` is redirected too.

After that, "write to stdout" and "write to stderr" are the same thing for every line of code
that is not the event emitter. It is irreversible by design.

**The dry-run model** (`fake.py`) is the default provider and costs nothing. It is
*schema-driven*: it walks the agent's `TOOLS`, reads each tool's argument schema, synthesises
one call per tool with placeholder arguments, then finishes with a plain answer so the
conditional edge can route to `END`. That buys you, for free and with no API key:

- every generated tool function actually executes, so import errors, typos and bad decorators
  surface immediately,
- a trace with real depth — `llm_call` / `router` / `tool_call` per tool — so the timeline and
  state-diff views have something to show,
- determinism, so a trace can be diffed run over run.

It is a smoke test, not a simulation. A tool that hits a real API will fail on the
placeholder argument — and that failure is captured as a traced step error, which itself
proves the error path renders.

---

## The agent contract

A generated (or hand-written) agent project must expose exactly three symbols from
`agent.py`, and nothing more:

```python
TOOLS: list                               # every @tool the graph can call
def build_graph(llm): ...                 # returns a COMPILED graph; llm is INJECTED
def build_initial_state(user_input: str) -> dict
```

Deliberately **not** in the contract: anything Jaroku. A generated agent that imports
`jaroku_interceptor` is rejected at generation time, precisely so your project stays portable
standard LangGraph.

Because the model is injected rather than constructed, the provider dropdown is a real
feature instead of a regeneration: the same project runs unchanged on the free dry-run model,
on Claude, or on GPT.

`runtime/agents/example_agent/` is the hand-written reference implementation — two
dependency-free tools, a custom `notes` state field, a system prompt as editable markdown. It
exists so a fresh checkout has something to run before anything has been generated.

---

## The Node server

| File | Responsibility |
|---|---|
| `index.ts` | Wires the pipeline: RunPool → TraceStore → WsRelay. Owns run lifecycle, pause/resume/branch, and the eval command surface. |
| `wsRelay.ts` | HTTP + WebSocket transport. Serves the fallback client, defines every command and channel type. Answers reads locally, forwards mutations to the app. |
| `processManager.ts` | Spawns the Python subprocess, reads stdout line-by-line, parses each line as a trace event. Survives non-zero exit, mid-run crash, and garbled lines. |
| `runPool.ts` | N process managers. **Slot 0 is reserved for the interactive run**; the rest are lent to the eval fan-out. Adds per-run attribution and optional deadlines. |
| `store.ts` | SQLite trace store (`runs`, `steps`) via built-in `node:sqlite`. JSON payloads are TEXT, parsed on the way out so live and replayed steps are identical shapes. |
| `planner.ts` / `planProtocol.ts` | The pre-generation gate: prompt → short structured plan → confirm. |
| `generator.ts` / `fileProtocol.ts` | Prompt → Claude → a complete LangGraph project, streamed, staged, validated, atomic-swapped. |
| `prompt.ts` | Every system/user prompt in one module — generation, editing, planning — so the three can never drift. |
| `validator.ts` | The gate that decides whether generated text is allowed to become a runnable agent. |
| `editor.ts` | The fix loop: instruction → staged proposal → reviewable diff → apply/undo with linear history. |
| `projectFs.ts` | `atomicSwap`, path confinement, agent-id validation. Read-every-line territory. |
| `connectors.ts` / `agents.ts` | Registries over `tool_templates/catalog.json` and `runtime/agents/`. |
| `claude.ts` | One lazy Anthropic client, one usage/cost accounting. The key never leaves the process. |
| `pricing.ts` | Node reader of the shared `runtime/pricing.json`. |
| `graphIntrospect.ts` | Spawns `jaroku_runner.graph` to get real topology. Never runs the graph. |
| `explainer.ts` | Streaming prose answers about a step / node / agent. Degrades to raw context with no API key. |
| `evalStore.ts` | Eval control-plane tables in the same DB file: datasets, examples, rubrics, eval runs, jobs, scores. |
| `evalRunner.ts` | The orchestrator: expands (examples × providers) into persisted jobs and drains them under per-provider caps, with bounded retries and a budget ceiling. |
| `evalAggregate.ts` | Traces → the numbers the comparison dashboard shows. |
| `evalEstimate.ts` | What a real-provider eval will roughly cost, *before* committing. |
| `evalCleanup.ts` | Sweeps checkpoint blobs left by finished eval jobs. Never touches interactive runs. |
| `judge/` | LLM-as-judge: `rubric.ts` (pure — prompt + parser), `score.ts` (the pipeline), `output.ts` (extracting the agent's answer from a trace). |

---

## The build pipeline: plan → generate → validate

### 1. The plan gate

Typing a description with no agent selected produces a **plan**, not code. The planner writes
nothing to disk and reserves no agent id — a plan is text about code that does not exist yet.

The plan uses a delimiter protocol so it can be rendered as structure while staying readable
if the model ignores it entirely:

```
<<<PLAN section="tools">>>
- gmail_search — reviewed connector template (gmail)
- order_lookup — bespoke; reads order status from Postgres by order id
<<<ENDPLAN>>>
```

Parsing **degrades, never hard-fails**. Every plan carries its `raw` text, the card always
falls back to rendering it, and confirming is never blocked on a successful parse.

Typing again while a plan is on screen is treated as *feedback on that plan*, not a new
brief — the original brief is kept and the revision counter increments. The only way to
abandon a plan is Discard.

When you press Generate, the build comes from the **stored plan record**, not from whatever
the composer currently says. If you retyped the prompt or toggled a connector chip after
planning, the approved plan still wins — building something you never reviewed is the exact
failure this gate exists to prevent. If a connector named by the plan has since vanished from
the catalog, the generation is refused loudly and the plan survives so you can re-plan.

### 2. Generation

Files stream over a delimiter protocol chosen over JSON deliberately — streaming *partial*
JSON means escaping every newline in every source file, which is fragile to parse mid-stream
and materially more expensive in tokens for code payloads:

```
<<<FILE path="agent.py">>>
...contents...
<<<ENDFILE>>>
```

`FileProtocolParser` is fed arbitrary chunk boundaries, so it holds back a tail of
`delimiter length − 1` characters until it can prove they are content, and never emits text
that might turn out to be the front of a delimiter.

Safety properties the generator owns:

- **Staging + atomic swap.** Files are written to `agents/.staging/<id>/` and moved into
  `agents/<id>/` only after validation passes. A crash, a truncated stream, or a rule
  violation leaves any previously working agent untouched.
- **Path confinement.** Every path the model emits is checked. Absolute paths, `..`, and
  anything escaping the staging root are rejected outright.
- **The API key never leaves the process.** It is never logged, echoed to a client, or
  written into a generated file.
- **Host-owned files are written after the model's**, so the model cannot shadow them:
  `jaroku.json` (metadata, connectors, required env, and what the agent cost to create),
  `.env.example` (merged with whatever keys the model declared), `__init__.py`.
- **Connector templates are copied byte-for-byte**, never re-rendered.

### 3. The hard rules

The generation prompt states eleven hard rules. Each exists because violating it breaks
something specific, and each is *enforced* by the validator rather than merely requested:

| # | Rule | Why |
|---|---|---|
| 1 | Never import anything named `jaroku` | Keeps generated projects portable; keeps trace wiring in the host |
| 2 | Never construct a model | `llm` is injected — this is what makes the provider dropdown work without regenerating |
| 3 | Never write to stdout | stdout **is** the event transport. Also enforced at runtime by the stdout guard |
| 4 | Read secrets only from `os.environ`, and declare them in `.env.example` | So a user can find out what an agent needs |
| 5 | The graph must terminate | A non-terminating graph burns the recursion limit and money |
| 6 | Use connector templates exactly as given | A reviewed connector must not be silently rewritten |
| 7 | Tools return answers; failures **raise** | A returned error string is recorded as a *successful* tool call — a green step whose content is an error, which the model then answers the user from. Requires `ToolNode(TOOLS, handle_tool_errors=True)` |
| 8 | Every `@tool` needs a typed signature and a docstring | The model reads the docstring to decide when to call it; the host derives dry-run args from the type hints |
| 9 | Never call one `@tool` from inside another | A decorated tool is a `StructuredTool` object — calling it raises `TypeError` |
| 10 | Never build SQL by interpolation | An injection vector even against a read-only connector: a crafted input can widen a `SELECT` to rows the user should never see |
| 11 | Emit only final, working code | No false starts or dead classes; the project is imported during validation |

### 4. Validation

Validation runs against the **staging directory, before the swap**. Any problem means the
staged project is discarded and whatever was at `agents/<id>/` is untouched. In order,
cheapest first:

1. **Contract checks** — `build_graph`, `build_initial_state`, a reference to `TOOLS`, and
   (on fresh generation) `handle_tool_errors=True` on the tool node.
2. **Regex rules across every generated file** — jaroku imports, model construction, bare
   `print()` (allowing the documented `print(..., file=sys.stderr)`).
3. **Secret declaration** — every `os.environ` key referenced must appear in `.env.example`.
4. **AST analysis via Python's own parser**, in the project's uv venv:
   - syntax errors, with file and line,
   - calling a `@tool` as a plain function,
   - SQL assembled with an f-string (requiring actual query *shape*, so an error message
     mentioning `SELECT` doesn't trip it),
   - **shadowing or unwiring a reviewed tool.** The connector template *files* are read-only,
     but the file that decides which tools get bound is not — it can't be, because adding a
     bespoke tool means editing it. So the validator follows `TOOLS = …` assignments (through
     one level of local variable, so `TOOLS = CONNECTOR_TOOLS + [mine]` is understood) and
     rejects a project that advertises a connector it can no longer call, or that defines a
     function shadowing a reviewed tool's name.
5. **An actual import** — only reached when every cheaper check passed. `ast.parse` proves a
   file *parses*; it does not prove it *loads*. A real generation once shipped
   `class AgentState(StateGraph.__bases__[0] …)` — syntactically valid, `TypeError` on
   import, so every run died at step 0 while validation waved it through. The import check
   executes the project's top-level code exactly as the runner would, in the same venv, with
   stdout captured and a 20-second timeout.

---

## The fix loop: propose → apply → undo

The AI never silently edits your files.

```
instruction ──▶ staged copy of the project + the model's files
                          │
                          ▼
                   full validation (same contract as generation)
                          │
                          ▼
                  reviewable diff card (per-file hunks, +/− counts)
                          │
             ┌────────────┼────────────┐
          Apply         Undo        Discard
             │            │            │
      snapshot then   restore      drop staging
      atomic swap     snapshot
```

- A proposal lives in `agents/.staging/<id>__edit/` — a full copy of the project with the
  model's files applied. The live project is untouched until an explicit **Apply**.
- **Reviewed connector templates, `jaroku.json` and the top-level `__init__.py` are hard
  read-only.** The stream is rejected the moment the model opens one, with a message pointing
  at the right move ("ask for a wrapper tool that adapts its results instead"). The block
  list covers every connector filename in the catalog, installed or not, so the model can
  never introduce a file masquerading as a reviewed template.
- **Apply snapshots first, then swaps.** The current project is copied to
  `agents/.history/<id>/v<n>/` before the swap, and the history entry is written only after
  the swap succeeds. **Undo** restores the latest snapshot the same way. Linear history,
  surviving reloads (the sidebar's Undo availability is derived from `history.json`).
- **A run in flight blocks mutation.** The check is pool-aware, not just interactive-aware:
  an eval job reading the agent's files from a subprocess right now would make its trace
  describe code that never ran.
- **A no-op is a valid outcome.** If the model declines and explains why, or re-emits files
  byte-identical to what is already there, you get a proposal with zero files and the
  summary explaining it — not a fake diff.

---

## Debug depth: pause, resume, branch

A generated agent's `build_graph(llm)` returns a bare compiled graph with no checkpointer, so
a plain `.invoke()` leaves nothing to resume from. `debug.py` recompiles a **twin** from the
same `StateGraph` builder with a durable `SqliteSaver` and `interrupt_after="*"`, then drives
it with a stream loop.

The load-bearing guarantee: **the trace emitted from this path is identical to a plain
`.invoke()`** — same nodes, same callbacks, same `seq` — because the interrupt only hands
control back between nodes and never re-runs a completed node. What changes is that every
node boundary now leaves a durable checkpoint on disk.

The control plane is entirely off the frozen stdout stream:

- **runner → server:** one `@@JAROKU_CTRL@@ {json}` line per boundary on **stderr**, carrying
  `seq_high`, `checkpoint_id` and the next nodes. The server correlates the checkpoint to the
  steps it covers.
- **server → runner:** a per-run `<run_id>.control` file the runner reads at each boundary.
  `pause` makes it stop *at* the boundary — checkpoint durable — and exit **without a
  `run_end`**, so the run stays open and a later resume continues its timeline.

| Action | What happens |
|---|---|
| **Pause** | The live run halts at its next node boundary. Its status becomes `paused` (a store-only status, never an emitted event). |
| **Resume** | A fresh subprocess continues the **same run id**, its `seq` starting where the paused segment left off. No `run_start`, no re-run of completed nodes. |
| **Branch** | Forks a **new run** from a parent's checkpoint at a step's node boundary, optionally with a validated domain-field edit applied to the state first. The parent's step rows are copied verbatim into the branch and its checkpoint DB is *physically copied* — the parent is never mutated, and both stay fully inspectable. |

Branching is always at a whole-node boundary, never mid-node.

---

## The eval engine

An eval is a **batch of ordinary runs**. There is deliberately no second way to execute an
agent: every job goes through the same pool slot → `jaroku_runner` → `JarokuTracer` →
`TraceStore` path as a run you trigger by hand, and produces the same `Run`/`Step` rows.
`eval_jobs.run_id` is a plain foreign key into `runs.id` — that FK is the entire integration
surface.

### The flow

```
dataset (examples)  ×  targets (provider, model)
          │
          ▼
   jobs PERSISTED to SQLite ──── before anything dispatches
          │
          ▼
   drained through the run pool under per-provider caps
          │                                   │
   transient failure? bounded retry     terminal? ──▶ judge (separate phase)
   with exponential backoff                          │
          │                                          ▼
          └──────────────▶ aggregation ──▶ comparison dashboard ──▶ CSV / JSON
```

### The properties that make the numbers mean something

**Jobs are persisted before dispatch.** The queue is a table, not an array. A crash mid-eval
leaves a readable record of what was meant to run and what already spent money, instead of
orphaned runs nothing points at. A restart marks interrupted evals as cancelled rather than
leaving rows claiming to be in flight forever.

**Per-provider concurrency, not just a global cap.** Providers rate-limit independently.
Eight simultaneous calls to one provider earns 429s that look like *that provider being
unreliable* — exactly the wrong conclusion for a tool whose job is comparing providers.
Default: 16 for `fake` (local and free), 2 for real providers, overridable per provider.

**One failing job is one failing cell.** A job that errors, times out or can't spawn is
recorded, and the drain continues.

**Retries are bounded and discriminating.** A rate limit or a dropped connection is luck, and
retrying converts it into a result. A `ContractError`, a missing module or an unset API key is
a property of the agent — it will fail identically every time, and retrying just multiplies
the bill. **Unrecognised failures are treated as deterministic**, because getting this
backwards means silently paying 3× for every broken agent.

**A budget ceiling the server enforces.** Checked before dispatching anything, against *true
spend* (every attempt plus judge cost) — never the comparison figure, which excludes failures
and would let a retry storm spend straight past the limit. It bounds what is **started**, not
what is spent: a job already in flight runs to completion, because stopping mid-run would
spend the money and throw away the result.

**Eval runs stay off the live trace channel.** Their events persist normally, but twenty
parallel runs broadcasting `run_start` would yank the timeline away from whatever you were
reading. Drill-down loads them on demand through the ordinary `loadRun` path.

### The judge

Scoring is a **separate phase** from execution. A job is scored once its run is already
terminal and recorded, so a broken judge costs you the quality column and nothing else.

- **The rubric is data, not code.** Criteria live in the `rubrics` table and are editable per
  dataset. "Correct" for a refund bot is not "correct" for a SQL agent.
- **A coarse, anchored scale.** Each criterion is scored 0–4 against written anchors, not on
  a continuous 0–1. Judges are far more consistent choosing between described levels than
  emitting a float, and "0.73" implies a precision that isn't there. The overall 0–1 is
  derived, never asked for.
- **Every criterion is phrased positively.** "Hallucination" as normally written is a
  negative — a high score would mean a bad answer, and mixing polarities in one weighted sum
  produces a number nobody can interpret. It ships as **grounding** instead, measuring the
  same thing upward.
- **An incomplete verdict is an error, not a zero.** If the judge omits a criterion the
  verdict is rejected and the example is **unscored**. Defaulting a missing score to 0 would
  silently punish a provider for the judge's formatting slip.
- **Judge cost is eval overhead**, tracked separately from provider cost — it's the same model
  for every leg, so charging it to the providers would add a constant to each and make cheap
  ones look worse than they are. It still counts toward true spend and the budget ceiling.
- **Only succeeded runs are judged.** A failed run has no answer to grade.

### Starting an eval

The free dry-run path is one click, because it is genuinely free. A real-provider eval is
deliberately asymmetric:

```
pick providers → see an estimate (a RANGE, and what it's based on) → set a ceiling → confirm
```

The estimate is honest about being one: it is a range not a point, it says whether it was
calibrated from this agent's real runs on this model or from a built-in default, and an
unpriced model estimates to `null` rather than zero. The estimate *informs*; the ceiling
*enforces*.

### Export

CSV and JSON. The one rule: **an export must not launder an uncertain number into a clean
one.** Unknown cost is an empty cell *with* a `cost_known` column beside it, never a 0. An
unscored run is an empty score *with* the judge's reason. Both are machine-readable and
neither can be mistaken for a measurement.

---

## Cost accounting

`runtime/pricing.json` is the single source of truth, read by **both** sides — the Python
interceptor computing per-step cost as a run executes, and the TypeScript server computing
pre-run estimates and eval aggregates. Two copies of a pricing table drift, and a drifted
table means the dashboard and the estimate disagree about the same run.

Prices are USD **per million tokens** so they're auditable against a published price sheet.
Three rules, implemented identically on both sides:

1. **An unpriced model costs `null`, never `$0`.** A silent zero next to a real number reads
   as "this provider is free" rather than "we don't know".
2. **Matching is exact, then longest-prefix** — never unordered substring.
3. **Cached input is priced as cached input** (Anthropic: ~0.1× read, ~1.25× write). Charging
   cache reads at the full input rate overstates cost by up to 10×.

Aggregation adds two more:

4. **Cost comes from `steps`, not `runs.cost`.** `runs.cost` is written by `run_end`; a run
   that crashes mid-graph never emits one and its row still reads 0 while its steps record
   real money already spent. Summing the steps is the only figure that matches the bill.
5. **Partial pricing is flagged, not hidden.** If any `llm_call` reports tokens but no cost,
   the total is an undercount and the run is marked cost-incomplete so the dashboard can say
   so rather than presenting a confidently wrong number.

And the comparison/spend split: the number a provider is **compared** on counts succeeded
runs only, so a provider that hit transient rate limits isn't scored as expensive for being
unlucky. **True spend** counts every attempt plus judge cost, because that is what actually
hit the card — and it's what the budget ceiling checks.

Creation cost is recorded too: `jaroku.json` carries what the plan and the generation each
cost, because the conversation that showed those numbers is in-memory and gone on reload, and
"what did this cost me" is a question asked long after.

---

## Connectors

Connectors are **reviewed, hand-audited tool templates**, copied byte-for-byte into generated
projects. They are never written by a model and never rewritten by one.

`runtime/tool_templates/catalog.json` is the registry. The server reads it to render tool
signatures into the generation prompt, to copy the right files into a project, and to build
`.env.example` from `required_env`.

| Connector | Tools | Required env | Safety posture |
|---|---|---|---|
| **Gmail** | `gmail_search`, `gmail_create_draft` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Creates drafts only — **never sends** |
| **Slack** | `slack_list_channels`, `slack_read_channel`, `slack_post_message` | `SLACK_BOT_TOKEN` | Posting is immediate and irreversible; the prompt says so explicitly |
| **Postgres** | `pg_query` | `DATABASE_URL` | Read-only, enforced twice: a statement check *and* a read-only transaction. One statement, `SELECT`/`WITH … SELECT` only, capped at 100 rows |

Each template lazy-imports its SDK, so the base install stays light and a missing SDK
produces a clear message rather than an import crash. Install them with
`uv sync --extra connectors`.

Adding a connector means: write the template, add its entry to `catalog.json`, and run the
`check_catalog()` verification in `tool_templates/__init__.py`.

---

## The React client

Three resizable columns:

```
┌─────────────┬───────────────────────────┬────────────────────────────┐
│  Sidebar    │  Build pane               │  Right panel               │
│             │                           │                            │
│  agents     │  ONE composer             │  [Graph] [Trace] [Evals]   │
│  runs       │  · Chat  → Jaroku         │                            │
│  history    │  · Test  → the agent      │  Trace is the hero.        │
│             │                           │  Click a step → detail     │
│             │  plan cards               │  panel slides over.        │
│             │  diff cards               │                            │
│             │  streaming files          │  Code opens as an overlay  │
│             │  explain answers          │  (Cmd+P / a diff row).     │
└─────────────┴───────────────────────────┴────────────────────────────┘
```

**One composer, routed by intent.** Rather than a dozen buttons, a single input routes each
message by *(selection context + phrasing)* into the mechanism that already exists:

| You type | With this selected | Goes to |
|---|---|---|
| a description | nothing | plan a new agent |
| feedback | a pending plan | revise that plan |
| `why did this fail?` | a step / node / nothing | explain (streaming prose) |
| `re-run from here` | a step | branch from that step |
| `fix this` | a **failed** step | the edit loop, pre-filled with the error |
| anything else | an agent | edit this agent |

Routing is pure keyword and pattern heuristics — no per-message LLM call. A mis-route just
needs a rephrase, so the cost of a classifier isn't warranted. The composer shows a live
one-line label of where the message will go, so the routing teaches itself.

**Stores are separated by invariant, not by convenience.** `traceStore` has rules that keep
the trace honest (dedupe by step id, render in `seq` order, never arrival order).
`buildStore`, `chatStore`, `evalStore`, `graphStore` and `uiStore` have none of those needs
and would only add churn to a store whose correctness matters. They share a socket and
nothing else.

**Voice input** is available via the Web Speech API, with a live waveform fed from a
short-lived `getUserMedia` stream. If `AudioContext`/`getUserMedia` are unavailable it falls
back to a plain recording indicator rather than breaking.

**Keyboard**

| Key | Action |
|---|---|
| `Cmd/Ctrl + K` | Command palette |
| `Cmd/Ctrl + P` | Jump to file |
| `Cmd/Ctrl + /` | Focus the composer |
| `J` / `K` | Previous / next trace step |
| `Enter` | Expand the selected step |
| `R` | Re-run the last test input |

---

## WebSocket protocol

One socket, many logical channels. The separation is deliberate: only `trace` carries the
frozen event schema, and everything added since rides beside it.

**Server → client**

| Channel | Carries |
|---|---|
| `history` | Run-history snapshot (sent on connect, and after a branch is created) |
| `agents` | The agent list (sent on connect, and after a generation or apply/undo) |
| `trace` | Live schema-v1 trace events for the interactive run |
| `runSteps` | A specific run's steps, ordered by `seq` (answer to `loadRun`) |
| `agentFiles` | An agent's current on-disk files, connector files flagged read-only |
| `graph` | Static LangGraph topology for an agent |
| `gen` | Plan + generation lifecycle: `plan_started`, `plan_delta`, `plan`, `plan_error`, `started`, `file_start/delta/end`, `done`, `error` |
| `edit` | Fix-loop lifecycle: `started`, file streaming, `proposal`, `applied`, `undone`, `discarded`, `error` |
| `debug` | Control plane: `paused`, `resumed`, `boundary`, `branched`, `error` |
| `eval` | Datasets, examples, rubrics, eval progress, scores, results, estimates |
| `reply` | Streaming "explain" answers |
| `log` | stderr lines and parse errors, for visibility |

**Client → server**

`run` · `loadRun` · `listAgents` · `loadAgentFiles` · `loadAgentGraph` · `planAgent` ·
`discardPlan` · `generate` · `edit` · `applyEdit` · `undoEdit` · `discardEdit` · `pauseRun` ·
`resumeRun` · `branchRun` · `explain` · and the eval set: `createDataset` · `renameDataset` ·
`deleteDataset` · `listDatasets` · `loadDataset` · `addExample` · `updateExample` ·
`deleteExample` · `promoteTestInput` · `startEval` · `cancelEval` · `estimateEval` ·
`loadEvalResults` · `listEvals` · `loadRubric` · `saveRubric`

Reads are answered locally by the relay (only the requesting client); mutations are forwarded
to the app, which answers by broadcasting the affected snapshot — the same shape a fresh read
would return, so a client never has to reconcile a partial update against local state.

The client reconnects automatically with a 1-second backoff, and re-requests what it needs.

---

## Configuration

### Server

| Variable | Default | Purpose |
|---|---|---|
| `JAROKU_PORT` | `4317` | HTTP + WebSocket port |
| `JAROKU_DB` | `server/jaroku.db` | SQLite file (traces + eval control plane) |
| `JAROKU_NO_AUTORUN` | — | Set to `1` to skip the startup run |
| `JAROKU_EVAL_CONCURRENCY` | `4` | Pool slots. Slot 0 is always the interactive run |
| `JAROKU_LIMIT_<PROVIDER>` | `16` (fake) / `2` (real) | Per-provider concurrent-run cap, e.g. `JAROKU_LIMIT_ANTHROPIC=4` |
| `JAROKU_JOB_TIMEOUT_MS` | `180000` | Per-eval-job wall-clock deadline |
| `JAROKU_JOB_ATTEMPTS` | `3` | Total attempts per job, including the first |
| `JAROKU_RETRY_BASE_MS` | `2000` | Base for exponential retry backoff |

### Models

| Variable | Default | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Planning, generation, editing, explain, judging |
| `JAROKU_GEN_MODEL` | `claude-haiku-4-5` | Generation |
| `JAROKU_PLAN_MODEL` | falls through to `JAROKU_GEN_MODEL` | Planning |
| `JAROKU_EDIT_MODEL` | `claude-haiku-4-5` | The fix loop |
| `JAROKU_EXPLAIN_MODEL` | `claude-haiku-4-5` | Explain answers |
| `JAROKU_JUDGE_MODEL` | `claude-haiku-4-5` | Eval scoring |
| `JAROKU_JUDGE_CONCURRENCY` | `4` | Concurrent judge calls |
| `JAROKU_JUDGE_ATTEMPTS` | `2` | Attempts per verdict |

The plan model falls through to the generation model on purpose: pointing generation at a
different model moves the plan with it, because the two phases describing the same build
should not disagree about who is doing the thinking.

### Runtime (set per run by the server; also usable by hand)

| Variable | Purpose |
|---|---|
| `JAROKU_PROVIDER` | `fake` (default) · `anthropic` · `openai` |
| `JAROKU_MODEL` | Model id. Unset → a cheap per-provider default |
| `JAROKU_RUN_ID` | Server-minted id so a run can be addressed before `run_start` races back |
| `JAROKU_RESUME_RUN_ID` | Resume an existing run from its durable checkpoint |
| `JAROKU_SEQ_OFFSET` | Where a resumed/branched segment's `seq` continues from |
| `JAROKU_BRANCH_CHECKPOINT_ID` / `_THREAD_ID` / `_EDIT_FILE` / `_EDIT_NODE` | Branch a new run from a parent's checkpoint, optionally with a state edit |

### Client

| Variable | Default |
|---|---|
| `VITE_JAROKU_WS` | `ws://localhost:4317` |

---

## Running things by hand

Everything the UI does through the server, you can do from a terminal. All commands run from
`runtime/`.

**Run an agent on the free dry-run model** — events (JSON, one per line) to stdout, logs to
stderr:

```bash
uv run python -m jaroku_runner example_agent "What time is it in Europe/Paris?"
```

**Run it on a real provider:**

```bash
JAROKU_PROVIDER=anthropic JAROKU_MODEL=claude-haiku-4-5 \
  uv run python -m jaroku_runner example_agent "How many words are in this sentence?"
```

**Run the hand-written fixture agent** (it traces itself, so it keeps the original pipeline
regression-testable):

```bash
uv run python -m test_agent.agent "What's the weather in Tokyo, and what's 17 * 23?"
```

**Introspect a graph** — prints exactly one JSON object, never runs the graph:

```bash
uv run python -m jaroku_runner.graph example_agent
```

**Pretty-print a trace as it streams:**

```bash
uv run python -m jaroku_runner example_agent 2>/dev/null | python3 -m json.tool --json-lines
```

---

## Tests

The test suites are plain `tsx` scripts with no test-runner dependency, covering the logic
where a bug would be silent rather than loud.

```bash
cd server
npm run typecheck        # tsc --noEmit
npm run test:protocol    # the file-emission stream parser, at every chunk boundary
npm run test:plan        # plan parsing + degradation + connector reconciliation
npm run test:pricing     # exact/prefix matching, cache multipliers, unpriced → null
npm run test:pool        # slot reservation, attribution, deadlines
npm run test:aggregate   # cost from steps, unknown vs free, partial-pricing flags
npm run test:retry       # transient vs deterministic failure classification
npm run test:judge       # rubric prompt construction + verdict parsing
npm run test:cleanup     # checkpoint sweeping (never touches interactive runs)
```

```bash
cd client
npm run typecheck
npm run test:plan-flow   # the plan → confirm → generate state machine
npm run test:note-kind   # rule vs note classification
npm run test:inline-code # inline code detection in prose
npm run test:title       # title truncation (never mid-word)
npm run test:export      # CSV/JSON export preserves every caveat
npm run test:csv         # RFC-4180 quoting
```

The client's test scripts invoke `../server/node_modules/.bin/tsx`, so install the server's
dependencies first.

---

## Developing for free (fixtures)

Every real generation, plan or edit costs money. `server/fixtures/` holds recorded model
responses that make the whole build path — planning, streaming, staging, validation, commit —
replayable at zero cost, chunked and paced so the UI behaves exactly as it would live.

| Variable | Replays |
|---|---|
| `JAROKU_GEN_FIXTURE` | A generation |
| `JAROKU_PLAN_FIXTURE` | A plan |
| `JAROKU_EDIT_FIXTURE` | An edit proposal |

Point one at a path that **does not exist** to *record* a fresh fixture from a real call.

```bash
cd server
JAROKU_GEN_FIXTURE=fixtures/support_bot.txt \
JAROKU_PLAN_FIXTURE=fixtures/plan-support-bot.txt \
npm run dev
```

Included fixtures:

| File | Purpose |
|---|---|
| `support_bot.txt` | A known-good generation. Should always pass validation. |
| `plan-support-bot.txt` | The matching plan, so plan → card → confirm → generate runs end to end for free. Select the **postgres** connector — the generation imports `tools/postgres.py`. |
| `rejected-tool-call-and-sql.txt` | A real response that shipped two genuine defects: it called `pg_query` directly and built SQL with an f-string. Should always be **rejected** — the regression test for rules 9 and 10. |
| `rejected-import-time-failure.txt` | Parses fine, `TypeError` on import. The regression test for the import check. |
| `edit-*.txt` | Edit-path fixtures: a no-op, a syntax error, a prompt tweak, a connector-bait attempt, a real limit. |

**Care with `JAROKU_PLAN_FIXTURE`.** A forgotten `JAROKU_GEN_FIXTURE` replays a canned
project you can see is wrong. A forgotten `JAROKU_PLAN_FIXTURE` feeds stale plan text into a
**real** generation, so the output is genuinely model-written but built to somebody else's
plan. The planner logs a loud warning for exactly this reason.

---

## Where data lives

| Path | What | Tracked? |
|---|---|---|
| `server/jaroku.db` | Traces (`runs`, `steps`) + eval control plane (`datasets`, `dataset_examples`, `rubrics`, `eval_runs`, `eval_jobs`, `eval_scores`) | No |
| `runtime/agents/<id>/` | A generated agent project — yours, editable, portable | No (except `example_agent`) |
| `runtime/agents/.staging/` | In-flight generations and edit proposals. Cleared on server start — a proposal interrupted by a shutdown is an orphan | No |
| `runtime/agents/.history/<id>/` | Per-agent version snapshots + `history.json`, powering Undo across reloads | No |
| `runtime/.checkpoints/` | Durable LangGraph checkpoints (`<run_id>.sqlite`) and pause control files | No |
| `runtime/.env` | Provider and connector keys | No |

Both SQLite stores share one database file on one connection — a single writer, and
aggregation can `JOIN` eval jobs against the frozen `steps` table directly.

**Checkpoint sweeping.** When an eval finishes, the resumable-checkpoint blobs its jobs left
behind are swept (the traces stay — only the pause/resume machinery goes, and nobody resumes a
finished eval job). On startup, orphans from evals whose sweep never ran are collected too.
**An interactive run's checkpoint is never swept** — it is exactly the thing you might come
back to branch from.

---

## Security notes

- **Keys never leave the server process.** They are read from `runtime/.env`, never logged,
  never echoed to a client, never written into a generated file. Both env loaders log key
  *names* only.
- **Path confinement everywhere.** Every path a model emits is validated: absolute paths,
  `..`, and null bytes are rejected. Agent ids are validated against
  `^[a-z][a-z0-9_]{0,63}$` — the same pattern enforced independently on the Python side, so
  a client-supplied id cannot traverse out of `agents/`.
- **Generated code is executed.** Validation imports the staged project, and running an agent
  executes it. That is inherent to the product — but it is why validation runs first, why the
  import is sandboxed to a 20-second timeout with stdout captured, and why connector
  templates are hand-reviewed rather than model-written.
- **The Postgres connector is read-only twice over** — a statement check *and* a read-only
  transaction — and f-string SQL is a hard validation failure, because it is an injection
  vector even against a read-only connection: a crafted input can widen a `SELECT` to rows
  the user was never meant to see.
- **The Gmail connector creates drafts only.** It never sends.
- **The Slack connector can post**, which is irreversible, and both the catalog description
  and the generation prompt say so explicitly.
- **The server binds to localhost.** It has no authentication and is not built to be exposed
  to a network. Don't put it on one.

---

## Troubleshooting

**`spawn uv ENOENT` / "could not read graph"**
`uv` isn't on the server's `PATH`. The server prepends `/opt/homebrew/bin`; if yours lives
elsewhere, start the server with an explicit `PATH`, or install uv where the shell that
launches the server can see it.

**`ANTHROPIC_API_KEY is not set (expected in runtime/.env)`**
Planning, generation, editing and judging all need it. Running agents on the dry-run provider
does not. Note that an env var already set in your shell always beats the file.

**`DatabaseSync is not a constructor` / `node:sqlite` not found**
Node is too old. You need 22+; 24 is what this is developed against.

**Every generation returns the same project**
`JAROKU_GEN_FIXTURE` is set and pointing at an existing file. Check the server log — it warns
loudly on every replay.

**"cannot modify the agent while a run is in progress"**
An interactive run *or* an eval job is reading the project's files right now. Wait for it, or
cancel the eval.

**A generation was rejected**
The problem list names the rule and the file:line. That is the system working — the staged
project was discarded and whatever was there before is untouched. Re-plan with the problem
addressed, or ask for the same agent more specifically.

**The trace is empty but the agent "ran"**
Check stderr in the server console. `run_start` is emitted before the agent is even imported,
so a completely empty trace usually means the subprocess never spawned.

**Branching says "no durable checkpoint for that step"**
That run predates checkpointing, or its checkpoint was swept (which happens for finished eval
jobs). Re-run the agent interactively and branch from the new run.

---

## License

Apache License 2.0. See [LICENSE](LICENSE).

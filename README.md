# Jaroku

**A local-first workbench for building, running, tracing, editing and evaluating AI agents.**

You describe an agent in plain English. Jaroku plans it, writes it as a real LangGraph
project on your disk, runs it, and shows you every LLM call, tool call, routing decision and
state mutation it made — with real token counts and real dollar costs. Then you can pause a
run mid-graph, fork it from any step with an edited state, ask for a code change and review
the diff before it lands, and fan the whole thing out across providers to compare quality,
latency and cost side by side.

The generated projects import nothing from Jaroku. They are plain LangGraph you can copy out
of the repo and run yourself.

```
  you ──▶ plan ──▶ generate ──▶ run ──▶ trace ──▶ edit ──▶ eval ──▶ deploy
           │          │          │        │        │        │        │
        review     validated   traced   stepped  diffed  compared  to YOUR
        before     before      live     through  before  across    Railway
        writing    landing              & forked applying providers account
```

Once there is more than one agent and more than one session, four full-screen destinations answer
four different questions — [Threads](#threads) is the conversation, [Agents](#agents) is the
artifact, [the Inbox](#the-inbox) is what is waiting on you, and [Activity](#activity) is what the
workspace is doing. It runs the same way for one person on a laptop and for a
[team](#workspaces-and-teams) sharing a workspace, with [per-agent access](#per-agent-access) for
the case where somebody should be able to fix one agent and not every other one.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [First run](#first-run)
- [Try it in 60 seconds](#try-it-in-60-seconds)
- [Repository layout](#repository-layout)
- [Architecture](#architecture)
- [The event schema](#the-event-schema)
- [The Python runtime](#the-python-runtime)
- [The agent contract](#the-agent-contract)
- [The Node server](#the-node-server)
- [The build pipeline: plan → generate → validate](#the-build-pipeline-plan--generate--validate)
- [The fix loop: propose → apply → undo](#the-fix-loop-propose--apply--undo)
- [Threads](#threads)
- [Agents](#agents)
- [The Inbox](#the-inbox)
- [Activity](#activity)
- [The composer](#the-composer)
- [Debug depth: pause, resume, branch](#debug-depth-pause-resume-branch)
- [The eval engine](#the-eval-engine)
- [Cost accounting](#cost-accounting)
- [Connectors](#connectors)
- [MCP servers](#mcp-servers)
- [GitHub](#github)
- [Deploying an agent](#deploying-an-agent)
- [The React client](#the-react-client)
- [WebSocket protocol](#websocket-protocol)
- [Configuration](#configuration)
- [Running things by hand](#running-things-by-hand)
- [Tests](#tests)
- [Developing for free (fixtures)](#developing-for-free-fixtures)
- [The tenancy model](#the-tenancy-model)
- [Storage isolation](#storage-isolation)
- [Sandboxed execution and the distributed control plane](#sandboxed-execution-and-the-distributed-control-plane)
- [Queueing, fairness, and per-workspace limits](#queueing-fairness-and-per-workspace-limits)
- [Cost metering, budgets, and billing](#cost-metering-budgets-and-billing)
- [Plans, tiers and entitlements](#plans-tiers-and-entitlements)
- [Connector OAuth and the credential vault](#connector-oauth-and-the-credential-vault)
- [Hardening, abuse, data lifecycle, observability, deploy](#hardening-abuse-data-lifecycle-observability-deploy)
- [Authentication and membership](#authentication-and-membership)
- [Workspaces and teams](#workspaces-and-teams)
- [Per-agent access](#per-agent-access)
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
| **Unreviewed code is labelled as such** | Connectors are audited and copied in verbatim. An [MCP server](#mcp-servers) is third-party code nobody here has read, so its tools carry a badge everywhere they appear, an agent only gets the specific ones it was granted, and a high-impact one stops for your confirmation before it runs. |
| **A control that does nothing is worse than no control** | A stored setting has to change what the machine does, or it is a lie the UI keeps telling. A read that fails answers on its own channel rather than leaving an empty state that means "there is nothing here". A button with no handler fails `test:dead-controls`, and an action name with no case fails the typecheck. |

---

## Requirements

| Tool | Version | Why |
|---|---|---|
| **Node.js** | **22+** (24 recommended) | The server uses the built-in `node:sqlite` module — no native build step, no `better-sqlite3`. |
| **Python** | **3.12+** | Pinned in `runtime/.python-version`. |
| **uv** | any recent | The server spawns every agent as `uv run python -m jaroku_runner …`. Install from [astral.sh/uv](https://docs.astral.sh/uv/). |
| **Anthropic API key** | optional | Needed for planning, generation, editing, explain and the eval judge. Everything else — running agents on the dry-run provider, the trace pipeline, the graph view, the whole UI — works with no key at all. |
| **Railway CLI** | optional | Only to deploy. Jaroku uses it to upload a project; everything else about a deploy goes over Railway's API. `brew install railway` or `npm i -g @railway/cli`. |

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
uv sync --extra connectors   # optional: Gmail / Slack / Postgres SDKs, and the MCP client
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

You can skip this and add keys in the app: the first run walks you through it, and Settings in
the sidebar opens the same form afterwards. Either way the key ends up in the file below, and
nothing but the local server process ever reads it.

To do it by hand, create `runtime/.env`:

```bash
# Planning, generation, editing, explain, and the eval judge all use this key.
ANTHROPIC_API_KEY=sk-ant-...

# Only needed to run agents on the OpenAI provider.
OPENAI_API_KEY=sk-...

# Only needed to run agents on Gemini. GOOGLE_API_KEY and not GEMINI_API_KEY, because that is
# the name langchain_google_genai reads — and it is NOT the Gmail connector's OAuth app, which
# is JAROKU_OAUTH_GOOGLE_CLIENT_ID / _SECRET below and will not run a model.
GOOGLE_API_KEY=...

# Only needed by the connectors you actually select.
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
# Google Calendar's own three, not Gmail's — the two are separate connections under one OAuth
# app, so revoking either leaves the other working, and a project generated with only Calendar
# asks for only these.
GCAL_CLIENT_ID=
GCAL_CLIENT_SECRET=
GCAL_REFRESH_TOKEN=
SLACK_BOT_TOKEN=
# A RESTRICTED key with read permissions only (rk_live_… / rk_test_…). A full-access sk_live_
# key is refused at save: the connector's read-only posture is enforced twice, and this is the
# half Stripe enforces rather than the half our template does.
STRIPE_SECRET_KEY=rk_live_...
DATABASE_URL=postgres://...
# The HTTP connector's allowlist IS its safety model: comma-separated EXACT hostnames, no
# scheme, no path, no port, no wildcards. An empty value refuses every request.
HTTP_ALLOWED_DOMAINS=api.example.com,hooks.example.net
# Optional. Sent on every HTTP-connector request — either a bare value or a whole header line.
HTTP_AUTH_HEADER=

# MCP server credentials are written here by the MCP panel, never by hand:
# JAROKU_MCP_<SERVER>_TOKEN=
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

Open **http://localhost:5173** and sign in. With no auth provider configured the server runs
its own [local issuer](#the-local-issuer): the sign-in screen asks for an email address and no
password, mints a real token, and everything downstream verifies it exactly as it would a
provider's. No cloud account, no Redis, no Docker.

There is also a dependency-free fallback UI served directly by the relay at
**http://localhost:4317** (`server/debug-client.html`) — useful for confirming the pipeline
is alive without running Vite. It performs the same three-request exchange the React client
does, so it works out of the box in local mode.

On startup the server fires one run of the hand-written fixture agent so you see a live trace
immediately. Set `JAROKU_NO_AUTORUN=1` to suppress it.

**Or run the whole thing in a window.** `npm install && npm run tauri:dev` at the repository root
starts the same two processes inside a desktop shell — the same `server/src/index.ts` from your
working tree, the same Vite bundle, the same localhost WebSocket between them. It is a host rather
than a port: nothing under `server/` or `client/` imports from it, and the two commands above stay
the development path. See [docs/tauri.md](docs/tauri.md) for the architecture, the per-platform
builds, where code-signing certificates go, and a section separating what has been run from what
has not — `tauri dev` and `tauri build` exercise different halves of the shell, and only the first
has been earned so far.

---

## First run

The first time you open the UI on a machine, Jaroku walks you from nothing to a live trace in
four screens, then gets out of the way permanently.

1. **Welcome** — what the product does, one button.
2. **Connect a provider** — Anthropic and/or OpenAI, with the key's destination stated before
   the field that wants it. **Test connection** is free and writes nothing; **Save** writes.
   There is a real skip: the dry-run path costs nothing and exercises the whole trace/graph/UI.
3. **First prompt** — the ordinary composer, alone, with a few real examples. With an Anthropic
   key those are agents to build; without one they are inputs for the bundled `example_agent`,
   because planning and generation go through Anthropic while *running* does not.
4. **First run** — the sidebar arrives when a plan card does, the right panel when files start
   streaming, and the Trace tab when the first run does. Nothing appears before it has something
   in it.

Reaching `run_end` ends onboarding. The three-column app is then just the same layout with the
last two columns mounted — no reload, no reset, and it never appears again.

**Whether you have onboarded is a fact about your account**, not about this browser:
`users.onboarded_at`, reported as `user.onboarded` on `/v1/auth/session`. So it follows you to a
second device and it does not follow the *machine* to the next person who signs in on it — see
[onboarding belongs to the person](#onboarding-belongs-to-the-person-not-the-browser) for why
that distinction had to be made explicit.

Where you are *up to* stays local, under `jaroku.onboarding.<user id>` (`onboardingStep`,
`onboardingHintsShown`), so a reload mid-flow resumes rather than restarting. A workspace that
already contains a generated agent is treated as onboarded and skips it.

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

**Give it a third-party tool.** Open the **MCP** tab and connect a server — `npm run mock:mcp`
in `server/` starts a fixture one at `http://127.0.0.1:8931/mcp` if you don't have a real
endpoint handy. You'll see exactly what it says it can do, each tool classified as read-only
or high-impact *with the reason*. Tick the ones an agent should have, plan, generate, and run:
the read-only tools just run, and the high-impact ones stop and show you the arguments before
they go anywhere.

**Ship it.** Open the **Deploy** tab, add a Railway account token, pick a real provider, and
look at the list of credentials it is about to hand over — names only, with whether each one is
set on this machine. Press Deploy and watch it package the project, create a Railway project and
service, set the variables, upload, build and publish. You end with a URL and a bearer token
shown once. The agent runs in **your** Railway account, on **your** credentials; Jaroku hosts
nothing.

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
│   │   ├── models.py          # provider selection (fake / anthropic / openai / google)
│   │   ├── fake.py            # schema-driven dry-run model — free, deterministic
│   │   ├── debug.py           # checkpointed driver: pause / resume / branch
│   │   └── graph.py           # static topology introspection for the Graph view
│   │
│   ├── tool_templates/        # reviewed connectors, copied verbatim into projects
│   │   ├── catalog.json       # the registry: ids, env, tool signatures
│   │   ├── gmail.py  google_calendar.py  slack.py
│   │   ├── postgres.py  stripe_connector.py  http_connector.py
│   │   └── mcp_bridge.py      # calls third-party MCP servers; the manifest is the grant
│   │
│   ├── test_agent/            # hand-written 2-tool fixture; traces itself
│   └── agents/                # generated projects land here
│       └── example_agent/     # hand-written reference implementation of the contract
│
├── server/                    # Node/TypeScript: the control plane
│   ├── migrations/            # forward-only, checksummed, one numbering, two dialects
│   ├── src/                   # (see "The Node server" below)
│   │   ├── auth/              # who is asking, and what they may do
│   │   └── http/              # the small HTTP surface beside the socket
│   ├── fixtures/              # recorded model responses for free development
│   │   ├── mcp/mockServer.ts  # a fixture MCP server, so all of it is testable for free
│   │   ├── github/mockGithubApi.ts  # a fixture GitHub, App flow and check runs included
│   │   ├── fly/mockFlyApi.ts  s3/mockS3.ts
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
│  four destinations · one composer · eleven right-panel tabs               │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │  one WebSocket, many logical channels
                                │  trace · gen · edit · debug · eval · reply · inbox · activity · access …
┌───────────────────────────────┴───────────────────────────────────────────┐
│  NODE SERVER — process manager + relay + store          localhost:4317    │
│                                                                           │
│   interactivePool + evalPool (separate capacity, neither starves the other)│
│   Dispatcher → per-workspace lists → round-robin admit → leased caps      │
│   Planner → Generator → Validator → atomic swap                          │
│   Editor  → staged proposal → diff → apply/undo with linear history      │
│   EvalRunner → persisted job queue → per-provider caps → judge           │
│   McpRegistry → handshake → classify → the agent's manifest              │
│   TraceStore + EvalStore + McpStore  (one SQLite file, one writer)       │
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

### Putting an agent away, and giving it a name

**Archived, never deleted** — the answer threads got, for the same reasons. An agent's versions,
runs, traces, evals and costs are the record every past comparison and every invoice line points at,
so "tidy the sidebar" must not be the same button as "destroy the history". Archiving takes an agent
out of the lists that offer work — the sidebar, the eval picker, the composer's targets, the deploy
form, every sweep — and out of nothing else: the row still resolves by id, so nothing pointing at it
dangles, and its threads stay attached rather than rendering `(deleted)`. It is one press back, from
the sidebar's **Archived** tab, which only appears when there is something in it.

A **deployed** agent is refused: archiving one would take it out of every list while it is still
serving traffic in your hosting account, which is the same trap "forgetting a deployment does not
stop the thing it described" is careful about. Cancel or forget the deployment first.

**A rename changes the name, never the slug.** The slug is the identity: the directory on disk, the
key `datasets.agent_id` and `eval_runs.agent_id` hold, the working directory of every job's
subprocess, and the id every past run row names. `display_name` is the label the sidebar and every
thread row render, and it is the only thing a rename touches — and it sets
`display_name_is_custom`, which is what stops the next disk reconciliation overwriting it from
`jaroku.json`. That is exactly the trap `threads.title` was in, solved by the column
`title_is_custom` already established; an agent nobody has renamed still follows the file, so
editing `jaroku.json` by hand is still how you rename by hand.

None of this existed until v0.3.0. There was no `deleteAgent`, `renameAgent` or `archiveAgent`
anywhere — no command, no route, no repository method, no affordance — while every other resource in
the product had a lifecycle, and the Threads specification devoted a section to what happens when an
agent is deleted and used that deletion as the reason not to build a thread-delete confirmation. The
only way an agent left was the disk sweep, which refuses to touch a row with a published version:
every agent the product actually builds has one, so none of them could be removed by any means short
of SQL.

---

## The Node server

| File | Responsibility |
|---|---|
| `index.ts` | Wires the pipeline: RunPool → TraceStore → WsRelay. Owns run lifecycle, pause/resume/branch, and the eval command surface. |
| `wsRelay.ts` | HTTP + WebSocket transport. Serves the fallback client, defines every command and channel type. Authorises the upgrade, capability-checks every command, answers reads locally, forwards mutations to the app. |
| `http/router.ts` | The HTTP surface: one error shape, a body cap on everything, a request id on every response, and a log line that redacts anything that grants access. |
| `http/health.ts` | `/healthz` (liveness, touches nothing) and `/readyz` (readiness, probes the database under a deadline). Two different questions. |
| `auth/config.ts` | Which issuer this server trusts — or, with none configured, the local one. Refuses to start under `NODE_ENV=production`. |
| `auth/jwks.ts` | The issuer's signing keys, cached, with a rate-limited forced refresh and negative caching. Asymmetric keys only. |
| `auth/jwt.ts` | Compact-JWS verification. `alg: "none"` and every symmetric algorithm are absent from the allow-list rather than branched around. |
| `auth/localIssuer.ts` | The development issuer: real RS256, real tokens, no password. |
| `auth/verifier.ts` | Bearer token → `AuthContext`. Distinguishes "this token is bad" from "we cannot check it right now". |
| `auth/resolve.ts` | `AuthContext` + a requested workspace → `TenantContext`, from a membership row and nowhere else. The line between authenticated and authorised. |
| `auth/capabilities.ts` | The role matrix, as data, plus the command → capability map a test proves exhaustive. |
| `auth/tickets.ts` | The single-use, hashed, thirty-second credential a socket is opened with. |
| `auth/origin.ts` | The origin allowlist. WebSockets are not covered by CORS; this is the CSWSH defence. |
| `auth/socketAuth.ts` | What the relay calls to decide whether a socket may exist, and in which workspace. |
| `auth/session.ts` | `/v1/auth/*`, `/v1/ws-ticket` and `/v1/invites/accept`. |
| `db/repositories/tickets.ts` | The ticket store that works across replicas: the delete is the decision. |
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
| `mcpStore.ts` | MCP registry tables (`mcp_servers`, `mcp_tools`) beside the frozen schema. Stores env var *names*, never credentials. |
| `mcpClient.ts` | The capability handshake against a remote server. Every wait and every cursor is bounded. |
| `mcpImpact.ts` | Classifies a discovered tool `high`/`low`, with its reason. A ratchet: an untrusted signal may only raise. |
| `mcpRegistry.ts` | Connect / re-discover / remove. A failed refresh never destroys a working tool list. |
| `mcpManifest.ts` | Builds `mcp_tools.json` — the grant a generated agent's bridge honours. |
| `deployStore.ts` | Deploy control-plane tables (`deployments`, `deployment_logs`) beside the frozen schema. Stores env var *names*, never credentials. |
| `deploySecrets.ts` | Which credentials a deploy needs, by name; reads their values at the moment of use; scrubs them out of every build-log line. |
| `dockerfile.ts` | Pure synthesis: `jaroku.json` → the Dockerfile, `.dockerignore` and `pyproject.toml` an image is built from. |
| `deployArtifacts.ts` | Writes those four files into a project, staged and atomic-swapped. A failure leaves the project untouched. |
| `railwayApi.ts` | Railway's GraphQL control plane. Every call bounded, every failure classified, every message scrubbed. |
| `railwayCli.ts` | `railway up` — the one job the API cannot do. Token via the child's environment, never its arguments. |
| `deployManager.ts` | The orchestrator: refuse → record → package → provision → variables → upload → follow → publish. |
| `envWriter.ts` | The only code that writes `runtime/.env`. Refuses anything it cannot read back identically. |
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
| `sandbox/runSandbox.ts` | The `RunSandbox` interface, and `sandboxKind()` reading `JAROKU_RUN_SANDBOX`. |
| `sandbox/flySandbox.ts` / `flyApi.ts` | The hosted `RunSandbox`: one Fly Machine per run, and the bare Fly Machines API client underneath it. |
| `sandbox/codeCheck.ts` | The narrower `CodeCheckSandbox` interface — what the import check and graph introspection run through. |
| `sandbox/eventBus.ts` | `RunEventBus`: what a hosted run's control-plane HTTP routes push into, and what a hosted `RunSandbox` re-emits as its own events. |
| `sandbox/controlPlaneRoutes.ts` | The four HTTP routes a hosted run's runner speaks to: trace push, control push, control long-poll, MCP confirm. |
| `sandbox/runTokens.ts` | Minting and verifying the self-contained token that scopes those routes to one run. |
| `sandbox/egressPolicy.ts` / `databaseUrl.ts` | What a sandbox may reach, computed and pinned per run; and the SSRF-closing validation a workspace's own `DATABASE_URL` goes through first. |
| `sandbox/backpressure.ts` | Bytes/line/rate caps shared by a local run's stdout and a hosted run's trace push. |
| `sandbox/image.ts` | Enforces that a sandbox image reference is pinned by digest, never a tag. |
| `sandbox/traceIngestMetrics.ts` | Counts what the trace route drops rather than ingests. |
| `queue/dispatcher.ts` | The fair dispatcher: enqueue, admit, ack, reap. What the rest of the server calls. |
| `queue/backend.ts` | The `QueueBackend` interface — `InMemoryQueueBackend` (default) and `RedisQueueBackend` (one Lua script per atomic operation). |
| `queue/jobs.ts` | Every job class as data: concurrency, timeout, retryability, and which are actually queued. |
| `queue/semaphores.ts` | Named leased caps — per workspace, per provider. The descendants of slot 0 and `JAROKU_LIMIT_<PROVIDER>`. |
| `queue/workerLoop.ts` | The admit loop a worker process runs, and the drain window that hands stragglers back. |
| `queue/eventBridge.ts` | Cross-replica broadcast fan-out over Redis pub/sub, with the self-echo defence. |
| `worker.ts` | The second entrypoint (`npm run worker`). Boots, requires Redis, drains nothing yet — see [queueing](#queueing-fairness-and-per-workspace-limits). |
| `billing/usage.ts` | The eight metered kinds, the two payers, and the meter that turns steps and platform calls into ledger rows. |
| `billing/plans.ts` | Every plan LIMIT, as data. Not the `plans` table — see [what each plan limits](#what-each-plan-actually-limits). |
| `billing/balances.ts` | The atomic claim against a balance, the hold row it writes, and the sweeper that reclaims what nobody released. |
| `billing/gate.ts` | The one place that answers "may this workspace start this", and the sentences it refuses with. |
| `billing/platformKey.ts` | The kill switch, the plan gate and the separate ceiling on what the platform pays. |
| `billing/providerKeys.ts` | Where a workspace's own key is stored, which run may receive it, and whether it may pay for platform calls. |
| `billing/stripe.ts` / `subscriptions.ts` | The signature check and the checkout call; and the state machine that decides when a plan actually moves. |
| `billing/rates.ts` / `storage.ts` | What sandbox time and storage cost this deployment, and the hourly sampler that meters bytes held. |
| `http/billing.ts` | The two HTTP surfaces: checkout, and the webhook whose signature is its authentication. |

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

## Threads

A **thread** is one build session: what somebody asked for, what it produced, what it cost, and
whether anything in it is still waiting on a person. It is the answer to a question the sidebar
could not answer — *which of the things I started need me?* — and it is a full-screen destination
rather than a fourth list in a panel, because triage is what you open it to do.

**One agent carries several independent threads.** `api_gateway` can have a rate-limiting session
with an unapplied diff, an OAuth session mid-run, and a finished one from Tuesday, and they do not
share a conversation, a cost, or a state. Every command that starts work carries the thread it
belongs to; a command that carries none falls back to the agent's most recently active session,
which is what keeps a client that has not been updated working.

**Status is derived, never stored as an input.** The `threads.status` column is a cache; the
authority is `threadStatus.ts`, a pure function over facts the server already holds:

| Status | Means | Fragment on the row |
|---|---|---|
| `✕ errored` | The thread's last operation ended in error and nothing was retried after it | `3 failed steps` |
| `◆ needs_you` | An unapplied diff, a plan awaiting a decision, a refused generation, a high-impact MCP call halting a graph, or a failed step nobody retried | `diff pending +42−11` |
| `● running` | A run, generation or eval is in flight | `eval 34/120` |
| `○ idle` | Nothing outstanding | `deployed`, or nothing |
| `⊘ archived` | Set aside. Leaves the default list, keeps every byte | — |

Precedence is that order, and each step is a decision: `needs_you` beats `running` because a run
ends by itself and an unapplied diff does not, which is exactly what the sidebar's Threads badge
counts. **Ownership comes from `thread_items`; liveness comes from whoever owns the live thing** —
`runs.status`, `eval_runs.status`, the editor's proposal map, the planner's slot, the MCP confirm
queue. A proposal does not survive a restart, so after one no thread claims a pending diff and the
list says idle, which is true: there is no diff left to apply.

**A thread is archived, never deleted.** There is no `deleteThread` command, no method on the
store, and `test:thread-archive` audits every server source file to keep it that way. A thread
holds what was thought and what it cost, and that record outlives the artefact — the same reason
a dataset is soft-deleted and an agent is soft-deleted. Retention sweeps the join rows that point
at runs it has already removed, and nothing else.

**Cost is per session, and it moves while work does.** `usage_events` gains a `thread_id` for the
platform's own calls (plan, generation, edit, explain); everything else attributes through its run.
A running thread's figure is the ledger's total plus the per-step costs that have arrived since —
off the `trace` channel for an interactive run, off the `eval` channel's progress events for an
eval, which are kept off `trace` so a sweep cannot steal the timeline's focus. An eval also knows
its denominator, so its row projects: `$0.82 → ~$2.90`, with the tilde because an estimate must
never be shown with the confidence of a final figure.

**An agent's deletion leaves its threads standing.** They keep pointing at it and the row renders
`stripe_webhook (deleted)`, dimmed, because the deletion is soft and reverses itself when the
directory comes back. `agent_name_snapshot` is what survives a *hard* delete, where the link
cascades away and there is nowhere left to read the name from.

Two tables, both additive: `threads` (migration 043) and `thread_items` (044). Nothing about the
frozen event schema moves for any of it — a run does not gain a field, and no thread appears in a
trace.

---

## Agents

Threads is the conversation. **Agents is the artifact.** It is the second of the four sidebar
destinations and it answers four questions and nothing else: what agents exist here, what can each
one touch, what version is live and is it drifting from what is deployed, and is it healthy. The
live trace, the plan card and the diff card are deliberately not in it — they live where they
already live, one tab away.

**A card is a glance, not a dashboard.** Every element on it is one line or one badge, and the
densest of them is the tag row, which is the main reason forty agents are scannable at all.

| Family | Members | Colour |
|---|---|---|
| Attention | `Creds missing` · `High-impact tools` · `Cost unknown` | Rose |
| Runtime | `Idle` · `Running` · `Generating` · `Deploying` · `Paused` | Amber for the three that are activity, grey for the two that are not |
| Deploy | `Live` · drift, as `v5 → v9` | Green, rose when drifted |
| Health | `Degraded` · `Failing` · `Unverified` | Rose, grey for unverified |
| Lifecycle | `New` · `Draft` · `Forked` · `Archived` | Blue, grey for the inert two |

Two rules keep the row from becoming noise, and both live in `lib/agentTags.ts` as a pure function
rather than in the card's JSX: **at most three tags render**, followed by a `+n` chip, with
precedence Attention > Runtime > Deploy > Health > Lifecycle — an agent that is both failing and new
shows `Failing`, because the problem outranks the novelty — and **one tag per family**, resolved
before the row is assembled, so `Idle` and `Running` can never appear together.

**A warning is never amber.** v0.2.2 redrew the wordmark because an amber outline read as a warning
sign in an app where amber already means running, and that rule holds here without exception:
`Creds missing` is rose, and so is every other problem. `test:agent-tags` asserts it rather than
trusting a comment.

**Runtime and Health are separate axes and never collapse.** "Idle · Failing" is a real and
important state — nothing is running and the last four runs failed — and a card that showed one tag
for both would be lying about the agent.

**Health is the validator's verdict on the live version AND a rolling error rate**, because either
alone lies. The validator alone would call an agent healthy while every one of its last ten runs
failed; the error rate alone would call a hand-dropped project healthy for never having been run.
The validator's verdict costs nothing to read: it is the gate on publishing, so a version whose
`source` is `generation`, `edit` or `deploy` passed it by construction, and `import` — the backfill
and the hand-dropped directory — is what `Unverified` means.

**The gradient on a card is a pure function of `agents.id`.** FNV-1a over the uuid, modulo an
explicitly sorted list built at build time (`scripts/gen-agent-art.mjs`), so the same agent shows the
same gradient on every replica, for every member of the workspace, forever. Sorting is not a detail:
directory iteration order is not stable across platforms, and the sort order *is* the mapping.

**The whole grid is one bounded set of reads.** Per agent the card needs a thread count, a 7-day run
count and spend, a last-run time, its latest session's title and last turn, health inputs, deploy
state, version drift and a missing-credential count — and the number of statements that costs does
not grow with the number of agents. Each read is grouped or windowed in the database and joined in
memory; `test:agent-grid` instruments the driver and asserts the count for one agent equals the count
for forty, which is the only version of that claim worth having.

**A credential is a NAME, everywhere.** `required_env` against `secret_refs.configured` produces a
list of names, and there is no field on the wire shape a value could travel in — which is what makes
the card's warning line, the Capabilities tab and §5.5's copy-to-clipboard safe by construction
rather than by discipline. `test:agent-context` asserts it by the same pattern that keeps a known
secret out of a log sink.

**The detail is a tab of the right panel, not a fourth column.** The composer keeps the centre
unchanged; the surface splits into the artifact (overview, version history, file browser) and six
tabs (Capabilities · Health · Deploy · Evals · Threads & runs · Access). Reading it as a fourth
column would have put the trace out of reach for anybody who arrived from the Agents tab, when the
trace is only out of scope *for* that tab. Access is absent in a personal workspace, where every
section of it would be about a set of one — see [Per-agent access](#per-agent-access).

**Capabilities is where an agent's MCP grants are changed**, and it is the only place they can be.
`setAgentTools` carries the **whole set** rather than an add or a remove: a grant is a
least-privilege decision and its honest unit is "these tools and no others", where two tabs each
sending an add would produce a set neither of them chose. Every ref is resolved against the registry
before it is written, so a client cannot grant a tool this workspace has not connected — and sending
the refs that still resolve is how a grant whose server has left the workspace gets removed.

**Version history is a render, not a query.** Migration 014 already put the instruction, the summary,
the per-file diff stat and the undone flag onto the version row. Restoring an old version **publishes
a new one carrying its files** — it never moves `current_version` backwards, which would rewrite the
history the request was made from and leave the pointer on objects a retention sweep is entitled to
consider superseded. Publishing the *files* rather than pointing at the old manifest is what makes
the new version readable at all: a key carries the version it was written under, so a manifest
copied onto a new number names paths that only exist under the old one. The restored version is then
materialised to `runtime/agents/<slug>`, because that directory is what a local run spawns from and
what a deploy uploads.

**Fork copies the connectors and the current version's files, and resets MCP grants to zero.**
Copying the grants would silently re-grant high-impact third-party tools to a brand-new agent
without anybody ticking a box, and the whole MCP design rests on access being granted per tool,
deliberately. The Capabilities tab is where the fork's own grants get filled, which is what makes
that notice sensible advice.

The **files** are published under the fork's own id rather than having the manifest copied onto it.
An object's key is per agent — `ws/<workspace>/agents/<agentId>/v<n>/<path>` — so a manifest handed
across an agent boundary names a prefix nobody wrote: the row, the version list and the byte total
are all correct and every read of the content throws. `addVersion` is right for a *restore*, where
the objects live under the same id; `publish` writes the row and the objects together, which is the
invariant it exists to hold.

One migration, and it adds no column: `048_agents_grid` is an index on
`threads (workspace_id, agent_id, last_activity_at DESC)`, because the card's current-work line and
the grid's default sort are the same question and neither of 043's two indexes answers it.

---

## The Inbox

Threads is the conversation, Agents is the artifact, Activity is what happened, and **the Inbox is
what is waiting on you.** It is the third destination, and the one that shrinks as you work.

Three laws hold it up, and each is enforced by something other than a comment.

**Every item has exactly one owner-action.** "A run failed" is Activity. "A run failed and nobody
has opened the trace" is the Inbox. If there is nothing a person could do about it, it does not
belong here.

**Every item dies on its own.** Each type declares a *resolve predicate* the server evaluates
independently of any user action — so setting a missing credential from the Agents tab, from a
thread, or from a script nobody has written yet clears the card with nobody dismissing anything. An
item that left because a button was pressed is an item that stays when the same fix arrives by
another door, and an Inbox that shows stale items is dead in a week.

**Items collapse.** Forty failed runs is one item with a count of forty, deduplicated at write time
on a key in the database rather than by a query that groups afterwards.

**Sixteen item types, as one typed registry.** Each entry declares its severity, its subject, how it
is produced, its icon, its action set, the sentence its card reads — and, load-bearing, the
predicate. The trigger that creates an item and the condition that removes it sit three lines apart
on purpose: a file apart they drift, and the type quietly becomes one that can be raised and never
cleared. Adding a seventeenth is one entry and no line in the sweep, the store, the channel or the
board.

**Two generators, because two kinds of item exist.** *Event-driven* ones hang off moments the
control plane already emits — a run failing, a deploy failing, an eval finishing, an MCP server
changing status. *Derived* ones have no event to hang off, because each is a **comparison between
two states that are both simply true**: a name in `required_env` with no configured secret, a
deployed version behind the current one, a server that last answered a day ago, spend three times
its own average, a high-impact grant with the confirmation gate off. Nothing was added to the frozen
event schema for any of it.

**Three verbs, and they stay three.** Resolve is shared, because the problem is. Snooze is personal
and *returns* — evaluated at read time, so there is no job that can fail to run and leave work away
forever. Dismiss is personal and does not return. Collapsing any two would break something the
specification spends a section on: a dismissal that resolved would clear a teammate's board, and a
snooze that vanished would be a slower dismissal.

**The reconciler is what makes Law 2 real.** Idempotent by its own `WHERE`, workspace-scoped one at
a time through the repository layer, safe against concurrent replicas on an advisory lock that
*tries and gives up* rather than queueing, and constant in the number of agents — one aggregate pass
plus two statements, asserted by counting them for two items and for forty.

Cards carry their fixes inline. Twenty-nine action names route through one dispatcher, and it is
**exhaustive**: a new `InboxActionName` fails the client typecheck rather than shipping as a glyph
that does nothing. An action the client cannot yet run is declared in `UNIMPLEMENTED_ACTIONS` and
therefore **not rendered**, so the card falls through to its next-best fix rather than offering a
control that closes a menu and changes nothing.

---

## Activity

The fourth destination, and **the only one that writes nothing.** Cross-agent, aggregate,
historical, read-only: what this workspace is doing.

It inherits the leftover axis, and that inheritance is the whole design. Everything per-agent
already lives in the Agents detail pane; everything actionable already lives in the Inbox. So
Activity gets exactly what is left — and the consequence is enforced by an **absence** rather than
by a rule anybody has to remember: *the `activity` channel has no mutating command.* Every other
tab's relay code carries a set of them; this one carries none, so the next person who wants a button
that changes state has to add a command first and will find nothing to put it beside.

**One window, resolved once, handed to every module.** 24h / 7d / 30d, chosen in the header and
remembered per workspace, with every card stating its own window in its context line so a screenshot
is never ambiguous. That is not tidiness: cross-highlighting is only coherent because all four
participating modules are looking at the same seconds, and six aggregates that each resolved their
own window would be four lenses onto four moments.

**Ten aggregates, one grouped query per module, none of them moving with the number of agents.** The
leaderboard's statement count is asserted equal for one agent and for forty, the way the Agents
grid's is — a leaderboard is the most natural place in the product to write an N+1, because every
row wants a per-agent figure.

Four honesty rules, each of which is a bug this product has shipped once and each of which fails
*silently* on a card built to be screenshotted: a crashed run still spent money on its completed
steps; cache reads bill at the cached rate; **an unpriced model is unknown and never `$0`**; and
cost is summed from what was spent, never from `runs.cost`. There is no global "up is bad" rule
either — spend up is bad, tokens up is neutral, latency down is good — so each metric declares its
own polarity and every badge reads it.

The feed is keyset-paginated rather than offset-paginated, and the suite proves why by scrolling a
page, **inserting rows above the cursor**, and scrolling again: an offset repeats rows it already
showed and skips ones it never will, silently, on a table written to by every run, deploy and step.

---

## The composer

The right panel inspects; the middle panel acts. One rule governs every decision in the composer,
and it is the reason several obvious shortcuts were not taken: **it gathers intent and never
performs privileged actions.** Attaching a GitHub commit is context. *Pushing* to GitHub is a
confirmed, audit-logged action that lives in the GitHub panel. Blurring that line is how a
trust-first product quietly stops being one.

**One bottom control bar, seven controls, in a fixed order.** ⊕, fullscreen, effort, the permission
shield and the connector deck pack left; the model selector, the Chat/Test toggle, mic and send pack
right; one spacer absorbs the difference. Deliberately *not* `space-between` — the deck is absent
with zero connectors and the effort control is hidden on a non-reasoning model, and spreading the
row would move every button each time one of them disappeared.

### ⊕ Attachments

Five sources behind one picker — files, runs, dataset cases, tool schemas, GitHub references —
server-searched and **server-priced**, because a client-supplied token estimate would let any
request through by claiming to be small. A source with nothing behind it is *hidden rather than
disabled*: an empty menu item that always fails is worse than no item.

The refs ride the command that creates the turn rather than a second round trip, because at Send the
turn does not exist yet — the server writes the `thread_items` row. `attachTurn` is one
implementation of the cap (existing *plus* arriving), the server-side re-measurement, the budget
check *before* the write, and the all-or-none transaction; the HTTP route and the dispatch both call
it. Resolved content then goes into the prompt: a persisted ref nothing reads is a record, not a
feature.

A file's ref pins a `version_id`, so an attachment of v3 stays an attachment of v3 after v4
publishes. Everything else resolves at send time, because a chip made five minutes ago should ground
the answer in the repository as it is now.

### Reasoning effort

Four Jaroku levels, translated per provider in **one adapter** — extended-thinking providers get a
token budget, `reasoning_effort` providers get a named level with XHigh clamped to High, and a model
with no reasoning control renders the chip disabled *with the model named* rather than showing a
meaningless "Low".

The budget is validated against **this call's** `max_tokens`, not the model's ceiling: every builder
sends its own — 600 for a plan, 700 for an explain, 16,000 for a generation — and a thinking block is
spent out of that allowance. A clamp is **reported**: the turn stores what was requested *and* what
was applied, so the marker is derivable after the fact rather than only knowable to the provider.
Budgets live in `runtime/pricing.json` beside the prices, and the resolved level reaches an agent run
as `JAROKU_REASONING_EFFORT` on the same seam `JAROKU_PROVIDER` already uses.

### The permission shield

Strict, Smart, Fast — a *policy* control, enforced server-side with the client bypassed. Two
invariants hold it up: an environment that claimed a mode cannot authorise anything (every ask still
arrives at the gate, which resolves the mode from the conversation's own row), and **Fast still
confirms a write**. A workspace admin can pin the mode, and a pinned conversation refuses a `PATCH`
with 409 rather than accepting a write the resolver would then ignore.

### The connector deck

Three tiles then a `+N`, with a disabled connector kept **in place and greyed** rather than removed —
an absent connector reads as a workspace disconnection, which is the one thing this toggle
deliberately is not.

Switching one off is a real capability rather than a dimmed logo. The conversation's decisions narrow
`agent.connectors`, and that one narrowed list feeds every place a connector reaches a run: its
credentials are not resolved, its host is off the sandbox egress allowlist, its MCP servers are
filtered out of `JAROKU_MCP_SERVERS`, and the reviewed templates read `JAROKU_CONNECTORS` and refuse
by name — *"Slack is switched off for this conversation"* rather than a credential error about a
credential that is perfectly fine.

### The response metadata row

Model, effort, build, duration, diff stat, and — when a turn has more than one answer — a `‹ n/m ›`
variant switcher. The order is **stable and absent items collapse without reordering the rest**,
because people learn the position of the thing they check most.

Regenerate re-runs rather than prefilling the composer, attaching a second answer to the turn it is
re-running rather than appending a second question. Each answer's row in `turn_variants` records the
model, both effort levels and what it cost, so *"which model wrote this?"* stays answerable for
every one of them. The bodies live in memory for the session — the same decision migration 044 made
about Jaroku's prose, which is not stored and is rebuilt from stubs on reload.

Notes are **shared**, pins are **personal**, and feedback is workspace-visible in aggregate. Notes
hang off the turn rather than off a variant, deliberately, so a regeneration cannot take them.

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
| **Stop** | Ends the run. The control file is cleared, the row is closed as `error` with `cancelled by user` against it, and the ordinary exit teardown releases the slot. Nothing is left to resume from — that is the whole difference from a pause. |

Branching is always at a whole-node boundary, never mid-node.

**Stop is the way out of a wedged run, not a nicety beside Pause.** The interactive slot is
process-wide: while a run is in flight nothing else can start, be branched, be resumed, or have an
edit applied — and two of the server's own refusals say so in as many words ("stop it before
resuming this one", "stop it before branching"). It sits next to Pause while a run moves and next
to Resume once it has stopped moving, and it asks once before it fires: a cancellation destroys
nothing that was written, but it cannot be undone, and a mis-click on the control beside Pause
should not read as a pause that silently killed the run.

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
  dataset — in the dataset builder, under **Judge rubric**, beside the examples they will be applied
  to. "Correct" for a refund bot is not "correct" for a SQL agent. Saving writes a rubric for *that
  dataset* and never touches the built-in one, which is what a dataset with no rubric of its own is
  scored against — and is what the editor opens with, so editing starts from the real criteria
  rather than from a blank list. A criterion's **id** is fixed once it exists: it is the key a
  stored verdict's per-criterion score is recorded against, so renaming it would orphan every score
  already taken and leave the drill-down showing blanks beside a criterion that looks identical. The
  label is the display name and is free to change.
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

**It is also the catalogue.** Which models a user can actually pick — for a run, as an eval leg, in
the deploy configuration, from the command palette — comes from this file, delivered on the
`providers` snapshot with each provider's display name. It used to be a hardcoded array in the
client, and that array had fallen four models behind the price sheet: `claude-opus-5`, the newest
priced entry, could not be selected anywhere, and nothing failed because nothing compared the two
lists. That is the drift this file's own header warns about, one level up — not two copies of the
prices, but a second, hidden copy of the *catalogue* that the priced one could not correct.
`test:pricing` now asserts the properties that keep it safe: every model names a provider, every
provider has a display name, the free dry-run entry is present, and every model the catalogue offers
resolves through the same `priceFor` that will be asked about it later.

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
| **Google Calendar** | `gcal_list_events`, `gcal_get_event`, `gcal_create_event`, `gcal_update_event` | `GCAL_CLIENT_ID`, `GCAL_CLIENT_SECRET`, `GCAL_REFRESH_TOKEN` | **No delete.** Creating and updating change a real calendar and send invitations — irreversible, and the prompt says so. Scope is `calendar.events`, never the wide `calendar`, so it cannot create, delete or share a calendar |
| **Slack** | `slack_list_channels`, `slack_read_channel`, `slack_post_message` | `SLACK_BOT_TOKEN` | Posting is immediate and irreversible; the prompt says so explicitly |
| **Stripe (read-only)** | `stripe_get_customer`, `stripe_list_payments`, `stripe_get_payment`, `stripe_list_invoices`, `stripe_get_invoice`, `stripe_get_balance` | `STRIPE_SECRET_KEY` | Read-only, enforced twice: the template calls **only** `retrieve`/`list`/`search` — asserted by a scan of its own syntax tree — *and* a full-access `sk_live_` key is **refused at save**, so it takes a restricted key. Returned fields are an allowlist; nothing is `expand`ed |
| **Postgres** | `pg_query` | `DATABASE_URL` | Read-only, enforced twice: a statement check *and* a read-only transaction. One statement, `SELECT`/`WITH … SELECT` only, capped at 100 rows |
| **HTTP/Webhook** | `http_request` | `HTTP_ALLOWED_DOMAINS` (+ optional `HTTP_AUTH_HEADER`) | HTTPS only, to **exact hostnames with no wildcards**. Credential-in-URL refused, private/link-local/reserved ranges refused whatever a name resolves to, DNS pinned at request time, redirects reported but never followed, response capped at 256 KB, `Set-Cookie` and `Authorization` stripped on the way back |

Each template lazy-imports its SDK, so the base install stays light and a missing SDK
produces a clear message rather than an import crash. Install them with
`uv sync --extra connectors`.

Adding a connector means: write the template, add its entry to `catalog.json` — including its
`auth` mode — and run the `check_catalog()` verification in `tool_templates/__init__.py`.

Hosted, **the required env above is no longer something a user pastes in for the OAuth
connectors**: Jaroku owns the OAuth app, the user clicks Connect, and a short-lived access token
reaches the run under the same variable name the template already reads. Postgres, Stripe and
HTTP stay `user_secret` — there is no consent screen for "the database at the other end of this
connection string", and none for a Stripe key or a domain list either. All six appear in the
**Connections** tab; the `user_secret` three end in fields rather than a Connect button, and the
value is posted over the elevation-gated `POST /v1/secrets` rather than the WebSocket, which
cannot carry an elevation header. See
[Connector OAuth and the credential vault](#connector-oauth-and-the-credential-vault).

**Google Calendar is a second Google connection, not a wider Gmail one.** Both use the same OAuth
app, and merging them would save a click at the cost of the thing people actually want: one grant
is one revocation, so somebody stopping an agent from reading their mail would lose the scheduling
assistant with it. Two connections make "disconnect Gmail, keep Calendar" expressible.

**Two known limits on the HTTP connector, recorded rather than discovered.** There are no wildcard
domains — `*.example.com` is refused, because the domain anybody would want one on is a shared
platform and a wildcard there grants every tenant of it. And there is **no `http_webhook_listen`**:
a hosted run's sandbox is outbound-only, its egress policy has no concept of accepting a
connection, and a tool that worked on a laptop and raised everywhere the product actually runs
would be worse than an absent one. Both are future items, not oversights.

---

## MCP servers

Connectors are code we read. **MCP servers are code nobody here has read** — and the whole
design of this feature follows from taking that seriously rather than treating an MCP server
as a connector that happens to arrive over HTTP.

| | reviewed connector | MCP server |
|---|---|---|
| provenance | hand-audited by us | third-party, unread |
| tool list | declared in a catalog | **discovered** at runtime, can change |
| parameters | a display-only signature | a machine-readable JSON Schema |
| output | trusted — we wrote it | untrusted input |

They therefore get their own registry, their own vocabulary, and a badge that appears
everywhere one of their tools does. `schema/events.md` v1 is untouched: **an MCP tool call is
an ordinary `tool_call` Step**, and everything below rides beside the frozen schema in new
tables and a new channel, exactly as pause/resume and the eval engine did.

### Connecting one

The **MCP** tab lists connected servers. Adding one performs the standard handshake —
`initialize` → `notifications/initialized` → `tools/list` — and shows you what the server says
it can do *before* anything is granted to any agent. Nothing is ever assumed about a server's
capabilities; the list is its own advertisement, re-read on demand and never carried over.

Only **Streamable HTTP** endpoints are supported. stdio is deliberately not: it means running
a third-party binary on your machine, which is a much larger decision than making a request.

Failure is classified rather than swallowed, because the three cases need different fixes:

| Status | What it means |
|---|---|
| `connected` | Handshake succeeded; the tool list is what it advertised |
| `unreachable` | DNS, refused, reset, timeout. Usually transient — the previously discovered tools are **kept** |
| `auth_required` | It wants a credential, or rejected the one it has |
| `error` | It answered, but not with usable MCP |

A failed *refresh* never destroys a working tool list. Wiping it on a network blip would
silently strip every agent scoped to that server, which is a far worse failure than a status
line saying unreachable.

A URL carrying a username or password (`https://user:token@host/mcp`) is **refused before
anything is sent**, and the error does not quote it back. Such a URL can never connect — the
HTTP client rejects it outright — and the refusal it produces otherwise puts the password into
`last_error`, into the database, onto every client's registry snapshot, and into the log. Give
the plain URL and add the token separately.

### What an advertisement has to satisfy

A server's *description of itself* is untrusted input in exactly the way its results are, and it
travels further: a name and a description are stored, put on every registry snapshot every
connected client receives, written into `mcp_tools.json`, and pasted into the generation prompt.
They are read once and repeated everywhere, so they are bounded at the point they arrive.

- **A tool name must be 1–128 characters of `[A-Za-z0-9_-]`.** Not a style rule — the model API
  accepts nothing else, so one tool called `my tool` does not produce one broken tool, it
  produces a 400 on *every* request the agent makes, taking every other tool down with it.
  `__proto__` is refused too: as a plain-object key it assigns a prototype rather than an entry,
  and a tool named that vanished silently from the validator's checks.
- **Descriptions are capped and flattened to one line**, with ANSI escapes and control
  characters stripped — the same treatment results get. The words are kept verbatim; what a
  third party does not get is control over the *shape* of a prompt we build around them.
- **A schema over 64 KB is refused whole**, not truncated: checking arguments against a
  half-schema the server never declared is worse than not having the tool.
- **`serverInfo` is bounded and stripped** for the same reasons — it is rendered in the panel
  and in log lines.

Refusals are **counted and reported**, never silent. A user who cannot find the tool they came
for is told it was dropped, rather than left to conclude the server does not offer it.

### Credentials

A token entered in the UI is stored under a derived name (`JAROKU_MCP_<SERVER>_TOKEN`) through
the [secret store](#the-secret-lifecycle) — `runtime/.env` locally, per-workspace ciphertext
hosted — and that is the last time anything holds it. **The name is derived from the server id,
so two workspaces connecting one service derive the same name; the store is what keeps them two
different values.** See
[Connector OAuth and the credential vault](#connector-oauth-and-the-credential-vault). From then on it is
read from the environment at the moment a request is made. It is never logged, never stored in
the database, never written into a generated project, and never sent back to the browser —
what a client learns is `configured: true`, meaning a named variable is set.

Two things worth knowing:

- **A value that cannot round-trip is refused, not mangled.** The `.env` format has no escape
  sequences, so every candidate line is parsed back with the real loader first. A credential
  quietly altered on the way to disk produces a 401 with no explanation anywhere.
- **A variable already exported in your shell wins after a restart**, on both sides, by design
  (see [Configuration](#configuration)). Writing one that is shadowed warns you, because a
  token that silently reverts is a baffling thing to debug.

**OAuth against an MCP server is not supported.** A server that answers a handshake with an OAuth
challenge says so explicitly rather than failing as a generic "unauthorized" — otherwise you
would go hunting for a key that does not exist. (Jaroku *does* run OAuth for its reviewed
connectors; that is a different thing, and it is
[here](#connector-oauth-and-the-credential-vault).)

**An endpoint is validated before anything connects to it, and again before every
re-discovery.** A user-supplied URL fetched by the control plane is an SSRF vector: private,
link-local and loopback addresses are refused, the resolved addresses are pinned, and a
hostname repointed after registration is refused at the next handshake — while keeping the tool
list it already had.

### Impact classification

Every discovered tool is classified `high` or `low` at discovery, and the classification is
stored **with its reason**. High-impact tools stop and ask before their first call in a run.

The rule is a **ratchet**: an untrusted or unreliable signal may raise impact, never lower it.

1. **The server's own `ToolAnnotations`.** `destructiveHint: true` is believed.
   `readOnlyHint: true` is **ignored** — letting a server certify its own tool as safe would
   make the gate opt-out, defeated by four characters of JSON. When a server tried to lower
   something and it stayed high, you are told so.
2. **The tool name**, which by MCP convention leads with its verb. The only signal allowed to
   decide in both directions, because it is a machine identifier the author chose. A high verb
   anywhere outranks a low one (`get_or_create_issue` is high), while a leading-position-only
   lexicon keeps a read's *object* from reading as a verb (`get_message` stays low, while
   `send_message` does not). Matching is exact rather than stemmed, so `list_deleted_items`
   is low.
3. **The description's opening words**, and only as evidence of a write. There is no path from
   prose to "low": "Returns the newly created issue" opens like a read and describes a write.
4. **Otherwise high.** This mirrors the eval engine treating unrecognised failures as
   deterministic — when a heuristic cannot read something, it must fail toward the answer that
   is expensive rather than the one that is silent. A tool called `frobnicate` gets a prompt,
   because nobody, including us, knows what it does.

You can **override** any classification in either direction, and the reason is shown beside it
so the override is a considered disagreement rather than a way to make a warning go away. An
override is stamped with the schema it was judged against: if the server later changes that
tool's parameters, the override is **voided and says so**, and the computed classification
governs again. A server quietly widening a tool it already talked you into trusting is the
case that defends against.

### Least privilege

MCP tools are selected **per tool**, never per server. Connecting a server makes its tools
available to choose from; it grants an agent nothing. The selection travels through the
approved plan into `mcp_tools.json`, and the reviewed bridge builds exactly the tools that
file lists and offers **no way to reach anything else** — no dynamic discovery, no tool name
passed in from the agent. If a server grows a `delete_everything` tool tomorrow, an agent
generated today still cannot call it.

**The honest limit:** the finest grain MCP exposes is the tool. There is no sub-tool scoping in
the protocol, so if a tool's own schema permits more than your agent needs, nothing here can
narrow it — the scoping is per tool, and that is as far as it goes.

**One name, one tool.** An agent has a single tool list, and the model picks a tool by name, so
selecting `create_issue` from two different servers is a grant that cannot be honoured — and it
is an ordinary thing to try, since plenty of issue trackers use the same names. Generation
**refuses** it and names both servers, rather than resolving it quietly: whichever entry won,
the agent would call a server the user did not pick, and if the two differ in impact, a
high-impact tool's confirmation gate would be replaced by a same-named low-impact one and never
fire. The same refusal covers an MCP tool sharing a name with a selected connector tool. The
bridge raises on such a manifest as a backstop, for a project that predates the check or was
edited by hand.

### The first-use confirmation gate

Before a **high-impact** MCP tool runs for the first time in a run, the run halts and asks:

```
┌──────────────────────────────────────────────┐
│  ⚠  A tool is waiting for you                │
│  [MCP] send_message  on  mock                │
│  This runs on a third-party server Jaroku    │
│  has not reviewed. It was classified         │
│  high-impact because its name begins "send". │
│                                              │
│  ARGUMENTS THE AGENT PRODUCED                │
│  { "channel": "eng", "text": "ship it" }     │
│                                              │
│  run 4f15e873      denies in 1:52            │
│         [Deny] [Allow once] [Allow for run]  │
└──────────────────────────────────────────────┘
```

The **arguments are the body of the dialog**, not a detail behind a disclosure. The tool was
already approved in principle when it was selected during planning; what has never been
approved is *this* call, with these values, which the model made up a second ago.

- **Denying or timing out raises**, so a refusal lands as a red `tool_call` step the model is
  told about — never as silence. Timing out **denies**; a gate that opens when nobody answers
  is a gate that opens whenever someone steps away from their desk.
- **Escape denies**, and the scrim does not dismiss. The run has already stopped; the only
  outcomes are allow and refuse.
- **"Allow for this run" lasts exactly as long as the process.** Nothing persists to the next
  run, and nothing persists to another agent.
- The mechanism is the one pause/resume already uses: a `@@JAROKU_CTRL@@` line out on
  **stderr**, an approval file back. stdout carries the trace and nothing else.

**Outside Jaroku** — the copied-out project this README promises works — there is nobody to
ask. The bridge proceeds, with a warning on stderr naming the tool, because a person running
the script themselves on their own machine *is* the authorisation and a hard denial would make
that promise false. Set `JAROKU_MCP_CONFIRM=require` to refuse instead.

### Output isolation

A tool's result is untrusted input, so before it reaches the model or the trace it is:

- **capped** (`JAROKU_MCP_MAX_RESULT_CHARS`, default 20 000) with the truncation *announced* —
  a quietly cut answer reads to the model as a complete one;
- **stripped** of ANSI escapes and control characters, which serve no purpose in a result and
  corrupt everything that renders one;
- **coerced** — non-text content blocks are named by type rather than stringified, so an image
  never arrives as a base64 wall in a step row;
- **framed** as `[mcp:<server>/<tool> returned the following external data]`. Not a defence
  against prompt injection — nothing is — but this is the only point in the pipeline where such
  text *can* be labelled, and a model reading it is at least told who wrote it.

A server flagging its own call as failed becomes a **raise**, not a returned string, for the
same reason connector templates raise: a returned string is recorded as a *successful* tool
call, so the trace would show a green step whose content is an error.

Every wait is bounded twice — per request and across the whole operation — because a slow
server is indistinguishable from a hostile one holding a connection open. Pagination is
bounded too: `nextCursor` is server-controlled state, so a cursor that never terminates would
be a trivial denial of service against Jaroku itself.

### What lands in a generated project

```
runtime/agents/<id>/
├── mcp_tools.json        ← host-written: the GRANT. Servers, tools, schemas, impact.
└── tools/
    └── mcp_bridge.py     ← reviewed template, copied byte-for-byte
```

Both are **read-only to the edit loop**, unconditionally, alongside `jaroku.json`. The manifest
is the whole of an agent's MCP access and the bridge is the reviewed code that honours it, so
an edit able to rewrite either could widen the agent's reach with nobody approving it. Asking
for a change points you at the MCP panel, because changing an agent's scope is your decision,
not an edit's.

Importing the bridge does **file reads only, never network** — validation imports the staged
project under a 20-second kill timer and graph introspection imports it again, and neither may
depend on a third party being awake. Because it builds each tool from the *real* declared JSON
Schema, the free dry-run model synthesises arguments for MCP tools too, so every one of them is
exercised with no server, no credential and no money.

Like a connector template, **the bridge is copied at generation time**: updating the template
does not retroactively change agents that already exist.

### Validation

A discovered tool carries a real schema, so a wrong call is caught before the project is
written rather than at runtime against somebody else's server:

- `MCP_TOOLS` must be reachable from `TOOLS` — an agent whose metadata advertises MCP tools it
  cannot call is the same lie the reviewed-tool wiring check exists to prevent;
- a generated function **shadowing** a granted tool's name is rejected;
- a literal `tool.invoke({...})` is checked for missing required keys and keys the tool does not
  accept, naming the server that declared them.

Two things it deliberately does not claim: a schema declaring no properties accepts anything
(silence is not a prohibition), and a dict assembled at runtime is left to the bridge's own
check, which runs on every call.

### Testing without a real server

`server/fixtures/mcp/mockServer.ts` is a fixture MCP server, written against `node:http` and
raw JSON-RPC rather than the MCP SDK — a fixture has to be able to advertise things a
well-behaved server never would, and it means the client is tested against something that does
not share its implementation.

```bash
cd server
npm run mock:mcp                        # http://127.0.0.1:8931/mcp
MOCK_MCP_TOKEN=sekrit npm run mock:mcp  # requires a bearer token
MOCK_MCP_HOSTILE=1 npm run mock:mcp     # adds the badly-behaved tools
```

Its default tools span the classifier's decision points (including one that insists in its own
annotations that it is read-only while being called `purge_cache`). The hostile set returns
10 MB of text, control characters, non-text-only content, 400-deep nesting, an injection
attempt, a self-reported error, and one tool that never answers at all.

---

## GitHub

Jaroku already has a version lineage: `agent_versions`, a monotonic number per agent, with the
pointer in `agents.current_version`. Git has one too. This feature is **not "git inside Jaroku"** —
it is the place where the relationship between the two is legible at every moment, and every screen
in it answers one question: *what does GitHub have that I do not, and what do I have that GitHub
does not?*

### Connecting

Press **Connect GitHub**. You are sent to GitHub, you choose which repositories Jaroku may reach,
and you come back. There is nothing to paste — not a token, and not the deployment's own key.

The first person to connect on a fresh deployment sees one extra screen: GitHub asking them to
create the App from a manifest this repository ships. That manifest declares the permissions, so
what you approve is described by GitHub in its own words rather than by instructions you follow.
GitHub then hands the App's private key straight back to a callback on this server, which stores it
in `runtime/.env`. Nobody sees it, including you.

Seven permissions, and each is there for named calls:

| Permission | For |
|---|---|
| `contents: write` | the push — blobs, trees, commits, refs — and the pull's tree read |
| `workflows: write` | `.github/workflows/jaroku-build.yml`, which `contents` alone cannot write |
| `administration: write` | creating a repository, and reading collaborator permission for the eval check's provider boundary |
| `pull_requests: write` | opening the PR, reading review comments, posting the threaded reply |
| `checks: write` | posting the eval check. **Write access to checks is available only to GitHub Apps** — this is why the connection is an App and not a token |
| `statuses: write` | reading the combined status as the second half of the PR's verdict |
| `metadata: read` | mandatory on every App |

Two tokens come out of one install, because GitHub has two kinds. An **installation token**, minted
per hour from the private key, carries everything that touches a repository. A **user token** from
the same round trip carries the three calls that are about a *person* — the account line, the
name-availability check, and creating a repository — because `POST /user/repos` refuses an
installation token. `apiFor()` is the one place either is resolved.

> **Choose "All repositories" when installing** unless you have a reason not to. A repository
> created a moment ago is *outside* a "selected repositories" installation, and GitHub offers no
> API to add one — so Jaroku checks after creating and tells you at link time rather than failing a
> push later.

**GitHub Enterprise Server**, or a deployment with no callback URL a browser can reach, uses a
personal access token instead: `POST /v1/github/connect` is intact and takes one. It is not
reachable from the UI, and it cannot post check runs — see [ADR-036](adr/ADR-036-github-app-installation-as-the-connection.md).

### The branch model

Jaroku owns `jaroku/<agent-slug>` and **never writes to your default branch** as part of
reconciling the two lineages. You edit `main` exactly as you normally would. Reconciliation is
always a pull request, never a silent auto-merge.

```
main            ●──●──────────●────────●
                    ╲                 ╱
jaroku/weather       ●──●──●──●──●───●   ← Jaroku pushes here
                     v11 12 13 14 15   PR
```

The one exception is the generated build workflow, and it is an exception because GitHub only runs
workflows that exist on the default branch — a build check written to `jaroku/<slug>` would never
run on the pull requests it exists to gate. It is written once, and a workflow you have since
edited is surfaced rather than overwritten.

### Push, pull, and what refuses

- **A push is one commit per version**, through the Git Data API. `PUT /contents` writes one file
  per commit, so a version touching three files would become three commits and two intermediate
  states that never existed. Squash is opt-in per push and never a stored preference.
- **A pull is held to the identical bar as generated code** — the remote tree is staged as a
  candidate version and put through the same parse · import · contract validation every generation
  passes. A failure is a refusal: the candidate is discarded, the pointer never moves, and the card
  names the file and the check.
- **A secret scan sits between tree-build and commit-create**, where blobs and trees are
  content-addressed and invisible until a ref points at them — so a refusal costs a garbage
  collection and leaves the branch where it was.
- **Protected paths** — reviewed connector templates, the MCP bridge and its manifest — are refused
  from a pull as well as from the edit loop. A pull is the one route into them from outside the
  product entirely.
- **A rewritten remote is `diverged`, never `behind`.** Zero commits between two heads reads as in
  sync and is the one case where a pull destroys work.

### Checks on a pull request

A pull request that touches an agent can run a dataset against it and post the pass rate, the cost
per run and the latency as a GitHub check, with the delta against the base branch. It is configured
per agent in the panel's **Checks** region, and it is **off until somebody picks a dataset** —
linking a repository deliberately does not enable it, because unbounded spend on every push to a
pull request is not a default this product gets to have.

The dataset is the switch, so there is no separate enable toggle: without one there is nothing to
enable. The second decision is **whose money a check may spend**, and it is three positions rather
than a boolean, because the middle one is the interesting case:

| Policy | What a check may use |
|---|---|
| Dry run | The free dry-run provider. Nobody's money |
| Collaborators | A collaborator's pull request may spend this workspace's balance; a stranger's runs dry |
| Anybody | Any pull request may spend it |

The default when a config row is first written is the middle one — defaulting to *anybody* would make
opting in an opt-out of the boundary, and defaulting to *dry run* would make the feature do nothing
until configured twice. The two fields are patched independently: clearing the dataset turns checks
off and keeps the policy, and changing the policy does not clear the dataset.

**This was written a release before it could be reached.** `checkRunner`, `checkPolicy`, `evalCheck`,
`githubChecksLine`, two migrations, the webhook branch and four suites all sat behind one row in
`agent_ci_config`, and `setConfig` had no caller — so `ci_dataset_id` was always null and every
delivery logged *"no dataset is linked for CI on this agent"*. Closing that surfaced a second thing
nothing could have observed: the dispatch passed the agent's **uuid** where the eval engine takes the
**slug**, which is what a job's working directory is derived from, so the first real check would have
failed every job. The suite asserts the slug now.

### The first push into an empty repository

Worth knowing because it is not obvious from the outside: GitHub's Git Data API refuses **every**
write against a repository with no commits (`409 Git Repository is empty`), and a repository Jaroku
creates for you deliberately has none. So the initial commit goes through the Contents API — the
one endpoint GitHub accepts there — onto your repository's own default branch, and `jaroku/<slug>`
is then rooted on it. A branch with no parent has no merge base, which means no pull request and no
comparison, so rooting it is what makes every reconciliation surface work at all.

### Developing without a GitHub account

`npm run mock:github` starts a fixture that implements the App surface — manifest conversion,
installation tokens, the OAuth exchange, `/installation/repositories` — **and GitHub's two browser
screens**. Point both hosts at it and the entire connect-and-push flow runs on a laptop:

```bash
npm run mock:github     # prints its URL
JAROKU_GITHUB_API=http://127.0.0.1:8936 JAROKU_GITHUB_WEB=http://127.0.0.1:8936 npm run dev
```

---

## Deploying an agent

An agent you trust is an agent you want reachable. Deploy packages it, ships it to **your own
Railway account**, and gives you back a URL you can `curl`.

Jaroku orchestrates the deploy. It does not host anything: your credentials, your account, your
agent, your bill. There is no Jaroku infrastructure in this path at all.

```
you press Deploy
      │
      ├─ refuse      everything knowable locally, BEFORE touching your account
      ├─ record      a row, before the first Railway call
      ├─ package     serve.py + Dockerfile + .dockerignore + pyproject.toml, atomically
      ├─ provision   a project and a service, in your Railway account
      ├─ variables   your credentials, over HTTPS, in a request body
      ├─ upload      the project, over the Railway CLI, token in the environment
      ├─ follow      the build, until it settles
      └─ publish     a public URL, once there is something behind it
```

### The agent contract does not change

Not one line, and no agent is regenerated. The contract already describes a request handler —

```
build_initial_state(text) → state → graph.invoke(state) → answer
```

— and `jaroku_runner` just happens to call it once and exit. What was missing was a caller that
loops, not a symbol. So `runtime/tool_templates/serve.py` is a **reviewed template**, copied
byte-for-byte into a project exactly like `mcp_bridge.py` and the connectors, and every agent
ever generated became deployable the day it landed.

| Route | Behaviour |
|---|---|
| `GET /health` | `{"ok": true, "agent": "<id>"}`. Unauthenticated — it reveals nothing, and a health check that needs a credential is one the platform cannot make. |
| `POST /run` | `{"input": "…"}` → `{"output", "state", "provider", "model", "duration_ms"}`. Bearer token required. UTF-8, capped at 64 KB in, bounded concurrency out. |

It holds two properties, and both are the reason it looks like this:

- **It imports nothing from Jaroku.** Pulling in `jaroku_runner.models` for twelve lines of
  provider selection would quietly end the promise that a generated project is yours to copy
  out and run. Those twelve lines are duplicated instead.
- **It adds no dependency.** Stdlib `ThreadingHTTPServer`. LangGraph invocation is blocking, so
  threads are the right shape, and a project's dependency closure is unchanged by being
  deployable.

It does two things a *generated* file may not, and both are the point: it **constructs the
model** (rule 2 forbids `agent.py` from doing so precisely so the model can be injected — this
is the injection point) and it **writes to stdout** (rule 3 protects the NDJSON trace stream,
and out there stdout is the deployment's log pane).

### What lands in a project

```
runtime/agents/<id>/
├── serve.py          ← reviewed template, copied byte-for-byte
├── Dockerfile        ← synthesised from jaroku.json
├── .dockerignore     ← excludes .env from the build context
└── pyproject.toml    ← the project's own dependency manifest
```

All four are **host-owned and read-only to the edit loop**, alongside `jaroku.json` and the MCP
pair. `serve.py` is the process that answers a publicly reachable URL and the Dockerfile decides
what runs around it — an edit able to rewrite either could change what a container on the open
internet does, with nobody approving it.

They are written through the same **staging + atomic swap** discipline generation and the fix
loop use. A failed or cancelled deploy leaves `agents/<id>/` byte for byte as it was.

`pyproject.toml` pays an old debt. `example_agent` has always carried one, with a comment
promising the project is "export-ready: copy this directory out of Jaroku and it is a standalone
uv/pip project" — and no *generated* agent ever had one. Now they all do. Deploy tooling makes
portability stronger, not weaker.

The image installs **what the agent actually uses**: base LangGraph, the one provider SDK it will
run on, and each selected connector's `pip_requires` from the catalog. An agent with one Postgres
tool does not pull in the Google API client.

The project is put on `sys.path`, never `pip install`ed — `runtime/pyproject.toml` does not ship
`agents` in its wheel, so installing would produce an image where every agent fails to load.

### Secrets handoff

The first time a credential leaves this machine. The rule everywhere:

> **Names travel. Values do not.**

```
        runtime/.env  (chmod 600, gitignored)      ← still the only home
              │
        process.env                                ← still the only reader
              │
   NAMES ─────┼──▶  the browser sees [{ name, configured: true|false }]
              │     and ticks which to send. NO VALUE CROSSES THE SOCKET.
              │
   VALUES ────┴──▶  read at the moment of the mutation
                      ├─ POST variableCollectionUpsert — value in the HTTPS BODY
                      │  never argv · never a log · never the DB · never a file
                      └─ held for THIS deploy only, to scrub every build-log line
                         finally { cleared }
```

| Property | How it holds |
|---|---|
| **The database never sees a value** | `deployments.env_keys` is a JSON array of names. There is no column one would fit in. |
| **Never in an argument** | A process table is world-readable. This is the only reason the transport is split: the API sets variables in a request body, and the CLI — which would need `--set NAME=value` — is used *only* to upload source. |
| **Never in a log** | Values exist as a local inside one function; and every build-log line is scrubbed before it is broadcast or stored, because Railway echoes build output and a `RUN echo $DATABASE_URL` would otherwise land in the log pane, the table and every browser at once. Values under 8 characters are left alone — a log full of holes says more than it hides. |
| **Never in the image** | `.dockerignore` excludes `.env`, and no artifact contains a credential. Secrets arrive only as host environment variables at runtime, which is exactly what `env.py`'s "environment wins" precedence was built for. |
| **Verified before anything is created** | `testRailwayToken` proves a token works and writes nothing — the same two-command split as `testProviderKey`. |

The Railway token itself takes the established path: `RAILWAY_API_TOKEN` in `runtime/.env`,
through the one shared credential writer, `chmod 600`, never logged, never echoed back. (The
*account*-scoped variable, not `RAILWAY_TOKEN`, which Railway's own tooling reads as
project-scoped and which cannot create a project.) It is also stripped from every agent
subprocess: an agent's own keys have to be there, a deploy credential does not.

### The bearer token

A deployed URL runs an agent on your provider key on every request. So Jaroku mints a random
`JAROKU_SERVE_TOKEN`, sets it on Railway, and shows it to you **once** — `serve.py` refuses to
start without one unless `JAROKU_SERVE_PUBLIC=1` says out loud that the endpoint is open.

That token is the only credential this product ever sends *to* a browser, and it is never
persisted: not in the deployments row, not in `deployment_logs`, not in `localStorage`. Reloading
loses it, and the card says so.

```bash
curl https://your-agent.up.railway.app/health
curl -XPOST https://your-agent.up.railway.app/run \
  -H 'Authorization: Bearer <the token>' \
  -d '{"input":"What time is it in Europe/Paris?"}'
```

### What a deploy refuses

- **The dry-run provider.** It answers with placeholder text; a deployed one would be a URL that
  looks like a working agent and is not.
- **A missing connector credential** — or one you unticked. Rule 7 makes an unconfigured
  template *raise* on every call, so that container deploys green and is dead, and it makes no
  difference whether the value was absent or withheld. Overridable by the same checkbox — you
  may intend to set it in Railway by hand — but not by default.
- **An agent with a run in flight.** Deploying writes into the project, and rewriting files a
  subprocess is importing would change code out from under a run. The same rule edits follow.
- **A missing Railway CLI**, before any resource exists — so a missing binary costs you a
  message, not an orphaned project.

### High-impact MCP tools fail closed

A copied-out project proceeds on a high-impact MCP tool with a warning, because a person running
a script on their own machine *is* the authorisation. A container is not that: nobody is there to
ask, and the bridge's "allow for this run" grant is module-global, so one approval would leak
across every later request for the life of the process. Deployed agents therefore run with
`JAROKU_MCP_CONFIRM=require` — set in the Dockerfile *and* on the host — and refuse them. Their
read-only tools are unaffected.

### The deploy record

A row is written **before the first Railway call**, not after the last one — a deploy that dies
mid-flight still leaves a record of what was attempted and where. On startup, any row still in
flight is marked `interrupted` with a message pointing at your Railway dashboard, because
whatever was already created is still there.

```
queued → packaging → uploading → building → deploying → live
                                                ↘         ↘
   any stage ──▶ failed | cancelled | interrupted      superseded
```

`cancelled` and `interrupted` are deliberately not `failed`. One means you stopped it; one means
nobody was watching. Telling somebody their deploy failed when it may be about to come up is how
they end up deploying a second copy.

`superseded` is not a failure either: it worked, and then a later deploy of the same agent
replaced it. Exactly one row may claim to be `live` on a service, because two would be two URLs
both described as the current one.

### Redeploying

**A redeploy goes back into the same Railway project and service.** The button says *Redeploy*
when that is what it will do, and the form says so before you press it — "replaces what is
running there" and "puts up a second one you will also be billed for" are different decisions,
and only you know which you meant.

The remembered ids are checked before they are trusted, because Railway is not ours: if you
deleted the project from your dashboard, the deploy makes a new one and the log says why.

**Forget** is the exception. It detaches the record, so the next deploy has nothing to go back
into and creates a fresh project — while the old service keeps running. The notice says so, with
its URL, when you press it.

**Forget** detaches a record from Jaroku and touches nothing in your account — the notice tells
you where the real thing still is.

### What a deployed run is now

A deployed agent used to be a black box. It emitted no trace, reported no cost, could not be
paused, could not be cancelled, and could not stop and ask a human before a high-impact tool ran.
Every one of those looked like a missing feature and none of them was: all of that machinery
already existed here and was wired into a running server. It was built for the sandbox, and the
deploy path had simply never joined it.

**A deployed run is an ordinary traced run.** Not a similar thing, not a deploy-shaped variant of
one — the same thing:

```
POST /run  {input, run_id, run_token, control_plane_url}
      │
      ├─ 202 immediately          the request does not wait for the graph
      │
      └─ python -m jaroku_runner  the same runner a local run, an eval job
             │                    and a sandboxed run all go through
             ├─ JarokuTracer  →  schema-v1 events
             └─ controlplane_http → POST /v1/runs/<id>/trace, on Jaroku's control plane
```

`serve.py` no longer selects a provider, builds a model or invokes a graph. It accepts a request,
hands it to the runner, and answers `202` while the run is still going. There is deliberately no
second way to execute an agent, and the deploy path was the one place in this product that broke
that rule.

What follows from it, none of which is a new mechanism:

| | how |
|---|---|
| **Traces** | The runner's own `JarokuTracer`, pushed to the control plane that was already listening. A deployed trace and a local trace of the same agent on the same input differ in run id and timing and nothing else — asserted, in `test:serve-trace`. |
| **Cost** | Summed from `steps`, by the same `aggregateJob` the eval engine uses. Never read from `runs.cost`: a run whose container died never emitted a `run_end`, and its row still reads 0 while its steps record real money. |
| **Pause / resume** | The control-plane actions that already existed. A pause stops at a node boundary and leaves a durable checkpoint; a resume continues the same run, with the same id, from the seq it stopped at. |
| **Cancel** | A third action beside those two, read at the same boundary. Never a kill: the node in flight finishes, and the run ends with a `run_end` that says it was cancelled. |
| **Confirmation** | `mcp_bridge.py`'s existing HTTP gate. A high-impact tool in a deployed run stops and asks a person, and the modal cannot tell it from a local run. |
| **Health, logs, kill** | On the server, so the screen is only a screen. Health asks the agent's own `/health` rather than Railway, because Railway reports a crash-looping service as deployed. |

**The image now contains Jaroku's own reviewed code** — `jaroku_interceptor` and `jaroku_runner`,
vendored at deploy time exactly as `serve.py` and the connector templates already are. That is a
reversal of what the previous version of this section said, and it is worth being plain about:
the promise being defended was about the **generated project**, not the image. `agent.py` still
imports nothing named `jaroku`, the validator still rejects it if it tries, and the contract is
still three symbols. The image is a different boundary, and `runtime/sandbox/Dockerfile` had
already drawn it — what lives in an image is code Jaroku wrote and reviewed. Copy the project out
and it still runs standalone, because `controlplane_http.py` reports to nobody unless both
`JAROKU_CONTROL_PLANE_URL` and `JAROKU_RUN_TOKEN` are set, and both arrive per request.

**Jaroku now keeps a copy of the serve token.** The old property was "Jaroku does not keep a
copy", and it was a real one. It ended because a token shown once cannot dispatch a run. The new
property is narrower and is the one actually defended: the token lives where every other
credential lives — envelope-encrypted, workspace-scoped, with no path to plaintext except the
dispatcher. Agents deployed before this have no stored token and the old one is unrecoverable;
**Reconnect** mints a fresh one, sets it, and stores it. Setting a variable restarts the service,
so the command says so before you press it.

### Still owed

`runtime/.checkpoints/` inside a container is the container's own filesystem. A paused deployed
run keeps a durable checkpoint and can be resumed — until the service restarts, which setting a
variable does. After that the checkpoint is gone, and a resume is refused with a `409` rather
than silently starting the graph over and re-spending what it already spent.

---

## The Cockpit

Jaroku builds an agent and then hands you a URL. The Cockpit is where that stops being the end of
the story. It is the operator's surface for agents that are **already live**, and it answers five
questions and no others: *what is live*, *give this agent a real job*, *what is happening to the
jobs I gave it*, *what does it need from me right now*, and *what did it cost*.

None of that is approximate, because a deployed run is an ordinary traced run: the cost is summed
from `steps`, the trace is the trace, the pause is real, and a job that needs a human decision
genuinely stops and waits for one.

### What it is, and what it is not

**It is not the Agents tab.** Agents is agent-first — pick one, then work on it. The Cockpit is
**work-first**: one list across every agent, because the operator asks "what is happening", not
"how is agent four". There is deliberately no work list inside Agent detail; what sits there is a
pointer strip — *3 running, 1 waiting on you* — that opens this tab filtered to that agent. A
second place a job can be dealt with is the mistake the Inbox already refused.

**It is not the Inbox.** The Inbox is system state: what is broken, with every item dying on its own
via a server-evaluated predicate. A job's outcome is not a predicate over workspace state — it is a
record of something that happened, and a job blocked on a human dies when the human answers.
Different table, different law, different tab. Nothing migrates out of `inbox_items`.

They touch in exactly one place. A deployed run waiting on an MCP confirmation is blocking in the
Inbox's sense and waiting on you in the Cockpit's. It has one home — the Cockpit — and the Inbox
carries a pointer to it rather than a second card. Two boards showing the same thing is how both
stop being believed.

### The shape

```
┌──────────────────────────────────────────────────────────────────────┐
│  Cockpit          2 running · 1 waiting on you                       │
├──────────────────────────────────────────────────────────────────────┤
│ ┌────────────────┐┌────────────────┐┌────────────────┐               │  the fleet:
│ │ ● billing_bot  ││ ○ mailer   v3  ││ ⚠ scraper      │  ← scrolls →  │  a glance, one
│ │ 2 running ·    ││ idle · 11 jobs ││ not connected  │               │  card per LIVE
│ │ 1 waiting      ││ today · $0.42  ││ [Reconnect]    │               │  deployment
│ └────────────────┘└────────────────┘└────────────────┘               │
├──────────────────────────────────────────────────────────────────────┤
│  [Mine][Everyone's]   [All] [◐ 2] [⏸ 1] [✓ 40]                       │
│  ⏸ refund order 4471 — "it never arrived"          4.2s      $0.0031 │
│    billing_bot · Ada · waiting on stripe/create_refund               │
│  ✓ chase the invoice for ACME                      9.1s      $0.0084 │
│    mailer · Bo                                                       │
├──────────────────────────────────────────────────────────────────────┤
│  [billing_bot ▾]  Give this agent a real job…                    [↑] │
└──────────────────────────────────────────────────────────────────────┘
```

The **fleet strip** is a glance, not a dashboard. Its one line is the hardest design in the tab and
the rule is that no card may say something that would be true of twenty cards: not "Running" and
not "Deployed", but *2 running · 1 waiting on you*, or *idle · 11 jobs today · $0.42*, or *not
connected*. A status word alone is what the Railway dashboard already gives, and it is the reason
somebody is opening Railway instead of this.

A card whose credential is refused says **only that**. Its counts are stale by construction —
nothing has been able to dispatch to it — so carrying them would invite you to read the second half
and conclude it is working.

### The four connection states

| | what it means | what to do |
|---|---|---|
| **connected** | Jaroku holds a serve token for this deployment's Railway service. | nothing |
| **unconnected** | No stored token. Every agent deployed before the production bridge is here. | Reconnect |
| **unauthorised** | A token exists and the agent refused it — rotated on Railway out from under us. | Reconnect |
| **public** | `JAROKU_SERVE_PUBLIC=1`. A **warning** state, not a healthy one: anyone with the URL can spend your provider key. | decide whether you meant it |

**Reconnect restarts the service, and says so before you press it.** Setting a variable on Railway
restarts the container: every run in flight in it dies, and its checkpoints die with them, so a run
paused this morning cannot be resumed afterwards. That sentence is worded identically wherever the
same consequence appears, because two different sentences for one consequence teach you that
neither is precise.

### Giving an agent a job

**The dispatch composer is not the build composer, and does not route through `lib/intent`.** The
build composer's whole design is that one input routes by *(selection context + phrasing)* into
plan / revise / explain / branch / fix / edit. Here there is exactly one destination — a live
agent, for real — and reusing the routing would mean *"refund order 4471"* could be read as an edit
instruction and quietly turned into a code change to the agent that was supposed to do it.

**A pre-flight gate sits between the button and the dispatch**, naming the agent, the deployment
version, and the provider and model it will run on. Money asks first, and there is no free dry-run
path out here. A deployment written before migration 041 has no recorded version, and the gate says
*an unrecorded version* rather than guessing one.

Then five steps, in this order:

1. **Resolve the live deployment.** No live deployment refuses *before* a row is written and names
   the Deploy panel — nothing was asked of anybody, so there is nothing to record.
2. **Write the row**, as `queued`, before anything leaves the process. A dispatch creates work in
   somebody else's account and can be interrupted at any point; a record that only appeared on
   success would turn a crash into a container spending money with nothing here knowing it was
   asked to.
3. **Resolve the credential**, by Railway **service** id rather than by deployment row, so a
   redeploy overwrites one variable instead of accumulating one dead secret per deploy.
4. **`POST /run`, expect `202`.** Bounded, discriminating retry on a 429 and on connection
   transients only, honouring `Retry-After`. A 401 or a 400 fails identically every time, so
   retrying either multiplies nothing but the bill. Each retry uses a **fresh run id**: the
   revocation list is keyed by run id, so reusing one would take the 202 and then have every push
   the container made refused for the life of the run.
5. **Nothing else.** From here the trace drives the state.

### Six statuses, and what closes a job

`queued · running · waiting · succeeded · failed · cancelled`

`waiting` means **a person has to answer something**. It exists because the production bridge made
it reachable, it is the only state where a human is the blocker, and it is the only thing the
sidebar badge counts — a badge that counts everything never reaches zero, and a badge that is never
zero is one people train themselves to ignore.

`cancelled` means genuinely cancelled **at a node boundary**. A cancel is a request, not an
outcome: the node in flight finishes, the runner emits its boundary line, and the run's own
`run_end` is what closes the item. A cancelled run and a crashed one arrive as the *same* event —
the frozen schema has three run statuses and none of them is `cancelled` — so what separates them
is the boundary line, watched for rather than matched out of the error text.

### Six failure kinds

| | what it means |
|---|---|
| `unauthorised` | 401 — the stored serve token is wrong, or there is none. The one with a button attached. |
| `agent_error` | The agent raised. The trace has the failing step. |
| `rejected` | 400/413 — Jaroku sent something the agent refused. **That is a bug in Jaroku** and is worded that way. |
| `unreachable` | DNS, refused, reset. |
| `stopped_reporting` | The container went quiet past the ceiling. **It may have completed, and it may have spent money.** Never "failed". |
| `busy` | 429 after the retry budget was exhausted. |

### Honesty rules, enforced in code

- **Unknown is not zero.** An unpriced model reports `null` and renders `—`. A run whose steps are
  partly priced is marked incomplete and the row says so with a `+`. Never a confidently wrong
  total.
- **Cost is summed from `steps`, never `runs.cost`.** A run that crashed mid-graph never emitted a
  `run_end`, and its row reads 0 while its steps record real money already spent. There is no cost
  column on `work_items` so that this cannot quietly become two answers.
- **`stopped_reporting` says what it means** — the container went quiet, it may have completed, it
  may have spent money.
- **Three zero states, three sentences.** No live agents → *"No agents are live yet"*, with a route
  to Deploy. Live agents, no jobs → *"Nothing has been asked of them yet"*. A filter with nothing
  behind it says the filter is on. Nothing blocked should feel like an achievement; nothing
  deployed should feel like a next step.

### What it costs to read

Two grouped queries build the fleet strip whatever it holds, and one builds a page's costs whatever
the page holds — forty agents and forty jobs cost what one costs, asserted as equality rather than
as a threshold. The one read that is per-card is the serve-token check, and it is not batched
because `SecretStore.getServeToken` deliberately takes one service id and returns one value, which
is what keeps it from being asked for an arbitrary credential.

### Out of scope, deliberately

- **Delegation** — giving a teammate the right to dispatch to your agent sits on `agent_grants` and
  is its own piece of work. When it is built, the composite-FK mistake previously documented on
  `agent_grants` must not be repeated.
- **External users** — everything here is inside the workspace.
- **Per-agent conversation** — asking an agent "did you send that mail" is answered from
  `work_items`, not by the agent, which has no memory across runs. That is Part 3, and it extends
  the existing threads machinery rather than adding a second one. Two constraints it puts on this
  release now: `work_items.id` must be stable and citable, because Part 3's answers cite it and the
  citation is clickable; and the work detail must be reachable by id alone, because a citation chip
  opens it without a list in between. Both hold.
- **Voice and calls** — the layer above. It is now buildable, because `waiting` exists and means
  something.
- **Schedules and triggers, rollback and environment variables, per-agent spend ceilings, and
  delivering a result outward.** All four sit directly on machinery this release creates and none of
  them is in it. `work_items.created_by` stays `NOT NULL` so that a scheduled item is attributed to
  the person who created the schedule rather than to nobody, and the `mine` filter is written so it
  can later mean "mine, including what my schedules did overnight".

### Still owed

The fleet strip's health figure is whatever the last probe found, and nothing probes on a timer —
it is filled by the commands that already ask (a reconnect, a kill) and by anything else that calls
`DeployOps.health`. A card that has never been probed says nothing rather than guessing, which is
correct, but it does mean the strip is not a health monitor and does not claim to be.

`test:work-tenancy` and `test:rls` are the two suites that need Postgres to mean anything; there is
no Postgres on the machine this was built on, so CI is the first place the RLS half of them ever
runs.

---

## The React client

Three resizable columns:

```
┌─────────────┬───────────────────────────┬────────────────────────────┐
│  Sidebar    │  Build pane               │  Right panel               │
│             │                           │                            │
│  workspace  │  ONE composer             │  [Graph][Trace][Evals][MCP]│
│  ─────────  │  · Chat  → Jaroku         │  [Agent][Deploy][GitHub]   │
│  Threads    │  · Test  → the agent      │  [Secrets][Usage][Conns]   │
│  Agents     │                           │                            │
│  Cockpit    │  plan cards               │  Trace is the hero.        │
│  Inbox      │  diff cards               │  Click a step → detail     │
│  Activity   │  streaming files          │  panel slides over.        │
│  ─────────  │  explain answers          │                            │
│  agents     │  ────────────────────     │  Code opens as an overlay  │
│  runs       │  the control bar          │  (Cmd+P / a diff row).     │
│  history    │                           │                            │
└─────────────┴───────────────────────────┴────────────────────────────┘
```

The four destinations at the top of the sidebar are full-screen surfaces rather than a fifth list:
[Threads](#threads) is the conversation, [Agents](#agents) is the artifact, [the Inbox](#the-inbox)
is what is waiting on you, and [Activity](#activity) is what the workspace is doing. Below them the
sidebar keeps the agent list, the live runs and the history window it always had.

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

**Two surfaces sit outside the three columns**, because neither is about an agent. The **workspace
panel** — Members, Audit and Data — opens from the workspace switcher and holds everything that is
true of the workspace rather than of something in it: who may be here, what has been done here, and
taking the whole of it away. A tab beside `GitHub` would have put "delete this workspace" one click
from an agent's diff. The **enforcement strip** sits under the top bar for exactly as long as a rung
of the abuse ladder is in force and nowhere at all otherwise — it is not a setting anybody goes
looking for, it is the reason the last thing they pressed was refused.

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
| `history` | Run-history snapshot (sent on connect, and after a branch is created). Carries the WINDOW it was read with and whether anything is behind it, which is what makes "load older runs" possible without breaking the full-snapshot rule |
| `agents` | The agent list (sent on connect, and after a generation or apply/undo) |
| `trace` | Live schema-v1 trace events for the interactive run |
| `runSteps` | A specific run's steps, ordered by `seq` (answer to `loadRun`) |
| `agentFiles` | An agent's current on-disk files, connector files flagged read-only |
| `graph` | Static LangGraph topology for an agent |
| `gen` | Plan + generation lifecycle: `plan_started`, `plan_delta`, `plan`, `plan_error`, `started`, `file_start/delta/end`, `done`, `error` |
| `edit` | Fix-loop lifecycle: `started`, file streaming, `proposal`, `applied`, `undone`, `discarded`, `error` |
| `debug` | Control plane: `paused`, `resumed`, `boundary`, `branched`, `cancelled`, `error` |
| `eval` | Datasets, examples, rubrics, eval progress, scores, results, estimates |
| `mcp` | MCP registry snapshots, discovery progress, and the first-use confirmation request |
| `deploy` | Deployment snapshots, the pre-deploy plan, live stage transitions, scrubbed build-log lines, and the one-shot serve token |
| `session` | The only channel about the CONNECTION rather than the work: `expiring`, `expired`, `revoked`, `workspace_changed`, `role_changed` |
| `members` | Who is in the workspace, who has been invited, and the one-shot invite link |
| `audit` | The workspace's own record of what has been done to it, newest first. Answered to the socket that asked and never broadcast — the rows name who revealed which credential and who removed whom |
| `enforcement` | Which rung of the abuse ladder is in force, its own sentence, the history, and the workspace's appeal. Broadcast, because a rung refuses every member's work |
| `providers` | Which provider keys are set (`configured: true/false`, by name), test results, whether the workspace's own key pays for platform calls, and **the selectable model catalogue** — read from `runtime/pricing.json`, so what the product offers cannot drift from what it can price |
| `connections` | Which third-party accounts this workspace has authorised, their status and granted scopes, and the URL a consent flow must be started at. Never a token |
| `billing` | What this workspace has spent this period, against which ceilings — see [cost metering](#cost-metering-budgets-and-billing) |
| `reply` | Streaming "explain" answers |
| `threads` | The workspace's build sessions with §3.3's derived status and the filter counts, one thread's conversation when it is opened, and refusals answered to the socket that earned them — see [Threads](#threads) |
| `agents` | The sidebar's agent list, and — since the Agents tab — the grid with every card's tags already derived, one agent in full, one version's files, and refusals answered to the socket that earned them. One channel rather than two: every message is the same subject, and a second would be a second place a broadcast could forget to be scoped — see [Agents](#agents) |
| `github` | Link state, sync verdicts, push and pull outcomes, staged hunks, secret-scan refusals, and pull-request check results — see [GitHub](#github) |
| `inbox` | What is waiting on somebody, rebuilt **per recipient** rather than fanned out — a board is per person as well as per workspace, and a snapshot carries the names of a tenant's missing credentials, failed deploys and unreachable servers. A resolution travels as a delta because it is true for everybody; a dismissal never does — see [the Inbox](#the-inbox) |
| `activity` | Six answers to one command, each sent as its aggregate resolves, so a slow leaderboard does not hold up the hero row. Answered to the socket that **asked** — a range is one person's choice of window — and the only channel in the relay with no mutating command at all — see [Activity](#activity) |
| `access` | Who may do what to one agent, who granted it, when it runs out, and which of those people are connected. Answered to the socket that asked; the one message that is broadcast carries nothing but the fact that something changed — see [per-agent access](#per-agent-access) |
| `log` | stderr lines and parse errors, for visibility |

**Client → server**

`run` · `loadRun` · `loadHistory` · `listAgents` · `archiveAgent` · `restoreAgent` ·
`renameAgent` · `loadAgentFiles` · `loadAgentGraph` · `planAgent` ·
`discardPlan` · `generate` · `edit` · `applyEdit` · `undoEdit` · `discardEdit` · `pauseRun` ·
`resumeRun` · `cancelRun` · `branchRun` · `explain` · and the eval set: `createDataset` · `renameDataset` ·
`deleteDataset` · `listDatasets` · `loadDataset` · `addExample` · `updateExample` ·
`deleteExample` · `promoteTestInput` · `startEval` · `cancelEval` · `estimateEval` ·
`loadEvalResults` · `listEvals` · `loadRubric` · `saveRubric` · and the MCP set:
`listMcpServers` · `addMcpServer` · `removeMcpServer` · `rediscoverMcpServer` ·
`setMcpServerAuth` · `setMcpToolImpact` · `resolveMcpConfirm` · and the provider set:
`listProviders` · `setProviderKey` · `testProviderKey` · `setOwnKeyForPlatform` · and
`loadUsage` · `setSpendCeiling` · and the deploy set: `listDeployments` · `planDeploy` ·
`deploy` · `cancelDeploy` · `forgetDeployment` · `loadDeployLogs` · `setRailwayToken` ·
`testRailwayToken` · and the membership set: `listMembers` · `inviteMember` · `revokeInvite` ·
`setMemberRole` · `removeMember` · `listAudit` · `loadEnforcement` · `appealEnforcement` · and the
thread set: `listThreads` · `loadThread` ·
`createThread` · `renameThread` · `archiveThread` · `restoreThread` · the agent set:
`listAgentGrid` · `loadAgentDetail` · `loadAgentVersion` · `archiveAgent` · `restoreAgent` ·
`renameAgent` · `forkAgent` · `restoreAgentVersion` · and the GitHub set:
`listGithub` · `listGithubRepos` · `checkGithubRepo` · `linkGithub` · `unlinkGithub` ·
`refreshGithub` · `pushGithub` · `pullGithub` · `switchGithubBranch` · `createGithubBranch` ·
`openGithubPr` · `commitGithub` · `generateGithubMessage` · `diagnoseFile` ·
`shadowRunGithub` · `listShadowRuns` · `semanticDiffGithub` · `resolveReviewComment` ·
`setAgentCiConfig` · `listScanFindings` · and the inbox set: `listInbox` · `resolveInboxItem` ·
`dismissInboxItem` · `snoozeInboxItem` · `undoInboxAction` · `bulkInboxAction` ·
`answerMemoryProposal` · and `getActivity` · `getActivityFeed` · and the access set:
`loadAccess` · `loadExposure` · `loadSessions` · `loadAccessHistory` · `grantAccess` ·
`modifyGrant` · `revokeGrant` · `endSession` · and `setAgentTools` · `setByok` ·
`listConnections` · `connectConnector` · `disconnectConnector` · `leaveWorkspace`

Accepting an invitation is deliberately **not** a command: the accepter is not a member yet, so
there is no socket scoped to the workspace they are joining. It is `POST /v1/invites/accept`.

**A read has three outcomes and answers all three.** `WsRelay.answer()` takes the error shape as a
**required** parameter, so every point-to-point read supplies the member its own channel already
renders — a failure is a message rather than a line on a server console the person who asked cannot
see. That matters more than it sounds: every empty state in this product is designed to mean "there
is nothing here", so a swallowed read failure spends that meaning on a lie. `test:channels` reads
every call site out of the source, which is what stops the next read command shipping silent.

**Every command is capability-checked at the door**, before it reaches the app — see
[roles](#roles-as-data). A refusal is answered on the channel the command belongs to, and a
command with no capability is refused rather than allowed.

`setProviderKey` and `testProviderKey` are two commands rather than one on purpose: the test
proves a key authenticates and writes **nothing**, so "Test connection" cannot put a credential
on disk before you have pressed Save. Both tests are models-list calls, so checking a key is
free.

Reads are answered locally by the relay (only the requesting client); mutations are forwarded
to the app, which answers by broadcasting the affected snapshot — the same shape a fresh read
would return, so a client never has to reconcile a partial update against local state.

**Lists are paged by a growing WINDOW rather than by a cursor**, and that follows from the rule
above. Every list read is `ORDER BY <time> DESC LIMIT n`, and until v0.3.0 `n` could not be changed
from the client: the 51st-newest run was unreachable, because `loadRun` needs an id and the only
source of ids was the list that stopped at fifty — while retention keeps traces for a month to a
year, by plan. A cursor plus an append would have made one channel a merging channel; asking for a
bigger window keeps the invariant, at the cost of re-sending rows the client already has (`history`
merges by run id, so the cost is bytes and never duplicates). The window is capped at 500 per
request, and `complete` — a window that came back short — is the only end-of-list signal a control
needs. The run history and the eval history both work this way; the sidebar's search box says plainly
that it is searching what has been loaded, which used to be the silent half of the same problem.

GitHub's own history is deliberately **not** paged: what the panel renders is versions and remote
commits read 30 at a time from GitHub's API, and the `github_events` rows behind it feed a five-row
refusal-and-override strip. Widening those means paging somebody else's API for a surface nobody
scrolls, which is a different feature from this one.

A socket is opened with a **single-use ticket** rather than a token — see [why the ticket
exists](#why-the-ticket-exists) — and the `Origin` is checked before the handshake. The client
reconnects with an exponential, jittered backoff, re-requesting what it needs; a refusal (401/403)
stops the loop and shows sign-in instead.

There is also a small HTTP surface beside the socket, which is where the credential exchange has
to happen because a browser cannot put a header on a WebSocket:

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness. Touches nothing — a probe that checks a dependency turns one database blip into every instance restarting at once |
| `GET /readyz` | Readiness. Probes the database under a deadline |
| `POST /v1/auth/session` | Token → account + the workspaces you may act in. Provisions on first sight |
| `POST /v1/ws-ticket` | A single-use, 30-second, workspace-scoped ticket for one socket |
| `POST /v1/invites/accept` | Redeem an invitation |
| `POST /v1/workspaces` | Create a workspace, owned by the caller. `{name, kind}`, both required |
| `GET /v1/secrets/:name/rotations` | When a credential was replaced, and why. A masked hint and a reason — never a value |
| `POST /v1/billing/checkout` | Start a checkout for a plan. `{plan, workspaceId}`; answers a URL the browser navigates to |
| `POST /v1/workspace/export` | Ask for a copy of everything. 202 with an id; a worker writes the archive |
| `GET /v1/workspace/export/:id` | Whether that archive is ready, and a presigned link with a stated expiry |
| `POST /v1/workspace/delete` | Destroy the workspace. `{confirm: "<its id>"}`, and the answer is a receipt |
| `GET /v1/auth/jwks.json` | The **local issuer's** public key. Absent in provider mode |
| `POST /v1/auth/dev-login` | Mint a local token. Absent in provider mode |

---

## Configuration

### Server

| Variable | Default | Purpose |
|---|---|---|
| `JAROKU_PORT` | `4317` | HTTP + WebSocket port |
| `JAROKU_DB` | `server/jaroku.db` | SQLite file. Everything, not just traces — see [where data lives](#where-data-lives) |
| `JAROKU_DB_DRIVER` | `sqlite` | `sqlite` \| `postgres`. Refuses anything else rather than falling back |
| `JAROKU_PG_URL` | — | Jaroku's own Postgres. Deliberately **not** `DATABASE_URL`, which is the credential the Postgres *connector* reads — reusing it would point every agent's `pg_query` at the control plane |
| `JAROKU_DEV_WORKSPACE` | the local workspace | Which workspace the server acts in **on its own behalf** — the startup run, the sweepers, the restart reconciliations. Announced at boot. **It also creates that workspace when the name does not exist, as a `team` one**, which is a development convenience and not the way to get a team workspace: that is the workspace switcher (`POST /v1/workspaces`) |
| `JAROKU_AUTH_ISSUER` | — | Your OIDC issuer. **Unset runs the local issuer**, which refuses `NODE_ENV=production` |
| `JAROKU_AUTH_AUDIENCE` | `jaroku` | The `aud` a token must carry |
| `JAROKU_AUTH_JWKS_URL` | `<issuer>/.well-known/jwks.json` | Where the signing keys live |
| `JAROKU_ALLOWED_ORIGINS` | the local dev origins | Comma-separated origin allowlist for the WebSocket upgrade. **Required in production** — see [why the origin check is not optional](#why-the-origin-check-is-not-optional) |
| `JAROKU_DEV_AUTH` | — | `1` opens sockets with **no credential at all**, in the dev workspace. Refuses `NODE_ENV=production` |
| `JAROKU_DEV_AUTH_KEY` | `server/.devauth.json` | Where the local issuer's signing key is kept (`chmod 600`, gitignored) |
| `JAROKU_OBJECT_STORE` | `fs` | `fs` \| `s3`. Where an agent's files live. `fs` roots under `runtime/.objects/` and refuses `NODE_ENV=production` — see [storage isolation](#storage-isolation) |
| `JAROKU_S3_ENDPOINT` / `_BUCKET` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | — | The bucket, when `JAROKU_OBJECT_STORE=s3`. R2, S3 and MinIO all work; `_FORCE_PATH_STYLE=false` for an AWS bucket in the host |
| `JAROKU_OBJECT_SIGNING_KEY` | generated into `server/.objectkey` | Signs presigned object URLs. **Required in production**: a per-replica key produces URLs that verify on one replica and nowhere else |
| `JAROKU_SECRET_STORE` | `dotenv` | `dotenv` \| `kms`. `dotenv` is `runtime/.env` and refuses `NODE_ENV=production`, because one file has no workspace in it |
| `JAROKU_MASTER_KEY` | — | Wraps each workspace's data key when `JAROKU_SECRET_STORE=kms`. No generated fallback: a regenerated master key would make every stored credential permanently unreadable |
| `JAROKU_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | — | The Google OAuth app the Gmail connector is granted through. **Not** the Gemini credential — that is `GOOGLE_API_KEY` under [Models](#models), and setting one will not do the other's job. Unset means the connector is listed as unavailable, which is the local default and not an error |
| `JAROKU_OAUTH_SLACK_CLIENT_ID` / `_SECRET` | — | The same, for Slack |
| `JAROKU_OAUTH_REDIRECT_BASE` | `http://localhost:<port>` | Where a provider sends the browser back. `{base}/v1/oauth/{provider}/callback` must be registered as an authorised redirect URI |
| `JAROKU_APP_URL` | `http://localhost:5173` | Where the browser is sent once a flow finishes. A `returnTo` is a PATH joined to this and never a URL of its own — see [the flow](#the-flow-and-the-two-things-that-defend-it) |
| `JAROKU_MCP_ALLOW_LOOPBACK` | on in dev | `0` refuses loopback MCP endpoints locally too. Always off under `NODE_ENV=production`, and no value overrides that — it exists so `npm run mock:mcp` keeps working |
| `JAROKU_CHECKPOINTER` | `sqlite` | `sqlite` \| `postgres`. Where pause/resume/branch state lives |
| `JAROKU_CHECKPOINT_PG_URL` | — | The checkpointer's OWN connection. Not `JAROKU_PG_URL`: LangGraph never issues `SET LOCAL`, so it must not borrow the pool whose isolation depends on it |
| `JAROKU_RUN_SANDBOX` | `local` | `local` \| `fly`. Where a run's code actually executes — see [Sandboxed execution](#sandboxed-execution-and-the-distributed-control-plane) |
| `JAROKU_CONTROL_PLANE_URL` | — | This server's own public address, told to a hosted run so its control-plane client knows where to push and poll. **Required** when `JAROKU_RUN_SANDBOX=fly` |
| `JAROKU_FLY_APP` | — | Which Fly app a run's machine is created in. **Required** when `JAROKU_RUN_SANDBOX=fly` |
| `JAROKU_FLY_API_TOKEN` | — | The Fly Machines API token. Never an agent's own credential — this is the platform's |
| `JAROKU_FLY_API` | `https://api.machines.dev/v1` | Fly's Machines API endpoint. Overridable to point at the fixture (`npm run mock:fly`) |
| `JAROKU_SANDBOX_IMAGE` | — | The sandbox image, as `name@sha256:…` — a bare tag is refused. **Required** when `JAROKU_RUN_SANDBOX=fly` |
| `JAROKU_RUN_TOKEN_SIGNING_KEY` | generated into `server/.runtokenkey` | Signs run tokens. **Required in production**, same reasoning as `JAROKU_OBJECT_SIGNING_KEY` |
| `JAROKU_NO_AUTORUN` | — | Set to `1` to skip the startup run |
| `JAROKU_REDIS_URL` | — | Jaroku's own Redis. Unset means the queue is unconfigured: the dispatcher falls back to an in-memory backend and no cross-replica bridge is created — see [queueing](#queueing-fairness-and-per-workspace-limits) |
| `JAROKU_EVAL_CONCURRENCY` | `4` | Slots in the **eval** pool. No longer shares a pool with the interactive run |
| `JAROKU_INTERACTIVE_CONCURRENCY` | `1` | Slots in the **interactive** pool. Above 1 does nothing yet — see what Session 5 does not do. A run refused a slot now hands its per-workspace reservation straight back rather than holding it for the lease's hour |
| `JAROKU_WORKSPACE_CONCURRENCY_<CLASS>` | per class | How many of one job class ONE workspace may have in flight, e.g. `JAROKU_WORKSPACE_CONCURRENCY_RUN_EVAL=4` |
| `JAROKU_LIMIT_<PROVIDER>` | `16` (fake) / `2` (real) | Per-provider concurrent-run cap, e.g. `JAROKU_LIMIT_ANTHROPIC=4`. Now global across every eval, not per eval |
| `JAROKU_JOB_TIMEOUT_MS` | `180000` | Per-eval-job wall-clock deadline (the `run.eval` class default) |
| `JAROKU_JOB_TIMEOUT_MS_<CLASS>` | per class | Overrides one class's deadline, e.g. `JAROKU_JOB_TIMEOUT_MS_JUDGE=30000` |
| `JAROKU_WORKER_CLASSES` | — | Which job classes `npm run worker` drains. Empty today — nothing is registered against it yet |
| `JAROKU_WORKER_CONCURRENCY` | `4` | Pool slots in a worker process |
| `JAROKU_WORKER_DRAIN_MS` | `30000` | How long a worker waits for in-flight jobs on SIGTERM before handing the stragglers back |
| `JAROKU_JOB_ATTEMPTS` | `3` | Total attempts per job, including the first |
| `JAROKU_RETRY_BASE_MS` | `2000` | Base for exponential retry backoff |
| `JAROKU_MCP_TIMEOUT_MS` | `10000` | Per-request ceiling during MCP discovery |
| `JAROKU_MCP_DISCOVERY_MS` | `30000` | Whole-discovery ceiling, so slow pages can't stall forever |
| `JAROKU_PLATFORM_KEY` | on | `off` / `0` / `false` / `no` stops the platform's provider key being lent to any workspace, without a restart. The kill switch for a free tier being farmed — see [BYOK and the platform key](#byok-and-the-platform-key) |
| `JAROKU_SANDBOX_USD_PER_SECOND` | `0` | What a second of sandbox wall clock costs this deployment. Zero means it is not charged for, which is a priced zero and not an unknown |
| `JAROKU_STORAGE_USD_PER_GIB_MONTH` | `0` | What a GiB held for a month costs. Per month because that is the unit every object store quotes, so the number can be copied off an invoice rather than divided by hand |
| `STRIPE_SECRET_KEY` | — | Payments are off until this AND the webhook secret are both set. An unverifiable webhook is worse than none |
| `STRIPE_WEBHOOK_SECRET` | — | Verifies the webhook signature, which is that endpoint's whole authentication |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | — | Where a checkout returns the browser |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Overridable to point at a fixture rather than at Stripe |
| `JAROKU_PUBLIC_URL` | `http://localhost:<port>` | Where a **browser** can reach this server. Baked into the GitHub App's manifest at registration — the webhook URL and both callbacks are built from it — so it is one variable to set before registering in production, and re-registering is what changes it afterwards |
| `JAROKU_GITHUB_APP_ID` / `_SLUG` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_PRIVATE_KEY_B64` | — | The GitHub App this deployment is. **Written by the registration callback, never by hand** — GitHub hands them back through the manifest conversion and the server stores them. The private key is base64 because a PEM is nothing but newlines and the `.env` format has no escape for one |
| `JAROKU_GITHUB_WEBHOOK_SECRET` | — | Verifies a delivery's signature, which is that endpoint's whole authentication. An App supplies its own at registration; this is what a personal-access-token deployment sets by hand |
| `JAROKU_GITHUB_API` | `https://api.github.com` | GitHub's API host. Overridable for GitHub Enterprise Server, or to point at the fixture (`npm run mock:github`) |
| `JAROKU_GITHUB_WEB` | `https://github.com` | GitHub's **web** host — the App install screens and the OAuth token exchange, which do not live on the API host. Overridable for the same two reasons |
| `JAROKU_GITHUB_TIMEOUT_MS` | `20000` | Per-request ceiling on a GitHub API call |
| `RAILWAY_API_TOKEN` | — | Your Railway **account** token. Written by the deploy panel, never by hand |
| `JAROKU_RAILWAY_API` | `https://backboard.railway.com/graphql/v2` | Railway's GraphQL endpoint |
| `JAROKU_RAILWAY_CLI` | `railway` | The CLI binary used to upload a project |
| `JAROKU_RAILWAY_TIMEOUT_MS` | `20000` | Per-request ceiling on a Railway API call |
| `JAROKU_DEPLOY_TIMEOUT_MS` | `900000` | Wall-clock ceiling on one upload + build |
| `JAROKU_DEPLOY_FOLLOW_MS` | `600000` | How long to keep watching a build before saying so |

### Models

| Variable | Default | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Planning, generation, editing, explain, judging — **and** running an agent on Claude |
| `OPENAI_API_KEY` | — | Running an agent on OpenAI. Nothing Jaroku itself does uses it |
| `GOOGLE_API_KEY` | — | Running an agent on Gemini. Nothing Jaroku itself does uses it. Not the Gmail connector's credential — that is `JAROKU_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET`, which will not run a model |
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
| `JAROKU_WORKSPACE_ID` | Which workspace a run's checkpoints belong to. Part of the thread id on the Postgres checkpointer, ignored on SQLite |
| `JAROKU_AGENT_DIR` | Import the project from THIS directory instead of `runtime/agents/<id>/`. What a version materialised out of the object store is handed to |
| `JAROKU_CONTROL_DIR` | Where the MCP bridge exchanges confirmation approvals locally. Its **absence** is how a copied-out project knows nobody is watching |
| `JAROKU_CONTROL_PLANE_URL` / `JAROKU_RUN_TOKEN` | Set on a HOSTED run only. The HTTP control plane a sandboxed run pushes trace/control to and polls pause/resume from — see [Sandboxed execution](#sandboxed-execution-and-the-distributed-control-plane). Absent locally, which is how the runner knows to use the file/pipe path instead |
| `JAROKU_PROJECT_TAR_URL` | Set on a HOSTED run only. Where `sandbox/boot.py` fetches the run's project archive from before extracting it and executing the real command |
| `JAROKU_MCP_CONFIRM` | `require` \| `skip`. Defaults to require under a host, skip standalone |
| `JAROKU_MCP_CONFIRM_TIMEOUT_S` | `120` — how long the gate waits before **denying** |
| `JAROKU_MCP_CALL_TIMEOUT_S` | `60` — wall-clock ceiling on one MCP tool call |
| `JAROKU_MCP_MAX_RESULT_CHARS` | `20000` — cap on what one MCP result may hand back |
| `JAROKU_MCP_<SERVER>_TOKEN` | A server's credential. Written by the UI, never logged |

### A deployed agent (set on the host by the deploy, or by hand outside Jaroku)

| Variable | Purpose |
|---|---|
| `PORT` | What `serve.py` binds. `8080` by default; hosting platforms set it themselves |
| `JAROKU_SERVE_TOKEN` | The bearer token `/run` requires. Minted per deploy and shown once |
| `JAROKU_SERVE_PUBLIC` | `1` to serve `/run` with **no** authentication. Refuses to start otherwise |
| `JAROKU_SERVE_CONCURRENCY` | `4` — simultaneous requests; over it, `429` |
| `JAROKU_SERVE_TIMEOUT_S` | `30` — how long one client may hold a connection before it is dropped |
| `JAROKU_PROVIDER` / `JAROKU_MODEL` | What the deployed agent runs on. `fake` is refused |

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

The tenancy suites are the gate for every session of the hosted migration. They run against
SQLite always, and against Postgres as well when `JAROKU_PG_URL` is set — the same assertions,
both drivers, because the ways the two differ are almost all silent.

```bash
cd server
npm run typecheck        # tsc --noEmit
npm run migrate          # apply pending migrations and exit

# tenancy — see "The tenancy model"
npm run test:tenancy     # two workspaces; neither can read, mutate or enumerate the other's
npm run test:acceptance  # Session 2's gate: two accounts using the app AT THE SAME TIME
npm run test:channels    # every WS channel, audited for workspace scoping — see below
npm run test:db-boundary # no driver outside src/db/; every store method takes a context first
npm run test:rls         # the policies, exercised: forced, write-checked, fail-closed unscoped
npm run test:trace       # trace scoping, and that workspace_id never reaches an emitted event
npm run test:identity    # users, workspaces, memberships, audit
npm run test:driver      # the driver choice, and the two combinations it refuses to boot on

# storage — see "Storage isolation"
npm run test:object-keys # every spelling of a traversal, refused before it becomes a path
npm run test:objects     # the conformance suite, on BOTH stores, plus AWS's own SigV4 vectors
npm run test:project-store # versions are immutable; undo is a pointer move, not a copy
npm run test:generation  # stream, stage, validate, commit — and a rejection leaving nothing
npm run test:edit-versions # a proposal never touches the live version; apply publishes the next
npm run test:read-only   # the block list, checked against a real published version
npm run test:store-reads # the local copy is DELETED, then the graph view and validator still work
npm run test:secrets     # the local store: a wrapper, with envWriter's refusals intact
npm run test:vault       # envelope encryption, the row binding, rotation, a wrong master key
npm run test:secret-refs # names and no values, and both stores answering identically
npm run test:checkpoint-threads # one thread name, computed in TypeScript and in Python
npm run test:branch      # a fork copies rows; the parent is hashed before and after

# sandboxed execution — see "Sandboxed execution and the distributed control plane"
npm run test:sandbox-image # digest pinning, and boot.py's archive extraction against hostile tars
npm run test:egress-policy # every named private/link-local/reserved range, DNS rebinding, pinning
npm run test:egress-connectors # an ALLOWED domain resolving privately is refused; and the Node
                               # and Python block lists held to each other by reading both sources
npm run test:database-url  # a workspace's own DATABASE_URL, the SSRF cases
npm run test:event-bus     # the push/long-poll transport a hosted run's control plane rides on
npm run test:run-tokens    # minting, scoping, expiry, revocation
npm run test:control-plane-routes # the four HTTP routes, auth, scoping, the long-poll, mcp-confirm
npm run test:pool-tokens   # RunPool only mints a token when there is a control plane to use it
npm run test:controlplane-http-python # the runner's own HTTP client, driven against the real routes
npm run test:mcp-confirm-http # mcp_bridge.py's confirmation gate over the hosted control plane
npm run test:trace-ingest-metrics # a dropped event is counted, not merely logged
npm run test:backpressure  # bytes/line/rate caps, pure
npm run test:code-check    # LocalCodeCheckSandbox against a real uv/python process
npm run test:graph-introspect # a version's graph is introspected at most once, ever
npm run test:fly-sandbox   # FlyMachinesSandbox against a fixture Fly Machines API
npm run test:escape-suite  # each named attack vector, proven against the real refusing code
npm run test:tenancy-isolation # two workspaces, two run tokens, neither reaches the other's run

# connector OAuth and MCP at scale — see "Connector OAuth and the credential vault"
npm run test:oauth-state     # PKCE, and a state that works once even when two callbacks race
npm run test:oauth-service   # the flow end to end; tokens appear in nothing it returns or stores
npm run test:oauth-google    # the scopes asked for, and the seven that are not; and that a
                             # Calendar connection shares no credential with a Gmail one
npm run test:oauth-slack     # errors arriving with a 200; a user token refused as a bot token
npm run test:oauth-refresh   # twelve concurrent callers, ONE call to the token endpoint
npm run test:oauth-injection # a run gets the access token; no token reaches any file
npm run test:oauth-revoke    # disconnect tells the provider, and forgets it either way
npm run test:connector-auth  # every connector declares where its credential comes from
npm run test:connector-secrets # DATABASE_URL refused at save and re-pinned at run; the HTTP
                               # allowlist checked for shape AND for where it points; a
                               # full-access sk_live_ Stripe key refused outright

# the connector templates themselves — Python, no SDKs, no network. See "Connectors".
npm run test:connector-catalog # check_catalog() and check_failures_raise(), which nothing ran
npm run test:connector-gcal    # the outgoing call, not the reply: singleEvents, the clamp, the
                               # fetch-merge update, and a cache that cannot outlive its credential
npm run test:connector-stripe  # read-only proven from the syntax tree, and the scanner fed
                               # violations because a check nobody has watched refuse is suspect
npm run test:connector-http    # the adversarial one: every refusal counted, not read
npm run test:mcp-tenancy     # two workspaces, one endpoint, two credentials
npm run test:mcp-url         # the hostile fixtures, at discovery AND at re-discovery
npm run test:mcp-discovery-queue # off the request path, collapsed, and the tool list survives

# queueing and fairness — see "Queueing, fairness, and per-workspace limits"
npm run test:redis       # the connection, and that an unset URL refuses rather than defaults
npm run test:jobs        # every job class has a config; env overrides; idempotency keys
npm run test:dispatcher  # starvation, thundering herds, caps, orphaned leases — on BOTH backends
npm run test:semaphores  # named leased caps, expiry without release, idempotent release
npm run test:worker-loop # handler routing, a throwing handler, and the drain window's hand-back
npm run test:chaos       # a worker that vanishes mid-job; two reapers racing one expired lease
npm run test:event-bridge # self-echo, no re-publish, a garbage message; cross-process needs Redis
npm run test:eval-off-trace # twenty eval runs stay off `trace` even across replicas
npm run test:eval-dispatch # enqueue → admit → run → retry/exhaust, through the real dispatcher
npm run loadtest:queue   # N workspaces x M jobs: admit p50/p95, fairness ratio, head-of-line

# cost, budgets and billing — see "Cost metering, budgets, and billing"
npm run test:plans       # every plan complete, the nesting nests, table and code agree at boot
npm run test:metering    # cost from steps, redelivery, unpriced-not-zero, a branch bills nothing
npm run test:balances    # ten simultaneous runs against one balance, and no overdraft
npm run test:gate        # the ceiling bounds what is STARTED; a refusal names what would clear it
npm run test:eval-budget # a fan-out is many starts; the running job is never killed
npm run test:estimate    # range, basis, null-for-unpriced — and affordability from the same gate
npm run test:byok        # a key reaches its own run's provider and nothing else
npm run test:platform-key # the kill switch, the plan, and a ceiling on what WE pay
npm run test:stripe      # signature, replay window, rotation, and the state machine

# hardening, abuse and the data lifecycle — see "Hardening, abuse, data lifecycle, observability, deploy"
npm run test:security-headers # a policy on EVERY answer, including the 500 nobody remembers
npm run test:rate-limit  # token buckets on both backends, and an honest Retry-After
npm run test:edge-rules  # the edge's exempt list and the application's are the same list
npm run test:abuse-signals # the shape of a miner; a score that decays; a keyed subject digest
npm run test:enforcement # nothing automatic suspends; a human's decision does not lapse
npm run test:partitions  # month arithmetic, and the two mistakes that cost data
npm run test:retention   # a run one day inside the window survives; a longer plan keeps more
npm run test:workspace-export # a real secret, and the archive greped for its value
npm run test:deletion    # the bystander workspace still has everything; the receipt outlives it
npm run test:log-redaction # a known key, and eight sinks it must not reach
npm run test:tracing     # four tiers, one trace id, the run id on every span
npm run test:metrics     # every alert names a metric something actually emits
npm run test:migration-gate # what breaks a version that is still serving
npm run test:boolean-literals # a literal 0 is not a false, and only Postgres says so
npm run migrate:check    # ...and the same check, as the gate the deploy pipeline runs
npm run drill:restore    # restore into a scratch database and verify what came back
npm run billing:stuck    # webhook events that arrived and never finished — the operator queue

# auth — see "Authentication and membership"
npm run test:http        # the HTTP layer: error envelope, body caps, log redaction
npm run test:jwks        # key caching, forced refresh with a leash, symmetric keys refused
npm run test:jwt         # alg:none, algorithm confusion, wrong issuer/audience, expiry, skew
npm run test:session     # first-sight provisioning, concurrent sign-in, workspace adoption
npm run test:resolve     # membership lookup, denial auditing, the cache's staleness window
npm run test:capabilities # the role matrix, and that every relay command is classified
npm run test:tickets     # single use under concurrency, hashing, the origin allowlist
npm run test:members     # invite / accept / role / remove, and the last-owner guard

# the database boundary
npm run test:migrate     # forward-only, checksummed, transactional, refuses an edited file
npm run test:db          # the driver conformance suite, on SQLite
npm run test:db-postgres # the same suite on Postgres, plus placeholder rewriting
npm run test:shape-parity # one Run and four Steps through both drivers, compared field by field

npm run test:protocol    # the file-emission stream parser, at every chunk boundary
npm run test:plan        # plan parsing + degradation + connector reconciliation
npm run test:pricing     # exact/prefix matching, cache multipliers, unpriced → null
npm run test:pool        # capacity as a hard cap, attribution, deadlines
npm run test:aggregate   # cost from steps, unknown vs free, partial-pricing flags
npm run test:retry       # transient vs deterministic classification, and the real backoff schedule
npm run test:judge       # rubric prompt construction + verdict parsing
npm run test:cleanup     # checkpoint sweeping (never touches interactive runs)
npm run test:env-writer  # .env writes: no clobbering, no injection, exact round trips
npm run test:providers   # provider keys: names out, values never; test writes nothing
npm run test:mcp-impact  # the impact ratchet, in both directions
npm run test:mcp-client  # discovery, pagination, auth, failure classification
npm run test:mcp-registry # override voiding, and a failed refresh keeping its tools
npm run test:mcp-isolation # a hostile server can't corrupt a trace or hang a run
npm run test:mcp-validate  # MCP wiring, shadowing, and calls checked against the schema
npm run test:mcp-hardening # a server's own advertisement, bounded at the point it arrives
npm run test:deploy-artifacts # the image's deps, and that no artifact carries a secret
npm run test:deploy-secrets   # names out, values never; the log scrubber's hard cases
npm run test:deploy-store     # deploy status transitions, restart reconciliation, Railway failure kinds

# the two lineages — see "GitHub"
npm run test:github-app       # the App's seven permissions, the JWT, the token cache, the state
npm run test:github-app-flow  # register → install → mint → post a check run that IS a check run
npm run test:github-sync      # six sync states, including the three you cannot produce by hand
npm run test:github-push      # versions → commits: deletions, subdirectories, squash, trailers
npm run test:github-first-push # the empty repository, the orphan branch, and 403 ≠ 401
npm run test:github-checks-line # check runs AND statuses; "unreadable" is not "none reported"
npm run test:check-runner     # one pull request opens exactly one check run
npm run test:github-webhook   # signature over raw bytes, delivery dedup, a tag that is not a branch
npm run test:github-staging   # hunk-level staging, and what a partial selection makes a push
npm run test:github-trailers  # §B.8.1's receipt, and the fields it omits rather than guesses
npm run test:github-workflow  # the generated build check, and a customised one left alone
npm run test:hunks            # whole-file vs partial selection
npm run test:unpushed-stack   # reorder, squash, drop — and the intermediate state that refuses
npm run test:secret-scan      # four surfaces, and no finding that carries a matched value
npm run test:live-diagnostics # the cheap half of the validator, on an unsaved buffer
npm run test:semantic-diff    # the agent's level, not the text's; the MCP grant line leads
npm run test:trace-diff       # two traces, per step; and the shadow-run sweep
npm run test:eval-check       # the check's title and summary, and null-not-zero deltas
npm run test:check-policy     # §B.1.3's provider boundary: whose money a stranger's PR spends

# build sessions — see "Threads"
npm run test:threads         # what a row promises: one agent, many sessions, and no delete path
npm run test:thread-status   # §3.3's precedence, one fixture per rung, and the collision count
npm run test:thread-channel   # two sockets in two workspaces; a read answers one, a write tells all
npm run test:thread-binding   # ownership from the items, liveness from the owner, through the app
npm run test:agent-lifecycle  # archive leaves the pickers and nothing else; a rename survives the sync
npm run test:thread-title     # the cut: one line, at a word boundary, saying it was cut
npm run test:thread-archive   # the ABSENCE: 208 source files audited for a path that deletes one

# what is waiting on you — see "The Inbox"
npm run test:inbox-registry   # every type's resolve predicate, tested by resolving it EXTERNALLY
npm run test:inbox-store      # Law 3: forty `record` calls are one row with count = 40
npm run test:inbox-generators # mostly what must NOT happen: reading a failure is not a tenth one
npm run test:inbox-reconciler # idempotent, constant in agents, and isolated in BOTH directions
npm run test:inbox-derive     # a trigger and its predicate live in two files; this is the round trip
npm run test:inbox-snapshot   # §3's three verbs, and why collapsing any two breaks something
npm run test:inbox-actions    # undo restores the PRIOR value rather than clearing the column
npm run test:inbox-payload    # one known secret, every route into a payload tried against it

# what the workspace is doing — see "Activity"
npm run test:activity-range   # one window, or four modules describing four different moments
npm run test:activity-spend   # four honesty rules, every one a bug this product has shipped once
npm run test:activity-health  # a paused-and-resumed run is ONE run; a cancellation is not a failure
npm run test:activity-pulse   # the columns SUM to the hero row above them
npm run test:activity-leaderboard # one agent and forty cost the same number of statements
npm run test:activity-feed    # the keyset, proved by inserting rows ABOVE the cursor mid-scroll

# the composer — see "The composer"
npm run test:effort           # the clamp, the per-request ceiling, and that the adapter is CALLED
npm run test:attachments      # the budget, and that a picked ref reaches the turn and the prompt
npm run test:conversation-settings # §7's refusal to backfill; the pin is a security rule
npm run test:permission-shield     # §12.7 and §12.8, verified by bypassing the UI
npm run test:turn-variants    # never overwrite variant 1's metadata; and the store has no publish path
npm run test:turn-interaction # a note is SHARED and a pin is PERSONAL — the same question, opposite

# tiers — see "Plans, tiers and entitlements"
npm run test:plans            # the table says what the pricing says
npm run test:entitlements     # a command with neither a check nor the word "none" fails here
npm run test:checkout-surfaces # the pricing page sells nothing, and sells nothing ungated

# per-agent access — see "Per-agent access"
npm run test:access-resolver  # every gated command driven with the client bypassed entirely
npm run test:access-denied    # the row that is the only evidence a grant is wrong

# the desktop wrapper — see docs/tauri.md
npm run test:desktop-contract # the seams between Rust, JSON and TypeScript, read as text
npm run test:desktop-smoke    # index.ts spawned the way the shell spawns it, driven over a real socket
npm run test:desktop-supervisor # the port a previous backend was still holding, read as free
```

Some suites are **source audits** rather than arithmetic ones, and that is deliberate: the failure
they exist for is a feature whose every calculation is correct and which nothing ever calls.
`test:effort`, `test:attachments` and `test:turn-variants` each read the dispatch, the wire and the
client for the links themselves — every other assertion in all three was once true of code that
never ran on a real turn.

```bash
cd client
npm run typecheck
npm run test:plan-flow   # the plan → confirm → generate state machine
npm run test:note-kind   # rule vs note classification
npm run test:inline-code # inline code detection in prose
npm run test:title       # title truncation (never mid-word)
npm run test:deploy-store # the deploy panel's state, and the races it has to survive
npm run test:export      # CSV/JSON export preserves every caveat
npm run test:csv         # RFC-4180 quoting
npm run test:auth        # retry vs stop: the one decision the socket layer must not get wrong
npm run test:invite      # the invitation link round trip, including the tokens `+` and `/` break
npm run test:reset       # NO store retains a row across a workspace switch
npm run test:secrets-store # the credential list's own state, and what elevation does to it
npm run test:truncate-path # a filename survives the width; the middle of the path gives way
npm run test:composer-triggers # #, @ and ! fire only where they are triggers
npm run test:thread-store    # a snapshot replaces; one row navigates nothing; the live cost delta
npm run test:thread-cost     # three states, and a projection that refuses to extrapolate from zero
npm run test:thread-groups   # §4.2's two sorting rules, and the input it must not reorder
npm run test:thread-filter   # the five chips and the text match, over one list
npm run test:thread-resume   # which turn §4.5 opens at, and the hint the row shows for it
npm run test:thread-archive  # what §3.4's notice names, and the archive that gets none
npm run test:host-config     # what a HOST may tell this bundle, and the four shapes it may not
npm run test:deep-link       # jaroku:// as untrusted input; the refusals are the interesting half
npm run test:session-vault   # localStorage in a browser, the keychain under a host, never both
npm run test:inbox-board     # the board's rules, and that no card offers an action nothing does
npm run test:activity-metrics # each metric declares its own polarity; unknown renders `--`, never 0
npm run test:composer-bar    # hiding a control moves nothing else, and the bar never wraps
npm run test:connector-deck  # a disabled connector renders grayscale and STAYS in the deck
npm run test:turn-metadata   # the row's order is stable and absent items collapse in place
npm run test:entitlement-store # a half-understood refusal must not become an upsell card
npm run test:dead-controls   # no <button> renders enabled with nothing behind it
npm run test:access-tab      # every assertion is about a sentence or an ABSENCE
npm run test:permission-ui   # the client's copy of the matrix, held to the server's own file
npm run test:type-scale      # the ladder, and which face carries what — a property of ALL of it
npm run test:colour-system   # the palette, and the hex literal that stays the colour it was
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

MCP has a fixture too, but a live one rather than a recording — see
[Testing without a real server](#testing-without-a-real-server). `npm run mock:mcp` starts a
server that speaks real MCP, so the whole path is exercisable with no third party and no spend.

`npm run mock:github` is the same idea for [GitHub](#github), and it is a real object store rather
than a response table: blobs, trees, commits and refs are content-addressed the way git does it, so
a push that "succeeds" against a repository that never changed is a failure the fixture can show
you. It also implements the App surface **and GitHub's two browser screens**, so registering,
installing, pushing, opening a pull request and reading a check back all run with no GitHub account:

```bash
npm run mock:github     # prints its URL
JAROKU_GITHUB_API=http://127.0.0.1:8936 JAROKU_GITHUB_WEB=http://127.0.0.1:8936 npm run dev
```

Its control plane scripts the states that are almost impossible to produce by hand against a real
repository — a colleague's push, a force-push that produces `diverged`, a branch deleted under a
live link, a revoked grant, a token that may not read checks, and a Checks API that is App-only.

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

## The tenancy model

Jaroku is becoming a hosted, multi-tenant product. Session 1 of that migration is done: every
row in the system belongs to a **workspace**, and it is structurally difficult to write a query
that crosses one. Session 2 is done too — see [authentication and
membership](#authentication-and-membership) for who decides *whose* workspace a request is in.

**The local path is untouched and stays the default.** `npm run dev` needs nothing installed and
nothing running: SQLite, the fixtures, the mock MCP server, no Postgres, no Docker.

### Workspace, not user

Every scoping column is `workspace_id`. `user_id` appears in exactly three places: membership
rows, audit rows, and "who did this" attribution. A single user is a workspace with one member,
so adding a second member later is a row rather than a re-migration of every table and a rewrite
of every query.

| Table | What it is |
|---|---|
| `users` | One row per person. `external_id` is the auth provider's `sub`, opaque and never parsed |
| `workspaces` | The tenancy unit. `personal` is created at signup; `team` is everything else |
| `workspace_members` | Who may act in a workspace, and as what: `owner` / `admin` / `member` |
| `audit_log` | Membership changes, deletions, and every denied cross-tenant attempt |
| `agents` | The agent list, which used to be a directory listing. Slugs are unique **per workspace** |
| `agent_versions` | `{path: {sha256, bytes}}` per version. Written now; Session 3 reads it |

`runs`, `steps`, the eval control plane, the MCP registry and the deploy records all gained a
`workspace_id` referencing `workspaces.id`.

### The one exception to the frozen schema

`schema/events.md` v1 is unchanged. `workspace_id` on `runs` and `steps` is a **storage** column —
which tenant a row belongs to is a property of the database, not of the event — and it must never
appear in an emitted `run_start`, `step` or `run_end`.

That is a `SELECT *` away from being false at all times, so the trace store names its columns and
`npm run test:trace` asserts both halves: nothing called `workspace_id` comes back on a Run, a
Step or a history summary, and every field schema v1 promises is still there.

### Two rules, enforced

**Every store and repository method takes a context first.** A parameter you must supply is
harder to forget than a `WHERE` clause you must remember.

```ts
type TenantContext = { workspaceId: string; actorUserId: string | null; role: Role; requestId: string };
type SystemContext = { actorUserId: string | null; role: "system"; requestId: string };
```

Two types, because there are genuinely two situations. Almost everything takes a `TenantContext`.
A short list of operations happen *before* a workspace is known and cannot be scoped by the thing
they are producing — mapping an auth provider's `sub` to a user on first sight, creating that
user's personal workspace, answering "which workspaces do you belong to" — and those take a
`SystemContext`. They are separate types on purpose: the compiler refuses to let a tenant query
run unscoped, and the exceptions are visible in the signatures rather than buried in the bodies.

**Nothing outside `server/src/db/` imports a driver.** `node:sqlite` and `pg` are reachable from
one directory. A module that could open its own connection is a connection nobody scopes.

Both are checked by `npm run test:db-boundary`, which is a plain `tsx` script rather than an
eslint rule — there is no lint toolchain here, and every other check is a script too. It asserts
the drivers *are* imported inside `src/db/` (so a pass cannot come from the feature being
deleted), that no exemption names a method that no longer exists, and that the rule still fails
on text designed to fail it.

### RLS is the backstop, not the enforcement

On Postgres every tenant table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY` plus a
`tenant_isolation` policy with both `USING` and `WITH CHECK`:

```sql
CREATE POLICY tenant_isolation ON runs
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
```

Every detail there is load-bearing:

- **`FORCE`**, because `ENABLE` alone exempts the table owner — and on a modest deployment the
  owner is whoever ran the migrations, often the app, so `ENABLE`-only RLS never applies once.
- **`WITH CHECK`**, because `USING` alone lets a caller INSERT into another workspace and merely
  not read it back, which is a write across the boundary and still a hole.
- **`SET LOCAL`** in the repository's transaction wrapper, because a session-scoped `SET` leaks
  to whoever gets that pooled connection next.
- **`NULLIF`**, because a custom setting that has ever been set keeps *existing* on that
  connection holding `''`, so the next unscoped user of a pooled connection gets `''` rather than
  NULL — and `''::uuid` raises instead of matching nothing.
- **A missing setting matches nothing.** Fail closed, which is the entire point.

`audit_log` and `workspace_members` are deliberately policy-free, and both for the same reason: a
policy on either would break the thing that makes every other policy work. The audit table's most
important row is a *denied* attempt, whose workspace may not exist; and `workspace_members` is
what *answers* which workspace a request may act in.

**The application must not connect as a superuser or with `BYPASSRLS`** — either ignores every
policy unconditionally, and nothing in the schema would tell you. Migration `009_rls` creates a
`jaroku_app` role with neither, and `npm run test:rls` asserts it.

SQLite has no RLS and no roles, so on that driver there is no second wall: the repository layer is
the whole of the enforcement. That is acceptable for what SQLite is here — one person, one machine
— and it is why `npm run test:tenancy` runs there too, and why the driver
[refuses to boot in production](#what-session-2-deliberately-did-not-do).

### Every channel, not just the ones somebody noticed

RLS guards what a *query* returns. Nothing there guards what the server **pushes** — and a
WebSocket relay's whole job is pushing. The stale-broadcast bug has now been found twice by
hand, and finding them one at a time as somebody happens to notice is not the same as knowing
there are none left.

So `npm run test:channels` enumerates rather than remembers. It reads `wsRelay.ts` for every
`channel:` it can emit and `COMMAND_CHANNEL` for every channel an answer can land on, and fails
when one of them is not classified as either tenant data or connection state. **A channel added
in a later session appears in that list automatically**, so it cannot arrive unclassified.

There are exactly two correct ways to send, and a third that is the bug:

| | |
|---|---|
| `broadcastTo(ctx, …)` | filtered by `workspaceId` ✓ |
| `perClient(…)` | payload rebuilt per recipient ✓ |
| one payload, every socket | **this is the bug** ✗ |

The suite asserts structurally that every sender uses one of the first two, then puts two live
sockets in two workspaces behind it and fires every channel to prove it.

**The scope belongs to the operation, not to the process.** The subtler half of the same bug is
one layer up, where the app chooses *which* context to hand the relay. A single `buildContext`
covered planning, generation, editing and explaining — four subsystems with four independent
locks, so two can be in flight at once and one variable cannot hold both answers. Worse, it was
assigned *before* the busy guard, so a request that was **refused** still repointed it: workspace
B's rejected `generate` redirected workspace A's still-streaming source code into B's build pane.

Each now has its own scope, claimed only once its operation has actually started, and a refusal
is answered to whoever asked rather than through the scope. `test:channels` asserts both
properties by reading `index.ts`, because the ordering is the whole of the fix and nothing about
it is visible at a type level.

### Adding a table

A new table without a `workspace_id`, a policy and a tenancy test **will be rejected**. In order:

1. Write the migration in **both** `server/migrations/postgres/` and `server/migrations/sqlite/`
   under the same number. A dialect with nothing to do gets a comment-only file, so the two
   sequences can never drift.
2. Add `workspace_id`, backfill, constrain, and index with `workspace_id` **leading** — a trailing
   tenant column makes the planner scan an index built for a different question.
3. Add the table to the policy loop in a new RLS migration.
4. Give it a repository whose every method takes a context first.
5. Add its methods to `SCOPED_API` in `src/tenancy.test.ts` and exercise them. The coverage
   assertion fails until you do.

### Running it

```bash
docker compose up -d postgres            # or any Postgres; 5433, not 5432
cd server
JAROKU_DB_DRIVER=postgres JAROKU_PG_URL=postgres://jaroku:jaroku@127.0.0.1:5433/jaroku npm run migrate
JAROKU_DB_DRIVER=postgres JAROKU_PG_URL=postgres://jaroku:jaroku@127.0.0.1:5433/jaroku npm run dev
```

Migrations run as the database **owner**; the server connects as the application role. A server
whose connection cannot apply migrations says which ones are owed and who has to apply them,
rather than failing with a raw privilege error.

Bringing an existing local install across:

```bash
npm run import -- --workspace "Ada's Team" --dry-run   # reads everything, writes nothing
npm run import -- --workspace "Ada's Team"
```

Idempotent and resumable — every insert is `ON CONFLICT DO NOTHING` on an id the source already
assigned, so a failed import is resumed by running it again. `runtime/agents/` is **not** copied:
the projects still live on this machine's disk until Session 3 moves them to an object store.

### What Session 1 deliberately did not do

- ~~**No authentication.**~~ Done in Session 2 — see [authentication and
  membership](#authentication-and-membership). Session 1's prediction held exactly: the shape did
  not change, only the resolution became real. `JAROKU_DEV_WORKSPACE` still names the workspace
  the server acts in **on its own behalf** — the startup run, the sweepers, the restart
  reconciliations — because work nobody triggered still needs a scope. It also *creates* that
  workspace when the name is one no workspace has, as a `team` one, and it prints which kind it
  made. That used to be the only reachable way to obtain a team workspace, which made a plumbing
  switch the door to the entire collaboration half of the product; creating one is a first-class
  action now.
- **The filesystem is still one namespace.** Agent slugs are unique per workspace in the *table*,
  but two workspaces with a `support_bot` would still collide on `runtime/agents/support_bot/`.
  Session 3's object store fixes that with keys built from the workspace id and the agent uuid.
- **Agent files and the graph are still read from a global directory.** Those two relay reads take
  a context and ignore it, so that when the storage moves the signature does not.
- **Cross-workspace maintenance reads run unscoped** and say so in their signatures — the restart
  reconciliations for interrupted evals and deploys, and the startup checkpoint sweep. Under RLS
  they need an administrative connection rather than the app role.

---

## Storage isolation

Three things in Jaroku were files, and all three assumed the server, the agent's code and the
checkpoints share one disk. Hosted they do not: a generation lands on one replica, the edit that
follows on another, and the undo after that on a replica four minutes old. This is what replaced
each of them, and what stayed the same.

**The local path is unchanged and is still the default.** `npm run dev` needs no bucket, no KMS
and no second database — the object store is a directory, the secret store is `runtime/.env`, and
the checkpointer is a SQLite file per run, exactly as before. Each of the three hosted
implementations refuses to run under `NODE_ENV=production`'s opposite: the *local* ones refuse
production, loudly, because each is a single-machine assumption wearing an interface.

### Object layout

```
ws/<workspace_id>/agents/<agent_id>/v<version>/<path>
ws/<workspace_id>/agents/<agent_id>/staging/<staging_id>/<path>
ws/<workspace_id>/exports/<eval_run_id>.csv
```

Every key starts with the workspace, before anything that reads more naturally, so **whose object
this is can be answered from the key alone** — by anybody holding one, without a database. That is
what makes a presigned URL checkable against the context of the request presenting it.

The components are uuids, never slugs. Slugs stopped being globally unique in Session 1, and two
workspaces may each have a `support_bot`; the only user-influenced text in a key is the
project-relative file path, and that is what `safeObjectPath` exists for.

**`..` is the whole hazard.** S3 will happily store a key containing one — to S3 it is two dots —
and the traversal happens later, on whatever turns the key back into a path, which locally is a
directory on somebody's laptop. Both halves are closed: the components a key is built from are
validated, and the local store re-checks the resolved path against its root anyway. `test:object-keys`
covers the plain form, the encoded form, the backslash, and the assembled key that never went
through a builder — because in production a key arrives off a URL and out of a stored manifest at
least as often as it arrives from the builder.

**Presigned URLs** carry one key, one verb and one expiry, signed. A signature proves the URL was
minted here; it does not prove who is holding it — so when a request also carries a session, the
session's workspace must be the one the key names. A URL with a good signature and *no* credential
still redeems, because that is what presigning is: a short-lived bearer capability for one object,
usable by something with no session at all.

### Versions

`projectFs.atomicSwap` renamed a staging directory over a live one. That is atomic on one
filesystem and means nothing across replicas, so it was replaced by two steps that cannot be seen
half-done: **a version's objects are written first, at keys nothing refers to yet and are never
rewritten; then one `UPDATE` moves `agents.current_version`.** A reader arriving in between sees
the previous version whole.

| Operation | Was | Is |
|---|---|---|
| Generate | write `.staging/<id>/`, validate, rename into place | stage under a staging id, validate from the store, publish version *N* |
| Apply an edit | copy the project into `.history/<id>/v<n>/`, rename staging in | publish version *N+1* |
| Undo | restore the snapshot, pop `history.json` | move `current_version` back one, mark the version it left behind |
| Read the file list | `readdir` the project | read the version's manifest |

Immutability is what makes undo cheap: the version being replaced was written once and never
rewritten, so it is still exactly where undo points. No copy, and it works from a replica that has
never seen the agent.

**The honest cost: history begins at the import.** An installation that already had applied edits
keeps its `.history/` directory and it is no longer what Undo reads — the first version is the
project as it stood when it was imported, and Undo covers what has been applied since. Nothing is
lost from the project; what is lost is stepping back through edits made before the migration,
which no second replica could ever have done anyway.

`runtime/agents/<slug>/` does not go away. It is still where a run's subprocess imports from, still
somewhere a user can drop a project by hand, and still portable — it stops being the source of
truth and becomes a materialisation of one.

### The secret lifecycle

The interface has **no `get(ctx, name)`**, and that absence is the design. A request handler cannot
ask for a plaintext value, because no method would answer — so no path exists down which a
credential reaches a socket frame, a log line or a JSON response.

```
set(ctx, name, value)        in
getForRun(runId, names[])    out, into a run's environment, and nowhere else
listNames(ctx)               names, providers, last use — never a value
delete(ctx, name)
```

`getForRun` takes a **run id rather than a context** because its caller is the thing assembling a
run's environment, and a run outlives the request that started it — by then the asking context is
gone. So the run is the unit of authorisation, and its workspace is resolved from the run.

Locally this wraps `envWriter.ts` unchanged: one writer of `runtime/.env`, the round-trip refusal,
the in-place rewrite that leaves every other line alone, the `chmod 600`, and the warning when a
shell variable will shadow the file on the next restart. Hosted, a per-workspace **data key**
seals the values and a **master key** seals the data key; the master key is configuration and
never in the database, so a dump without it is a dump of noise.

Each ciphertext is sealed against `<workspace_id>:<name>` as authenticated data. That is the wall
behind the wall — the repository scope stops the query and RLS backstops the scope, and this makes
going around both pointless: **a ciphertext copied into another workspace decrypts to nothing, and
so does the same row relabelled to another variable name.** Both are attempted by hand, at the SQL
level, in `test:vault`.

Rotation creates a new data key version and re-seals each secret under it; a read uses the key the
*row* names rather than the workspace's newest, so a row not yet reached stays readable and an
interrupted rotation is resumable.

`secret_refs` holds what a workspace has configured — names, what each is for, whether it is set,
when a run last received it — and has no column a value would fit in. Both stores write it, so a
client cannot tell which one answered. `configured` is a column rather than "the row exists",
because a name can be *declared* before it is set: that is what an agent's `required_env` produces,
and the panel asking somebody to fill one in needs to tell "this agent needs it and you have not
set it" from "nobody has ever mentioned that name".

### Checkpoint namespacing

`JAROKU_CHECKPOINTER=sqlite` writes `runtime/.checkpoints/<run_id>.sqlite`, one file per run, as
it always has. `postgres` writes through LangGraph's `PostgresSaver`, on **its own connection** in
**its own schema** (`langgraph`).

Both of those are deliberate. LangGraph never issues `SET LOCAL app.workspace_id`, so it must not
borrow a pool whose isolation depends on that — and a policy on its tables would match nothing and
fail every write. And its migrations run on its own timetable, which must not land in a schema
this repository's forward-only, checksummed runner is supposed to describe.

Which leaves the key as the isolation:

```
ws:<workspace_id>:run:<run_id>      on Postgres
<run_id>                            on SQLite, where one file per run is already a namespace
```

A copied-out project has no workspace and gets the bare form either way. Both sides compute the
name — the server when it dispatches a branch, the runner when it opens a checkpointer — and
`test:checkpoint-threads` runs both and compares, because a disagreement would surface exactly
once, on a branch, as a fork finding no checkpoint at an id the server just read out of its own
database.

**Branching** was `copyFileSync` of the parent's whole checkpoint database, which bought
parent-immutability in the crudest possible way and has no file to copy now. It is an
`INSERT … SELECT` of the parent's checkpoints up to the fork point into a new thread, so every
statement touching the parent is a `SELECT` — `test:branch` hashes the parent's rows before and
after. The columns are read from `information_schema` rather than declared, because the tables are
LangGraph's and it has added one before.

**The sweep** follows the same rules it always did. An eval's checkpoint state is dropped when the
eval finishes; the run rows, steps, jobs, scores and traces stay; **an interactive run's
checkpoints are never swept**, and that is true by construction rather than by a filename pattern,
because the run ids come from the eval's own job rows.

---

## Sandboxed execution and the distributed control plane

Session 4 of the hosted migration. Three places used to execute model-written Python directly on
this process — a run (`processManager.ts`), the import check (`validator.ts`), and graph
introspection (`graphIntrospect.ts`) — and all three now go through an interface instead of a raw
`child_process.spawn`. The local path is unchanged: `npm run dev` still spawns exactly the
subprocess it always has, with nothing installed and nothing running. A hosted run instead
executes inside its own Fly Machine, reachable only by the egress it was declared to need,
authenticated by a token scoped to that run and nothing else.

### RunSandbox and CodeCheckSandbox

Two interfaces, not one, because a full agent run and a twenty-second static check are genuinely
different shapes of problem:

| | `RunSandbox` | `CodeCheckSandbox` |
|---|---|---|
| what it runs | a whole agent execution | one short-lived check |
| has a run id, a trace, a control plane | yes | no |
| implementations | `LocalSubprocessSandbox`, `FlyMachinesSandbox` | `LocalCodeCheckSandbox` |
| selected by | `JAROKU_RUN_SANDBOX=local\|fly` | not yet selectable — see below |

`LocalSubprocessSandbox` is `ProcessManager` unchanged, under the interface's name.
`FlyMachinesSandbox` turns a `SandboxSpec` into one Fly Machine per run — the image pinned by
digest, resources from `SandboxLimits`, and env carrying only the run's control-plane credentials
and project archive URL, nothing ambient. `RunPool` takes a sandbox factory in its constructor
rather than building one itself, so which kind a slot runs is a config choice, never a rewrite of
the pool.

**A documented gap, not a silent one.** `validator.ts` and `graphIntrospect.ts` both moved onto
`CodeCheckSandbox`, and its only implementation today is local — the same subprocess check this
codebase always ran, now behind an interface. A hosted implementation running the check inside
the sandbox image instead of on the control plane is the natural next step (the image already
carries `jaroku_runner` and Python) and was not built this session.

### The egress policy

A sandbox is granted exactly what a run declares it needs, computed fresh every time:

```
provider   → api.anthropic.com  OR  api.openai.com, never both, never for the "fake" provider
connectors → each connector's fixed hosts (gmail.googleapis.com, www.googleapis.com,
             api.stripe.com, slack.com, …)
postgres   → only the workspace's own validated DATABASE_URL, never a fixed host
http       → only the workspace's own HTTP_ALLOWED_DOMAINS, resolved and pinned per run
```

Every host is resolved and **pinned** before the sandbox starts — the sandbox is handed literal
IPs, never a hostname to re-resolve, which is what closes the DNS-rebinding window between
validation and use. **Every private, link-local and reserved range is refused unconditionally**,
including the cloud metadata endpoint (`169.254.169.254`) and its IPv4-mapped IPv6 form — and a
host is refused *whole* if even one of its resolved answers lands in one of them, not merely
filtered down to the answers that didn't.

A workspace's own `DATABASE_URL` is one of the egress hosts that is genuinely user-supplied, and is
validated separately (`validateDatabaseUrl`): scheme, a small port allowlist (5432, 5433, 6543 —
never an arbitrary port a scan of the workspace's own infrastructure could use), and the identical
private-range refusal every other host goes through.

The HTTP connector's `HTTP_ALLOWED_DOMAINS` is the third such host — the same shape, handled the
same way. Parsed and normalised at save (and a domain resolving into a private range is refused
*there*, so `metadata.internal` is answered while somebody is looking at it), then **resolved
fresh and pinned per run** by `ConnectorSecrets.httpEgress`, which is the check that actually
holds. Refusal is **per domain rather than per run**: one entry that has since been repointed at a
private address contributes no rule and is logged, while the other three still work — the same
judgement `mcpEgressRules` makes about a server that no longer validates.

**Being on the allowlist buys nothing against the address check**, and `test:egress-connectors`
exists to say so: an *allowed* domain that resolves to `169.254.169.254` is refused. Allowed is
not the same as reachable, and a builder that trusted its own allowlist would make a text field
into a read of the metadata server. That suite also holds the two private-range block lists to
each other by reading the other language's source — the rule is written twice on purpose, because
the control plane cannot check a request the sandbox originates and the sandbox cannot call
TypeScript, so the only way it fails is drift.

### The sandbox image

One image (`runtime/sandbox/Dockerfile`), built once, reviewed once, and **referenced only by
digest** — a tag can be repointed by anyone with push access to the registry; a digest cannot.
It ships Jaroku's own reviewed code (`jaroku_runner`, the interceptor, the tool templates) and
**none of an agent's** — the untrusted part. `boot.py`, the image's `ENTRYPOINT`, fetches the
run's project archive fresh at boot from a presigned URL, extracts it with the same
traversal/symlink refusal `projectFs` already enforces on local disk, points
`JAROKU_AGENT_DIR` at the result, and `exec`s the real run command in its own place — there is no
wrapper process left running above the workload for a signal to get lost in.

### The control plane, over HTTP

A hosted run has no local pipe for this process to read and no shared control file — so it
**pushes** instead of being read from, and **polls** instead of being told:

| Route | Direction | Carries |
|---|---|---|
| `POST /v1/runs/:id/trace` | runner → server | batched trace events, the exact schema-v1 shape |
| `POST /v1/runs/:id/control` | runner → server | one `@@JAROKU_CTRL@@`-shaped control line |
| `GET /v1/runs/:id/control` | server → runner | a bounded long-poll: `pause`, `resume`, or `none` |
| `POST /v1/runs/:id/mcp-confirm` | runner → server | blocks until a human answers, or its own timeout denies |

Every route is authenticated by a **run token** — self-contained and HMAC-signed, the same shape
a presigned object URL already is, scoped to exactly one run id rather than a workspace. Minted
only when a launch carries both a `workspaceId` and a configured control-plane URL, so the local
path — which has neither — mints nothing and behaves exactly as it always has. A token presented
against a different run than the one it names is a `403`, not a `404`.

`jaroku_runner/controlplane_http.py` is the runner's client for this surface: trace events are
batched (50 events or 100ms, whichever comes first) rather than one HTTP round trip per step, with
an explicit flush at run end for whatever never crossed a threshold. `mcp_bridge.py` gets its
**own, separately-written copy** of the HTTP confirm client rather than importing this module —
it is copied byte-for-byte into every generated project, and a generated project must never
import anything named `jaroku`.

A hosted MCP confirmation raises the identical modal a local one does — the same `pendingConfirms`
registration on the server, the same `confirmRequest` broadcast — so the UI cannot tell which kind
of run it is looking at, and answering one resolves both the local approval file and the event bus
so `resolveMcpConfirm` never has to know either.

### Backpressure

A hostile or merely buggy agent can write arbitrarily fast and arbitrarily much. One tracker
enforces three caps on both transports a run can write through — a local run's raw stdout chunks
and a hosted run's trace-push batches:

- **bytes per run** (64 MB default) — checked on the raw write, before it joins any buffer, or a
  single write with no newline in it would accumulate forever;
- **a single line's own size** (1 MB default);
- **lines per second** (200 default).

A run that crosses any cap **stays refused for the rest of its life**, not merely for the one call
that tripped it — and is stopped outright, not merely declined further writes. A dropped trace
event is counted (`TraceIngestMetrics`), not merely logged and forgotten.

### Caching a version's graph

A version's compiled topology cannot change without the version itself changing, so
`introspectGraphCached` introspects a given `(agent, version)` pair **at most once, ever**
(migration 019, `agent_versions.graph_cache`) — a replica that has never even seen this agent
before answers the graph view instantly once any replica has introspected it once. A failed
introspection is deliberately never cached, so a transient sandbox hiccup gets to try again next
time rather than permanently breaking that version's graph view.

### What this session proves, and what it does not

The escape suite (`npm run test:escape-suite`) names each attack by what it is and proves it
against the real refusing code, not a description of it: the cloud metadata endpoint in every
shape it could arrive in, a workspace's own Postgres and Redis-shaped ports, another run's token,
a project archive engineered to escape its extraction root, a repointed image, a stdout flood, DNS
rebinding. Two gaps are recorded rather than assumed closed, the same "known limit, stated
plainly" discipline the rest of this README holds to:

- **No pid/process-count ceiling is enforced inside a hosted machine yet.** What actually stops a
  fork bomb today is Fly's own memory ceiling killing the machine once `guest.memory_mb` is
  exhausted, not a dedicated `pids` cap.
- **No network-layer egress enforcement is wired.** The policy above is computed, validated and
  pinned before a run starts, but nothing in this session installs an in-VM firewall or an egress
  proxy that would stop a compromised process from simply opening a socket to an address the
  policy never admitted. This is the largest gap this session leaves, and it is the next one to
  close.

---

## Queueing, fairness, and per-workspace limits

Session 5 of the hosted migration. The single-user version of "who runs next" was one pool with
slot 0 reserved for the interactive run — correct when there was one workspace, and a way for one
tenant to occupy every slot when there are six thousand. What replaces it is a fair dispatcher:
work is enqueued per workspace, admitted round-robin, and capped by named leases rather than by
which index a slot happened to have.

### The dispatcher

```
enqueue ─▶ q:{class}:list:{workspace}   one FIFO list per (workspace, job class)
                    │
                    ▼
           q:{class}:ring               rotation order of workspaces with pending work
                    │
      ┌─────────────┴──────────────┐
      │  ONE atomic admit step:    │    rotate → check capacity → pop → reserve
      │  a Lua script on Redis,    │
      │  a synchronous block in    │
      │  the in-memory backend     │
      └─────────────┬──────────────┘
                    ▼
           q:{class}:reserved:*         the lease, until acked or its TTL lapses
```

**Fair means round-robin by workspace, not by job.** A workspace that submits five hundred eval
jobs and a workspace that submits one are served in turn. The load-test harness measures exactly
this: at 6,000 workspaces the fairness ratio is **1.000** (every workspace served an equal share)
and the worst first-serve position is bounded by the number of *workspaces*, not by the size of
the backlog — 5,999 out of 30,000 queued jobs, where a plain FIFO would have made the last
workspace wait behind all 30,000.

**Those four steps are one step on purpose.** Rotating, checking capacity, popping and reserving
have to happen without another worker interleaving between them, or two workers both see room,
both admit, and the cap was never real. Redis runs a script to completion before looking at
anyone else's command, which is what buys that; the in-memory backend gets it for free by never
awaiting inside the critical section.

**A lease, not a pop.** An admitted job is *reserved*, not deleted — so a worker that dies
mid-job doesn't take the job with it. Whatever notices the lapsed lease puts the job back
(`reapExpired`). A graceful shutdown doesn't wait for that: it acks and re-enqueues its
stragglers immediately, so recovery is a drain-window concern rather than a TTL one. Both paths
are tested, including two reapers racing the same expired lease and still only claiming it once.

### The caps, and what became of the old ones

| Single-user | Now |
|---|---|
| slot 0 reserved for the interactive run | a per-workspace `run.interactive` lease, plus a separate `interactivePool` an eval fan-out cannot reach into |
| `JAROKU_EVAL_CONCURRENCY` | still bounds `evalPool`, now one of two pools rather than the only one |
| `JAROKU_LIMIT_<PROVIDER>` | a *global* per-provider semaphore — two concurrent evals now share one budget per provider, where each used to get its own |
| `JAROKU_JOB_TIMEOUT_MS` | the default for `run.eval`; every class has its own, overridable per class |

Per-workspace and per-provider caps are checked **after** a fair admit rather than fused into it,
and that split is deliberate: the ring's own cap has to be atomic with the pop because *which*
workspace it will serve isn't known until it rotates. A workspace or provider is known before the
job is ever enqueued, so those caps have no such race and get to be plain leased counters instead
of more Lua.

**Retry classification is unchanged and reused verbatim.** `isTransientFailure` still decides
what is worth paying to retry, unrecognised failures still count as deterministic, and the queue
does not get its own competing retry policy. What's new is the proof: `test:retry` now runs the
whole cycle through the real dispatcher and asserts attempts exhaust at exactly
`JAROKU_JOB_ATTEMPTS` with no fourth dispatch, and that the gap between attempts actually grows
(2s, then 4s) rather than firing back to back.

### Across replicas

Every WebSocket broadcast already funnelled through one function, so cross-replica fan-out is one
hook on that function rather than one per channel: it publishes to Redis after delivering
locally, and `deliverFromPeer` delivers what other replicas publish **without** re-entering the
hook — otherwise two replicas would bounce the same message between them forever. Each bridge
tags its own publishes and drops them on receipt.

**"Eval runs stay off the live trace channel" survives this**, and structurally rather than by
remembering to check twice: the hook lives *inside* `broadcastTo`, downstream of the `isEvalRun`
gate, so an eval run's step never reaches the bridge to be published in the first place. There is
deliberately no eval-specific logic in the bridge. `test:eval-off-trace` asserts it with a
control case — disable the gate and all twenty do cross — so the assertion cannot pass vacuously.

### Capacity, from the load test rather than from arithmetic

`npm run loadtest:queue` (tunable via `JAROKU_LOADTEST_WORKSPACES` / `_JOBS_PER_WS` /
`_CONCURRENCY`). At 6,000 workspaces × 5 jobs, 64 admitted at once, in-memory backend:

| | |
|---|---|
| enqueue | 30,000 jobs, ~135,000/s |
| drain | 30,000 jobs, ~56,000/s |
| admit latency | p50 491µs · p95 1.10ms · p99 1.90ms |
| fairness ratio | 1.000 |

The target is ~6,000 concurrent **sessions** — people with the app open, mostly idle — not 6,000
concurrent runs; those differ by roughly fifty times. Dispatch at these latencies is nowhere near
the binding constraint at that session count: the real ceiling is sandbox capacity, which is a
provisioning question this session does not answer. The harness measures dispatch **only** — no
sandboxes, no Python, no model calls — because a run's own cost is dominated by a LangGraph
import and a provider round trip, neither of which this session changed, and folding them in
would bury the one number that is actually new.

### What this session does not do

Stated plainly, in the same spirit as the sandbox session's own limits:

- **The worker process exists but drains nothing.** `npm run worker` boots, requires Redis,
  admits, and shuts down gracefully — all tested — but no job class is registered against it.
  `run.eval` and `judge` are drained **in-process** by `evalRunner.ts` instead. Moving execution
  to a genuinely separate OS process needs index.ts's trace-ingestion and debug-control surface
  (pause/resume, MCP confirmation) available there too, which is real work this session scoped
  out rather than half-built.
- **`generate`, `plan`, `edit`, `explain` and `mcp.discover` are registered job classes that stay
  synchronous.** They have real concurrency and timeout numbers written down, but they are short
  bounded requests a client is actively waiting on, not long-running sandboxed executions
  competing for scarce capacity. Putting them on an async queue would be a rewrite in search of
  a problem.
- **One live interactive run per gateway, still.** The per-workspace reservation is real and
  acquired on every dispatch, but `runActive`/`activeRunId` remain a single process-wide pair, so
  `JAROKU_INTERACTIVE_CONCURRENCY` above 1 does not yet do anything. Widening those into a
  per-workspace map is the next step and is not delivered here.
- **The cross-replica assertions no longer need a real Redis, but still prefer one.** See the
  hardening note below: `fixtures/redis/mockRedis.ts` runs the real Lua and gives `duplicate()`
  a genuine second connection, so every queue and bridge assertion runs on a machine with
  nothing installed. A real broker is still the authority and is still used whenever
  `JAROKU_REDIS_URL` points at one.

### The hardening pass

Sessions 4 and 5 were gone back over deliberately looking for what breaks under load, under
failure, and under a second tenant. What that turned up, and what it means for anyone reading
this code:

- **The Redis backend had no test coverage at all.** Its Lua is the load-bearing part of the
  whole session — the fair admit is one script precisely because "rotate, check capacity, pop,
  reserve" has to be atomic — and every suite that would have exercised it printed
  `SKIPPED: no JAROKU_REDIS_URL`. `fixtures/redis/mockRedis.ts` is an in-process Redis for the
  sixteen commands `redisBackend.ts` issues, executing the real script source in a real Lua VM
  (fengari, pure JavaScript, no native build). The queue conformance suite, the semaphore suite
  and the chaos suite now run against `RedisQueueBackend` everywhere. It found the ring bug
  below within minutes.
- **The Redis ring ran backwards.** `enqueue` appends a newly-pending workspace to the tail;
  the admit script rotated with `RPOPLPUSH`, which takes from the tail. So the workspace that
  had just become pending was served first and the longest-waiting one last — round-robin, so
  every fairness scenario passed, but not the documented order and not the same order the
  in-memory backend gives. Conformance now asserts that `ringOrder` equals the order actually
  served, so the two implementations cannot drift apart again in silence.
- **An eval against a real provider wedged the event loop.** `providerLimit` is 2 for a real
  provider and the eval pool has 4 slots, so any eval with a backlog reaches "a free slot, no
  provider slot" — and a job admitted there goes straight back on the queue, which keeps the
  queue non-empty, which keeps the loop admitting. Every step resolves as a microtask, so the
  loop never yields: no timer fires and no socket is read. `drainAvailable` stops on a requeue
  now and awaits each start.
- **Reservations outlived what they were reserved for.** A `pool.tryStart` that returned false
  left a per-workspace interactive reservation with no run coming to release it — one refused
  start locked that workspace out for the lease's full hour. Reserving and starting are one
  call now (`interactiveSlot.ts`).
- **A floating promise that rejects ends the process.** Every driver of the eval runner is
  floating by construction — an EventEmitter listener cannot be awaited, and neither can a
  timer — so one SQLITE_BUSY under exactly the concurrency this session is about took down the
  gateway. They all go through one handler now.
- **Two `startEval` commands could both be told they were the only one.** `wsRelay` dispatches
  concurrently and the guard was followed by five awaits, so two overlapping starts both saw
  `active === false`. Two live evals is a cross-tenant write, not merely slot contention:
  `contextForEval(activeEvalIds()[0])` attributes the second eval's rows to the first one's
  workspace. The claim is synchronous and inside `EvalRunner` now.

On the sandbox side: the IPv6 half of the egress block list matched the *text* of an address
rather than the address, so `::ffff:a9fe:a9fe` — the cloud metadata endpoint, written in hex —
was admitted and pinned into a run's allowlist; the lines-per-second cap existed on a local
run's stdout and on nothing at all on the hosted push; `CodeCheckSandbox` read untrusted output
into a string with no ceiling; a long-poll a client had abandoned could swallow a real pause;
and a Fly machine reclaimed by `auto_destroy` was polled for its exit forever, holding its pool
slot. Each is described in its own commit.

---

## Cost metering, budgets, and billing

Session 6 of the hosted migration. The arithmetic did not change: `runtime/pricing.json` is still
the one table both runtimes read, cost is still summed from `steps` and never from `runs.cost`,
and an unpriced model still costs `null` rather than `$0`. What this session adds is **where
those numbers are written down, what may be started against them, and whose money is being
spent** — enforcement, not new maths.

### The ledger

Every metered thing is a row in `usage_events`, and every row says four things: what was bought
(`kind`), whose money bought it (`payer`), what it cost, and whether that cost is an answer.

| Kind | What it is | Who pays under BYOK |
|---|---|---|
| `llm.provider` | the agent's own model calls, from its trace steps | the workspace |
| `llm.judge` | the eval judge — eval overhead, never a provider's agent cost | the platform |
| `llm.generation` · `llm.plan` · `llm.edit` · `llm.explain` | the platform thinking on a workspace's behalf | the platform |
| `sandbox.seconds` · `storage.bytes` | infrastructure | the platform |

**`kind` does not say who paid, which is why `payer` exists.** An `llm.provider` call made on a
workspace's own key is their bill; the identical call on ours is ours. A platform-key ceiling
that counted by kind would throttle somebody for spending their own money. It cannot be inferred
later either: whether a run used its workspace's key depends on what was configured *at the
time*, and a workspace that connects a key tomorrow would retroactively change what today's rows
mean. So it is recorded where the run's environment is assembled, which is the only place that
knows.

**`cost_usd` is nullable and `cost_known` is not**, which is "unknown is not zero" written as a
schema. A NULL cost with `cost_known = false` says we metered real tokens against an unpriced
model; a `0` with `cost_known = true` says the model is genuinely free, which the dry-run
provider is. Every rollup carries the count of rows it could not price, so a total is never
presented without the flag that says it is a floor.

**The idempotency key is what makes at-least-once ingestion safe for billing.** A usage row is
*derived* from a step rather than sent as one, so it has no id of its own to lean on — the
derivation names itself from the step's id, which is the one thing that survives redelivery.
Anything from the moment of ingestion would charge a redelivered batch twice, and there will be
redelivered batches. The judge's own calls key on `(job, attempt)` for the same reason; the four
synchronous platform calls key on a fresh uuid, deliberately, because they are not redeliverable
and a derived key would silently un-bill the second of two genuine generations of the same brief.

Two things are metered that are not model calls. **Sandbox seconds are wall clock, not CPU** — a
micro-VM is reserved for the whole time it exists, and billing CPU would charge the agent that
waits on I/O less than the one that spins, which is backwards from what the platform pays for.
**Storage is sampled hourly rather than metered on write**: a version publish *is* an event, so
metering bytes as they are written looks like it fits — and it would charge a workspace once for
a file and nothing at all for keeping it, which is the opposite of what an object store bills.
Each sample is keyed by `(workspace, clock hour)`, so several replicas sampling the same hour
produce one charge.

### What may be started

Two gates, and they protect different people.

```
                    ┌──────────────────────────────────────────────┐
  a run, an eval ──▶│  BudgetGate — has this workspace already      │
                    │  spent more than IT is allowed to?            │
                    └───────────────────┬──────────────────────────┘
                                        │  under the ceiling
                    ┌───────────────────┴──────────────────────────┐
                    │  Balances — is there platform credit to       │  only when there is
                    │  cover it? Claimed atomically, and held.      │  a balance at stake
                    └───────────────────┬──────────────────────────┘
                                        │  no key of its own
                    ┌───────────────────┴──────────────────────────┐
                    │  PlatformKeyGate — kill switch, plan, and a   │
                    │  SEPARATE ceiling on what WE pay.             │
                    └──────────────────────────────────────────────┘
```

**The ceiling bounds what is STARTED, not what is spent.** A workspace under its limit may start
a run that takes it over; a run already going is never killed. Stopping mid-graph would spend the
money and throw away the result, which is the rule the eval budget has followed since the eval
engine landed. The consequence is stated rather than hidden: a final total can exceed the ceiling
by at most the cost of what was already in flight. A fan-out is checked on every pump rather than
once at the button, because five hundred jobs are five hundred things being started.

**The ceiling in force is the workspace's own, else its plan's** — and a workspace can now set its
own from the meter it is drawn on. Three states, all reachable, because the column has three: a
number is a limit of this workspace's own, `0` means start nothing (which is what an abuse response
applies), and clearing it goes back to the plan's — offered as its own button, because emptying an
input is not a statement. It is `billing:manage`, the owner's, while *reading* spend stays every
member's: somebody whose run was refused for budget has to be able to see the number it was refused
against. `limit_overrides` is deliberately **not** settable here: seats, concurrency, retention and
the platform-key ceiling are a negotiated exception to a plan, and a workspace raising its own
retention or its own platform-key ceiling would be editing what we pay for.

**A hold, because checking a balance first is not a check.** Ten runs each read the same balance,
each conclude there is room, and all ten start — no care at the call site closes that, because
the call sites are on different machines. So the check and the claim are one statement:

```sql
UPDATE workspace_balances SET reserved_usd = reserved_usd + $2
 WHERE workspace_id = $1 AND (balance_usd - reserved_usd) >= $2
```

Zero rows means refused. It is the same shape as the queue's Lua admit script and for the same
reason: the database is the only thing that can arbitrate between two requests that arrive
together.

**And a hold is a row, not a number.** Something has to move that counter back by exactly the
same amount later, including when the process that took it is gone — Session 5 learned this in
the small when a per-workspace interactive reservation was taken for a run that never started and
held for the lease's full hour. Money is the worse version: a leaked slot costs a workspace an
hour, a leaked hold costs it the balance. So a hold carries an amount and an expiry, and a
sweeper reclaims what nobody released.

**Releasing and settling are two movements.** A release frees what was *held*; a settle deducts
what was *used*, read from `usage_events` and never from the estimate the hold was sized with.
They are almost never the same number, and a settle may exceed its hold — a run already in flight
completes, and clamping would mean the platform ate the difference every time an estimate ran
low, which is the direction estimates run. An eval settles on `trueSpend`: every attempt of every
job plus the judge, never the comparison figure, which counts successes only.

**Every refusal names what would clear it.** The figure, the limit, the plan that set it, the
window, and the two things that would change it. And a period total that is a floor says "at
least" and says why — a number somebody may reasonably dispute is one they should hear about from
us rather than derive from the itemisation.

### BYOK, and the platform key

Bring-your-own-key is the enforced default and the platform's token spend under it is zero. A
workspace's key goes through `SecretStore` — locally still `runtime/.env` through the one writer,
hosted envelope-encrypted ciphertext scoped to the workspace — and reaches exactly one
destination.

**A run gets the key for the provider it named, and no other.** An agent on Anthropic does not
receive `OPENAI_API_KEY` even when the workspace has configured one. That is the least-privilege
rule the egress policy already applies to the socket, applied to the credential, and it matters
more here because what receives it is model-written Python.

**A key is proved before it is stored.** The probe is a models-list call: it authenticates as
conclusively as a completion and costs nothing, which matters because the alternative is billing
somebody for finding out whether they typed their own key correctly. Without it, the first thing
to discover a mistyped key is a run — after a sandbox start and a Python import — reporting
somebody else's 401.

**A workspace's key does not pay for the platform's own thinking unless somebody said so.**
Planning, generation, the fix loop, explain and the judge bill to the platform's key by default,
because using a tenant's credential for a call they did not ask for is a use they did not consent
to whatever the accounting says. `own_key_for_platform` is how somebody says otherwise; it
defaults to false and no migration turns it on. Opting in with no key falls back to the
platform's rather than failing every generation with an authentication error; turning it *on*
with no key is refused outright, because being billed platform credit while believing otherwise
is a surprise on an invoice rather than an error at the moment of the mistake.

That opt-in is why `SecretStore` gained its second — and last — plaintext exit,
`getForPlatformCall`. The rule it must not break is that no method returns a value to a *request
handler*; `getForRun` is not an exception to that, it is a value flowing **into** an execution and
never back out, and a platform-side model call is the same shape. Expressing it as `getForRun`
against a synthetic run id would have been worse in two specific ways: the hosted store resolves
a workspace *from* the run id, so a made-up one silently returns nothing, and `last_used_at`
would be attributed to a run that does not exist.

The other path is a workspace with no key of its own running on ours, and it is the only place in
this system where the platform's money is spent by somebody else's decision. Three gates, in
order:

1. **`JAROKU_PLATFORM_KEY=off`** stops the key being lent to anybody, immediately, without
   touching a plan or a workspace or a database. It exists for one situation — somebody is
   farming the free tier faster than the per-workspace ceilings are catching it — and a response
   that requires a migration is not a response. Read per call, so flipping it needs no restart,
   and it answers to `off` / `0` / `false` / `no` in any case: a kill switch that recognised one
   spelling is one somebody sets to `0` at three in the morning and watches do nothing.
2. **The plan.** A refusal here carries no figure: the workspace is not being throttled, it is
   being told about the arrangement it agreed to.
3. **`platformKeyCeilingUsd`**, which is a *different number* from `budgetCeilingUsd`. That one
   bounds what a workspace starts, whoever pays, and protects the user from their own fan-out.
   This bounds what we pay, and protects the platform. A workspace can sit on either while
   nowhere near the other, in both directions. Sandbox seconds and stored bytes count against it,
   because a free tier farmed for compute rather than for tokens shows up in no token counter.

### What each plan actually limits

The numbers live in `server/src/billing/plans.ts`, not in the `plans` table — the same reasoning
as roles in `auth/capabilities.ts` and job classes in `queue/jobs.ts`. What *is* in the table is
the part that genuinely varies per deployment: which payment-provider price a plan maps to, and
whether it can be bought today. The two are checked against each other at boot, in both
directions: a row nothing defines would resolve to the free limits, so a workspace that paid for
Team would get a free workspace's ceiling with no error and no symptom except its own
throughput.

| | Free | Pro | Team |
|---|---|---|---|
| Monthly credit | $5 | $50 | $250 |
| Budget ceiling — what may be **started** | $5 | $200 | none |
| On **our** provider key | $2 | $50 | $250 |
| Interactive runs at once | 1 | 3 | 10 |
| Eval jobs at once | 2 | 8 | 32 |
| Trace retention | 14 days | 90 days | 365 days |
| Seats | 3 | 10 | unlimited |
| Deploy | — | ✓ | ✓ |

Plans **nest by spreading**, so a limit added to the base is a limit every plan has — written as
three independent objects, the day somebody adds a flag and updates one of them is the day a paid
plan silently has less than a free one. `test:plans` asserts the direction holds on every axis.

A workspace's own negotiated exceptions live in `workspace_balances.limit_overrides`, and one
detail there is load-bearing: `budgetCeilingUsd: null` is a real answer ("no ceiling from the
plan") and has to be distinguishable from the key being absent, so `hasOwnProperty` decides
rather than truthiness. An override of `0` is kept too, because `0` is what suspending a
workspace sets. An unrecognised key is ignored rather than refused — a workspace whose overrides
were written by an older version must fall back to its plan, not fail to resolve at all.

The period is the **calendar month, in UTC**, and it is stated rather than derived from a
subscription's anniversary: a period that moved per workspace would mean two people looking at
"this month's spend" are looking at different windows, and a support conversation about a figure
would start by working out which.

### Payments

Stripe by hand — no SDK, for the reason there is no OpenAI SDK on the Node side and no framework
under the HTTP router. What an SDK would give here is a form-encoder and an HMAC, and a
dependency in the path a payment takes is a supply chain in the path a payment takes.

The webhook is public and unauthenticated by construction, so **the signature is the
authentication**. It is checked over the raw bytes before anything parses them, because
`JSON.parse` followed by `JSON.stringify` does not reproduce what was signed. The timestamp is
inside the MAC and has to be recent, which is what makes replay bounded rather than theoretical —
a signature stays validly signed forever, so one captured `invoice.paid` would otherwise replay a
year later and verify perfectly. More than one `v1=` is normal during a secret rotation, and all
of them are tried.

The state machine's load-bearing transition is the one it is most tempting to get wrong: **a
failed renewal does not downgrade.** A card that expired on renewal day is the ordinary case, the
provider retries for weeks, and stopping somebody's agents while their payment is still being
attempted is worse than a fortnight of unpaid Pro — so they are told instead, on the `providers`
channel. `canceled` and `unpaid` are what downgrade. A status this system has never heard of
moves nothing at all: a default that downgraded would turn a vocabulary change into an outage for
paying customers, and one that upgraded would give the plan away. A completed checkout does not
grant the plan either — it means the form was submitted, not that the charge settled.

`billing_webhook_events` records what has been acted on, and it is a separate table from
`usage_events.idempotency_key` rather than another key in it: a usage row is idempotent because
writing it twice records one charge twice, and a webhook is idempotent because *acting* twice
applies a state transition twice — a plan change reapplied after a later one superseded it, a
cancellation undone by its own retry. An event that fails mid-transition is left unprocessed on
purpose, because that is the queue an operator replays.

**And the queue can be read.** `npm run billing:stuck` lists what arrived and never finished, oldest
first, and exits non-zero so it can be a cron line rather than only something somebody types —
anything in that list is money that has not moved. It deliberately cannot replay the event itself:
the table stores an id, a type, a workspace and two timestamps and **not** the payload, because
keeping one would be a second copy of every customer object with no retention story, and the
signature is over bytes we no longer have. So the operator resends from the provider's dashboard by
id — redelivery goes through the verified path, and the claim makes a duplicate harmless — and then
marks the row resolved with `--resolve <id> --note "…"`, because a queue that only grows is one
people stop reading.

**And a plan can be bought from inside the product.** Every layer of that existed for a release
before the button did: the checkout route validating the plan against the `plans` table and never
against a client-supplied price, the customer reuse so a second upgrade is not a second customer,
the webhook state machine, the credit grant, three suites — and no control anywhere, so a
deployment with Stripe configured had a paid tier nobody could buy. The Usage tab now carries the
catalogue directly under the ceiling meter, which is where "how do I raise this" gets asked. The
list comes from the server: `purchasable` and the price id are columns on the `plans` table, and
each plan's limits come from the code that enforces them, so the panel cannot advertise a ceiling
the budget gate would not apply. A deployment with no Stripe keys shows nothing rather than a
control that refuses — the local path is not a degraded state — and changing the plan is
`billing:manage`, which is the owner's, while *reading* spend stays every member's.

### The dashboard, and the export

The Usage tab shows the period total against its ceiling, what the platform paid against its own,
credit and what is held, and a breakdown by agent, by run and by kind. **Nothing on it is
computed client-side** — every figure comes from the same `BudgetGate.status` the server refuses
a run with, so the number on the page and the number in a refusal are one computation. A billing
page that disagrees with a refusal is worse than no billing page.

Every figure that could be incomplete carries its flag, on screen and in the export. Session 6
found one place where that was not true: the per-leg rollup has flagged `costIncomplete` since
the eval dashboard was written, and the per-**cell** shape never carried it — so a cell whose
cost was a floor rendered, and exported, as a clean measurement. There are three states, not two.
`cost_known: no` means we could not price it at all; `cost_complete: no` means we priced some of
it and the number beside it is a floor.

### What this session does not do

- **Retention is decided but not enforced.** `retentionDays` is a plan promise made here and kept
  in Session 8's sweeper; nothing deletes a trace yet.
- **Seat limits are a number, not a gate.** `seats` is written down and the invite path does not
  consult it.
- **A workspace's monthly credit is not granted on a schedule.** `monthlyCreditsUsd` describes
  what a plan includes; credit arrives from `invoice.paid` and from an operator, and a periodic
  grant is a scheduler this session did not add.
- **A pause/resume cycle is billed as its first segment only.** Sandbox seconds key on the run id
  alone, and a resumed run is a new subprocess under the same id. That undercharges, which is the
  right direction to be wrong in while the alternative is a key derived from a timestamp that
  would double-charge a redelivered exit; a segment counter is the proper fix and is not here.
- **The plan does not yet change the dispatcher's caps.** `planConcurrency` returns the right
  number for a class a plan speaks about, and the queue still reads `jobClassConfig`'s flat one.
  Composing them is a change to the admit path rather than to this file, and it is the next step.
- **There is no invoice.** Everything here is metering and enforcement; producing a document
  somebody could file is a payment-provider feature this session leans on rather than rebuilds.

---

## Plans, tiers and entitlements

The section above is about *money* — what a run cost and whether the workspace can afford it. This
one is about **quantity and capability**: how many agents, how many runs, how many people, and which
features are on at all.

Three plans, in `billing/plans.ts`, as data with the argument for each number written beside it.
These are the numbers the **server enforces** — `web/pricing.html` is a marketing surface and states
its own:

| | Free | Pro | Team |
|---|---|---|---|
| Agents | 3 | unlimited | unlimited |
| Runs / month | 500 | 10,000 | 50,000 |
| Seats | 1 | **1** | 20 |
| Trace retention | 7 days | 90 days | 365 days |
| `monthlyCreditsUsd` | $5 | $50 | $250 |
| Budget ceiling | $5 | $200 | no plan ceiling |
| GitHub push | — | ✓ | ✓ |
| GitHub sync | — | — | ✓ |
| Per-agent access | — | — | ✓ |

Free's figures are small deliberately rather than stingily: they are the whole of the free tier's
exposure, and the abuse economics of a tier that runs arbitrary Python are the reason. A monthly
credit **resets rather than accumulating** — an unused allowance that compounds is a liability
nobody priced — while *purchased* credit is a different column and does carry.

**Pro is single-seat, and that is the pricing's shape rather than an oversight** — Pro is the
single-operator tier and Team is what collaboration costs. It is also the only place in the table
where a paid plan does not beat the one below it on an axis, which is exactly why the upsell has to
be a lookup rather than a "next tier up" heuristic: a Free workspace refused for a second member
needs to be told **Team**, and being told Pro means paying and being refused identically.

**`plans.ts` holds the numbers; `entitlements.ts` holds the resolution.** They are a table and a
reader rather than two answers to one question — move the numbers into the resolver and they stop
being reviewable as a set; move the resolution into the table and it has to know about sessions.
`resolveEntitlements` is the only function that produces a tier's values, and `requireEntitlement`
is the only thing that refuses on them.

**Unclassified is a build failure, not a default.** `COMMAND_ENTITLEMENT` maps every WebSocket
command to a check or to the literal word `"none"`, and `test:entitlements` reads `wsRelay.ts` for
every command the relay accepts and fails on one that has neither. The failure it prevents is the
one that actually happens: somebody adds a command next year, it is absent from the table, and it is
unlimited on every tier forever with nothing anywhere saying so.

**Two refusal shapes, because a quota and a feature gate are different facts.** A quota carries
`current` and `limit` and renders a meter; a feature gate carries neither, because *"GitHub is not
on Free"* is not zero of zero and a bar sitting at 0/0 reads as something that fills up again next
month. Both carry **which plan would actually lift them**, resolved server-side from the plan table
over the same projection the refusal was made with — and `null` is a real answer, rendered as "No
plan currently includes this" with no upgrade button at all.

A downgrade **gates features off and never destroys data**. Nothing is deleted, every read stays
open, and the controls that get somebody back *under* a limit — cancel a deploy, remove an MCP
server, revoke a grant — are deliberately ungated, because a gate there is a trap only an upgrade
opens.

`approvalBatchApprove`, `policyEngine` and `evalCiGate` are declared on `TierEntitlements` and gate
nothing: the surfaces they describe are other specifications and are not built. Declaring the flag
and wiring it when the surface lands is the right order — `perAgentAccessGrants` followed exactly
that path from v0.3.4 to v0.3.8 — and `test:checkout-surfaces` now refuses a row on the public
pricing page that does not map to a check somebody can actually be refused by, so the marketing
cannot get ahead of the flag again.

---

## Connector OAuth and the credential vault

Session 7 of the hosted migration. Until now, connecting Gmail meant obtaining a refresh token
out of band and pasting three variables into `runtime/.env` by hand. That is a reasonable
instruction for one person on their own machine, and it is not an instruction you can give six
thousand people — so **Jaroku now owns the OAuth app, and a user grants it access by clicking a
button.**

That is a different security posture, not a nicer form. The credential is no longer something the
user holds and shares with us; it is a grant *somebody else's system* made to us, against a real
mailbox, which can be revoked from the far end at any moment and which we are now responsible for
handing back when asked.

### Where a credential comes from, per connector

`runtime/tool_templates/catalog.json` gains one field, `auth`, and it decides three things: what
the Connections panel offers, what `.env.example` says about each key, and what the generation
prompt tells the model about where a value comes from.

| Connector | `auth` | What a run receives | What the user does |
|---|---|---|---|
| **Gmail** | `oauth` | `GMAIL_ACCESS_TOKEN` — short-lived | clicks Connect |
| **Google Calendar** | `oauth` | `GCAL_ACCESS_TOKEN` — short-lived | clicks Connect (a *second* time, deliberately) |
| **Slack** | `oauth` | `SLACK_BOT_TOKEN` — `xoxb-…`, no expiry | clicks Connect |
| **Stripe** | `user_secret` | `STRIPE_SECRET_KEY` | pastes a **restricted** key |
| **Postgres** | `user_secret` | `DATABASE_URL` | pastes a connection string |
| **HTTP/Webhook** | `user_secret` | `HTTP_ALLOWED_DOMAINS`, `HTTP_AUTH_HEADER` | lists the domains it may reach |

The three `user_secret` connectors stay that way and always will: there is no consent screen for
"the database at the other end of this connection string", none for a Stripe API key, and none
for a list of domains. In each case the value *is* the credential or the policy.

**Calendar is its own connection under the same Google OAuth app**, with its own scopes and its
own `GCAL_` names. One grant is one revocation, and somebody who no longer wants an agent reading
their mail should not thereby lose their scheduling assistant — so the two are separate rows that
revoke independently, at the cost of one extra click. A project generated with Calendar and not
Gmail therefore asks for Calendar credentials and nothing else.

**The names stay in `.env.example` either way, and that is deliberate.** A generated project is
portable — the README has always promised it runs standalone, and `test:acceptance` proves it — so
a copy running outside Jaroku has no connection to ask and needs those names documented. What
changed is what the file *says* about them: a key a connection fills in is rendered as a comment
explaining that, not as a blank to paste into. Telling somebody to go and obtain a refresh token
by hand is telling them to redo, badly, the thing the button just did.

### What a run is given, and what it is not

A run receives an **access token**. It does not receive the refresh token.

That is the whole of the injection design. A refresh token is a permanent grant to somebody's
mailbox; an access token is an hour. What executes in a sandbox is model-written Python responding
to a stranger's prompt, so it gets the short half, and the permanent one stays in the vault on the
control plane where the sandbox has no route to it. The token is refreshed *before* the run when
the run's own deadline could outlive it, with ten minutes of grace, so a graph does not lose its
Gmail access halfway through a tool call it cannot retry.

`slack.py` needed no change at all — an OAuth install yields the `xoxb-…` token it already reads.
`gmail.py` gained exactly one additive branch: it prefers `GMAIL_ACCESS_TOKEN` when present and
falls back to the client-id/secret/refresh-token triple when it is not. **The migration spec said
the connector Python should not need to change, and for Gmail that turned out not to be quite
true** — keeping it literally unchanged would have meant injecting a refresh token into untrusted
code, which contradicts this session's own acceptance criterion. The contract is untouched: both
routes are read from `os.environ`, and the standalone path works exactly as before.

### Refresh, and the bug that makes it a module

Concurrent refreshes of one connection are how you *lose* a connection.

A workspace fans out an eval: twelve runs start within a second, each needs a Gmail token, each
finds the same one thirty seconds from expiry, and each refreshes it. Under a provider that
rotates refresh tokens the first refresh retires the old one — and the other eleven then present a
token the provider has already invalidated. A provider seeing a retired refresh token does not
answer "try again"; it treats the reuse as evidence of theft and **revokes the entire grant**.
Twelve concurrent runs would disconnect the integration and require a human to reconnect it.

So there is one refresh in flight per connection and everybody else awaits the same promise — not
"checks again afterwards", which would leave a window in which the first has retired the old token
and not yet written the new one. `test:oauth-refresh` fires twelve concurrent callers and asserts
the token endpoint is called exactly once.

The mutex is **per process**, and that is honest rather than complete: two API replicas can still
race. What makes the in-process version worth having on its own is the shape of the traffic — a
fan-out is one workspace's dispatch, and a dispatcher hands its jobs to workers rather than
scattering them — and the residual race needs two replicas to touch one connection inside the same
five-minute window *and* the provider to rotate.

Two smaller rules that pull in opposite directions and are both load-bearing:

- **An absent `refresh_token` in a response means keep the stored one.** Google's ordinary refresh
  response has no such field, so an implementation that stored what it was given would destroy a
  working connection on the first refresh.
- **A `refresh_token` that differs from the stored one replaces it, under the same name.** A second
  name would be a credential nothing reads while the thing everything reads is already dead.

And `invalid_grant` is **terminal**. It means the grant is gone — revoked in the provider's
console, expired by policy, invalidated by a password change — and retrying it is a loop against
somebody's real account that ends in a lockout rather than a reconnection. The connection is marked
`reauth_required`, the workspace is told once, and nothing tries again until a human reconnects.
Fail-closed, the same posture the MCP confirmation gate takes when it times out.

### Scopes are the product promise, enforced by somebody else

`gmail.py` creates drafts and never sends, and has said so in prose since it was written. Hosted,
*we* ask for the scopes, so that promise becomes something Google enforces on our behalf.

| Provider | Scopes | Why not more |
|---|---|---|
| Google | `gmail.readonly`, `gmail.compose`, `openid`, `email` | **not** `gmail.send`, **not** `gmail.modify`, and emphatically not `https://mail.google.com/` — which is full access including permanent deletion, and is what a lazy integration asks for |
| Slack | `channels:read`, `channels:history`, `chat:write` | nothing that reaches private conversations, files or administration |

`openid` and `email` are non-sensitive and buy one thing: an account label. A connections panel
that cannot say **which** mailbox an agent is reading is a panel nobody can audit, and a workspace
with two Google accounts connected has no way to tell which one to disconnect.

`test:oauth-google` asserts the forbidden scopes individually, so a widening that arrives by
somebody copying a wider example from a tutorial fails a named test rather than a consent screen a
user reads too quickly.

**Google verification is the long pole of this session and it is not a code problem.** Both Gmail
scopes are *restricted*, which means the OAuth app must pass Google's verification **and** a
third-party security assessment before it may serve more than a hundred users. That has a lead time
measured in weeks and, for the assessment, a real invoice. Until it completes the app runs in
testing mode: it works, for a list of test users entered by hand, behind an unmissable "Google
hasn't verified this app" screen. Nothing in this codebase changes that, and nothing in it pretends
to. The scope justifications above are written the way they are because they are what the
submission argues.

### What a user is consenting to

Rendered in sentences, **before** the button, from the connector spec rather than from a scope
string:

> - Read the messages in your mailbox, so an agent can search it
> - Create draft replies in your mailbox
> - It cannot send mail, delete anything, or change your settings

The exact granted scopes are shown too, and second. The sentences come first because
`https://www.googleapis.com/auth/gmail.compose` tells nobody whether an agent can email their
customers; the strings are kept because they are the only exact statement of what was granted, and
an interface that only paraphrased would be one you cannot audit.

**What is shown is what was GRANTED, not what was asked for.** Google's incremental consent lets
somebody tick one box and not the other, and a partial grant connects — refusing it would mean a
person happy to let an agent read their mail but not draft replies cannot connect at all. The panel
says which scope was withheld so the tools that need it are known to be broken before one fails.

### The flow, and the two things that defend it

`state` and PKCE are constantly confused for each other. They defend different things and a flow
needs both.

- **`state` defends the callback.** Without it, anyone can send a victim's browser to our callback
  carrying an authorization code for *their* account, and quietly connect their mailbox to the
  victim's workspace — a login-CSRF that ends with a workspace's agents reading, and writing into,
  an attacker's inbox.
- **`code_verifier` defends the code.** An authorization code intercepted from a log, a `Referer`
  or a shared machine's history cannot be redeemed by whoever took it. PKCE is routinely skipped by
  confidential clients on the grounds that the client secret already proves who is exchanging — but
  that reasoning is about the *client* and says nothing about the *code*, which travels through a
  user agent either way. Always `S256`; `plain` makes the exercise decorative.

The state row is **hashed at rest, single-use, and ten minutes old at most**, and consuming it is a
`DELETE` whose row count *is* the decision — the same shape `ws_tickets` uses, because it is the
same problem, and two spellings of one solution is how they eventually disagree.

`GET /v1/oauth/{provider}/callback` is **unauthenticated by construction**, exactly as the payment
webhook is: a provider redirects a *browser*, carrying no bearer token and no socket. The state is
the whole of the authentication. There is deliberately no session check on top, because the person
completing a flow may be on a different device than the one that started it, and a check that broke
that would stop no attack — anyone who can present a valid state already has the thing it would
verify.

Every outcome ends in a **redirect**, not JSON. A white page reading
`{"error":{"code":"unauthorized"}}` is the worst possible end to a consent flow. And the redirect
target is never something the request chose: `returnTo` is a *path*, re-joined to this deployment's
own app URL, and anything that could be absolute is **discarded rather than sanitised** — `//evil.example`
and `/\evil.example` are both absolute to a browser, and a cleanup pass is a thing to get subtly
wrong. A callback that redirects wherever it is told is a phishing primitive hosted on our own
domain, wearing our own certificate, reached by a link that genuinely came from Google.

The failure kind travels on the URL; the **message does not**. A message on a URL is a string an
attacker chooses by choosing what to send to the callback, and a page that renders it renders
their words under our domain.

### Disconnecting means revoking

Deleting our copy of a credential is housekeeping. **Revoking it is what the button appears to
promise**, and without the second a user who pressed Disconnect still appears in their own Google
account's connected apps, holding a refresh token that still works. They believe they have ended
something they have not.

So: revoke at the provider, *then* forget locally. A crash between the two leaves a grant that is
dead at the far end and still recorded here — visible, wrong in the harmless direction, fixed by
pressing the button again. The other order leaves a live grant nothing points at, which is
unrecoverable.

The refresh token is preferred over the access token when there is one, and for Google that is the
difference between ending the grant and ending an hour of it.

A provider that refuses or cannot be reached **does not keep the credential here** — retrying
forever holds a user in a state they asked to leave, and our copy of somebody else's credential is
not leverage over their outage. What happened is recorded instead, because these are different
answers to a support question:

| Outcome | What it means |
|---|---|
| `revoked` | the provider confirmed it |
| `already_gone` | the provider says the token was not valid — the outcome asked for, not a failure |
| `unreachable` | we could not tell it. The credential is gone from here; **check your connected apps** |
| `unsupported` | the provider publishes no revocation endpoint |
| `no_credential` | there was nothing stored to revoke with |

`endAllGrants` ends every OAuth connection *and* deletes every MCP credential a workspace holds. It
is not called from a delete button yet — workspace and account deletion is Session 8's — and it is
built here, where the revocation logic lives, so that Session 8 does not have to invent the half
that makes a deletion honest rather than merely thorough.

### MCP at multi-tenant scale

Every MCP property in this README survives: the impact ratchet, `readOnlyHint` being ignored,
override voiding on schema change, one-name-one-tool, the confirmation gate that denies on timeout,
and a failed refresh never destroying a working tool list. Three things changed around them.

**An MCP token stops being one value for the whole server.** This was not hypothetical. A server id
is a slug derived from the endpoint's hostname, so two workspaces connecting `mcp.linear.app` both
get `linear` and both derive `JAROKU_MCP_MCP_LINEAR_APP_TOKEN` — and the process environment has no
workspace in it. The second workspace to save a token overwrote the first's, and from then on
**both** workspaces authenticated to Linear as whoever wrote last, silently, with `configured: true`
on both panels. Credentials now go through `SecretStore`, and `configured` reads the workspace's own
listing rather than `process.env` — the same mistake `listProviders` was fixed for in Session 6.

**Discovery moved onto the queue.** It is the only registered job class that is a round trip to a
*third party* rather than to a provider we have a contract with. `mcpClient` has always bounded it
— a per-request timeout and a whole-discovery deadline — but nothing bounded *how many* could be in
flight, and thirty seconds of a request handler is a hundred concurrent pending fetches when a
popular endpoint has a bad afternoon and every workspace that connected it retries at once. Jobs are
collapsed by `(workspace, server)`, so six presses of Re-discover are one round trip to a server
that is probably already struggling. Not retryable at the queue level: discovery classifies its own
failures and returns rather than throwing, so there is nothing for a retry to improve.

**A user-supplied MCP URL is an SSRF vector, and it is fetched twice.** Once by the control plane at
discovery — where there is no sandbox and no egress policy, only this check — and again by the
sandbox at call time, where a pinned egress rule holds. Both are covered.

- The refusal is `egressPolicy`'s own, not a second copy: it already knows `::ffff:a9fe:a9fe` and
  `169.254.169.254` are one address written two ways, that `febf::1` is link-local, and that a 6to4
  address carries an IPv4 in bytes 2–5.
- **Re-checked before every handshake, not once at registration.** A hostname is not a promise:
  `mcp.example.com` can be repointed at the metadata endpoint the day after it was added, and a
  re-discovery is exactly when that would be used. A repointed server stops being talked to **and
  keeps its tool list** — those two rules pull in opposite directions if you implement the first by
  wiping the row.
- Ports are a **denylist**, unlike `DATABASE_URL`'s allowlist. Postgres has conventions; MCP has
  none, and self-hosted servers legitimately sit on 3000 and 8080 and whatever a container was
  given. The address check is the defence; the port list is depth against an operator whose
  infrastructure has a public address.

**Loopback has a development seam**, because `npm run mock:mcp` listens on `127.0.0.1` and the
fixture path must keep working. It admits *literal* loopback only — never RFC1918, never
link-local, and never a hostname that merely *resolves* to loopback, which would be the rebinding
shape again — and it is off under `NODE_ENV=production` **unoverridably**. Setting
`JAROKU_MCP_ALLOW_LOOPBACK=1` in production does nothing. `JAROKU_MCP_ALLOW_LOOPBACK=0` turns it off
locally for somebody who wants the production posture.

### The Connections tab

Its own channel, beside `providers` rather than folded into it: a provider key is a credential the
workspace *holds*; a connection is a grant made to us, revocable from the far end, with a
`reauth_required` state no API key has. Full-snapshot discipline like every channel beside it, and
**nothing on it is a credential** — a status, the granted scopes, and an account label is the whole
of what the browser is told.

`connector:read` is a **member** capability; `connector:manage` is an **admin** one, for the reason
`mcp:manage` is and rather more so: connecting Gmail points every agent in the workspace at one
person's mailbox, and the grant is made against *their* account. Disconnecting is the same
capability, not a lesser one — the ability to break every agent that depends on a connection is not
a read.

`connectionStore` is registered in `WORKSPACE_STORES`, so a workspace switch empties it before the
new socket opens. An account label held across a switch is one tenant's email address shown under
another tenant's name, beside a Disconnect button that would act in the wrong workspace.

### Setting up the OAuth apps

Two variables per provider, read **per call** so a deployment that registers an app does not need a
restart:

```bash
JAROKU_OAUTH_GOOGLE_CLIENT_ID=...
JAROKU_OAUTH_GOOGLE_CLIENT_SECRET=...
JAROKU_OAUTH_SLACK_CLIENT_ID=...
JAROKU_OAUTH_SLACK_CLIENT_SECRET=...

# Where the callback lands. Defaults to http://localhost:<port>.
JAROKU_OAUTH_REDIRECT_BASE=https://api.jaroku.example.com
# Where the browser is sent afterwards. Defaults to http://localhost:5173.
JAROKU_APP_URL=https://app.jaroku.example.com
```

Register `{JAROKU_OAUTH_REDIRECT_BASE}/v1/oauth/google/callback` and `.../v1/oauth/slack/callback`
as authorised redirect URIs on the respective apps. **A deployment with neither set is not an error
state** — it is the local default. The panel lists the connector with a sentence naming the two
variables somebody has to set, rather than hiding it, because an empty page reads as a missing
feature.

### What this session does not do

- **The Google verification is not done.** It cannot be done from a repository. Until it is, the app
  serves a hand-entered list of test users behind an unverified-app screen.
- **The refresh mutex is per process.** Two API replicas can still race one connection; closing that
  needs the distributed lock Session 5 built for the queue.
- **Workspace deletion does not exist yet.** `endAllGrants` is the provider-side half, built and
  tested; the cascade across Postgres, the object store, the checkpoints and the queue is Session
  8's, and so is the receipt and the stated window.
- **One connection per connector per workspace.** A workspace cannot connect two Slack teams. A
  design admitting several needs a rule for picking one at run time and a UI for setting it, and
  neither is worth inventing before somebody asks.
- **The sandbox does not enforce the egress policy locally.** It is computed per run and carried on
  the spec; a child process shares this machine's network stack and there is no route to take away,
  which is why `LocalSubprocessSandbox` refuses to start under `NODE_ENV=production`.
- **No connector token is metered.** Sandbox seconds and provider tokens are; a Gmail API call costs
  nothing and is not a billable event.

---

## Hardening, abuse, data lifecycle, observability, deploy

Session 8 of the hosted migration, and the last one. Everything before it made the platform
multi-tenant; this makes it safe to point the public at. Nothing here adds a feature — it adds
the layers that decide what happens when somebody is hostile, when data has outlived its promise,
when a deploy goes wrong, and when nobody is watching.

### What changed about "runs on your machine"

The README opened, and still opens, by calling Jaroku local-first. That is still true of the
thing you install, and it is no longer the whole story:

| | Local (`npm run dev`, unchanged) | Hosted |
|---|---|---|
| Where an agent runs | a subprocess on your machine | a per-run micro-VM with an egress allowlist |
| Where its files live | `runtime/agents/<id>/` | an object store, keyed by workspace and version |
| Where its keys live | `runtime/.env`, on your disk | envelope-encrypted per workspace, injected into a run's environment only |
| Who can read the trace | you | the workspace it belongs to, and nobody else |
| What the server binds | localhost | a public origin behind an edge, with everything below |

**"Keys stay local" now means something narrower and more precise.** Locally it means what it
always did: your provider key is a line in a file on your disk, and the only process that reads
it is the one you started. Hosted it means a key never leaves the vault except into the
environment of a run that is entitled to it — it is not readable back by any request handler, not
returned to a browser, not written to a file that outlives a run, and not printable to a log (see
[the redaction filter](#nothing-a-credential-can-reach)). What a client learns is `configured:
true`.

**The local path is not a degraded mode of the hosted one.** `npm run dev` still needs nothing
installed and nothing running: SQLite, a directory of objects, `runtime/.env`, a local subprocess,
an in-memory queue, an in-memory rate limiter, and no collector. Every abstraction this migration
introduced has two implementations, and the local one is the default in all eight sessions.

### The layers in front of the application

Three of them, and each refuses a different thing in a different place.

| Layer | Refuses | Where it runs | Costs us |
|---|---|---|---|
| **Edge** (`deploy/edge/`) | volumetric floods, scanners, absurd bodies | somebody else's datacentre | nothing |
| **Per-IP bucket** (`http/rateLimit.ts`) | a stranger hammering a route | this process, after routing | a TCP handshake |
| **Per-workspace-per-action** | a signed-in tenant degrading the others | this process, per command | a Redis round trip |

They are not redundant. The edge cannot tell a generation from a list of datasets; the per-IP
limit cannot bound a workspace whose members are on twenty addresses; the per-workspace limit
cannot see somebody with no account. The edge's rules are **data in this repository**, rendered
to the provider's configuration by `npm run edge:render`, and `test:edge-rules` asserts that its
exempt list and the application's are the same list — because when those two disagree the failure
is not a red test, it is every sandbox in a Fly region being served a JavaScript challenge.

**`/healthz` and `/v1/runs/…` are exempt at both layers.** A rate-limited health check is an
instance pulled from rotation for being healthy, and every sandbox in a region shares one egress
address, so an IP counter on the control plane is a global cap on how many runs may exist.

### Every response, and what a browser may do with it

A JSON API needs a Content Security Policy for one reason: `Content-Type` is a claim a browser is
willing to second-guess. An echoed string, served without `nosniff`, fetched as a top-level
navigation, is script on the origin where the bearer token lives. So every answer carries a policy
that permits nothing — `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action
'none'` — plus `nosniff`, `no-referrer` (a URL here can carry a ws-ticket), a permissions policy
and the framing headers. `debug-client.html` gets its own policy admitting its two inline blocks
and `connect-src 'self'`, because the policy that permits nothing would serve a blank page.

**HSTS rides on an explicit `JAROKU_PUBLIC_TLS=1`, not on `NODE_ENV`.** Sent over plaintext it is
ignored; sent by a deployment somebody reaches at `http://localhost:4317` behind a TLS-terminating
proxy it is honoured, and a browser then refuses plain HTTP to `localhost` — for every other
project on that machine — for two years.

**And two clocks.** A handler has a deadline (raced, not cancelled: nothing here can stop a wait
on somebody else's socket, but it can stop the client waiting on us), and the HTTP server has
read timeouts replacing Node's sixty-and-three-hundred-second defaults. `connectionsCheckingInterval`
comes with them, because those are swept rather than timed and at the default thirty-second sweep
the numbers are decoration. The control long-poll and the MCP confirmation state their own
deadlines: the router's fifteen seconds would answer a confirmation while somebody was still
reading the arguments.

### Abuse is a shape over time

Hosted agent execution attracts three things, and none is identifiable from a single event:

- **crypto miners** want CPU, and look exactly like a slow agent until you notice a run held its
  sandbox for four minutes and made no model calls — twice an hour, all week;
- **proxy and scraping farms** want egress, and the allowlist already bounds *where*, which is
  what makes *volume* the remaining question;
- **spam senders** want a connector, and this is the signal whose false positives hurt most,
  because a legitimate notification agent is a Slack-posting agent.

So observations become rows (`abuse_signals`), each carrying **what it weighed at the time** —
re-tuning a signal must not silently re-sentence every workspace that already tripped it, and an
appeal has to be arguable against the numbers actually applied. Scores **decay** with a day-long
half-life: a cumulative counter only goes up, so every account eventually crosses every threshold
and "who is abusing us" resolves to "the oldest customers".

Signup velocity is observed **before a workspace exists**, so a row is keyed by a subject digest
instead — HMAC, not a plain hash, because an unkeyed SHA-256 of an IPv4 address is reversible in
an afternoon.

### The ladder, and the two rungs a machine may not climb

| Rung | Applied by | Expires | What it does |
|---|---|---|---|
| `watch` | the score | 24h | nothing but a record |
| `soft_limit` | the score | 24h | one run at a time; no platform credit |
| `verify` | the score | 7d | nothing new starts until a human verifies |
| `suspended` | **a person** | never | nothing new starts |
| `blocked` | **a person** | never | as above, harder |

**Nothing automatic passes `verify`.** An automatic system that can suspend accounts will
eventually suspend the wrong one at 3am with nobody watching, and the cost of that is somebody's
business rather than somebody's afternoon. The two rungs that stop a person working require a
human, recorded by name on the row.

The hole this design is shaped around: **a suspended workspace runs nothing, so it produces no
signals, so its score decays to zero within days.** An automatic lift on that basis would
un-suspend everything it ever suspended. So a human's decision never lapses and is never replaced
by an automatic rung underneath it.

Every rung **bounds what is started, never what is running** — the rule the budget ceiling has
followed since the eval engine landed. And none of them touches roles, readability or export: a
platform that holds data hostage over an automated score is worse than the abuse it is
responding to. Rows are append-only with a `lifted_at`, the evidence is copied in (signals are
swept at thirty days and an appeal arrives later than that), and there is a column to appeal in,
because a promise of an appeal with nowhere to make one is a sentence in a README.

**And there is now somewhere to make it.** The column existed, `appeal()` was written and audited,
and nothing called it — so the note could only be written with SQL, which is the one hand that does
not need an appeal mechanism. A workspace under a rung gets a strip under the top bar carrying the
rung's own sentence (the same one a refusal is built from, so the two cannot drift apart), when it
lapses if it does, what it has been under before, and one text field. `watch` gets no strip — it
changes nothing about what the workspace may do, and an alarm about a recorded observation is
noise — and the two rungs that refuse work outright cannot be dismissed, because hiding the
explanation for why nothing starts would leave the product silently broken. The appeal is
`enforcement:appeal`, a **member's** capability: the refusal is a member's problem, and an appeal
that has to go through the party that applied the enforcement is not an appeal. It changes no limit
by itself and the copy says so.

### Prompt injection, restated honestly

The README has always said that framing MCP output is *not* a defence against prompt injection —
nothing is. Multi-tenant, that is unchanged, and three things are worth adding:

- **An agent's blast radius is bounded by its grants**, which is the actual mitigation and was
  already true: the egress allowlist, the connector scopes, and the MCP manifest are what an
  injected instruction is confined to.
- **High-impact calls still stop for a confirmation**, and timing out still denies.
- **The confirmation UI shows the arguments as the body**, which is precisely the surface where an
  injected instruction becomes visible to a human.

### Data has an end date now

`retentionDays` has been on every plan since Session 6 with a note saying this session would
enforce it. Until now it was a promise nothing kept.

- **`steps` is partitioned by month**, so retention is `DROP TABLE steps_2026_01` rather than a
  multi-hour `DELETE` over tens of millions of rows. Partitioned on the ISO-8601 `text` column
  rather than converting it to `timestamptz`: the format sorts lexicographically exactly as it
  sorts chronologically — that is why it was chosen — and changing the column type would change
  the shape a step reads back as, which `test:shape-parity` exists to catch.
- **Months are created two ahead, at boot and daily**, with a `DEFAULT` partition behind them. An
  `INSERT` with no matching partition *fails*, and the row it fails on is a trace step: a
  deployment out of partitions would not slow down, it would stop recording. A non-empty default
  is a metric with an alert on it.
- **The partition drop is an optimisation over the delete, not a replacement.** A partition is a
  month and a month holds every workspace's steps, so it can only go once it is past the longest
  retention any live workspace has. The per-workspace `DELETE` is what keeps a fourteen-day
  promise inside a partition that will not be droppable for a year.
- **Checkpoints go with their runs** — a resumable pointer into a deleted trace is worse than
  either — **exports expire on the plan's own clock**, because an export is a copy of exactly the
  same regulated content, and **staging expires on hours regardless of plan**, because it belongs
  to a process that died.

### Taking it with you, and taking it away

**Export** is one file: an NDJSON per table plus every agent's current source, in a tar this
repository writes itself. The absences are the design — no vault ciphertext, no data key, no
OAuth token; `secret_refs` and `oauth_connections` are carried redacted to exactly what the client
already sees, and the manifest names every excluded table with its reason. `test:workspace-export`
writes a real secret and greps the archive for the value, and reads the schema to assert that
every workspace-scoped table is either exported or explicitly excluded. It is HTTP rather than a
socket command, because what it produces is a file a browser downloads; the status check needs no
job table, since the worker writes the archive at a key derived from the export id.

**Deletion** is a claim about five systems: rows, objects, checkpoint threads, queued jobs, and
**grants at somebody else's company**. A user who deletes their workspace and still appears in
their own Google account's connected apps has not had their data deleted — they have had our copy
of it forgotten. The order is the design: mark deleted first so the rest is a cleanup rather than
a race; revoke at the provider second, while the credentials that can end a grant still exist;
rows last, because the run ids and agent ids the other steps need are in them. The receipt goes
to `audit_log`, whose `workspace_id` is nullable and not a foreign key, so **the record survives
the deletion it records** — and it names every provider that could not be told, because a
clean-looking deletion with a standing grant is the dishonest outcome.

Deleting an *account* takes their personal workspace and any where they were the last owner, and
leaves a team's alone. A shared workspace is not one member's to take on the way out.

**Both are in the product**, in the workspace panel's **Data** section, and they are together on
purpose: the two questions somebody asks about their own data are "can I take it with me" and "can I
get rid of it", and offering the second without the first makes leaving cost you your history. The
export is polled from the browser, because there is nothing to push — no row changes state, and
whether the archive exists is a HEAD on one object key. The delete asks you to type the workspace's
**id**, which is the server's own requirement rather than a flourish this screen added, and the id is
rendered beside the box because asking somebody to type an identifier you have not shown them is a
puzzle instead of a confirmation. The answer is the receipt, printed as it arrived.

### Nothing a credential can reach

"We are careful with secrets" means every `console.log` anybody ever writes is a place to be
careful in, forever — including the ones added in a hurry by somebody debugging exactly the code
that handles credentials. So the redaction filter is installed **over `console` itself**, at the
top of boot, and the hundreds of existing calls go through it without being rewritten. It is the
same reasoning as `dup2(2,1)` running before any generated code is imported: the guarantee has to
hold for code that has not been written yet, and the only way is to own the sink.

Three recognisers, deliberately different in kind: **registered values** (everything loaded from
`runtime/.env`, plus every credential assembled into a run's environment) matched literally;
**field names**, so a field called `token` is redacted whatever it holds; and **shapes**, which is
the weakest and the only one that catches a provider's error message quoting the key we just sent
it. A uuid and a sha256 are deliberately *not* shapes — redacting those makes the logs useless in
the incident that needs them. A redacted line names the credential (`[redacted:ANTHROPIC_API_KEY]`),
because during an incident "which one was in this line" is the whole question.

### One trace, four tiers; one metric, all of them

A trace explains **one** request across the four processes it touched. A metric explains **all**
of them. Neither substitutes for the other — sampling a trace makes it useless as a rate,
aggregating a counter makes it useless as an explanation.

Both are written here rather than installed, and in both cases **the protocol is not
reinvented**: `traceparent` is the W3C spec's, the export is OTLP/HTTP JSON, and `/metrics`
answers Prometheus text exposition. A job carries the traceparent of whatever enqueued it; a run's
environment carries one under the name the OTel SDKs already read, so `jaroku.run_id` on every
span makes "everything that happened for this run" a single query across the gateway, the queue,
the worker and the sandbox. Sampling is decided once at the root and inherited — a tier deciding
for itself produces traces with holes, and a missing span reads as a step that did not happen.

An **undeclared metric label is refused at the call site**. The standard way a metrics bill
becomes an incident is somebody adding a label holding a run id; every distinct value is a new
series forever.

**SLOs and alerts are a table in code**, rendered to `deploy/observability/alerts.json` with a
`--check` in CI, which is what makes it possible to assert that every alert names a metric
something actually emits — an alert on a metric nobody emits never fires, which is worse than no
alert because it looks like cover. Four alerts page. **`CrossTenantDenial` fires on any non-zero
value, immediately, with no threshold and no window**, because a threshold there would be a
decision that some cross-tenant access attempts are acceptable.

### Deploying, and the rule that makes a rollback possible

Migrations run **before** the new version takes traffic, which means that for the length of every
rolling deploy the **old code runs against the new schema**. A migration that removed something it
uses makes the old replicas fail *during* the deploy — looking like the new version broke, and
appearing to be fixed by rolling back to code that no longer matches the database.

So a schema change is three deploys — **expand, migrate, contract** — and `npm run migrate:check`
turns that from a habit into a build failure: `DROP COLUMN`, a rename, `SET NOT NULL`, `ADD COLUMN
… NOT NULL` with no default, and a non-`CONCURRENTLY` index on `steps`, which is minutes of a
write lock on the hottest path in the system. When a deploy genuinely *is* the contract step, the
override is a comment in the migration (`-- jaroku:contract-step`) rather than a flag on a
command: a flag is invisible in review and gets copied between deploys, while a comment sits
beside the statement and appears in the diff. Overridden statements are printed in the deploy log
anyway, because the claim should be visible when it turns out to be wrong.

There is no rollback step in the pipeline, because a rollback is a deploy of the previous digest —
and that is only safe if the rule above held.

### The restore drill, and what it found

An untested backup is not a backup, so `npm run drill:restore` is a script with an exit code: it
builds a target by running this checkout's migrations, copies every row through the `Db`
interface, and verifies counts, the migration ledger, the tenancy and one trace read back in `seq`
order. Row by row rather than a file copy, deliberately — a file copy proves a file can be copied;
this proves the schema in the repository can hold the data in production.

It got three things wrong on the first run, and `deploy/backup/RUNBOOK.md` is written from them:
`schema_migrations` is not data (the target wrote its own ledger by migrating); some rows are
created *by* the migrations, so a plain `INSERT` fails on `plans` and the `Local` workspace; and
the isolation probe was testing Postgres's mechanism on SQLite, where `forWorkspace` is the
connection and the repository layer is the whole of the enforcement.

**Redis is deliberately not backed up.** `eval_jobs` is the source of truth and the queue was
always a dispatch mechanism over it.

### What this session deliberately did not do

- **No penetration test has been performed.** The acceptance criterion for this session names one,
  and an external test is a thing somebody is hired to do rather than a thing a commit can claim.
  What exists is the escape suite, the tenancy suite on both drivers, and the isolation assertions
  in every session's own tests.
- **The abuse weights are a starting point, not a calibration.** They are chosen so that the
  interesting combinations cross the thresholds and the boring ones do not; tuning them honestly
  means running the ladder against real traffic first.
- **PII redaction of trace payloads is not implemented.** The data-lifecycle spec names it as an
  option for regulated customers. The trace deliberately contains what the agent read, and
  redacting it at ingestion is a different feature with a different contract — not a filter to
  slip in beside the log redactor.
- **`planConcurrency` is still not wired to the dispatcher.** Session 5 introduced it as the
  plan-aware layer over the flat defaults and left it unwired; the enforcement ladder states its
  concurrency numbers so that the day it is wired the rungs are already correct, but today the
  soft limit's teeth are the platform-key ceiling.
- **The edge configuration is rendered, not applied.** Nothing here has credentials for a WAF. The
  JSON is the input to whatever mechanism an account uses, and the pipeline only asserts it has
  not drifted from the table it came from.
- **A workspace export has no UI.** It is an authenticated HTTP route with a capability check; the
  client work to put a button on it is not in this session.

---

## Authentication and membership

Session 2 of the hosted migration. There are now real users, real sessions, and a client that
cannot see anything it is not a member of. Session 1 put a `workspace_id` on every row; this is
what decides *whose* workspace a request is in.

**The local path is still the default and still needs nothing.** `npm run dev` starts with no
Postgres, no Redis, no Docker and no cloud account — and, importantly, with authentication
*on*. See [the local issuer](#the-local-issuer) for why that is not a contradiction.

### The shape

```
  browser                                    server
     │                                          │
     │  1. token from the issuer ───────────▶   verified against cached JWKS
     │                                          iss · aud · exp · nbf · signature
     │
     │  2. POST /v1/auth/session ───────────▶   sub → users.external_id
     │     Authorization: Bearer <token>        first sight? create user + personal workspace
     │     ◀─── user, workspaces, role          all inside one transaction
     │
     │  3. POST /v1/ws-ticket ──────────────▶   membership lookup for the workspace asked for
     │     { workspaceId }                      refuse (403 + audit row) if not a member
     │     ◀─── single-use ticket, 30s
     │
     │  4. wss://…/ws?ticket=… ─────────────▶   Origin checked, ticket consumed (once)
     │                                          socket is scoped for its whole life
     │                                          re-checked every 60s against membership
```

Four requests where there used to be one, and each exists for a reason the next one cannot
cover. Nothing below step 4 can be talked into a different workspace: a socket's scope was
decided by a `workspace_members` row before the handshake, and there is no message that changes
it. **Switching workspace is a new socket**, deliberately.

### Provider-agnostic, on purpose

The server verifies an OIDC JWT against a JWKS URL and maps `sub` to `users.external_id`. That
is what Clerk, Auth0, Okta, Cognito and Supabase Auth all issue, so pointing this at any of them
is three environment variables and no code:

```bash
JAROKU_AUTH_ISSUER=https://your-app.clerk.accounts.dev
JAROKU_AUTH_AUDIENCE=jaroku
JAROKU_AUTH_JWKS_URL=https://your-app.clerk.accounts.dev/.well-known/jwks.json   # optional
```

There is no vendor SDK in the request path, so D3 is a config value rather than a rewrite. The
JWKS cache is the usual shape and for the usual reasons: a TTL so the provider's latency is not
this server's latency, a **forced refresh on an unknown `kid`** so rotation works, and a **rate
limit on that refresh** because `kid` comes off an unverified token header — "re-fetch on unknown
kid" with no leash is a remote trigger that makes this server hammer its own auth provider on
demand. A failed refresh **keeps the keys it already had**, exactly as a failed MCP discovery
keeps its tool list.

**A token that cannot be verified because the ISSUER is down is a 503, not a 401.** A 401 there
would sign every user out of a working session because a third party had a bad minute, and the
client's socket layer branches on precisely that distinction.

### The local issuer

With no issuer configured, the server runs one: an RS256 key pair generated at boot, published
at its own `/v1/auth/jwks.json`, minting real tokens that go through the **same** verifier, the
same JWKS fetch, the same `iss`/`aud`/`exp` checks.

This is deliberately not a flag that skips verification. A bypass would mean the path exercised
on every developer's machine every day is a *different* path from the one that runs in
production — so the code that actually matters is the code nobody runs, and the day it breaks is
the day it is in front of users.

What is missing locally is a password, not a signature: `POST /v1/auth/dev-login` takes an email
and hands back a token for it. That is exactly as dangerous as it sounds, which is why it says
so at every boot and **refuses to start under `NODE_ENV=production`**. The signing key is
persisted to `server/.devauth.json` (`chmod 600`, gitignored) so a `tsx` restart does not sign
you out — the predictable alternative is somebody reaching for a bypass to stop being logged out.

### Why the ticket exists

A browser **cannot set an `Authorization` header on a WebSocket**. The two things people reach
for instead are both wrong:

| Approach | Why not |
|---|---|
| Long-lived JWT in the query string | Lands in access logs, proxy logs and `Referer` headers, and stays there for as long as logs are kept |
| A cookie | WebSockets are **not covered by CORS**, and a cookie is attached to an upgrade from *any* origin — which is cross-site WebSocket hijacking |

So the thing that does go in the URL is worth nothing thirty seconds later and worth nothing
twice. A ticket is 256 bits of `randomBytes`, **stored as a SHA-256 digest** so a copy of the
table is not a set of credentials, scoped to one workspace, and **consumed atomically** — the
redemption is a `DELETE` whose row count is the decision, so exactly one caller wins even when
two race on different replicas.

Backed by Postgres rather than Redis, and that is a considered deviation from the spec: there is
no Redis client in this codebase until Session 5 introduces one for the queues, and a
`DELETE`-that-returns-a-count has exactly the property `GETDEL` was wanted for. `RedisTicketStore`
drops in behind the same interface when it lands. `MemoryTicketStore` is the local default.

### Why the origin check is not optional

**WebSockets are not covered by CORS.** This surprises people, and the surprise *is* the
vulnerability. A browser will not let `evil.example` read a cross-origin `fetch` response without
the server's permission — but `new WebSocket("wss://jaroku.example/ws")` from a page on
`evil.example` connects, with the user's browser doing the connecting, and no CORS check applies
because the handshake is not a CORS request.

The `Origin` header is the actual defence: browsers set it on every upgrade and script cannot
forge it. So it is checked **before** the ticket, and a failure is an HTTP 403 on the raw socket
rather than an opened-then-closed connection.

- **A missing `Origin` is allowed**, and that is correct rather than a loophole. Browsers always
  send one; `curl`, the `ws` library, the test suites and the fallback debug client do not.
  Refusing it would break every non-browser client while stopping no attack — an attacker with a
  non-browser client can send any origin they like, so the header only ever *means* anything when
  it comes from a browser, and a browser always sends it. What stops that case is the ticket,
  which is a credential rather than a claim.
- **A literal `null` origin is refused.** That is a sandboxed iframe or a `file://` page — an
  opaque origin, which is exactly the one not to trust.
- `JAROKU_ALLOWED_ORIGINS` is **required in production**. Unset there is a decision nobody made,
  and guessing gives either "nothing can connect" or "anything can", so the server refuses to
  start instead.

### Roles, as data

Three roles, one table, one check. Scattered `if (ctx.role !== "owner")` across fifty command
handlers is how you get a hole, and the hole is always in the handler nobody thought about.

| Role | May |
|---|---|
| **member** | Build, run, edit, pause, branch and evaluate agents; answer an MCP confirmation on their own run; read members, providers, MCP servers and deployments |
| **admin** | Everything a member may, plus connect MCP servers, store provider keys, and deploy |
| **owner** | Everything an admin may, plus manage membership, the workspace, and billing |

The split follows one question: **does this change what the workspace *is*, or what is *in* it?**
Building and running agents is the product, and every member does it. Connecting a third-party
MCP server, storing a provider key, or putting an agent on a public URL commits the whole
workspace to something — money, an external dependency, an internet-facing endpoint.

The roles are **nested** rather than three copied lists, so a new member capability is
automatically an admin's and an owner's. `npm run test:capabilities` reads `wsRelay.ts` and fails
when a command exists with no capability, so one added in a later session cannot arrive ungated —
**unclassified is refused, not allowed**.

A refusal is answered **on the channel the asking panel is listening to**, and it happens at the
door: a command that would be refused never reaches the app, because a refusal that forwards
first has already written the key.

### Membership

| Action | Who | Notes |
|---|---|---|
| Create a workspace | anybody signed in | `POST /v1/workspaces`, not a socket command: a socket is scoped to a workspace by its ticket, and this is the request that brings one into existence. The caller becomes its owner, and `kind` (`personal` \| `team`) is required rather than defaulted — it decides whether the workspace has a members list and an author column at all, and it does not change afterwards. Rate-limited per person |
| Invite | owner | The link is shown **once** — only a hash is stored, and there is no email sender here |
| Accept | the invitee | `POST /v1/invites/accept`, not a socket command: the accepter is not a member yet, so there is no socket scoped to the workspace they are joining |
| Change role | owner | Refuses to demote the **last** owner |
| Remove | owner | Refuses to remove the last owner. Kills their outstanding tickets, and their open sockets close on the next re-check |

Every one of them writes an `audit_log` row **inside the transaction that makes the change**, so
there is no path that alters membership without a record of who did it.

**And the record is readable.** `audit_log` is written by five subsystems — membership mutations,
every GitHub safety override, secret reveals and rotations, enforcement appeals, workspace export
and deletion — and the reason given in the code for writing those rows is that somebody will need
to read them. The reader existed and had no caller: no command, no route, no UI, so the rows were
kept for a question nobody could ask. `listAudit` is the workspace panel's **Audit** section, on a
channel of its own, answered to the asking socket and never broadcast. It is `workspace:manage` —
the owner's — because of what the rows contain rather than because reading is privileged: an actor,
a target, an IP, and the metadata printed as stored, because an audit trail read during an incident
must not have summarised away the field the question turned on.

**Where all of it is in the product.** The workspace switcher in the top bar creates a workspace and
opens **Members and invitations**, a panel over the shell — the same panel every other
workspace-scoped setting hangs off, because none of it is a fact about an agent and a tab beside
`GitHub` would put "delete this workspace" one click from an agent's diff. The panel lists members
with their roles as editable selects, lists outstanding invitations separately (nobody has accepted
one, so counting them as members would be a lie about who has access), and shows the invite link
once.

**The link is assembled in the browser, not by the server.** `inviteMember` answers the asking
socket with the secret — once, because only a hash is stored — and the server has no idea what
origin the app is served from and deliberately has no mailer. So the client builds
`<origin>/?invite=<token>`, the invitee opens it, the sign-in screen says an invitation is waiting,
and the redemption fires as soon as there is a session to spend it with. The parameter is removed
from the URL the moment it is spent: an invitation is single-use, and a URL still carrying a spent
one is a link whose reload fails with a message that reads exactly like a forgery.

The invite token is `<workspace_id>.<secret>`, and the workspace id in it **authorises nothing**:
it selects which rows to search so the query can be scoped, and the 256-bit secret is the whole
of the proof. That is what lets `workspace_invites` keep an RLS policy while still being readable
by somebody with no membership at all — the trick `ws_tickets` could not use, which is why that
table is policy-free and holds nothing but a digest, an id and a role for thirty seconds.

### A socket must not outlive its membership

Every HTTP request re-presents its token and is re-checked. **A socket is checked once, at the
upgrade**, and would then run for as long as a browser tab is open — still acting on a membership
that may have been revoked in its first ten minutes. Nothing about the socket itself would ever
notice.

So every open socket is re-checked on a timer, and told the outcome on a `session` channel:

| Event | What happens |
|---|---|
| `expiring` | The token has under five minutes left. A **warning**, not a close — cutting somebody off mid-generation would be the server causing the outage it is warning about |
| `expired` | Closed, with the "sign in again" close code |
| `revoked` | No longer a member. Closed immediately |
| `workspace_changed` | The workspace itself is gone. Closed with the **reconnect** code — a different instruction |
| `role_changed` | Still a member, at a different role. The socket **stays open** and re-authorises against the new one |

A role change is applied in place because the connection is still legitimately theirs; what
changed is what it may do, and the capability check reads the socket's live context on every
command. That is the enforcement, not a notification.

The distinction is worth a test rather than a sentence, and `test:tenancy` has one: a socket
that **handshakes as an admin** — from a real membership row, not a stale capture — is demoted
mid-session and immediately re-sends the exact command it just succeeded at. It is refused, and
the command never reaches the app. Connecting as a member and demoting from there would prove
nothing: a server reading the handshake context would refuse it too, and the test would pass for
the opposite of the right reason.

**A failed re-check does not close anything.** The database being briefly unavailable is our
problem, and signing every user out over it would turn a blip into an outage — the same reasoning
the JWKS cache applies to a failed refresh.

The membership decision is cached for **30 seconds**, positives and negatives both (without the
negative, guessing workspace ids is a database round trip per guess). That staleness window is a
real security property rather than a tuning detail, so it is stated: between a revocation and the
cache expiring, a request on another replica may still be authorised at the old role. Every
membership mutation invalidates explicitly, which makes it exact on the replica that made the
change; Session 5's Redis pub/sub is what makes it exact everywhere.

### The client

`lib/socket.ts` makes one distinction that everything else depends on, because "disconnected" and
"unauthorised" arrive at a browser looking identical — a request fails, a socket closes:

- **retryable** — offline, a 5xx, a 429, a dropped socket. Back off (exponential, jittered,
  capped) and try again. The backoff is reset by a connection that *opened*, not one that was
  attempted.
- **not retryable** — a 401 or a 403. **Stop**, and show the sign-in screen.

Getting that backwards produces the worst behaviour this client is capable of: retrying a 401
every second, forever, behind a spinner, while the user has no idea they need to sign in.

**Every store fully resets on a workspace switch.** A perfectly-scoped server still leaks if the
browser keeps the rows — a `traceStore` still holding the previous workspace's step payloads is a
cross-tenant leak in the UI, and those payloads contain email content, database output and Slack
messages. The reset happens *before* the new socket opens, so there is no window in which the new
workspace's first snapshot merges into the previous one's rows.

`npm run test:reset` reads the store **directory** and fails when a store exists that is neither
reset nor explicitly excluded — because the leak that actually happens is not in a store somebody
tested, it is in the one added six months later that nobody wired in.

**A store is memory; `localStorage` is not**, and that was this suite's blind spot. The last test
input per agent was remembered under `jaroku.input.<agent>` — keyed by slug alone, and slugs
[stopped being globally unique](#the-one-exception-to-the-frozen-schema) in Session 1. Two
workspaces with a same-named agent on one browser meant one tenant's last input loading into the
other's composer, and `R` re-running it. A test input is whatever the user typed to drive the
agent: a real customer email, a real order id. It survived not just a switch but a sign-out,
which no store reset could reach.

The key now carries the workspace, read inside `inputKey` rather than passed in, so every call
site is scoped by construction. Sign-out sweeps the prefix as well, for the browser two people
share. And `test:reset` now audits **every `jaroku.*` key the client writes**, found by reading
the source rather than from a list, and fails when one is classified as neither workspace-scoped
nor non-tenant — the same enumerate-don't-remember discipline as the
[channel audit](#every-channel-not-just-the-ones-somebody-noticed).

### CORS, and why it is here rather than in Session 8

The client is served by Vite on `:5173` and this server answers on `:4317`, so **every request
the browser makes here is cross-origin** — the whole sign-in exchange included. Without an
`Access-Control-Allow-Origin` the browser blocks the *response*, `fetch` rejects with a bare
"Failed to fetch", and there is no way to sign in at all.

The allowlist is [the socket's](#why-the-origin-check-is-not-optional), unchanged and not a
second copy: one list decides both who may open a socket and who may read an HTTP response, so
the answer to "may this origin talk to us" cannot depend on which transport asked. The origin is
**echoed by name, never `*`** — a wildcard is not shorthand for a list, it is the absence of one
— and there is deliberately no `Access-Control-Allow-Credentials`, because this server
authenticates with a bearer header and never a cookie.

Note that CORS and the socket's `Origin` check defend against opposite things and neither
replaces the other. CORS asks the *browser* not to hand a response to script from another
origin; the origin check is the *server* refusing the connection outright, because WebSockets
are not covered by CORS at all.

The failing responses carry the headers too. A 401 a browser cannot read arrives at the client
as "could not reach the server", which inverts the one decision `lib/socket.ts` exists to get
right — retry, or stop and show sign-in.

Session 8 still owns the rest of the posture: CSP, HSTS, `Referrer-Policy`, per-route rate
limits. This is the part Session 2 cannot work without.

### Onboarding belongs to the person, not the browser

The [first-run flow](#first-run) was gated on `localStorage`, which was exactly right when
Jaroku was one user on one machine: the browser and the account were the same fact. Real
accounts made them different facts and left the gate reading the wrong one, so "is this user
new" actually answered **"is this browser new"**:

- a new account signing in on a browser that had already onboarded skipped the flow entirely,
  and inherited whatever step the previous person stopped on;
- an existing user on a second device, or in a private window, was walked through a welcome
  screen for a product they use daily;
- two accounts on one machine — which is the whole point of this session — meant the second one
  never onboarded.

`users.onboarded_at` answers it instead, reported as `user.onboarded` on `/v1/auth/session` and
set by `POST /v1/auth/onboarded`. That route **takes no user id**, which is the whole of its
authorisation story: the only person it can mark is whoever presented the token, so there is
nothing to forge because there is nothing to send. It is idempotent, because the client fires it
from an effect a second tab or a reload can re-run, and the column records the *first* time
rather than the latest.

**On `users`, not on `workspace_members`.** Onboarding teaches somebody what the product *is* —
what a plan gate is, what a trace shows — and that is learned once by a person, not once per
workspace they join. Somebody accepting an invitation to a colleague's workspace is not new to
Jaroku and must not be told they are.

What stays in the browser is *where somebody is up to*: the step and the one-time hints, keyed
by user id so two accounts sharing a machine do not resume each other's flow. Existing rows get
`NULL`, so everybody provisioned before the migration is offered onboarding once — there is no
truthful backfill, since the only record of who had onboarded was in browsers the migration
cannot reach, and one extra welcome screen is a smaller harm than silently skipping it for
somebody genuinely new. A workspace that already contains a generated agent short-circuits it
anyway.

### The gate: two people, one server, at the same time

`npm run test:acceptance` is Session 2's acceptance criterion, run rather than described: **two
real accounts, two real workspaces, both using the app simultaneously against one server,
neither able to observe the other by any command, socket, or timing.**

It is a separate suite from the attack one because it catches different failures. An attack asks
*can I reach across the boundary if I try*; this asks *does the server keep two ordinary sessions
apart while it is busy* — and the answers differ wherever per-operation state lives in a
module-level variable. No adversarial test would have provoked the build-scope leak above,
because the attacker's move there is to do something entirely legitimate in their own workspace
at the wrong moment.

Both accounts sign in through the real three-request exchange, open real sockets, and then run
overlapping scripts of ordinary work — list, run, load, list again — with the suite asserting the
overlap actually happened rather than assuming it. Then:

- **command** — every answer either of them received is their own, and neither inbox contains the
  other's agent id or workspace id anywhere.
- **socket** — the unbidden traffic too: the live trace and history pushes one person's run
  causes while the other has a socket open.
- **timing** — naming a run id that is real *in the other workspace* returns a byte-identical
  answer to naming an invented one, and costs the same. The bound is a ratio rather than a
  threshold: this does not claim to defeat a lab-grade timing attack, it asserts there is no
  order-of-magnitude oracle, which is what a scoped-versus-unscoped query produces and what
  would be exploitable over a network.

### The threat model

What each layer stops, what it explicitly does not, and why the two decisions that look like
over-engineering are not: **[`server/src/auth/THREAT-MODEL.md`](server/src/auth/THREAT-MODEL.md)**.

Worth reading before touching anything in `server/src/auth/`. In particular it is where the
sentence "WebSockets are not covered by CORS" is written down with its consequences, because
that is the fact a future cleanup will not know.

### What Session 2 deliberately did not do

- **No Redis.** Tickets and the membership cache are Postgres- and process-backed. Session 5
  introduces the Redis client with the queues that need it, and both drop in behind existing
  interfaces.
- **No vendor SDK in the client.** Sign-in is the local issuer's form or a message pointing at
  the configured provider. Wiring a provider's React SDK is a client-side change with no server
  consequence.
- **No email.** An invite link is shown once to the inviter, who sends it however they like.
- **Provider keys are still process-wide.** `runtime/.env` is one file, so "anthropic is
  configured" is a fact about the install. The `providers` channel is scoped per workspace
  already, so the shape is right for Session 6's per-workspace `SecretStore`.
- **`users.external_id` is `COLLATE NOCASE` on SQLite and case-sensitive on Postgres.** An auth
  provider's `sub` is opaque and case-sensitive, so two subs differing only in case are two
  people on Postgres and one on SQLite. Harmless where SQLite is used — one person, one machine —
  but a genuine driver disagreement, and fixing it needs a table rebuild.

  Rather than leave that merely *unlikely* in production, **the server refuses to boot on
  SQLite under `NODE_ENV=production`** — the same refusal the local issuer and the dev tenancy
  middleware already make about themselves. The rebuild is still owed; this makes the
  discrepancy structurally unreachable in the meantime rather than improbable. The second
  reason is the larger one anyway: RLS is the backstop the whole tenancy model leans on and it
  exists only on Postgres, so SQLite in production is a deployment with the backstop silently
  absent. `npm run test:driver`.

---

## Workspaces and teams

The section above is about *whose* workspace a request is in. This one is about the part somebody
uses: being in more than one, moving between them, and deciding who else is in each.

Every account has a **personal workspace** from the moment it exists — `provisionUser` creates it
in the same transaction as the user, because every panel in this product is a view of one
workspace's data and an account without one cannot render anything. You cannot have a second: the
switcher does not offer the option and `POST /v1/workspaces` refuses it, because "where does my
own work live" has one answer and several things in here read as though it does.

**Team workspaces** are the ones you can have many of, be invited to, and leave.

### The switcher

The workspace name at the top of the sidebar is a control, not a label. It carries the kind icon,
the plan chip, and a chevron; opening it lists the personal workspace first and the teams below it
alphabetically — case- and accent-insensitively, so `acme co` sorts above `Zebra` and `Ångström`
sits with the As rather than after `z`. Arrow keys move, Enter selects, Escape closes.

Below the list: **+ Create workspace** and **Join a workspace**. The gear on the active row opens
the workspace panel.

### Switching is a teardown, not a navigation

Clicking another workspace does this, in this order:

```
  1. lock the UI            a scrim naming where it is going
  2. close the old socket   before anything else opens one
  3. empty every store      client/src/store/reset.ts
  4. POST /v1/ws-ticket     for the workspace being entered
  5. open a new socket      with that ticket
  6. snapshots arrive       the app refills
  7. unlock
```

**Steps 2 and 3 are the security part, and their order is the whole of it.** Two sockets open at
once would both write to the same stores, and the old workspace's broadcasts would land in the new
workspace's view. Resetting *after* the new socket opened would leave a window — however short —
in which one tenant's rows are merged into another tenant's panel. Both are cross-tenant leaks in
the UI that the server cannot prevent, and neither is visible in a screenshot of a switch that
worked: the stores look empty because the new snapshot replaced what was there. `npm run
test:workspace-switch` asserts the transcript rather than the result, which is the only thing that
can tell "closed then opened" from "opened then closed" afterwards.

If anything fails — a refused ticket, a handshake that closes before it opens, a target that never
answers — the switch **reverts to where it came from** and says why. A 403 on a ticket is not
retryable, and not-retryable used to mean sign out; being refused entry to one workspace ended the
session in the one you were already in, which is the failure that shape of error handling has here.

What survives a switch: the session, the workspace list, and per-*user* preferences. What does
not: every workspace-scoped store, any command in flight to the old socket, and the remembered
test input.

### Joining

Two ways in, and they end at the same place:

- **The link.** `jaroku://invite?token=…`, or the same token on the web origin. Opening it
  redeems the invitation as part of creating the session, so somebody who has never signed in
  lands in the team on their first request rather than being sent to sign in and then losing the
  link.
- **The code.** *Join a workspace* in the switcher takes either the whole URL or the bare token
  pasted out of Slack. The client extracts the token from whichever it was given and refuses
  what cannot be one before anything is sent — a truncated paste is the case that matters, and
  it is the one that otherwise reaches the server as a valid-looking secret.

Every refusal a redemption can produce — revoked, expired, already used, addressed to somebody
else, never existed — answers with **one sentence and one status**, deliberately: a stolen link
should not learn which of the five it is.

### Roles

Three: **owner**, **admin**, **member**, nested — an owner can do everything an admin can, an
admin everything a member can. The split follows one question: *does this change what the
workspace **is**, or what is **in** it?*

| | Member | Admin | Owner |
|---|:---:|:---:|:---:|
| Build, run, edit, evaluate agents | ● | ● | ● |
| Threads, inbox, activity, spend figures | ● | ● | ● |
| Appeal an enforcement action | ● | ● | ● |
| MCP servers, connectors, secrets, deploys, GitHub | | ● | ● |
| Invite, remove, change a role | | | ● |
| Rename, export, delete the workspace | | | ● |
| Billing: plan, spend ceiling, BYOK | | | ● |

The table lives in `server/src/auth/capabilities.ts` and is copied into
`client/src/lib/capabilities.ts`. The copy is what lets the UI decide what to draw without a round
trip; `npm run test:permission-ui` reads the server file as text and fails when the two disagree in
either direction, which is what makes "a copy guarantees they match" true rather than hopeful.

**An affordance a role cannot use is absent from the DOM** — not disabled, not hidden with CSS. A
disabled control with "only an owner can do this" beside it has decided somebody should keep
looking at it, and a control hidden with CSS is one devtools panel away from being clicked. None
of this is enforcement: every command is checked again by the relay and every route at its door.

### Members and invitations

The workspace panel's Members section lists everybody — owner first, then admins, then members,
each group alphabetical, your own row highlighted. An owner can change a role, remove somebody, or
mint an invitation; everybody else sees the list and a static badge.

An invitation is **a link, not an email** — this server has no mailer. It is shown once, copyable
for thirty seconds, and one-shot. Leaving the address blank makes it redeemable by whoever holds
it; filling it in binds it to that address. Pending invitations are listed with a revoke button
until they are accepted, at which point the row becomes a member.

An owner **cannot leave** — transfer ownership first. Everybody else can, and lands back in their
personal workspace with their socket closed on the way out.

### Seats are a plan limit

Free and Pro are **solo**: one member, which is you. Inviting anybody needs Team. That is an
entitlement rather than a permission, so what an owner on Free gets is the upgrade card and not a
button that fails — the two gates are separate on purpose, and if both are right neither a 402 nor
a capability toast should appear in ordinary use.

### Personal versus team

A personal workspace has no members panel, no author column on threads, and no role badges
anywhere. Those are not hidden — for a workspace that is nobody else's they are answers to
questions nobody is asking.

---

## Per-agent access

A workspace role is one answer to *"what may this person do"*, and it is the same answer for every
agent in the tenant. That is fine for a workspace of three and wrong for the case this is about: a
contractor brought in to fix one agent held the same authority over every other one.

**There is one resolver, not a second permission system.** Grants are data flowing through the same
check every command already passes, in the file the role matrix already lives in:

```
  workspace role  →  the role's default set  →  the grant
                  →  intersect with the role's ceiling, ALWAYS
                  →  the implication closure
```

**Seven agent-level capabilities** — `view`, `run`, `edit`, `eval`, `deploy`, `secrets`, `admin` —
with the implication rules as data: `view` is implied by everything, `edit` implies `run`, and
`secrets`, `edit` and `admin` imply none of each other, because somebody who writes an agent's code
and somebody who holds its production credentials are genuinely different roles.

A grant may **narrow** somebody below their role's default or **widen** them within it, and can
never exceed it. That is enforced when it is written *and again on every command* — which sounds
redundant and is the only thing that makes a demotion bite without anybody rewriting grant rows.
Expiry is evaluated in the resolver and nowhere else, because a control that is correct only as
often as a cron fires fails silently in the generous direction.

Grants are **time-boxable**, and `deploy`, `secrets` and `admin` require a written note. Six months
later *"why does this contractor have deploy"* needs an answer that is not archaeology, and the only
moment anybody can write it is the moment they know.

**The tab is read-only without `admin` rather than hidden.** "Who can deploy this?" is a question a
member should be able to answer without asking an admin, and hiding the answer produces exactly the
Slack thread the tab exists to eliminate. Every mutation control is **absent** rather than disabled
for a role that cannot use it.

**A cross-workspace agent id answers "there is no such agent" rather than refusing**, on every
command — a refusal confirms the id exists, which turns the socket into an enumeration oracle.

`access.denied` is written per refusal rather than deduplicated, because the *pattern* is the
signal: nobody files a ticket saying their capability is misconfigured — they try, fail, and
eventually ask a colleague to do it for them, which is the outcome the whole feature exists to
prevent.

### What this does not cover, stated on the panel itself

Every grant here governs access **through Jaroku**. A deployed agent answers HTTP directly, on a
template with no auth layer of any kind — so the Exposure section names the live URL, says in a
sentence that the endpoint is unauthenticated, and renders **even when nothing is deployed**, because
a section that disappeared would have its absence read as safety.

Live sessions show a name, two words about the browser and a duration — no IP addresses, no tickets,
no raw User-Agent. **End session closes one socket and revokes nothing**, and the confirmation says
so, because an administrator who believes they removed somebody's access and removed their tab is
the failure that button invites. The sessions listed are the ones *this process* holds: behind two
gateways each reports its own, and the count is honest about what it counted.

---

## Where data lives

| Path | What | Tracked? |
|---|---|---|
| browser `localStorage` | `jaroku.token` (the bearer token), `jaroku.workspace` (the last workspace), `jaroku.onboarding.<user id>` (where a person is up to in the first-run flow — *whether* they finished it is `users.onboarded_at`, on the server), `jaroku.input.<workspace id>.<agent>` (last test input). Both of the last two are keyed so a browser two people share never hands one's data to the other. Deleting the first two signs you out; the rest lose nothing that matters | n/a |
| `server/.devauth.json` | The **local issuer's** RS256 signing key, `chmod 600`. Only exists when no `JAROKU_AUTH_ISSUER` is set | No |
| `server/jaroku.db` | The local database. Identity (`users`, `workspaces`, `workspace_members`, `workspace_invites`, `ws_tickets`, `audit_log`) + agents (`agents`, `agent_versions`) + secrets (`secret_refs`, `workspace_secrets`, `workspace_data_keys`) + traces (`runs`, `steps`) + eval control plane (`datasets`, `dataset_examples`, `rubrics`, `eval_runs`, `eval_jobs`, `eval_scores`) + MCP registry (`mcp_servers`, `mcp_tools`) + deploy records (`deployments`, `deployment_logs`) + billing (`workspace_balances`, `usage_events`, `billing_holds`, `subscriptions`, and the platform-level `plans` and `billing_webhook_events`). Every one of them carries a `workspace_id`, except the last two, which are the platform's own catalogue and its delivery log | No |
| Postgres (`JAROKU_PG_URL`) | The same schema, hosted, with RLS. Selected by `JAROKU_DB_DRIVER=postgres`; see [the tenancy model](#the-tenancy-model) | No |
| `runtime/.objects/` | The **local object store**: every agent version, every in-flight staging copy, every export, under `ws/<workspace_id>/…`. Selected by `JAROKU_OBJECT_STORE=fs`, which is the default — see [storage isolation](#storage-isolation) | No |
| R2 / S3 (`JAROKU_OBJECT_STORE=s3`) | The same keys, hosted | No |
| `server/.objectkey` | The key that signs presigned object URLs, `chmod 600`. Generated on first use; **supplied by config in production**, or replicas disagree | No |
| `runtime/agents/<id>/` | A generated agent project — yours, editable, portable. A **materialisation** of the current version now, not the source of truth | No (except `example_agent`) |
| `runtime/agents/.history/<id>/` | Pre-Session-3 edit snapshots. No longer written or read: history is `agent_versions` — see [versions](#versions) | No |
| `runtime/.checkpoints/` | Durable LangGraph checkpoints (`<run_id>.sqlite`) and pause control files, when `JAROKU_CHECKPOINTER=sqlite` | No |
| Postgres `langgraph` schema | The same checkpoints, hosted, keyed `ws:<workspace_id>:run:<run_id>`. LangGraph owns the tables; Jaroku owns the schema and the grant | No |
| `runtime/.env` | Provider, connector and MCP server keys, when `JAROKU_SECRET_STORE=dotenv` (the default) | No |
| `oauth_connections` | Which connectors a workspace has authorised, whose account, which scopes were granted, and the NAMES its tokens live under. No token columns exist | No |
| `oauth_states` | A hashed, single-use, ten-minute flow. Gone the moment a callback consumes it — and an ABANDONED one is swept hourly, which is housekeeping rather than a boundary: an expired state is already refused at redemption | No |
| `workspace_secrets` / `workspace_data_keys` | The same credentials, hosted: envelope-encrypted ciphertext, per-workspace data key. Never a plaintext column | No |
| `abuse_signals` | What a workspace — or an address with no workspace — has been observed doing, with the weight each observation carried at the time. Swept after 30 days | No |
| `workspace_enforcements` | Which rung a workspace is under, who decided, the evidence at the time, and the appeal. Append-only, with a `lifted_at` | No |
| `steps_YYYY_MM` | On Postgres, `steps` is one table per month — see [the data lifecycle](#data-has-an-end-date-now). `steps_default` catches anything outside the created months and should always be empty | No |
| `ws/<id>/exports/workspace-<uuid>.tar` | A workspace's full export: one NDJSON per table plus every agent's current source. No credential of any kind is in it. Expires on the plan's retention | No |
| `secret_refs` | What each workspace has configured — names, providers, last use. **No value column, on purpose** | No |
| `usage_events` | One row per metered thing: what was bought, whose money bought it, what it cost, and whether that cost is an answer. Traces contain user data; this contains only the shape and price of a call | No |
| `runtime/agents/<id>/mcp_tools.json` | An agent's MCP grant: servers, tools, schemas, impact. Host-written, read-only to edits | No (with the project) |
| `runtime/agents/<id>/{serve.py,Dockerfile,.dockerignore,pyproject.toml}` | Deploy tooling. Host-written, read-only to edits, regenerated on every deploy | No (with the project) |

Both SQLite stores share one database file on one connection — a single writer, and
aggregation can `JOIN` eval jobs against the frozen `steps` table directly.

**Checkpoint sweeping.** When an eval finishes, the resumable-checkpoint state its jobs left
behind is swept (the traces stay — only the pause/resume machinery goes, and nobody resumes a
finished eval job). On startup, orphans from evals whose sweep never ran are collected too.
**An interactive run's checkpoint is never swept** — it is exactly the thing you might come
back to branch from, and the run ids come from the eval's own job rows rather than from a
filename pattern, which is what makes that true by construction.

---

## Security notes

- **Keys never leave the server process.** They are read from `runtime/.env`, never logged,
  never echoed to a client, never written into a generated file. Both env loaders log key
  *names* only.
- **Path confinement everywhere.** Every path a model emits is validated: absolute paths,
  `..`, and null bytes are rejected. Agent ids are validated against
  `^[a-z][a-z0-9_]{0,63}$` — the same pattern enforced independently on the Python side, so
  a client-supplied id cannot traverse out of `agents/`.
- **No user string becomes an object key un-normalised.** An object store has no `..` and will
  store one happily; the traversal happens on whatever turns the key back into a path. Keys are
  built only from validated uuids and paths that passed the same gate, and the local store
  re-checks the resolved path against its root anyway — see [object layout](#object-layout).
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
- **An MCP server is never trusted.** Its tool list is a claim, its `readOnlyHint` is ignored,
  its output is capped and stripped before it reaches a model or a trace, and a tool it did
  not appear in the agent's manifest for cannot be called at all. High-impact calls stop for
  an explicit confirmation, and timing out denies.
- **A credential has no way out.** The secret store's interface has no `get` that returns a
  plaintext value to a request handler — values go in through `set` and come out only into a
  run's environment through `getForRun`. Everything else answers *names*. Locally the value
  lives in `runtime/.env`; hosted it is envelope-encrypted per workspace and bound to
  `<workspace_id>:<name>`, so a ciphertext moved between workspaces, or relabelled to another
  variable, decrypts to nothing. See [the secret lifecycle](#the-secret-lifecycle).
- **MCP credentials are stored as env var names.** The value is read at the moment of use and
  never reaches a generated project, a log line, or the browser.
- **Provider keys take exactly that path.** A key entered in the first-run flow or in Settings
  goes through the *same* credential writer — one instance, shared — and lands as one
  correctly-named line in `runtime/.env`. Every other line of that file survives byte for byte,
  the file is `chmod 600`, and what the browser learns is `configured: true`. The server logs
  `[providers] anthropic key set`; the value appears nowhere.
- **A deploy sends credentials, by name and then by value, and nothing else.** What crosses the
  socket is variable *names* plus whether each is set. The values are read from `process.env` at
  the moment of the Railway mutation, travel in an HTTPS request body — never an argument, since
  a process table is world-readable — and are held only long enough to scrub them out of every
  build-log line before it is shown or stored. `deployments.env_keys` has names in it; there is
  no column a value would fit in, and `.dockerignore` keeps `.env` out of the image.
- **A deployed agent's URL requires a bearer token.** It runs on your provider key, so an open
  one is an unmetered way for anyone who finds it to spend your money. Jaroku mints the token,
  sets it on Railway and shows it once; `serve.py` refuses to start without one unless
  `JAROKU_SERVE_PUBLIC=1` says so explicitly. The check is constant-time.
- **High-impact MCP tools are refused in a deployed container.** There is nobody there to ask,
  and the bridge's per-run grant is process-global — one approval would leak across every later
  request. Deployed agents run with `JAROKU_MCP_CONFIRM=require`.
- **The server authenticates every request and every socket.** A verified OIDC token, a
  membership lookup, a single-use ticket, an origin allowlist, and a capability check at the
  door — see [authentication and membership](#authentication-and-membership).
- **The network posture, stated plainly.** This README said for seven sessions that the server
  binds localhost and should not be put on a network. That sentence is now false and is replaced
  rather than deleted, because what replaced it is a list rather than a promise:

  | | What defends it |
  |---|---|
  | Untrusted code | a per-run micro-VM with a computed egress allowlist; nothing model-written runs on the control plane, including the import check and the graph introspection |
  | Cross-tenant reads | a repository layer that cannot be called without a context, and Postgres RLS as the backstop |
  | Credentials | a vault with no method that returns a plaintext value to a request handler, and a redaction filter installed over every log sink |
  | Volume | an edge WAF, a per-IP bucket, and a per-workspace-per-action bucket |
  | Browsers | CORS from one allowlist, an Origin check on the upgrade, a policy that permits nothing, HSTS, and body limits on every route |
  | Abuse | recorded signals, a decaying score, and a ladder whose last two rungs need a human |

  **What the local mode still assumes has not changed.** `npm run dev` binds localhost, runs
  agents as subprocesses of the server, keeps keys in `runtime/.env`, and is meant for one
  person on one machine. Several facilities exist only there and refuse to start under
  `NODE_ENV=production` rather than degrading quietly: the local subprocess sandbox, the
  filesystem object store, `JAROKU_DEV_AUTH=1`, and the local token issuer. A local install put
  on a network is still a local install put on a network.
- **An external penetration test has not been performed.** The hosted posture above is what the
  code does and what its suites assert; it is not a third party's opinion, and this README will
  not imply that it is until one exists.
- **`JAROKU_DEV_AUTH=1` and the local issuer are development facilities**, and both refuse to
  start under `NODE_ENV=production`. The first opens sockets with no credential at all; the
  second mints real, verifiable tokens for any address with no password. Both announce
  themselves at every boot.
- **Nothing that grants access reaches a log.** The ws-ticket rides in a query string because a
  browser has nowhere else to put it, and the request logger redacts it by name — along with
  `token`, `key`, `code` and `access_token`. Tickets and invitations are stored as SHA-256
  digests, so a copy of either table is not a set of usable credentials.
- **A cross-tenant attempt is a recorded security event.** Asking to act in a workspace you are
  not a member of writes an `audit_log` row naming who tried and from where. It is deliberately
  *not* recorded when the workspace does not exist at all — a scan of random uuids would
  otherwise be an unbounded write against the table whose whole job is recording the attempts
  that matter — and the refusal message is identical either way, so it cannot be used as an
  existence oracle.
- **A *deployed agent* deliberately binds `0.0.0.0`**, because a service nothing can reach is
  not a service — which is exactly why its bearer token is not optional.

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

**"the Railway CLI is not installed"**
Jaroku uses it to upload your project. `brew install railway` or `npm i -g @railway/cli`, then
restart the Jaroku server — it inherits its `PATH` at launch. Nothing was created in your
account: the CLI is checked before any Railway resource exists.

**I deployed twice and only see one URL**
That is deliberate: a redeploy replaces what is running on the same Railway service rather than
creating a second one. The earlier record is kept and marked `superseded`. Use **Forget** first
if you genuinely want a separate deployment — and delete the old service in Railway, because
forgetting a record does not stop the thing it described.

**A deploy says `interrupted`**
The Jaroku server restarted while it was in flight, so nothing is watching it any more. Whatever
had already been created still exists in your Railway account — check there before deploying
again, or you will end up with two projects.

**The deployed agent returns 401**
`/run` needs `Authorization: Bearer <token>`. The token is shown once, when the deploy goes live,
and Jaroku keeps no copy — rotate it by setting `JAROKU_SERVE_TOKEN` in Railway yourself, or
deploy again for a fresh one.

**The deployed agent 500s on every request**
Usually a credential the container does not have. The deploy warns before it starts if a declared
variable is unset locally, but you can proceed past that — a connector template *raises* when it
is unconfigured (rule 7), so a missing key is a failed request rather than a degraded one. Set it
in Railway's variables and redeploy.

**The app shows a sign-in screen and I never set up an auth provider**
That is the [local issuer](#the-local-issuer). Type any email address; there is no password. It
exists so the code that authenticates you locally is the same code that authenticates a user in
production, rather than a flag that skips it.

**"open this socket with a ticket from POST /v1/ws-ticket"**
Something connected to the WebSocket without doing the credential exchange first. The React
client and the fallback debug client both do it; a `wscat` or a script will not. Either do the
exchange, or set `JAROKU_DEV_AUTH=1` — which opens sockets with no credential at all, says so at
boot, and refuses to start under `NODE_ENV=production`.

**A socket is refused with 403 "origin not allowed"**
The page's origin is not in `JAROKU_ALLOWED_ORIGINS`. Unset, that defaults to the Vite dev server
and the relay's own port. WebSockets are not covered by CORS, so this check is the actual
cross-site-hijacking defence and is not optional — see [why](#why-the-origin-check-is-not-optional).

**Signing in says my email "already belongs to a different sign-in"**
`users.email` is unique, and that address is held by a different provider `sub` — usually because
the auth provider changed, or two are configured at once. It is a sentence rather than a stack
trace precisely because there is nothing automatic that can safely resolve it.

**Everything disappeared after I switched workspace**
That is the switch working. Every store is emptied before the new socket opens, because a
`traceStore` still holding the previous workspace's payloads is a cross-tenant leak in the UI
even when the server behaved perfectly.

**Branching says "no durable checkpoint for that step"**
That run predates checkpointing, or its checkpoint was swept (which happens for finished eval
jobs). Re-run the agent interactively and branch from the new run.

---

## License

Apache License 2.0. See [LICENSE](LICENSE).

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
- [Debug depth: pause, resume, branch](#debug-depth-pause-resume-branch)
- [The eval engine](#the-eval-engine)
- [Cost accounting](#cost-accounting)
- [Connectors](#connectors)
- [MCP servers](#mcp-servers)
- [Deploying an agent](#deploying-an-agent)
- [The React client](#the-react-client)
- [WebSocket protocol](#websocket-protocol)
- [Configuration](#configuration)
- [Running things by hand](#running-things-by-hand)
- [Tests](#tests)
- [Developing for free (fixtures)](#developing-for-free-fixtures)
- [The tenancy model](#the-tenancy-model)
- [Authentication and membership](#authentication-and-membership)
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

# Only needed by the connectors you actually select.
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
SLACK_BOT_TOKEN=
DATABASE_URL=postgres://...

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
│   │   ├── models.py          # provider selection (fake / anthropic / openai)
│   │   ├── fake.py            # schema-driven dry-run model — free, deterministic
│   │   ├── debug.py           # checkpointed driver: pause / resume / branch
│   │   └── graph.py           # static topology introspection for the Graph view
│   │
│   ├── tool_templates/        # reviewed connectors, copied verbatim into projects
│   │   ├── catalog.json       # the registry: ids, env, tool signatures
│   │   ├── gmail.py  slack.py  postgres.py
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
│   │   └── mcp/mockServer.ts  # a fixture MCP server, so all of it is testable for free
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

A token entered in the UI is written to `runtime/.env` under a derived name
(`JAROKU_MCP_<SERVER>_TOKEN`), and that is the last time anything holds it. From then on it is
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

**OAuth is not supported.** A server that answers a handshake with an OAuth challenge says so
explicitly rather than failing as a generic "unauthorized" — otherwise you would go hunting for
a key that does not exist.

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

### Not in this milestone

Deployed agents do **not** stream trace events back yet. That is the next layer (Weeks 13–14),
and building it now would mean shipping `jaroku_interceptor` inside the image — breaking the one
guarantee the deployed artifact should keep hardest.

---

## The React client

Three resizable columns:

```
┌─────────────┬───────────────────────────┬────────────────────────────┐
│  Sidebar    │  Build pane               │  Right panel               │
│             │                           │                            │
│  agents     │  ONE composer             │  [Graph][Trace][Evals][MCP]│
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
| `mcp` | MCP registry snapshots, discovery progress, and the first-use confirmation request |
| `deploy` | Deployment snapshots, the pre-deploy plan, live stage transitions, scrubbed build-log lines, and the one-shot serve token |
| `session` | The only channel about the CONNECTION rather than the work: `expiring`, `expired`, `revoked`, `workspace_changed`, `role_changed` |
| `members` | Who is in the workspace, who has been invited, and the one-shot invite link |
| `providers` | Which provider keys are set (`configured: true/false`, by name) and test results |
| `reply` | Streaming "explain" answers |
| `log` | stderr lines and parse errors, for visibility |

**Client → server**

`run` · `loadRun` · `listAgents` · `loadAgentFiles` · `loadAgentGraph` · `planAgent` ·
`discardPlan` · `generate` · `edit` · `applyEdit` · `undoEdit` · `discardEdit` · `pauseRun` ·
`resumeRun` · `branchRun` · `explain` · and the eval set: `createDataset` · `renameDataset` ·
`deleteDataset` · `listDatasets` · `loadDataset` · `addExample` · `updateExample` ·
`deleteExample` · `promoteTestInput` · `startEval` · `cancelEval` · `estimateEval` ·
`loadEvalResults` · `listEvals` · `loadRubric` · `saveRubric` · and the MCP set:
`listMcpServers` · `addMcpServer` · `removeMcpServer` · `rediscoverMcpServer` ·
`setMcpServerAuth` · `setMcpToolImpact` · `resolveMcpConfirm` · and the provider set:
`listProviders` · `setProviderKey` · `testProviderKey` · and the deploy set: `listDeployments` · `planDeploy` ·
`deploy` · `cancelDeploy` · `forgetDeployment` · `loadDeployLogs` · `setRailwayToken` ·
`testRailwayToken` · and the membership set: `listMembers` · `inviteMember` · `revokeInvite` ·
`setMemberRole` · `removeMember`

Accepting an invitation is deliberately **not** a command: the accepter is not a member yet, so
there is no socket scoped to the workspace they are joining. It is `POST /v1/invites/accept`.

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
| `JAROKU_DEV_WORKSPACE` | the local workspace | Which workspace the server acts in **on its own behalf** — the startup run, the sweepers, the restart reconciliations. Announced at boot |
| `JAROKU_AUTH_ISSUER` | — | Your OIDC issuer. **Unset runs the local issuer**, which refuses `NODE_ENV=production` |
| `JAROKU_AUTH_AUDIENCE` | `jaroku` | The `aud` a token must carry |
| `JAROKU_AUTH_JWKS_URL` | `<issuer>/.well-known/jwks.json` | Where the signing keys live |
| `JAROKU_ALLOWED_ORIGINS` | the local dev origins | Comma-separated origin allowlist for the WebSocket upgrade. **Required in production** — see [why the origin check is not optional](#why-the-origin-check-is-not-optional) |
| `JAROKU_DEV_AUTH` | — | `1` opens sockets with **no credential at all**, in the dev workspace. Refuses `NODE_ENV=production` |
| `JAROKU_DEV_AUTH_KEY` | `server/.devauth.json` | Where the local issuer's signing key is kept (`chmod 600`, gitignored) |
| `JAROKU_NO_AUTORUN` | — | Set to `1` to skip the startup run |
| `JAROKU_EVAL_CONCURRENCY` | `4` | Pool slots. Slot 0 is always the interactive run |
| `JAROKU_LIMIT_<PROVIDER>` | `16` (fake) / `2` (real) | Per-provider concurrent-run cap, e.g. `JAROKU_LIMIT_ANTHROPIC=4` |
| `JAROKU_JOB_TIMEOUT_MS` | `180000` | Per-eval-job wall-clock deadline |
| `JAROKU_JOB_ATTEMPTS` | `3` | Total attempts per job, including the first |
| `JAROKU_RETRY_BASE_MS` | `2000` | Base for exponential retry backoff |
| `JAROKU_MCP_TIMEOUT_MS` | `10000` | Per-request ceiling during MCP discovery |
| `JAROKU_MCP_DISCOVERY_MS` | `30000` | Whole-discovery ceiling, so slow pages can't stall forever |
| `RAILWAY_API_TOKEN` | — | Your Railway **account** token. Written by the deploy panel, never by hand |
| `JAROKU_RAILWAY_API` | `https://backboard.railway.com/graphql/v2` | Railway's GraphQL endpoint |
| `JAROKU_RAILWAY_CLI` | `railway` | The CLI binary used to upload a project |
| `JAROKU_RAILWAY_TIMEOUT_MS` | `20000` | Per-request ceiling on a Railway API call |
| `JAROKU_DEPLOY_TIMEOUT_MS` | `900000` | Wall-clock ceiling on one upload + build |
| `JAROKU_DEPLOY_FOLLOW_MS` | `600000` | How long to keep watching a build before saying so |

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
| `JAROKU_CONTROL_DIR` | Where the MCP bridge exchanges confirmation approvals. Its **absence** is how a copied-out project knows nobody is watching |
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
npm run test:pool        # slot reservation, attribution, deadlines
npm run test:aggregate   # cost from steps, unknown vs free, partial-pricing flags
npm run test:retry       # transient vs deterministic failure classification
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
```

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
npm run test:reset       # NO store retains a row across a workspace switch
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
  reconciliations — because work nobody triggered still needs a scope.
- **The filesystem is still one namespace.** Agent slugs are unique per workspace in the *table*,
  but two workspaces with a `support_bot` would still collide on `runtime/agents/support_bot/`.
  Session 3's object store fixes that with keys built from the workspace id and the agent uuid.
- **Agent files and the graph are still read from a global directory.** Those two relay reads take
  a context and ignore it, so that when the storage moves the signature does not.
- **Cross-workspace maintenance reads run unscoped** and say so in their signatures — the restart
  reconciliations for interrupted evals and deploys, and the startup checkpoint sweep. Under RLS
  they need an administrative connection rather than the app role.

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
| Invite | owner | The link is shown **once** — only a hash is stored, and there is no email sender here |
| Accept | the invitee | `POST /v1/invites/accept`, not a socket command: the accepter is not a member yet, so there is no socket scoped to the workspace they are joining |
| Change role | owner | Refuses to demote the **last** owner |
| Remove | owner | Refuses to remove the last owner. Kills their outstanding tickets, and their open sockets close on the next re-check |

Every one of them writes an `audit_log` row **inside the transaction that makes the change**, so
there is no path that alters membership without a record of who did it.

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

## Where data lives

| Path | What | Tracked? |
|---|---|---|
| browser `localStorage` | `jaroku.token` (the bearer token), `jaroku.workspace` (the last workspace), `jaroku.onboarding.<user id>` (where a person is up to in the first-run flow — *whether* they finished it is `users.onboarded_at`, on the server), `jaroku.input.<workspace id>.<agent>` (last test input). Both of the last two are keyed so a browser two people share never hands one's data to the other. Deleting the first two signs you out; the rest lose nothing that matters | n/a |
| `server/.devauth.json` | The **local issuer's** RS256 signing key, `chmod 600`. Only exists when no `JAROKU_AUTH_ISSUER` is set | No |
| `server/jaroku.db` | The local database. Identity (`users`, `workspaces`, `workspace_members`, `workspace_invites`, `ws_tickets`, `audit_log`) + agents (`agents`, `agent_versions`) + traces (`runs`, `steps`) + eval control plane (`datasets`, `dataset_examples`, `rubrics`, `eval_runs`, `eval_jobs`, `eval_scores`) + MCP registry (`mcp_servers`, `mcp_tools`) + deploy records (`deployments`, `deployment_logs`). Every one of them carries a `workspace_id` | No |
| Postgres (`JAROKU_PG_URL`) | The same schema, hosted, with RLS. Selected by `JAROKU_DB_DRIVER=postgres`; see [the tenancy model](#the-tenancy-model) | No |
| `runtime/agents/<id>/` | A generated agent project — yours, editable, portable | No (except `example_agent`) |
| `runtime/agents/.staging/` | In-flight generations and edit proposals. Cleared on server start — a proposal interrupted by a shutdown is an orphan | No |
| `runtime/agents/.history/<id>/` | Per-agent version snapshots + `history.json`, powering Undo across reloads | No |
| `runtime/.checkpoints/` | Durable LangGraph checkpoints (`<run_id>.sqlite`) and pause control files | No |
| `runtime/.env` | Provider, connector and MCP server keys | No |
| `runtime/agents/<id>/mcp_tools.json` | An agent's MCP grant: servers, tools, schemas, impact. Host-written, read-only to edits | No (with the project) |
| `runtime/agents/<id>/{serve.py,Dockerfile,.dockerignore,pyproject.toml}` | Deploy tooling. Host-written, read-only to edits, regenerated on every deploy | No (with the project) |

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
- **An MCP server is never trusted.** Its tool list is a claim, its `readOnlyHint` is ignored,
  its output is capped and stripped before it reaches a model or a trace, and a tool it did
  not appear in the agent's manifest for cannot be called at all. High-impact calls stop for
  an explicit confirmation, and timing out denies.
- **MCP credentials are stored as env var names.** The value lives only in `runtime/.env`,
  is read at the moment of use, and never reaches the database, a generated project, a log
  line, or the browser.
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
  door — see [authentication and membership](#authentication-and-membership). What it does
  *not* yet have is the rest of the hosted posture: rate limits, security headers, a WAF and
  abuse detection are Session 8, and the sandbox that stops model-written Python running on the
  control plane is Session 4. **So it still binds localhost and should still not be put on a
  network.** That sentence used to be true because there was no authentication; it is now true
  because authentication is not the whole of it.
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

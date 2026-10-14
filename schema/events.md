# Jaroku Event Schema (v1 — FROZEN)

This is the product's foundational primitive (doc §5.2). The trace pipeline, the timeline UI,
the eval aggregation, and production observability all read this shape. **Do not change field
names or types casually** — schema versioning comes later (doc §8).

`schema_version: 1`

---

## Transport envelope

The Python interceptor emits **newline-delimited JSON** to **stdout** — exactly one JSON
object per line, each object one "event". stdout carries events *only*; all logging goes to
stderr so the stream never gets polluted.

Every line is one of three `kind`s:

```jsonc
{ "kind": "run_start", "schema_version": 1, "run": Run }
{ "kind": "step",      "schema_version": 1, "step": Step }
{ "kind": "run_end",   "schema_version": 1, "run": Run }
```

- `run_start` — emitted once, first, when a run begins. Carries the Run with `status: "running"`.
- `step` — emitted once per captured step, in `seq` order.
- `run_end` — emitted once, last. Carries the final Run (`status: "completed" | "error"`,
  `ended_at`, aggregated `cost` + `tokens`).

Ordering guarantee within a run: `run_start` → `step`(seq 0..N in ascending order) → `run_end`.

---

## Run

```jsonc
Run {
  "id":         string,   // uuid4, stable for the whole run
  "agent_id":   string,   // identifier of the agent definition (e.g. "test_agent")
  "provider":   string,   // "anthropic" | "openai" | ...
  "model":      string,   // e.g. "claude-opus-4-8"
  "status":     "running" | "completed" | "error",
  "started_at": string,   // ISO-8601 UTC
  "ended_at":   string | null,  // ISO-8601 UTC, null until run_end
  "cost":       number,   // USD, aggregated across steps; 0 until known
  "tokens":     number,   // total tokens across steps; 0 until known
  "error":      string | null   // top-level failure message if the run itself errored
}
```

## Step

```jsonc
Step {
  "id":            string,   // uuid4, unique per step
  "run_id":        string,   // FK -> Run.id
  "seq":           number,   // monotonically increasing per run, starts at 0
  "type":          "llm_call" | "tool_call" | "state_update" | "router",
  "name":          string,   // node/tool/llm name (e.g. "call_model", "calculator")
  "input":         json,     // step input (prompt messages, tool args, ...)
  "output":        json,     // step output (llm response, tool return, ...)
  "state_before":  json | null,  // agent state snapshot before this step
  "state_after":   json | null,  // agent state snapshot after this step
  "tokens":        number | null,  // tokens for this step (llm_call only, else null)
  "cost":          number | null,  // USD for this step (llm_call only, else null)
  "latency_ms":    number,   // wall-clock duration of the step
  "error":         string | null,  // stack/message if this step failed
  "parent_step_id": string | null, // FK -> Step.id, for nested steps (tool inside a node)
  "started_at":    string,   // ISO-8601 UTC
  "input_tokens":  number | null,  // OPTIONAL — `tokens` the call read, cached included (llm_call only)
  "output_tokens": number | null   // OPTIONAL — `tokens` the call wrote; the two add up to `tokens`
}
```

`input_tokens` / `output_tokens` were added on 2026-10-14 for the trace's prompt/completion bar. They
are **additive and optional**: `tokens` keeps its meaning, an older interceptor sends neither, and a
consumer treats an absent or null split as "not recorded" — never as zero. `schema_version` stays 1,
because nothing a v1 reader relies on changed.

### Step `type` semantics
- `llm_call` — a model invocation. `tokens`/`cost` populated; `input` = messages, `output` = response text/tool-calls.
- `tool_call` — a tool/function invocation. `input` = args, `output` = return value.
- `state_update` — a graph node mutated agent state. `state_before`/`state_after` populated.
- `router` — a conditional-edge / routing decision. `output` = chosen branch.

### Ordering & parenting
- `seq` is assigned by the interceptor in emission order, monotonic per `run_id`, starting at 0.
  Consumers (SQLite, UI) sort by `seq`, never by arrival time.
- `parent_step_id` links nested execution (e.g. a `tool_call` invoked within an LLM/agent node)
  using LangChain's parent run-id chain. Top-level steps have `parent_step_id: null`.

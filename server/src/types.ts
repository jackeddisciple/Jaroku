// Mirrors schema/events.md (v1). Keep in sync with runtime/jaroku_interceptor/schema.py.

export const SCHEMA_VERSION = 1;

export type RunStatus = "running" | "completed" | "error";
export type StepType = "llm_call" | "tool_call" | "state_update" | "router";

export interface Run {
  id: string;
  agent_id: string;
  provider: string;
  model: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  cost: number;
  tokens: number;
  error: string | null;
}

export interface Step {
  id: string;
  run_id: string;
  seq: number;
  type: StepType;
  name: string;
  input: unknown;
  output: unknown;
  state_before: unknown;
  state_after: unknown;
  tokens: number | null;
  cost: number | null;
  latency_ms: number;
  error: string | null;
  parent_step_id: string | null;
  started_at: string;
}

export type TraceEvent =
  | { kind: "run_start"; schema_version: number; run: Run }
  | { kind: "step"; schema_version: number; step: Step }
  | { kind: "run_end"; schema_version: number; run: Run };

/**
 * Does this actually have the shape the schema names?
 *
 * IT USED TO CHECK ONLY `kind`, which meant `{"kind":"step"}` with no `step` at all reached
 * `insertStep` and threw into a catch that only logs — and every field of a real one was whatever a
 * sandbox chose to send. The ids are the part that matters most: `store.insertStep` binds
 * `step.run_id` directly and `upsertRun`'s ON CONFLICT is scoped only by workspace, so an id from
 * the BODY decides which run a row belongs to. This is the shape half; the attribution half is at
 * the ingest boundary, where the body's run id is reconciled against the slot that produced it.
 */
export function isTraceEvent(v: unknown): v is TraceEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as { kind?: unknown; run?: unknown; step?: unknown };
  // THE IDS, AND NOT THE WHOLE SCHEMA. What this has to establish is that the event carries the
  // fields the ingest path READS — the ones that decide which row is written and which run it
  // belongs to. Insisting on every column would make this a second schema definition beside
  // events.md, and the one that rejected a legitimate event would be this one.
  if (e.kind === "run_start" || e.kind === "run_end") {
    const run = e.run as Partial<Run> | undefined;
    return typeof run?.id === "string" && run.id.length > 0;
  }
  if (e.kind === "step") {
    const step = e.step as Partial<Step> | undefined;
    return (
      typeof step?.id === "string" && step.id.length > 0 &&
      typeof step.run_id === "string" && step.run_id.length > 0
    );
  }
  return false;
}

/**
 * The run id this event claims to be about.
 *
 * Named rather than inlined because two ingest paths ask it — the local pool and the hosted
 * control plane — and "which id does this event carry" must have one answer, not two spellings
 * that could drift apart.
 */
export function runIdOf(event: TraceEvent): string {
  return event.kind === "step" ? event.step.run_id : event.run.id;
}

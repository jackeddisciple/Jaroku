// What gets metered, named — same reasoning as queue/jobs.ts naming what the queue moves
// before anything moved it. A closed set in one module, so "which kind is this" is a decision
// somebody makes while looking at every other kind, rather than a string typed at a call site.
//
// THE SPLIT THAT MATTERS IS NOT llm-vs-not. It is WHOSE MODEL CALL IT WAS:
//
//   `llm.provider` — the agent's own calls, made inside a run, priced from its trace steps.
//   Under BYOK this is the user's own key and their own bill; we meter it because they want
//   the dashboard, and we do not charge for it.
//
//   `llm.judge` — the eval judge. Metered separately and never folded into a provider's agent
//   cost, exactly as `eval_runs.judge_cost_usd` already keeps it separate: a comparison that
//   charged the judge's opinion to the provider being judged would make an expensive judge
//   look like an expensive model.
//
//   `llm.generation` / `llm.plan` / `llm.edit` / `llm.explain` — the platform thinking on a
//   workspace's behalf. These are Anthropic-only and, under BYOK, are the calls the platform
//   genuinely pays for unless the workspace opts its own key in.
//
//   `sandbox.seconds` / `storage.bytes` — infrastructure. What is billable under BYOK, where
//   token spend is not. Kept as separate kinds from day one rather than added later, because
//   "meter everything, bill some of it" is a distinction that cannot be retrofitted onto rows
//   that never recorded which was which.

/** Every kind of thing a `usage_events` row can describe. */
export const USAGE_KINDS = [
  "llm.provider",
  "llm.judge",
  "llm.generation",
  "llm.plan",
  "llm.edit",
  "llm.explain",
  "sandbox.seconds",
  "storage.bytes",
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

export function isUsageKind(v: unknown): v is UsageKind {
  return typeof v === "string" && (USAGE_KINDS as readonly string[]).includes(v);
}

/** The kinds that are model calls. The dashboard's token columns mean nothing for the rest. */
export const LLM_KINDS: readonly UsageKind[] = USAGE_KINDS.filter((k) => k.startsWith("llm."));

/**
 * A deterministic name for one metered event.
 *
 * The same idea as `buildIdempotencyKey` in queue/jobs.ts, and needed for a stricter reason.
 * Trace ingestion is at-least-once by design — a worker that dies between writing steps and
 * acknowledging its batch will redeliver them — and Session 4 made that safe for the trace by
 * upserting on the step's own id. Billing has no such id to lean on, because a usage row is
 * DERIVED from a step rather than sent as one. So the derivation has to name itself, from the
 * parts that identify the thing being metered and nothing else.
 *
 * `parts` must therefore never include anything that varies between two deliveries of the same
 * event — no timestamp, no attempt counter that is not itself part of what was billed, no uuid
 * minted at the call site. A key that varies is not an idempotency key; it is a second charge.
 */
export function usageKey(kind: UsageKind, ...parts: string[]): string {
  return [kind, ...parts].join(":");
}

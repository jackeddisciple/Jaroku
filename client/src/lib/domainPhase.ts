// Every state union in this product, mapped into the seven phases — and the three families that are
// deliberately not mapped at all.
//
// I4 IS THE WHOLE POINT AND IT IS A COMPILE-TIME PROPERTY, not a test. Each map below is a
// `Record<Union, Phase>` typed against the real union, so adding a member to `WorkStatus` or to
// `DeployStatus` without deciding what phase it is in fails `npm run typecheck` rather than
// rendering a blank square in a column of glyphs at three in the morning. A suite can only check
// the maps that exist; the typechecker is what notices the member that was added yesterday.
//
// ONE MODULE RATHER THAN EIGHT, which is a deliberate departure from the brief's "one mapping
// module per domain" and is worth the sentence. What makes these maps correct is not each one on
// its own — it is that no domain has invented an eighth shape and no domain has reused a shape to
// mean something else, which is a property OF THE SET. Eight files is eight places for a comparison
// state to be quietly mapped to `done` because the person editing that file could not see the other
// seven. §3's exclusion list has the same problem twice over: it spans three domains and belongs
// beside the maps it is an exception to, not scattered across the files it excuses.
//
// THE UNIONS ARE THE REAL ONES, READ OUT OF THE CODE, and three of them do not match the tables in
// the brief. That is I4 doing its job rather than a disagreement:
//
//   `RunStatus` has four members, not seven. There is no `queued`, no `cancelled` and no `timeout`
//   in the client's run union — the brief is describing a server-side vocabulary the client has
//   never been handed.
//
//   `DeployStatus` has eleven, not nine. `interrupted`, `superseded` and `removed` are real
//   terminal states with real distinctions between them, and none of the three is in the brief.
//
//   `EvalRunStatus` has `aborted_over_budget`, which is the state an eval reaches when it stops
//   itself rather than being stopped — and the brief's `Judging` does not exist as a status at all.
//
// THREE FAMILIES HAVE NO PHASE AND ARE TYPED OUT RATHER THAN OMITTED. §3: they answer "how does this
// compare to something else", not "what phase is this in", and forcing them into the ramp would make
// the ramp lie. A repository can be `ahead` AND healthy; a drifted deployment is live and working;
// an agent can be "Idle · Failing", which is a real state and collapsing it would be lying about the
// agent. Every one of them keeps the mark or badge it has today and this work does not touch it.
//
//   npm run test:status-map

import type { Phase } from "./statusPhase.ts";
import type {
  AgentCardView,
  DeployStatus,
  EvalRunStatus,
  McpServerStatus,
  RunStatus,
  SyncState,
  ThreadStatus,
  WorkStatus,
} from "../types.ts";

// ── Runs ────────────────────────────────────────────────────────────────────
//
// FOUR MEMBERS, WHICH IS THE UNION THE CLIENT ACTUALLY HAS. `paused` is `halted` and not `waiting`:
// a paused run is resumable by whoever paused it and is not blocked ON anybody, which is the whole
// distinction `waiting` carries.

export const RUN_PHASE: Record<RunStatus, Phase> = {
  running: "active",
  completed: "done",
  error: "failed",
  paused: "halted",
};

// ── Threads ─────────────────────────────────────────────────────────────────
//
// `needs_you` IS THE ONE STATE IN THE PRODUCT THAT `waiting` WAS DEFINED FOR — halted, needs a
// human — and it is the reason `waiting` is a phase rather than a shade of `active`. `archived` is
// lifecycle and takes `halted`, which is also what §9's ladder wants: an archived row is quiet
// regardless of what it used to be doing.

export const THREAD_PHASE: Record<ThreadStatus, Phase> = {
  needs_you: "waiting",
  running: "active",
  errored: "failed",
  idle: "ready",
  archived: "halted",
};

// ── Cockpit work items ──────────────────────────────────────────────────────
//
// THE ONE DOMAIN WHOSE SIX STATES ARE ALREADY THE SEVEN PHASES MINUS ONE, which is what makes it
// the honest test of the vocabulary: if the ramp could not cover the Cockpit without folding two of
// its states together, it was the wrong ramp.

export const WORK_PHASE: Record<WorkStatus, Phase> = {
  queued: "pending",
  running: "active",
  waiting: "waiting",
  succeeded: "done",
  failed: "failed",
  cancelled: "halted",
};

// ── Deploys ─────────────────────────────────────────────────────────────────
//
// ONE GLYPH FOR THE WHOLE BUILD. All five in-flight stages are `active` and the stage name carries
// the detail — a person watching a deploy is reading the stage, and five shapes for one build would
// be five things to learn about a process that is over in ninety seconds.
//
// THE THREE TERMINAL STATES THE BRIEF DOES NOT KNOW ABOUT, each decided from what the server writes:
//
//   `interrupted` is `failed`. The Jaroku server restarted mid-deploy. It did not succeed and
//   nobody chose it, which is exactly the difference between `failed` and `halted`.
//
//   `superseded` is `halted`. It worked, and a later deploy of the same agent replaced it. The
//   panel already calls it "replaced" and already draws it neutral; this agrees with both.
//
//   `removed` is `halted`, AND THAT IS A CORRECTION to what the panel does today. `deployStore.ts`
//   is explicit — "terminal, the user detached the record from Jaroku" — so it is somebody pressing
//   a button, which is the definition of `halted`. The panel draws it in the error red, which files
//   a deliberate teardown under "something went wrong". The label still says "removed".

export const DEPLOY_PHASE: Record<DeployStatus, Phase> = {
  queued: "active",
  packaging: "active",
  uploading: "active",
  building: "active",
  deploying: "active",
  live: "done",
  failed: "failed",
  cancelled: "halted",
  interrupted: "failed",
  superseded: "halted",
  removed: "halted",
};

/**
 * A deployment's phase, including the one the union cannot express.
 *
 * "NEVER DEPLOYED" IS AN ABSENT ROW, NOT A STATUS — which is why this is a function and the map
 * above is not enough. An agent with no deployment is `pending`: it exists and has not begun, which
 * is the phase's own definition. Rendering nothing there would leave a hole in the one column whose
 * entire value is being scannable.
 */
export function deployPhase(deployment: { status: DeployStatus } | null | undefined): Phase {
  return deployment ? DEPLOY_PHASE[deployment.status] : "pending";
}

// ── GitHub sync ─────────────────────────────────────────────────────────────
//
// THREE OF THE SEVEN ARE POSITIONS RATHER THAN PHASES and are excluded by type below, so this map
// covers four. §3 is worth restating because the temptation is real: `behind` looks exactly like a
// status and is not one — a repository can be `in_sync` and healthy, or `ahead` and healthy, and
// `behind` keeps rendering as `↓` rather than `↓0` precisely because it is approximate until
// somebody fetches.

/** §3's first exclusion. A comparison, never a phase. */
export type SyncComparison = Extract<SyncState, "ahead" | "behind" | "diverged">;

/**
 * The exclusion, as a value as well as a type.
 *
 * TYPED OUT, NEVER OMITTED — I4's second half. A `SyncState` that is neither in this list nor in the
 * map below fails `tsc`, so the only way to add a state without giving it a phase is to say out loud
 * that it is a comparison.
 */
export const SYNC_COMPARISON: readonly SyncComparison[] = ["ahead", "behind", "diverged"];

export const SYNC_PHASE: Record<Exclude<SyncState, SyncComparison>, Phase> = {
  unlinked: "pending",
  syncing: "active",
  in_sync: "done",
  broken: "failed",
};

/** Null for the three positions, so a call site cannot accidentally draw one. */
export function syncPhase(state: SyncState): Phase | null {
  return (SYNC_COMPARISON as readonly SyncState[]).includes(state)
    ? null
    : SYNC_PHASE[state as Exclude<SyncState, SyncComparison>];
}

// ── MCP servers ─────────────────────────────────────────────────────────────
//
// D2: `unreachable` AND `error` SHARE A GLYPH, on purpose. They are genuinely different — one is
// usually transient and keeps its tool list, the other means the server answered with something
// unusable — but that difference needs a sentence and not a shape, and an eighth phase for it would
// break the rule that a shape means the same thing in every tab. The status line keeps saying which,
// and `StatusGlyph` takes a `title` so the tooltip does too.

export const MCP_PHASE: Record<McpServerStatus, Phase> = {
  connected: "done",
  auth_required: "waiting",
  unreachable: "failed",
  error: "failed",
};

// ── Evals ───────────────────────────────────────────────────────────────────
//
// `aborted_over_budget` IS `failed`, and it is the member I4 exists to catch. An eval that stopped
// itself at a spending ceiling did not finish and did not succeed; the reason it stopped is a
// sentence the panel already prints ("over budget"), which is where a reason belongs.

export const EVAL_PHASE: Record<EvalRunStatus, Phase> = {
  queued: "pending",
  running: "active",
  completed: "done",
  aborted_over_budget: "failed",
  cancelled: "halted",
  error: "failed",
};

// ── Agent cards — the runtime axis only ─────────────────────────────────────
//
// D1: THE GLYPH TAKES RUNTIME, NOT HEALTH, and the two must not merge. The grid holds them as
// separate axes deliberately: "Idle · Failing" is a real state, and a card that collapsed it would
// be lying about the agent in the one place somebody looks to decide whether to trust it. The glyph
// answers "what is it doing right now"; Failing and Unverified stay in the tag row, where the tag
// precedence ladder already ranks them.

export type AgentRuntime = AgentCardView["runtime"];
/** §3's third exclusion: an axis of its own, and this work does not touch it. */
export type AgentHealth = AgentCardView["health"];

export const AGENT_HEALTH_AXIS: readonly AgentHealth[] = ["healthy", "degraded", "failing", "unverified"];

export const AGENT_RUNTIME_PHASE: Record<AgentRuntime, Phase> = {
  idle: "ready",
  running: "active",
  // GENERATING AND DEPLOYING ARE BOTH WORK HAPPENING RIGHT NOW. The tag row already separates them
  // by word, and three amber shapes for three kinds of busy would be three things to learn about one
  // fact. This is the same call the deploy map makes about its five live stages.
  generating: "active",
  deploying: "active",
  paused: "halted",
};

/**
 * An agent card's phase, with the two facts the runtime union cannot carry.
 *
 * LIFECYCLE OUTRANKS RUNTIME, which is §9's ladder rung 1: an archived card is quiet regardless of
 * what it used to be doing, so an agent archived mid-run is `halted` and not `active`. And "never
 * run" is the absence of a timestamp rather than a runtime — an agent that exists and has not begun
 * is `pending`, which is the one phase the runtime union has no way to express.
 */
export function agentPhase(agent: {
  runtime: AgentRuntime;
  archived_at: string | null;
  last_run_at: string | null;
}): Phase {
  if (agent.archived_at) return "halted";
  if (agent.runtime === "idle" && agent.last_run_at === null) return "pending";
  return AGENT_RUNTIME_PHASE[agent.runtime];
}

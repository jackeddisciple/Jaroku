// What an agent's card says about it, derived from facts the grid aggregate already read.
//
// PURE, AND IN ITS OWN MODULE FOR THE REASON `threadStatus.ts` IS. Every interesting decision on the
// Agents grid — is this healthy, is it busy, is it drifting, is a credential missing — is a rule that
// looks obviously right in a screenshot and is wrong in the case nobody had that day. A rule that
// lives inside a SELECT can only be exercised by standing a database up; a rule that lives inside a
// component can only be exercised by rendering one. So the queries gather, this decides, and
// `test:agent-health` drives it with rows.
//
// HEALTH IS TWO AXES FOLDED INTO ONE ANSWER, AND RUNTIME IS NOT ONE OF THEM. §5.4 is explicit that
// Runtime and Health are separate families and must never collapse — "Idle · Failing" is a valid and
// important state, and a card that hides it is lying about the agent. So `healthOf` never looks at
// whether anything is running, and `runtimeOf` never looks at whether anything failed.

/** How a run ended, as the sparkline draws it and the error rate counts it. */
export type RunOutcome = "ok" | "error" | "running" | "paused";

/** §5.4's Health family. Four, and a fifth would be a colour this product does not have. */
export type AgentHealth = "healthy" | "degraded" | "failing" | "unverified";

/** §5.4's Runtime family. One per agent, resolved before the tag row is assembled. */
export type AgentRuntime = "idle" | "running" | "generating" | "deploying" | "paused";

/** §5.2's footer: how busy this agent has been, bucketed from its 7-day run count. */
export type ActivityLevel = "quiet" | "steady" | "high";

/**
 * How many of an agent's recent runs the card looks at.
 *
 * §5.5's sparkline says "the last ~20 run outcomes", and the error rate behind the health tag reads
 * the same window rather than a second one. Two windows would let the sparkline show four red bars
 * beside a Healthy tag, which is the one thing a sparkline beside a tag must never do.
 */
export const OUTCOME_WINDOW = 20;

/**
 * Where "some runs fail" becomes "this agent is failing".
 *
 * A HALF, and the number is a judgement rather than a derivation — the same kind of constant, argued
 * the same way, as the thread list's `HIGH_COST_SHARE`. Below it an agent has a problem worth a
 * colour and above it the agent IS the problem: an agent that fails one call in three is degraded and
 * usable, one that fails one in two is not something you would put a customer in front of.
 *
 * It is deliberately not settable. §5.4 asks for a tag row somebody can scan across forty agents, and
 * a threshold each workspace tuned would make two workspaces' grids incomparable.
 */
export const FAILING_ERROR_RATE = 0.5;

/**
 * Where Quiet becomes Steady, and Steady becomes High, over seven days.
 *
 * Bucketed rather than shown as a count, because §5.2 puts this in the card FOOTER beside a thread
 * count — and two bare numbers side by side invite a comparison between two things that are not
 * comparable. "Steady" answers the question the footer is actually asking, which is whether this
 * agent is in use.
 */
export const ACTIVITY_BUCKETS = { steady: 5, high: 40 } as const;

/** Everything `healthOf` reads. Gathered by the aggregate; nothing here queries. */
export interface HealthFacts {
  /** The last ~20 outcomes, oldest first — the order the sparkline draws them in. */
  outcomes: readonly RunOutcome[];
  /**
   * What made the agent's CURRENT version.
   *
   * WHY THIS IS THE VALIDATOR STATUS, and why it is not a stored verdict. §7.5 folds "the validator
   * status of the current version" into health, and this schema stores no such column — running the
   * validator here would mean fetching a version out of the object store and starting a Python check
   * per agent per grid load, which is the opposite of one query.
   *
   * It does not need to. The validator is the gate on PUBLISHING: a generation or an edit that it
   * refuses is discarded and never becomes a version, so every row whose `source` is `generation`,
   * `edit` or `deploy` passed it by construction. What did NOT pass it is `import` — the backfill and
   * the hand-dropped directory, published as-is because it already existed — and a version nobody
   * has ever checked is exactly what §5.4's `Unverified` means.
   *
   * Null is an agent with no version row at all, which is the same claim: nothing has been validated.
   */
  versionSource: "generation" | "edit" | "import" | "deploy" | null;
}

/**
 * Health, from the validator's verdict on what is live and the outcomes of what has run.
 *
 * BOTH, BECAUSE EITHER ALONE LIES (§7.5). The validator alone would call an agent healthy while every
 * one of its last ten runs failed — the code is well-formed and the world is not. The error rate alone
 * would call a hand-dropped project healthy for never having been run, which is a different lie in the
 * same direction: it says "fine" where the truth is "nobody has checked".
 *
 * UNVERIFIED OUTRANKS A CLEAN RECORD BUT NOT A FAILURE, and that order is the whole of the rule. An
 * unchecked agent whose runs are failing is failing — the failures are evidence, and evidence beats
 * the absence of it. An unchecked agent with no failures is `unverified` rather than `healthy`,
 * because "we have not looked" is not a clean bill of health. `unverified` is grey for the same
 * reason: §5.4 reserves green for good standing, and this is not a claim of good standing.
 */
export function healthOf(facts: HealthFacts): AgentHealth {
  const settled = facts.outcomes.filter((o) => o === "ok" || o === "error");
  const errors = settled.filter((o) => o === "error").length;
  const rate = settled.length === 0 ? 0 : errors / settled.length;

  // The most recent settled outcome, which is what "is it failing right now" actually means. An agent
  // whose last four runs failed is failing at a rate of 0.2 over a window of twenty, and calling that
  // degraded would be arithmetic winning an argument against the screen in front of somebody.
  const last = [...settled].pop();

  if (errors > 0 && (last === "error" || rate >= FAILING_ERROR_RATE)) return "failing";
  const unverified = facts.versionSource === null || facts.versionSource === "import";
  if (errors > 0) return "degraded";
  return unverified ? "unverified" : "healthy";
}

/** What §5.2's footer says, from the 7-day run count. */
export function activityOf(runs7d: number): ActivityLevel {
  if (runs7d >= ACTIVITY_BUCKETS.high) return "high";
  if (runs7d >= ACTIVITY_BUCKETS.steady) return "steady";
  return "quiet";
}

/** Everything `runtimeOf` reads. */
export interface RuntimeFacts {
  /** Runs of this agent whose row says `running`. */
  liveRuns: number;
  /** Runs of this agent halted mid-graph — paused by a person, or waiting on a confirmation. */
  pausedRuns: number;
  /** True while a generation or an edit is streaming files for this agent. */
  building: boolean;
  /** True while a deployment of this agent is queued, building or releasing. */
  deploying: boolean;
}

/**
 * §5.4's Runtime family, resolved to exactly one member.
 *
 * ONE PER FAMILY IS A RULE RATHER THAN A CONVENTION (§5.4.2): `Idle` and `Running` can never appear
 * together, so the resolution happens here — once, against every input — rather than in the row that
 * assembles the tags, where "which of these two won" would be a question the JSX answers differently
 * each time somebody adds a case.
 *
 * THE ORDER IS BY WHAT A PERSON WOULD DO NEXT. A deploy in flight is the thing you wait for before
 * touching anything; a generation is the thing you are watching; a run is the ordinary busy state;
 * paused is a run that has stopped and is asking. Idle is the absence of all four and is never a
 * claim that nothing has ever happened — that is Lifecycle's `New`, on a different axis.
 */
export function runtimeOf(facts: RuntimeFacts): AgentRuntime {
  if (facts.deploying) return "deploying";
  if (facts.building) return "generating";
  if (facts.liveRuns > 0) return "running";
  if (facts.pausedRuns > 0) return "paused";
  return "idle";
}

/**
 * Which of an agent's required names have no configured credential behind them (§5.2).
 *
 * NAMES ONLY, AND NEVER A VALUE — not a value, not a prefix, not a length. This list is rendered on a
 * card, put on a clipboard by §5.5's copy-context action, and carried in a snapshot that reaches every
 * socket in the workspace; the same redaction discipline that governs deploy logs governs it, and the
 * cheapest way to keep that true is for the value never to be in the shape at all.
 *
 * `configured` IS THE TEST, NOT EXISTENCE. `secret_refs` holds a row for every name an agent has ever
 * DECLARED, with a `configured` flag that is false until a value actually landed in the vault — so a
 * membership test against the table would report every declared credential as present and the warning
 * line, which §5.2 calls the single most important line on the card, would never appear.
 *
 * The comparison is exact and case-sensitive, because an environment variable name is. `AIRTABLE_KEY`
 * and `airtable_key` are two different names to every process that will read one, and quietly
 * matching them here would mean a card saying a credential is configured while the run that needs it
 * fails on a missing variable.
 */
export function missingCredentials(
  requiredEnv: readonly string[],
  configuredNames: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of requiredEnv) {
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    if (!configuredNames.has(name)) out.push(name);
  }
  return out.sort();
}

/** What is live against what is current. Null when there is nothing to say. */
export interface VersionDrift {
  deployed: number;
  current: number;
}

/**
 * §5.2's drift badge: the deployed version is behind the current one, and by how much.
 *
 * NULL IS THREE DIFFERENT SITUATIONS AND ALL THREE MEAN "DRAW NOTHING", which is why this returns a
 * nullable rather than a boolean beside two numbers:
 *
 *   Nothing is deployed. There is no second version to be behind.
 *
 *   The deploy predates migration 041 and recorded no version. That column is deliberately never
 *   backfilled — a guess there is a confident lie about somebody's production — so the honest badge
 *   for a deploy nobody recorded a version for is no badge.
 *
 *   The deployed version IS the current one, which is the ordinary case and the one the badge exists
 *   to distinguish from the others.
 *
 * A DEPLOYED VERSION AHEAD OF THE CURRENT ONE IS ALSO NOT DRIFT, and it is reachable: an undo moves
 * `current_version` BACKWARDS while the container carries on serving what it was given. That is worth
 * knowing and it is not what `v5 → v9` means — the badge reads left to right as "live, then current",
 * and rendering `v9 → v5` would say the deploy is behind when it is ahead. The Deploy tab shows both
 * numbers plainly; the card says nothing rather than something backwards.
 */
export function driftOf(deployedVersion: number | null, currentVersion: number): VersionDrift | null {
  if (deployedVersion === null) return null;
  if (deployedVersion >= currentVersion) return null;
  return { deployed: deployedVersion, current: currentVersion };
}

/**
 * The two latency figures the Health tab shows, from the durations of settled runs.
 *
 * NEAREST-RANK, NOT INTERPOLATED. The window is at most twenty runs, and an interpolated p95 over
 * twenty samples is a number computed between two real ones — which reads as more precision than
 * twenty samples can carry. Nearest-rank returns a duration that an actual run actually took, which
 * is what somebody reading "p95" against a list of runs expects to be able to find in it.
 *
 * Null for a window with nothing settled in it, never zero: §5.2's rule about `creation_cost` is the
 * same rule, and a p95 of `0 ms` is a claim about speed rather than an admission of ignorance.
 */
export function percentiles(durationsMs: readonly number[]): { p50: number | null; p95: number | null } {
  const sorted = [...durationsMs].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { p50: null, p95: null };
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: at(0.5), p95: at(0.95) };
}

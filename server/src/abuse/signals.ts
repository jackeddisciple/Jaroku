// What abuse looks like here, written down as a table of observations and what each one weighs.
//
// THE THREE THINGS HOSTED AGENT EXECUTION ATTRACTS, per the migration spec, and what each looks
// like from inside this system:
//
//   CRYPTO MINERS want CPU and nothing else. A miner is a run that saturates its sandbox for its
//   whole wall clock and makes no model calls — which is a shape nothing legitimate has, because
//   an agent that never calls a model is an agent that does nothing. This is the single most
//   reliable signal on the list, and it is reliable precisely because the product's own cost
//   model already measures both halves of it.
//
//   PROXY AND SCRAPING FARMS want egress. An agent that fetches is normal; an agent that moves
//   hundreds of megabytes through a sandbox is a residential proxy with extra steps. The egress
//   allowlist already bounds WHERE it can go, which is what makes VOLUME the remaining question.
//
//   SPAM SENDERS want a connector. The Slack connector can post and the Gmail one drafts, so
//   volume through either, at a rate no team produces, is the signal — and it is the one whose
//   false positives hurt most, because a legitimate notification agent is a Slack-posting agent.
//
// SCORES DECAY, AND THAT IS THE DESIGN RATHER THAN A REFINEMENT. A workspace that tripped four
// signals during one bad afternoon in March is not the same as one tripping four a week, and a
// cumulative counter cannot tell them apart — it only ever goes up, so every account eventually
// crosses every threshold and the system's answer to "who is abusing us" becomes "the oldest
// customers". Exponential decay with a day-long half-life makes the score mean "recently", which
// is the only thing an enforcement decision should ever be made on.
//
// NOTHING HERE ENFORCES. This module observes and scores; `abuse/enforcement.ts` decides. They
// are separate for the reason the migration's header gives: recording and enforcing as one step
// is how a threshold nobody reviewed starts suspending people.
//
// AND A WEIGHT IS NOT A PROBABILITY. These numbers are a shared vocabulary for "how much does
// this worry us", calibrated so that the interesting combinations cross the thresholds in
// enforcement.ts and the boring ones do not. They are a starting point to be tuned against real
// traffic, and the way to tune them honestly is to run the ladder in `report`-only mode first —
// which is why the first rung of that ladder does nothing but say so.

import { createHmac } from "node:crypto";

export const SIGNAL_KINDS = [
  "sandbox.cpu_without_llm",
  "sandbox.egress_volume",
  "run.rate_spike",
  "signup.velocity",
  "connector.post_volume",
  "rate.limit_tripped",
  "tenancy.cross_denied",
  "payment.disputed",
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export function isSignalKind(v: unknown): v is SignalKind {
  return typeof v === "string" && (SIGNAL_KINDS as readonly string[]).includes(v);
}

export interface SignalDefinition {
  kind: SignalKind;
  /** What this observation contributes to a score, before decay. */
  weight: number;
  /** One sentence, for the incident channel and for the appeal. */
  describe: string;
  /** Whether the actor is a workspace or an address with no workspace yet. */
  actor: "workspace" | "subject";
}

/**
 * The weights, in one table.
 *
 * Calibrated against `LADDER` in enforcement.ts rather than in the abstract: the numbers mean
 * nothing on their own, and the only useful way to read them is "how many of these, how close
 * together, before something happens".
 */
export const SIGNALS: Record<SignalKind, SignalDefinition> = {
  // The clearest one there is. Deliberately heavy: three of these inside a day is a miner, and
  // there is no legitimate agent that burns a sandbox and calls no model.
  "sandbox.cpu_without_llm": {
    kind: "sandbox.cpu_without_llm",
    weight: 25,
    describe: "a run used its sandbox for a long time and made no model calls",
    actor: "workspace",
  },
  "sandbox.egress_volume": {
    kind: "sandbox.egress_volume",
    weight: 15,
    describe: "a run moved far more data than an agent normally does",
    actor: "workspace",
  },
  // Bursty by nature — an eval fan-out is a run-rate spike with a good explanation — so it is
  // light on its own and only means something alongside something else.
  "run.rate_spike": {
    kind: "run.rate_spike",
    weight: 5,
    describe: "runs started far faster than this workspace's own normal rate",
    actor: "workspace",
  },
  // The earliest signal there is, and the only one observed before a workspace exists.
  "signup.velocity": {
    kind: "signup.velocity",
    weight: 20,
    describe: "many accounts created from one address in a short window",
    actor: "subject",
  },
  "connector.post_volume": {
    kind: "connector.post_volume",
    weight: 15,
    describe: "an agent posted through a connector at a volume no team produces",
    actor: "workspace",
  },
  // Tripping a rate limit is not abuse. It is a client with a loop in it, and the limiter has
  // already done its job — so this is nearly weightless and exists to make a PATTERN visible.
  "rate.limit_tripped": {
    kind: "rate.limit_tripped",
    weight: 2,
    describe: "a rate limit refused something, repeatedly",
    actor: "workspace",
  },
  // Heavy, and for a different reason from the rest: this is not resource abuse, it is somebody
  // trying to read another tenant's data. The counter for it is supposed to be zero — see the
  // metric of the same name — and one is worth a human looking.
  "tenancy.cross_denied": {
    kind: "tenancy.cross_denied",
    weight: 30,
    describe: "an attempt to act in a workspace the actor is not a member of",
    actor: "workspace",
  },
  // A chargeback on credit that has already been spent on somebody else's compute.
  "payment.disputed": {
    kind: "payment.disputed",
    weight: 40,
    describe: "a payment for this workspace was disputed after the credit was spent",
    actor: "workspace",
  },
};

/** How long it takes for an observation to count half as much. */
export const HALF_LIFE_MS = 24 * 3_600_000;

/**
 * How long a signal is kept at all.
 *
 * Thirty days: long enough that a weekly pattern is visible and that an appeal has evidence to
 * argue against, short enough that this table is not a permanent dossier on everybody who ever
 * hit a rate limit. The retention sweeper takes them like everything else.
 */
export const SIGNAL_RETENTION_DAYS = 30;

export interface ObservedSignal {
  kind: SignalKind;
  weight: number;
  observedAt: number;
}

/**
 * The current score: every observation, weighted, decayed by its age.
 *
 * Half-life rather than a sliding window, because a window has a cliff — a signal counts fully
 * at 23 hours 59 minutes and not at all a minute later, which makes the score jump for reasons
 * that have nothing to do with what the actor did. Decay is smooth, so a score only ever falls
 * because time passed.
 */
export function score(signals: readonly ObservedSignal[], now = Date.now()): number {
  let total = 0;
  for (const s of signals) {
    const ageMs = Math.max(0, now - s.observedAt);
    total += s.weight * Math.pow(0.5, ageMs / HALF_LIFE_MS);
  }
  return Math.round(total * 100) / 100;
}

// --- the detectors ------------------------------------------------------------------------------
//
// Pure functions over facts the platform already measures, so that "what counts as a miner" is
// one expression somebody can argue with rather than a condition buried in a run's exit handler.

/** What a finished run cost, in the terms the meters already record. */
export interface RunBehaviour {
  runId: string;
  /** Wall-clock seconds the sandbox existed. Already metered as `sandbox.seconds`. */
  sandboxSeconds: number;
  /** How many model calls the trace recorded. Already counted as `llm_call` steps. */
  llmCalls: number;
  /** Bytes out, where the sandbox substrate reports it. Undefined when it does not. */
  egressBytes?: number;
}

/**
 * The floor below which a run is too short to say anything about.
 *
 * A validation import, a graph introspection and a run that failed at startup all take seconds
 * and make no model calls. Without this floor every one of them is a mining signal, which is how
 * a detector ends up flagging the product's own machinery.
 */
export const MINER_MIN_SECONDS = 120;

/** Bytes out past which a run is moving data rather than reading it. */
export const EGRESS_BYTES_THRESHOLD = 256 * 1024 * 1024;

export interface DetectedSignal {
  kind: SignalKind;
  weight: number;
  detail: Record<string, unknown>;
  targetType?: string;
  targetId?: string;
}

/** What a single finished run says about the workspace that ran it. Usually nothing. */
export function signalsFromRun(run: RunBehaviour): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  if (run.sandboxSeconds >= MINER_MIN_SECONDS && run.llmCalls === 0) {
    out.push({
      kind: "sandbox.cpu_without_llm",
      weight: SIGNALS["sandbox.cpu_without_llm"].weight,
      detail: { sandboxSeconds: Math.round(run.sandboxSeconds), llmCalls: 0 },
      targetType: "run",
      targetId: run.runId,
    });
  }
  if ((run.egressBytes ?? 0) >= EGRESS_BYTES_THRESHOLD) {
    out.push({
      kind: "sandbox.egress_volume",
      weight: SIGNALS["sandbox.egress_volume"].weight,
      detail: { egressBytes: run.egressBytes },
      targetType: "run",
      targetId: run.runId,
    });
  }
  return out;
}

/**
 * Whether a burst of runs is a spike, judged against this workspace's own normal.
 *
 * RELATIVE, NOT ABSOLUTE, and that is what makes it usable at all. Twenty runs an hour is
 * nothing for a workspace running evals all day and is remarkable for one that has averaged two
 * a day for a month — an absolute threshold would flag the first constantly and never see the
 * second. `baselinePerHour` comes from the workspace's own history; a workspace with no history
 * has no baseline, and gets the benefit of the doubt rather than an invented one.
 */
export function isRunRateSpike(recentPerHour: number, baselinePerHour: number | null): boolean {
  if (baselinePerHour === null || baselinePerHour <= 0) return false;
  return recentPerHour >= Math.max(20, baselinePerHour * 10);
}

/**
 * The digest an address is recorded under.
 *
 * KEYED, so the table is not a rainbow table of every IP that ever signed up: there are about
 * four billion IPv4 addresses and an unkeyed SHA-256 of one is reversible by anybody with an
 * afternoon. The key is the deployment's, and losing it means losing the ability to correlate
 * old rows with new ones — which is a smaller problem than the table being a list of who was
 * where, and is why it is not derived from anything guessable.
 */
export function subjectDigest(value: string, key: string | Buffer): string {
  return createHmac("sha256", key).update(value.trim().toLowerCase(), "utf8").digest("hex").slice(0, 32);
}

// The tag row on an agent card: agent record in, ordered and trimmed tag list out (§5.4).
//
// A PURE FUNCTION IN ITS OWN MODULE, WHICH THE SPECIFICATION ASKS FOR BY NAME: "Implement the tag row
// as one component driven by a pure function… Do not scatter tag decisions across the card's JSX."
// The reason is the same one `threadGroups.ts` and `threadFilter.ts` exist for — the interesting half
// is an ordering and a trimming rule, and both are exactly what looks right in a screenshot and is
// wrong in the case nobody had that day. This file is that half, and `test:agent-tags` drives it.
//
// THE COLOUR LAW, WHICH IS NOT NEGOTIABLE AND IS ENCODED HERE RATHER THAN LEFT TO THE ROW.
//
//   Blue    informational — New, Forked
//   Amber   runtime activity ONLY — Running, Generating, Deploying
//   Rose    problems — Failing, Creds missing, Over budget
//   Green   good standing — Healthy, Live
//   Grey    inert — Idle, Draft, Archived, Unverified
//
// A WARNING MUST NEVER BE AMBER. v0.2.2 established that amber means running, and the wordmark was
// redrawn specifically because an amber outline read as a warning sign in an app where amber already
// meant something. That rule holds here without exception, which is why `Creds missing` — the single
// most important line on a card — is rose and not amber, and why `Unverified` is grey rather than
// amber despite being the tag most likely to be mistaken for a warning.
//
// TWO RULES KEEP THE ROW FROM BECOMING NOISE, and both are here rather than in the component:
//
//   ONE TAG PER FAMILY, resolved BEFORE assembly. `Idle` and `Running` can never appear together.
//   AT MOST THREE RENDER, then a `+n` chip. Precedence when trimming is
//   Attention > Runtime > Deploy > Health > Lifecycle — an agent that is both failing and new shows
//   `Failing` first, because the problem always outranks the novelty.
//
// RUNTIME AND HEALTH STAY SEPARATE AXES and must never be collapsed into one tag. "Idle · Failing" is
// a valid and important state, and a card that hides it is lying about the agent — so `Idle` is a
// Runtime tag, `Failing` is a Health tag, and nothing here can produce a single tag meaning both.

import { STATUS, TEXT } from "./tokens.ts";

/** The five families, in the precedence order §5.4 gives for trimming. */
export const TAG_FAMILIES = ["attention", "runtime", "deploy", "health", "lifecycle"] as const;
export type TagFamily = (typeof TAG_FAMILIES)[number];

/** The five colours, and nothing else. A sixth meaning is a question, not a hex value. */
export type TagTone = "amber" | "rose" | "green" | "grey";

export interface AgentTag {
  /** Stable within a row, for React keys and for a test that names one. */
  id: string;
  label: string;
  family: TagFamily;
  tone: TagTone;
  /** What the tag means, in one sentence, for the tooltip and the accessible name. */
  title: string;
}

/**
 * The tone → colour join, in one place.
 *
 * BORROWED, NEVER INVENTED. Amber, rose and green are `STATUS.pending`, `STATUS.error` and
 * `STATUS.ok` — the three the whole app already means those things by — and grey is `TEXT.faint`,
 * which is what "inert" already looks like everywhere else.
 *
 * THERE WAS A FIFTH, AND IT HAD TO GO. `blue` carried `Forked` and `New`, and it was the only blue
 * anywhere in the product — so the loudest cool colour on screen was spent on two labels that are
 * not interactive, not a status, and not something anybody acts on. That is the exact collision
 * that makes an accent unusable for selection later: once the eye has learned that blue means "this
 * agent is a week old", it stops reading blue as "this is the row you are in". Blue is now the
 * interaction accent and nothing else claims it.
 *
 * The rule that replaced it: semantic colour only where the tag IS a state somebody acts on —
 * running, failing, live — and grayscale for every tag that merely describes. `Forked` and `New`
 * describe.
 */
export const TAG_COLOR: Record<TagTone, string> = {
  amber: STATUS.pending,
  rose: STATUS.error,
  green: STATUS.ok,
  grey: TEXT.faint,
};

/** Everything the resolver reads. A subset of the card, so a test needs no fixture generator. */
export interface TagInput {
  archived_at: string | null;
  created_at: string;
  current_version: number;
  version_source: "generation" | "edit" | "import" | "deploy" | null;
  runs_7d: number;
  last_run_at: string | null;
  runtime: "idle" | "running" | "generating" | "deploying" | "paused";
  health: "healthy" | "degraded" | "failing" | "unverified";
  missing_env: string[];
  high_impact_tools: number;
  spend_known: boolean;
  deployment: { status: string; url: string | null } | null;
  drift: { deployed: number; current: number } | null;
  /**
   * The slug this agent was copied from, or null.
   *
   * REQUIRED, NOT OPTIONAL, and the difference is what caught this once already. While it was
   * optional, `AgentCardView` simply did not have the field — so every card passed `undefined`, the
   * `Forked` branch below could never be taken, and the whole tag was unreachable code that
   * typechecked. A required field makes a card that cannot answer a compile error.
   */
  forked_from: string | null;
}

/** How new is New. Seven days, which is §5.4's own number. */
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How many tags render before the overflow chip takes over. §5.4's number. */
export const TAG_LIMIT = 3;

/**
 * Every tag that is TRUE of this agent, in precedence order, one per family.
 *
 * UNTRIMMED, because the overflow chip has to be able to reveal the rest — so the trimming is a
 * separate step and this is the full, ordered truth. A caller that wants the row calls `agentTagRow`.
 */
export function agentTags(a: TagInput, now = Date.now()): AgentTag[] {
  const out: AgentTag[] = [];

  // ── Attention, first, because a problem outranks everything else on the card ──────────────
  //
  // ROSE, NEVER AMBER. This is the family the colour law was written for: a credential that is not
  // there turns a run which would have failed into a problem you can see beforehand, and dressing
  // that in the running colour would make it read as progress.
  //
  // ONE ATTENTION TAG, chosen by which is worse. A missing credential stops the agent; a high-impact
  // grant is a thing to know about an agent that works. An agent with both shows the credential.
  if (a.missing_env.length > 0) {
    const n = a.missing_env.length;
    out.push({
      id: "creds-missing",
      label: n === 1 ? "Creds missing" : `${n} creds missing`,
      family: "attention",
      tone: "rose",
      // NAMES, NEVER VALUES — not even a fragment of one. The names are the useful half anyway: they
      // are what somebody has to go and set.
      title: `No credential is configured for ${a.missing_env.join(", ")}`,
    });
  } else if (a.high_impact_tools > 0) {
    out.push({
      id: "high-impact",
      label: "high-impact tools",
      family: "attention",
      tone: "rose",
      title:
        `${a.high_impact_tools} granted MCP tool${a.high_impact_tools === 1 ? "" : "s"} ` +
        "stop and ask before the first call",
    });
  } else if (!a.spend_known) {
    // §5.4's third Attention tag. A figure that is a floor is not a figure, and a card that showed it
    // as one would be the same lie `creation_cost` is forbidden from telling.
    out.push({
      id: "cost-unknown",
      label: "cost unknown",
      family: "attention",
      tone: "rose",
      title: "Something here ran on a model with no price entry, so the spend figure is a floor",
    });
  }

  // ── Runtime, already resolved to one member by the server ────────────────────────────────
  //
  // AMBER FOR THE THREE THAT ARE ACTIVITY, and grey for the two that are not. `Idle` is inert by the
  // colour law and `Paused` is a run that has stopped and is asking — which is not runtime activity,
  // whatever it is. Amber on a paused run would say something is happening when nothing is.
  if (a.runtime === "running") {
    out.push({ id: "running", label: "running", family: "runtime", tone: "amber", title: "A run is in flight" });
  } else if (a.runtime === "generating") {
    out.push({ id: "generating", label: "generating", family: "runtime", tone: "amber", title: "Jaroku is writing this agent's files" });
  } else if (a.runtime === "deploying") {
    out.push({ id: "deploying", label: "deploying", family: "runtime", tone: "amber", title: "A deployment is building or releasing" });
  } else if (a.runtime === "paused") {
    out.push({ id: "paused", label: "paused", family: "runtime", tone: "grey", title: "A run is halted mid-graph, waiting on you" });
  } else {
    out.push({ id: "idle", label: "idle", family: "runtime", tone: "grey", title: "Nothing is running" });
  }

  // ── Deploy ───────────────────────────────────────────────────────────────────────────────
  //
  // DRIFT OUTRANKS LIVE WITHIN THE FAMILY, because it is the more specific claim: a drifted agent is
  // also live, and `Live` beside `v5 → v9` would be two tags saying one thing while burying the half
  // that matters. Rose rather than green: a deploy serving code that is not the code you have is a
  // problem, and the green would say it is in good standing.
  if (a.drift) {
    out.push({
      id: "drift",
      label: `v${a.drift.deployed} → v${a.drift.current}`,
      family: "deploy",
      tone: "rose",
      title: `Deployed from v${a.drift.deployed}; this agent is now at v${a.drift.current}`,
    });
  } else if (a.deployment?.status === "live") {
    out.push({
      id: "live",
      label: "live",
      family: "deploy",
      tone: "green",
      title: a.deployment.url ? `Serving at ${a.deployment.url}` : "Serving on a public URL",
    });
  }

  // ── Health, which is a SEPARATE AXIS from runtime and must stay one ───────────────────────
  //
  // `Healthy` IS DELIBERATELY OMITTED FROM THE ROW, and that is the one place this departs from a
  // literal reading of §5.4's list. Every tag here costs space on a card that has at most three, and
  // "nothing is wrong" is the default a person assumes when nothing says otherwise — so spending a
  // slot on it would push a real signal into the overflow chip on precisely the agents that are fine.
  // The Health tab states it in full, and the sparkline beside it shows the evidence.
  if (a.health === "failing") {
    out.push({ id: "failing", label: "failing", family: "health", tone: "rose", title: "Its recent runs are failing" });
  } else if (a.health === "degraded") {
    out.push({ id: "degraded", label: "degraded", family: "health", tone: "rose", title: "Some of its recent runs failed" });
  } else if (a.health === "unverified") {
    out.push({
      id: "unverified",
      label: "unverified",
      family: "health",
      tone: "grey",
      title: "Its live version was published as-is and never went through the validator",
    });
  }

  // ── Lifecycle, last, because the problem always outranks the novelty ──────────────────────
  if (a.archived_at) {
    out.push({ id: "archived", label: "archived", family: "lifecycle", tone: "grey", title: "Put away. Restore it to bring it back." });
  } else if (a.forked_from) {
    out.push({ id: "forked", label: "forked", family: "lifecycle", tone: "grey", title: `Copied from ${a.forked_from}` });
  } else if (a.current_version <= 1 && a.version_source === null) {
    // DRAFT IS "NOTHING PUBLISHED", not "nothing run". An agent whose row exists and whose version
    // has no manifest behind it is a generation that has not finished or a project nobody imported.
    out.push({ id: "draft", label: "draft", family: "lifecycle", tone: "grey", title: "Nothing has been published for this agent yet" });
  } else if (isNew(a, now)) {
    out.push({ id: "new", label: "new", family: "lifecycle", tone: "grey", title: "Created in the last week, or not run yet" });
  }

  return out;
}

/**
 * §5.4's `New`: created in the last seven days, OR zero runs.
 *
 * THE `OR` IS THE INTERESTING HALF and it is the specification's own wording. An agent generated
 * three months ago that nobody has ever run is new in the only sense that matters to somebody
 * scanning a grid — nothing has happened to it yet — and a rule that only looked at `created_at`
 * would call it established on the strength of having sat there.
 */
export function isNew(a: Pick<TagInput, "created_at" | "runs_7d" | "last_run_at">, now = Date.now()): boolean {
  if (a.last_run_at === null) return true;
  const created = Date.parse(a.created_at);
  return Number.isFinite(created) && now - created < NEW_WINDOW_MS;
}

/** What a card actually renders: the first three, and how many are behind the chip. */
export interface TagRow {
  shown: AgentTag[];
  /** The tags the `+n` chip reveals. Empty when everything fits. */
  overflow: AgentTag[];
}

/**
 * Trim to three, in precedence order.
 *
 * THE ORDER IS ALREADY RIGHT because `agentTags` builds the list in it — so this is a slice rather
 * than a sort, and there is no second place the precedence is decided. A sort here would be a second
 * definition of "which tag matters more", and the two would disagree the first time somebody added a
 * family.
 */
export function agentTagRow(a: TagInput, now = Date.now()): TagRow {
  const all = agentTags(a, now);
  return { shown: all.slice(0, TAG_LIMIT), overflow: all.slice(TAG_LIMIT) };
}

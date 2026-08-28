// §5's one line of real state, and the reason the Cockpit is a tab rather than a status page.
//
// "GET THIS WRONG AND THE COCKPIT IS A STATUS PAGE." That is the whole brief, and the failure mode
// is specific: a strip of twenty cards each reading the same word. A status enum rendered as a
// label is what the Railway dashboard already gives, and it is the reason somebody is opening
// Railway instead of this. So the property this module has to hold is not correctness — a status
// word is perfectly correct — it is SPECIFICITY. Every card must say something that is true of it
// and not of the twenty beside it.
//
// IT IS COMPOSED, NOT TEMPLATED FROM A STATUS ENUM — §5 in as many words. At most three clauses,
// joined by the app's middot, in a precedence that is a LIST rather than a shape nested inside
// JSX. The three kinds and the rule that ranks them:
//
//   1. WHAT IS HAPPENING NOW, if anything is. "2 running", and its queued sibling.
//   2. WHAT IS WAITING ON THE USER, if anything is. "1 waiting on you". §5: "This clause outranks
//      everything except an outright failure, because it is the only clause the reader can act
//      on." It is emitted in §5's own order and it is the clause that never gets trimmed, which
//      is what "outranks" has to mean given that the list is also the order.
//   3. WHAT LAST HAPPENED, when neither of the above applies. "last job 4m ago", "11 jobs today".
//
// A REPLACEMENT, NOT A PREFIX, WHEN THE AGENT CANNOT BE REACHED. §5: "the sentence is replaced,
// not appended. 'Not connected' and nothing else. A card that says 'not connected · 11 jobs today'
// invites the reader to wonder which half is current." The counts on such a card are stale by
// construction — nothing has been able to dispatch to it — so carrying them would be describing a
// yesterday the reader has no way to date.
//
// A PURE FUNCTION OVER A FACTS OBJECT, in its own file, with a fixture per branch — §5 asks for
// exactly that and names its three peers: `threadStatus.ts`, `agentStatus.ts`, `inboxBoard.ts`.
// The reason all four are shaped this way is the same one: "a sentence assembled inside JSX can
// only be tested by rendering, and this one has enough precedence in it to deserve a fixture per
// branch."
//
// WHAT THIS FILE DELIBERATELY NO LONGER DOES, because §4 moved it: the day's SPEND is not in the
// sentence. It was, and §4 relocates it to "the card's overflow panel or the detail's metadata
// line" so that line three of the card can be the health strip instead. A money figure and a
// sparkline competing for one line is how the denser of the two loses.
//
//   npm run test:fleet-sentence

import { CLAUSE, CONNECTION_LABEL } from "./cockpitCopy.ts";
import { relTime } from "./format.ts";
import type { FleetCardView, FleetConnection } from "../types.ts";

/**
 * Everything the sentence is allowed to know.
 *
 * A FACTS OBJECT RATHER THAN THE WIRE TYPE, which §5 asks for and which is worth more than the
 * indirection costs. `FleetCardView` carries a url, a provider, a model, a health probe and a
 * deployment id, and a rule that could reach any of them is a rule whose next revision quietly
 * does. Nine fields narrow to six, and the six are exactly the ones a reader could argue about.
 */
export interface FleetFacts {
  connection: FleetConnection;
  running: number;
  waiting: number;
  queued: number;
  /** Jobs since UTC midnight. The server's day — a limit stated in `snapshot.ts` rather than hidden. */
  jobsToday: number;
  /** When anything was last asked of it, at all. Null means nothing ever has been. */
  lastJobAt: string | null;
}

/** The wire row, narrowed. One place the two shapes meet, so the rule cannot reach past its six. */
export function factsOf(card: FleetCardView): FleetFacts {
  return {
    connection: card.connection,
    running: card.running,
    waiting: card.waiting,
    queued: card.queued,
    jobsToday: card.jobs_today,
    lastJobAt: card.last_job_at,
  };
}

/** Whether this state is one the operator has to fix before the agent can be given work. */
export function needsReconnect(connection: FleetConnection): boolean {
  return connection === "unconnected" || connection === "unauthorised";
}

/**
 * The app's existing separator, and not a new one.
 *
 * A SPACED MIDDOT, which is what every other composed line in this client joins with — the fleet
 * card's predecessor, the thread row's metadata, the trace step's figures. §5 says "the app's
 * existing middot separator" and means it literally: a comma here would be the one composed line
 * in the product that punctuates differently, which reads as a different hand having written it.
 */
export const JOIN = " · ";

/**
 * §5's sentence, as a string.
 *
 * THE CAP IS THREE AND IT IS STRUCTURAL rather than a `slice`. The live clauses are at most three
 * — running, waiting, queued — and the settled clauses only run when none of those did, so the
 * sentence cannot exceed §5's limit by construction. A `.slice(0, 3)` would have been the same
 * length and would have hidden which clause got dropped, which is precisely the decision §5 spends
 * a sentence on: the one that survives is the one the reader can act on.
 */
export function fleetSentence(facts: FleetFacts): string {
  // AN UNREACHABLE AGENT SAYS SO AND STOPS — §5's replacement rule. Both states qualify: a stored
  // token that is absent and one that was refused are different faults and the same fact about the
  // counts beside them, which is that nothing has been able to reach the container to change them.
  if (needsReconnect(facts.connection)) return CONNECTION_LABEL[facts.connection]!;

  const clauses: string[] = [];

  // §5's order, which is also its precedence. `running` first because "what is happening now" is
  // clause one; `waiting` immediately after because it is the clause a person acts on and the one
  // that is never trimmed.
  if (facts.running > 0) clauses.push(CLAUSE.running(facts.running));
  if (facts.waiting > 0) clauses.push(CLAUSE.waiting(facts.waiting));
  if (facts.queued > 0) clauses.push(CLAUSE.queued(facts.queued));

  // CLAUSE THREE RUNS ONLY WHEN THE FIRST TWO DID NOT — §5: "when neither of the above applies".
  // It is not additional colour on a busy card; it is what a settled card says instead of nothing.
  // A card reading "2 running · 11 jobs today" would be answering a question nobody asked of an
  // agent that is visibly working.
  if (clauses.length === 0) {
    if (facts.jobsToday > 0) clauses.push(CLAUSE.jobsToday(facts.jobsToday));
    // AND WHEN IT LAST DID SOMETHING, which is the fact that separates an agent that finished at
    // four this morning from one nobody has ever asked for anything. `relTime` and nothing else —
    // §17 — including its week ceiling, so a card for an agent last used in March reads as a date
    // rather than as arithmetic the reader has to undo.
    if (facts.lastJobAt) {
      const when = relTime(facts.lastJobAt);
      if (when !== "") clauses.push(CLAUSE.lastJob(when));
    }
  }

  // §5: "When there is nothing to say, say that. 'Idle' is a real answer and a better one than an
  // empty line." This is the card for an agent that is live, reachable, and has never been given
  // anything — a genuine state of a workspace that has just deployed its first agent.
  if (clauses.length === 0) return CLAUSE.idle;

  return clauses.join(JOIN);
}

/**
 * What the health probe said, and how old the answer is.
 *
 * NULL IS "NOBODY HAS ASKED", which is a third state and not "unhealthy" — a card that reported
 * red because it had never been probed would be the product accusing a working agent. And the
 * staleness is SPOKEN rather than implied: §10 asks for a stated staleness precisely so the screen
 * says "as of 12s ago" instead of suggesting it just checked.
 *
 * IT IS NOT PART OF THE SENTENCE and never was. §5's three clauses are about work; this is about
 * the probe, it appears in a different place on the card, and folding it in would push a real
 * clause out of a three-clause cap to make room for a fact nobody asked for.
 */
export function healthLine(card: FleetCardView): string | null {
  if (!card.health) return null;
  const age = card.health_stale_ms ?? 0;
  const when = age < 2_000 ? "just now" : `${Math.round(age / 1000)}s ago`;
  switch (card.health) {
    case "healthy":
      return `answering, as of ${when}`;
    case "unhealthy":
      return `answering, but not as a healthy agent — as of ${when}`;
    case "unreachable":
      return `did not answer, as of ${when}`;
    case "no_url":
      return "no public URL";
  }
}

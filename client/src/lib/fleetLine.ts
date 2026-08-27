// §9's hardest line, as a pure function.
//
// "The one line on a fleet card is the hardest design here. Not 'Running'. A card reads: name,
// connection state, and one sentence of real state — '2 running · 1 waiting on you', 'idle · 11
// jobs today · $0.42', 'not connected'. A status word alone is what the Railway dashboard already
// gives, and it is the reason the user is opening Railway instead of this."
//
// SO THE RULE IS: EVERY CARD SAYS SOMETHING THAT IS TRUE OF IT SPECIFICALLY. A word that would be
// identical on twenty cards is a word that has told the reader nothing, and the failure mode of
// this component is a strip of twenty cards all reading "Deployed".
//
// PURE, AND ITS OWN FILE, for the reason `composerBar.ts`, `inboxBoard.ts` and `activityMetrics.ts`
// are: this is a RULE that looks obviously right in a screenshot and is wrong in the case nobody
// had that day — a workspace with nothing running, an agent whose model has no price, a card whose
// connection state means the numbers beside it cannot be trusted. A rule embedded in JSX is a rule
// tested by looking at it.
//
// THE ORDER IS LIVE-FIRST, THEN TODAY. What is happening now outranks what has happened, because
// somebody opening this tab is asking "what is going on" — and a card that led with "11 jobs today"
// while one of them was blocked on a confirmation would have buried the only line that needed them.

import { fmtCost } from "./format.ts";
import type { FleetCardView, FleetConnection } from "../types.ts";

/**
 * What the connection state says, when it is the whole of what the card can say.
 *
 * THREE OF THE FOUR REPLACE THE SENTENCE RATHER THAN PREFIXING IT, and that is the decision worth
 * stating: an agent Jaroku cannot authenticate against has counts that are still true and are no
 * longer the point. "not connected · 11 jobs today" invites somebody to read the second half and
 * conclude it is working. `connected` is the one that says nothing, because on a working agent the
 * connection is not news.
 *
 * `public` IS A WARNING AND NOT A HEALTHY STATE — §9 in as many words. It does NOT replace the
 * sentence, because a public agent is working: it says so alongside, so the card carries both the
 * real state and the fact that anyone with the URL can spend the workspace's provider key.
 */
export const CONNECTION_LABEL: Record<FleetConnection, string | null> = {
  connected: null,
  unconnected: "not connected",
  unauthorised: "credential refused",
  public: "public URL",
};

/** Whether this state is one the operator has to fix before the agent can be given work. */
export function needsReconnect(connection: FleetConnection): boolean {
  return connection === "unconnected" || connection === "unauthorised";
}

/**
 * One sentence of real state, as its parts.
 *
 * PARTS RATHER THAN A STRING, so the view can weight them — "1 waiting on you" is the only fragment
 * that is ever ink rather than muted, because it is the only one that names something a person has
 * to do. A function returning a joined string would put that decision in a `split(" · ")`.
 */
export interface FleetLine {
  parts: { text: string; emphasis: "ink" | "muted" }[];
  /** True when the numbers beside it cannot be trusted — the card renders the state alone. */
  blocked: boolean;
}

export function fleetLine(card: FleetCardView): FleetLine {
  const state = CONNECTION_LABEL[card.connection];

  // A CARD THAT CANNOT BE REACHED SAYS SO AND STOPS. Its counts are stale by construction — nothing
  // has been able to dispatch to it — and a sentence that carried them would be describing a
  // yesterday the reader has no way to date.
  if (needsReconnect(card.connection)) {
    return { parts: [{ text: state!, emphasis: "ink" }], blocked: true };
  }

  const parts: FleetLine["parts"] = [];

  // LIVE FIRST. `waiting` is ink even when something is also running, because it is the only
  // fragment on this strip that names a thing a person has to do.
  if (card.running > 0) parts.push({ text: `${card.running} running`, emphasis: "muted" });
  if (card.waiting > 0) {
    parts.push({ text: `${card.waiting} waiting on you`, emphasis: "ink" });
  }
  if (card.queued > 0) parts.push({ text: `${card.queued} queued`, emphasis: "muted" });

  // AND `idle` ONLY WHEN NOTHING IS LIVE, which is what stops it appearing beside a running count.
  // It is a real word about this agent right now, unlike "deployed", which is true of every card.
  if (parts.length === 0) parts.push({ text: "idle", emphasis: "muted" });

  // THEN TODAY, so an idle card still says something specific. A card reading only "idle" is the
  // status word §9 rules out, one synonym over.
  if (card.jobs_today > 0) {
    parts.push({ text: `${card.jobs_today} job${card.jobs_today === 1 ? "" : "s"} today`, emphasis: "muted" });
    // UNKNOWN IS NOT ZERO — §11.1, and `fmtCost` is the one place that rule is spelled. An unpriced
    // model reports null and renders `—`; omitting the fragment entirely would be the same lie in a
    // quieter form, because a card with jobs and no money reads as free.
    const spend = fmtCost(card.spend_today);
    parts.push({
      // A FLOOR SAYS SO. `cost_incomplete` means some call could not be priced, so the total is an
      // undercount — and a confidently wrong number on a card built to be glanced at is exactly
      // what §11 exists to prevent.
      text: card.spend_complete ? spend : `${spend}+`,
      emphasis: "muted",
    });
  }

  return { parts, blocked: false };
}

/**
 * What the health probe said, and how old the answer is.
 *
 * NULL IS "NOBODY HAS ASKED", which is a third state and not "unhealthy" — a card that reported red
 * because it had never been probed would be the product accusing a working agent. And the staleness
 * is SPOKEN rather than implied: §10 asks for a stated staleness precisely so the screen says "as
 * of 12s ago" instead of suggesting it just checked.
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

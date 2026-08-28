// What the Cockpit's composer should say, given what is happening — §23, and `composerMoment`'s shape.
//
// §23 ASKS FOR THIS BY NAME AND GIVES THE REASON: "`composerMoment.ts` exists because the app's one
// input used to be the part of it that never knew what was going on, and it is a pure function over
// a flat descriptor with precedence as a list rather than nesting inside JSX. Write the Cockpit's
// equivalent, in the same shape, in its own file, with its own suite."
//
// ITS SITUATION IS GENUINELY DIFFERENT AND THAT IS WHY IT IS A SECOND FUNCTION RATHER THAN A
// BRANCH IN THE FIRST. `composerMoment` reasons about plans, generations, staleness and a selected
// trace step — none of which exist out here. This one has exactly one destination, a live agent,
// for real, and the things that can be wrong with that destination are its own: not connected, at
// capacity, not permitted. Folding them into one function would produce a descriptor with eleven
// fields of which each caller uses five.
//
// TWO STRINGS OUT, AS `composerMoment` DOES. The placeholder says WHAT TO TYPE. The status says
// WHAT THE APP IS DOING and is NULL WHEN THE ANSWER IS NOTHING — §23 repeats that clause and it is
// the one that is easy to lose: "A composer that reports 'idle' is noise." A ready composer says
// nothing about itself, because there is nothing to say and the empty line is quieter than a lie.
//
// THE PRECEDENCE IS A LIST AND NOT A SHAPE, which is the half that makes it testable. Every one of
// these states can be true at once — a reader with no permission, no agent selected, and a dispatch
// in flight — and the question the function answers is which of them the person should be told
// about first.
//
//   npm run test:cockpit-composer

/**
 * Everything the composer is allowed to know, flat.
 *
 * FLAT AND NOT NESTED, deliberately, which `composerMoment` also is. A descriptor with a
 * `{ agent: { connection, capacity } }` inside it invites the function to reach one level deeper
 * than the state it was given, and the moment it does the precedence stops being a list.
 */
export type CockpitSituation = {
  /** How many live agents there are to choose between. Zero is a real and common state. */
  liveAgents: number;
  /** The chosen agent's display name, or null when none is chosen. */
  agentName: string | null;
  /** Whether the chosen agent can be reached at all — `unconnected` or `unauthorised`. */
  connected: boolean;
  /** Whether the chosen agent is already running as many jobs as it allows. */
  atCapacity: boolean;
  /** Whether this reader may dispatch work here at all. §14's `run:execute`. */
  permitted: boolean;
  /** A dispatch this composer sent has not been acknowledged yet. */
  inFlight: boolean;
  /** The input is over the byte cap the boundary enforces. See `overCap` below. */
  overCap: boolean;
};

export type CockpitMoment = {
  placeholder: string;
  /** One line about what is happening. Null when nothing is. */
  status: string | null;
  /** Whether the send control can be pressed at all. */
  ready: boolean;
};

import { COMPOSER } from "./cockpitCopy.ts";

/**
 * Precedence, most specific first — and each rung is here because it answers a different question.
 *
 *   1. A DISPATCH IS IN FLIGHT. What the app is DOING outranks what you could ask it to do, which
 *      is `composerMoment`'s own second rule and is right for the same reason: a second press while
 *      the first is unacknowledged is the commonest way one job gets sent twice.
 *
 *   2. THE READER MAY NOT DISPATCH. It is a fact about them that no choice on this screen changes,
 *      so telling them to pick an agent first would be sending them down a path that ends in the
 *      same refusal. §14: the reason names the capability in human words, and it is the COMPOSER
 *      that stays typeable — "a composer that cannot be typed in gives the user nothing to read".
 *
 *   3. THERE IS NO AGENT TO SEND TO, which is two states that read as one to the person: a
 *      workspace with nothing deployed, and one where nothing has been picked yet. They differ in
 *      what the reader does next, so they differ in the sentence.
 *
 *   4. THE AGENT CANNOT BE REACHED. Beyond this rung the destination exists and is the problem.
 *
 *   5. THE AGENT IS AT CAPACITY. Below `connected` because an unreachable agent's capacity is not
 *      a fact anybody has checked — the container has not answered.
 *
 *   6. THE INPUT IS TOO LONG. Last of the refusals, because it is the only one the reader can fix
 *      by editing what is in front of them — and §19 requires it to be caught HERE rather than at
 *      the gate: "Refusals that are knowable before dispatch happen before the gate. No live
 *      deployment, no stored token, over the input cap: all of these are known client-side or on
 *      the first server hop, and asking the user to confirm something that was always going to be
 *      refused is the worst version of this flow."
 *
 *   7. READY. The placeholder names the agent and the status is null.
 */
export function cockpitComposer(s: CockpitSituation): CockpitMoment {
  const agent = s.agentName ?? "this agent";

  if (s.inFlight) {
    return { placeholder: COMPOSER.placeholder.inFlight, status: COMPOSER.status.inFlight, ready: false };
  }
  if (!s.permitted) {
    return { placeholder: COMPOSER.placeholder.forbidden, status: COMPOSER.status.forbidden, ready: false };
  }
  if (s.liveAgents === 0 || !s.agentName) {
    // NO STATUS. "Pick an agent first" is already the whole of what the app has to say, and
    // repeating it underneath would be the composer telling the reader twice.
    return { placeholder: COMPOSER.placeholder.noAgent, status: null, ready: false };
  }
  if (!s.connected) {
    return { placeholder: COMPOSER.placeholder.unconnected, status: COMPOSER.status.unconnected, ready: false };
  }
  if (s.atCapacity) {
    return { placeholder: COMPOSER.placeholder.busy, status: COMPOSER.status.busy, ready: false };
  }
  if (s.overCap) {
    // THE PLACEHOLDER IS STILL THE READY ONE, because a placeholder is only visible in an EMPTY
    // field and a field over the byte cap is by definition not empty. Writing a refusal into a
    // string nobody can see would be the one branch of this function that never renders.
    return { placeholder: COMPOSER.placeholder.ready(agent), status: null, ready: false };
  }
  // §23: THE STATUS IS NULL WHEN NOTHING IS HAPPENING. "A composer that reports 'idle' is noise."
  return { placeholder: COMPOSER.placeholder.ready(agent), status: null, ready: true };
}

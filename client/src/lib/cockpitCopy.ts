// Every word the Cockpit says, in one file — §16, and the reason it gives is the one that matters.
//
// "Put every user-facing string of this tab in one module, not spread across components, so the
// voice can be reviewed as prose in a single diff." That is not a tidiness argument. A tab's voice
// is a property of the WHOLE tab and of no single component, so it is invisible in every diff that
// touches one file: a sentence that pleads, a hard-coded `(s)`, a "failed" standing on its own —
// each of them looks fine beside the twenty lines of JSX it arrives in, and wrong beside the other
// forty strings on the same screen. Read as a block, they cannot hide from each other.
//
// THE SIX RULES §16 STATES, WRITTEN OUT SO `test:cockpit-copy` CAN HOLD THEM:
//
//   SENTENCE CASE EVERYWHERE except `TYPE.panelLabel`, which is the caps recipe and the only caps
//   in the app. Nothing in this file is capitalised beyond its first word and its proper nouns.
//
//   NUMERALS ALWAYS, even below ten — "2 running", never "two running". A figure the eye can catch
//   beats a word it has to read, and this surface is scanned rather than read.
//
//   PLURALISE PROPERLY. "1 job", "2 jobs", "1 waiting on you", "2 waiting on you". A hard-coded
//   `(s)` is the fastest way to look unfinished, so every counted string goes through `count`
//   below and the suite checks 0, 1 and 2 for each of them.
//
//   NO PLEADING AND NO APOLOGISING. Not "Please try again", not "Sorry, something went wrong".
//   Say what happened and what to do.
//
//   AN ERROR NAMES THE THING, THEN THE ACTION. "The stored token is wrong. Reconnect this agent."
//   Two sentences, in that order — the fact first, because the fact is what the reader is checking
//   against what they already believe.
//
//   NEVER SAY "FAILED" ALONE. Six failure kinds exist precisely so the interface can be specific,
//   and a row reading "failed" throws all six away.
//
// AND THE ONE THAT IS NOT A STYLE RULE: NEVER INVENT CERTAINTY. "May have" is a real and correct
// phrase when the record is genuinely ambiguous. `stopped_reporting` is the case — the container
// went quiet, and both of its clauses are required verbatim by §7 and by Part 2 before it. Do not
// edit the hedge out to make the copy read tighter; the sentence is hedged because the FACT is.

import type { FleetConnection, WorkFailureKind, WorkStatus } from "../types.ts";

/**
 * A counted noun, pluralised by the count rather than by a suffix in the middle of a word.
 *
 * THE IRREGULAR FORM IS A PARAMETER AND NOT A RULE. English pluralisation is not a function of the
 * singular — "person" and "people", "is" and "are" — and a helper that appended an `s` would be
 * correct for four of this tab's nouns and wrong for the two that matter, which is the shape of
 * bug that ships because the fixtures were all regular. Callers that need "is"/"are" pass both.
 *
 * THE NUMBER IS ALWAYS A NUMERAL, per §16, and always leads. "2 jobs" rather than "jobs: 2":
 * a column of these is scanned down its left edge, and a label-first form buries the digit.
 */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * §5's three clauses, as strings rather than as templates inside the sentence builder.
 *
 * SEPARATE FROM `fleetSentence.ts` ON PURPOSE, even though that module is their only caller today.
 * The sentence's job is PRECEDENCE — which clause outranks which — and this file's job is the
 * words. Keeping them apart is what lets §16's voice be reviewed without reading a precedence
 * table, and what lets the precedence be tested without asserting on prose that may be reworded.
 */
export const CLAUSE = {
  running: (n: number): string => `${n} running`,
  /** Second person for the reader — §16. The agent is "it"; the person reading is "you". */
  waiting: (n: number): string => `${count(n, "waiting on you", "waiting on you")}`,
  queued: (n: number): string => `${n} queued`,
  jobsToday: (n: number): string => `${count(n, "job")} today`,
  lastJob: (rel: string): string => `last job ${rel}`,
  /**
   * WHEN THERE IS NOTHING TO SAY, SAY THAT. §5: "Idle is a real answer and a better one than an
   * empty line." It is capitalised here because it is the whole sentence when it appears alone,
   * and sentence case means the first word of a sentence.
   */
  idle: "Idle",
} as const;

/**
 * §9's four connection states, in words.
 *
 * `connected` IS NULL AND NOT A WORD. §9: "the quietest possible mark, or none. Healthy is not a
 * thing to announce." A card that said "connected" would spend a line of a three-line card on the
 * one fact that is true of every card worth reading.
 *
 * THE OTHER THREE REPLACE THE SENTENCE RATHER THAN PREFIXING IT — §5 — except `public`, which is
 * a supported mode somebody chose rather than a fault and therefore says so ALONGSIDE the real
 * state. "Not connected · 11 jobs today" invites the reader to work out which half is current.
 */
export const CONNECTION_LABEL: Record<FleetConnection, string | null> = {
  connected: null,
  unconnected: "Not connected",
  unauthorised: "Credential refused",
  public: "Public URL",
};

/** What `public` adds beside its colour, because §9 requires a word or a mark beside the hue. */
export const PUBLIC_NOTE = "anyone holding the URL can spend this workspace’s provider key";

/**
 * §7.3's six failure sentences, written out.
 *
 * "EACH KIND GETS ITS OWN SENTENCE, WRITTEN OUT, NOT A MAPPED ENUM LABEL." That is the whole
 * point of the closed set: six kinds exist so that six different things can be said, and a screen
 * that rendered `agent_error` in a monospace chip would have spent the schema and said nothing.
 *
 * TWO OF THEM ARE VERBATIM AND MUST NOT BE REWORDED:
 *
 *   `rejected` — "Jaroku sent something this agent refused — this is a bug on our side." §7 calls
 *   it the most important sentence in the list, and it is: telling somebody their agent refused
 *   something, when Jaroku sent it something malformed, points them at the wrong product and at
 *   the wrong afternoon.
 *
 *   `stopped_reporting` — both clauses, hedge intact. It is the absence of an observation rather
 *   than an observation, and rendering it as "failed" would be a confident claim about somebody's
 *   bill.
 *
 * EACH NAMES THE THING AND THEN THE ACTION, in that order, per §16.
 */
export const FAILURE_SENTENCE: Record<WorkFailureKind, string> = {
  unauthorised: "The stored token is wrong. Reconnect this agent.",
  agent_error: "The agent raised an error. The trace opens on the failing step.",
  rejected: "Jaroku sent something this agent refused — this is a bug on our side.",
  unreachable: "The container could not be reached.",
  stopped_reporting:
    "The container stopped reporting. It may have completed, and it may have spent money.",
  busy: "The agent was at capacity.",
};

/**
 * The one word each status wears where a word is wanted — a chip's title, a glyph's `title`.
 *
 * NOT A REPLACEMENT FOR THE GLYPH. §9's rule is six statuses, six marks, and these are what the
 * mark is NAMED, which is what §12 requires of every status mark and what a screen reader reads
 * instead of a colour. `waiting` says what it is waiting on, because "waiting" alone leaves the
 * reader to guess whether the machine or a person is the blocker — and it is always a person.
 */
export const STATUS_WORD: Record<WorkStatus, string> = {
  queued: "queued",
  running: "running",
  waiting: "waiting on you",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * §10's three empty states, three sentences, and each carries its own action.
 *
 * THEY MUST BE DISTINGUISHABLE AT A GLANCE because they call for three different things: deploy
 * something, give it something to do, or undo a filter. Collapsing any two would tell an operator
 * with forty jobs that nothing has been asked of their agents, because they had clicked "failed".
 */
export const EMPTY = {
  /** The only `full` state in the tab: a genuine state of the product, not a gap that clears. */
  noAgents: {
    title: "No agents are live yet.",
    hint: "Deploy an agent from its Deploy panel and it will appear here, with everything it has been asked to do.",
    action: "Open the Deploy panel",
  },
  /** Live agents and nothing asked of them. A `line`, because the composer below is the answer. */
  noWork: { title: "Nothing has been asked of them yet." },
  /** Narrowed to nothing. Names the filter and offers to clear it — a `line`, for the same reason. */
  filtered: { title: "Nothing here matches this filter.", action: "Show everything" },
} as const;

/**
 * The channel dropped.
 *
 * §10: freeze the fleet strip's sentences rather than blanking them, and say in the header that
 * the figures are as of the last update. Blanking reads as "everything stopped"; a stale figure
 * with a STATED staleness is honest and calmer, and it is the difference between a surface that
 * has lost its connection and one that is reporting a workspace that has gone quiet.
 */
export const OFFLINE = {
  header: "reconnecting…",
  /** The `title` on it, which is the Inbox's own sentence — two tabs saying it differently is worse. */
  hint: "Changes here need a connection",
  /** Beside the frozen strip, so a figure nobody can refresh says how old it is. */
  frozen: "These figures are as of the last update.",
} as const;

/**
 * §8's composer, and the one phrase that separates it from every other input in the product.
 *
 * "WILL RUN FOR REAL" IS ALWAYS VISIBLE, ABOVE THE INPUT — §8, "not a tooltip, not on hover". The
 * build composer edits an agent; this one commands one, on the workspace's real provider key,
 * against the world. A person who confuses the two boxes spends money on a sentence they meant as
 * a note to themselves, and the only reliable defence is that the destination is never hidden.
 */
export const COMPOSER = {
  destination: (agentName: string): string => `${agentName} — will run for real`,
  noDestination: "No agent selected",
  placeholder: {
    noAgent: "Pick an agent first",
    unconnected: "This agent is not connected",
    busy: "This agent is at capacity",
    forbidden: "You cannot dispatch work in this workspace",
    inFlight: "Sending…",
    ready: (agentName: string): string => `Give ${agentName} a real job…`,
  },
  status: {
    unconnected: "Reconnect it before giving it work.",
    busy: "It is already running as many jobs as it allows.",
    forbidden: "Dispatching a job needs the run:execute capability.",
    inFlight: "Sending it now.",
  },
  send: "Dispatch",
  /** Restored on refusal, so the courtesy any message box owes is a string somebody can see. */
  restored: "That was refused, so what you typed is back in the box.",
} as const;

/**
 * §8's pre-flight gate: what is about to happen, before the button that causes it.
 *
 * IT NAMES WHAT WILL HAPPEN AND NOT WHAT IT WILL COST, deliberately. Nothing can honestly predict
 * the cost of a job whose graph has not run, and a confident figure here would be the one number
 * on the tab whose whole argument is that its numbers are real.
 */
export const GATE = {
  title: "Run this for real?",
  /** The confirming control. Not the default focus — §8 is explicit. */
  confirm: "Dispatch it",
  cancel: "Cancel",
  unrecordedVersion: "an unrecorded version",
} as const;

/**
 * §21's three graded confirmations, and the reason they are graded at all.
 *
 * "GIVING ALL THREE THE SAME CONFIRMATION TEACHES PEOPLE TO CLICK THROUGH ALL THREE." Stop is
 * scoped to one item that is on screen, so it is a single press. Reconnect and Kill affect other
 * people's jobs, so each gets a dialog — and Kill's names the agent, because a dialog that does
 * not name what it is about is one somebody confirms over the wrong card.
 *
 * THE RECONNECT SENTENCE IS VERBATIM FROM PART 2 and appears in exactly one place in this
 * codebase, which is why it is here rather than beside the button: two different sentences for
 * one consequence teach the reader that neither is precise.
 */
export const DESTRUCTIVE = {
  stop: { label: "Stop", title: "Ask the agent to stop at its next node boundary" },
  reconnect: {
    label: "Reconnect",
    title: "Reconnect this agent",
    warning:
      "This will briefly take the agent offline: setting the token on Railway restarts the " +
      "service, and any run in flight — including a paused one — loses its checkpoint.",
    confirm: "Reconnect anyway",
  },
  kill: {
    label: "Kill",
    title: "Stop this agent’s service",
    warning: (agentName: string): string =>
      `Stopping ${agentName}’s service kills everything running on it. Jaroku cannot bring it ` +
      `back — the service is redeployed from the Deploy panel.`,
    confirm: "Kill it",
  },
  /** Shared by both dialogs. Never the default focus on either — §21. */
  cancel: "Cancel",
} as const;

/**
 * §18's pill, and §19's optimistic row.
 *
 * "3 NEW" RATHER THAN "3 NEW JOBS", because the pill sits at the top of a list of jobs and the
 * noun is the list. Pluralised anyway — a pill that read "1 new" beside a hard-coded plural would
 * be the `(s)` failure one word further along.
 */
export const LIVE = {
  pill: (n: number): string => `${count(n, "new", "new")}`,
  pillTitle: "Scroll to the top and show them",
  /** The optimistic row, before the server has said anything. Quiet, and never a lie. */
  unacknowledged: "Sending…",
} as const;

/** §6's filter bar. The mine/all toggle is never gated — §14 — so neither label is a refusal. */
export const FILTERS = {
  scope: { mine: "Mine", all: "Everyone’s" },
  allStatuses: "All",
  /** The chip a fleet card sets, and the press that undoes it. Names the agent, per §4. */
  agentChip: (agentName: string): string => `Only ${agentName}`,
  clearAgent: "Show every agent",
} as const;

/**
 * §14's refusals: a control the reader lacks permission for is DISABLED WITH A STATED REASON,
 * never missing, and the reason names the capability in human words.
 *
 * THIS IS THE OPPOSITE OF `Capable`'s DEFAULT, and the difference is deliberate rather than an
 * inconsistency. `Capable` renders nothing because §8 of Part 2 decided that for socket commands
 * in general: an absent control cannot be found in devtools and clicked. §14 of THIS document
 * overrides it for the Cockpit's own verbs, and the argument is about a console specifically —
 * an operator who cannot see that Stop exists concludes the product cannot stop a job, which is
 * a worse belief to leave somebody with than "you cannot do this here".
 */
export const REFUSAL = {
  dispatch: "Dispatching a job needs the run:execute capability.",
  cancel: "Stopping a job needs the run:execute capability.",
  retry: "Retrying a job needs the run:execute capability.",
  reconnect: "Reconnecting an agent needs the deploy:manage capability.",
  kill: "Killing an agent’s service needs the deploy:manage capability.",
} as const;

/**
 * §7's detail panel, and §17's em-dash tooltip.
 *
 * "UNKNOWN IS AN EM DASH WITH A TOOLTIP SAYING WHY." An em dash with no explanation is a figure
 * the reader assumes is a bug in the product rather than an absence in the record — and the two
 * reasons a cost is unknown are genuinely different facts, so they are two sentences.
 */
export const DETAIL = {
  label: "Job",
  close: "Close",
  asked: "What was asked",
  cameBack: "What came back",
  wentWrong: "What went wrong",
  /** Where the dispatcher's cap cut the stored value. §7: say so WHERE THE TEXT ENDS. */
  truncated: "the rest was not stored — this is where the record stops",
  emptyOutput: "the agent produced nothing",
  trace: "Open the trace",
  copyId: "Copy this job’s id",
  costUnknown: "Nothing here could be priced, so there is no total to show.",
  costPartial: "Part of this run could not be priced, so this is a floor rather than a total.",
  tokensUnknown: "No step reported a token count.",
  durationUnknown: "This job has not ended, so it has no duration yet.",
} as const;

/** The one thing the header says beyond its own name — §3's count beside the panel label. */
export const HEADER = {
  label: "Cockpit",
  refresh: "Ask for the fleet and the list again",
  /** §12's live region announces `waiting` and nothing else. This is what it announces. */
  announce: (agentName: string): string => `${agentName} is waiting on you.`,
} as const;

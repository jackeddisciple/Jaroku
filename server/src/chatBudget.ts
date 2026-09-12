// §12 — the two chat ceilings, as one pure decision.
//
// §12's OPENING ARGUMENT IS THE REASON THIS FILE EXISTS: "v0.1.9 gave the eval engine a hard budget
// ceiling and a pre-run estimate. Chat has neither. A long thread, an accidental loop, or a
// regenerate pressed ten times can spend quietly. A cost-honest product's next step is to be
// cost-controlled — displaying a number is not the same as bounding it."
//
// PURE, AND THAT IS WHAT MAKES §12'S THREE ACCEPTANCE CASES CHECKABLE. "A thread driven past the
// soft ceiling warns once and continues", "a workspace past the hard ceiling refuses with the
// specified sentence while a run and a generation both still start", and "an in-flight stream at the
// moment the ceiling is crossed completes rather than being killed" — the first two are decisions
// about four numbers and a boolean, and the third is a property of WHERE this is called rather than
// of what it returns. So the numbers live here and the placement is argued at the call site.
//
// IT COUNTS THE SAME FIGURES §10 RECORDS. §12.2: "spend is counted from the same per-turn figures
// §10 records — one source, so the ceiling and the displayed total can never disagree." The caller
// reads `usage_events` through the same `spendByThread` the Threads row renders from, and the
// workspace half through the same table.
//
//   npm run test:chat-budget

/** §12.2's own words, and the figure is filled in from the ceiling that was actually set. */
export function dailyRefusal(ceilingUsd: number): string {
  // §12.2 QUOTES THIS SENTENCE, and it is quoted rather than paraphrased for the reason the rule
  // gives: "the refusal explains itself and names the remedy, per this product's standing rule that
  // a blocked control always says why. Never a greyed composer with no sentence."
  //
  // TWO DECIMALS, because it is a limit somebody typed and will read back. `fmtCost`'s four are for
  // a per-call figure where the fourth decimal is the measurement; a ceiling of `$2.0000` reads as
  // a number a machine chose.
  return `Daily chat budget reached ($${ceilingUsd.toFixed(2)}). Raise it in settings or start again tomorrow.`;
}

/** What a thread's warning says when the soft ceiling is crossed. */
export function softWarning(spentUsd: number, ceilingUsd: number): string {
  // §12.1: "at the threshold, a visible warning in the thread STATING THE SPEND AND THE CEILING.
  // Does not block." Both figures, because a warning naming only the limit leaves somebody
  // guessing how far past it they are, and one naming only the spend does not say why it appeared.
  return `This conversation has spent $${spentUsd.toFixed(2)} on chat, past the $${ceilingUsd.toFixed(2)} `
    + `you set per conversation. Nothing is blocked — the daily workspace budget is what stops chat.`;
}

/** The ceilings in force, as the workspace has them. */
export interface ChatCeilings {
  /** Per thread, cumulative. Soft: it warns. */
  threadUsd: number;
  /** Per workspace per day. Hard: it refuses. */
  dailyUsd: number;
}

/** What has been spent, as the caller read it. */
export interface ChatSpend {
  /** This thread's cumulative chat spend, or null when nothing has been measured. */
  threadUsd: number | null;
  /** The workspace's chat spend today, or null when nothing has been measured. */
  dailyUsd: number | null;
  /** True when this thread has already been warned about the soft ceiling. */
  warned: boolean;
}

export type ChatBudgetVerdict =
  /** Send it. */
  | { allow: true; warn: string | null }
  /** §12.1's hard refusal, with §12.2's sentence. */
  | { allow: false; reason: string };

/**
 * §12: may this chat turn start, and is there anything to say about it?
 *
 * THE HARD CEILING IS CHECKED FIRST, because a refusal makes the warning irrelevant: telling
 * somebody their conversation is expensive and then refusing to answer it is two sentences where
 * one will do, and the one that matters is the refusal.
 *
 * UNKNOWN SPEND DOES NOT BLOCK. `null` means nothing has been measured — a workspace whose every
 * chat turn ran on an unpriced model, or a brand-new one — and §10's rule is that unknown is
 * excluded from totals rather than contributing zero. A ceiling that treated unknown as "over"
 * would refuse a workspace that had spent nothing measurable; one that treated it as zero is what
 * this does, which is the direction that keeps somebody working. It is also why the DAILY ceiling
 * is the hard one: an unpriced model cannot be bounded by money at all, and §12 does not pretend
 * otherwise.
 *
 * A CEILING OF ZERO REFUSES EVERYTHING, which is a coherent setting rather than an edge case: an
 * administrator turning conversational spend off entirely. `>=` is what makes that true, and it is
 * the same comparison that makes a crossed ceiling a refusal rather than a near miss.
 */
export function chatBudgetVerdict(spend: ChatSpend, ceilings: ChatCeilings): ChatBudgetVerdict {
  const daily = spend.dailyUsd ?? 0;
  if (daily >= ceilings.dailyUsd) {
    return { allow: false, reason: dailyRefusal(ceilings.dailyUsd) };
  }
  const thread = spend.threadUsd ?? 0;
  // §12.2: "THE WARNING APPEARS ONCE PER THRESHOLD CROSSING, NOT ON EVERY SUBSEQUENT TURN. A
  // warning that repeats becomes furniture." `warned` is what the caller read off the thread's own
  // record, which is also where the warning was written — so the thing that remembers the warning
  // IS the warning, and there is no second state to keep in step.
  if (thread >= ceilings.threadUsd && !spend.warned) {
    return { allow: true, warn: softWarning(thread, ceilings.threadUsd) };
  }
  return { allow: true, warn: null };
}

/**
 * The marker a soft warning leaves in the thread, so it is not repeated.
 *
 * A PREFIX ON THE WARNING'S OWN TEXT rather than a column. §12.2 needs "has this thread been warned"
 * and the warning is already a durable, visible item in the conversation — so the record of the
 * warning is the warning, and a boolean beside it would be a second state that can disagree with
 * what is on screen. Matching on a prefix is crude and is the crudeness that cannot drift: there is
 * one writer and one reader, both in this file's callers, and the string is here.
 */
export const SOFT_WARNING_MARK = "This conversation has spent $";

/** Whether a thread's items already carry the soft warning. */
export function alreadyWarned(bodies: readonly (string | null)[]): boolean {
  return bodies.some((b) => (b ?? "").startsWith(SOFT_WARNING_MARK));
}

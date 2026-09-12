// §12 — the two chat ceilings, and the three things §12's acceptance asks for.
//
//   "A thread driven past the soft ceiling warns once and continues."
//   "A workspace driven past the hard ceiling refuses new chat turns with the specified sentence,
//    while a run and a generation both still start successfully."
//   "An in-flight stream at the moment the ceiling is crossed completes rather than being killed."
//
// THE FIRST TWO ARE DECISIONS OVER FOUR NUMBERS AND A BOOLEAN, which is why `chatBudgetVerdict` is
// pure: a suite that had to stand a server up to learn whether a warning repeats would be a suite
// nobody runs. The THIRD is not a decision at all — it is a property of WHERE the check is called,
// and the only honest way to assert it is to read the code and show there is no ceiling consulted
// anywhere in the streaming path. That is the last block.
//
// AND THE SENTENCE IS QUOTED RATHER THAN PARAPHRASED, because §12.2 quotes it: "Daily chat budget
// reached ($2.00). Raise it in settings or start again tomorrow." A refusal that said something
// else would still be a refusal and would have lost the half that names the remedy.
//
//   npm run test:chat-budget

import { readFileSync } from "node:fs";

import {
  alreadyWarned, chatBudgetVerdict, dailyRefusal, softWarning, SOFT_WARNING_MARK,
} from "./chatBudget.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** §12.2's own defaults — migration 076's, and the figure the refusal quotes. */
const CEILINGS = { threadUsd: 0.5, dailyUsd: 2 };

// --- the soft ceiling -------------------------------------------------------------------------

console.log("\n§12.1 — the soft ceiling warns and does not block");
{
  const under = chatBudgetVerdict({ threadUsd: 0.2, dailyUsd: 0.2, warned: false }, CEILINGS);
  check("under the threshold, nothing is said", under.allow === true && under.warn === null, JSON.stringify(under));

  const over = chatBudgetVerdict({ threadUsd: 0.61, dailyUsd: 0.61, warned: false }, CEILINGS);
  check("past it, the turn is still allowed", over.allow === true, JSON.stringify(over));
  check("...and a warning is produced", over.allow && over.warn !== null, JSON.stringify(over));
  // §12.1: "A VISIBLE WARNING IN THE THREAD STATING THE SPEND AND THE CEILING." Both figures: one
  // naming only the limit leaves somebody guessing how far past it they are, and one naming only
  // the spend does not say why it appeared.
  check("...naming the spend", over.allow && over.warn?.includes("$0.61") === true, over.allow ? over.warn ?? "" : "");
  check("...and the ceiling", over.allow && over.warn?.includes("$0.50") === true, over.allow ? over.warn ?? "" : "");
  // AND IT SAYS WHAT IS NOT HAPPENING, because a warning that reads like a refusal is a refusal as
  // far as anybody reading it is concerned.
  check("...and that nothing is blocked", over.allow && /Nothing is blocked/.test(over.warn ?? ""), "");

  // EXACTLY AT THE THRESHOLD IS PAST IT. `>=` rather than `>`, which is the same comparison that
  // makes a crossed ceiling a refusal rather than a near miss.
  const exact = chatBudgetVerdict({ threadUsd: 0.5, dailyUsd: 0.5, warned: false }, CEILINGS);
  check("exactly at the threshold warns", exact.allow === true && exact.warn !== null, JSON.stringify(exact));
}

console.log("\n§12.2 — the warning appears once per threshold crossing");
{
  // "A WARNING THAT REPEATS BECOMES FURNITURE." The second turn past the ceiling says nothing, and
  // the thing that remembers is the warning itself — see `SOFT_WARNING_MARK`.
  const again = chatBudgetVerdict({ threadUsd: 1.2, dailyUsd: 1.2, warned: true }, CEILINGS);
  check("a thread already warned is not warned again", again.allow === true && again.warn === null, JSON.stringify(again));

  // THE MARKER IS THE WARNING'S OWN TEXT, so there is no second state that can disagree with what
  // is on screen.
  check("the marker matches a real warning", alreadyWarned([softWarning(0.61, 0.5)]));
  check("...and is not matched by an ordinary message", !alreadyWarned(["why did the last run fail?"]));
  check("...nor by a null body", !alreadyWarned([null, null]));
  check("...and the marker is the prefix the writer uses", softWarning(1, 2).startsWith(SOFT_WARNING_MARK));
}

// --- the hard ceiling -------------------------------------------------------------------------

console.log("\n§12.1 — the hard ceiling refuses");
{
  const over = chatBudgetVerdict({ threadUsd: 0.01, dailyUsd: 2.4, warned: false }, CEILINGS);
  check("past the daily ceiling, the turn is refused", over.allow === false, JSON.stringify(over));
  // §12.2's SENTENCE, QUOTED. The figure comes from the ceiling that was actually set rather than
  // from the constant, so a workspace that raised it is told its own number.
  check("...with §12.2's exact sentence",
    !over.allow && over.reason === "Daily chat budget reached ($2.00). Raise it in settings or start again tomorrow.",
    over.allow ? "" : over.reason);
  check("...and a raised ceiling is quoted as itself",
    dailyRefusal(10) === "Daily chat budget reached ($10.00). Raise it in settings or start again tomorrow.",
    dailyRefusal(10));
  // THE HARD CEILING IS CHECKED FIRST. Telling somebody their conversation is expensive and then
  // refusing to answer it is two sentences where one will do.
  const both = chatBudgetVerdict({ threadUsd: 9, dailyUsd: 9, warned: false }, CEILINGS);
  check("a turn over BOTH ceilings is refused, not warned", both.allow === false, JSON.stringify(both));

  // A CEILING OF ZERO REFUSES EVERYTHING, which is a coherent setting — an administrator turning
  // conversational spend off — rather than an edge case.
  const off = chatBudgetVerdict({ threadUsd: 0, dailyUsd: 0, warned: false }, { threadUsd: 0, dailyUsd: 0 });
  check("a zero ceiling refuses everything", off.allow === false, JSON.stringify(off));
}

console.log("\nunknown spend does not block");
{
  // §10: UNKNOWN IS EXCLUDED FROM TOTALS RATHER THAN CONTRIBUTING ZERO — so a workspace whose every
  // chat turn ran on an unpriced model has `null`, and a ceiling that read that as "over" would
  // refuse somebody who had spent nothing measurable. This is also why the DAILY ceiling is the
  // hard one: money cannot bound an unpriced model at all, and §12 does not pretend otherwise.
  const unmeasured = chatBudgetVerdict({ threadUsd: null, dailyUsd: null, warned: false }, CEILINGS);
  check("nothing measured allows the turn", unmeasured.allow === true, JSON.stringify(unmeasured));
  check("...and says nothing about it", unmeasured.allow && unmeasured.warn === null, JSON.stringify(unmeasured));
}

// --- §12.2: the ceiling bounds chat ONLY ------------------------------------------------------
//
// "IT MUST NEVER BLOCK A RUN, A GENERATION, A DEPLOY OR AN EVAL — those have their own accounting
// and their own limits. A person who hits the chat ceiling can still work." That is a property of
// WHAT READS THIS MODULE, and there is exactly one reader.

console.log("\n§12.2 — it bounds chat only");
{
  const here = new URL(".", import.meta.url);
  const index = readFileSync(new URL("index.ts", here), "utf8");

  // ONE CALLER. A second would be a second thing to reason about, and the one thing §12.2 forbids
  // is this limit reaching a path that has its own.
  const callers = (index.match(/chatBudget\(/g) ?? []).length;
  check(`the budget is consulted in one place (${callers} call site + its definition)`, callers === 2, String(callers));
  check("...and that place is the chat route",
    /const budget = await chatBudget\(ctx, thread\);/.test(index), "");

  // AND THE FOUR PATHS §12.2 NAMES DO NOT CONSULT IT. Asserted by reading each dispatch's own
  // function for the call rather than by trusting that one caller implies three absences.
  for (const [what, fn] of [
    ["a run", "async function runAgent"],
    ["a generation", "function generateAgent"],
    ["a plan", "function planAgent"],
    // THE EVAL DISPATCH IS A CASE IN THE COMMAND SWITCH rather than a named function, which is why
    // this row names the case label: what is being asserted is that the path a user takes to start
    // one does not consult this limit, and the path is `case "startEval":`.
    ["an eval", 'case "startEval":'],
  ] as const) {
    const at = index.indexOf(fn);
    if (at < 0) { check(`${what}'s dispatch exists to check`, false, fn); continue; }
    // The body up to the next top-level declaration — crude, and enough: what is being asserted is
    // an ABSENCE, so a window that is too wide can only make the check stricter.
    const body = index.slice(at, at + 4000);
    check(`${what} does not consult the chat budget`, !/chatBudget\(/.test(body), fn);
  }
}

// --- §12.2's documented limit: it bounds what is STARTED --------------------------------------

console.log("\n§12.2 — an in-flight stream completes");
{
  const index = readFileSync(new URL("index.ts", import.meta.url), "utf8");
  // v0.1.9's DOCUMENTED LIMIT, APPLIED UNCHANGED: "the ceiling bounds what is started, not what is
  // already running — an in-flight stream completes. Do not quietly claim a stronger guarantee than
  // the eval engine makes."
  //
  // ASSERTED AS AN ABSENCE, which is the only way an "is not killed" claim can be made: the check
  // happens before the dispatch and nothing in the streaming path consults a ceiling, so there is
  // no mechanism that could kill a stream even if one were crossed underneath it.
  const chatFn = index.slice(index.indexOf("async function chatWithJaroku"));
  const body = chatFn.slice(0, chatFn.indexOf("\n}\n") + 3);
  const budgetAt = body.indexOf("await chatBudget(");
  const streamAt = body.indexOf("await streamExplain(");
  check("the budget is read before the stream opens", budgetAt > 0 && streamAt > budgetAt,
    `${budgetAt} vs ${streamAt}`);
  // AND NOTHING IN THE CALLBACKS REACHES FOR IT. `onDelta`, `onUsage`, `onDone`, `onStopped` and
  // `onError` are the whole of what runs while a stream is open.
  const callbacks = body.slice(streamAt);
  check("...and nothing while it is open consults a ceiling", !/chatBudget\(|dailyRefusal\(/.test(callbacks), "");
  // THE ONE THING THAT DOES STOP A STREAM IS §6.1's Stop, which is a user action and not a budget.
  check("...and the only thing that stops one is the user's Stop", /chatStops\.set\(thread, handle\.stop\)/.test(body), "");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

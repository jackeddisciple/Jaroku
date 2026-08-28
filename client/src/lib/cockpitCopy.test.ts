// §16's voice, held to its own six rules — and read as prose, which is the point of the module.
//
// "Words are interface." The rules §16 states are not preferences and they are not each other's
// synonyms: each one names a specific way this tab could look unfinished, and every one of them has
// happened to a real product. A hard-coded `(s)`. A "Sorry, something went wrong". A row reading
// `failed` where six failure kinds exist. A "two running" beside a "2 waiting".
//
// THE INTERESTING ASSERTIONS ARE THE ABSENCES, which is the same shape `colourSystem.test.ts` takes
// and for the same reason: a `(s)` does not fail, it renders. So half of this suite reads the
// module's OWN SOURCE rather than its exports, because a rule about how strings are written cannot
// be checked by calling them — a template that produces `job(s)` at every count produces it at 0, 1
// and 2 alike and would pass a purely behavioural test three times over.
//
// AND THE TWO VERBATIM SENTENCES ARE PINNED CHARACTER FOR CHARACTER. §7 requires `rejected`'s
// wording and both of `stopped_reporting`'s clauses; §21 requires Reconnect's. They are quoted in
// three documents and reworded by anybody tightening the copy, which is exactly why a test holds
// them rather than a comment asking nicely.
//
//   npm run test:cockpit-copy

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CLAUSE, COMPOSER, CONNECTION_LABEL, DESTRUCTIVE, DETAIL, EMPTY, FAILURE_SENTENCE, FILTERS,
  GATE, HEADER, LIVE, OFFLINE, PUBLIC_NOTE, REFUSAL, STATUS_WORD, count,
} from "./cockpitCopy.ts";
import type { WorkFailureKind } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE = readFileSync(`${HERE}cockpitCopy.ts`, "utf8");

/**
 * Every string this module can produce, flattened — the prose, as one block.
 *
 * FUNCTIONS ARE CALLED AT THREE COUNTS rather than skipped, because the counted strings are exactly
 * the ones the `(s)` rule is about and a walker that only collected the constants would miss all of
 * them. The names are placeholders a real workspace would fill; nothing asserts on them.
 */
function everyString(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  const add = (where: string, value: unknown): void => {
    if (typeof value === "string") out.push({ where, text: value });
    else if (typeof value === "function") {
      for (const arg of [0, 1, 2]) {
        const produced = (value as (a: unknown) => unknown)(arg);
        if (typeof produced === "string") out.push({ where: `${where}(${arg})`, text: produced });
      }
      const named = (value as (a: unknown) => unknown)("billing_bot");
      if (typeof named === "string") out.push({ where: `${where}(name)`, text: named });
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) add(`${where}.${key}`, inner);
    }
  };
  for (const [name, group] of Object.entries({
    CLAUSE, COMPOSER, CONNECTION_LABEL, DESTRUCTIVE, DETAIL, EMPTY, FAILURE_SENTENCE, FILTERS,
    GATE, HEADER, LIVE, OFFLINE, REFUSAL, STATUS_WORD, PUBLIC_NOTE,
  })) add(name, group);
  return out;
}

const ALL = everyString();

// --- 1. pluralisation, at 0, 1 and 2 ---------------------------------------------------------------

console.log("\nevery counted string, at nought, one and two");
{
  check(`the walker found the prose (${ALL.length} strings)`, ALL.length > 50, String(ALL.length));

  // §24 names this one: "pluralisation at 0, 1 and 2 for every counted string". Nought takes the
  // plural in English — "0 jobs", not "0 job" — which is the case a naive `n > 1` gets wrong and
  // the one a fixture written by hand never contains.
  check("0 takes the plural", count(0, "job") === "0 jobs", count(0, "job"));
  check("1 takes the singular", count(1, "job") === "1 job", count(1, "job"));
  check("2 takes the plural", count(2, "job") === "2 jobs", count(2, "job"));

  // AND THE IRREGULAR FORM IS A PARAMETER, not an appended `s`. "1 waiting on you" and "2 waiting
  // on you" are the same words, and a helper that pluralised by suffix would render "2 waiting on
  // yous" — which is the failure mode of every plural helper that assumes English is regular.
  check("an irregular plural is given rather than derived",
    count(2, "person", "people") === "2 people", count(2, "person", "people"));
  check("...and a noun whose plural IS its singular stays put",
    CLAUSE.waiting(2) === "2 waiting on you", CLAUSE.waiting(2));
  check("...at one as well", CLAUSE.waiting(1) === "1 waiting on you", CLAUSE.waiting(1));

  check("the jobs clause pluralises", CLAUSE.jobsToday(1) === "1 job today" && CLAUSE.jobsToday(2) === "2 jobs today",
    `${CLAUSE.jobsToday(1)} / ${CLAUSE.jobsToday(2)}`);
  check("the pill pluralises without a noun to pluralise",
    LIVE.pill(1) === "1 new" && LIVE.pill(3) === "3 new", `${LIVE.pill(1)} / ${LIVE.pill(3)}`);
}

// --- 2. no `(s)`, ever -----------------------------------------------------------------------------

console.log("\nthe fastest way to look unfinished");
{
  // AGAINST THE SOURCE AND NOT THE OUTPUT. A template holding `job(s)` produces it identically at
  // every count, so three behavioural fixtures agree with each other and all three are wrong.
  const parenthesised = SOURCE.match(/\w\(s\)/g) ?? [];
  check("no string carries a parenthesised plural", parenthesised.length === 0, parenthesised.join(", "));

  const rendered = ALL.filter((s) => /\(s\)|\(es\)/.test(s.text));
  check("...and none is produced either", rendered.length === 0, rendered.map((s) => s.where).join(", "));
}

// --- 3. numerals always ----------------------------------------------------------------------------

console.log("\nnumerals, even below ten");
{
  // "A figure the eye can catch beats a word it has to read." The count words are what a template
  // reaches for when somebody decides a digit looks abrupt — and this surface is scanned, so the
  // digit is the whole value of the string.
  const WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten) (job|run|agent|new|running|queued|waiting)/i;
  const spelled = ALL.filter((s) => WORDS.test(s.text));
  check("no counted string spells its number", spelled.length === 0,
    spelled.map((s) => `${s.where}: ${s.text}`).join(" | "));
}

// --- 4. no pleading and no apologising -------------------------------------------------------------

console.log("\nsay what happened and what to do");
{
  const PLEADING = /\b(please|sorry|oops|whoops|unfortunately|we apologi[sz]e)\b/i;
  const pleading = ALL.filter((s) => PLEADING.test(s.text));
  check("nothing pleads or apologises", pleading.length === 0,
    pleading.map((s) => `${s.where}: ${s.text}`).join(" | "));

  // "Please try again" is the specific phrase §16 rules out, and it is the one that arrives with a
  // retry control beside it — where it is not merely limp but redundant.
  check("...and 'try again' in particular is absent",
    !ALL.some((s) => /try again/i.test(s.text)));
}

// --- 5. six failure kinds, six sentences -----------------------------------------------------------

console.log("\nnever 'failed' alone");
{
  const KINDS: WorkFailureKind[] = [
    "unauthorised", "agent_error", "rejected", "unreachable", "stopped_reporting", "busy",
  ];
  check("every kind has a sentence", KINDS.every((k) => (FAILURE_SENTENCE[k] ?? "").length > 0));

  const sentences = KINDS.map((k) => FAILURE_SENTENCE[k]);
  check("six kinds, six different sentences", new Set(sentences).size === 6, sentences.join(" | "));

  // THE WHOLE REASON THE CLOSED SET EXISTS. A kind rendered as the bare word throws away the one
  // thing the schema was for, and a kind rendered as its own enum name is worse — it is the column
  // heading, on screen, in front of somebody who does not have the schema.
  const lazy = KINDS.filter((k) => {
    const s = FAILURE_SENTENCE[k].toLowerCase();
    return s === "failed" || s === "failed." || s.includes(k);
  });
  check("no sentence is the word 'failed' or its own enum name", lazy.length === 0, lazy.join(", "));

  // AN ERROR NAMES THE THING, THEN THE ACTION — §16, "two sentences, in that order". The kinds with
  // an action carry two; the ones that are a bare fact carry one, and that is correct rather than
  // an omission: there is nothing for a reader to do about a container that was at capacity.
  check("the credential failure names the fact and then the action",
    FAILURE_SENTENCE.unauthorised === "The stored token is wrong. Reconnect this agent.",
    FAILURE_SENTENCE.unauthorised);

  // VERBATIM. §7 calls this the most important sentence in the list and quotes it exactly.
  check("`rejected` is worded as Jaroku's bug, verbatim",
    FAILURE_SENTENCE.rejected === "Jaroku sent something this agent refused — this is a bug on our side.",
    FAILURE_SENTENCE.rejected);

  // VERBATIM, BOTH CLAUSES. §16: "Never invent certainty. 'May have' is a real and correct phrase
  // when the record is genuinely ambiguous. Do not edit the hedge out to make the copy read
  // tighter." The hedge is there because the FACT is hedged — the container went quiet.
  check("`stopped_reporting` keeps both clauses and both hedges",
    FAILURE_SENTENCE.stopped_reporting ===
      "The container stopped reporting. It may have completed, and it may have spent money.",
    FAILURE_SENTENCE.stopped_reporting);
  check("...which is two 'may have's and not one",
    (FAILURE_SENTENCE.stopped_reporting.match(/may have/g) ?? []).length === 2);
}

// --- 6. second person for the reader, third for the agent ------------------------------------------

console.log("\nwho the sentences are about");
{
  check("the waiting clause is addressed to the reader", /\byou\b/.test(CLAUSE.waiting(1)), CLAUSE.waiting(1));
  check("the agent is 'the agent' or 'it', never 'we'",
    !ALL.some((s) => /\bwe (are|will|have|cannot|can't)\b/i.test(s.text)),
    ALL.filter((s) => /\bwe \w/i.test(s.text)).map((s) => s.where).join(", "));
  check("...and never first person singular",
    !ALL.some((s) => /\bI\b/.test(s.text)));
}

// --- 7. sentence case, and the one exception -------------------------------------------------------

console.log("\nsentence case everywhere but the panel label");
{
  // THE CAPS RECIPE IS `TYPE.panelLabel`'s AND IT IS A CLASS, not a string — which is exactly why
  // no string in here may be shouted. A caps string would render caps wherever it landed and would
  // survive a change to the recipe, which is the drift the token file exists to stop.
  const shouted = ALL.filter((s) => s.text.length > 3 && s.text === s.text.toUpperCase() && /[A-Z]/.test(s.text));
  check("nothing is written in capitals", shouted.length === 0,
    shouted.map((s) => `${s.where}: ${s.text}`).join(" | "));

  // Title Case is the other half and the commoner one: a label reading "Open The Trace" is what
  // happens when somebody capitalises by ear rather than by rule.
  const titled = ALL.filter((s) => {
    const words = s.text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
    if (words.length < 3) return false;
    // "Jaroku" and a workspace's own agent name are proper nouns and stay capitalised.
    const caps = words.slice(1).filter((w) => /^[A-Z]/.test(w) && w !== "Jaroku" && w !== "Railway" && w !== "Reconnect" && w !== "It" && w !== "The");
    return caps.length >= 2;
  });
  check("nothing is Title Cased", titled.length === 0, titled.map((s) => `${s.where}: ${s.text}`).join(" | "));
}

// --- 8. the strings the rest of the tab is required to say -----------------------------------------

console.log("\nthe phrases three documents quote");
{
  // §8: the destination label is always visible, above the input, and says these four words.
  check("the composer's destination says it will run for real",
    COMPOSER.destination("billing_bot") === "billing_bot — will run for real",
    COMPOSER.destination("billing_bot"));

  // §21, verbatim from Part 2, and the one sentence this codebase spells in exactly one place.
  check("Reconnect states the offline consequence verbatim",
    DESTRUCTIVE.reconnect.warning.startsWith("This will briefly take the agent offline"),
    DESTRUCTIVE.reconnect.warning);

  // §21: Kill's dialog names the agent, because a dialog that does not is one somebody confirms
  // over the wrong card in a strip of forty.
  check("Kill names the agent it is about",
    DESTRUCTIVE.kill.warning("billing_bot").includes("billing_bot"),
    DESTRUCTIVE.kill.warning("billing_bot"));

  // §9: `connected` announces nothing. Healthy is not a thing to announce.
  check("a healthy connection has no word", CONNECTION_LABEL.connected === null);
  check("...and the other three do",
    CONNECTION_LABEL.unconnected === "Not connected"
    && CONNECTION_LABEL.unauthorised === "Credential refused"
    && CONNECTION_LABEL.public === "Public URL");

  // §9 requires a word or a mark beside `warn`, and this is the word.
  check("public carries a sentence beside its colour", PUBLIC_NOTE.length > 20, PUBLIC_NOTE);

  // §5: "Idle is a real answer and a better one than an empty line."
  check("idle is a real answer", CLAUSE.idle === "Idle");

  // §10: three empty states, three sentences, and each carries its action.
  check("the three empty states are three different sentences",
    new Set([EMPTY.noAgents.title, EMPTY.noWork.title, EMPTY.filtered.title]).size === 3);
  check("...and the two that have somewhere to go say so",
    EMPTY.noAgents.action.length > 0 && EMPTY.filtered.action.length > 0);
  check("...and the first names the Deploy panel", /Deploy panel/.test(EMPTY.noAgents.hint), EMPTY.noAgents.hint);

  // §14: the reason names the capability in human words rather than in a permission string.
  const refusals = Object.values(REFUSAL);
  check("every refusal names a capability", refusals.every((r) => /capability/.test(r)));
  check("...and reads as a sentence rather than a code", refusals.every((r) => r.endsWith(".")));

  // §17: the em dash carries a tooltip saying why, and the two reasons are different facts.
  // Widened to `string` before comparing: `DETAIL` is `as const`, so TypeScript reads the two as
  // non-overlapping literal types and refuses the comparison as unintentional — which is the
  // compiler proving the assertion at build time and then declining to let it be made at run time.
  check("the two cost absences are two different sentences",
    (DETAIL.costUnknown as string) !== (DETAIL.costPartial as string));
  check("...and neither of them is a number", !/\$/.test(DETAIL.costUnknown + DETAIL.costPartial));

  // §7: a truncated output says so where the text ends.
  check("truncation is announced rather than silent", DETAIL.truncated.length > 10, DETAIL.truncated);

  // §10: offline freezes the figures and says they are frozen.
  check("the offline notice states the staleness", /last update/.test(OFFLINE.frozen), OFFLINE.frozen);

  // §12: the live region announces `waiting` and only `waiting`, so its one sentence is about that.
  check("the announcement is about waiting on a person",
    /waiting on you/.test(HEADER.announce("billing_bot")), HEADER.announce("billing_bot"));

  // §8: the gate asks a question rather than announcing a state.
  check("the gate asks", GATE.title.endsWith("?"), GATE.title);
  check("...and its confirming control says what it will do rather than 'OK'",
    /dispatch/i.test(GATE.confirm), GATE.confirm);

  // §14: the mine/all toggle is a filter, not a permission — so neither label reads as a refusal.
  check("neither scope label reads as a refusal",
    !/cannot|not allowed|permission/i.test(FILTERS.scope.mine + FILTERS.scope.all));

  // §9: every status has a word, because colour is never the only signal.
  check("all six statuses have a word", Object.values(STATUS_WORD).filter((w) => w.length > 0).length === 6);
  check("...and `waiting` says who is blocking", STATUS_WORD.waiting === "waiting on you");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

// A ROW THAT SPENDS TWO LINES SAYING ONE THING.
//
// `label={r.label ?? r.runId.slice(0, 8)}` beside `sub={r.runId.slice(0, 8)}` — the fallback and
// the sub are the same expression, so every run without a label rendered `1c7c8878` over
// `1c7c8878`. Six of the rows on screen in the audit did. It is a two-line fix and it is here
// rather than at the call site because the same collapse can arrive from the DATA — an agent whose
// display name is its slug, a kind whose payer is its own name — and a fix at one call site would
// only cover the one way it was noticed.
//
// THE ASSERTIONS ABOUT WHAT MUST STILL RENDER ARE THE OTHER HALF. A suppressor that is slightly too
// eager takes the sub off rows that were carrying a real second fact, which is a worse row than the
// duplicated one: nothing on screen says a fact was dropped.
//
//   npm run test:row-facts

import { distinctSub } from "./rowFacts.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe rows the audit found — an id over the same id");
{
  for (const id of ["1c7c8878", "2074fb03", "54e6136f", "6a4ab96c", "70a92150", "77ab20b2"]) {
    check(`${id} over ${id} collapses to one line`, distinctSub(id, id) === undefined);
  }
}

console.log("\nthe rows that were always right keep both lines");
{
  // The shape the section exists for: an agent name over a short run id.
  check("an agent over a run id", distinctSub("test_agent", "389aeae2") === "389aeae2");
  check("a name over a run count", distinctSub("Support bot", "12 runs") === "12 runs");
  check("a kind over a payer", distinctSub("llm.generation", "platform") === "platform");
}

console.log("\nthe same fact told twice is still one fact");
{
  // A display name that IS the slug is the way this arrives from data rather than from JSX.
  check("case is not a second fact", distinctSub("Test_Agent", "test_agent") === undefined);
  check("...in the other direction too", distinctSub("test_agent", "Test_Agent") === undefined);
  check("a trailing space is not a second fact", distinctSub("test_agent", "test_agent ") === undefined);
  check("...nor a leading one", distinctSub("test_agent", "  test_agent") === undefined);
}

console.log("\nnothing to say renders nothing rather than an empty line");
{
  // Undefined rather than "": the row renders the element conditionally, and an empty second line
  // would leave its vertical space under every row that has nothing for it.
  check("undefined stays undefined", distinctSub("test_agent", undefined) === undefined);
  check("null too", distinctSub("test_agent", null) === undefined);
  check("an empty string too", distinctSub("test_agent", "") === undefined);
  check("...and whitespace is empty", distinctSub("test_agent", "   ") === undefined);
}

console.log("\na sub that survives comes back unchanged");
{
  // Compared after trimming, RETURNED as it was: the caller's string is what the row renders, and
  // silently trimming it here would be this function editing copy it was only asked to judge.
  check("spacing inside is preserved", distinctSub("agent", " 12 runs ") === " 12 runs ");
  check("the identity is the caller's", distinctSub("agent", "389aeae2") === "389aeae2");
}

console.log("\nthe rule is not stuck at either answer");
{
  check("it suppresses something", distinctSub("x", "x") === undefined);
  check("and keeps something", distinctSub("x", "y") === "y");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

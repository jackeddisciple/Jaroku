// The display-title helper, against the real shape of the data.
//
// The case that matters is the one in the header today: a 60-character server cut landing inside
// "Postgres". The cases that matter almost as much are the ones where nothing was cut — a name must
// never be shortened on suspicion.
//
//   npm run test:title

import { displayTitle, fullTitle } from "./title.ts";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

// The live example: server cut the prompt at 60 chars, mid-"Postgres".
const PROMPT = "a support agent that reads Gmail, looks up orders in Postgres, and drafts replies";
const CUT = PROMPT.slice(0, 60); // "…looks up orders in Postgre"
eq("the cut is what we think it is", CUT, "a support agent that reads Gmail, looks up orders in Postgre");
eq("partial word is dropped, ellipsis added",
  displayTitle(CUT, PROMPT),
  "a support agent that reads Gmail, looks up orders in…");
eq("tooltip carries the whole prompt", fullTitle(CUT, PROMPT), PROMPT);

// A cut that happened to land on a word boundary: nothing to drop, but there is still more to say.
{
  const prompt = "an agent that summarises long customer support threads into one line for triage";
  const cut = prompt.slice(0, 60);
  eq("boundary cut keeps every whole word, gains an ellipsis",
    displayTitle(cut, prompt),
    `${cut.trimEnd()}…`);
}

// --- names that must come back untouched -------------------------------------------
eq("a short name is never touched",
  displayTitle("weather bot", "weather bot that answers questions about the forecast"),
  "weather bot");
eq("a typed name is not the head of the description, so it stands",
  displayTitle("Order Lookup Bot".padEnd(60, "!"), PROMPT),
  "Order Lookup Bot".padEnd(60, "!"));
eq("exactly at the cap with nothing beyond it is not a truncation",
  displayTitle(CUT, CUT),
  CUT);
eq("no description means nothing can be proven", displayTitle(CUT), CUT);
eq("empty name survives", displayTitle("", PROMPT), "");

// --- shape ---------------------------------------------------------------------------
eq("tooltip falls back to the name when there is no more",
  fullTitle("weather bot", "weather bot"),
  "weather bot");
eq("tooltip falls back to the name with no description at all",
  fullTitle("weather bot"),
  "weather bot");
{
  // A multi-line prompt: the name comes from the first line, so only the first line can restore it.
  const multi = `${PROMPT}\n\nAlso: never send mail.`;
  eq("only the first line is used to restore",
    displayTitle(CUT, multi),
    "a support agent that reads Gmail, looks up orders in…");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

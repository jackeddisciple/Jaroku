// The prose tokenizer, checked on the sentences the panel actually renders.
//
// The failure mode worth testing is not "missed an identifier" — that just leaves a word plain. It
// is the opposite: chipping ordinary English until the distinction stops meaning anything. Most of
// these cases are there to hold that line.
//
//   npm run test:inline-code

import { segmentProse } from "./inlineCode.ts";

let fail = 0;
/** The identifiers a sentence yields, in order. */
const chips = (text: string, vocab: string[] = []) =>
  segmentProse(text, vocab).filter((s) => s.code).map((s) => s.text);

const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

// --- the sentences from real plans -------------------------------------------------
eq("plan note names a tool",
  chips("pg_query is read-only and takes a static SQL string; order filters are passed as arguments, not interpolated."),
  ["pg_query"]);
eq("state field in a sentence",
  chips("current_email is optional and cleared between requests."),
  ["current_email"]);
eq("a SQL clause",
  chips("The SQL tool needs a LIMIT clause."),
  ["LIMIT"]);
eq("a rule reference",
  chips("Rejected by rule E1 — the tool was called directly."),
  ["E1"]);
eq("a file path",
  chips("The connector template is copied into tools/postgres.py unchanged."),
  ["tools/postgres.py"]);
eq("a type name",
  chips("the support conversation is threaded through as MessagesState"),
  ["MessagesState"]);
eq("several in one sentence",
  chips("Agent must extract order id from email content before calling order_lookup()."),
  ["order_lookup()"]);

// --- what must stay plain ----------------------------------------------------------
eq("ordinary prose is untouched",
  chips("Will be written by the model for this agent."),
  []);
eq("product names are not identifiers",
  chips("Reads Gmail, looks up orders in Postgres, and drafts replies."),
  []);
eq("lowercase sql words are prose",
  chips("the query is limited to twenty rows and ordered by date"),
  []);
eq("a plain-word state name is NOT chipped in prose",
  // `messages` is a real state field, but chipping it here would decorate English.
  chips("agent (llm) reads messages and state, then decides what to do", ["messages"]),
  []);
eq("a plain-word state name IS chipped when the plan spells it as code",
  chips("agent reads `messages` and state", ["messages"]),
  ["messages"]);

// --- vocabulary ---------------------------------------------------------------------
eq("a plan's own tool name, unusual shape",
  chips("summarize_issue condenses the thread.", ["summarize_issue"]),
  ["summarize_issue"]);
eq("longest vocabulary term wins",
  chips("current_order_id is derived from current_order.", ["current_order", "current_order_id"]),
  ["current_order_id", "current_order"]);
// The vocabulary is word-bounded: without \b this would have chipped the bare `pg_query` out of
// the middle of a longer word. The longer word is still snake_case-shaped, so the generic rule
// picks it up whole — which is right; it just isn't the tool.
eq("a vocabulary term inside a longer word is not matched on its own",
  chips("The pg_queryish helper is not the tool.", ["pg_query"]),
  ["pg_queryish"]);

// --- precedence and reassembly -------------------------------------------------------
eq("backticks win, and are stripped",
  chips("Call `pg_query` first."),
  ["pg_query"]);
eq("an identifier is claimed once, not twice",
  chips("`order_lookup` runs first.").length,
  1);
{
  const text = "pg_query is read-only; call order_lookup() after.";
  eq("segments rejoin to the original text",
    segmentProse(text).map((s) => s.text).join(""),
    text);
}
eq("empty input yields nothing", segmentProse(""), []);
eq("text with no identifiers is one plain run",
  segmentProse("Nothing to see here.").map((s) => s.code),
  [false]);

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

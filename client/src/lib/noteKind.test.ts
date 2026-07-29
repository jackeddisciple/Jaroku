// The constraint/info classifier, checked against notes real plans actually produce.
//
// A heuristic with no test is a guess that nobody can revise safely: change one marker and there is
// no way to tell what you broke. These cases are the ones that matter — the rules a user must not
// miss, and the descriptions that must not be dressed up as rules.
//
//   npm run test:note-kind

import { noteKind } from "./noteKind.ts";

let fail = 0;
const is = (kind: "constraint" | "info", note: string) => {
  const got = noteKind(note);
  if (got === kind) console.log(`  ok   ${kind.padEnd(10)} ${note.slice(0, 62)}`);
  else { fail++; console.log(`  FAIL wanted ${kind}, got ${got}\n    ${note}`); }
};

// --- rules: what the agent will and will not do ------------------------------------
is("constraint", "Drafts replies only — never sends. Sending requires a Gmail scope the connector does not grant.");
is("constraint", "Agent must extract order id from email content before calling order_lookup.");
is("constraint", "order_lookup is bespoke because postgres connector is read-only; agent will call it with an order id extracted from context.");
is("constraint", "The SQL tool cannot write — every query is SELECT only.");
is("constraint", "It won't retry a failed tool call.");
is("constraint", "The agent always ends its turn after drafting.");
is("constraint", "Deleting messages is not allowed.");
is("constraint", "The model refuses requests outside the support domain.");

// --- descriptions: how the thing works ---------------------------------------------
is("info", "current_email is optional and cleared between requests.");
is("info", "State is threaded through every node as a MessagesState.");
is("info", "The graph loops between agent and tools until the model stops calling tools.");
is("info", "Order lookups hit the read replica, so results can lag by a second.");
is("info", "Costs are estimated from the provider's published per-token pricing.");

// --- the words that were left out on purpose ---------------------------------------
// "requires" and "is not" turn up in plain description as often as in prohibition, so they are
// not markers. These stay info even though a looser list would have caught them.
is("info", "Running this agent requires a Postgres connection string in the environment.");
is("info", "The reply is not persisted anywhere outside the run.");

// --- shape ------------------------------------------------------------------------
is("info", "");
// Case-insensitive, and markers only match whole words: "Never" counts, "nevertheless" does not.
is("constraint", "NEVER sends mail on the user's behalf.");
is("info", "Nevertheless the agent will summarise what it found.");
// "only" inside a longer word must not fire.
is("info", "The tool returns a read-onlyish view of the row.");

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

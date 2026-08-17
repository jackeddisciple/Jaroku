// §5's title, and the one thing it must never do.
//
// The interesting cases are all about honesty of the cut. A title that stops mid-word says nothing
// about having been shortened — that is the bug `client/src/lib/title.ts` exists to repair for agent
// names, and this is the same rule applied at the point of the cut so there is nothing to repair.
//
// The other half of §5 is not about the cut at all: auto-titling must never overwrite a name somebody
// typed. That guarantee lives in the store's UPDATE and is asserted in `test:threads`; it is named
// here so a reader of this file knows where it went.
//
//   npm run test:thread-title

import { threadTitle, TITLE_CAP } from "./threadTitle.ts";
import { UNTITLED } from "./threadStore.ts";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown): void => {
  if (got === want) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

// --- a short message is a short title, and that is fine (§5) --------------------------------
eq("a short message is the title, untouched", threadTitle("fix this"), "fix this");
eq("surrounding whitespace goes", threadTitle("   add retries   "), "add retries");
eq("nothing said is nothing to title from", threadTitle(""), UNTITLED);
eq("...and whitespace is nothing said", threadTitle("\n   \n"), UNTITLED);

// --- one line, always -----------------------------------------------------------------------
eq("the first line is the title",
  threadTitle("why is it 401ing on refresh?\n\nhere is the traceback:\n  File \"x.py\""),
  "why is it 401ing on refresh?");
eq("a leading blank line does not make the title blank",
  threadTitle("\nadd exponential backoff"),
  "add exponential backoff");

// --- the cut ---------------------------------------------------------------------------------
{
  const long = "a support agent that reads Gmail, looks up orders in Postgres, and drafts replies";
  const title = threadTitle(long);
  eq("a long first line is cut", title !== long, true);
  // The real assertion about the boundary: the kept text is a prefix of the original that ends
  // exactly where a word does. A regex for "ends in a word character before the ellipsis" would pass
  // for a clean cut AND a mid-word one — a complete word also ends in a word character — which is
  // the sort of check that looks like it holds the rule down and holds nothing.
  const kept = title.slice(0, -1);
  eq("...at a word boundary, never mid-word", long.startsWith(`${kept} `), true);
  eq("...and says it was cut", title.endsWith("…"), true);
  eq("...to the exact string the cap and the boundary imply",
    title, "a support agent that reads Gmail, looks up orders in…");
  eq("...within the cap, ellipsis and all", title.length <= TITLE_CAP + 1, true);
}
{
  // The case a naive "trim the partial word" would turn into an ellipsis on its own: one word
  // longer than the cap, with no boundary to fall back to.
  const url = `https://example.com/${"a".repeat(80)}`;
  const title = threadTitle(url);
  eq("a single over-long word is cut rather than erased", title.length > 10, true);
  eq("...and still says it was cut", title.endsWith("…"), true);
}
{
  // A cut that lands just after a comma should not read as "…in Postgres,…".
  const title = threadTitle("read the mailbox, look up the order, draft a reply, and never send it");
  eq("trailing punctuation goes with the cut", /[\s,;:.]…$/.test(title), false);
}
{
  const exact = "x".repeat(TITLE_CAP);
  eq("a line exactly at the cap is not a truncation", threadTitle(exact), exact);
  eq("...and one character more is", threadTitle(`${exact}y`).endsWith("…"), true);
}

// --- deterministic, because it is not a model call -------------------------------------------
{
  const message = "run the full support dataset on both providers and tell me which is cheaper";
  eq("the same message always produces the same title",
    threadTitle(message), threadTitle(message));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

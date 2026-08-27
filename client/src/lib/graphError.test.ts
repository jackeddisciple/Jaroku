// AN EMPTY STATE THAT ANSWERS TWO OF §30'S THREE QUESTIONS AND CONTRADICTS ITSELF ON THE FIRST.
//
//   No graph for this version yet
//   ContractError: cannot import agents.working_agent.agent: No module named 'agents.working_agent'
//
// "Not yet" says wait. A hard import failure is not something waiting fixes. Between the two is an
// internal Python module path, and after them is no next step at all.
//
// THE STRING IS TRUE, which is why the fix is a mapping rather than a filter. `graph_cache` is null,
// the manifest is empty and there is no project on this replica — the server is giving an accurate
// account of what happened, in the vocabulary of the process it happened in.
//
// THE ASSERTIONS THAT MATTER MOST ARE THE TWO NEGATIVES. An unrecognised failure must keep its raw
// string as the sentence, because a default that swallowed it into "something went wrong" would be
// strictly worse than what this replaces; and no mapped title may say "yet", because that is the
// word that made the panel contradict itself.
//
//   npm run test:graph-error

import { graphErrorCopy, isMappedGraphError } from "./graphError.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** The exact string the audit read off the screen. */
const AUDIT = "ContractError: cannot import agents.working_agent.agent: No module named 'agents.working_agent'";

console.log("\nthe failure the audit reproduced");
{
  const copy = graphErrorCopy(AUDIT);
  check("it is recognised", isMappedGraphError(AUDIT));
  check("the title says the code could not load", copy.title === "This agent's code could not be loaded", copy.title);
  // The word that made the panel contradict itself.
  check("...and does not say 'yet'", !/\byet\b/i.test(copy.title), copy.title);
  check("the sentence says there is nothing to draw rather than nothing yet",
    copy.sentence.includes("nothing to draw"));
  check("there is a next step", copy.next !== null, String(copy.next));
  // The module path is not gone — it is behind the disclosure, which is what the panel renders it in.
  check("the raw string is kept", copy.raw === AUDIT);
}

console.log("\nno mapped title tells somebody to wait for a failure");
{
  const cases = [
    AUDIT,
    "ModuleNotFoundError: No module named 'tools.postgres'",
    "ImportError: cannot import name 'require_enabled'",
    "could not read this agent's files",
    "ENOENT: no such file or directory",
    "the introspection timed out after 20000ms",
    "no graph available",
  ];
  for (const err of cases) {
    const copy = graphErrorCopy(err);
    check(`"${err.slice(0, 42)}…" does not say 'yet'`, !/\byet\b/i.test(copy.title), copy.title);
  }
}

console.log("\nthe classes are told apart, and by the more specific one");
{
  check("a missing module is an import failure",
    graphErrorCopy("No module named 'agents.x'").title === "This agent's code could not be loaded");
  check("unreadable files are their own class",
    graphErrorCopy("could not read this agent's files").title === "This agent's files are not on this machine");
  check("a timeout is its own class",
    graphErrorCopy("the introspection timed out").title === "Introspecting this graph timed out");
  check("an empty answer is its own class",
    graphErrorCopy("no graph available").title === "No graph to show");
  // An import failure whose message also names a path must read as the import failure: that is the
  // sharper diagnosis and its next step is a different one.
  const both = graphErrorCopy("ImportError: no such file or directory: tools/postgres.py");
  check("import wins over path when a message contains both",
    both.title === "This agent's code could not be loaded", both.title);
}

console.log("\nan unrecognised failure keeps its own words");
{
  const weird = "SIGSEGV in the introspection sandbox (signal 11)";
  const copy = graphErrorCopy(weird);
  check("it is not claimed as mapped", isMappedGraphError(weird) === false);
  check("the raw string IS the sentence", copy.sentence === weird, copy.sentence);
  // Which is why the panel does not also disclose it — the disclosure would repeat the sentence.
  check("...and the title is honest about not knowing", copy.title === "This graph could not be drawn");
  check("the raw string is still carried", copy.raw === weird);
}

console.log("\nthere is always a definite answer, because the caller is already in the failure branch");
{
  for (const nothing of ["", "   ", undefined, null]) {
    const copy = graphErrorCopy(nothing);
    check(`${JSON.stringify(nothing)} still produces a title`, copy.title.length > 0);
    check(`...and a sentence`, copy.sentence.length > 0, copy.sentence);
    check(`...and is not claimed as mapped`, isMappedGraphError(nothing) === false);
  }
}

console.log("\nevery mapped class offers a retry, and none of them promises one that cannot work");
{
  for (const err of [AUDIT, "could not read this agent's files", "timed out", "no graph available"]) {
    check(`"${err.slice(0, 30)}…" is retryable`, graphErrorCopy(err).retryable === true);
  }
  // The next step is null where there honestly is not one beyond retrying — an invented action is
  // the same defect as an absent one, one step further on.
  check("a timeout offers no invented next step", graphErrorCopy("timed out").next === null);
  check("...and an import failure does offer one", graphErrorCopy(AUDIT).next !== null);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

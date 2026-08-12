// CSV reader — written out rather than split(",") because the failure mode is silent and
// expensive: a naive split mangles any field containing a comma, quote, or newline (which
// is most real support queries), and the result isn't an error — it's a dataset of subtly
// wrong examples that then run against every provider at full cost.
//
//   npm run test:csv

import { csvToExamples, parseCsv } from "./csv.ts";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};
const check = (name: string, ok: boolean) => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}`); }
};

// --- the shapes split(",") gets wrong ---------------------------------------------
eq("plain", parseCsv("a,b\nc,d").rows, [["a", "b"], ["c", "d"]]);
eq("quoted comma", parseCsv(`"a,b",c`).rows, [["a,b", "c"]]);
eq("embedded newline", parseCsv(`"line1\nline2",x`).rows, [["line1\nline2", "x"]]);
eq("doubled quote", parseCsv(`"say ""hi""",x`).rows, [[`say "hi"`, "x"]]);
eq("crlf", parseCsv("a,b\r\nc,d\r\n").rows, [["a", "b"], ["c", "d"]]);
eq("trailing newline makes no empty row", parseCsv("a\nb\n").rows, [["a"], ["b"]]);
eq("empty quoted field survives", parseCsv(`"",x`).rows, [["", "x"]]);

// --- column resolution --------------------------------------------------------------
eq("header detected", csvToExamples("input,expected\nadd milk,Task added").examples,
  [{ input: "add milk", expected: "Task added" }]);
eq("header aliases", csvToExamples("prompt,answer\nq1,a1").examples,
  [{ input: "q1", expected: "a1" }]);
eq("headerless falls back to positional", csvToExamples("add milk,Task added\nlist,Listed").examples,
  [{ input: "add milk", expected: "Task added" }, { input: "list", expected: "Listed" }]);
// A list of inputs with no ground truth is a perfectly good dataset — the judge scores
// against the rubric, not a diff.
eq("single column = inputs only", csvToExamples("add milk\nlist tasks").examples,
  [{ input: "add milk", expected: null }, { input: "list tasks", expected: null }]);

// --- rows that would become runs with nothing to do ----------------------------------
eq("blank inputs dropped", csvToExamples("input,expected\n,x\nreal,y").examples,
  [{ input: "real", expected: "y" }]);
{
  const r = csvToExamples("input\n,\n");
  eq("blank-only file yields nothing", r.examples, []);
  check("warns about skipped rows", r.warnings.length > 0);
}
check("warns on an unterminated quote", parseCsv(`"unterminated`).warnings.length > 0);

// --- what a SECTIONED export does to this parser ---------------------------------------
//
// The usage export writes several tables into one file, separated by a blank line — an agent, a
// run and a kind are different units, and one flat sheet would need a `type` column and a lot of
// empty ones. That blank line is not a trailing newline and must not be read as one: this parser
// drops empty rows so a file ending in a newline does not become an example, and the same rule
// applied to a separator would silently weld two tables together with mismatched headers.
{
  const sectioned = ["a,b", "1,2", "", "c,d", "3,4"].join(String.fromCharCode(13, 10));
  const parsed = parseCsv(sectioned);
  const headers = parsed.rows.filter((r) => r[0] === "a" || r[0] === "c").length;
  check("two headers survive a blank separator", headers === 2);
  check(
    "and the rows after the separator are not folded into the first table",
    parsed.rows.some((r) => r[0] === "3" && r[1] === "4"),
  );
}

// --- the case this all exists for ------------------------------------------------------
eq("realistic support query with commas and quotes",
  csvToExamples(`input,expected\n"Where is order #123, and why is it late?","Order 123 is delayed"`).examples,
  [{ input: "Where is order #123, and why is it late?", expected: "Order 123 is delayed" }]);

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

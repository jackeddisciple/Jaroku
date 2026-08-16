// The cheap half of the validator, on a buffer nobody has saved.
//
// THE PROPERTY THIS SUITE EXISTS FOR is agreement, not coverage: a squiggle that says something the
// commit-time gate does not, or stays silent about something the gate refuses, is worse than no
// squiggle — a person would have learned to trust it and be surprised at the moment it costs most.
// So the regex checks are asserted against the SAME exported patterns `validateProject` uses, and
// the AST script's SQL predicate is the gate's own, character for character.
//
// AND THE ABSENCE THAT IS ALSO A PROPERTY: the sandboxed import check does not run here. It is the
// one v0.1.0's changelog names as catching what AST parsing cannot, and running it on every
// keystroke would quietly invert §3/§4's ordering rule — cheapest first, import last.
//
// The AST half needs a Python interpreter, so it is skipped when there is no runtime. The regex and
// contract halves are pure and always run, which is most of what a person sees.
//
//   npm run test:live-diagnostics

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  astDiagnostics, contractDiagnostics, liveDiagnostics, regexDiagnostics, DEBOUNCE_MS,
} from "./liveDiagnostics.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const RUNTIME_DIR = join(process.cwd(), "..", "runtime");
const hasRuntime = existsSync(join(RUNTIME_DIR, "pyproject.toml"));

const rules = (ds: { rule: number | null }[]): string => ds.map((d) => String(d.rule)).join(",");

console.log("\nthe regex rules, on the lines they are about");
{
  const source = [
    "import os",
    "from jaroku import runner",
    "from langchain_anthropic import ChatAnthropic",
    "",
    "def go(x):",
    "    print(x)",
    "    print(x, file=sys.stderr)",
    "    logger.print(x)",
    "",
  ].join("\n");
  const ds = regexDiagnostics("agent.py", source);

  check(ds.some((d) => d.rule === 1 && d.line === 2), "rule 1 lands on the import line, not on line 1", JSON.stringify(ds));
  check(ds.some((d) => d.rule === 2 && d.line === 3), "rule 2 lands on its own line too");
  check(ds.some((d) => d.rule === 3 && d.line === 6), "rule 3 lands on the print");

  // Both of these are the gate's own carve-outs, and a live checker that flagged either would put a
  // permanent squiggle under code the commit path is perfectly happy with.
  check(!ds.some((d) => d.rule === 3 && d.line === 7), "print(..., file=sys.stderr) is documented and allowed");
  check(!ds.some((d) => d.rule === 3 && d.line === 8), "and a method called print on something else is not rule 3");

  const d3 = ds.find((d) => d.rule === 3)!;
  check(d3.column === 5 && d3.endColumn === 10, "the column spans the word, so the squiggle sits under it", `${d3.column}-${d3.endColumn}`);
  check(ds.every((d) => d.severity === "warning"), "every diagnostic is advisory — there is no severity that stops anything");
}

console.log("\nthe contract, and only where the contract applies");
{
  const bad = "def helper():\n    pass\n";
  const onAgent = contractDiagnostics("agent.py", bad);
  check(onAgent.length === 3, "a bare agent.py is missing both functions and TOOLS", rules(onAgent));
  check(onAgent.every((d) => d.rule === null), "none of them is a numbered rule — they are the contract");
  check(onAgent.every((d) => d.column === undefined), "and none draws a column, because a missing thing has no location");

  // The false-positive that would fire on every tool module in every project.
  check(contractDiagnostics("tools/weather.py", bad).length === 0, "a tool module is not required to have build_graph");
  check(contractDiagnostics("agents/weather/agent.py", bad).length === 3, "a nested agent.py still is");

  const good = "TOOLS = []\ndef build_graph(llm):\n    pass\ndef build_initial_state(user_input):\n    return {}\n";
  check(contractDiagnostics("agent.py", good).length === 0, "a file that satisfies the contract says nothing");
}

console.log("\nthe debounce is a number this module owns");
{
  check(DEBOUNCE_MS === 400, "400ms, as §B.3.1's table states it", String(DEBOUNCE_MS));
}

// ONE THROWAWAY CALL FIRST, and it is worth explaining rather than looking like superstition.
// `uv run python` resolves and locks the virtualenv on its first invocation in a process tree,
// which takes seconds — comfortably past the 3s ceiling this module sets deliberately, since a
// live check that answered late would be annotating text the user has already replaced. In the
// product that cost is paid once, by a keystroke pause that quietly produces nothing; here it
// would land on whichever assertion happened to be first and look like a rule that does not fire.
if (hasRuntime) await astDiagnostics("warmup.py", "x = 1\n", { runtimeDir: RUNTIME_DIR });

/**
 * Whether the AST half can run AT ALL, asked by running it.
 *
 * `existsSync(runtime/pyproject.toml)` WAS THE WRONG QUESTION, and it was wrong in the direction
 * that costs the most: the file is in the checkout on every machine, including one with no Python
 * and no `uv`. `astDiagnostics` fails SILENT by design — an unavailable sandbox means no squiggle
 * and a responsive editor, which is right in the product and indistinguishable from "the rule did
 * not fire" here. So this suite reported four rules broken on any machine without an interpreter,
 * which is precisely the machine that could not have told you either way.
 *
 * A SYNTAX ERROR IS THE PROBE because it is the one input whose answer cannot be empty: Python
 * either parses the buffer or reports where it could not, and an empty list means nothing ran.
 */
const canRunPython =
  hasRuntime &&
  (await astDiagnostics("probe.py", "def f(:\n", { runtimeDir: RUNTIME_DIR })).length > 0;

if (!canRunPython) {
  console.log(
    hasRuntime
      ? "\n(skipping the AST half: runtime/ is here but no Python interpreter would run)"
      : "\n(skipping the AST half: no runtime/ with a Python project)",
  );
} else {
  console.log("\nthe AST rules a regex cannot see");
  {
    const sql = [
      "def get_weather(city: str) -> str:",
      '    query = f"SELECT * FROM cities WHERE name={city}"',
      "    return db.run(query)",
      "",
    ].join("\n");
    const ds = await astDiagnostics("tools/weather.py", sql, { runtimeDir: RUNTIME_DIR });
    check(ds.some((d) => d.rule === 10 && d.line === 2), "rule 10 finds the f-string SQL, on its line", JSON.stringify(ds));

    // The gate's own predicate, and the reason it is not a bare keyword match: this codebase's
    // connector templates raise errors that mention SELECT, and flagging one would be a squiggle
    // under reviewed code that nobody can remove.
    const prose = 'def explain():\n    raise ValueError(f"only SELECT queries are allowed, got {kind}")\n';
    const none = await astDiagnostics("tools/weather.py", prose, { runtimeDir: RUNTIME_DIR });
    check(!none.some((d) => d.rule === 10), "an error message that mentions SELECT is not a query", JSON.stringify(none));

    const toolCall = [
      "from langchain_core.tools import tool",
      "",
      "@tool",
      "def get_weather(city: str) -> str:",
      '    return "sunny"',
      "",
      "@tool",
      "def forecast(city: str) -> str:",
      "    return get_weather(city)",
      "",
    ].join("\n");
    const nine = await astDiagnostics("tools/weather.py", toolCall, { runtimeDir: RUNTIME_DIR });
    check(nine.some((d) => d.rule === 9 && d.line === 9),
      "rule 9 catches a @tool called as a function, with no caller telling it the names", JSON.stringify(nine));

    const known = await astDiagnostics("agent.py", "x = pg_query('select 1')\n", {
      runtimeDir: RUNTIME_DIR,
      knownTools: ["pg_query"],
    });
    check(known.some((d) => d.rule === 9), "…and tools defined elsewhere, when the caller names them");
  }

  console.log("\na half-written file is the common case, not an error");
  {
    const half = "def get_weather(city:\n";
    const ds = await astDiagnostics("agent.py", half, { runtimeDir: RUNTIME_DIR });
    check(ds.length === 1 && ds[0]!.message.startsWith("syntax error"),
      "an unparseable buffer reports the syntax error and nothing else", JSON.stringify(ds));
    check(ds[0]!.severity === "warning", "…and even that does not block anything");
  }

  console.log("\nthe cheap checks are not gated on the parse");
  {
    // The inversion of validateProject's rule, and deliberately so: a syntax error three lines
    // below must not hide the rule-3 squiggle a person can already act on.
    const both = "def go():\n    print('x')\n    if True\n";
    const ds = await liveDiagnostics("agent.py", both, { runtimeDir: RUNTIME_DIR });
    check(ds.some((d) => d.rule === 3), "the print is still reported");
    check(ds.some((d) => d.message.startsWith("syntax error")), "beside the syntax error");
    check(
      ds.every((d, i) => i === 0 || ds[i - 1]!.line <= d.line),
      "and the list is sorted by line, so PROBLEMS does not churn between renders",
      JSON.stringify(ds.map((d) => d.line)),
    );
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

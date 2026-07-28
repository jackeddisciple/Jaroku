// Judge rubric, prompt, verdict parsing, and output extraction — all pure, so this runs
// free and deterministically.
//
// The failure modes here are quiet ones: a lenient parser turns the judge's formatting slip
// into a provider's low score, and a wrong output extraction has the judge confidently
// grading a tool result instead of the answer. Both produce a plausible number with nothing
// behind it.
//
//   npm run test:judge

import { DEFAULT_CRITERIA, buildJudgePrompt, parseJudgeVerdict, SCALE_MAX } from "./rubric.ts";
import { extractAgentOutput } from "./output.ts";
import type { Step } from "../types.ts";
import type { RubricCriterion } from "../evalStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const C = DEFAULT_CRITERIA;

// --- prompt construction --------------------------------------------------------------
{
  const p = buildJudgePrompt(
    { input: "where is order 123?", expected: "Order 123 shipped Tuesday", output: "It shipped Tuesday." },
    C,
  );
  check("prompt carries the input", p.user.includes("where is order 123?"));
  check("prompt carries the agent output", p.user.includes("It shipped Tuesday."));
  check("prompt carries the reference", p.user.includes("Order 123 shipped Tuesday"));
  check("reference is framed as one acceptable answer, not the only one",
    p.user.includes("not the only one"));
  check("every criterion id reaches the prompt", C.every((c) => p.user.includes(`"${c.id}"`)));
  check("scale anchors are included", p.user.includes("0 —") && p.user.includes(`${SCALE_MAX} —`));

  const noRef = buildJudgePrompt({ input: "hi", output: "hello" }, C);
  check("no reference section when the example has no expected output",
    !noRef.user.includes("Reference output"));

  const empty = buildJudgePrompt({ input: "hi", output: "" }, C);
  check("an empty response is stated, not blank",
    empty.user.includes("the agent produced no output"));

  const errored = buildJudgePrompt({ input: "hi", output: "partial", runError: "tool timeout" }, C);
  check("a run error is surfaced so the judge isn't grading a truncation blind",
    errored.user.includes("tool timeout"));

  // The schema is what makes the response shape enforced rather than requested.
  const props = (p.schema as { properties: { scores: { required: string[] } } }).properties;
  check("schema requires every criterion",
    C.every((c) => props.scores.required.includes(c.id)));
}

// --- rubric is data ---------------------------------------------------------------------
{
  const custom: RubricCriterion[] = [
    { id: "sql_safety", label: "SQL safety", description: "Does the query avoid full scans?", weight: 1 },
  ];
  const p = buildJudgePrompt({ input: "count users", output: "SELECT COUNT(*) FROM users" }, custom);
  check("a custom rubric replaces the default entirely",
    p.user.includes("sql_safety") && !p.user.includes("correctness"));
}

// --- verdict parsing --------------------------------------------------------------------
{
  const good = JSON.stringify({
    scores: { correctness: 4, grounding: 4, tone: 4 },
    rationale: "Answered exactly.",
  });
  const r = parseJudgeVerdict(good, C);
  check("all-4s is a perfect 1.0", "verdict" in r && r.verdict.score === 1);
  check("rationale round-trips", "verdict" in r && r.verdict.rationale === "Answered exactly.");

  const zeros = parseJudgeVerdict(
    JSON.stringify({ scores: { correctness: 0, grounding: 0, tone: 0 }, rationale: "" }), C);
  check("all-0s is 0.0", "verdict" in zeros && zeros.verdict.score === 0);

  // 0.5*(4/4) + 0.3*(2/4) + 0.2*(0/4) = 0.65
  const weighted = parseJudgeVerdict(
    JSON.stringify({ scores: { correctness: 4, grounding: 2, tone: 0 }, rationale: "x" }), C);
  check("overall is weighted by the rubric",
    "verdict" in weighted && Math.abs(weighted.verdict.score - 0.65) < 1e-9,
    "verdict" in weighted ? String(weighted.verdict.score) : "");

  check("raw per-criterion scores are kept alongside the overall",
    "verdict" in weighted && weighted.verdict.perCriterion.grounding === 2);

  // Models still wrap JSON in fences.
  const fenced = parseJudgeVerdict(
    "```json\n" + JSON.stringify({ scores: { correctness: 3, grounding: 3, tone: 3 }, rationale: "ok" }) + "\n```",
    C);
  check("tolerates a ```json fence", "verdict" in fenced);

  // Out-of-range: clamp, don't discard an otherwise complete verdict.
  const over = parseJudgeVerdict(
    JSON.stringify({ scores: { correctness: 9, grounding: 4, tone: 4 }, rationale: "" }), C);
  check("clamps an out-of-range score instead of discarding the verdict",
    "verdict" in over && over.verdict.perCriterion.correctness === SCALE_MAX);
}

// --- strictness: an incomplete verdict must be UNSCORED, never 0 -----------------------
{
  const missing = parseJudgeVerdict(
    JSON.stringify({ scores: { correctness: 4, grounding: 4 }, rationale: "forgot tone" }), C);
  check("a missing criterion is an error, not a silent 0",
    "error" in missing && missing.error.includes("tone"));

  check("non-JSON is an error", "error" in parseJudgeVerdict("I think it was pretty good!", C));
  check("empty is an error", "error" in parseJudgeVerdict("   ", C));
  check("a JSON array is an error", "error" in parseJudgeVerdict("[1,2,3]", C));
  check("missing scores object is an error",
    "error" in parseJudgeVerdict(JSON.stringify({ rationale: "nice" }), C));
  check("a non-numeric score is an error",
    "error" in parseJudgeVerdict(
      JSON.stringify({ scores: { correctness: "good", grounding: 4, tone: 4 }, rationale: "" }), C));
}

// --- weight normalization ----------------------------------------------------------------
{
  // An edited rubric whose weights don't sum to 1 must still produce a 0..1 score.
  const odd: RubricCriterion[] = [
    { id: "a", label: "A", description: "d", weight: 3 },
    { id: "b", label: "B", description: "d", weight: 1 },
  ];
  const r = parseJudgeVerdict(JSON.stringify({ scores: { a: 4, b: 0 }, rationale: "" }), odd);
  check("weights are normalized (3:1 -> 0.75)",
    "verdict" in r && Math.abs(r.verdict.score - 0.75) < 1e-9,
    "verdict" in r ? String(r.verdict.score) : "");

  const zeroW: RubricCriterion[] = [
    { id: "a", label: "A", description: "d", weight: 0 },
    { id: "b", label: "B", description: "d", weight: 0 },
  ];
  const z = parseJudgeVerdict(JSON.stringify({ scores: { a: 4, b: 0 }, rationale: "" }), zeroW);
  check("all-zero weights fall back to an equal split, not a divide-by-zero",
    "verdict" in z && Math.abs(z.verdict.score - 0.5) < 1e-9);
}

// --- output extraction ---------------------------------------------------------------
{
  let seq = 0;
  const mk = (over: Partial<Step>): Step => ({
    id: `s${seq}`, run_id: "r", seq: seq++, type: "llm_call", name: "call_model",
    input: null, output: null, state_before: null, state_after: null, tokens: null,
    cost: null, latency_ms: 0, error: null, parent_step_id: null, started_at: "", ...over,
  } as Step);

  seq = 0;
  const trace = [
    mk({ type: "llm_call", output: [{ content: "", tool_calls: [{ name: "lookup" }] }] }),
    mk({ type: "tool_call", name: "lookup", output: "Order 123: shipped Tuesday" }),
    mk({ type: "llm_call", output: [{ content: "Your order shipped Tuesday." }] }),
  ];
  const got = extractAgentOutput(trace);
  check("takes the closing model turn, not the tool result",
    got.text === "Your order shipped Tuesday." && got.source === "llm_call", got.text);

  // Steps are emitted at END time, so arrival order is not causal order.
  seq = 0;
  const shuffled = [trace[2]!, trace[0]!, trace[1]!];
  check("sorts by seq rather than trusting array order",
    extractAgentOutput(shuffled).text === "Your order shipped Tuesday.");

  // A closing call with only tool_calls isn't the answer.
  seq = 0;
  const toolOnlyLast = [
    mk({ output: [{ content: "Here is the summary." }] }),
    mk({ output: [{ content: "", tool_calls: [{ name: "x" }] }] }),
  ];
  check("skips a final call that produced no text",
    extractAgentOutput(toolOnlyLast).text === "Here is the summary.");

  // Anthropic-style content blocks.
  seq = 0;
  check("handles block-array content",
    extractAgentOutput([mk({ output: [{ content: [{ type: "text", text: "Blocked answer." }] }] })]).text
      === "Blocked answer.");

  // Fallback to state when the closing text lives in a node's output.
  seq = 0;
  const stateOnly = [
    mk({ type: "state_update", name: "respond", output: null,
         state_after: { messages: [{ type: "human", content: "hi" }, { type: "ai", content: "State answer." }] } }),
  ];
  const s = extractAgentOutput(stateOnly);
  check("falls back to the final state's assistant message",
    s.text === "State answer." && s.source === "state", s.text);

  // An errored llm_call is not the answer.
  seq = 0;
  check("ignores an errored model call",
    extractAgentOutput([
      mk({ output: [{ content: "Good answer." }] }),
      mk({ output: [{ content: "half" }], error: "APIConnectionError" }),
    ]).text === "Good answer.");

  seq = 0;
  const none = extractAgentOutput([mk({ type: "tool_call", output: "just a tool result" })]);
  check("reports 'none' rather than passing off a tool result as the answer",
    none.text === "" && none.source === "none");
  check("empty trace yields none", extractAgentOutput([]).source === "none");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

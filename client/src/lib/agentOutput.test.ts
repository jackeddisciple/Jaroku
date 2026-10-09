// What the Answer card above a finished run shows — the same string the eval judge scores.
//
//   npm run test:agent-output

import type { Step } from "../types.ts";
import { extractAgentOutput } from "./agentOutput.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

let seq = 0;
const mk = (over: Partial<Step>): Step => ({
  id: `s${seq}`, run_id: "r", seq: seq++, type: "llm_call", name: "call_model",
  input: null, output: null, state_before: null, state_after: null, tokens: null,
  cost: null, latency_ms: 0, error: null, parent_step_id: null, started_at: "", ...over,
});

const trace = [
  mk({ output: [{ content: "", tool_calls: [{ name: "lookup" }] }] }),
  mk({ type: "tool_call", name: "lookup", output: "Order 123: shipped Tuesday" }),
  mk({ output: [{ content: "Your order shipped Tuesday." }] }),
];
const got = extractAgentOutput(trace);
check("takes the closing model turn, not the tool result", got === "Your order shipped Tuesday.", got);
check("sorts by seq rather than trusting array order",
  extractAgentOutput([trace[2]!, trace[0]!, trace[1]!]) === "Your order shipped Tuesday.");

seq = 0;
check("skips a final call that produced no text", extractAgentOutput([
  mk({ output: [{ content: "Here is the summary." }] }),
  mk({ output: [{ content: "", tool_calls: [{ name: "x" }] }] }),
]) === "Here is the summary.");

// What a Claude run with reasoning on actually traces: a signed thinking block, then the text.
seq = 0;
const reasoned = extractAgentOutput([mk({ output: [{ content: [
  { type: "thinking", thinking: "The orders queue grows 375/min.", signature: "EsMD…" },
  { type: "text", text: "ALERT: orders is backing up." },
] }] })]);
check("shows the text block and never the reasoning", reasoned === "ALERT: orders is backing up.", reasoned);

seq = 0;
const stateOnly = extractAgentOutput([mk({
  type: "state_update", name: "respond",
  state_after: { messages: [{ type: "human", content: "hi" }, { type: "ai", content: "State answer." }] },
})]);
check("falls back to the final state's assistant message", stateOnly === "State answer.", stateOnly);

seq = 0;
check("ignores an errored model call", extractAgentOutput([
  mk({ output: [{ content: "Good answer." }] }),
  mk({ output: [{ content: "half" }], error: "APIConnectionError" }),
]) === "Good answer.");

seq = 0;
check("a tool result alone is not an answer",
  extractAgentOutput([mk({ type: "tool_call", output: "just a tool result" })]) === "");
check("an empty trace has no answer", extractAgentOutput([]) === "");

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

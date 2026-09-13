// The two provider streams, parsed from lines both CLIs really emitted.
//
// Every fixture below was captured on 2026-09-13 from `codex exec --json` and
// `claude -p --output-format stream-json --verbose --include-partial-messages`, against real
// signed-in plans. A parser tested against the documented shape is a parser tested against a
// document; these are the bytes.
//
// The point of the suite is that the two protocols agree on nothing — Codex emits a whole message
// in one `item.completed`, Claude emits real `text_delta`s — and both must reduce to the same three
// outcomes the conversation understands: text, usage, failure.
//
//   npm run test:provider-turn

import { __parseCodexLine, __parseClaudeLine } from "./providerTurn.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const J = (s: string): unknown => JSON.parse(s);

console.log("\ncodex exec --json, as captured");
{
  const started = __parseCodexLine(J('{"type":"thread.started","thread_id":"01a099c1-9756-7f51-9dda-d4d197b32b9d"}'));
  check("thread.started carries nothing the conversation needs", started === null);

  const turn = __parseCodexLine(J('{"type":"turn.started"}'));
  check("turn.started likewise", turn === null);

  const msg = __parseCodexLine(J('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"BRIDGE OK"}}'));
  check("an agent message becomes text", msg?.text === "BRIDGE OK", JSON.stringify(msg));

  const done = __parseCodexLine(J('{"type":"turn.completed","usage":{"input_tokens":15941,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}'));
  check("turn.completed becomes usage", done?.usage?.input_tokens === 15941 && done?.usage?.output_tokens === 7, JSON.stringify(done));
  // A plan turn is not priced per token. Reporting a dollar figure would invent one.
  check("...and reports no cost, because a plan was drawn on", done?.usage?.cost_usd === null);

  // A reasoning item is not the answer, and appending it would put the model's scratchpad in the
  // conversation.
  const reasoning = __parseCodexLine(J('{"type":"item.completed","item":{"type":"reasoning","text":"thinking out loud"}}'));
  check("a reasoning item is not treated as the answer", reasoning === null);
}

console.log("\nclaude -p --output-format stream-json, as captured");
{
  const init = __parseClaudeLine(J('{"type":"system","subtype":"init","cwd":"/tmp","session_id":"9a680ec1"}'));
  check("the init event carries nothing the conversation needs", init === null);

  const start = __parseClaudeLine(J('{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-5","role":"assistant"}},"session_id":"9a680ec1"}'));
  check("message_start is not text", start === null);

  const delta = __parseClaudeLine(J('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi!"}},"session_id":"9a680ec1"}'));
  check("a text_delta becomes text", delta?.text === "Hi!", JSON.stringify(delta));

  // The full assistant message arrives again as its own event. It is carried as `whole` rather than
  // as `text`, which is the distinction that keeps both properties: appending it as text would
  // double every streamed answer, and dropping it entirely loses the answer on a turn where no
  // delta ever arrived. The runner appends it only when nothing streamed — asserted in
  // providerTurnFlow.test.ts, where a whole run is driven.
  const full = __parseClaudeLine(J('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi! How can I help?"}]}}'));
  check("the repeated assistant message is held in reserve, not appended", full?.whole === "Hi! How can I help?" && full?.text === undefined, JSON.stringify(full));

  const result = __parseClaudeLine(J('{"type":"result","duration_api_ms":1673,"stop_reason":"end_turn","total_cost_usd":0.0683845,"usage":{"input_tokens":2,"output_tokens":10}}'));
  check("result becomes usage", result?.usage?.input_tokens === 2 && result?.usage?.output_tokens === 10, JSON.stringify(result));
  // Claude Code does report a figure. It is an estimate of the same request on the API, not what
  // the plan was charged — which is nothing — so it is carried and labelled, never billed.
  check("...carrying Claude Code's own cost estimate", result?.usage?.cost_usd === 0.0683845);

  const errored = __parseClaudeLine(J('{"type":"result","subtype":"error","is_error":true,"result":"Credit balance is too low"}'));
  check("an errored result becomes a failure", errored?.error === "Credit balance is too low", JSON.stringify(errored));
}

console.log("\nneither parser trusts what it is given");
{
  for (const junk of [null, undefined, 42, "a string", [], {}, { type: "unheard-of" }]) {
    check(`codex survives ${JSON.stringify(junk) ?? "undefined"}`, __parseCodexLine(junk) === null);
    check(`claude survives ${JSON.stringify(junk) ?? "undefined"}`, __parseClaudeLine(junk) === null);
  }
  // A malformed usage block must not produce NaN in a record somebody reads.
  const weird = __parseCodexLine(J('{"type":"turn.completed","usage":{"input_tokens":"lots"}}'));
  check("a non-numeric token count does not become NaN", Number.isFinite(weird?.usage?.input_tokens ?? 0), JSON.stringify(weird));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

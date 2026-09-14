// The whole local-turn flow, driven against a stand-in shell.
//
// WHAT THIS COVERS THAT `providerTurn.test.ts` DOES NOT. That suite tests the two parsers as pure
// functions, which leaves the part where the answer actually reaches the conversation untested:
// listening before the process starts, matching events to the right turn, appending deltas in
// order, settling once, reporting usage, and cancelling. Those are the seams between pieces that
// each work — which is exactly where a feature is whole in parts and broken as a whole.
//
// THE STAND-IN IS A SHELL, NOT A PROVIDER. It emits the same event envelopes `provider_turn.rs`
// emits, carrying lines both CLIs really printed (captured 2026-09-13). Nothing here fakes a
// provider's answer: the JSON is real, and what is substituted is only the process that carried it.
// A test that invented the JSON too would be testing its own idea of the protocol.
//
//   npm run test:provider-turn-flow

import { runLocalTurn } from "./providerTurn.ts";
import { useChatStore } from "../store/chatStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the store was told, in order. The conversation's view of the turn. */
interface Seen {
  started: number; deltas: string[]; done: number; errors: string[]; usage: unknown;
  /** §15.1's band as the turn was opened with it. */
  planEvidence: string | null;
}

function watchStore(): Seen {
  const seen: Seen = { started: 0, deltas: [], done: 0, errors: [], usage: null, planEvidence: null };
  const s = useChatStore.getState();
  useChatStore.setState({
    ...s,
    replyStarted: (e: { planEvidence?: string }) => { seen.started++; seen.planEvidence = e.planEvidence ?? null; },
    replyDelta: (e: { text: string }) => { seen.deltas.push(e.text); },
    replyDone: (e: { usage?: unknown }) => { seen.done++; seen.usage = e.usage ?? null; },
    replyError: (e: { message: string }) => { seen.errors.push(e.message); },
  } as never);
  return seen;
}

/**
 * A shell that plays a scripted stream.
 *
 * `started` resolves once `provider_turn_start` has been called, so a test can assert the listener
 * was attached BEFORE the process began — the ordering that decides whether a fast turn's first
 * line is heard or dropped.
 */
function installHost(lines: string[], opts: {
  exitCode?: number; failStart?: string; delayMs?: number;
  /** Lines THIS turn prints before `provider_turn_start` has returned its id — a fast first line. */
  earlyLines?: string[];
  /** Lines ANOTHER turn prints in that same window — an earlier turn still running. */
  foreignLines?: string[];
} = {}): {
  cancelled: number[]; startedWith: Record<string, unknown> | null;
} {
  const state = { cancelled: [] as number[], startedWith: null as Record<string, unknown> | null };
  let listener: ((e: { payload: unknown }) => void) | null = null;
  let nextId = 1;

  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "provider_turn_cancel") { state.cancelled.push(Number(args?.turnId)); return true; }
        if (cmd !== "provider_turn_start") return null;
        if (opts.failStart) throw new Error(opts.failStart);
        state.startedWith = args ?? null;
        const id = nextId++;
        // Delivered synchronously, before this call returns — the window in which the page cannot yet
        // tell its own turn's events from anybody else's.
        for (const line of opts.foreignLines ?? []) listener?.({ payload: { turnId: 999, line, done: false } });
        for (const line of opts.earlyLines ?? []) listener?.({ payload: { turnId: id, line, done: false } });
        // Emitted after this call returns, the way a real spawn does.
        void (async () => {
          await sleep(opts.delayMs ?? 5);
          for (const line of lines) listener?.({ payload: { turnId: id, line, done: false } });
          listener?.({ payload: { turnId: id, done: true, code: opts.exitCode ?? 0 } });
        })();
        return id;
      },
    },
    event: {
      listen: async (_event: string, cb: (e: { payload: unknown }) => void) => {
        listener = cb;
        return () => { listener = null; };
      },
    },
  };
  return state;
}

// Lines captured from the real CLIs on 2026-09-13.
const CODEX_STREAM = [
  '{"type":"thread.started","thread_id":"01a09a3d-8e2b-74d1-b31c-e380e5d541cd"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"LAST MILE OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":15942,"cached_input_tokens":11008,"output_tokens":8,"reasoning_output_tokens":0}}',
];
const CLAUDE_STREAM = [
  '{"type":"system","subtype":"init","session_id":"9a680ec1"}',
  '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-5"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"!"}}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi!"}]}}',
  '{"type":"result","total_cost_usd":0.0683845,"usage":{"input_tokens":2,"output_tokens":10}}',
];

const base = { model: null, effort: null, agentId: "agent_x" };

console.log("\na Codex turn reaches the conversation and settles once");
{
  const host = installHost(CODEX_STREAM);
  const seen = watchStore();
  // A holder rather than a bare `let`: TypeScript narrows a variable assigned only inside a
  // callback to `never` at the point it is read, because its control-flow analysis cannot see that
  // the callback ran. A property on an object is not narrowed that way.
  const record: { seen: { answer: string; usage: unknown } | null } = { seen: null };
  const turn = runLocalTurn({
    ...base, provider: "openai", prompt: "say it",
    onComplete: (answer, usage) => { record.seen = { answer, usage }; },
  });
  await turn.finished;

  check("the turn opened exactly one answer", seen.started === 1);
  check("...carrying the provider's text", seen.deltas.join("") === "LAST MILE OK", seen.deltas.join(""));
  check("...and settled exactly once", seen.done === 1 && seen.errors.length === 0);
  check("...reporting what it spent", (seen.usage as { output_tokens?: number })?.output_tokens === 8);
  // The record is what persists the turn. Without it the answer vanishes on reload.
  check("the turn is handed on to be recorded", record.seen?.answer === "LAST MILE OK", JSON.stringify(record.seen));
  // The prompt reaches the shell as a field, never as a command line — see provider_turn.rs.
  check("the shell was asked for a provider and a prompt, not an argv",
    host.startedWith?.provider === "openai" && host.startedWith?.prompt === "say it"
      && !("argv" in (host.startedWith ?? {})), JSON.stringify(host.startedWith));
  // NOR A DIRECTORY. The page named one from a config field the shell never injected, so every shipped
  // turn ran in /tmp; where a turn runs is the shell's decision alone.
  check("...and was not told where to run it", !("cwd" in (host.startedWith ?? {})), JSON.stringify(host.startedWith));
}

console.log("\na Claude turn streams in order and does not double");
{
  installHost(CLAUDE_STREAM);
  const seen = watchStore();
  const turn = runLocalTurn({ ...base, provider: "anthropic", prompt: "hi" });
  await turn.finished;

  check("deltas arrive in order", seen.deltas.join("") === "Hi!", seen.deltas.join(""));
  // Claude repeats the finished message as its own `assistant` event. Appending that as well is the
  // obvious bug this asserts against: the answer would read "Hi!Hi!".
  check("...and the repeated assistant message does not double it", seen.deltas.length === 2, String(seen.deltas.length));
  check("...settling with Claude Code's own cost estimate",
    (seen.usage as { cost_usd?: number })?.cost_usd === 0.0683845);
}

console.log("\na subscription turn is opened with the router's plan band");
{
  // §15.1's "Build this as an agent" card reads the band on the turn. A server-answered turn gets it
  // from `started`; this path was never given one, so the card could not appear under an answer that
  // ran on the user's own plan — which is the path Chat actually takes.
  installHost(CODEX_STREAM);
  const seen = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "something that watches my inbox", planEvidence: "near" }).finished;
  check("the band reaches the turn", seen.planEvidence === "near", String(seen.planEvidence));
  installHost(CODEX_STREAM);
  const none = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("...and a turn routed with none carries none", none.planEvidence === null, String(none.planEvidence));
}

console.log("\ntwo Codex messages in one turn stay two paragraphs");
{
  // Codex emits each agent message whole, and a turn can carry a preamble before its answer. Appended
  // bare, "Let me think about that." and "Here is the plan." rendered as one run-on sentence.
  installHost([
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Let me think about that."}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Here is the plan."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":9}}',
  ]);
  const seen = watchStore();
  const record: { answer: string | null } = { answer: null };
  await runLocalTurn({
    ...base, provider: "openai", prompt: "plan it", onComplete: (answer) => { record.answer = answer; },
  }).finished;
  const expected = "Let me think about that.\n\nHere is the plan.";
  check("...rendered with a paragraph break between them", seen.deltas.join("") === expected, JSON.stringify(seen.deltas.join("")));
  check("...recorded the same way", record.answer === expected, JSON.stringify(record.answer));
  check("...and with nothing in front of the first", !seen.deltas.join("").startsWith("\n"));
}

console.log("\nan answer that never streamed is still an answer");
{
  // THE CASE THE APP ACTUALLY HIT. A Claude turn ended with a complete `assistant` message and no
  // `text_delta` at all, and the conversation rendered "the provider returned no answer" while the
  // answer sat in the event immediately before `done`. Deltas are what usually carry a reply; they
  // are not what guarantees there was one.
  installHost([
    '{"type":"system","subtype":"init","session_id":"s"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi! What can I help you with?"}]}}',
    '{"type":"result","total_cost_usd":0.01,"usage":{"input_tokens":2,"output_tokens":9}}',
  ]);
  const seen = watchStore();
  await runLocalTurn({ ...base, provider: "anthropic", prompt: "Hi" }).finished;
  check("the whole message becomes the answer", seen.deltas.join("") === "Hi! What can I help you with?", seen.deltas.join(""));
  check("...settling rather than erroring", seen.done === 1 && seen.errors.length === 0, JSON.stringify(seen.errors));
}

console.log("\nand a streamed answer is never doubled by the copy that follows it");
{
  // The other half of the same rule: when deltas DID arrive, the repeated whole message must not be
  // appended on top of them. "Hi!" must not render as "Hi!Hi!".
  installHost([
    '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hi"}}}',
    '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"!"}}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi!"}]}}',
    '{"type":"result","usage":{"input_tokens":1,"output_tokens":2}}',
  ]);
  const seen = watchStore();
  await runLocalTurn({ ...base, provider: "anthropic", prompt: "Hi" }).finished;
  check("the streamed text stands alone", seen.deltas.join("") === "Hi!", seen.deltas.join(""));
}

console.log("\na failure is reported rather than swallowed");
{
  // A provider that exits non-zero having said nothing: the shape of an expired sign-in.
  installHost([], { exitCode: 1 });
  const seen = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("the turn errors rather than completing empty", seen.errors.length === 1 && seen.done === 0, JSON.stringify(seen.errors));

  // A turn that produced nothing but exited cleanly is still not an answer.
  installHost(['{"type":"turn.started"}'], { exitCode: 0 });
  const quiet = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("...and so does a clean exit with no answer", quiet.errors.length === 1 && quiet.done === 0);

  // A Codex turn that FAILED with an exit of 0 and only `turn.failed` to say why — the shape the parser
  // used to read as nothing specific and render as "The provider reported a failure."
  installHost([
    '{"type":"turn.started"}',
    String.raw`{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-x' model is not supported when using Codex with a ChatGPT account.\"}}"}}`,
  ], { exitCode: 0 });
  const refused = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("...and a turn.failed alone reports the provider's own sentence",
    refused.errors[0] === "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.", refused.errors[0]);

  // The shell refusing to start at all — no CLI, or a provider it will not run.
  installHost([], { failStart: "codex is not installed" });
  const absent = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("...and a shell that cannot start one says so", absent.errors[0]?.includes("not installed") === true, absent.errors[0]);
}

console.log("\nnothing is recorded for a turn that failed");
{
  installHost([], { exitCode: 1 });
  let recorded = false;
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onComplete: () => { recorded = true; } }).finished;
  // Recording a failure as an answer would put an empty assistant message in the thread forever.
  check("a failed turn is never handed on to be recorded", !recorded);
}

console.log("\nan earlier turn still printing cannot bleed into this one");
{
  // Until `provider_turn_start` returns, this turn does not know its own id — and the listener has to
  // be up before then, or a fast first line is lost. Accepting everything in that window appended a
  // still-running earlier turn's output to this answer.
  installHost([
    '{"type":"item.completed","item":{"type":"agent_message","text":"mine"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ], { foreignLines: ['{"type":"item.completed","item":{"type":"agent_message","text":"ANOTHER TURN"}}'] });
  const seen = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("another turn's line is not appended", seen.deltas.join("") === "mine", JSON.stringify(seen.deltas.join("")));

  // ...WHILE THIS TURN'S OWN FIRST LINE, printed in that same window, still lands.
  installHost(['{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'], {
    earlyLines: ['{"type":"item.completed","item":{"type":"agent_message","text":"fast"}}'],
    foreignLines: ['{"type":"item.completed","item":{"type":"agent_message","text":"stale"}}'],
  });
  const fast = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("...a fast first line from this turn is kept", fast.deltas.join("") === "fast", JSON.stringify(fast.deltas.join("")));
  check("...and the other turn's is still dropped", !fast.deltas.join("").includes("stale"));
}

console.log("\ncancelling kills the process that is spending the plan");
{
  const host = installHost(CODEX_STREAM, { delayMs: 200 });
  watchStore();
  const turn = runLocalTurn({ ...base, provider: "openai", prompt: "hi" });
  // Wait for the id to come back, then cancel before the stream arrives.
  await sleep(50);
  turn.cancel();
  check("the shell is told to kill the turn", host.cancelled.length === 1, JSON.stringify(host.cancelled));
  await turn.finished;
}

console.log("\nin a browser it says so rather than doing nothing");
{
  delete (globalThis as Record<string, unknown>).__TAURI__;
  const seen = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi" }).finished;
  check("a browser reports that this needs the desktop app",
    seen.errors[0]?.includes("desktop app") === true, seen.errors[0]);
  check("...and records nothing", seen.done === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

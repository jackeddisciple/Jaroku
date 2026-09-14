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
// THE SERVER OWNS THE TURN. It wrote the question, announced it with `started` and handed this app a
// run — so what is asserted is that the answer streams into THAT thread's turn, that the page never
// opens or closes the turn itself, and that the run is settled exactly once with how it ended.
//
//   npm run test:provider-turn-flow

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runLocalTurn, type LocalTurnOutcome } from "./providerTurn.ts";
import { useChatStore } from "../store/chatStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the store was told, in order. The conversation's view of the turn. */
interface Seen {
  started: number; deltas: string[]; threads: (string | undefined)[]; settled: number; errors: string[];
}

function watchStore(): Seen {
  const seen: Seen = { started: 0, deltas: [], threads: [], settled: 0, errors: [] };
  const s = useChatStore.getState();
  useChatStore.setState({
    ...s,
    replyStarted: () => { seen.started++; },
    replyDelta: (e: { text: string; threadId?: string }) => { seen.deltas.push(e.text); seen.threads.push(e.threadId); },
    replyDone: () => { seen.settled++; },
    replyStopped: () => { seen.settled++; },
    replyError: (e: { message: string }) => { seen.errors.push(e.message); },
  } as never);
  return seen;
}

/** Every settle the turn sent, so settling twice is visible — and whether sending it worked. */
function settleRecorder(sent = true): { outcomes: LocalTurnOutcome[]; onSettle: (o: LocalTurnOutcome) => boolean } {
  const outcomes: LocalTurnOutcome[] = [];
  return { outcomes, onSettle: (o) => { outcomes.push(o); return sent; } };
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
  /** The sentence the shell puts on the last event itself — a turn it ended at its deadline. */
  endError?: string;
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
  const killed = new Set<number>();

  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "provider_turn_cancel") {
          const id = Number(args?.turnId);
          state.cancelled.push(id);
          // A KILL ENDS THE STREAM, as it does in the shell: the pipe closes, and the last event carries
          // no exit code and no sentence.
          killed.add(id);
          listener?.({ payload: { turnId: id, done: true, code: null } });
          return true;
        }
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
          // A KILLED PROCESS PRINTS NOTHING MORE — its pipe is closed.
          if (killed.has(id)) return;
          for (const line of lines) listener?.({ payload: { turnId: id, line, done: false } });
          // THE SHELL NAMES A NON-ZERO EXIT, AND A DEADLINE, ITSELF, on the final event — see `run` in
          // provider_turn.rs. A stand-in that left it off would pass a failed turn off as a finished one.
          const code = opts.exitCode ?? 0;
          listener?.({ payload: {
            turnId: id, done: true, code: opts.endError ? null : code,
            ...(opts.endError
              ? { error: opts.endError }
              : code !== 0
                ? { error: `The provider's CLI exited with status ${code}. Check the desktop log, and that your sign-in is still valid.` }
                : {}),
          } });
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

const base = { threadId: "th-1", model: null, effort: null, agentId: "agent_x" };

console.log("\na Codex turn streams into its thread and is settled once");
{
  const host = installHost(CODEX_STREAM);
  const seen = watchStore();
  const settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "openai", prompt: "say it", onSettle: settled.onSettle }).finished;

  check("the provider's text streams in", seen.deltas.join("") === "LAST MILE OK", seen.deltas.join(""));
  // A TURN STREAMED WITH NO THREAD went to `pending`, which no open conversation shows — the answer
  // was invisible whenever an agent was selected or a thread was open.
  check("...into the thread the server opened it in", seen.threads.length > 0 && seen.threads.every((t) => t === "th-1"),
    JSON.stringify(seen.threads));
  check("the page neither opens nor closes the turn — the server's events do",
    seen.started === 0 && seen.settled === 0 && seen.errors.length === 0, JSON.stringify(seen));
  check("the run is settled exactly once", settled.outcomes.length === 1, String(settled.outcomes.length));
  const o = settled.outcomes[0];
  check("...as done, with the answer", o?.status === "done" && o.answer === "LAST MILE OK" && o.error === null, JSON.stringify(o));
  check("...and what it spent", o?.usage?.output_tokens === 8, JSON.stringify(o?.usage));
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
  const settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "anthropic", prompt: "hi", onSettle: settled.onSettle }).finished;

  check("deltas arrive in order", seen.deltas.join("") === "Hi!", seen.deltas.join(""));
  // Claude repeats the finished message as its own `assistant` event. Appending that as well is the
  // obvious bug this asserts against: the answer would read "Hi!Hi!".
  check("...and the repeated assistant message does not double it", seen.deltas.length === 2, String(seen.deltas.length));
  check("...settling with Claude Code's own cost estimate",
    settled.outcomes[0]?.usage?.cost_usd === 0.0683845, JSON.stringify(settled.outcomes[0]?.usage));
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
  const settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "openai", prompt: "plan it", onSettle: settled.onSettle }).finished;
  const expected = "Let me think about that.\n\nHere is the plan.";
  check("...rendered with a paragraph break between them", seen.deltas.join("") === expected, JSON.stringify(seen.deltas.join("")));
  check("...settled the same way", settled.outcomes[0]?.answer === expected, JSON.stringify(settled.outcomes[0]?.answer));
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
  const settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "anthropic", prompt: "Hi", onSettle: settled.onSettle }).finished;
  check("the whole message becomes the answer", seen.deltas.join("") === "Hi! What can I help you with?", seen.deltas.join(""));
  check("...settling as done rather than as a failure", settled.outcomes[0]?.status === "done", JSON.stringify(settled.outcomes[0]));
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
  const settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "anthropic", prompt: "Hi", onSettle: settled.onSettle }).finished;
  check("the streamed text stands alone", seen.deltas.join("") === "Hi!", seen.deltas.join(""));
  check("...and is what the run is settled with", settled.outcomes[0]?.answer === "Hi!", JSON.stringify(settled.outcomes[0]));
}

console.log("\na failure is settled as one, never swallowed and never erased");
{
  // A provider that exits non-zero having said nothing: the shape of an expired sign-in.
  installHost([], { exitCode: 1 });
  watchStore();
  let settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("a provider that exits non-zero settles as an error",
    settled.outcomes.length === 1 && settled.outcomes[0]?.status === "error" && Boolean(settled.outcomes[0]?.error),
    JSON.stringify(settled.outcomes));

  // A turn that produced nothing but exited cleanly is still not an answer.
  installHost(['{"type":"turn.started"}'], { exitCode: 0 });
  settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("...and so does a clean exit with no answer", settled.outcomes[0]?.status === "error", JSON.stringify(settled.outcomes[0]));

  // A Codex turn that FAILED with an exit of 0 and only `turn.failed` to say why — the shape the parser
  // used to read as nothing specific and render as "The provider reported a failure."
  installHost([
    '{"type":"turn.started"}',
    String.raw`{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-x' model is not supported when using Codex with a ChatGPT account.\"}}"}}`,
  ], { exitCode: 0 });
  settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("...and a turn.failed alone settles with the provider's own sentence",
    settled.outcomes[0]?.error === "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.",
    String(settled.outcomes[0]?.error));

  // The shell refusing to start at all — no CLI, or a provider it will not run.
  installHost([], { failStart: "codex is not installed" });
  settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("...and a shell that cannot start one says so", settled.outcomes[0]?.error?.includes("not installed") === true,
    String(settled.outcomes[0]?.error));

  // WHAT ARRIVED BEFORE A FAILURE IS PART OF THE TURN. A failed turn used to be handed on to nothing,
  // so the partial — and the question with it — was gone after a reload.
  installHost(['{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"half an"}}}'], { exitCode: 1 });
  settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "anthropic", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("a failure after text arrived settles with that text",
    settled.outcomes[0]?.status === "error" && settled.outcomes[0]?.answer === "half an", JSON.stringify(settled.outcomes[0]));
}

console.log("\nan answer that could not be handed back says so here");
{
  // THE SOCKET CLOSED WHILE THE CLI WAS ANSWERING. The server will never hear how this ended, so the
  // tab is the only place left to say it: the answer stays on screen, marked as not saved.
  installHost(CODEX_STREAM);
  const seen = watchStore();
  const settled = settleRecorder(false);
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("the settle was attempted", settled.outcomes.length === 1);
  check("...and its failure is shown on the turn", seen.errors.length === 1 && /saved/.test(seen.errors[0] ?? ""),
    JSON.stringify(seen.errors));
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
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settleRecorder().onSettle }).finished;
  check("another turn's line is not appended", seen.deltas.join("") === "mine", JSON.stringify(seen.deltas.join("")));

  // ...WHILE THIS TURN'S OWN FIRST LINE, printed in that same window, still lands.
  installHost(['{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'], {
    earlyLines: ['{"type":"item.completed","item":{"type":"agent_message","text":"fast"}}'],
    foreignLines: ['{"type":"item.completed","item":{"type":"agent_message","text":"stale"}}'],
  });
  const fast = watchStore();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settleRecorder().onSettle }).finished;
  check("...a fast first line from this turn is kept", fast.deltas.join("") === "fast", JSON.stringify(fast.deltas.join("")));
  check("...and the other turn's is still dropped", !fast.deltas.join("").includes("stale"));
}

console.log("\ncancelling kills the process that is spending the plan");
{
  const host = installHost(CODEX_STREAM, { delayMs: 200 });
  const seen = watchStore();
  const settled = settleRecorder();
  const turn = runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle });
  // Wait for the id to come back, then cancel before the stream arrives.
  await sleep(50);
  turn.cancel();
  check("the shell is told to kill the turn", host.cancelled.length === 1, JSON.stringify(host.cancelled));
  await turn.finished;
  // A STOP IS NOT A FAILURE. It used to end as "the provider returned no answer", because a killed
  // process prints nothing more and nothing here knew somebody had asked for that.
  check("...and the run settles as stopped, not failed",
    settled.outcomes.length === 1 && settled.outcomes[0]?.status === "stopped" && settled.outcomes[0]?.error === null,
    JSON.stringify(settled.outcomes));
  check("...with nothing claimed to have arrived after the kill", seen.deltas.length === 0, JSON.stringify(seen.deltas));
}

console.log("\na Stop pressed before the shell has named the process still stops it");
{
  // THE WINDOW BETWEEN ASKING THE SHELL AND HEARING BACK. A cancel there had no id to name, so the
  // process started anyway and spent the plan with nobody left to stop it.
  const host = installHost(CODEX_STREAM, { delayMs: 200 });
  watchStore();
  const settled = settleRecorder();
  const turn = runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle });
  turn.cancel();
  await turn.finished;
  check("the shell is told to kill it as soon as it has an id", host.cancelled.length === 1, JSON.stringify(host.cancelled));
  check("...and it settles as stopped", settled.outcomes[0]?.status === "stopped", JSON.stringify(settled.outcomes));
}

console.log("\na turn the shell ended at its deadline settles as a failure that says so");
{
  // NOBODY PRESSED STOP, so it is not a stop — and it is not silence either. The shell names the
  // deadline on the last event, and what arrived before it is kept.
  const sentence = "The answer ran past 15 minutes, so Jaroku stopped it. Ask again, or try a lower effort.";
  installHost(['{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"so far"}}}'], { endError: sentence });
  watchStore();
  const settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "anthropic", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("the turn settles as an error with the shell's sentence",
    settled.outcomes[0]?.status === "error" && settled.outcomes[0]?.error === sentence, JSON.stringify(settled.outcomes[0]));
  check("...keeping what had arrived", settled.outcomes[0]?.answer === "so far", JSON.stringify(settled.outcomes[0]));
}

console.log("\nStop reaches the process from this tab and from any other");
{
  // SOURCE-READ, because the socket is the half this suite does not stand up. What is checkable is that
  // a running run is kept where a Stop can find it, and that both roads to a Stop reach it.
  const socket = readFileSync(fileURLToPath(new URL("./socket.ts", import.meta.url)), "utf8");
  check("a running subscription turn is kept where Stop can find it",
    /localTurns\.set\(run\.runId, \{ threadId: run\.threadId, turn \}\);/.test(socket));
  check("...and let go of once it has finished", /turn\.finished\.then\(\(\) => localTurns\.delete\(run\.runId\)\)/.test(socket));
  check("the server's stop cancels the run it names",
    /msg\.type === "stop"\) localTurns\.get\(msg\.runId\)\?\.turn\.cancel\(\)/.test(socket));
  const stop = socket.slice(socket.indexOf("export function sendStopChat"), socket.indexOf("export function sendStopChat") + 700);
  check("this tab's own Stop cancels its run in the open conversation at once",
    /for \(const \{ threadId: t, turn \} of localTurns\.values\(\)\) if \(t === threadId\) turn\.cancel\(\);/.test(stop));
}

console.log("\nin a browser it settles as a failure that says why");
{
  delete (globalThis as Record<string, unknown>).__TAURI__;
  const seen = watchStore();
  const settled = settleRecorder();
  await runLocalTurn({ ...base, provider: "openai", prompt: "hi", onSettle: settled.onSettle }).finished;
  check("a browser reports that this needs the desktop app",
    settled.outcomes[0]?.status === "error" && settled.outcomes[0]?.error?.includes("desktop app") === true,
    JSON.stringify(settled.outcomes[0]));
  check("...and streamed nothing", seen.deltas.length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

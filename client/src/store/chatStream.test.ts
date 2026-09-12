// §5's streaming, and the three ways an answer can stop.
//
// WHAT IS WORTH A SUITE. Not the reveal cadence — `useStreamedText` is a rendering detail with its
// own tuning and a `prefers-reduced-motion` escape, and it was already here. What this asserts is
// the STATE MACHINE, because every one of its wrong answers looks plausible on screen:
//
//   A DROPPED SOCKET LEAVING A TURN `streaming` shows a blinking caret under a sentence that ended
//   mid-word, for ever. It reads as the app still working on it.
//
//   A DROPPED SOCKET MARKING A TURN `done` presents half a sentence as the whole answer, which is
//   the one outcome §5 names outright: "partial content must never be mistaken for a finished
//   reply."
//
//   A FAILURE OVERWRITING THE PARTIAL loses the two hundred tokens that did arrive. §7: "partial
//   output is kept… with the failure below them."
//
//   A RECONNECT REPLACING THE THREAD WITH A RECORD THAT HAS NO ANSWERS deletes every reply on
//   screen — silently, because a replace is what a snapshot is supposed to do.
//
//   npm run test:chat-stream

import { threadFor, useChatStore, type ReplyTurn } from "./chatStore.ts";
import type { ThreadItemView } from "../types.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const T = "th-1";
const A = "weather_agent";
const store = () => useChatStore.getState();
const reset = (): void =>
  useChatStore.setState({ threads: {}, pending: [], streamingAgentId: null, streamingThreadId: null });
const turns = () => threadFor(store(), T);
const replies = () => turns().filter((t): t is ReplyTurn => t.role === "jaroku" && t.kind === "reply");
const reply = () => replies()[replies().length - 1];

// --- the ordinary stream ----------------------------------------------------------------------

console.log("\nan answer that arrives");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "why did the last run fail?" });
  check("the question is a user turn", turns()[0]?.role === "user", turns()[0]);
  check("the answer opens streaming", reply()?.status === "streaming", reply());
  check("...and the store knows which thread is live", store().streamingThreadId === T);

  store().replyDelta({ threadId: T, agentId: A, text: "It timed out " });
  store().replyDelta({ threadId: T, agentId: A, text: "at step 7." });
  check("deltas accumulate in order", reply()?.text === "It timed out at step 7.", reply()?.text);

  store().replyDone({ threadId: T, agentId: A });
  check("it settles done", reply()?.status === "done", reply());
  check("nothing is left streaming", store().streamingThreadId === null);
  check("no error is invented", reply()?.error === undefined, reply());
}

// --- §5: the connection dies mid-stream -------------------------------------------------------

console.log("\nan answer the connection cut off");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "what does this agent do?" });
  store().replyDelta({ threadId: T, agentId: A, text: "It watches an inbox and" });
  store().replyInterrupted();

  check("the turn is interrupted, not done", reply()?.status === "interrupted", reply());
  // THE WHOLE POINT. A short answer and a cut-off answer are different things, and only one of them
  // is safe to read as the reply.
  check("...and not left streaming for ever", reply()?.status !== "streaming", reply());
  check("what arrived is kept", reply()?.text === "It watches an inbox and", reply()?.text);
  check("nothing is left streaming", store().streamingThreadId === null);

  // IDEMPOTENT. `onerror` calls `close()` and the browser fires `onclose` too, so this runs twice
  // on the way down.
  store().replyInterrupted();
  check("a second interruption is a no-op", replies().length === 1 && reply()?.status === "interrupted", replies());
}

console.log("\ncut off before the first token");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "hi" });
  store().replyInterrupted();
  check("an empty answer is still marked interrupted", reply()?.status === "interrupted", reply());
  // §7: NEVER A BLANK TURN. The turn exists, it says what happened, and the message the user typed
  // is still in the thread above it — retryable without retyping.
  check("the question survives", turns().some((t) => t.role === "user" && t.text === "hi"), turns());
}

console.log("\na dropped socket with nothing streaming");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "hi" });
  store().replyDone({ threadId: T, agentId: A });
  const before = turns().length;
  store().replyInterrupted();
  // NOT AN INFO TURN. A dropped socket with no answer in flight is the connection banner's
  // business; a line added here would land in whichever conversation happened to be on screen.
  check("a finished turn is not re-marked", reply()?.status === "done", reply());
  check("...and no turn is appended", turns().length === before, turns().length);
}

// --- §7: a failure keeps what arrived AND says what happened ---------------------------------

console.log("\na failure mid-stream");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "summarise the last run" });
  store().replyDelta({ threadId: T, agentId: A, text: "The run started at 10:04 and " });
  store().replyError({ threadId: T, agentId: A, message: "rate limited by anthropic" });

  check("the partial is kept", reply()?.text === "The run started at 10:04 and ", reply()?.text);
  // THE REGRESSION THIS ROW EXISTS FOR. `text: open.text || message` kept the partial and threw the
  // failure away, so a stream that died after two hundred tokens looked like a short answer.
  check("...and the failure is recorded beside it", reply()?.error === "rate limited by anthropic", reply());
  check("the status says error", reply()?.status === "error", reply());
}

console.log("\na failure with nothing streaming");
{
  reset();
  store().replyError({ threadId: T, agentId: A, message: "no API key configured for anthropic" });
  // NEVER SWALLOWED. A failure with no open turn to attach to becomes a visible note rather than
  // nothing at all — §7's "never a blank turn" from the other direction.
  check("it becomes a visible note", turns().some((t) => t.role === "jaroku" && t.kind === "info"), turns());
}

// --- §5: a reconnect rebuilds the conversation rather than emptying it ------------------------

console.log("\na reconnect");
{
  reset();
  const items: ThreadItemView[] = [
    {
      id: "i1", kind: "message", ref_id: null, role: "user",
      body: "which two models are cheapest?", created_at: "2026-09-12T10:00:00.000Z",
      answers: [{ ordinal: 1, body: "GPT-5.6 Luna, then claude-haiku-4-5." }],
    },
    {
      id: "i2", kind: "message", ref_id: null, role: "user",
      body: "what about the second one?", created_at: "2026-09-12T10:01:00.000Z",
      answers: [
        { ordinal: 1, body: "A first answer." },
        { ordinal: 2, body: "A second answer." },
      ],
    },
    { id: "i3", kind: "run", ref_id: "r1", role: null, body: null, created_at: "2026-09-12T10:02:00.000Z" },
  ];
  store().hydrate(T, items);

  const rs = replies();
  check("both exchanges come back with their answers", rs.length === 2, rs.length);
  check("...in order", rs[0]?.text.includes("GPT-5.6 Luna") === true, rs[0]?.text);
  // §6.2: BOTH SIBLINGS ARE RETAINED, and the selected one is what is shown. Retained in the
  // browser's memory was retained until the tab closed.
  check("the selected sibling is on screen", rs[1]?.text === "A second answer.", rs[1]?.text);
  check("...and the other is switchable", rs[1]?.priorVariants?.length === 1, rs[1]?.priorVariants);
  // A REHYDRATED ANSWER IS A RECORD, NOT A STREAM THAT STOPPED.
  check("rehydrated answers are done", rs.every((r) => r.status === "done"), rs.map((r) => r.status));
  check("every turn keeps its durable id", rs.every((r) => Boolean(r.itemId)), rs.map((r) => r.itemId));
  // THE NON-MESSAGE ITEM STILL STUBS, unchanged.
  check("a run still rehydrates as a note",
    turns().some((t) => t.role === "jaroku" && t.kind === "info"), turns());
  // AND NOTHING IS DUPLICATED. §5: "reconnect does not duplicate or reorder the turn." A second
  // hydrate is what a reconnect produces, and it REPLACES.
  store().hydrate(T, items);
  check("hydrating twice does not duplicate", replies().length === 2, replies().length);
}

console.log("\nan exchange with no answer kept");
{
  reset();
  store().hydrate(T, [{
    id: "i1", kind: "message", ref_id: null, role: "user",
    body: "hi", created_at: "2026-09-12T10:00:00.000Z",
  }]);
  // EVERY ANSWER FROM BEFORE MIGRATION 073 HAS NONE, and an empty reply turn would claim the answer
  // was empty. The question comes back and nothing pretends to be the reply.
  check("the question comes back alone", turns().length === 1 && turns()[0]?.role === "user", turns());
  store().hydrate(T, [{
    id: "i1", kind: "message", ref_id: null, role: "user",
    body: "hi", created_at: "2026-09-12T10:00:00.000Z", answers: [{ ordinal: 1, body: "   " }],
  }]);
  check("a whitespace-only answer is not an answer", replies().length === 0, replies());
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

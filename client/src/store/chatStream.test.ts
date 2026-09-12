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

// --- §6.1: Stop --------------------------------------------------------------------------------
//
// THREE THINGS FOLLOW FROM PRESSING IT and only the first is obvious. The partial is retained; the
// turn is a first-class turn afterwards (regenerable, and present in conversation memory as the
// partial answer it actually is); and the cost is the real one — which is settled server-side and
// asserted in `test:chat-stop`, because the counts come off an aborted stream rather than a
// completed one.

console.log("\nan answer somebody stopped");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "explain the whole graph" });
  store().replyDelta({ threadId: T, agentId: A, text: "It starts at the router, which" });
  store().replyStopped({ threadId: T, agentId: A });

  check("the turn is stopped", reply()?.status === "stopped", reply());
  // NOT `done`. §5: "partial content must never be mistaken for a finished reply." Not `error`
  // either — nothing failed, so a turn that read as a failure would blame the product for a button.
  check("...and neither done nor error", reply()?.status !== "done" && reply()?.status !== "error", reply());
  check("what arrived is kept", reply()?.text === "It starts at the router, which", reply()?.text);
  check("no error is invented", reply()?.error === undefined, reply());
  check("nothing is left streaming", store().streamingThreadId === null);
}

console.log("\nstopping during the first token");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "hi" });
  store().replyStopped({ threadId: T, agentId: A });
  // §16'S TURN-ACTION ATTACK. An empty stopped turn is still a turn — never a blank one, and never
  // silently absent.
  check("an empty stopped answer is still a turn", reply()?.status === "stopped", reply());
  check("...and the question survives it", turns().some((t) => t.role === "user" && t.text === "hi"), turns());
}

console.log("\nstop racing the last token");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "hi" });
  store().replyDelta({ threadId: T, agentId: A, text: "Hello — what are we building?" });
  store().replyDone({ threadId: T, agentId: A });
  // THE RACE EVERY Esc PRODUCES: the answer finished, the abort found a closed stream, and a
  // `stopped` arrives afterwards. Demoting a finished answer to a partial one would be a lie about
  // a complete reply.
  store().replyStopped({ threadId: T, agentId: A });
  check("a finished answer stays finished", reply()?.status === "done", reply());
  check("...and keeps all of its text", reply()?.text === "Hello — what are we building?", reply()?.text);
}

console.log("\nstop, then immediately send");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "first" });
  store().replyDelta({ threadId: T, agentId: A, text: "partial" });
  store().replyStopped({ threadId: T, agentId: A });
  store().replyStarted({ threadId: T, agentId: A, question: "second" });
  // §16 ASKS FOR THIS PAIR BY NAME. The stopped turn must not be reopened by the next question's
  // stream — `findReply` looks for a `streaming` reply, and a stopped one is not one.
  const rs = replies();
  check("the stopped turn stays stopped", rs[0]?.status === "stopped", rs[0]);
  check("...and the new answer is its own turn", rs.length === 2 && rs[1]?.status === "streaming", rs.map((r) => r.status));
  store().replyDelta({ threadId: T, agentId: A, text: "fresh" });
  check("deltas land on the new turn only", rs[0]?.text === "partial" && replies()[1]?.text === "fresh",
    replies().map((r) => r.text));
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
  // THROUGH `siblings` SINCE §6.2, not `priorVariants`. The two arrive at different moments and
  // that is the whole distinction: `priorVariants` is this session's own swap, and `siblings` is the
  // record — which is what a reload has and what makes the switcher's numbers and each answer's
  // model survive one.
  check("...and the other is switchable", rs[1]?.siblings?.length === 2, rs[1]?.siblings);
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

// --- §6.2: regenerate produces a sibling, and both are retrievable ---------------------------
//
// THE RULE THIS WHOLE BLOCK IS ABOUT: "regenerate never destroys the previous reply. The new reply
// is a SIBLING, not a replacement." §6.2 gives the argument rather than a preference — branches
// never mutate their parent (v0.1.5), undo restores from a snapshot rather than reversing a diff
// (v0.1.0), an agent's threads survive the agent's deletion — so "a chat surface that overwrites
// the previous answer would be the only place in Jaroku where pressing a button destroys a record."

console.log("\nregenerating in this session");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "which model for classification?" });
  store().replyDelta({ threadId: T, agentId: A, text: "Use Haiku." });
  store().replyDone({ threadId: T, agentId: A });
  const first = reply()!;
  // The server echoes the turn id back on a regeneration, which is what makes it a sibling rather
  // than a second question. Faked here, because the store is what is under test.
  useChatStore.setState((st) => ({
    threads: { ...st.threads, [T]: (st.threads[T] ?? []).map((t) => (t.id === first.id ? { ...t, itemId: "i1" } : t)) },
  }));

  store().replyStarted({ threadId: T, agentId: A, question: "which model for classification?", regenerateOf: "i1" });
  // TWO ANSWERS TO ONE QUESTION, NOT TWO QUESTIONS. §6.2's whole shape: the thread must not grow a
  // second copy of the sentence somebody typed once.
  check("no second question is appended", turns().filter((t) => t.role === "user").length === 1, turns());
  check("...and no second reply turn either", replies().length === 1, replies().length);
  check("the previous answer is retained", reply()?.priorVariants?.[0] === "Use Haiku.", reply()?.priorVariants);

  store().replyDelta({ threadId: T, agentId: A, text: "Use GPT-5.6 Luna." });
  store().replyDone({ threadId: T, agentId: A, usage: {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cost_usd: 0, variant_ordinal: 2, variant_total: 2,
  } });
  check("the new answer is on screen", reply()?.text === "Use GPT-5.6 Luna.", reply()?.text);
  check("...and the switcher has two", reply()?.usage?.variant_total === 2, reply()?.usage);
  // BOTH RETRIEVABLE. A switch back must produce the first answer, not a second copy of the second.
  store().switchVariant({ threadId: T, turnId: "i1", ordinal: 1 });
  check("switching back shows the first answer", reply()?.text === "Use Haiku.", reply()?.text);
  check("...and the second is still reachable", reply()?.priorVariants?.[0] === "Use GPT-5.6 Luna.", reply()?.priorVariants);
}

console.log("\nregenerating ten times");
{
  reset();
  store().replyStarted({ threadId: T, agentId: A, question: "why?" });
  store().replyDelta({ threadId: T, agentId: A, text: "answer 0" });
  store().replyDone({ threadId: T, agentId: A });
  const t0 = reply()!;
  useChatStore.setState((st) => ({
    threads: { ...st.threads, [T]: (st.threads[T] ?? []).map((t) => (t.id === t0.id ? { ...t, itemId: "i1" } : t)) },
  }));
  for (let n = 1; n <= 10; n++) {
    store().replyStarted({ threadId: T, agentId: A, question: "why?", regenerateOf: "i1" });
    store().replyDelta({ threadId: T, agentId: A, text: `answer ${n}` });
    store().replyDone({ threadId: T, agentId: A });
  }
  // §16'S TURN-ACTION ATTACK, BY NAME. Ten regenerations is one turn with eleven answers, not
  // eleven turns and not one answer with ten lost.
  check("ten regenerations make one turn", replies().length === 1, replies().length);
  check("...and one question", turns().filter((t) => t.role === "user").length === 1, turns().length);
  check("...with every earlier answer kept", reply()?.priorVariants?.length === 10, reply()?.priorVariants?.length);
  check("...and the newest on screen", reply()?.text === "answer 10", reply()?.text);
}

console.log("\nregenerating a stopped turn, and a failed one");
{
  for (const [name, settle] of [
    ["stopped", () => store().replyStopped({ threadId: T, agentId: A })],
    ["failed", () => store().replyError({ threadId: T, agentId: A, message: "rate limited" })],
  ] as const) {
    reset();
    store().replyStarted({ threadId: T, agentId: A, question: "why?" });
    store().replyDelta({ threadId: T, agentId: A, text: "half an" });
    settle();
    const t0 = reply()!;
    useChatStore.setState((st) => ({
      threads: { ...st.threads, [T]: (st.threads[T] ?? []).map((t) => (t.id === t0.id ? { ...t, itemId: "i1" } : t)) },
    }));
    // §6.2: "REGENERATE IS AVAILABLE ON A STOPPED TURN, A FAILED TURN, AND A COMPLETED TURN ALIKE."
    // Those are the three where somebody most wants it.
    store().replyStarted({ threadId: T, agentId: A, question: "why?", regenerateOf: "i1" });
    check(`a ${name} turn regenerates in place`, replies().length === 1 && reply()?.status === "streaming", replies());
    check(`...keeping the ${name} partial as a sibling`, reply()?.priorVariants?.[0] === "half an", reply()?.priorVariants);
    store().replyDelta({ threadId: T, agentId: A, text: "a whole answer" });
    store().replyDone({ threadId: T, agentId: A });
    check(`...and the retry settles clean`, reply()?.status === "done" && reply()?.error === undefined, reply());
  }
}

// --- §6.2 + §13.3: siblings from the record, each with its own model -------------------------

console.log("\nsiblings after a reload");
{
  reset();
  store().hydrate(T, [{
    id: "i1", kind: "message", ref_id: null, role: "user",
    body: "which model?", created_at: "2026-09-12T10:00:00.000Z",
    answers: [
      { ordinal: 1, body: "Haiku.", model: "claude-haiku-4-5", provider: "anthropic" },
      { ordinal: 2, body: "Luna.", model: "gpt-5.6-luna", provider: "openai", selected: true },
      { ordinal: 3, body: "Terra.", model: "gpt-5.6-terra", provider: "openai" },
    ],
  }]);
  // §6.2: THE SELECTED ONE IS WHAT IS SHOWN, not the newest. Before migration 074 the switcher was
  // local, so a reload always came back on the last answer generated — which is the one somebody
  // may have switched AWAY from.
  check("the selected sibling is on screen", reply()?.text === "Luna.", reply()?.text);
  check("...and the switcher reports 2 of 3", reply()?.usage?.variant_ordinal === 2 && reply()?.usage?.variant_total === 3, reply()?.usage);
  // §13.3: "TWO SIBLINGS GENERATED ON DIFFERENT MODELS SHOW DIFFERENT MODEL CHIPS." The metadata
  // row reads `usage.model`, so the model has to move with the body.
  check("the model chip names the shown sibling's model", reply()?.usage?.model === "gpt-5.6-luna", reply()?.usage?.model);

  store().switchVariant({ threadId: T, turnId: "i1", ordinal: 1 });
  check("switching shows the first answer", reply()?.text === "Haiku.", reply()?.text);
  check("...and its own model", reply()?.usage?.model === "claude-haiku-4-5", reply()?.usage?.model);
  check("...and its own provider", reply()?.usage?.provider === "anthropic", reply()?.usage?.provider);
  check("...and the count follows", reply()?.usage?.variant_ordinal === 1, reply()?.usage);

  store().switchVariant({ threadId: T, turnId: "i1", ordinal: 3 });
  check("switching forward works too", reply()?.text === "Terra." && reply()?.usage?.model === "gpt-5.6-terra", reply()?.usage);
  // AN ORDINAL NOTHING PRODUCED MOVES NOTHING. A client that asks for variant 9 of a three-variant
  // turn has raced a regeneration or is simply wrong.
  store().switchVariant({ threadId: T, turnId: "i1", ordinal: 9 });
  check("an ordinal nothing produced is a no-op", reply()?.text === "Terra.", reply()?.text);
  // NOTHING IS DESTROYED BY SWITCHING. Every body is still reachable after moving through all three.
  check("every sibling survives switching", reply()?.siblings?.length === 3, reply()?.siblings?.length);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

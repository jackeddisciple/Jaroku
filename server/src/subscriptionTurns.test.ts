// A subscription turn the server prepared, and the app that is answering it.
//
// WHAT IS WORTH A SUITE. The registry is small and every one of its wrong answers is quiet: a settle
// accepted from the wrong socket erases somebody else's answer; a turn nobody settles keeps its
// conversation "still answering" for ever; a timer that fires after a settle reports a finished answer
// as abandoned. The second half reads index.ts and wsRelay.ts for the seams a registry cannot see —
// that a subscription turn never reaches an API key, and that its run goes to one socket.
//
//   npm run test:subscription-turns

import { readFileSync } from "node:fs";

import { SubscriptionTurns, SUBSCRIPTION_TURN_TIMEOUT_MS } from "./subscriptionTurns.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A clock the suite advances by hand, so a twenty-minute timeout takes no time at all. */
function manualClock() {
  const pending: { at: number; fn: () => void; cancelled: boolean }[] = [];
  let now = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      const entry = { at: now + ms, fn, cancelled: false };
      pending.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    advance(ms: number): void {
      now += ms;
      for (const e of pending.splice(0)) {
        if (e.cancelled) continue;
        if (e.at <= now) e.fn();
        else pending.push(e);
      }
    },
  };
}

const owner = { workspaceId: "ws-1", requestId: "req-a", threadId: "th-1" };

console.log("\na turn is settled by the app it was handed to, and by nobody else");
{
  const clock = manualClock();
  const timedOut: string[] = [];
  const turns = new SubscriptionTurns<typeof owner & { note: string }>((t) => timedOut.push(t.runId), 1000, clock.schedule);
  const open = turns.open({ ...owner, note: "hi" });
  check("the server mints the run id", typeof open.runId === "string" && open.runId.length >= 32, open.runId);
  check("...a different one for every turn", turns.open({ ...owner, threadId: "th-2", note: "x" }).runId !== open.runId);
  check("another socket cannot take it", turns.take(open.runId, { workspaceId: "ws-1", requestId: "req-b" }) === null);
  check("...nor the same socket id in another workspace", turns.take(open.runId, { workspaceId: "ws-2", requestId: "req-a" }) === null);
  check("...and trying leaves it waiting", turns.inThread("ws-1", "th-1")?.runId === open.runId);
  const taken = turns.take(open.runId, { workspaceId: "ws-1", requestId: "req-a" });
  check("the socket it was handed to takes it, with what was stored", taken?.note === "hi", JSON.stringify(taken));
  check("...exactly once", turns.take(open.runId, { workspaceId: "ws-1", requestId: "req-a" }) === null);
  clock.advance(5000);
  check("...and a settled turn never times out afterwards", !timedOut.includes(open.runId), timedOut.join(","));
}

console.log("\na turn nobody settles is given up on, once");
{
  const clock = manualClock();
  const timedOut: string[] = [];
  const turns = new SubscriptionTurns<typeof owner>((t) => timedOut.push(t.runId), 1000, clock.schedule);
  const open = turns.open(owner);
  clock.advance(999);
  check("it waits the whole timeout", timedOut.length === 0 && turns.size === 1);
  clock.advance(1);
  check("...then gives the turn up", timedOut.length === 1 && timedOut[0] === open.runId, timedOut.join(","));
  check("...having already let go of the conversation", turns.inThread("ws-1", "th-1") === null && turns.size === 0);
  check("a late settle finds nothing to settle", turns.take(open.runId, owner) === null);
  check("the default leaves room for a slow answer", SUBSCRIPTION_TURN_TIMEOUT_MS >= 10 * 60_000, String(SUBSCRIPTION_TURN_TIMEOUT_MS));
}

console.log("\na turn given up on is gone for good");
{
  const clock = manualClock();
  const timedOut: string[] = [];
  const turns = new SubscriptionTurns<typeof owner>((t) => timedOut.push(t.runId), 1000, clock.schedule);
  const open = turns.open(owner);
  check("dropping hands the turn back", turns.drop(open.runId)?.runId === open.runId);
  check("...once", turns.drop(open.runId) === null);
  clock.advance(5000);
  check("...and its timer never fires", timedOut.length === 0, timedOut.join(","));
  check("conversations are told apart", turns.inThread("ws-1", "th-9") === null);
}

console.log("\nthe chat route hands a subscription turn to the app, never to an API key");
{
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const relay = readFileSync(new URL("./wsRelay.ts", import.meta.url), "utf8");
  const bodyOf = (name: string): string => {
    const from = index.slice(index.indexOf(name));
    return from.slice(0, from.indexOf("\n}\n") + 3);
  };
  const chat = bodyOf("async function chatWithJaroku");
  const handOff = chat.indexOf("await prepareSubscriptionTurn(");
  check("chatWithJaroku hands a subscription turn off", handOff > 0);
  check("...after the question is written and announced",
    handOff > chat.indexOf("await noteUserMessage(ctx, thread, message)") && handOff > chat.indexOf('type: "started"'));
  check("...and before anything resolves a key or opens a stream",
    handOff < chat.indexOf("platformKeyFor(") && handOff < chat.indexOf("await streamExplain("));
  check("...returning from the route once it has", /await prepareSubscriptionTurn\([^;]*\);\s*handedOff = true;\s*return;/.test(chat));
  check("...while the app keeps the conversation's one-at-a-time slot", /if \(!handedOff\) chatting\.delete\(thread\);/.test(chat));
  check("an app that has gone does not hold a conversation", /!relay\.hasRequest\(ctx, held\.requestId\)/.test(chat));

  const prepare = bodyOf("async function prepareSubscriptionTurn");
  check("the variant is opened on the subscription route", /openVariant\([^)]*"subscription"\)/.test(prepare));
  check("...the run goes to the socket that asked", /relay\.sendReply\(ctx, ctx\.requestId, \{\s*type: "run"/.test(prepare));
  check("...and nothing in it reaches for a key or a provider call", !/platformKeyFor|streamExplain|meterPlatformCall/.test(prepare));
  // A JAROKU TURN: it used to be handed the sentence alone.
  check("...but the rules, the context block and the conversation, read as the API path reads them",
    /chatMemory\(ctx, thread, turn\)/.test(prepare) && /chatGrounding\(/.test(prepare) && /system: CHAT_SYSTEM/.test(prepare)
      && /prompt: subscriptionPrompt\(\{ context, history, question: message, closing \}\)/.test(prepare));

  const settle = bodyOf("async function settleSubscriptionTurn");
  check("a settle is taken only by the socket it came from",
    /subscriptionTurns\.take\(cmd\.runId, \{ workspaceId: ctx\.workspaceId, requestId: ctx\.requestId \}\)/.test(settle));
  check("...books no cost", /costUsd: null/.test(settle) && !/meterPlatformCall|costFor\(/.test(settle));
  check("...and releases the conversation", /chatting\.delete\(open\.threadId\)/.test(settle));
  check("recordChatTurn settles a prepared turn before anything else",
    /async function recordChatTurn[\s\S]{0,300}?if \(typeof cmd\.runId === "string"\) \{\s*await settleSubscriptionTurn\(ctx, cmd\);\s*return;/.test(index));

  const stop = bodyOf("function stopChat");
  check("Stop reaches the app answering a subscription turn, whichever tab pressed it",
    /subscriptionTurns\.inThread\(ctx\.workspaceId, threadId\)[\s\S]{0,400}?relay\.sendReply\(ctx, held\.requestId, \{ type: "stop"/.test(stop));

  check("the relay answers one socket by its request id",
    /sendReply\(ctx: TenantContext, requestId: string, event: ReplyEvent, threadId\?: string \| null\): number \{/.test(relay));
  check("...and can tell whether that socket is still there", /hasRequest\(ctx: TenantContext, requestId: string\): boolean \{/.test(relay));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

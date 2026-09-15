// When a chat is given a topic title, and what the title turn is asked.
//
//   npm run test:topic-title

import type { ChatTurn } from "../store/chatStore.ts";
import type { ThreadView } from "../types.ts";
import { TITLE_SYSTEM, TOPIC_WORDS, needsTopicTitle, runTitleTurn, titlePrompt } from "./topicTitle.ts";
import { NEW_CHAT, UNTITLED, chatTitle } from "./chatTitle.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const thread = (over: Partial<ThreadView> = {}): ThreadView =>
  ({ id: "t1", title: "hi", title_is_custom: false, agent_id: null, archived_at: null, status: "idle", ...over }) as ThreadView;
const user = (text: string): ChatTurn => ({ id: `u-${text}`, role: "user", text }) as ChatTurn;
const reply = (status: string): ChatTurn =>
  ({ id: `r-${status}`, role: "jaroku", kind: "reply", status, agentId: "", text: "hello" }) as unknown as ChatTurn;

console.log("\nonly the first exchange of a chat nobody renamed is titled");
{
  check("a first message is titled from that message",
    needsTopicTitle(thread(), [user("  Hi there "), reply("done")]) === "Hi there");
  // THE BUG THIS PINS. The app asks at the moment the CLI ends, and the reply is only marked done when
  // the server answers that settle — so the reply still reads `streaming` here, every time, and a check
  // on it meant no chat was ever titled. Whether the answer finished comes from the turn's outcome.
  check("...even while the reply turn still reads streaming, which it always does at that moment",
    needsTopicTitle(thread(), [user("Hi"), reply("streaming")]) === "Hi");
  check("a second exchange keeps the title it has",
    needsTopicTitle(thread(), [user("Hi"), reply("done"), user("and another"), reply("done")]) === null);
  check("a chat somebody renamed keeps their name",
    needsTopicTitle(thread({ title_is_custom: true }), [user("Hi"), reply("done")]) === null);
  check("a chat this tab does not have is left alone", needsTopicTitle(undefined, [user("Hi"), reply("done")]) === null);
  check("a blank first message is nothing to title from", needsTopicTitle(thread(), [user("   "), reply("done")]) === null);
}

console.log("\nwhat the title turn is asked");
{
  check("the rules cap the title at the same word count the server enforces", TITLE_SYSTEM.includes(`${TOPIC_WORDS} words`));
  check("...and name the greeting case", TITLE_SYSTEM.includes("Greeting"));
  const prompt = titlePrompt("  Build me an agent that triages support email  ");
  check("the prompt carries the first message, trimmed", prompt.endsWith("First message:\nBuild me an agent that triages support email"));
  const long = titlePrompt("x".repeat(5000));
  check("a long paste is cut to its opening", long.length < 2100 && long.endsWith("…"), String(long.length));
}

console.log("\na browser has no plan to ask");
{
  delete (globalThis as Record<string, unknown>).__TAURI__;
  check("with no host the title turn resolves to nothing", (await runTitleTurn({ provider: "anthropic", model: null, prompt: "p" })) === null);
}

console.log("\na shell answers, and only this turn's lines count");
{
  const handlers: ((e: { payload: unknown }) => void)[] = [];
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd !== "provider_turn_start") return null;
        // A line from ANOTHER turn arrives before this one's id is known, then this turn's own lines.
        for (const h of handlers) h({ payload: { turnId: 99, line: JSON.stringify({ type: "result", result: "Wrong" }) } });
        setTimeout(() => {
          for (const h of handlers) {
            h({ payload: { turnId: 7, line: JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Support Email " } } }) } });
            h({ payload: { turnId: 7, line: JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Triage" } } }) } });
            h({ payload: { turnId: 7, done: true } });
          }
        }, 5);
        return 7;
      },
    },
    event: { listen: async (_: string, cb: (e: { payload: unknown }) => void) => { handlers.push(cb); return () => {}; } },
  };
  const title = await runTitleTurn({ provider: "anthropic", model: null, prompt: "p" });
  check("the title is this turn's text", title === "Support Email Triage", String(title));
}

console.log("\na chat waiting for its topic title is a New chat, not its own first line");
{
  check("the stored placeholder reads New chat", chatTitle(UNTITLED) === NEW_CHAT);
  check("...and so does an empty one", chatTitle("  ") === NEW_CHAT);
  check("a real name is shown as it is", chatTitle("Greeting") === "Greeting");
}

console.log(fail === 0 ? "\nall topic-title checks passed" : `\n${fail} topic-title check(s) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

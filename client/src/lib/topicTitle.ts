// A chat's topic title, asked of the same plan that answered it.
//
// THE WAY CLAUDE AND CODEX NAME A CONVERSATION: from what the first message is ABOUT, not from its
// first line. "Hi" is a Greeting; a message that comes straight to the point is named for its point.
// The server already titles a thread from its first line the moment the message lands, so a chat is
// never untitled — this replaces that line with a topic once the first answer has finished.
//
// ON THE USER'S OWN PLAN, NEVER A KEY. Chat on a subscription runs through the provider CLI on this
// machine, and the title is one more short turn on that same CLI: the plan somebody chose to talk on is
// the plan that names the conversation, and Jaroku spends nothing. A browser, or a chat that is not on
// a subscription, keeps its first-line title.
//
// SILENT. The turn streams into nothing on screen and is never recorded as a message; what comes back
// is sent as `titleThread`, which the server cleans, caps at `TOPIC_WORDS`, and applies only to a thread
// nobody has renamed.
//
//   npm run test:topic-title

import type { ChatTurn } from "../store/chatStore.ts";
import type { ThreadView } from "../types.ts";
import { __parseClaudeLine, __parseCodexLine, type Parsed } from "./providerTurn.ts";

/**
 * The most a title may say. The server enforces the same cap; this is what the model is asked for.
 *
 * FOUR, THE PRODUCT OWNER'S CALL ON 2026-09-18: "every thread name should not exceed 4 words". It was
 * five, and five is a title that fits the sidebar and not the thing the sidebar is for — the column is
 * scanned rather than read, and the fifth word is the one that pushes the name past what a 240px row
 * shows. Four is the number, not a preference between four and five: a cap somebody has to choose
 * inside is not a cap.
 */
export const TOPIC_WORDS = 4;

/** How long a title turn may take before it is abandoned and the first-line title stands. */
export const TITLE_TIMEOUT_MS = 60_000;

/** The most of the first message the title turn is shown. A topic is in the opening, not the paste. */
const MESSAGE_CAP = 2000;

/** What the CLI answers by, in place of its own instructions. */
export const TITLE_SYSTEM =
  `You name conversations. Reply with only a title of at most ${TOPIC_WORDS} words that says what the ` +
  "conversation is about, in Title Case. A greeting or small talk is titled Greeting. No quotes, no " +
  "trailing punctuation, no explanation — the title and nothing else.";

/** The one-message prompt a title turn is given. */
export function titlePrompt(message: string): string {
  const text = message.trim();
  const clipped = text.length > MESSAGE_CAP ? `${text.slice(0, MESSAGE_CAP)}…` : text;
  return `Name this conversation from its first message.\n\nFirst message:\n${clipped}`;
}

/**
 * The first message to title from, or null when this chat should not be titled now.
 *
 * ONLY A CHAT NOBODY HAS RENAMED, and only at its FIRST exchange — one message from the user. A second
 * message, or a chat somebody named themselves, keeps the title it has.
 *
 * WHETHER THE ANSWER FINISHED IS THE CALLER'S TO SAY, from the turn's own outcome. It used to be read
 * off the reply turn here, and that is always too early: the app settles the run the moment the CLI
 * ends, and the reply is only marked done when the server's answer to that settle comes back — so at
 * the one moment this is asked, every reply still read `streaming` and no chat was ever titled.
 */
export function needsTopicTitle(thread: ThreadView | undefined, turns: readonly ChatTurn[]): string | null {
  if (!thread || thread.title_is_custom) return null;
  const asked = turns.filter((t) => t.role === "user");
  if (asked.length !== 1) return null;
  const first = asked[0];
  const text = first && first.role === "user" ? first.text.trim() : "";
  return text.length > 0 ? text : null;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
type TurnEvent = { turnId: number; line?: string; done?: boolean; error?: string };

function host(): { invoke: Invoke; listen: Listen } | null {
  const t = (globalThis as {
    __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } };
  }).__TAURI__;
  return t?.core?.invoke && t?.event?.listen ? { invoke: t.core.invoke, listen: t.event.listen } : null;
}

/**
 * Run one silent turn on the provider CLI and resolve to what it said, or null.
 *
 * THE SAME COMMAND AND EVENT a chat turn uses — `provider_turn_start` and `jaroku:provider-turn` —
 * with the same rule about events that arrive before the turn knows its own id: held, then replayed
 * for this turn only. Nothing reaches the conversation. A failure, a stop or the timeout is null.
 */
export function runTitleTurn(opts: { provider: string; model: string | null; prompt: string }): Promise<string | null> {
  const h = host();
  if (!h) return Promise.resolve(null);
  const parse: (raw: unknown) => Parsed | null = opts.provider === "openai" ? __parseCodexLine : __parseClaudeLine;

  return new Promise((resolve) => {
    let text = "";
    let whole = "";
    let failed = false;
    let turnId: number | null = null;
    let settled = false;
    let unlisten: (() => void) | null = null;
    const early: TurnEvent[] = [];

    const finish = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve(answer);
    };
    const timer = setTimeout(() => {
      if (turnId !== null) void h.invoke("provider_turn_cancel", { turnId });
      finish(null);
    }, TITLE_TIMEOUT_MS);

    const onEvent = ({ payload }: { payload: unknown }): void => {
      const ev = payload as TurnEvent;
      if (turnId === null) { early.push(ev); return; }
      if (ev.turnId !== turnId) return;
      if (ev.line) {
        try {
          const parsed = parse(JSON.parse(ev.line));
          if (parsed?.text) text += parsed.text;
          if (parsed?.whole) whole = parsed.whole;
          if (parsed?.error) failed = true;
        } catch {
          // Progress chatter, not an answer.
        }
      }
      if (ev.done) finish(failed || ev.error ? null : (text || whole).trim() || null);
    };

    void (async () => {
      try {
        unlisten = await h.listen("jaroku:provider-turn", onEvent);
        turnId = (await h.invoke("provider_turn_start", {
          provider: opts.provider,
          prompt: opts.prompt,
          model: opts.model,
          effort: null,
          system: TITLE_SYSTEM,
        })) as number;
        if (settled) { void h.invoke("provider_turn_cancel", { turnId }); return; }
        for (const ev of early.splice(0)) onEvent({ payload: ev });
      } catch {
        finish(null);
      }
    })();
  });
}

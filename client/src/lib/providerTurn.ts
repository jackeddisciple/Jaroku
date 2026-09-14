// One Chat turn run on the user's own provider subscription, on this machine.
//
// IT DRIVES THE SAME STORE ACTIONS A SERVER-ANSWERED TURN DOES — `replyStarted`, `replyDelta`,
// `replyDone`, `replyError` — so the conversation renders through exactly one path. The alternative
// was a second set of components for locally-answered turns, which is two implementations of "an
// answer appearing" that drift the first time either is touched. Where the inference happened is a
// fact about billing, not about rendering.
//
// TWO PROTOCOLS, ONE SHAPE. Codex and Claude both emit newline-delimited JSON and agree on nothing
// else, so each gets a reader that knows its own vocabulary and both produce the same three things:
// text as it arrives, a usage record at the end, and an error when there is one.
//
//   codex exec --json      {"type":"item.completed","item":{"type":"agent_message","text":…}}
//                          {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
//   claude -p stream-json  {"type":"stream_event","event":{"delta":{"type":"text_delta","text":…}}}
//                          {"type":"result","usage":{…},"total_cost_usd":…}
//
// NOTHING HERE IS BILLED BY JAROKU, and the usage it reports is recorded for the user's own
// benefit. These tokens were spent against a plan the user already pays for, through a CLI they
// signed into themselves. Sending this to the platform's metering would be charging somebody twice
// for one answer — so the turn is recorded, and the spend is not.

import { useChatStore } from "../store/chatStore.ts";

/** What a finished turn spent, in the shape `replyDone` already takes. */
/**
 * A token count from a provider's own JSON, or zero.
 *
 * `Number("lots")` IS NaN, AND NaN SURVIVES EVERYTHING it touches — it adds, it serialises to
 * `null`, and it lands in a usage record somebody reads as a fact. Caught by this file's suite
 * feeding a non-numeric count through, which is exactly what a provider changing its schema looks
 * like from here.
 */
function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number | null;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;

/** One event of a running turn, as `provider_turn.rs` emits it. */
type TurnEvent = { turnId: number; line?: string; done?: boolean; error?: string };

function host(): { invoke: Invoke; listen: Listen } | null {
  const t = (globalThis as {
    __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } };
  }).__TAURI__;
  return t?.core?.invoke && t?.event?.listen ? { invoke: t.core.invoke, listen: t.event.listen } : null;
}

/** Whether a turn can be run locally at all. False in a browser, where there is no shell. */
export function canRunLocally(): boolean {
  return host() !== null;
}

/** A line of one provider's stream, reduced to what the conversation needs. */
export interface Parsed {
  /** Text to append to the answer. */
  text?: string;
  /**
   * `text` is a WHOLE MESSAGE rather than a piece of one, so it starts a new paragraph.
   *
   * Codex emits each agent message complete, and a turn can carry more than one — a preamble, then
   * the answer. Appended bare they ran together into one sentence; Claude's deltas are pieces of a
   * single message and must not be broken up, which is why this is marked per event.
   */
  block?: boolean;
  /**
   * A COMPLETE message, as opposed to a delta.
   *
   * Both CLIs emit the finished answer a second time after streaming it — Claude as an `assistant`
   * event, Codex as `item.completed`. Appending that alongside the deltas would double every reply,
   * so it is carried separately and used only when no delta ever arrived. That is not hypothetical:
   * `--include-partial-messages` is what produces the deltas, and a turn that ends before any
   * arrive (a refusal, a fast cached reply, a build that ignores the flag) would otherwise render
   * as "the provider returned no answer" while the answer sat in the very next event.
   */
  whole?: string;
  /** The turn finished, and this is what it spent. */
  usage?: TurnUsage;
  /** The provider reported a failure of its own. */
  error?: string;
}

/**
 * Codex's `exec --json` stream.
 *
 * `item.completed` carries a whole message rather than a delta — codex buffers the agent's reply
 * and emits it once — so a Codex turn appears in one piece. That is the protocol's behaviour and
 * not something to paper over with a fake typewriter: a spinner that pretends to stream and then
 * dumps everything is a worse lie than an honest wait.
 */
export function __parseCodexLine(raw: unknown): Parsed | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, any>;
  if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") {
    return { text: e.item.text, block: true };
  }
  if (e.type === "turn.completed") {
    return {
      usage: {
        input_tokens: count(e.usage?.input_tokens),
        output_tokens: count(e.usage?.output_tokens),
        // Codex reports no cost: the turn was drawn from a plan, not priced per token.
        cost_usd: null,
      },
    };
  }
  // TWO SHAPES, AND THE SECOND WAS BEING READ AS THE FIRST. Captured from codex-cli 0.154.0 by asking
  // for a model a ChatGPT sign-in cannot use:
  //
  //   {"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"…\"}}"}
  //   {"type":"turn.failed","error":{"message":"<the same body>"}}
  //
  // `turn.failed` keeps its sentence under `error`, so reading `e.message` turned a specific,
  // actionable refusal into "The provider reported a failure." — masked only while an `error` event
  // happened to arrive first. Both carry the backend's JSON body as a STRING, so the sentence inside
  // it is what reaches the conversation rather than escaped JSON.
  if (e.type === "turn.failed" || e.type === "error") {
    const raw = e.type === "turn.failed" ? (e.error?.message ?? e.message) : e.message;
    return { error: failureSentence(raw) ?? "The provider reported a failure." };
  }
  return null;
}

/**
 * The sentence inside a provider's failure message, which Codex hands back as a JSON body in a string.
 *
 * Unwrapped as far as a `message` or `detail` and no further; a message that is not JSON is already
 * the sentence. Null when there is nothing usable, so the caller's generic fallback stands.
 */
function failureSentence(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  if (!text.startsWith("{")) return text;
  try {
    const body = JSON.parse(text) as Record<string, any>;
    const inner = body?.error?.message ?? body?.detail ?? body?.message;
    return typeof inner === "string" && inner.trim() ? inner.trim() : text;
  } catch {
    return text;
  }
}

/** Claude Code's `--output-format stream-json`, which does emit real token deltas. */
export function __parseClaudeLine(raw: unknown): Parsed | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, any>;
  if (e.type === "stream_event" && e.event?.delta?.type === "text_delta" && typeof e.event.delta.text === "string") {
    return { text: e.event.delta.text };
  }
  if (e.type === "assistant" && Array.isArray(e.message?.content)) {
    const text = e.message.content
      .filter((b: Record<string, unknown>) => b?.type === "text" && typeof b.text === "string")
      .map((b: Record<string, string>) => b.text)
      .join("");
    return text ? { whole: text } : null;
  }
  if (e.type === "result") {
    if (e.is_error === true || e.subtype === "error") {
      return { error: typeof e.result === "string" ? e.result : "The provider reported a failure." };
    }
    return {
      usage: {
        input_tokens: count(e.usage?.input_tokens),
        output_tokens: count(e.usage?.output_tokens),
        // Claude Code DOES report a figure, and it is a client-side estimate of what the same
        // request would cost on the API — not what the plan was charged, which is nothing.
        // Carried because it is the only size signal available, and labelled as an estimate
        // wherever it is shown.
        cost_usd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
      },
    };
  }
  return null;
}

export interface LocalTurn {
  /** Stop the turn. Killing the process is what ends the spend. */
  cancel: () => void;
  /** Resolves when the turn has finished, one way or another. */
  finished: Promise<void>;
}

/** How a local turn ended, which is what the run it answers is settled with. */
export interface LocalTurnOutcome {
  /**
   * `stopped` when somebody stopped it — the process was killed on purpose, and what arrived is kept.
   * `error` covers a refused sign-in, a CLI that could not start, an answer that never came, and a turn
   * the shell ended at its deadline.
   */
  status: "done" | "stopped" | "error";
  /** Everything that arrived — the whole answer, or the part of it before a failure. */
  answer: string;
  usage: TurnUsage | null;
  /** The provider's own sentence when it failed, else null. */
  error: string | null;
}

/**
 * Answer a run the server handed this app, streaming into the turn the server opened.
 *
 * THE SERVER OWNS THE TURN. It wrote the question and announced it with `started` before this was
 * called, so nothing here opens a turn or closes one: the answer's pieces go into that thread's reply
 * as they arrive, and how it ended goes back once, through `onSettle`. The server's settling event is
 * what marks the turn finished — in every tab at once, this one included.
 *
 * EXCEPT WHEN THE SETTLE CANNOT BE SENT. With the socket gone the server will never hear how this
 * ended, so this tab is the only place left to say so — and it does, on the turn itself.
 */
export function runLocalTurn(opts: {
  /** The conversation the server opened the turn in. */
  threadId?: string;
  agentId: string;
  provider: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  /** How the turn ended, sent once. Answers whether it could be sent. */
  onSettle: (outcome: LocalTurnOutcome) => boolean;
}): LocalTurn {
  const h = host();
  const chat = useChatStore.getState();
  const parse = opts.provider === "openai" ? __parseCodexLine : __parseClaudeLine;

  let answer = "";
  /** A whole message held in reserve, used only if no delta ever arrives. See `Parsed.whole`. */
  let whole = "";
  let usage: TurnUsage | null = null;
  let failed: string | null = null;
  let turnId: number | null = null;
  /** Set by `cancel`, so a killed process ends as a stop rather than as a failure. */
  let cancelled = false;
  /**
   * Events that arrived before this turn knew its own id.
   *
   * THE LISTENER HAS TO BE UP BEFORE THE PROCESS STARTS, because a fast turn can print its first line
   * before `invoke` resolves — and until it resolves there is no id to match against. Accepting
   * everything in that window appended a still-running EARLIER turn's output to this one's answer, so
   * the window is held here and replayed, filtered, once the id comes back.
   */
  const early: TurnEvent[] = [];
  let unlisten: (() => void) | null = null;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => { resolveFinished = r; });

  const end = (): void => {
    unlisten?.();
    unlisten = null;
    // A FAILURE IS SETTLED TOO, with whatever arrived before it. The question was written before this
    // run was handed out, so a refused or expired sign-in leaves the message in the thread and the
    // partial with it — never a turn that vanishes on reload.
    const status = cancelled ? "stopped" : failed ? "error" : "done";
    const sent = opts.onSettle({ status, answer, usage, error: status === "error" ? failed : null });
    if (!sent) {
      chat.replyError({
        threadId: opts.threadId,
        agentId: opts.agentId,
        message: failed ?? "This answer arrived, but the connection to Jaroku dropped before it could be saved.",
      });
    }
    resolveFinished();
  };

  if (!h) {
    // A browser has no shell to run this on, and nothing should have handed it a run. Said plainly
    // rather than silently doing nothing.
    failed = "Subscription chat needs the Jaroku desktop app — it runs on the provider CLI installed on your machine.";
    end();
    return { cancel: () => {}, finished };
  }

  void (async () => {
    try {
      // LISTEN BEFORE STARTING. A fast turn can emit its first line before an await resolves, and a
      // listener attached afterwards would miss it — which reads as a turn that answered nothing.
      const onEvent = ({ payload }: { payload: unknown }): void => {
        const ev = payload as TurnEvent;
        // NOT KNOWN YET IS HELD, NEVER ACCEPTED — see `early`.
        if (turnId === null) { early.push(ev); return; }
        if (ev.turnId !== turnId) return;
        if (ev.line) {
          let parsedLine: Parsed | null = null;
          try {
            parsedLine = parse(JSON.parse(ev.line));
          } catch {
            // A line that is not JSON is progress chatter, not an answer. Both CLIs write those to
            // stderr, which the shell keeps out of this stream, so this is belt and braces.
            return;
          }
          if (!parsedLine) return;
          if (parsedLine.text) {
            // A WHOLE MESSAGE AFTER TEXT ALREADY ON THE TURN STARTS A NEW PARAGRAPH — see `Parsed.block`.
            const piece = parsedLine.block && answer.length > 0 ? `\n\n${parsedLine.text}` : parsedLine.text;
            answer += piece;
            chat.replyDelta({ threadId: opts.threadId, agentId: opts.agentId, text: piece });
          }
          if (parsedLine.whole) whole = parsedLine.whole;
          if (parsedLine.usage) usage = parsedLine.usage;
          if (parsedLine.error) failed = parsedLine.error;
        }
        if (ev.done) {
          // NO DELTAS BUT A WHOLE MESSAGE IS STILL AN ANSWER. Rendered at the end rather than as it
          // arrived, which is honest: it did not stream, and pretending otherwise would be a
          // typewriter over text that was already complete.
          if (answer.length === 0 && whole.length > 0) {
            answer = whole;
            chat.replyDelta({ threadId: opts.threadId, agentId: opts.agentId, text: whole });
          }
          // The shell's own error only stands when the provider did not give a better one.
          if (!failed && ev.error) failed = ev.error;
          if (!failed && !cancelled && answer.length === 0) {
            failed = "The provider returned no answer. Check the desktop log for what its CLI reported.";
          }
          end();
        }
      };
      unlisten = await h.listen("jaroku:provider-turn", onEvent);

      // NO DIRECTORY. Where a turn runs is the shell's decision alone — see `chat_dir` in
      // provider_turn.rs. The page used to name one, and every shipped turn ran in /tmp.
      turnId = (await h.invoke("provider_turn_start", {
        provider: opts.provider,
        prompt: opts.prompt,
        model: opts.model,
        effort: opts.effort,
      })) as number;
      // A STOP PRESSED WHILE THE SHELL WAS STARTING had no id to name, so it is carried out now —
      // otherwise the process would run on, spending the plan with nobody left to stop it.
      if (cancelled) void h.invoke("provider_turn_cancel", { turnId });
      // AND NOW THAT IT DOES, what arrived in the meantime is replayed — this turn's own lines in the
      // order they came, and any other turn's dropped rather than appended to this answer.
      for (const ev of early.splice(0)) onEvent({ payload: ev });
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
      end();
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
      if (turnId !== null) void h.invoke("provider_turn_cancel", { turnId });
    },
    finished,
  };
}

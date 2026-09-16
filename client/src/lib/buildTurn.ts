// Answering a PLAN or a GENERATION on the user's own subscription.
//
// WHY THIS EXISTS BESIDE `runLocalTurn`. That one answers a chat turn, and a chat turn's text is a
// reply somebody reads: it streams into the conversation as it arrives. A build turn's text is a
// protocol on its way to a parser — `<<<PLAN section="tools">>>` or `<<<FILE path="agent.py">>>` —
// and must never appear in the conversation. So this is `runTitleTurn`'s shape rather than
// `runLocalTurn`'s: silent, recorded nowhere, and handed straight back to the server.
//
// THE TEXT GOES BACK AS IT ARRIVES, which is the one thing a title turn does not do. The build pane
// streams: on the API path the server watches the model and broadcasts the plan's deltas and each
// file as it is written. When the CLI does the thinking, this app is the only process that sees the
// text, and a generation takes minutes — so it is flushed back on an interval and the server feeds
// it to the same parsers, and every tab sees the build progress exactly as it always has.
//
// BATCHED RATHER THAN PER TOKEN. One frame per `FLUSH_MS` with everything that arrived in it, which
// is strictly less traffic than the API path's own per-delta broadcast.
//
//   npm run test:build-turn

import { __parseClaudeLine, __parseCodexLine, type Parsed } from "./providerTurn.ts";

/** How often accumulated text is sent back while a build turn runs. */
export const FLUSH_MS = 400;

/**
 * How long a build turn may take before it is abandoned.
 *
 * GENERATION IS THE LONG ONE and it is long in minutes, not seconds: a real generation measured on
 * 2026-09-16 took 2m22s and wrote 16,689 output tokens. Fifteen minutes is room for several of those
 * and still inside the server's own twenty-minute hold, so the app gives up before the server does
 * and the person sees a failure rather than a pane that never resolves.
 */
export const BUILD_TIMEOUT_MS = 15 * 60_000;

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
type TurnEvent = { turnId: number; line?: string; done?: boolean; error?: string };

/** How a build turn ended. The server settles the call that is still awaiting this text. */
export interface BuildOutcome {
  status: "done" | "stopped" | "error";
  raw: string;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function host(): { invoke: Invoke; listen: Listen } | null {
  const t = (globalThis as {
    __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } };
  }).__TAURI__;
  return t?.core?.invoke && t?.event?.listen ? { invoke: t.core.invoke, listen: t.event.listen } : null;
}

/**
 * Run one silent turn on the provider CLI for a build, streaming its text back as it arrives.
 *
 * A BROWSER CANNOT ANSWER ONE, and says so rather than hanging: there is no shell, so there is no
 * CLI and no sign-in to answer with. The server is still holding the turn, so the failure has to be
 * reported rather than dropped — which is why this resolves an outcome instead of throwing.
 */
export function runBuildTurn(opts: {
  provider: string;
  model: string | null;
  effort: string | null;
  system: string;
  prompt: string;
  /** Text that has arrived since the last call. Batched — see `FLUSH_MS`. */
  onChunk: (text: string) => void;
}): Promise<BuildOutcome> {
  const h = host();
  if (!h) {
    return Promise.resolve({
      status: "error",
      raw: "",
      error: "This build needs the Jaroku desktop app, where your subscription is signed in.",
      inputTokens: null,
      outputTokens: null,
    });
  }
  const parse: (raw: unknown) => Parsed | null = opts.provider === "openai" ? __parseCodexLine : __parseClaudeLine;

  return new Promise<BuildOutcome>((resolve) => {
    let raw = "";
    let whole = "";
    /** Arrived but not yet sent back. Flushed on the interval, and once more at the end. */
    let pending = "";
    let usage: { input_tokens?: number; output_tokens?: number } | null = null;
    let failed: string | null = null;
    let turnId: number | null = null;
    let settled = false;
    let unlisten: (() => void) | null = null;
    const early: TurnEvent[] = [];

    const flush = (): void => {
      if (!pending) return;
      const text = pending;
      pending = "";
      opts.onChunk(text);
    };
    const ticker = setInterval(flush, FLUSH_MS);

    const finish = (outcome: BuildOutcome): void => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearTimeout(timer);
      // EVERYTHING THAT ARRIVED, BEFORE THE OUTCOME. The server feeds chunks to the same parser the
      // settle then closes, so text still sitting here would reach it after the parser was finished.
      flush();
      unlisten?.();
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      if (turnId !== null) void h.invoke("provider_turn_cancel", { turnId });
      finish({
        status: "error",
        raw,
        error: "The build ran past fifteen minutes, so Jaroku stopped waiting for it.",
        inputTokens: null,
        outputTokens: null,
      });
    }, BUILD_TIMEOUT_MS);

    const onEvent = ({ payload }: { payload: unknown }): void => {
      const ev = payload as TurnEvent;
      if (turnId === null) { early.push(ev); return; }
      if (ev.turnId !== turnId) return;
      if (ev.line) {
        try {
          const parsed = parse(JSON.parse(ev.line));
          if (parsed?.text) { raw += parsed.text; pending += parsed.text; }
          if (parsed?.whole) whole = parsed.whole;
          if (parsed?.usage) usage = parsed.usage as { input_tokens?: number; output_tokens?: number };
          if (parsed?.error) failed = parsed.error;
        } catch {
          // Progress chatter, not an answer.
        }
      }
      if (!ev.done) return;
      // A TURN THAT NEVER SENT A DELTA still has an answer — `whole` is the assistant message the
      // CLI reported in one piece. Sent as a chunk too, or the server's parser sees nothing at all.
      if (!raw && whole) { raw = whole; pending += whole; }
      const error = failed ?? ev.error ?? null;
      finish({
        status: error ? "error" : "done",
        raw,
        error,
        inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
        outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
      });
    };

    void (async () => {
      try {
        unlisten = await h.listen("jaroku:provider-turn", onEvent);
        turnId = (await h.invoke("provider_turn_start", {
          provider: opts.provider,
          prompt: opts.prompt,
          model: opts.model,
          effort: opts.effort,
          system: opts.system,
        })) as number;
        if (settled) { void h.invoke("provider_turn_cancel", { turnId }); return; }
        for (const ev of early.splice(0)) onEvent({ payload: ev });
      } catch (e) {
        finish({
          status: "error",
          raw,
          error: (e as Error)?.message ?? "The provider's CLI could not be started.",
          inputTokens: null,
          outputTokens: null,
        });
      }
    })();
  });
}

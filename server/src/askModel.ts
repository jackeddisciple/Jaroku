// WHO DOES THE THINKING FOR A PLAN OR A GENERATION, and it is no longer always us.
//
// Planning and generation are each ONE call: a system prompt, one user message, a stream of text,
// and a parser on the other end. Nothing about them needs a tool, a second turn or a conversation.
// That is the whole reason this abstraction is possible at all — and why it is an abstraction over
// the CALL rather than a refactor of either module: `planner.ts` and `generator.ts` keep every line
// of their parsing, staging, validation and broadcasting, and only where the text comes from moves.
//
// TWO IMPLEMENTATIONS, AND THE CREDENTIAL IS THE WHOLE DIFFERENCE:
//
//   the API key      `askAnthropic` in claude.ts — the platform's key, or a workspace's own.
//                    Kept for agent RUNS and for what agents do inside themselves, which is where
//                    an API key belongs: a run has no user sitting in front of it.
//   a subscription   the user's own Claude or Codex sign-in, on their machine. The server cannot
//                    use it — a subscription is a CLI sign-in, not a credential you can send — so
//                    the turn is handed to the desktop app and answered there. See
//                    `index.ts#askOnSubscription`.
//
// THE SERVER STILL OWNS EVERYTHING AROUND THE CALL. Which workspace asked, the single-slot plan and
// generation state, the thread the brief was written in, the staging directory, the validator and
// every broadcast. The app answers one question — "what did the model say?" — and settles.

import type { UsageSummary } from "./claude.ts";

/** One model call: a system prompt, one user message, and text streaming back. */
export interface AskRequest {
  system: string;
  user: string;
  /** Called as text arrives. The API path streams; a subscription turn may deliver in one piece. */
  onChunk: (text: string) => void;
}

/** What a call answers with: everything the model wrote, and what it spent. */
export interface AskResult {
  raw: string;
  usage: UsageSummary;
}

/**
 * A model call, however it is made.
 *
 * ASYNC AND NOTHING ELSE. It cannot see the workspace, the thread or the request — everything it
 * needs is in the request, and everything it must not decide stays with the caller. That is what
 * keeps `planner.ts` and `generator.ts` unable to tell which credential answered them.
 */
export type AskModel = (req: AskRequest) => Promise<AskResult>;

/**
 * The sentence a person sees when planning or generation has no plan to run on.
 *
 * ONE STRING, BECAUSE IT IS ONE SITUATION. Planning and generation both run on the user's own
 * subscription now; an API key pays for agent runs and for what an agent does inside itself, and
 * never for this. A workspace with no CLI connected cannot build, and saying so plainly is better
 * than a refusal that reads as a failure.
 */
export const NO_SUBSCRIPTION =
  "Planning and generation run on your own Claude or Codex subscription. Connect one in Settings, " +
  "then try again.";

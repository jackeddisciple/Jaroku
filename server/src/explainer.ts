// Unified composer "explain" (doc §4.7): a streaming prose answer about a trace step, a graph
// node, or the agent — the one genuinely-new composer intent. It never changes code and never
// touches the trace store or the frozen event schema.
//
// It reuses ONLY already-available context (the step the client selected, or the agent's on-disk
// prompt/tools), assembled by the caller. With an Anthropic key it asks claude-haiku-4-5 for a
// concise, grounded answer; without a key it degrades to streaming the factual context itself, so
// "explain" always produces something useful (and is testable on the free path).

import { existsSync, readFileSync } from "node:fs";

import { anthropicClient } from "./claude.ts";
import type { EffortPlan } from "./effort.ts";

export const EXPLAIN_MODEL = process.env.JAROKU_EXPLAIN_MODEL ?? "claude-haiku-4-5";

/** The ceiling THIS call sends. Exported so the effort adapter clamps against the real number
 *  rather than against the model's theoretical maximum — see planEffort's maxOutputTokens. */
export const EXPLAIN_MAX_TOKENS = 700;

const SYSTEM =
  "You explain an AI agent's execution to the developer who built it. Answer the developer's " +
  "question concisely and specifically, grounded ONLY in the provided context (a trace step, a " +
  "graph node, or the agent's files). Do not propose code changes and do not invent details that " +
  "aren't in the context. A few sentences is usually enough.";

export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * A recorded answer, replayed instead of calling the model — §13's fixture.
 *
 * WHAT IT IS FOR. The whole answering path — the fact pack, the prompt, the stream, the citation
 * resolution, the spend attribution, the turn in the thread — is exercisable at zero cost if the
 * one part that costs money can be replayed. `JAROKU_GEN_FIXTURE`, `JAROKU_EDIT_FIXTURE` and
 * `JAROKU_PLAN_FIXTURE` already work this way and this is the fourth.
 *
 * AND THE WARNING §13 ASKS ABOUT, WHICH IS NOT THE SAME WARNING. `planner.ts` says its fixture is
 * the LOUD one because a stale plan feeds a REAL generation — "a forgotten env var silently
 * corrupts genuine output". This one is worse in a different direction: a stale ANSWER is a
 * sentence about what somebody's agent did, delivered in the product's own voice, with citations
 * on it. There is no downstream step to notice; the person reading it is the last check.
 *
 * SO IT REFUSES TO BE QUIET IN TWO WAYS THE OTHER THREE DO NOT:
 *
 *   IT IS OFF UNDER `NODE_ENV=production`, unconditionally, whatever the variable says. A
 *   development convenience that can be turned on in production by an environment variable is a
 *   way to make a deployment answer every question with the same recorded paragraph.
 *
 *   IT SAYS SO IN THE ANSWER ITSELF, not only in the log. The other three replay into a card
 *   somebody can see is canned; this one replays into prose, where a console line nobody is
 *   watching is the only difference between a fixture and a fact.
 */
export function explainFixture(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env["JAROKU_EXPLAIN_FIXTURE"];
  if (!path) return null;
  if (env["NODE_ENV"] === "production") {
    console.warn(
      "[explain] JAROKU_EXPLAIN_FIXTURE is set and is being IGNORED: this is a production process, " +
        "and a recorded answer served as a real one is a sentence about somebody's agent that nothing " +
        "downstream can catch.",
    );
    return null;
  }
  if (!existsSync(path)) {
    console.warn(`[explain] JAROKU_EXPLAIN_FIXTURE points at ${path}, which does not exist — calling the model.`);
    return null;
  }
  return path;
}

/** The prefix a replayed answer carries, so a fixture cannot be mistaken for an answer. */
export const FIXTURE_NOTICE = "(replayed from JAROKU_EXPLAIN_FIXTURE — not a real answer)";

/** What one explain call consumed. The SDK reports `input` EXCLUSIVE of the cached counts. */
export interface ExplainUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ExplainCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  /**
   * What the call cost, when there was one.
   *
   * Optional, and reported SEPARATELY from `onDone` rather than as a field on it, because the
   * two are not the same event: the no-key path streams the raw context and completes without
   * ever talking to a provider, and a `usage` field on `onDone` would then have to be an empty
   * summary — a zero that means "no call" sitting where a zero meaning "free" would go. Not
   * calling this at all is the unambiguous version.
   */
  onUsage?: (usage: ExplainUsage) => void;
}

/** Stream a haiku answer for `question` grounded in `context`. Falls back (on any API error) to
 *  streaming the factual context, so the caller always gets a reply. */
export async function streamExplain(
  context: string,
  question: string,
  cb: ExplainCallbacks,
  /** The workspace's own key, when it has opted its key in. See billing/providerKeys.ts. */
  apiKey?: string,
  /**
   * §3.2 REACHING THE REQUEST, translated by the one adapter and resolved by the caller through
   * the conversation → workspace → default chain. Null when the model has no reasoning control or
   * nothing asked for one, and the request is then exactly the one that shipped.
   */
  effort?: EffortPlan | null,
  /**
   * A different kind of question, asked under different rules (Part 3 §7.2).
   *
   * ONE OPTIONAL ARGUMENT RATHER THAN A SECOND ENGINE, which is §7.2's instruction — "this is the
   * answering engine and you are not writing a second one". Everything either side of it is the
   * part worth not duplicating: the key resolution that makes a workspace's own credential count,
   * the raw-context degradation, the usage report that arrives BEFORE `onDone`, and the error path
   * that still hands back the facts. What genuinely differs between explaining a trace step and
   * answering from the record is the instruction and who is asking, so those are the arguments.
   *
   * Omitted means the explain call that shipped, byte for byte — the same discipline as `effort`
   * being spread rather than set.
   */
  ask?: {
    /** The rules. `prompt.ts` owns every one of them — see `CONVERSATION_SYSTEM`. */
    system?: string;
    /**
     * Who is asking, for the one label in the user message that names them.
     *
     * IT IS NOT COSMETIC. The message says "Developer's question", and the developer who built an
     * agent and the operator who runs it want different answers to the same words — one is owed a
     * stack trace and the other is owed "yes, at 10:04". A prompt that called an operator a
     * developer would be quietly asking for the wrong register on every question.
     */
    askedBy?: string;
    /**
     * A last paragraph, after the question.
     *
     * WHERE THE RULES THAT CARRY DATA GO. `system` cannot hold the agent's display name without
     * changing per agent, which costs the prompt cache on every question; this can, because it is
     * part of the message anyway. Last rather than first because the instructions most likely to be
     * dropped on a long context are the ones furthest from the end — see `conversationClosing`.
     */
    closing?: string;
  },
): Promise<void> {
  // THE FIXTURE IS CHECKED BEFORE THE KEY, so a recorded answer replays whether or not one is
  // configured — which is the point of having it: the path is exercisable on a laptop with no
  // credential and in CI with no network, and it is the same path either way.
  const fixture = explainFixture();
  if (fixture) {
    console.warn(
      `[explain] JAROKU_EXPLAIN_FIXTURE is set — replaying ${fixture}; the question is ignored and ` +
        `the model is NOT being called. Unset it for real answers.`,
    );
    // THE NOTICE IS PART OF THE ANSWER. See `explainFixture` for why this one says so in the prose
    // and the other three fixtures do not: there is no card around it to look canned.
    cb.onDelta(`${FIXTURE_NOTICE}\n\n${readFileSync(fixture, "utf8")}`);
    cb.onDone();
    return;
  }
  // `apiKey` counts as a key. Without this, a workspace running entirely on its own credential
  // — no platform key configured at all — would get the raw-context fallback for every
  // explanation, on a deployment where an explanation was perfectly affordable.
  if (!apiKey && !hasAnthropicKey()) {
    // No key — the factual context IS the answer (no LLM synthesis available).
    // THE FACTS AS FACTS, WHICH IS A BETTER ANSWER THAN AN ERROR AND — for the record-answering
    // caller — a strictly more honest one than a synthesised paragraph. §7.2 calls this degradation
    // a feature here rather than a fallback, and it is what makes the whole answering path
    // replayable at zero cost.
    cb.onDelta(`(No Anthropic key set — showing the raw context.)\n\n${context}`);
    cb.onDone();
    return;
  }
  try {
    const stream = anthropicClient(apiKey).messages.stream({
      model: EXPLAIN_MODEL,
      max_tokens: EXPLAIN_MAX_TOKENS,
      // SPREAD RATHER THAN SET, so a call with no plan is byte-identical to the one that shipped —
      // and the budget inside it was already validated against THIS call's max_tokens by the adapter,
      // not against whatever the model could theoretically produce.
      ...(effort?.thinking?.type === "enabled" ? { thinking: effort.thinking } : {}),
      system: ask?.system ?? SYSTEM,
      messages: [{
        role: "user",
        content: `Context:\n${context}\n\n${ask?.askedBy ?? "Developer"}'s question: ${question}`
          + (ask?.closing ? `\n\n${ask.closing}` : ""),
      }],
    });
    stream.on("text", (t: string) => cb.onDelta(t));
    const final = await stream.finalMessage();
    // Reported before `onDone` so a caller that meters cannot see the answer complete and the
    // charge arrive afterwards — the same "record first, then say it happened" order the trace
    // ingest chain keeps between persisting a step and broadcasting it.
    cb.onUsage?.({
      model: EXPLAIN_MODEL,
      input: final.usage?.input_tokens ?? 0,
      output: final.usage?.output_tokens ?? 0,
      cacheRead: final.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: final.usage?.cache_creation_input_tokens ?? 0,
    });
    cb.onDone();
  } catch (err) {
    // Surface the failure but still hand back the factual context rather than nothing.
    cb.onError(`explain failed (${(err as Error).message}). Raw context:\n\n${context}`);
  }
}

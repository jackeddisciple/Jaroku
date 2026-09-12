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
import { faultError, injectedFault } from "./providerFailure.ts";
import { isOpenAiCompatible, streamOpenAiChat } from "./openaiChat.ts";
import type { ProviderId } from "./providers.ts";
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

/**
 * §6.1: WHAT AN ABORTED CALL ACTUALLY SPENT, or nothing at all.
 *
 * NAMED AND EXPORTED BECAUSE IT IS THE RULE RATHER THAN THE PLUMBING. §6.1 forbids both wrong
 * answers — "records the cost actually incurred, not zero and not the full projected amount" — and
 * they fail in opposite directions:
 *
 *   ZERO IS THE ONE THAT SHIPS. `finalMessage()` never resolves on an aborted stream, so the usage
 *   report that fires on a completed call does not fire at all here. A caller that defaulted the
 *   counts to 0 would record a stopped answer as free, on a call that really consumed every input
 *   token of the prompt — and v0.1.9's whole rule is that a silent zero reads as "this was free"
 *   rather than as "we don't know".
 *
 *   THE PROJECTED AMOUNT IS THE OTHER. Pricing the request as though it had run to `max_tokens`
 *   would charge somebody for an answer they stopped precisely to avoid paying for.
 *
 * SO: the counts the SDK accumulated onto `currentMessage` as `message_delta` frames arrived, and
 * `undefined` when the abort beat the first `message_start` — which is unknown, not zero, and is
 * why the return type is optional rather than a zeroed record.
 */
export function usageFromPartial(
  model: string,
  partial: { usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } } | undefined,
): ExplainUsage | undefined {
  const u = partial?.usage;
  if (!u) return undefined;
  return {
    model,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

export interface ExplainCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  /**
   * The failure, as a sentence AND as the thing that was thrown.
   *
   * `cause` IS THE ADDITION §7 NEEDED. This callback used to receive only a formatted string —
   * "explain failed (…). Raw context: …" — which is a fine answer for `explain`, whose fallback is
   * to hand the facts back, and is unusable for classification: the status, the `retry-after`
   * header and the provider's own error code are all fields on the thrown object, and a caller
   * given a sentence has to parse them back out of prose somebody wrote.
   *
   * OPTIONAL, because the no-key and fixture paths produce no thrown error — and because one of the
   * error paths is this module's own message rather than a provider's.
   */
  onError: (message: string, cause?: unknown) => void;
  /**
   * §6.1: THE ANSWER WAS STOPPED, and what it had spent by then.
   *
   * A CALLBACK OF ITS OWN RATHER THAN `onDone` OR `onError`, because it is neither and the turn
   * renders differently for all three. `onDone` would present a half-answer as the whole one — the
   * exact thing §5 names — and `onError` would put a failure on a turn nothing failed in: somebody
   * pressed a button.
   *
   * IT CARRIES THE USAGE RATHER THAN LEAVING IT TO `onUsage`, and that is the load-bearing half.
   * `finalMessage()` never resolves on an aborted stream, so the usage report that fires on a
   * completed call does not fire here at all — which is how a stopped turn would come to cost
   * `$0.00` for a call that really consumed input tokens. §6.1: "records the cost actually
   * incurred, not zero and not the full projected amount." The SDK accumulates usage onto
   * `currentMessage` as `message_delta` frames arrive, so the number exists; it just has to be
   * read at the moment of the abort rather than waited for.
   *
   * UNDEFINED USAGE IS A REAL ANSWER. A stream aborted before its first `message_start` has no
   * accumulated message and therefore no counts — and unknown is `null`, never zero (v0.1.9).
   */
  onStopped?: (usage?: ExplainUsage) => void;
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

/**
 * What a caller can do to an answer that is still arriving — §6.1.
 *
 * A HANDLE RATHER THAN A REGISTRY. The obvious alternative is a module-level map of thread id to
 * stream, and it is the shape that goes wrong: two subsystems would then decide what "the current
 * stream" is, and `streamExplain` would have to learn what a thread is to key the map — which is
 * the dependency `test:db-boundary` exists to keep out of this file. The caller already knows which
 * conversation it is in; what it lacked was a way to reach the socket, and this is that.
 *
 * `stop()` IS IDEMPOTENT AND SAFE AFTER THE END. A stop that races the last token is the ordinary
 * case — somebody presses Esc as the answer finishes — and it must not throw or produce a second
 * terminal callback.
 */
export interface ExplainHandle {
  stop: () => void;
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
     * The model to ask, when it is not this module's own.
     *
     * IT RIDES WITH THE RULES BECAUSE THE CALLER THAT CHANGES ONE CHANGES THE OTHER. A different
     * kind of question asked under different instructions is also a question worth asking a
     * different model — §11's chat route runs on the cheapest capable one, while explain stays on
     * `EXPLAIN_MODEL` — and a separate positional argument would be a second way to say the same
     * thing about the same call.
     *
     * IT IS REPORTED BACK ON `onUsage` AS ITSELF rather than as `EXPLAIN_MODEL`, which is the half
     * that matters for money: `costFor` prices whatever id it is handed, so a model named here and
     * metered as something else is the v0.1.10 accounting bug in a new place.
     *
     * Omitted means the explain call that shipped, byte for byte — the same discipline as `effort`
     * being spread rather than set.
     */
    model?: string;
    /**
     * WHICH TRANSPORT ANSWERS — `anthropic` (the default) or an OpenAI-compatible one.
     *
     * IT RIDES WITH THE MODEL because a model id only means something against a provider: the same
     * string is a 404 on the wrong one. The composer's selector picks a provider and a model
     * together for exactly that reason, and this is the pair arriving.
     *
     * THIS IS NOT A SECOND ENGINE. Everything either side of the transport is shared — the key
     * resolution, the fixture, §16's fault injection, the raw-context degradation, the usage report
     * that arrives BEFORE `onDone`, the stop handle, the cost read off a partial message, and the
     * error path that hands the thrown value to §7's classifier. What differs between providers is
     * how bytes arrive, and that is all that branches.
     *
     * Omitted means Anthropic, so `explain` and Part 3's answers are byte-identical to the calls
     * they were — the same discipline as `effort` being spread rather than set.
     */
    provider?: string;
    /**
     * THE CONVERSATION SO FAR — §4, and the one argument that turns this into a chat.
     *
     * REAL TURNS RATHER THAN A TRANSCRIPT PASTED INTO `context`. The cheap version folds the
     * history into the context string, and it is worse in two ways that both bite: a model handed
     * its own previous words as quoted material inside a user message treats them as something the
     * user said about it, and the provider's prompt cache has nothing stable to key on because the
     * one message changes completely on every turn. Real `assistant` turns fix both — the prefix is
     * byte-identical from one message to the next, so it caches, and the model's own turns are its
     * own turns.
     *
     * ASSEMBLED BY THE CALLER, like `context`. This module knows how to ask a model a question; it
     * does not know what a thread is, and `test:db-boundary` is what keeps that true — it imports no
     * store and takes no context.
     *
     * Omitted means the single-shot call that shipped, which is what `explain` still is: §4.1 is
     * explicit that explain is deliberately single-shot and "grounded strictly in the selection".
     */
    history?: readonly { role: "user" | "assistant"; content: string }[];
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
  /**
   * Where to put the stop handle, once there is a stream to stop.
   *
   * A CALLBACK RATHER THAN A RETURN VALUE, because this function does not return until the stream
   * has finished — which is precisely when a handle is of no further use. The caller receives it
   * the moment the request is open and the deltas start, which is the window in which Esc means
   * anything.
   *
   * NOT CALLED ON THE FIXTURE OR THE NO-KEY PATH. Both complete synchronously with no provider
   * behind them, so there is nothing to stop; a handle for them would be a control that does
   * nothing, which is worse than no control.
   */
  onHandle?: (handle: ExplainHandle) => void,
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
    // THE MODEL THE CALLER NAMED, falling back to this module's own. One resolution, read twice
    // below — by the request and by the usage report — so the id that was ASKED and the id that is
    // PRICED cannot be two different strings.
    const model = ask?.model ?? EXPLAIN_MODEL;
    const provider = ask?.provider ?? "anthropic";
    // AN OPENAI-COMPATIBLE PROVIDER TAKES THE OTHER TRANSPORT, and everything above this line has
    // already happened: the fixture, the key check, the degradation. Everything below — the usage
    // report before `onDone`, the classified failure, the stop handle — happens for both, which is
    // why this branch is here rather than at the top of the function.
    if (isOpenAiCompatible(provider)) {
      await streamOpenAiVia({
        provider, model, apiKey: apiKey ?? "", context, question, cb, ask, onHandle,
      });
      return;
    }

    // §16's FAULT, THROWN WHERE A REAL ONE WOULD BE — inside this try, so it travels the same
    // path with the same `cause` and the same partial-output behaviour as a provider's own. A
    // harness that threw from outside would be testing the harness.
    //
    // BEFORE THE REQUEST FOR THE ORDINARY CASE, and after the first tokens for `:mid` — which is
    // the half §7.3 is about: "if 200 tokens arrived before a mid-stream 5xx, those 200 tokens
    // stay." A fault that could only fire before the stream opened would never exercise it.
    const fault = injectedFault();
    if (fault && !fault.mid) throw faultError(fault.class);
    const stream = anthropicClient(apiKey).messages.stream({
      model,
      max_tokens: EXPLAIN_MAX_TOKENS,
      // SPREAD RATHER THAN SET, so a call with no plan is byte-identical to the one that shipped —
      // and the budget inside it was already validated against THIS call's max_tokens by the adapter,
      // not against whatever the model could theoretically produce.
      ...(effort?.thinking?.type === "enabled" ? { thinking: effort.thinking } : {}),
      system: ask?.system ?? SYSTEM,
      messages: [
        // THE CONTEXT BLOCK IS ITS OWN TURN WHEN THERE IS A HISTORY, and folded into the question
        // when there is not. Two reasons, and the first is the one that matters: a conversation's
        // turns have to stay in order, and a context block prepended to the LAST user message would
        // put the state of the world after everything that was said about it. The second is the
        // cache — the block and the history are the stable prefix, and the question is the only part
        // that changes.
        //
        // AND THE NO-HISTORY SHAPE IS BYTE-IDENTICAL TO WHAT SHIPPED, which is what keeps `explain`
        // and Part 3's answers exactly the calls they were.
        ...(ask?.history && ask.history.length > 0
          ? [
            { role: "user" as const, content: `Context:\n${context}` },
            { role: "assistant" as const, content: "Understood — I have the context." },
            ...ask.history.map((m) => ({ role: m.role, content: m.content })),
            {
              role: "user" as const,
              content: `${ask?.askedBy ?? "Developer"}'s question: ${question}`
                + (ask?.closing ? `\n\n${ask.closing}` : ""),
            },
          ]
          : [{
            role: "user" as const,
            content: `Context:\n${context}\n\n${ask?.askedBy ?? "Developer"}'s question: ${question}`
              + (ask?.closing ? `\n\n${ask.closing}` : ""),
          }]),
      ],
    });
    let sawText = 0;
    stream.on("text", (t: string) => { sawText += t.length; cb.onDelta(t); });
    // §6.1: THE HANDLE, HANDED OVER THE MOMENT THERE IS SOMETHING TO STOP.
    //
    // `stopped` IS THIS CLOSURE'S OWN FLAG AND NOT `stream.aborted`. The SDK's flag is true after
    // an abort for any reason, including one the runtime caused; this one is true only when
    // somebody asked. The difference decides whether the turn renders as stopped or as failed, and
    // those are different sentences about different events.
    let stopped = false;
    onHandle?.({
      stop: () => {
        if (stopped || stream.ended) return;
        stopped = true;
        stream.abort();
      },
    });
    let final: Awaited<ReturnType<typeof stream.finalMessage>> | null = null;
    try {
      final = await stream.finalMessage();
      // §16's MID-STREAM FAULT, thrown once real text has arrived — so the caller's partial is
      // genuinely non-empty and §7.3's "partial output is kept" is a claim about the same code path
      // a provider's own 5xx would take.
      if (fault?.mid && sawText > 0) throw faultError(fault.class);
    } catch (err) {
      // AN ABORT REJECTS `finalMessage()`, which is the SDK's contract and is why this is a catch
      // rather than a check: there is no resolved message to read on a stopped stream.
      if (stopped) {
        // THE COUNTS THE CALL ACTUALLY SPENT, off the partially-accumulated message — see
        // `usageFromPartial` for why neither zero nor the projected amount is acceptable here.
        cb.onStopped?.(usageFromPartial(model, stream.currentMessage));
        return;
      }
      // §7.3: "COST INCURRED BEFORE A FAILURE IS RECORDED HONESTLY. A failed call that consumed
      // input tokens did cost money."
      //
      // THE SAME READ THE STOP PATH MAKES, for the same reason: a mid-stream 5xx rejects
      // `finalMessage()` too, so the usage report that fires on a completed call does not fire — and
      // a failure that silently cost nothing is the same silent zero v0.1.9 refuses everywhere else.
      // Absent when the failure beat the first `message_start`, which is genuinely unknown.
      const spent = usageFromPartial(model, stream.currentMessage);
      if (spent) cb.onUsage?.(spent);
      throw err;
    }
    // Reported before `onDone` so a caller that meters cannot see the answer complete and the
    // charge arrive afterwards — the same "record first, then say it happened" order the trace
    // ingest chain keeps between persisting a step and broadcasting it.
    cb.onUsage?.({
      model,
      input: final.usage?.input_tokens ?? 0,
      output: final.usage?.output_tokens ?? 0,
      cacheRead: final.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: final.usage?.cache_creation_input_tokens ?? 0,
    });
    cb.onDone();
    return;
  } catch (err) {
    // Surface the failure but still hand back the factual context rather than nothing.
    //
    // AND HAND THE CALLER THE THROWN VALUE. §7 classifies on the status, the `retry-after` header
    // and the provider's own error code, all of which are fields rather than prose — so a caller
    // given only the sentence below would have to parse them back out of a string this function
    // composed. `explain`'s two callers ignore the second argument and keep the behaviour they had.
    cb.onError(`explain failed (${(err as Error).message}). Raw context:\n\n${context}`, err);
  }
}

/**
 * The OpenAI-compatible half of `streamExplain` — same contract, different bytes.
 *
 * A FUNCTION RATHER THAN AN INLINE BRANCH, because the Anthropic path is already forty lines of
 * stream handling and two of them side by side inside one `try` would be unreadable. What matters is
 * that everything OUTSIDE both is shared: the caller cannot tell which transport answered except by
 * the provider it asked for.
 *
 * IT KEEPS EVERY ONE OF THE CONTRACT'S PROMISES, and they are easy to drop one at a time:
 *
 *   `onUsage` BEFORE `onDone`, which is the ordering the trace ingest chain keeps between
 *   persisting a step and broadcasting it — a caller that meters must not see the answer complete
 *   and the charge arrive afterwards.
 *
 *   THE STOP HANDLE, so §6.1's Esc works on every provider. An `AbortController` here is what
 *   `stream.abort()` is there.
 *
 *   THE COUNTS A STOPPED OR FAILED CALL ACTUALLY SPENT. `fetch` gives no partially-accumulated
 *   message the way the Anthropic SDK does, and these APIs report usage only in the final frame —
 *   so an aborted call has no counts at all, and `undefined` is the honest report. Unknown, never
 *   zero (v0.1.9), and §6.1's "not zero and not the full projected amount" is satisfied by saying
 *   nothing rather than by inventing a figure.
 *
 *   THE THROWN VALUE, handed to the caller so §7 can classify it. `streamOpenAiChat` attaches the
 *   status and the `retry-after` header for exactly that.
 */
async function streamOpenAiVia(args: {
  provider: ProviderId;
  model: string;
  apiKey: string;
  context: string;
  question: string;
  cb: ExplainCallbacks;
  ask: { system?: string; history?: readonly { role: "user" | "assistant"; content: string }[]; askedBy?: string; closing?: string } | undefined;
  onHandle: ((handle: ExplainHandle) => void) | undefined;
}): Promise<void> {
  const { provider, model, apiKey, context, question, cb, ask, onHandle } = args;

  // §16's FAULT, ON THIS TRANSPORT TOO. A harness that could only fail Anthropic would leave the
  // provider half of §7 untested on the path most likely to surprise us.
  const fault = injectedFault();
  if (fault && !fault.mid) throw faultError(fault.class);

  const controller = new AbortController();
  let stopped = false;
  onHandle?.({
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
  });

  // THE SAME MESSAGE SHAPE THE ANTHROPIC PATH BUILDS, so a conversation reads identically whichever
  // provider answers it: the context block as its own turn when there is a history, folded into the
  // question when there is not.
  const messages: { role: "user" | "assistant"; content: string }[] =
    ask?.history && ask.history.length > 0
      ? [
        { role: "user", content: `Context:\n${context}` },
        { role: "assistant", content: "Understood — I have the context." },
        ...ask.history.map((m) => ({ role: m.role, content: m.content })),
        {
          role: "user",
          content: `${ask?.askedBy ?? "Developer"}'s question: ${question}`
            + (ask?.closing ? `\n\n${ask.closing}` : ""),
        },
      ]
      : [{
        role: "user",
        content: `Context:\n${context}\n\n${ask?.askedBy ?? "Developer"}'s question: ${question}`
          + (ask?.closing ? `\n\n${ask.closing}` : ""),
      }];

  let sawText = 0;
  let reported: ExplainUsage | undefined;
  try {
    await streamOpenAiChat(
      {
        provider, model, apiKey,
        system: ask?.system ?? SYSTEM,
        messages,
        maxTokens: EXPLAIN_MAX_TOKENS,
        signal: controller.signal,
      },
      {
        onDelta: (t) => { sawText += t.length; cb.onDelta(t); },
        onUsage: (u) => { reported = { ...u }; },
      },
    );
    // §16's MID-STREAM FAULT, after real text has arrived — so the partial the caller keeps is
    // genuinely non-empty.
    if (fault?.mid && sawText > 0) throw faultError(fault.class);
  } catch (err) {
    if (stopped) {
      // NO COUNTS ON AN ABORTED CALL, and that is the truth rather than a gap: these APIs report
      // usage in the final frame only, so a stream cut off before it has none. Unknown, not zero.
      cb.onStopped?.(reported);
      return;
    }
    // WHAT THE FAILED CALL SPENT, IF THE PROVIDER MANAGED TO SAY. §7.3's "cost incurred before a
    // failure is recorded honestly" — usually nothing to report on this shape, and reported when
    // there is.
    if (reported) cb.onUsage?.(reported);
    // THE THROWN VALUE REACHES THE CALLER, which is what §7's classifier reads.
    cb.onError(`chat failed (${(err as Error)?.message ?? String(err)})`, err);
    return;
  }

  // BEFORE `onDone`, like the other transport — see the header.
  if (reported) cb.onUsage?.(reported);
  cb.onDone();
}

// Unified composer "explain" (doc §4.7): a streaming prose answer about a trace step, a graph
// node, or the agent — the one genuinely-new composer intent. It never changes code and never
// touches the trace store or the frozen event schema.
//
// It reuses ONLY already-available context (the step the client selected, or the agent's on-disk
// prompt/tools), assembled by the caller. With an Anthropic key it asks claude-haiku-4-5 for a
// concise, grounded answer; without a key it degrades to streaming the factual context itself, so
// "explain" always produces something useful (and is testable on the free path).

import { anthropicClient } from "./claude.ts";

const EXPLAIN_MODEL = process.env.JAROKU_EXPLAIN_MODEL ?? "claude-haiku-4-5";

const SYSTEM =
  "You explain an AI agent's execution to the developer who built it. Answer the developer's " +
  "question concisely and specifically, grounded ONLY in the provided context (a trace step, a " +
  "graph node, or the agent's files). Do not propose code changes and do not invent details that " +
  "aren't in the context. A few sentences is usually enough.";

export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

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
export async function streamExplain(context: string, question: string, cb: ExplainCallbacks): Promise<void> {
  if (!hasAnthropicKey()) {
    // No key — the factual context IS the answer (no LLM synthesis available).
    cb.onDelta(`(No Anthropic key set — showing the raw context.)\n\n${context}`);
    cb.onDone();
    return;
  }
  try {
    const stream = anthropicClient().messages.stream({
      model: EXPLAIN_MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: `Context:\n${context}\n\nDeveloper's question: ${question}` }],
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

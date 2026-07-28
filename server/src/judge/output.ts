// Extracting an agent's final answer from its trace.
//
// The judge scores the response a user would have seen, so this has to find that one string
// among a trace full of tool calls, routing decisions, and state snapshots. Getting it
// wrong is not a crash — it's the judge confidently scoring the wrong text, which produces
// a plausible-looking number with nothing behind it.
//
// The rule: the LAST llm_call's text content. That is the model's closing turn — after
// every tool result has come back — which is what the graph returns to the user. A tool
// result is not the answer (it's an input to one), and a state snapshot is machinery.
//
// Falls back to the final state's last assistant message when a graph's shape hides the
// closing call, then gives up honestly rather than guessing.

import type { Step } from "../types.ts";

/** Pull display text out of whatever shape the interceptor captured for `output`. */
function textFromLlmOutput(output: unknown): string | null {
  // The tracer emits llm_call output as [{ content, tool_calls? }, ...].
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const gen of output) {
      if (typeof gen === "string") { parts.push(gen); continue; }
      if (typeof gen !== "object" || gen === null) continue;
      const content = (gen as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) parts.push(content);
      // Anthropic-style content blocks: [{type:"text", text:"…"}, …]
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "string") parts.push(block);
          else if (
            typeof block === "object" && block !== null &&
            typeof (block as { text?: unknown }).text === "string"
          ) {
            parts.push((block as { text: string }).text);
          }
        }
      }
    }
    const joined = parts.join("").trim();
    return joined || null;
  }
  if (typeof output === "string") return output.trim() || null;
  return null;
}

/** Last assistant-ish message in a LangGraph state snapshot, if there is one. */
function textFromState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const messages = (state as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m !== "object" || m === null) continue;
    const type = (m as { type?: unknown }).type;
    if (type !== "ai" && type !== "assistant") continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) return content.trim();
  }
  return null;
}

export interface ExtractedOutput {
  text: string;
  /** Where it came from, so an odd score can be traced back to what was actually judged. */
  source: "llm_call" | "state" | "none";
}

/**
 * The agent's final user-facing output.
 *
 * Steps are sorted by `seq` first: they're emitted at END time, so arrival order is not
 * causal order and "the last one" read off the raw array can be the wrong turn entirely.
 */
export function extractAgentOutput(steps: Step[]): ExtractedOutput {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);

  // Walk backwards to the closing model turn that actually said something. A final call
  // that only emitted tool_calls has no text and isn't the answer.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i]!;
    if (s.type !== "llm_call" || s.error) continue;
    const text = textFromLlmOutput(s.output);
    if (text) return { text, source: "llm_call" };
  }

  // Some graphs assemble the reply in a node rather than a model call.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i]!;
    const text = textFromState(s.state_after) ?? textFromState(s.output);
    if (text) return { text, source: "state" };
  }

  // Say so plainly. The judge is told the agent produced nothing, which is a real (and
  // low-scoring) outcome — better than handing it a tool result and calling that the answer.
  return { text: "", source: "none" };
}

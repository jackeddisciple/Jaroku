// Extracting an agent's final answer from its trace — what the Answer card above a finished
// run shows.
//
// A MIRROR OF server/src/judge/output.ts, kept in sync by hand like types.ts. The judge scores
// that string, so the card showing anything else would put one answer on screen and grade
// another. The rule is the judge's: the LAST llm_call's text content — the model's closing
// turn, after every tool result came back — falling back to the final state's last assistant
// message when a graph assembles its reply in a node, and otherwise nothing at all.

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
      // Anthropic-style content blocks: [{type:"text", text:"…"}, …]. A thinking block carries
      // `thinking`, not `text`, so a model's reasoning never reaches the card.
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

/**
 * The agent's final user-facing output, or "" when it produced none.
 *
 * Sorted by `seq` first: steps are emitted at END time, so arrival order is not causal order.
 */
export function extractAgentOutput(steps: readonly Step[]): string {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);

  // A closing call that only emitted tool_calls has no text and isn't the answer.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i]!;
    if (s.type !== "llm_call" || s.error) continue;
    const text = textFromLlmOutput(s.output);
    if (text) return text;
  }

  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i]!;
    const text = textFromState(s.state_after) ?? textFromState(s.output);
    if (text) return text;
  }

  return "";
}

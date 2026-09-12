// The chat route — §2. A conversational reply, on the model that answers cheapest.
//
// WHAT THIS MODULE IS AND IS NOT. It is the chat route's own facts: which model answers, what
// ceiling that call sends, and the context block the answer is grounded in. It is NOT a second
// answering engine — `explainer.ts`'s `streamExplain` is the engine, and §5's instruction is
// explicit that there is one ("this is the answering engine and you are not writing a second
// one"). The dispatch site hands this module's material to that function, exactly as Part 3's
// `answerFromRecord` hands it the rendered record.
//
// AND THE RULES ARE NOT HERE EITHER. `CHAT_SYSTEM` and `chatClosing` live in `prompt.ts` with the
// other four, because a prompt is code that is never compiled and the only thing that notices a
// deleted paragraph is a suite that looks for it in one known place.
//
//   npm run test:chat

/**
 * The model a chat message is answered on.
 *
 * THE CHEAPEST CAPABLE ONE IS THE DEFAULT, which §11.1 asks for and which `runtime/pricing.json`
 * decides: `claude-haiku-4-5` at $1/$5 per million is the cheapest Anthropic entry, and Jaroku's
 * own thinking is Anthropic-only (see `providers.ts`'s note about which calls the platform makes).
 *
 * SEPARATE FROM `EXPLAIN_MODEL`, `PLAN_MODEL`, `JAROKU_GEN_MODEL` AND `JAROKU_EDIT_MODEL` even
 * though it resolves to the same id today — §11.1: "The chat model is separate from the eval, plan
 * and generation models. Changing one must not change another." A constant that read one of the
 * others would make that sentence false the first time somebody set an env var, and it would be
 * false silently.
 *
 * §11's per-conversation selection overrides this; this is the floor underneath it, for a workspace
 * that has never opened the selector.
 */
export const CHAT_MODEL = process.env.JAROKU_CHAT_MODEL ?? "claude-haiku-4-5";

/**
 * The ceiling a chat call sends.
 *
 * SMALLER THAN GENERATION'S AND DELIBERATELY SO. A chat reply that runs to two thousand tokens is
 * a chat reply nobody reads — `CHAT_SYSTEM` asks for a few sentences, and a bound is how that
 * instruction is enforced rather than requested. Exported so the effort adapter validates a
 * thinking budget against the number THIS call sends rather than against the model's theoretical
 * maximum, which is the same reason `EXPLAIN_MAX_TOKENS` is exported.
 */
export const CHAT_MAX_TOKENS = 900;

/** What the context block knows about the agent a conversation is open on. */
export interface ChatGrounding {
  /** The agent's display name, or null for a thread with `agent_id` null. */
  agentName: string | null;
}

/**
 * The context block a chat reply is grounded in — §8.
 *
 * §8.1'S ABSENT-AGENT RULE IS THE ONE DECISION IN HERE. "When no agent is selected — the planning
 * stage, a thread with `agent_id` null — the block says that plainly rather than being omitted, so
 * the model knows the difference between 'no agent' and 'agent unknown'." An omitted block is an
 * absence a model fills in; a block that says the absence out loud is a fact it can answer from.
 *
 * BOUNDED, like every other model-facing text in this codebase (v0.2.1 bounded MCP server text for
 * the same reason) — which is why it is assembled from named fields rather than from whatever a
 * caller happens to hand over.
 */
export function chatContext(g: ChatGrounding): string {
  const lines = [
    g.agentName
      ? `agent:       ${g.agentName}`
      : `agent:       none — this conversation has no agent yet (the planning stage)`,
  ];
  return `JAROKU CONTEXT\n\n${lines.join("\n")}`;
}

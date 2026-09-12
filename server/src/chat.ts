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

// ── §4: thread-scoped conversation memory ───────────────────────────────────────────────────────
//
// "This is the single largest contributor to whether the composer feels mature. Routing can be
// perfect and the product will still feel primitive if every reply arrives with amnesia."
//
// IT READS THREAD OWNERSHIP RATHER THAN INVENTING A SESSION. Threads already made a conversation
// thread-owned; this walks that thread's `thread_items` and the `turn_variants` rows hanging off
// them, and there is no second notion of "the current conversation" anywhere in it. A module that
// kept its own idea of who was talking to whom would be the thing §4.2 warns against in one line.
//
// AND IT IS PURE. Every read is the caller's — the items, the variant bodies, the run outcomes —
// so the assembly, the budget and the truncation notice are all checkable without a database. The
// three things §4.5 asks to be asserted are exactly the three that need no round trip.

/** One turn, as the model will see it. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The window's ceiling, in tokens — §4.2's "bounded by token budget, not turn count".
 *
 * BY BUDGET AND NOT BY TURN COUNT, which is the decision rather than the implementation. Ten turns
 * of "ok" and ten turns each quoting a traceback cost two orders of magnitude apart, and a turn
 * count prices them the same — so a count is either too small for the first conversation or too
 * expensive for the second. A budget is the thing that is actually scarce.
 *
 * A NAMED CONSTANT IN ONE PLACE, which §4.2 asks for in those words, so the window can be widened
 * in one edit and is visible in review. 12,000 is about nine tenths of `claude-haiku-4-5`'s context
 * left for the context block, the system prompt and the answer — deliberately conservative, because
 * the failure at the top end is a provider refusal on somebody's ordinary message.
 */
export const CONTEXT_TOKEN_BUDGET = 12_000;

/**
 * Tokens, estimated — and the estimate is the point rather than a shortcut.
 *
 * FOUR CHARACTERS PER TOKEN is the standard rough figure for English, and what matters here is that
 * it is a CEILING-ish estimate computed the same way every time. A real tokenizer would be a
 * dependency, a per-model table and a round trip, to decide whether to include one more turn of a
 * conversation — and being wrong by a turn costs nothing, while being wrong by a provider refusal
 * costs the message.
 *
 * IT ERRS HIGH ON PURPOSE. Code, JSON and non-Latin scripts all tokenize worse than four
 * characters, and a window that overshoots is a 400 from the provider on a message somebody typed.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** What §4.3 turns a non-message item into: one line, from what the record actually holds. */
export interface ItemForWindow {
  kind: "message" | "plan" | "generation" | "proposal" | "run" | "eval" | "work";
  role: "user" | null;
  /** The user's own prose, on a `message`. Null on everything else. */
  body: string | null;
  /** The row this item points at, for the summaries that need one. */
  refId: string | null;
  /**
   * The answers to this turn, oldest first — `turn_variants` rows with a body.
   *
   * `selected` IS §6.2's SWITCHER, DURABLY (migration 074). False on every row of a turn nobody has
   * switched, which reads as "the newest one" — the same answer this had before the column existed.
   */
  answers: readonly { ordinal: number; body: string | null; selected?: boolean }[];
}

/** The run outcomes the window needs, keyed by run id — `store.runDigests`. */
export type RunDigests = ReadonlyMap<string, { status: string; failedSeq: number | null; failedError: string | null }>;

/**
 * §4.3: a non-message turn, as ONE LINE.
 *
 * WHY NOT THE PAYLOAD. "A thread's history contains plan cards, full-file diffs, generation file
 * lists and trace steps. Sending those verbatim would blow the context window within a few turns
 * and cost a fortune." Full payloads stay reachable through explicit attach — the ⊕ menu — which is
 * exactly what that menu is for.
 *
 * AND WHERE THE RECORD IS THIN, THE LINE IS THIN. §4.3's examples include `[plan confirmed: support
 * agent, 3 tools]`, and that tool count is not durable: a plan lives in `planner.ts`'s memory until
 * it is taken, and `thread_items` keeps its id and its kind. So a plan summarises as a plan, a run
 * summarises with the step and the error the trace store really has, and nothing here invents a
 * number to match an example. A summary that guessed would be §8.3's failure — the product lying
 * about its own state — in the one place the model would believe it completely.
 */
export function summariseItem(item: ItemForWindow, runs: RunDigests): string {
  switch (item.kind) {
    case "run": {
      const d = item.refId ? runs.get(item.refId) : undefined;
      if (!d) return "[run started]";
      if (d.status === "error" && d.failedSeq !== null) {
        // THE ERROR IS TRIMMED, not dropped. A traceback is the whole of what a model needs to say
        // something useful about a failure, and the first line of one is where the exception is.
        const why = (d.failedError ?? "").split("\n")[0]?.trim().slice(0, 120);
        return why
          ? `[run failed at step ${d.failedSeq}: ${why}]`
          : `[run failed at step ${d.failedSeq}]`;
      }
      if (d.status === "error") return "[run failed]";
      if (d.status === "running") return "[run in flight]";
      return "[run completed]";
    }
    case "plan": return "[plan written]";
    case "generation": return "[agent generated]";
    case "proposal": return "[edit proposed]";
    case "eval": return "[eval run]";
    case "work": return "[job given to the deployed agent]";
    // A `message` reaching here has no `user` role, which nothing writes. Its body is still the
    // truest thing available about it.
    default: return item.body ?? "";
  }
}

/** What `conversationWindow` produced, and what it had to leave out. */
export interface ConversationWindow {
  messages: ChatMessage[];
  /** True when the budget forced older turns out. §4.2 requires the model to be TOLD. */
  truncated: boolean;
  /** How many turns did not fit. For the suite and the log, never for a prompt. */
  dropped: number;
}

/**
 * §4.2's window: the preceding turns of this thread, newest-first until the budget is spent.
 *
 * OLDEST DROP FIRST, which is the only sensible direction and is worth saying because the
 * implementation runs the other way: the walk is backwards from the newest turn, spending budget
 * until it runs out, and what is left unvisited is the oldest. Reversing at the end is what makes
 * the result read forwards.
 *
 * AND WHEN TURNS ARE DROPPED THE MODEL IS TOLD — §4.2, and it is the half that is easy to skip.
 * "When turns are dropped, the model is told the conversation was truncated rather than being handed
 * a silently shortened history it will treat as complete." A model given eight turns of a thirty-
 * turn conversation, with nothing saying so, answers "we never discussed that" about something
 * discussed twenty turns ago — confidently, in the product's own voice, which is §8.3's failure
 * again.
 *
 * ONLY THE SELECTED SIBLING PARTICIPATES (§6.2). The selected answer is the LAST variant with a
 * body, which is what a regeneration produces and what the switcher moves; the unselected ones are
 * retained and viewable and are deliberately not fed back — "the unselected siblings are retained
 * and viewable but are not silently fed back to the model."
 *
 * THE CURRENT MESSAGE IS NOT IN HERE. The caller has just written it as a `thread_items` row, so it
 * is the newest item in the list and would arrive twice: once as history and once as the question.
 * `exclude` is the turn id to leave out, and passing it is what makes the count honest.
 */
export function conversationWindow(
  items: readonly ItemForWindow[],
  runs: RunDigests,
  opts: { exclude?: string | null; budget?: number } = {},
): ConversationWindow {
  const budget = opts.budget ?? CONTEXT_TOKEN_BUDGET;
  const out: ChatMessage[] = [];
  let spent = 0;
  let dropped = 0;

  // BACKWARDS, because the budget is spent on the most recent conversation first. A forward walk
  // that stopped at the budget would keep the START of a long thread and drop the part somebody is
  // actually in the middle of.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (opts.exclude && item.refId === opts.exclude) continue;

    const turn: ChatMessage[] = [];
    if (item.kind === "message" && item.role === "user") {
      const body = (item.body ?? "").trim();
      if (body) turn.push({ role: "user", content: body });
    } else {
      const line = summariseItem(item, runs);
      // A SUMMARY IS THE ASSISTANT'S TURN, not the user's. What the line describes is something
      // Jaroku did — a plan it wrote, a run it started, a diff it proposed — and filing it as the
      // user's would make the conversation read as though somebody had typed "[run failed]".
      if (line) turn.push({ role: "assistant", content: line });
    }
    // §6.2: THE SELECTED SIBLING — the one somebody switched to, else the newest that said anything.
    //
    // THE FALLBACK IS NOT A SHORTCUT. A turn nobody has switched has no selected row (migration 074
    // defaults the column false and backfills nothing), and the newest answer is the right default:
    // it is the one on screen, because a regeneration replaces what was showing. The explicit flag
    // only starts deciding anything once there is a choice on the record.
    //
    // AND A TIE GOES TO THE NEWEST, which is why this walks backwards through the selected ones
    // too. Two rows both claiming to be selected can only come from a failed half-transaction, and
    // "the newest one" is the same answer the column's absence gives — so the degradation is to the
    // previous behaviour rather than to an arbitrary one.
    const said = (a: { body: string | null }): boolean => (a.body ?? "").trim().length > 0;
    const newestFirst = [...item.answers].reverse();
    const answered = newestFirst.find((a) => a.selected === true && said(a)) ?? newestFirst.find(said);
    if (answered?.body) turn.push({ role: "assistant", content: answered.body.trim() });
    if (turn.length === 0) continue;

    const cost = turn.reduce((n, m) => n + estimateTokens(m.content), 0);
    // THE FIRST TURN GOES IN WHATEVER IT COSTS. A budget that could reject every turn would hand
    // the model an empty history and a truncation notice, which is strictly worse than one turn
    // over budget — and the one turn in question is the one immediately before the question.
    if (spent + cost > budget && out.length > 0) {
      // EVERYTHING OLDER IS DROPPED, not just this one. Skipping a turn and keeping an older one
      // would hand the model a conversation with a hole in it, which is worse than a short one:
      // a gap it cannot see is a gap it will answer across.
      dropped = i + 1;
      break;
    }
    spent += cost;
    // Unshifted as a unit, so the question and its answer stay adjacent and in order.
    out.unshift(...turn);
  }

  return { messages: out, truncated: dropped > 0, dropped };
}

/**
 * What the model is told when the window was cut — §4.2's notice.
 *
 * IT NAMES NO NUMBER. "Earlier turns are not shown" is actionable; "12 earlier turns are not shown"
 * invites a model to reason about what it cannot see, and to tell the user about the arithmetic of
 * its own context window, which is not a thing anybody asked about.
 */
export const TRUNCATION_NOTICE =
  "This conversation is longer than what follows. Earlier turns are not shown to you. If the "
  + "answer depends on something said earlier that you cannot see, say so rather than assuming it "
  + "was never said.";

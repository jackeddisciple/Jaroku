// Unified composer — intent routing (doc §4.7). ONE composer routes a message by (selection
// context + message intent) into the EXISTING mechanisms; it invents no new backend for intents
// that already have one (edit/fix reuse sendEdit, rerun reuses branchRun). Only "explain" is a
// new, lightweight path. Routing is pure keyword/pattern heuristics — no per-message LLM call; a
// mis-route just needs a rephrase, so the cost of a classifier isn't warranted.
//
// AND ONE OF THE DESTINATIONS IS NOW A CONVERSATION. Every message this function saw used to
// become a plan, an edit or an explanation, because those were the only places to send one — so
// "hi" produced a plan card, in the first ten seconds of somebody's first session. `chat` is the
// route for a message that is none of the five, and it is deliberately the CHEAP side of the
// asymmetry: routed to chat when a plan was wanted costs a rephrase, and routed to plan when a
// greeting was meant costs a real generation call and makes the product look like it cannot read
// plain language.
//
//   npm run test:chat-route

import type { Step } from "../types.ts";
import { jsonPretty } from "./format.ts";

export type ExplainSubject =
  | { kind: "step"; step: Step }
  | { kind: "node"; nodeId: string }
  | { kind: "agent" };

export type Intent =
  /**
   * NOTHING IS BEING BUILT, EDITED, EXPLAINED, FIXED OR RE-RUN — somebody is talking.
   *
   * THE ROUTE THAT WAS MISSING, and the one the composer spends most of its messages on. Every
   * sentence typed into this box used to become a plan, an edit or an explanation, because those
   * were the only destinations there were: "hi" produced a plan card, and a plan card is an
   * expensive, visually heavy, multi-step artefact. The fix is not a better plan card — it is that
   * MOST MESSAGES ARE NOT BUILD REQUESTS and there was no route for them.
   *
   * IT NEVER WRITES. It does not generate files, apply an edit, move a version pointer, start a
   * run, start a deploy or resolve an MCP confirmation. It answers, and where an action is
   * warranted it OFFERS the route rather than taking it. That is the same boundary the composer's
   * ⊕ attach menu already holds — attach brings context in, it never triggers a write — and the
   * same reason the Threads list shows which threads need you without letting you apply their diffs
   * from the row. A conversational surface that can quietly mutate an agent is exactly the thing
   * this product's trust model is built to not have.
   *
   * IT CARRIES NO FIELDS, which is the whole shape of it: every other intent names the thing it
   * acts on, and this one acts on nothing.
   */
  | { kind: "chat" }
  /**
   * `into` NAMES AN EXISTING ROW TO BUILD INTO, and is absent for the ordinary case.
   *
   * A generate with no target creates an agent. A generate WITH one adopts the identity that is
   * already there — the name, the face and the category somebody chose at onboarding — and fills in
   * everything else. It is one field rather than a second kind because the destination is the same
   * planner, the same plan card and the same Approve; what differs is one row's worth of identity,
   * which is exactly what an optional field is for.
   */
  | { kind: "generate"; into?: string }
  | { kind: "replan"; planId: string }
  /**
   * `grounding` NAMES WHAT THE EDIT IS ABOUT, and changes nothing about where it goes.
   *
   * §B.5.2 adds one signal to the router and no new destination. This field is what lets the
   * composer say "edit this agent, from @teammate's comment" instead of just "edit this agent" —
   * which is the whole visible difference, and is why it is optional rather than a second kind.
   */
  | { kind: "edit"; grounding?: "review" }
  | { kind: "fix"; step: Step }
  | { kind: "rerun"; step: Step }
  | { kind: "explain"; subject: ExplainSubject };

export type ComposerContext = {
  agentId: string | null;
  /** A plan awaiting the user's decision. While one is up, a typed message is feedback on
   *  THAT plan, not a request for a new one — the only way to abandon it is Discard. */
  pendingPlanId?: string | null;
  step?: Step; // the selected trace step, if any
  nodeId?: string | null; // the selected graph node, if any (takes precedence for "explain")
  /**
   * §B.5.2: whether the composer is carrying a review-comment chip.
   *
   * ONE NEW SIGNAL AND NOT A NEW INTENT. A comment pinned to a specific file and line is
   * unambiguous in exactly the way "a failed step is selected → fix" already is, so it routes to
   * the EDIT loop — which is where a change to an agent's code has always gone. A `review` intent
   * would be a second write path to the same place, with its own diff card and its own Apply, and
   * §B's governing constraint is that nothing adds a second way to make code land.
   */
  hasReviewComment?: boolean;
  /**
   * Whether the selected agent is an identity with no code behind it (`AgentSummary.draft`).
   *
   * IT SHORT-CIRCUITS THE WHOLE LADDER, ahead of even the question test, and that is deliberate.
   * Every route below this line needs something a draft does not have: a step to re-run, an error
   * to fix, code to edit, a trace to explain. And the sentence somebody types at a draft is a
   * DESCRIPTION of the agent they want — which routinely opens "when a customer emails…", a word
   * `RE_EXPLAIN` matches. Ranking the draft check below it would send the commonest first sentence
   * in the product to a route that has nothing to answer with.
   */
  agentIsDraft?: boolean;
};

/**
 * A message that is social and nothing else — the one thing no other route can want.
 *
 * A CLOSED LIST, AND DELIBERATELY NOT THE SHAPE §3 WARNS ABOUT. The unbounded-pattern-list failure
 * is pattern-matching TOWARD the expensive route: every miss produces another pattern for "this is
 * a build request", and every such pattern widens the false-positive surface on the side where
 * being wrong costs a generation. This matches toward the cheap route, over a vocabulary that does
 * not grow — a greeting, a thanks, a farewell, an acknowledgement — and a miss here costs nothing
 * because the message simply falls through to where it went before.
 *
 * ANCHORED AT BOTH ENDS. `^…$` is what makes it the WHOLE message rather than a word in one:
 * "thanks, now fix the retry logic" is an edit request that happens to open politely, and a rule
 * that matched "thanks" anywhere would send it to a route that cannot edit anything. The optional
 * trailing punctuation and the optional second word are there because "hi!", "hey there" and
 * "thanks so much" are the same message.
 */
const RE_SOCIAL =
  /^(hi|hii+|hey|hello|hiya|yo|sup|howdy|morning|good (morning|afternoon|evening)|thanks|thank you|thx|ty|cheers|ok|okay|k|cool|nice|great|awesome|perfect|got it|sounds good|never ?mind|nvm|bye|goodbye|see ya|later|test|testing|ping)\b[\s!.,?]*(there|all|again|jaroku|so much|a lot|very much|mate|man|folks)?[\s!.,?]*$/i;

const RE_EXPLAIN = /^(why|what|whats|what's|how|when|where|which|who|explain|describe|tell me|walk me)\b|\bexplain\b/i;
const RE_RERUN = /\b(re-?run|retry|run again|try again|re-?execute|from (here|step|this|that))\b/i;
const RE_FIX = /\b(fix|repair|resolve|debug|correct|patch|make (it|this|that) (work|pass|succeed))\b/i;

/** Decide where a composer message goes, given what's selected in the UI. Precedence:
 *  explain (question phrasing) → rerun (needs a step) → fix (needs a failed step) → edit. With no
 *  agent selected there's nothing to edit/explain, so it's a plan for a new agent — or, if one
 *  is already on screen awaiting a decision, a revision of it. */
export function classifyIntent(text: string, ctx: ComposerContext): Intent {
  const t = text.trim();
  // FIRST IN THE LADDER, ABOVE EVEN THE PENDING-PLAN RULE, and that ordering is the decision.
  //
  // Every rung below this one sends the message somewhere that spends money: a plan, a revision of
  // a plan, a generation into a draft, an edit, an explanation. "hi" belongs at none of them, and
  // ranking this check lower would put the commonest first sentence in the product behind whichever
  // of those matched first — which is the defect §0 opens with.
  //
  // IT OUTRANKS `pendingPlanId` DELIBERATELY. The standing rule is that while a plan awaits a
  // decision a typed message is feedback on THAT plan, and it is the right rule for a sentence. It
  // is not the right rule for "thanks": re-planning against a greeting costs a real call and
  // produces a card nobody asked for, and a plan is only abandoned by Discard either way — so the
  // card is still there, unchanged, when the conversation moves on.
  if (RE_SOCIAL.test(t)) return { kind: "chat" };
  if (!ctx.agentId) {
    return ctx.pendingPlanId ? { kind: "replan", planId: ctx.pendingPlanId } : { kind: "generate" };
  }
  // A DRAFT IS A NAME AND A FACE. Nothing below this line applies to it, so it never reaches them.
  // The pending-plan rule still comes first for the same reason it does above: while a plan is on
  // screen awaiting a decision, what somebody types is feedback on THAT plan.
  if (ctx.agentIsDraft) {
    return ctx.pendingPlanId
      ? { kind: "replan", planId: ctx.pendingPlanId }
      : { kind: "generate", into: ctx.agentId };
  }

  const step = ctx.step;
  const nodeId = ctx.nodeId ?? undefined;

  if (RE_EXPLAIN.test(t)) {
    if (nodeId) return { kind: "explain", subject: { kind: "node", nodeId } };
    if (step) return { kind: "explain", subject: { kind: "step", step } };
    return { kind: "explain", subject: { kind: "agent" } };
  }
  if (RE_RERUN.test(t) && step) return { kind: "rerun", step };
  if (RE_FIX.test(t) && step?.error) return { kind: "fix", step };
  // §B.5.2's one new signal. It lands on `edit`, which is where the default already goes — and that
  // is the design rather than a coincidence: the signal exists so the route LABEL can name what is
  // grounding the edit, not to send it somewhere new. A step or a node still wins, because somebody
  // who selected one and then typed is looking at that.
  if (ctx.hasReviewComment && !step && !nodeId) return { kind: "edit", grounding: "review" };
  return { kind: "edit" };
}

/** A one-line, human summary of where a message will route — shown live by the composer so the
 *  routing is transparent and teachable. */
export function routeLabel(intent: Intent): string {
  switch (intent.kind) {
    // NOT "chat", WHICH NAMES THE MECHANISM. Every other label in this function says what will
    // HAPPEN in the words a person would use, and this one has to as well — a preview reading "chat"
    // beside a send button tells somebody the name of a route rather than what pressing it does.
    case "chat": return "answer, without building anything";
    case "generate": return intent.into ? `plan ${intent.into}` : "plan a new agent";
    case "replan": return "revise the plan";
    case "edit":
      return intent.grounding === "review" ? "edit this agent, from the review comment" : "edit this agent";
    case "fix": return `fix step #${intent.step.seq}`;
    case "rerun": return `re-run from step #${intent.step.seq}`;
    case "explain":
      return intent.subject.kind === "step"
        ? `explain step #${intent.subject.step.seq}`
        : intent.subject.kind === "node"
          ? `explain node ${intent.subject.nodeId}`
          : "explain this agent";
  }
}

/** Fix prompt for the edit/fix loop (doc §4.7.1): the failing step + its error + a little input
 *  context, framed as an edit instruction. Shared with the old One-Click Fix, now reached by
 *  typing "fix this" with a failed step selected. */
export function fixPrompt(step: Step): string {
  const lines = [
    `The trace step "${step.name}" (${step.type}) failed with this error:`,
    "",
    (step.error ?? "").trim(),
  ];
  const input = jsonPretty(step.input);
  if (input && input.length <= 600) lines.push("", "It was called with:", input);
  lines.push("", "Please fix the agent's code so this step succeeds.");
  return lines.join("\n");
}

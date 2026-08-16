// Unified composer — intent routing (doc §4.7). ONE composer routes a message by (selection
// context + message intent) into the EXISTING mechanisms; it invents no new backend for intents
// that already have one (edit/fix reuse sendEdit, rerun reuses branchRun). Only "explain" is a
// new, lightweight path. Routing is pure keyword/pattern heuristics — no per-message LLM call; a
// mis-route just needs a rephrase, so the cost of a classifier isn't warranted.

import type { Step } from "../types.ts";
import { jsonPretty } from "./format.ts";

export type ExplainSubject =
  | { kind: "step"; step: Step }
  | { kind: "node"; nodeId: string }
  | { kind: "agent" };

export type Intent =
  | { kind: "generate" }
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
};

const RE_EXPLAIN = /^(why|what|whats|what's|how|when|where|which|who|explain|describe|tell me|walk me)\b|\bexplain\b/i;
const RE_RERUN = /\b(re-?run|retry|run again|try again|re-?execute|from (here|step|this|that))\b/i;
const RE_FIX = /\b(fix|repair|resolve|debug|correct|patch|make (it|this|that) (work|pass|succeed))\b/i;

/** Decide where a composer message goes, given what's selected in the UI. Precedence:
 *  explain (question phrasing) → rerun (needs a step) → fix (needs a failed step) → edit. With no
 *  agent selected there's nothing to edit/explain, so it's a plan for a new agent — or, if one
 *  is already on screen awaiting a decision, a revision of it. */
export function classifyIntent(text: string, ctx: ComposerContext): Intent {
  const t = text.trim();
  if (!ctx.agentId) {
    return ctx.pendingPlanId ? { kind: "replan", planId: ctx.pendingPlanId } : { kind: "generate" };
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
    case "generate": return "plan a new agent";
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

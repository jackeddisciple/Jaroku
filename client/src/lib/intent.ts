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
// AND CHAT IS THE DEFAULT, WHICH IS §3 AND IS THE MOST IMPORTANT DECISION IN THIS FILE.
//
// The tempting implementation of "route greetings to chat" is a longer list of patterns pointing at
// PLAN, and it is the wrong shape. Two reasons, and the second is the one that does not go away:
//
//   FALSE POSITIVES. "fix the retry logic in my webhook agent" is a noun phrase plus a capability.
//   It is an edit request, and any pattern broad enough to catch a real brief catches it too.
//
//   THE LIST IS UNBOUNDED. Every miss produces another pattern, and every pattern widens the
//   false-positive surface. "kuch aisa jo mails padhe aur summary bheje" is a genuine build request
//   matching no English noun-phrase pattern; so is "I need something to watch my inbox".
//
// THE ASYMMETRY DECIDES IT. Routed to chat when a plan was wanted: a conversational reply, one
// click (§15.1), a few seconds and a fraction of a cent. Routed to plan when chat was wanted: a
// full plan card in response to "hi", a real generation call, and a product that looks like it
// cannot read plain language. Those are not remotely the same error, so the default sits on the
// cheap side and PLAN has to prove itself — with positive evidence, never with the mere absence of
// other signals.
//
// WHAT DID NOT CHANGE. Selection-aware routing wins, exactly as it did: a selected failed step plus
// "fix this" is still `fix`, a selected node plus "why" is still `explain`, a pending plan still
// takes feedback, a draft still builds into its own row, and an agent selected plus a change
// request is still `edit`. §3 governs what happens when nothing else claims the message.
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

// ── §3: what counts as evidence that somebody wants something BUILT ────────────────────────────

/**
 * The bar plan has to clear — §3.3 rule 4, and this is the one place it is written.
 *
 * A NAMED CONSTANT RATHER THAN A NUMBER INLINED IN A CONDITION, which the rule asks for in those
 * words, and the reason is review rather than tidiness: this number decides whether somebody's
 * sentence costs a generation call, and a `>= 2` buried in an `if` is a product decision that is
 * invisible in a diff.
 *
 * TWO MEANS TWO INDEPENDENT SIGNALS. One signal is a noun phrase or a verb, and either alone is
 * what produces the false positives §3.1 names — "my webhook agent" is an artifact word in an edit
 * request, and "I need a break" is a build verb in a sentence about nothing. Two signals that agree
 * is the cheapest thing that is not either of those. `TRIGGER` is worth both on its own because a
 * trigger-and-action clause is not a noun phrase that might be a brief — it is a description of an
 * automation, which is the thing being built.
 */
export const PLAN_CONFIDENCE = 2;

/**
 * §15.1's band: plan evidence this close to the bar, without clearing it.
 *
 * WHAT IT IS FOR, AND WHY IT IS NOT A CONFIDENCE SCORE ON THE WIRE. §15.1 shows the
 * "Build this as an agent" card "only when the router's confidence for plan was close to the
 * threshold — not on every chat reply, which would be noise", and §13.2 forbids exposing a raw
 * number ("a score without a scale invites the user to reason about a number they cannot
 * calibrate"). A band satisfies both: the arithmetic stays in this file, and what leaves it is one
 * of three words.
 */
export const PLAN_NEAR = 1;

/** The words that name a thing somebody would have Jaroku build. A closed list, on purpose. */
const RE_ARTIFACT =
  /\b(agent|agents|bot|bots|assistant|automation|workflow|pipeline|script|tool|integration|watcher|monitor|scraper|summari[sz]er|responder|notifier|copilot|helper)\b/i;

/** …and the placeholders people use instead of naming one. "something to watch my inbox." */
const RE_PLACEHOLDER = /\b(something|anything|some ?thing|a thing|kuch)\b/i;

/** An ask for a thing to exist. Not `fix`, `add`, `change` — those ask for an existing thing to move. */
const RE_BUILD_VERB =
  /\b(build|create|make me|make a|make an|set ?up|spin ?up|scaffold|design|generate me|write me|i need|i want|i'?d like|can you build|can you make|give me|banao|bana ?do|bana ?do|banana hai|chahiye)\b/i;

/**
 * A clause saying what the thing would DO — the half that turns a noun into a brief.
 *
 * `jo` IS IN HERE WITH `that` AND `which`, which is the whole reason this pattern is not English-
 * only. §3.1 names "kuch aisa jo mails padhe aur summary bheje" as a genuine build request that
 * matches no English noun-phrase pattern, and `jo` is exactly the relative pronoun doing the work
 * in it.
 */
const RE_CAPABILITY = /\b(that|which|who|to|jo)\s+[a-z\u0900-\u097F]{2,}/i;

/**
 * A trigger and an action — the shape of an automation rather than the name of one.
 *
 * WORTH THE WHOLE THRESHOLD, because nothing else reads like this. "when a customer emails us,
 * reply with the refund policy" names no artifact and uses no build verb, and it is unmistakably a
 * description of an agent.
 *
 * THE COMMA (OR `then`) IS LOAD-BEARING. Without it this matches "when did this last run" and
 * "what happens if it times out" — two questions — and a question that routed to plan is the exact
 * defect §3 exists to remove. A trigger clause that has an action after it has a separator before
 * the action, in English and in Hinglish both.
 */
const RE_TRIGGER = /\b(when(ever)?|every time|each time|if)\b[^,?]{4,}(,|\bthen\b|\bto\b\s+\w+)/i;

/**
 * The whole message is an indefinite description of a thing to build.
 *
 * "a support agent". "an inbox watcher". Two words, no verb, and completely unambiguous to a person
 * — somebody typing that into an empty composer wants one. It is worth the whole threshold for the
 * same reason `RE_TRIGGER` is: it is not a fragment that might be a brief, it is a brief.
 *
 * THE INDEFINITE ARTICLE IS THE DISCRIMINATOR, and `RE_ARTIFACT` is the other half. "a question
 * about the retry logic" opens the same way and names no artifact, so it scores nothing here; "my
 * webhook agent" names an artifact and is possessive rather than indefinite, which is what makes
 * "fix the retry logic in my webhook agent" an edit request in §3.1's own example.
 */
const RE_BRIEF = /^(a|an|one|some)\s+[a-z0-9][\w\s/&'-]{1,60}$/i;

/**
 * Asking HOW to build something is not asking for it to be built.
 *
 * A GUARD RATHER THAN A NEGATIVE SIGNAL, so it cannot be outvoted. "how do I build an agent that
 * watches my inbox" scores three signals and is a question about approach — somebody who wanted the
 * agent would have said so. §16 lists "a build request phrased as a question" as an attack, and
 * §3.2's asymmetry says which way an attack like that resolves: to the cheap side, with §15.1's one
 * click available if the router read it wrong.
 *
 * FIRST PERSON ONLY. "can you build me an agent" is a request; "how do I build one" is a question.
 * The difference is who the sentence proposes should do the work.
 */
const RE_ASKING_HOW =
  /^(how (do|would|can|should) (i|we)|what'?s the best way|whats the best way|should (i|we)|is it possible|is there a way|can (i|we))\b/i;

/**
 * A message that ASKS rather than instructs — the test §8.2's six questions have to pass.
 *
 * SEPARATE FROM `RE_EXPLAIN` AND DELIBERATELY BROADER. `RE_EXPLAIN` decides whether a SELECTION
 * gets explained and its behaviour is v0.1.7's, asserted by v0.1.7's own suite; widening it would
 * change where a message with a step selected goes. This decides whether a message with an agent
 * and nothing else selected is a conversation, and it has to catch the half `RE_EXPLAIN` never
 * needed to: "is it deployed", "does it have retries", "did the last run pass" are questions and
 * open with no wh-word at all.
 *
 * THE SUBJECT AFTER THE AUXILIARY IS THE WHOLE DISCRIMINATOR. "can IT read Gmail" asks about the
 * agent; "can YOU add a retry" asks Jaroku to do something, and is a polite imperative wearing a
 * question's clothes. A pattern that took the auxiliary alone would send every politely-phrased
 * edit request to a route that cannot edit anything — which is §3.1's false-positive failure with
 * the sign flipped.
 */
const RE_QUESTION = new RegExp(
  "^(why|what|whats|what's|how|when|where|which|who|whose|explain|describe|tell me|walk me|show me|list)\\b"
  + "|^(is|are|was|were|does|do|did|has|have|had|can|could|will|would|should|any)\\s+"
  + "(it|this|that|the|these|those|there|my|our|its|he|she|they|we|i)\\b",
  "i",
);

/**
 * The verbs that ask an EXISTING thing to move — the ones that mean `edit`.
 *
 * HERE TO PROTECT THE TRAILING-QUESTION-MARK RULE, and for nothing else. "and the cost?" is a
 * follow-up question with no interrogative opener, so the `?` is the only thing marking it — and
 * "add a LIMIT clause?" is an edit request that happens to end the same way. The first word is what
 * tells them apart, so this list gates the `?` rule rather than routing anything itself.
 */
const RE_CHANGE_VERB_FIRST =
  /^(add|remove|change|rename|use|switch|update|set|drop|increase|decrease|rewrite|refactor|fix|make|move|delete|replace|wrap|cache|retry|handle|log|validate|rename|split|merge|extract|inline|bump|pin)\b/i;

/** Romanised-Hindi build markers, beside the English ones rather than instead of them. */
const RE_HINGLISH = /\b(kuch aisa|aisa kuch|banao|bana ?do|banana hai|chahiye|karna hai|bhejne wala|padhne wala)\b/i;

/**
 * WHAT THE ROUTER DECIDED, AND WHY — §3.3 rule 5, and what §13 renders.
 *
 * THE REASON IS PRODUCED AT DECISION TIME AND CARRIED, never reconstructed afterwards. §13.2 is
 * explicit about why: "a reconstruction can disagree with the actual decision and then the
 * explanation is itself a lie." A second function that looked at the message and the context and
 * worked out what the router probably did would be exactly that reconstruction.
 */
export interface Routing {
  intent: Intent;
  /** One line of plain language. "No build-request signal; nothing selected." */
  reason: string;
  /**
   * How near the plan evidence came, as a band — never a number (§13.2).
   *
   * `confident` on a plan route, and on a chat route it is `near` or `none`: §15.1's card appears
   * on `near` and nowhere else.
   */
  planEvidence: "none" | "near" | "confident";
}

/**
 * How much evidence there is that this message asks for something to be built.
 *
 * PURE, AND SEPARATE FROM THE LADDER, so the bands §15.1 reads and the route §3 takes come from one
 * count rather than from two opinions about the same sentence.
 */
function planScore(t: string): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;
  const add = (n: number, name: string): void => { score += n; signals.push(name); };

  if (RE_BRIEF.test(t) && RE_ARTIFACT.test(t)) add(PLAN_CONFIDENCE, "named a thing to build");
  if (RE_TRIGGER.test(t)) add(PLAN_CONFIDENCE, "described a trigger and what should happen");
  if (RE_BUILD_VERB.test(t)) add(1, "asked for something to be built");
  if (RE_ARTIFACT.test(t) || RE_PLACEHOLDER.test(t)) add(1, "named a thing to build");
  if (RE_CAPABILITY.test(t)) add(1, "said what it should do");
  if (RE_HINGLISH.test(t)) add(1, "asked for something to be built");

  return { score, signals };
}

/**
 * WHERE A MESSAGE GOES, AND WHY — the router, in one ladder.
 *
 * THE ORDER IS THE DESIGN. Read top to bottom: the rungs above the scoring are the ones where
 * something on screen makes the answer unambiguous, and the scoring at the bottom is what happens
 * when nothing does. §3.3 rule 3 is that ordering in one sentence — "selection-aware routing is
 * unchanged and still wins. This section governs only what happens when nothing is selected and no
 * other intent claims the message."
 *
 * `classifyIntent` IS THE WRAPPER AND THIS IS THE FUNCTION. Two entry points rather than one
 * because the reason has to be CARRIED (§13.2) and the twenty-odd existing callers of
 * `classifyIntent` want a route and nothing else — widening its return type would have rewritten
 * every one of them to reach through a field, for a value they do not use.
 */
export function routeMessage(text: string, ctx: ComposerContext): Routing {
  const t = text.trim();
  const chat = (reason: string, planEvidence: Routing["planEvidence"] = "none"): Routing => ({
    intent: { kind: "chat" }, reason, planEvidence,
  });

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
  if (RE_SOCIAL.test(t)) return chat("A greeting or acknowledgement, not a request.");

  // A PLAN ON SCREEN TAKES FEEDBACK — v0.1.7's rule, unchanged, and the only way out is Discard.
  if (ctx.pendingPlanId && !ctx.agentId) {
    return { intent: { kind: "replan", planId: ctx.pendingPlanId }, reason: "A plan is waiting; this is feedback on it.", planEvidence: "none" };
  }

  // A DRAFT IS A NAME AND A FACE. Nothing below this line applies to it, so it never reaches them.
  if (ctx.agentId && ctx.agentIsDraft) {
    return ctx.pendingPlanId
      ? { intent: { kind: "replan", planId: ctx.pendingPlanId }, reason: "A plan is waiting; this is feedback on it.", planEvidence: "none" }
      : { intent: { kind: "generate", into: ctx.agentId }, reason: "A draft agent is selected; this describes what to build into it.", planEvidence: "confident" };
  }

  const step = ctx.step;
  const nodeId = ctx.nodeId ?? undefined;

  // ── selection-aware routing: unchanged, and it still wins (§3.3 rule 3) ──────────────────────
  //
  // EXPLAIN NOW REQUIRES A SELECTION, AND THAT IS §3'S ONE CHANGE TO THIS RUNG. A question with a
  // step or a node selected is still `explain`, because the selection says what the question is
  // about. A question with NOTHING selected used to be `explain { kind: "agent" }` — a single-shot
  // answer "grounded strictly in the selection", with no selection to ground it in — and §8.2 puts
  // exactly those questions on the chat route instead: "why did the last run fail?", "what does
  // this agent do?", "how much has this cost?" are answered from the grounded context block, with
  // conversation memory behind them. §4.1 states the difference: explain is deliberately
  // single-shot, and "what about the second one?" needs the opposite property.
  if (RE_EXPLAIN.test(t)) {
    if (nodeId) {
      return { intent: { kind: "explain", subject: { kind: "node", nodeId } }, reason: `Node ${nodeId} selected, and the message asked about it.`, planEvidence: "none" };
    }
    if (step) {
      return { intent: { kind: "explain", subject: { kind: "step", step } }, reason: `Step #${step.seq} selected, and the message asked about it.`, planEvidence: "none" };
    }
  }
  if (RE_RERUN.test(t) && step) {
    return { intent: { kind: "rerun", step }, reason: `Step #${step.seq} selected, and the message asked to run it again.`, planEvidence: "none" };
  }
  if (RE_FIX.test(t) && step?.error) {
    return { intent: { kind: "fix", step }, reason: `Step #${step.seq} selected and failed, and the message asked to fix it.`, planEvidence: "none" };
  }

  // ── with an agent selected ───────────────────────────────────────────────────────────────────
  //
  // A QUESTION IS A CONVERSATION AND A STATEMENT IS AN EDIT, which is where §3's inversion lands on
  // this side of the ladder. Both of §0's middle two cases are questions asked with an agent on
  // screen and nothing selected — "what is this agent doing", "why did step 7 fail" — and both used
  // to reach a route that could not answer them from the record. Everything that is NOT a question
  // keeps the destination it had: "add a LIMIT clause", "triage inbound support email", a review
  // comment. That is not the scoring being skipped, it is `edit` claiming the message, which §3.3
  // rule 1 allows in so many words.
  if (ctx.agentId) {
    // A QUESTION MARK WITH NO CHANGE VERB IN FRONT OF IT IS A QUESTION. "and the cost?" carries no
    // interrogative opener and is plainly one; "add a LIMIT clause?" carries the same punctuation
    // and is plainly not.
    const asked = RE_QUESTION.test(t) || (t.endsWith("?") && !RE_CHANGE_VERB_FIRST.test(t));
    if (asked) return chat("Asked a question about this agent; nothing selected.");
    if (ctx.hasReviewComment) {
      return { intent: { kind: "edit", grounding: "review" }, reason: "A review comment is attached, so this edits the code it points at.", planEvidence: "none" };
    }
    if (ctx.pendingPlanId) {
      // Selecting an agent is an unambiguous change of subject — v0.1.7's rule, unchanged.
      return { intent: { kind: "edit" }, reason: "An agent is selected, so this asks for a change to it.", planEvidence: "none" };
    }
    return { intent: { kind: "edit" }, reason: "An agent is selected, so this asks for a change to it.", planEvidence: "none" };
  }

  // ── nothing selected: chat is the default, and plan must prove itself (§3.3) ─────────────────
  const { score, signals } = planScore(t);

  // THE GUARD OUTRANKS THE SCORE so it cannot be outvoted: "how do I build an agent that watches my
  // inbox" scores three signals and is a question about approach.
  //
  // BUT IT KEEPS ITS EVIDENCE, which is the half that is easy to get wrong. A how-question about
  // building is the message MOST likely to have wanted the build route — so §15.1's card has to
  // appear under the reply, and a guard that returned "no evidence" would be the router hiding the
  // one-click correction for the exact message that needs it. The band is what the card reads, and
  // "near" is what it means here: plan was genuinely in play and the guard decided against it.
  if (RE_ASKING_HOW.test(t)) {
    return chat(
      "Asked how to do something rather than for it to be done.",
      score >= PLAN_NEAR ? "near" : "none",
    );
  }
  if (score >= PLAN_CONFIDENCE) {
    // THE SIGNALS THAT FIRED, NOT THE COUNT — §13.2: "state the signal, not the arithmetic."
    // De-duplicated, because two patterns can report the same signal and a reason that said
    // "named a thing to build, named a thing to build" would read as a bug.
    const why = [...new Set(signals)].join("; ");
    return { intent: { kind: "generate" }, reason: `${why[0]?.toUpperCase()}${why.slice(1)}.`, planEvidence: "confident" };
  }
  // §3.3 rule 2: uncertain between chat and plan resolves to chat, EVERY time. The band is what
  // §15.1 reads to decide whether to offer the build route under the reply.
  return score >= PLAN_NEAR
    ? chat("A build request was possible but not clear; nothing selected.", "near")
    : chat("No build-request signal; nothing selected.");
}

/**
 * Where a message goes. The route alone — see `routeMessage` for the reason beside it.
 *
 * KEPT AS THE NARROW ENTRY POINT rather than replaced, because most callers want a destination and
 * nothing else: the composer's live preview, the send button's label, `test:plan-flow`. One
 * function answering both questions would have made every one of them reach through a field.
 */
export function classifyIntent(text: string, ctx: ComposerContext): Intent {
  return routeMessage(text, ctx).intent;
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

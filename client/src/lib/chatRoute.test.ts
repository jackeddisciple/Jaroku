// §2's chat route, in the router.
//
// WHAT THIS SUITE IS FOR, AND WHAT IT MUST NOT BECOME. §2.4 asks for two properties and they pull
// in opposite directions: `chat` has to exist and claim what belongs to it, and the five routes
// that were here before have to be BYTE-UNCHANGED. A suite that only asserted the first would pass
// happily on a router that had quietly swallowed the edit loop.
//
// So the second half is written as a regression table over the routes that existed before this
// commit, driven through the same `classifyIntent` — and `test:plan-flow`, the router's original
// suite, stays untouched and must still pass. Two suites over one function is deliberate here: one
// says what the router learned, the other says what it must not have forgotten.
//
// §3.5'S FIXTURE TABLE IS THE BULK OF THIS FILE, and its rule is the one that makes it worth
// having: EVERY AMBIGUOUS CASE ASSERTS CHAT, EXPLICITLY, WITH A COMMENT SAYING WHY. A table of
// unambiguous rows is a table that passes on a router with no judgement in it at all.
//
//   npm run test:chat-route

import {
  classifyIntent, prose, routeLabel, routeMessage,
  type ComposerContext, type Intent,
} from "./intent.ts";
import type { Step } from "../types.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

/** A failed step, for the selection-aware cases. Only the fields the router reads matter. */
const FAILED: Step = {
  id: "s7", run_id: "r1", seq: 7, type: "tool_call", name: "get_weather",
  input: {}, output: null, state_before: null, state_after: null,
  tokens: null, cost: null, latency_ms: 120, error: "TimeoutError", parent_step_id: null,
  started_at: "2026-09-12T10:00:00.000Z",
};

const OK_STEP: Step = { ...FAILED, id: "s3", seq: 3, error: null };

const route = (text: string, ctx: ComposerContext = { agentId: null }): string =>
  classifyIntent(text, ctx).kind;

// --- the intent exists, and says what it does rather than what it is called ------------------

console.log("\nthe intent");
{
  const i = classifyIntent("hi", { agentId: null });
  check("a social message routes to chat", i.kind === "chat", i);
  // NOT "chat". Every other label in `routeLabel` says what will happen in the words a person
  // would use, and a preview reading the name of a route teaches nobody anything.
  const label = routeLabel(i);
  check("the route label is a sentence, not the mechanism's name", label !== "chat" && label.length > 0, label);
  check("...and it says nothing is built", /build|answer/i.test(label), label);
}

// --- §0's opening example: the greeting that used to cost a plan ------------------------------
//
// EVERY ONE OF THESE ROUTED TO `generate` BEFORE THIS COMMIT, with no agent selected — which is
// the defect §0 opens with: "Hi" produced a plan card, an expensive, visually heavy, multi-step
// artefact, in the first ten seconds of somebody's first session.

console.log("\nsocial messages, with nothing selected");
for (const text of [
  "hi", "hii", "hey", "hello", "Hello!", "hey there", "yo", "howdy", "good morning",
  "thanks", "thank you", "thanks so much", "thx", "ty", "cheers",
  "ok", "okay", "cool", "nice", "great", "perfect", "got it", "sounds good",
  "nvm", "never mind", "bye", "see ya", "test", "ping",
]) {
  check(`"${text}" → chat`, route(text) === "chat", route(text));
}

// --- ...and with an agent selected, where they used to become an EDIT -------------------------
//
// THE OTHER HALF OF THE SAME DEFECT, and the less obvious one. With an agent on screen the
// router's default was `edit`, so "thanks" asked a model to rewrite somebody's agent.

console.log("\nsocial messages, with an agent selected");
for (const text of ["hi", "thanks", "ok", "cool", "bye"]) {
  check(`"${text}" with an agent → chat`, route(text, { agentId: "weather_agent" }) === "chat", route(text, { agentId: "weather_agent" }));
}

// --- the anchors, which are what stop this rule eating real requests -------------------------
//
// `^…$` IS THE WHOLE SAFETY PROPERTY. A rule that matched "thanks" anywhere in a message would
// send "thanks, now fix the retry logic" to a route that cannot edit anything — and the person
// would watch their request produce a pleasantry.

console.log("\na social opener on a real request is still the real request");
{
  const ctx: ComposerContext = { agentId: "weather_agent" };
  check('"thanks, now add a retry" → edit', route("thanks, now add a retry", ctx) === "edit", route("thanks, now add a retry", ctx));
  // WITH A NODE SELECTED, because that is what makes it `explain` once §3 has landed: a question
  // with nothing selected is a conversation now. What this row is for is unchanged — the social
  // rule must not swallow the request behind the opener.
  const onNode: ComposerContext = { agentId: "weather_agent", nodeId: "router" };
  check('"hi, can you explain the graph" (node selected) → explain',
    route("hi, can you explain the graph", onNode) === "explain", route("hi, can you explain the graph", onNode));
  check('"ok so the webhook is wrong" → edit', route("ok so the webhook is wrong", ctx) === "edit", route("ok so the webhook is wrong", ctx));
  // A BUILD REQUEST THAT OPENS WITH A GREETING IS STILL A BUILD REQUEST.
  check('"hey, build me an inbox watcher" → generate', route("hey, build me an inbox watcher", { agentId: null }) === "generate",
    route("hey, build me an inbox watcher", { agentId: null }));
  // AND A WORD INSIDE ANOTHER WORD IS NOT THE WORD.
  check('"testing the retry path against staging" → edit', route("testing the retry path against staging", ctx) === "edit",
    route("testing the retry path against staging", ctx));
}

// --- §2.4: the five routes that were here before, unchanged ----------------------------------
//
// DRIVEN AS A TABLE rather than as prose, because what matters is that NONE of them moved. Each
// row is a route that existed before `chat` did, with the context that claims it.

console.log("\nthe five existing routes are unchanged");
{
  const rows: { text: string; ctx: ComposerContext; want: string; why: string }[] = [
    { text: "an agent that triages support email", ctx: { agentId: null }, want: "generate",
      why: "a description with no agent is still a plan" },
    { text: "drop the summariser", ctx: { agentId: null, pendingPlanId: "p1" }, want: "replan",
      why: "a plan on screen still takes feedback" },
    { text: "when a customer emails, reply with the policy", ctx: { agentId: "draft_1", agentIsDraft: true }, want: "generate",
      why: "a draft still short-circuits to a build into that row" },
    { text: "add a LIMIT clause", ctx: { agentId: "weather_agent" }, want: "edit",
      why: "the default with an agent selected is still an edit" },
    { text: "why did this fail?", ctx: { agentId: "weather_agent", step: FAILED }, want: "explain",
      why: "a question with a step selected still explains it" },
    { text: "what does this node do", ctx: { agentId: "weather_agent", nodeId: "router" }, want: "explain",
      why: "a node still wins over a step for explain" },
    { text: "re-run from here", ctx: { agentId: "weather_agent", step: OK_STEP }, want: "rerun",
      why: "re-run still needs a step and still gets one" },
    { text: "fix this", ctx: { agentId: "weather_agent", step: FAILED }, want: "fix",
      why: "fix still needs a FAILED step" },
    { text: "fix this", ctx: { agentId: "weather_agent", step: OK_STEP }, want: "edit",
      why: "...and a passing step still falls through to edit" },
    { text: "make the tone warmer", ctx: { agentId: "weather_agent", hasReviewComment: true }, want: "edit",
      why: "a review comment still lands on edit" },
  ];
  for (const r of rows) {
    const got = route(r.text, r.ctx);
    check(`${r.want}: ${r.why}`, got === r.want, { text: r.text, got, want: r.want });
  }
}

// --- §2.2: the route carries nothing to write with -------------------------------------------
//
// ASSERTED ON THE SHAPE, which is the only place it can be asserted in a pure function: every
// other intent names the thing it acts on — a plan id, an agent to build into, a step to fix — and
// this one names nothing, so there is nothing for a dispatch to act on even by mistake.

console.log("\nthe chat intent carries nothing actionable");
{
  const i = classifyIntent("hi", { agentId: "weather_agent", pendingPlanId: "p1", step: FAILED });
  check("chat wins over every selection", i.kind === "chat", i);
  check("...and has exactly one field", Object.keys(i).join(",") === "kind", Object.keys(i));
}

// --- §3.5's fixture table --------------------------------------------------------------------
//
// FORTY-SIX ROWS, and the `why` column is not decoration: §3.5 asks for a comment on every
// ambiguous case saying why the ambiguity resolves the way it does, and a table is where that can
// be written once per row rather than buried in prose.
//
// READ THE `want` COLUMN DOWNWARDS. Most of it says `chat`, and that is §3.2's asymmetry made
// visible: a wrong chat route costs a rephrase and one click, a wrong plan route costs a real
// generation call and a plan card in response to a greeting.

console.log("\n§3.5's fixture table");
{
  const NO_AGENT: ComposerContext = { agentId: null };
  const AGENT: ComposerContext = { agentId: "weather_agent" };
  const ON_FAILED: ComposerContext = { agentId: "weather_agent", step: FAILED };
  const ON_NODE: ComposerContext = { agentId: "weather_agent", nodeId: "router" };

  const table: { text: string; ctx: ComposerContext; want: Intent["kind"]; why: string }[] = [
    // ── greetings ────────────────────────────────────────────────────────────────────────────
    { text: "hi", ctx: NO_AGENT, want: "chat", why: "§0's opening example: a greeting is never a build request" },
    { text: "hello there", ctx: NO_AGENT, want: "chat", why: "a greeting with a second word is the same greeting" },
    { text: "good evening", ctx: AGENT, want: "chat", why: "an agent on screen does not make a greeting an edit" },
    { text: "thanks!", ctx: AGENT, want: "chat", why: "trailing punctuation does not change what was said" },

    // ── general questions, with nothing selected ─────────────────────────────────────────────
    { text: "what can you do", ctx: NO_AGENT, want: "chat", why: "§3.5 names this one: a question about Jaroku, not a brief" },
    { text: "what is langgraph", ctx: NO_AGENT, want: "chat", why: "a general question; §8.3 lets chat answer it from its own knowledge" },
    { text: "which model should I use for classification", ctx: NO_AGENT, want: "chat", why: "advice, and nothing in it asks for a thing to exist" },
    { text: "does this support python 3.13", ctx: NO_AGENT, want: "chat", why: "a yes/no question about the product" },

    // ── questions about the current agent — §8.2's six, and the case §3 moved ────────────────
    { text: "what does this agent do", ctx: AGENT, want: "chat", why: "§8.2: answered from the grounded context block, not from an explain with no selection" },
    { text: "why did the last run fail", ctx: AGENT, want: "chat", why: "§8.2: the trace store has the answer and chat is where it is read out" },
    { text: "how much did this cost", ctx: AGENT, want: "chat", why: "§3.5 names this one; the thread's own total answers it" },
    { text: "what tools does it have", ctx: AGENT, want: "chat", why: "§8.2: the current version's TOOLS, and no code changes hands" },
    { text: "is it deployed", ctx: AGENT, want: "chat", why: "§8.2: a deployment record, read not written" },
    { text: "what changed in the last version", ctx: AGENT, want: "chat", why: "§8.2: agent_versions, read not written" },
    // A YES/NO QUESTION OPENS WITH NO WH-WORD AT ALL, which is the half `RE_EXPLAIN` never had to
    // catch and the half §8.2 is full of. Found by this table rather than by a user.
    { text: "does it have retries", ctx: AGENT, want: "chat", why: "an auxiliary plus 'it' asks about the agent" },
    { text: "did the last run pass", ctx: AGENT, want: "chat", why: "a past-tense question about the record" },
    { text: "can it read Gmail", ctx: AGENT, want: "chat", why: "'can IT' asks about capability" },
    { text: "and the cost?", ctx: AGENT, want: "chat", why: "AMBIGUOUS: a follow-up with no opener; the question mark is the only marker and no change verb precedes it" },
    // ...AND THE POLITE IMPERATIVE THAT MUST NOT BE MISTAKEN FOR ONE. "can YOU" asks Jaroku to act.
    { text: "can you add a LIMIT clause", ctx: AGENT, want: "edit", why: "'can YOU' is a request, not a question — the subject after the auxiliary decides it" },
    { text: "add a retry there?", ctx: AGENT, want: "edit", why: "a change verb in front of a question mark is still a change request" },

    // ── ...and the same questions WITH a selection, where §3.3 rule 3 still wins ─────────────
    { text: "why did this fail?", ctx: ON_FAILED, want: "explain", why: "a selected step says what the question is about — selection-aware routing is unchanged" },
    { text: "what does this node do", ctx: ON_NODE, want: "explain", why: "a selected node wins, exactly as it did in v0.1.7" },
    { text: "fix this", ctx: ON_FAILED, want: "fix", why: "a selected FAILED step plus fix phrasing is still fix" },
    { text: "run it again from here", ctx: ON_FAILED, want: "rerun", why: "a selected step plus re-run phrasing is still rerun" },

    // ── edit requests ────────────────────────────────────────────────────────────────────────
    { text: "add a LIMIT clause to the query", ctx: AGENT, want: "edit", why: "a change to an agent that exists; the default with one selected is unchanged" },
    { text: "use gpt-5.6-terra instead", ctx: AGENT, want: "edit", why: "a statement about an existing agent, not a question" },
    { text: "make the tone warmer", ctx: AGENT, want: "edit", why: "an imperative about the agent on screen" },
    { text: "triage inbound support email", ctx: AGENT, want: "edit", why: "a capability described AT an existing agent reads as 'make it do this'" },
    // §3.1'S OWN FALSE-POSITIVE EXAMPLE, in both contexts. It is "a noun phrase plus a capability"
    // and it is an edit request — the pattern-toward-plan shape would have claimed it.
    { text: "fix the retry logic in my webhook agent", ctx: AGENT, want: "edit", why: "§3.1: an edit request that any plan-ward pattern would misread" },
    { text: "fix the retry logic in my webhook agent", ctx: NO_AGENT, want: "chat", why: "§3.1 again, with nothing to edit — so the cheap side, with §15.1 one click away" },

    // ── explicit build requests in English ───────────────────────────────────────────────────
    { text: "build me an agent that watches my inbox", ctx: NO_AGENT, want: "generate", why: "§0's fourth case: a verb, a thing and what it does" },
    { text: "create a bot that posts to slack when a deploy fails", ctx: NO_AGENT, want: "generate", why: "three signals, and a trigger clause besides" },
    { text: "I need something to watch my inbox", ctx: NO_AGENT, want: "generate", why: "§3.1: a genuine brief that names no artifact word — the placeholder carries it" },
    { text: "a support agent", ctx: NO_AGENT, want: "generate", why: "a bare indefinite artifact phrase IS a brief; v0.1.7 asserted this and it still holds" },
    { text: "an inbox watcher", ctx: NO_AGENT, want: "generate", why: "same shape, and why the artifact list holds agent-ish nouns and not only 'agent'" },
    { text: "can you build me a tool that summarises PDFs", ctx: NO_AGENT, want: "generate", why: "a request phrased as a question is still a request — 'can you' proposes Jaroku does it" },
    { text: "when a customer emails us, reply with the refund policy", ctx: NO_AGENT, want: "generate", why: "a trigger and an action is what an agent IS; worth the threshold alone" },
    { text: "every time a PR opens, run the tests and comment", ctx: NO_AGENT, want: "generate", why: "the same shape without a comma after the trigger's own clause" },

    // ── build requests in Hinglish and casual phrasing ───────────────────────────────────────
    { text: "kuch aisa jo mails padhe aur summary bheje", ctx: NO_AGENT, want: "generate", why: "§3.1's own Hinglish example; `jo` is the relative pronoun doing the work" },
    { text: "ek agent banao jo slack pe post kare", ctx: NO_AGENT, want: "generate", why: "banao + agent + jo — three signals, none of them English patterns" },
    { text: "mujhe ek bot chahiye jo invoices padhe", ctx: NO_AGENT, want: "generate", why: "chahiye is the ask; bot is the thing; jo says what it does" },
    { text: "something that scrapes a page every hour", ctx: NO_AGENT, want: "generate", why: "casual phrasing with no artifact word and no build verb" },

    // ── asking HOW is not asking for it ──────────────────────────────────────────────────────
    { text: "how do I build an agent that watches my inbox", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: it scores three plan signals and is a question about approach — the guard wins, and §15.1 is one click" },
    { text: "what's the best way to summarise email", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: advice or a brief; §3.2 says the cheap side" },
    { text: "is it possible to make a bot that reads Stripe", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: a capability question wearing a brief's clothes" },

    // ── ambiguous one-word messages — §3.5 asks for these by name ────────────────────────────
    { text: "x", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: one character carries no evidence at all, and plan needs positive evidence" },
    { text: "email", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: a noun on its own could be a brief or a topic; uncertain resolves to chat every time" },
    { text: "slack", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: the name of a connector is not a request to build against it" },
    { text: "agent", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: one artifact word is one signal, and one signal is below the bar by design" },
    { text: "inbox", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: a domain noun with no ask around it" },
    { text: "?", ctx: NO_AGENT, want: "chat", why: "AMBIGUOUS: punctuation; §16 attacks this and it must not reach a model call that writes" },
    { text: "🙂", ctx: NO_AGENT, want: "chat", why: "§16's single-emoji attack: no signal, so the cheap side" },
    { text: "https://example.com/docs", ctx: NO_AGENT, want: "chat", why: "§16's only-a-URL attack: a link is context, never a brief" },
  ];

  // AT LEAST FORTY, ASSERTED. §3.5 asks for the number, and a table that quietly shrank in a
  // refactor would still pass every row it had left.
  check(`the table has at least 40 rows (${table.length})`, table.length >= 40, table.length);

  for (const r of table) {
    const got = route(r.text, r.ctx);
    check(`${r.want.padEnd(8)} "${r.text.slice(0, 46)}" — ${r.why}`, got === r.want, { got, want: r.want });
  }

  // AND EVERY `chat` ROW IN THE TABLE CARRIES A REASON, which is §3.3 rule 5: the router records
  // which route it took and why, for EVERY message. A route with an empty reason would render an
  // empty provenance line in §13, which reads as meaning something.
  for (const r of table) {
    const { reason } = routeMessage(r.text, r.ctx);
    check(`...and "${r.text.slice(0, 34)}" records why`, reason.trim().length > 0 && reason.endsWith("."), reason);
  }
}

// --- §15.1's band, which is what makes the escape hatch discoverable ------------------------
//
// A BAND AND NOT A NUMBER — §13.2: "do not expose a raw confidence number. A score without a scale
// invites the user to reason about a number they cannot calibrate." What leaves the router is one
// of three words, and §15.1 shows its card on exactly one of them.

console.log("\n§15.1's plan-evidence band");
{
  const NO_AGENT: ComposerContext = { agentId: null };
  const band = (t: string): string => routeMessage(t, NO_AGENT).planEvidence;

  check('"hi" has no plan evidence', band("hi") === "none", band("hi"));
  check('"x" has no plan evidence', band("x") === "none", band("x"));
  // ONE SIGNAL IS `near`, which is precisely the case §15.1 exists for: the router read it as a
  // conversation and might have been wrong, so the reply offers the build route once.
  check('"fix the retry logic in my webhook agent" is near', band("fix the retry logic in my webhook agent") === "near",
    band("fix the retry logic in my webhook agent"));
  check('"how do I build an agent that watches my inbox" is near or better',
    band("how do I build an agent that watches my inbox") !== "none",
    band("how do I build an agent that watches my inbox"));
  check('"build me an agent that watches my inbox" is confident',
    band("build me an agent that watches my inbox") === "confident",
    band("build me an agent that watches my inbox"));
  // THE BAND NEVER LEAKS A NUMBER, asserted on the type's own values rather than on a string shape:
  // three words, and none of them is arithmetic.
  for (const t of ["hi", "x", "a support agent", "build me a bot that reads email"]) {
    check(`"${t}" bands rather than scores`, ["none", "near", "confident"].includes(band(t)), band(t));
  }
}

// --- §16's routing attacks, run here rather than saved for the hardening pass ---------------
//
// THE POINT OF RUNNING THEM NOW is that every one of them is a pure function call, and a pure
// property asserted in a suite is a property that cannot regress quietly. The hardening pass is for
// what needs a running app.

console.log("\n§16's routing attacks");
{
  const NO_AGENT: ComposerContext = { agentId: null };
  check("an empty message routes without throwing", route("", NO_AGENT) === "chat", route("", NO_AGENT));
  check("whitespace only → chat", route("   \n\t  ", NO_AGENT) === "chat", route("   ", NO_AGENT));
  // TEN THOUSAND CHARACTERS. Every pattern in the router is linear with no nested quantifier, so
  // this is about proving there is no backtracking cliff rather than about the route it takes.
  const huge = "lorem ipsum dolor sit amet ".repeat(400);
  const started = Date.now();
  const bigRoute = route(huge, NO_AGENT);
  const elapsed = Date.now() - started;
  check(`10,000 characters route in ${elapsed}ms`, elapsed < 250, elapsed);
  check("...and prose with no ask in it is a conversation", bigRoute === "chat", bigRoute);
  // ONLY CODE. Pasting a traceback or a function must not produce a plan — somebody pasting code
  // wants it looked at, and with nothing selected there is nothing to look at but the message.
  check("only code → chat",
    route("def handler(event):\n    return {'ok': True}", NO_AGENT) === "chat",
    route("def handler(event):\n    return {'ok': True}", NO_AGENT));
  check("a traceback → chat",
    route("Traceback (most recent call last):\n  File \"agent.py\", line 12\nTimeoutError", NO_AGENT) === "chat",
    route("Traceback (most recent call last):\n  File \"agent.py\", line 12", NO_AGENT));
  // A QUESTION PHRASED AS AN IMPERATIVE, which is §16's pair to the build-request-as-a-question row
  // in the table above.
  check("a question phrased as an imperative → chat",
    route("tell me what this agent costs to run", { agentId: "weather_agent" }) === "chat",
    route("tell me what this agent costs to run", { agentId: "weather_agent" }));
  // THE SAME MESSAGE, WITH AND WITHOUT A SELECTION. §16 asks for exactly this comparison, and the
  // two answers must differ — a router that gave the same one would mean the selection was decorative.
  const withSel = route("why did this fail?", { agentId: "weather_agent", step: FAILED });
  const without = route("why did this fail?", { agentId: "weather_agent" });
  check("a selection changes the route", withSel === "explain" && without === "chat", { withSel, without });
}


// --- §16's pass: quoted code is not a request ------------------------------------------------
//
// THE BUG. Every pattern in the router read the whole message, so a build verb inside a fence was
// indistinguishable from one somebody typed. Three of these were `generate` with CONFIDENT
// evidence — two of them questions carrying both a question mark and an interrogative opener — and
// each paid a real generation call to answer with a plan card. §3.2 names that as the expensive
// half of the asymmetry; §3.3 rule 2 requires "positive, confident evidence", and a verb in
// material somebody is SHOWING you is not evidence about what they want.
//
// THE SUITE ALREADY HAD AN "only code" ROW AND IT PASSED THROUGHOUT, with `def handler(event)` —
// which routes to chat because it contains no build verb at all. It was passing for a reason that
// had nothing to do with its being code, which is the shape §16 exists to find.

console.log("\n§16 — a paste is not a brief");
{
  const NO_AGENT: ComposerContext = { agentId: null };
  const AGENT: ComposerContext = { agentId: "weather_agent" };
  const DRAFT: ComposerContext = { agentId: "new_agent", agentIsDraft: true };

  // THE THREE THAT WERE CONFIDENT. Each one now routes to chat, and the evidence band is `none`
  // rather than `near` — there was never a signal, so §15.1 must not offer the build card either.
  for (const [text, why] of [
    ["what does `build me an agent` mean here?", "a question ABOUT a code span"],
    ["why does this say that?\n```\nbuild an agent, they said\n```", "a question above a fenced quote"],
    ["is `whenever a row lands, email me` a valid trigger?", "a question about a trigger's syntax"],
  ] as const) {
    const r = routeMessage(text, NO_AGENT);
    check(`${why} → chat`, r.intent.kind === "chat", r.intent.kind);
    check(`...and offers no build card`, r.planEvidence === "none", r.planEvidence);
  }

  // EVERY FENCE DIALECT, and the shapes a real paste arrives in.
  for (const [text, why] of [
    ["```\nbuild me an agent that watches my inbox\n```", "a bare fence"],
    ["```md\n# README\nbuild an agent that summarises mail\n```", "a fenced README with an info string"],
    ["~~~\nbuild me a bot\n~~~", "a tilde fence"],
    ["look at this:\n```\nbuild me an agent\n```", "prose with no ask, above a fence"],
    // A TRUNCATED PASTE. Markdown renders an unclosed fence as code to the end, and so does this.
    ["```\nbuild me an agent", "an unclosed fence"],
  ] as const) {
    check(`${why} → chat`, routeMessage(text, NO_AGENT).intent.kind === "chat",
      routeMessage(text, NO_AGENT).intent.kind);
  }

  // A CLOSER MUST BE AT LEAST AS LONG AS ITS OPENER — ``` does not close ````, so the inner fence
  // is content and the whole thing is still quoted.
  check("``` does not close ````",
    routeMessage("````\n```\nbuild me an agent\n```\n````", NO_AGENT).intent.kind === "chat",
    routeMessage("````\n```\nbuild me an agent\n```\n````", NO_AGENT).intent.kind);

  // AND THE PROSE STILL DECIDES WHEN THERE IS PROSE. This is the half that makes the fix a fix
  // rather than a refusal to route: the ask is in the sentence, the fence is the illustration.
  const asked = routeMessage("build me an agent that does this:\n```\ndef f(): pass\n```", NO_AGENT);
  check("an ask above a fence still generates", asked.intent.kind === "generate", asked.intent.kind);
  check("...confidently", asked.planEvidence === "confident", asked.planEvidence);

  // WHERE THE FIX STOPS, ASSERTED RATHER THAN LEFT TO BE DISCOVERED.
  //
  // This originally asserted `chat`, which was a claim about what I wanted the fix to cover rather
  // than what it does. `prose` strips material somebody MARKED as quoted. Unfenced code carrying an
  // English build sentence has no marker on it, so the router reads it as typed prose and plans:
  //
  //   "def build_agent():\n    make an agent that watches inbox"   → generate
  //
  // AND WIDENING IT IS THE WRONG TRADE, on §3.1's own argument: recognising code by its shape means
  // indentation, braces, `def`, semicolons, a colon-terminated line — and "the pattern list is
  // unbounded. Every miss produces another pattern, and every pattern widens the false-positive
  // surface." Each of those patterns would also fire on ordinary sentences. The real-world shape
  // this leaves open is pasting a prompt file raw; wrapping it in a fence routes it correctly, and
  // §15.2's "just asking" card is the one-click recovery §3.2 describes for the rest.
  check("unfenced code carrying an English ask still plans — a documented limit",
    routeMessage("def build_agent():\n    make an agent that watches inbox\n    return 1", NO_AGENT)
      .intent.kind === "generate");

  // AN ALL-QUOTED MESSAGE WITH AN AGENT OPEN IS A CONVERSATION, not an edit. Without the rung the
  // agent-selected fallback hands the editor an instruction with no instruction in it.
  check("a fenced paste with an agent open → chat",
    routeMessage("```\nadd a retry\n```", AGENT).intent.kind === "chat",
    routeMessage("```\nadd a retry\n```", AGENT).intent.kind);
  // ...AND WITH A DRAFT OPEN IT IS A BRIEF, because that rung sits ABOVE the quoted-only check on
  // purpose: "here is the API I want you to use: ```…```" is a legitimate brief for a draft.
  check("a fenced paste with a DRAFT open still generates into it",
    routeMessage("```\nGET /v1/messages\n```", DRAFT).intent.kind === "generate");

  // BLOCKQUOTES ARE DELIBERATELY NOT STRIPPED. A fence means "literal text I am showing you" in
  // markdown's own grammar; a `>` means "somebody said this", and what somebody said can still be
  // the ask — "my boss said: > we need a bot that files receipts" is a build request being relayed.
  // Asserted so the decision is visible rather than incidental.
  check("a relayed build request is still a build request",
    routeMessage("my boss said:\n> we need a bot that files receipts", NO_AGENT).intent.kind === "generate");

  // NO BACKTRACKING SURFACE. `prose` walks lines, and this runs on every keystroke behind the live
  // route preview — §16.1's 10,000-character attack applied to the new code path.
  const huge = "```\n" + "x".repeat(10_000) + "\n```\n" + "`y`".repeat(2_000);
  const started = Date.now();
  const r = routeMessage(huge, NO_AGENT);
  const elapsed = Date.now() - started;
  check(`12,000 characters of fences and spans strip in ${elapsed}ms`, elapsed < 250, elapsed);
  check("...and say nothing", r.intent.kind === "chat", r.intent.kind);

  // `prose` ITSELF, on the cases where the seam is easy to get wrong.
  check("a span is replaced by a space, never closed up",
    prose("watches `x` daily") === "watches   daily", JSON.stringify(prose("watches `x` daily")));
  check("a message with no code comes back unchanged",
    prose("build me an agent") === "build me an agent");
  check("a lone backtick does not fuse words",
    prose("a ` b") === "a   b", JSON.stringify(prose("a ` b")));
  check("nothing but a fence is empty", prose("```\nx\n```") === "");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

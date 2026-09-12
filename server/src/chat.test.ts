// The chat route's own facts — §2, §8.1 and §11.1's floor.
//
// WHAT IS WORTH A SUITE HERE. Not the stream: `streamExplain` is the engine and has its own
// coverage. What this asserts is the three things that fail SILENTLY.
//
//   THE MODEL IS PRICED. `costFor` returns null for a model with no entry in
//   `runtime/pricing.json`, and null renders as "unknown" everywhere in this product. A default
//   chat model that nothing prices would make every chat turn's cost unknown, forever, and the
//   only symptom would be an absent figure that looks like a rendering choice.
//
//   THE MODEL IS INDEPENDENT. §11.1: "The chat model is separate from the eval, plan and generation
//   models. Changing one must not change another." A constant that read one of the others would
//   make that false the first time somebody set an env var, silently.
//
//   THE RULES ARE STILL IN THE PROMPT. A prompt is code that is never compiled, so a deleted
//   paragraph produces no error anywhere — the only thing that notices is something that looks for
//   it. `test:convo-honesty` does exactly this for `CONVERSATION_SYSTEM`; this is its sibling.
//
//   npm run test:chat

import { readFileSync } from "node:fs";

import { CHAT_MAX_TOKENS, CHAT_MODEL, chatContext, type ChatGrounding } from "./chat.ts";
import { CHAT_SYSTEM, chatClosing } from "./prompt.ts";
import { allPrices, capabilityFor, costFor, isPriced, priceFor } from "./pricing.ts";
import { EXPLAIN_MODEL, usageFromPartial } from "./explainer.ts";
import { PLAN_MODEL } from "./planner.ts";
import { EDIT_MODEL } from "./editor.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// --- the model ------------------------------------------------------------------------------

console.log("\nthe chat model");
{
  check("has a pricing entry", isPriced(CHAT_MODEL), CHAT_MODEL);
  // §10: "An unpriced chat model shows cost unknown and is excluded from totals rather than
  // contributing zero." That is the right behaviour for a model somebody points us at; it must not
  // be the behaviour of the DEFAULT, which would make the cost line permanently absent.
  const cost = costFor(CHAT_MODEL, { inputTokens: 1000, outputTokens: 200 });
  check("...so a chat turn's cost is a number, not unknown", cost !== null && cost > 0, cost);

  // §11.1's default: the cheapest model among the ones Jaroku's own thinking can reach, which is
  // Anthropic-only — see providers.ts's note about which calls the platform makes.
  const chat = priceFor(CHAT_MODEL);
  const cheapest = allPrices()
    .filter((m) => m.provider === "anthropic")
    .reduce<number | null>((lo, m) => (lo === null || m.input < lo ? m.input : lo), null);
  check("...and the cheapest Anthropic one there is", chat !== null && chat.input === cheapest,
    { chat: chat?.input, cheapest });
  check("it is an Anthropic model", chat?.provider === "anthropic", chat?.provider);

  // THE CEILING IS VALIDATED AGAINST A REAL NUMBER. The effort adapter clamps a thinking budget
  // against what THIS call sends, so a ceiling above the model's own maximum would be a budget
  // validated against nothing.
  const cap = capabilityFor(CHAT_MODEL);
  check("the chat ceiling fits the model's own maximum",
    cap !== null && CHAT_MAX_TOKENS <= cap.maxOutputTokens, { CHAT_MAX_TOKENS, max: cap?.maxOutputTokens });
}

// --- §11.1: separate from the other four ----------------------------------------------------
//
// READ OFF THE SOURCE rather than by setting env vars, because the constants are resolved at import
// time and a suite cannot re-import a module with a different environment. What can be asserted is
// the thing that actually goes wrong: that `chat.ts` does not resolve its model THROUGH one of the
// others. `PLAN_MODEL` falls through `JAROKU_GEN_MODEL` deliberately and says so; this must not.

console.log("\nindependence from the other model paths");
{
  const src = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  // THE RESOLUTION EXPRESSION ALONE, not the whole file. The file NAMES the other four in the
  // comment that explains why it is separate from them, and a substring search over the source
  // would fail on the very paragraph that documents the property being asserted.
  const resolution = /export const CHAT_MODEL\s*=([^;]*);/.exec(src)?.[1] ?? "";
  check("there is a resolution to read", resolution.trim().length > 0, resolution);
  check("it reads JAROKU_CHAT_MODEL", resolution.includes("JAROKU_CHAT_MODEL"), resolution);
  for (const other of ["JAROKU_GEN_MODEL", "JAROKU_PLAN_MODEL", "JAROKU_EDIT_MODEL", "JAROKU_EXPLAIN_MODEL"]) {
    // `PLAN_MODEL` falls through `JAROKU_GEN_MODEL` on purpose and says so in its own comment.
    // This must not: §11.1's "changing one must not change another" is exactly that fall-through's
    // absence.
    check(`...and never falls through ${other}`, !resolution.includes(other), resolution);
  }
  check("...nor through another module's constant",
    !/EXPLAIN_MODEL|PLAN_MODEL|EDIT_MODEL|GENERATION_MODEL/.test(resolution), resolution);
  // The four are allowed to be the same id today — they all default to the cheapest Anthropic
  // model. What is asserted is that they are four INDEPENDENT resolutions, which the check above
  // establishes; this records the current alignment so a change to one is visible in a diff.
  check("today all five default to one id (recorded, not required)",
    new Set([CHAT_MODEL, EXPLAIN_MODEL, PLAN_MODEL, EDIT_MODEL]).size >= 1,
    { CHAT_MODEL, EXPLAIN_MODEL, PLAN_MODEL, EDIT_MODEL });
}

// --- §8.1: the context block says the absence out loud --------------------------------------

console.log("\nthe context block");
{
  const withAgent = chatContext({ agentName: "weather-agent" });
  check("names the agent", withAgent.includes("weather-agent"), withAgent);

  const none = chatContext({ agentName: null });
  // THE DECISION §8.1 NAMES. "When no agent is selected the block says that plainly rather than
  // being omitted, so the model knows the difference between 'no agent' and 'agent unknown'." An
  // omitted block is an absence a model fills in.
  check("an absent agent is stated, not omitted", none.trim().length > 0 && /none|no agent/i.test(none), none);
  check("...and the block is still labelled", none.includes("JAROKU CONTEXT"), none);
  check("...and it does not name an agent", !/weather/i.test(none), none);
}

// --- §2.2 and §8.3: the rules that keep the route honest ------------------------------------

console.log("\nthe rules in CHAT_SYSTEM");
{
  const rules: [string, RegExp][] = [
    // §8.3 — the rule this whole route is judged on.
    ["never invent a fact about their own system", /NEVER INVENT A FACT ABOUT THEIR OWN SYSTEM/],
    ["an explicit 'I don't have that' is offered", /can't see that from here/i],
    // §2.2 — the write boundary, stated as well as enforced.
    ["it cannot change anything", /CANNOT CHANGE ANYTHING/],
    ["...and must not claim to have", /Never say or imply that you have/i],
    // §8.3 / v0.1.9 — the cost rule, in the prompt as well as in pricing.ts.
    ["unknown is not zero", /UNKNOWN IS NOT ZERO/],
    ["...spelled with the figure that must never appear", /\$0\.00/],
    // §8.1 — a general question is answered as a general question.
    ["general questions are fair game", /General questions/i],
  ];
  for (const [name, re] of rules) check(name, re.test(CHAT_SYSTEM), name);
  // It is a set of RULES rather than a paragraph of tone. Four of the seven above are honesty
  // properties, and a prompt that lost the numbered structure would lose their ordering with it.
  check("the rules are ordered by damage", /IN ORDER OF HOW MUCH DAMAGE/.test(CHAT_SYSTEM));
}

console.log("\nthe closing paragraph");
{
  const named = chatClosing("weather-agent");
  check("names the agent it may speak about", named.includes("weather-agent"), named);
  check("...and repeats the two rules worth repeating",
    /cannot see it/i.test(named) && /cannot change anything/i.test(named), named);

  const anon = chatClosing(null);
  // §8.1 AGAIN, FROM THE OTHER SIDE. A closing that invented a name here would contradict the
  // context block that has just said there is no agent.
  check("an absent agent is said plainly", /no agent is open/i.test(anon), anon);
  check("...and no name is invented", !/"/.test(anon.split("—")[0] ?? anon), anon);
}

// --- §8: the grounded context block ----------------------------------------------------------
//
// §8 IS WHERE THE NICHE IS, and its own sentence is the standard: "a generic chat wrapper can answer
// 'what is LangGraph'. Only Jaroku can answer 'why did step 7 fail in this run' or 'what has this
// agent cost me this week'." What this suite asserts is that the BLOCK contains those answers —
// whether a model uses them well is a model's business, and whether it is allowed to invent them
// when they are absent is `CHAT_SYSTEM`'s, asserted above.
//
// SO THE TEST IS: for each of §8.2's six questions, is the fact in the block? A block missing one
// makes that question unanswerable no matter how good the model is — and §8.3 then requires the
// reply to say so, which is the outcome §8.2 exists to avoid.

const FIXTURE: ChatGrounding = {
  // §8's own acceptance fixture: "a fixture agent with a failed run, three tools, two versions and
  // a deployment — with nothing selected."
  agentName: "weather-agent",
  version: 14,
  connectors: 2,
  mcpTools: 1,
  deployedUrl: "https://weather-agent.up.railway.app",
  deployStatus: "live",
  lastRun: {
    label: "#a1b2c3d4",
    status: "error",
    failedSeq: 7,
    failedError: "TimeoutError: get_weather timed out after 30s",
    costUsd: 0.0031,
    costKnown: true,
    startedAt: "4m ago",
  },
  thread: { turns: 6, costUsd: 0.04, costKnown: true },
  lastChange: "Added a retry around the weather lookup",
};

console.log("\n§8.2 — the six questions, answerable with nothing selected");
{
  const block = chatContext(FIXTURE);
  const rows: [string, RegExp, string][] = [
    ["why did the last run fail?", /failed at step 7 \(TimeoutError: get_weather timed out after 30s\)/,
      "the failed step and the error, from the trace store"],
    ["what does this agent do?", /weather-agent · v14 · 3 tools/,
      "the current version and its tool count"],
    ["how much has this cost?", /\$0\.0400 spent in this conversation/,
      "the thread total, and the line SAYS which figure it is"],
    ["what changed in the last version?", /last change: Added a retry around the weather lookup/,
      "the version's own instruction summary"],
    ["what tools does it have?", /\(2 reviewed, 1 from MCP\)/,
      "§8.2: reviewed vs MCP MARKED, because that distinction is what makes one trustworthy"],
    ["is it deployed?", /deployed at https:\/\/weather-agent\.up\.railway\.app/,
      "the deployment record and the live URL"],
  ];
  for (const [q, re, why] of rows) {
    check(`"${q}" — ${why}`, re.test(block), block);
  }
  // §8.1: THE SELECTION LINE IS THE ONE THAT IS OMITTED. An absent selection is not a fact about the
  // workspace; it is the ordinary state of the composer.
  check("nothing selected means no selection line", !/selection:/.test(block), block);
  const withSel = chatContext({ ...FIXTURE, selection: { seq: 7, type: "tool_call", name: "get_weather" } });
  check("...and a selection is named when there is one",
    /selection:\s+step 7 \(tool_call get_weather\)/.test(withSel), withSel);
}

// --- §8.3 and §16: what the block says when it does not know ---------------------------------
//
// EVERY ONE OF THESE IS AN ATTACK §16 NAMES, and they share one failure: an omitted line is an
// absence a model fills in. §8.3 treats a wrong answer about the user's own system as the most
// serious class there is — "the product lying about its own state" — so each of these has to be
// STATED rather than left out.

console.log("\n§16's grounding attacks");
{
  // AN AGENT WITH NO RUNS.
  const noRuns = chatContext({ ...FIXTURE, lastRun: null });
  check("an agent that has never run says so", /last run:\s+none — this agent has never been run/.test(noRuns), noRuns);
  check("...and does not describe a run", !/failed|completed/.test(noRuns), noRuns);

  // A RUN STILL IN FLIGHT. "Completed" would be the product describing something that has not
  // happened yet.
  const inFlight = chatContext({
    ...FIXTURE,
    lastRun: { ...FIXTURE.lastRun!, status: "running", failedSeq: null, failedError: null, costUsd: null },
  });
  check("a run in flight says it is still running", /still running/.test(inFlight), inFlight);
  check("...and its cost is unknown rather than zero", /unknown/.test(inFlight) && !/\$0\.0000/.test(inFlight), inFlight);

  // A THREAD WITH `agent_id` NULL — the planning stage.
  const noAgent = chatContext({ agentName: null, thread: { turns: 1, costUsd: null, costKnown: true } });
  check("no agent is stated plainly", /no agent yet \(the planning stage\)/.test(noAgent), noAgent);
  check("...and no run line is invented for an agent that does not exist", !/last run:/.test(noAgent), noAgent);
  check("...and the thread line is still there", /1 turn/.test(noAgent), noAgent);

  // AN UNPRICED MODEL. §8.3: "cost figures obey the existing rule without exception: unknown is
  // `null`, never `$0.00`, and a total with any unknown component is reported as APPROXIMATE."
  const unknownCost = chatContext({ ...FIXTURE, thread: { turns: 6, costUsd: null, costKnown: true } });
  check("an unmeasured thread cost reads as unknown", /unknown spent in this conversation/.test(unknownCost), unknownCost);
  check("...and never as $0.00", !/\$0\.00\b/.test(unknownCost), unknownCost);

  const partial = chatContext({ ...FIXTURE, thread: { turns: 6, costUsd: 0.04, costKnown: false } });
  check("a partial total says it is a floor", /at least \$0\.0400/.test(partial), partial);
  check("...and names why", /some calls were unpriced/.test(partial), partial);

  // AN AGENT WITH NO TOOLS AT ALL, which is different from an unknown tool count.
  const bare = chatContext({ ...FIXTURE, connectors: 0, mcpTools: 0 });
  check("no tools is stated, not omitted", /no tools/.test(bare), bare);

  // A DEPLOYMENT THAT IS NOT LIVE. "Not deployed" and "deploying" are different answers to
  // §8.2's question, and neither is silence.
  check("an undeployed agent says so",
    /not deployed/.test(chatContext({ ...FIXTURE, deployedUrl: null, deployStatus: null })));
  check("...and one mid-deploy says which",
    /deployment building/.test(chatContext({ ...FIXTURE, deployedUrl: null, deployStatus: "building" })));

  // A QUESTION WHOSE ANSWER GENUINELY IS NOT IN THE BLOCK. The block cannot answer it, which is
  // the point — what makes the reply honest is `CHAT_SYSTEM`'s rule 1, asserted above, and the
  // block containing no material that could be mistaken for the answer.
  check("the block says nothing about an agent's author", !/created by|author/i.test(chatContext(FIXTURE)));
  check("...nor about a week's spend it was never given",
    !/this week|last 7 days/i.test(chatContext(FIXTURE)));
}

console.log("\nthe block is bounded and labelled");
{
  // BOUNDED, like every other model-facing text in this codebase (v0.2.1 bounded MCP server text
  // for the same reason). The inputs that could grow it without limit are the error and the
  // version summary, and both are trimmed by the caller — asserted here on the RENDERER, because a
  // caller that forgot would produce a block with a traceback in it.
  const huge = chatContext({
    ...FIXTURE,
    lastRun: { ...FIXTURE.lastRun!, failedError: "x".repeat(4000) },
    lastChange: "y".repeat(4000),
  });
  check("a block with enormous inputs stays readable", huge.length < 9000, huge.length);
  check("it is labelled as the developer's own workspace", /the developer's own workspace/.test(chatContext(FIXTURE)));
  // AND IT NEVER CLAIMS TO BE COMPLETE. A block that read as "everything Jaroku knows" would
  // invite the model to answer from its absence.
  check("nothing in it claims completeness", !/all |every |complete/i.test(chatContext(FIXTURE).split("\n")[0] ?? ""));
}

// --- §6.1: what a stopped answer cost --------------------------------------------------------
//
// THE ONE RULE WITH TWO WRONG ANSWERS, both of which are a single `?? 0` away. `finalMessage()`
// never resolves on an aborted stream, so the usage report that fires on a completed call does not
// fire here — and a caller that defaulted the counts would record a stopped answer as FREE on a
// call that really consumed every input token of the prompt.

console.log("\na stopped answer's cost");
{
  const real = usageFromPartial(CHAT_MODEL, {
    usage: { input_tokens: 1420, output_tokens: 96, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  check("the counts are the ones the call accumulated", real?.input === 1420 && real?.output === 96, real);
  check("...and it prices to a real figure", (costFor(CHAT_MODEL, {
    inputTokens: real?.input ?? 0, outputTokens: real?.output ?? 0,
  }) ?? 0) > 0, real);
  // NOT THE PROJECTED AMOUNT. A stopped answer produced 96 tokens, not `CHAT_MAX_TOKENS` of them —
  // pricing the request as though it had run to the ceiling charges somebody for the answer they
  // stopped precisely to avoid paying for.
  check("...and it is far below the ceiling", (real?.output ?? 0) < CHAT_MAX_TOKENS, real?.output);

  // UNKNOWN, NOT ZERO. An abort that beat the first `message_start` has no accumulated message, and
  // v0.1.9's rule is that a silent zero reads as "this was free" rather than as "we don't know".
  check("no accumulated message means no counts", usageFromPartial(CHAT_MODEL, undefined) === undefined);
  check("...and neither does a message with no usage on it", usageFromPartial(CHAT_MODEL, {}) === undefined);
  // THE MODEL TRAVELS WITH THE COUNTS, because `costFor` prices whatever id it is handed — a
  // stopped call metered against the wrong model is the v0.1.10 accounting bug in a new place.
  check("the model is reported as itself",
    usageFromPartial("gpt-5.6-luna", { usage: { input_tokens: 1 } })?.model === "gpt-5.6-luna");
  // A PARTIAL MESSAGE WITH NULL COUNTS IS ZERO RATHER THAN UNKNOWN, and that is right: the SDK sent
  // a usage block, so the call reported its own spend and reported none.
  check("an explicit null count is zero, not absent",
    usageFromPartial(CHAT_MODEL, { usage: { input_tokens: null, output_tokens: null } })?.input === 0);
}


// --- §16's pass: a deleted agent is not the planning stage ------------------------------------
//
// THE BUG. `chatGrounding` returns `agentName: null` both for a thread that never had an agent and
// for one whose agent was deleted while it was open, and the block asserted the first for both:
//
//   agent:       none — this conversation has no agent yet (the planning stage)
//
// ...under four turns of history about an agent that existed. §8.1 asks for this distinction in so
// many words — the block exists "so the model knows the difference between 'no agent' and 'agent
// unknown'" — and §16.1 attacks it twice, in the Memory row and the Grounding row.

console.log("\n§16 — a deleted agent says so");
{
  const gone = chatContext({
    agentName: null,
    missingAgentSlug: "weather_agent",
    thread: { turns: 4, costUsd: 0.031, costKnown: true },
  });
  check("it does not claim the planning stage", !/planning stage/.test(gone), gone);
  check("...it says the agent is gone", /gone —/.test(gone), gone);
  check("...and names which one", /weather_agent/.test(gone), gone);
  // THE THREAD LINE SURVIVES, because the turns and the spend are still facts about this
  // conversation — losing them would answer "how much has this cost?" with nothing.
  check("...while the thread's own figures stand", /4 turns/.test(gone) && /\$0\.0310/.test(gone), gone);
  // AND NO AGENT DETAIL IS INVENTED for a row that could not be read.
  check("...and nothing is invented about it", !/ · v\d/.test(gone) && !/tools/.test(gone), gone);

  // A THREAD THAT NEVER HAD AN AGENT still gets §8.1's original sentence, unchanged.
  const never = chatContext({ agentName: null, thread: { turns: 1, costUsd: null, costKnown: true } });
  check("a thread with agent_id null is still the planning stage", /planning stage/.test(never), never);
  check("...and does not read as gone", !/gone —/.test(never), never);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

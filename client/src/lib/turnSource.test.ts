// What a turn IS — its markdown source, the metadata it reports, and the message that produced it.
//
// `turnSource.ts` HAS POINTED AT THIS SUITE SINCE IT WAS WRITTEN AND THE SUITE DID NOT EXIST. Its
// header says `npm run test:turn-source`; there was no such script and no such file. That matters
// more since §13, because `metaForTurn` is now what fills the provenance line — the route, the
// reason, the token count and the cost — and every one of those has a wrong answer that renders
// perfectly: a `?? 0` on the cost reads as "this was free", and a route guessed from a turn's kind
// would put a confident label on a decision nobody made.
//
//   npm run test:turn-source

import { metaForTurn, promptForRegenerate, turnPrompt, turnSource } from "./turnSource.ts";
import type { ChatTurn, ReplyTurn } from "../store/chatStore.ts";
import type { GenUsage } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const reply = (over: Partial<ReplyTurn> = {}): ReplyTurn => ({
  id: "t1", role: "jaroku", kind: "reply", status: "done",
  agentId: "weather_agent", text: "It timed out at step 7.", ...over,
});

const usage = (over: Partial<GenUsage> = {}): GenUsage => ({ ...over });

// --- §13's four, read from the turn ------------------------------------------------------------

console.log("\n§13 — the provenance line's fields come from the turn record");
{
  const meta = metaForTurn(reply({
    usage: usage({
      model: "claude-haiku-4-5", provider: "anthropic",
      route: "chat", route_reason: "No build-request signal; nothing selected.",
      total_tokens: 1204, turn_cost_usd: 0.0003,
    }),
  }));
  check("there is a row", meta !== null);
  check("the route is the one recorded", meta?.route === "chat", String(meta?.route));
  check("...and its reason", meta?.routeReason === "No build-request signal; nothing selected.", String(meta?.routeReason));
  check("the token total", meta?.totalTokens === 1204, String(meta?.totalTokens));
  check("the cost", meta?.costUsd === 0.0003, String(meta?.costUsd));
  // §6.2's RULE GOVERNS THESE TOO: read from the turn, never from the toolbar. Asserted by the
  // absence of any other source — the function takes one argument.
  check("the model is the one that answered", meta?.modelId === "claude-haiku-4-5", String(meta?.modelId));
}

console.log("\n§10 — unknown is null and is not zero");
{
  // THE ONE ASSERTION THAT WOULD PASS WITH A BUG IN IT if it were written the other way round. A
  // `?? 0` here renders `$0.0000`, which reads as "this was free" — the single failure v0.1.9
  // exists to prevent — and it would look completely correct on screen.
  const unpriced = metaForTurn(reply({ usage: usage({ model: "some-model", total_tokens: 900 }) }));
  check("a turn with no recorded cost reports null", unpriced?.costUsd === null, String(unpriced?.costUsd));
  check("...and not zero", unpriced?.costUsd !== 0, String(unpriced?.costUsd));
  // A REAL ZERO IS A DIFFERENT CLAIM AND SURVIVES. The free dry-run provider costs nothing, and
  // that is a measurement rather than an absence.
  const free = metaForTurn(reply({ usage: usage({ model: "fake-dry-run", total_tokens: 10, turn_cost_usd: 0 }) }));
  check("a measured zero is kept as zero", free?.costUsd === 0, String(free?.costUsd));
  // AND A TURN THAT MEASURED NOTHING REPORTS NOTHING for both figures.
  const bare = metaForTurn(reply({ usage: usage({ model: "claude-haiku-4-5" }) }));
  check("no token count means null", bare?.totalTokens === null, String(bare?.totalTokens));
}

console.log("\n§13.3 — the line appears on every assistant turn");
{
  // "A PROVENANCE LINE THAT EXISTS ON ONE TURN TYPE AND NOT OTHERS IS WORSE THAN NONE, because its
  // absence reads as meaning something." A plan, a generation and a proposal never went through the
  // router, so their route comes from what they ARE — which is a fact about the kind rather than a
  // guess about a decision, and carries no reason.
  const plan: ChatTurn = {
    id: "p1", role: "jaroku", kind: "plan", status: "pending", planId: "p", revision: 1,
    prompt: "a support agent", raw: "", plan: null, warnings: [],
    usage: usage({ model: "claude-haiku-4-5" }),
  };
  check("a plan turn names the plan route", metaForTurn(plan)?.route === "plan", String(metaForTurn(plan)?.route));
  check("...and claims no reason for it", metaForTurn(plan)?.routeReason === null);

  const gen: ChatTurn = {
    id: "g1", role: "jaroku", kind: "gen", status: "done", agentId: "a", files: ["agent.py"],
    usage: usage({ model: "claude-haiku-4-5" }), planUsage: null,
  };
  check("a generation names the generate route", metaForTurn(gen)?.route === "generate", String(metaForTurn(gen)?.route));

  const proposal: ChatTurn = {
    id: "d1", role: "jaroku", kind: "proposal", status: "pending", agentId: "a",
    proposalId: "pr", summary: "add a retry", files: [], streaming: [],
    usage: usage({ model: "claude-haiku-4-5" }),
  };
  check("a proposal names the edit route", metaForTurn(proposal)?.route === "edit", String(metaForTurn(proposal)?.route));

  // A REPLY WITH NO RECORDED ROUTE OMITS THE CHIP rather than guessing. The same turn kind is what
  // `explain` produces, so `chat` would be a claim about a decision nobody recorded.
  check("a reply with no route claims none",
    metaForTurn(reply({ usage: usage({ model: "claude-haiku-4-5" }) }))?.route === null);
  // ...AND A RECORDED ONE WINS OVER THE KIND, which is what makes an explain turn say `explain`.
  check("a recorded route wins over the turn's kind",
    metaForTurn(reply({ usage: usage({ model: "m", route: "explain" }) }))?.route === "explain");
}

console.log("\nturns with nothing to report");
{
  check("a user turn has no row", metaForTurn({ id: "u", role: "user", text: "hi" }) === null);
  // AN INFO TURN IS THE APP NARRATING ITSELF, not a response anybody asked for.
  check("an info turn has no row",
    metaForTurn({ id: "i", role: "jaroku", kind: "info", tone: "muted", text: "connectors changed" }) === null);
  // AND A REPLY STILL STREAMING, before any usage has landed, has nothing to say yet — the row
  // appearing at the END of every response would be a reflow under the thing somebody is reading.
  check("a reply with no usage and no version has no row",
    metaForTurn(reply({ usage: undefined })) === null);
}

// --- §5.1: the markdown source, not the rendered text -----------------------------------------

console.log("\n§5.1 — Copy produces the markdown source");
{
  check("a reply copies its prose", turnSource(reply()) === "It timed out at step 7.");
  // "A TURN WITH NOTHING TO COPY RETURNS null RATHER THAN ''. An enabled Copy that puts an empty
  // string on the clipboard is worse than no Copy at all, because it looks like it worked."
  check("an empty reply has nothing to copy", turnSource(reply({ text: "" })) === null);
  check("a whitespace-only reply has nothing to copy", turnSource(reply({ text: "   " })) === null);
  check("a user turn has nothing to copy", turnSource({ id: "u", role: "user", text: "hi" }) === null);

  const plan: ChatTurn = {
    id: "p", role: "jaroku", kind: "plan", status: "pending", planId: "p", revision: 1,
    prompt: "brief", raw: "<<<PLAN>>>\n- a tool\n<<<ENDPLAN>>>", plan: null, warnings: [], usage: null,
  };
  // THE RAW PLAN, which is already markdown as the model wrote it — not the parsed structure
  // re-serialised, which would be Jaroku's rendering of a plan rather than the plan itself.
  check("a plan copies its raw markdown", turnSource(plan)?.includes("<<<PLAN>>>") === true, String(turnSource(plan)));

  const gen: ChatTurn = {
    id: "g", role: "jaroku", kind: "gen", status: "done", agentId: "a",
    files: ["agent.py", "tools/weather.py"], usage: null, planUsage: null,
  };
  check("a generation copies its file list", turnSource(gen)?.includes("`agent.py`") === true, String(turnSource(gen)));
  check("...and a generation that wrote nothing copies nothing",
    turnSource({ ...gen, files: [] } as ChatTurn) === null);
}

// --- §5.4: the message a turn is regenerated from ---------------------------------------------

console.log("\n§5.4 — the message a re-run uses");
{
  const turns: ChatTurn[] = [
    { id: "u1", role: "user", text: "why did the last run fail?" },
    reply({ id: "r1" }),
    { id: "u2", role: "user", text: "and the cost?" },
    reply({ id: "r2", text: "About four pence." }),
  ];
  // "THE SAME INPUT" — so a reply three cards down re-runs the sentence that produced IT, not
  // whatever is in the composer now and not the most recent question.
  check("a reply walks back to its own question",
    promptForRegenerate(turns, turns[1]!) === "why did the last run fail?",
    String(promptForRegenerate(turns, turns[1]!)));
  check("...and the second reply to its own",
    promptForRegenerate(turns, turns[3]!) === "and the cost?",
    String(promptForRegenerate(turns, turns[3]!)));

  // A PLAN KEEPS ITS OWN PROMPT — "the brief this plan was written for" — which is the one to
  // re-run rather than whatever is in the composer, a sentence somebody may have abandoned.
  const plan: ChatTurn = {
    id: "p", role: "jaroku", kind: "plan", status: "pending", planId: "p", revision: 1,
    prompt: "a support agent", raw: "", plan: null, warnings: [], usage: null,
  };
  check("a plan carries its own brief", turnPrompt(plan) === "a support agent");
  check("...and does not walk back", promptForRegenerate([{ id: "u", role: "user", text: "something else" }, plan], plan) === "a support agent");

  // A TURN WITH NOTHING BEHIND IT RETURNS null, which is what tells the caller not to dispatch.
  check("a reply with no question before it has nothing to re-run",
    promptForRegenerate([reply({ id: "orphan" })], reply({ id: "orphan" })) === null);
  check("a turn not in the list has nothing to re-run",
    promptForRegenerate(turns, reply({ id: "elsewhere" })) === null);
  // AND A BLANK QUESTION IS SKIPPED rather than re-run as an empty message.
  check("a blank question is skipped",
    promptForRegenerate([
      { id: "u0", role: "user", text: "the real question" },
      { id: "u1", role: "user", text: "   " },
      reply({ id: "r" }),
    ], reply({ id: "r" })) === null
    || promptForRegenerate([
      { id: "u0", role: "user", text: "the real question" },
      { id: "u1", role: "user", text: "   " },
      reply({ id: "r" }),
    ], reply({ id: "r" })) === "the real question");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

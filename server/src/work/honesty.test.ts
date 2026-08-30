// The one that protects the rest: an empty record produces "there is nothing recorded", never a
// plausible summary.
//
// §7.5 IS THE RULE AND §13 CALLS THIS SUITE THE ONE THAT PROTECTS EVERYTHING ELSE. "ask about an
// agent with an empty record and the reply must be that there is nothing recorded — not a hedge,
// not a plausible summary, not 'it appears that'."
//
// WHAT CAN AND CANNOT BE TESTED WITHOUT A MODEL, stated plainly rather than papered over. Nothing
// here can prove what a language model will say; a suite that claimed to would be asserting
// something it cannot observe. What it CAN prove is every mechanical thing between the database and
// the model, and those are the parts that fail silently:
//
//   THE MATERIAL. An empty pack renders as a sentence that says the record is empty and tells the
//   reader not to describe what the agent might do. An empty LIST would be an invitation — a model
//   handed no jobs and no statement about their absence writes about the agent in general terms,
//   fluently, and every word of it is invented.
//
//   THE RULES. `CONVERSATION_SYSTEM` actually contains the refusals, asserted against the string
//   rather than against a summary of it, because a prompt is code that is never compiled and the
//   only thing that notices a deleted paragraph is a test that reads it.
//
//   THE FLOOR. With no key the answering path streams the material verbatim — §7.2's degradation —
//   so the WORST case this feature has is the facts as facts. That is the property that makes "it
//   never invents" survivable even when everything above it is wrong.
//
//   THE CITATIONS. An empty record has nothing citable, so a sentence claiming something happened
//   cannot be dressed as evidence. §7.4 one layer down.
//
//   npm run test:convo-honesty

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { streamExplain } from "../explainer.ts";
import { CONVERSATION_SYSTEM, conversationClosing, renderRecord } from "../prompt.ts";
import { buildFactPack, PACK_ITEMS, type PackDeps } from "./factPack.ts";
import { citableFrom, resolveCitations } from "./citations.ts";
import type { Db } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const A = testContext();
const USER = "aaaaaaaa-0000-4000-8000-0000000000ha";
const DEPLOYMENT = "dep-honesty";

const deps: PackDeps = {
  modelByDeployment: async () => new Map([[DEPLOYMENT, "fake-scripted"]]),
  unreviewedRunIds: async () => new Set<string>(),
};

async function seedAgent(db: Db, ctx: TenantContext): Promise<string> {
  const at = "2026-01-01T00:00:00.000Z";
  await db.run(
    `INSERT OR IGNORE INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
    [USER, `ext-${USER}`, `${USER}@example.com`, at],
  );
  const agentId = randomUUID();
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, 'tracey', 'Tracey', '[]', '[]', '[]', 'fake', ?)`,
    [agentId, ctx.workspaceId, at],
  );
  await db.run(
    `INSERT INTO deployments (id, workspace_id, agent_id, target, status, provider, model,
                              env_keys, created_at, updated_at, created_seq)
     VALUES (?, ?, ?, 'railway', 'live', 'fake', 'fake-scripted', '[]', ?, ?, 1)`,
    [DEPLOYMENT, ctx.workspaceId, agentId, at, at],
  );
  return agentId;
}

console.log("\nan empty record, as the model receives it");
{
  const db = await openTestSqlite();
  const agentId = await seedAgent(db, A);
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: agentId, name: "Tracey" }] });
  check("the pack really is empty", pack.items.length === 0 && pack.truncation.total === 0);

  const record = renderRecord(pack);
  const lower = record.toLowerCase();
  // §13: "NOTHING IS RECORDED", IN THE MATERIAL ITSELF. An empty list is an invitation; a sentence
  // saying the list is empty is a fact, and a model can only refuse on the strength of a fact.
  check("§7.5: the material says the record is empty", lower.includes("the record is empty"));
  check("...and says it is empty of EVERYTHING, not just of matches",
    lower.includes("none whatsoever") || lower.includes("no jobs recorded"), record.slice(0, 200));
  // AND IT CLOSES THE DOOR THE MODEL WOULD OTHERWISE WALK THROUGH. Asked about an agent with no
  // record, the fluent answer is a description of what the agent is FOR — which reads as an answer
  // and is entirely invented.
  check("...and forbids describing what the agent might do",
    lower.includes("do not describe what the agent might do"), record.slice(-260));
  check("...and there is no job list to summarise", !record.includes("[work:"));

  // NOTHING IS CITABLE, so a sentence claiming something happened cannot be given evidence. This is
  // §7.4 acting as the backstop for §7.5: even a model that ignores every rule above cannot produce
  // a chip, and an uncited claim is visibly an uncited claim.
  const citable = citableFrom(pack.items);
  check("an empty record makes every citation impossible", citable.size === 0);
  const invented = resolveCitations(`It went out on Tuesday [work:${randomUUID()}].`, citable);
  check("...so an invented claim cannot be dressed as evidence",
    invented.cited.length === 0 && invented.invented.length === 1);
  await db.close();
}

console.log("\nthe rules the model is given");
{
  // READ OFF THE STRING rather than summarised, because a prompt is code that is never compiled:
  // the only thing that notices a deleted paragraph is something that looks for it.
  const s = CONVERSATION_SYSTEM.toLowerCase();
  check("§7.5: it forbids stating what the record does not show",
    s.includes("never state anything the record does not show"));
  check("...and names the refusal it wants, in words",
    s.includes("i have no record of that"));
  check("...and says the refusal is a complete answer, so it is not hedged into a guess",
    s.includes("complete and correct answer"));
  check("§7.4: it requires a citation per claim, in the exact marker",
    s.includes("[work:<id>]") && s.includes("every claim about what happened cites"));
  check("...and forbids inventing an id", s.includes("never invent an id"));
  check("§8: first person only where a record backs it", s.includes("only where a record backs it"));
  // §8's THREE-WAY DISTINCTION, which is the subtlest rule in the part and the one a paraphrase
  // would lose: silence is not a denial, and a denial is a claim.
  check("§8: it distinguishes silence from denial from inference",
    s.includes("i don't think so") && s.includes("an inference")
    && s.includes("i didn't") && s.includes("a claim"));
  check("§10: unknown is not zero", s.includes("unknown is not zero"));
  check("§3: it says the agent remembers nothing between jobs",
    s.includes("remembers nothing between jobs"));
  // §12 IS ALSO A PROHIBITION HERE. An operate answer that offered to run something would be a
  // second dispatch path with no pre-flight gate in front of it.
  check("§6: it does not offer to run anything", s.includes("do not offer to run anything"));

  // AND THE CLOSING NAMES THE AGENT WITHOUT DESCRIBING IT (§8). "Never given a personality prompt."
  const closing = conversationClosing("Tracey");
  check("the closing lets the answer speak as the agent", closing.includes('"Tracey"'));
  check("...and says nothing about what the agent is like",
    !/helpful|friendly|cheerful|assistant who|persona/i.test(closing), closing);
}

console.log("\nthe floor: what happens with no key at all");
{
  // §7.2'S DEGRADATION IS THIS FEATURE'S WORST CASE, and it is the facts as facts. Asserted by
  // driving the real `streamExplain` with the key removed from the environment, so this is the
  // production path rather than a description of it.
  const db = await openTestSqlite();
  const agentId = await seedAgent(db, A);
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: agentId, name: "Tracey" }] });
  const record = renderRecord(pack);

  const had = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let text = "";
  let done = false;
  let errored = "";
  await streamExplain(record, "did that email go out?", {
    onDelta: (t) => { text += t; },
    onDone: () => { done = true; },
    onError: (m) => { errored = m; },
  }, undefined, null, { system: CONVERSATION_SYSTEM, askedBy: "Operator", closing: conversationClosing("Tracey") });
  if (had !== undefined) process.env.ANTHROPIC_API_KEY = had;

  check("with no key the answer still completes", done && !errored, errored);
  check("...and it is the record itself", text.includes("THE RECORD IS EMPTY"));
  check("...and says why there is no synthesis", text.includes("No Anthropic key set"));
  // THE FLOOR IS STILL HONEST. The degraded answer contains no sentence claiming anything happened,
  // because it contains no sentences at all — only the material.
  check("...and it invents nothing", !/it appears|probably|likely sent|should have/i.test(text));
  await db.close();
}

console.log("\nand the other boundary: a record that is real but incomplete");
{
  // §7.5 CUTS BOTH WAYS. "Not in the pack, not in the answer" must not become "not in the pack,
  // therefore it never happened" — a truncated pack that presented itself as the whole record would
  // turn a bound into a false denial, which is the same failure wearing the opposite sign.
  const db = await openTestSqlite();
  const agentId = await seedAgent(db, A);
  const at = (i: number): string => `2026-07-01T00:${String(i).padStart(2, "0")}:00.000Z`;
  for (let i = 0; i < PACK_ITEMS + 3; i++) {
    await db.run(
      `INSERT INTO work_items (id, workspace_id, agent_id, deployment_id, run_id, created_by,
                               input, status, output, error, failure_kind,
                               created_at, started_at, ended_at, created_seq)
       VALUES (?, ?, ?, ?, ?, ?, 'send the invoice', 'succeeded', 'sent', NULL, NULL, ?, ?, ?, 0)`,
      [randomUUID(), A.workspaceId, agentId, DEPLOYMENT, randomUUID(), USER, at(i), at(i), at(i)],
    );
  }
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: agentId, name: "Tracey" }] });
  const record = renderRecord(pack);
  check("a truncated pack says it is truncated", record.includes("Older jobs exist and are NOT shown"));
  check("...and forbids concluding it never happened",
    record.includes("do not conclude it never happened"), record.slice(0, 300));
  check("...and gives the true total rather than the page size",
    record.includes(`OF ${PACK_ITEMS + 3} JOBS`), record.slice(0, 300));

  // AND A COMPLETE ONE SAYS SO, which is what lets a real denial be a real denial: with the whole
  // record in hand, "it did not happen through Jaroku" is a claim the material supports.
  const small = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: agentId, name: "Tracey" }], maxItems: PACK_ITEMS });
  check("the complete/incomplete distinction is stated either way",
    renderRecord(small).includes("THIS IS THE MOST RECENT")
    || renderRecord(small).includes("THIS IS THE COMPLETE RECORD"));
  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

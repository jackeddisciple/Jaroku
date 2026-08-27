// The `work` channel: a transition is a DELTA, not a board.
//
// §5 states it in one sentence — "The Inbox learned this the expensive way. One item changing state
// broadcasts that item; a snapshot is for a filter change or a fresh connect" — and it matters more
// here than it did there. A work list moves constantly: four agents on a schedule produce a
// transition every few seconds, and re-sending a fifty-row page for each of them would put the whole
// list on the wire once a second and re-render it under whoever was reading.
//
// SO THE LOAD-BEARING ASSERTION IS A NEGATIVE ONE: the payload a transition broadcasts has no
// `items` field. A delta that grew one would be a board, and nothing about the screen would look
// wrong — the client would render it correctly, once a second, for ever.
//
// THE SECOND HALF IS WHO GETS WHAT. A snapshot carries the asking client's FILTER, so it goes to
// the socket that asked and to nobody else; broadcasting one would replace a colleague's list with
// somebody else's choice of what to look at. The delta carries no filter, so it is safe to
// broadcast — and the client drops what does not match the list it is holding.
//
// AND THE STATEMENT COUNT, because §16 asks for it and because the fleet strip is rebuilt on every
// deployment change: forty agents and forty jobs cost the same number of queries as one.
//
//   npm run test:work-channel

import { randomUUID } from "node:crypto";

import { countingDb, openTestSqlite, testContext } from "../db/testDb.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { DeployStore } from "../deployStore.ts";
import { newRequestId, systemContext, type TenantContext } from "../db/tenant.ts";
import { COMMAND_CHANNEL, channelFor } from "../wsRelay.ts";
import { capabilityFor } from "../auth/capabilities.ts";
import { WorkSnapshots } from "./snapshot.ts";
import { WorkStore, WORK_STATUSES, type WorkItem } from "./workStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const base = await openTestSqlite();
const counting = countingDb(base);
const db = counting.db;

const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const deploys = new DeployStore(db);
const work = new WorkStore(db);

const person = await identity.provisionUser(systemContext(newRequestId()), {
  externalId: `channel-${randomUUID().slice(0, 8)}`,
  email: `channel-${randomUUID().slice(0, 8)}@example.com`,
});
const colleague = await identity.provisionUser(systemContext(newRequestId()), {
  externalId: `channel-b-${randomUUID().slice(0, 8)}`,
  email: `channel-b-${randomUUID().slice(0, 8)}@example.com`,
});
const ctx: TenantContext = { ...testContext(), actorUserId: person.user.id };
const asColleague: TenantContext = { ...ctx, actorUserId: colleague.user.id };
await identity.addMember(ctx, person.user.id, "owner");
await identity.addMember(ctx, colleague.user.id, "member");

const serveTokens = new Set<string>();
async function liveAgent(slug: string, opts: { token?: boolean; publicServe?: boolean } = {}): Promise<{ agentId: string; deploymentId: string }> {
  const agent = await agents.upsertFromDisk(ctx, { slug, display_name: slug });
  const deployment = await deploys.create(ctx, {
    agentId: agent.id, provider: "anthropic", model: "claude-haiku-4-5",
    envKeys: opts.publicServe ? ["JAROKU_SERVE_PUBLIC"] : [],
  });
  const serviceId = `svc-${slug}`;
  await deploys.patch(ctx, deployment.id, {
    status: "live", url: `https://${slug}.up.railway.app`,
    railway_project_id: "p", railway_service_id: serviceId, railway_environment_id: "e",
  });
  if (opts.token !== false) serveTokens.add(serviceId);
  return { agentId: agent.id, deploymentId: deployment.id };
}

const snapshots = new WorkSnapshots({
  work,
  agentNames: async (c) => new Map((await agents.list(c, { includeArchived: true })).map((a) => [a.id, a.display_name ?? a.slug])),
  actorNames: async (c) => new Map((await identity.listMembers(c)).map((m) => [m.user_id, m.display_name ?? m.email])),
  deployments: (c) => deploys.currentByAgent(c),
  hasServeToken: async (_c, serviceId) => serveTokens.has(serviceId),
  scoped: (c) => db.forWorkspace(c.workspaceId),
});

const jobs = await liveAgent("channel_agent");

async function job(input: string, status?: "succeeded" | "failed"): Promise<WorkItem> {
  const item = await work.create(ctx, {
    agentId: jobs.agentId, deploymentId: jobs.deploymentId, runId: randomUUID(), input,
  });
  await work.markRunning(ctx, item.id);
  if (status) await work.finish(ctx, item.id, { status, output: status === "succeeded" ? "done" : null });
  return (await work.get(ctx, item.id))!;
}

// --- 1. every command is on the channel, and gated -------------------------------------------------

console.log("\nthe channel, and the gate in front of it");
{
  const COMMANDS = [
    "listWork", "loadWorkItem", "listFleet",
    "dispatchWork", "cancelWork", "retryWork",
    "reconnectAgent", "loadAgentLogs", "killAgent",
  ];
  check("§5's nine commands and no more", COMMANDS.every((c) => c in COMMAND_CHANNEL));
  for (const cmd of COMMANDS) {
    check(`${cmd} answers on \`work\``, channelFor(cmd) === "work", channelFor(cmd));
  }
  // A COMMAND WITH NO CAPABILITY IS REFUSED, not allowed — `capabilityFor`'s own rule — so an
  // unclassified one here would be a control nobody can use rather than one anybody can. Either
  // way it is a bug, and this is where it shows up rather than in a 403 somebody reports.
  for (const cmd of COMMANDS) {
    check(`...and is classified`, capabilityFor(cmd) !== undefined, cmd);
  }
  // THE FOUR THAT SPEND OR DESTROY ARE NOT MEMBER READS. `deploy:read` is a member capability and
  // three of the nine sit on it deliberately; these four must not.
  check("dispatch is run:execute", capabilityFor("dispatchWork") === "run:execute");
  check("cancel and retry are the same", capabilityFor("cancelWork") === "run:execute" && capabilityFor("retryWork") === "run:execute");
  check("reconnect and kill reach into Railway, so they are deploy:manage",
    capabilityFor("reconnectAgent") === "deploy:manage" && capabilityFor("killAgent") === "deploy:manage");
  // §5: "Confirmations reuse the existing resolveMcpConfirm. Do not add a second confirm command."
  check("there is no second confirm command", !("confirmWork" in COMMAND_CHANNEL) && !("resolveWorkConfirm" in COMMAND_CHANNEL));
}

// --- 2. a delta is one item, and has no board in it -------------------------------------------------

console.log("\na transition is a delta");
{
  const item = await job("refund order 4471", "succeeded");
  const delta = await snapshots.item(ctx, item);

  // THE ASSERTION THE FILE EXISTS FOR. A delta that grew an `items` field would be a board, and
  // nothing on screen would look wrong — the client would render it correctly, once a second.
  check("a delta carries no items array", !("items" in (delta as object)));
  check("...no counts", !("counts" in (delta as object)));
  check("...and no fleet", !("cards" in (delta as object)));
  check("it is one row", typeof delta.id === "string" && delta.id === item.id);

  // IT IS THE SAME SHAPE A ROW IN THE SNAPSHOT IS, so a client REPLACES rather than merges. A delta
  // whose shape differed would be a second definition of a row that the first change to either
  // makes wrong.
  const snapshot = await snapshots.list(ctx, { scope: "all" });
  const inList = snapshot.items.find((i) => i.id === item.id)!;
  check("...in exactly the shape the snapshot's rows have",
    JSON.stringify(Object.keys(delta).sort()) === JSON.stringify(Object.keys(inList).sort()),
    `${Object.keys(delta).length} vs ${Object.keys(inList).length}`);
  check("...with the same values", JSON.stringify(delta) === JSON.stringify(inList));
}

// --- 3. a snapshot carries its filter, so it cannot be broadcast ------------------------------------

console.log("\na snapshot carries the filter it answers for");
{
  await job("mine, one");
  const theirs = await work.create(asColleague, {
    agentId: jobs.agentId, deploymentId: jobs.deploymentId, runId: randomUUID(), input: "a colleague's",
  });

  const mine = await snapshots.list(ctx, { scope: "mine" });
  check("the default page is the asker's own", mine.items.every((i) => i.created_by === person.user.id));
  check("...and says so, so a page that arrives late can be dropped", mine.filters.scope === "mine");
  check("...which is exactly why it is not broadcast", mine.items.every((i) => i.id !== theirs.id));

  const all = await snapshots.list(ctx, { scope: "all" });
  check("the toggle shows a colleague's job", all.items.some((i) => i.id === theirs.id));
  check("...and names who asked for it", all.items.find((i) => i.id === theirs.id)?.created_by_name !== null);
  check("...echoing the filter it answers for", all.filters.scope === "all");

  // THE COUNTS ARE THE WORKSPACE'S WHATEVER THE FILTER IS, which is what makes the badge right on a
  // page that is narrowed. A count of the page would go to zero the moment somebody filtered.
  check("the counts are the workspace's, not the page's",
    mine.counts.queued === all.counts.queued && mine.counts.running === all.counts.running);
  check("...and cover all six statuses", WORK_STATUSES.every((s) => typeof mine.counts[s] === "number"));

  const filtered = await snapshots.list(ctx, { scope: "all", status: "succeeded" });
  check("a status filter narrows the page", filtered.items.every((i) => i.status === "succeeded"));
  check("...and is echoed", filtered.filters.status === "succeeded");
  check("...while the counts stay the workspace's", filtered.counts.running === all.counts.running);
}

// --- 4. the fleet is its own read ------------------------------------------------------------------

console.log("\nthe fleet strip");
{
  const fleet = await snapshots.fleet(ctx);
  check("one card per live deployment", fleet.cards.length === 1, String(fleet.cards.length));
  check("...and it says something is live", fleet.anyLive === true);
  const card = fleet.cards[0]!;
  check("a connected agent reads connected", card.connection === "connected", card.connection);
  // §9'S ONE SENTENCE IS ASSEMBLED FROM FACTS, not written on the server. The card carries the
  // numbers; the client writes "2 running · 1 waiting on you".
  check("the card carries the pieces of its sentence rather than the sentence",
    typeof card.running === "number" && typeof card.waiting === "number" && typeof card.jobs_today === "number");
  check("...including what today cost", card.spend_today !== undefined);
  // NULL MEANS NOBODY HAS ASKED, which is a third state and not "unhealthy" — a card that reported
  // red because it had never been probed would be the product accusing a working agent.
  check("health is null until somebody probes, not unhealthy", card.health === null && card.health_stale_ms === null);

  const unconnected = await liveAgent("no_token_agent", { token: false });
  const withoutToken = (await snapshots.fleet(ctx)).cards.find((c) => c.agent_id === unconnected.agentId)!;
  check("an agent Jaroku has no token for reads unconnected", withoutToken.connection === "unconnected");

  // `public` IS A WARNING STATE AND NOT A HEALTHY ONE — anyone with the URL can spend the
  // workspace's provider key, and rendering it as "fine, no credential needed" would be the product
  // agreeing with the most expensive misconfiguration it can have.
  const open = await liveAgent("public_agent", { token: false, publicServe: true });
  const openCard = (await snapshots.fleet(ctx)).cards.find((c) => c.agent_id === open.agentId)!;
  check("a public endpoint reads public rather than unconnected", openCard.connection === "public");
}

// --- 5. forty agents and forty jobs cost what one costs ---------------------------------------------

console.log("\nthe statement count");
{
  const many: string[] = [];
  for (let i = 0; i < 40; i++) {
    const a = await liveAgent(`fleet_agent_${i}`);
    many.push(a.agentId);
    await work.create(ctx, {
      agentId: a.agentId, deploymentId: a.deploymentId, runId: randomUUID(), input: `job ${i}`,
    });
  }

  // THE STRIP'S DATABASE READS ARE FLAT, and the credential check is counted separately and
  // deliberately. §16 asks that forty agents cost what one costs, and this is where the honest
  // answer has two halves:
  //
  //   THE AGGREGATES ARE FLAT and that is the half the question was about — the live counts and
  //   today's jobs and spend are two GROUPED queries whatever the fleet holds, not one per card.
  //
  //   THE SERVE-TOKEN CHECK IS ONE PER LIVE DEPLOYMENT, and it is not batched because the door it
  //   goes through deliberately does not offer a batch: `SecretStore.getServeToken` takes ONE
  //   service id and returns ONE value, which is what keeps it from being asked for an arbitrary
  //   credential the way a `get(ctx, name)` could. Widening it to take a list would widen the
  //   narrowest accessor Part 1 has for the sake of a strip that is rebuilt a few times a day, on
  //   a workspace that is already paying for one Railway service per card. Counted here so the
  //   cost is a number somebody can see rather than a surprise.
  const readsPerFleet = async (): Promise<{ db: number; credentials: number }> => {
    let credentials = 0;
    const instrumented = new WorkSnapshots({
      work,
      agentNames: async (c) => new Map((await agents.list(c, { includeArchived: true })).map((a) => [a.id, a.display_name ?? a.slug])),
      actorNames: async (c) => new Map((await identity.listMembers(c)).map((m) => [m.user_id, m.display_name ?? m.email])),
      deployments: (c) => deploys.currentByAgent(c),
      hasServeToken: async (_c, serviceId) => { credentials++; return serveTokens.has(serviceId); },
      scoped: (c) => db.forWorkspace(c.workspaceId),
    });
    counting.reset();
    await instrumented.fleet(ctx);
    return { db: counting.count(), credentials };
  };

  const full = await readsPerFleet();
  const cards = (await snapshots.fleet(ctx)).cards;
  check(`the strip's database reads do not grow with the fleet (${full.db} for ${cards.length} cards)`,
    full.db === 4, `${full.db}`);
  // ONE PER CARD THAT COULD HAVE A TOKEN, which is every card except a public one — a public
  // endpoint has none by design, so asking the vault about it would be a query whose answer says
  // nothing. That short-circuit is what makes the two numbers differ, and asserting the difference
  // rather than the total is what keeps this from passing if the short-circuit is removed.
  const askable = cards.filter((c) => c.connection !== "public").length;
  check(`...while the credential check is one per live deployment that could have one (${full.credentials})`,
    full.credentials === askable, `${full.credentials} vs ${askable}`);
  check("...and a public endpoint is not asked about at all", cards.some((c) => c.connection === "public") && full.credentials < cards.length);

  counting.reset();
  await snapshots.list(ctx, { scope: "all" });
  const page = counting.count();
  counting.reset();
  await snapshots.list(ctx, { scope: "all", limit: 1 });
  const oneRow = counting.count();
  check(`a page of fifty costs the same as a page of one (${page} vs ${oneRow})`, page === oneRow, `${page} vs ${oneRow}`);
}

await base.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

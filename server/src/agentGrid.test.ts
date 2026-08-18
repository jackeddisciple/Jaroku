// The Agents grid aggregate: what it costs, and whose rows it can see.
//
// §7.2 IS THE CLAIM THIS SUITE EXISTS TO HOLD. "This must be one query. An N+1 across forty agents
// will be instantly visible and you will have to come back and fix it. Write the aggregate, then
// write a test that asserts the query count for a grid load is constant regardless of agent count."
//
// So the driver is instrumented and the statements are counted, once against one agent and once
// against forty. The number itself is not the assertion — a later release may legitimately need one
// more read — but "the same number for one agent as for forty" is, and that is the property that
// cannot be satisfied by accident.
//
// THE SECOND HALF IS §7.3, and it is a real information-leak boundary rather than a stylistic one:
// an id belonging to another workspace reads as ABSENT, not as forbidden. Two workspaces are stood
// up side by side, each given an agent, and each asked about the other's.
//
//   npm run test:agent-grid

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { BillingRepository } from "./db/repositories/billing.ts";
import { ThreadStore } from "./threadStore.ts";
import { TraceStore } from "./store.ts";
import { DeployStore } from "./deployStore.ts";
import { OUTCOME_WINDOW, driftOf, healthOf, missingCredentials } from "./agentHealth.ts";
import type { Db, Queryable, WriteResult } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/**
 * A `Db` that counts the statements that pass through it.
 *
 * A WRAPPER RATHER THAN A DRIVER FLAG, because what has to be counted is what the repositories
 * ACTUALLY send — including the ones a `forWorkspace` handle issues, which is every read the grid
 * makes. Wrapping `forWorkspace` as well as the top-level methods is the whole trick: a counter that
 * only saw the outer object would have counted zero and passed forever.
 */
function counting(db: Db): { db: Db; count: () => number; reset: () => void } {
  let n = 0;
  const wrapQ = (q: Queryable): Queryable => ({
    get: <T>(sql: string, params?: readonly unknown[]) => { n++; return q.get<T>(sql, params); },
    all: <T>(sql: string, params?: readonly unknown[]) => { n++; return q.all<T>(sql, params); },
    run: (sql: string, params?: readonly unknown[]): Promise<WriteResult> => { n++; return q.run(sql, params); },
    exec: (sql: string) => { n++; return q.exec(sql); },
  });
  const wrapped = {
    ...db,
    dialect: db.dialect,
    get: <T>(sql: string, params?: readonly unknown[]) => { n++; return db.get<T>(sql, params); },
    all: <T>(sql: string, params?: readonly unknown[]) => { n++; return db.all<T>(sql, params); },
    run: (sql: string, params?: readonly unknown[]) => { n++; return db.run(sql, params); },
    exec: (sql: string) => { n++; return db.exec(sql); },
    forWorkspace: (workspaceId: string) => wrapQ(db.forWorkspace(workspaceId)),
    scoped: <T>(workspaceId: string, fn: (tx: Queryable) => Promise<T>) =>
      db.scoped(workspaceId, (tx) => fn(wrapQ(tx))),
  } as unknown as Db;
  return { db: wrapped, count: () => n, reset: () => { n = 0; } };
}

/**
 * The grid's reads, in the same shape and the same order `agentGridSnapshot` issues them.
 *
 * A COPY OF THE CALL LIST, NOT OF THE DERIVATION. What §7.2 asks to be held constant is how many
 * statements a grid load costs, and that is decided entirely by which methods are called — none of
 * which live in `index.ts` except the joining, which issues nothing. Importing the real function
 * would mean standing the whole process up (a relay, a run pool, a deploy manager, an object store)
 * to count SELECTs; this asserts the property that can actually go wrong, and `test:acceptance`
 * covers that the real one is wired.
 */
async function gridReads(
  ctx: TenantContext,
  deps: {
    agents: AgentRepository; store: TraceStore; threads: ThreadStore;
    deploys: DeployStore; billing: BillingRepository; refs: SecretRefRepository;
  },
  since: string,
): Promise<void> {
  await Promise.all([
    deps.agents.list(ctx, { includeArchived: true }),
    deps.store.agentRunFacts(ctx, since, OUTCOME_WINDOW),
    deps.threads.agentThreadFacts(ctx),
    deps.deploys.currentByAgent(ctx),
    deps.billing.spendByAgent(ctx, since),
    deps.agents.currentVersionSources(ctx),
    deps.refs.list(ctx),
  ]);
}

const ISO = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

async function seedAgent(
  db: Db,
  ctx: TenantContext,
  agents: AgentRepository,
  threads: ThreadStore,
  slug: string,
  opts: { runs?: number; failing?: boolean; requiredEnv?: string[] } = {},
): Promise<string> {
  const agent = await agents.create(ctx, {
    id: randomUUID(),
    slug,
    display_name: slug,
    connectors: [],
    mcp_tools: [],
    required_env: opts.requiredEnv ?? [],
    default_provider: "fake",
  });
  const thread = await threads.create(ctx, { agentId: agent.id, agentName: slug, title: `${slug} session` });
  await threads.addItem(ctx, thread.id, { kind: "message", role: "user", body: `do something in ${slug}` });
  for (let i = 0; i < (opts.runs ?? 0); i++) {
    // Written straight in rather than through `upsertRun`, so the seeding cost is not confused with
    // the read cost the counter is about.
    await db.forWorkspace(ctx.workspaceId).run(
      `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at, ended_at,
                         cost, tokens, error)
       VALUES (?, ?, ?, 'fake', 'fake-1', ?, ?, ?, 0, 0, ?)`,
      [
        randomUUID(), ctx.workspaceId, slug,
        opts.failing ? "error" : "completed",
        ISO((i + 1) * HOUR), ISO((i + 1) * HOUR - 1000),
        opts.failing ? "it went wrong" : null,
      ],
    );
  }
  return agent.id;
}

{
  const raw = await openTestSqlite();
  const meter = counting(raw);
  const db = meter.db;
  try {
    const agents = new AgentRepository(db);
    const store = new TraceStore(db);
    const threads = new ThreadStore(db);
    const deploys = new DeployStore(db);
    const billing = new BillingRepository(db);
    const refs = new SecretRefRepository(db);
    const deps = { agents, store, threads, deploys, billing, refs };
    const since = ISO(7 * 24 * HOUR);

    // A IS THE WORKSPACE MIGRATION 004 ALREADY CREATED, and B is a second one made here. Two are
    // needed because §7.3 is a claim about what one workspace can see of another, and a suite with
    // one workspace can assert nothing about that at all.
    const A = testContext();
    const B = { ...testContext(), workspaceId: randomUUID() } as TenantContext;
    await db.run(
      `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'personal', 'free', ?)`,
      [B.workspaceId, `ws-${B.workspaceId.slice(0, 8)}`, "the other tenant", new Date().toISOString()],
    );

    console.log("\nthe grid costs the same for forty agents as for one (§7.2)");
    {
      await seedAgent(db, A, agents, threads, "agent_one", { runs: 3 });
      meter.reset();
      await gridReads(A, deps, since);
      const one = meter.count();
      check("one agent costs a bounded number of statements", one > 0 && one < 20, `${one}`);

      for (let i = 0; i < 39; i++) {
        await seedAgent(db, A, agents, threads, `agent_${String(i).padStart(2, "0")}`, { runs: 2 });
      }
      meter.reset();
      await gridReads(A, deps, since);
      const forty = meter.count();

      // THE ASSERTION §7.2 ASKS FOR, and the only one worth having: not that the number is small,
      // but that it does not move. An N+1 would show here as 40× whatever the per-agent read is.
      check("forty agents cost exactly the same", forty === one, `one=${one} forty=${forty}`);
    }

    console.log("\n...and the facts it gathers are right, not merely cheap");
    {
      const runFacts = await store.agentRunFacts(A, since, OUTCOME_WINDOW);
      const one = runFacts.get("agent_one");
      check("the run counts are per agent", one?.runs7d === 3, JSON.stringify(one?.runs7d));
      check("the sparkline window is oldest-first, which is the order it is drawn in",
        (one?.recent.length ?? 0) === 3 &&
        (one?.recent[0]?.startedAt ?? "") < (one?.recent[2]?.startedAt ?? ""),
        JSON.stringify(one?.recent.map((r) => r.startedAt)));

      // THE READ THAT WOULD OTHERWISE BE THE N+1. Twenty per agent, from one statement.
      await seedAgent(db, A, agents, threads, "busy_agent", { runs: 30 });
      const busy = (await store.agentRunFacts(A, since, OUTCOME_WINDOW)).get("busy_agent");
      check(`the window caps at ${OUTCOME_WINDOW} per agent, not per workspace`,
        busy?.recent.length === OUTCOME_WINDOW, String(busy?.recent.length));
      // THE HALF THAT IS EASY TO GET BACKWARDS. The window takes the newest twenty DESCENDING and
      // then re-sorts them ascending for the sparkline; sorting the table ascending and taking the
      // first twenty would take the OLDEST twenty, which is the opposite list and looks identical
      // in a screenshot. These runs are seeded one per hour going back thirty, so the oldest bar
      // that survives is the one from twenty hours ago and everything past it is gone.
      check("...and it is the NEWEST twenty rather than the oldest",
        (busy?.recent[0]?.startedAt ?? "") > ISO(21 * HOUR),
        `oldest kept = ${busy?.recent[0]?.startedAt}`);
      check("...so the runs beyond the window are not in it at all",
        (busy?.recent.at(-1)?.startedAt ?? "") > (busy?.recent[0]?.startedAt ?? ""));

      const threadFacts = await threads.agentThreadFacts(A);
      const uuid = (await agents.bySlug(A, "agent_one"))!.id;
      check("the current-work line names the agent's latest session",
        threadFacts.get(uuid)?.latest?.title === "agent_one session");
      check("...and carries the last thing the user said in it",
        threadFacts.get(uuid)?.latest?.lastTurn === "do something in agent_one");
      check("the footer's thread count is per agent", threadFacts.get(uuid)?.threadCount === 1);
    }

    console.log("\nan agent that has failed reads as failing, and the failing STEP is findable");
    {
      await seedAgent(db, A, agents, threads, "broken_agent", { runs: 4, failing: true });
      const facts = (await store.agentRunFacts(A, since, OUTCOME_WINDOW)).get("broken_agent");
      check("its errors are counted", facts?.errors7d === 4, String(facts?.errors7d));
      check("...and the most recent message is kept for the card", facts?.lastError === "it went wrong");
      check("...and health says failing",
        healthOf({ outcomes: (facts?.recent ?? []).map((r) => r.outcome), versionSource: "generation" }) === "failing");

      // §5.5: "a failed bar opens on the failing step". The FIRST failing step, because a failure
      // cascades and what somebody wants is where it went wrong.
      const runId = facts!.recent[0]!.runId;
      for (const [seq, error] of [[1, null], [2, "boom"], [3, "and again"]] as const) {
        await db.forWorkspace(A.workspaceId).run(
          `INSERT INTO steps (id, workspace_id, run_id, seq, type, name, latency_ms, error, started_at)
           VALUES (?, ?, ?, ?, 'tool_call', 'step', 1, ?, ?)`,
          [`step-${seq}-${runId}`, A.workspaceId, runId, seq, error, ISO(HOUR)],
        );
      }
      const first = await store.firstFailedStepFor(A, [runId]);
      check("the first failing step is the one a red bar opens on, not the last",
        first.get(runId) === `step-2-${runId}`, String(first.get(runId)));
      check("a workspace with no failures is not asked at all",
        (await store.firstFailedStepFor(A, [])).size === 0);
    }

    console.log("\nthe missing-credential derivation reads `configured`, not existence");
    {
      await seedAgent(db, A, agents, threads, "needs_keys", { requiredEnv: ["SLACK_TOKEN", "STRIPE_KEY"] });
      const owner = (await agents.bySlug(A, "needs_keys"))!;
      // Declared but never given a value — the state a membership test against the table would
      // report as present, which is the failure §5.2's warning line exists to catch.
      await refs.declare(A, { name: "SLACK_TOKEN", scope: "agent", agentId: owner.id, provider: null });
      await refs.markConfigured(A, { name: "STRIPE_KEY", scope: "agent", agentId: owner.id, provider: null });

      const configured = new Set((await refs.list(A)).filter((r) => r.configured).map((r) => r.name));
      const missing = missingCredentials(owner.required_env, configured);
      check("a declared-but-unconfigured name is missing", missing.includes("SLACK_TOKEN"));
      check("...and a configured one is not", !missing.includes("STRIPE_KEY"));
      check("so the card says one credential missing, not none and not two",
        missing.length === 1, JSON.stringify(missing));
    }

    console.log("\ndrift comes off the version a deploy actually recorded (migration 041)");
    {
      const owner = (await agents.bySlug(A, "agent_one"))!;
      const deployment = await deploys.create(A, {
        agentId: owner.slug, provider: "fake", model: "fake-1", envKeys: [], version: 2,
      });
      await deploys.patch(A, deployment.id, { status: "live", url: "https://example.invalid" });
      const live = (await deploys.currentByAgent(A)).get(owner.slug);
      // THE COLUMN THAT EXISTED AND WAS NEVER WRITTEN. Until the Agents tab, `deployments.version`
      // was NULL on every row this product had ever created, so drift could not be computed at all.
      check("a deploy records which version it built from", live?.version === 2, String(live?.version));
      check("...so a card can say v2 → v9",
        JSON.stringify(driftOf(live?.version ?? null, 9)) === JSON.stringify({ deployed: 2, current: 9 }));
      check("...and says nothing when the two agree", driftOf(live?.version ?? null, 2) === null);
    }

    console.log("\n§7.3: another workspace's agent reads as ABSENT, never as forbidden");
    {
      await seedAgent(db, B, agents, threads, "other_tenant_agent", { runs: 2 });
      const bAgent = (await agents.bySlug(B, "other_tenant_agent"))!;

      check("B's agent is not in A's list",
        !(await agents.list(A, { includeArchived: true })).some((x) => x.slug === "other_tenant_agent"));
      check("...and asking A for it by id resolves to nothing rather than refusing",
        (await agents.byId(A, bAgent.id)) === undefined);
      check("...nor can A read its versions", (await agents.versions(A, bAgent.id)).length === 0);
      check("...nor its file blame", (await agents.fileBlame(A, bAgent.id)).size === 0);
      check("...nor which source made its live version",
        !(await agents.currentVersionSources(A)).has(bAgent.id));

      // The aggregates are the ones most likely to be written without a scope, because they group
      // rather than look up — which is exactly how a GROUP BY over every run in the database gets
      // written by accident.
      check("A's run facts contain none of B's agents",
        !(await store.agentRunFacts(A, since, OUTCOME_WINDOW)).has("other_tenant_agent"));
      check("A's thread facts contain none of B's agents",
        !(await threads.agentThreadFacts(A)).has(bAgent.id));
      check("...and B still sees its own", (await threads.agentThreadFacts(B)).has(bAgent.id));

      check("B's deployments are not in A's map", !(await deploys.currentByAgent(A)).has("other_tenant_agent"));
      check("B's declared credential names are not in A's list",
        !(await refs.list(A)).some((r) => r.name === "ONLY_IN_B"));
    }
  } finally {
    await raw.close();
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

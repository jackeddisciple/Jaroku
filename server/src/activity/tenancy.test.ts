// Two workspaces, both busy, and every module's figures for A unaffected by B's rows.
//
// NOT ONE MODULE — EVERY MODULE. §5.4 asks for exactly that and the reason is in the history: row-
// level security has bitten this project repeatedly and every single instance was an AGGREGATE. The
// eval job aggregate read `steps` unscoped and zeroed every job's cost, tokens and latency. The eval
// cost estimate read `runs` unscoped and always fell back to "no history". Both worked locally, on
// SQLite, and as the database owner — which is what every test connects as and what no deployment
// connects as. The Activity tab is nothing but aggregates over exactly those tables, so a per-module
// assertion is the only kind that can catch the per-module version of that mistake.
//
// AND IN BOTH DIRECTIONS. An assertion that A cannot see B's rows passes trivially when the query
// returns nothing at all, which is the other way a scoped read fails. So the two workspaces are
// seeded with DIFFERENT and NON-ZERO data, and each module is checked to return A's numbers exactly
// — not merely to exclude B's.
//
// IT IS EXPORTED AND INVOKED FROM `tenancy.test.ts` RATHER THAN GIVEN ITS OWN SCRIPT, which is what
// `auth/attacks.test.ts` does and for the reason that file states: the spec makes the tenancy suite
// the gate for every later session, and a second script somebody can forget to run is not a gate.
// `npm run test:tenancy` runs this, on both drivers, and on Postgres with RLS behind it.

import { randomUUID } from "node:crypto";

import type { Db } from "../db/db.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { TraceStore } from "../store.ts";
import type { Run, Step } from "../types.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow, type Window } from "./range.ts";

/** The moment every window in this suite is resolved against, so bucket edges are deterministic. */
export const ACTIVITY_NOW = new Date("2026-08-19T12:00:00.000Z");

/**
 * Everything one workspace owns for this tab, so the same fixture can be built twice and differ.
 *
 * THE TWO WORKSPACES ARE DELIBERATELY UNLIKE EACH OTHER — different agent counts, different spend,
 * different failure counts, different models. An isolation suite whose two tenants hold identical
 * data cannot tell a correctly scoped aggregate from one that reads everything and happens to
 * halve, and that is the exact shape of the bug this file exists for.
 */
export interface ActivityFixture {
  ctx: TenantContext;
  label: string;
  /** Agent slugs, in the order they were created. */
  agents: string[];
  /** How many agents this workspace has. Differs between A and B on purpose. */
  agentCount: number;
  /** What this workspace spent inside the window, to the cent. */
  spendUsd: number;
  /** How many tokens it moved inside the window. */
  tokens: number;
  /** How many of those were cache reads, on the rows that recorded a split. */
  cachedTokens: number;
  /** Run ids, in the order they were created. The first of them ended in error. */
  runs: string[];
}

/**
 * The shape of one workspace's day, per label.
 *
 * EVERY NUMBER DIFFERS BETWEEN A AND B, and that is the assertion's whole mechanism rather than
 * decoration. An isolation suite whose two tenants hold the same data cannot tell a correctly
 * scoped aggregate from one that reads everything and happens to halve — and "happens to halve" is
 * precisely what a two-workspace test database produces.
 */
const SHAPE: Record<string, { agents: number; runs: number; usd: number; tokens: number; cached: number }> = {
  a: { agents: 2, runs: 3, usd: 0.75, tokens: 300, cached: 100 },
  b: { agents: 3, runs: 5, usd: 2.25, tokens: 700, cached: 250 },
};

export async function seedActivity(db: Db, label: string): Promise<ActivityFixture> {
  const identity = new IdentityRepository(db);
  const sys = systemContext(newRequestId());
  const ws = await identity.createWorkspaceUnowned(sys, {
    name: `activity ${label} ${randomUUID().slice(0, 6)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  const agentRepo = new AgentRepository(db);

  const shape = SHAPE[label] ?? SHAPE["a"]!;
  const agents: string[] = [];
  for (let i = 0; i < shape.agents; i++) {
    // THE SAME SLUGS IN BOTH WORKSPACES, on purpose and for the reason the main suite shares an MCP
    // server id: `support_bot` is what two tenants who both generated a support bot actually
    // produce, and migration 008's `UNIQUE (workspace_id, slug)` is what makes it possible. A suite
    // whose two tenants used different names could not catch an aggregate that grouped by slug
    // across workspaces, because the groups would never collide.
    const slug = `shared_agent_${i}`;
    await agentRepo.upsertFromDisk(ctx, { slug, display_name: `${slug} (${label})` });
    agents.push(slug);
  }

  // A DAY OF WORK, INSIDE THE WINDOW EVERY ASSERTION BELOW RESOLVES. Each run is placed an hour
  // apart ending an hour before `ACTIVITY_NOW`, so every row is comfortably inside a 24h window and
  // none of them straddles a bucket edge — a fixture that landed rows on the boundary would make a
  // failure here indistinguishable from an off-by-one in `bucketIndex`, which has its own suite.
  const trace = new TraceStore(db);
  const billing = new BillingRepository(db);
  const runs: string[] = [];
  const perRunUsd = shape.usd / shape.runs;
  const perRunTokens = Math.round(shape.tokens / shape.runs);
  const perRunCached = Math.round(shape.cached / shape.runs);

  for (let i = 0; i < shape.runs; i++) {
    const runId = randomUUID();
    const at = new Date(ACTIVITY_NOW.getTime() - (i + 1) * 3_600_000).toISOString();
    const ended = new Date(Date.parse(at) + 2_000).toISOString();
    // ONE RUN IN EACH WORKSPACE ENDS IN ERROR, because the crashed-run rule is the one §2 says must
    // not be reintroduced: a run that died still spent money on the steps it completed.
    const failed = i === 0;
    const run: Run = {
      id: runId,
      agent_id: agents[i % agents.length]!,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      status: failed ? "error" : "completed",
      started_at: at,
      ended_at: ended,
      // DELIBERATELY ZERO ON THE RUN ROW, and this is the fixture's sharpest edge. Nothing on this
      // tab may read `runs.cost`; a fixture that filled it would let a query that did read it pass
      // every assertion below.
      cost: 0,
      tokens: 0,
      error: failed ? "boom" : null,
    };
    await trace.upsertRun(ctx, run);

    const step: Step = {
      id: randomUUID(), run_id: runId, seq: 0, type: "llm_call", name: "call_model",
      input: { q: label }, output: { a: label }, state_before: null, state_after: null,
      tokens: perRunTokens, cost: perRunUsd, latency_ms: 500 + i * 100, error: null,
      parent_step_id: null, started_at: at,
    };
    await trace.insertStep(ctx, step);

    await billing.record(ctx, {
      kind: "llm.provider",
      idempotencyKey: `activity-${label}-${runId}`,
      runId,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: perRunTokens - perRunCached,
      outputTokens: 0,
      cachedInputTokens: perRunCached,
      totalTokens: perRunTokens,
      costUsd: perRunUsd,
      occurredAt: at,
    });
    runs.push(runId);
  }

  return {
    ctx,
    label,
    agents,
    agentCount: shape.agents,
    spendUsd: perRunUsd * shape.runs,
    tokens: perRunTokens * shape.runs,
    cachedTokens: perRunCached * shape.runs,
    runs,
  };
}

/**
 * The isolation pass, run once per driver by `tenancy.test.ts`.
 *
 * `check` and `label` come from the caller so the output reads as one suite rather than as two, and
 * so a failure here fails `npm run test:tenancy` rather than being reported somewhere nobody looks.
 */
export async function activitySuite(
  db: Db,
  check: (ok: boolean, msg: string) => void,
  label: string,
): Promise<void> {
  console.log(`  · activity aggregates (${label})`);

  const A = await seedActivity(db, "a");
  const B = await seedActivity(db, "b");
  const store = new ActivityStore(db);
  const w: Window = resolveWindow("24h", ACTIVITY_NOW, null);

  // --- the directory every other module resolves its names through -----------------------------
  //
  // FIRST, BECAUSE EVERYTHING ELSE IS LABELLED BY IT. Six modules render an agent's name and every
  // one of them receives a slug from its own aggregate; if this map crossed the boundary, a
  // leaderboard row in A would carry B's display name — which is the version of this bug somebody
  // would actually notice, and the version that is worst.

  const dirA = await store.agentDirectory(A.ctx);
  const dirB = await store.agentDirectory(B.ctx);

  check(dirA.size === A.agentCount, `A's directory holds exactly its own ${A.agentCount} agents`);
  check(dirB.size === B.agentCount, `B's directory holds exactly its own ${B.agentCount} agents`);

  // The slugs COLLIDE by construction, so identity is not enough — the NAME is what proves the row
  // came from the right workspace.
  const shared = A.agents[0]!;
  check(
    dirA.get(shared)?.name === `${shared} (a)`,
    "a slug both workspaces use resolves to A's own display name in A",
  );
  check(
    dirB.get(shared)?.name === `${shared} (b)`,
    "...and to B's in B, from the same slug",
  );
  check(
    dirA.get(shared)?.uuid !== dirB.get(shared)?.uuid,
    "...and they are two different rows, not one shared one",
  );
  // The direction that passes trivially when a query returns nothing.
  check(
    B.agents.every((slug) => dirB.has(slug)),
    "B's directory is complete, so the assertion above is not passing on an empty read",
  );
  // B has one agent A does not, which is the only slug that can prove the bound rather than the join.
  const onlyB = B.agents[B.agents.length - 1]!;
  check(!dirA.has(onlyB), `A's directory does not contain B's ${onlyB}`);

  // --- the workspace's own header facts --------------------------------------------------------

  const metaA = await store.workspaceMeta(A.ctx);
  const metaB = await store.workspaceMeta(B.ctx);
  check(metaA?.name.includes("activity a") === true, "A reads its own workspace name");
  check(metaB?.name.includes("activity b") === true, "B reads its own");
  check(
    typeof metaA?.createdAt === "string" && metaA.createdAt.length > 0,
    "and its creation time, which is what decides whether a delta has anything to compare against",
  );

  // §5.4 EXACTLY: an id belonging to another workspace reads as ABSENT, not as forbidden. There is
  // no method on this store that takes an id, so the only way to ask about a workspace is to hold a
  // context for it — and a context for one that is not there answers with nothing rather than with
  // an error, which is the same answer another tenant's id produces and is the point.
  const nowhere = systemContextFor(randomUUID(), newRequestId());
  check(
    (await store.workspaceMeta(nowhere)) === undefined,
    "a workspace this context cannot see reads as absent, not as forbidden",
  );
  check(
    (await store.agentDirectory(nowhere)).size === 0,
    "...and its directory is empty rather than everybody's",
  );

  // --- module 2: spend ------------------------------------------------------------------------

  const spendA = await store.spend(A.ctx, w);
  const spendB = await store.spend(B.ctx, w);
  const cents = (n: number): number => Math.round(n * 100);

  check(cents(spendA.usd) === cents(A.spendUsd), `A's spend is A's ($${spendA.usd.toFixed(2)})`);
  check(cents(spendB.usd) === cents(B.spendUsd), `B's spend is B's ($${spendB.usd.toFixed(2)})`);
  // The assertion that catches the bug this file exists for: an unscoped SUM returns the pair.
  check(
    cents(spendA.usd) !== cents(A.spendUsd + B.spendUsd),
    "...and neither is the sum of both, which is what an unscoped SUM returns",
  );
  check(spendA.events === A.runs.length, "A counts only its own usage rows");
  check(spendB.events === B.runs.length, "B counts only its own");
  check(
    spendA.byProvider.reduce((n, p) => n + cents(p.usd), 0) === cents(A.spendUsd),
    "the provider split adds up to A's own total and no further",
  );

  // --- module 3: token volume -----------------------------------------------------------------

  const tokensA = await store.tokens(A.ctx, w);
  const tokensB = await store.tokens(B.ctx, w);
  check(tokensA.total === A.tokens, `A's volume is A's (${tokensA.total})`);
  check(tokensB.total === B.tokens, `B's volume is B's (${tokensB.total})`);
  check(tokensA.total !== A.tokens + B.tokens, "...and not both workspaces' tokens under A's name");
  check(tokensA.cached === A.cachedTokens, "and the cached split is scoped too");
  check(tokensB.cached === B.cachedTokens, "...on both sides");
}

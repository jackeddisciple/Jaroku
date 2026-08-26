// The Agents surface, driven at the cases a screenshot cannot produce.
//
// WHAT THIS IS FOR, AND WHY IT IS SEPARATE FROM `test:agent-grid`. That suite asserts the two claims
// the specification makes out loud: the read is not an N+1, and another workspace's agent is absent.
// This one is the adversarial pass — every case where a derivation looked obviously right and was
// wrong about something nobody had that day. Each block below corresponds to a defect that was in the
// shipped code, and the assertion is what stops it coming back.
//
//   npm run test:agent-adversarial

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { AgentRepository, nextForkSlug } from "./db/repositories/agents.ts";
import { ThreadStore } from "./threadStore.ts";
import { TraceStore } from "./store.ts";
import { DeployStore } from "./deployStore.ts";
import { bestByQuality } from "./evalAggregate.ts";
import { OUTCOME_WINDOW, driftOf, healthOf } from "./agentHealth.ts";
import type { ProviderMetrics } from "./evalAggregate.ts";
import type { Db } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ISO = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

async function agentRow(
  agents: AgentRepository,
  ctx: TenantContext,
  slug: string,
  over: Partial<{ requiredEnv: string[] }> = {},
): Promise<string> {
  const a = await agents.create(ctx, {
    id: randomUUID(),
    slug,
    display_name: slug,
    connectors: [],
    mcp_tools: [],
    required_env: over.requiredEnv ?? [],
    default_provider: "fake",
  });
  return a.id;
}

const leg = (over: Partial<ProviderMetrics>): ProviderMetrics => ({
  provider: "anthropic", model: "m", total: 2, succeeded: 2, failed: 0, successRate: 1,
  comparisonCostUsd: 0.01, costPerRunUsd: 0.005, spentUsd: 0.01, tokens: 100,
  latencyP50Ms: 100, latencyP95Ms: 200, costUnknown: false, costIncomplete: false,
  qualityScore: 0.5, scored: 2, unscored: 0,
  ...over,
});

{
  const db: Db = await openTestSqlite();
  try {
    const agents = new AgentRepository(db);
    const store = new TraceStore(db);
    const threads = new ThreadStore(db);
    const deploys = new DeployStore(db);
    const ctx = testContext();
    const since = ISO(7 * 24 * HOUR);

    console.log("\ndrift is a fact about something that is SERVING, not about any deploy row");
    {
      const slug = "drifty";
      await agentRow(agents, ctx, slug);
      // A deploy that never got off the ground still records the version it was going to build from.
      const dead = await deploys.create(ctx, {
        agentId: slug, provider: "fake", model: "m", envKeys: [], version: 2,
      });
      await deploys.patch(ctx, dead.id, { status: "failed", error: "build failed" });
      const current = (await deploys.currentByAgent(ctx)).get(slug);

      check("a failed deploy is still the agent's most recent one", current?.status === "failed");
      check("...and it carries the version it meant to build", current?.version === 2);
      // THE DEFECT: `driftOf` answered on the numbers alone, so a card with nothing deployed showed
      // `v2 → v9` — claiming old code was serving when no code was. The status is the guard, and it
      // belongs at the one place the snapshot is assembled rather than in each surface that renders.
      const shownDrift = current?.status === "live" ? driftOf(current.version, 9) : null;
      check("a failed deploy produces no drift badge", shownDrift === null);
      check("...though the numbers alone would have produced one",
        JSON.stringify(driftOf(2, 9)) === JSON.stringify({ deployed: 2, current: 9 }));

      await deploys.patch(ctx, dead.id, { status: "live", url: "https://x.invalid" });
      const live = (await deploys.currentByAgent(ctx)).get(slug);
      check("...and the same row, once live, does produce one",
        JSON.stringify(live?.status === "live" ? driftOf(live.version, 9) : null) ===
          JSON.stringify({ deployed: 2, current: 9 }));
    }

    console.log("\na fork avoids every slug the UNIQUE constraint holds, not just the visible ones");
    {
      await agentRow(agents, ctx, "twin");
      const swept = await agentRow(agents, ctx, "twin_copy");
      // The sweep's mark. The row keeps its slug, so the constraint still holds it.
      await db.forWorkspace(ctx.workspaceId).run(
        `UPDATE agents SET deleted_at = ? WHERE id = ?`, [ISO(HOUR), swept],
      );

      const visible = new Set((await agents.list(ctx, { includeArchived: true })).map((a) => a.slug));
      const taken = await agents.takenSlugs(ctx);
      check("the visible list does not contain the swept slug", !visible.has("twin_copy"));
      // THE DEFECT: `nextForkSlug` was handed the visible list, so it offered `twin_copy` — and the
      // INSERT hit the constraint and answered "that did not work", for a name never available.
      check("...but `takenSlugs` does, because that is what the constraint holds", taken.has("twin_copy"));
      check("so the fork skips it and takes the next one",
        nextForkSlug("twin", taken) === "twin_copy2", String(nextForkSlug("twin", taken)));
      check("a first fork of a free name is `_copy`", nextForkSlug("fresh", taken) === "fresh_copy");

      // The other refusal, and the one nobody reaches by hand: a name with no room for a suffix.
      const long = "a".repeat(60);
      check("a slug too long to suffix is refused rather than truncated into a collision",
        nextForkSlug(long, new Set()) === null, String(nextForkSlug(long, new Set())));
      check("...and one with just enough room is not", nextForkSlug("a".repeat(58), new Set()) !== null);

      // AND THE FORK WRITES BYTES, NOT ONLY A ROW. `test:project-store` holds the property — a
      // manifest copied across an agent boundary names a prefix nobody wrote — and this holds the
      // CALL, because the property is only protected while `forkAgent` uses the operation that has
      // it. `addVersion` writes the row alone, which is right for a restore (same agent id, objects
      // already there) and is what made every read of a fork throw. Read as text because the
      // function is not exported and the distinction is one identifier wide.
      const forkFn = /async function forkAgent\([\s\S]*?\n\}/.exec(indexSource)?.[0] ?? "";
      check("forkAgent exists to be read", forkFn.length > 0);
      check(
        "a fork publishes the source's FILES under the fork's own id",
        /projects\.publish\(ctx, id, sourceFiles/.test(forkFn),
      );
      check(
        "...rather than copying the manifest onto it with addVersion, which writes no objects",
        !/agentRepo\.addVersion\(ctx, id,/.test(forkFn),
      );
      check(
        "...having read them first, so an unreadable source refuses instead of forking a second broken agent",
        /projects\.readVersion\(ctx, source\.id/.test(forkFn),
      );
      check(
        "...and materialises them where the local run path looks for them",
        /projects\.materialise\(ctx, id,/.test(forkFn),
      );
    }

    console.log("\nan agent with nothing at all does not crash a derivation, and says so");
    {
      const bare = await agentRow(agents, ctx, "bare_agent");
      const runFacts = await store.agentRunFacts(ctx, since, OUTCOME_WINDOW);
      const threadFacts = await threads.agentThreadFacts(ctx);

      check("no runs means no entry rather than a zeroed one", !runFacts.has("bare_agent"));
      check("no threads means no entry either", !threadFacts.has(bare));
      // What the card does with those absences. Null is "not started yet"; a zero would be a claim.
      check("health with nothing published and nothing run is unverified",
        healthOf({ outcomes: [], versionSource: null }) === "unverified");
      check("no version row means no source to read",
        !(await agents.currentVersionSources(ctx)).has(bare));
      check("...and no file blame either", (await agents.fileBlame(ctx, bare)).size === 0);
    }

    console.log("\nan agent whose only session was archived has still been started");
    {
      const put = await agentRow(agents, ctx, "quiet_agent");
      const t = await threads.create(ctx, { agentId: put, agentName: "quiet_agent", title: "Old work" });
      await threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "have a look at this" });
      await threads.archive(ctx, t.id);

      const facts = (await threads.agentThreadFacts(ctx)).get(put);
      // THE ASYMMETRY THAT IS EASY TO GET WRONG IN EITHER DIRECTION. The COUNT is how many sessions
      // are open, so an archived one is not counted; the LATEST is whether the agent has been
      // started at all, so an archived one still answers. Excluding it from both would make the card
      // say "Not started yet" about an agent somebody worked on for a week.
      check("an archived session is not counted as open", facts?.threadCount === 0, String(facts?.threadCount));
      check("...but it is still the latest session, so the card does not say 'Not started yet'",
        facts?.latest?.title === "Old work");
      check("...and its last turn still reads", facts?.latest?.lastTurn === "have a look at this");
    }

    console.log("\nthe sparkline's window is per agent and survives a noisy neighbour");
    {
      // One agent with far more runs than the window, beside one with two. A window applied to the
      // WORKSPACE rather than to each agent would starve the quiet one entirely.
      for (const [slug, n] of [["loud_agent", 40], ["soft_agent", 2]] as const) {
        await agentRow(agents, ctx, slug);
        for (let i = 0; i < n; i++) {
          await db.forWorkspace(ctx.workspaceId).run(
            `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at,
                               ended_at, cost, tokens, error)
             VALUES (?, ?, ?, 'fake', 'm', 'completed', ?, ?, 0, 0, NULL)`,
            [randomUUID(), ctx.workspaceId, slug, ISO((i + 1) * HOUR), ISO((i + 1) * HOUR - 500)],
          );
        }
      }
      const facts = await store.agentRunFacts(ctx, since, OUTCOME_WINDOW);
      check("the loud agent is capped at the window", facts.get("loud_agent")?.recent.length === OUTCOME_WINDOW);
      check("...and the quiet one keeps both of its runs", facts.get("soft_agent")?.recent.length === 2);
    }

    console.log("\nthe failing-step lookup is asked once, and answers the first failure");
    {
      const runId = randomUUID();
      await db.forWorkspace(ctx.workspaceId).run(
        `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at, ended_at,
                           cost, tokens, error)
         VALUES (?, ?, 'soft_agent', 'fake', 'm', 'error', ?, ?, 0, 0, 'boom')`,
        [runId, ctx.workspaceId, ISO(HOUR), ISO(HOUR - 100)],
      );
      for (const [seq, error] of [[1, null], [2, "first"], [3, "second"]] as const) {
        await db.forWorkspace(ctx.workspaceId).run(
          `INSERT INTO steps (id, workspace_id, run_id, seq, type, name, latency_ms, error, started_at)
           VALUES (?, ?, ?, ?, 'tool_call', 'n', 1, ?, ?)`,
          [`s${seq}`, ctx.workspaceId, runId, seq, error, ISO(HOUR)],
        );
      }
      // A DUPLICATED ID IN THE INPUT IS NOT A DUPLICATED ROW IN THE OUTPUT. The caller flattens ids
      // off every card's bars, and two cards can name one run — an eval's jobs, a branch.
      const first = await store.firstFailedStepFor(ctx, [runId, runId, runId]);
      check("a run id asked for three times answers once", first.size === 1, String(first.size));
      check("...with the FIRST failing step, because a failure cascades", first.get(runId) === "s2");
      check("a run with no failing steps is simply absent",
        !(await store.firstFailedStepFor(ctx, [randomUUID()])).has("nope"));
    }

    console.log("\nthe eval winner is a ranking over what was scored, not over everything");
    {
      check("nothing scored means no winner rather than an arbitrary one",
        bestByQuality([leg({ qualityScore: null, scored: 0, unscored: 2 })]) === null);
      // An unscored leg is a judge that failed, and it says nothing about the provider — averaging
      // its silence in as a zero would punish it, and ranking it as a zero would too.
      check("an unscored leg cannot win, and cannot lose either",
        bestByQuality([
          leg({ model: "scored-low", qualityScore: 0.1 }),
          leg({ model: "unscored", qualityScore: null, scored: 0, unscored: 4 }),
        ])?.model === "scored-low");
      check("the highest score wins",
        bestByQuality([leg({ model: "a", qualityScore: 0.4 }), leg({ model: "b", qualityScore: 0.9 })])?.model === "b");
      // §6 excludes an unpriced model from a COST ranking. This is a quality ranking, and a leg that
      // scored best still scored best.
      check("an unpriced model is not disqualified from a QUALITY ranking",
        bestByQuality([
          leg({ model: "priced", qualityScore: 0.5 }),
          leg({ model: "unpriced", qualityScore: 0.8, costUnknown: true, comparisonCostUsd: null }),
        ])?.model === "unpriced");
      check("a tie falls to the higher success rate",
        bestByQuality([
          leg({ model: "flaky", qualityScore: 0.7, successRate: 0.5 }),
          leg({ model: "steady", qualityScore: 0.7, successRate: 1 }),
        ])?.model === "steady");
      // STABLE, so two reads of one eval never disagree about who won.
      const tied = [leg({ model: "zeta", qualityScore: 0.7 }), leg({ model: "alpha", qualityScore: 0.7 })];
      check("a total tie is broken by name, so the answer does not depend on row order",
        bestByQuality(tied)?.model === "alpha" && bestByQuality([...tied].reverse())?.model === "alpha");
    }

    console.log("\nthe grid's reads refuse an id that is not this workspace's, quietly");
    {
      // Not another workspace this time — a uuid that names nothing at all, which is what a stale
      // client sends after somebody else archives and the row is swept.
      const ghost = randomUUID();
      check("versions of a nonexistent agent is an empty list, not a throw",
        (await agents.versions(ctx, ghost)).length === 0);
      check("its blame is an empty map", (await agents.fileBlame(ctx, ghost)).size === 0);
      check("one of its versions is undefined", (await agents.version(ctx, ghost, 1)) === undefined);
      check("archiving it reports that nothing happened", (await agents.setArchived(ctx, ghost, true)) === false);
      check("renaming it likewise", (await agents.rename(ctx, ghost, "new name")) === false);
    }
  } finally {
    await db.close();
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

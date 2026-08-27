// The same Run and Step written through both drivers, read back, and compared.
//
// The trace store's promise, stated in its own header since long before there were two
// drivers: a step read back out of history is the SAME SHAPE as the one that streamed live.
// Everything downstream leans on it — the timeline renders both paths with one component,
// the state-diff view reads state_before/state_after without checking their type, the judge
// pulls the agent's answer out of a step's output, and the CSV export walks it.
//
// SQLite keeps that promise by storing payloads as TEXT and parsing on the way out. Postgres
// keeps it by storing `json` and letting the driver parse. Those are different mechanisms
// reaching the same place, and "reaching the same place" is a claim that has to be checked
// rather than asserted — which is what this file is. It is the one test that would catch a
// payload silently changing type between the machine a feature was written on and the one it
// runs on.
//
//   docker compose up -d postgres      (or any Postgres)
//   JAROKU_PG_URL=postgres://… npm run test:shape-parity

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./migrate.ts";
import { SqliteDb } from "./sqlite.ts";
import { withScratchPostgres } from "./testDb.ts";
import { LOCAL_WORKSPACE_ID, newRequestId, systemContextFor } from "./tenant.ts";
import { TraceStore } from "../store.ts";
import type { Run, Step } from "../types.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");

const runId = randomUUID();

const run: Run = {
  id: runId,
  agent_id: "parity_agent",
  provider: "fake",
  model: "fake-scripted",
  status: "completed",
  started_at: "2026-01-01T00:00:00.000Z",
  ended_at: "2026-01-01T00:00:02.250Z",
  cost: 0.01234567,
  tokens: 4242,
  error: null,
};

/**
 * The payload shapes that actually differ between a TEXT column and a `json` one.
 *
 * The interesting ones are the scalars. An object round-trips through either mechanism
 * unremarkably; a payload that IS a JSON string, or a number, or `null`, is where "parse
 * anything that looks like a string" and "the driver already parsed it" come apart.
 */
const steps: Step[] = [
  {
    id: randomUUID(), run_id: runId, seq: 0, type: "state_update", name: "agent",
    input: { messages: [{ role: "user", content: 'he said "hi"\nthen left' }], n: 0.1 },
    output: { messages: [], notes: ["ünïcödé — ✓"] },
    state_before: { count: 0 }, state_after: { count: 1 },
    tokens: null, cost: null, latency_ms: 12.5, error: null, parent_step_id: null,
    started_at: "2026-01-01T00:00:00.100Z",
  },
  {
    // A tool that returns a bare string, and one whose result LOOKS like a number. The
    // second is the trap: from Postgres it reads back as the JS string "123", and a hydration
    // that re-parsed every string would hand the consumer the number 123 instead.
    id: randomUUID(), run_id: runId, seq: 1, type: "tool_call", name: "lookup",
    input: "plain string argument",
    output: "123",
    state_before: null, state_after: null,
    tokens: null, cost: null, latency_ms: 3, error: null, parent_step_id: null,
    started_at: "2026-01-01T00:00:00.200Z",
  },
  {
    id: randomUUID(), run_id: runId, seq: 2, type: "llm_call", name: "model",
    input: [1, 2, 3], output: null,
    state_before: null, state_after: null,
    tokens: 4242, cost: 0.01234567, latency_ms: 900.25,
    error: "boom", parent_step_id: null,
    started_at: "2026-01-01T00:00:01.000Z",
  },
  {
    // Booleans and an empty object, because "falsy" is where coercions go wrong.
    id: randomUUID(), run_id: runId, seq: 3, type: "router", name: "should_continue",
    input: { done: false, retry: true }, output: {},
    state_before: {}, state_after: { done: true },
    tokens: null, cost: null, latency_ms: 0, error: null, parent_step_id: null,
    started_at: "2026-01-01T00:00:01.500Z",
  },
];

const ctx = systemContextFor(LOCAL_WORKSPACE_ID, newRequestId());

/**
 * Every write happens TWICE, because at-least-once ingest is not a hypothetical.
 *
 * The relay redelivers a buffered batch on reconnect and the store's answer is `ON CONFLICT DO
 * NOTHING`, so the second pass has to be a no-op on both drivers — and the conflict target it
 * names has to be one both drivers can resolve. Inserting once proves neither: it was a single
 * insert per step that let a conflict target no Postgres index could match reach production,
 * green on SQLite the whole way. The duplicate pass is one line and it is the line that fails.
 *
 * The existing "both drivers return every step" assertion below is what catches the other half —
 * a target that resolves but does not actually deduplicate returns twice the steps.
 */
async function roundTrip(store: TraceStore): Promise<{ run: Run | undefined; steps: Step[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await store.upsertRun(ctx, run);
    for (const s of steps) await store.insertStep(ctx, s);
  }
  return { run: await store.getRun(ctx, runId), steps: await store.stepsForRun(ctx, runId) };
}

/** Only the frozen schema's fields. Storage columns are not part of the comparison. */
const STEP_FIELDS = [
  "id", "run_id", "seq", "type", "name", "input", "output",
  "state_before", "state_after", "tokens", "cost", "latency_ms",
  "error", "parent_step_id", "started_at",
] as const;
const RUN_FIELDS = [
  "id", "agent_id", "provider", "model", "status",
  "started_at", "ended_at", "cost", "tokens", "error",
] as const;

const pick = <T extends object>(o: T, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

// --- the Cockpit's own table, which is here for a different reason from the two above ------------
//
// `runs` and `steps` are the frozen schema and their parity claim is about JSON payloads. This one
// is about TIMESTAMPS AND IDS, and it is the half of the divergence `test:timestamp-text` can only
// audit statically: `work_items.created_at` is `timestamptz` on Postgres and `TEXT` on SQLite, and
// `id` is `uuid` there and `TEXT` here. Both are correct — see 063's header — and both are correct
// only for as long as they read back as the same JavaScript value, which is what the driver's
// `setTypeParser` for 1184 and the store's explicitly-minted uuid are between them supposed to
// guarantee. A `Date` object arriving out of one driver and an ISO string out of the other is
// invisible in every suite that opens SQLite and is a `.slice()` on an object in production.
//
// `deployment_id` IS THE ONE COLUMN THAT IS `text` ON BOTH, because it references `deployments(id)`
// which migration 002 made `text` — so this also asserts that the FK the Cockpit's whole "what
// actually ran it" claim rests on is one a real deployment row satisfies on both drivers. It is
// written through raw SQL rather than through a store on purpose: the store does not exist at this
// commit, and what is being compared here is the SCHEMA rather than anything a store decides.
const WORK_FIELDS = [
  "id", "agent_id", "deployment_id", "run_id", "created_by", "input", "status",
  "output", "error", "failure_kind", "created_at", "started_at", "ended_at", "created_seq",
] as const;

const workIds = {
  user: randomUUID(),
  agent: randomUUID(),
  deployment: `dep_${randomUUID().slice(0, 8)}`,
  item: randomUUID(),
  run: randomUUID(),
};

/**
 * A work item, its three parents, and the row read back.
 *
 * The parents are seeded here rather than shared with the run above because a work item's foreign
 * keys are the point: an agent, a deployment and a USER, all of which have to exist before the row
 * does, and two of which are uuid on one driver and text on the other.
 */
async function workRoundTrip(db: { run: (sql: string, params?: unknown[]) => Promise<unknown>; get: <T>(sql: string, params?: unknown[]) => Promise<T | undefined> }): Promise<Record<string, unknown> | undefined> {
  const at = "2026-02-03T10:00:00.000Z";
  await db.run(
    `INSERT INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
    [workIds.user, `parity|${workIds.user}`, `${workIds.user}@example.com`, at],
  );
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, 'parity_agent', 'parity_agent', '[]', '[]', '[]', 'fake', ?)`,
    [workIds.agent, LOCAL_WORKSPACE_ID, at],
  );
  await db.run(
    `INSERT INTO deployments (id, workspace_id, agent_id, target, status, provider, model,
                              env_keys, created_at, updated_at, created_seq)
     VALUES (?, ?, ?, 'railway', 'live', 'fake', 'fake-scripted', '[]', ?, ?, 1)`,
    [workIds.deployment, LOCAL_WORKSPACE_ID, workIds.agent, at, at],
  );
  await db.run(
    `INSERT INTO work_items (id, workspace_id, agent_id, deployment_id, run_id, created_by,
                             input, status, output, error, failure_kind,
                             created_at, started_at, ended_at, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, NULL, NULL, ?, ?, ?, 7)`,
    [
      workIds.item, LOCAL_WORKSPACE_ID, workIds.agent, workIds.deployment, workIds.run, workIds.user,
      'refund order 4471 — the customer said "it never arrived"',
      "done: refunded £41.20",
      at, "2026-02-03T10:00:01.000Z", "2026-02-03T10:00:09.500Z",
    ],
  );
  return db.get<Record<string, unknown>>(
    `SELECT ${WORK_FIELDS.join(", ")} FROM work_items WHERE id = ? AND workspace_id = ?`,
    [workIds.item, LOCAL_WORKSPACE_ID],
  );
}

const tmp = mkdtempSync(join(tmpdir(), "jaroku-parity-"));
const sqlite = new SqliteDb(join(tmp, "parity.db"));
await migrate(sqlite.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
const sqliteStore = new TraceStore(sqlite);
await sqliteStore.init();

const ran = await withScratchPostgres(async (pg) => {
  const pgStore = new TraceStore(pg);
  await pgStore.init(); // a no-op on this dialect, called for symmetry

  const a = await roundTrip(sqliteStore);
  const b = await roundTrip(pgStore);

  console.log("\nrun");
  const runA = JSON.stringify(pick(a.run!, RUN_FIELDS));
  const runB = JSON.stringify(pick(b.run!, RUN_FIELDS));
  check(runA === runB, `a Run reads back identically\n       sqlite: ${runA}\n       pg:     ${runB}`);

  console.log("\nsteps");
  check(a.steps.length === steps.length && b.steps.length === steps.length, "both drivers return every step");
  for (let i = 0; i < steps.length; i++) {
    const sa = JSON.stringify(pick(a.steps[i]!, STEP_FIELDS));
    const sb = JSON.stringify(pick(b.steps[i]!, STEP_FIELDS));
    check(sa === sb, `step ${i} (${steps[i]!.type}) is the same shape on both drivers`);
    if (sa !== sb) console.log(`       sqlite: ${sa}\n       pg:     ${sb}`);
  }

  console.log("\nand the same shape as the step that went in");
  for (let i = 0; i < steps.length; i++) {
    const original = JSON.stringify(pick(steps[i]!, STEP_FIELDS));
    const back = JSON.stringify(pick(a.steps[i]!, STEP_FIELDS));
    check(original === back, `step ${i} survives the write/read round trip unchanged`);
    if (original !== back) console.log(`       in:  ${original}\n       out: ${back}`);
  }

  console.log("\nwork items");
  const workA = await workRoundTrip(sqlite);
  const workB = await workRoundTrip(pg);
  check(Boolean(workA) && Boolean(workB), "a work item is written and read back on both drivers");
  const wa = JSON.stringify(pick(workA ?? {}, WORK_FIELDS));
  const wb = JSON.stringify(pick(workB ?? {}, WORK_FIELDS));
  check(wa === wb, `a work item reads back identically\n       sqlite: ${wa}\n       pg:     ${wb}`);
  // Named separately from the equality above, because equality would also be satisfied by two
  // drivers that both got it wrong. `timestamptz` reaches JavaScript as a Date unless the pool
  // installs a parser for oid 1184, and a Date is not what anything downstream slices, compares or
  // puts on the wire.
  check(
    typeof workA?.created_at === "string" && typeof workB?.created_at === "string",
    `created_at is an ISO string on both, not a Date on one (sqlite: ${typeof workA?.created_at}, pg: ${typeof workB?.created_at})`,
  );
  check(
    typeof workA?.created_seq === "number" && typeof workB?.created_seq === "number",
    "created_seq is a number on both — the tie-break every ordered read applies",
  );
  return true;
});

await sqlite.close();
rmSync(tmp, { recursive: true, force: true });
if (ran === null) {
  console.log("SKIPPED: this suite compares two drivers, so it needs both.");
  process.exit(0);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

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

const MIGRATIONS = join(new URL("../..", import.meta.url).pathname, "migrations");

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

async function roundTrip(store: TraceStore): Promise<{ run: Run | undefined; steps: Step[] }> {
  await store.upsertRun(ctx, run);
  for (const s of steps) await store.insertStep(ctx, s);
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

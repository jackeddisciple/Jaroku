// Whose eval it is, from the moment it starts.
//
// An eval outlives the command that asked for it by minutes: its jobs run as subprocesses and
// their progress, results and cost arrive on callbacks with no context of their own. So the
// runner resolves a workspace by looking up the eval in flight — and the one moment that
// lookup cannot work is the moment there is no eval in flight yet, which is precisely when
// `start` runs.
//
// It fell back to the SERVER's workspace there, and every read and write in `start` used it:
// the dataset lookup ran in the wrong workspace and found nothing, so any workspace but the
// server's was told its own dataset was empty; had it found rows, the eval run and its jobs
// would have been written into the server's workspace as well. A single-workspace install —
// which is every local one, and every test before this — cannot tell the two apart.
//
//   npm run test:retry

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "./db/testDb.ts";
import { LOCAL_WORKSPACE_ID, newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { TraceStore } from "./store.ts";
import { EvalStore } from "./evalStore.ts";
import { EvalRunner } from "./evalRunner.ts";
import type { RunPool } from "./runPool.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const identity = new IdentityRepository(db);

const SERVER: TenantContext = systemContextFor(LOCAL_WORKSPACE_ID, newRequestId());
const workspace = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
  name: `evals ${randomUUID().slice(0, 6)}`,
});
const B: TenantContext = systemContextFor(workspace.id, newRequestId());

const dataset = await evalStore.createDataset(B, "agent_x", "a set of B's own");
await evalStore.addExample(B, dataset.id, "hello", null, null);

// A pool that never starts anything: what is under test is the bookkeeping `start` does
// before the first job, and a real pool would spawn Python for it.
const idlePool = {
  tryStart: () => false,
  stop: () => {},
  freeSlots: 0,
  busy: false,
  on: () => {},
} as unknown as RunPool;

// Wired exactly as index.ts wires it — including the fallback, which is the whole point.
const evalWorkspaces = new Map<string, TenantContext>();
const contextForEval = (evalId: string): TenantContext => evalWorkspaces.get(evalId) ?? SERVER;
let runner: EvalRunner;
const boundDuringStart: string[] = [];
runner = new EvalRunner({
  pool: idlePool,
  store,
  dispatcher: new Dispatcher(new InMemoryQueueBackend()),
  evalStore,
  runtimeDir: ".",
  context: () => contextForEval(runner.activeEvalIds()[0] ?? ""),
  bindWorkspace: (evalId, ctx) => {
    evalWorkspaces.set(evalId, ctx);
    boundDuringStart.push(evalId);
  },
  markEvalRun: () => {},
  onStarted: (e) => {
    // By the time anything is announced the workspace must already be known, or the
    // announcement itself goes to the wrong one.
    check(
      "the eval's workspace is known before it is announced",
      contextForEval(e.evalId).workspaceId === B.workspaceId,
      contextForEval(e.evalId).workspaceId,
    );
  },
  onProgress: () => {},
  onFinished: () => {},
});

console.log("\nstarting an eval in a workspace that is not the server's");
const started = await runner.start({
  ctx: B,
  datasetId: dataset.id,
  agentId: "agent_x",
  rubricId: "",
  targets: [{ provider: "fake", model: "fake" }],
  budgetUsd: null,
});
check("the dataset is found — it is read in the asking workspace", !("error" in started), "error" in started ? started.error : "");

if (!("error" in started)) {
  check("the workspace was bound during start, not after it", boundDuringStart.includes(started.evalId));
  check("the eval run belongs to the workspace that asked", (await evalStore.getEvalRun(B, started.evalId)) !== undefined);
  check("...and not to the server's", (await evalStore.getEvalRun(SERVER, started.evalId)) === undefined);
  const jobs = await evalStore.jobsForEval(B, started.evalId);
  check(`...and so do its jobs (${jobs.length})`, jobs.length === 1);
  check("...which the server cannot see either", (await evalStore.jobsForEval(SERVER, started.evalId)).length === 0);
}

// Let the pump settle before the connection goes away.
await new Promise((r) => setTimeout(r, 300));
await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

// The worker process — Session 5's second entrypoint. index.ts owns the sockets and a
// gateway's own interactive pool; this owns nothing a browser ever talks to directly. It
// exists to drain the classes doc queue/jobs.ts marks `queued: true`, each in its own
// RunPool, so an eval fan-out competes with other WORKERS for capacity instead of with the
// interactive run sitting in the same process as its socket.
//
// Run:  npm run worker        (in server/, with JAROKU_REDIS_URL set)
//
// UNLIKE index.ts, this refuses to start without Redis. The in-memory QueueBackend is a
// legitimate default for a single-process deployment or a test, but a worker's entire reason
// to exist is being a SEPARATE process from the gateway — an in-memory queue only that one
// process could ever see, which makes a "worker" indistinguishable from doing nothing.
//
// NO HANDLERS ARE REGISTERED HERE, and that stays true for this whole session — not a gap
// waiting on a later commit. run.eval and judge ended up drained IN-PROCESS by evalRunner.ts
// itself (drainAvailable()/executeAdmitted(), running inside index.ts's gateway process),
// not through this file's generic WorkerLoop — see evalRunner.ts's own header for why: moving
// EXECUTION to a genuinely separate process turned out to need replicating index.ts's entire
// trace-ingestion and debug-control surface (pause/resume, MCP confirmation) in a second
// process, which is real work this session scoped out rather than half-building. What this
// file delivers instead is the machinery a true standalone worker needs once that surface is
// exported — boot sequence, Redis-required admit loop, graceful shutdown — proven correct by
// queue/workerLoop.test.ts and queue/chaos.test.ts against a generic handler, with nothing
// yet plugged into JAROKU_WORKER_CLASSES because there is nothing here that needs its own OS
// process today. A worker asked to drain a class nobody has wired a handler for still refuses
// outright at construction, not a silent no-op — that discipline is real regardless.

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RunPool } from "./runPool.ts";
import { TraceStore } from "./store.ts";
import { migrate } from "./db/migrate.ts";
import { openDb } from "./db/open.ts";
import { EvalStore } from "./evalStore.ts";
import { openObjectStore } from "./storage/open.ts";
import { resolveSigningKey } from "./storage/presign.ts";
import { sandboxKind } from "./sandbox/runSandbox.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { resolveRunTokenSigningKey, RunTokenRevocationList } from "./sandbox/runTokens.ts";
import { sandboxImageRef } from "./sandbox/image.ts";
import { FlyMachinesSandbox } from "./sandbox/flySandbox.ts";
import { loadRuntimeEnv } from "./env.ts";
import { installLogRedaction, protectEnv } from "./obs/log.ts";
import { REDIS_URL_ENV, openRedis, pingRedis, redisUrlFromEnv } from "./queue/redis.ts";
import { RedisQueueBackend } from "./queue/redisBackend.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { isJobClass, type JobClass } from "./queue/jobs.ts";
import { WorkerLoop, type JobHandler } from "./queue/workerLoop.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SERVER_DIR, "..");
const RUNTIME_DIR = join(REPO_DIR, "runtime");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");
const WORKER_ID = process.env.JAROKU_WORKER_ID ?? `worker-${process.pid}`;

// THE FILTER OVER EVERY LOG SINK, BEFORE ANYTHING IS LOGGED. The same three lines index.ts opens
// with, and their absence here was not a smaller version of the same gap — it was the whole of
// it, in this process. `installLogRedaction` replaces `console` for the process that calls it,
// and nothing in a second entrypoint inherits the first one's.
//
// The first line this file used to print was the leak. `[worker …] redis: <url>` writes the
// connection string verbatim, and a hosted Redis URL is `rediss://user:password@host` — a
// credential, on a boot line, on the happy path, with no error involved. The filter's
// url-credentials rule has always caught it; nothing here was running the filter.
//
// obs/log.ts's header says the guarantee has to hold "for code that has not been written yet".
// A second entrypoint is that case exactly: this one has no job handlers wired to it today, so
// the day it gets one is the day it starts logging around provider keys, and the filter has to
// predate that rather than be remembered alongside it.
installLogRedaction();

const url = redisUrlFromEnv();
if (!url) {
  throw new Error(
    `A worker process needs ${REDIS_URL_ENV} — it exists to be a SEPARATE process from the ` +
      `gateway, and the in-memory queue backend is only ever visible to the process that made ` +
      `it. \`docker compose up -d redis\` starts one locally.`,
  );
}
const redisClient = openRedis({ url });
if (!(await pingRedis(redisClient))) {
  throw new Error(`${REDIS_URL_ENV} is set to ${url} but nothing answered PING there.`);
}
console.log(`[worker ${WORKER_ID}] redis: ${url}`);

const loadedKeys = loadRuntimeEnv(join(RUNTIME_DIR, ".env"));
// AND THE VALUES REGISTERED, which is the half that makes a leak impossible rather than
// unlikely. Shapes catch a key that looks like one; a registered value is matched literally, so
// a provider quoting the key it just rejected is caught whatever it looks like. This process
// loads the same file index.ts does and was registering none of it.
protectEnv(process.env, loadedKeys);
if (loadedKeys.length) {
  console.log(`[worker ${WORKER_ID}] loaded ${loadedKeys.length} var(s) from runtime/.env`);
}

const db = openDb({ sqlitePath: DB_PATH });
await migrate(db.migrationTarget(), join(SERVER_DIR, "migrations", db.dialect));
console.log(`[worker ${WORKER_ID}] database: ${db.dialect}${db.dialect === "sqlite" ? ` (${DB_PATH})` : ""}`);

const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();

rmSync(join(RUNTIME_DIR, "agents", ".staging"), { recursive: true, force: true });
const OBJECT_SIGNING_KEY_PATH = process.env.JAROKU_OBJECT_KEY_PATH ?? join(SERVER_DIR, ".objectkey");
const objects = openObjectStore({ runtimeDir: RUNTIME_DIR, signingKeyPath: OBJECT_SIGNING_KEY_PATH });
console.log(`[worker ${WORKER_ID}] object store: ${objects.kind}`);

// A worker's own pool, own event bus, own run-token key — deliberately not shared with the
// gateway's. Two processes minting tokens off the same signing key is fine (the key only has
// to verify, not be unique to a process); what matters is neither one has to reach into the
// other's memory to do its job, which is the whole point of the split.
const RUN_TOKEN_KEY_PATH = process.env.JAROKU_RUN_TOKEN_KEY_PATH ?? join(SERVER_DIR, ".runtokenkey");
const runTokenSigningKey = resolveRunTokenSigningKey(RUN_TOKEN_KEY_PATH);
const runEventBus = new RunEventBus();
const runTokenRevocations = new RunTokenRevocationList();
setInterval(() => runTokenRevocations.sweep(), 10 * 60_000).unref();

const CONTROL_PLANE_URL = process.env.JAROKU_CONTROL_PLANE_URL;
const RUN_SANDBOX_KIND = sandboxKind();
const FLY_APP = process.env.JAROKU_FLY_APP;
if (RUN_SANDBOX_KIND === "fly" && !CONTROL_PLANE_URL) {
  throw new Error("JAROKU_RUN_SANDBOX=fly needs JAROKU_CONTROL_PLANE_URL.");
}
if (RUN_SANDBOX_KIND === "fly" && !FLY_APP) {
  throw new Error("JAROKU_RUN_SANDBOX=fly needs JAROKU_FLY_APP.");
}
console.log(`[worker ${WORKER_ID}] run sandbox: ${RUN_SANDBOX_KIND}`);

const WORKER_CONCURRENCY = Math.max(1, Number(process.env.JAROKU_WORKER_CONCURRENCY ?? 4));
const pool = new RunPool(WORKER_CONCURRENCY, {
  controlPlaneUrl: CONTROL_PLANE_URL,
  bus: runEventBus,
  signingKey: runTokenSigningKey,
  revocations: runTokenRevocations,
  sandbox:
    RUN_SANDBOX_KIND === "fly"
      ? () => new FlyMachinesSandbox({ app: FLY_APP!, bus: runEventBus, image: sandboxImageRef() })
      : undefined,
});

const dispatcher = new Dispatcher(new RedisQueueBackend(redisClient));

const requestedClasses = (process.env.JAROKU_WORKER_CLASSES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
for (const c of requestedClasses) {
  if (!isJobClass(c)) throw new Error(`JAROKU_WORKER_CLASSES names an unknown job class: "${c}"`);
}
const classes = requestedClasses as JobClass[];

// Populated by commit 7 — see the file header. An empty registry plus an empty `classes`
// list is a worker that boots, connects, and idles, which is exactly what "the producer
// doesn't exist yet" should look like.
const handlers: Partial<Record<JobClass, JobHandler>> = {};

if (classes.length === 0) {
  console.log(
    `[worker ${WORKER_ID}] no JAROKU_WORKER_CLASSES configured — idling. ` +
      `(No class has a handler registered yet; see queue/workerLoop.ts.)`,
  );
} else {
  console.log(`[worker ${WORKER_ID}] draining: ${classes.join(", ")}`);
}

const loop = new WorkerLoop({
  dispatcher,
  classes,
  handlers,
  onAdmit: (jobClass, job) => console.log(`[worker ${WORKER_ID}] admitted ${jobClass} job ${job.id.slice(0, 8)}`),
  onHandlerError: (jobClass, job, error) =>
    console.error(`[worker ${WORKER_ID}] ${jobClass} job ${job.id.slice(0, 8)} threw:`, error),
  onReaped: (jobClass, jobs) =>
    jobs.length && console.log(`[worker ${WORKER_ID}] reclaimed ${jobs.length} orphaned ${jobClass} lease(s)`),
});

const runPromise = loop.run();

const DRAIN_WINDOW_MS = Number(process.env.JAROKU_WORKER_DRAIN_MS ?? 30_000);
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[worker ${WORKER_ID}] ${signal} — draining up to ${loop.activeCount} in-flight job(s)…`);
  void loop
    .shutdown(DRAIN_WINDOW_MS)
    .then(({ stillRunning }) => {
      if (stillRunning > 0) {
        console.log(`[worker ${WORKER_ID}] drain window closed with ${stillRunning} still running`);
      }
      pool.stopAll();
      return store.close();
    })
    .finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await runPromise;

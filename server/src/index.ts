// Wires the pipeline: RunPool (Python agents) -> TraceStore (SQLite) -> WsRelay (browser).
//
//   uv-spawned agent  --stdout JSON-->  RunPool slot  --event-->  { persist + broadcast }
//
// The pool reserves slot 0 for the interactive run — the one the user drives, and the only
// one pause/resume/branch address — and lends the rest to the eval fan-out.
//
// Run:  npm run dev        (in server/)
// Then open http://localhost:4317 to watch traces live.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RunPool } from "./runPool.ts";
import { TraceStore } from "./store.ts";
import { EvalStore, type Rubric, type RubricCriterion } from "./evalStore.ts";
import { EvalRunner } from "./evalRunner.ts";
import { DEFAULT_CRITERIA } from "./judge/rubric.ts";
import { JudgeScorer } from "./judge/score.ts";
import { aggregateEval } from "./evalAggregate.ts";
import { estimateEval } from "./evalEstimate.ts";
import { fmtBytes, sweepEvalArtifacts, sweepOrphanedEvalArtifacts } from "./evalCleanup.ts";
import { WsRelay, type ForwardedCommand, type GenerateCommand } from "./wsRelay.ts";
import { Generator } from "./generator.ts";
import { Editor, editCount } from "./editor.ts";
import { listAgents } from "./agents.ts";
import { loadConnectors } from "./connectors.ts";
import { isSafeAgentId, listProjectFiles } from "./projectFs.ts";
import { introspectGraph, type GraphResult } from "./graphIntrospect.ts";
import { streamExplain } from "./explainer.ts";
import type { ExplainCommand } from "./wsRelay.ts";
import { loadRuntimeEnv } from "./env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SERVER_DIR, "..");
const RUNTIME_DIR = join(REPO_DIR, "runtime");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");
const PORT = Number(process.env.JAROKU_PORT ?? 4317);

// Provider + generation keys live in runtime/.env. Names only are logged, never values.
const loadedKeys = loadRuntimeEnv(join(RUNTIME_DIR, ".env"));
if (loadedKeys.length) {
  console.log(`[server] loaded ${loadedKeys.length} var(s) from runtime/.env: ${loadedKeys.sort().join(", ")}`);
}

// Stale staging (a proposal or generation interrupted by a previous shutdown) must not
// survive a restart — pending proposals are in-memory, so their staging dirs are orphans.
rmSync(join(RUNTIME_DIR, "agents", ".staging"), { recursive: true, force: true });

const store = new TraceStore(DB_PATH);
// Eval's control-plane tables live in the same database file, on the same connection
// (single writer; aggregation JOINs eval_jobs against the frozen `steps` table). Nothing
// here touches schema/events.md — an eval is a batch of ordinary runs.
const evalStore = new EvalStore(store.connection());
// Slot 0 is the interactive run; the rest are the eval fan-out's. Modest by default —
// each slot is a Python subprocess with a LangGraph import, and oversubscribing the machine
// inflates every run's latency, which the comparison dashboard then reports as if it were
// the provider's.
const EVAL_CONCURRENCY = Math.max(1, Number(process.env.JAROKU_EVAL_CONCURRENCY ?? 4));
const pool = new RunPool(EVAL_CONCURRENCY);
const generator = new Generator();

// Run ids belonging to an in-flight eval job. Their events persist normally but are kept
// OFF the "trace" channel, so a fan-out can't steal the timeline's focus (traceStore
// focuses activeRunId on every run_start). Populated by the orchestrator.
const evalRunIds = new Set<string>();
const isEvalRun = (runId: string): boolean => evalRunIds.has(runId);

// The orchestrator. Constructed after the relay exists (it broadcasts progress), so it's
// declared here and assigned below.
let evalRunner: EvalRunner;

// The shared built-in rubric every dataset falls back to until it customizes one. Seeded
// from DEFAULT_CRITERIA but stored as ordinary data — the doc calls for an EDITABLE rubric,
// and "correct" for a refund bot is not "correct" for a SQL agent.
const DEFAULT_RUBRIC_ID = "rubric-default";

/** The rubric a dataset scores against: its own if customized, else the built-in default. */
function defaultRubric(): Rubric {
  const shared = evalStore.getRubric(DEFAULT_RUBRIC_ID);
  if (shared) return shared;
  return evalStore.putRubric({
    id: DEFAULT_RUBRIC_ID,
    dataset_id: null,
    name: "Default",
    criteria: DEFAULT_CRITERIA,
  });
}
function rubricFor(datasetId: string): Rubric {
  return evalStore.rubricForDataset(datasetId) ?? defaultRubric();
}
const rubricIdFor = (datasetId: string): string => rubricFor(datasetId).id;

// An eval left 'running' by a shutdown has no orchestrator behind it any more. Mark those
// interrupted at startup rather than leaving rows that claim to be in flight forever —
// the jobs and whatever they spent stay on record and remain inspectable.
for (const stale of evalStore.unfinishedEvalRuns()) {
  const cancelled = evalStore.cancelQueuedJobs(stale.id, "server restarted before this job ran");
  evalStore.setEvalStatus(stale.id, "cancelled", "interrupted by a server restart");
  console.log(`[eval] ${stale.id} was interrupted by a restart — ${cancelled} queued job(s) cancelled`);
}

// Catch checkpoint blobs from evals whose per-eval sweep never ran (a crash, a restart).
// Only runs belonging to FINISHED eval jobs are touched — an interactive run's checkpoint
// is exactly the thing a user might come back to branch from, and is never swept.
{
  const swept = sweepOrphanedEvalArtifacts(evalStore, join(RUNTIME_DIR, ".checkpoints"));
  if (swept.removed) {
    console.log(
      `[eval] swept ${swept.removed} orphaned checkpoint artifact(s) from earlier evals, ${fmtBytes(swept.bytesFreed)} freed`,
    );
  }
}

// True from spawn until run_end (or exit) of the INTERACTIVE run. Deliberately NOT
// pool.interactiveRunning: the process outlives its run_end by a beat while it tears down,
// and refusing an apply/undo in that window is a race the user would hit by clicking right
// after a run finishes. Once run_end is emitted the graph is done and the project files are
// no longer being read.
let runActive = false;

// Debug depth (Week 6). The server mints each run's id up front so it can address a live run
// (e.g. to pause it) before run_start races back. `activeRunId` is the current subprocess's run;
// `pausedRunId` remembers a run that halted at a boundary so exit-handling leaves it 'paused'
// rather than clobbering the status. Both are control-plane only.
let activeRunId: string | null = null;
let pausedRunId: string | null = null;

const CHECKPOINT_DIR = join(RUNTIME_DIR, ".checkpoints");
const controlFile = (runId: string): string => join(CHECKPOINT_DIR, `${runId}.control`);
/** Ask the runner to pause: it reads this file at its next node boundary. */
function requestPause(runId: string): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(controlFile(runId), "pause");
}
/** Clear any stale pause request (before a fresh run of, or a resume of, this run id). */
function clearControl(runId: string): void {
  rmSync(controlFile(runId), { force: true });
}

const editor = new Editor({
  runtimeDir: RUNTIME_DIR,
  // Pool-aware, not just interactive-aware: an eval job is reading the agent's files from
  // a subprocess right now, and rewriting them mid-flight would make the trace describe
  // code that never ran. `pool.busy` covers every slot.
  canMutate: () =>
    runActive || pool.busy ? "cannot modify the agent while a run is in progress" : null,
});

/** Current on-disk files of an agent project, connector files flagged read-only. */
function agentProjectFiles(agentId: string): unknown[] {
  if (!isSafeAgentId(agentId)) return [];
  const dir = join(RUNTIME_DIR, "agents", agentId);
  if (!existsSync(dir)) return [];
  let connectors: string[] = [];
  try {
    const meta = JSON.parse(readFileSync(join(dir, "jaroku.json"), "utf8")) as { connectors?: string[] };
    connectors = meta.connectors ?? [];
  } catch {
    /* metadata optional */
  }
  const files = loadConnectors(RUNTIME_DIR)
    .filter((c) => connectors.includes(c.id))
    .map((c) => `tools/${c.file}`);
  return listProjectFiles(dir, files);
}

// Graph topology is derived by spawning the isolated `jaroku_runner.graph` entrypoint. It is
// pure w.r.t. an agent's on-disk code, so it's cached per agent and invalidated on apply/undo.
const graphCache = new Map<string, Promise<GraphResult>>();
function agentGraph(agentId: string): Promise<GraphResult> {
  if (!isSafeAgentId(agentId)) return Promise.resolve({ agent_id: agentId, error: "invalid agent id" });
  let pending = graphCache.get(agentId);
  if (!pending) {
    pending = introspectGraph(RUNTIME_DIR, agentId);
    // Don't cache a failure — let a later request retry (e.g. after a transient import error).
    pending.then((r) => { if (r.error) graphCache.delete(agentId); });
    graphCache.set(agentId, pending);
  }
  return pending;
}

const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: join(SERVER_DIR, "debug-client.html"),
  listAgents: () =>
    listAgents(RUNTIME_DIR).map((a) => ({
      ...a,
      edit_count: editCount(RUNTIME_DIR, a.agent_id),
    })),
  listAgentFiles: agentProjectFiles,
  getAgentGraph: agentGraph,
  onCommand: (cmd: ForwardedCommand) => {
    if (cmd.cmd === "run") runAgent(cmd.input, cmd.provider, cmd.model, cmd.agentId);
    else if (cmd.cmd === "generate") generateAgent(cmd);
    else if (cmd.cmd === "edit") editAgent(cmd.agentId, cmd.instruction);
    else if (cmd.cmd === "applyEdit") editor.apply(cmd.proposalId);
    else if (cmd.cmd === "undoEdit") editor.undo(cmd.agentId);
    else if (cmd.cmd === "discardEdit") editor.discard(cmd.proposalId);
    else if (cmd.cmd === "pauseRun") pauseRun(cmd.runId);
    else if (cmd.cmd === "resumeRun") resumeRun(cmd.runId);
    else if (cmd.cmd === "branchRun") branchRun(cmd.fromRunId, cmd.atSeq, cmd.editNode, cmd.editedState);
    else if (cmd.cmd === "explain") explainAgent(cmd);
    else handleEvalCommand(cmd);
  },
});

// The orchestrator: expands (examples × providers) into persisted jobs and drains them
// through the pool under per-provider caps. Every job runs the ordinary path — there is no
// second way to execute an agent.
// The judge. Scoring is a SEPARATE phase from execution: a job is scored once its run is
// already terminal and recorded, so a broken judge costs the quality column and nothing
// else. Its cost accrues to the eval, never to a provider.
const judge = new JudgeScorer({
  store,
  evalStore,
  onScored: (e) => relay.broadcastEval({ type: "scored", ...e }),
  onScoringFinished: (e) => {
    console.log(`[eval] ${e.evalId} scoring done — ${e.scored} scored, ${e.unscored} unscored`);
    relay.broadcastEval({ type: "scoringFinished", ...e });
  },
});

evalRunner = new EvalRunner({
  pool,
  store,
  evalStore,
  runtimeDir: RUNTIME_DIR,
  // An eval job's run persists like any other but stays off the live "trace" channel.
  markEvalRun: (runId, isEval) => {
    if (isEval) evalRunIds.add(runId);
    else evalRunIds.delete(runId);
  },
  onStarted: (e) => relay.broadcastEval({ type: "evalStarted", ...e }),
  onProgress: (p) => relay.broadcastEval({ type: "evalProgress", ...p }),
  // Score as results land rather than in a batch at the end, so the quality column fills in
  // alongside the rest of the row instead of appearing all at once minutes later.
  onJobFinished: (job) => judge.enqueue(job.eval_id, job),
  onFinished: (e) => {
    relay.broadcastEval({ type: "evalFinished", ...e });
    // The eval's runs are now in history like any other; refresh so drill-down can reach
    // them without a reconnect.
    relay.broadcastHistory();
    // No more jobs are coming: the judge reports done once its own queue drains.
    judge.seal(e.evalId);
    // Sweep the resumable-checkpoint blobs these runs left behind. The traces stay —
    // only the pause/resume machinery goes, and nobody resumes a finished eval job.
    const swept = sweepEvalArtifacts(evalStore, CHECKPOINT_DIR, e.evalId);
    if (swept.removed) {
      console.log(
        `[eval] ${e.evalId} swept ${swept.removed} checkpoint artifact(s), ${fmtBytes(swept.bytesFreed)} freed` +
          (swept.failed ? ` (${swept.failed} could not be removed)` : ""),
      );
    }
  },
});

// --- eval: dataset CRUD -----------------------------------------------------
// Control-plane only. Every mutation answers by re-broadcasting the affected snapshot on
// the "eval" channel, the same shape a fresh `listDatasets` would return — so a client
// never has to reconcile a partial update against local state.

function broadcastDatasets(agentId: string | null): void {
  relay.broadcastEval({
    type: "datasets",
    agentId,
    datasets: evalStore.listDatasets(agentId ?? undefined),
  });
}

function broadcastDataset(datasetId: string): void {
  relay.broadcastEval({ type: "dataset", datasetId, examples: evalStore.listExamples(datasetId) });
}

function handleEvalCommand(cmd: ForwardedCommand): void {
  try {
    switch (cmd.cmd) {
      case "listDatasets":
        broadcastDatasets(cmd.agentId ?? null);
        return;
      case "loadDataset":
        broadcastDataset(cmd.datasetId);
        return;
      case "createDataset": {
        const ds = evalStore.createDataset(cmd.agentId, cmd.name);
        console.log(`[eval] dataset "${ds.name}" created for ${cmd.agentId}`);
        broadcastDatasets(cmd.agentId);
        broadcastDataset(ds.id);
        return;
      }
      case "renameDataset": {
        evalStore.renameDataset(cmd.datasetId, cmd.name);
        broadcastDatasets(evalStore.getDataset(cmd.datasetId)?.agent_id ?? null);
        return;
      }
      case "deleteDataset": {
        evalStore.deleteDataset(cmd.datasetId);
        relay.broadcastEval({ type: "datasetDeleted", datasetId: cmd.datasetId });
        broadcastDatasets(cmd.agentId);
        return;
      }
      case "addExample": {
        // An empty input would be a run with nothing to do — reject it here rather than
        // let it become a job that burns a real API call on whitespace.
        const input = (cmd.input ?? "").trim();
        if (!input) {
          relay.broadcastEval({ type: "error", datasetId: cmd.datasetId, message: "an example needs an input" });
          return;
        }
        evalStore.addExample(cmd.datasetId, input, cmd.expected ?? null, cmd.notes ?? null);
        broadcastDataset(cmd.datasetId);
        broadcastDatasets(evalStore.getDataset(cmd.datasetId)?.agent_id ?? null);
        return;
      }
      case "updateExample": {
        evalStore.updateExample(cmd.exampleId, {
          ...(cmd.input !== undefined ? { input: cmd.input } : {}),
          ...(cmd.expected !== undefined ? { expected: cmd.expected } : {}),
          ...(cmd.notes !== undefined ? { notes: cmd.notes } : {}),
        });
        broadcastDataset(cmd.datasetId);
        return;
      }
      case "deleteExample": {
        evalStore.deleteExample(cmd.exampleId);
        broadcastDataset(cmd.datasetId);
        broadcastDatasets(evalStore.getDataset(cmd.datasetId)?.agent_id ?? null);
        return;
      }
      case "startEval": {
        // One eval at a time. Two concurrent fan-outs would contend for the same pool
        // slots and each would report latency inflated by the other — a comparison the
        // numbers can't support.
        if (evalRunner.active) {
          relay.broadcastEval({ type: "error", message: "an eval is already running" });
          return;
        }
        const started = evalRunner.start({
          datasetId: cmd.datasetId,
          agentId: cmd.agentId,
          rubricId: rubricIdFor(cmd.datasetId),
          targets: cmd.targets ?? [],
          budgetUsd: cmd.budgetUsd ?? null,
        });
        if ("error" in started) relay.broadcastEval({ type: "error", message: started.error });
        return;
      }
      case "cancelEval": {
        evalRunner.cancel(cmd.evalId);
        return;
      }
      case "estimateEval": {
        relay.broadcastEval({
          type: "estimate",
          estimate: estimateEval(store, evalStore, {
            datasetId: cmd.datasetId,
            agentId: cmd.agentId,
            targets: cmd.targets ?? [],
            judgeEnabled: JudgeScorer.available(),
          }),
        });
        return;
      }
      case "loadEvalResults": {
        const results = aggregateEval(evalStore, cmd.evalId);
        if (!results) {
          relay.broadcastEval({ type: "error", message: "unknown eval" });
          return;
        }
        relay.broadcastEval({ type: "evalResults", evalId: cmd.evalId, results });
        return;
      }
      case "listEvals": {
        const all = evalStore.listEvalRuns();
        relay.broadcastEval({
          type: "evals",
          evals: cmd.datasetId ? all.filter((e) => e.dataset_id === cmd.datasetId) : all,
        });
        return;
      }
      case "loadRubric": {
        const r = rubricFor(cmd.datasetId);
        relay.broadcastEval({
          type: "rubric", datasetId: cmd.datasetId, rubric: r, isDefault: r.dataset_id === null,
        });
        return;
      }
      case "saveRubric": {
        // Validated here rather than trusted: a rubric with no criteria, or with all-zero
        // weights, produces scores that look real and mean nothing.
        const criteria = (cmd.criteria ?? []).filter(
          (c): c is RubricCriterion =>
            typeof c?.id === "string" && c.id.trim() !== "" && typeof c.description === "string",
        );
        if (!criteria.length) {
          relay.broadcastEval({ type: "error", message: "a rubric needs at least one criterion" });
          return;
        }
        if (!criteria.some((c) => c.weight > 0)) {
          relay.broadcastEval({ type: "error", message: "a rubric needs at least one criterion with weight above zero" });
          return;
        }
        const existing = evalStore.rubricForDataset(cmd.datasetId);
        const saved = evalStore.putRubric({
          id: existing?.id,
          dataset_id: cmd.datasetId, // dataset-scoped: never overwrites the shared default
          name: cmd.name ?? existing?.name ?? "Custom",
          criteria,
        });
        console.log(`[eval] rubric saved for dataset ${cmd.datasetId} — ${criteria.length} criteria`);
        relay.broadcastEval({ type: "rubric", datasetId: cmd.datasetId, rubric: saved, isDefault: false });
        return;
      }
      case "promoteTestInput": {
        const input = (cmd.input ?? "").trim();
        if (!input) {
          relay.broadcastEval({ type: "error", message: "nothing to promote — the test input is empty" });
          return;
        }
        const ds = evalStore.defaultDatasetFor(cmd.agentId, cmd.agentName);
        // Adding the same input twice silently doubles what an eval over this dataset
        // costs, for zero extra signal. Report it instead.
        const duplicate = evalStore.hasExampleWithInput(ds.id, input);
        if (!duplicate) evalStore.addExample(ds.id, input, cmd.expected ?? null, null);
        console.log(
          `[eval] promote → "${ds.name}"${duplicate ? " (already present)" : ""}: ${input.slice(0, 60)}`,
        );
        relay.broadcastEval({ type: "promoted", datasetId: ds.id, datasetName: ds.name, duplicate });
        broadcastDatasets(cmd.agentId);
        broadcastDataset(ds.id);
        return;
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[eval] ${cmd.cmd} failed:`, message);
    relay.broadcastEval({ type: "error", message: `${cmd.cmd} failed: ${message}` });
  }
}

// --- pipeline ---------------------------------------------------------------
// Every run in the pool — interactive or eval job — persists identically. Persisting is
// unconditional and un-special-cased on purpose: an eval job IS an ordinary run, and its
// trace has to be as complete and as inspectable as one the user triggered by hand.
//
// What differs is only the LIVE broadcast. An eval job's events are not put on the "trace"
// channel, because traceStore.applyEvent focuses activeRunId on every run_start and a
// fan-out would yank the timeline away from whatever the user is reading. Drill-down loads
// those runs on demand through the existing loadRun path.
pool.on("event", ({ runId, event }) => {
  if (runId === activeRunId && event.kind === "run_end") runActive = false;
  // Persist first (source of truth), then broadcast to live clients.
  try {
    if (event.kind === "run_start" || event.kind === "run_end") {
      store.upsertRun(event.run);
    } else if (event.kind === "step") {
      store.insertStep(event.step);
    }
  } catch (err) {
    console.error("[store] failed to persist event:", (err as Error).message);
  }
  if (!isEvalRun(runId)) relay.broadcast(event);
});

pool.on("parseError", ({ runId, line, error }) => {
  console.error(`[manager] non-event stdout line (${error}):`, line.slice(0, 200));
  if (!isEvalRun(runId)) relay.broadcastLog("parseError", `${error}: ${line.slice(0, 200)}`);
});

pool.on("stderr", ({ runId, line }) => {
  console.error("[agent]", line);
  if (!isEvalRun(runId)) relay.broadcastLog("stderr", line);
});

// Debug-depth control events (off the trace stream). A `boundary` correlates the durable
// checkpoint to the steps it covers (for later branching); a `paused` flips the run to the
// store-only 'paused' status so history shows it as resumable, without any run_end.
pool.on("control", ({ ctrl }) => {
  const runId = typeof ctrl.run_id === "string" ? ctrl.run_id : null;
  if (!runId) return;
  const seqHigh = typeof ctrl.seq_high === "number" ? ctrl.seq_high : -1;
  const checkpointId = typeof ctrl.checkpoint_id === "string" ? ctrl.checkpoint_id : null;
  const next = Array.isArray(ctrl.next) ? (ctrl.next as string[]) : [];
  try {
    if (ctrl.ctrl === "boundary") {
      if (checkpointId && seqHigh >= 0) store.setCheckpointUpto(runId, seqHigh, checkpointId);
      relay.broadcastDebug({ type: "boundary", runId, seq: seqHigh, next });
    } else if (ctrl.ctrl === "paused") {
      pausedRunId = runId;
      store.setRunStatus(runId, "paused");
      relay.broadcastDebug({ type: "paused", runId, seq: seqHigh });
    }
  } catch (err) {
    console.error("[debug] control handling failed:", (err as Error).message);
  }
});

pool.on("spawnError", ({ runId, error }) => {
  if (runId === activeRunId) {
    runActive = false;
    activeRunId = null;
  }
  console.error(`[manager] spawn error (run ${runId}):`, error.message);
});

pool.on("exit", ({ runId, code, signal, timedOut }) => {
  // Only the interactive run owns the interactive flags; an eval job finishing must not
  // clear them out from under a run the user is driving.
  if (runId === activeRunId) {
    runActive = false; // covers a crash before run_end ever arrived
    // A run that halted at a boundary keeps its 'paused' status (set from the control
    // event); a normal completion already updated the run via run_end. Either way this
    // subprocess is gone.
    activeRunId = null;
  }
  console.log(
    `[manager] agent exited (run=${runId} code=${code} signal=${signal}${timedOut ? " TIMED OUT" : ""})`,
  );
});

// --- generation -------------------------------------------------------------
// Streams into the "gen" channel. Nothing here touches the trace store or the frozen
// event schema; a generation and a run are independent concerns that share only a socket.
let generating = false;

function generateAgent(cmd: GenerateCommand): void {
  if (generating) {
    relay.broadcastGen({ type: "error", message: "a generation is already in progress" });
    return;
  }
  generating = true;
  console.log(`[gen] generating — "${cmd.prompt.slice(0, 80)}"`);
  relay.broadcastGen({ type: "started", prompt: cmd.prompt });

  const onStart = (e: { path: string }) => relay.broadcastGen({ type: "file_start", ...e });
  const onDelta = (e: { path: string; text: string }) => relay.broadcastGen({ type: "file_delta", ...e });
  const onEnd = (e: { path: string }) => relay.broadcastGen({ type: "file_end", ...e });

  const cleanup = () => {
    generating = false;
    generator.off("file_start", onStart);
    generator.off("file_delta", onDelta);
    generator.off("file_end", onEnd);
    generator.off("done", onDone);
    generator.off("error", onError);
  };

  const onDone = (e: { agentId: string; name: string; files: string[]; usage: unknown }) => {
    const usage = e.usage as { cost_usd?: number; output_tokens?: number };
    console.log(
      `[gen] ${e.agentId} ready — ${e.files.length} file(s), ` +
        `${usage?.output_tokens ?? 0} output tokens, $${(usage?.cost_usd ?? 0).toFixed(5)}`,
    );
    relay.broadcastGen({ type: "done", ...e });
    relay.broadcastAgents();
    cleanup();
  };

  const onError = (e: { message: string; problems?: string[] }) => {
    console.error(`[gen] failed: ${e.message}`);
    for (const p of e.problems ?? []) console.error(`  - ${p}`);
    relay.broadcastGen({ type: "error", ...e });
    cleanup();
  };

  generator.on("file_start", onStart);
  generator.on("file_delta", onDelta);
  generator.on("file_end", onEnd);
  generator.once("done", onDone);
  generator.once("error", onError);

  void generator.generate({
    runtimeDir: RUNTIME_DIR,
    prompt: cmd.prompt,
    connectors: cmd.connectors,
    name: cmd.name,
  });
}

// --- editing (fix loop) -----------------------------------------------------
// Streams into the "edit" channel. Like generation, nothing here touches the trace store
// or the frozen event schema. Listeners are permanent — every event carries its ids.
editor.on("file_start", (e) => relay.broadcastEdit({ type: "file_start", ...e }));
editor.on("file_delta", (e) => relay.broadcastEdit({ type: "file_delta", ...e }));
editor.on("file_end", (e) => relay.broadcastEdit({ type: "file_end", ...e }));

editor.on("proposal", (e) => {
  console.log(
    `[edit] proposal for ${e.agentId} — ${e.files.length} file(s): ${e.summary}`,
  );
  relay.broadcastEdit({ type: "proposal", ...e });
});

editor.on("applied", (e) => {
  console.log(`[edit] applied v${e.version} to ${e.agentId}: ${e.summary}`);
  relay.broadcastEdit({ type: "applied", ...e });
  relay.broadcastAgents();
  relay.broadcastAgentFiles(e.agentId);
  // An edit may have changed the graph structure — invalidate and re-push.
  graphCache.delete(e.agentId);
  void relay.broadcastAgentGraph(e.agentId);
});

editor.on("undone", (e) => {
  console.log(`[edit] undid v${e.version} on ${e.agentId}`);
  relay.broadcastEdit({ type: "undone", ...e });
  relay.broadcastAgents();
  relay.broadcastAgentFiles(e.agentId);
  graphCache.delete(e.agentId);
  void relay.broadcastAgentGraph(e.agentId);
});

editor.on("discarded", (e) => relay.broadcastEdit({ type: "discarded", ...e }));

editor.on("error", (e) => {
  console.error(`[edit] failed: ${e.message}`);
  for (const p of e.problems ?? []) console.error(`  - ${p}`);
  relay.broadcastEdit({ type: "error", ...e });
});

function editAgent(agentId: string, instruction: string): void {
  console.log(`[edit] ${agentId} — "${instruction.slice(0, 80)}"`);
  relay.broadcastEdit({ type: "started", agentId, instruction });
  void editor.propose(agentId, instruction);
}

// --- run trigger ------------------------------------------------------------
function runAgent(input?: string, provider?: string, model?: string, agentId?: string): void {
  if (pool.interactiveRunning) {
    console.log("[manager] agent already running; ignoring run request");
    return;
  }
  // Mint the run id server-side so we can address the run (e.g. pause it) before run_start races
  // back. The runner uses JAROKU_RUN_ID when present, else mints its own — back-compatible.
  const runId = randomUUID();
  clearControl(runId); // no stale pause request from a prior life
  console.log(`[manager] starting ${agentId ?? "test_agent"}${input ? ` — "${input}"` : ""} (run ${runId})`);
  // Model is forwarded explicitly so a real-provider run can't silently fall back to
  // the agent's expensive default; unset means the agent picks its own default.
  const env: NodeJS.ProcessEnv = { JAROKU_RUN_ID: runId };
  if (provider) env.JAROKU_PROVIDER = provider;
  if (model) env.JAROKU_MODEL = model;
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  pool.startInteractive({ runId, runtimeDir: RUNTIME_DIR, input, agentId, env });
}

// Pause the live run at its next node boundary (the runner honours the control file there).
function pauseRun(runId: string): void {
  if (!runActive || activeRunId !== runId) {
    console.log(`[debug] pauseRun ignored — ${runId} is not the active run`);
    return;
  }
  console.log(`[debug] pause requested for run ${runId}`);
  requestPause(runId);
}

// Resume a paused run from its durable checkpoint: a fresh subprocess continues the SAME run id,
// its seq starting where the paused segment left off (no run_start, no re-run of done nodes).
function resumeRun(runId: string): void {
  if (pool.interactiveRunning) {
    console.log("[debug] resumeRun ignored — a run is already active");
    return;
  }
  const run = store.getRun(runId);
  if (!run) {
    relay.broadcastDebug({ type: "error", runId, message: "unknown run" });
    return;
  }
  // 'paused' is a store-only status (never an emitted event), so it's outside the frozen
  // RunStatus mirror — compare as a plain string rather than widening that type.
  if ((run.status as string) !== "paused") {
    relay.broadcastDebug({ type: "error", runId, message: `run is ${run.status}, not paused` });
    return;
  }
  const seqOffset = store.maxSeqForRun(runId) + 1;
  clearControl(runId); // drop the pause request so it doesn't immediately re-pause
  store.setRunStatus(runId, "running");
  console.log(`[debug] resuming run ${runId} from seq ${seqOffset} (agent ${run.agent_id})`);
  const env: NodeJS.ProcessEnv = {
    JAROKU_RESUME_RUN_ID: runId,
    JAROKU_SEQ_OFFSET: String(seqOffset),
    JAROKU_PROVIDER: run.provider,
    JAROKU_MODEL: run.model,
  };
  runActive = true;
  activeRunId = runId;
  pausedRunId = null;
  relay.broadcastDebug({ type: "resumed", runId, seqOffset });
  pool.startInteractive({ runId, runtimeDir: RUNTIME_DIR, agentId: run.agent_id, env });
}

// Fork a NEW run from a parent run's checkpoint at a step's node boundary, optionally with a
// validated domain-field edit. The parent is only read: its checkpoint db is copied (never
// written), and its step rows are copied verbatim into the branch — both stay fully inspectable.
function branchRun(
  fromRunId: string,
  atSeq: number,
  editNode?: string,
  editedState?: Record<string, unknown>,
): void {
  if (pool.interactiveRunning) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: "a run is active — stop it before branching" });
    return;
  }
  const parent = store.getRun(fromRunId);
  if (!parent) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: "unknown run to branch from" });
    return;
  }
  // Resolve the node boundary containing `atSeq` — we fork at a whole-node boundary, never mid-node.
  const boundary = store.boundaryForStep(fromRunId, atSeq);
  const parentDb = join(CHECKPOINT_DIR, `${fromRunId}.sqlite`);
  if (!boundary || !existsSync(parentDb)) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: "no durable checkpoint for that step (branching needs a checkpointed run)" });
    return;
  }

  const branchId = randomUUID();
  const { checkpointId, seqHigh } = boundary;
  try {
    // Copy the parent's step prefix (0..boundary) + a physical copy of its checkpoint db, so the
    // parent is never mutated and the branch is self-contained + independently inspectable.
    store.copyRunPrefix(fromRunId, branchId, seqHigh, seqHigh);
    copyFileSync(parentDb, join(CHECKPOINT_DIR, `${branchId}.sqlite`));
  } catch (err) {
    relay.broadcastDebug({ type: "error", runId: fromRunId, message: `branch prep failed: ${(err as Error).message}` });
    return;
  }

  const env: NodeJS.ProcessEnv = {
    JAROKU_RUN_ID: branchId,
    JAROKU_BRANCH_THREAD_ID: fromRunId, // the checkpoint thread lives under the parent's id
    JAROKU_BRANCH_CHECKPOINT_ID: checkpointId,
    JAROKU_SEQ_OFFSET: String(seqHigh + 1),
    JAROKU_PROVIDER: parent.provider,
    JAROKU_MODEL: parent.model,
  };
  if (editedState && Object.keys(editedState).length) {
    const editFile = join(CHECKPOINT_DIR, `${branchId}.edit.json`);
    writeFileSync(editFile, JSON.stringify(editedState));
    env.JAROKU_BRANCH_EDIT_FILE = editFile;
    if (editNode) env.JAROKU_BRANCH_EDIT_NODE = editNode;
  }

  runActive = true;
  activeRunId = branchId;
  pausedRunId = null;
  console.log(`[debug] branching ${fromRunId} @seq ${seqHigh} -> ${branchId} (agent ${parent.agent_id})`);
  relay.broadcastHistory(); // surface the new branch run in history immediately
  relay.broadcastDebug({ type: "branched", parentRunId: fromRunId, branchId, fromSeq: seqHigh });
  pool.startInteractive({ runId: branchId, runtimeDir: RUNTIME_DIR, agentId: parent.agent_id, env });
}

// --- explain (unified composer) --------------------------------------------
// A prose answer about a step / node / the agent, streamed to the conversation. Reuses only
// already-available context (the step the client selected, the agent's on-disk prompt/tools);
// never a code change, never on the trace stream.
let explaining = false;

function truncateJson(v: unknown, cap = 800): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > cap ? `${s.slice(0, cap)}\n…(truncated)` : s;
}

function buildExplainContext(cmd: ExplainCommand): string {
  const { agentId, subject } = cmd;
  if (subject.kind === "step") {
    const st = subject.step;
    const parts = [
      `Agent: ${agentId}`,
      `Trace step #${st.seq}: "${st.name}" (${st.type}), status: ${st.error ? "FAILED" : "ok"}.`,
    ];
    if (st.error) parts.push(`Error:\n${st.error}`);
    parts.push(`Input:\n${truncateJson(st.input)}`, `Output:\n${truncateJson(st.output)}`);
    return parts.join("\n\n");
  }
  // node / agent — ground in the agent's on-disk prompt + tools (already served to the client too).
  const files = agentProjectFiles(agentId) as { path: string; content: string }[];
  const prompt = files.find((f) => /prompt/i.test(f.path) && f.path.endsWith(".md"))?.content ?? "(no system prompt file)";
  const toolFiles = files.filter((f) => /(^|\/)tools\//.test(f.path) && f.path.endsWith(".py") && !f.path.endsWith("__init__.py"));
  const tools = toolFiles.length
    ? toolFiles.map((f) => `- ${f.path}:\n${f.content.slice(0, 500)}`).join("\n")
    : "(no bespoke tools)";
  const head = subject.kind === "node" ? `Graph node: "${subject.nodeId}" of agent ${agentId}.` : `Agent: ${agentId}.`;
  return [head, `System prompt:\n${prompt.slice(0, 1500)}`, `Tools:\n${tools}`].join("\n\n");
}

function explainAgent(cmd: ExplainCommand): void {
  if (explaining) {
    relay.broadcastReply({ type: "error", agentId: cmd.agentId, message: "already answering — one at a time" });
    return;
  }
  explaining = true;
  relay.broadcastReply({ type: "started", agentId: cmd.agentId, question: cmd.question });
  const context = buildExplainContext(cmd);
  void streamExplain(context, cmd.question, {
    onDelta: (text) => relay.broadcastReply({ type: "delta", agentId: cmd.agentId, text }),
    onDone: () => { explaining = false; relay.broadcastReply({ type: "done", agentId: cmd.agentId }); },
    onError: (message) => { explaining = false; relay.broadcastReply({ type: "error", agentId: cmd.agentId, message }); },
  });
}

// Kick off one run on startup unless suppressed (set JAROKU_NO_AUTORUN=1 to just serve).
if (process.env.JAROKU_NO_AUTORUN !== "1") {
  // Small delay so the relay is listening before the first events land.
  setTimeout(() => runAgent(), 300);
}

// --- graceful shutdown ------------------------------------------------------
function shutdown(): void {
  console.log("\n[server] shutting down…");
  pool.stopAll();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

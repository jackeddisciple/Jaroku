// Standing up a REAL deployed agent — the actual serve.py, the actual runner, the actual
// example agent — with only the model provider replaced by a fixture.
//
// WHY MOCK THE PROVIDER RATHER THAN THE PRODUCT. Every other way of making these suites runnable
// costs something the suites exist to check. Letting serve.py accept the dry-run provider would
// put a test-only escape into the file whose whole job is refusing one. Stubbing the runner
// would test a stub. Running against a real key would make the suite something that runs when
// somebody has a budget. Pointing `ANTHROPIC_BASE_URL` at a node server replaces the one thing
// that genuinely cannot be in a test — a paid third party — and leaves every line of Jaroku's
// own code executing for real.
//
// WHAT THAT BUYS. The trace these suites read is produced by the same interceptor, the same
// tracer, the same checkpointed driver and the same graph a local run uses. So "a deployed
// trace and a local trace differ in run id and timing and nothing else" is a comparison of two
// real traces rather than of a real one against a fixture's idea of one.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { randomBytes, randomUUID } from "node:crypto";

import { writeDeployArtifacts } from "../../src/deployArtifacts.ts";
import { DeployRuns } from "../../src/deployRuns.ts";
import { Router } from "../../src/http/router.ts";
import { BackpressureTracker } from "../../src/sandbox/backpressure.ts";
import { RunEventBus } from "../../src/sandbox/eventBus.ts";
import { registerControlPlaneRoutes } from "../../src/sandbox/controlPlaneRoutes.ts";
import { RunTokenRevocationList } from "../../src/sandbox/runTokens.ts";
import { TraceIngestMetrics } from "../../src/sandbox/traceIngestMetrics.ts";
import type { TraceEvent } from "../../src/types.ts";

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const RUNTIME_DIR = join(REPO_DIR, "runtime");

/**
 * The interpreter these suites drive, or null when this machine has no Python for them.
 *
 * The runtime's own virtualenv first, because that is where LangGraph actually is and because
 * `sys.executable` inside serve.py then names it too — so the runner subprocess serve.py starts
 * inherits the same interpreter rather than finding whatever `python` means on this PATH.
 */
export function pythonExecutable(): string | null {
  for (const candidate of [
    join(RUNTIME_DIR, ".venv", "Scripts", "python.exe"),
    join(RUNTIME_DIR, ".venv", "bin", "python"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** One turn the fixture provider will answer with, in order. */
export type MockTurn =
  | { kind: "tool_use"; name: string; input?: Record<string, unknown>; inputTokens?: number; outputTokens?: number }
  | { kind: "text"; text: string; inputTokens?: number; outputTokens?: number };

export interface MockProvider {
  baseUrl: string;
  /** Every request the agent actually made, so a suite can assert the model was reached. */
  calls: number;
  close: () => Promise<void>;
}

/**
 * An Anthropic Messages API that answers from a script.
 *
 * Deliberately raw `node:http` and raw JSON rather than any Anthropic SDK — the same reasoning
 * the MCP fixture gives. What is under test here is `langchain_anthropic` talking to something
 * that is not itself, and two halves of one library agreeing proves less.
 */
export async function startMockProvider(turns: MockTurn[]): Promise<MockProvider> {
  let index = 0;
  const state = { calls: 0 };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.calls++;
      // The script is consumed in order and the LAST turn repeats. A graph that loops one more
      // time than the suite expected should produce a longer trace, not a 500 that reads as an
      // unrelated transport failure.
      const turn = turns[Math.min(index++, turns.length - 1)]!;
      const content =
        turn.kind === "tool_use"
          ? [{ type: "tool_use", id: `toolu_${index}`, name: turn.name, input: turn.input ?? {} }]
          : [{ type: "text", text: turn.text }];
      const body = JSON.stringify({
        id: `msg_${index}`,
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content,
        stop_reason: turn.kind === "tool_use" ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: turn.inputTokens ?? 100,
          output_tokens: turn.outputTokens ?? 20,
        },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get calls() { return state.calls; },
    close: () => new Promise((done) => server.close(() => done())),
  };
}

export interface DeployedProject {
  /** A runtime-shaped directory holding one deployed agent, laid out exactly as an image is. */
  runtimeDir: string;
  projectDir: string;
  agentId: string;
  cleanup: () => void;
}

/**
 * Build the layout a deployed container actually has, on disk, from the real checkout.
 *
 * THROUGH `writeDeployArtifacts` RATHER THAN BY HAND, and that is the point: the vendored
 * runtime, serve.py, the Dockerfile and the pyproject are placed by the same code a real deploy
 * runs. A harness that assembled its own directory would be testing a layout nothing produces.
 */
export function deployedProject(agentId = "example_agent"): DeployedProject {
  const scratch = mkdtempSync(join(tmpdir(), "jaroku-serve-"));
  const runtimeDir = join(scratch, "runtime");
  const projectDir = join(runtimeDir, "agents", agentId);
  mkdirSync(join(runtimeDir, "agents"), { recursive: true });
  writeFileSync(join(runtimeDir, "agents", "__init__.py"), '"""agents."""\n', "utf8");
  cpSync(join(RUNTIME_DIR, "agents", agentId), projectDir, {
    recursive: true,
    filter: (src) => !src.includes("__pycache__"),
  });
  // The three things writeDeployArtifacts reads out of a runtime directory.
  cpSync(join(RUNTIME_DIR, "tool_templates"), join(runtimeDir, "tool_templates"), {
    recursive: true,
    filter: (src) => !src.includes("__pycache__") && !src.includes(`${"tests"}`),
  });
  for (const entry of ["jaroku_interceptor", "jaroku_runner"]) {
    cpSync(join(RUNTIME_DIR, entry), join(runtimeDir, entry), {
      recursive: true,
      filter: (src) => !src.includes("__pycache__"),
    });
  }
  writeFileSync(join(runtimeDir, "pricing.json"), readFileSync(join(RUNTIME_DIR, "pricing.json"), "utf8"), "utf8");

  writeDeployArtifacts({ runtimeDir, agentId, provider: "anthropic" });

  return {
    runtimeDir,
    projectDir,
    agentId,
    // BEST-EFFORT, AND RETRIED. On Windows a directory a just-killed process still has open —
    // its cwd, a checkpoint database, an import lock — refuses to be removed for a moment
    // afterwards, and a fixture that threw EPERM here would fail suites whose assertions had all
    // passed. A temp directory left behind is the operating system's problem; a red suite that
    // proved nothing is ours.
    cleanup: () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { rmSync(scratch, { recursive: true, force: true }); return; } catch { /* retry */ }
      }
    },
  };
}

export interface ServedAgent {
  url: string;
  token: string;
  /** Everything the container wrote to its log pane, which is where the runner's stderr lands. */
  logs: string[];
  proc: ChildProcess;
  stop: () => Promise<void>;
}

export interface ServeOptions {
  project: DeployedProject;
  provider: MockProvider;
  /** Extra environment for the container. Where a suite says what it is actually testing. */
  env?: Record<string, string>;
  token?: string;
  concurrency?: number;
}

/**
 * Start the real serve.py against a built project, and wait until it answers /health.
 *
 * Started as `python -m agents.<id>.serve` from the runtime directory, which is the invocation
 * the file's own docstring documents and the one it is run under locally. In a container the
 * package is `<id>` rather than `agents.<id>`; serve.py takes the last segment either way, which
 * is exactly what its `main()` says it does.
 */
export async function startServe(opts: ServeOptions): Promise<ServedAgent> {
  const python = pythonExecutable();
  if (!python) throw new Error("no Python interpreter for the serve harness");
  const token = opts.token ?? "harness-bearer-token";

  // A port picked by the OS and released, then handed to serve.py — it binds a fixed port, and
  // a hardcoded one makes two suites running at once flake against each other.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const logs: string[] = [];
  const proc = spawn(python, ["-m", `agents.${opts.project.agentId}.serve`], {
    cwd: opts.project.runtimeDir,
    env: {
      ...process.env,
      PORT: String(port),
      JAROKU_SERVE_TOKEN: token,
      JAROKU_SERVE_CONCURRENCY: String(opts.concurrency ?? 4),
      JAROKU_PROVIDER: "anthropic",
      JAROKU_MODEL: "claude-haiku-4-5",
      // The one substitution. Both names are read by the Anthropic SDK itself, which is what
      // langchain_anthropic is built on.
      ANTHROPIC_API_KEY: "sk-ant-harness-not-a-real-key",
      ANTHROPIC_BASE_URL: opts.provider.baseUrl,
      // A deployed container has no runtime/.env and no control directory. Cleared rather than
      // inherited, so this machine's own configuration cannot make a suite pass.
      JAROKU_CONTROL_DIR: "",
      JAROKU_RUN_TOKEN: "",
      JAROKU_CONTROL_PLANE_URL: "",
      JAROKU_CHECKPOINTER: "sqlite",
      PYTHONUNBUFFERED: "1",
      ...opts.env,
    },
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => { for (const l of d.split("\n")) if (l.trim()) logs.push(l.trimEnd()); });
  proc.stderr.on("data", (d: string) => { for (const l of d.split("\n")) if (l.trim()) logs.push(`STDERR ${l.trimEnd()}`); });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`serve.py exited ${proc.exitCode}:\n${logs.join("\n")}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) { await res.json(); break; }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`serve.py never became healthy:\n${logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  const served: ServedAgent = {
    url,
    token,
    logs,
    proc,
    stop: () =>
      new Promise((done) => {
        // THE TREE, NOT THE HANDLE. On Windows the process node spawned is a virtualenv shim and
        // serve.py is its child — see killRunnerChildren — so killing the handle leaves the real
        // server running, holding the port and the scratch directory the suite is about to try
        // to delete. That is what turns a passing suite into an EPERM in its own cleanup.
        killDescendants(proc.pid);
        if (proc.exitCode !== null) return done();
        proc.once("exit", () => done());
        proc.kill();
        setTimeout(() => { proc.kill("SIGKILL"); done(); }, 5_000).unref();
      }),
  };
  return served;
}

/** Every descendant of `root`, killed. `root` itself is left to its own handle. */
function killDescendants(root: number | undefined): void {
  if (!root) return;
  try {
    const rows = processTable();
    const tree = new Set<number>([root]);
    for (let pass = 0; pass < 8; pass++) {
      let grew = false;
      for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) { tree.add(r.pid); grew = true; }
      if (!grew) break;
    }
    for (const pid of tree) {
      if (pid === root) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } catch { /* best effort — a stray process is not a failed assertion */ }
}

/** pid, parent pid and command line for every process on this machine. */
function processTable(): Array<{ pid: number; ppid: number; cmd: string }> {
  if (process.platform === "win32") {
    const out = spawnSync(
      "powershell.exe",
      [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object " +
        '{ "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ).stdout ?? "";
    return out.split(/\r?\n/)
      .map((line) => {
        const [pid, ppid, ...rest] = line.split("\t");
        return { pid: Number(pid), ppid: Number(ppid), cmd: rest.join("\t") };
      })
      .filter((r) => Number.isInteger(r.pid) && r.pid > 0);
  }
  const out = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).stdout ?? "";
  return out.split("\n")
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! } : { pid: 0, ppid: 0, cmd: "" };
    })
    .filter((r) => Number.isInteger(r.pid) && r.pid > 0);
}

/**
 * Run the same agent LOCALLY, the way `npm run dev` does, and collect its trace off stdout.
 *
 * THE OTHER HALF OF §12's COMPARISON. "Diff a local trace against a deployed trace for the same
 * agent and input; they should differ in run id and timing and nothing else" is a claim about
 * two real traces, and it is only worth anything if the local one is produced by the local path
 * rather than by a description of it. So this is the invocation from jaroku_runner's own
 * docstring, against the same project directory, with stdout read as the frozen NDJSON stream —
 * exactly what processManager.ts holds the other end of.
 */
export async function runLocally(
  project: DeployedProject,
  provider: MockProvider,
  input: string,
  env: Record<string, string> = {},
): Promise<{ events: TraceEvent[]; stderr: string; code: number | null }> {
  const python = pythonExecutable();
  if (!python) throw new Error("no Python interpreter for the serve harness");
  return new Promise((done, reject) => {
    const proc = spawn(python, ["-m", "jaroku_runner", project.agentId, input], {
      cwd: project.runtimeDir,
      env: {
        ...process.env,
        JAROKU_AGENT_DIR: project.projectDir,
        JAROKU_PROVIDER: "anthropic",
        JAROKU_MODEL: "claude-haiku-4-5",
        ANTHROPIC_API_KEY: "sk-ant-harness-not-a-real-key",
        ANTHROPIC_BASE_URL: provider.baseUrl,
        // No control plane and no control directory: this is the local path, and the local path
        // is what it is BECAUSE neither is set. controlplane_http no-ops on exactly this.
        JAROKU_CONTROL_PLANE_URL: "",
        JAROKU_RUN_TOKEN: "",
        JAROKU_CONTROL_DIR: "",
        JAROKU_CHECKPOINTER: "sqlite",
        PYTHONUNBUFFERED: "1",
        ...env,
      },
    });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => (out += d));
    proc.stderr.on("data", (d: string) => (err += d));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      const events: TraceEvent[] = [];
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { events.push(JSON.parse(trimmed) as TraceEvent); } catch { /* not an event line */ }
      }
      done({ events, stderr: err, code });
    });
  });
}

/**
 * One trace, reduced to the shape §11 asks to compare: "step types and ordering, not just
 * presence".
 *
 * Run id and timing are deliberately absent — those are the two things a deployed run is
 * ALLOWED to differ in. What is left is the sequence a reader of the Graph tab actually sees.
 */
export function traceShape(events: TraceEvent[]): string[] {
  return events.map((e) =>
    e.kind === "step" ? `step:${e.step.seq}:${e.step.type}:${e.step.name}` : `${e.kind}:${e.run.status}`,
  );
}

export interface HarnessControlPlane {
  url: string;
  bus: RunEventBus;
  runs: DeployRuns;
  revocations: RunTokenRevocationList;
  metrics: TraceIngestMetrics;
  workspaceId: string;
  /** Every trace event that reached the bus, by run id, for a suite that only wants the list. */
  eventsFor: (runId: string) => TraceEvent[];
  /** Control lines a run pushed — boundaries, pauses, the run_closed marker. */
  controlFor: (runId: string) => Record<string, unknown>[];
  /** Batch entries the route refused to recognise as trace events, and why. */
  parseErrorsFor: (runId: string) => { line: string; error: string }[];
  /** Runs the backpressure limiter asked production to stop, and the reason it gave. */
  stopped: { runId: string; reason: string }[];
  close: () => Promise<void>;
}

/**
 * The real control plane, on a real port — the same four routes index.ts registers at startup.
 *
 * NOT A STUB OF THEM. §7 says the ingest is already built and must be used rather than forked,
 * and a harness that answered 200 to whatever a container pushed would make every suite over it
 * a test of the container alone. Everything a deployed run pushes here goes through the real
 * `authenticate`, the real backpressure tracker and the real event-shape check.
 */
export async function startControlPlane(
  opts: { backpressure?: BackpressureTracker; workspaceId?: string } = {},
): Promise<HarnessControlPlane> {
  const signingKey = randomBytes(32);
  const revocations = new RunTokenRevocationList();
  const bus = new RunEventBus();
  const router = new Router({ log: () => {}, quiet: () => true });
  const events = new Map<string, TraceEvent[]>();
  const control = new Map<string, Record<string, unknown>[]>();
  const parseErrors = new Map<string, { line: string; error: string }[]>();
  const metrics = new TraceIngestMetrics();
  const stopped: { runId: string; reason: string }[] = [];

  registerControlPlaneRoutes(router, {
    bus,
    signingKey,
    revocations,
    metrics,
    backpressure: opts.backpressure ?? new BackpressureTracker(),
    // WHAT PRODUCTION DOES WITH A HOSTILE RUN, wired to a recorder rather than to a pool. §7 is
    // explicit that a deployed run is not more trusted than a sandboxed one — "every bound that
    // applies to a sandbox run applies here" — and the bound only means something if tripping it
    // stops the run rather than merely refusing the batch.
    onBackpressureViolation: (runId, reason) => stopped.push({ runId, reason }),
  });
  const server = createServer((req, res) => {
    void router.handle(req, res).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const runs = new DeployRuns({ signingKey, revocations, bus });
  // Recorded as it arrives rather than read back later: a bus entry is released the moment a run
  // closes, and a suite that asked afterwards would find nothing for exactly the runs it cares
  // about most.
  const originalOpen = runs.open.bind(runs);
  runs.open = (input) => {
    const opened = originalOpen(input);
    events.set(input.runId, []);
    control.set(input.runId, []);
    parseErrors.set(input.runId, []);
    const emitter = bus.register(input.runId);
    emitter.on("event", (e) => events.get(input.runId)!.push(e));
    emitter.on("control", (c) => control.get(input.runId)!.push(c));
    emitter.on("parseError", (e) => parseErrors.get(input.runId)!.push(e));
    return opened;
  };

  return {
    url,
    bus,
    runs,
    revocations,
    metrics,
    workspaceId: opts.workspaceId ?? randomUUID(),
    eventsFor: (runId) => events.get(runId) ?? [],
    controlFor: (runId) => control.get(runId) ?? [],
    parseErrorsFor: (runId) => parseErrors.get(runId) ?? [],
    stopped,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/**
 * Kill the runner processes serve.py started, without touching serve.py.
 *
 * THIS IS THE OOM KILLER, STOOD IN FOR. A container that runs out of memory does not get to
 * finish its `finally`: the kernel removes the process between two steps, and the only evidence
 * is that nothing further arrives. There is no way to ask a Python process to fail like that —
 * every mechanism inside it runs its cleanup — so it has to be done from out here, to the child,
 * exactly as the kernel would.
 *
 * Two platform branches because listing a process's children has no portable spelling, and both
 * are read-only queries followed by a kill of what they return. Returns how many were killed, so
 * a suite can assert it actually did something rather than passing because it found nothing.
 */
export function killRunnerChildren(served: ServedAgent): number {
  const root = served.proc.pid;
  if (!root) return 0;

  // THE WHOLE DESCENDANT TREE, AND THEN MATCHED ON THE COMMAND LINE. Both halves were learned
  // the hard way and both are load-bearing:
  //
  //   DESCENDANTS, NOT CHILDREN. On Windows a virtualenv's `python.exe` re-execs the real
  //   interpreter, so the process node spawned is a shim and serve.py is its child — which makes
  //   the runner a GRANDCHILD. Killing the direct child kills serve.py, and the runner then
  //   survives with a broken stderr pipe and reports `OSError: [Errno 22]` as its own failure.
  //   That is a run that failed, not a run that was killed, and this helper exists to produce
  //   the second one.
  //
  //   BY COMMAND LINE, NOT BY EXECUTABLE NAME. Every process in that tree is `python.exe`, so
  //   the name distinguishes nothing. `jaroku_runner` is on the runner's argv and on nothing
  //   else's.
  let rows: Array<{ pid: number; ppid: number; cmd: string }> = [];
  try { rows = processTable(); } catch { return 0; }

  const descendants = new Set<number>([root]);
  // Repeated passes rather than recursion: the table is unordered, so a grandchild can appear
  // before its parent, and one pass would miss it. Bounded by the depth of the tree, which is
  // three.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const r of rows) {
      if (descendants.has(r.ppid) && !descendants.has(r.pid)) { descendants.add(r.pid); grew = true; }
    }
    if (!grew) break;
  }

  let killed = 0;
  for (const r of rows) {
    if (r.pid === root || !descendants.has(r.pid)) continue;
    if (!r.cmd.includes("jaroku_runner")) continue;
    try { process.kill(r.pid, "SIGKILL"); killed++; } catch { /* already gone */ }
  }
  return killed;
}

/** One dispatch, exactly as Jaroku makes it. */
export async function dispatch(
  served: ServedAgent,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${served.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${served.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

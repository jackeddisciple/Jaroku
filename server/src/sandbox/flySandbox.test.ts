// FlyMachinesSandbox, driven against a fixture Fly API — provisioning, the bus pipe-through,
// and the three exit shapes a run can end in: a normal exit, an OOM kill, and a signal.
//
//   npm run test:fly-sandbox

import { randomBytes } from "node:crypto";
import { startMockFlyApi, type MockFlyApi } from "../../fixtures/fly/mockFlyApi.ts";
import { RunEventBus } from "./eventBus.ts";
import { FlyMachinesSandbox } from "./flySandbox.ts";
import type { SandboxSpec } from "./runSandbox.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const DIGEST = "sha256:" + randomBytes(32).toString("hex");
const IMAGE = `ghcr.io/jackeddisciple/jaroku-sandbox@${DIGEST}`;

process.env.JAROKU_FLY_API_TOKEN = "fixture-fly-token";

async function withMock<T>(fn: (mock: MockFlyApi) => Promise<T>): Promise<T> {
  const mock = await startMockFlyApi({ token: "fixture-fly-token" });
  process.env.JAROKU_FLY_API = mock.url;
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

const baseSpec = (runId: string): SandboxSpec => ({
  runId,
  workspaceId: "ws-1",
  runtimeDir: "/does/not/matter",
  agentId: "example_agent",
  env: { JAROKU_PROVIDER: "fake" },
  controlPlane: { url: "https://cp.example.com", runToken: "tok" },
  files: { presignedTarUrl: "https://objects.example.com/project.tar" },
});

await withMock(async (mock) => {
  const bus = new RunEventBus();
  const sandbox = new FlyMachinesSandbox({ app: "jaroku-runs", bus, image: IMAGE, exitPollMs: 50 });
  const exits: unknown[] = [];
  sandbox.on("exit", (e) => exits.push(e));

  sandbox.start(baseSpec("run-fly-1"));
  for (let i = 0; i < 50 && mock.machines.size === 0; i++) await new Promise((r) => setTimeout(r, 20));

  check("a machine was actually provisioned against the fixture", mock.machines.size === 1);
  const machine = [...mock.machines.values()][0]!;
  check(
    "the image sent is exactly the one this sandbox was configured with",
    (machine.config as { image?: string }).image === IMAGE,
  );
  const env = (machine.config as { env?: Record<string, string> }).env ?? {};
  check("the run token reached the machine's env", env.JAROKU_RUN_TOKEN === "tok");
  check("the project archive URL reached the machine's env", env.JAROKU_PROJECT_TAR_URL === "https://objects.example.com/project.tar");
  check("the workspace id reached the machine's env", env.JAROKU_WORKSPACE_ID === "ws-1");
  check("bus.register happened before the machine was even created", bus.has("run-fly-1"));

  // A trace event pushed through the bus (as controlPlaneRoutes.ts would, from the runner's own
  // HTTP push) must reach the sandbox instance itself — this is the whole of how RunPool's
  // existing per-slot listeners work unmodified against a hosted sandbox.
  let sawEvent = false;
  sandbox.once("event", () => (sawEvent = true));
  bus.pushTrace("run-fly-1", { kind: "run_start", schema_version: 1, run: { id: "run-fly-1" } } as never);
  check("an event pushed onto the bus is re-emitted on the sandbox instance", sawEvent);

  mock.setExit(machine.id, { exit_code: 0, oom_killed: false, signal: null });
  sandbox.stop();
  for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  check("a clean exit is reported with code 0 and no oom flag", (exits[0] as { code?: number; oom?: boolean })?.code === 0 && !(exits[0] as { oom?: boolean })?.oom);
  check("the bus entry is cleaned up once the run has exited", !bus.has("run-fly-1"));
});

await withMock(async (mock) => {
  const bus = new RunEventBus();
  const sandbox = new FlyMachinesSandbox({ app: "jaroku-runs", bus, image: IMAGE, exitPollMs: 50 });
  const exits: Array<{ oom?: boolean }> = [];
  sandbox.on("exit", (e) => exits.push(e));
  sandbox.start(baseSpec("run-fly-oom"));
  for (let i = 0; i < 50 && mock.machines.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const machine = [...mock.machines.values()][0]!;
  mock.setExit(machine.id, { exit_code: 137, oom_killed: true, signal: 9 });
  sandbox.stop();
  for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  check("an OOM kill is reported as such, distinct from an ordinary exit", exits[0]?.oom === true);
});

await withMock(async () => {
  // A non-digest-pinned image is refused at CONSTRUCTION, before any machine is ever requested —
  // the same invariant image.ts enforces, checked again here rather than only trusted from the
  // caller, since a sandbox is exactly the wrong place to discover a tag slipped through.
  const bus = new RunEventBus();
  let threw = false;
  try {
    new FlyMachinesSandbox({ app: "jaroku-runs", bus, image: "jaroku-sandbox:latest" });
  } catch {
    threw = true;
  }
  check("constructing a sandbox with a tag instead of a digest throws immediately", threw);
});

await withMock(async () => {
  // Authentication failures are surfaced as spawnError, not swallowed — the pool's existing
  // spawnError handling already knows what to do with this.
  process.env.JAROKU_FLY_API_TOKEN = "";
  const bus = new RunEventBus();
  const sandbox = new FlyMachinesSandbox({ app: "jaroku-runs", bus, image: IMAGE, exitPollMs: 50 });
  const errors: Error[] = [];
  sandbox.on("spawnError", (e) => errors.push(e));
  sandbox.start(baseSpec("run-fly-noauth"));
  for (let i = 0; i < 50 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  check("a missing Fly API token surfaces as spawnError", errors.length === 1 && /JAROKU_FLY_API_TOKEN/.test(errors[0]!.message));
  process.env.JAROKU_FLY_API_TOKEN = "fixture-fly-token";
});

// --- the two ways the exit poll could wait forever -----------------------------------------
//
// RunPool frees a slot in its `exit` handler and nowhere else. A poll that keeps asking and never
// emits one is not a slow run, it is a slot gone for the process's lifetime — and the poll used
// to catch every error alike and try again, which turns both of these into exactly that.

await withMock(async (mock) => {
  // `auto_destroy: true` means Fly reclaims the machine ITSELF once it stops. A reclaimed machine
  // is not in state "destroyed" — it is gone, and getMachine 404s. Forever, every poll interval.
  const bus = new RunEventBus();
  const sandbox = new FlyMachinesSandbox({ app: "jaroku-runs", bus, image: IMAGE, exitPollMs: 20 });
  const exits: Array<{ code: number | null; timedOut?: boolean }> = [];
  sandbox.on("exit", (e) => exits.push(e));

  sandbox.start(baseSpec("run-fly-vanished"));
  for (let i = 0; i < 100 && mock.machines.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const id = [...mock.machines.keys()][0]!;
  mock.machines.delete(id); // Fly reclaimed it out from under us

  for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  check("a machine reclaimed by auto_destroy ends the run rather than polling a 404 forever", exits.length === 1);
  check("...reported as an ordinary end, not a timeout", exits[0]?.timedOut === false);
  check("...and the bus entry goes with it", !bus.has("run-fly-vanished"));
});

await withMock(async (mock) => {
  // Fly stops answering entirely while a machine is still running. Retrying is right; retrying
  // without a ceiling is not — past the run's own wall clock there is no machine left to wait for.
  const bus = new RunEventBus();
  const sandbox = new FlyMachinesSandbox({ app: "jaroku-runs", bus, image: IMAGE, exitPollMs: 20 });
  const exits: Array<{ code: number | null; timedOut?: boolean }> = [];
  sandbox.on("exit", (e) => exits.push(e));

  // A negative wall clock puts the deadline already in the past, so this resolves in a test.s
  // lifetime rather than the ten minutes a real run would wait out.
  sandbox.start({ ...baseSpec("run-fly-silent"), limits: { cpuMillis: 1000, memoryMb: 512, pids: 64, wallClockSec: -1000, diskMb: 0 } });
  for (let i = 0; i < 100 && mock.machines.size === 0; i++) await new Promise((r) => setTimeout(r, 20));

  for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  check("a machine still 'started' past its wall clock is given up on", exits.length === 1);
  check("...and reported as a timeout, which is what it is", exits[0]?.timedOut === true);
});

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

// RunPool's run-token wiring: minted only when there is both a workspace to scope one to and a
// control plane to present it against, revoked and unregistered the moment the run exits.
//
//   npm run test:pool-tokens

import { EventEmitter } from "node:events";
import { RunPool, type PoolRunOptions } from "./runPool.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { RunTokenRevocationList, verifyRunToken } from "./sandbox/runTokens.ts";
import type { RunSandbox, SandboxEvents, SandboxSpec } from "./sandbox/runSandbox.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A RunSandbox that never actually spawns anything — records what it was started with and
 *  lets the test drive its exit, so the pool's token lifecycle can be exercised with no
 *  subprocess and no Python at all. */
class FakeSandbox extends EventEmitter<SandboxEvents> implements RunSandbox {
  lastSpec: SandboxSpec | null = null;
  running = false;
  start(spec: SandboxSpec): void {
    this.lastSpec = spec;
    this.running = true;
  }
  stop(): void {
    this.running = false;
    this.emit("exit", { code: 0, signal: null });
  }
}

const base: Omit<PoolRunOptions, "runId"> = { runtimeDir: "/does/not/matter" };

await (async () => {
  const fakes: FakeSandbox[] = [];
  const pool = new RunPool(1, { sandbox: () => { const f = new FakeSandbox(); fakes.push(f); return f; } });
  pool.startInteractive({ ...base, runId: "r1", workspaceId: "ws-1" });
  check("no controlPlaneUrl configured -> no token minted even with a workspaceId", fakes[0]!.lastSpec?.controlPlane === undefined);
  check("the bus does not track a run with no control plane to push into", !pool.eventBus.has("r1"));
})();

await (async () => {
  const fakes: FakeSandbox[] = [];
  const pool = new RunPool(1, {
    controlPlaneUrl: "https://cp.example.com",
    sandbox: () => { const f = new FakeSandbox(); fakes.push(f); return f; },
  });
  pool.startInteractive({ ...base, runId: "r1" }); // no workspaceId
  check("a control plane with no workspaceId still mints no token", fakes[0]!.lastSpec?.controlPlane === undefined);
})();

await (async () => {
  const fakes: FakeSandbox[] = [];
  const bus = new RunEventBus();
  const pool = new RunPool(1, {
    controlPlaneUrl: "https://cp.example.com",
    bus,
    sandbox: () => { const f = new FakeSandbox(); fakes.push(f); return f; },
  });
  pool.startInteractive({ ...base, runId: "r1", workspaceId: "ws-1" });
  const spec = fakes[0]!.lastSpec;
  check("a workspace + a control plane mints a run token", !!spec?.controlPlane?.runToken);
  check("the control plane URL is passed through", spec?.controlPlane?.url === "https://cp.example.com");
  check("the bus is tracking the run before the sandbox is even started", bus.has("r1"));
})();

await (async () => {
  const fakes: FakeSandbox[] = [];
  const bus = new RunEventBus();
  const revocations = new RunTokenRevocationList();
  const pool = new RunPool(1, {
    controlPlaneUrl: "https://cp.example.com",
    bus,
    revocations,
    sandbox: () => { const f = new FakeSandbox(); fakes.push(f); return f; },
  });
  pool.startInteractive({ ...base, runId: "r1", workspaceId: "ws-1" });
  fakes[0]!.stop(); // simulate the sandbox exiting
  check("the bus stops tracking the run once it exits", !bus.has("r1"));
  check("the run's token is revoked the moment it exits, not left to run out its own ttl", revocations.isRevoked("r1"));
})();

await (async () => {
  // The token minted is a REAL, verifiable one — not a placeholder string.
  const fakes: FakeSandbox[] = [];
  const { randomBytes } = await import("node:crypto");
  const signingKey = randomBytes(32);
  const pool = new RunPool(1, {
    controlPlaneUrl: "https://cp.example.com",
    signingKey,
    sandbox: () => { const f = new FakeSandbox(); fakes.push(f); return f; },
  });
  pool.startInteractive({ ...base, runId: "r1", workspaceId: "ws-42" });
  const runToken = fakes[0]!.lastSpec!.controlPlane!.runToken;
  const verified = verifyRunToken(signingKey, runToken);
  check("the minted token verifies against the pool's own signing key", verified.ok);
  if (verified.ok) {
    check("it is scoped to the run that was started", verified.claims.runId === "r1");
    check("it carries the workspace the run was started in", verified.claims.workspaceId === "ws-42");
  }
})();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

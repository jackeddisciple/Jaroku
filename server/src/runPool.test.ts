// Run pool guarantees, exercised against REAL subprocesses.
//
// These are the properties a fan-out depends on, and all three fail silently if broken:
// exceeding the cap just makes everything slower (and poisons the latency numbers the
// comparison dashboard reports), losing the interactive reservation breaks pause/branch
// only once an eval happens to be running, and a missing timeout turns one hung network
// call into an eval that never finishes with no way out.
//
// Runs on the free `fake` provider, so this costs nothing.
//
//   npm run test:pool

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { RunPool } from "./runPool.ts";

const RUNTIME_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "runtime");
// Any generated agent works; this one exercises four tools, so it has real boundaries.
const AGENT = "a_simple_todo_list_agent_that_can_add_ta_2";

if (!existsSync(join(RUNTIME_DIR, "agents", AGENT))) {
  console.log(`  SKIP  fixture agent ${AGENT} is not present`);
  process.exit(0);
}

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const base = { runtimeDir: RUNTIME_DIR, agentId: AGENT, input: "add milk" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live `jaroku_runner` processes. The point of a graceful stop is leaving none behind. */
function runnerProcessCount(): number {
  try {
    return execFileSync("pgrep", ["-f", "jaroku_runner"], { encoding: "utf8" })
      .split("\n").filter(Boolean).length;
  } catch {
    return 0; // pgrep exits non-zero when nothing matches
  }
}

// --- 1. capacity is a hard cap, and slot 0 is not part of it -------------------------
{
  const CONCURRENCY = 2;
  const pool = new RunPool(CONCURRENCY);
  const exits: string[] = [];
  pool.on("exit", ({ runId }) => exits.push(runId));

  check("capacity excludes the interactive slot", pool.capacity === CONCURRENCY, `got ${pool.capacity}`);
  check("all background slots free initially", pool.freeSlots === CONCURRENCY);

  const started = [
    pool.tryStart({ ...base, runId: "bg-1" }),
    pool.tryStart({ ...base, runId: "bg-2" }),
  ];
  const overflow = pool.tryStart({ ...base, runId: "bg-3" });

  check("fills every background slot", started.every(Boolean));
  check("refuses to spawn past the cap", overflow === false);
  check("no free slots while saturated", pool.freeSlots === 0);

  // The reservation is the whole point: an eval must never be able to take the slot the
  // user's run — and pause/resume/branch — depend on.
  const interactive = pool.startInteractive({ ...base, runId: "interactive-1" });
  check("interactive slot still available while background is saturated", interactive === true);
  check("interactive run refuses a second interactive start",
    pool.startInteractive({ ...base, runId: "interactive-2" }) === false);

  await wait(25_000);
  check("every run exited", exits.length === 3, `exits: ${exits.join(",")}`);
  check("slots released after exit", pool.freeSlots === CONCURRENCY, `free=${pool.freeSlots}`);
  check("pool reports idle", pool.busy === false);
  pool.stopAll();
}

// --- 2. a hung run is killed at its deadline, and says so ----------------------------
{
  const pool = new RunPool(1);
  // Timestamp AT the exit event — measuring after the settle-wait would just re-measure
  // the wait.
  let observed: { timedOut: boolean; runId: string; elapsedMs: number } | null = null;

  // JAROKU_STEP_DELAY_MS sleeps at every node boundary — a stand-in for the real hazard,
  // a subprocess wedged on a network call that would otherwise hold its slot forever.
  const t0 = Date.now();
  pool.on("exit", ({ runId, timedOut }) => {
    observed = { runId, timedOut, elapsedMs: Date.now() - t0 };
  });
  pool.tryStart({
    ...base,
    runId: "hung-1",
    timeoutMs: 2_000,
    env: { JAROKU_STEP_DELAY_MS: "60000" },
  });

  await wait(12_000);
  const seen = observed as { timedOut: boolean; runId: string; elapsedMs: number } | null;
  check("hung run was killed", seen !== null);
  check("reported as timed out, not as a crash", seen?.timedOut === true);
  // The agent would run for a minute per boundary; the deadline has to be what ends it.
  check("killed at the deadline, not at the agent's own pace",
    (seen?.elapsedMs ?? Infinity) < 10_000, `exited after ${seen?.elapsedMs}ms`);
  check("slot reclaimed after the kill", pool.freeSlots === 1, `free=${pool.freeSlots}`);
  pool.stopAll();
}

// --- 3. stopAll leaves no orphan subprocesses ----------------------------------------
{
  const before = runnerProcessCount();
  const pool = new RunPool(2);
  pool.tryStart({ ...base, runId: "orphan-1", env: { JAROKU_STEP_DELAY_MS: "60000" } });
  pool.tryStart({ ...base, runId: "orphan-2", env: { JAROKU_STEP_DELAY_MS: "60000" } });
  await wait(6_000);
  pool.stopAll();
  await wait(4_000);
  const after = runnerProcessCount();
  check("no runner processes survive stopAll", after <= before, `before=${before} after=${after}`);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

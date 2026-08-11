// RunEventBus: the push/long-poll transport a hosted run's control plane rides on.
//
//   npm run test:event-bus

import { RunEventBus } from "./eventBus.ts";
import type { TraceEvent } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

function sampleEvent(): TraceEvent {
  return {
    kind: "run_start",
    schema_version: 1,
    run: {
      id: "r1",
      agent_id: "a",
      provider: "fake",
      model: "fake",
      status: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
      cost: null,
      tokens: null,
      error: null,
    },
  } as unknown as TraceEvent;
}

await (async () => {
  const bus = new RunEventBus();
  const emitter = bus.register("r1");
  let received: unknown = null;
  emitter.on("event", (e) => (received = e));
  bus.pushTrace("r1", sampleEvent());
  check("a pushed trace event reaches the registered emitter", (received as { run?: { id?: string } })?.run?.id === "r1");
})();

await (async () => {
  const bus = new RunEventBus();
  bus.pushTrace("unknown-run", sampleEvent()); // must not throw
  check("pushing to an unregistered run is a no-op, not a crash", true);
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  const before = Date.now();
  const result = await bus.waitForControl("r1", 150);
  const elapsed = Date.now() - before;
  check("a long-poll with nothing queued resolves to none after the timeout", result.action === "none");
  check("it actually waited roughly the timeout, not returned instantly", elapsed >= 100, `elapsed=${elapsed}ms`);
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  bus.signal("r1", { action: "pause" });
  const result = await bus.waitForControl("r1", 5_000);
  check("a queued action is returned on the very next poll", result.action === "pause");
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  const before = Date.now();
  const pending = bus.waitForControl("r1", 5_000);
  // Signal AFTER the poll is already in flight — this is the case that matters: a pause
  // requested while the runner is mid-long-poll must wake it immediately, not sit unseen for
  // up to the full 5s timeout.
  setTimeout(() => bus.signal("r1", { action: "resume" }), 30);
  const result = await pending;
  const elapsed = Date.now() - before;
  check("signalling a runner already waiting wakes it immediately", result.action === "resume" && elapsed < 500, `elapsed=${elapsed}ms`);
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  const pending = bus.waitForControl("r1", 5_000);
  bus.unregister("r1");
  const result = await pending;
  check("unregistering a run releases anyone still waiting on it", result.action === "none");
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  bus.register("r1"); // duplicate register
  bus.signal("r1", { action: "pause" });
  const result = await bus.waitForControl("r1", 1_000);
  check("re-registering an already-tracked run does not orphan its queue", result.action === "pause");
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  bus.register("r2");
  const e1 = bus.register("r1");
  const e2 = bus.register("r2");
  let sawOnR2 = false;
  e2.on("event", () => (sawOnR2 = true));
  let sawOnR1 = false;
  e1.on("event", () => (sawOnR1 = true));
  bus.pushTrace("r1", sampleEvent());
  check("an event pushed to one run never reaches another run's emitter", sawOnR1 && !sawOnR2);
})();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

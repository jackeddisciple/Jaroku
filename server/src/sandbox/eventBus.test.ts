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

// --- what a run may park on the bus, and what a second poll means -------------------------
//
// waitForControl is reachable from a sandbox over HTTP, so "how many of these can one run have
// open" is a question a hostile run gets to answer. It used to be "as many as it can open
// sockets", each with a live timer — and signal() hands its action to exactly ONE waiter, so a
// run that parked a hundred abandoned polls made a real pause a 1-in-101 shot.

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  const first = bus.waitForControl("r1", 30_000);
  const second = bus.waitForControl("r1", 30_000);
  const third = bus.waitForControl("r1", 30_000);
  // Two earlier polls, superseded: they resolve now rather than sitting on the action.
  check("an earlier poll is released when a newer one arrives", (await first).action === "none");
  check("...and so is the one after it", (await second).action === "none");

  bus.signal("r1", { action: "pause" });
  check("the pause reaches the poll that is actually live", (await third).action === "pause");
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  // A hundred abandoned polls, then the real one. Before superseding, signal() would hand the
  // pause to whichever of the hundred came first and this run would never see it.
  const abandoned = Array.from({ length: 100 }, () => bus.waitForControl("r1", 30_000));
  const live = bus.waitForControl("r1", 30_000);
  bus.signal("r1", { action: "pause" });
  const settled = await Promise.all([...abandoned, live]);
  check("a hundred parked polls do not swallow the pause", settled[100]!.action === "pause");
  check(
    "...and every abandoned one was released rather than left holding a timer",
    settled.slice(0, 100).every((a) => a.action === "none"),
  );
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  // Nobody polling. Pause/resume are last-write-wins: replaying the whole history to a runner
  // that finally asks would resume a run the user has since paused.
  bus.signal("r1", { action: "pause" });
  bus.signal("r1", { action: "resume" });
  bus.signal("r1", { action: "pause" });
  check("queued pause/resume collapse to the latest intent", (await bus.waitForControl("r1", 10)).action === "pause");
  check("...with nothing stale behind it", (await bus.waitForControl("r1", 10)).action === "none");
})();

await (async () => {
  const bus = new RunEventBus();
  bus.register("r1");
  for (let i = 0; i < 5_000; i++) {
    bus.signal("r1", { action: "mcp-confirm", nonce: `n${i}`, verdict: "deny" });
  }
  let drained = 0;
  for (;;) {
    const a = await bus.waitForControl("r1", 1);
    if (a.action === "none") break;
    drained++;
    if (drained > 200) break;
  }
  check(`a run nobody polls for cannot park unbounded actions (held ${drained})`, drained <= 64);
  check("and what it kept is the most recent, not the oldest", drained > 0);
})();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

// The per-workspace interactive reservation, and the one way it used to be lost.
//
//   npm run test:interactive-slot

import { randomUUID } from "node:crypto";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";
import { InteractiveSlots } from "./interactiveSlot.ts";
import { semaphoreKey } from "./queue/semaphores.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const keyFor = (workspaceId: string): string =>
  semaphoreKey("run.interactive", { kind: "workspace", workspaceId });

console.log("\none reservation per workspace, released by the run's exit");
{
  const backend = new InMemoryQueueBackend();
  const slots = new InteractiveSlots(backend, randomUUID);

  check(await slots.reserve("ws-a", "run-1"), "a workspace's first interactive run reserves");
  check((await backend.semaphoreCount(keyFor("ws-a"))) === 1, "and the cap reflects it");
  check(!(await slots.reserve("ws-a", "run-2")), "its second is refused — the cap is one");
  check(await slots.reserve("ws-b", "run-3"), "another workspace is unaffected by the first's cap");

  await slots.release("ws-a", "run-1");
  check((await backend.semaphoreCount(keyFor("ws-a"))) === 0, "releasing hands the slot back");
  check(await slots.reserve("ws-a", "run-4"), "and the workspace can run again");
}

console.log("\nreleasing something that never reserved");
{
  const backend = new InMemoryQueueBackend();
  const slots = new InteractiveSlots(backend, randomUUID);
  // Every exit event goes through release, including an eval job's — which never reserved.
  await slots.release("ws-a", "an-eval-job-run");
  await slots.reserve("ws-a", "run-1");
  await slots.release("ws-a", "run-1");
  await slots.release("ws-a", "run-1"); // twice
  check((await backend.semaphoreCount(keyFor("ws-a"))) === 0, "is a harmless no-op, not an under-count");
  check(slots.held === 0, "and nothing is left tracked");
}

console.log("\na start that does not happen");
{
  // THE BUG. index.ts reserved, then called pool.tryStart(...) and discarded its boolean. The
  // reservation is released by the run's own exit event — so when tryStart returned false there
  // was no run, no exit, and nothing to release it. The interactive cap is ONE per workspace on
  // an hour-long lease, so that workspace could not start anything interactive for an hour.
  //
  // tryStart returns false whenever every pool slot is taken. The process-wide `pool.busy` check
  // upstream makes that unlikely for ONE workspace, but it is a different check: two workspaces'
  // runAgent calls interleave freely, take DIFFERENT workspace semaphores so neither refuses the
  // other, and then contend for the same single pool slot. The loser is exactly this case.
  const backend = new InMemoryQueueBackend();
  const slots = new InteractiveSlots(backend, randomUUID);

  const outcome = await slots.reserveAndStart("ws-a", "run-1", () => false);
  check(outcome === "no-slot", `a refused start reports why (got ${outcome})`);
  check(
    (await backend.semaphoreCount(keyFor("ws-a"))) === 0,
    "and the reservation is handed straight back rather than waiting out its lease",
  );
  check(slots.held === 0, "nothing is left tracked against a run that never existed");

  const second = await slots.reserveAndStart("ws-a", "run-2", () => true);
  check(second === "started", "so the very next attempt can reserve — no hour-long lockout");
}

console.log("\ntwo workspaces racing one pool slot");
{
  // Both are allowed by their own per-workspace cap; only one gets the slot. The point is what
  // happens to the loser's reservation.
  const backend = new InMemoryQueueBackend();
  const slots = new InteractiveSlots(backend, randomUUID);
  let poolFree = 1;
  const tryStart = (): boolean => {
    if (poolFree <= 0) return false;
    poolFree--;
    return true;
  };

  const [a, b] = await Promise.all([
    slots.reserveAndStart("ws-a", "run-a", tryStart),
    slots.reserveAndStart("ws-b", "run-b", tryStart),
  ]);
  check(
    [a, b].filter((o) => o === "started").length === 1 && [a, b].filter((o) => o === "no-slot").length === 1,
    `one started and one was refused the slot (got ${a} / ${b})`,
  );
  const held = (await backend.semaphoreCount(keyFor("ws-a"))) + (await backend.semaphoreCount(keyFor("ws-b")));
  check(held === 1, `only the workspace that actually ran is holding a reservation (${held} held)`);
}

console.log("\na start that throws");
{
  const backend = new InMemoryQueueBackend();
  const slots = new InteractiveSlots(backend, randomUUID);
  let threw = false;
  try {
    await slots.reserveAndStart("ws-a", "run-1", () => {
      throw new Error("the sandbox factory blew up");
    });
  } catch {
    threw = true;
  }
  check(threw, "the error reaches the caller rather than being swallowed");
  check(
    (await backend.semaphoreCount(keyFor("ws-a"))) === 0,
    "and the reservation is still handed back on the way out",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

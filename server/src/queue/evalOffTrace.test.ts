// "Eval runs stay off the live trace channel" — re-proven under Session 5's cross-replica
// fan-out, which is the thing that could plausibly have broken it.
//
// The property (README, the eval engine): twenty parallel eval runs' events persist normally
// but must NOT broadcast on `trace`, or a fan-out yanks the timeline away from whatever the
// user was actually reading. Before this session that was one `if (!isEvalRun(runId))` in one
// process and nothing else could reach a socket. Now a SECOND path exists — another replica
// publishes, this one delivers via deliverFromPeer — and the honest question is whether an
// eval's events can arrive through that back door having skipped the gate.
//
// THE ANSWER, AND WHY IT IS STRUCTURAL RATHER THAN LUCKY: the bridge hook fires inside
// broadcastTo, which is DOWNSTREAM of the isEvalRun check. An eval run's step never calls
// broadcastTrace at all, so it never reaches broadcastTo, so it is never published, so no
// replica can receive it. There is no eval-specific logic in the bridge and there deliberately
// isn't any — the filtering already happened before the bridge could ever see it. This suite
// asserts exactly that, at the seam where it matters.
//
//   npm run test:eval-off-trace

import { EventBridge, type PubSubClient } from "./eventBridge.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Every attached client sees every publish, including the sender — like real Redis. */
class FakeBroker {
  private listeners: Array<(channel: string, message: string) => void> = [];
  client(): PubSubClient {
    const broker = this;
    return {
      async publish(channel: string, message: string): Promise<number> {
        setTimeout(() => {
          for (const l of [...broker.listeners]) l(channel, message);
        }, 0);
        return broker.listeners.length;
      },
      async subscribe(): Promise<unknown> {
        return 1;
      },
      on(_e: "message", listener: (channel: string, message: string) => void): unknown {
        broker.listeners.push(listener);
        return this;
      },
      duplicate(): PubSubClient {
        return broker.client();
      },
      async quit(): Promise<unknown> {
        return "OK";
      },
    };
  }
}

/**
 * The gate exactly as index.ts applies it, standing in for the ingest handler: an eval run's
 * events are persisted (not modelled here — that half is evalDispatch.test.ts's) and simply
 * never handed to the broadcaster. `broadcast` is what WsRelay.broadcastTrace would call.
 */
function ingestTraceEvent(
  runId: string,
  isEvalRun: (id: string) => boolean,
  broadcast: (payload: unknown) => void,
): void {
  if (!isEvalRun(runId)) broadcast({ channel: "trace", runId });
}

console.log("\ntwenty parallel eval runs, one interactive run, one replica publishing to another");
{
  const broker = new FakeBroker();
  const replicaA = EventBridge.withClient(broker.client()); // where the eval is draining
  const replicaB = EventBridge.withClient(broker.client()); // where the user's browser is

  // What replica B's sockets would actually receive.
  const deliveredToB: Array<{ channel?: string; runId?: string }> = [];
  await replicaB.subscribe((_ws, payload) => deliveredToB.push(payload as { channel?: string; runId?: string }));

  const evalRunIds = new Set<string>();
  for (let i = 0; i < 20; i++) evalRunIds.add(`eval-run-${i}`);
  const isEvalRun = (id: string): boolean => evalRunIds.has(id);

  // Replica A ingests events for twenty eval runs and one interactive run, applying the same
  // gate index.ts applies, and publishing whatever survives it.
  const publishFromA = (payload: unknown): void => replicaA.publish("ws-1", payload);
  for (const runId of evalRunIds) ingestTraceEvent(runId, isEvalRun, publishFromA);
  ingestTraceEvent("the-users-own-run", isEvalRun, publishFromA);

  await sleep(100);

  const traceMessages = deliveredToB.filter((m) => m.channel === "trace");
  check(
    traceMessages.length === 1,
    `exactly one trace message crossed to the other replica, not twenty-one (got ${traceMessages.length})`,
  );
  check(
    traceMessages[0]?.runId === "the-users-own-run",
    `and it is the interactive run's, not an eval's (got ${traceMessages[0]?.runId})`,
  );
  check(
    !deliveredToB.some((m) => typeof m.runId === "string" && m.runId.startsWith("eval-run-")),
    "no eval run's id appears anywhere in what the other replica received",
  );

  await replicaA.close();
  await replicaB.close();
}

console.log("\nand the gate is what does it — remove it and the same setup floods");
{
  // The control case. Without this, the assertions above would pass equally well if the
  // bridge were simply broken and delivered nothing at all, which would prove nothing.
  const broker = new FakeBroker();
  const replicaA = EventBridge.withClient(broker.client());
  const replicaB = EventBridge.withClient(broker.client());
  const deliveredToB: Array<{ runId?: string }> = [];
  await replicaB.subscribe((_ws, payload) => deliveredToB.push(payload as { runId?: string }));

  const neverAnEval = (): boolean => false; // the gate, disabled
  for (let i = 0; i < 20; i++) {
    ingestTraceEvent(`eval-run-${i}`, neverAnEval, (p) => replicaA.publish("ws-1", p));
  }
  await sleep(100);

  check(
    deliveredToB.length === 20,
    `with the gate disabled all twenty do cross — so the bridge genuinely works and the gate is ` +
      `what stops them (got ${deliveredToB.length})`,
  );

  await replicaA.close();
  await replicaB.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

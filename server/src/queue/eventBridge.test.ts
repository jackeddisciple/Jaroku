// The cross-replica bridge, against a real Redis when there is one.
//
// Unlike every other suite in this directory, the interesting behaviour here CANNOT be
// exercised in-memory: what is under test is precisely that two separate processes' relays
// see each other's broadcasts, and a fake pub/sub only ever proves the fake works. So the
// self-echo assertion (the one bug this design exists to avoid) runs against real Redis, and
// the whole thing SKIPS loudly without one rather than passing vacuously.
//
//   docker compose up -d redis
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run test:event-bridge

import { EventBridge, type PubSubClient } from "./eventBridge.ts";
import { openRedis, pingRedis, redisUrlFromEnv } from "./redis.ts";

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

console.log("\nwithout Redis configured, there is no bridge at all");
check(EventBridge.create({ env: {} }) === undefined, "create() returns undefined rather than a broken bridge");

// --- the envelope logic, against an in-process broker -----------------------------------
//
// One shared FakeBroker stands in for Redis's pub/sub fabric: every client attached to it
// receives every publish, INCLUDING the one that sent it — which is exactly how real Redis
// behaves, and precisely the thing EventBridge's origin tagging has to defend against.
class FakeBroker {
  private listeners: Array<(channel: string, message: string) => void> = [];
  publishCount = 0;

  client(): PubSubClient {
    const broker = this;
    return {
      async publish(channel: string, message: string): Promise<number> {
        broker.publishCount++;
        // Async, like a real round trip - so a re-publish-on-receive bug would actually get
        // the chance to recurse rather than being flattened into one synchronous call.
        setTimeout(() => {
          for (const l of [...broker.listeners]) l(channel, message);
        }, 0);
        return broker.listeners.length;
      },
      async subscribe(): Promise<unknown> {
        return 1;
      },
      on(_event: "message", listener: (channel: string, message: string) => void): unknown {
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

console.log("\nthe envelope logic, with an in-process broker (no Redis needed)");
{
  const broker = new FakeBroker();
  const replicaA = EventBridge.withClient(broker.client());
  const replicaB = EventBridge.withClient(broker.client());

  const seenByA: Array<{ workspaceId: string; payload: unknown }> = [];
  const seenByB: Array<{ workspaceId: string; payload: unknown }> = [];
  await replicaA.subscribe((workspaceId, payload) => seenByA.push({ workspaceId, payload }));
  await replicaB.subscribe((workspaceId, payload) => seenByB.push({ workspaceId, payload }));

  replicaA.publish("ws-1", { channel: "trace", marker: "from-A" });
  await sleep(50);

  check(seenByB.length === 1, `replica B received A's broadcast (got ${seenByB.length})`);
  check(seenByB[0]?.workspaceId === "ws-1", "carrying the workspace it belongs to");
  check((seenByB[0]?.payload as { marker?: string })?.marker === "from-A", "with the payload intact");
  check(
    seenByA.length === 0,
    `replica A dropped its OWN publish (got ${seenByA.length}) - it delivered locally already, ` +
      `so accepting it back would double every message on the originating replica`,
  );

  // The ping-pong check: the broker counts publishes, so a re-publish-on-receive bug shows up
  // as a count that keeps climbing rather than staying at the one call actually made.
  const publishesAfterOne = broker.publishCount;
  await sleep(100);
  check(publishesAfterOne === 1, `one publish() call produced exactly one publish (got ${publishesAfterOne})`);
  check(broker.publishCount === 1, "and no replica re-published what it received - no infinite ping-pong");

  await replicaA.close();
  await replicaB.close();
}

console.log("\nan unparseable message is dropped rather than crashing the subscriber");
{
  const broker = new FakeBroker();
  const bridge = EventBridge.withClient(broker.client());
  const seen: unknown[] = [];
  await bridge.subscribe((_ws, payload) => seen.push(payload));

  const raw = broker.client();
  await raw.publish("jaroku:relay:events", "{not json at all");
  await sleep(50);
  check(seen.length === 0, "nothing was delivered from the garbage message");

  // ...and the subscriber still works afterwards, which is the actual point.
  const other = EventBridge.withClient(broker.client());
  other.publish("ws-after", { channel: "trace", marker: "still-alive" });
  await sleep(50);
  check(seen.length === 1, "a good message right after a bad one still arrives");
  await bridge.close();
  await other.close();
}

const url = redisUrlFromEnv();
if (!url) {
  console.log(
    `\nSKIPPED: no JAROKU_REDIS_URL. Start one with \`docker compose up -d redis\` and set\n` +
      `  JAROKU_REDIS_URL=redis://127.0.0.1:6380\n` +
      `to run the cross-replica assertions, which cannot be faked in-memory.`,
  );
} else {
  const probe = openRedis({ url });
  const reachable = await pingRedis(probe);
  probe.disconnect();
  if (!reachable) {
    console.log(`\nSKIPPED: JAROKU_REDIS_URL is set but unreachable at ${url}`);
  } else {
    // Two bridges = two gateway replicas, each with its own origin id.
    const replicaA = EventBridge.create({ url })!;
    const replicaB = EventBridge.create({ url })!;

    const seenByA: Array<{ workspaceId: string; payload: unknown }> = [];
    const seenByB: Array<{ workspaceId: string; payload: unknown }> = [];
    await replicaA.subscribe((workspaceId, payload) => seenByA.push({ workspaceId, payload }));
    await replicaB.subscribe((workspaceId, payload) => seenByB.push({ workspaceId, payload }));
    await sleep(200); // let both subscriptions actually establish

    console.log("\na broadcast on one replica reaches the other");
    replicaA.publish("ws-1", { channel: "trace", marker: "from-A" });
    for (let i = 0; i < 50 && seenByB.length < 1; i++) await sleep(20);

    check(seenByB.length === 1, `replica B received A's broadcast (got ${seenByB.length})`);
    check(seenByB[0]?.workspaceId === "ws-1", "with the workspace it belongs to");
    check(
      (seenByB[0]?.payload as { marker?: string })?.marker === "from-A",
      "and the payload intact",
    );

    console.log("\nand never comes back to the replica that sent it");
    check(
      seenByA.length === 0,
      `replica A did NOT receive its own publish (got ${seenByA.length}) - it already delivered locally, ` +
        `so receiving it again would double every message on the originating replica`,
    );

    console.log("\nreceiving does not re-publish - two replicas cannot ping-pong forever");
    {
      // If deliverFromPeer's path re-entered publish(), this single message would bounce
      // between A and B without end. Publish once, wait well past several round trips, and
      // assert each side saw exactly what it should have and nothing more.
      const beforeA = seenByA.length;
      const beforeB = seenByB.length;
      replicaB.publish("ws-2", { channel: "eval", marker: "from-B" });
      await sleep(600); // many round trips' worth of time for a loop to become obvious
      check(seenByA.length === beforeA + 1, `replica A saw B's message exactly once (delta ${seenByA.length - beforeA})`);
      check(seenByB.length === beforeB, `replica B still never sees its own (delta ${seenByB.length - beforeB})`);
    }

    console.log("\na workspace's events carry their workspace, so the receiver can scope them");
    {
      const beforeB = seenByB.length;
      replicaA.publish("ws-alpha", { channel: "trace", marker: "alpha" });
      replicaA.publish("ws-beta", { channel: "trace", marker: "beta" });
      for (let i = 0; i < 50 && seenByB.length < beforeB + 2; i++) await sleep(20);
      const got = seenByB.slice(beforeB);
      check(got.length === 2, `both arrived (got ${got.length})`);
      check(
        got.some((m) => m.workspaceId === "ws-alpha") && got.some((m) => m.workspaceId === "ws-beta"),
        "each labelled with its own workspace, never merged or mixed up",
      );
    }

    await replicaA.close();
    await replicaB.close();
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

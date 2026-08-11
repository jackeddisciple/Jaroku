// Fans a broadcast out across gateway replicas over Redis pub/sub — the "N stateless
// replicas" half of the target architecture (doc §3): today, an eval draining in one gateway
// process only updates that process's own in-memory bookkeeping, so a client connected to a
// DIFFERENT replica than the one running the eval never hears about it. Every WsRelay method
// already funnels through one function, broadcastTo — see wsRelay.ts's own note — so this
// hooks that one function rather than needing to touch every channel individually.
//
// SELF-ECHO IS THE ONE REAL HAZARD. This process's own broadcastTo already delivered locally
// before the hook fires; if it also received its own publish back over the subscription, every
// message would be delivered twice on the replica that originated it, and — worse — with
// naive re-publishing on receipt, two replicas would bounce the same message back and forth
// forever. Each bridge is tagged with a random id at construction and stamps every publish
// with it; the subscriber drops anything carrying its own id, and NEVER re-publishes what it
// receives — only WsRelay.deliverFromPeer, which does not loop back through the hook.
//
// ABSENT REDIS, THIS IS A NO-OP BY CONSTRUCTION — not a special case. `create()` returns
// `undefined` when no URL is configured, and index.ts wires WsRelay's `onBroadcast` only when
// it gets a real bridge back, so `npm run dev` with nothing installed behaves exactly as it
// did before this file existed: single replica, no publish, no subscribe.

import { randomUUID } from "node:crypto";
import { openRedis, redisUrlFromEnv } from "./redis.ts";

const CHANNEL = "jaroku:relay:events";

interface Envelope {
  origin: string;
  workspaceId: string;
  payload: unknown;
}

/**
 * The slice of ioredis this module actually uses.
 *
 * Named as an interface so the envelope logic below — origin tagging, dropping our own
 * publish, never re-publishing what we receive — is testable with an in-process double on a
 * machine with no Redis. That logic is the entire reason this file exists and is exactly
 * where the ping-pong bug would live, so "only testable against real infrastructure" would be
 * the wrong trade. The cross-process assertions that genuinely need a real broker still run
 * against one, and still skip loudly without it — see eventBridge.test.ts.
 */
export interface PubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  duplicate(): PubSubClient;
  quit(): Promise<unknown>;
}

export class EventBridge {
  private readonly origin = randomUUID();
  private sub: PubSubClient | null = null;

  private constructor(private pub: PubSubClient) {}

  /** `undefined` when JAROKU_REDIS_URL is not set — see the file header. */
  static create(opts: { url?: string; env?: NodeJS.ProcessEnv } = {}): EventBridge | undefined {
    const url = redisUrlFromEnv(opts);
    if (!url) return undefined;
    return new EventBridge(openRedis({ url }) as unknown as PubSubClient);
  }

  /** For tests: a bridge over an in-process double rather than a real connection. */
  static withClient(client: PubSubClient): EventBridge {
    return new EventBridge(client);
  }

  /** Tell every OTHER replica about a broadcast this one already delivered locally. */
  publish(workspaceId: string, payload: unknown): void {
    const envelope: Envelope = { origin: this.origin, workspaceId, payload };
    void this.pub.publish(CHANNEL, JSON.stringify(envelope)).catch((err) => {
      console.error("[event-bridge] publish failed:", (err as Error).message);
    });
  }

  /**
   * Start delivering what other replicas publish to sockets on this one. `deliver` is
   * WsRelay.deliverFromPeer bound to a context built from the envelope's workspaceId — this
   * module has no TenantContext of its own to construct, on purpose: minting one correctly
   * (a request id, a role) is the caller's job, not a queue module's.
   */
  async subscribe(deliver: (workspaceId: string, payload: unknown) => void): Promise<void> {
    if (this.sub) return;
    this.sub = this.pub.duplicate();
    this.sub.on("message", (_channel, raw) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(raw) as Envelope;
      } catch {
        console.error("[event-bridge] dropped an unparseable message");
        return;
      }
      if (envelope.origin === this.origin) return; // our own publish, already delivered locally
      deliver(envelope.workspaceId, envelope.payload);
    });
    await this.sub.subscribe(CHANNEL);
  }

  async close(): Promise<void> {
    await this.sub?.quit();
    await this.pub.quit();
  }
}

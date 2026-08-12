// Discovery, off the request path.
//
// A handshake against a third-party MCP server is a network round trip to somebody else's
// infrastructure, and the client is a browser waiting for an answer on a socket. `mcpClient.ts`
// has always bounded it — a per-request timeout AND a whole-discovery deadline, because a server
// answering each page just inside the request timeout would otherwise stall forever legally — so
// the worst case was already thirty seconds rather than never. What it was not bounded by is
// HOW MANY of them can be in flight at once.
//
// THAT IS THE PART THAT DOES NOT SURVIVE SIX THOUSAND WORKSPACES. Thirty seconds of a request
// handler is fine when there is one user; it is a hundred concurrent sockets each holding a
// pending fetch against a server that has decided to be slow, on the same replicas that answer
// every other command, when there are many. And it is not even hostility that gets you there —
// a popular MCP endpoint having a bad afternoon is enough, because every workspace that connected
// it retries at once.
//
// So discovery becomes a job: enqueued with a workspace on it, drained at a per-workspace
// concurrency the dispatcher enforces, and answered on the `mcp` channel when it finishes. The
// panel already renders a `discovering` state — it was built for the seconds a synchronous
// handshake took — so nothing about the interface changes except that the wait is now bounded by
// a queue rather than by a socket.
//
// THE IDEMPOTENCY KEY IS THE WORKSPACE AND THE SERVER, WITH NO ATTEMPT NUMBER IN IT. Somebody
// mashing "Re-discover" enqueues one unit of work, not six — which is the whole reason the queue
// takes a key at all, and it is the same reasoning `buildIdempotencyKey` documents for eval jobs.
// A re-discovery is idempotent by nature: it replaces the tool list with whatever the server says
// now, so doing it twice is doing it once.
//
// AND EVERY PROPERTY THE SYNCHRONOUS PATH HAD SURVIVES, because the work itself is unchanged —
// this file enqueues and drains, and `McpRegistry` still does the discovering. In particular a
// FAILED REFRESH STILL NEVER DESTROYS A WORKING TOOL LIST: that rule lives in `rediscover`, which
// updates the status and leaves the tools alone, and moving the call onto a queue does not reach
// it. `test:mcp-discovery-queue` re-proves it through the queue anyway, because a property that
// is only true because of where a function is called from is a property one refactor away from
// being false.

import { buildIdempotencyKey, type JobClass, type QueueJob } from "./queue/jobs.ts";
import type { Dispatcher } from "./queue/dispatcher.ts";
import type { TenantContext } from "./db/tenant.ts";
import { newRequestId, systemContextFor } from "./db/tenant.ts";
import type { McpRegistry, RegistrationResult } from "./mcpRegistry.ts";

export const MCP_DISCOVER_CLASS: JobClass = "mcp.discover";

/**
 * What one discovery job carries.
 *
 * NO CREDENTIAL, and that is deliberate rather than incidental. A token on a payload is a token
 * in whatever the queue is backed by — Redis, in production, which is neither encrypted at rest
 * nor scoped to a tenant. The job says WHICH server, and the handler reads the credential from
 * the workspace's own vault at the moment it makes the call, exactly as the synchronous path did.
 */
export interface McpDiscoveryPayload {
  /** `add` registers a new server; `rediscover` re-runs the handshake against an existing one. */
  kind: "add" | "rediscover";
  workspaceId: string;
  /** Who asked, for the audit row and for the context the answer is broadcast to. */
  actorUserId: string | null;
  serverId: string;
  /** Only on `add`. On a rediscover the endpoint comes from the row, which is the truth. */
  endpoint?: string;
  label?: string;
  /**
   * Whether a credential was supplied with the registration.
   *
   * A FLAG, NEVER THE VALUE. The token is written to the vault BEFORE the job is enqueued, so by
   * the time this payload exists there is nothing left to carry — see the interface note above.
   */
  hasToken?: boolean;
}

export interface McpDiscoveryOptions {
  dispatcher: Dispatcher;
  registry: McpRegistry;
  /** Told when a job finishes, so the app can broadcast a snapshot and a message. */
  onResult?: (ctx: TenantContext, payload: McpDiscoveryPayload, result: RegistrationResult) => void;
  /** Told when the handler itself threw, which is a bug rather than a failed handshake. */
  onError?: (ctx: TenantContext, payload: McpDiscoveryPayload, error: unknown) => void;
}

export class McpDiscoveryQueue {
  constructor(private readonly opts: McpDiscoveryOptions) {}

  /**
   * Put a discovery on the queue.
   *
   * Returns the job so a caller can report that it was accepted — which is the honest answer to
   * "connect this server" now, rather than the outcome of a handshake that has not happened yet.
   */
  async enqueue(ctx: TenantContext, payload: Omit<McpDiscoveryPayload, "workspaceId" | "actorUserId">):
    Promise<QueueJob<McpDiscoveryPayload>> {
    const full: McpDiscoveryPayload = {
      ...payload,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.actorUserId,
    };
    // See the file header: the workspace and the server, and nothing that varies per press.
    const idempotencyKey = buildIdempotencyKey(MCP_DISCOVER_CLASS, ctx.workspaceId, payload.serverId);

    // PURGE, THEN ENQUEUE — which is how a key becomes a collapse rather than a label.
    //
    // The queue does not deduplicate on its own, deliberately: `idempotencyKey` exists so that a
    // REDELIVERED job is recognised as the same unit of work, and an eval fan-out genuinely wants
    // its five hundred jobs enqueued. Collapsing is this caller's decision, and it is the right
    // one here for a reason specific to discovery: the work is idempotent by nature — it replaces
    // the tool list with whatever the server says NOW — so six pending copies would be six round
    // trips to one third-party endpoint producing one outcome. The last one wins either way; the
    // only question is how many times somebody else's server is asked.
    //
    // A job already ADMITTED is unaffected, which `purgePending` says plainly. That is correct:
    // it is already talking to the server, and the fresh one behind it will re-read whatever it
    // wrote. Best-effort collapse, exact result.
    await this.opts.dispatcher.backend
      .purgePending(MCP_DISCOVER_CLASS, ctx.workspaceId, new Set([idempotencyKey]))
      .catch(() => 0);

    return this.opts.dispatcher.enqueue(MCP_DISCOVER_CLASS, ctx.workspaceId, full, { idempotencyKey });
  }

  /**
   * The handler a worker loop registers for this class.
   *
   * ACKS ITSELF, ALWAYS, INCLUDING ON FAILURE. A discovery that could not complete has still
   * finished — the row records the status and the error, which is the outcome — and leaving the
   * lease to expire would mean a server that is merely unreachable blocks its workspace's
   * discovery slot for the lease TTL. That is the distinction the worker loop's header draws
   * between "the handler returned" and "the work is settled"; here they are the same moment.
   */
  handler(): (job: QueueJob<McpDiscoveryPayload>, leaseId: string) => Promise<void> {
    return async (job, leaseId) => {
      const payload = job.payload;
      // A system context scoped to the payload's workspace. Not the requester's — a job outlives
      // the socket that enqueued it, and by the time this runs the asking context is gone. The
      // WORKSPACE is what authorises the work, and it came off the job rather than off anything
      // the handler was told.
      const ctx = systemContextFor(payload.workspaceId, newRequestId());
      try {
        const result =
          payload.kind === "add"
            ? await this.opts.registry.addServer(ctx, {
                endpoint: payload.endpoint ?? "",
                label: payload.label,
                id: payload.serverId,
              })
            : await this.opts.registry.rediscover(ctx, payload.serverId);
        this.opts.onResult?.(ctx, payload, result);
      } catch (err) {
        // A throw here is a bug, not a failed handshake — `addServer` and `rediscover` classify
        // every network failure and return rather than throwing. Reported and swallowed, because
        // a worker loop that dies on one workspace's bad server stops draining for everybody.
        this.opts.onError?.(ctx, payload, err);
      } finally {
        await this.opts.dispatcher.ack(MCP_DISCOVER_CLASS, leaseId).catch(() => {});
      }
    };
  }
}

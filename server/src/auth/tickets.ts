// The single-use credential a WebSocket is opened with.
//
// See migration 010 for why the ticket exists rather than a JWT in the query string or a
// cookie. This module is the two implementations and the rules both must satisfy.
//
// TWO IMPLEMENTATIONS, AS EVERYWHERE ELSE HERE. `memoryTicketStore` is the default and needs
// nothing running, which is the property hard rule 5 protects — `npm run dev` still starts
// with no Postgres, no Redis, no Docker. `DbTicketStore` is the one that works when there is
// more than one server process, because a ticket issued by replica 1 has to be consumable by
// replica 2, and an in-process Map is not.
//
// THE SPEC SAYS REDIS, and this is deliberately not Redis yet. There is no Redis client in
// this codebase — Session 5 introduces one, along with the queues and pub/sub that actually
// need it — and a `DELETE … RETURNING` against the Postgres already here has exactly the
// property `GETDEL` was wanted for: one caller wins, atomically, across replicas. When Session
// 5 lands, `RedisTicketStore` goes behind this same interface and nothing above it changes.
//
// FOUR RULES, and every one of them is load-bearing:
//
//   SINGLE USE. Consumption deletes. A ticket that could be replayed is a bearer credential in
//   a URL, which is the thing this design exists to avoid.
//   SHORT. Thirty seconds is a page load, not a session.
//   HASHED AT REST. The store holds a digest, so a copy of it is not a set of credentials.
//   SCOPED. A ticket names one workspace, and the socket it opens can act in no other.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MemberRole, Role, TenantContext } from "../db/tenant.ts";

/** How long a ticket is worth anything. A page load, not a session. */
export const TICKET_TTL_S = 30;

export interface Ticket {
  workspaceId: string;
  userId: string | null;
  role: Role;
  /** Unix milliseconds. */
  expiresAt: number;
}

export interface IssuedTicket {
  /** The only time the raw value exists anywhere. Handed to the client and forgotten. */
  ticket: string;
  expiresAt: number;
}

export interface TicketStore {
  /**
   * Mint a ticket for the caller's own workspace.
   *
   * Takes a TenantContext, so a ticket for a workspace can only be issued by a request that
   * already resolved to it — the membership check happens before this is reached, and there is
   * no argument here that could ask for a different one.
   */
  issue(ctx: TenantContext, ttlS?: number): Promise<IssuedTicket>;
  /**
   * Redeem a ticket, exactly once.
   *
   * No context, and that is not an oversight: this is the operation that PRODUCES the scope.
   * The same reasoning as `SystemContext` in tenant.ts — an unscoped operation that says so in
   * its signature beats one pretending to a scope it is in the middle of establishing.
   */
  consume(raw: string): Promise<Ticket | null>;
  /** Drop every ticket for a workspace, or for one member of it. On revocation. */
  revoke(workspaceId: string, userId?: string): Promise<void>;
  /** Delete what has expired. Cheap, and called opportunistically rather than scheduled. */
  sweep(): Promise<number>;
}

/** 256 bits of randomness. Not a uuid: a v4 uuid is 122 bits and reads like an identifier. */
export function mintTicketValue(): string {
  return randomBytes(32).toString("base64url");
}

export function hashTicket(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * A ticket that could not possibly be one, rejected before it reaches a database.
 *
 * `consume` is reachable by anybody who can open a socket, so it is a free query against the
 * store for whoever wants to send them. A shape check costs nothing and turns a scan into
 * an in-process rejection.
 */
export function looksLikeTicket(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length >= 40 && raw.length <= 64 && /^[A-Za-z0-9_-]+$/.test(raw);
}

/**
 * Compare two digests without leaking where they differ.
 *
 * Overkill for a hashed 256-bit random value looked up by primary key — an attacker has
 * nothing to steer with — but the in-memory store compares strings directly, and a
 * short-circuiting comparison in a credential path is a habit worth not having.
 */
export function digestsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The local default. One process, one Map, nothing installed. */
export function memoryTicketStore(now: () => number = () => Date.now()): TicketStore {
  const tickets = new Map<string, Ticket>();
  return {
    async issue(ctx, ttlS = TICKET_TTL_S) {
      const raw = mintTicketValue();
      const expiresAt = now() + ttlS * 1000;
      tickets.set(hashTicket(raw), {
        workspaceId: ctx.workspaceId,
        userId: ctx.actorUserId,
        role: ctx.role,
        expiresAt,
      });
      return { ticket: raw, expiresAt };
    },
    async consume(raw) {
      if (!looksLikeTicket(raw)) return null;
      const hash = hashTicket(raw);
      const found = tickets.get(hash);
      // Deleted whether or not it was still valid: an expired ticket presented once is a
      // ticket that will never be presented usefully again.
      tickets.delete(hash);
      if (!found || found.expiresAt <= now()) return null;
      return found;
    },
    async revoke(workspaceId, userId) {
      for (const [hash, t] of tickets) {
        if (t.workspaceId !== workspaceId) continue;
        if (userId && t.userId !== userId) continue;
        tickets.delete(hash);
      }
    },
    async sweep() {
      let n = 0;
      const at = now();
      for (const [hash, t] of tickets) {
        if (t.expiresAt <= at) {
          tickets.delete(hash);
          n++;
        }
      }
      return n;
    },
  };
}

export type { MemberRole };

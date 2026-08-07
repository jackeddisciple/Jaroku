// The ws-ticket store that survives more than one server process.
//
// See auth/tickets.ts for the interface and the rules, and migration 010 for why the table
// carries no RLS policy. This file's only interesting property is how it makes a ticket
// single-use across replicas, which is the whole reason it exists.
//
// CONSUMPTION IS A DELETE, AND THE DELETE IS THE DECISION. Not "read it, check it, delete it"
// — three statements, and between the first and the third a second request on another replica
// reads the same row and is also admitted. Instead the transaction deletes by primary key and
// reads how many rows it touched: the row is either there and now ours, or it is not. On
// Postgres a concurrent DELETE blocks on the row lock and then re-evaluates its WHERE against
// the committed state, finds nothing, and reports zero. On SQLite there is one connection and
// transactions serialise, so the same holds for a simpler reason.
//
// It is spelled as SELECT-then-DELETE-then-check rather than `DELETE … RETURNING` because the
// `Db` interface's `run()` reports rows affected and not rows returned, and one spelling that
// is correct on both drivers beats two that are each correct on one.

import { asIntOrNull, type Db } from "../db.ts";
import type { Role, SystemContext, TenantContext } from "../tenant.ts";
import {
  TICKET_TTL_S,
  hashTicket,
  looksLikeTicket,
  mintTicketValue,
  type IssuedTicket,
  type Ticket,
  type TicketStore,
} from "../../auth/tickets.ts";

export class DbTicketStore implements TicketStore {
  constructor(
    private db: Db,
    private now: () => number = () => Date.now(),
  ) {}

  async issue(
    ctx: TenantContext,
    opts: { ttlS?: number; tokenExpiresAt?: number | null } = {},
  ): Promise<IssuedTicket> {
    const raw = mintTicketValue();
    const expiresAt = this.now() + (opts.ttlS ?? TICKET_TTL_S) * 1000;
    await this.db.run(
      `INSERT INTO ws_tickets
         (token_hash, workspace_id, user_id, role, expires_at, token_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        hashTicket(raw),
        ctx.workspaceId,
        ctx.actorUserId,
        ctx.role,
        new Date(expiresAt).toISOString(),
        opts.tokenExpiresAt ?? null,
        new Date(this.now()).toISOString(),
      ],
    );
    // Opportunistic rather than scheduled: rows are tiny, few, and live thirty seconds, and a
    // cron job for this would be a moving part with nothing to do. Failure is ignored — a
    // sweep that did not happen costs some dead rows, and it must never fail an issue.
    void this.sweep().catch(() => {});
    return { ticket: raw, expiresAt };
  }

  /**
   * Redeem exactly once.
   *
   * `_ctx` is a SystemContext and unused, and the parameter is here rather than absent because
   * of the boundary rule: every repository method takes a context first, and the type is what
   * says out loud that this one legitimately precedes a workspace. It is the same signature
   * shape `IdentityRepository.provisionUser` has, for the same reason.
   */
  async consume(raw: string, _ctx?: SystemContext): Promise<Ticket | null> {
    if (!looksLikeTicket(raw)) return null;
    const hash = hashTicket(raw);
    return this.db.transaction(async (tx) => {
      const row = await tx.get<{
        workspace_id: string;
        user_id: string | null;
        role: string;
        expires_at: string;
        token_expires_at: number | string | null;
      }>(
        `SELECT workspace_id, user_id, role, expires_at, token_expires_at
           FROM ws_tickets WHERE token_hash = ?`,
        [hash],
      );
      if (!row) return null;
      // The delete is the decision, not the read above it. A second consumer that got here
      // first leaves this at zero rows, and the loser is refused rather than admitted.
      const deleted = await tx.run(`DELETE FROM ws_tickets WHERE token_hash = ?`, [hash]);
      if (deleted.changes === 0) return null;

      const expiresAt = Date.parse(row.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) return null;
      return {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        role: row.role as Role,
        expiresAt,
        // asIntOrNull, not `Number(...) || null`: Postgres hands a bigint back as a string,
        // and an expiry of 0 is not the same as an absent one.
        tokenExpiresAt: asIntOrNull(row.token_expires_at),
      };
    });
  }

  async revoke(workspaceId: string, userId?: string): Promise<void> {
    if (userId) {
      await this.db.run(`DELETE FROM ws_tickets WHERE workspace_id = ? AND user_id = ?`, [workspaceId, userId]);
      return;
    }
    await this.db.run(`DELETE FROM ws_tickets WHERE workspace_id = ?`, [workspaceId]);
  }

  async sweep(): Promise<number> {
    const res = await this.db.run(`DELETE FROM ws_tickets WHERE expires_at <= ?`, [
      new Date(this.now()).toISOString(),
    ]);
    return res.changes;
  }
}

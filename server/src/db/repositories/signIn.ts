// The sign-in store that survives more than one server process.
//
// See `auth/signIn.ts` for the interface and the rules, and migration 053 for why none of these
// five tables carries an RLS policy. This file's interesting property is the one every one of its
// consume methods has, and it is the same one `DbTicketStore` was built around:
//
// CONSUMPTION IS A CONDITIONAL WRITE, AND THE WRITE IS THE DECISION. Not "read it, check it, mark
// it" — three statements, and between the first and the third a second request on another replica
// reads the same row and is also admitted. Instead a single `UPDATE … WHERE consumed_at IS NULL`
// runs first and reports how many rows it touched: the row is either unspent and now ours, or it
// is not. On Postgres a concurrent update blocks on the row lock and then re-evaluates its WHERE
// against the committed state, finds `consumed_at` set, and reports zero. On SQLite there is one
// connection and transactions serialise, so the same holds for a simpler reason.
//
// §3.3's own words for this are "an UPDATE … WHERE consumed_at IS NULL RETURNING * in one query",
// and it is spelled as UPDATE-then-SELECT rather than `RETURNING` because the `Db` interface's
// `run()` reports rows affected and not rows returned. One spelling correct on both drivers beats
// two that are each correct on one — the same trade `DbTicketStore` makes, in the same words.
//
// AND THE ROWS ARE MARKED RATHER THAN DELETED, which is where this differs from `ws_tickets`.
// A deleted ticket cannot tell "already used" from "never existed", and §4.5 wants both to produce
// the SAME message to the user while producing DIFFERENT rows in the audit log — a used ticket is a
// double-click, and an invented one is somebody probing. The sweep is what eventually removes them.

import { asInt, type Db } from "../db.ts";
import {
  MAGIC_LINK_TTL_S,
  OAUTH_STATE_TTL_S,
  SESSION_TICKET_TTL_S,
  hashSecret,
  isSignInProvider,
  looksLikeSecret,
  mintSecret,
  normaliseEmail,
  type MagicLinkRecord,
  type OAuthStateRecord,
  type RateWindow,
  type SessionTicketRecord,
  type SignInProvider,
  type SignInStore,
} from "../../auth/signIn.ts";

export class DbSignInStore implements SignInStore {
  constructor(
    private db: Db,
    private now: () => number = () => Date.now(),
  ) {}

  private iso(at: number): string {
    return new Date(at).toISOString();
  }

  // --- magic links ------------------------------------------------------------------------

  async issueMagicLink(input: {
    email: string;
    ip: string | null;
    userAgent: string | null;
    ttlS?: number;
  }): Promise<{ token: string; expiresAt: number }> {
    const token = mintSecret();
    const expiresAt = this.now() + (input.ttlS ?? MAGIC_LINK_TTL_S) * 1000;
    await this.db.run(
      `INSERT INTO magic_link_tokens (token_hash, email, ip_address, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        hashSecret(token),
        normaliseEmail(input.email),
        input.ip,
        // BOUNDED, because it is a header a client chooses and it is going into a database. Two
        // hundred characters is longer than any real user agent and short enough that somebody
        // sending a megabyte of them is storing a megabyte rather than a gigabyte.
        input.userAgent === null ? null : input.userAgent.slice(0, 200),
        this.iso(this.now()),
        this.iso(expiresAt),
      ],
    );
    // Opportunistic rather than scheduled, exactly as `DbTicketStore.issue` does it: these rows
    // are tiny and short-lived, and a failure here must never fail a sign-in.
    void this.sweep().catch(() => {});
    return { token, expiresAt };
  }

  async consumeMagicLink(token: string, email: string): Promise<MagicLinkRecord | null> {
    if (!looksLikeSecret(token)) return null;
    const hash = hashSecret(token);
    const address = normaliseEmail(email);
    const at = this.iso(this.now());
    return this.db.transaction(async (tx) => {
      // THE EMAIL IS IN THE WHERE CLAUSE, and that is §10's last property made structural: "a
      // token for alice@example.com cannot sign someone in as bob@example.com even if leaked".
      // Checking it after the read would leave a window where the token is spent and the binding
      // has not been tested, and the honest reading of a mismatch is that this is not our token.
      //
      // AND SO IS THE EXPIRY, so an expired token is never marked consumed. §4.5 wants both to say
      // the same thing to the user, and the audit log wants to be able to tell them apart.
      const claimed = await tx.run(
        `UPDATE magic_link_tokens
            SET consumed_at = ?
          WHERE token_hash = ? AND email = ? AND consumed_at IS NULL AND expires_at > ?`,
        [at, hash, address, at],
      );
      if (claimed.changes === 0) return null;
      const row = await tx.get<{ email: string; expires_at: string }>(
        `SELECT email, expires_at FROM magic_link_tokens WHERE token_hash = ?`,
        [hash],
      );
      if (!row) return null;
      return { email: row.email, expiresAt: Date.parse(row.expires_at) };
    });
  }

  // --- oauth state ------------------------------------------------------------------------

  async issueOAuthState(input: {
    provider: SignInProvider;
    codeVerifier: string;
    nonce: string;
    redirectTo?: string | null;
    ttlS?: number;
  }): Promise<{ state: string; expiresAt: number }> {
    const state = mintSecret();
    const expiresAt = this.now() + (input.ttlS ?? OAUTH_STATE_TTL_S) * 1000;
    await this.db.run(
      `INSERT INTO oauth_state_tokens
         (state_hash, provider, code_verifier, nonce_hash, redirect_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        hashSecret(state),
        input.provider,
        input.codeVerifier,
        hashSecret(input.nonce),
        input.redirectTo ?? null,
        this.iso(this.now()),
        this.iso(expiresAt),
      ],
    );
    void this.sweep().catch(() => {});
    return { state, expiresAt };
  }

  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    if (!looksLikeSecret(state)) return null;
    const hash = hashSecret(state);
    const at = this.iso(this.now());
    return this.db.transaction(async (tx) => {
      const claimed = await tx.run(
        `UPDATE oauth_state_tokens
            SET consumed_at = ?
          WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        [at, hash, at],
      );
      if (claimed.changes === 0) return null;
      const row = await tx.get<{
        provider: string;
        code_verifier: string;
        nonce_hash: string;
        redirect_to: string | null;
        expires_at: string;
      }>(
        `SELECT provider, code_verifier, nonce_hash, redirect_to, expires_at
           FROM oauth_state_tokens WHERE state_hash = ?`,
        [hash],
      );
      if (!row || !isSignInProvider(row.provider)) return null;
      return {
        provider: row.provider,
        codeVerifier: row.code_verifier,
        nonceHash: row.nonce_hash,
        redirectTo: row.redirect_to,
        expiresAt: Date.parse(row.expires_at),
      };
    });
  }

  // --- session tickets --------------------------------------------------------------------

  async issueSessionTicket(input: {
    userId: string;
    provider: SignInProvider;
    nonceHash?: string | null;
    ttlS?: number;
  }): Promise<{ ticket: string; expiresAt: number }> {
    const ticket = mintSecret();
    const expiresAt = this.now() + (input.ttlS ?? SESSION_TICKET_TTL_S) * 1000;
    await this.db.run(
      `INSERT INTO session_tickets (ticket_hash, user_id, provider, nonce_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        hashSecret(ticket),
        input.userId,
        input.provider,
        // Absent for the magic link, and that is the flow working as specified rather than a
        // binding somebody forgot — §10 wants a link clicked on a second device to sign that
        // device in, and there is no nonce there to bind to. See migration 053.
        input.nonceHash ?? null,
        this.iso(this.now()),
        this.iso(expiresAt),
      ],
    );
    void this.sweep().catch(() => {});
    return { ticket, expiresAt };
  }

  async consumeSessionTicket(ticket: string): Promise<SessionTicketRecord | null> {
    if (!looksLikeSecret(ticket)) return null;
    const hash = hashSecret(ticket);
    const at = this.iso(this.now());
    return this.db.transaction(async (tx) => {
      const claimed = await tx.run(
        `UPDATE session_tickets
            SET consumed_at = ?
          WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        [at, hash, at],
      );
      if (claimed.changes === 0) return null;
      const row = await tx.get<{
        user_id: string;
        provider: string;
        nonce_hash: string | null;
        expires_at: string;
      }>(
        `SELECT user_id, provider, nonce_hash, expires_at FROM session_tickets WHERE ticket_hash = ?`,
        [hash],
      );
      if (!row || !isSignInProvider(row.provider)) return null;
      return {
        userId: row.user_id,
        provider: row.provider,
        // RETURNED RATHER THAN CHECKED HERE, deliberately. The store's job is single-use
        // consumption; whether the presented nonce matches is the exchange's decision, and it is
        // made in `session.ts` where the request that presented one is. A store that refused on a
        // mismatch would have already spent the ticket by the time it did, which turns a wrong
        // nonce into a ticket nobody can use rather than into a refusal.
        nonceHash: row.nonce_hash,
        expiresAt: Date.parse(row.expires_at),
      };
    });
  }

  // --- rate limits ------------------------------------------------------------------------

  /**
   * Count one attempt, rolling the window when it has run out.
   *
   * A FIXED WINDOW RATHER THAN A SLIDING ONE, and the imprecision is affordable here in a way it
   * would not be on a metered API: the worst a fixed window admits is twice the limit across a
   * boundary — six sign-in emails in a few minutes rather than three — which is an annoyance, and
   * the sliding version costs a row per attempt and a range scan per check on a route a stranger
   * can reach. `http/rateLimit.ts` makes the same trade for the same reason.
   *
   * THE WHOLE THING IS ONE TRANSACTION because two requests for the same address really do arrive
   * together: somebody double-clicking "Continue with email" is the ordinary case, and a
   * read-then-write outside a transaction lets both read 2 and both write 3.
   */
  async countAttempt(key: string, windowS: number): Promise<RateWindow> {
    const now = this.now();
    const cutoff = now - windowS * 1000;
    return this.db.transaction(async (tx) => {
      const row = await tx.get<{ window_start: string; count: number | string }>(
        `SELECT window_start, count FROM magic_link_rate_limits WHERE key = ?`,
        [key],
      );
      const startedAt = row ? Date.parse(row.window_start) : NaN;
      const live = Number.isFinite(startedAt) && startedAt > cutoff;

      if (!row) {
        const inserted = await tx.run(
          `INSERT INTO magic_link_rate_limits (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT (key) DO NOTHING`,
          [key, this.iso(now)],
        );
        // Lost a race with another request for the same key: their row is the real one, so this
        // attempt is counted against it rather than being silently free.
        if (inserted.changes === 0) {
          await tx.run(`UPDATE magic_link_rate_limits SET count = count + 1 WHERE key = ?`, [key]);
          const after = await tx.get<{ window_start: string; count: number | string }>(
            `SELECT window_start, count FROM magic_link_rate_limits WHERE key = ?`,
            [key],
          );
          return { count: asInt(after?.count, 1), windowStart: Date.parse(after?.window_start ?? this.iso(now)) };
        }
        return { count: 1, windowStart: now };
      }

      if (!live) {
        // The window ran out. Restarted rather than incremented, which is what makes this a
        // window rather than a lifetime total.
        await tx.run(`UPDATE magic_link_rate_limits SET window_start = ?, count = 1 WHERE key = ?`, [
          this.iso(now),
          key,
        ]);
        return { count: 1, windowStart: now };
      }

      await tx.run(`UPDATE magic_link_rate_limits SET count = count + 1 WHERE key = ?`, [key]);
      return { count: asInt(row.count, 0) + 1, windowStart: startedAt };
    });
  }

  // --- blocked addresses ------------------------------------------------------------------

  async isBlocked(email: string): Promise<boolean> {
    const row = await this.db.get<{ email: string }>(`SELECT email FROM blocked_emails WHERE email = ?`, [
      normaliseEmail(email),
    ]);
    return row !== undefined;
  }

  async block(email: string, reason: "bounce" | "complaint", detail: string | null = null): Promise<void> {
    // `DO NOTHING` rather than an upsert: the FIRST reason is the interesting one. An address that
    // hard-bounced and was later marked as spam by an autoresponder is still an address that does
    // not exist, and overwriting the reason would lose the fact that matters.
    await this.db.run(
      `INSERT INTO blocked_emails (email, reason, detail, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (email) DO NOTHING`,
      [normaliseEmail(email), reason, detail === null ? null : detail.slice(0, 500), this.iso(this.now())],
    );
  }

  // --- the sweep --------------------------------------------------------------------------

  /**
   * §6: "Cleaned up by a scheduled job that deletes expired-or-consumed rows daily."
   *
   * CONSUMED ROWS GO TOO, not only expired ones, and there is a real question hidden in that. A
   * consumed magic-link token is what makes a second click say "already used" rather than "never
   * existed" — so deleting it loses a distinction. It is deleted anyway, because the two produce
   * the SAME message to the user by design (§4.5: a used-ticket message is a fingerprinting signal
   * for account existence) and the audit row is where the distinction is actually kept. A table of
   * spent credentials growing forever is a worse trade than losing a difference nothing renders.
   *
   * `blocked_emails` IS NOT SWEPT. A bounce is a fact about an address that stays true, and
   * expiring it would mean quietly resuming delivery to a mailbox that does not exist — which is
   * how a sending domain's reputation goes.
   */
  async sweep(): Promise<number> {
    const at = this.iso(this.now());
    let removed = 0;
    for (const table of ["magic_link_tokens", "oauth_state_tokens", "session_tickets"]) {
      const res = await this.db.run(
        `DELETE FROM ${table} WHERE expires_at <= ? OR consumed_at IS NOT NULL`,
        [at],
      );
      removed += res.changes;
    }
    // The counters, once their window is long dead. A day rather than the window itself, so a
    // sweep that runs mid-window cannot reset somebody's limit for them.
    const stale = await this.db.run(`DELETE FROM magic_link_rate_limits WHERE window_start <= ?`, [
      this.iso(this.now() - 24 * 60 * 60 * 1000),
    ]);
    return removed + stale.changes;
  }
}

/**
 * The local default. One process, four Maps, nothing installed.
 *
 * IT EXISTS FOR THE REASON `memoryTicketStore` DOES, which is hard rule 5: `npm run dev` starts
 * with no Postgres, no Redis and no Docker. It is also what the pure half of `test:sign-in` runs
 * against, so every rule in `signIn.ts` is exercised without a database — and the database-backed
 * half then runs the SAME suite against both drivers, which is how "single use" gets checked where
 * it is actually implemented differently.
 */
export function memorySignInStore(now: () => number = () => Date.now()): SignInStore {
  const magic = new Map<string, { email: string; expiresAt: number; consumed: boolean }>();
  const states = new Map<string, OAuthStateRecord & { consumed: boolean }>();
  const tickets = new Map<string, SessionTicketRecord & { consumed: boolean }>();
  const limits = new Map<string, RateWindow>();
  const blocked = new Map<string, string>();

  return {
    async issueMagicLink(input) {
      const token = mintSecret();
      const expiresAt = now() + (input.ttlS ?? MAGIC_LINK_TTL_S) * 1000;
      magic.set(hashSecret(token), { email: normaliseEmail(input.email), expiresAt, consumed: false });
      return { token, expiresAt };
    },
    async consumeMagicLink(token, email) {
      if (!looksLikeSecret(token)) return null;
      const found = magic.get(hashSecret(token));
      // Every condition the SQL's WHERE clause carries, in the same order and for the same
      // reasons — including the email binding, which is §10's last property.
      if (!found || found.consumed || found.expiresAt <= now()) return null;
      if (found.email !== normaliseEmail(email)) return null;
      found.consumed = true;
      return { email: found.email, expiresAt: found.expiresAt };
    },

    async issueOAuthState(input) {
      const state = mintSecret();
      const expiresAt = now() + (input.ttlS ?? OAUTH_STATE_TTL_S) * 1000;
      states.set(hashSecret(state), {
        provider: input.provider,
        codeVerifier: input.codeVerifier,
        nonceHash: hashSecret(input.nonce),
        redirectTo: input.redirectTo ?? null,
        expiresAt,
        consumed: false,
      });
      return { state, expiresAt };
    },
    async consumeOAuthState(state) {
      if (!looksLikeSecret(state)) return null;
      const found = states.get(hashSecret(state));
      if (!found || found.consumed || found.expiresAt <= now()) return null;
      found.consumed = true;
      const { consumed: _consumed, ...record } = found;
      return record;
    },

    async issueSessionTicket(input) {
      const ticket = mintSecret();
      const expiresAt = now() + (input.ttlS ?? SESSION_TICKET_TTL_S) * 1000;
      tickets.set(hashSecret(ticket), {
        userId: input.userId,
        provider: input.provider,
        nonceHash: input.nonceHash ?? null,
        expiresAt,
        consumed: false,
      });
      return { ticket, expiresAt };
    },
    async consumeSessionTicket(ticket) {
      if (!looksLikeSecret(ticket)) return null;
      const found = tickets.get(hashSecret(ticket));
      if (!found || found.consumed || found.expiresAt <= now()) return null;
      found.consumed = true;
      const { consumed: _consumed, ...record } = found;
      return record;
    },

    async countAttempt(key, windowS) {
      const at = now();
      const held = limits.get(key);
      if (!held || held.windowStart <= at - windowS * 1000) {
        const fresh = { count: 1, windowStart: at };
        limits.set(key, fresh);
        return { ...fresh };
      }
      held.count += 1;
      return { ...held };
    },

    async isBlocked(email) {
      return blocked.has(normaliseEmail(email));
    },
    async block(email, reason) {
      const address = normaliseEmail(email);
      // First reason wins, as in the database. See `DbSignInStore.block`.
      if (!blocked.has(address)) blocked.set(address, reason);
    },

    async sweep() {
      const at = now();
      let removed = 0;
      for (const [key, value] of magic) {
        if (value.expiresAt <= at || value.consumed) {
          magic.delete(key);
          removed++;
        }
      }
      for (const [key, value] of states) {
        if (value.expiresAt <= at || value.consumed) {
          states.delete(key);
          removed++;
        }
      }
      for (const [key, value] of tickets) {
        if (value.expiresAt <= at || value.consumed) {
          tickets.delete(key);
          removed++;
        }
      }
      for (const [key, value] of limits) {
        if (value.windowStart <= at - 24 * 60 * 60 * 1000) {
          limits.delete(key);
          removed++;
        }
      }
      return removed;
    },
  };
}

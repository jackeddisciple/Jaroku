// Granting, checking and ending an elevated session.
//
// AN ELEVATED SESSION IS AN AUTHORISATION, NOT A KEY. It does not unlock anything cryptographic
// and nothing is encrypted under it — see passcode.ts for why deriving a key from the passcode
// would break every unattended run. What it does is prove the person is still there, for ten
// minutes, on the routes that manage credentials.
//
// FOUR PROPERTIES, each of which is a line in the brief and a way to get this wrong:
//
//   THE TTL IS ABSOLUTE. Ten minutes from the moment it was granted, never extended by activity.
//   A sliding window means an idle open tab stays elevated all day, which is the exact thing the
//   gate exists to deny. `renewFor` below deliberately has no counterpart that pushes the expiry
//   out — a second tab COPIES the expiry rather than setting a new one.
//
//   IT BELONGS TO A SESSION, NOT A TAB AND NOT A DEVICE. Two tabs of one session share it; a
//   different device does not. The session is a digest of the bearer token, which gets sign-out
//   right for free: signing out mints a new token, so the new session shares nothing with the
//   elevation the old one held.
//
//   THE TOKEN NEVER TOUCHES STORAGE. It is returned once per tab and held in memory by the client.
//   This server has no cookie to put it in — it authenticates with a bearer header, deliberately —
//   and the brief's alternative, `localStorage`, is the one place it must not be: an XSS that
//   reads localStorage already has the JWT, and elevation is supposed to be the thing it does not
//   also get.
//
//   THE METHOD IS A DISCRIMINATOR FROM DAY ONE. Only 'passcode' is implemented. Retrofitting
//   WebAuthn into a passcode-shaped grant is painful; leaving the discriminator in costs nothing.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { TenantContext } from "../db/tenant.ts";
import type {
  ElevationMethod,
  ElevationRow,
  SecretElevationRepository,
} from "../db/repositories/secretElevations.ts";

/** Ten minutes, absolute. The brief's number, and the reason `renew` does not exist. */
export const ELEVATION_TTL_MS = 10 * 60 * 1000;

/** The header a client presents its elevation on. Not a cookie; this server has none. */
export const ELEVATION_HEADER = "x-jaroku-elevation";

/**
 * A session identity derived from the credential the request already carries.
 *
 * SHA-256 of the bearer token. Not the token, which must not be stored anywhere, and not a random
 * id of our own, which would need somewhere to live and would not die when the token did.
 *
 * That last property is the whole reason for this shape: "sign-out ends elevation" and "elevation
 * does not survive a token refresh" both become true without any code that watches for either.
 */
export function sessionIdFor(bearerToken: string): string {
  return createHash("sha256").update(bearerToken, "utf8").digest("hex");
}

export function mintElevationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashElevationToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * A token that could not possibly be one, rejected before it reaches a database.
 *
 * The elevation header is attacker-controlled on every request to the group, so a shape check
 * turns a free query-per-guess into an in-process rejection. Same reasoning as `looksLikeTicket`.
 */
export function looksLikeElevationToken(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length >= 40 && raw.length <= 64 && /^[A-Za-z0-9_-]+$/.test(raw);
}

/** Compare digests without leaking where they differ. */
export function digestsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Proof that a live elevation was checked, in a form only this module can produce.
 *
 * WHY A BRANDED TYPE AND NOT A BOOLEAN. ADR-033's central argument is that "privilege is a runtime
 * check, and the absence of a method is a compile-time one" — which is why the vault has no `get`.
 * ADR-035 adds a reveal path and therefore gives that up. What replaces it has to be the strongest
 * remaining compile-time thing, and this is it: `revealForUser` takes a receipt, the receipt's
 * brand is a symbol this module does not export, and so the ONLY way to obtain one is to have gone
 * through `check()` and had it say yes. A caller cannot construct a receipt, cannot cast an object
 * into one without deliberately reaching for `as unknown`, and cannot forge one from a request
 * body.
 *
 * IT CARRIES ITS OWN WORKSPACE, for exactly the reason `getForRun` takes a run id: the caller does
 * not get to assert which tenant it is acting for. The store reads the workspace off the receipt,
 * so a receipt for one workspace cannot open another's credential even if the name matches.
 */
declare const ELEVATION_BRAND: unique symbol;

export interface ElevationReceipt {
  readonly [ELEVATION_BRAND]: "elevation";
  readonly workspaceId: string;
  readonly userId: string;
  readonly elevationId: string;
}

export interface GrantedElevation {
  /** Handed to the client ONCE. Never stored server-side in this form, never logged. */
  token: string;
  expiresAt: string;
  method: ElevationMethod;
}

/** What a caller learns about its own elevation without holding a token for it. */
export interface ElevationState {
  elevated: boolean;
  expiresAt: string | null;
  remainingMs: number;
}

export interface ElevationDeps {
  elevations: SecretElevationRepository;
  now?: () => number;
}

export class SecretElevations {
  private now: () => number;

  constructor(private deps: ElevationDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Grant a fresh elevation, starting the clock now.
   *
   * The caller has already verified whatever `method` names — this records the decision, it does
   * not make it.
   */
  async grant(
    ctx: TenantContext,
    input: {
      userId: string;
      sessionId: string;
      method: ElevationMethod;
      ip?: string | null;
      userAgent?: string | null;
    },
  ): Promise<GrantedElevation> {
    const token = mintElevationToken();
    const expiresAt = new Date(this.now() + ELEVATION_TTL_MS).toISOString();
    await this.deps.elevations.issue(ctx, {
      userId: input.userId,
      sessionId: input.sessionId,
      tokenHash: hashElevationToken(token),
      method: input.method,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { token, expiresAt, method: input.method };
  }

  /**
   * Issue a token for a session that is ALREADY elevated, inheriting the original expiry.
   *
   * This is how a second tab joins. It is not a renewal and must never become one: the expiry is
   * copied from the live row, so a tab opened at minute nine is elevated for one more minute, not
   * for ten. Returns null when the session holds nothing live, which is the caller's cue to ask
   * for a passcode rather than to quietly grant a fresh ten minutes.
   */
  async joinExisting(
    ctx: TenantContext,
    input: { userId: string; sessionId: string; ip?: string | null; userAgent?: string | null },
  ): Promise<GrantedElevation | null> {
    const live = await this.deps.elevations.liveForSession(
      ctx,
      input.userId,
      input.sessionId,
      new Date(this.now()).toISOString(),
    );
    if (!live) return null;
    const token = mintElevationToken();
    await this.deps.elevations.issue(ctx, {
      userId: input.userId,
      sessionId: input.sessionId,
      tokenHash: hashElevationToken(token),
      method: live.method,
      // THE INHERITED EXPIRY. Changing this line to `now + TTL` is how this feature would quietly
      // become a sliding window.
      expiresAt: live.expires_at,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { token, expiresAt: live.expires_at, method: live.method };
  }

  /**
   * Is this request elevated? Returns the row, or null.
   *
   * The token must match a row for THIS workspace, THIS user and THIS session, and that row must
   * be unrevoked and unexpired. All four are checked in one query so no combination of them is
   * skippable by a caller that forgot one.
   */
  async check(
    ctx: TenantContext,
    input: { userId: string; sessionId: string; token: string },
  ): Promise<ElevationRow | null> {
    if (!looksLikeElevationToken(input.token)) return null;
    const row = await this.deps.elevations.liveByToken(
      ctx,
      { userId: input.userId, sessionId: input.sessionId, tokenHash: hashElevationToken(input.token) },
      new Date(this.now()).toISOString(),
    );
    return row ?? null;
  }

  /**
   * The same check, answering with a receipt the vault will accept.
   *
   * Separate from `check` rather than replacing it, because most callers want "may this request
   * proceed" and only one wants "and here is proof, to hand to the thing that reads a value". A
   * single method returning the receipt would put a reveal token in the hands of every route in
   * the group, which is precisely the widening ADR-035 is trying not to do.
   *
   * The workspace on the receipt comes from the ROW, not from the context that was passed in —
   * `liveByToken` already scoped the lookup, and taking it from the row means the receipt cannot
   * describe a workspace the elevation was not actually issued for.
   */
  async receiptFor(
    ctx: TenantContext,
    input: { userId: string; sessionId: string; token: string },
  ): Promise<ElevationReceipt | null> {
    const row = await this.check(ctx, input);
    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      userId: row.user_id,
      elevationId: row.id,
    } as ElevationReceipt;
  }

  /**
   * How long this session has left, for the header countdown.
   *
   * Answered from the session rather than from a token, so a tab that has not been issued one yet
   * can still render "unlocked, 6:12" — and so that asking does not require holding the token in a
   * place a request could log it.
   */
  async state(ctx: TenantContext, userId: string, sessionId: string): Promise<ElevationState> {
    const nowMs = this.now();
    const live = await this.deps.elevations.liveForSession(ctx, userId, sessionId, new Date(nowMs).toISOString());
    if (!live) return { elevated: false, expiresAt: null, remainingMs: 0 };
    return {
      elevated: true,
      expiresAt: live.expires_at,
      // Clamped at zero: a row one millisecond from expiry must not render as a negative
      // countdown, and the client should never have to defend against one.
      remainingMs: Math.max(0, Date.parse(live.expires_at) - nowMs),
    };
  }

  /** Lock now. Ends every token this session holds, so every tab of it locks together. */
  async lock(ctx: TenantContext, userId: string, sessionId: string, reason = "locked by the user"): Promise<number> {
    return this.deps.elevations.revokeSession(ctx, userId, sessionId, reason);
  }

  /**
   * End every elevation this user holds in this workspace, on every device.
   *
   * For the events that invalidate the proof rather than one session of it — the passcode was
   * changed or reset, or the person was removed from the workspace. A recovery that left a stolen
   * session elevated would be a recovery that did not recover anything.
   */
  async lockEverywhere(ctx: TenantContext, userId: string, reason: string): Promise<number> {
    return this.deps.elevations.revokeAllForUser(ctx, userId, reason);
  }
}

// The credential a sandboxed run authenticates to the control plane with — everything the
// presigned-URL scheme already gets right (storage/presign.ts), scoped to a run instead of an
// object key.
//
// SELF-CONTAINED AND STATELESS, DELIBERATELY. The control-plane long-poll is a hot path — a
// run in flight polls it roughly every 25 seconds for its whole lifetime — and a database round
// trip on every poll is a cost worth avoiding when an HMAC check is not slower than a comparison.
// The signing key is configuration, not a process secret, for exactly presign.ts's reason: a
// token minted by replica 1 is verified by whichever replica the runner's next request happens
// to land on.
//
// SCOPED TO EXACTLY ONE RUN. The spec is explicit about this: "a JWT scoped to exactly one run
// id, valid for the run's wall-clock limit, granting nothing but these endpoints." A token that
// named a workspace instead would let a compromised sandbox address every run the workspace has
// ever started; naming the run id means the worst a leaked token can do is impersonate the one
// execution it already has code-execution inside of.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";

export const RUN_TOKEN_SIGNING_KEY_ENV = "JAROKU_RUN_TOKEN_SIGNING_KEY";

/** A run token outlives nothing longer than this by policy — see mint()'s ttl clamp. Sandbox
 *  wall-clock caps in the migration spec are on the order of minutes, not hours. */
export const MAX_RUN_TOKEN_TTL_S = 60 * 60 * 2;

export interface RunTokenClaims {
  runId: string;
  workspaceId: string;
  expiresAtMs: number;
}

export type VerifyResult =
  | { ok: true; claims: RunTokenClaims }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

/** Same resolution rule as storage/presign.ts's signing key, word for word: env wins, a local
 *  dev process persists one beside the database, and production refuses to boot without one —
 *  see resolveSigningKey there for why a per-replica generated key is the wrong failure mode. */
export function resolveRunTokenSigningKey(statePath: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const supplied = env[RUN_TOKEN_SIGNING_KEY_ENV]?.trim();
  if (supplied) {
    if (supplied.length < 32) {
      throw new Error(`${RUN_TOKEN_SIGNING_KEY_ENV} is too short — supply at least 32 characters of random data`);
    }
    return Buffer.from(supplied, "utf8");
  }
  if (env["NODE_ENV"] === "production") {
    throw new Error(
      `${RUN_TOKEN_SIGNING_KEY_ENV} must be set under NODE_ENV=production. Without it each ` +
        `replica mints run tokens the others cannot verify, which a sandboxed run experiences ` +
        `as its control-plane calls failing at random depending on which replica answers.`,
    );
  }
  if (existsSync(statePath)) {
    try {
      const stored = readFileSync(statePath, "utf8").trim();
      if (stored.length >= 64) return Buffer.from(stored, "hex");
    } catch {
      /* unreadable — fall through and write a fresh one */
    }
  }
  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(statePath, 0o600);
  } catch {
    /* a file we cannot chmod is still a file we wrote */
  }
  return Buffer.from(generated, "hex");
}

function payload(runId: string, workspaceId: string, expiresAtMs: number): string {
  // Length-prefixed-by-position, not delimiter-separated — see presign.ts's payload() for why a
  // run/workspace id containing the field separator would otherwise let one field's content
  // relabel itself as another's. Run ids are server-minted uuids and workspace ids are too, so
  // this can never actually happen, but the signature is cheap and the reasoning should not
  // depend on that staying true forever.
  return `runtoken.v1\n${runId}\n${workspaceId}\n${expiresAtMs}`;
}

function sign(secret: Buffer, runId: string, workspaceId: string, expiresAtMs: number): string {
  return createHmac("sha256", secret).update(payload(runId, workspaceId, expiresAtMs)).digest("hex");
}

/** Mint a token scoped to exactly this run, valid for `ttlSeconds` (clamped to the wall-clock
 *  ceiling above). The raw value is `runId.workspaceId.expiresAtMs.signature`, base64url-free by
 *  construction — ids and a signature are already URL-safe, so it can ride a Bearer header
 *  unencoded. */
export function mintRunToken(
  secret: Buffer,
  runId: string,
  workspaceId: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_RUN_TOKEN_TTL_S);
  const expiresAtMs = now + ttl * 1000;
  const sig = sign(secret, runId, workspaceId, expiresAtMs);
  return `${runId}.${workspaceId}.${expiresAtMs}.${sig}`;
}

/** Verify a token, returning its claims. Never throws — every failure is a `VerifyResult`, so
 *  an HTTP handler can answer 401 without a try/catch around every call site. */
export function verifyRunToken(secret: Buffer, raw: string, now = Date.now()): VerifyResult {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return { ok: false, reason: "malformed" };
  const parts = raw.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [runId, workspaceId, expiresAtRaw, sig] = parts as [string, string, string, string];
  const expiresAtMs = Number(expiresAtRaw);
  if (!runId || !workspaceId || !Number.isFinite(expiresAtMs) || !/^[0-9a-f]{64}$/.test(sig)) {
    return { ok: false, reason: "malformed" };
  }

  const expected = Buffer.from(sign(secret, runId, workspaceId, expiresAtMs), "hex");
  const actual = Buffer.from(sig, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  // Expiry checked AFTER the signature — the same ordering presign.ts uses, so an unsigned
  // guess at a run id cannot distinguish "wrong signature" from "correct but expired" and learn
  // anything about which run ids are real.
  if (expiresAtMs <= now) return { ok: false, reason: "expired" };

  return { ok: true, claims: { runId, workspaceId, expiresAtMs } };
}

/** Revocation, for a run that has already finished. Self-contained tokens cannot be un-minted,
 *  so this is a denylist consulted alongside verification — small and short-lived by
 *  construction, since every entry falls out on its own once the token's own expiry passes. */
export class RunTokenRevocationList {
  private revoked = new Map<string, number>(); // runId -> expiresAtMs, so a sweep is cheap

  revoke(runId: string, expiresAtMs: number): void {
    this.revoked.set(runId, expiresAtMs);
  }

  isRevoked(runId: string): boolean {
    return this.revoked.has(runId);
  }

  /** Drop entries whose underlying token has expired anyway — nothing to protect against once
   *  verifyRunToken would refuse the token on expiry alone. */
  sweep(now = Date.now()): number {
    let n = 0;
    for (const [runId, expiresAtMs] of this.revoked) {
      if (expiresAtMs <= now) {
        this.revoked.delete(runId);
        n++;
      }
    }
    return n;
  }
}

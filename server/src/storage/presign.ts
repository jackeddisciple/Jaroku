// A URL that carries its own authorisation, and expires.
//
// A presigned URL exists so that bytes can travel between a browser (or a run sandbox) and the
// object store WITHOUT passing through the control plane. That is the point of it and also the
// whole of its danger: it is a bearer credential in a query string, it outlives the request
// that minted it, and it lands in browser history, in a proxy's access log and in whatever the
// user pasted it into.
//
// So the shape of the promise has to be narrow, and it is the same promise for both
// implementations:
//
//   ONE KEY. Not a prefix, not a bucket. The signature covers the exact key.
//   ONE VERB. A GET URL cannot write and a PUT URL cannot read. The signature covers the verb.
//   ONE WINDOW. Minutes, not days, and the expiry is inside the signature rather than beside it.
//
// AND — the part that is Jaroku's rather than S3's — every key names its workspace as its first
// component (keys.ts), so a leaked URL is still checkable against the context of the request
// presenting it. A signature that verifies proves the URL was minted here; it does not prove the
// person holding it is in that workspace. Both checks, always: `verifyLocalUrl` answers the
// first, and the route in http/objects.ts answers the second.
//
// THE SIGNING KEY IS CONFIGURATION, NOT A PROCESS SECRET. A URL minted on replica 1 is redeemed
// on replica 7, so a per-process random key would produce a scheme where every presigned URL
// works about a seventh of the time. Locally it is generated once and persisted beside the
// database, the same way the local issuer's signing key is; in production it must be supplied,
// and boot fails if it is not, because the failure mode of guessing here is silent.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { assertKey } from "./keys.ts";

/** What a presign call hands back. Both implementations produce this shape. */
export interface Presigned {
  /**
   * Where to send the request.
   *
   * Absolute for S3 (the bucket's endpoint). ROOT-RELATIVE for the local store — `/v1/objects/…`
   * — because the local store has no endpoint of its own and the server's own public origin is
   * not reliably knowable from inside it (a reverse proxy, a tunnel, a port map). A relative URL
   * is correct from a browser already talking to this server, and the one caller that needs an
   * absolute one can join it with the origin it already used.
   */
  url: string;
  /** ISO-8601, so it is comparable and loggable without arithmetic at the call site. */
  expiresAt: string;
}

export type PresignOp = "get" | "put";

/** The route the local store's URLs point at. One constant, so the router and the signer agree. */
export const OBJECT_ROUTE_PREFIX = "/v1/objects/";

/** The environment variable a hosted deployment supplies the signing key in. */
export const SIGNING_KEY_ENV = "JAROKU_OBJECT_SIGNING_KEY";

/** Nothing in this codebase mints a longer one. A presign is for a transfer, not for storage. */
export const MAX_PRESIGN_TTL_S = 60 * 60;

/**
 * A ttl in whole seconds that both implementations agree on.
 *
 * Here rather than at each call site because the two disagreed, and in the worst direction: the
 * local signer floored, so a sub-second ttl became ZERO and minted a URL already past its expiry
 * — a signature that verifies and is refused, which reads as a signing-key mismatch and is not
 * one. S3's signer clamped to at least a second and never clamped the top end at all, so the
 * same call produced a working URL there and a dead one locally.
 *
 * A second is the floor because neither scheme can express less: `X-Amz-Expires` is an integer
 * count of seconds, and the local scheme's expiry is compared with `<=`.
 */
export function normalisePresignTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`a presign ttl must be a positive number of seconds, not ${ttlSeconds}`);
  }
  return Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_PRESIGN_TTL_S);
}

/**
 * Resolve the key that signs local object URLs.
 *
 * From the environment when it is set. Otherwise generated and persisted at `statePath`,
 * `chmod 600`, exactly as the local issuer's RS256 key is — an ephemeral one would invalidate
 * every outstanding URL on every `tsx` restart, and `tsx` restarts a lot.
 *
 * UNDER NODE_ENV=production IT MUST BE SUPPLIED. Generating one there produces a per-replica
 * key, which produces URLs that verify on the replica that minted them and nowhere else — an
 * intermittent, load-balancer-shaped failure that looks like anything but a configuration
 * mistake. Refusing at boot costs a line of config and makes it unreachable.
 */
export function resolveSigningKey(
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const supplied = env[SIGNING_KEY_ENV]?.trim();
  if (supplied) {
    // Hex or base64 both work; anything else is taken as raw bytes. What matters is that the
    // same string produces the same key on every replica, and every encoding does.
    if (supplied.length < 32) {
      throw new Error(`${SIGNING_KEY_ENV} is too short — supply at least 32 characters of random data`);
    }
    return Buffer.from(supplied, "utf8");
  }

  if (env["NODE_ENV"] === "production") {
    throw new Error(
      `${SIGNING_KEY_ENV} must be set under NODE_ENV=production. Without it each replica ` +
        `generates its own, so a presigned URL minted by one replica fails on every other — ` +
        `which presents as intermittent 403s rather than as the configuration error it is.`,
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
    // A file we cannot chmod is still a file we wrote. Same judgement envWriter makes.
  }
  return Buffer.from(generated, "hex");
}

/**
 * The bytes the signature covers.
 *
 * Newline-separated with the fields in a fixed order, and every field length-prefixed by its
 * position rather than by a delimiter that could appear inside it: a key cannot contain a
 * newline (keys.ts refuses control characters), so this is unambiguous. Without that property
 * `get` + `a\nb` and `get\na` + `b` would sign the same string, which is how a signature scheme
 * gets a confusion attack.
 */
function payload(op: PresignOp, key: string, expiresAtMs: number): string {
  return `v1\n${op}\n${key}\n${expiresAtMs}`;
}

function sign(secret: Buffer, op: PresignOp, key: string, expiresAtMs: number): string {
  return createHmac("sha256", secret).update(payload(op, key, expiresAtMs)).digest("hex");
}

/** Mint a local presigned URL for exactly one key and one verb. */
export function signLocalUrl(
  secret: Buffer,
  op: PresignOp,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Presigned {
  assertKey(key);
  const ttl = normalisePresignTtl(ttlSeconds);
  const expiresAtMs = now + ttl * 1000;
  const sig = sign(secret, op, key, expiresAtMs);
  // The key is percent-encoded as a whole, slashes included. Leaving them bare would make the
  // path traversable by a router that resolves ".." before the handler sees it, and this URL is
  // the one place a key is handed to something that has never read keys.ts.
  const url =
    `${OBJECT_ROUTE_PREFIX}${encodeURIComponent(key)}` +
    `?op=${op}&exp=${expiresAtMs}&sig=${sig}`;
  return { url, expiresAt: new Date(expiresAtMs).toISOString() };
}

export type VerifyResult =
  | { ok: true; key: string; op: PresignOp; workspaceId: string }
  | { ok: false; reason: "malformed" | "expired" | "bad signature" };

/**
 * Check a local presigned URL. Answers only "was this minted here, for this, and is it still
 * valid" — never "may the person holding it have it", which is the caller's question and is
 * asked against the request's TenantContext.
 */
export function verifyLocalUrl(
  secret: Buffer,
  url: string,
  now: number = Date.now(),
): VerifyResult {
  let parsed: URL;
  try {
    // A base is required to parse a root-relative URL, and is otherwise unused — nothing here
    // reads the host, precisely because the mint side does not know it either.
    parsed = new URL(url, "http://object-store.invalid");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed.pathname.startsWith(OBJECT_ROUTE_PREFIX)) return { ok: false, reason: "malformed" };

  const raw = parsed.pathname.slice(OBJECT_ROUTE_PREFIX.length);
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const op = parsed.searchParams.get("op");
  const exp = Number(parsed.searchParams.get("exp"));
  const sig = parsed.searchParams.get("sig");
  if ((op !== "get" && op !== "put") || !sig || !Number.isFinite(exp)) {
    return { ok: false, reason: "malformed" };
  }

  // The key is validated BEFORE the signature is checked and again by the store afterwards. A
  // key that keys.ts refuses can never be reached even by somebody who has the signing secret,
  // which is the difference between a leaked key and a compromised one.
  let workspaceId: string;
  try {
    assertKey(key);
    workspaceId = key.split("/")[1]!;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const expected = Buffer.from(sign(secret, op, key, exp), "hex");
  const actual = Buffer.from(sig, "hex");
  // Length-checked first: timingSafeEqual throws on a length mismatch rather than returning
  // false, and a thrown error inside a comparison is a 500 where a 403 belongs.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad signature" };
  }
  // Expiry AFTER the signature, so an unsigned guess cannot learn whether a key exists by
  // watching which error it gets. Same reasoning the ticket store follows.
  if (exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, key, op, workspaceId };
}

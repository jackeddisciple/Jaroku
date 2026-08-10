// The key that encrypts the keys.
//
// Envelope encryption has exactly one thing that must not be in the database: the master key.
// Everything else — the wrapped data keys, the sealed secrets — is safe to hold beside the data
// it protects, because a database dump without the master key is a dump of noise.
//
// SO THIS IS AN INTERFACE, AND THE FIRST IMPLEMENTATION READS AN ENVIRONMENT VARIABLE. That is
// not the end state and does not pretend to be. A cloud KMS never hands the key out at all — it
// wraps and unwraps on its own hardware, and the application holds nothing — which is strictly
// better and is a Session 8 concern. What matters now is that the ciphertext format does not
// change when that happens: every wrapped data key records WHICH master key wrapped it, so a
// provider swap is a rewrap of N data keys rather than a re-encryption of every secret on the
// platform, and the two providers can coexist while it happens.
//
// THE KEY ID IS DERIVED FROM THE KEY, NOT CHOSEN. `local:<first 16 hex of sha256>` — enough to
// tell two keys apart, not enough to be useful to somebody who has it. That means a deployment
// that changes `JAROKU_MASTER_KEY` gets a clear "this data key was wrapped by local:ab12… and
// this process holds local:cd34…" instead of a decryption failure reported as corruption, which
// is the difference between a five-minute fix and an incident.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MASTER_KEY_ENV = "JAROKU_MASTER_KEY";

/** 96-bit nonce, 128-bit tag. What AES-GCM is specified for and what every KMS uses. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface MasterKeyProvider {
  /** Recorded with every wrapped data key. Never secret, and never the key. */
  readonly id: string;
  /** Seal a 32-byte data key. Returns base64(iv || tag || ciphertext). */
  wrap(dataKey: Buffer): Promise<string>;
  /**
   * Open one.
   *
   * `keyId` is what the row says wrapped it. A provider that is not that key must REFUSE rather
   * than try and fail: "wrapped by a key this process does not have" is an operator's problem
   * with an obvious fix, and "authentication failed" reads as data corruption.
   */
  unwrap(wrapped: string, keyId: string): Promise<Buffer>;
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

/**
 * A master key from configuration.
 *
 * The supplied string is hashed to 32 bytes rather than used raw, so any length and any
 * encoding works and the caller does not have to know that AES-256 wants exactly 32 bytes. A
 * minimum length is still enforced, because hashing a short string produces a perfectly
 * well-formed key with very little behind it.
 */
export class LocalMasterKeyProvider implements MasterKeyProvider {
  readonly id: string;
  private readonly key: Buffer;

  constructor(material: string) {
    if (material.trim().length < 32) {
      throw new MasterKeyError(
        `${MASTER_KEY_ENV} must be at least 32 characters of random data — a short master key ` +
          `is a well-formed key with very little behind it`,
      );
    }
    this.key = createHash("sha256").update(material, "utf8").digest();
    // From the DERIVED key, so two spellings of the same material are the same id, and the id
    // reveals nothing: it is a truncated hash of a hash.
    this.id = `local:${createHash("sha256").update(this.key).digest("hex").slice(0, 16)}`;
  }

  async wrap(dataKey: Buffer): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    // The key id as additional authenticated data: a wrapped key relabelled to claim a
    // different master key fails to open rather than opening as something else.
    cipher.setAAD(Buffer.from(this.id, "utf8"));
    const sealed = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
  }

  async unwrap(wrapped: string, keyId: string): Promise<Buffer> {
    if (!constantTimeEquals(keyId, this.id)) {
      throw new MasterKeyError(
        `this data key was wrapped by master key ${keyId} and this process holds ${this.id} — ` +
          `set ${MASTER_KEY_ENV} to the key this deployment was created with, or rewrap`,
      );
    }
    const raw = Buffer.from(wrapped, "base64");
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new MasterKeyError("the wrapped data key is malformed");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(this.id, "utf8"));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    } catch {
      // Deliberately not the underlying message, which is "Unsupported state or unable to
      // authenticate data" and tells nobody anything.
      throw new MasterKeyError("the wrapped data key does not authenticate under this master key");
    }
  }
}

/** Comparing two ids, without leaking which byte differed. Cheap, and the habit is worth it. */
function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The master key this process holds, or a refusal.
 *
 * There is no generated fallback, and that is the difference between this and the object
 * store's signing key. A signing key that regenerates invalidates outstanding URLs, which is
 * annoying; a MASTER key that regenerates makes every secret in the database permanently
 * unreadable. So it is supplied or it is not, and "not" is an error at boot rather than a
 * surprise at the first decrypt.
 */
export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): MasterKeyProvider {
  const material = env[MASTER_KEY_ENV];
  if (!material) {
    throw new MasterKeyError(
      `the hosted secret store needs ${MASTER_KEY_ENV}. There is deliberately no generated ` +
        `fallback: a master key that regenerated would make every stored credential ` +
        `permanently unreadable, which is a worse outcome than refusing to start.`,
    );
  }
  return new LocalMasterKeyProvider(material);
}

// --- the data-key layer -----------------------------------------------------------------
//
// Same primitive, different key, and kept here beside it so the two halves of the envelope are
// one file to read. The AAD is what binds a ciphertext to the row it was written for.

export function sealWithDataKey(dataKey: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
}

export class CiphertextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiphertextError";
  }
}

export function openWithDataKey(dataKey: Buffer, ciphertext: string, aad: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new CiphertextError("the stored value is malformed");
  const decipher = createDecipheriv("aes-256-gcm", dataKey, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    // The AAD is `<workspace_id>:<name>`, so this is also what a row copied into another
    // workspace, or renamed to another variable, produces. That is the point of the binding.
    throw new CiphertextError(
      "the stored value does not authenticate — it was sealed for a different workspace, a " +
        "different name, or under a different data key",
    );
  }
}

/** A fresh 256-bit data key. One per workspace, per rotation. */
export function newDataKey(): Buffer {
  return randomBytes(32);
}

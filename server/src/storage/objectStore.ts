// The storage boundary. Everything that is a file rather than a row goes through this
// interface, and the two implementations behind it are the same shape for the same reason the
// two database drivers are: the application must not be able to tell which one it got.
//
// WHY THIS EXISTS AT ALL. Three things in Jaroku are files today, and all three assume the
// server, the agent's code and the checkpoint blobs share one disk: `runtime/agents/<id>/`,
// `.staging/`, and `.history/`. Hosted, there is no shared disk. A generation lands on
// replica 1, the edit that follows lands on replica 3, and the undo after that lands on a
// replica that has been running for four minutes. Every one of those has to see the same
// bytes, which means the bytes stop living on a disk any one of them owns.
//
// TWO IMPLEMENTATIONS, ALWAYS — the standing rule for this migration. `FsObjectStore` roots
// itself under `runtime/.objects/` and needs nothing installed and nothing running, so the
// fixtures, the mock MCP server and `npm run dev` keep working with no cloud account at all.
// `S3ObjectStore` is production. Selected by `JAROKU_OBJECT_STORE`, defaulting to `fs`.
//
// SMALL SURFACE, ON PURPOSE. put/get/head/list/delete/copy/presign, and nothing that implies a
// directory: no `mkdir`, no `rename`, no `walk`. Every one of those would be a local-filesystem
// idea that S3 answers by pretending, and a caller that leaned on the pretence would be a
// caller that works on one implementation. `copy` is here rather than get-then-put because S3
// can do it server-side without the bytes crossing the network, and a version bump that copies
// an unchanged file is the common case.
//
// KEYS ARE VALIDATED BY EVERY IMPLEMENTATION, not by the caller. See keys.ts: a key is a flat
// string to an object store and a path to whatever turns one back into a file, and the gap
// between those two facts is the traversal.

import type { Presigned } from "./presign.ts";

export type ObjectStoreKind = "fs" | "s3";

/** What is known about a stored object without fetching it. */
export interface ObjectMeta {
  key: string;
  bytes: number;
  /**
   * An opaque per-store content marker.
   *
   * NOT a sha256, and deliberately not named one. S3 returns an ETag, which is an MD5 for a
   * single-part upload and something else entirely for a multipart one; a filesystem has no
   * such thing at all. Promising a hash here would make one implementation lie.
   *
   * What IS promised, and what the conformance suite asserts: within one store, equal content
   * has an equal etag and different content does not. That is enough for "has this changed",
   * which is the only question anything asks of it. The `sha256` in an `agent_versions`
   * manifest is computed by whoever holds the bytes — see projectStore.ts — precisely so that
   * it is one number produced one way rather than whatever the store happened to hand back.
   */
  etag: string;
  /** ISO-8601. Last write, as the store understands it. */
  modifiedAt: string;
}

export interface PutOptions {
  /** Recorded where the store has somewhere to record it. Advisory; nothing branches on it. */
  contentType?: string;
}

/**
 * A key that is not there.
 *
 * Its own class because "absent" and "broken" are different answers and the callers care:
 * a missing staging object during a generation is a bug, and a missing history object during
 * an undo is a version that was already swept. Both arrive as failures from `get`; only one
 * of them should be reported as an error to a user.
 */
export class ObjectNotFound extends Error {
  constructor(public readonly key: string) {
    super(`no such object: ${key}`);
    this.name = "ObjectNotFound";
  }
}

export interface ObjectStore {
  readonly kind: ObjectStoreKind;

  /** Write `body` at `key`, replacing whatever was there. Returns what is now stored. */
  put(key: string, body: Buffer | string, opts?: PutOptions): Promise<ObjectMeta>;

  /** The bytes at `key`. Throws `ObjectNotFound` when there are none. */
  get(key: string): Promise<Buffer>;

  /** Metadata only, or null when the key is absent. Never throws for absence. */
  head(key: string): Promise<ObjectMeta | null>;

  /**
   * Every object whose key starts with `prefix`, sorted by key.
   *
   * A BYTE prefix, exactly as S3 means it — `…/v1` also matches `…/v10/agent.py`. Callers
   * pass a prefix ending in "/" for that reason, and the builders in keys.ts produce them
   * that way so the decision is made once.
   */
  list(prefix: string): Promise<ObjectMeta[]>;

  /** Remove `key`. Idempotent: deleting what is not there is not an error. */
  delete(key: string): Promise<void>;

  /** Every object under `prefix`, removed. Returns how many. Idempotent, like `delete`. */
  deletePrefix(prefix: string): Promise<number>;

  /** Server-side copy where the store can do one. Throws `ObjectNotFound` for a missing source. */
  copy(fromKey: string, toKey: string): Promise<ObjectMeta>;

  /** A URL that reads `key` for `ttlSeconds`, and grants nothing else. */
  presignGet(key: string, ttlSeconds: number): Promise<Presigned>;

  /** A URL that writes `key` for `ttlSeconds`, and grants nothing else. */
  presignPut(key: string, ttlSeconds: number): Promise<Presigned>;
}

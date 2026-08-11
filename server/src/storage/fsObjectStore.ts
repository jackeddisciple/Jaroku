// The development object store: a real object store, on the local disk.
//
// Same reasoning as the local auth issuer. The alternative — a flag that makes the generation
// path keep using `runtime/agents/<id>/` directly when there is no S3 configured — would mean
// the code that matters in production is the code nobody runs locally, and every bug in it
// would be found by a user. So this is a full implementation of the interface: flat keyspace,
// byte-prefix listing, presigned URLs that actually verify, and the same key validation.
//
// It roots itself under `runtime/.objects/`, which is gitignored beside `.checkpoints/` and
// `.staging/`, and it needs nothing installed and nothing running.
//
// WHAT IT DOES NOT PRETEND. A filesystem is not an object store, and the two places that shows
// are dealt with explicitly rather than papered over:
//
//   * A KEY IS NOT A PATH. The store re-validates every key with keys.ts and then re-checks the
//     resolved path against its own root, because the entire hazard of running an object store
//     on a filesystem is a key that resolves outside it. Two walls, and the second one is here
//     even though the first one already refused `..` — a store that trusts its caller is a store
//     whose safety depends on every caller.
//
//   * DIRECTORIES ARE AN ARTEFACT. S3 has none, so nothing here may report one. `list` returns
//     objects, never the directories they happen to sit in, and deleting the last object under a
//     prefix prunes the now-empty directories back to the root — otherwise a local tree keeps a
//     shape that the hosted store never had, and the first thing that walks it locally sees a
//     structure production does not have.
//
// WRITES ARE ATOMIC, via a temp file and a rename in the same directory. A reader must never see
// half an object: the generation path streams a file and then validates the project, and a
// half-written agent.py is a syntax error attributed to the model.

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertKey, assertPrefix } from "./keys.ts";
import {
  ObjectNotFound, type ObjectMeta, type ObjectStore, type PutOptions,
} from "./objectStore.ts";
import { signLocalUrl, type Presigned } from "./presign.ts";

export interface FsObjectStoreOptions {
  /** The root every key resolves under. Created on first write. */
  root: string;
  /** Signs the URLs `presignGet`/`presignPut` mint. See presign.ts. */
  signingKey: Buffer;
}

export class FsObjectStore implements ObjectStore {
  readonly kind = "fs" as const;
  private readonly root: string;
  private readonly signingKey: Buffer;

  constructor(opts: FsObjectStoreOptions) {
    // Resolved once, so every later comparison is between two absolute paths. A relative root
    // would make the confinement check depend on the process's working directory, which is not
    // a thing a security boundary should depend on.
    this.root = resolve(opts.root);
    this.signingKey = opts.signingKey;
  }

  /**
   * A key, as a path under the root — or a thrown error.
   *
   * `assertKey` has already refused traversal, and this check is here anyway. The reason is
   * that they are guarding different things: `assertKey` guards the SHAPE of a key, and this
   * guards the OUTCOME of joining it to this particular root. A future key builder, a symlink
   * in the tree, or a platform whose `join` normalises differently changes the second without
   * changing the first.
   */
  private pathFor(key: string): string {
    assertKey(key);
    const full = resolve(this.root, key);
    const rel = relative(this.root, full);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`object key resolves outside the store root: ${key}`);
    }
    this.refuseSymlinks(rel);
    return full;
  }

  /**
   * Refuse a key any of whose components is a symlink.
   *
   * `lstat`, never `stat`: the point is to see the link itself rather than what it points at.
   * Walked from the root down, so a link ANYWHERE on the way is caught — the dangerous one is
   * a directory component, because that redirects everything beneath it, and the target is
   * checked too so a link cannot be written through or read out of.
   *
   * A component that does not exist yet is fine and stops the walk: nothing below it can be a
   * link, and `put` is about to create it as a real directory.
   */
  private refuseSymlinks(rel: string): void {
    let cursor = this.root;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      let stat;
      try {
        stat = lstatSync(cursor);
      } catch {
        return; // does not exist yet — and neither does anything under it
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`object key passes through a symlink, which an object store has none of: ${rel}`);
      }
    }
  }

  private metaFor(key: string, full: string, body?: Buffer): ObjectMeta {
    const stat = statSync(full);
    const bytes = body ?? readFileSync(full);
    return {
      key,
      bytes: stat.size,
      // A content hash rather than an mtime. An mtime has one-second granularity on some
      // filesystems, so two writes inside the same second would be reported as unchanged —
      // and "has this file changed" is the question the version manifest is built on.
      etag: createHash("sha256").update(bytes).digest("hex"),
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
    };
  }

  async put(key: string, body: Buffer | string, _opts?: PutOptions): Promise<ObjectMeta> {
    const full = this.pathFor(key);
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    mkdirSync(dirname(full), { recursive: true });
    // Same directory as the target, so the rename is within one filesystem and is therefore
    // atomic. A temp file in the OS temp dir would be a cross-device copy that is not.
    const tmp = `${full}.tmp-${randomUUID()}`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    try {
      renameSync(tmp, full);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      chmodSync(full, 0o600);
    } catch {
      // Objects hold agent source and, in the staging case, whatever the model wrote. The
      // permission bits are worth asking for and not worth failing a write over.
    }
    return this.metaFor(key, full, bytes);
  }

  async get(key: string): Promise<Buffer> {
    const full = this.pathFor(key);
    try {
      return readFileSync(full);
    } catch {
      throw new ObjectNotFound(key);
    }
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const full = this.pathFor(key);
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    return this.metaFor(key, full);
  }

  async list(prefix: string): Promise<ObjectMeta[]> {
    assertPrefix(prefix);
    // A BYTE prefix, like S3's. So the walk starts at the last complete directory component and
    // the string comparison does the rest — `…/v1` matching `…/v10/agent.py` is correct here,
    // and a caller that did not want that passes a prefix ending in "/".
    const cut = prefix.lastIndexOf("/");
    const dirKey = cut >= 0 ? prefix.slice(0, cut) : "";
    const start = resolve(this.root, dirKey);
    if (relative(this.root, start).startsWith("..")) return [];
    if (!existsSync(start)) return [];

    const out: ObjectMeta[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        // `lstat`, so a symlink is seen as a symlink. Skipped entirely rather than followed:
        // an object store has no symlinks, so anything reachable only through one is not an
        // object — and a link that points back up its own tree would otherwise be an infinite
        // walk, or an ELOOP that takes down a whole workspace's listing.
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        // A half-written object is not an object. Its temp name is deliberately un-key-like.
        if (entry.includes(".tmp-")) continue;
        const key = relative(this.root, full).split(sep).join("/");
        if (key.startsWith(prefix)) out.push(this.metaFor(key, full));
      }
    };
    walk(start);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    const full = this.pathFor(key);
    rmSync(full, { force: true });
    this.prune(dirname(full));
  }

  async deletePrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    for (const o of objects) {
      const full = this.pathFor(o.key);
      rmSync(full, { force: true });
      this.prune(dirname(full));
    }
    return objects.length;
  }

  async copy(fromKey: string, toKey: string): Promise<ObjectMeta> {
    // Read-then-write rather than a hardlink. A hardlink would make the copy and the source the
    // same inode, so an in-place write to one would change the other — and immutability is the
    // property the whole version model rests on. S3's server-side copy has the same semantics
    // as this: an independent object with the same bytes.
    return this.put(toKey, await this.get(fromKey));
  }

  async presignGet(key: string, ttlSeconds: number): Promise<Presigned> {
    return signLocalUrl(this.signingKey, "get", key, ttlSeconds);
  }

  async presignPut(key: string, ttlSeconds: number): Promise<Presigned> {
    return signLocalUrl(this.signingKey, "put", key, ttlSeconds);
  }

  /** Walk empty directories back toward the root, so the tree keeps no shape S3 would not. */
  private prune(dir: string): void {
    let cursor = dir;
    while (cursor.startsWith(this.root) && cursor !== this.root) {
      try {
        if (readdirSync(cursor).length > 0) return;
        // `rmdirSync`, not `rmSync`: the latter refuses a directory unless told to recurse, and
        // recursing here would delete objects this call was never asked to touch.
        rmdirSync(cursor);
      } catch {
        return;
      }
      cursor = dirname(cursor);
    }
  }
}

// Where a byte belongs, and who is allowed to say so.
//
// An object store has no directories. It has a flat keyspace and a prefix search, and every
// separator in a key is a character the store itself attaches no meaning to. That is the whole
// reason this module exists as a module rather than as a handful of template literals at the
// call sites: the confinement a filesystem gives you for free — `..` cannot escape a chroot,
// a path is normalised before it is opened — is not given here at all.
//
// S3 WILL HAPPILY STORE A KEY CONTAINING "..". It is not a traversal to S3; it is two dots.
// The traversal happens later, on the machine that turns that key back into a path — which in
// this codebase is FsObjectStore, the local development implementation, writing under
// runtime/.objects/. So a key built from an unvalidated string is a hole that is invisible in
// production and lands squarely on a developer's disk. Both halves are closed here: the
// segments a key is assembled FROM are validated, and FsObjectStore re-checks the assembled
// path against its root anyway, because one wall is not a wall.
//
// EVERY KEY STARTS WITH A WORKSPACE. `ws/<workspace_id>/…`, always, with no exception and no
// second root — so "which workspace does this object belong to" is answerable from the key
// alone, by anybody holding it, without a database. That is what makes a presigned URL
// checkable against the context of the request presenting it (see presign.ts), and it is why
// the workspace id is first rather than somewhere more natural-reading like
// `agents/<id>/ws/<id>/`.
//
// IDS, NOT NAMES. The path components are uuids: the workspace's and the agent's. Not the
// agent's slug — slugs stopped being globally unique in Session 1 and are a display concern
// (§6.2 of the spec: thread the uuid). The only user-influenced text in a key is the
// project-relative file path, and that is exactly the part `safeObjectPath` exists for.

import { randomUUID } from "node:crypto";

/** 8-4-4-4-12 hex, lowercase. What `randomUUID()` produces and what both drivers store. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** NUL, the C0 range, and DEL. Not filenames, and the first of them truncates a C string. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A project-relative path is at most this long.
 *
 * S3 caps a whole key at 1024 bytes and Jaroku's prefixes eat ~90 of them; a real project path
 * is `tools/mcp_bridge.py`. The cap is here so an absurd one is refused at the boundary with a
 * sentence rather than at the store with a provider's error code.
 */
const MAX_PATH_BYTES = 512;

/** Version numbers are a bumped integer, and a sane one — see `agents.current_version`. */
const MAX_VERSION = 1_000_000_000;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

function assertUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    // The value is quoted rather than interpolated bare: the thing that reaches here wrong is
    // usually `undefined` or an empty string, and `not a uuid: ` reads as a truncated message.
    throw new KeyError(`${what} must be a uuid, not ${JSON.stringify(value)}`);
  }
  return value;
}

function assertVersion(version: unknown): number {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new KeyError(`version must be a positive integer, not ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * The gate a project-relative path passes through before it becomes part of a key.
 *
 * Returns the path unchanged when it is safe, or null when it is not. Deliberately NOT a
 * normaliser: `a/./b` is not silently rewritten to `a/b`, because a caller handing over a path
 * it has not normalised is a caller that will compare its unnormalised copy against the stored
 * key later and find they differ. Refusing is the answer that shows up immediately.
 *
 * What is refused, and why each one:
 *
 *   * `..` or `.` as a whole segment — the traversal itself. S3 stores it; FsObjectStore would
 *     resolve it; the object then lands outside the store's root.
 *   * an empty segment (`a//b`, a leading or trailing `/`) — two keys that name the same file
 *     on a filesystem and two different objects in S3, which is a cache that silently diverges.
 *   * a backslash — a separator on Windows and an ordinary character to S3. A key containing
 *     one is a directory on one machine and a filename on another.
 *   * an absolute path or a drive letter — nothing relative about it.
 *   * NUL and control characters — NUL truncates a C string, and the rest are not filenames.
 *   * `%` — S3 keys are percent-encoded in a URL, so `%2e%2e%2f` is a traversal that survives
 *     every check above and is decoded back into `../` by whatever unescapes the URL. No file
 *     in a generated agent project needs a percent sign, so the cheap answer is the right one.
 *   * a segment ending in a space or a dot — Windows silently strips both when creating a file,
 *     so `evil. ` and `evil` are one file there and two keys here.
 */
export function safeObjectPath(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (Buffer.byteLength(candidate, "utf8") > MAX_PATH_BYTES) return null;
  if (CONTROL.test(candidate)) return null;
  if (candidate.includes("\\") || candidate.includes("%")) return null;
  if (candidate.startsWith("/") || /^[a-zA-Z]:/.test(candidate)) return null;

  for (const segment of candidate.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.endsWith(" ") || segment.endsWith(".")) return null;
  }
  return candidate;
}

/** The same gate, as an assertion, for the key builders. */
function assertPath(path: unknown): string {
  const safe = safeObjectPath(path);
  if (safe === null) {
    throw new KeyError(`refusing an unsafe object path: ${JSON.stringify(path)}`);
  }
  return safe;
}

/**
 * A staging id. A uuid like everything else, but named separately because it is minted per
 * generation or per edit proposal rather than being an identity anything else knows.
 */
export function newStagingId(): string {
  return randomUUID();
}

// --- the layout ----------------------------------------------------------------------------
//
// ws/<workspace_id>/agents/<agent_id>/v<version>/<path>
// ws/<workspace_id>/agents/<agent_id>/staging/<staging_id>/<path>
// ws/<workspace_id>/exports/<eval_run_id>.csv
//
// Prefixes end in "/" and keys never do. That is not cosmetic: `list()` takes a BYTE prefix,
// exactly as S3 does, so `ws/<id>/agents/<a>/v1` without the slash would also match `v10/…`.

/** Everything one workspace owns. The prefix a deletion or an export sweep walks. */
export function workspacePrefix(workspaceId: string): string {
  return `ws/${assertUuid(workspaceId, "workspaceId")}/`;
}

/** Every version and every staging copy of one agent. */
export function agentPrefix(workspaceId: string, agentId: string): string {
  return `${workspacePrefix(workspaceId)}agents/${assertUuid(agentId, "agentId")}/`;
}

/** One immutable version of an agent's files. */
export function agentVersionPrefix(workspaceId: string, agentId: string, version: number): string {
  return `${agentPrefix(workspaceId, agentId)}v${assertVersion(version)}/`;
}

export function agentVersionKey(
  workspaceId: string,
  agentId: string,
  version: number,
  path: string,
): string {
  return `${agentVersionPrefix(workspaceId, agentId, version)}${assertPath(path)}`;
}

/** An in-flight generation or edit proposal, before anything has been committed to a version. */
export function agentStagingPrefix(workspaceId: string, agentId: string, stagingId: string): string {
  return `${agentPrefix(workspaceId, agentId)}staging/${assertUuid(stagingId, "stagingId")}/`;
}

export function agentStagingKey(
  workspaceId: string,
  agentId: string,
  stagingId: string,
  path: string,
): string {
  return `${agentStagingPrefix(workspaceId, agentId, stagingId)}${assertPath(path)}`;
}

/** A finished eval's CSV export. One object per eval run, named by it. */
export function exportKey(workspaceId: string, evalRunId: string): string {
  return `${workspacePrefix(workspaceId)}exports/${assertUuid(evalRunId, "evalRunId")}.csv`;
}

/**
 * Which workspace a key belongs to, or null when it does not name one.
 *
 * The reason the workspace id is the first path component. A presigned URL is a bearer
 * credential that outlives the request that minted it, so the thing checking one has only the
 * key — no context, no row, no join. This is what lets that check be `workspaceIdFromKey(key)
 * === ctx.workspaceId` rather than a database lookup on a path that is already leaking.
 *
 * Null for anything that is not a well-formed workspace key, INCLUDING a key whose second
 * component merely looks uuid-ish. A malformed key belongs to no workspace, and the caller's
 * comparison against a real workspace id then fails closed on its own.
 */
export function workspaceIdFromKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const parts = key.split("/");
  if (parts.length < 3 || parts[0] !== "ws") return null;
  return UUID.test(parts[1]!) ? parts[1]! : null;
}

/**
 * The gate a whole assembled key passes through on its way into a store.
 *
 * The builders above cannot be the only check, because a key also arrives from OUTSIDE them:
 * off a presigned URL, out of an `agent_versions` manifest written by an older version of this
 * code, from a `list()` result being handed to `copy()`. Every implementation of ObjectStore
 * calls this on every key it is given, so "this string was built by keys.ts" is a property that
 * gets verified rather than assumed.
 */
export function assertKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new KeyError(`an object key must be a non-empty string, not ${JSON.stringify(key)}`);
  }
  if (Buffer.byteLength(key, "utf8") > 1024) {
    throw new KeyError(`object key is too long (${Buffer.byteLength(key, "utf8")} bytes, max 1024)`);
  }
  if (key.endsWith("/")) {
    throw new KeyError(`an object key is not a prefix — it must not end in "/": ${key}`);
  }
  if (workspaceIdFromKey(key) === null) {
    throw new KeyError(`every object key must start with ws/<workspace uuid>/: ${key}`);
  }
  // The tail is validated by the same rule that built it. `ws/<uuid>/` is stripped first
  // because its own segments are uuids, which `safeObjectPath` would pass anyway — the point
  // is that the remainder is checked as a path rather than trusted for having a prefix.
  const tail = key.split("/").slice(2).join("/");
  if (safeObjectPath(tail) === null) {
    throw new KeyError(`refusing an unsafe object key: ${key}`);
  }
  return key;
}

/**
 * The same, for a prefix.
 *
 * A prefix is a byte prefix, so it is NOT required to end at a segment boundary — `ws/<id>/ag`
 * is a legal thing to ask S3 for. What it is required to be is inside a workspace, because a
 * `list()` that starts at `ws/` would enumerate every tenant on the platform, and the caller
 * that wrote it would never see a difference locally.
 */
export function assertPrefix(prefix: unknown): string {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new KeyError(`an object prefix must be a non-empty string, not ${JSON.stringify(prefix)}`);
  }
  // Not `workspaceIdFromKey`, which wants a third component: the shortest legal prefix is
  // `ws/<uuid>/` — a whole workspace — and that has nothing after the second slash.
  const parts = prefix.split("/");
  if (parts.length < 3 || parts[0] !== "ws" || !UUID.test(parts[1] ?? "")) {
    throw new KeyError(`every object prefix must start with ws/<workspace uuid>/: ${prefix}`);
  }
  if (prefix.includes("..") || prefix.includes("\\") || prefix.includes("%") || CONTROL.test(prefix)) {
    throw new KeyError(`refusing an unsafe object prefix: ${prefix}`);
  }
  return prefix;
}

// An agent's files, as versioned objects rather than as a directory.
//
// This is the seam the rest of Session 3 hangs off. Below it are the object store (bytes at
// keys) and the agent repository (rows). Above it, the generation path, the edit path, the file
// list, the validator and the graph view all want the same three things and should not each
// have to know how a version is assembled:
//
//   READ a version's files.        MATERIALISE one into a directory something can import.
//   PUBLISH a set of files as a new version, atomically.
//
// THE ATOMIC SWAP IS NOW TWO STEPS THAT CANNOT BE SEEN HALF-DONE. Objects for version N are
// written first, at keys nothing else refers to, and are never rewritten afterwards. Then one
// UPDATE moves `agents.current_version`. A reader that arrives in between sees version N-1
// complete — which is exactly the promise `renameSync` made on one filesystem, and the only
// version of that promise that survives having several replicas and no shared disk.
//
// IMMUTABILITY IS WHAT MAKES UNDO CHEAP. `.history/<id>/v<n>/` was a full copy of the project
// per applied edit, made on the machine that applied it. Here, the previous version's objects
// were never touched, so undoing is `current_version = N-1` and nothing else — no copy, no
// snapshot, and it works from a replica that has never seen this agent before.
//
// THE DIRECTORY DOES NOT GO AWAY LOCALLY, AND THAT IS DELIBERATE. `runtime/agents/<slug>/` is
// still where a run's subprocess imports from, still where a user can drop a project in by
// hand, and still what the README promises is yours and portable. It stops being the source of
// truth and becomes a materialisation of one — which is why `materialise` exists and why the
// backfill runs disk → objects exactly once per agent that has never been published.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type {
  AgentVersion, AgentRepository, VersionManifest, VersionMeta,
} from "../db/repositories/agents.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  agentStagingKey, agentStagingPrefix, agentVersionKey, safeObjectPath,
} from "./keys.ts";
import { ObjectNotFound, type ObjectStore } from "./objectStore.ts";
import type { Presigned } from "./presign.ts";

/** A project file on its way in or out. `path` is project-relative and posix-style. */
export interface StoredFile {
  path: string;
  content: string;
}

/** How long a presigned URL for an agent's own files lasts. Minutes, not hours. */
export const PROJECT_PRESIGN_TTL_S = 300;

export function sha256Of(content: string | Buffer): string {
  return createHash("sha256").update(typeof content === "string" ? Buffer.from(content, "utf8") : content).digest("hex");
}

/**
 * {path: {sha256, bytes}} for a set of files. One function, so two callers cannot disagree.
 *
 * `Object.create(null)` and not `{}`, because the keys here are file paths a model chose. On a
 * plain object `out["__proto__"] = entry` is a call to a setter, not a property: the entry is
 * swallowed, the file drops out of the manifest, and — since publish writes objects from `files`
 * and readVersion reads them back from the MANIFEST — the version silently loses a file that is
 * sitting in the store. A prototype-less object has no such key, so a path is only ever a path.
 */
export function manifestFor(files: StoredFile[]): VersionManifest {
  const out: VersionManifest = Object.create(null) as VersionManifest;
  for (const f of files) {
    out[f.path] = { sha256: sha256Of(f.content), bytes: Buffer.byteLength(f.content, "utf8") };
  }
  return out;
}

export class ProjectStore {
  constructor(
    private readonly objects: ObjectStore,
    private readonly agents: AgentRepository,
  ) {}

  /** The store underneath, for the two callers that legitimately need a key of their own. */
  get objectStore(): ObjectStore {
    return this.objects;
  }

  /**
   * Write `files` as a new immutable version and make it current.
   *
   * THREE STEPS, AND THE ORDER IS THE SAFETY PROPERTY.
   *
   *   1. RESERVE the version number, as a row that is not current yet.
   *   2. WRITE the objects under it. They are at keys nothing refers to, and are never
   *      rewritten afterwards.
   *   3. PROMOTE: one UPDATE moves `agents.current_version`.
   *
   * A reader arriving at any point sees the previous version whole, which is what the directory
   * rename used to promise. A crash between 1 and 3 leaves an unpromoted row and some objects —
   * garbage a retention sweep collects, and not a corrupted agent.
   *
   * THIS REPLACED A PREDICT-AND-CHECK VERSION THAT COULD CORRUPT AN AGENT. It read the next
   * number, wrote objects there, and then compared what the insert actually gave it. Two
   * concurrent publishes both predicted N and both wrote to N's prefix; the one that lost had
   * ALREADY bumped the pointer, and its cleanup then deleted the winner's objects — leaving
   * `current_version` on a version with no files at all. Reserving first removes the guess:
   * two callers get two numbers, each writes its own objects, and nothing deletes anything.
   */
  async publish(
    ctx: TenantContext,
    agentId: string,
    files: StoredFile[],
    meta: VersionMeta = {},
  ): Promise<{ version: number; manifest: VersionManifest }> {
    for (const f of files) {
      if (safeObjectPath(f.path) === null) {
        throw new Error(`refusing to publish an unsafe project path: ${JSON.stringify(f.path)}`);
      }
    }

    const manifest = manifestFor(files);
    const version = await this.agents.reserveVersion(ctx, agentId, manifest, meta);
    for (const f of files) {
      await this.objects.put(agentVersionKey(ctx.workspaceId, agentId, version, f.path), f.content, {
        contentType: contentTypeFor(f.path),
      });
    }
    await this.agents.promoteVersion(ctx, agentId, version);
    return { version, manifest };
  }

  /**
   * Every file of one version, in manifest order.
   *
   * Read from the manifest rather than from `list()`, deliberately. A listing is what the store
   * happens to hold; the manifest is what the version was declared to be. If they disagree —
   * a half-finished publish, an object swept early — the manifest is the truth and the missing
   * object is an error worth reporting, not a file that quietly vanishes from a project.
   */
  async readVersion(ctx: TenantContext, agentId: string, version: number): Promise<StoredFile[]> {
    const row = await this.agents.version(ctx, agentId, version);
    if (!row) return [];
    const out: StoredFile[] = [];
    for (const path of Object.keys(row.manifest).sort()) {
      const bytes = await this.objects.get(agentVersionKey(ctx.workspaceId, agentId, version, path));
      out.push({ path, content: bytes.toString("utf8") });
    }
    return out;
  }

  /** The live version's files. `[]` when the agent has never been published. */
  async readCurrent(ctx: TenantContext, agentId: string, currentVersion: number): Promise<StoredFile[]> {
    return this.readVersion(ctx, agentId, currentVersion);
  }

  /**
   * Write a version's files into a real directory.
   *
   * Because two things still need a filesystem in this session: the validator imports the
   * project with Python, and `jaroku_runner.graph` builds the compiled graph. Session 4 moves
   * both into a sandbox, at which point the destination is a tmpfs inside a micro-VM rather than
   * a directory here — and the call site does not change, which is the point of routing them
   * through this now rather than then.
   *
   * `dest` is emptied first. A materialisation into a directory holding somebody else's leftover
   * files is a project that validates code it does not contain.
   */
  async materialise(ctx: TenantContext, agentId: string, version: number, dest: string): Promise<string[]> {
    const files = await this.readVersion(ctx, agentId, version);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const f of files) {
      // Re-validated on the way OUT as well as on the way in. The manifest is data from the
      // database, and a path that became a key safely years ago is still a path being joined to
      // a directory here — the same argument FsObjectStore makes for re-checking its root.
      if (safeObjectPath(f.path) === null) {
        throw new Error(`refusing to materialise an unsafe path: ${JSON.stringify(f.path)}`);
      }
      const target = join(dest, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, "utf8");
    }
    return files.map((f) => f.path);
  }

  // --- staging ------------------------------------------------------------------------------
  //
  // An in-flight generation or edit proposal. Same keyspace, a different branch of it, and no
  // version row at all — a proposal that is never applied leaves nothing but objects under a
  // staging id, which `discardStaging` removes and a sweep would collect anyway.

  async putStaging(ctx: TenantContext, agentId: string, stagingId: string, file: StoredFile): Promise<void> {
    await this.objects.put(
      agentStagingKey(ctx.workspaceId, agentId, stagingId, file.path),
      file.content,
      { contentType: contentTypeFor(file.path) },
    );
  }

  async readStaging(ctx: TenantContext, agentId: string, stagingId: string): Promise<StoredFile[]> {
    const prefix = agentStagingPrefix(ctx.workspaceId, agentId, stagingId);
    const listed = await this.objects.list(prefix);
    const out: StoredFile[] = [];
    for (const meta of listed) {
      out.push({ path: meta.key.slice(prefix.length), content: (await this.objects.get(meta.key)).toString("utf8") });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async materialiseStaging(ctx: TenantContext, agentId: string, stagingId: string, dest: string): Promise<string[]> {
    const files = await this.readStaging(ctx, agentId, stagingId);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const f of files) {
      if (safeObjectPath(f.path) === null) {
        throw new Error(`refusing to materialise an unsafe path: ${JSON.stringify(f.path)}`);
      }
      const target = join(dest, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, "utf8");
    }
    return files.map((f) => f.path);
  }

  async discardStaging(ctx: TenantContext, agentId: string, stagingId: string): Promise<number> {
    return this.objects.deletePrefix(agentStagingPrefix(ctx.workspaceId, agentId, stagingId));
  }

  /** Promote a staging copy to a version. What "commit" means once files are objects. */
  async publishStaging(
    ctx: TenantContext,
    agentId: string,
    stagingId: string,
    meta: VersionMeta = {},
  ): Promise<{ version: number; manifest: VersionManifest }> {
    const files = await this.readStaging(ctx, agentId, stagingId);
    if (!files.length) throw new Error(`staging copy ${stagingId} is empty — nothing to publish`);
    const published = await this.publish(ctx, agentId, files, meta);
    await this.discardStaging(ctx, agentId, stagingId);
    return published;
  }

  // --- reads that do not need the bytes ------------------------------------------------------

  /** A URL that reads one file of one version, and grants nothing else. */
  async presignFile(ctx: TenantContext, agentId: string, version: number, path: string): Promise<Presigned> {
    return this.objects.presignGet(
      agentVersionKey(ctx.workspaceId, agentId, version, path),
      PROJECT_PRESIGN_TTL_S,
    );
  }

  /** Whether a version's objects are actually there. Used by the backfill to avoid re-publishing. */
  async versionIsMaterialised(ctx: TenantContext, agentId: string, row: AgentVersion): Promise<boolean> {
    for (const path of Object.keys(row.manifest)) {
      const head = await this.objects.head(agentVersionKey(ctx.workspaceId, agentId, row.version, path));
      if (!head) return false;
    }
    return Object.keys(row.manifest).length > 0;
  }

  /**
   * Publish a directory as an agent's first version, if it has none.
   *
   * The backfill. Every agent that existed before this session lives in `runtime/agents/<slug>/`
   * and has no version objects at all, so the first thing that reads through the object store
   * would find an empty project. Idempotent: an agent whose current version is materialised is
   * left alone, so this runs at every boot and does work exactly once per agent.
   *
   * `source: "import"` rather than "generation", because that is what happened. Labelling a
   * pre-existing directory as a generation would put an instruction-less row in a history list
   * that is otherwise a record of things somebody asked for.
   */
  async importFromDirectory(
    ctx: TenantContext,
    agentId: string,
    currentVersion: number,
    files: StoredFile[],
  ): Promise<{ version: number; imported: boolean }> {
    const existing = await this.agents.version(ctx, agentId, currentVersion);
    if (existing && (await this.versionIsMaterialised(ctx, agentId, existing))) {
      return { version: currentVersion, imported: false };
    }
    if (!files.length) return { version: currentVersion, imported: false };
    const { version } = await this.publish(ctx, agentId, files, { source: "import" });
    return { version, imported: true };
  }
}

/**
 * Read a directory's text files as `StoredFile`s. The disk half of the backfill.
 *
 * A SYMLINK IS NOT A FILE OF THIS PROJECT. The caller's listing already skips them, and this
 * checks again because the two are separated by a caller that could pass any list — and what
 * gets read here is written into the object store as an agent's version, permanently, and then
 * served. A link named `notes.py` pointing at `runtime/.env` would import a credential file
 * into a version and hand it to the browser.
 */
export function filesFromDirectory(dir: string, paths: string[]): StoredFile[] {
  const out: StoredFile[] = [];
  for (const path of paths) {
    const normalised = path.split(sep).join("/");
    if (safeObjectPath(normalised) === null) continue;
    try {
      const full = join(dir, path);
      if (lstatSync(full).isSymbolicLink()) continue;
      out.push({ path: normalised, content: readFileSync(full, "utf8") });
    } catch {
      // A file that vanished between the listing and the read. Skipping is right: the
      // alternative is failing a whole import over one transient.
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Advisory, and stored where a store has somewhere to store it. Nothing branches on it. */
function contentTypeFor(path: string): string {
  if (path.endsWith(".py")) return "text/x-python; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".csv")) return "text/csv; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/** Re-exported so callers do not import two modules to catch one error. */
export { ObjectNotFound };

/** `relative()` in posix form, for turning an absolute path back into a project path. */
export function projectRelative(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

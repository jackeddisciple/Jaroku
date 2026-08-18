// Filesystem helpers shared by the generation and edit flows. This is 🟡 read-every-line
// territory (doc §8 Week 4): a bad move here corrupts the user's project.
//
// Two invariants both flows rely on:
//   * atomicSwap — a directory replacement either fully succeeds or leaves the previous
//     directory exactly as it was. Never a half-written project.
//   * Reads are confined to the agent's own directory; agentId is validated against the
//     same pattern the Python runner enforces, so a client-supplied id can't traverse paths.

import {
  cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync, mkdirSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// Mirror of jaroku_runner/contract.py _SAFE_AGENT_ID — one contract, two enforcers.
const SAFE_AGENT_ID = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The gate every agent id passes through before it becomes a path.
 *
 * The type check is not defensive noise. `RegExp.test` coerces its argument to a string
 * first, so this function used to answer TRUE for `undefined` ("undefined" is lowercase
 * letters), for `null` ("null" likewise), and for `["ok_agent"]`, whose toString is the id it
 * contains. A client sending a null agent id got past the one check standing between it and
 * a path join, and came back with a Node internal error about the "path" argument.
 *
 * Ids arrive over a socket from a client that can send anything, and this guard is shared by
 * run, edit, generate, eval, graph, files and deploy — so it has to be true for exactly the
 * strings it describes and nothing else.
 */
export function isSafeAgentId(agentId: unknown): agentId is string {
  return typeof agentId === "string" && SAFE_AGENT_ID.test(agentId);
}

export interface ProjectFile {
  path: string; // project-relative, posix-style
  content: string;
  readOnly: boolean;
}

// Files the edit model may never rewrite: host-owned metadata and the package marker.
// Connector files are read-only too, but are resolved per-project (see readOnlyPaths).
//
// mcp_tools.json and tools/mcp_bridge.py are here unconditionally rather than per-project,
// on purpose. The manifest is the entire grant for an agent's MCP access, and the bridge is
// the reviewed code that honours it — an edit that could rewrite either could widen the
// agent's reach into a third-party system without anyone approving it. Listing them always,
// installed or not, also means the model cannot introduce a file masquerading as one, the
// same reason the connector block list covers every catalogue filename.
//
// The four deploy artifacts are here for a sharper version of the same reason. serve.py is
// the reviewed process that answers a PUBLICLY REACHABLE URL, and the Dockerfile decides what
// runs around it — an edit able to rewrite either could change what a container on the open
// internet does, spending the user's provider key, with nobody approving it. They are listed
// unconditionally, before the deploy layer has ever written one, so an edit cannot get in
// first with a file masquerading as one.
/**
 * The four files the deploy layer writes into a project. Exported so there is one list:
 * the artifact writer produces exactly these, and the edit loop refuses exactly these.
 */
export const DEPLOY_ARTIFACTS = new Set([
  "serve.py",
  "Dockerfile",
  ".dockerignore",
  "pyproject.toml",
]);

// EVERY PATH HERE IS A POSIX OBJECT PATH, and `tools/mcp_bridge.py` is written out rather than
// assembled with `join`. That is not style. `join` uses the PLATFORM separator, so on Windows
// this entry read `tools\mcp_bridge.py` — which matched the local paths `listProjectFiles`
// produced there and matches NOTHING in the object store, whose keys are always `/`-separated
// (storage/keys.ts refuses a backslash outright). The block list would have gone quietly empty
// for the one file it most needs to cover: the reviewed bridge that honours an agent's entire
// MCP grant.
//
// It never failed on macOS or Linux, where the separator happens to agree, which is exactly why
// it is spelled explicitly now and asserted in readOnly.test.ts rather than left to a coincidence.
const HOST_OWNED = new Set([
  "jaroku.json",
  "__init__.py",
  "mcp_tools.json",
  "tools/mcp_bridge.py",
  ...DEPLOY_ARTIFACTS,
]);

// What counts as project text worth showing/editing. Everything else (pyc, caches) is noise.
const TEXT_EXTENSIONS = new Set([".py", ".md", ".json", ".toml", ".txt"]);
const MAX_FILE_BYTES = 200_000; // sanity cap; agent projects are a few KB

// Project text with no extension to match on. A Dockerfile is the file a user is most likely
// to want to read before trusting a deploy, so it has to be visible in the file list — and
// .dockerignore is what proves .env never enters the build context, which is worth being able
// to check. Both are named exactly, the same way .env.example already is.
const EXTENSIONLESS_TEXT = new Set(["Dockerfile", ".dockerignore", ".env.example"]);

function isTextFile(name: string): boolean {
  if (EXTENSIONLESS_TEXT.has(name)) return true;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(name.slice(dot));
}

/**
 * The read-only set for a project: host-owned files + its installed connector files.
 *
 * `connectorFiles` are project-relative, posix-style — `tools/postgres.py`. Callers pass every
 * filename in the catalogue rather than only the installed ones, so the model cannot introduce
 * a file masquerading as a reviewed template.
 */
export function readOnlyPaths(connectorFiles: string[]): Set<string> {
  return new Set([...HOST_OWNED, ...connectorFiles]);
}

/** The host-owned half on its own, for the test that asserts what it contains and how. */
export function hostOwnedPaths(): string[] {
  return [...HOST_OWNED].sort();
}

/**
 * WHY a file cannot be edited, in one sentence, or null when it can be.
 *
 * §6 asks the file browser to show read-only files "with the stored reason shown", and until now
 * there was no reason to show: `ProjectFile.readOnly` is a boolean, and the arguments for each half
 * of the block list lived only in the comments above it. A lock with no explanation is the kind of
 * refusal people work around rather than understand — and these three refusals are each protecting
 * something different, which is precisely what a single "read-only" badge cannot say.
 *
 * DERIVED FROM THE SAME SETS `readOnlyPaths` BUILDS, not from a second table. A reason that could
 * disagree with the block list would be worse than none: the browser would explain why a file is
 * locked while the edit loop happily rewrote it, or the reverse. The order below matches the order
 * `readOnlyPaths` unions them in, so a path in two sets is described by the same half that would
 * have put it in the set.
 *
 * POSIX SEPARATORS, like everything compared against these sets. `tools/mcp_bridge.py` is written
 * out rather than assembled, for the reason HOST_OWNED gives at length: `join` uses the platform
 * separator, and a Windows backslash matched the local paths and matched nothing in the object
 * store — silently emptying the block list for the one file that carries an agent's entire MCP
 * grant.
 */
export function readOnlyReason(path: string, connectorFiles: string[]): string | null {
  if (DEPLOY_ARTIFACTS.has(path)) {
    return "the deploy layer writes this — serve.py answers a public URL and the Dockerfile decides what runs around it";
  }
  if (path === "mcp_tools.json" || path === "tools/mcp_bridge.py") {
    return "this is the agent's MCP grant and the reviewed code that honours it — editing it would widen its reach without anyone approving it";
  }
  if (HOST_OWNED.has(path)) return "host-owned project metadata, written by Jaroku rather than by a model";
  if (connectorFiles.includes(path)) return "a reviewed connector template, copied in verbatim and audited as written";
  return null;
}

/**
 * All text files of an agent project, sorted, with read-only flags. `connectorFiles` are
 * project-relative connector template paths (e.g. "tools/gmail.py").
 *
 * SYMLINKS ARE SKIPPED, not followed, and that is a security property rather than tidiness.
 * This list is served to the browser and — since Session 3 — copied into the object store as
 * an agent's version, permanently. A project directory is something a user can edit and a
 * generated project is something a model wrote, so a link named `notes.py` pointing at
 * `../../.env`, or at `/etc/passwd`, would turn "show me my agent's code" into an arbitrary
 * file read on a shared host. `lstat`, so the link is seen as a link; a link that points back
 * up its own tree would also be an unbounded walk.
 */
export function listProjectFiles(projectDir: string, connectorFiles: string[]): ProjectFile[] {
  const readOnly = readOnlyPaths(connectorFiles);
  const out: ProjectFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__pycache__" || (entry.startsWith(".") && !EXTENSIONLESS_TEXT.has(entry))) continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
      } else if (isTextFile(entry) && stat.size <= MAX_FILE_BYTES) {
        const rel = relative(projectDir, full).split("\\").join("/");
        out.push({ path: rel, content: readFileSync(full, "utf8"), readOnly: readOnly.has(rel) });
      }
    }
  };

  walk(projectDir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Copy a project directory, skipping caches. Used for staging seeds and history snapshots. */
export function copyProject(fromDir: string, toDir: string): void {
  rmSync(toDir, { recursive: true, force: true });
  cpSync(fromDir, toDir, {
    recursive: true,
    filter: (src) => basename(src) !== "__pycache__",
  });
}

/**
 * Replace `toDir` with `fromDir`, keeping the old copy until the swap succeeds.
 * (Extracted from Generator.commit — same semantics, now shared with the edit flow.)
 */
export function atomicSwap(fromDir: string, toDir: string): void {
  const backup = `${toDir}.replaced-${Date.now()}`;
  if (existsSync(toDir)) renameSync(toDir, backup);
  try {
    mkdirSync(dirname(toDir), { recursive: true });
    renameSync(fromDir, toDir);
  } catch (err) {
    if (existsSync(backup)) renameSync(backup, toDir); // put it back
    throw err;
  }
  rmSync(backup, { recursive: true, force: true });
}

// Filesystem helpers shared by the generation and edit flows. This is 🟡 read-every-line
// territory (doc §8 Week 4): a bad move here corrupts the user's project.
//
// Two invariants both flows rely on:
//   * atomicSwap — a directory replacement either fully succeeds or leaves the previous
//     directory exactly as it was. Never a half-written project.
//   * Reads are confined to the agent's own directory; agentId is validated against the
//     same pattern the Python runner enforces, so a client-supplied id can't traverse paths.

import {
  cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, mkdirSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// Mirror of jaroku_runner/contract.py _SAFE_AGENT_ID — one contract, two enforcers.
const SAFE_AGENT_ID = /^[a-z][a-z0-9_]{0,63}$/;

export function isSafeAgentId(agentId: string): boolean {
  return SAFE_AGENT_ID.test(agentId);
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

const HOST_OWNED = new Set([
  "jaroku.json",
  "__init__.py",
  "mcp_tools.json",
  join("tools", "mcp_bridge.py"),
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

/** The read-only set for a project: host-owned files + its installed connector files. */
export function readOnlyPaths(connectorFiles: string[]): Set<string> {
  return new Set([...HOST_OWNED, ...connectorFiles]);
}

/**
 * All text files of an agent project, sorted, with read-only flags. `connectorFiles` are
 * project-relative connector template paths (e.g. "tools/gmail.py").
 */
export function listProjectFiles(projectDir: string, connectorFiles: string[]): ProjectFile[] {
  const readOnly = readOnlyPaths(connectorFiles);
  const out: ProjectFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__pycache__" || (entry.startsWith(".") && !EXTENSIONLESS_TEXT.has(entry))) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
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

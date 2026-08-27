// Putting the deploy artifacts into an agent project.
//
// 🟡 read-every-line territory, like projectFs.ts: this writes into the user's own project.
//
// The discipline is the one generation and the fix loop already use — stage a full copy, do
// the work there, atomic-swap it back — for the reason stated in the brief: a failed or
// partial deploy must never corrupt the project locally. A crash halfway through writing four
// files into a live directory would leave a project that has a Dockerfile and no serve.py,
// which builds an image that cannot start. The swap makes it all-or-nothing.
//
// Deliberately no .history snapshot, unlike the fix loop's Apply. Every file written here is
// host-owned and read-only to edits (projectFs.DEPLOY_ARTIFACTS), so there is no user work an
// Undo could restore — a history entry would only be noise in a list whose whole job is
// showing what you changed.

import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { loadConnectors, templatesDir } from "./connectors.ts";
import { buildArtifacts, VENDORED_RUNTIME_DIR, VENDORED_RUNTIME_ENTRIES } from "./dockerfile.ts";
import { atomicSwap, copyProject, DEPLOY_ARTIFACTS, isSafeAgentId } from "./projectFs.ts";

/** The reviewed serve wrapper, copied byte-for-byte. Never rendered — see dockerfile.ts. */
const SERVE_TEMPLATE = "serve.py";

/**
 * Sibling of generation's `.staging/<id>` and the fix loop's `.staging/<id>__edit`. A distinct
 * suffix so a deploy in flight can never collide with an edit proposal for the same agent, and
 * so the startup sweep of `.staging` collects an interrupted deploy like any other orphan.
 */
const STAGING_SUFFIX = "__deploy";

export interface AgentMeta {
  connectors: string[];
  mcp_servers?: string[];
  required_env?: string[];
  description?: string;
  name?: string;
}

export interface WriteArtifactsOptions {
  runtimeDir: string;
  agentId: string;
  /** What the deployed instance will run on — decides which provider SDK is installed. */
  provider: string;
}

export interface WrittenArtifacts {
  /** Project-relative paths, sorted. Exactly DEPLOY_ARTIFACTS. */
  paths: string[];
  /** The dependency list baked into the image, so a caller can show it before building. */
  requires: string[];
  /**
   * The reviewed Jaroku packages vendored into the project for this build, project-relative
   * and sorted, and the bytes they came to.
   *
   * Reported rather than assumed for the same reason `requires` is: a deploy log that says
   * "wrote four files" while quietly adding a directory of somebody else's code to the image
   * is a deploy log that is hiding the interesting half. The size is here because it is the
   * one number a reader can use to decide whether the image grew by an amount they mind.
   */
  vendored: string[];
  vendoredBytes: number;
}

/**
 * Copy Jaroku's own reviewed packages into the staged project, byte for byte.
 *
 * VENDORED AT DEPLOY TIME, EXACTLY AS serve.py AND THE CONNECTOR TEMPLATES ALREADY ARE, and
 * that is the property rather than an implementation detail: an image that exists was built
 * from the bytes that were on disk the day it was built, and editing `runtime/jaroku_runner/`
 * tomorrow does not reach back into it. Redeploy is how a deployed agent gets a newer runner —
 * the same rule `mcp_bridge.py` holds, for the same reason.
 *
 * INTO THE STAGING DIRECTORY, NEVER THE LIVE PROJECT. Everything else `writeDeployArtifacts`
 * does is staged and atomic-swapped so a failed deploy leaves the project byte-identical; two
 * more directories written directly into the project would be the one part of it that a crash
 * could leave half-finished, which is precisely the property this module exists to hold.
 *
 * `__pycache__` is filtered on the way in, the same filter `copyProject` uses. Compiled
 * bytecode from this machine's interpreter is not portable to the image's, and it would be
 * both dead weight and a confusing thing to find in somebody's build context.
 */
function vendorRuntime(runtimeDir: string, staging: string): { paths: string[]; bytes: number } {
  const target = join(staging, VENDORED_RUNTIME_DIR);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const paths: string[] = [];
  let bytes = 0;
  const measure = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__pycache__") continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) measure(full, `${prefix}/${entry}`);
      else if (stat.isFile()) {
        paths.push(`${prefix}/${entry}`);
        bytes += stat.size;
      }
    }
  };

  for (const entry of VENDORED_RUNTIME_ENTRIES) {
    const source = join(runtimeDir, entry);
    if (!existsSync(source)) {
      // Refused, not skipped. A missing runner produces an image that builds, starts, answers
      // /health, and fails on the first request with an ImportError — a deployment that looks
      // healthy and is not, which is the failure mode this whole file is built to avoid.
      throw new Error(`cannot vendor ${entry} for the image: ${source} does not exist`);
    }
    const dest = join(target, entry);
    if (lstatSync(source).isDirectory()) {
      cpSync(source, dest, { recursive: true, filter: (src) => basename(src) !== "__pycache__" });
      measure(dest, `${VENDORED_RUNTIME_DIR}/${entry}`);
    } else {
      copyFileSync(source, dest);
      paths.push(`${VENDORED_RUNTIME_DIR}/${entry}`);
      bytes += lstatSync(dest).size;
    }
  }
  return { paths: paths.sort(), bytes };
}

export function agentsRoot(runtimeDir: string): string {
  return join(runtimeDir, "agents");
}

export function deployStagingDir(runtimeDir: string, agentId: string): string {
  return join(agentsRoot(runtimeDir), ".staging", `${agentId}${STAGING_SUFFIX}`);
}

/** An agent's own metadata, read as a partial — the same posture listAgents() takes. */
export function readAgentMeta(runtimeDir: string, agentId: string): AgentMeta {
  const path = join(agentsRoot(runtimeDir), agentId, "jaroku.json");
  if (!existsSync(path)) return { connectors: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentMeta>;
    return {
      connectors: Array.isArray(parsed.connectors) ? parsed.connectors : [],
      mcp_servers: Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [],
      required_env: Array.isArray(parsed.required_env) ? parsed.required_env : [],
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
    };
  } catch {
    // Unreadable metadata means the smallest possible image, not a failed deploy: the agent
    // still has an agent.py, and a missing connector shows up as a clear ImportError at build
    // time rather than as a silent refusal to deploy at all.
    return { connectors: [] };
  }
}

/**
 * Write the four deploy artifacts into `agents/<agentId>/`, atomically.
 *
 * Returns what was written and what the image will install. Throws — and leaves the project
 * byte for byte as it was — if anything goes wrong.
 */
export function writeDeployArtifacts(opts: WriteArtifactsOptions): WrittenArtifacts {
  const { runtimeDir, agentId, provider } = opts;
  if (!isSafeAgentId(agentId)) throw new Error(`invalid agent id: ${agentId}`);

  const projectDir = join(agentsRoot(runtimeDir), agentId);
  if (!existsSync(join(projectDir, "agent.py"))) {
    throw new Error(`${agentId} has no agent.py — there is nothing to serve`);
  }

  const serveTemplate = join(templatesDir(runtimeDir), SERVE_TEMPLATE);
  if (!existsSync(serveTemplate)) {
    throw new Error(`the serve template is missing from ${templatesDir(runtimeDir)}`);
  }

  const meta = readAgentMeta(runtimeDir, agentId);
  const artifacts = buildArtifacts(
    {
      agentId,
      connectors: meta.connectors,
      hasMcpTools: existsSync(join(projectDir, "mcp_tools.json")),
      provider,
      description: meta.description,
    },
    loadConnectors(runtimeDir),
  );

  const staging = deployStagingDir(runtimeDir, agentId);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(agentsRoot(runtimeDir), ".staging"), { recursive: true });
  let vendored: { paths: string[]; bytes: number } = { paths: [], bytes: 0 };

  try {
    copyProject(projectDir, staging);

    // The reviewed template first, then the synthesised files. Order does not matter here the
    // way it does in generation (nothing else is writing), but keeping it means the one file
    // that is copied rather than rendered is visibly separate from the three that are not.
    copyFileSync(serveTemplate, join(staging, SERVE_TEMPLATE));
    for (const [rel, contents] of Object.entries(artifacts.files)) {
      writeFileSync(join(staging, rel), contents, "utf8");
    }
    // AND JAROKU'S OWN CODE, INSIDE THE SAME STAGING DIRECTORY AND THEREFORE INSIDE THE SAME
    // ALL-OR-NOTHING SWAP. Two more directories do not weaken that property; they are only
    // covered by it because they go through here rather than beside it.
    vendored = vendorRuntime(runtimeDir, staging);

    // Nothing is swapped in that we did not put there. A missing file at this point would mean
    // a partially written project going live, which is exactly what staging exists to prevent.
    // The vendored packages are checked the same way: `vendorRuntime` refuses a missing source,
    // and this re-reads what actually landed, because the failure being guarded against is a
    // write that did not happen rather than a source that was not there.
    const missing = [...DEPLOY_ARTIFACTS, ...vendored.paths].filter(
      (rel) => !existsSync(join(staging, rel)),
    );
    if (missing.length) {
      throw new Error(`deploy artifacts were not written: ${missing.join(", ")}`);
    }

    atomicSwap(staging, projectDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  return {
    paths: [...DEPLOY_ARTIFACTS].sort(),
    requires: artifacts.requires,
    vendored: vendored.paths,
    vendoredBytes: vendored.bytes,
  };
}

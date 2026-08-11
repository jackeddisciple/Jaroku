// Which files an agent has, and where the answer is allowed to come from.
//
// A function rather than a closure in index.ts, and that is the point of the module: this
// decides what one workspace may read of an agent's source, and a decision like that has to be
// callable by a test. The version it lived in as a closure had a bug nothing could reach.
//
// THE DISK HAS NO WORKSPACE IN IT. `runtime/agents/<slug>/` is one namespace shared by every
// workspace on the box, while a slug is unique PER workspace — so two tenants can each have a
// `support_bot` and only one of them owns the directory. Anything that answers "this agent's
// files" by falling back to that directory hands the other tenant's generated source to a
// lookup that correctly found the caller's OWN row.
//
// So there are exactly two sources, and the second is narrow:
//
//   1. THE PUBLISHED VERSION, out of the object store. The answer in every hosted case, and in
//      every local one after the boot import has run.
//
//   2. THE DIRECTORY, only when there is no row at all AND the caller is the workspace this
//      process acts in. That is the hand-dropped project — somebody put a directory under
//      runtime/agents/ between boots — and the workspace that adopts it is the one the disk
//      sync adopts into. Any other workspace gets nothing, because there is nothing of theirs
//      there.
//
// An agent whose row exists but whose version is empty answers EMPTY. That reads oddly and is
// correct: the row says the agent is theirs, the store says they have published nothing, and
// the directory is somebody else's.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentRepository } from "./db/repositories/agents.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { ProjectStore } from "./storage/projectStore.ts";
import { listProjectFiles, readOnlyPaths, type ProjectFile } from "./projectFs.ts";

export interface AgentFilesDeps {
  runtimeDir: string;
  agents: AgentRepository;
  projects: ProjectStore;
  /** The connector template paths an agent has installed, project-relative and posix-style. */
  connectorFilesFor: (agent: Agent | undefined, slug: string) => string[];
  /** The workspace this process acts in. The only one a hand-dropped directory belongs to. */
  serverWorkspaceId: () => string;
}

/** Where an answer came from. Returned so a caller can log it and a test can assert it. */
export type AgentFilesSource = "version" | "disk" | "none";

export interface AgentFilesResult {
  files: ProjectFile[];
  source: AgentFilesSource;
}

export async function readAgentFiles(
  deps: AgentFilesDeps,
  ctx: TenantContext,
  slug: string,
): Promise<AgentFilesResult> {
  const agent = await deps.agents.bySlug(ctx, slug);
  const connectorFiles = deps.connectorFilesFor(agent, slug);

  if (agent) {
    const stored = await deps.projects.readCurrent(ctx, agent.id, agent.current_version);
    if (stored.length) {
      const readOnly = readOnlyPaths(connectorFiles);
      return {
        source: "version",
        files: stored.map((f) => ({ path: f.path, content: f.content, readOnly: readOnly.has(f.path) })),
      };
    }
    // Their row, their empty version. Never the shared directory — see the note above.
    return { files: [], source: "none" };
  }

  if (ctx.workspaceId !== deps.serverWorkspaceId()) return { files: [], source: "none" };
  const dir = join(deps.runtimeDir, "agents", slug);
  if (!existsSync(dir)) return { files: [], source: "none" };
  return { files: listProjectFiles(dir, connectorFiles), source: "disk" };
}

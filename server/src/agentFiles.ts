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
//   2. THE DIRECTORY, only when NO workspace has a row for that slug AND the caller is the
//      workspace this process acts in. That is the hand-dropped project — somebody put a
//      directory under runtime/agents/ between boots — and the workspace that adopts it is the
//      one the disk sync adopts into. Any other workspace gets nothing, because there is
//      nothing of theirs there; and a directory another workspace materialised is not
//      hand-dropped, it is theirs, so having no row for it is not a claim to it either.
//
// An agent whose row exists but whose version is empty answers EMPTY. That reads oddly and is
// correct: the row says the agent is theirs, the store says they have published nothing, and
// the directory is somebody else's.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentRepository } from "./db/repositories/agents.ts";
import type { IdentityRepository } from "./db/repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
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
  /** Whether some other workspace owns this slug — see `slugsOwnedElsewhere` below. */
  ownedElsewhere: (slug: string) => Promise<boolean>;
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
  // Hand-dropped means nobody's. A directory whose slug another workspace owns is that
  // workspace's materialised copy, and having no row for it is not a claim to it. Only reached
  // when there is no row here at all, so the lookup is off the path every ordinary read takes.
  if (await deps.ownedElsewhere(slug)) return { files: [], source: "none" };
  return { files: listProjectFiles(dir, connectorFiles), source: "disk" };
}

/**
 * The slugs under `runtime/agents/` that belong to somebody else.
 *
 * The other half of the same rule, for the boot reconciliation rather than for a read. That scan
 * runs as the workspace this process acts in and adopts every directory it finds — but a
 * directory is written by whichever workspace generated or edited the agent, so adopting them
 * all gave the local workspace a row per foreign agent, carrying that agent's name, description,
 * connectors and required-env. And a row makes the directory readable: `readAgentFiles` hands
 * the disk to a workspace with no row, which the adoption then created.
 *
 * Workspace by workspace, and never one unscoped query, for the reason the startup sweeps give:
 * as the application role under RLS an unscoped read of `agents` returns nothing, so the filter
 * would come back empty in precisely the deployment that has more than one tenant in it.
 */
export async function slugsOwnedElsewhere(
  deps: { agents: AgentRepository; identity: IdentityRepository },
  serverWorkspaceId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of await deps.identity.listWorkspaceIds(systemContext(newRequestId()))) {
    if (id === serverWorkspaceId) continue;
    for (const agent of await deps.agents.list(systemContextFor(id, newRequestId()))) out.add(agent.slug);
  }
  return out;
}

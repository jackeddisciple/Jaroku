// The workspace this process acts in, until there is authentication.
//
// Session 2 replaces every line of this with a real one: a JWT verified against the auth
// provider's JWKS, a membership lookup, a per-socket ticket. What matters now is that the
// SHAPE is already right — a request arrives, a workspace is resolved for it, and everything
// downstream takes that context as a parameter. When the resolution becomes real, nothing
// below it changes.
//
// It is loud on purpose. A server that silently decides which tenant it is acting as is the
// thing this whole session exists to make impossible, and the one place it is still allowed
// to happen should say so every time it starts.

import { IdentityRepository, slugify } from "./db/repositories/identity.ts";
import {
  LOCAL_WORKSPACE_ID,
  newRequestId,
  systemContext,
  systemContextFor,
  type TenantContext,
} from "./db/tenant.ts";
import type { Db } from "./db/db.ts";

/** Name or slug of the workspace `npm run dev` acts in. Defaults to the local one. */
export const DEV_WORKSPACE_ENV = "JAROKU_DEV_WORKSPACE";

export interface DevTenancy {
  workspaceId: string;
  slug: string;
  /** A fresh context per call. The request id is what correlates a log line to a trace. */
  context: () => TenantContext;
}

/**
 * Resolve the development workspace, creating it if it was named and does not exist.
 *
 * Unset means the workspace migration 004 created and backfilled every pre-tenancy row into,
 * which is what makes an existing jaroku.db open with all of its history rather than empty.
 * Set means a named one — the way to run two workspaces against one server and watch them
 * fail to see each other, which is the point of the isolation suite.
 */
export async function resolveDevTenancy(db: Db, log: (m: string) => void = console.log): Promise<DevTenancy> {
  const requested = (process.env[DEV_WORKSPACE_ENV] ?? "").trim();
  const sys = systemContext(newRequestId());
  const identity = new IdentityRepository(db);

  if (!requested) {
    const local = await identity.workspaceById(sys, LOCAL_WORKSPACE_ID);
    log(
      `[tenancy] no authentication yet — acting as workspace "${local?.slug ?? "local"}" ` +
        `(${LOCAL_WORKSPACE_ID}). Set ${DEV_WORKSPACE_ENV} to use another.`,
    );
    return {
      workspaceId: LOCAL_WORKSPACE_ID,
      slug: local?.slug ?? "local",
      context: () => systemContextFor(LOCAL_WORKSPACE_ID, newRequestId()),
    };
  }

  const slug = slugify(requested);
  let ws = await identity.workspaceBySlug(sys, slug);
  if (!ws) {
    // Unowned, like the importer's: nobody has signed in, and inventing a member to hold it
    // would put a person in the list who does not exist.
    ws = await identity.createWorkspaceUnowned(sys, { name: requested, kind: "team" });
    log(`[tenancy] created workspace "${ws.name}" (${ws.slug}) for ${DEV_WORKSPACE_ENV}`);
  }
  const id = ws.id;
  log(
    `[tenancy] no authentication yet — acting as workspace "${ws.slug}" (${id}), ` +
      `from ${DEV_WORKSPACE_ENV}.`,
  );
  return { workspaceId: id, slug: ws.slug, context: () => systemContextFor(id, newRequestId()) };
}

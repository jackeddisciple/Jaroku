// The workspace this process acts in ON ITS OWN BEHALF.
//
// Session 2 took this off the request path, and Session 1's prediction held: the SHAPE did not
// change. A connection arrives, a workspace is resolved for it, everything downstream takes
// that context as a parameter — only the resolution became real, and it now lives in
// auth/socketAuth.ts, where it redeems a ticket minted after a membership check.
//
// What is left here is the workspace for work NOBODY TRIGGERED, which is a real and permanent
// category rather than a leftover: the startup run, the checkpoint sweep, the reconciliation of
// evals and deploys a restart interrupted. None of those has a user, and giving them a
// TenantContext with a made-up actor would make "the server did this" indistinguishable from
// "somebody did this". It is also what `JAROKU_DEV_AUTH=1` hands to a socket that presents no
// ticket — see auth/socketAuth.ts, which refuses to start under NODE_ENV=production.
//
// It stays loud. A server that silently decides which tenant it is acting as is the thing this
// session exists to make impossible, and this is the one place it still does.

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
      `[tenancy] server-side work runs in workspace "${local?.slug ?? "local"}" ` +
        `(${LOCAL_WORKSPACE_ID}). Set ${DEV_WORKSPACE_ENV} to use another. ` +
        `Requests and sockets resolve their own workspace — see auth/socketAuth.ts.`,
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
    `[tenancy] server-side work runs in workspace "${ws.slug}" (${id}), from ${DEV_WORKSPACE_ENV}. ` +
      `Requests and sockets resolve their own workspace — see auth/socketAuth.ts.`,
  );
  return { workspaceId: id, slug: ws.slug, context: () => systemContextFor(id, newRequestId()) };
}

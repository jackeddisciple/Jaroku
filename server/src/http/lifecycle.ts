// Asking for everything you have, and coming back for it.
//
// TWO ROUTES, AND NEITHER IS A SOCKET COMMAND. Everything else the product does goes down the
// WebSocket, and this deliberately does not: what an export produces is a FILE a browser
// downloads, and a download is a request with a URL. Putting it on the socket would mean
// inventing a way to hand a browser a link over a frame, which is a URL with extra steps.
//
// POST STARTS ONE AND ANSWERS IMMEDIATELY. Reading a year of steps is minutes of work; a request
// that holds a connection for minutes is one a load balancer kills at four and a user reloads at
// two — and each reload starts another. So the POST enqueues and returns 202 with an id, and the
// GET says whether that id is ready.
//
// THE STATUS CHECK IS STATELESS, which is the part worth explaining. There is no job table and
// no sticky routing: the worker writes the archive at a key derived from the export id, and the
// GET asks the object store whether that key exists. A gateway replica that has never heard of
// the job answers correctly, a worker that died mid-export leaves no object and therefore no
// false "ready", and nothing has to be reconciled after a restart.
//
// AN OWNER'S DECISION. `workspace:manage`, not a member's or an admin's — an export is a copy of
// every trace, and therefore of every mail body and database row an agent ever read, and the
// link lands in whoever asked for it.

import { randomUUID } from "node:crypto";
import { requireCapability } from "../auth/capabilities.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { ObjectStore } from "../storage/objectStore.ts";
import { EXPORT_URL_TTL_S, WorkspaceExporter } from "../lifecycle/export.ts";
import { badRequest, type Handler, type HttpRequest } from "./router.ts";

export interface LifecycleRouteDeps {
  /** Delete the workspace and everything of it, returning the receipt. */
  deleteWorkspace?: (ctx: TenantContext) => Promise<unknown>;
  /** The workspace this request is acting in, resolved exactly as every other route resolves it. */
  contextFor: (req: HttpRequest) => Promise<TenantContext>;
  objects: ObjectStore;
  /** Put the work somewhere a worker will find it. Returns once the job is durable. */
  enqueueExport: (ctx: TenantContext, exportId: string) => Promise<void>;
  /** Recorded, because "who took a copy of everything, and when" is an audit question. */
  audit?: (ctx: TenantContext, action: string, detail: Record<string, unknown>) => Promise<void>;
}

export interface LifecycleRoute {
  method: "GET" | "POST";
  path: string;
  prefix?: boolean;
  handler: Handler;
}

export function lifecycleRoutes(deps: LifecycleRouteDeps): LifecycleRoute[] {
  return [
    {
      method: "POST",
      path: "/v1/workspace/export",
      handler: async (req) => {
        const ctx = await deps.contextFor(req);
        requireCapability(ctx, "workspace:manage");
        const exportId = randomUUID();
        await deps.enqueueExport(ctx, exportId);
        await deps.audit?.(ctx, "workspace.export_requested", { exportId });
        return {
          status: 202,
          body: {
            exportId,
            status: "pending",
            // Where to look, so a client does not have to know how to build this URL. The one
            // place a route's shape is stated is the route table above, and answering with it
            // keeps a caller from hardcoding a second copy.
            statusUrl: `/v1/workspace/export/${exportId}`,
          },
        };
      },
    },
    {
      method: "GET",
      path: "/v1/workspace/export/",
      prefix: true,
      handler: async (req) => {
        const ctx = await deps.contextFor(req);
        requireCapability(ctx, "workspace:manage");
        const exportId = req.path.slice("/v1/workspace/export/".length);
        if (!exportId) throw badRequest("which export?");
        // THE KEY IS BUILT FROM THE CONTEXT'S WORKSPACE, never from anything on the URL. An id
        // from another workspace's export resolves to a key under THIS workspace's prefix, which
        // does not exist — so a leaked id is a 404 rather than somebody else's archive.
        let key: string;
        try {
          key = WorkspaceExporter.keyFor(ctx.workspaceId, exportId);
        } catch {
          throw badRequest("that is not an export id");
        }
        const meta = await deps.objects.head(key);
        if (!meta) {
          // 200, not 404: the export may simply not have finished, and a 404 tells a polling
          // client to stop. A caller that wants "no such export" gets it from an id it never
          // received, which is a case nothing legitimate reaches.
          return { body: { exportId, status: "pending" } };
        }
        const download = await deps.objects.presignGet(key, EXPORT_URL_TTL_S);
        await deps.audit?.(ctx, "workspace.export_downloaded", { exportId, bytes: meta.bytes });
        return {
          body: {
            exportId,
            status: "ready",
            bytes: meta.bytes,
            generatedAt: meta.modifiedAt,
            url: download.url,
            // Stated rather than left for the caller to infer from the URL, which on the local
            // store carries no expiry a client could read.
            expiresAt: download.expiresAt,
          },
        };
      },
    },
    {
      method: "POST",
      path: "/v1/workspace/delete",
      handler: async (req) => {
        const ctx = await deps.contextFor(req);
        requireCapability(ctx, "workspace:manage");
        if (!deps.deleteWorkspace) throw badRequest("this deployment cannot delete a workspace");

        // TYPED CONFIRMATION, AND IT IS NOT DECORATION. Every other destructive action in this
        // product is reversible — an undo is a version pointer, a suspension is a row somebody
        // lifts — and this one is not. A body carrying the workspace's own id is the cheapest
        // possible proof that the caller knows which workspace they are about to lose, and it is
        // the same shape every platform's delete dialog uses for the same reason.
        const body = await req.json<{ confirm?: unknown }>();
        if (body.confirm !== ctx.workspaceId) {
          throw badRequest(`to delete this workspace, send {"confirm": "<its id>"}`);
        }

        const receipt = await deps.deleteWorkspace(ctx);
        await deps.audit?.(ctx, "workspace.delete_requested", { via: "http" });
        // The receipt is the answer, not a 204. Somebody asked for their data to be destroyed and
        // is entitled to the count of what was — including whatever could not be revoked at a
        // provider, which is the part a silent success would hide.
        return { body: receipt as Record<string, unknown> };
      },
    },
  ];
}

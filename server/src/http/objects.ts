// Redeeming a presigned URL against the local object store.
//
// S3 has an endpoint of its own, so a presigned S3 URL needs nothing from this server. The
// local store does not — it is a directory — so the URL it mints points here, and this is what
// makes `FsObjectStore` a real implementation of the interface rather than one with a stub
// where presigning should be. That matters beyond tidiness: Session 4's sandbox spec fetches an
// agent version over a presigned URL, and a local development sandbox has to be able to.
//
// THREE CHECKS, IN THIS ORDER, AND THE ORDER IS THE POINT:
//
//   1. THE SIGNATURE, which proves this server minted this URL for this key and this verb, and
//      that it has not expired. Without it nothing else is worth doing.
//
//   2. THE KEY, re-validated. `verifyLocalUrl` already does it, and the store does it again,
//      because a valid signature over a hostile key is precisely the thing that matters if the
//      signing secret ever leaks — and the answer must be that a leaked secret still cannot
//      name a path outside the keyspace.
//
//   3. THE WORKSPACE, when the request carries a session. Every key names its workspace as its
//      first component, so a request that presents a credential must present one for the
//      workspace whose object it is asking for. That is the "rejected for a B-scoped request
//      even if leaked" rule from the spec, and it is what stops a URL that escaped into a chat
//      log from being usable by another tenant of the same deployment.
//
// A REQUEST WITH NO CREDENTIAL AND A GOOD SIGNATURE IS ALLOWED, and that is deliberate rather
// than an oversight. It is what a presigned URL IS: a short-lived bearer capability for one
// object, redeemable by something holding no session — a sandbox, a download the browser hands
// to the OS. Making the local store refuse it would make it stricter than S3, which means the
// two implementations would behave differently, which is the one thing the interface exists to
// prevent. The mitigations are the ones presigning always relies on: one key, one verb, minutes
// of validity, and a key that cannot address anything outside its own workspace.

import { forbidden, notFound, type Handler, type HttpRequest, type HttpResponse } from "./router.ts";
import { OBJECT_ROUTE_PREFIX, verifyLocalUrl } from "../storage/presign.ts";
import { ObjectNotFound, type ObjectStore } from "../storage/objectStore.ts";

export { OBJECT_ROUTE_PREFIX };

export interface ObjectRouteDeps {
  /** The store to read and write. Only ever the local one — S3 answers its own URLs. */
  objects: ObjectStore;
  /** The key that signed the URL. The same one `FsObjectStore` was constructed with. */
  signingKey: Buffer;
  /**
   * The workspace this request is authenticated for, or null when it carries no credential.
   *
   * Injected rather than resolved here, so the HTTP layer does not grow a dependency on the
   * auth layer for one lookup — the same shape `Router` uses for its origin policy. Returning
   * null must mean "no credential was presented", never "the credential was bad": a bad token
   * has to be a refusal, and a resolver that collapsed the two would turn one into access.
   */
  workspaceFor: (req: HttpRequest) => Promise<string | null>;
}

/**
 * Verify the URL, then answer it. Shared by both verbs so the checks cannot drift apart.
 *
 * Every refusal is a 403 with the same message. Distinguishing "expired" from "wrong signature"
 * from "not your workspace" would let somebody holding a URL learn which of those they had, and
 * none of those answers is one this endpoint owes an unauthenticated caller.
 */
async function authorise(req: HttpRequest, deps: ObjectRouteDeps, expected: "get" | "put"): Promise<string> {
  const verified = verifyLocalUrl(deps.signingKey, `${req.path}${req.url.search}`);
  if (!verified.ok) throw forbidden("that object URL is not valid");
  if (verified.op !== expected) throw forbidden("that object URL is not valid");

  const workspaceId = await deps.workspaceFor(req);
  if (workspaceId !== null && workspaceId !== verified.workspaceId) {
    // A credential was presented, and it is for a different workspace than the key names. This
    // is the leaked-URL case, and it is the one refusal worth logging loudly — a cross-tenant
    // access attempt is a security event rather than a 404, which is the rule Session 8's
    // cross-tenant-denial counter will alert on.
    console.warn(
      `[objects] ${req.requestId} refused: a request scoped to ${workspaceId} presented a URL ` +
        `for ${verified.workspaceId}`,
    );
    throw forbidden("that object URL is not valid");
  }
  return verified.key;
}

export function objectRoutes(deps: ObjectRouteDeps): { method: "GET" | "PUT"; prefix: string; handler: Handler }[] {
  const get: Handler = async (req): Promise<HttpResponse> => {
    const key = await authorise(req, deps, "get");
    try {
      const body = await deps.objects.get(key);
      return {
        status: 200,
        body,
        headers: {
          "content-type": "application/octet-stream",
          // The URL is a capability with an expiry; a cache that outlived it would be a copy
          // of the object with none. And an intermediary caching one tenant's response under a
          // URL another tenant could replay is the failure this header exists to prevent.
          "cache-control": "private, no-store",
        },
      };
    } catch (err) {
      // Absent is a 404 here, not a 403. The signature already proved the caller was entitled
      // to ask, so hiding existence from them buys nothing and costs an intelligible error.
      if (err instanceof ObjectNotFound) throw notFound("no such object");
      throw err;
    }
  };

  const put: Handler = async (req): Promise<HttpResponse> => {
    const key = await authorise(req, deps, "put");
    await deps.objects.put(key, await req.buffer());
    return { status: 204 };
  };

  return [
    { method: "GET", prefix: OBJECT_ROUTE_PREFIX, handler: get },
    { method: "PUT", prefix: OBJECT_ROUTE_PREFIX, handler: put },
  ];
}

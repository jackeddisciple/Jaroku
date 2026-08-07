// `/v1/auth/*` — the routes a client talks to before it has a socket.
//
// Three of them, and only the first exists in every configuration:
//
//   POST /v1/auth/session    verify a bearer token, provision on first sight, answer with the
//                            user and the workspaces they may act in.
//   GET  /v1/auth/jwks.json  the LOCAL issuer's public key. Absent in provider mode.
//   POST /v1/auth/dev-login  mint a local token. Absent in provider mode.
//
// WHAT `POST /v1/auth/session` IS. It is not a login — the credential already exists by the
// time it arrives, minted by the issuer. It is the point where an external `sub` becomes an
// internal `users.id`, and where a first-time user gets the personal workspace everything else
// hangs off. Session 1 built the transaction; this is the request that calls it.
//
// WHAT IT DELIBERATELY DOES NOT RETURN. Not a session cookie, not a refresh token, not a
// workspace the caller asked for. The client already holds the only credential in this system;
// minting a second one beside it would be two things to revoke instead of one. And the
// workspace list is what the caller MAY act in, computed from membership rows — never echoed
// back from anything the client sent.

import { forbidden, unauthorized, type Handler, type HttpRequest } from "../http/router.ts";
import { newRequestId, systemContext } from "../db/tenant.ts";
import { IdentityConflictError, type IdentityRepository } from "../db/repositories/identity.ts";
import { AuthError, TokenVerifier, type AuthContext } from "./verifier.ts";
import type { LocalIssuer } from "./localIssuer.ts";
import type { AuthConfig } from "./config.ts";

export interface SessionDeps {
  config: AuthConfig;
  verifier: TokenVerifier;
  identity: IdentityRepository;
  /** Present only in local mode. Its absence is what makes the dev routes not exist. */
  localIssuer?: LocalIssuer;
  log?: (m: string) => void;
}

/**
 * Verify the `Authorization` header, or refuse.
 *
 * The one function every authenticated route starts with. It is a plain call rather than
 * framework middleware because there are five routes: a registry of before-handlers would be
 * indirection over something a reader can otherwise see at the top of each one, and "which
 * routes are authenticated" should be answerable by looking.
 */
export async function authenticate(req: HttpRequest, verifier: TokenVerifier): Promise<AuthContext> {
  const token = TokenVerifier.bearer(req.header("authorization"));
  if (!token) throw unauthorized("this endpoint needs an Authorization: Bearer <token> header");
  try {
    return await verifier.verify(token);
  } catch (err) {
    if (err instanceof AuthError && err.kind === "unavailable") {
      // 503, not 401. The token may be perfectly good; what failed is our ability to check
      // it. A 401 here would sign every user out because a third party had a bad minute, and
      // the client's socket layer treats the two completely differently.
      throw Object.assign(new Error(err.message), { status: 503, code: "auth_unavailable" });
    }
    throw unauthorized((err as Error).message);
  }
}

/** What a client learns about itself. Ids and roles; no tokens, no keys, no other tenants. */
export interface SessionView {
  user: { id: string; email: string; displayName: string | null };
  workspaces: { id: string; slug: string; name: string; kind: string; role: string }[];
  /** Where a client with no stored preference should start. Always one it belongs to. */
  defaultWorkspaceId: string;
  /** Unix seconds. The client refreshes before this; the server revalidates against it. */
  expiresAt: number;
}

export function sessionRoutes(deps: SessionDeps): { path: string; method: "GET" | "POST"; handler: Handler }[] {
  const routes: { path: string; method: "GET" | "POST"; handler: Handler }[] = [
    { path: "/v1/auth/session", method: "POST", handler: sessionHandler(deps) },
  ];
  if (deps.localIssuer) {
    routes.push({ path: "/v1/auth/jwks.json", method: "GET", handler: jwksHandler(deps.localIssuer) });
    routes.push({ path: "/v1/auth/dev-login", method: "POST", handler: devLoginHandler(deps) });
  }
  return routes;
}

function sessionHandler(deps: SessionDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    if (!auth.email) {
      // `users.email` is NOT NULL and UNIQUE, so there is nowhere to put "no address". The
      // alternative — synthesising `<sub>@users.invalid` — produces an account nobody can be
      // contacted at or recover, in a column whose uniqueness then means nothing. Every
      // provider in the D3 list supplies a verified address; a configuration that does not is
      // a configuration problem, and this says so.
      throw forbidden(
        "your identity provider did not supply a verified email address, which this server needs to create an account",
      );
    }

    const sys = systemContext(req.requestId);
    let provisioned;
    try {
      provisioned = await deps.identity.provisionUser(sys, {
        externalId: auth.subject,
        email: auth.email,
        displayName: auth.displayName,
      });
    } catch (err) {
      if (err instanceof IdentityConflictError) throw forbidden(err.message);
      throw err;
    }
    if (provisioned.created) {
      log(`[auth] provisioned ${auth.email} and their personal workspace "${provisioned.workspace.slug}"`);
      await adoptOrphans(deps, provisioned.user.id, req.requestId, log);
    }

    const memberships = await deps.identity.workspacesForUser(sys, provisioned.user.id);
    // Belt and braces: a user who somehow belongs to nothing has no workspace to act in, and
    // every command below would then resolve to no context at all. The provisioning
    // transaction makes this impossible; the check is here because "impossible" is what the
    // half-provisioned repair path also used to be.
    if (memberships.length === 0) throw forbidden("this account belongs to no workspace");

    const preferred =
      memberships.find((w) => w.id === provisioned.workspace.id) ?? memberships[0]!;
    const view: SessionView = {
      user: {
        id: provisioned.user.id,
        email: provisioned.user.email,
        displayName: provisioned.user.display_name,
      },
      workspaces: memberships.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        kind: w.kind,
        role: w.role,
      })),
      defaultWorkspaceId: preferred.id,
      expiresAt: auth.expiresAt,
    };
    return { body: view };
  };
}

/**
 * The first sign-in on a LOCAL install claims the workspaces nobody owns.
 *
 * Session 1 leaves exactly two kinds of member-less workspace behind: the one migration 004
 * created and backfilled every pre-tenancy row into, and any the importer made. Both were
 * created before authentication existed, so there was nobody to own them — and Session 1's
 * `createWorkspaceUnowned` says in as many words that this is where they get adopted. Without
 * it, signing in on your own machine shows you an empty app while all your agents and runs sit
 * in a workspace you are not a member of.
 *
 * IT IS LOCAL-MODE ONLY, and that is not a detail. Hosted, "the first person to sign up owns
 * every unowned workspace" turns a sign-up form into a way to acquire somebody else's imported
 * data. In provider mode this function does nothing at all.
 */
async function adoptOrphans(
  deps: SessionDeps,
  userId: string,
  requestId: string,
  log: (m: string) => void,
): Promise<void> {
  if (deps.config.mode !== "local") return;
  const sys = systemContext(requestId);
  const orphans = await deps.identity.unownedWorkspaces(sys);
  for (const ws of orphans) {
    if (await deps.identity.adoptWorkspace(sys, ws.id, userId)) {
      log(`[auth] adopted the unowned workspace "${ws.slug}" (${ws.id}) — local development only`);
    }
  }
}

function jwksHandler(issuer: LocalIssuer): Handler {
  return () => ({
    // Short but non-zero: this is fetched by the verifier's own JwksClient over loopback, and
    // the client's TTL is the one that matters. A cache header stops anything in between
    // holding a rotated-away key for an hour.
    headers: { "cache-control": "public, max-age=60" },
    body: issuer.jwks(),
  });
}

/**
 * Mint a local token for an email address. There is no password.
 *
 * That is the honest shape of the local issuer, and it is why config.ts refuses to enable it
 * under NODE_ENV=production and says so at every boot. The trust boundary is the same one
 * `runtime/.env` has always had locally: whoever can reach this port is the person sitting at
 * this machine.
 */
function devLoginHandler(deps: SessionDeps): Handler {
  const issuer = deps.localIssuer!;
  const log = deps.log ?? console.log;
  return async (req) => {
    const body = await req.json<{ email?: unknown; name?: unknown }>();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    // Deliberately loose: this is not an address anybody will send mail to, and a strict
    // pattern here would only stop somebody typing `ada` into a dev sign-in box. It does have
    // to be shaped like an address, because it lands in a UNIQUE column and in a slug.
    if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email) || email.length > 254) {
      throw unauthorized("give an email address to sign in as");
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : null;
    const { token, expiresAt } = issuer.mint({ email, displayName: name });
    log(`[auth] local issuer minted a token for ${email}`);
    return { body: { token, expiresAt, issuer: deps.config.issuer } };
  };
}

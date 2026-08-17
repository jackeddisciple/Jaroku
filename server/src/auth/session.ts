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

import { badRequest, forbidden, tooMany, unauthorized, type Handler, type HttpRequest } from "../http/router.ts";
import { newRequestId, systemContext } from "../db/tenant.ts";
import { IdentityConflictError, defaultWorkspace, type IdentityRepository } from "../db/repositories/identity.ts";
import { AuthError, TokenVerifier, type AuthContext } from "./verifier.ts";
import type { LocalIssuer } from "./localIssuer.ts";
import type { AuthConfig } from "./config.ts";
import type { TicketStore } from "./tickets.ts";
import type { ContextResolver } from "./resolve.ts";

export interface SessionDeps {
  config: AuthConfig;
  verifier: TokenVerifier;
  identity: IdentityRepository;
  /** Present only in local mode. Its absence is what makes the dev routes not exist. */
  localIssuer?: LocalIssuer;
  /** Present once there are sockets to authorise — see `/v1/ws-ticket` below. */
  tickets?: TicketStore;
  resolver?: ContextResolver;
  /**
   * Bound how often one PERSON may create a workspace. Returns the seconds to wait, or null.
   *
   * Supplied rather than reached for, like every other limiter call in this codebase, and it
   * fails open inside the supplier: a limiter that cannot answer must not be the reason nobody
   * can make a workspace. The boundary here is authentication, not the bucket.
   */
  limitWorkspaceCreate?: (userId: string) => Promise<number | null>;
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
  user: {
    id: string;
    email: string;
    displayName: string | null;
    /**
     * Whether this PERSON has been shown the product before.
     *
     * Here rather than in the browser, because "is this user new" and "is this browser new"
     * are different questions and only the first one is the one being asked. The client used
     * to answer it from `localStorage`, which meant a new account on a used browser skipped
     * onboarding and a returning user on a second device was walked through it again. See
     * migration 013.
     */
    onboarded: boolean;
  };
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
  if (deps.tickets && deps.resolver) {
    routes.push({ path: "/v1/ws-ticket", method: "POST", handler: ticketHandler(deps) });
  }
  routes.push({ path: "/v1/auth/onboarded", method: "POST", handler: onboardedHandler(deps) });
  routes.push({ path: "/v1/invites/accept", method: "POST", handler: acceptInviteHandler(deps) });
  routes.push({ path: "/v1/workspaces", method: "POST", handler: createWorkspaceHandler(deps) });
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

    // The shared rule, not "the one provisioning happened to return". Those differ the moment
    // a user owns more than one workspace, and the socket resolves through the shared rule —
    // so reporting anything else here tells the client a default its own socket will not use.
    const preferred = defaultWorkspace(memberships) ?? memberships[0]!;
    const view: SessionView = {
      user: {
        id: provisioned.user.id,
        email: provisioned.user.email,
        displayName: provisioned.user.display_name,
        // A boolean, not the timestamp. The client's only question is whether to show the
        // flow; WHEN somebody onboarded is for whoever reads the funnel, and a date on the
        // wire is a date somebody eventually renders.
        onboarded: provisioned.user.onboarded_at !== null,
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

/**
 * Exchange a bearer token for a single-use ticket to open one socket with.
 *
 * The whole of the WebSocket credential problem is here. A browser cannot put a header on a
 * WebSocket, so something has to go in the URL; a long-lived JWT there lands in access logs
 * forever, and a cookie makes the upgrade a cross-site-request target. What goes in the URL
 * instead is worth nothing thirty seconds later and worth nothing twice.
 *
 * The workspace is resolved through the SAME membership lookup every other request uses, so
 * a ticket for a workspace can only be minted by somebody who is a member of it. The socket
 * then inherits that scope and can never be talked into another one — a switch is a new
 * socket, which is a new ticket, which is a new membership check.
 */
/**
 * "I have finished onboarding." A fact about the caller, and only ever about the caller.
 *
 * NO USER ID IN THE BODY, and that is the whole of the authorisation story: the only person
 * this can mark is whoever presented the token, so there is no id to forge because there is no
 * id to send. A route that accepted one would need a rule about who may mark whom, and the only
 * correct rule is "nobody" — so the parameter should not exist.
 *
 * Not a socket command, for the reason accepting an invitation is not one: this is a fact about
 * a PERSON rather than about anything in a workspace, so scoping it to one would describe it
 * wrongly. The capability matrix would also have to grow an entry meaning "yourself", which is
 * not a capability.
 *
 * Idempotent in the repository, because the client can fire this more than once — a second tab,
 * a re-render, a reload — and only the first time means anything.
 */
function onboardedHandler(deps: SessionDeps): Handler {
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    const sys = systemContext(req.requestId);
    const user = await deps.identity.userByExternalId(sys, auth.subject);
    // A verified token for somebody with no row: a session against an account deleted
    // mid-flight, not a malformed request, and there is nothing to mark.
    if (!user) throw forbidden("this account no longer exists");
    const at = await deps.identity.markOnboarded(sys, user.id);
    return { body: { onboarded: at !== null } };
  };
}

function ticketHandler(deps: SessionDeps): Handler {
  const tickets = deps.tickets!;
  const resolver = deps.resolver!;
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    const body = await req.json<{ workspaceId?: unknown }>();
    const requested = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : null;
    // Throws 403 and writes an audit row if they are not a member. Nothing below this line
    // sees a workspace id the client chose.
    const session = await resolver.resolve(auth, requested, req.requestId, req.ip);
    // The token's expiry travels with the ticket, so the socket it opens knows when its
    // credential runs out. Nothing downstream of the upgrade ever sees a token again.
    const issued = await tickets.issue(session.context, { tokenExpiresAt: auth.expiresAt });
    return {
      body: {
        ticket: issued.ticket,
        expiresAt: issued.expiresAt,
        workspaceId: session.context.workspaceId,
        role: session.role,
      },
    };
  };
}

/**
 * Redeem an invitation, becoming a member.
 *
 * THE ONE MEMBERSHIP OPERATION THAT CANNOT GO OVER A SOCKET, and the reason is structural: a
 * socket is scoped to a workspace by a ticket, a ticket is minted after a membership check, and
 * the person accepting an invitation is by definition not a member yet. There is no connection
 * they could send this down.
 *
 * So it is HTTP, authenticated by the same bearer token as everything else, and the invitation
 * token is the second credential — one proves who you are, the other that you were asked. The
 * account is provisioned first if this is also their first sight, so a link in an email works
 * for somebody who has never used the product.
 */
function acceptInviteHandler(deps: SessionDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    if (!auth.email) throw forbidden("your identity provider did not supply a verified email address");
    const body = await req.json<{ token?: unknown }>();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) throw badRequest("give the invitation token");

    const sys = systemContext(req.requestId);
    // Provision first. An invitation is often somebody's first contact with the product, and
    // requiring them to have signed in once already would make the link fail for exactly the
    // people it was sent to.
    const provisioned = await deps.identity.provisionUser(sys, {
      externalId: auth.subject,
      email: auth.email,
      displayName: auth.displayName,
    });

    const result = await deps.identity.acceptInvite(sys, token, {
      id: provisioned.user.id,
      email: provisioned.user.email,
    });
    if (!result.ok) throw forbidden(result.reason);

    log(`[members] ${provisioned.user.email} accepted an invite to ${result.workspace.slug} as ${result.role}`);
    const memberships = await deps.identity.workspacesForUser(sys, provisioned.user.id);
    return {
      body: {
        workspace: { id: result.workspace.id, slug: result.workspace.slug, name: result.workspace.name },
        role: result.role,
        // The full list, so a client can render its switcher without a second round trip —
        // and so the workspace it just joined is visibly in it.
        workspaces: memberships.map((w) => ({
          id: w.id,
          slug: w.slug,
          name: w.name,
          kind: w.kind,
          role: w.role,
        })),
      },
    };
  };
}

/**
 * The longest a workspace may be called.
 *
 * A bound rather than a preference: the name is rendered in the switcher, in the sidebar and in
 * every audit row's metadata, and it feeds the slug. Sixty-four is more than any real team name
 * and short enough that nothing downstream has to decide where to cut.
 */
export const WORKSPACE_NAME_MAX = 64;

/**
 * Create a workspace, owned by whoever asked.
 *
 * HTTP AND NOT A SOCKET COMMAND, for the same structural reason accepting an invitation is not
 * one: a socket is scoped to a workspace by a ticket, and this is the request that brings a
 * workspace into existence. There is no scope for it to arrive in. It also means the capability
 * matrix stays honest — `workspace:manage` is a role IN a workspace, and no role in workspace A
 * should have anything to say about whether B may exist.
 *
 * WHICH IS ALSO WHY THIS WAS THE MISSING HALF OF TEAM WORKSPACES. `createWorkspace` had no
 * production caller: `provisionUser` made one personal workspace on first sight and nothing else
 * ever made another, so the only reachable way to obtain a TEAM workspace — the kind the roles
 * matrix, the invite flow and the Threads author column all exist for — was an environment
 * variable documented as naming which workspace the server acts in on its own behalf.
 *
 * `kind` IS EXPLICIT AND HAS NO DEFAULT. The repository defaults it to `team`, which is right for
 * the importer and wrong here: the difference decides whether the product renders collaboration
 * at all, and a request that did not say is a request whose author had not decided.
 *
 * Rate-limited PER PERSON rather than per workspace, because a workspace is what is being
 * created — there is no workspace to key a bucket by yet, and the thing being bounded is one
 * account minting tenancies.
 */
function createWorkspaceHandler(deps: SessionDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    if (!auth.email) {
      throw forbidden(
        "your identity provider did not supply a verified email address, which this server needs to create an account",
      );
    }
    const body = await req.json<{ name?: unknown; kind?: unknown }>();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw badRequest("a workspace needs a name");
    if (name.length > WORKSPACE_NAME_MAX) {
      throw badRequest(`a workspace name is at most ${WORKSPACE_NAME_MAX} characters`);
    }
    const kind = body.kind === "personal" || body.kind === "team" ? body.kind : null;
    if (!kind) {
      throw badRequest(`"${String(body.kind ?? "").slice(0, 24)}" is not a workspace kind — expected personal or team`);
    }

    const sys = systemContext(req.requestId);
    // Provisioned first, exactly as the invite path does it, so a brand-new account creating its
    // second workspace in its first session is one round trip rather than an ordering rule.
    const provisioned = await deps.identity.provisionUser(sys, {
      externalId: auth.subject,
      email: auth.email,
      displayName: auth.displayName,
    });

    const retryAfter = await deps.limitWorkspaceCreate?.(provisioned.user.id);
    if (retryAfter !== null && retryAfter !== undefined) {
      throw tooMany("you are creating workspaces faster than this server allows", retryAfter);
    }

    const workspace = await deps.identity.createWorkspace(sys, {
      name,
      kind,
      ownerUserId: provisioned.user.id,
    });
    log(`[auth] ${provisioned.user.email} created the ${kind} workspace "${workspace.slug}"`);

    const memberships = await deps.identity.workspacesForUser(sys, provisioned.user.id);
    return {
      status: 201,
      body: {
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          kind: workspace.kind,
        },
        role: "owner",
        // The full list, for the reason the invite route answers with one: the switcher can
        // render the workspace that was just made without a second round trip.
        workspaces: memberships.map((w) => ({
          id: w.id,
          slug: w.slug,
          name: w.name,
          kind: w.kind,
          role: w.role,
        })),
      },
    };
  };
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

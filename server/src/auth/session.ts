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

import { HttpError, badRequest, forbidden, notFound, tooMany, unauthorized, type Handler, type HttpRequest } from "../http/router.ts";
import { newRequestId, systemContext } from "../db/tenant.ts";
import { IdentityConflictError, ONBOARDING_STEPS, defaultWorkspace, type IdentityRepository } from "../db/repositories/identity.ts";
import { planFor } from "../billing/plans.ts";
import { adminModeOn, isAdminUser, setAdminMode } from "./adminMode.ts";
import { AuthError, TokenVerifier, type AuthContext } from "./verifier.ts";
import type { LocalIssuer } from "./localIssuer.ts";
import type { AuthConfig } from "./config.ts";
import type { TicketStore } from "./tickets.ts";
import { hashSecret, type SignInStore } from "./signIn.ts";
import type { ContextResolver } from "./resolve.ts";

export interface SessionDeps {
  config: AuthConfig;
  verifier: TokenVerifier;
  identity: IdentityRepository;
  /** Present only in local mode. Its absence is what makes the dev routes not exist. */
  localIssuer?: LocalIssuer;
  /** Present once there are sockets to authorise — see `/v1/ws-ticket` below. */
  tickets?: TicketStore;
  /**
   * Where the sixty-second session tickets live. Absent in a deployment that has no sign-in flows
   * of its own, which is what makes the ticket branch of `POST /v1/auth/session` not exist there
   * rather than exist and refuse.
   */
  signIn?: SignInStore;
  /**
   * Whether each sign-in path is configured, read PER REQUEST rather than captured.
   *
   * Functions rather than booleans, for the reason every other override in this codebase is a
   * function: a deployment that adds a Google client should not need a restart before the button
   * appears. It also means the answer cannot be a snapshot taken before the environment settled.
   */
  methods?: { google: () => boolean; magicLink: () => boolean };
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
    /**
     * How far through account onboarding they got, 1-5. §5.3.
     *
     * MEANINGLESS WHILE `onboarded` IS TRUE, and the client must not read it then — `markOnboarded`
     * writes the last step in the same statement it sets the flag, so a finished account always
     * reads 5, and the number is only a resume point while the flag is false.
     */
    onboardingStep: number;
    /**
     * Whether this account MAY turn admin mode on — never whether it currently is.
     *
     * TWO FLAGS AND NOT ONE, which is the whole security model. This one is derived from the
     * environment at hydration and cannot be set by anything a client sends; the other,
     * `adminMode`, is a deliberate act. A request carrying `adminMode: true` grants nothing,
     * because the flag that would make it meaningful is not one a request can reach.
     *
     * FALSE FOR ALMOST EVERYBODY, and the client renders nothing at all when it is — the toggle is
     * absent from the DOM rather than hidden, so admin mode is invisible to a non-admin reading
     * view-source rather than merely inconvenient to reach.
     */
    isAdmin: boolean;
    /**
     * Whether it is on RIGHT NOW.
     *
     * Always false in a freshly-started process, because it lives only in this process's memory —
     * which is what makes "resets on every app launch" true on a desktop app whose session token
     * survives in the OS keychain for weeks. See auth/adminMode.ts.
     */
    adminMode: boolean;
  };
  workspaces: {
    id: string;
    slug: string;
    name: string;
    kind: string;
    role: string;
    /**
     * Which plan the workspace is on, with the label a person reads.
     *
     * BOTH FIELDS, AND THE LABEL COMES FROM HERE rather than being mapped in the browser. The
     * sidebar renders the plan on every screen and the Usage panel renders it again from
     * `BudgetGate.status`; a client that mapped ids to names itself would be a second copy of the
     * plan table, and the failure mode is a paid workspace reading "Free" in one place and "Pro" in
     * the other — which is worse than showing nothing. `planFor` is the same function the gate
     * resolves limits through, so the two cannot disagree.
     */
    plan: { id: string; label: string };
    /**
     * When this workspace came into existence, as an ISO string.
     *
     * §10.2's General section asks for it, and it is the one field on that section a client cannot
     * derive: the name and the kind are already here, and a creation date is a row in `workspaces`
     * nothing else in the product surfaces. It is a fact about the workspace rather than about the
     * membership — "created", not "joined" — which is why it reads from `w.created_at` and not
     * from the membership row beside it.
     *
     * ON EVERY MEMBERSHIP RATHER THAN ONLY THE CURRENT ONE, because the switcher's list and the
     * panel's list are the same array and a field present on one entry and absent on the others is
     * the shape that produces an undefined nobody expected.
     */
    createdAt: string;
  }[];
  /** Where a client with no stored preference should start. Always one it belongs to. */
  defaultWorkspaceId: string;
  /** Unix seconds. The client refreshes before this; the server revalidates against it. */
  expiresAt: number;
}

export function sessionRoutes(deps: SessionDeps): { path: string; method: "GET" | "POST" | "PATCH"; handler: Handler }[] {
  const routes: { path: string; method: "GET" | "POST" | "PATCH"; handler: Handler }[] = [
    { path: "/v1/auth/session", method: "POST", handler: sessionHandler(deps) },
  ];
  if (deps.tickets && deps.resolver) {
    routes.push({ path: "/v1/ws-ticket", method: "POST", handler: ticketHandler(deps) });
  }
  // WHAT THIS SERVER CAN ACTUALLY DO, asked before the sign-in screen renders a single control.
  //
  // REGISTERED UNCONDITIONALLY, unlike the dev routes below it, because its whole job is to say
  // what exists — a route that appeared and disappeared with a configuration change would answer
  // its own question by 404ing, and a client would then have to treat "no answer" as "no methods",
  // which is indistinguishable from a server that has not finished starting.
  //
  // §3.1 is why this exists at all. "Both buttons appear equally valid" is a promise a client can
  // only keep if it knows which buttons are real: a "Continue with Google" that produces a 404 is
  // worse than no Google at all, and the client cannot know without asking. `localIssuerAvailable`
  // already probes `/v1/auth/jwks.json` for the same reason, one question at a time; this answers
  // all of them in one round trip, which is the difference between a sign-in screen that appears
  // and one that appears twice.
  routes.push({ path: "/v1/auth/methods", method: "GET", handler: methodsHandler(deps) });
  // §3.4 and §7's table. The only route in this file that is a PATCH, and it is one because "change
  // this one field" is a distinct operation from "replace this resource": a settings screen that
  // changed only the marketing preference must not clear a display name by omitting it.
  routes.push({ path: "/v1/users/me", method: "PATCH", handler: profileHandler(deps) });
  routes.push({ path: "/v1/auth/onboarded", method: "POST", handler: onboardedHandler(deps) });
  // §7's last three rows. All three are facts about a PERSON rather than about anything in a
  // workspace — which is why none of them is a socket command and why none takes a workspace id.
  routes.push({ path: "/v1/users/me/onboarding/step", method: "POST", handler: onboardingStepHandler(deps) });
  routes.push({ path: "/v1/users/me/onboarding/complete", method: "POST", handler: onboardedHandler(deps) });
  routes.push({ path: "/v1/users/me/onboarding/restart", method: "POST", handler: onboardingRestartHandler(deps) });
  // THE FOUNDER'S OVERRIDE. Registered unconditionally rather than only when the environment lists
  // somebody, because a route that appeared and disappeared with a configuration change would tell
  // an unauthenticated prober whether this deployment HAS admins — and the handler refuses a
  // non-admin either way, which is the check that actually matters.
  routes.push({ path: "/v1/auth/admin-mode", method: "POST", handler: adminModeHandler(deps) });
  routes.push({ path: "/v1/invites/accept", method: "POST", handler: acceptInviteHandler(deps) });
  routes.push({ path: "/v1/workspaces", method: "POST", handler: createWorkspaceHandler(deps) });
  routes.push({ path: "/v1/workspaces/rename", method: "POST", handler: renameWorkspaceHandler(deps) });
  if (deps.localIssuer) {
    routes.push({ path: "/v1/auth/jwks.json", method: "GET", handler: jwksHandler(deps.localIssuer) });
    routes.push({ path: "/v1/auth/dev-login", method: "POST", handler: devLoginHandler(deps) });
  }
  return routes;
}

/**
 * §7's row for `POST /v1/auth/session`: "Exchange ticket for session (existing endpoint,
 * extended)."
 *
 * TWO WAYS IN, ONE WAY OUT. Presented with a bearer token this is what it has always been — verify,
 * provision on first sight, answer with the account and its workspaces. Presented with a `ticket`
 * it is the last step of §3.2 and §3.3: spend the sixty-second single-use value the web callback
 * minted, MINT A TOKEN for the account it names, and answer with that token alongside the same view.
 *
 * EXTENDING THIS ROUTE RATHER THAN ADDING ONE is the specification's own instruction and it is the
 * right shape for a reason worth stating: what a client wants at the end of a sign-in is a session,
 * and a second route would mean two places that assemble a `SessionView` from memberships — which
 * is exactly the duplication that lets one of them start reporting a different default workspace
 * than the socket will actually use.
 *
 * THE TICKET BRANCH EXISTS ONLY WHERE THIS SERVER CAN MINT A TOKEN, which is `deps.localIssuer`.
 * That is not a limitation of the desktop app — a packaged install runs the local issuer by
 * construction, because `lib.rs` points `JAROKU_DEV_AUTH_KEY` at `~/.jaroku/keys/devauth.json` and
 * no OIDC provider is configured — it is a limitation of a HOSTED deployment pointed at Clerk or
 * Auth0, where Jaroku verifies somebody else's tokens and cannot issue one. Growing a second
 * identity system beside a configured provider would be the wrong answer to that; the right one is
 * that a deployment with a provider signs people in through the provider, which is what it already
 * does.
 */
function sessionHandler(deps: SessionDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    // THE TICKET BRANCH IS TRIED FIRST AND ONLY WHEN THERE IS A TICKET. A request carrying both a
    // ticket and an Authorization header is somebody finishing a sign-in while an old session is
    // still in the vault — §4.5's "deep-link arrives while a different user is signed in" — and the
    // ticket is what they just did, so it wins.
    const ticketed = await exchangeTicket(deps, req, log);
    if (ticketed) return ticketed;

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
        // §5.3's resume point. On the session rather than fetched separately, because it is read
        // on exactly the same occasion `onboarded` is — the moment a client decides what to render
        // — and a second round trip for one integer would be a second chance to disagree.
        onboardingStep: provisioned.user.onboarding_step,
        // FROM THE ENVIRONMENT, IN EXACTLY ONE PLACE. Every downstream check reads the flag off the
        // session rather than re-deriving, so there is one answer per session rather than a
        // scattering of environment reads that could disagree mid-request.
        isAdmin: isAdminUser(provisioned.user.id),
        adminMode: adminModeOn(provisioned.user.id),
      },
      workspaces: memberships.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        kind: w.kind,
        role: w.role,
        plan: { id: planFor(w.plan).id, label: planFor(w.plan).label },
        createdAt: w.created_at,
      })),
      defaultWorkspaceId: preferred.id,
      expiresAt: auth.expiresAt,
    };
    return { body: view };
  };
}

/**
 * §5.3 — record how far through the tour somebody got.
 *
 * IDEMPOTENT AND MONOTONIC, and the second is the interesting half. `advanceOnboarding` refuses to
 * move the step backwards, so a stale request from a second tab, a double-click, or two calls that
 * arrive out of order cannot walk somebody back to a screen they have already finished. The client
 * fires this after each step advances and does not wait for it.
 *
 * §9.3'S DISTINCTION IS MADE BY WHO CALLS THIS, NOT BY A FLAG ON IT. A SKIP advances the step,
 * because the person decided; an INTERRUPTION — a closed app, a killed process — never reaches this
 * route at all, so the step stays where it was and resume shows the same screen. That is the whole
 * of the difference, and it is structural rather than recorded: a `skipped: true` parameter would
 * be a thing a client could get wrong.
 */
function onboardingStepHandler(deps: SessionDeps): Handler {
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    const sys = systemContext(req.requestId);
    const user = await deps.identity.userByExternalId(sys, auth.subject);
    if (!user) throw forbidden("this account no longer exists");

    const body = await req.json<{ step?: unknown }>();
    const step = typeof body.step === "number" ? Math.floor(body.step) : NaN;
    // BOUNDED AGAINST THE NUMBER OF SCREENS THAT EXIST. A client that could send 9 would put a row
    // into a state no screen renders, and the person it belonged to would meet a blank onboarding
    // on their next sign-in with no way out of it.
    if (!Number.isFinite(step) || step < 1 || step > ONBOARDING_STEPS) {
      throw badRequest(`a step is between 1 and ${ONBOARDING_STEPS}`);
    }

    const at = await deps.identity.advanceOnboarding(sys, user.id, step);
    return { body: { step: at } };
  };
}

/**
 * §5.4 — walk through the setup screens again.
 *
 * "Your workspace and settings won't change." The repository clears exactly two columns and this
 * route adds nothing to that: there is no cascade, no deletion, and nothing that touches a
 * workspace, a key or an agent. What resets is a flag.
 *
 * AUDITED, unlike the step advance beside it. A step moving is somebody pressing Continue forty
 * times a year; a restart puts an account back into a flow it had finished, which is the kind of
 * thing that turns up in a support conversation as "why am I seeing this again".
 */
function onboardingRestartHandler(deps: SessionDeps): Handler {
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    const sys = systemContext(req.requestId);
    const user = await deps.identity.userByExternalId(sys, auth.subject);
    if (!user) throw forbidden("this account no longer exists");

    await deps.identity.restartOnboarding(sys, user.id);
    await deps.identity.appendAudit(sys, {
      workspaceId: null,
      actorUserId: user.id,
      action: "user.onboarding_restarted",
      targetType: "user",
      targetId: user.id,
      metadata: {},
      ip: req.ip,
    });
    return { body: { onboarded: false, step: 1 } };
  };
}

/**
 * The longest a person may be called.
 *
 * §3.4: "Name is 1-100 chars, trimmed, non-empty. Emoji allowed (people put them in their display
 * names)." A hundred is more than any real name and short enough that the members list, the audit
 * metadata and the workspace's default name never have to decide where to cut.
 */
export const DISPLAY_NAME_MAX = 100;

/**
 * The only thing a display name may not contain.
 *
 * WRITTEN AS ESCAPES RATHER THAN AS A LITERAL RANGE, deliberately. The first version of this line
 * had the actual bytes in it, which made the whole file read as binary to `grep`, `git diff` and
 * every code-review tool — a regular expression whose contents are invisible in review is one
 * nobody can check.
 *
 * C0, C1 AND DEL, and nothing else. None of the three is a thing a person types on purpose; all of
 * them are somebody trying to break a log line, a CSV export or a terminal. Zero-width characters
 * are deliberately absent from this list — U+200D is load-bearing in emoji sequences and U+200C in
 * several scripts, and refusing them would be refusing real names.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * §3.4 — the name, and the one checkbox.
 *
 * WHAT IT ACCEPTS IS AS IMPORTANT AS WHAT IT REFUSES. The specification is explicit that emoji are
 * allowed, and the instinct to sanitise a display name is the instinct that rejects "أحمد",
 * "李伟" and "Ada 🏳️‍🌈" — three real names and one flag sequence that is six code points long. So
 * the only rules are: trimmed, non-empty, and inside a hundred characters. Nothing is stripped and
 * nothing is transliterated.
 *
 * WHAT IS REFUSED IS CONTROL CHARACTERS, and only those. A newline or a NUL in a display name
 * is not a name — it is somebody trying to break a log line, a CSV export or a terminal — and none
 * of the three is a thing a person types on purpose. Zero-width characters are deliberately NOT
 * refused: they are load-bearing in several scripts, and refusing them would be refusing names.
 *
 * ONLY EVER THE CALLER'S OWN PROFILE. There is no user id in the body and there is nowhere to put
 * one — the only person this can change is whoever presented the token, so there is no id to forge
 * because there is no id to send. A route that accepted one would need a rule about who may edit
 * whom, and the only correct rule is "nobody".
 */
function profileHandler(deps: SessionDeps): Handler {
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    const sys = systemContext(req.requestId);
    const user = await deps.identity.userByExternalId(sys, auth.subject);
    // A verified token for somebody with no row: a session against an account deleted mid-flight.
    if (!user) throw forbidden("this account no longer exists");

    const body = await req.json<{ name?: unknown; marketingEmailsOptIn?: unknown }>();
    const patch: { displayName?: string; marketingEmailsOptIn?: boolean } = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string") throw badRequest("a name is a string");
      const name = body.name.trim();
      if (name.length === 0) throw badRequest("give a name to be called by");
      if (name.length > DISPLAY_NAME_MAX) {
        throw badRequest(`a name is at most ${DISPLAY_NAME_MAX} characters`);
      }
      // The control-character refusal, and nothing else. See the note above on why this is the only
      // filter and why zero-width characters are not in it.
      if (CONTROL_CHARACTERS.test(name)) throw badRequest("a name cannot contain control characters");
      patch.displayName = name;
    }

    if (body.marketingEmailsOptIn !== undefined) {
      // STRICTLY A BOOLEAN, never a truthy value. This decides whether somebody receives marketing
      // email, and reading `"false"` as true is the shape of consent bug that ends in a complaint
      // to a regulator rather than a bug report.
      if (typeof body.marketingEmailsOptIn !== "boolean") throw badRequest("marketingEmailsOptIn is true or false");
      patch.marketingEmailsOptIn = body.marketingEmailsOptIn;
    }

    if (Object.keys(patch).length === 0) throw badRequest("give something to change");

    const updated = await deps.identity.updateProfile(sys, user.id, patch);
    if (!updated) throw forbidden("this account no longer exists");
    await deps.identity.appendAudit(sys, {
      workspaceId: null,
      actorUserId: user.id,
      action: "user.profile_updated",
      targetType: "user",
      targetId: user.id,
      // WHICH FIELDS MOVED, NEVER THEIR VALUES. A display name is personal data and an audit row
      // outlives the thing it describes; "the name changed" is what an investigation needs, and
      // "the name changed to X" is a copy of somebody's name in a table nobody sweeps.
      metadata: { fields: Object.keys(patch) },
      ip: req.ip,
    });

    return {
      body: {
        user: {
          id: updated.id,
          email: updated.email,
          displayName: updated.display_name,
          onboarded: updated.onboarded_at !== null,
          onboardingStep: updated.onboarding_step,
          marketingEmailsOptIn: updated.marketing_emails_opt_in,
          isAdmin: isAdminUser(updated.id),
          adminMode: adminModeOn(updated.id),
        },
      },
    };
  };
}

/**
 * Which sign-in paths this deployment actually has.
 *
 * UNAUTHENTICATED, and it discloses nothing worth protecting: which providers a server offers is
 * visible to anybody who opens its sign-in screen, and hiding it would only mean the screen had to
 * guess. It says nothing about whether any particular ACCOUNT exists, which is the fact §3.3 goes
 * to lengths to keep unknowable.
 */
function methodsHandler(deps: SessionDeps): Handler {
  return async () => ({
    body: {
      // Present only when a client id, a secret and an HTTPS callback origin are all configured —
      // see `googleConfigFrom`. Half-configured answers false, because a half-configured Google is
      // a button that 500s.
      google: deps.methods?.google() ?? false,
      // Present when there is somewhere to send mail from AND an issuer that can mint the session
      // at the end of it. Both, because either alone is a flow that stops halfway.
      magicLink: (deps.methods?.magicLink() ?? false) && Boolean(deps.localIssuer),
      // The development sign-in. False in every packaged and hosted configuration that has a real
      // provider; true on a desktop install, where the local issuer IS the session issuer.
      localIssuer: Boolean(deps.localIssuer),
    },
  });
}

/**
 * The ticket half of `POST /v1/auth/session`, or `null` when this is not that kind of request.
 *
 * `null` RATHER THAN A THROW ON AN ABSENT TICKET, so the caller falls through to the bearer path
 * with no branch of its own. Every OTHER refusal here is a throw, because by then somebody has
 * presented a ticket and is owed an answer about it.
 *
 * §4.5'S FAILURE TABLE IS THIS FUNCTION. Expired, already used, and forged all produce the SAME
 * message — "that link expired, try signing in again" — and different audit rows. The message is
 * identical on purpose: a used-ticket message distinguishable from an invalid-ticket message is a
 * fingerprinting signal for whether an account exists, which is the same reasoning that makes
 * `POST /v1/auth/magic-link` always answer 200.
 */
async function exchangeTicket(
  deps: SessionDeps,
  req: HttpRequest,
  log: (m: string) => void,
): Promise<{ body: unknown } | null> {
  const store = deps.signIn;
  if (!store) return null;
  const body = await req.json<{ ticket?: unknown; nonce?: unknown }>();
  if (typeof body.ticket !== "string" || body.ticket === "") return null;

  const sys = systemContext(req.requestId);
  const audit = (action: string, metadata: Record<string, unknown>, userId: string | null = null): Promise<void> =>
    deps.identity
      .appendAudit(sys, { workspaceId: null, actorUserId: userId, action, targetType: "user", targetId: userId, metadata, ip: req.ip })
      // A sign-in must not fail because an audit row would not write. The row matters and the
      // person getting into their account matters more; the failure is logged where the write was.
      .catch((err: Error) => console.error(`[auth] could not write ${action}:`, err.message));

  if (!deps.localIssuer) {
    // Configured with an external provider, so there is nothing here that could mint a session.
    // A 501 rather than a 400: the request is well-formed and this deployment cannot serve it.
    throw new HttpError(501, "not_configured", "this server does not issue its own sessions");
  }

  const claimed = await store.consumeSessionTicket(body.ticket);
  if (!claimed) {
    // THE HIGHEST-SIGNAL ROW IN §7'S LIST, and it is deliberately not sampled. It covers three
    // different things — expired, already spent, never existed — and the metadata says which is
    // impossible to tell from here, which is itself the honest record.
    await audit("auth.invalid_ticket", { presented: hashSecret(body.ticket) });
    throw unauthorized("that sign-in link expired or was already used — try signing in again");
  }

  // §3.2's app-instance binding, spent. A ticket minted by the OAuth flow carries the digest of a
  // nonce that never left the app's memory; presenting the ticket without it means whoever is
  // asking is not the window that started this. A magic-link ticket carries no digest at all —
  // §10 wants a link clicked on a second device to work — and that branch requires nothing.
  if (claimed.nonceHash) {
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    if (!nonce || hashSecret(nonce) !== claimed.nonceHash) {
      await audit("auth.invalid_ticket", { reason: "nonce_mismatch" }, claimed.userId);
      throw unauthorized("that sign-in link expired or was already used — try signing in again");
    }
  }

  const user = await deps.identity.userById(sys, claimed.userId);
  if (!user) {
    // The ticket is real and the account is gone — deleted between the callback and the exchange,
    // which is a sixty-second window and therefore very nearly never. Same message: there is
    // nothing a person can do differently, and naming it would confirm an account had existed.
    await audit("auth.invalid_ticket", { reason: "user_missing" }, claimed.userId);
    throw unauthorized("that sign-in link expired or was already used — try signing in again");
  }

  // THE TOKEN, MINTED HERE AND HANDED OVER EXACTLY ONCE. `subject` is the user's own external id
  // rather than a fresh one derived from their email, so the token verifies to the row that
  // already exists — deriving it would provision a SECOND account for the same person on their
  // next request, which is §10's "never two accounts for one email" broken from the inside.
  const minted = deps.localIssuer.mint({
    subject: user.external_id,
    email: user.email,
    displayName: user.display_name,
  });
  await audit("auth.session_created", { provider: claimed.provider }, user.id);
  log(`[auth] ${user.email} signed in with ${claimed.provider} (${req.requestId})`);

  const memberships = await deps.identity.workspacesForUser(sys, user.id);
  if (memberships.length === 0) throw forbidden("this account belongs to no workspace");
  const preferred = defaultWorkspace(memberships) ?? memberships[0]!;

  return {
    body: {
      // THE ONLY PLACE THIS SERVER EVER PUTS A DURABLE TOKEN IN A RESPONSE, and the client's next
      // move is to write it to the operating system's credential store — §4.4 step 4, and
      // `sessionVault.ts` is the half that does it.
      token: minted.token,
      expiresAt: minted.expiresAt,
      provider: claimed.provider,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        onboarded: user.onboarded_at !== null,
        onboardingStep: user.onboarding_step,
        isAdmin: isAdminUser(user.id),
        adminMode: adminModeOn(user.id),
      },
      workspaces: memberships.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        kind: w.kind,
        role: w.role,
        plan: { id: planFor(w.plan).id, label: planFor(w.plan).label },
        createdAt: w.created_at,
      })),
      defaultWorkspaceId: preferred.id,
    },
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

/**
 * Turn admin mode on or off, for the person asking, for as long as this process lives.
 *
 * AN HTTP ROUTE AND NOT A SOCKET COMMAND, for the reason the checkout is one: it changes what the
 * SESSION is, and a socket's authority was decided by the ticket it was opened with. Answering on
 * the same channel as trace events would also mean the client had to hold "am I mid-toggle" across
 * a reconnect, for a control whose whole point is to be unambiguous.
 *
 * A NON-ADMIN GETS 403 AND IS LOGGED, which is a deliberate departure from how this codebase hides
 * things elsewhere. A 404 is right for a resource somebody may not know exists; this is somebody who
 * found an endpoint they were never shown, constructing a request for a privilege they do not have,
 * and the specification is explicit that it is worth a row rather than a disguise.
 *
 * THE AUDIT ROW CARRIES THE IP, because the case it exists for is "an admin account was used from
 * somewhere unexpected", and a row with an actor and no address cannot answer that.
 */
function adminModeHandler(deps: SessionDeps): Handler {
  return async (req) => {
    const auth = await authenticate(req, deps.verifier);
    const sys = systemContext(req.requestId);
    const user = await deps.identity.userByExternalId(sys, auth.subject);
    if (!user) throw forbidden("this account no longer exists");

    const body = await req.json<{ on?: unknown }>();
    const on = body.on === true;
    const admin = isAdminUser(user.id);

    if (!admin) {
      // LOGGED BEFORE THE REFUSAL, so a probe that gets a 403 still leaves the row. The action name
      // is distinct from the ordinary toggle's, because "somebody tried" and "somebody did" are
      // different questions and a shared name would make them one.
      await deps.identity.appendAudit(sys, {
        workspaceId: null,
        actorUserId: user.id,
        action: "admin.mode_denied",
        targetType: "user",
        targetId: user.id,
        metadata: { requested: on },
        ip: req.ip,
      });
      throw forbidden("admin mode is not available to this account");
    }

    const result = setAdminMode(user.id, admin, on);
    await deps.identity.appendAudit(sys, {
      workspaceId: null,
      actorUserId: user.id,
      action: "admin.mode_changed",
      targetType: "user",
      targetId: user.id,
      metadata: { on: result.on },
      ip: req.ip,
    });
    console.log(`[admin] mode ${result.on ? "ON" : "off"} for ${user.id}`);
    return { body: { isAdmin: true, adminMode: result.on } };
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
          plan: { id: planFor(w.plan).id, label: planFor(w.plan).label },
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

    // §3.3 — "A user cannot create a second personal workspace."
    //
    // THE RULE WAS ONLY EVER ON THE BUTTON. §3.3 goes on to say the option is absent rather than
    // disabled, the switcher does that, and this route accepted `kind: "personal"` from anybody
    // who asked — so the rule held for the menu and not for the request behind it, which is the
    // one place it has to hold. A `curl` made as many as it liked.
    //
    // AND THE REST OF THE PRODUCT COUNTS ON THERE BEING ONE. `provisionUser` creates it in the
    // same transaction as the account, §6.5 refuses to let an owner leave the one workspace they
    // cannot be removed from, and two of them stop several things meaning anything: `leftWorkspace`
    // lands somebody on `find(kind === "personal")` and would pick whichever came back first, §2.2
    // pins THE personal workspace to the top of the switcher, and §9.4 hangs "no members panel, no
    // author column, no role badges" on a workspace being the one that is nobody else's.
    //
    // ASKED OF THE MEMBERSHIPS RATHER THAN ASSUMED FROM `provisioned`, because "we just made you
    // one" and "you have one" are different claims — an account provisioned before this rule
    // existed, or one whose personal workspace was deleted by §11's account deletion, is a state
    // this has to answer correctly rather than a state that cannot happen.
    if (kind === "personal") {
      const held = await deps.identity.workspacesForUser(sys, provisioned.user.id);
      if (held.some((w) => w.kind === "personal")) {
        throw badRequest(
          "you already have a personal workspace — a team workspace is the kind you can have more than one of",
        );
      }
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
          plan: { id: planFor(w.plan).id, label: planFor(w.plan).label },
        })),
      },
    };
  };
}

/**
 * Rename a workspace somebody already belongs to.
 *
 * §5.1 STEP 2 IS WHY THIS EXISTS, AND IT IS A RENAME RATHER THAN THE `POST /v1/workspaces` THE
 * SPECIFICATION NAMES. That instruction is right for a system where signing in does not create a
 * workspace; this one does — `provisionUser` makes a personal workspace in the same transaction as
 * the user, because every panel in the product is a view of one workspace's data and an account
 * without one cannot render anything. Following §5.1 literally would leave every new account with
 * two workspaces, one of them empty and named after their email address.
 *
 * HTTP RATHER THAN A SOCKET COMMAND, for the reason `createWorkspaceHandler` beside it is: the one
 * caller runs BEFORE the app has opened a socket, on a screen that exists precisely because there
 * is not a usable workspace yet. It also means the capability matrix does not grow an entry that
 * would have to be true during onboarding and false after it.
 *
 * THE MEMBERSHIP CHECK IS THE RESOLVER'S, exactly as `/v1/ws-ticket`'s is — so nothing below this
 * line sees a workspace id the client chose. And the ROLE check is here rather than there, because
 * "may act in" and "may rename" are different questions: a member can use a workspace and should
 * not be able to rename it out from under everybody else in it.
 */
function renameWorkspaceHandler(deps: SessionDeps): Handler {
  const log = deps.log ?? console.log;
  return async (req) => {
    const resolver = deps.resolver;
    if (!resolver) throw notFound("this server cannot rename workspaces");
    const auth = await authenticate(req, deps.verifier);
    const body = await req.json<{ workspaceId?: unknown; name?: unknown }>();
    const requested = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : null;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw badRequest("a workspace needs a name");
    if (name.length > WORKSPACE_NAME_MAX) {
      throw badRequest(`a workspace name is at most ${WORKSPACE_NAME_MAX} characters`);
    }

    // Throws 403 and writes an audit row if they are not a member.
    const session = await resolver.resolve(auth, requested, req.requestId, req.ip);
    if (session.role !== "owner" && session.role !== "admin") {
      throw forbidden("only an owner or an admin may rename a workspace");
    }

    const renamed = await deps.identity.renameWorkspace(session.context, name);
    if (!renamed) throw notFound("that workspace no longer exists");
    await deps.identity.appendAudit(session.context, {
      action: "workspace.renamed",
      targetType: "workspace",
      targetId: renamed.id,
      // The name is in the row on purpose, unlike a person's display name: a workspace name is the
      // shared label a team argues about, and "who changed it to what" is the whole question
      // somebody asks when it changes.
      metadata: { name: renamed.name },
      ip: req.ip,
    });
    log(`[auth] ${renamed.slug} was renamed to "${renamed.name}"`);
    return { body: { workspace: { id: renamed.id, slug: renamed.slug, name: renamed.name, kind: renamed.kind } } };
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

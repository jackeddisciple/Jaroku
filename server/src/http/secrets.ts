// The secrets route group, and the guard that every route in it goes through.
//
// THE BRIEF'S CENTRAL WARNING, restated because this file is where it is either honoured or lost:
// gating the UI is not gating the data. A passcode that only hides a React component is theatre —
// anyone with a session can call the API directly. Every route here independently requires an
// elevated session, enforced in one place, and if that is wrong nothing else in the feature
// matters.
//
// HOW A ROUTE IS PROTECTED "WITHOUT THE AUTHOR ADDING ANYTHING". The brief asks for middleware on
// the group. This router deliberately has no middleware chain — it has ONE global `beforeHandle`,
// and its own comment forecloses on chains ("a chain is what you build when you have stopped being
// able to name them"). Fighting that would mean rewriting the request path for one feature. So the
// group is expressed the way every other group here is — a factory returning a route table — with
// two things that together give the same guarantee:
//
//   1. `guarded()` is the ONLY way to build a handler in this file, and its default is protected.
//      An author who writes a route and thinks about nothing gets capability + tenancy + elevation.
//      Opting OUT is explicit, spelled `elevation: "none"`, and visible in review.
//
//   2. `guardLevelOf()` lets a test assert that every exported route actually came through it. A
//      handler assembled by hand has no marker and fails the audit. That is ADR-028's structural
//      pattern, and it is what makes rule 1 a property rather than a convention — see
//      `secretsRoutes.test.ts`, which also proves the audit can fail.
//
// FOUR LEVELS, because the brief asks for two policies and a recovery path:
//
//   none     no elevation. Only for becoming elevated, and for the counts behind the tab badge.
//   read     elevation when the workspace's policy is `tab`; none when it is `mutations`.
//   mutate   elevation, always, under either policy.
//   step-up  a FRESH IdP login, not a passcode. Setting the first passcode and resetting a
//            forgotten one — the two operations a passcode cannot authorise, because a hijacked
//            session could otherwise set one and let itself in.
//
// ELEVATION IS NEVER A SUBSTITUTE FOR TENANCY. `contextFor` resolves the workspace through the
// same resolver every other route uses, and the capability check runs before the elevation check.
// A caller who is elevated in their own workspace is not thereby anything in somebody else's.

import { requireCapability, type Capability } from "../auth/capabilities.ts";
import type { SecretKind } from "../db/repositories/secretRefs.ts";
import type { TenantContext } from "../db/tenant.ts";
import { ELEVATION_HEADER, type SecretElevations } from "../secrets/elevation.ts";
import type { SecretPasscodes } from "../secrets/passcode.ts";
import { isSecretName } from "../secrets/secretStore.ts";
import { parseSecretBundle, validateBundle } from "../secrets/bundle.ts";
import type { SecretSummary } from "../secrets/manager.ts";
import type { UsageRow as UsageSite } from "../db/repositories/secretUsages.ts";
import { HttpError, badRequest, notFound, type Handler, type HttpRequest, type HttpResponse, type Router } from "./router.ts";

/** Which policy a workspace is on. Both implemented; `tab` is the default and what ships. */
export type SecretsGate = "tab" | "mutations";

export type GuardLevel = "none" | "read" | "mutate" | "step-up";

/** Who is asking, resolved once per request and handed to the handler. */
export interface SecretsCaller {
  ctx: TenantContext;
  userId: string;
  /** A digest of the bearer token — see `sessionIdFor`. Two tabs of one session share it. */
  sessionId: string;
  /** Whether the presented token is fresh enough to count as a step-up re-auth. */
  reauthenticatedRecently: boolean;
  ip: string | null;
  userAgent: string | null;
}

/** A handler that has been through `guarded`, and knows at what level. */
export type SecretsHandler = (req: HttpRequest, caller: SecretsCaller) => Promise<HttpResponse> | HttpResponse;

export interface SecretsRoute {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  prefix?: boolean;
  handler: Handler;
}

/**
 * The marker `guarded` leaves behind.
 *
 * A symbol rather than a property name, so nothing sets it by accident and nothing sets it by
 * copying a plain object. Read through `guardLevelOf`, which is exported; the symbol is not.
 */
const GUARD_LEVEL = Symbol("jaroku.secrets.guardLevel");

type MarkedHandler = Handler & { [GUARD_LEVEL]?: GuardLevel };

/** At what level a handler is guarded, or undefined when it never went through `guarded`. */
export function guardLevelOf(handler: Handler): GuardLevel | undefined {
  return (handler as MarkedHandler)[GUARD_LEVEL];
}

export interface GuardOptions {
  /**
   * Defaults to `mutate` — the strictest. An author who says nothing gets the safest thing, which
   * is the entire point of the default being here rather than at each call site.
   */
  elevation?: GuardLevel;
  /** Defaults to `secret:manage`, for the same reason. */
  capability?: Capability;
}

export interface SecretsRouteDeps {
  /**
   * Resolve who is asking, through the same resolver as every other authenticated route.
   *
   * Throws on a bad token or a workspace the caller is not in — so tenancy is enforced before
   * anything here reads a row, and independently of elevation.
   */
  callerFor: (req: HttpRequest) => Promise<SecretsCaller>;
  elevations: SecretElevations;
  passcodes: SecretPasscodes;
  /** The workspace's gate policy. Read per request: an admin changing it takes effect at once. */
  gateFor: (ctx: TenantContext) => Promise<SecretsGate>;
  /** Every refusal and every grant is written down. See §6.1 of the brief. */
  audit: (caller: SecretsCaller, action: string, detail?: Record<string, unknown>) => Promise<void>;
  /**
   * Bound how often somebody may try to unlock.
   *
   * MUST FAIL OPEN, and the caller here is written assuming it already does: `rateLimit.ts`'s own
   * post-mortem is that a limiter which cannot answer must not become the outage. Returns the
   * seconds to wait, or null to admit.
   */
  limitElevation?: (caller: SecretsCaller) => Promise<number | null>;
  /**
   * The counts behind the tab's warning dot. Served WITHOUT elevation, so it answers in numbers.
   *
   * Whether something needs attention is not sensitive; which credential needs it names what a
   * workspace integrates with. The return type has no room for a name, which is the enforcement.
   */
  health: (ctx: TenantContext) => Promise<Record<string, number>>;
  /**
   * Tell somebody their account was locked out.
   *
   * A SEAM RATHER THAN A MAILER, and that is a decision worth stating. The brief asks for an email
   * on lockout; this server has no mail transport, and inventing an untested SMTP client for one
   * notification would be a worse answer than a named hook. The durable record — which the brief
   * also asks for — is the `secrets.locked_out` audit row, which is written whether or not this is
   * wired to anything. Deployments that have a mailer pass one in.
   */
  notifyLockout?: (caller: SecretsCaller, until: string | null) => Promise<void>;
  /** Everything the workspace has, as metadata. Never a value; there is no method that returns one. */
  list: (ctx: TenantContext) => Promise<SecretSummary[]>;
  /**
   * Store a credential, having proved it works when that is possible.
   *
   * Returns what is safe to say about it. The VALUE is the caller's argument and never the
   * result — the once-only display the brief asks for is the client echoing back what the user
   * just typed, not the server handing it back.
   */
  store: (
    caller: SecretsCaller,
    input: { name: string; value: string; kind: SecretKind; provider?: string | null; agentId?: string | null; expiresAt?: string | null; rotateEveryDays?: number | null },
  ) => Promise<{ ok: boolean; message: string | null; summary?: SecretSummary }>;
  /** Forget one. The caller has already dealt with the blast-radius confirmation. */
  revoke: (caller: SecretsCaller, name: string) => Promise<void>;
  /** Re-run a provider probe against what is already stored. Answers ok/message, never a key. */
  test: (caller: SecretsCaller, name: string) => Promise<{ ok: boolean; message: string | null }>;
  /** Whether anything references this credential — drives the typed-name confirmation. */
  isReferenced: (ctx: TenantContext, name: string) => Promise<boolean>;
  /**
   * Read a stored credential back to its owner. ADR-035.
   *
   * OPTIONAL, and absent means the route 404s. That is not defensive coding — it is the one knob
   * that lets a deployment keep ADR-033's original posture, and it costs one `if`. A build that
   * never passes this has no reachable path from a request to a plaintext value, which is where
   * this codebase stood before, and somebody should be able to stand there on purpose.
   *
   * It takes the raw request because it needs the elevation token to mint the receipt the vault
   * demands — the route layer has already checked elevation, but a boolean is not a receipt and
   * deliberately cannot be turned into one.
   */
  reveal?: (req: HttpRequest, caller: SecretsCaller, name: string) => Promise<string | null>;
  /** Bound how often credentials may be read back. Fails open, like every limiter here. */
  limitReveal?: (caller: SecretsCaller) => Promise<number | null>;
  /**
   * Where one credential is used, from both sources, each labelled.
   *
   * Refreshes the static half before answering — a scan is a substring walk over one version's
   * files, cheap enough to do on demand, and a Usage view showing yesterday's scan is a Usage view
   * somebody makes a revoke decision from.
   */
  usage?: (caller: SecretsCaller, name: string) => Promise<UsageSite[]>;
}

/**
 * What a client learns about one credential.
 *
 * DECLARED IN ONE PLACE — `secrets/manager.ts` — so that "does any route return a value" is
 * answerable by reading one interface rather than by auditing every handler. There is no field on
 * it a credential fits in, and the serialiser audit asserts that against every route's real output
 * rather than against the type.
 */
export type { SecretSummary, UsageSite };

/**
 * Wrap a handler in the group's guarantees.
 *
 * The order is the security property and is the same on every route:
 *
 *   1. WHO — `callerFor` authenticates and resolves the workspace. A bad token stops here.
 *   2. WHAT — the capability check. A member cannot rotate a credential however elevated they are.
 *   3. HOW RECENTLY — elevation, or a fresh IdP login for the step-up routes.
 *
 * Capability before elevation, deliberately: being elevated is not a role, and a refusal should
 * say "you are not allowed to do this" rather than sending somebody to prove their identity for
 * an operation they still would not be permitted to perform.
 */
export function guarded(deps: SecretsRouteDeps, options: GuardOptions, handler: SecretsHandler): Handler {
  const level = options.elevation ?? "mutate";
  const capability = options.capability ?? "secret:manage";

  const wrapped: MarkedHandler = async (req: HttpRequest): Promise<HttpResponse> => {
    const caller = await deps.callerFor(req);
    requireCapability(caller.ctx, capability);

    if (level === "step-up") {
      if (!caller.reauthenticatedRecently) {
        // NOT A 401. A 401 tells the client its session is finished and sends it to sign-in,
        // losing whatever it was doing. This says: the session is fine, prove it is still you.
        await deps.audit(caller, "secrets.elevation_denied", { reason: "step_up_required" });
        throw new HttpError(
          403,
          "step_up_required",
          "setting or resetting a secrets passcode needs a fresh sign-in",
        );
      }
      return handler(req, caller);
    }

    if (level !== "none") {
      const gate = await deps.gateFor(caller.ctx);
      // The one policy check, and it is one line because it was designed in rather than bolted on.
      // Under `mutations` the metadata list is readable with ordinary auth; add, rotate, revoke
      // and reveal are not.
      const required = level === "mutate" || gate === "tab";
      if (required) {
        const token = req.header(ELEVATION_HEADER);
        const live = token
          ? await deps.elevations.check(caller.ctx, {
              userId: caller.userId,
              sessionId: caller.sessionId,
              token,
            })
          : null;
        if (!live) {
          await deps.audit(caller, "secrets.elevation_denied", { path: req.path, reason: "not_elevated" });
          throw new HttpError(403, "elevation_required", "this needs an unlocked Secrets session");
        }
      }
    }

    return handler(req, caller);
  };

  wrapped[GUARD_LEVEL] = level;
  return wrapped;
}

/**
 * The group.
 *
 * Every entry's handler is `guarded(...)`. `secretsRoutes.test.ts` asserts that mechanically, so a
 * route added later without it fails the build rather than shipping open.
 */
export function secretsRoutes(deps: SecretsRouteDeps): SecretsRoute[] {
  return [
    // --- the badge, which must work while the tab is locked -----------------------------------
    //
    // `none`, and it is the only READ in the group that is. The brief is explicit: the tab shows a
    // warning dot when something is expiring or broken, and that dot has to be computable without
    // elevation — otherwise every user is prompted for a passcode to be told whether they need to
    // care. Expiry status is not sensitive. WHICH credential is expiring names what a workspace
    // integrates with, so this answers in counts and the shape it returns has nowhere to put a
    // name.
    {
      method: "GET",
      path: "/v1/secrets/health",
      handler: guarded(deps, { elevation: "none", capability: "secret:read" }, async (_req, caller) => {
        const counts = await deps.health(caller.ctx);
        return { body: counts };
      }),
    },

    // --- setting the first passcode -----------------------------------------------------------
    //
    // STEP-UP, NOT ELEVATION, and the ordering is the point: a user who has never set a passcode
    // cannot be asked for one, so something else has to authorise this. If a session alone were
    // enough, a hijacked session could set a passcode and thereby GRANT ITSELF access to every
    // credential in the workspace — the gate would be a door the attacker installs and holds the
    // only key to.
    {
      method: "POST",
      path: "/v1/secrets/passcode",
      handler: guarded(deps, { elevation: "step-up", capability: "secret:read" }, async (req, caller) => {
        const body = await req.json<{ passcode?: unknown }>();
        if (typeof body.passcode !== "string") throw badRequest("a passcode is required");
        // Refused rather than silently replaced. Somebody who already has one and reaches here has
        // either lost it — which is what /reset is for — or is not who they say they are.
        if (await deps.passcodes.isSet(caller.ctx, caller.userId)) {
          throw new HttpError(409, "passcode_already_set", "this account already has a secrets passcode");
        }
        await setPasscodeOrRefuse(deps, caller, body.passcode);
        await deps.audit(caller, "secrets.passcode_set", {});
        return { headers: { "cache-control": "no-store" }, body: { passcodeSet: true } };
      }),
    },

    // --- changing one you know ------------------------------------------------------------------
    //
    // Elevation AND the current passcode. Elevation alone would mean an unlocked tab left open is
    // a tab that can change the passcode, which is how somebody loses access to their own
    // credentials to whoever walked past their desk.
    {
      method: "PATCH",
      path: "/v1/secrets/passcode",
      handler: guarded(deps, { elevation: "mutate", capability: "secret:read" }, async (req, caller) => {
        const body = await req.json<{ current?: unknown; passcode?: unknown }>();
        if (typeof body.current !== "string" || typeof body.passcode !== "string") {
          throw badRequest("the current passcode and a new one are both required");
        }
        const proven = await deps.passcodes.verify(caller.ctx, caller.userId, body.current);
        if (!proven.ok) {
          await deps.audit(caller, "secrets.elevation_denied", { reason: "passcode_change" });
          throw new HttpError(403, "elevation_denied", proven.message ?? "Incorrect passcode");
        }
        await setPasscodeOrRefuse(deps, caller, body.passcode);
        // EVERY ELEVATION THE USER HOLDS ENDS, on every device. The proof they were granted under
        // is the passcode that no longer exists, and a session elevated under the old one
        // outliving the change is the case somebody changes their passcode to prevent.
        await deps.elevations.lockEverywhere(caller.ctx, caller.userId, "passcode changed");
        await deps.audit(caller, "secrets.passcode_changed", {});
        return { headers: { "cache-control": "no-store" }, body: { passcodeSet: true, reElevate: true } };
      }),
    },

    // --- recovering one you have forgotten --------------------------------------------------------
    //
    // A FULL STEP-UP, and deliberately NOT an email magic link. The whole point of elevation is
    // proving the person is still there; a link in a mailbox proves someone had the mailbox, which
    // is exactly the thing an attacker who took the session may also have.
    {
      method: "POST",
      path: "/v1/secrets/passcode/reset",
      handler: guarded(deps, { elevation: "step-up", capability: "secret:read" }, async (req, caller) => {
        const body = await req.json<{ passcode?: unknown }>();
        if (typeof body.passcode !== "string") throw badRequest("a new passcode is required");
        // `put` clears the lockout as part of setting one — see the repository. Somebody who has
        // just re-proved their identity to the IdP must not still be held out by the ladder.
        await setPasscodeOrRefuse(deps, caller, body.passcode);
        await deps.elevations.lockEverywhere(caller.ctx, caller.userId, "passcode reset");
        await deps.audit(caller, "secrets.passcode_reset", {});
        return { headers: { "cache-control": "no-store" }, body: { passcodeSet: true, reElevate: true } };
      }),
    },

    // --- becoming elevated ------------------------------------------------------------------
    //
    // `none`, necessarily: this is the route somebody calls precisely because they are not
    // elevated yet. What protects it is the passcode itself, the ladder behind it, and two rate
    // limits — not an elevation it exists to produce.
    {
      method: "POST",
      path: "/v1/secrets/elevation",
      handler: guarded(deps, { elevation: "none", capability: "secret:read" }, async (req, caller) => {
        const retryAfter = deps.limitElevation ? await deps.limitElevation(caller) : null;
        if (retryAfter !== null) {
          await deps.audit(caller, "secrets.elevation_denied", { reason: "rate_limited" });
          throw new HttpError(429, "rate_limited", "too many unlock attempts — wait a moment", {
            "retry-after": String(retryAfter),
          });
        }

        const body = await req.json<{ method?: unknown; credential?: unknown }>();
        // A DISCRIMINATOR FROM DAY ONE, even though one value is implemented. The brief asks for
        // this specifically: retrofitting WebAuthn into a passcode-shaped endpoint is painful and
        // leaving room for it costs nothing.
        const method = body.method ?? "passcode";
        if (method !== "passcode") {
          throw badRequest(`unsupported elevation method: ${String(method)}`);
        }
        if (typeof body.credential !== "string") throw badRequest("a passcode is required");

        const outcome = await deps.passcodes.verify(caller.ctx, caller.userId, body.credential);
        if (!outcome.ok) {
          await deps.audit(caller, "secrets.elevation_denied", {
            method,
            lockedUntil: outcome.lockedUntil,
            // The COUNT is auditable; the guess never is. Nothing from `credential` reaches here.
            lockedOut: outcome.justLockedOut,
          });
          if (outcome.justLockedOut) {
            await deps.audit(caller, "secrets.locked_out", { method, until: outcome.lockedUntil });
            // Told once, on the step that crosses into the lockout — not on every subsequent
            // refusal, which would turn one attack into a mailbox full of identical warnings.
            // Never awaited into the refusal: a notification that fails must not turn a 403 into
            // a 500 and tell the attacker they found something.
            void deps.notifyLockout?.(caller, outcome.lockedUntil).catch((err) => {
              console.error("[secrets] could not report a lockout:", (err as Error)?.message ?? err);
            });
          }
          // 403 with the same body whether the passcode was wrong, whether none is set, and
          // whether they are held out — plus `lockedUntil` when there is a wait to render, which
          // is not an oracle: you only learn about a lockout you caused.
          throw new HttpError(403, "elevation_denied", outcome.message ?? "Incorrect passcode", {
            ...(outcome.lockedUntil ? { "retry-after": String(retryAfterSecondsUntil(outcome.lockedUntil)) } : {}),
          });
        }

        const granted = await deps.elevations.grant(caller.ctx, {
          userId: caller.userId,
          sessionId: caller.sessionId,
          method: "passcode",
          ip: caller.ip,
          userAgent: caller.userAgent,
        });
        await deps.audit(caller, "secrets.elevation_granted", { method: "passcode", expiresAt: granted.expiresAt });
        return {
          // NO-STORE, on the one response that carries an authorisation. A cached elevation grant
          // in a shared proxy is an elevation somebody else can replay.
          headers: { "cache-control": "no-store" },
          body: { token: granted.token, expiresAt: granted.expiresAt, method: granted.method },
        };
      }),
    },

    // --- how long is left, and joining from a second tab ------------------------------------
    {
      method: "GET",
      path: "/v1/secrets/elevation",
      handler: guarded(deps, { elevation: "none", capability: "secret:read" }, async (req, caller) => {
        const state = await deps.elevations.state(caller.ctx, caller.userId, caller.sessionId);
        // A SECOND TAB OF THE SAME SESSION GETS ITS OWN TOKEN, INHERITING THIS ONE'S EXPIRY. That
        // is what makes elevation a property of the session rather than of the tab that unlocked
        // — and inheriting rather than renewing is what stops "open a tab every nine minutes"
        // being an indefinite elevation with nobody present.
        //
        // Only when asked, so an ordinary countdown poll does not mint a token per second.
        const wantsToken = req.url.searchParams.get("join") === "1";
        const joined =
          wantsToken && state.elevated
            ? await deps.elevations.joinExisting(caller.ctx, {
                userId: caller.userId,
                sessionId: caller.sessionId,
                ip: caller.ip,
                userAgent: caller.userAgent,
              })
            : null;
        return {
          headers: { "cache-control": "no-store" },
          body: {
            elevated: state.elevated,
            expiresAt: state.expiresAt,
            remainingMs: state.remainingMs,
            // WHICH SCREEN TO RENDER: setup or unlock. This is not the oracle §3.5 forbids — that
            // rule is about a FAILED verify not distinguishing "wrong" from "none set", so an
            // attacker cannot enumerate. This tells an authenticated caller a fact about their own
            // account, which they are entitled to and which the first-run flow cannot work without.
            passcodeSet: await deps.passcodes.isSet(caller.ctx, caller.userId),
            // What the gate is set to, so the client knows whether a locked tab should still
            // render the list. Not sensitive: it is the shape of the policy, not its contents.
            gate: await deps.gateFor(caller.ctx),
            ...(joined ? { token: joined.token } : {}),
          },
        };
      }),
    },

    // --- the list ------------------------------------------------------------------------------
    //
    // `read`, so it is the route the workspace policy actually decides about: under `tab` it needs
    // elevation, under `mutations` it does not. Metadata only — see `SecretSummary`, which has no
    // field a credential would fit in.
    {
      method: "GET",
      path: "/v1/secrets",
      handler: guarded(deps, { elevation: "read", capability: "secret:read" }, async (_req, caller) => {
        const secrets = await deps.list(caller.ctx);
        await deps.audit(caller, "secrets.listed", { count: secrets.length });
        return { headers: { "cache-control": "no-store" }, body: { secrets } };
      }),
    },

    // --- adding one ------------------------------------------------------------------------------
    {
      method: "POST",
      path: "/v1/secrets",
      handler: guarded(deps, {}, async (req, caller) => {
        const body = await req.json<Record<string, unknown>>();
        const name = body["name"];
        const value = body["value"];
        if (!isSecretName(name)) {
          throw badRequest(
            "a credential name must be UPPER_SNAKE_CASE, start with a letter, and be at most 128 characters",
          );
        }
        if (typeof value !== "string" || !value) throw badRequest("a value is required");
        const kind = readKind(body["kind"]);
        const result = await deps.store(caller, {
          name,
          value,
          kind,
          provider: typeof body["provider"] === "string" ? body["provider"] : null,
          agentId: typeof body["agentId"] === "string" ? body["agentId"] : null,
          expiresAt: typeof body["expiresAt"] === "string" ? body["expiresAt"] : null,
          rotateEveryDays: typeof body["rotateEveryDays"] === "number" ? body["rotateEveryDays"] : null,
        });
        if (!result.ok) {
          // NOT STORED. A provider key that the provider itself rejected is a typo caught here
          // rather than a confusing failure three screens later, and storing it anyway would mean
          // the row says `invalid` while the vault holds something nobody can use.
          throw new HttpError(422, "credential_rejected", result.message ?? "that credential was not accepted");
        }
        await deps.audit(caller, "secrets.created", { name, kind });
        return { headers: { "cache-control": "no-store" }, body: { secret: result.summary ?? null } };
      }),
    },

    // --- importing a bundle from somewhere else ---------------------------------------------------
    {
      method: "POST",
      path: "/v1/secrets/import",
      handler: guarded(deps, {}, async (req, caller) => {
        const body = await req.json<{ text?: unknown }>();
        if (typeof body.text !== "string") throw badRequest("paste an export to import");
        const bundle = validateBundle(parseSecretBundle(body.text));
        const stored: string[] = [];
        const failed: { name: string; reason: string }[] = [...bundle.rejected];
        for (const entry of bundle.accepted) {
          // Each through the SAME store path a single credential takes, so nothing about a bulk
          // import is a way around the rules the single path enforces.
          const result = await deps.store(caller, { name: entry.name, value: entry.value, kind: "custom" });
          if (result.ok) stored.push(entry.name);
          else failed.push({ name: entry.name, reason: result.message ?? "it was not accepted" });
        }
        await deps.audit(caller, "secrets.imported", {
          format: bundle.format,
          imported: stored.length,
          rejected: failed.length,
        });
        // NAMES AND REASONS, never a value — the same shape `describe` produces, which is why that
        // function exists rather than the route reaching into the bundle itself.
        return {
          headers: { "cache-control": "no-store" },
          body: { format: bundle.format, imported: stored, rejected: failed },
        };
      }),
    },

    // --- one credential: rotate, test, revoke -------------------------------------------------------
    //
    // ADDRESSED BY NAME, not by a uuid. The brief writes `/secrets/:id`, and an id would be a
    // second way to name a row whose identity already IS `(workspace_id, name)` — the pointer the
    // whole store is built on. A second identifier is a second thing to keep in step.
    //
    // Reached by prefix, and the exact routes above are matched first, so `/v1/secrets/health` is
    // never read as a credential called `health`. A name that is not a legal credential name is
    // refused before anything looks it up.
    {
      method: "POST",
      path: "/v1/secrets/",
      prefix: true,
      handler: guarded(deps, {}, async (req, caller) => {
        const { name, action } = readTail(req.path);
        if (action === "rotate") {
          const body = await req.json<{ value?: unknown }>();
          if (typeof body.value !== "string" || !body.value) throw badRequest("a new value is required");
          const existing = (await deps.list(caller.ctx)).find((s) => s.name === name);
          if (!existing) throw notFound("no such credential in this workspace");
          if (existing.kind === "managed") {
            // A BUTTON THAT CANNOT WORK IS WORSE THAN NO BUTTON. Jaroku does not own a connector
            // token's lifecycle; the fix for a broken one is re-running consent, not writing a new
            // value over it.
            throw new HttpError(
              409,
              "managed_credential",
              "this credential is managed by a connector — reconnect it instead of rotating it",
            );
          }
          const result = await deps.store(caller, {
            name,
            value: body.value,
            kind: existing.kind,
            provider: existing.provider,
            agentId: existing.agentId,
          });
          if (!result.ok) {
            throw new HttpError(422, "credential_rejected", result.message ?? "that credential was not accepted");
          }
          await deps.audit(caller, "secrets.rotated", { name });
          return { headers: { "cache-control": "no-store" }, body: { secret: result.summary ?? null } };
        }
        if (action === "test") {
          const outcome = await deps.test(caller, name);
          await deps.audit(caller, "secrets.provider_validated", { name, ok: outcome.ok });
          return { headers: { "cache-control": "no-store" }, body: outcome };
        }
        if (action === "reveal") {
          // THE ONE ROUTE THAT RETURNS A CREDENTIAL. See ADR-035 for the decision and what it
          // cost; what follows is the set of things that make it the narrowest version of itself.
          if (!deps.reveal) throw notFound("this deployment does not expose stored credentials");
          // Its own rate limit, tighter than the unlock one and separate from it, so a script that
          // has obtained one elevation cannot walk the whole vault with it inside ten minutes.
          const retryAfter = await deps.limitReveal?.(caller);
          if (retryAfter != null) {
            await deps.audit(caller, "secrets.reveal_denied", { name, reason: "rate_limited" });
            throw new HttpError(429, "rate_limited", "too many reveals — wait a moment", {
              "retry-after": String(retryAfter),
            });
          }
          const value = await deps.reveal(req, caller, name);
          if (value === null) throw notFound("there is no value stored under that name");
          // AUDITED BEFORE IT IS ANSWERED, and never sampled. "Who read this credential, from where,
          // and when" is the question asked after it turns up somewhere it should not have, and an
          // audit row written after the response is one a crash loses.
          await deps.audit(caller, "secrets.revealed", { name });
          // A revealed credential must not sit in a proxy, a browser cache or a back button.
          const noCache: Record<string, string> = {
            "cache-control": "no-store, no-cache, must-revalidate, private",
            pragma: "no-cache",
          };
          return { headers: noCache, body: { name, value } };
        }
        throw notFound(`nothing to do at ${req.path}`);
      }),
    },

    // --- what breaks if I revoke this --------------------------------------------------------
    //
    // `read`, not `mutate`: it is a question, and under the `mutations` policy somebody looking at
    // the list should be able to see what depends on a credential without unlocking. The answer
    // labels each site with its source, because a static hit is a guess about code that may never
    // run and a runtime read is a fact about code that did.
    {
      method: "GET",
      path: "/v1/secrets/",
      prefix: true,
      handler: guarded(deps, { elevation: "read", capability: "secret:read" }, async (req, caller) => {
        const { name, action } = readTail(req.path);
        if (action !== "usage") throw notFound(`nothing at ${req.path}`);
        if (!deps.usage) throw notFound("this deployment does not record credential usage");
        const sites = await deps.usage(caller, name);
        return { headers: { "cache-control": "no-store" }, body: { name, usage: sites } };
      }),
    },

    {
      method: "DELETE",
      path: "/v1/secrets/",
      prefix: true,
      handler: guarded(deps, {}, async (req, caller) => {
        const { name, action } = readTail(req.path);
        if (action) throw notFound(`nothing to delete at ${req.path}`);
        const existing = (await deps.list(caller.ctx)).find((s) => s.name === name);
        if (!existing) throw notFound("no such credential in this workspace");
        if (existing.kind === "managed") {
          throw new HttpError(
            409,
            "managed_credential",
            "this credential is managed by a connector — disconnect the connector instead",
          );
        }
        // CONFIRMATION GATED BY BLAST RADIUS. A credential nothing points at goes with an ordinary
        // confirm; one with a live reference makes somebody type its name, the same discipline the
        // audited GitHub force-override uses. The quiet revoke that breaks a deployed agent at
        // three in the morning is the failure being designed against.
        if (await deps.isReferenced(caller.ctx, name)) {
          const body = await req.json<{ confirm?: unknown }>();
          if (body.confirm !== name) {
            throw new HttpError(
              409,
              "confirmation_required",
              `${name} is referenced by this workspace — type its name to confirm`,
            );
          }
        }
        await deps.revoke(caller, name);
        await deps.audit(caller, "secrets.revoked", { name });
        return { headers: { "cache-control": "no-store" }, body: { revoked: name } };
      }),
    },

    // --- lock now ----------------------------------------------------------------------------
    //
    // `none` rather than `mutate`, and that is deliberate. Requiring elevation to END elevation
    // would mean a session that is already expiring cannot be locked early, and would make the
    // "Lock now" button fail in exactly the state somebody presses it in. Locking is idempotent
    // and can only reduce access, so the worst an unauthorised caller achieves is locking
    // themselves — and they can only reach their own session, because the session id is derived
    // from the token they presented.
    {
      method: "DELETE",
      path: "/v1/secrets/elevation",
      handler: guarded(deps, { elevation: "none", capability: "secret:read" }, async (_req, caller) => {
        const ended = await deps.elevations.lock(caller.ctx, caller.userId, caller.sessionId);
        await deps.audit(caller, "secrets.elevation_revoked", { ended, reason: "locked by the user" });
        return { headers: { "cache-control": "no-store" }, body: { elevated: false, ended } };
      }),
    },
  ];
}

/**
 * Put the group on a router.
 *
 * ONE FUNCTION, USED BY THE SERVER AND BY EVERY TEST THAT DRIVES ONE, and that is the whole reason
 * it exists rather than each caller writing the four-line loop for itself. Three of these routes are
 * addressed by a NAME in the path — rotate, test, reveal, usage, revoke — so they are declared
 * `prefix: true` and must be mounted with `prefixRoute`. A caller that spells the loop out and
 * forgets that one branch registers them as exact paths instead, and then `/v1/secrets/NAME/rotate`
 * matches nothing: the handler is correct, the guard is correct, the audit is correct, and the
 * feature is a 404. That is the shape of bug a test suite with its own copy of the loop cannot see,
 * because its copy is the one that is right.
 *
 * So the loop lives here, next to the table it reads, and there is nowhere left for the two to
 * disagree.
 */
export function mountSecretsRoutes(router: Router, deps: SecretsRouteDeps): SecretsRoute[] {
  const routes = secretsRoutes(deps);
  for (const route of routes) {
    if (route.prefix) router.prefixRoute(route.method, route.path, route.handler);
    else if (route.method === "GET") router.get(route.path, route.handler);
    else if (route.method === "PATCH") router.patch(route.path, route.handler);
    else if (route.method === "DELETE") router.del(route.path, route.handler);
    else router.post(route.path, route.handler);
  }
  return routes;
}

/** The three origins, read from a request body without trusting it. */
function readKind(raw: unknown): SecretKind {
  if (raw === "provider_key" || raw === "custom") return raw;
  // `managed` is deliberately not reachable from here. A connector's credential is created by the
  // connector's own flow; letting a client declare one would produce a row claiming a lifecycle
  // Jaroku does not actually own, with a Reconnect button pointing at nothing.
  if (raw === undefined || raw === null) return "custom";
  throw badRequest(`unknown kind: ${String(raw).slice(0, 32)}`);
}

/**
 * Split `/v1/secrets/NAME` or `/v1/secrets/NAME/rotate` into its two halves.
 *
 * The name is validated HERE, before anything looks it up, so a path segment that could never be a
 * credential name is a 400 rather than a lookup miss — and so nothing downstream receives a string
 * that has not been through the same gate `set` uses.
 */
function readTail(path: string): { name: string; action: string | null } {
  const tail = path.slice("/v1/secrets/".length);
  const [rawName, action, ...rest] = tail.split("/");
  if (rest.length) throw notFound(`nothing at ${path}`);
  const name = decodeURIComponent(rawName ?? "");
  if (!isSecretName(name)) throw badRequest("that is not a credential name");
  return { name, action: action || null };
}

/** Whole seconds until an ISO instant, floored at one. A `Retry-After: 0` invites an instant retry. */
function retryAfterSecondsUntil(iso: string): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 1000));
}

/**
 * Store a passcode, turning a policy refusal into a 400 rather than a 500.
 *
 * `SecretPasscodes.set` throws a plain Error for a passcode that is too short or all spaces, which
 * is right for a library — but an uncaught one here becomes "the server failed to handle that",
 * with the actual reason visible only in a log the user cannot read. The message is safe to render:
 * it says nothing about the passcode beyond the rule it broke.
 */
async function setPasscodeOrRefuse(
  deps: SecretsRouteDeps,
  caller: SecretsCaller,
  passcode: string,
): Promise<void> {
  try {
    await deps.passcodes.set(caller.ctx, caller.userId, passcode);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest((err as Error)?.message ?? "that passcode cannot be used");
  }
}

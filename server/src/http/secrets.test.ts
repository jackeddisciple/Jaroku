// The guard on the secrets group: that it is on every route, and that it refuses what it should.
//
// TWO KINDS OF ASSERTION, and the first is the one the brief asks for by name.
//
// THE STRUCTURAL HALF — "a new route added to the secrets group is protected without the author
// adding anything". Every handler the group exports must carry the marker `guarded()` leaves
// behind. A handler assembled by hand has none and fails. Because a structural audit is worthless
// if it cannot fail, this suite ALSO builds a deliberately-unguarded route table and asserts the
// same check rejects it — so the audit is proved rather than trusted.
//
// THE BEHAVIOURAL HALF — that the guard actually refuses. In order: a bad capability before a
// missing elevation (so a member is told they are not allowed, rather than sent to prove their
// identity for something they still could not do), then elevation itself, then the workspace
// policy, then the session binding.
//
// Every request here is built by hand and passed straight to the handler. There is no browser and
// no client: the brief's first acceptance criterion is that the API refuses with the UI bypassed
// entirely, and this is that, one layer below curl.
//
//   npm run test:secret-routes

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type Role, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretElevationRepository } from "../db/repositories/secretElevations.ts";
import { SecretPasscodeRepository } from "../db/repositories/secretPasscodes.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { SecretUsageRepository } from "../db/repositories/secretUsages.ts";
import { KmsSecretStore } from "../secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "../secrets/masterKey.ts";
import { SecretsManager } from "../secrets/manager.ts";
import { SecretElevations, ELEVATION_HEADER, ELEVATION_TTL_MS, sessionIdFor } from "../secrets/elevation.ts";
import { SecretPasscodes } from "../secrets/passcode.ts";
import {
  guardLevelOf,
  guarded,
  secretsRoutes,
  type SecretsCaller,
  type SecretsGate,
  type SecretsRoute,
  type SecretsRouteDeps,
} from "./secrets.ts";
import type { Handler, HttpRequest } from "./router.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");
const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-secret-routes-"));
  scratch.push(d);
  return d;
};

/** Enough of an HttpRequest for a handler. Nothing here touches a socket. */
function mkReq(init: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: string;
}): HttpRequest {
  const path = init.path ?? "/v1/secrets/elevation";
  const headers = init.headers ?? {};
  return {
    requestId: newRequestId(),
    method: init.method ?? "POST",
    path,
    url: new URL(`http://localhost:4317${path}${init.query ? `?${init.query}` : ""}`),
    raw: {} as IncomingMessage,
    ip: "203.0.113.7",
    header: (name: string) => headers[name.toLowerCase()],
    json: async <T,>() => (init.body ?? {}) as T,
    buffer: async () => Buffer.alloc(0),
  };
}

/** The status a handler refused with, or 0 when it did not refuse. */
async function statusOf(handler: Handler, req: HttpRequest): Promise<{ status: number; code: string }> {
  try {
    await handler(req);
    return { status: 0, code: "" };
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { status: e.status ?? -1, code: e.code ?? "" };
  }
}

const dir = tmpDir();
const db: Db = new SqliteDb(join(dir, "secret-routes.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

try {
  const identity = new IdentityRepository(db);
  const sys = systemContext(newRequestId());
  const ws = await identity.createWorkspaceUnowned(sys, { name: `routes ${randomUUID().slice(0, 6)}` });
  const { user } = await identity.provisionUser(sys, {
    externalId: `routes_${randomUUID().slice(0, 8)}`,
    email: `${randomUUID().slice(0, 8)}@example.com`,
  });

  const elevationRepo = new SecretElevationRepository(db);
  const passcodeRepo = new SecretPasscodeRepository(db);
  const refs = new SecretRefRepository(db);
  const usages = new SecretUsageRepository(db);
  // The hosted store rather than the dotenv one: it holds real ciphertext and writes no files, so
  // the suite proves the no-value property against something that genuinely has a value to leak.
  const vault = new KmsSecretStore({
    db,
    master: new LocalMasterKeyProvider("a-master-key-with-enough-entropy-behind-it-0123456789"),
    refs,
    runWorkspace: async () => null,
    providerFor: (name) => (name.startsWith("ANTHROPIC") ? "anthropic" : null),
  });
  // Provider probes are stubbed by outcome, not by network: the point being asserted is that a
  // rejected key is not stored, and reaching Anthropic to find that out would make the suite
  // depend on somebody else's uptime.
  let providerSaysYes = true;
  const manager = new SecretsManager({
    secrets: vault,
    refs,
    usages,
    verify: async () =>
      providerSaysYes ? { ok: true, message: null } : { ok: false, message: "the provider rejected that key (401)" },
  });
  const elevations = new SecretElevations({ elevations: elevationRepo });
  const passcodes = new SecretPasscodes({ passcodes: passcodeRepo });

  const BEARER = "a-bearer-token-standing-in-for-a-real-one";
  const sessionId = sessionIdFor(BEARER);

  // What the deps hand back is steered by these, so one route table covers every case.
  let role: Role = "admin";
  let gate: SecretsGate = "tab";
  let freshLogin = false;
  const audited: { action: string; detail: Record<string, unknown> }[] = [];

  const ctxFor = (): TenantContext => ({ ...systemContextFor(ws.id, newRequestId()), role });
  const callerFor = async (): Promise<SecretsCaller> => ({
    ctx: ctxFor(),
    userId: user.id,
    sessionId,
    reauthenticatedRecently: freshLogin,
    ip: "203.0.113.7",
    userAgent: "test-agent/1.0",
  });

  const deps: SecretsRouteDeps = {
    callerFor,
    elevations,
    passcodes,
    gateFor: async () => gate,
    audit: async (_caller, action, detail) => {
      audited.push({ action, detail: detail ?? {} });
    },
    health: async () => ({ total: 2, expiringSoon: 1, invalid: 0, rotationDue: 0, unusedNinetyDays: 0 }),
    // THE REAL MANAGER OVER A REAL VAULT, not a stub. The point of the CRUD half of this suite is
    // that no route returns a value, and a stub that never held one would prove nothing.
    list: (ctx) => manager.list(ctx),
    store: (c, input) => manager.store(c.ctx, { ...input, actorUserId: c.userId }),
    revoke: (c, name) => manager.revoke(c.ctx, name),
    test: (c, name) => manager.test(c.ctx, name),
    isReferenced: (ctx, name) => manager.isReferenced(ctx, name),
    // ADR-035. The receipt is minted here exactly as index.ts mints it — from the token on the
    // request — so the suite exercises the real path from an HTTP header to an unforgeable value.
    reveal: async (req, c, name) => {
      const receipt = await elevations.receiptFor(c.ctx, {
        userId: c.userId,
        sessionId: c.sessionId,
        token: req.header(ELEVATION_HEADER) ?? "",
      });
      return receipt ? manager.reveal(receipt, name) : null;
    },
  };

  // --- the structural audit ---------------------------------------------------------------
  console.log("\nevery route in the group is guarded");
  const routes = secretsRoutes(deps);
  check(routes.length > 0, `the group exports routes (${routes.length})`);
  const unguarded = routes.filter((r) => guardLevelOf(r.handler) === undefined);
  check(
    unguarded.length === 0,
    "every exported route's handler went through guarded()",
    unguarded.map((r) => `${r.method} ${r.path}`).join(", "),
  );
  for (const r of routes) {
    check(
      ["none", "read", "mutate", "step-up"].includes(guardLevelOf(r.handler)!),
      `${r.method} ${r.path} declares a level (${guardLevelOf(r.handler)})`,
    );
  }

  // AND THE AUDIT CAN FAIL. A rule that cannot fail is a rule nobody is following.
  const smuggled: SecretsRoute[] = [
    { method: "GET", path: "/v1/secrets/oops", handler: async () => ({ body: { leaked: true } }) },
  ];
  check(
    smuggled.filter((r) => guardLevelOf(r.handler) === undefined).length === 1,
    "...and a hand-built handler is caught by the same check, so the audit can fail",
  );

  // --- the default is protected ------------------------------------------------------------
  console.log("\nthe default level is the strict one");
  const defaulted = guarded(deps, {}, async () => ({ body: { ok: true } }));
  check(guardLevelOf(defaulted) === "mutate", "a route that says nothing about elevation gets 'mutate'");
  check(
    (await statusOf(defaulted, mkReq({}))).code === "elevation_required",
    "and is refused without one",
  );

  // --- capability is checked before elevation ----------------------------------------------
  console.log("\ncapability first, then elevation");
  role = "member";
  const manageRoute = guarded(deps, { elevation: "mutate" }, async () => ({ body: { ok: true } }));
  const memberRefusal = await statusOf(manageRoute, mkReq({}));
  check(memberRefusal.status === 403, "a member is refused a manage route");
  check(
    memberRefusal.code === "forbidden",
    "with 'forbidden', not 'elevation_required' — they would still not be allowed once elevated",
    memberRefusal.code,
  );
  role = "admin";

  // --- elevation itself ---------------------------------------------------------------------
  console.log("\nelevation");
  const readRoute = guarded(deps, { elevation: "read", capability: "secret:read" }, async () => ({
    body: { names: [] },
  }));
  check((await statusOf(readRoute, mkReq({}))).code === "elevation_required", "a read route refuses under gate 'tab'");
  check(
    (await statusOf(manageRoute, mkReq({ headers: { [ELEVATION_HEADER]: "not-a-real-token" } }))).code ===
      "elevation_required",
    "a nonsense elevation token is refused",
  );

  // Grant one for real, through the actual route.
  await passcodes.set(ctxFor(), user.id, "hunter2!");
  const grant = routes.find((r) => r.method === "POST" && r.path === "/v1/secrets/elevation")!;
  const wrong = await statusOf(grant.handler, mkReq({ body: { method: "passcode", credential: "wrong-pc" } }));
  check(wrong.status === 403 && wrong.code === "elevation_denied", "a wrong passcode is refused by the grant route");
  check(
    audited.some((a) => a.action === "secrets.elevation_denied"),
    "and the refusal is audited — the highest-signal row in the list",
  );

  const granted = (await grant.handler(mkReq({ body: { method: "passcode", credential: "hunter2!" } }))) as {
    body: { token: string; expiresAt: string };
    headers?: Record<string, string>;
  };
  check(typeof granted.body.token === "string" && granted.body.token.length >= 40, "the right passcode grants a token");
  check(granted.headers?.["cache-control"] === "no-store", "on a response no proxy may cache");
  check(
    audited.some((a) => a.action === "secrets.elevation_granted"),
    "and the grant is audited too",
  );
  const token = granted.body.token;

  const elevatedReq = mkReq({ headers: { [ELEVATION_HEADER]: token } });
  check((await statusOf(manageRoute, elevatedReq)).status === 0, "a real token opens a mutate route");
  check((await statusOf(readRoute, elevatedReq)).status === 0, "and a read route");

  // --- the policy escape hatch ---------------------------------------------------------------
  console.log("\ngate: tab versus gate: mutations");
  gate = "mutations";
  check((await statusOf(readRoute, mkReq({}))).status === 0, "under 'mutations' the metadata list needs no elevation");
  check(
    (await statusOf(manageRoute, mkReq({}))).code === "elevation_required",
    "...but a mutation still does, which is the whole point of the setting",
  );
  gate = "tab";
  check(
    (await statusOf(readRoute, mkReq({}))).code === "elevation_required",
    "and under 'tab' — the default, and what ships — even reading needs it",
  );

  // --- the session binding --------------------------------------------------------------------
  console.log("\nan elevation belongs to a session");
  const otherSession = await elevations.grant(ctxFor(), {
    userId: user.id,
    sessionId: sessionIdFor("a-completely-different-bearer-token"),
    method: "passcode",
  });
  check(
    (await statusOf(manageRoute, mkReq({ headers: { [ELEVATION_HEADER]: otherSession.token } }))).code ===
      "elevation_required",
    "a token minted for another session does not work in this one",
  );

  // --- the TTL is absolute ---------------------------------------------------------------------
  console.log("\nthe TTL does not slide");
  {
    let clock = Date.parse("2026-08-14T12:00:00.000Z");
    const timed = new SecretElevations({ elevations: elevationRepo, now: () => clock });
    const first = await timed.grant(ctxFor(), { userId: user.id, sessionId: "slide-test", method: "passcode" });

    clock += 9 * 60 * 1000;
    const joined = await timed.joinExisting(ctxFor(), { userId: user.id, sessionId: "slide-test" });
    check(joined !== null, "a second tab nine minutes in can join");
    check(
      joined!.expiresAt === first.expiresAt,
      "inheriting the original expiry rather than starting a new ten minutes",
      `${joined?.expiresAt} vs ${first.expiresAt}`,
    );

    clock += 61 * 1000; // ten minutes and one second after the grant
    check(
      (await timed.check(ctxFor(), { userId: user.id, sessionId: "slide-test", token: joined!.token })) === null,
      "and both tabs expire together, exactly at the TTL",
    );
    check(
      (await timed.state(ctxFor(), user.id, "slide-test")).elevated === false,
      "with the session reporting itself locked",
    );
    check(ELEVATION_TTL_MS === 10 * 60 * 1000, "which is ten minutes, as the brief says");
  }

  // --- lock now, across tabs -------------------------------------------------------------------
  console.log("\nlocking in one tab locks the session");
  {
    const a = await elevations.grant(ctxFor(), { userId: user.id, sessionId: "two-tabs", method: "passcode" });
    const b = await elevations.joinExisting(ctxFor(), { userId: user.id, sessionId: "two-tabs" });
    check(b !== null, "two tabs of one session each hold a token");
    // Matched on path as well as method: the group now has two DELETEs, and the other one is the
    // prefix route that revokes a credential.
    const lockRoute = routes.find((r) => r.method === "DELETE" && r.path === "/v1/secrets/elevation")!;
    // The lock route acts on the caller's own session, which the fixture pins to `sessionId`, so
    // this is asserted through the service for the tab pair above.
    await elevations.lock(ctxFor(), user.id, "two-tabs");
    check(
      (await elevations.check(ctxFor(), { userId: user.id, sessionId: "two-tabs", token: a.token })) === null,
      "locking ends the tab that locked",
    );
    check(
      (await elevations.check(ctxFor(), { userId: user.id, sessionId: "two-tabs", token: b!.token })) === null,
      "...and the other one, which is what makes it a session property",
    );
    check(guardLevelOf(lockRoute.handler) === "none", "and lock-now needs no elevation, so it works while expiring");
  }

  // --- the badge works while the tab is locked ---------------------------------------------------
  console.log("\nhealth answers without elevation, in counts");
  {
    const healthRoute = routes.find((r) => r.path === "/v1/secrets/health")!;
    check(guardLevelOf(healthRoute.handler) === "none", "health needs no elevation");
    const answer = (await healthRoute.handler(mkReq({ method: "GET", path: "/v1/secrets/health" }))) as {
      body: Record<string, number>;
    };
    check(typeof answer.body["expiringSoon"] === "number", "and answers with counts");
    check(
      Object.values(answer.body).every((v) => typeof v === "number"),
      "every field of which is a number, so there is nowhere for a name to travel",
      JSON.stringify(answer.body),
    );
  }

  // --- setting, changing and resetting a passcode ------------------------------------------------
  console.log("\nthe passcode routes");
  {
    const setRoute = routes.find((r) => r.method === "POST" && r.path === "/v1/secrets/passcode")!;
    const patchRoute = routes.find((r) => r.method === "PATCH" && r.path === "/v1/secrets/passcode")!;
    const resetRoute = routes.find((r) => r.method === "POST" && r.path === "/v1/secrets/passcode/reset")!;
    check(guardLevelOf(setRoute.handler) === "step-up", "setting the first passcode is a step-up route");
    check(guardLevelOf(resetRoute.handler) === "step-up", "and so is resetting a forgotten one");
    check(guardLevelOf(patchRoute.handler) === "mutate", "while changing a known one needs elevation");

    // A SESSION ALONE CANNOT SET ONE. This is acceptance criterion 9, and the reason is that
    // otherwise a hijacked session installs the gate and holds the only key.
    freshLogin = false;
    check(
      (await statusOf(setRoute.handler, mkReq({ body: { passcode: "newpass1" } }))).code === "step_up_required",
      "a valid session alone cannot set a first passcode",
    );

    // The fixture user already has one from the elevation section, so setting is refused as a
    // conflict rather than silently replacing it.
    freshLogin = true;
    const conflict = await statusOf(setRoute.handler, mkReq({ body: { passcode: "newpass1" } }));
    check(conflict.status === 409, "setting one over an existing passcode is refused, not silently replaced");

    // A short passcode is a 400 from the policy, not a 500 from an uncaught throw.
    const tooShort = await statusOf(resetRoute.handler, mkReq({ body: { passcode: "ab" } }));
    check(tooShort.status === 400, "a too-short passcode is a bad request");
    check(tooShort.status !== 500, "...rather than an uncaught error the user cannot read");

    // Reset works on a step-up and ends every elevation, everywhere.
    const stillLive = await elevations.grant(ctxFor(), {
      userId: user.id,
      sessionId: "reset-victim",
      method: "passcode",
    });
    await resetRoute.handler(mkReq({ body: { passcode: "resetpc9" } }));
    check(
      (await elevations.check(ctxFor(), { userId: user.id, sessionId: "reset-victim", token: stillLive.token })) ===
        null,
      "a reset ends every elevation the user holds, on every device",
    );
    check(
      audited.some((a) => a.action === "secrets.passcode_reset"),
      "and is audited",
    );
    check((await passcodes.verify(ctxFor(), user.id, "resetpc9")).ok, "and the new passcode works");

    // Changing needs BOTH elevation and the current passcode — an unlocked tab left open must not
    // be enough to lock its owner out.
    const fresh = await elevations.grant(ctxFor(), { userId: user.id, sessionId, method: "passcode" });
    const wrongCurrent = await statusOf(
      patchRoute.handler,
      mkReq({ method: "PATCH", headers: { [ELEVATION_HEADER]: fresh.token }, body: { current: "nope1234", passcode: "brandnew1" } }),
    );
    check(wrongCurrent.code === "elevation_denied", "changing it with the wrong current passcode is refused");
    check((await passcodes.verify(ctxFor(), user.id, "resetpc9")).ok, "and the old one still works");
    freshLogin = false;
  }

  // --- storing, rotating, revoking ---------------------------------------------------------------
  //
  // Every response in this section is also collected for the serialiser audit at the end, which is
  // the assertion the brief asks for by name: no secrets route returns a plaintext value, checked
  // across every route rather than argued about per handler.
  console.log("\nstoring a credential");
  const responses: unknown[] = [];
  const SECRET_VALUE = "sk-ant-api03-THIS-IS-THE-PLAINTEXT-NOBODY-MAY-SEE-9c11";
  {
    const elevated = await elevations.grant(ctxFor(), { userId: user.id, sessionId, method: "passcode" });
    const withElevation = (init: Parameters<typeof mkReq>[0]) =>
      mkReq({ ...init, headers: { ...(init.headers ?? {}), [ELEVATION_HEADER]: elevated.token } });

    const createRoute = routes.find((r) => r.method === "POST" && r.path === "/v1/secrets")!;
    const listRoute = routes.find((r) => r.method === "GET" && r.path === "/v1/secrets")!;
    const itemPost = routes.find((r) => r.method === "POST" && r.prefix)!;
    const itemDelete = routes.find((r) => r.method === "DELETE" && r.prefix)!;

    // A REJECTED PROVIDER KEY IS NOT STORED. This is acceptance criterion 20.
    providerSaysYes = false;
    const rejected = await statusOf(
      createRoute.handler,
      withElevation({ body: { name: "ANTHROPIC_API_KEY", value: SECRET_VALUE, kind: "provider_key" } }),
    );
    check(rejected.status === 422, "a key the provider rejects is refused");
    const afterReject = (await listRoute.handler(withElevation({ method: "GET", path: "/v1/secrets" }))) as {
      body: { secrets: { name: string }[] };
    };
    check(
      !afterReject.body.secrets.some((s) => s.name === "ANTHROPIC_API_KEY"),
      "...and is not stored, so the row and the vault cannot disagree",
    );

    providerSaysYes = true;
    const created = (await createRoute.handler(
      withElevation({ body: { name: "ANTHROPIC_API_KEY", value: SECRET_VALUE, kind: "provider_key" } }),
    )) as { body: { secret: { maskedHint: string; status: string; kind: string } } };
    responses.push(created.body);
    check(created.body.secret.status === "valid", "a key that passes its probe is stored as valid");
    check(created.body.secret.kind === "provider_key", "classified by kind");
    check(
      created.body.secret.maskedHint === "sk-ant-api03-...9c11",
      "with a mask showing a published prefix and four characters",
      created.body.secret.maskedHint,
    );
    check(!created.body.secret.maskedHint.includes("PLAINTEXT"), "and nothing from the middle of the key");

    // Rotation is the same call against a name that already exists.
    const rotated = (await itemPost.handler(
      withElevation({ path: "/v1/secrets/ANTHROPIC_API_KEY/rotate", body: { value: `${SECRET_VALUE}-rotated-4f2a` } }),
    )) as { body: { secret: { maskedHint: string; rotatedAt: string | null } } };
    responses.push(rotated.body);
    check(rotated.body.secret.rotatedAt !== null, "rotating records when it happened");
    check(rotated.body.secret.maskedHint.endsWith("4f2a"), "and the mask follows the new value");
    const history = await refs.rotations(ctxFor(), "ANTHROPIC_API_KEY");
    check(history.length === 1, "with one history row, holding a mask and no value");
    check(!JSON.stringify(history).includes("PLAINTEXT"), "...and definitely not the old value");

    // Testing a stored key answers ok/message and never the key.
    const tested = (await itemPost.handler(
      withElevation({ path: "/v1/secrets/ANTHROPIC_API_KEY/test" }),
    )) as { body: { ok: boolean; message: string | null } };
    responses.push(tested.body);
    check(tested.body.ok === true, "a stored key can be re-tested on demand");
    providerSaysYes = false;
    const retested = (await itemPost.handler(
      withElevation({ path: "/v1/secrets/ANTHROPIC_API_KEY/test" }),
    )) as { body: { ok: boolean; message: string | null } };
    responses.push(retested.body);
    check(retested.body.ok === false, "and flips to invalid when the provider stops accepting it");
    check(
      (await manager.get(ctxFor(), "ANTHROPIC_API_KEY"))?.status === "invalid",
      "...with the row updated rather than silently retried forever",
    );
    providerSaysYes = true;

    // The list, and the once-only rule: nothing here is the value.
    const listed = (await listRoute.handler(withElevation({ method: "GET", path: "/v1/secrets" }))) as {
      body: { secrets: unknown[] };
    };
    responses.push(listed.body);
    check(listed.body.secrets.length >= 1, "the list answers with what the workspace has");

    // --- revoking, and the blast-radius confirmation --------------------------------------------
    console.log("\nrevoking");
    await manager.store(ctxFor(), { name: "OPENWEATHER_API_KEY", value: "a-plain-custom-credential-value", kind: "custom" });
    const unreferenced = (await itemDelete.handler(
      withElevation({ method: "DELETE", path: "/v1/secrets/OPENWEATHER_API_KEY" }),
    )) as { body: { revoked: string } };
    responses.push(unreferenced.body);
    check(unreferenced.body.revoked === "OPENWEATHER_API_KEY", "a credential nothing points at revokes directly");

    await manager.store(ctxFor(), { name: "STRIPE_SECRET_KEY", value: "another-plain-custom-value-here", kind: "custom" });
    await usages.record(ctxFor(), { name: "STRIPE_SECRET_KEY", source: "static_scan", location: "tools/pay.py:9" });
    const needsTyping = await statusOf(
      itemDelete.handler,
      withElevation({ method: "DELETE", path: "/v1/secrets/STRIPE_SECRET_KEY" }),
    );
    check(needsTyping.status === 409, "a REFERENCED credential refuses a bare revoke");
    check(needsTyping.code === "confirmation_required", "asking for its name to be typed");
    const wrongName = await statusOf(
      itemDelete.handler,
      withElevation({ method: "DELETE", path: "/v1/secrets/STRIPE_SECRET_KEY", body: { confirm: "NOT_THE_NAME" } }),
    );
    check(wrongName.status === 409, "and the wrong name does not satisfy it");
    const confirmed = (await itemDelete.handler(
      withElevation({ method: "DELETE", path: "/v1/secrets/STRIPE_SECRET_KEY", body: { confirm: "STRIPE_SECRET_KEY" } }),
    )) as { body: { revoked: string } };
    check(confirmed.body.revoked === "STRIPE_SECRET_KEY", "typing it exactly goes through");

    // --- managed credentials get neither verb ----------------------------------------------------
    console.log("\nmanaged credentials");
    await manager.store(ctxFor(), { name: "GITHUB_TOKEN", value: "ghp_a-connector-owned-token-value", kind: "custom" });
    await refs.setMetadata(ctxFor(), "GITHUB_TOKEN", { kind: "managed", connectorId: "github" });
    const cannotRotate = await statusOf(
      itemPost.handler,
      withElevation({ path: "/v1/secrets/GITHUB_TOKEN/rotate", body: { value: "ghp_something-else-entirely" } }),
    );
    check(cannotRotate.status === 409 && cannotRotate.code === "managed_credential", "a managed credential cannot be rotated");
    const cannotRevoke = await statusOf(
      itemDelete.handler,
      withElevation({ method: "DELETE", path: "/v1/secrets/GITHUB_TOKEN" }),
    );
    check(cannotRevoke.status === 409, "nor revoked — the fix is reconnecting the connector");

    // --- importing a bundle ------------------------------------------------------------------------
    console.log("\nimporting an export from somewhere else");
    const importRoute = routes.find((r) => r.path === "/v1/secrets/import")!;
    const imported = (await importRoute.handler(
      withElevation({
        path: "/v1/secrets/import",
        body: {
          text: JSON.stringify({
            data: { data: { VAULT_ONE: "a-vault-kv2-credential-value", lower_case: "refused", VAULT_TWO: "" } },
          }),
        },
      }),
    )) as { body: { format: string; imported: string[]; rejected: { name: string; reason: string }[] } };
    responses.push(imported.body);
    check(imported.body.format === "vault", "a Vault KV-v2 document is recognised as one");
    check(imported.body.imported.includes("VAULT_ONE"), "and its credentials are stored");
    check(
      imported.body.rejected.some((r) => r.name === "lower_case"),
      "a name that is not a legal credential name is rejected with a reason",
    );
    check(
      imported.body.rejected.some((r) => r.name === "VAULT_TWO"),
      "and so is an empty value, which is a template placeholder rather than a credential",
    );
    check(
      !JSON.stringify(imported.body).includes("a-vault-kv2-credential-value"),
      "and the import response carries names and reasons, never a value",
    );
  }

  // --- reveal: the one route that returns a credential (ADR-035) ---------------------------------
  //
  // Its responses are deliberately kept OUT of `responses`, because the serialiser audit below
  // asserts that no route returns a value and this is the documented exception. Keeping it out is
  // the honest arrangement: the audit would otherwise have to special-case a route, which is how
  // an audit stops meaning anything.
  console.log("\nreveal");
  {
    const elevated = await elevations.grant(ctxFor(), { userId: user.id, sessionId, method: "passcode" });
    const itemPost = routes.find((r) => r.method === "POST" && r.prefix)!;
    const withElevation = (path: string, token = elevated.token) =>
      mkReq({ path, headers: { [ELEVATION_HEADER]: token } });

    // WITHOUT ELEVATION IT IS NOT REACHABLE AT ALL — the guard refuses before reveal is consulted.
    const locked = await statusOf(itemPost.handler, mkReq({ path: "/v1/secrets/ANTHROPIC_API_KEY/reveal" }));
    check(locked.code === "elevation_required", "reveal is refused without a live elevation");

    const revealed = (await itemPost.handler(withElevation("/v1/secrets/ANTHROPIC_API_KEY/reveal"))) as {
      body: { name: string; value: string };
      headers?: Record<string, string>;
    };
    check(revealed.body.value.endsWith("-rotated-4f2a"), "with one it returns the credential the owner stored");
    check(
      (revealed.headers?.["cache-control"] ?? "").includes("no-store"),
      "on a response nothing may cache",
      revealed.headers?.["cache-control"],
    );
    check(
      audited.some((a) => a.action === "secrets.revealed" && a.detail["name"] === "ANTHROPIC_API_KEY"),
      "and every reveal is audited by name",
    );

    // A NAME WITH NOTHING STORED IS A 404, not an empty string. `STRIPE_SECRET_KEY` was revoked
    // above, so its registry row survives with `configured: false` and the vault has nothing.
    const gone = await statusOf(itemPost.handler, withElevation("/v1/secrets/STRIPE_SECRET_KEY/reveal"));
    check(gone.status === 404, "a name with no stored value reveals nothing rather than an empty string");

    // AND THE DEPLOYMENT THAT KEPT ADR-033's POSTURE. Absent `reveal`, the route does not exist.
    const strictRoutes = secretsRoutes({ ...deps, reveal: undefined });
    const strictItemPost = strictRoutes.find((r) => r.method === "POST" && r.prefix)!;
    const refused = await statusOf(strictItemPost.handler, withElevation("/v1/secrets/ANTHROPIC_API_KEY/reveal"));
    check(refused.status === 404, "a build that wires no reveal has no path from a request to a value");
  }

  // --- the serialiser audit -----------------------------------------------------------------------
  //
  // Acceptance criterion 11, asserted across every response this suite collected rather than
  // argued handler by handler. The needle is a value that was genuinely stored in a real vault.
  console.log("\nno route returns a plaintext value");
  {
    const haystack = JSON.stringify(responses);
    check(responses.length >= 6, `collected ${responses.length} route responses to check`);
    for (const needle of ["PLAINTEXT", SECRET_VALUE, "a-plain-custom-credential-value", "a-vault-kv2-credential-value"]) {
      check(!haystack.includes(needle), `no response contains ${needle.slice(0, 24)}…`);
    }
    // And the mask is present, so the check above is not passing because the responses were empty.
    check(haystack.includes("sk-ant-api03-...9c11"), "...while the MASK is present, so this is checking real output");
  }

  // --- step-up ----------------------------------------------------------------------------------
  console.log("\nstep-up cannot be satisfied by a session alone");
  {
    const stepUp = guarded(deps, { elevation: "step-up" }, async () => ({ body: { ok: true } }));
    freshLogin = false;
    const refused = await statusOf(stepUp, elevatedReq);
    check(refused.status === 403 && refused.code === "step_up_required", "a valid session is not a fresh sign-in");
    check(refused.status !== 401, "and it is not a 401, which would throw the user out of the app");
    freshLogin = true;
    check((await statusOf(stepUp, mkReq({}))).status === 0, "a fresh sign-in satisfies it, with no elevation at all");
    freshLogin = false;
  }
} finally {
  await db.close();
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

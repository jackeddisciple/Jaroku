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
    const lockRoute = routes.find((r) => r.method === "DELETE")!;
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

// `/v1/auth/session`: the request where an external `sub` becomes an internal user.
//
// Runs on both drivers, because the two disagree about the case that matters most here. On
// SQLite there is one connection and transactions serialise, so a concurrent double sign-in
// cannot happen; on Postgres each transaction gets its own pooled connection, both see no
// user, and both insert. That difference is silent — the local path works perfectly and the
// hosted one drops a sign-in — which is exactly the shape of bug the two-driver suites exist
// for.
//
//   npm run test:session
//   JAROKU_PG_URL=postgres://… npm run test:session    # runs it twice

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { withScratchPostgres } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext } from "../db/tenant.ts";
import { Router } from "../http/router.ts";
import { JwksClient } from "./jwks.ts";
import { TokenVerifier } from "./verifier.ts";
import { LocalIssuer } from "./localIssuer.ts";
import { sessionRoutes } from "./session.ts";
import { memoryTicketStore } from "./tickets.ts";
import { ContextResolver } from "./resolve.ts";
import { DEFAULT_AUDIENCE, LOCAL_ISSUER, type AuthConfig } from "./config.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(new URL("../..", import.meta.url).pathname, "migrations");
const keyDir = mkdtempSync(join(tmpdir(), "jaroku-session-"));
const issuer = new LocalIssuer(join(keyDir, "devauth.json"), DEFAULT_AUDIENCE, () => {});

/** Serve the issuer's JWKS so the verifier's real fetch path is what is exercised. */
const jwksHttp = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issuer.jwks()));
});
await new Promise<void>((r) => jwksHttp.listen(0, "127.0.0.1", r));
const jwksUrl = `http://127.0.0.1:${(jwksHttp.address() as AddressInfo).port}/jwks.json`;

async function serve(db: Db, mode: AuthConfig["mode"]): Promise<{ base: string; close: () => Promise<void> }> {
  const config: AuthConfig = { mode, issuer: LOCAL_ISSUER, audience: DEFAULT_AUDIENCE, jwksUrl };
  const router = new Router({ log: () => {} });
  for (const route of sessionRoutes({
    config,
    verifier: new TokenVerifier(config, new JwksClient({ url: jwksUrl })),
    identity: new IdentityRepository(db),
    localIssuer: mode === "local" ? issuer : undefined,
    // The ticket route only exists once there is somewhere to put a ticket. Memory-backed
    // here: the Db-backed one has its own suite, and what this file is asking is whether the
    // route agrees with /v1/auth/session about which workspace a client is in.
    tickets: memoryTicketStore(),
    resolver: new ContextResolver({ identity: new IdentityRepository(db), log: () => {} }),
    log: () => {},
  })) {
    if (route.method === "GET") router.get(route.path, route.handler);
    else router.post(route.path, route.handler);
  }
  const http = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}

async function post(base: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the assertion is about the status */
  }
  return { status: res.status, json };
}

async function suite(driver: string, db: Db): Promise<void> {
  console.log(`\n${driver}`);
  // Lowercased, because every email below is built from it and the verifier normalises
  // addresses on the way in — an assertion comparing against a mixed-case one tests nothing
  // but its own spelling.
  const label = driver.toLowerCase();
  const identity = new IdentityRepository(db);
  const sys = systemContext(newRequestId());
  const server = await serve(db, "local");
  const { base } = server;

  console.log("  · first sight");
  {
    const { token } = issuer.mint({ email: `ada-${label}@example.com`, displayName: "Ada L" });
    const first = await post(base, "/v1/auth/session", token);
    check(first.status === 200, `a verified token provisions an account (${first.status})`);
    check(first.json?.user?.email === `ada-${label}@example.com`, "...with the token's email");
    check(first.json?.workspaces?.length >= 1, "...belonging to at least one workspace");
    check(
      first.json?.workspaces?.some((w: any) => w.kind === "personal" && w.role === "owner"),
      "...owning a personal one",
    );
    check(
      first.json.workspaces.some((w: any) => w.id === first.json.defaultWorkspaceId),
      "the default workspace is always one they belong to",
    );

    const second = await post(base, "/v1/auth/session", token);
    check(second.json?.user?.id === first.json?.user?.id, "signing in again is the same user, not a second one");
    check(
      second.json?.workspaces?.length === first.json?.workspaces?.length,
      "...and does not create a second personal workspace",
    );
  }

  console.log("  · onboarding is a fact about the PERSON");
  {
    // Migration 013. The flow used to be gated on a browser-local flag, which answered "is this
    // BROWSER new" — so a second account on a used machine skipped onboarding entirely and a
    // returning user in a private window was welcomed to a product they already use. The server
    // is the only place that can answer the question actually being asked.
    const { token } = issuer.mint({ email: `onb-${label}@example.com` });
    const fresh = await post(base, "/v1/auth/session", token);
    check(fresh.json?.user?.onboarded === false, "a brand-new account has NOT onboarded");

    const marked = await post(base, "/v1/auth/onboarded", token);
    check(marked.status === 200 && marked.json?.onboarded === true, `finishing it is recorded (${marked.status})`);

    const again = await post(base, "/v1/auth/session", token);
    check(again.json?.user?.onboarded === true, "...and the NEXT sign-in knows — on any browser, any device");

    // Idempotent, because the client can fire it from an effect that a second tab, a
    // re-render or a reload each re-runs. The first time is the one that means anything: a
    // column that moved would record the most recent visit rather than the first.
    const first = await db.get<{ onboarded_at: string }>(
      `SELECT onboarded_at FROM users WHERE email = ?`, [`onb-${label}@example.com`],
    );
    await post(base, "/v1/auth/onboarded", token);
    const after = await db.get<{ onboarded_at: string }>(
      `SELECT onboarded_at FROM users WHERE email = ?`, [`onb-${label}@example.com`],
    );
    check(
      first?.onboarded_at === after?.onboarded_at,
      "marking it twice does not move the timestamp — it records the FIRST time, not the latest",
    );

    // It is the caller's own flag and nobody else's. There is no user id in the body precisely
    // so that there is none to forge, and a second account is unaffected by the first's call.
    const other = issuer.mint({ email: `onb-other-${label}@example.com` });
    const otherView = await post(base, "/v1/auth/session", other.token);
    check(otherView.json?.user?.onboarded === false, "another account is untouched by somebody else finishing");

    check((await post(base, "/v1/auth/onboarded")).status === 401, "and it takes a token like everything else");
  }

  console.log("  · concurrent first sight");
  {
    // The real case: the client asks for a session and a ws-ticket in the same tick, and a
    // second tab doubles it. On Postgres these are separate connections that both see no row.
    const { token } = issuer.mint({ email: `race-${label}@example.com` });
    const results = await Promise.all(Array.from({ length: 6 }, () => post(base, "/v1/auth/session", token)));
    check(results.every((r) => r.status === 200), `six simultaneous first sign-ins all succeed (${results.map((r) => r.status).join(",")})`);
    const ids = new Set(results.map((r) => r.json?.user?.id));
    check(ids.size === 1, `...and all resolve to ONE user (${ids.size})`);
    const rows = await db.all(`SELECT id FROM users WHERE email = ?`, [`race-${label}@example.com`]);
    check(rows.length === 1, `...with exactly one row in the table (${rows.length})`);
  }

  console.log("  · refusals");
  {
    const none = await post(base, "/v1/auth/session");
    check(none.status === 401, "no Authorization header is 401");
    const garbage = await post(base, "/v1/auth/session", "not.a.token");
    check(garbage.status === 401, "a token that does not verify is 401");
    const expired = issuer.mint({ email: `stale-${label}@example.com`, ttlS: -3600 });
    const old = await post(base, "/v1/auth/session", expired.token);
    check(old.status === 401, "an expired token is 401");

    // Same address, different `sub`: a person whose provider changed. It needs a sentence,
    // not a unique-violation stack trace.
    const taken = issuer.mint({ subject: "other|provider", email: `ada-${label}@example.com` });
    const conflict = await post(base, "/v1/auth/session", taken.token);
    check(conflict.status === 403, `a second sub claiming a taken email is refused (${conflict.status})`);
    check(
      typeof conflict.json?.error?.message === "string" && /different sign-in/.test(conflict.json.error.message),
      "...with a message that says what happened",
    );
  }

  console.log("  · adopting what nobody owns");
  {
    // Exactly what Session 1's importer and dev-tenancy resolver leave behind, and what
    // `createWorkspaceUnowned` promises gets adopted here.
    const orphan = await identity.createWorkspaceUnowned(sys, { name: `imported ${label}` });
    const { token } = issuer.mint({ email: `heir-${label}@example.com` });
    const view = await post(base, "/v1/auth/session", token);
    check(
      view.json?.workspaces?.some((w: any) => w.id === orphan.id && w.role === "owner"),
      "the first sign-in on a LOCAL install adopts a workspace nobody owns",
    );

    // ...and the second person does not inherit it, because it is no longer unowned.
    const later = issuer.mint({ email: `later-${label}@example.com` });
    const second = await post(base, "/v1/auth/session", later.token);
    check(
      !second.json?.workspaces?.some((w: any) => w.id === orphan.id),
      "...and the next user does not, because it is owned now",
    );

    // An adopted workspace stops being `personal`. Without this the heir owns two personal
    // workspaces, and every rule that says "their personal one" has two answers — which is
    // exactly what made /v1/auth/session and /v1/ws-ticket disagree about the default.
    const adopted = view.json.workspaces.find((w: any) => w.id === orphan.id);
    check(adopted?.kind === "team", `an adopted workspace becomes a team, not a second personal one (${adopted?.kind})`);
    const personals = view.json.workspaces.filter((w: any) => w.kind === "personal");
    check(personals.length === 1, `...so a user has exactly one personal workspace (${personals.length})`);
    check(
      view.json.defaultWorkspaceId === personals[0]?.id,
      "...and the default is that one, not whichever the database returned first",
    );
  }

  console.log("  · the default a socket gets is the default the client was told");
  {
    // The two used to be computed separately, and the symptom was a UI showing one workspace's
    // name above another workspace's runs.
    const { token } = issuer.mint({ email: `agree-${label}@example.com` });
    const view = await post(base, "/v1/auth/session", token);
    const ticket = await post(base, "/v1/ws-ticket", token);
    check(ticket.status === 200, `a ws-ticket is issued (${ticket.status})`);
    check(
      ticket.json?.workspaceId === view.json?.defaultWorkspaceId,
      `a ticket asked for with no workspace lands in the reported default ` +
        `(${ticket.json?.workspaceId} vs ${view.json?.defaultWorkspaceId})`,
    );

    const explicit = await post(base, "/v1/ws-ticket", token, { workspaceId: view.json.workspaces[0].id });
    check(explicit.json?.workspaceId === view.json.workspaces[0].id, "...and asking for one you belong to honours it");

    const notMine = await post(base, "/v1/ws-ticket", token, { workspaceId: "00000000-0000-4000-8000-00000000dead" });
    check(notMine.status === 403, "...while asking for one you do not is refused, before a ticket exists");

    const noToken = await post(base, "/v1/ws-ticket");
    check(noToken.status === 401, "a ticket cannot be had without a token at all");
  }

  await server.close();

  console.log("  · provider mode never adopts");
  {
    const providerServer = await serve(db, "provider");
    const orphan = await identity.createWorkspaceUnowned(sys, { name: `hosted orphan ${label}` });
    const { token } = issuer.mint({ email: `hosted-${label}@example.com` });
    const view = await post(providerServer.base, "/v1/auth/session", token);
    check(
      !view.json?.workspaces?.some((w: any) => w.id === orphan.id),
      "signing up hosted does NOT acquire somebody else's imported workspace",
    );

    const jwks = await fetch(`${providerServer.base}/v1/auth/jwks.json`);
    check(jwks.status === 404, "the local issuer's JWKS route does not exist in provider mode");
    const devLogin = await post(providerServer.base, "/v1/auth/dev-login", undefined, { email: "x@y.com" });
    check(devLogin.status === 404, "...and neither does dev-login");
    await providerServer.close();
  }

  console.log("  · the local sign-in route");
  {
    const local = await serve(db, "local");
    const ok = await post(local.base, "/v1/auth/dev-login", undefined, { email: `Dev-${label}@Example.com` });
    check(ok.status === 200 && typeof ok.json?.token === "string", "dev-login mints a token");
    const used = await post(local.base, "/v1/auth/session", ok.json.token);
    check(used.status === 200 && used.json?.user?.email === `dev-${label}@example.com`, "...which the session route accepts, normalised");

    const bad = await post(local.base, "/v1/auth/dev-login", undefined, { email: "not-an-address" });
    check(bad.status === 401, "dev-login refuses something that is not an address — it lands in a UNIQUE column");

    const jwks = await fetch(`${local.base}/v1/auth/jwks.json`);
    const doc = (await jwks.json()) as { keys: { kty: string; d?: string }[] };
    check(jwks.status === 200 && doc.keys.length === 1, "the local JWKS serves exactly one key");
    check(doc.keys.every((k) => k.d === undefined), "...and it is the PUBLIC half — no private material is published");
    await local.close();
  }
}

const tmp = mkdtempSync(join(tmpdir(), "jaroku-session-db-"));
{
  const db = new SqliteDb(join(tmp, "session.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  try {
    await suite("SqliteDb", db);
  } finally {
    await db.close();
  }
}
rmSync(tmp, { recursive: true, force: true });

await withScratchPostgres(async (db) => {
  await suite("PostgresDb", db);
});

await new Promise<void>((r) => jwksHttp.close(() => r()));
rmSync(keyDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

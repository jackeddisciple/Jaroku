// The Secrets tab's acceptance criteria, run against a real server over real HTTP.
//
// WHY THIS EXISTS WHEN `test:secret-routes` ALREADY PASSES. That suite calls handlers directly,
// which proves the handlers. It cannot prove the WIRING — that the routes are registered on the
// router at the paths the client uses, that the elevation header survives the request pipeline,
// that `contextFor` resolves a real bearer token, that the guard is reached before the handler.
// Every one of those is a place this feature could be complete and unreachable.
//
// The brief's first acceptance criterion is specific about the method: 403 without elevation,
// "verified with a valid session cookie and the UI bypassed entirely (curl)". This is that, with a
// bearer token instead of a cookie because that is what this server authenticates with.
//
// TWO ACCOUNTS, in the shape `acceptance.test.ts` established, because the most important thing to
// prove about a credential surface is not that it works — it is that one tenant's does not answer
// another's requests.
//
//   npm run test:secrets-e2e

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { SecretUsageRepository } from "../db/repositories/secretUsages.ts";
import { SecretElevationRepository } from "../db/repositories/secretElevations.ts";
import { SecretPasscodeRepository } from "../db/repositories/secretPasscodes.ts";
import { Router } from "../http/router.ts";
import { secretsRoutes, type SecretsCaller } from "../http/secrets.ts";
import { ELEVATION_HEADER, SecretElevations, sessionIdFor } from "./elevation.ts";
import { SecretPasscodes } from "./passcode.ts";
import { SecretsManager } from "./manager.ts";
import { KmsSecretStore } from "./kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./masterKey.ts";

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
const dir = mkdtempSync(join(tmpdir(), "jaroku-secrets-e2e-"));
scratch.push(dir);

const db: Db = new SqliteDb(join(dir, "e2e.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const refs = new SecretRefRepository(db);
const usages = new SecretUsageRepository(db);
const sys = systemContext(newRequestId());

/** A tenant: a workspace, a user, and the bearer token that stands for their session. */
async function tenant(label: string): Promise<{ workspaceId: string; userId: string; bearer: string }> {
  const ws = await identity.createWorkspaceUnowned(sys, { name: `${label} ${randomUUID().slice(0, 6)}` });
  const { user } = await identity.provisionUser(sys, {
    externalId: `e2e_${randomUUID().slice(0, 10)}`,
    email: `${randomUUID().slice(0, 10)}@example.com`,
  });
  return { workspaceId: ws.id, userId: user.id, bearer: `bearer-for-${label}-${randomUUID()}` };
}

const A = await tenant("alpha");
const B = await tenant("beta");
const byBearer = new Map([
  [A.bearer, A],
  [B.bearer, B],
]);

const vault = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider("a-master-key-with-enough-entropy-behind-it-0123456789"),
  refs,
  runWorkspace: async () => null,
});
const manager = new SecretsManager({
  secrets: vault,
  refs,
  usages,
  verify: async () => ({ ok: true, message: null }),
});
const elevations = new SecretElevations({ elevations: new SecretElevationRepository(db) });
const passcodes = new SecretPasscodes({ passcodes: new SecretPasscodeRepository(db) });

/** Set per request by the fixture, standing in for a fresh IdP login. */
let freshLogin = false;

const router = new Router();
for (const route of secretsRoutes({
  // The real resolution shape: a bearer token becomes a workspace and a user, and the session is a
  // digest of the token. What is stubbed is the JWT verification, not the mapping.
  callerFor: async (req): Promise<SecretsCaller> => {
    const header = req.header("authorization") ?? "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] ?? "";
    const who = byBearer.get(bearer);
    if (!who) {
      const { unauthorized } = await import("../http/router.ts");
      throw unauthorized("this endpoint needs an Authorization: Bearer <token> header");
    }
    return {
      ctx: { ...systemContextFor(who.workspaceId, req.requestId), role: "owner" },
      userId: who.userId,
      sessionId: sessionIdFor(bearer),
      reauthenticatedRecently: freshLogin,
      ip: req.ip,
      userAgent: req.header("user-agent") ?? null,
    };
  },
  elevations,
  passcodes,
  gateFor: (ctx) => identity.secretsGate(ctx),
  audit: async () => {},
  health: async (ctx) => ({ ...(await refs.health(ctx)) }),
  list: (ctx) => manager.list(ctx),
  store: (c, input) => manager.store(c.ctx, { ...input, actorUserId: c.userId }),
  revoke: (c, name) => manager.revoke(c.ctx, name),
  test: (c, name) => manager.test(c.ctx, name),
  isReferenced: (ctx, name) => manager.isReferenced(ctx, name),
  usage: (c, name) => manager.usage(c.ctx, name),
  reveal: async (req, c, name) => {
    const receipt = await elevations.receiptFor(c.ctx, {
      userId: c.userId,
      sessionId: c.sessionId,
      token: req.header(ELEVATION_HEADER) ?? "",
    });
    return receipt ? manager.reveal(receipt, name) : null;
  },
})) {
  if (route.prefix) router.prefixRoute(route.method, route.path, route.handler);
  else if (route.method === "GET") router.get(route.path, route.handler);
  else if (route.method === "PATCH") router.patch(route.path, route.handler);
  else if (route.method === "DELETE") router.del(route.path, route.handler);
  else router.post(route.path, route.handler);
}

const server: Server = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

interface Answer {
  status: number;
  code: string;
  body: Record<string, unknown>;
  headers: Headers;
  text: string;
}

async function call(
  who: { bearer: string },
  method: string,
  path: string,
  opts: { body?: unknown; elevation?: string } = {},
): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${who.bearer}`,
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.elevation ? { [ELEVATION_HEADER]: opts.elevation } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* a non-JSON answer; `text` is what the assertion reads */
  }
  const error = body["error"] as { code?: string } | undefined;
  return { status: res.status, code: error?.code ?? "", body, headers: res.headers, text };
}

const SECRET_A = "sk-ant-api03-alphas-own-credential-value-1234";

try {
  // --- 1. 403 without elevation, with the UI bypassed entirely --------------------------------
  console.log("\nthe gate, over real HTTP");
  {
    const anonymous = await fetch(`${base}/v1/secrets`);
    check(anonymous.status === 401, `no credential at all is 401 (${anonymous.status})`);

    const listed = await call(A, "GET", "/v1/secrets");
    check(listed.status === 403, `a valid session with no elevation is 403 (${listed.status})`);
    check(listed.code === "elevation_required", "with a code the client can branch on", listed.code);
    check(!listed.text.includes("sk-"), "and no credential in the refusal");

    // The badge's counts answer while locked. Criterion 16.
    const health = await call(A, "GET", "/v1/secrets/health");
    check(health.status === 200, "health answers without elevation");
    check(
      Object.values(health.body).every((v) => typeof v === "number"),
      "in counts, with nowhere for a name to travel",
      health.text,
    );
  }

  // --- 2. first-run setup needs a step-up ------------------------------------------------------
  console.log("\nsetting the first passcode");
  {
    freshLogin = false;
    const refused = await call(A, "POST", "/v1/secrets/passcode", { body: { passcode: "hunter2!" } });
    check(refused.status === 403 && refused.code === "step_up_required", "a session alone cannot set one");

    freshLogin = true;
    const set = await call(A, "POST", "/v1/secrets/passcode", { body: { passcode: "hunter2!" } });
    check(set.status === 200, `a fresh sign-in can (${set.status})`);
    freshLogin = false;
  }

  // --- 3. wrong and unset are indistinguishable ------------------------------------------------
  console.log("\nwrong passcode and no passcode");
  {
    const wrong = await call(A, "POST", "/v1/secrets/elevation", {
      body: { method: "passcode", credential: "not-the-one" },
    });
    // B has never set one at all.
    const unset = await call(B, "POST", "/v1/secrets/elevation", {
      body: { method: "passcode", credential: "not-the-one" },
    });
    check(wrong.status === unset.status, `the same status (${wrong.status})`);
    check(
      (wrong.body["error"] as { message?: string })?.message ===
        (unset.body["error"] as { message?: string })?.message,
      "and the same message",
    );
  }

  // --- 4. unlocking, and what it opens ----------------------------------------------------------
  console.log("\nunlocking");
  let elevation = "";
  {
    const granted = await call(A, "POST", "/v1/secrets/elevation", {
      body: { method: "passcode", credential: "hunter2!" },
    });
    check(granted.status === 200, "the right passcode grants");
    check((granted.headers.get("cache-control") ?? "").includes("no-store"), "on an uncacheable response");
    elevation = String(granted.body["token"]);
    check(elevation.length >= 40, "with a token");

    const listed = await call(A, "GET", "/v1/secrets", { elevation });
    check(listed.status === 200, "and the list opens");
  }

  // --- 5. storing, and that no route hands the value back ---------------------------------------
  console.log("\nstoring and reading back");
  {
    const created = await call(A, "POST", "/v1/secrets", {
      elevation,
      body: { name: "ANTHROPIC_API_KEY", value: SECRET_A, kind: "provider_key" },
    });
    check(created.status === 200, `a provider key is stored (${created.status})`);
    check(!created.text.includes(SECRET_A), "and the response does not contain it");

    const listed = await call(A, "GET", "/v1/secrets", { elevation });
    check(!listed.text.includes(SECRET_A), "nor does the list");
    check(listed.text.includes("sk-ant-api03-...1234"), "which carries the mask instead", listed.text.slice(0, 200));

    // ADR-035: the one route that does hand it back.
    const revealed = await call(A, "POST", "/v1/secrets/ANTHROPIC_API_KEY/reveal", { elevation });
    check(revealed.status === 200 && revealed.body["value"] === SECRET_A, "and reveal returns it, with elevation");
    check(
      (revealed.headers.get("cache-control") ?? "").includes("no-store"),
      "on a response nothing may cache",
    );
    const noElevation = await call(A, "POST", "/v1/secrets/ANTHROPIC_API_KEY/reveal");
    check(noElevation.status === 403, "and refuses without it");
  }

  // --- 6. one tenant cannot reach another's -------------------------------------------------------
  console.log("\ntwo accounts, one server");
  {
    // B holds no elevation, and A's token is not B's to use.
    const withAsToken = await call(B, "GET", "/v1/secrets", { elevation });
    check(withAsToken.status === 403, "A's elevation token does nothing for B");

    freshLogin = true;
    await call(B, "POST", "/v1/secrets/passcode", { body: { passcode: "betapass1" } });
    freshLogin = false;
    const bGrant = await call(B, "POST", "/v1/secrets/elevation", {
      body: { method: "passcode", credential: "betapass1" },
    });
    const bElevation = String(bGrant.body["token"]);
    check(bGrant.status === 200, "B unlocks its own");

    const bList = await call(B, "GET", "/v1/secrets", { elevation: bElevation });
    check(bList.status === 200, "and sees its own list");
    check(!bList.text.includes("ANTHROPIC_API_KEY"), "which does not contain A's credential");
    check(!bList.text.includes(SECRET_A), "and certainly not A's value");

    const bReveal = await call(B, "POST", "/v1/secrets/ANTHROPIC_API_KEY/reveal", { elevation: bElevation });
    check(bReveal.status === 404, `B cannot reveal a credential of A's (${bReveal.status})`);
    check(!bReveal.text.includes(SECRET_A), "and learns nothing from trying");
  }

  // --- 7. the blast-radius confirmation ------------------------------------------------------------
  console.log("\nrevoking what something depends on");
  {
    await call(A, "POST", "/v1/secrets", {
      elevation,
      body: { name: "OPENWEATHER_API_KEY", value: "a-custom-credential-value-here", kind: "custom" },
    });
    await usages.record(systemContextFor(A.workspaceId, newRequestId()), {
      name: "OPENWEATHER_API_KEY",
      source: "static_scan",
      location: "tools/weather.py:14",
    });

    const usage = await call(A, "GET", "/v1/secrets/OPENWEATHER_API_KEY/usage", { elevation });
    check(usage.status === 200, "usage answers");
    check(usage.text.includes("static_scan"), "labelling each site with its source", usage.text.slice(0, 160));

    const bare = await call(A, "DELETE", "/v1/secrets/OPENWEATHER_API_KEY", { elevation, body: {} });
    check(bare.status === 409 && bare.code === "confirmation_required", "a bare revoke is refused");
    const typed = await call(A, "DELETE", "/v1/secrets/OPENWEATHER_API_KEY", {
      elevation,
      body: { confirm: "OPENWEATHER_API_KEY" },
    });
    check(typed.status === 200, "and typing the name goes through");
  }

  // --- 8. locking, and the TTL --------------------------------------------------------------------
  console.log("\nlocking");
  {
    // A second tab of the same session joins, inheriting the expiry.
    const joined = await call(A, "GET", "/v1/secrets/elevation?join=1", {});
    const second = String(joined.body["token"]);
    check(second.length >= 40, "a second tab of the session gets its own token");
    check(second !== elevation, "which is not the first tab's");

    const locked = await call(A, "DELETE", "/v1/secrets/elevation");
    check(locked.status === 200, "lock now succeeds");
    check(Number(locked.body["ended"]) >= 2, `ending every token the session held (${locked.body["ended"]})`);

    const afterFirst = await call(A, "GET", "/v1/secrets", { elevation });
    const afterSecond = await call(A, "GET", "/v1/secrets", { elevation: second });
    check(afterFirst.status === 403, "the first tab is locked");
    check(afterSecond.status === 403, "and so is the second — which is criterion 7");
  }

  // --- 9. a new route in the group is protected without anybody remembering -------------------------
  console.log("\nthe group's default");
  {
    // Every path the group serves, hit with a valid session and no elevation. The only ones that
    // may answer are the three that exist to make elevation possible, plus the badge.
    const open = ["/v1/secrets/health", "/v1/secrets/elevation"];
    for (const path of ["/v1/secrets", "/v1/secrets/ANTHROPIC_API_KEY/usage"]) {
      const answer = await call(A, "GET", path);
      check(answer.status === 403, `${path} refuses without elevation (${answer.status})`);
    }
    for (const path of open) {
      const answer = await call(A, "GET", path);
      check(answer.status === 200, `${path} answers while locked, on purpose (${answer.status})`);
    }
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

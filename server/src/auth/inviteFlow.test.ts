// §14.1's `test:invite-flow` — an invitation from the moment it is minted to the membership it
// becomes, over the wire it actually travels on.
//
// WHY IT IS NOT A SECOND `test:members`. That suite exercises the REPOSITORY: `createInvite`
// answers with a token, `acceptInvite` turns one into a row, both write audit rows, and every
// refusal is checked against the transaction that produced it. Everything it asserts is true of a
// function call. What no function call can tell you is whether the thing a client actually does —
// `POST /v1/invites/accept` with a bearer token and a string — reaches that function with the
// right arguments, provisions an account that has never been seen before on the way past, and
// answers with a workspace list the switcher can render.
//
// THAT GAP IS WHERE THE FAILURES LIVE. The route provisions the accepter first, because somebody
// arriving from a link may not have an account yet; it resolves nothing from the client's own
// claim about which workspace it is; and it answers with the full membership list rather than a
// bare success, because §4.1.2's flow puts the joined workspace into the switcher immediately. A
// repository test passes with every one of those wrong.
//
// §13.4's LINK INVITATION IS THE OTHER HALF, and it is the reason this suite exists in this
// release rather than being folded into `test:members`: an invitation with no address is
// redeemable by whoever holds it, which is a genuinely different credential, and the assertion
// that matters is the one about the account that was never named anywhere near it.
//
//   npm run test:invite-flow
//   JAROKU_PG_URL=postgres://… npm run test:invite-flow    # runs it twice

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { withScratchPostgres } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
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

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");
const keyDir = mkdtempSync(join(tmpdir(), "jaroku-inviteflow-"));
const issuer = new LocalIssuer(join(keyDir, "devauth.json"), DEFAULT_AUDIENCE, () => {});

/** The issuer's own JWKS, served, so the verifier's real fetch path is what is exercised. */
const jwksHttp = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issuer.jwks()));
});
await new Promise<void>((r) => jwksHttp.listen(0, "127.0.0.1", r));
const jwksUrl = `http://127.0.0.1:${(jwksHttp.address() as AddressInfo).port}/jwks.json`;

async function serve(db: Db): Promise<{ base: string; close: () => Promise<void> }> {
  const config: AuthConfig = { mode: "local", issuer: LOCAL_ISSUER, audience: DEFAULT_AUDIENCE, jwksUrl };
  const router = new Router({ log: () => {} });
  for (const route of sessionRoutes({
    config,
    verifier: new TokenVerifier(config, new JwksClient({ url: jwksUrl })),
    identity: new IdentityRepository(db),
    localIssuer: issuer,
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

interface Answer {
  status: number;
  json: {
    workspace?: { id?: string; name?: string };
    role?: string;
    workspaces?: { id: string; name: string; role: string; kind: string }[];
    error?: { message?: string };
  } | null;
}

async function post(base: string, path: string, token?: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: Answer["json"] = null;
  try {
    json = JSON.parse(text) as Answer["json"];
  } catch {
    /* the assertion is about the status */
  }
  return { status: res.status, json };
}

async function suite(driver: string, db: Db): Promise<void> {
  console.log(`\n${driver}`);
  const label = driver.toLowerCase();
  const identity = new IdentityRepository(db);
  const sys = systemContext(newRequestId());
  const { base, close } = await serve(db);

  try {
    // THE EXTERNAL ID IS THE ISSUER'S, not a synthetic one, and that is a fixture decision this
    // suite paid for: provisioned with `if-ada-<driver>` and then signed in with a token the local
    // issuer minted, Ada is TWO identities claiming one verified address — which is exactly what
    // `IdentityConflictError` exists for, and which surfaced here as a 500 from
    // `/v1/invites/accept` because only `/v1/auth/session` was converting it. The route is fixed;
    // the fixture is now the shape a person actually has, so the assertions below are about
    // invitations rather than about a conflict.
    const adaEmail = `if-ada-${label}@example.com`;
    const adaToken = issuer.mint({ email: adaEmail }).token;
    const adaSession = await post(base, "/v1/auth/session", adaToken);
    check(adaSession.status === 200, `the owner signs in through the issuer (${adaSession.status})`);
    const ada = { user: (await identity.userByEmail(sys, adaEmail))! };
    const team = await identity.createWorkspace(sys, { name: `if team ${label}`, ownerUserId: ada.user.id });
    const owner: TenantContext = {
      ...systemContextFor(team.id, newRequestId()),
      role: "owner",
      actorUserId: ada.user.id,
    };

    // §12.2's golden path, from the invitee's side.
    console.log("  · an addressed invitation, redeemed by an account that does not exist yet");
    {
      const invitee = `if-bob-${label}@example.com`;
      const made = await identity.createInvite(owner, { email: invitee, role: "member" });
      check("token" in made, "an owner mints one");
      if (!("token" in made)) return;

      // NO `POST /v1/auth/session` FIRST, and that is the assertion rather than a shortcut. §12.2:
      // "If they don't have a Jaroku account: they sign in (OIDC), the invite is redeemed as part
      // of session creation, and they land in the team workspace." The route provisions on the way
      // past, so an invitee whose very first request to this server is the redemption still ends up
      // with an account, a personal workspace AND the membership.
      const token = issuer.mint({ email: invitee }).token;
      const accepted = await post(base, "/v1/invites/accept", token, { token: made.token });
      check(accepted.status === 200, `a brand-new account redeems it over HTTP (${accepted.status})`);
      check(accepted.json?.workspace?.id === team.id, "...joining the workspace the invite named");
      check(accepted.json?.role === "member", "...at the role it was sent for");

      // THE LIST IS WHAT THE SWITCHER RENDERS. §4.1.2 has the workspace appear in the switcher and
      // be auto-selected the moment this resolves, which is only possible if the answer carries it
      // — a bare `{ ok: true }` would leave the client with a membership it cannot see until the
      // next reconnect, and `switchWorkspace` refuses a target it has no membership for.
      const listed = accepted.json?.workspaces ?? [];
      check(listed.some((w) => w.id === team.id && w.role === "member"), "...and the answer carries the full membership list");
      check(
        listed.some((w) => w.kind === "personal"),
        "...including the personal workspace the redemption provisioned on the way past",
      );

      const twice = await post(base, "/v1/invites/accept", token, { token: made.token });
      check(twice.status === 403, `it is one-shot over HTTP too (${twice.status})`);
    }

    console.log("  · revoked");
    {
      const invitee = `if-cat-${label}@example.com`;
      const made = await identity.createInvite(owner, { email: invitee, role: "admin" });
      if (!("token" in made)) return check(false, "could not mint one to revoke");
      check(await identity.revokeInvite(owner, made.invite.id), "an owner takes it back");
      const token = issuer.mint({ email: invitee }).token;
      const dead = await post(base, "/v1/invites/accept", token, { token: made.token });
      check(dead.status === 403, `a revoked link joins nothing (${dead.status})`);
      const members = await identity.listMembers(owner);
      check(!members.some((m) => m.email === invitee), "...and they are not a member");
    }

    console.log("  · expired");
    {
      const invitee = `if-dan-${label}@example.com`;
      // A NEGATIVE TTL RATHER THAN A SLEEP. §14.1 offers "wait for expiry (or mock the clock)";
      // `createInvite` computes `expires_at` from `ttlHours`, so a negative one produces a row that
      // is already past — which is the same row a week-old invitation becomes, without the week.
      const made = await identity.createInvite(owner, { email: invitee, role: "member", ttlHours: -1 });
      if (!("token" in made)) return check(false, "could not mint an expired one");
      const token = issuer.mint({ email: invitee }).token;
      const dead = await post(base, "/v1/invites/accept", token, { token: made.token });
      check(dead.status === 403, `an expired link joins nothing (${dead.status})`);
      check(
        !(await identity.listMembers(owner)).some((m) => m.email === invitee),
        "...and they are not a member",
      );
    }

    console.log("  · addressed to somebody else");
    {
      const made = await identity.createInvite(owner, { email: `if-eve-${label}@example.com`, role: "member" });
      if (!("token" in made)) return check(false, "could not mint one to misdirect");
      // THE ONE REFUSAL THAT SAYS WHAT HAPPENED, and the reason it is different from the three
      // above: somebody signed in with the wrong account can fix it, and "invalid link" would send
      // them hunting for a problem with the link.
      const wrong = issuer.mint({ email: `if-frank-${label}@example.com` }).token;
      const refused = await post(base, "/v1/invites/accept", wrong, { token: made.token });
      check(refused.status === 403, `an addressed invitation refuses another account (${refused.status})`);
      check(
        /if-eve-/.test(refused.json?.error?.message ?? ""),
        "...naming the address it WAS sent to, which is the half somebody can act on",
      );
    }

    // §13.4. The credential this release added, and the only one whose proof is the secret alone.
    console.log("  · a link addressed to nobody");
    {
      const made = await identity.createInvite(owner, { role: "member" });
      check("token" in made, "an owner mints one with no address at all");
      if (!("token" in made)) return;
      check(made.invite.email === null, "...and the row says NULL rather than an empty string");

      // AN ACCOUNT NAMED NOWHERE NEAR IT. That is the whole of what a link invitation is, and it
      // is also the assertion that would fail if the address check were merely bypassed for an
      // empty string rather than skipped for a null one — `"" !== "if-gina@…"` refuses.
      const stranger = issuer.mint({ email: `if-gina-${label}@example.com` }).token;
      const joined = await post(base, "/v1/invites/accept", stranger, { token: made.token });
      check(joined.status === 200, `whoever holds it can redeem it (${joined.status})`);
      check(joined.json?.role === "member", "...at the role the link was made for, not one they chose");

      // STILL ONE-SHOT. The thing a link gives up is WHO may redeem it, and nothing else — an
      // invitation that could be reused would be a permanent door rather than an invitation.
      const second = issuer.mint({ email: `if-hank-${label}@example.com` }).token;
      const late = await post(base, "/v1/invites/accept", second, { token: made.token });
      check(late.status === 403, `and the second person to try is refused (${late.status})`);
    }

    console.log("  · a member opening a link they do not need");
    {
      const made = await identity.createInvite(owner, { role: "member" });
      if (!("token" in made)) return check(false, "could not mint one for the owner to click");
      // The demotion §13.4 opened the door to: `insertMemberIn` upserts the role, so an owner
      // opening a `member` link would stop being the owner. Refused WITHOUT consuming, so the link
      // is still there for whoever it was shared with.
      const refused = await post(base, "/v1/invites/accept", adaToken, { token: made.token });
      check(refused.status === 403, `the owner clicking their own link is refused (${refused.status})`);
      check(
        (await identity.listMembers(owner)).find((m) => m.user_id === ada.user.id)?.role === "owner",
        "...and is still the owner they were",
      );
      const stranger = issuer.mint({ email: `if-iris-${label}@example.com` }).token;
      const joined = await post(base, "/v1/invites/accept", stranger, { token: made.token });
      check(joined.status === 200, "...and the link still works for the person it was for");
    }

    console.log("  · what cannot be redeemed at all");
    {
      const token = issuer.mint({ email: `if-jo-${label}@example.com` }).token;
      const forged = await post(base, "/v1/invites/accept", token, { token: `${team.id}.${"a".repeat(43)}` });
      check(forged.status === 403, `a made-up secret against a real workspace (${forged.status})`);
      const shapeless = await post(base, "/v1/invites/accept", token, { token: "no-dot-here" });
      check(shapeless.status === 403, `a token with no workspace id (${shapeless.status})`);
      const nothing = await post(base, "/v1/invites/accept", token, {});
      check(nothing.status >= 400, `no token at all (${nothing.status})`);
      // AND WITHOUT A CREDENTIAL, which is the one that must not be a 403: there is nobody to
      // refuse yet. A 401 is what tells a client to sign in rather than to give up on the link.
      const anonymous = await post(base, "/v1/invites/accept", undefined, { token: `${team.id}.${"a".repeat(43)}` });
      check(anonymous.status === 401, `an unauthenticated redemption is a 401, not a 403 (${anonymous.status})`);
    }
  } finally {
    await close();
  }
}

const tmp = mkdtempSync(join(tmpdir(), "jaroku-inviteflow-db-"));
{
  const db = new SqliteDb(join(tmp, "inviteFlow.db"));
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

jwksHttp.close();
rmSync(keyDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

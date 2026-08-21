// §7's last three routes, and §5.3's resume, driven as routes.
//
// THE INTERESTING PROPERTY IS THAT THE STEP ONLY EVER MOVES FORWARD, and it is a property of the
// STATEMENT rather than of the handler: `advanceOnboarding` carries `onboarding_step < ?` in its
// WHERE clause, so a stale request from a second tab, a double-click, or two calls that arrive out
// of order cannot walk somebody back to a screen they have already finished. That cannot be checked
// by calling the handler once; it needs the requests actually racing.
//
// AND §5.4'S PROMISE IS ASSERTED AS AN ABSENCE. "Your workspace and settings won't change." So the
// restart is run against an account that HAS a renamed workspace and a completed flow, and what the
// suite checks afterwards is that the workspace still has its name — a restart that cascaded would
// pass every assertion about the flag and quietly destroy the thing the promise was about.
//
//   npm run test:onboarding

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository, ONBOARDING_STEPS } from "../db/repositories/identity.ts";
import { systemContext, newRequestId } from "../db/tenant.ts";
import { Router } from "../http/router.ts";
import { LocalIssuer } from "./localIssuer.ts";
import { TokenVerifier } from "./verifier.ts";
import { DEFAULT_AUDIENCE, LOCAL_ISSUER } from "./config.ts";
import { sessionRoutes } from "./session.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const identity = new IdentityRepository(db);

const keyDir = mkdtempSync(join(tmpdir(), "jaroku-onboarding-"));
const issuer = new LocalIssuer(join(keyDir, "devauth.json"), DEFAULT_AUDIENCE, () => {});

const jwksServer: Server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issuer.jwks()));
});
await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
const jwksPort = (jwksServer.address() as { port: number }).port;

const authConfig = {
  mode: "local",
  issuer: LOCAL_ISSUER,
  audience: DEFAULT_AUDIENCE,
  jwksUrl: `http://127.0.0.1:${jwksPort}/`,
} as const;
const verifier = new TokenVerifier(authConfig);

const router = new Router({ log: () => {} });
for (const route of sessionRoutes({ config: authConfig, verifier, identity, localIssuer: issuer, log: () => {} })) {
  if (route.method === "GET") router.get(route.path, route.handler);
  else if (route.method === "PATCH") router.patch(route.path, route.handler);
  else router.post(route.path, route.handler);
}

const server: Server = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const email = `ada-${randomUUID()}@example.com`;
const sys = (): ReturnType<typeof systemContext> => systemContext(newRequestId());
const provisioned = await identity.provisionUser(sys(), {
  externalId: `email|${email}`,
  email,
  displayName: "Ada Lovelace",
  authProvider: "magic_link",
});
const token = issuer.mint({ subject: `email|${email}`, email, displayName: "Ada Lovelace" }).token;

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function post(path: string, payload: unknown = {}, bearer: string | null = token): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const stepNow = async (): Promise<number> => (await identity.userById(sys(), provisioned.user.id))!.onboarding_step;
const onboardedNow = async (): Promise<boolean> =>
  (await identity.userById(sys(), provisioned.user.id))!.onboarded_at !== null;

console.log("\nwhere a new account starts");
{
  check(provisioned.user.onboarding_step === 1, "a fresh account is at step one");
  check(provisioned.user.onboarded_at === null, "...and has not onboarded");
  // The gap between this and `onboarded_at` is the only thing that can say where people give up,
  // and it is null until they actually start rather than being stamped at sign-up: an account
  // created and never returned to has not started anything.
  check(provisioned.user.onboarding_started_at === null, "...and has not started, which is a different fact from step one");
}

console.log("\nadvancing");
{
  const two = await post("/v1/users/me/onboarding/step", { step: 2 });
  check(two.status === 200 && two.body.step === 2, "a step advances");
  check((await stepNow()) === 2, "...and is written down");
  const user = await identity.userById(sys(), provisioned.user.id);
  check(user!.onboarding_started_at !== null, "the first advance stamps when they started");

  const stamped = user!.onboarding_started_at;
  await post("/v1/users/me/onboarding/step", { step: 3 });
  const later = await identity.userById(sys(), provisioned.user.id);
  // Stamped once and never again. It records when this person first started setting up, which a
  // second step does not change.
  check(later!.onboarding_started_at === stamped, "...and a later advance does not re-stamp it");
}
{
  // MONOTONIC, which is the whole of the concurrency handling. A stale request from a second tab, a
  // double-click, or two calls arriving out of order must not walk somebody back to a screen they
  // have already finished.
  const back = await post("/v1/users/me/onboarding/step", { step: 1 });
  check(back.status === 200, "a stale step is not an error");
  check(back.body.step === 3, "...and answers with where they actually are");
  check((await stepNow()) === 3, "...having moved nothing");

  const same = await post("/v1/users/me/onboarding/step", { step: 3 });
  check(same.body.step === 3, "advancing to the step they are already on is idempotent");
}
{
  // Two tabs, both pressing Continue on step 3, at the same moment.
  await post("/v1/users/me/onboarding/step", { step: 4 });
  const racing = await Promise.all([
    post("/v1/users/me/onboarding/step", { step: 5 }),
    post("/v1/users/me/onboarding/step", { step: 5 }),
    post("/v1/users/me/onboarding/step", { step: 3 }),
  ]);
  check(racing.every((r) => r.status === 200), "three simultaneous advances all answer 200");
  check((await stepNow()) === 5, "...and the furthest one wins, never the last to arrive");
}
{
  // BOUNDED AGAINST THE NUMBER OF SCREENS THAT EXIST. A client that could send 9 would put a row
  // into a state no screen renders, and the person would meet a blank onboarding on their next
  // sign-in with no way out of it.
  check((await post("/v1/users/me/onboarding/step", { step: ONBOARDING_STEPS + 1 })).status === 400, "a step past the last is refused");
  check((await post("/v1/users/me/onboarding/step", { step: 0 })).status === 400, "...and a step below the first");
  check((await post("/v1/users/me/onboarding/step", { step: -1 })).status === 400, "...and a negative one");
  check((await post("/v1/users/me/onboarding/step", { step: "3" })).status === 400, "...and one that is not a number");
  check((await post("/v1/users/me/onboarding/step", {})).status === 400, "...and none at all");
  check((await post("/v1/users/me/onboarding/step", { step: 2 }, null)).status === 401, "and an unauthenticated advance is refused");
}

console.log("\nfinishing");
{
  const done = await post("/v1/users/me/onboarding/complete");
  check(done.status === 200 && done.body.onboarded === true, "completing marks the account onboarded");
  check(await onboardedNow(), "...in the database");
  // The step goes to the last one in the same statement. A row with `onboarded_at` set and
  // `onboarding_step = 2` would describe two different states, and §5.4's restart reads the step.
  check((await stepNow()) === ONBOARDING_STEPS, "...and the step is the last one, so the row describes one state");

  const again = await post("/v1/users/me/onboarding/complete");
  check(again.status === 200, "completing twice is idempotent");
}
{
  // A FINISHED ONBOARDING DOES NOT MOVE. Somebody who has finished and whose old tab fires a stale
  // step must not be walked back into the flow — the flag is the gate, and a step that could move
  // underneath it would be a second, disagreeing answer.
  await post("/v1/users/me/onboarding/step", { step: 2 });
  check((await stepNow()) === ONBOARDING_STEPS, "a stale step against a completed account changes nothing");
  check(await onboardedNow(), "...and certainly does not un-complete it");
}

console.log("\nrestarting, and what it must not touch");
{
  // §5.4's promise is about what STAYS. So the account gets a renamed workspace first, and the
  // assertion afterwards is that it still has its name — a restart that cascaded would pass every
  // assertion about the flag and quietly destroy the thing the promise was about.
  const memberships = await identity.workspacesForUser(sys(), provisioned.user.id);
  const workspace = memberships[0]!;
  const ctx = { workspaceId: workspace.id, actorUserId: provisioned.user.id, role: "owner" as const, requestId: newRequestId() };
  await identity.renameWorkspace(ctx, "Ada's workspace");

  const restarted = await post("/v1/users/me/onboarding/restart");
  check(restarted.status === 200, "restarting is accepted");
  check(restarted.body.onboarded === false && restarted.body.step === 1, "...and answers with the state it produced");
  check(!(await onboardedNow()), "the completion flag is cleared");
  check((await stepNow()) === 1, "...and the step is back at one");

  const after = await identity.workspaceById(ctx, workspace.id);
  check(after?.name === "Ada's workspace", "THE WORKSPACE KEEPS ITS NAME — §5.4's whole promise");
  check(after?.slug === workspace.slug, "...and its slug, which is in URLs");

  const user = await identity.userById(sys(), provisioned.user.id);
  // It records when this person FIRST started setting up, which a second walk-through does not
  // change — a funnel that reset it would count one person as two.
  check(user!.onboarding_started_at !== null, "and when they first started is not un-recorded");
  check(user!.display_name === "Ada Lovelace", "...and their name is untouched");

  const audited = await db.all<{ action: string }>(
    `SELECT action FROM audit_log WHERE action = 'user.onboarding_restarted'`,
    [],
  );
  // Audited, unlike the step advance beside it: a step moving is somebody pressing Continue, and a
  // restart puts an account back into a flow it had finished.
  check(audited.length === 1, "a restart is audited");

  check((await post("/v1/users/me/onboarding/restart", {}, null)).status === 401, "an unauthenticated restart is refused");
}

console.log("\nresuming, which is what the whole column is for");
{
  // §5.3: "User closes app mid-onboarding at step 3 → onboarding_step = 3, onboarding_completed_at
  // = NULL. User signs in next time → account onboarding shows, starts at step 3, not step 1."
  await post("/v1/users/me/onboarding/step", { step: 3 });
  const session = await post("/v1/auth/session");
  check(session.status === 200, "a fresh session lands");
  check(session.body.user?.onboarded === false, "...saying they have not onboarded");
  check(session.body.user?.onboardingStep === 3, "...and WHERE THEY WERE, which is what resume reads");

  // §9.3's distinction, made structurally: a SKIP advances the step because the person decided; an
  // INTERRUPTION never reaches the route at all, so the step stays and resume shows the same screen.
  const interrupted = await post("/v1/auth/session");
  check(interrupted.body.user?.onboardingStep === 3, "an interruption resumes at the SAME step, having advanced nothing");
}

server.close();
jwksServer.close();
await db.close();
rmSync(keyDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

// `PATCH /v1/users/me` — the two things a person may change about themselves.
//
// MOST OF THIS SUITE IS ABOUT WHAT IS **ACCEPTED**, which is the opposite of how a validation suite
// usually reads and is the point. §3.4 says "emoji allowed (people put them in their display
// names)", and the instinct to sanitise a display name is the instinct that rejects "أحمد", "李伟",
// "Ada 🏳️‍🌈" and "O'Brien" — four real names, one of which is a flag sequence six code points long.
// A name field that refuses a person's name is a product that has told them they do not exist.
//
// SO THE REFUSALS ARE DELIBERATELY FEW: too long, empty, and control characters. Zero-width
// characters are asserted to be ACCEPTED, because U+200D is load-bearing in emoji sequences and
// U+200C in several scripts — refusing them would be refusing names while looking like hygiene.
//
// AND THE AUDIT ROW IS ASSERTED NOT TO CONTAIN THE NAME. A display name is personal data and an
// audit row outlives what it describes; "the name changed" is what an investigation needs, and
// "the name changed to X" is a copy of somebody's name in a table nothing sweeps.
//
//   npm run test:profile

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { systemContext, newRequestId } from "../db/tenant.ts";
import { Router } from "../http/router.ts";
import { LocalIssuer } from "./localIssuer.ts";
import { TokenVerifier } from "./verifier.ts";
import { DEFAULT_AUDIENCE, LOCAL_ISSUER } from "./config.ts";
import { DISPLAY_NAME_MAX, sessionRoutes } from "./session.ts";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const keyDir = mkdtempSync(join(tmpdir(), "jaroku-profile-"));
const issuer = new LocalIssuer(join(keyDir, "devauth.json"), DEFAULT_AUDIENCE, () => {});

// A real verifier against the local issuer's own JWKS, so the token below goes through the same
// path a provider's would — the whole point of `auth/config.ts`'s local-issuer design.
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
for (const route of sessionRoutes({
  config: authConfig,
  verifier,
  identity,
  localIssuer: issuer,
  log: () => {},
})) {
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

// A magic-link account, provisioned exactly as `index.ts` does it: no display name at all, which is
// §3.4's trigger.
const email = `ada-${randomUUID()}@example.com`;
const sys = systemContext(newRequestId());
const provisioned = await identity.provisionUser(sys, {
  externalId: `email|${email}`,
  email,
  displayName: null,
  authProvider: "magic_link",
});
const token = issuer.mint({ subject: `email|${email}`, email, displayName: null }).token;

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function patch(payload: unknown, bearer: string | null = token): Promise<Answer> {
  const res = await fetch(`${base}/v1/users/me`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

console.log("\nthe state this screen exists for");
{
  check(provisioned.user.display_name === null, "a magic-link account starts with no name, which is §3.4's trigger");
  check(provisioned.user.email_verified === true, "...and a verified address, because a link is a delivery receipt");
  check(provisioned.user.auth_provider === "magic_link", "...and a record of how they got in");
  check(provisioned.user.marketing_emails_opt_in === false, "...and the marketing box unchecked, which is opt-IN");
  check(provisioned.user.onboarding_step === 1, "...and account onboarding at step one");
}

console.log("\nnames this refuses to reject");
{
  // EVERY ONE OF THESE IS SOMEBODY'S ACTUAL NAME. A field that refuses them is a product telling
  // that person they do not exist, which is a considerably worse outcome than any of the things a
  // sanitiser is protecting against.
  const real = [
    ["Ada Lovelace", "an ordinary name"],
    ["O'Brien", "an apostrophe"],
    ["Anne-Marie", "a hyphen"],
    ["李伟", "a name in Han characters"],
    ["أحمد", "a name in Arabic script"],
    ["Ævar Arnfjörð", "a name with diacritics and an eth"],
    ["Ada 🌸", "a name with an emoji in it, which §3.4 says out loud is allowed"],
    ["Ada \u200d🏳️", "a zero-width joiner, which is load-bearing in emoji sequences"],
    ["  Ada  ", "surrounding whitespace, which is trimmed rather than refused"],
    ["Ada", "a very short one"],
    ["a".repeat(DISPLAY_NAME_MAX), `exactly ${DISPLAY_NAME_MAX} characters, which is the boundary`],
  ] as const;
  for (const [name, why] of real) {
    const answer = await patch({ name });
    check(answer.status === 200, `${why} is accepted`);
  }
  const trimmed = await patch({ name: "  Grace Hopper  " });
  check(trimmed.body.user?.displayName === "Grace Hopper", "...and what comes back is trimmed, not what was sent");
}

console.log("\nand the few it does");
{
  check((await patch({ name: "" })).status === 400, "an empty name is refused");
  check((await patch({ name: "   " })).status === 400, "...and one that is only whitespace");
  check((await patch({ name: "a".repeat(DISPLAY_NAME_MAX + 1) })).status === 400, `...and one over ${DISPLAY_NAME_MAX} characters`);
  check((await patch({ name: 42 })).status === 400, "...and one that is not a string");
  // A newline in a display name is not a name — it is somebody trying to break a log line, a CSV
  // export or a terminal, and none of the three is a thing a person types on purpose.
  check((await patch({ name: "Ada\nLovelace" })).status === 400, "a newline is refused");
  check((await patch({ name: "Ada\u0000" })).status === 400, "...and a NUL");
  check((await patch({ name: "Ada\u001b[31m" })).status === 400, "...and an ANSI escape, which a terminal would obey");
}

console.log("\nthe one checkbox");
{
  const on = await patch({ marketingEmailsOptIn: true });
  check(on.status === 200 && on.body.user?.marketingEmailsOptIn === true, "the opt-in can be turned on");
  const off = await patch({ marketingEmailsOptIn: false });
  check(off.status === 200 && off.body.user?.marketingEmailsOptIn === false, "...and off again");

  // STRICTLY A BOOLEAN. This decides whether somebody receives marketing email, and reading
  // `"false"` as true is the shape of consent bug that ends in a complaint to a regulator.
  check((await patch({ marketingEmailsOptIn: "true" })).status === 400, "a string is not a boolean here");
  check((await patch({ marketingEmailsOptIn: 1 })).status === 400, "...and neither is a 1");
}

console.log("\nwhat a PATCH means");
{
  await patch({ name: "Ada Lovelace", marketingEmailsOptIn: true });
  // THE WHOLE REASON THIS IS A PATCH. A settings screen that changes only the marketing preference
  // must not clear a display name by omitting it.
  const only = await patch({ marketingEmailsOptIn: false });
  check(only.body.user?.displayName === "Ada Lovelace", "changing one field leaves the other alone");
  check(only.body.user?.marketingEmailsOptIn === false, "...while changing the one that was named");

  const nothing = await patch({});
  check(nothing.status === 400, "a patch with nothing in it is refused rather than being a no-op 200");
}

console.log("\nwho may change what");
{
  check((await patch({ name: "Nobody" }, null)).status === 401, "an unauthenticated request is refused");
  check((await patch({ name: "Nobody" }, "not-a-token")).status === 401, "...and one carrying rubbish");

  // THERE IS NO USER ID IN THE BODY AND THERE IS NOWHERE TO PUT ONE. Sending one changes nothing,
  // because the only account this route can touch is the one behind the token — which is why there
  // is nothing here to forge.
  const other = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `email|other-${randomUUID()}@example.com`,
    email: `other-${randomUUID()}@example.com`,
    displayName: "Somebody Else",
    authProvider: "magic_link",
  });
  const forged = await patch({ name: "Hijacked", userId: other.user.id, id: other.user.id });
  check(forged.status === 200, "a request carrying somebody else's id is not an error");
  check(forged.body.user?.id === provisioned.user.id, "...it simply changes the CALLER, because there is no id to honour");
  const untouched = await identity.userById(systemContext(newRequestId()), other.user.id);
  check(untouched?.display_name === "Somebody Else", "...and the other account is untouched");
}

console.log("\nwhat the audit row keeps");
{
  await patch({ name: "Ada Lovelace" });
  const rows = await db.all<{ action: string; metadata: string }>(
    `SELECT action, metadata FROM audit_log WHERE action = 'user.profile_updated'`,
    [],
  );
  check(rows.length > 0, "a profile change is audited");
  const metadata = rows.map((r) => r.metadata).join("|");
  check(metadata.includes("fields"), "...naming which fields moved");
  // A display name is personal data and an audit row outlives what it describes. "The name changed"
  // is what an investigation needs; "the name changed to X" is a copy of somebody's name in a table
  // nothing sweeps.
  check(!metadata.includes("Ada Lovelace"), "...and NEVER the value, which is personal data in a table nothing sweeps");
  check(!metadata.includes(email), "...nor the address");
}

server.close();
jwksServer.close();
await db.close();
rmSync(keyDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

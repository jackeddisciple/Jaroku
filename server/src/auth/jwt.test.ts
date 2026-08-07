// Token verification, against a fixture issuer that can misbehave on purpose.
//
// A real provider will never hand this server an `alg: "none"` token, a token signed with the
// public key, or one issued for somebody else's audience. An attacker will try all three
// before breakfast. So the fixture issuer here is deliberately capable of producing things a
// well-behaved issuer never would — the same reasoning that made the mock MCP server raw
// JSON-RPC rather than the SDK.
//
// Every FAIL in this file is somebody signing in as somebody else.
//
//   npm run test:jwt

import { createServer } from "node:http";
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JwksClient } from "./jwks.ts";
import { JwtError, readUnverifiedHeader, verifyJwt } from "./jwt.ts";
import { TokenVerifier, AuthError } from "./verifier.ts";
import { LocalIssuer, subjectFor } from "./localIssuer.ts";
import { resolveAuthConfig, AuthConfigError, LOCAL_ISSUER, DEFAULT_AUDIENCE } from "./config.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const ISSUER = "https://fixture.example";
const AUDIENCE = "jaroku";
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

// --- a fixture issuer, with the ability to lie ---------------------------------------------

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaKid = "fixture-rsa";
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecKid = "fixture-ec";
/** A second RSA pair the issuer does NOT publish: the "signed by someone else" case. */
const impostor = generateKeyPairSync("rsa", { modulusLength: 2048 });

const jwksDoc = {
  keys: [
    { ...(rsa.publicKey.export({ format: "jwk" }) as object), kid: rsaKid, alg: "RS256", use: "sig" },
    { ...(ec.publicKey.export({ format: "jwk" }) as object), kid: ecKid, alg: "ES256", use: "sig" },
  ],
};

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jwksDoc));
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const jwksUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/jwks.json`;

interface MintOpts {
  alg?: string;
  kid?: string;
  key?: import("node:crypto").KeyObject;
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
}

/** Mint a token, including ones no honest issuer would. */
function mint(opts: MintOpts = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const alg = opts.alg ?? "RS256";
  const header = { alg, typ: "JWT", kid: opts.kid ?? (alg === "ES256" ? ecKid : rsaKid), ...opts.header };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user_abc",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada",
    iat: now,
    exp: now + 3600,
    ...opts.claims,
  };
  const signing = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  if (alg === "none") return `${signing}.`;
  const key = opts.key ?? (alg === "ES256" ? ec.privateKey : rsa.privateKey);
  const sig =
    alg === "ES256"
      ? cryptoSign("sha256", Buffer.from(signing, "ascii"), { key, dsaEncoding: "ieee-p1363" })
      : cryptoSign("sha256", Buffer.from(signing, "ascii"), key);
  return `${signing}.${sig.toString("base64url")}`;
}

const config = { mode: "provider" as const, issuer: ISSUER, audience: AUDIENCE, jwksUrl };
const verifier = new TokenVerifier(config, new JwksClient({ url: jwksUrl }));

const refuses = async (token: string, msg: string, kind: AuthError["kind"] = "unauthenticated"): Promise<void> => {
  const err = await verifier.verify(token).then(() => null).catch((e) => e as AuthError);
  check(err instanceof AuthError && err.kind === kind, `${msg}${err ? "" : " (IT WAS ACCEPTED)"}`);
};

console.log("\nthe happy path");
{
  const ctx = await verifier.verify(mint());
  check(ctx.subject === "user_abc", "a well-formed RS256 token verifies and yields its subject");
  check(ctx.email === "ada@example.com", "...its verified email");
  check(ctx.displayName === "Ada", "...and its display name");
  check(ctx.expiresAt > Math.floor(Date.now() / 1000), "...with the expiry the session timer watches");

  const es = await verifier.verify(mint({ alg: "ES256" }));
  check(es.subject === "user_abc", "an ES256 token verifies too — raw r||s, not DER");

  const unverifiedEmail = await verifier.verify(mint({ claims: { email_verified: false } }));
  check(
    unverifiedEmail.email === null,
    "an UNVERIFIED email is dropped — it becomes a user row and a workspace name, and it is not an identity claim",
  );
}

console.log("\nsignature");
{
  await refuses(mint({ alg: "none" }), 'alg "none" is refused — an unsigned token is not a signed one');

  // Algorithm confusion: the header says HMAC, and the "key" a naive verifier reaches for is
  // the issuer's PUBLIC key, which everybody has.
  const hs = (() => {
    const header = { alg: "HS256", typ: "JWT", kid: rsaKid };
    const pub = rsa.publicKey.export({ type: "spki", format: "pem" }) as string;
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: ISSUER, aud: AUDIENCE, sub: "attacker", exp: now + 3600 };
    const signing = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    const mac = createHmac("sha256", pub).update(signing).digest("base64url");
    return `${signing}.${mac}`;
  })();
  await refuses(hs, "HS256 is refused outright — there is no branch that verifies with a shared secret");

  await refuses(mint({ key: impostor.privateKey }), "a token signed by a key the issuer does not publish is refused");
  await refuses(mint({ kid: "no-such-key" }), "a token naming a kid the issuer has never published is refused");

  const tampered = (() => {
    const t = mint();
    const [h, p, s] = t.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    payload.sub = "somebody_else";
    return `${h}.${b64(JSON.stringify(payload))}.${s}`;
  })();
  await refuses(tampered, "a payload edited after signing is refused");

  await refuses(mint().split(".").slice(0, 2).join("."), "a two-part token is refused");
  await refuses(`${mint()}!!!`, "a signature that is not base64url is refused, not leniently decoded");
  await refuses("", "an empty string is refused");
  await refuses("x".repeat(9000), "an implausibly large token is refused before it is parsed");
}

console.log("\nclaims");
{
  const now = Math.floor(Date.now() / 1000);
  await refuses(mint({ claims: { iss: "https://evil.example" } }), "a token from another issuer is refused");
  await refuses(
    mint({ claims: { iss: `${ISSUER}.evil.example` } }),
    "...including one whose issuer merely STARTS with the right string",
  );
  await refuses(mint({ claims: { aud: "someone-else" } }), "a token for another audience is refused");
  await refuses(mint({ claims: { aud: ["a", "b"] } }), "...and an audience array that does not contain ours");

  const multi = await verifier.verify(mint({ claims: { aud: ["other", AUDIENCE] } }));
  check(multi.subject === "user_abc", "...while an array that DOES contain ours is accepted");

  await refuses(mint({ claims: { exp: now - 3600 } }), "an expired token is refused", "unauthenticated");
  await refuses(mint({ claims: { exp: undefined } }), "a token with NO expiry is refused — that is a permanent credential");
  await refuses(mint({ claims: { nbf: now + 3600 } }), "a token that is not valid yet is refused");
  await refuses(mint({ claims: { iat: now + 86_400 } }), "a token issued a day in the future is refused");
  await refuses(mint({ claims: { sub: "" } }), "a token with an empty subject is refused");
  await refuses(mint({ claims: { sub: undefined } }), "a token with no subject is refused");
  await refuses(mint({ claims: { sub: "x".repeat(300) } }), "a subject too long for the column is refused");

  // Sixty seconds of skew: two machines' clocks disagreeing must not sign people out.
  const justExpired = await verifier.verify(mint({ claims: { exp: now - 10 } }));
  check(justExpired.subject === "user_abc", "a token ten seconds past expiry is accepted — clocks disagree");
}

console.log("\nheaders");
{
  await refuses(mint({ header: { kid: undefined } }), "a token with no kid is refused");
  await refuses(mint({ header: { typ: "not-a-jwt" } }), "an unexpected typ is refused");
  const readable = readUnverifiedHeader(mint());
  check(readable.kid === rsaKid && readable.alg === "RS256", "the unverified header reader returns kid and alg");
  let threw = false;
  try {
    readUnverifiedHeader("aGk.aGk.aGk");
  } catch (e) {
    threw = e instanceof JwtError;
  }
  check(threw, "...and refuses a header that is not JSON");
}

console.log("\nthe issuer being unreachable is not the user's fault");
{
  const down = new TokenVerifier(config, new JwksClient({ url: "http://127.0.0.1:1/jwks.json", timeoutMs: 200 }));
  const err = await down.verify(mint()).then(() => null).catch((e) => e as AuthError);
  check(
    err instanceof AuthError && err.kind === "unavailable",
    "a JWKS endpoint that is down is 'unavailable', not 'unauthenticated' — a 401 here would sign everyone out",
  );
}

console.log("\nbearer parsing");
{
  check(TokenVerifier.bearer("Bearer abc") === "abc", "Bearer <token> is parsed");
  check(TokenVerifier.bearer("bearer abc") === "abc", "...case-insensitively, as RFC 6750 requires");
  check(TokenVerifier.bearer("Basic abc") === null, "a Basic header yields nothing");
  check(TokenVerifier.bearer(undefined) === null, "an absent header yields nothing");
  check(TokenVerifier.bearer("Bearer a b") === null, "a header with a space in the token yields nothing");
}

console.log("\nthe local issuer verifies through the same path");
{
  const dir = mkdtempSync(join(tmpdir(), "jaroku-devauth-"));
  const keyPath = join(dir, "devauth.json");
  const issuer = new LocalIssuer(keyPath, DEFAULT_AUDIENCE, () => {});

  const jwksHttp = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issuer.jwks()));
  });
  await new Promise<void>((r) => jwksHttp.listen(0, "127.0.0.1", r));
  const localUrl = `http://127.0.0.1:${(jwksHttp.address() as AddressInfo).port}/jwks.json`;
  const localVerifier = new TokenVerifier(
    { mode: "local", issuer: LOCAL_ISSUER, audience: DEFAULT_AUDIENCE, jwksUrl: localUrl },
    new JwksClient({ url: localUrl }),
  );

  const { token } = issuer.mint({ email: "Ada@Example.com ", displayName: "Ada L" });
  const ctx = await localVerifier.verify(token);
  check(ctx.subject === subjectFor("ada@example.com"), "a locally-minted token verifies against the real verifier");
  check(ctx.email === "ada@example.com", "...with a normalised email");
  check(ctx.issuer === LOCAL_ISSUER, "...stamped with the local issuer");

  // The reason the key is persisted: a restart must not sign everybody out.
  const restarted = new LocalIssuer(keyPath, DEFAULT_AUDIENCE, () => {});
  const stillGood = await localVerifier.verify(restarted.mint({ email: "ada@example.com" }).token)
    .then(() => true)
    .catch(() => false);
  check(stillGood, "a restarted local issuer reuses its key, so a dev session survives a reload");
  check(
    subjectFor("ada@example.com") === subjectFor(" ADA@example.com "),
    "the local subject is stable for an email, so signing in twice is the same user",
  );

  // The impostor's token is signed by a key the local issuer does not publish.
  await localVerifier
    .verify(mint({ key: impostor.privateKey, claims: { iss: LOCAL_ISSUER } }))
    .then(() => check(false, "a forged local token was ACCEPTED"))
    .catch(() => check(true, "a token forged against the local issuer is still refused"));

  await new Promise<void>((r) => jwksHttp.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nconfiguration");
{
  const quiet = () => {};
  const provider = resolveAuthConfig(4317, { JAROKU_AUTH_ISSUER: "https://x.clerk.accounts.dev" }, quiet);
  check(provider.mode === "provider", "an issuer in the environment selects provider mode");
  check(
    provider.jwksUrl === "https://x.clerk.accounts.dev/.well-known/jwks.json",
    "...with the OIDC-conventional JWKS URL derived from it",
  );
  check(provider.audience === DEFAULT_AUDIENCE, "...and a default audience");

  const local = resolveAuthConfig(4317, {}, quiet);
  check(local.mode === "local" && local.issuer === LOCAL_ISSUER, "no issuer selects the local one");
  check(local.jwksUrl.includes("4317"), "...whose keys are served by this process, so the fetch path is real");

  let refused = false;
  try {
    resolveAuthConfig(4317, { NODE_ENV: "production" }, quiet);
  } catch (e) {
    refused = e instanceof AuthConfigError;
  }
  check(refused, "the local issuer REFUSES to run under NODE_ENV=production");

  let httpRefused = false;
  try {
    resolveAuthConfig(4317, { NODE_ENV: "production", JAROKU_AUTH_ISSUER: "http://insecure.example" }, quiet);
  } catch (e) {
    httpRefused = e instanceof AuthConfigError;
  }
  check(httpRefused, "...and a plain-http issuer is refused there too");
}

await new Promise<void>((r) => http.close(() => r()));

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

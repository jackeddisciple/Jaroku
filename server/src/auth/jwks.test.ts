// The JWKS cache, and the ways it has to refuse.
//
// Every assertion here is about a behaviour that is invisible when it is wrong: a cache that
// silently never refreshes still works until the day the provider rotates; a forced refresh
// with no leash still works until somebody sends a thousand tokens with random `kid`s; an
// `oct` key that gets imported still works until somebody notices they can sign their own.
//
//   npm run test:jwks

import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { JwksClient, JwksError } from "./jwks.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

/** An RSA key pair, published as a JWK the way an issuer would. */
function rsaJwk(kid: string, extra: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { jwk: { ...jwk, kid, alg: "RS256", use: "sig", ...extra }, privateKey };
}

function ecJwk(kid: string) {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid, alg: "ES256", use: "sig" };
}

// A JWKS endpoint under the test's control: what it serves, how often, and whether at all.
let served: unknown = { keys: [] };
let status = 200;
let hits = 0;
let hang = false;
const http = createServer((_req, res) => {
  hits++;
  if (hang) return; // never answers; the client's own timeout has to end it
  res.writeHead(status, { "content-type": "application/json" }).end(
    typeof served === "string" ? served : JSON.stringify(served),
  );
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/jwks.json`;

const A = rsaJwk("key-a");
const B = rsaJwk("key-b");

console.log("\nfetching and caching");
{
  served = { keys: [A.jwk] };
  hits = 0;
  const client = new JwksClient({ url });
  const k1 = await client.keyFor("key-a", "RS256");
  check(k1.type === "public", "a published key is imported as a public key");
  await client.keyFor("key-a", "RS256");
  await client.keyFor("key-a", "RS256");
  check(hits === 1, `three verifications are one fetch (${hits})`);

  // Ten simultaneous first requests must be one fetch, not ten.
  const fresh = new JwksClient({ url });
  hits = 0;
  await Promise.all(Array.from({ length: 10 }, () => fresh.keyFor("key-a", "RS256")));
  check(hits === 1, `ten concurrent lookups share one in-flight fetch (${hits})`);
}

console.log("\nexpiry and rotation");
{
  let clock = 1_000_000;
  served = { keys: [A.jwk] };
  hits = 0;
  const client = new JwksClient({ url, ttlMs: 60_000, now: () => clock });
  await client.keyFor("key-a", "RS256");
  clock += 30_000;
  await client.keyFor("key-a", "RS256");
  check(hits === 1, "a key inside its TTL is not re-fetched");
  clock += 40_000;
  await client.keyFor("key-a", "RS256");
  check(hits === 2, "...and is re-fetched once the TTL passes");

  // The rotation story: a kid that has never been seen forces a fetch off-schedule.
  served = { keys: [A.jwk, B.jwk] };
  clock += 60_000; // past minRefreshMs
  const rotated = await client.keyFor("key-b", "RS256");
  check(rotated.type === "public", "an unknown kid forces a refresh, and the new key resolves");
}

console.log("\nthe forced-refresh leash");
{
  let clock = 5_000_000;
  served = { keys: [A.jwk] };
  const client = new JwksClient({ url, ttlMs: 600_000, minRefreshMs: 30_000, now: () => clock });
  await client.keyFor("key-a", "RS256");
  hits = 0;
  // `kid` comes off an UNVERIFIED token header, so this is a remote trigger. Twenty forged
  // tokens must not be twenty requests against the auth provider.
  for (let i = 0; i < 20; i++) {
    await client.keyFor(`forged-${i}`, "RS256").catch(() => {});
  }
  check(hits === 0, `twenty unknown kids inside the window cause no fetch at all (${hits})`);
  clock += 31_000;
  await client.keyFor("forged-again", "RS256").catch(() => {});
  check(hits === 1, "...and exactly one once the window has passed, so rotation still works");
}

console.log("\nfailure");
{
  served = { keys: [A.jwk] };
  let clock = 9_000_000;
  const client = new JwksClient({ url, ttlMs: 1, negativeTtlMs: 10_000, now: () => clock });
  await client.keyFor("key-a", "RS256");

  status = 503;
  clock += 1000;
  // The keys already held are still the issuer's keys. A CDN having a bad minute must not end
  // every session at once — the same rule the MCP registry applies to a failed re-discovery.
  const stillWorks = await client.keyFor("key-a", "RS256").then(() => true).catch(() => false);
  check(stillWorks, "a failed refresh keeps the keys it already had");

  hits = 0;
  clock += 100;
  for (let i = 0; i < 5; i++) await client.keyFor("key-a", "RS256").catch(() => {});
  check(hits === 0, `a recent failure is remembered rather than retried five times (${hits})`);

  status = 200;
  const cold = new JwksClient({ url, fetchImpl: async () => new Response("nope", { status: 500 }) });
  const err = await cold.keyFor("key-a", "RS256").catch((e) => e as JwksError);
  check(err instanceof JwksError && err.kind === "unreachable", "a first fetch that fails with nothing cached is 'unreachable'");

  hang = true;
  const slow = new JwksClient({ url, timeoutMs: 150 });
  const timedOut = await slow.keyFor("key-a", "RS256").catch((e) => e as JwksError);
  check(
    timedOut instanceof JwksError && /did not answer/.test(timedOut.message),
    "a JWKS endpoint that never answers times out rather than hanging a sign-in",
  );
  hang = false;
}

console.log("\nwhat a document may not contain");
{
  const fresh = () => new JwksClient({ url, ttlMs: 1 });

  served = { keys: [{ kty: "oct", kid: "shared", k: "c2VjcmV0", alg: "HS256" }] };
  const symmetric = await fresh().keyFor("shared", "RS256").catch((e) => e as JwksError);
  check(
    symmetric instanceof JwksError,
    "a symmetric (oct) key is never imported — publishing one hands out the ability to SIGN",
  );

  served = { keys: [{ ...A.jwk, use: "enc" }] };
  const enc = await fresh().keyFor("key-a", "RS256").catch((e) => e as JwksError);
  check(enc instanceof JwksError, "a key published for encryption cannot verify a signature");

  served = { keys: [A.jwk] };
  const wrongAlg = await fresh().keyFor("key-a", "ES256").catch((e) => e as JwksError);
  check(
    wrongAlg instanceof JwksError && /RS256/.test(wrongAlg.message),
    "a token claiming ES256 cannot be verified with a key published for RS256",
  );

  served = { keys: [ecJwk("ec-1")] };
  const ecOk = await fresh().keyFor("ec-1", "ES256").then(() => true).catch(() => false);
  check(ecOk, "...while an EC key does verify ES256");
  const ecWrong = await fresh().keyFor("ec-1", "RS256").catch((e) => e as JwksError);
  check(ecWrong instanceof JwksError, "...and not RS256");

  served = { keys: [{ kty: "RSA", kid: "broken", n: "!!!not-base64!!!", e: "AQAB" }, A.jwk] };
  const survivor = await fresh().keyFor("key-a", "RS256").then(() => true).catch(() => false);
  check(survivor, "one unimportable entry does not cost the whole document");

  served = "not json at all";
  const garbage = await fresh().keyFor("key-a", "RS256").catch((e) => e as JwksError);
  check(garbage instanceof JwksError, "a response that is not JSON is a classified failure, not a crash");

  served = { keys: [] };
  const empty = await fresh().keyFor("key-a", "RS256").catch((e) => e as JwksError);
  check(empty instanceof JwksError, "a document with no usable keys is a failure, not an empty success");
}

await new Promise<void>((r) => http.close(() => r()));

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

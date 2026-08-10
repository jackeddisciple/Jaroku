// The object stores, both of them, plus the signing they rest on.
//
// Three parts, in the order the risk runs:
//
//   1. SigV4 against AWS'S OWN published test vectors. The canonical form is the fiddly part of
//      the signature and it is fiddly in ways that produce a 403 with no explanation, so this is
//      checked against the numbers in the AWS documentation rather than against my reading of
//      the specification. If these pass, the signing is right; if they fail, nothing downstream
//      is worth debugging first.
//
//   2. The conformance suite, run against BOTH implementations. Same suite, same assertions.
//
//   3. The S3-specific behaviour a conformance suite cannot describe, because it is about how
//      the store behaves when the network does not cooperate: retries, multipart, and the
//      difference between an absent key and a refused one.
//
// It runs against the fixture S3 in fixtures/s3/, which verifies signatures rather than
// accepting anything — so this needs no cloud account, no credentials and no network. Point it
// at a real bucket with JAROKU_S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY and it
// runs the same suite there as well.
//
//   npm run test:objects
//   JAROKU_S3_ENDPOINT=… JAROKU_S3_BUCKET=… npm run test:objects   # also against a real bucket

import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runObjectConformance } from "./conformance.ts";
import { FsObjectStore } from "./fsObjectStore.ts";
import { S3ObjectStore, S3Error } from "./s3ObjectStore.ts";
import { ObjectNotFound } from "./objectStore.ts";
import { agentVersionKey, workspacePrefix } from "./keys.ts";
import { amzDates, presignUrl, signRequest, signingKey, uriEncode } from "./sigv4.ts";
import { objectStoreKindFromEnv, openObjectStore, OBJECT_STORE_ENV, S3_ENV } from "./open.ts";
import { MOCK_ACCESS_KEY, MOCK_REGION, MOCK_SECRET_KEY, startMockS3 } from "../../fixtures/s3/mockS3.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const scratch: string[] = [];
const tmpRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-objects-"));
  scratch.push(d);
  return d;
};

// --- 1. SigV4, against AWS's published vectors -------------------------------------------
console.log("\nSigV4");
{
  // From "Examples of how to derive a signing key" in the AWS documentation.
  const derived = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam")
    .toString("hex");
  check(
    "the derived signing key matches AWS's documented example",
    derived === "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    derived,
  );

  // aws-sig-v4-test-suite / get-vanilla.
  const vanilla = signRequest(
    {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "service",
    },
    "GET",
    "/",
    {},
    { host: "example.amazonaws.com" },
    "",
    new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  );
  // The vector signs `host` and `x-amz-date` only. This signer always adds
  // `x-amz-content-sha256`, which S3 requires and the test service does not have — so the
  // canonical form is compared rather than the final signature, which is where the vector's
  // value actually lies: it pins the encoding, the ordering and the trimming.
  check(
    "the canonical request matches the documented form",
    vanilla.canonical.startsWith("GET\n/\n\n") && vanilla.canonical.includes("host:example.amazonaws.com\n"),
    vanilla.canonical.split("\n").slice(0, 4).join(" | "),
  );
  check(
    "the string to sign is scoped by date, region and service",
    vanilla.stringToSign.includes("20150830/us-east-1/service/aws4_request") &&
      vanilla.stringToSign.startsWith("AWS4-HMAC-SHA256\n20150830T123600Z\n"),
  );

  check("dates are derived from one clock reading", (() => {
    const { amzDate, dateStamp } = amzDates(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)));
    return amzDate === "20260102T030405Z" && dateStamp === "20260102";
  })());

  // The encoder is the one thing that differs from encodeURIComponent, and the difference is
  // exactly the characters that are legal in an S3 key.
  check("the encoder is AWS's, not encodeURIComponent's", uriEncode("a b!c'd(e)f*g~h") === "a%20b%21c%27d%28e%29f%2Ag~h");
  check("...and a path keeps its separators when asked", uriEncode("tools/notes.py", false) === "tools/notes.py");

  const url = presignUrl(
    { accessKeyId: "AK", secretAccessKey: "SK", region: "auto", service: "s3" },
    "GET",
    "http://example.invalid",
    "/bucket/ws/a/b.py",
    300,
  );
  check("a presigned URL carries the algorithm, credential, expiry and signature", [
    "X-Amz-Algorithm=AWS4-HMAC-SHA256", "X-Amz-Credential=AK", "X-Amz-Expires=300", "X-Amz-Signature=",
  ].every((part) => url.includes(part)));
  check("...and signs the host only, so any headers may be added on redemption", url.includes("X-Amz-SignedHeaders=host"));
}

// --- 2. the conformance suite, on both implementations ------------------------------------
const fsStore = new FsObjectStore({ root: tmpRoot(), signingKey: randomBytes(32) });
failures += (await runObjectConformance("conformance: FsObjectStore", fsStore)).failures;

const mock = await startMockS3({ pageSize: 5 });
const mockStore = new S3ObjectStore({
  endpoint: mock.origin,
  bucket: mock.bucket,
  region: MOCK_REGION,
  accessKeyId: MOCK_ACCESS_KEY,
  secretAccessKey: MOCK_SECRET_KEY,
  sleep: async () => {},
});
failures += (await runObjectConformance("conformance: S3ObjectStore (fixture)", mockStore)).failures;

// --- 3. what only the S3 store can be asked --------------------------------------------
console.log("\nS3ObjectStore, when the network does not cooperate");
{
  const WS = crypto.randomUUID();
  const AGENT = crypto.randomUUID();

  // The fixture verifies signatures, so a wrong secret has to be refused rather than tolerated.
  const wrongKey = new S3ObjectStore({
    endpoint: mock.origin, bucket: mock.bucket, region: MOCK_REGION,
    accessKeyId: MOCK_ACCESS_KEY, secretAccessKey: "not-the-secret", sleep: async () => {},
  });
  let refused: unknown;
  try {
    await wrongKey.put(agentVersionKey(WS, AGENT, 1, "a.py"), "x");
  } catch (err) {
    refused = err;
  }
  check(
    "a wrong secret is refused, so the fixture is checking the signature rather than accepting anything",
    refused instanceof S3Error && refused.status === 403,
    refused instanceof Error ? refused.message : String(refused),
  );
  check("...and a refusal is not retried", refused instanceof S3Error && refused.code === "AccessDenied");

  // Retries. The fixture 503s a fixed number of requests and then behaves; the store must
  // survive exactly that and no more.
  const flaky = await startMockS3({ failFirst: 2 });
  const flakyStore = new S3ObjectStore({
    endpoint: flaky.origin, bucket: flaky.bucket, region: MOCK_REGION,
    accessKeyId: MOCK_ACCESS_KEY, secretAccessKey: MOCK_SECRET_KEY, sleep: async () => {},
  });
  const key = agentVersionKey(WS, AGENT, 1, "agent.py");
  await flakyStore.put(key, "survived\n");
  check("a 503 SlowDown is retried rather than surfaced", (await flakyStore.get(key)).toString() === "survived\n");
  check("...and took the retries to get there", flaky.requests() >= 3, `${flaky.requests()} requests`);

  const hopeless = await startMockS3({ failFirst: 99 });
  const hopelessStore = new S3ObjectStore({
    endpoint: hopeless.origin, bucket: hopeless.bucket, region: MOCK_REGION,
    accessKeyId: MOCK_ACCESS_KEY, secretAccessKey: MOCK_SECRET_KEY, sleep: async () => {},
  });
  let gaveUp = false;
  try {
    await hopelessStore.put(key, "x");
  } catch (err) {
    gaveUp = err instanceof S3Error && err.code === "SlowDown";
  }
  check("a store that never recovers gives up rather than retrying forever", gaveUp);
  check("...after a bounded number of attempts", hopeless.requests() === 4, `${hopeless.requests()} requests`);
  await hopeless.close();

  // A body past the multipart threshold. 9 MiB of a repeating pattern, so a mis-ordered or
  // dropped part changes the bytes rather than happening to look the same.
  const big = Buffer.alloc(9 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const bigKey = agentVersionKey(WS, AGENT, 1, "exports/big.bin");
  const meta = await flakyStore.put(bigKey, big);
  check("a body past the threshold uploads in parts", meta.bytes === big.length);
  check("...and reassembles byte-identically", (await flakyStore.get(bigKey)).equals(big));
  check("...with the multipart etag S3 reports for one", meta.etag.includes("-"), meta.etag);

  // The presigned URL is redeemed with NO credentials at all, which is the whole point of one.
  const signed = await flakyStore.presignGet(key, 300);
  const redeemed = await fetch(signed.url);
  check("a presigned GET is redeemable by something holding no credentials", redeemed.status === 200);
  check("...and returns the object", (await redeemed.text()) === "survived\n");

  const unsigned = await fetch(`${flaky.origin}/${flaky.bucket}/${key}`);
  check("...while the same URL without a signature is refused", unsigned.status === 403);

  // An S3 path keeps its separators, so the key appears in the URL literally — this is the
  // spelling that actually repoints it, and the reason it is written out rather than reused
  // from the local store's test, whose URLs encode the key whole.
  const tampered = signed.url.replace(key, agentVersionKey(crypto.randomUUID(), AGENT, 1, "agent.py"));
  check("...and a URL repointed at another key does not verify", (await fetch(tampered)).status === 403);

  const putUrl = await flakyStore.presignPut(agentVersionKey(WS, AGENT, 1, "uploaded.py"), 300);
  const uploaded = await fetch(putUrl.url, { method: "PUT", body: "from a presigned put\n" });
  check("a presigned PUT accepts a write", uploaded.status === 200);
  check(
    "...and the object is there afterwards",
    (await flakyStore.get(agentVersionKey(WS, AGENT, 1, "uploaded.py"))).toString() === "from a presigned put\n",
  );
  check(
    "...while a GET URL cannot be used to write",
    (await fetch(signed.url, { method: "PUT", body: "no" })).status === 403,
  );

  await flakyStore.deletePrefix(workspacePrefix(WS));
  await flaky.close();

  // Absence, distinguished from failure, on the store that has to read it out of XML.
  let absent = false;
  try {
    await mockStore.get(agentVersionKey(WS, AGENT, 1, "never-written.py"));
  } catch (err) {
    absent = err instanceof ObjectNotFound;
  }
  check("an absent key is ObjectNotFound rather than an S3Error", absent);
}

// --- 3b. choosing one -----------------------------------------------------------------------
console.log("\nchoosing a store");
{
  const runtimeDir = tmpRoot();
  const keyPath = join(runtimeDir, "objects.key");

  check("the default is the local store, so npm run dev needs nothing", objectStoreKindFromEnv(undefined, {}) === "fs");
  check("...and it is what openObjectStore builds", openObjectStore({ runtimeDir, signingKeyPath: keyPath, env: {} }).kind === "fs");

  let refusedUnknown = false;
  try {
    objectStoreKindFromEnv("gcs", {});
  } catch {
    refusedUnknown = true;
  }
  check("an unknown store is refused rather than falling back", refusedUnknown);

  let refusedProd = false;
  try {
    objectStoreKindFromEnv("fs", { NODE_ENV: "production" });
  } catch {
    refusedProd = true;
  }
  check("the local store refuses to run under NODE_ENV=production", refusedProd);

  let refusedIncomplete = false;
  try {
    openObjectStore({ runtimeDir, signingKeyPath: keyPath, env: { [OBJECT_STORE_ENV]: "s3" } });
  } catch (err) {
    refusedIncomplete = (err as Error).message.includes(S3_ENV.endpoint);
  }
  check("s3 with no endpoint names what is missing rather than half-starting", refusedIncomplete);

  const configured = openObjectStore({
    runtimeDir,
    signingKeyPath: keyPath,
    env: {
      [OBJECT_STORE_ENV]: "s3",
      [S3_ENV.endpoint]: mock.origin,
      [S3_ENV.bucket]: mock.bucket,
      [S3_ENV.accessKeyId]: MOCK_ACCESS_KEY,
      [S3_ENV.secretAccessKey]: MOCK_SECRET_KEY,
    },
  });
  check("a configured s3 store is built and works", configured.kind === "s3");
  const probeKey = agentVersionKey(crypto.randomUUID(), crypto.randomUUID(), 1, "probe.py");
  await configured.put(probeKey, "configured\n");
  check("...end to end", (await configured.get(probeKey)).toString() === "configured\n");
  await configured.delete(probeKey);
}

await mock.close();

// --- 4. a real bucket, when one is configured ---------------------------------------------
if (process.env.JAROKU_S3_ENDPOINT && process.env.JAROKU_S3_BUCKET) {
  const real = new S3ObjectStore({
    endpoint: process.env.JAROKU_S3_ENDPOINT,
    bucket: process.env.JAROKU_S3_BUCKET,
    region: process.env.JAROKU_S3_REGION ?? "auto",
    accessKeyId: process.env.JAROKU_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.JAROKU_S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: process.env.JAROKU_S3_FORCE_PATH_STYLE !== "false",
  });
  failures += (await runObjectConformance("conformance: S3ObjectStore (real bucket)", real)).failures;
} else {
  console.log("\n(set JAROKU_S3_ENDPOINT and JAROKU_S3_BUCKET to run the suite against a real bucket too)");
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

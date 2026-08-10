// AWS Signature Version 4, in about a hundred and fifty lines of node:crypto.
//
// WHY NOT @aws-sdk/client-s3. This repository has no lint toolchain, its test suites are plain
// tsx scripts, and its event transport is delimiters rather than a parser library — the
// consistent judgement is that a script somebody can read beats a tool they have to trust. The
// SDK would bring roughly fifteen megabytes and forty transitive packages to sign four verbs
// against one bucket. SigV4 itself is four HMACs and a string; the fiddly part is the canonical
// form, and the fiddly part is exactly what the published test vectors pin down. Both of those
// vectors are asserted in objects.test.ts, so this is checked against AWS's own answers rather
// than against my reading of the specification.
//
// AND IT KEEPS THE STORE PROVIDER-AGNOSTIC. R2, S3 and MinIO all speak this; the differences
// between them are an endpoint, a region string and whether the bucket is in the host or the
// path. All three are configuration rather than code, which is what D5 asked for.
//
// TWO SIGNING MODES, and they are genuinely different things:
//
//   signRequest   — the signature travels in an `Authorization` header. Used for every call
//                   this server makes itself. The payload is hashed, so the request is bound
//                   to its body.
//
//   presignUrl    — the signature travels in the query string, and the URL is then a bearer
//                   credential anybody can redeem for its lifetime. The payload is therefore
//                   UNSIGNED-PAYLOAD, because whoever redeems it has not written the body yet.
//                   That is the trade a presigned URL is: less binding, in exchange for the
//                   bytes not having to pass through this process at all.

import { createHash, createHmac } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary credentials (STS, an instance role). Sent as `x-amz-security-token`. */
  sessionToken?: string;
}

export interface SigV4Context extends SigV4Credentials {
  region: string;
  /** `s3` here, always. A parameter because the string is part of the scope and the vectors. */
  service: string;
}

const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/**
 * Percent-encode as AWS defines it, which is not what `encodeURIComponent` does.
 *
 * The unreserved set is exactly `A-Za-z0-9-_.~`; everything else is percent-encoded with
 * UPPERCASE hex. `encodeURIComponent` additionally leaves `!'()*` alone, and those characters
 * are legal in an S3 key — a key containing one would be signed one way and sent another, and
 * the request would come back 403 with nothing saying why.
 *
 * `encodeSlash` is false only for a canonical URI path, where the separators stay separators.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** `20150830T123600Z` and `20150830`. One clock reading, so the two can never disagree. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** The four chained HMACs. Cached nowhere: it is four hashes, and a cache would be state. */
export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), "aws4_request");
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? "")}`)
    .join("&");
}

/**
 * The canonical request, and the headers it says it covers.
 *
 * Header names are lowercased and sorted, values are trimmed and their internal runs of
 * whitespace collapsed — all of which the spec requires and none of which is optional: a
 * canonical form that differs from the server's by one space produces a signature mismatch and
 * an error message that names neither.
 */
export function canonicalRequest(
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  payloadHash: string,
): { canonical: string; signedHeaders: string } {
  const normalised = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = normalised.map(([k]) => k).join(";");
  const canonicalHeaders = normalised.map(([k, v]) => `${k}:${v}\n`).join("");
  const canonical = [
    method.toUpperCase(),
    // The path is already `/`-separated and its segments are encoded here. S3 is one of the
    // services that does NOT double-encode the path, which is why this is a single pass.
    path
      .split("/")
      .map((seg) => uriEncode(seg))
      .join("/"),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { canonical, signedHeaders };
}

/**
 * The last two steps: hash the canonical request into a string-to-sign, then HMAC it.
 *
 * Exported because a SERVER has to do exactly this to check a signature, and the fixture S3 in
 * `fixtures/s3/` does check one. A fixture that accepted an unsigned request would prove the
 * client can talk to a server that does not care, which is worth nothing at all.
 */
export function deriveSignature(
  ctx: SigV4Context,
  canonical: string,
  amzDate: string,
  dateStamp: string,
): string {
  const scope = `${dateStamp}/${ctx.region}/${ctx.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  return createHmac("sha256", signingKey(ctx.secretAccessKey, dateStamp, ctx.region, ctx.service))
    .update(stringToSign, "utf8")
    .digest("hex");
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** Exposed for the tests and for a signature mismatch that needs explaining. */
  canonical: string;
  stringToSign: string;
  signature: string;
}

/**
 * Sign a request with the signature in an `Authorization` header.
 *
 * `headers` must already contain `host`. It is not derived from the URL here because the
 * caller is the one that knows whether it is talking through a proxy, and a signature over the
 * wrong host is the single most common way this goes wrong silently.
 */
export function signRequest(
  ctx: SigV4Context,
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  body: Buffer | string,
  now: Date = new Date(),
): SignedRequest {
  const { amzDate, dateStamp } = amzDates(now);
  const payloadHash = sha256Hex(typeof body === "string" ? Buffer.from(body, "utf8") : body);

  const all: Record<string, string> = {
    ...headers,
    "x-amz-date": amzDate,
    // Sent AND signed. S3 requires it on every request, and a proxy that strips it turns a
    // working request into a 403 rather than into a silently unsigned one.
    "x-amz-content-sha256": payloadHash,
  };
  if (ctx.sessionToken) all["x-amz-security-token"] = ctx.sessionToken;

  const { canonical, signedHeaders } = canonicalRequest(method, path, query, all, payloadHash);
  const scope = `${dateStamp}/${ctx.region}/${ctx.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(ctx.secretAccessKey, dateStamp, ctx.region, ctx.service))
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    headers: {
      ...all,
      Authorization:
        `${ALGORITHM} Credential=${ctx.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonical,
    stringToSign,
    signature,
  };
}

/**
 * Mint a presigned URL: the signature in the query string, and nothing else granted.
 *
 * Only `host` is signed, so the URL survives whatever headers a browser or a sandbox decides to
 * add. `expiresIn` is seconds and S3 caps it at seven days; nothing here mints anything close.
 */
export function presignUrl(
  ctx: SigV4Context,
  method: string,
  origin: string,
  path: string,
  expiresIn: number,
  extraQuery: Record<string, string> = {},
  now: Date = new Date(),
): string {
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${ctx.region}/${ctx.service}/aws4_request`;
  const host = new URL(origin).host;

  const query: Record<string, string> = {
    ...extraQuery,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${ctx.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.floor(expiresIn)),
    "X-Amz-SignedHeaders": "host",
  };
  if (ctx.sessionToken) query["X-Amz-Security-Token"] = ctx.sessionToken;

  const { canonical } = canonicalRequest(method, path, query, { host }, "UNSIGNED-PAYLOAD");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(ctx.secretAccessKey, dateStamp, ctx.region, ctx.service))
    .update(stringToSign, "utf8")
    .digest("hex");

  return `${origin}${path
    .split("/")
    .map((seg) => uriEncode(seg))
    .join("/")}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/**
 * Recompute a presigned URL's signature, for a server that has to verify one.
 *
 * Only the fixture S3 uses this — but it uses it rather than skipping the check, because a
 * fixture that accepts an unsigned request proves the client can talk to a server that does not
 * care, which is the one thing worth nothing at all.
 */
export function presignedSignatureFor(
  ctx: SigV4Context,
  method: string,
  host: string,
  path: string,
  query: Record<string, string>,
): string {
  const credential = query["X-Amz-Credential"] ?? "";
  const dateStamp = credential.split("/")[1] ?? "";
  const withoutSignature = { ...query };
  delete withoutSignature["X-Amz-Signature"];
  const { canonical } = canonicalRequest(method, path, withoutSignature, { host }, "UNSIGNED-PAYLOAD");
  const scope = `${dateStamp}/${ctx.region}/${ctx.service}/aws4_request`;
  const stringToSign = [ALGORITHM, query["X-Amz-Date"] ?? "", scope, sha256Hex(canonical)].join("\n");
  return createHmac("sha256", signingKey(ctx.secretAccessKey, dateStamp, ctx.region, ctx.service))
    .update(stringToSign, "utf8")
    .digest("hex");
}

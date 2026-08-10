// A fixture S3, so the hosted object store can be built and verified without a cloud account.
//
// Same purpose as fixtures/mcp/mockServer.ts and server/fixtures/*.txt: rule 5 of this
// migration says the fixtures and `npm run dev` must keep working with zero cloud
// dependencies, and an implementation that can only be exercised by somebody with an R2
// account is an implementation that gets tested by accident.
//
// IT VERIFIES THE SIGNATURE. That is the whole reason this is worth writing rather than
// stubbing `fetch`. A fixture that accepted an unsigned request would prove the client can talk
// to a server that does not care — which is exactly what a signature bug looks like from the
// client's side, and exactly nothing worth knowing. Both signing modes are checked: the
// Authorization header for the server's own calls, and the query-string form for a presigned
// URL, which is what proves a presigned URL is redeemable by something holding no credentials.
//
// IT IS NOT S3. It implements the verbs this codebase uses and answers them the way S3 does,
// including the parts that are easy to get wrong from the client side and therefore worth
// having a second opinion on: 404 with a `<Code>NoSuchKey</Code>` body, a paginated
// ListObjectsV2 with a continuation token, quoted ETags, a multipart upload that refuses to
// complete twice. Everything else — versioning, ACLs, lifecycle, storage classes — is absent,
// and a caller reaching for one gets a 501 rather than a plausible lie.
//
// Usage:
//   npm run mock:s3                        # http://127.0.0.1:8933, bucket "jaroku"
//   MOCK_S3_PORT=9100 npm run mock:s3
//   MOCK_S3_PAGE_SIZE=2 npm run mock:s3    # forces pagination, for the listing tests
//   MOCK_S3_FAIL_FIRST=2 npm run mock:s3   # 503s the first N requests, for the retry tests

import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalRequest, deriveSignature, presignedSignatureFor, type SigV4Context } from "../../src/storage/sigv4.ts";

export const MOCK_ACCESS_KEY = "JAROKUFIXTUREKEYID00";
export const MOCK_SECRET_KEY = "jaroku-fixture-secret-key-not-a-real-one";
export const MOCK_BUCKET = "jaroku";
export const MOCK_REGION = "auto";

interface StoredObject {
  body: Buffer;
  contentType: string;
  modifiedAt: Date;
}

export interface MockS3Options {
  port?: number;
  bucket?: string;
  /** ListObjectsV2 page size. Small in tests, so the continuation-token path is real. */
  pageSize?: number;
  /** Answer 503 SlowDown to the first N requests, then behave. Exercises the retry ladder. */
  failFirst?: number;
}

export interface MockS3Handle {
  server: Server;
  origin: string;
  bucket: string;
  /** Every object currently held, for assertions the HTTP surface cannot make. */
  objects: Map<string, StoredObject>;
  /** How many requests have arrived, so a retry can be counted rather than inferred. */
  requests: () => number;
  close: () => Promise<void>;
}

const sigContext = (): SigV4Context => ({
  accessKeyId: MOCK_ACCESS_KEY,
  secretAccessKey: MOCK_SECRET_KEY,
  region: MOCK_REGION,
  service: "s3",
});

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`;
  res.writeHead(status, { "content-type": "application/xml", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

/**
 * Recompute the signature the client should have produced, and compare.
 *
 * The header form rebuilds the canonical request from exactly the headers `SignedHeaders`
 * names — not from every header the request carried, because a proxy (or Node's own fetch)
 * adds headers the client never signed, and including them here would fail every request for
 * a reason that is not the client's.
 */
function headerSignatureOk(req: IncomingMessage, path: string, query: Record<string, string>, body: Buffer): boolean {
  const auth = req.headers.authorization ?? "";
  const credential = /Credential=([^,\s]+)/.exec(auth)?.[1];
  const signedHeaders = /SignedHeaders=([^,\s]+)/.exec(auth)?.[1];
  const signature = /Signature=([0-9a-f]+)/.exec(auth)?.[1];
  if (!credential || !signedHeaders || !signature) return false;

  const [accessKeyId, dateStamp] = credential.split("/");
  if (accessKeyId !== MOCK_ACCESS_KEY || !dateStamp) return false;

  const headers: Record<string, string> = {};
  for (const name of signedHeaders.split(";")) {
    const value = req.headers[name];
    if (value === undefined) return false;
    headers[name] = Array.isArray(value) ? value.join(",") : String(value);
  }
  const payloadHash = String(req.headers["x-amz-content-sha256"] ?? createHash("sha256").update(body).digest("hex"));
  const { canonical } = canonicalRequest(req.method ?? "GET", path, query, headers, payloadHash);
  const expected = deriveSignature(sigContext(), canonical, String(req.headers["x-amz-date"] ?? ""), dateStamp);
  return expected === signature;
}

function querySignatureOk(req: IncomingMessage, path: string, query: Record<string, string>): boolean {
  const supplied = query["X-Amz-Signature"];
  if (!supplied) return false;
  const host = String(req.headers.host ?? "");
  const expected = presignedSignatureFor(sigContext(), req.method ?? "GET", host, path, query);
  if (expected !== supplied) return false;

  // The expiry is part of the promise, so the fixture enforces it. Without this a test could
  // pass with an expired URL and nobody would learn that expiry is never checked anywhere.
  const amzDate = query["X-Amz-Date"] ?? "";
  const started = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T` +
      `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  const expires = Number(query["X-Amz-Expires"] ?? 0) * 1000;
  return Number.isFinite(started) && Date.now() <= started + expires;
}

export function startMockS3(opts: MockS3Options = {}): Promise<MockS3Handle> {
  const bucket = opts.bucket ?? MOCK_BUCKET;
  const pageSize = opts.pageSize ?? 1000;
  let remainingFailures = opts.failFirst ?? 0;
  let requests = 0;

  const objects = new Map<string, StoredObject>();
  /** uploadId -> partNumber -> bytes. In-memory, exactly as long as the upload lives. */
  const uploads = new Map<string, Map<number, Buffer>>();
  const uploadKeys = new Map<string, string>();

  const server = createServer((req, res) => {
    void (async () => {
      requests++;
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      // Decoded per segment, because the signature is computed over the DECODED path re-encoded
      // canonically — a key with a space in it round-trips only if this side decodes first.
      const path = url.pathname
        .split("/")
        .map((seg) => decodeURIComponent(seg))
        .join("/");
      const body = await readBody(req);

      if (remainingFailures > 0) {
        remainingFailures--;
        return error(res, 503, "SlowDown", "please reduce your request rate");
      }

      const presigned = "X-Amz-Signature" in query;
      const authorised = presigned
        ? querySignatureOk(req, path, query)
        : headerSignatureOk(req, path, query, body);
      if (!authorised) {
        return error(
          res,
          403,
          presigned ? "SignatureDoesNotMatch" : "AccessDenied",
          "the request signature we calculated does not match the signature you provided",
        );
      }

      // /<bucket>            — a bucket-level operation (listing)
      // /<bucket>/<key…>     — an object operation. The key keeps its slashes.
      const segments = path.split("/").filter((s) => s.length > 0);
      if (segments[0] !== bucket) return error(res, 404, "NoSuchBucket", `no such bucket: ${segments[0]}`);
      const key = segments.slice(1).join("/");

      // --- listing ---------------------------------------------------------------------
      if (!key) {
        if (query["list-type"] !== "2") return error(res, 501, "NotImplemented", "only ListObjectsV2 is implemented");
        const prefix = query["prefix"] ?? "";
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const after = query["continuation-token"];
        const start = after ? all.findIndex((k) => k > after) : 0;
        const page = start < 0 ? [] : all.slice(start, start + pageSize);
        const truncated = start >= 0 && start + pageSize < all.length;
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          `<Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
          `<KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys>` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1] ?? "")}</NextContinuationToken>` : "") +
          page
            .map((k) => {
              const o = objects.get(k)!;
              return (
                `<Contents><Key>${xmlEscape(k)}</Key>` +
                `<LastModified>${o.modifiedAt.toISOString()}</LastModified>` +
                `<ETag>&quot;${createHash("md5").update(o.body).digest("hex")}&quot;</ETag>` +
                `<Size>${o.body.length}</Size></Contents>`
              );
            })
            .join("") +
          `</ListBucketResult>`;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(xml);
      }

      const etagOf = (buf: Buffer): string => createHash("md5").update(buf).digest("hex");

      // --- multipart -------------------------------------------------------------------
      if ("uploads" in query && req.method === "POST") {
        const uploadId = randomUUID();
        uploads.set(uploadId, new Map());
        uploadKeys.set(uploadId, key);
        const xml = `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(xml);
      }
      const uploadId = query["uploadId"];
      if (uploadId) {
        const parts = uploads.get(uploadId);
        if (!parts) return error(res, 404, "NoSuchUpload", "the specified upload does not exist");
        if (req.method === "PUT") {
          parts.set(Number(query["partNumber"]), body);
          res.writeHead(200, { etag: `"${etagOf(body)}"` });
          return res.end();
        }
        if (req.method === "DELETE") {
          uploads.delete(uploadId);
          uploadKeys.delete(uploadId);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === "POST") {
          const assembled = Buffer.concat([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
          objects.set(uploadKeys.get(uploadId)!, {
            body: assembled,
            contentType: "application/octet-stream",
            modifiedAt: new Date(),
          });
          // Consumed, so a second COMPLETE is NoSuchUpload rather than a second assembly. That
          // is why the client marks the call non-idempotent and does not retry it.
          uploads.delete(uploadId);
          uploadKeys.delete(uploadId);
          const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${xmlEscape(key)}</Key><ETag>&quot;${etagOf(assembled)}-${parts.size}&quot;</ETag></CompleteMultipartUploadResult>`;
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(xml);
        }
      }

      // --- objects ---------------------------------------------------------------------
      switch (req.method) {
        case "PUT": {
          const copySource = req.headers["x-amz-copy-source"];
          if (typeof copySource === "string") {
            const source = decodeURIComponent(copySource).replace(/^\//, "").split("/").slice(1).join("/");
            const found = objects.get(source);
            if (!found) return error(res, 404, "NoSuchKey", `no such key: ${source}`);
            objects.set(key, { ...found, body: Buffer.from(found.body), modifiedAt: new Date() });
            const xml = `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>&quot;${etagOf(found.body)}&quot;</ETag></CopyObjectResult>`;
            res.writeHead(200, { "content-type": "application/xml", etag: `"${etagOf(found.body)}"` });
            return res.end(xml);
          }
          objects.set(key, {
            body,
            contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
            modifiedAt: new Date(),
          });
          res.writeHead(200, { etag: `"${etagOf(body)}"` });
          return res.end();
        }
        case "GET":
        case "HEAD": {
          const found = objects.get(key);
          if (!found) {
            // A HEAD carries no body, exactly as S3's does — which is why the client reads the
            // status rather than looking for a `<Code>` there.
            if (req.method === "HEAD") {
              res.writeHead(404);
              return res.end();
            }
            return error(res, 404, "NoSuchKey", `no such key: ${key}`);
          }
          res.writeHead(200, {
            "content-type": found.contentType,
            "content-length": String(found.body.length),
            "last-modified": found.modifiedAt.toUTCString(),
            etag: `"${etagOf(found.body)}"`,
          });
          return res.end(req.method === "HEAD" ? undefined : found.body);
        }
        case "DELETE": {
          objects.delete(key);
          res.writeHead(204);
          return res.end();
        }
        default:
          return error(res, 501, "NotImplemented", `${req.method} is not implemented by the fixture`);
      }
    })().catch((err) => {
      error(res, 500, "InternalError", (err as Error).message);
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        origin: `http://127.0.0.1:${port}`,
        bucket,
        objects,
        requests: () => requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Run directly for a long-lived fixture, the same way the mock MCP server does.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ")) {
  const handle = await startMockS3({
    port: Number(process.env.MOCK_S3_PORT ?? 8933),
    pageSize: process.env.MOCK_S3_PAGE_SIZE ? Number(process.env.MOCK_S3_PAGE_SIZE) : undefined,
    failFirst: process.env.MOCK_S3_FAIL_FIRST ? Number(process.env.MOCK_S3_FAIL_FIRST) : undefined,
  });
  console.log(`[mock-s3] ${handle.origin}/${handle.bucket} — access key ${MOCK_ACCESS_KEY}`);
}

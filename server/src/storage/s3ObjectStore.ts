// The hosted object store: S3, and everything that speaks it.
//
// D5 answered R2 — no egress fees, S3-compatible — so this is one implementation covering R2,
// S3 and MinIO, with the differences between them expressed as configuration: an endpoint, a
// region string, and whether the bucket lives in the host or in the path. Signing is sigv4.ts,
// which is node:crypto and no dependency; see that file for why.
//
// THE THREE THINGS THAT ARE NOT "JUST HTTP":
//
//   RETRIES. S3 answers 503 SlowDown and 500 InternalError as a matter of routine, and both are
//   documented as retryable. Exponential backoff with jitter, bounded attempts, and — the part
//   that matters — retries only on idempotent failures. A PUT of a whole object is idempotent
//   by key, so it retries; a multipart COMPLETE is not, so it does not.
//
//   MULTIPART. A single PUT is capped at 5 GB and, long before that, is a request that has to
//   be restarted from zero when it fails. Anything past the threshold below is uploaded in
//   parts, and a failure aborts the upload rather than leaving parts accruing storage charges
//   nobody can see. Agent projects are kilobytes; eval exports and workspace archives are not,
//   and Session 8's export is the caller this exists for.
//
//   ERRORS ARE XML. Not JSON, not a status code alone. The code inside the body is what
//   distinguishes NoSuchKey (absent, and a normal answer) from AccessDenied (a configuration
//   mistake), and a store that reported both as "failed" would make the first one look like an
//   outage every time an undo reached a swept version.
//
// LISTING IS PAGINATED AND THE PAGINATION IS NOT OPTIONAL. ListObjectsV2 returns at most 1000
// keys and says so in `IsTruncated`. A store that read the first page and stopped would work
// through every test and every small workspace, and would silently lose files from the first
// large one.

import { assertKey, assertPrefix } from "./keys.ts";
import {
  ObjectNotFound, type ObjectMeta, type ObjectStore, type PutOptions,
} from "./objectStore.ts";
import { normalisePresignTtl, type Presigned } from "./presign.ts";
import { presignUrl, signRequest, uriEncode, type SigV4Credentials } from "./sigv4.ts";

/** Past this, a body is uploaded in parts. S3's own minimum part size is 5 MiB. */
const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;

/** Bounded, because a caller waiting on storage is a user watching a spinner. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 100;

export interface S3ObjectStoreOptions extends SigV4Credentials {
  /** `https://<account>.r2.cloudflarestorage.com`, or a MinIO origin. No trailing slash. */
  endpoint: string;
  bucket: string;
  /** `auto` for R2. Part of the signature scope, so it has to match what the provider expects. */
  region: string;
  /**
   * Bucket in the path (`/<bucket>/<key>`) rather than in the host.
   *
   * True by default because it is what R2 and MinIO want. AWS itself has deprecated path style
   * for new buckets, so an S3 deployment sets this false and gets `<bucket>.s3.<region>…`.
   */
  forcePathStyle?: boolean;
  /** Injected so the retry test does not spend four seconds sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so the fixture server can be addressed without a global fetch override. */
  fetchImpl?: typeof fetch;
}

interface S3Response {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** The XML entity set S3 uses. A key may legally contain `&`, so this is not decoration. */
function xmlDecode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** First value of `<tag>…</tag>` inside `xml`, decoded, or null. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlDecode(m[1]!) : null;
}

/** Every `<tag>…</tag>` block, undecoded, for iterating a list response's Contents. */
function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]!);
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The `<Code>` from the body — `NoSuchKey`, `SlowDown`, `AccessDenied`. */
    readonly code: string | null,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly opts: Required<Pick<S3ObjectStoreOptions, "forcePathStyle">> & S3ObjectStoreOptions;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: S3ObjectStoreOptions) {
    this.opts = { forcePathStyle: true, ...opts };
    const endpoint = opts.endpoint.replace(/\/+$/, "");
    this.origin = this.opts.forcePathStyle
      ? endpoint
      : endpoint.replace(/^(https?:\/\/)/, `$1${opts.bucket}.`);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The request path for a key, bucket included when the bucket lives in the path. */
  private pathFor(key: string): string {
    return this.opts.forcePathStyle ? `/${this.opts.bucket}/${key}` : `/${key}`;
  }

  private sigContext() {
    return {
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      sessionToken: this.opts.sessionToken,
      region: this.opts.region,
      service: "s3",
    };
  }

  /**
   * One signed request, retried where retrying is safe.
   *
   * `idempotent` is the caller's judgement rather than a property of the verb: a PUT of a whole
   * object can be replayed, and a multipart COMPLETE cannot. Getting that backwards is how a
   * retry storm produces a corrupt object instead of a slow one.
   */
  private async send(
    method: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: Buffer | string = "",
    idempotent = true,
  ): Promise<S3Response> {
    const host = new URL(this.origin).host;
    let lastError: unknown;

    for (let attempt = 1; attempt <= (idempotent ? MAX_ATTEMPTS : 1); attempt++) {
      // Re-signed every attempt. A signature carries its own timestamp and S3 refuses one more
      // than fifteen minutes old, so replaying the first attempt's headers after a long backoff
      // turns a retryable error into RequestTimeTooSkewed.
      const signed = signRequest(this.sigContext(), method, path, query, { ...headers, host }, body);
      // The SAME encoder the signature used. `encodeURIComponent` leaves `!*\'()` alone and
      // `uriEncode` does not, so signing with one and sending with the other produces a request
      // that verifies for most keys and 403s for the rest — which is the worst possible split.
      const qs = Object.keys(query).length
        ? `?${Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? "")}`).join("&")}`
        : "";
      try {
        const res = await this.fetchImpl(`${this.origin}${path}${qs}`, {
          method,
          headers: signed.headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
        });
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok) return { status: res.status, headers: res.headers, body: buf };

        const text = buf.toString("utf8");
        const code = tag(text, "Code");
        const error = new S3Error(
          `${method} ${path} failed: ${res.status}${code ? ` ${code}` : ""}${
            tag(text, "Message") ? ` — ${tag(text, "Message")}` : ""
          }`,
          res.status,
          code,
        );
        // 429 and 5xx are the documented retryable set. A 403 is a credential or a clock and
        // retrying it four times only makes the log four times longer.
        if (attempt < MAX_ATTEMPTS && idempotent && (res.status === 429 || res.status >= 500)) {
          lastError = error;
          await this.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 50));
          continue;
        }
        throw error;
      } catch (err) {
        if (err instanceof S3Error) throw err;
        // A socket error, a DNS failure, a reset connection. Retryable for the same reason a
        // 503 is, and distinguished from an S3Error so a real refusal is never retried.
        lastError = err;
        if (attempt >= MAX_ATTEMPTS || !idempotent) break;
        await this.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 50));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private metaFrom(key: string, headers: Headers, bytes: number): ObjectMeta {
    return {
      key,
      bytes,
      // S3's ETag arrives quoted, and for a multipart object it is `<md5>-<parts>` rather than
      // a hash of anything. Both are fine: ObjectMeta.etag promises an opaque marker that is
      // stable for stable content within one store, which is exactly what this is.
      etag: (headers.get("etag") ?? "").replace(/"/g, ""),
      modifiedAt: new Date(headers.get("last-modified") ?? Date.now()).toISOString(),
    };
  }

  async put(key: string, body: Buffer | string, opts?: PutOptions): Promise<ObjectMeta> {
    assertKey(key);
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    if (bytes.length > MULTIPART_THRESHOLD) return this.multipartPut(key, bytes, opts);

    const res = await this.send("PUT", this.pathFor(key), {}, {
      "content-length": String(bytes.length),
      "content-type": opts?.contentType ?? "application/octet-stream",
    }, bytes);
    return this.metaFrom(key, res.headers, bytes.length);
  }

  /**
   * Upload in parts, and abort rather than abandon.
   *
   * An abandoned multipart upload is invisible: it does not appear in a listing, it is not an
   * object, and it is billed. So every failure path aborts, and the abort's own failure is
   * swallowed — the error worth reporting is the one that caused it, not the cleanup's.
   */
  private async multipartPut(key: string, bytes: Buffer, opts?: PutOptions): Promise<ObjectMeta> {
    const path = this.pathFor(key);
    const created = await this.send("POST", path, { uploads: "" }, {
      "content-type": opts?.contentType ?? "application/octet-stream",
    });
    const uploadId = tag(created.body.toString("utf8"), "UploadId");
    if (!uploadId) throw new Error(`multipart upload of ${key} was not given an upload id`);

    try {
      const parts: { number: number; etag: string }[] = [];
      for (let offset = 0, n = 1; offset < bytes.length; offset += PART_SIZE, n++) {
        const chunk = bytes.subarray(offset, Math.min(offset + PART_SIZE, bytes.length));
        const res = await this.send("PUT", path, { partNumber: String(n), uploadId }, {
          "content-length": String(chunk.length),
        }, chunk);
        parts.push({ number: n, etag: (res.headers.get("etag") ?? "").replace(/"/g, "") });
      }
      const xml =
        `<CompleteMultipartUpload>${parts
          .map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>"${xmlEscape(p.etag)}"</ETag></Part>`)
          .join("")}</CompleteMultipartUpload>`;
      // NOT idempotent: completing twice with the same parts is an error, and completing after a
      // partial failure could assemble an object out of a mixture of two attempts' parts.
      const done = await this.send("POST", path, { uploadId }, {
        "content-type": "application/xml",
        "content-length": String(Buffer.byteLength(xml)),
      }, xml, false);
      // The completed object's ETag is in the BODY of this response, not in a header — S3
      // cannot send one, because it only learns the final etag after the response has begun.
      // Reading it from the headers would leave a multipart-uploaded object with an empty
      // marker, and "has this changed" would then answer no for every large file forever.
      const meta = this.metaFrom(key, done.headers, bytes.length);
      const etag = tag(done.body.toString("utf8"), "ETag");
      return etag ? { ...meta, etag: etag.replace(/"/g, "") } : meta;
    } catch (err) {
      try {
        await this.send("DELETE", path, { uploadId }, {});
      } catch {
        /* the upload is already failing; the abort's own failure is not the story */
      }
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    try {
      return (await this.send("GET", this.pathFor(key), {}, {})).body;
    } catch (err) {
      if (err instanceof S3Error && (err.status === 404 || err.code === "NoSuchKey")) {
        throw new ObjectNotFound(key);
      }
      throw err;
    }
  }

  async head(key: string): Promise<ObjectMeta | null> {
    assertKey(key);
    try {
      const res = await this.send("HEAD", this.pathFor(key), {}, {});
      return this.metaFrom(key, res.headers, Number(res.headers.get("content-length") ?? 0));
    } catch (err) {
      // A HEAD carries no body, so there is no `<Code>` to read — the status is the whole answer.
      if (err instanceof S3Error && (err.status === 404 || err.code === "NoSuchKey")) return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<ObjectMeta[]> {
    assertPrefix(prefix);
    const out: ObjectMeta[] = [];
    let token: string | undefined;

    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const res = await this.send(
        "GET",
        this.opts.forcePathStyle ? `/${this.opts.bucket}` : "/",
        query,
        {},
      );
      const xml = res.body.toString("utf8");
      for (const block of blocks(xml, "Contents")) {
        const key = tag(block, "Key");
        if (!key) continue;
        out.push({
          key,
          bytes: Number(tag(block, "Size") ?? 0),
          etag: (tag(block, "ETag") ?? "").replace(/"/g, ""),
          modifiedAt: new Date(tag(block, "LastModified") ?? Date.now()).toISOString(),
        });
      }
      token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") ?? undefined : undefined;
    } while (token);

    // S3 returns keys in lexicographic order already; sorted here anyway so the two
    // implementations make the same promise rather than one of them making it by accident.
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    try {
      await this.send("DELETE", this.pathFor(key), {}, {});
    } catch (err) {
      // S3 already answers 204 for a key that was not there. This covers a provider that does
      // not, so `delete` is idempotent on every one of them rather than on most.
      if (err instanceof S3Error && (err.status === 404 || err.code === "NoSuchKey")) return;
      throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    // One request per key rather than a batched DeleteObjects. The batched form needs a
    // Content-MD5 over an XML body, and every caller here deletes a staging copy or one swept
    // version — tens of objects, not thousands. Session 8's workspace deletion is the caller
    // that will want the batch, and it can have it when it is the thing being measured.
    for (const o of objects) await this.delete(o.key);
    return objects.length;
  }

  async copy(fromKey: string, toKey: string): Promise<ObjectMeta> {
    assertKey(fromKey);
    assertKey(toKey);
    try {
      const res = await this.send("PUT", this.pathFor(toKey), {}, {
        // Server-side: the bytes never cross this process. A version bump copies every unchanged
        // file, so this is the common case and not the clever one.
        // URI-encoded, slashes kept: S3 reads this header as a URL, so a key containing a
        // space or a plus would name a different object than the one being copied.
        "x-amz-copy-source": uriEncode(`/${this.opts.bucket}/${fromKey}`, false),
        "content-length": "0",
      });
      const head = await this.head(toKey);
      return head ?? this.metaFrom(toKey, res.headers, 0);
    } catch (err) {
      if (err instanceof S3Error && (err.status === 404 || err.code === "NoSuchKey")) {
        throw new ObjectNotFound(fromKey);
      }
      throw err;
    }
  }

  async presignGet(key: string, ttlSeconds: number): Promise<Presigned> {
    return this.presign("GET", key, ttlSeconds);
  }

  async presignPut(key: string, ttlSeconds: number): Promise<Presigned> {
    return this.presign("PUT", key, ttlSeconds);
  }

  private presign(method: "GET" | "PUT", key: string, ttlSeconds: number): Presigned {
    assertKey(key);
    const ttl = normalisePresignTtl(ttlSeconds);
    const url = presignUrl(this.sigContext(), method, this.origin, this.pathFor(key), ttl);
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}

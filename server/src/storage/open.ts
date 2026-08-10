// Choosing an object store. The only place in the codebase that does.
//
// The same shape as db/open.ts, deliberately: one function, one environment variable, a local
// default that needs nothing installed and nothing running, and a refusal rather than a
// fallback when the configuration is wrong. Falling back to the local store when somebody asked
// for S3 means a server that starts, works, and writes every agent's files to a disk that
// disappears with the container.

import { join } from "node:path";
import { FsObjectStore } from "./fsObjectStore.ts";
import { S3ObjectStore } from "./s3ObjectStore.ts";
import { resolveSigningKey } from "./presign.ts";
import type { ObjectStore, ObjectStoreKind } from "./objectStore.ts";

export const OBJECT_STORE_ENV = "JAROKU_OBJECT_STORE";

/** Every variable the S3 store reads, named once so the error message can list them. */
export const S3_ENV = {
  endpoint: "JAROKU_S3_ENDPOINT",
  bucket: "JAROKU_S3_BUCKET",
  region: "JAROKU_S3_REGION",
  accessKeyId: "JAROKU_S3_ACCESS_KEY_ID",
  secretAccessKey: "JAROKU_S3_SECRET_ACCESS_KEY",
  sessionToken: "JAROKU_S3_SESSION_TOKEN",
  forcePathStyle: "JAROKU_S3_FORCE_PATH_STYLE",
} as const;

export interface OpenObjectStoreOptions {
  /** Where `fs` roots itself, and where its signing key is persisted beside. */
  runtimeDir: string;
  /** Where the local signing key file lives. Beside the database, like the issuer's key. */
  signingKeyPath: string;
  /** Overrides `JAROKU_OBJECT_STORE`. Tests pass this rather than mutating the environment. */
  kind?: string;
  env?: NodeJS.ProcessEnv;
}

export function objectStoreKindFromEnv(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): ObjectStoreKind {
  const raw = (override ?? env[OBJECT_STORE_ENV] ?? "fs").trim().toLowerCase();
  if (raw !== "fs" && raw !== "s3") {
    throw new Error(`${OBJECT_STORE_ENV} must be "fs" or "s3", not "${raw}"`);
  }

  // THE LOCAL STORE IS A DEVELOPMENT STORE, and in production that is not a choice, it is an
  // accident — the same judgement db/open.ts makes about SQLite, refused the same way.
  //
  // The reason is not durability. It is that the local store is a DISK, and the whole of this
  // session exists because replicas do not share one. A hosted deployment running on it would
  // generate an agent on replica 1 and answer the edit that follows on replica 3, which has
  // never heard of the file — and it would do that intermittently, in proportion to how many
  // replicas are running, which is the least debuggable shape a bug can have.
  if (raw === "fs" && env["NODE_ENV"] === "production") {
    throw new Error(
      `${OBJECT_STORE_ENV}=fs refuses to run under NODE_ENV=production. The local store is a ` +
        `directory on one machine: an agent generated on one replica would not exist on the ` +
        `next one, intermittently and in proportion to how many are running. Set ` +
        `${OBJECT_STORE_ENV}=s3 with ${S3_ENV.endpoint} and ${S3_ENV.bucket}.`,
    );
  }
  return raw;
}

export function openObjectStore(opts: OpenObjectStoreOptions): ObjectStore {
  const env = opts.env ?? process.env;
  const kind = objectStoreKindFromEnv(opts.kind, env);

  if (kind === "fs") {
    return new FsObjectStore({
      root: join(opts.runtimeDir, ".objects"),
      signingKey: resolveSigningKey(opts.signingKeyPath, env),
    });
  }

  const missing = ([S3_ENV.endpoint, S3_ENV.bucket, S3_ENV.accessKeyId, S3_ENV.secretAccessKey] as const)
    .filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`${OBJECT_STORE_ENV}=s3 needs ${missing.join(", ")}`);
  }

  return new S3ObjectStore({
    endpoint: env[S3_ENV.endpoint]!,
    bucket: env[S3_ENV.bucket]!,
    // `auto` is R2's, and is what an unset region should mean given D5 answered R2. An S3
    // deployment sets a real one; a wrong region is a signature failure with a clear message
    // from AWS, which is a better outcome than guessing us-east-1 and half-working.
    region: env[S3_ENV.region] ?? "auto",
    accessKeyId: env[S3_ENV.accessKeyId]!,
    secretAccessKey: env[S3_ENV.secretAccessKey]!,
    sessionToken: env[S3_ENV.sessionToken],
    forcePathStyle: env[S3_ENV.forcePathStyle] !== "false",
  });
}

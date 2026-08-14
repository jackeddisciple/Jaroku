// Choosing a secret store. The only place in the codebase that does.
//
// The same shape as db/open.ts and storage/open.ts: one function, one environment variable, a
// local default that needs nothing, and a refusal rather than a fallback when the configuration
// is wrong. Falling back to `runtime/.env` when somebody asked for the vault means a server that
// starts, works, and writes every tenant's credentials into one shared file.

import type { Db } from "../db/db.ts";
import type { CredentialWriter } from "../envWriter.ts";
import { DotEnvSecretStore } from "./dotEnvSecretStore.ts";
import { KmsSecretStore } from "./kmsSecretStore.ts";
import { MASTER_KEY_ENV, resolveMasterKey } from "./masterKey.ts";
import type { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import type { RunWorkspaceResolver, SecretStore, SecretStoreKind } from "./secretStore.ts";

export const SECRET_STORE_ENV = "JAROKU_SECRET_STORE";

export interface OpenSecretStoreOptions {
  db: Db;
  /** The store-agnostic name registry. Both implementations record through it. */
  refs: SecretRefRepository;
  /** The one writer of `runtime/.env`. Used only by the local store. */
  writer: CredentialWriter;
  envPath: string;
  runWorkspace: RunWorkspaceResolver;
  providerFor?: (name: string) => string | null;
  /**
   * Told when a run received credentials, for the blast-radius view.
   *
   * Hosted store only. The local one answers from `process.env` and has no workspace to record
   * against — the same asymmetry that keeps `last_used_at` in memory there. See ADR-033.
   */
  onRuntimeRead?: (workspaceId: string, names: string[]) => Promise<void>;
  /** Overrides `JAROKU_SECRET_STORE`. Tests pass this rather than mutating the environment. */
  kind?: string;
  env?: NodeJS.ProcessEnv;
}

export function secretStoreKindFromEnv(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretStoreKind {
  const raw = (override ?? env[SECRET_STORE_ENV] ?? "dotenv").trim().toLowerCase();
  if (raw !== "dotenv" && raw !== "kms") {
    throw new Error(`${SECRET_STORE_ENV} must be "dotenv" or "kms", not "${raw}"`);
  }

  // THE LOCAL STORE IS A DEVELOPMENT STORE, refused in production for the same reason SQLite and
  // the local object store are — and with a sharper edge than either.
  //
  // `runtime/.env` is ONE FILE with no notion of a workspace in it. Every tenant on the box
  // would read every other tenant's provider keys, Slack tokens and database URLs out of the
  // same process environment, and nothing would error, and nothing would look wrong. It is not
  // a degraded mode; it is the absence of the boundary this whole session exists to build.
  if (raw === "dotenv" && env["NODE_ENV"] === "production") {
    throw new Error(
      `${SECRET_STORE_ENV}=dotenv refuses to run under NODE_ENV=production. runtime/.env is one ` +
        `file with no workspace in it, so every tenant would read every other tenant's ` +
        `credentials out of one process environment. Set ${SECRET_STORE_ENV}=kms and ` +
        `${MASTER_KEY_ENV}.`,
    );
  }
  return raw;
}

export function openSecretStore(opts: OpenSecretStoreOptions): SecretStore {
  const env = opts.env ?? process.env;
  const kind = secretStoreKindFromEnv(opts.kind, env);

  if (kind === "dotenv") {
    return new DotEnvSecretStore({
      writer: opts.writer,
      envPath: opts.envPath,
      providerFor: opts.providerFor,
      refs: opts.refs,
    });
  }

  return new KmsSecretStore({
    db: opts.db,
    // Throws when the master key is absent, which is the intended outcome: see masterKey.ts for
    // why there is deliberately no generated fallback.
    master: resolveMasterKey(env),
    refs: opts.refs,
    runWorkspace: opts.runWorkspace,
    providerFor: opts.providerFor,
    onRuntimeRead: opts.onRuntimeRead,
  });
}

// The hosted secret store: a per-workspace data key, envelope-encrypted, ciphertext in the
// database.
//
// Same interface as the local one and the same promises, so nothing above this can tell which
// it got. What it adds is the thing `runtime/.env` structurally cannot have: a workspace. Every
// row is scoped by one, every ciphertext is BOUND to one, and the two are different walls —
// the scope is what a query filters on and RLS backstops, and the binding is what makes going
// around both pointless, because a ciphertext moved to another workspace decrypts to nothing.
//
// THE KEY HIERARCHY, in the order a read walks it:
//
//   master key      — configuration, never in the database. See masterKey.ts.
//   data key        — one per workspace, per version. Wrapped by the master key, stored wrapped.
//   secret          — sealed by the data key, with `<workspace_id>:<name>` as authenticated
//                     data, so the row cannot be relabelled or relocated.
//
// ROTATION IS A LOOP, NOT AN OUTAGE. A new data key version is created and every secret is
// re-sealed under it, one at a time; a row still pointing at the old version stays readable the
// whole time, because a read uses the key the ROW names rather than the workspace's newest. The
// old version is retired at the end, not deleted, for the same reason.
//
// THE SAME REFUSALS AS THE LOCAL STORE, and that is deliberate rather than inherited. AES-GCM
// would happily seal a value containing a newline; the local store cannot, because the `.env`
// format has no escape for one. Accepting it here would mean a credential that works hosted and
// fails locally — the exact class of difference the two-implementation rule exists to prevent —
// and the exported project the README promises is portable writes a `.env` too.

import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/db.ts";
import { asInt } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { ElevationReceipt } from "./elevation.ts";
import type { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import {
  newDataKey, openWithDataKey, sealWithDataKey, type MasterKeyProvider,
} from "./masterKey.ts";
import {
  assertSecretName, unstorableReason, type RunWorkspaceResolver, type SecretRef,
  type SecretStore, type SetResult,
} from "./secretStore.ts";

export interface KmsSecretStoreOptions {
  db: Db;
  master: MasterKeyProvider;
  /** The store-agnostic name registry. What `listNames` answers from. */
  refs: SecretRefRepository;
  /** How a run id becomes a workspace. Null means "no such run", which means no secrets. */
  runWorkspace: RunWorkspaceResolver;
  /** What each name is for, when the caller knows. Display only. */
  providerFor?: (name: string) => string | null;
  /**
   * Told when a run actually received credentials, for the blast-radius view.
   *
   * Takes a workspace id rather than a context for the same reason `refs.touch` does: its caller
   * is the read path, which resolved one from a run and has no requesting context by then.
   * Optional, so the two suites that construct this store with nothing but a database still work.
   */
  onRuntimeRead?: (workspaceId: string, names: string[]) => Promise<void>;
}

interface DataKeyRow {
  id: string;
  version: number;
  master_key_id: string;
  wrapped_key: string;
}

export class KmsSecretStore implements SecretStore {
  readonly kind = "kms" as const;
  /**
   * Unwrapped data keys, by row id.
   *
   * In memory and never persisted. Unwrapping is a hash and a decrypt today and a network round
   * trip to a KMS tomorrow, and a run resolving six credentials would otherwise make six of
   * them. Keyed by the data key's ROW id rather than by workspace, so a rotation does not
   * invalidate a cache entry — the old key stays correct for the rows that still name it.
   */
  private unwrapped = new Map<string, Buffer>();

  constructor(private readonly opts: KmsSecretStoreOptions) {}

  private q(workspaceId: string): Queryable {
    return this.opts.db.forWorkspace(workspaceId);
  }

  async set(ctx: TenantContext, name: string, value: string): Promise<SetResult> {
    assertSecretName(name);
    const refusal = unstorableReason(value);
    if (refusal) return { ok: false, warning: refusal };

    const key = await this.currentDataKey(ctx.workspaceId);
    const ciphertext = sealWithDataKey(key.material, value, aadFor(ctx.workspaceId, name));
    const now = new Date().toISOString();
    await this.q(ctx.workspaceId).run(
      `INSERT INTO workspace_secrets
         (workspace_id, name, data_key_id, ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, name) DO UPDATE SET
         data_key_id = excluded.data_key_id,
         ciphertext  = excluded.ciphertext,
         updated_at  = excluded.updated_at`,
      [ctx.workspaceId, name, key.rowId, ciphertext, now, now],
    );
    await this.opts.refs.markConfigured(ctx, { name, provider: this.opts.providerFor?.(name) ?? null });
    // No warning to give. The local store's exists because a shell variable beats the file on
    // the next restart; nothing shadows a row.
    return { ok: true, warning: null };
  }

  async getForRun(runId: string, names: string[]): Promise<Record<string, string>> {
    const workspaceId = await this.opts.runWorkspace(runId);
    // No such run means no secrets. Never "all of them", and never the caller's own scope: a
    // run id that does not resolve is the one case where guessing is a cross-tenant leak.
    if (!workspaceId) return {};
    return this.decryptInto(workspaceId, names);
  }

  /** The decryption itself, shared by the two plaintext exits so they cannot drift apart in how
   *  they validate a name, which key version they open a row with, or what they record as a use. */
  private async decryptInto(workspaceId: string, names: string[]): Promise<Record<string, string>> {
    if (!names.length) return {};

    const wanted = names.filter((n) => {
      try {
        assertSecretName(n);
        return true;
      } catch {
        return false;
      }
    });
    if (!wanted.length) return {};

    const rows = await this.q(workspaceId).all<{ name: string; data_key_id: string; ciphertext: string }>(
      `SELECT name, data_key_id, ciphertext FROM workspace_secrets
        WHERE workspace_id = ? AND name IN (${wanted.map(() => "?").join(", ")})`,
      [workspaceId, ...wanted],
    );

    const out: Record<string, string> = {};
    for (const row of rows) {
      const material = await this.dataKeyById(workspaceId, row.data_key_id);
      // Decrypted with the key the ROW names, not the workspace's newest — during a rotation
      // those differ, and using the newest would fail on every row not reached yet.
      out[row.name] = openWithDataKey(material, row.ciphertext, aadFor(workspaceId, row.name));
    }

    // Usage is recorded in the registry rather than beside the ciphertext, so "when did a run
    // last receive this" is one fact in one place whichever store answered.
    const received = Object.keys(out);
    await this.opts.refs.touch(workspaceId, received);
    // AND WHERE, for the blast-radius view. Hooked HERE rather than at the request path because
    // eval runs and the queue worker never go through `index.ts` — recording at the caller would
    // have captured interactive runs only, which is the half least likely to be the one somebody
    // is trying to explain at three in the morning.
    //
    // Best-effort and never awaited into the read's failure: a run must not fail because a usage
    // row could not be written.
    if (this.opts.onRuntimeRead && received.length) {
      void this.opts.onRuntimeRead(workspaceId, received).catch((err) => {
        console.error("[secrets] could not record a runtime read:", (err as Error)?.message ?? err);
      });
    }
    return out;
  }

  /**
   * The same decryption, scoped by the asking CONTEXT rather than by a run.
   *
   * The only difference from `getForRun`, and it is the whole reason the two are separate
   * methods: there is no run to resolve a workspace from, because a generation or a judge
   * verdict is not a run. The context is the scope, exactly as it is for every other method on
   * this store — which is also why this one cannot be reached by anything holding only a run id,
   * and therefore cannot be used to read a workspace's key from inside a sandbox.
   */
  async getForPlatformCall(ctx: TenantContext, names: string[]): Promise<Record<string, string>> {
    return this.decryptInto(ctx.workspaceId, names);
  }

  /**
   * See `SecretStore.revealForUser` and ADR-035.
   *
   * The workspace comes off the RECEIPT, never from a caller's argument — which is what makes a
   * receipt for one workspace unable to open another's credential even when the name matches. That
   * is the same shape `getForRun` uses, and it is deliberate: the proof names the tenant.
   *
   * `decryptInto` is reused rather than reimplemented, so a revealed value goes through the same
   * AAD check as every other read. A ciphertext that was moved between workspaces or relabelled
   * fails to authenticate here exactly as it does on the run path.
   */
  async revealForUser(receipt: ElevationReceipt, name: string): Promise<string | null> {
    assertSecretName(name);
    const found = await this.decryptInto(receipt.workspaceId, [name]);
    return found[name] ?? null;
  }

  async listNames(ctx: TenantContext): Promise<SecretRef[]> {
    // From the registry, not from `workspace_secrets`. Two reasons: it is the answer the local
    // store gives too, so a client cannot tell which store it is talking to; and the ciphertext
    // column is never selected at all, so a value cannot reach a log line by way of an object
    // somebody stringified.
    const rows = await this.opts.refs.list(ctx);
    return rows
      .filter((r) => r.configured)
      .map((r) => ({ name: r.name, configured: true as const, provider: r.provider, lastUsedAt: r.last_used_at }));
  }

  async delete(ctx: TenantContext, name: string): Promise<void> {
    assertSecretName(name);
    await this.q(ctx.workspaceId).run(
      `DELETE FROM workspace_secrets WHERE workspace_id = ? AND name = ?`,
      [ctx.workspaceId, name],
    );
    // Cleared rather than forgotten — see the local store, and secretRefs.markCleared.
    await this.opts.refs.markCleared(ctx, name);
  }

  /**
   * Re-seal every one of this workspace's secrets under a fresh data key.
   *
   * Not on the `SecretStore` interface: the local store has no key to rotate, and putting a
   * method there that one implementation could only throw from would be an interface that lies.
   * Callers that rotate know which store they have.
   *
   * The order is what makes it safe. New key first, then each secret re-sealed, then the old
   * key retired. A crash at any point leaves rows readable — some under the old key, some under
   * the new — and re-running finishes the job, because a row already on the new key is simply
   * re-sealed under it again.
   */
  async rotate(ctx: TenantContext): Promise<{ version: number; resealed: number }> {
    const next = await this.createDataKey(ctx.workspaceId);
    const rows = await this.q(ctx.workspaceId).all<{ name: string; data_key_id: string; ciphertext: string }>(
      `SELECT name, data_key_id, ciphertext FROM workspace_secrets WHERE workspace_id = ?`,
      [ctx.workspaceId],
    );

    let resealed = 0;
    for (const row of rows) {
      const old = await this.dataKeyById(ctx.workspaceId, row.data_key_id);
      const plaintext = openWithDataKey(old, row.ciphertext, aadFor(ctx.workspaceId, row.name));
      await this.q(ctx.workspaceId).run(
        `UPDATE workspace_secrets SET data_key_id = ?, ciphertext = ?, updated_at = ?
          WHERE workspace_id = ? AND name = ?`,
        [
          next.rowId,
          sealWithDataKey(next.material, plaintext, aadFor(ctx.workspaceId, row.name)),
          new Date().toISOString(),
          ctx.workspaceId,
          row.name,
        ],
      );
      resealed++;
    }

    await this.q(ctx.workspaceId).run(
      `UPDATE workspace_data_keys SET retired_at = ?
        WHERE workspace_id = ? AND version < ? AND retired_at IS NULL`,
      [new Date().toISOString(), ctx.workspaceId, next.version],
    );
    return { version: next.version, resealed };
  }

  // --- the data keys ------------------------------------------------------------------------

  /** The newest un-retired key, creating the workspace's first one if it has none. */
  private async currentDataKey(workspaceId: string): Promise<{ rowId: string; version: number; material: Buffer }> {
    const row = await this.q(workspaceId).get<DataKeyRow>(
      `SELECT id, version, master_key_id, wrapped_key FROM workspace_data_keys
        WHERE workspace_id = ? AND retired_at IS NULL
        ORDER BY version DESC`,
      [workspaceId],
    );
    if (!row) return this.createDataKey(workspaceId);
    return {
      rowId: String(row.id),
      version: asInt(row.version, 1),
      material: await this.unwrap(String(row.id), String(row.master_key_id), String(row.wrapped_key)),
    };
  }

  private async createDataKey(workspaceId: string): Promise<{ rowId: string; version: number; material: Buffer }> {
    const material = newDataKey();
    const rowId = randomUUID();
    const wrapped = await this.opts.master.wrap(material);
    const top = await this.q(workspaceId).get<{ top: unknown }>(
      `SELECT MAX(version) AS top FROM workspace_data_keys WHERE workspace_id = ?`,
      [workspaceId],
    );
    const version = asInt(top?.top, 0) + 1;
    await this.q(workspaceId).run(
      `INSERT INTO workspace_data_keys (id, workspace_id, version, master_key_id, wrapped_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rowId, workspaceId, version, this.opts.master.id, wrapped, new Date().toISOString()],
    );
    this.unwrapped.set(rowId, material);
    return { rowId, version, material };
  }

  private async dataKeyById(workspaceId: string, id: string): Promise<Buffer> {
    const cached = this.unwrapped.get(id);
    if (cached) return cached;
    // Scoped to the workspace even though the id is a uuid. A data key row is reached by id in
    // exactly one place — here — and an unscoped lookup would be the one query in this file
    // that could read another tenant's row, which is precisely how it would be the one that
    // eventually did.
    const row = await this.q(workspaceId).get<DataKeyRow>(
      `SELECT id, version, master_key_id, wrapped_key FROM workspace_data_keys
        WHERE workspace_id = ? AND id = ?`,
      [workspaceId, id],
    );
    if (!row) throw new Error(`the data key this secret was sealed with is missing (${id})`);
    return this.unwrap(id, String(row.master_key_id), String(row.wrapped_key));
  }

  private async unwrap(rowId: string, masterKeyId: string, wrapped: string): Promise<Buffer> {
    const material = await this.opts.master.unwrap(wrapped, masterKeyId);
    this.unwrapped.set(rowId, material);
    return material;
  }
}

/**
 * What a ciphertext is bound to.
 *
 * The workspace and the name, together. Either alone would leave a hole: workspace-only lets a
 * row be renamed to another variable within the same tenant — `SLACK_BOT_TOKEN` relabelled as
 * `ANTHROPIC_API_KEY` and injected into a run that then sends it to the wrong host — and
 * name-only lets a row be copied between tenants.
 */
function aadFor(workspaceId: string, name: string): string {
  return `${workspaceId}:${name}`;
}

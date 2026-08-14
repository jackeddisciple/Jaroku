// Moving the provider keys people already have into the shape the Secrets tab reads.
//
// WHAT IS ACTUALLY MOVING, because it is much less than it sounds. The keys are already in the
// vault: onboarding wrote them through `SecretStore.set` under `ANTHROPIC_API_KEY` and
// `OPENAI_API_KEY`, and `secret_refs` already has a row per name. What they lack is the metadata
// migration 033 added — `kind`, and a mask to render.
//
// SO THE POINTER MOVES AND THE PLAINTEXT DOES NOT. This job never calls `getForRun`,
// `getForPlatformCall` or `revealForUser`. It reads names and writes classifications. That is not
// an optimisation: a migration that decrypted six thousand workspaces' credentials to compute a
// cosmetic hint would be the largest concentration of plaintext this system has ever created, and
// it would exist for the duration of a batch job nobody is watching.
//
// WHICH IS WHY THE HINT IS GENERIC. `masked_hint` cannot be derived without the value, so a
// migrated key gets `••••••••` — the same mask everything without a recognisable shape gets. The
// real hint appears the next time the key is rotated, which is the first moment a plaintext is
// legitimately in hand. A cosmetic detail is not worth a decrypt path.
//
// IDEMPOTENT, AND THAT IS A PROPERTY RATHER THAN A HOPE. Every write is conditional on the row
// still being unclassified, so a second run reports zero changes. Re-running after a partial
// failure resumes; re-running after a complete one does nothing.
//
// ONE AUDIT ROW PER WORKSPACE, not per key. A workspace with two keys produces one line saying
// what happened to it — the brief asks for this, and a per-key row would bury a real event under
// bookkeeping.

import type { Db } from "../db/db.ts";
import type { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import type { IdentityRepository } from "../db/repositories/identity.ts";
import { systemContextFor, newRequestId } from "../db/tenant.ts";
import { GENERIC_MASK } from "./mask.ts";
import { PROVIDER_ENV_KEY } from "../providers.ts";

/** The names this job claims. Read from the provider table, so a new provider is covered for free. */
const PROVIDER_KEY_NAMES = new Set<string>(Object.values(PROVIDER_ENV_KEY));

export interface MigrationOptions {
  db: Db;
  refs: SecretRefRepository;
  identity?: IdentityRepository;
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface MigrationReport {
  workspacesSeen: number;
  workspacesChanged: number;
  keysClassified: number;
  /** Rows already carrying `kind='provider_key'`. On a second run this is everything. */
  alreadyDone: number;
}

/**
 * Classify every stored provider key, in every workspace.
 *
 * Walks workspaces rather than `secret_refs` directly so the repository — and therefore the RLS
 * scope on Postgres — is doing the reading. A bare cross-tenant SELECT here would work on SQLite,
 * return nothing on Postgres, and report success either way.
 */
export async function migrateProviderKeys(opts: MigrationOptions): Promise<MigrationReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const report: MigrationReport = { workspacesSeen: 0, workspacesChanged: 0, keysClassified: 0, alreadyDone: 0 };

  const workspaces = await opts.db.all<{ id: string }>(
    `SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at`,
  );

  for (const { id: workspaceId } of workspaces) {
    report.workspacesSeen++;
    const ctx = systemContextFor(workspaceId, newRequestId());
    const rows = await opts.refs.list(ctx);
    const candidates = rows.filter((r) => PROVIDER_KEY_NAMES.has(r.name));
    if (!candidates.length) continue;

    const toClassify = candidates.filter((r) => r.kind !== "provider_key");
    report.alreadyDone += candidates.length - toClassify.length;
    if (!toClassify.length) continue;

    if (opts.dryRun) {
      log(`[migrate] would classify ${toClassify.map((r) => r.name).join(", ")} in ${workspaceId}`);
      report.workspacesChanged++;
      report.keysClassified += toClassify.length;
      continue;
    }

    for (const row of toClassify) {
      await opts.refs.setMetadata(ctx, row.name, {
        kind: "provider_key",
        // Only when there is nothing there. A row that somehow already has a real mask keeps it —
        // overwriting a good hint with a generic one is a regression this job can cause and
        // nothing else can undo without a rotation.
        ...(row.masked_hint ? {} : { maskedHint: GENERIC_MASK }),
        // `unknown`, not `valid`: nothing has probed this key. Claiming valid would put a green
        // tick beside a credential that may have been revoked at the provider months ago, and the
        // tab's whole job is telling somebody which of those they have.
        ...(row.status === "unknown" ? { status: "unknown" } : {}),
      });
      report.keysClassified++;
    }
    report.workspacesChanged++;

    // ONE ROW PER WORKSPACE. `created_at` on the secret is untouched throughout — this job
    // classifies what is already there and never re-creates it.
    await opts.identity?.appendAudit(ctx, {
      workspaceId,
      action: "secrets.provider_keys_migrated",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { names: toClassify.map((r) => r.name), count: toClassify.length },
    });
  }

  log(
    `[migrate] ${report.workspacesSeen} workspace(s); ` +
      `${report.keysClassified} key(s) classified in ${report.workspacesChanged}; ` +
      `${report.alreadyDone} already done` +
      (opts.dryRun ? " (dry run — nothing was written)" : ""),
  );
  return report;
}

/**
 * Which name a provider's key is resolved from, checking the new classification first.
 *
 * DUAL-READ, FOR ONE RELEASE. The name is the same on both sides — this has always been
 * `(workspace_id, name)` — so what "the old location" means here is "a row nobody has classified".
 * Resolution finds a classified row first and falls back to an unclassified one under the expected
 * name, so a workspace the job has not reached yet keeps working exactly as it did.
 *
 * The fallback comes out when telemetry shows it is never taken. `usedFallback` is what that
 * telemetry reads: a caller can count how often the second branch answered, and remove this
 * function when the count is zero.
 */
export async function resolveProviderKeyName(
  refs: SecretRefRepository,
  ctx: ReturnType<typeof systemContextFor>,
  envKey: string,
): Promise<{ name: string | null; usedFallback: boolean }> {
  const row = await refs.get(ctx, envKey);
  if (!row?.configured) return { name: null, usedFallback: false };
  return { name: row.name, usedFallback: row.kind !== "provider_key" };
}

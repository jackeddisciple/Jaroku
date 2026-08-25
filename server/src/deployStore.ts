// Deploy layer data model (doc §8, Weeks 11–12) — additive control-plane tables only.
//
// THE FROZEN SCHEMA IS UNTOUCHED. schema/events.md v1 stays exactly as it is, and a deploy is
// not a new event type: it is not an agent run at all. Nothing here touches `runs` or `steps`.
// This is the same discipline pause/resume, the eval engine and the MCP registry each
// followed — when a feature needed data the frozen schema does not carry, it went into new
// tables beside it.
//
// Three modelling decisions, each with a specific failure behind it:
//
//   * A row is written BEFORE the first Railway call, not after one succeeds. A deploy
//     creates real resources in somebody's real account and can be interrupted at any point,
//     so a record that only appears on success turns a crash into a project and a service
//     nothing in Jaroku knows about. Rows first means an interrupted deploy is a visible
//     deploy. Same reasoning as eval_jobs being persisted before dispatch.
//
//   * `env_keys` holds NAMES. There is deliberately no column a credential value fits in, so
//     "the database never sees a secret" is a property of the schema rather than a rule
//     somebody has to remember. Mirrors mcp_servers.auth_env_key.
//
//   * Log lines are stored already scrubbed. Railway echoes build output, so a value could
//     arrive in one; redacting on the way in means it is redacted in the table, in the
//     broadcast, and in anything read back later — rather than in whichever of the three
//     someone remembered.

import { randomUUID } from "node:crypto";
import { asInt, asIntOrNull, jsonFromColumn, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

// --- status ------------------------------------------------------------------

/**
 * queued      → the record exists; nothing has been created anywhere yet
 * packaging   → writing the deploy artifacts into the project
 * uploading   → the source is going to the host
 * building    → the host is building the image
 * deploying   → the image is built; the host is starting it
 * live        → serving, with a URL
 * failed      → terminal, with a reason
 * cancelled   → terminal, the user stopped it
 * interrupted → terminal, the server died while it was in flight (see reconcile)
 * superseded  → terminal, a later deploy replaced it on the same Railway service
 * removed     → terminal, the user detached the record from Jaroku
 */
export type DeployStatus =
  | "queued" | "packaging" | "uploading" | "building" | "deploying"
  | "live" | "failed" | "cancelled" | "interrupted" | "superseded" | "removed";

/** Statuses a deploy can still leave under its own power. */
export const IN_FLIGHT: ReadonlySet<DeployStatus> = new Set<DeployStatus>([
  "queued", "packaging", "uploading", "building", "deploying",
]);

/** Statuses that mean "this agent is deployed right now". */
export const ACTIVE: ReadonlySet<DeployStatus> = new Set<DeployStatus>(["live"]);

export function isInFlight(status: DeployStatus): boolean {
  return IN_FLIGHT.has(status);
}

// --- row shapes --------------------------------------------------------------

export interface Deployment {
  id: string;
  agent_id: string;
  /** The hosting target. "railway" is the only one today; the column is here so it stays one. */
  target: string;
  status: DeployStatus;
  /** The live URL. Null until the host has one — never a guess at what it will be. */
  url: string | null;
  provider: string;
  model: string;
  /**
   * The NAMES of the environment variables handed to the host, as a JSON array.
   * Never values. There is no column here that could hold one.
   */
  env_keys: string[];
  railway_project_id: string | null;
  railway_service_id: string | null;
  railway_environment_id: string | null;
  railway_deployment_id: string | null;
  /**
   * The agent version this deploy built from, or null.
   *
   * MIGRATION 041 ADDED THE COLUMN AND NOTHING EVER READ OR WROTE IT. Its own header says why it is
   * worth having — a marker pinned to the version that is LIVE cannot be inferred from a timestamp
   * once somebody publishes while a deploy is in flight — and then the store's column list did not
   * name it, so `deployments.version` was NULL on every row this product has ever written.
   *
   * §5.2's drift badge is what needed it: `v5 -> v9` is the deployed version against the current
   * one, and without this half the card could only ever say "live" and never "behind". Recorded at
   * creation, from the version the deploy is about to build.
   *
   * NULL STILL MEANS "NOBODY RECORDED THIS", and 041 is explicit that it is never backfilled: a
   * guess here is a confident lie about somebody's production. `agentHealth.driftOf` draws no badge
   * for a null, which is the honest rendering of a fact nobody wrote down.
   */
  version: number | null;
  error: string | null;
  /**
   * Who started this deploy, or null for one that predates the column.
   *
   * §13's Exposure section is what needed it — "show who deployed it and when" was unanswerable,
   * because nothing in this schema recorded a person and there is no audit row for a deploy to
   * read one out of either. NEVER BACKFILLED, exactly as `version` above is not: a name beside a
   * public URL that nobody actually chose to publish is worse than an honest "unrecorded".
   */
  created_by: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface DeployLogLine {
  deployment_id: string;
  seq: number;
  ts: string;
  /** Which phase produced it — so the UI can group without parsing the text. */
  stage: string;
  /** "jaroku" for our own narration, "build"/"deploy" for the host's output. */
  stream: string;
  /** Already scrubbed of every secret this deploy handled. See deploySecrets.scrubSecrets. */
  text: string;
}

export interface CreateDeployment {
  agentId: string;
  provider: string;
  model: string;
  envKeys: string[];
  target?: string;
  /** The agent's current version at the moment the deploy starts. See `Deployment.version`. */
  version?: number | null;
  /** Who pressed it. See `Deployment.created_by` — absent for a background reconciliation. */
  createdBy?: string | null;
}

export interface DeploymentPatch {
  status?: DeployStatus;
  url?: string | null;
  error?: string | null;
  railway_project_id?: string | null;
  railway_service_id?: string | null;
  railway_environment_id?: string | null;
  railway_deployment_id?: string | null;
}

/** Where a redeploy of an agent should go, if it has somewhere to go back to. */
export interface RailwayTarget {
  projectId: string;
  serviceId: string;
  environmentId: string;
}

// --- store -------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

/**
 * Columns `patch()` may write.
 *
 * Deliberately not derived from DeploymentPatch — a type cannot check anything at runtime,
 * and the columns this must never touch (`id`, `agent_id`, `created_at`) are exactly the ones
 * that identify the row being patched.
 */
const PATCHABLE: ReadonlySet<string> = new Set([
  "status", "url", "error",
  "railway_project_id", "railway_service_id", "railway_environment_id", "railway_deployment_id",
]);

// Explicit column lists — a deployment goes onto the deploy channel, and workspace_id has no
// business there.
const DEPLOY_COLUMNS = `id, agent_id, target, status, url, provider, model, env_keys, version,
                        railway_project_id, railway_service_id, railway_environment_id,
                        railway_deployment_id, error, created_by, created_at, updated_at, ended_at`;

/** How much of a deploy's log is kept. A build log is diagnostic, not an archive. */
const LOG_CAP = 2000;

export class DeployStore {
  // Shares the trace store's database: same file, single writer. See TraceStore.database().
  constructor(private db: Db) {}

  /** SQLite only — on Postgres these tables come from the numbered migrations. */
  /** Compatibility fixes for a database that predates a column. See TraceStore.init. */
  async init(): Promise<void> {
    if (this.db.dialect !== "sqlite") return;
    // Insertion order, made explicit — see `list()` for why the tie-break matters.
    //
    // It used to be SQLite's hidden `rowid`, which does not exist in Postgres and has no
    // stable equivalent there. Existing rows are backfilled FROM rowid, so no list reorders.
    if (await this.ensureColumn("deployments", "created_seq", "INTEGER NOT NULL DEFAULT 0")) {
      await this.db.exec(`UPDATE deployments SET created_seq = rowid`);
    }
  }

  /**
   * Idempotent ADD COLUMN — CREATE TABLE IF NOT EXISTS never alters an existing table.
   * Returns whether it added one, so a caller can backfill only when it did.
   */
  private async ensureColumn(table: string, column: string, decl: string): Promise<boolean> {
    const cols = await this.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.some((c) => c.name === column)) return false;
    await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    return true;
  }

  /**
   * The database, scoped to a request's workspace.
   *
   * Every read and write in this class goes through it, so on Postgres each statement carries
   * the SET LOCAL the RLS policies read. On SQLite it is the connection itself — no RLS to
   * scope — which is why the substitution is uniform and costs that driver nothing.
   */
  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): Deployment {
    // SQLite stores TEXT and Postgres `json`; jsonFromColumn is told which. A row whose
    // env_keys cannot be read still describes a real deployment, so it is shown with none
    // rather than hidden — the names are a convenience, the record is the point.
    const parsed = jsonFromColumn(this.db.dialect, row["env_keys"]);
    const envKeys = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
    // `asIntOrNull`, not `asInt`, and the difference is the whole of migration 041's argument: a row
    // written before that column existed has no version, and `0` would be a confident claim that it
    // was deployed from a version that cannot exist.
    return { ...(row as unknown as Deployment), env_keys: envKeys, version: asIntOrNull(row["version"]) };
  }

  // --- writes ---

  /**
   * Record a deploy before anything exists anywhere. Returns the row.
   *
   * `queued` is the only status this can produce: the point of writing first is that the row
   * predates every resource, so it cannot claim to be further along than it is.
   */
  async create(ctx: TenantContext, opts: CreateDeployment): Promise<Deployment> {
    const now = nowIso();
    const row: Deployment = {
      id: randomUUID(),
      agent_id: opts.agentId,
      target: opts.target ?? "railway",
      status: "queued",
      url: null,
      provider: opts.provider,
      model: opts.model,
      env_keys: [...opts.envKeys],
      railway_project_id: null,
      railway_service_id: null,
      railway_environment_id: null,
      railway_deployment_id: null,
      version: opts.version ?? null,
      error: null,
      created_by: opts.createdBy ?? null,
      created_at: now,
      updated_at: now,
      ended_at: null,
    };
    // The sequence read and the insert are one transaction: two deploys started together
    // would otherwise read the same maximum and claim the same position, which is exactly
    // the tie `created_seq` exists to break.
    await this.db.scoped(ctx.workspaceId, async (tx: Queryable) => {
      const top = await tx.get<{ n: unknown }>(
        `SELECT COALESCE(MAX(created_seq), 0) AS n FROM deployments WHERE workspace_id = ?`,
        [ctx.workspaceId],
      );
      await tx.run(
        `INSERT INTO deployments
           (id, workspace_id, agent_id, target, status, url, provider, model, env_keys, version,
            created_by, created_at, updated_at, created_seq)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, ctx.workspaceId, row.agent_id, row.target, row.status,
          row.provider, row.model, JSON.stringify(row.env_keys), row.version, row.created_by, now, now,
          asInt(top?.n) + 1,
        ],
      );
    });
    return row;
  }

  /**
   * Patch a deployment. `ended_at` is stamped by the status, never by the caller — a terminal
   * row without an end time and an in-flight row with one are both lies the schema should not
   * be able to tell.
   */
  async patch(ctx: TenantContext, id: string, changes: DeploymentPatch): Promise<Deployment | null> {
    const current = await this.get(ctx, id);
    if (!current) return null;

    const sets: string[] = ["updated_at = ?"];
    const values: (string | null)[] = [nowIso()];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      // Whitelisted, because this builds SQL out of object keys. TypeScript keeps the
      // in-tree callers honest and does nothing at runtime: passing `{ id: "…" }` rewrote the
      // primary key, and the deploy driving that row went on patching an id that no longer
      // existed while the record it thought it was updating had silently become unreachable.
      // A key that is not a column is a bug in the caller, so it says so rather than
      // half-applying the rest of the patch around it.
      if (!PATCHABLE.has(key)) {
        throw new Error(`deployments.${key} is not a patchable column`);
      }
      sets.push(`${key} = ?`);
      values.push(value as string | null);
    }

    if (changes.status) {
      const terminal = !isInFlight(changes.status);
      // Re-entering a terminal status must not move the end time; leaving one clears it.
      sets.push("ended_at = ?");
      values.push(terminal ? (current.ended_at ?? nowIso()) : null);
    }

    values.push(id, ctx.workspaceId);
    await this.q(ctx).run(
      `UPDATE deployments SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
      values,
    );
    return this.get(ctx, id);
  }

  /**
   * Append a log line. Returns its seq.
   *
   * The text must already be scrubbed — this store is not the place that knows what the
   * secrets were, and a redaction step that lives here would be one somebody could bypass by
   * writing to the table directly.
   */
  async appendLog(
    ctx: TenantContext,
    deploymentId: string,
    stage: string,
    stream: string,
    text: string,
  ): Promise<number> {
    // Read-then-insert in one transaction: build output arrives in bursts and two lines
    // racing for the same seq would collide on the (deployment_id, seq) primary key.
    return this.db.scoped(ctx.workspaceId, async (tx: Queryable) => {
      const row = await tx.get<{ max_seq: unknown }>(
        "SELECT MAX(seq) AS max_seq FROM deployment_logs WHERE deployment_id = ? AND workspace_id = ?",
        [deploymentId, ctx.workspaceId],
      );
      const seq = (asIntOrNull(row?.max_seq) ?? -1) + 1;
      await tx.run(
        `INSERT INTO deployment_logs (workspace_id, deployment_id, seq, ts, stage, stream, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ctx.workspaceId, deploymentId, seq, nowIso(), stage, stream, text],
      );

      // A build log is diagnostic, not an archive. Trim the oldest rather than growing
      // forever in a database whose other tables are traces the user actually goes back to.
      if (seq > 0 && seq % 200 === 0) {
        await tx.run(
          `DELETE FROM deployment_logs WHERE deployment_id = ? AND workspace_id = ? AND seq <= ?`,
          [deploymentId, ctx.workspaceId, seq - LOG_CAP],
        );
      }
      return seq;
    });
  }

  /**
   * Mark every in-flight deploy as interrupted. Called once at startup.
   *
   * A deploy is driven by this process, so a row still reading `building` after a restart is
   * not building — nothing is watching it. Saying `interrupted` is honest and actionable
   * ("check your Railway dashboard"); leaving it claiming to be in flight forever is neither.
   * Mirrors the eval engine cancelling unfinished eval runs on boot.
   */
  /**
   * Settle this workspace's in-flight deploys. Called once per workspace at startup.
   *
   * Scoped, and it used to not be. An unscoped query returns nothing under RLS as the
   * application role, so on the production configuration a deploy interrupted by a restart
   * stayed "building" forever with nothing saying so — the exact state this exists to
   * prevent. The caller walks the workspace list; `workspaces` carries no policy.
   */
  async reconcileInterrupted(ctx: TenantContext): Promise<Deployment[]> {
    const stale = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${DEPLOY_COLUMNS} FROM deployments
        WHERE workspace_id = ? AND status IN (${[...IN_FLIGHT].map(() => "?").join(",")})`,
      [ctx.workspaceId, ...IN_FLIGHT],
    );
    for (const row of stale) {
      await this.patch(ctx, row["id"] as string, {
        status: "interrupted",
        error:
          "the Jaroku server restarted while this deploy was in flight. Anything already " +
          "created still exists in your Railway account — check it there before retrying.",
      });
    }
    return stale.map((r) => this.hydrate(r));
  }

  // --- reads ---

  async get(ctx: TenantContext, id: string): Promise<Deployment | null> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${DEPLOY_COLUMNS} FROM deployments WHERE id = ? AND workspace_id = ?`,
      [id, ctx.workspaceId],
    );
    return row ? this.hydrate(row) : null;
  }

  /**
   * Newest first. The whole list is small — one row per deploy the user has ever run.
   *
   * `created_seq DESC` breaks ties, and the tie is not hypothetical: created_at is an ISO
   * string with millisecond resolution, and redeploying twice in the same millisecond (a
   * test, a double-click, a retry loop) made "the most recent deployment" whichever row the
   * database happened to return first. That is the value the sidebar shows and the Deploy
   * panel selects, so a coin flip there is a row that reports the wrong status.
   *
   * It used to be SQLite's `rowid`. That is not portable — Postgres has no stable physical
   * row identifier — so insertion order became a column of its own rather than a property
   * borrowed from one storage engine's internals.
   */
  async list(ctx: TenantContext): Promise<Deployment[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${DEPLOY_COLUMNS} FROM deployments
        WHERE workspace_id = ? AND status != 'removed'
        ORDER BY created_at DESC, created_seq DESC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  async listForAgent(ctx: TenantContext, agentId: string): Promise<Deployment[]> {
    return (await this.list(ctx)).filter((d) => d.agent_id === agentId);
  }

  /**
   * The deployment that represents an agent's current state: the one in flight if there is
   * one, otherwise the most recent. What the sidebar's Deployed filter reads.
   */
  async currentForAgent(ctx: TenantContext, agentId: string): Promise<Deployment | null> {
    const mine = await this.listForAgent(ctx, agentId);
    return mine.find((d) => isInFlight(d.status)) ?? mine[0] ?? null;
  }

  /** Agent id → its current deployment. One query for a whole agent list. */
  async currentByAgent(ctx: TenantContext): Promise<Map<string, Deployment>> {
    const out = new Map<string, Deployment>();
    // list() is newest-first, so the first row seen for an agent is its most recent.
    for (const d of await this.list(ctx)) {
      const existing = out.get(d.agent_id);
      if (!existing || (isInFlight(d.status) && !isInFlight(existing.status))) {
        out.set(d.agent_id, d);
      }
    }
    return out;
  }

  /**
   * The Railway project and service this agent was last deployed into, if any.
   *
   * A redeploy belongs in the SAME service. Creating a new project every time leaves the
   * previous one running and billing, with a URL the user was given and Jaroku still lists as
   * live — two services, two bills, and no way to tell which URL is the current one.
   *
   * Rows that never got as far as provisioning have no ids and are skipped; `removed` is
   * skipped too, since detaching a record is the user saying they no longer want it followed.
   */
  async reusableTarget(ctx: TenantContext, agentId: string): Promise<RailwayTarget | null> {
    for (const d of await this.listForAgent(ctx, agentId)) {
      if (d.railway_project_id && d.railway_service_id && d.railway_environment_id) {
        return {
          projectId: d.railway_project_id,
          serviceId: d.railway_service_id,
          environmentId: d.railway_environment_id,
        };
      }
    }
    return null;
  }

  /**
   * Mark earlier deployments of the same Railway service as replaced.
   *
   * Without this a redeploy leaves two rows claiming to be live, which is not a display
   * problem — it is two different URLs both described as the current one. Returns how many
   * were superseded.
   */
  async supersede(ctx: TenantContext, keepId: string, serviceId: string): Promise<number> {
    let count = 0;
    for (const d of await this.list(ctx)) {
      if (d.id === keepId || d.railway_service_id !== serviceId) continue;
      if (d.status !== "live") continue;
      await this.patch(ctx, d.id, { status: "superseded" });
      count++;
    }
    return count;
  }

  async logs(ctx: TenantContext, deploymentId: string, sinceSeq = -1): Promise<DeployLogLine[]> {
    return (await this.q(ctx).all(
      `SELECT deployment_id, seq, ts, stage, stream, text FROM deployment_logs
        WHERE deployment_id = ? AND workspace_id = ? AND seq > ?
        ORDER BY seq ASC`,
      [deploymentId, ctx.workspaceId, sinceSeq],
    )) as unknown as DeployLogLine[];
  }

  /** Any deploy this process should consider itself to be running. */
  async inFlight(ctx: TenantContext): Promise<Deployment[]> {
    return (await this.list(ctx)).filter((d) => isInFlight(d.status));
  }
}

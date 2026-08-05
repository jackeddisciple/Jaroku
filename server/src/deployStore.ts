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

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

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
 * removed     → terminal, the user detached the record from Jaroku
 */
export type DeployStatus =
  | "queued" | "packaging" | "uploading" | "building" | "deploying"
  | "live" | "failed" | "cancelled" | "interrupted" | "removed";

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
  error: string | null;
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

// --- store -------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

/** How much of a deploy's log is kept. A build log is diagnostic, not an archive. */
const LOG_CAP = 2000;

export class DeployStore {
  // Shares TraceStore's handle: same file, single writer. See TraceStore.connection().
  constructor(private db: DatabaseSync) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployments (
        id                     TEXT PRIMARY KEY,
        agent_id               TEXT NOT NULL,
        target                 TEXT NOT NULL,
        status                 TEXT NOT NULL,
        url                    TEXT,
        provider               TEXT NOT NULL,
        model                  TEXT NOT NULL,
        env_keys               TEXT NOT NULL DEFAULT '[]',
        railway_project_id     TEXT,
        railway_service_id     TEXT,
        railway_environment_id TEXT,
        railway_deployment_id  TEXT,
        error                  TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        ended_at               TEXT
      );
      CREATE TABLE IF NOT EXISTS deployment_logs (
        deployment_id TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        ts            TEXT NOT NULL,
        stage         TEXT NOT NULL,
        stream        TEXT NOT NULL,
        text          TEXT NOT NULL,
        PRIMARY KEY (deployment_id, seq),
        FOREIGN KEY (deployment_id) REFERENCES deployments(id)
      );
      CREATE INDEX IF NOT EXISTS idx_deployments_agent  ON deployments(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
    `);
  }

  // No additive migrations yet — these tables are new. When one is needed, copy the
  // `ensureColumn` helper from store.ts:65 / evalStore.ts:257: CREATE TABLE IF NOT EXISTS
  // never alters an existing table.

  private static hydrate(row: Record<string, unknown>): Deployment {
    let envKeys: string[] = [];
    if (typeof row["env_keys"] === "string") {
      try {
        const parsed = JSON.parse(row["env_keys"]);
        if (Array.isArray(parsed)) envKeys = parsed.filter((k): k is string => typeof k === "string");
      } catch {
        /* a row we cannot parse still describes a real deployment — show it with no keys */
      }
    }
    return { ...(row as unknown as Deployment), env_keys: envKeys };
  }

  // --- writes ---

  /**
   * Record a deploy before anything exists anywhere. Returns the row.
   *
   * `queued` is the only status this can produce: the point of writing first is that the row
   * predates every resource, so it cannot claim to be further along than it is.
   */
  create(opts: CreateDeployment): Deployment {
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
      error: null,
      created_at: now,
      updated_at: now,
      ended_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO deployments
           (id, agent_id, target, status, url, provider, model, env_keys, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.agent_id, row.target, row.status,
        row.provider, row.model, JSON.stringify(row.env_keys), now, now,
      );
    return row;
  }

  /**
   * Patch a deployment. `ended_at` is stamped by the status, never by the caller — a terminal
   * row without an end time and an in-flight row with one are both lies the schema should not
   * be able to tell.
   */
  patch(id: string, changes: DeploymentPatch): Deployment | null {
    const current = this.get(id);
    if (!current) return null;

    const sets: string[] = ["updated_at = ?"];
    const values: (string | null)[] = [nowIso()];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value as string | null);
    }

    if (changes.status) {
      const terminal = !isInFlight(changes.status);
      // Re-entering a terminal status must not move the end time; leaving one clears it.
      sets.push("ended_at = ?");
      values.push(terminal ? (current.ended_at ?? nowIso()) : null);
    }

    values.push(id);
    this.db.prepare(`UPDATE deployments SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  /**
   * Append a log line. Returns its seq.
   *
   * The text must already be scrubbed — this store is not the place that knows what the
   * secrets were, and a redaction step that lives here would be one somebody could bypass by
   * writing to the table directly.
   */
  appendLog(deploymentId: string, stage: string, stream: string, text: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS max_seq FROM deployment_logs WHERE deployment_id = ?")
      .get(deploymentId) as { max_seq: number | null } | undefined;
    const seq = (row?.max_seq ?? -1) + 1;
    this.db
      .prepare(
        `INSERT INTO deployment_logs (deployment_id, seq, ts, stage, stream, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(deploymentId, seq, nowIso(), stage, stream, text);

    // A build log is diagnostic, not an archive. Trim the oldest rather than growing forever
    // in a database whose other tables are traces the user actually goes back to.
    if (seq > 0 && seq % 200 === 0) {
      this.db
        .prepare(
          `DELETE FROM deployment_logs
            WHERE deployment_id = ? AND seq <= ?`,
        )
        .run(deploymentId, seq - LOG_CAP);
    }
    return seq;
  }

  /**
   * Mark every in-flight deploy as interrupted. Called once at startup.
   *
   * A deploy is driven by this process, so a row still reading `building` after a restart is
   * not building — nothing is watching it. Saying `interrupted` is honest and actionable
   * ("check your Railway dashboard"); leaving it claiming to be in flight forever is neither.
   * Mirrors the eval engine cancelling unfinished eval runs on boot.
   */
  reconcileInterrupted(): Deployment[] {
    const stale = this.db
      .prepare(
        `SELECT * FROM deployments WHERE status IN (${[...IN_FLIGHT].map(() => "?").join(",")})`,
      )
      .all(...IN_FLIGHT) as Record<string, unknown>[];
    for (const row of stale) {
      this.patch(row["id"] as string, {
        status: "interrupted",
        error:
          "the Jaroku server restarted while this deploy was in flight. Anything already " +
          "created still exists in your Railway account — check it there before retrying.",
      });
    }
    return stale.map((r) => DeployStore.hydrate(r));
  }

  // --- reads ---

  get(id: string): Deployment | null {
    const row = this.db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? DeployStore.hydrate(row) : null;
  }

  /**
   * Newest first. The whole list is small — one row per deploy the user has ever run.
   *
   * `rowid DESC` breaks ties, and the tie is not hypothetical: created_at is an ISO string
   * with millisecond resolution, and redeploying twice in the same millisecond (a test, a
   * double-click, a retry loop) made "the most recent deployment" whichever row SQLite
   * happened to return first. That is the value the sidebar shows and the Deploy panel
   * selects, so a coin flip there is a row that reports the wrong status. rowid is insertion
   * order and always ascends.
   */
  list(): Deployment[] {
    const rows = this.db
      .prepare("SELECT * FROM deployments WHERE status != 'removed' ORDER BY created_at DESC, rowid DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => DeployStore.hydrate(r));
  }

  listForAgent(agentId: string): Deployment[] {
    return this.list().filter((d) => d.agent_id === agentId);
  }

  /**
   * The deployment that represents an agent's current state: the one in flight if there is
   * one, otherwise the most recent. What the sidebar's Deployed filter reads.
   */
  currentForAgent(agentId: string): Deployment | null {
    const mine = this.listForAgent(agentId);
    return mine.find((d) => isInFlight(d.status)) ?? mine[0] ?? null;
  }

  /** Agent id → its current deployment. One query for a whole agent list. */
  currentByAgent(): Map<string, Deployment> {
    const out = new Map<string, Deployment>();
    // list() is newest-first, so the first row seen for an agent is its most recent.
    for (const d of this.list()) {
      const existing = out.get(d.agent_id);
      if (!existing || (isInFlight(d.status) && !isInFlight(existing.status))) {
        out.set(d.agent_id, d);
      }
    }
    return out;
  }

  logs(deploymentId: string, sinceSeq = -1): DeployLogLine[] {
    return this.db
      .prepare(
        `SELECT * FROM deployment_logs
          WHERE deployment_id = ? AND seq > ?
          ORDER BY seq ASC`,
      )
      .all(deploymentId, sinceSeq) as unknown as DeployLogLine[];
  }

  /** Any deploy this process should consider itself to be running. */
  inFlight(): Deployment[] {
    return this.list().filter((d) => isInFlight(d.status));
  }
}

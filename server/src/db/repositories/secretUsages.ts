// Blast radius: what breaks if I revoke this.
//
// The question somebody actually has in front of a revoke button, and the one a list of credential
// names cannot answer. A quiet revoke that breaks a deployed agent at three in the morning is the
// failure this table is designed against.
//
// TWO SOURCES, ALWAYS LABELLED, because neither is sufficient alone and pretending either is would
// be worse than showing nothing:
//
//   `static_scan`  — the name appears in the agent's current version tree, at a file and a line.
//                    Misses a name assembled at runtime, or read through a variable.
//   `runtime_read` — a run actually received this credential. Misses code that has never run,
//                    which for a newly deployed agent is all of it.
//
// So the UI shows both and says which is which. A single merged count would be a number nobody
// could act on: "three references" means something different when two of them are guesses.
//
// ONE ROW PER SITE, NOT PER READ. A read path that inserted a row per read would turn one busy
// agent's credential into millions of rows saying the same thing. `hits` counts, `detected_at`
// records the most recent, and `first_seen_at` the first — which is what "last read 2 minutes ago"
// renders from.

import { randomUUID } from "node:crypto";

import type { Db, Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

export type UsageSource = "static_scan" | "runtime_read";

export interface UsageRow {
  name: string;
  agent_id: string | null;
  source: UsageSource;
  /** `tools/weather.py:14` for a static hit; null for a runtime read, which knows no line. */
  location: string | null;
  hits: number;
  first_seen_at: string;
  detected_at: string;
}

export interface RecordUsageInput {
  name: string;
  source: UsageSource;
  agentId?: string | null;
  location?: string | null;
}

const COLUMNS = `name, agent_id, source, location, hits, first_seen_at, detected_at`;

function hydrate(row: Record<string, unknown>): UsageRow {
  return {
    name: String(row["name"]),
    agent_id: (row["agent_id"] as string | null) ?? null,
    source: row["source"] as UsageSource,
    location: (row["location"] as string | null) ?? null,
    hits: Number(row["hits"] ?? 0),
    first_seen_at: String(row["first_seen_at"]),
    detected_at: String(row["detected_at"]),
  };
}

export class SecretUsageRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /**
   * Record that a credential is used at this site, or that it was used again.
   *
   * IDEMPOTENT BY SITE. The unique index this conflicts on covers the nullable halves through
   * COALESCE, which is the part that makes it work: in an ordinary unique index two NULLs are
   * distinct, so a workspace-scoped runtime read would insert a fresh row on every single run and
   * the "how many times" answer would always be one.
   *
   * `hits` accumulates and `first_seen_at` is left alone, so re-running a static scan over an
   * unchanged file updates a timestamp rather than growing the table.
   */
  async record(ctx: TenantContext, input: RecordUsageInput): Promise<void> {
    const now = new Date().toISOString();
    // THE CAST IS NOT DECORATION, AND IT IS THE ONE THING THAT DIFFERS BETWEEN THE DRIVERS HERE.
    //
    // `ON CONFLICT (<expr>)` infers the index by matching the expression, so this has to be spelled
    // exactly as the unique index is — and the two migrations spell it differently ON PURPOSE.
    // SQLite is dynamically typed and takes `COALESCE(agent_id, '')`; on Postgres `agent_id` is a
    // `uuid`, so the same text asks the server to read '' as one and it answers
    // `invalid input syntax for type uuid: ""`. Migration 033 therefore indexes
    // `COALESCE(agent_id::text, '')` there, and this statement did not.
    //
    // The result was not a subtly wrong answer: `record` threw on every call against Postgres, so
    // the whole blast-radius half of the tab — every runtime read, every static scan hit — worked
    // on the local driver and on nothing else. It is invisible without a Postgres to run against,
    // which is why every secrets suite reports "skipping Postgres" on a developer machine and CI
    // is where it surfaced.
    const agentKey = this.db.dialect === "postgres" ? "COALESCE(agent_id::text, '')" : "COALESCE(agent_id, '')";
    await this.q(ctx).run(
      `INSERT INTO secret_usages
         (id, workspace_id, name, agent_id, source, location, hits, first_seen_at, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, name, source, ${agentKey}, COALESCE(location, ''))
       DO UPDATE SET hits = secret_usages.hits + 1, detected_at = excluded.detected_at`,
      [randomUUID(), ctx.workspaceId, input.name, input.agentId ?? null, input.source, input.location ?? null, 1, now, now],
    );
  }

  /** Every recorded site for one credential, static hits first, then most recently seen. */
  async forSecret(ctx: TenantContext, name: string): Promise<UsageRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM secret_usages
        WHERE workspace_id = ? AND name = ?
        ORDER BY source, detected_at DESC`,
      [ctx.workspaceId, name],
    );
    return rows.map(hydrate);
  }

  /**
   * Whether anything at all references this credential.
   *
   * Drives the typed-name confirmation on revoke: a credential nothing points at can go with an
   * ordinary confirm, and one with a live reference makes somebody type its name. Its own query
   * rather than `forSecret().length` so the common case does not read every row to learn whether
   * there is one.
   */
  async isReferenced(ctx: TenantContext, name: string): Promise<boolean> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT 1 AS present FROM secret_usages WHERE workspace_id = ? AND name = ? LIMIT ?`,
      [ctx.workspaceId, name, 1],
    );
    return Boolean(row);
  }

  /**
   * Forget every static reference for one agent, so a rescan replaces rather than accumulates.
   *
   * Static only, and deliberately: a runtime read is a thing that HAPPENED, and a scan of the
   * current source has no standing to say it did not. Deleting those would make the Usage view
   * forget every credential an agent stopped mentioning but is still deployed using.
   */
  async clearStaticFor(ctx: TenantContext, agentId: string): Promise<number> {
    const res = await this.q(ctx).run(
      `DELETE FROM secret_usages
        WHERE workspace_id = ? AND agent_id = ? AND source = ?`,
      [ctx.workspaceId, agentId, "static_scan"],
    );
    return res.changes;
  }
}

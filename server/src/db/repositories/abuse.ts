// Recording what was observed, and answering what it adds up to.
//
// Two kinds of row and therefore two kinds of method, which is unusual for a repository in this
// codebase and is the same exception `IdentityRepository` makes: almost everything takes a
// TenantContext, and the handful of operations that happen BEFORE a workspace exists cannot.
// Signup velocity is observed against an address, by definition before there is anything to
// scope it to — see the migration's header, and `tenant.ts` on why a fake TenantContext would be
// worse than a second signature.
//
// A SIGNAL IS APPEND-ONLY. There is no update and no way to lower one. A score falls because
// time passes, not because somebody edited the evidence — which is what makes the table
// something an appeal can be argued against.

import type { Db } from "../db.ts";
import { jsonFromColumn } from "../db.ts";
import type { SystemContext, TenantContext } from "../tenant.ts";
import {
  SIGNAL_RETENTION_DAYS,
  score as scoreOf,
  type DetectedSignal,
  type SignalKind,
} from "../../abuse/signals.ts";

export interface AbuseSignalRow {
  id: number;
  workspace_id: string | null;
  subject: string | null;
  kind: SignalKind;
  weight: number;
  detail: Record<string, unknown>;
  target_type: string | null;
  target_id: string | null;
  observed_at: string;
}

const nowIso = (): string => new Date().toISOString();

/** How far back the scorer looks. Past four half-lives a signal contributes under 7% of itself. */
const SCORE_WINDOW_DAYS = 7;

export class AbuseRepository {
  constructor(private db: Db) {}

  /**
   * Record an observation about a workspace.
   *
   * Scoped, and written through `scoped` rather than a bare insert because the table carries a
   * policy — the same lesson `createInvite` learned the hard way: an unscoped INSERT into a
   * policied table fails its WITH CHECK as the application role and works everywhere else,
   * which means it works in every test and not in production.
   */
  async record(ctx: TenantContext, signal: DetectedSignal): Promise<void> {
    await this.db.scoped(ctx.workspaceId, async (tx) => {
      await tx.run(
        `INSERT INTO abuse_signals
           (workspace_id, subject, kind, weight, detail, target_type, target_id, observed_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          ctx.workspaceId,
          signal.kind,
          signal.weight,
          JSON.stringify({ requestId: ctx.requestId, ...signal.detail }),
          signal.targetType ?? null,
          signal.targetId ?? null,
          nowIso(),
        ],
      );
    });
  }

  /**
   * Record an observation about an address that has no workspace.
   *
   * `subject` is already a keyed digest when it arrives here — see `subjectDigest`. This
   * repository never sees an address, which is deliberate: a module that cannot be handed one
   * cannot be the module that stored one.
   */
  async recordForSubject(_ctx: SystemContext, subject: string, signal: DetectedSignal): Promise<void> {
    await this.db.run(
      `INSERT INTO abuse_signals
         (workspace_id, subject, kind, weight, detail, target_type, target_id, observed_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subject,
        signal.kind,
        signal.weight,
        JSON.stringify(signal.detail),
        signal.targetType ?? null,
        signal.targetId ?? null,
        nowIso(),
      ],
    );
  }

  /** This workspace's recent observations, newest first. What an incident review reads. */
  async recent(ctx: TenantContext, limit = 100): Promise<AbuseSignalRow[]> {
    const rows = await this.db.forWorkspace(ctx.workspaceId).all<Record<string, unknown>>(
      `SELECT id, workspace_id, subject, kind, weight, detail, target_type, target_id, observed_at
         FROM abuse_signals
        WHERE workspace_id = ? AND observed_at >= ?
        ORDER BY observed_at DESC, id DESC
        LIMIT ?`,
      [ctx.workspaceId, since(SCORE_WINDOW_DAYS), limit],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /**
   * What this workspace's observations currently add up to.
   *
   * Decay is computed in JavaScript rather than in SQL, and that is a deliberate choice about
   * where a rule lives: `score()` is the same function on both drivers, testable without a
   * database, and identical to the one an operator would run against an export. An `exp()` in a
   * query would be two implementations of one rule, and the SQLite one would have to be
   * different because SQLite has no `exp`.
   */
  async score(ctx: TenantContext, now = Date.now()): Promise<number> {
    const rows = await this.db.forWorkspace(ctx.workspaceId).all<{ weight: unknown; observed_at: string }>(
      `SELECT weight, observed_at FROM abuse_signals
        WHERE workspace_id = ? AND observed_at >= ?`,
      [ctx.workspaceId, since(SCORE_WINDOW_DAYS)],
    );
    return scoreOf(
      rows.map((r) => ({ kind: "rate.limit_tripped" as SignalKind, weight: Number(r.weight), observedAt: Date.parse(r.observed_at) })),
      now,
    );
  }

  /** The same question about an address. Used before a workspace exists — signup velocity. */
  async scoreForSubject(_ctx: SystemContext, subject: string, now = Date.now()): Promise<number> {
    const rows = await this.db.all<{ weight: unknown; observed_at: string }>(
      `SELECT weight, observed_at FROM abuse_signals
        WHERE subject = ? AND observed_at >= ?`,
      [subject, since(SCORE_WINDOW_DAYS)],
    );
    return scoreOf(
      rows.map((r) => ({ kind: "signup.velocity" as SignalKind, weight: Number(r.weight), observedAt: Date.parse(r.observed_at) })),
      now,
    );
  }

  /**
   * How many of `kind` this workspace has tripped since `sinceIso`.
   *
   * For the detectors that need a COUNT rather than a score — "is this the third time today" is
   * a different question from "how worried are we overall", and answering it by weighting is how
   * a light signal repeated fifty times reads as one heavy one.
   */
  async countSince(ctx: TenantContext, kind: SignalKind, sinceIso: string): Promise<number> {
    const row = await this.db.forWorkspace(ctx.workspaceId).get<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM abuse_signals
        WHERE workspace_id = ? AND kind = ? AND observed_at >= ?`,
      [ctx.workspaceId, kind, sinceIso],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Drop observations past their retention.
   *
   * Run as the platform, not on a workspace's behalf: it takes the subject-keyed rows too, and
   * those belong to nobody. The number is `SIGNAL_RETENTION_DAYS` — long enough for a weekly
   * pattern and an appeal, short enough that this is not a permanent dossier on everybody who
   * ever hit a rate limit.
   *
   * `asPlatform` RATHER THAN A BARE STATEMENT, and the difference was not cosmetic. Unscoped,
   * this DELETE matched only the rows `platform_subject_rows` admits — the ones with a NULL
   * workspace_id — because `tenant_isolation` is false for everything else when no workspace is
   * set. Every workspace-attributed signal was retained forever, silently, and the only test
   * that could have noticed connects as a superuser. See migration 032.
   */
  async sweep(_ctx: SystemContext, now = Date.now()): Promise<number> {
    const cutoff = new Date(now - SIGNAL_RETENTION_DAYS * 86_400_000).toISOString();
    const res = await this.db.asPlatform((tx) =>
      tx.run(`DELETE FROM abuse_signals WHERE observed_at < ?`, [cutoff]),
    );
    return res.changes;
  }

  private hydrate(r: Record<string, unknown>): AbuseSignalRow {
    return {
      ...(r as unknown as AbuseSignalRow),
      id: Number(r["id"]),
      weight: Number(r["weight"]),
      detail: (jsonFromColumn(this.db.dialect, r["detail"]) as Record<string, unknown>) ?? {},
    };
  }
}

const since = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

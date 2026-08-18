// The inbox store — what is waiting on somebody, and what each person has done about it.
//
// EVERY METHOD TAKES A `TenantContext` FIRST, and on SQLite that parameter IS the tenancy boundary
// (migration 009 grants that driver no RLS at all). §6.3 admits no unscoped read path in this
// feature, so there is no method here that finds an item by id alone: `get` takes a context and a
// scoped WHERE, which is what makes another workspace's item id resolve to undefined rather than to
// somebody else's problem. That is §6.3's rule stated exactly — an id belonging to another workspace
// reads as ABSENT, never as forbidden.
//
// TWO TABLES AND TWO DIFFERENT KINDS OF FACT, which is the whole reason this class is not one map
// over one table. `inbox_items` holds what is TRUE — this credential is missing, and it is missing
// for everybody. `inbox_item_user_state` holds what one person DECIDED — I have dismissed this, I
// have snoozed it until Thursday. A method that wrote a decision onto the shared row would hide a
// live problem from a colleague who never made that decision, and one that resolved a shared row
// because somebody dismissed it would be Law 2 inverted: the item leaving for the one reason the
// specification says must never remove it.
//
// NOTHING HERE DECIDES WHETHER AN ITEM IS RESOLVED. That lives in the registry, evaluated by the
// reconciler against facts gathered independently — the same split `ThreadStore` has with
// `threadStatus`, and for the same reason. A store that computed resolution would have to know about
// the secret refs, the MCP registry, the deploy store and the billing ledger, and would become the
// second place each of those is modelled. `resolve` here is "write down that it is settled", which is
// a different verb from "work out whether it is".
//
// NOTHING IS DELETED, EITHER. `resolve` sets a timestamp and `reopen` clears it, and the only thing
// in this codebase that removes an inbox row is the retention sweep, on resolved rows past the plan's
// window. Undo is what makes that necessary rather than merely tidy: a five-second toast has to be
// able to put back exactly what was there, and a DELETE has nothing to put back.

import { randomUUID } from "node:crypto";

import { asInt, jsonFromColumn, type Db, type Queryable } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  inboxType,
  isInboxItemType,
  type InboxItemType,
  type InboxPayload,
  type InboxSeverity,
  type InboxSubjectType,
} from "./registry.ts";

/** Two values, and dismissal is deliberately not one of them — see the header and migration 050. */
export type InboxState = "open" | "resolved";

export interface InboxItem {
  id: string;
  type: InboxItemType;
  severity: InboxSeverity;
  subject_type: InboxSubjectType | null;
  subject_id: string | null;
  dedupe_key: string;
  payload: InboxPayload;
  state: InboxState;
  /** Law 3's number. Forty failures, one row. */
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

/**
 * One person's decisions about one item.
 *
 * BOTH NULLABLE AND BOTH INDEPENDENT. Somebody can snooze an item and then dismiss it, and the row
 * carries both — undo restores whichever it undid rather than clearing the pair, because clearing
 * both would resurrect a snooze the person had already replaced with a dismissal.
 */
export interface InboxUserState {
  dismissed_at: string | null;
  snoozed_until: string | null;
}

/** An item with the asking person's own state on it. What the board is rendered from. */
export interface InboxItemForUser extends InboxItem {
  user_state: InboxUserState;
}

/**
 * What `record` needs. Everything else about an item is the registry's or a default with a reason.
 *
 * `dedupeKey` IS PASSED RATHER THAN DERIVED, even though `dedupeKey()` in the registry composes one
 * from the same pieces. The discriminator is the generator's decision — one card per missing NAME,
 * one per version PAIR, one per agent — and a store that built the key itself would have to know all
 * sixteen of those rules, which is the registry's job and not this class's.
 */
export interface RecordInput {
  type: InboxItemType;
  subjectId: string | null;
  dedupeKey: string;
  payload?: InboxPayload;
  /** How many occurrences this observation represents. One, almost always. */
  count?: number;
  /** The clock, for a caller that has one — a backfill, a test. Defaults to now. */
  at?: string;
}

const nowIso = (): string => new Date().toISOString();

// Explicit rather than `SELECT *`: `workspace_id` is on every row and belongs on none of the
// snapshots a client receives, exactly as the thread store lists its columns out. `count` is
// qualified at every call site below because the join brings a second table into scope.
const COLUMNS = `i.id, i.type, i.severity, i.subject_type, i.subject_id, i.dedupe_key,
                 i.payload, i.state, i.count, i.first_seen_at, i.last_seen_at, i.resolved_at`;

export class InboxStore {
  /** Shares the trace store's database: same file, single writer. See TraceStore.database(). */
  constructor(private db: Db) {}

  // No `init()`. Both tables arrive with migration 050 on both drivers and no column has been added
  // to either after the fact. When one is, copy `ensureColumn` from store.ts — an existing database
  // has no migration row saying it is missing a column, so a migration cannot know to add it.

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /**
   * A row, as the application reads it.
   *
   * `payload` GOES THROUGH `jsonFromColumn` RATHER THAN `JSON.parse`. SQLite stores it as TEXT and
   * hands back a string; Postgres stores it as jsonb and the driver has already parsed it. A helper
   * that decided by looking at the value would turn the JSON string `"123"` into the number 123 on
   * one driver and not the other — same query, same code, different type, and nobody finds it for
   * months. `count` goes through `asInt` for the mirror-image reason: Postgres returns bigint columns
   * as strings.
   *
   * A ROW WHOSE `type` IS NOT IN THE REGISTRY IS DROPPED RATHER THAN RENDERED, and that is why this
   * returns a nullable. The column has no CHECK constraint — the registry is the one definition of
   * what a type is — so the honest failure mode for a row written by a version that knew a type this
   * one does not is to omit it from the board, not to render a card with no severity, no actions and
   * no predicate that could ever remove it. This is the rolling-deploy window, and it is exactly the
   * situation `migrate:check` exists to keep survivable.
   */
  private hydrate(dialect: Queryable["dialect"], row: Record<string, unknown>): InboxItem | null {
    const type = row["type"];
    if (!isInboxItemType(type)) return null;
    const payload = jsonFromColumn(dialect, row["payload"]);
    return {
      id: String(row["id"]),
      type,
      severity: row["severity"] as InboxSeverity,
      subject_type: (row["subject_type"] as InboxSubjectType | null) ?? null,
      subject_id: (row["subject_id"] as string | null) ?? null,
      dedupe_key: String(row["dedupe_key"]),
      payload: (payload && typeof payload === "object" ? payload : {}) as InboxPayload,
      state: row["state"] as InboxState,
      count: asInt(row["count"], 1),
      first_seen_at: String(row["first_seen_at"]),
      last_seen_at: String(row["last_seen_at"]),
      resolved_at: (row["resolved_at"] as string | null) ?? null,
    };
  }

  /**
   * Observe a problem. The one write that creates an item, and Law 3's whole mechanism.
   *
   * DEDUPLICATION HAPPENS HERE, AT WRITE TIME, ON A KEY, IN THE DATABASE. Forty failed runs of one
   * agent send forty of these and produce one row with `count = 40`. The alternative the
   * specification rules out — grouping at render time — means forty rows crossing every socket to say
   * one thing, every connected browser deriving the same grouping, and two of them disagreeing about
   * the number the sidebar badge is drawn from. `ON CONFLICT (workspace_id, dedupe_key)` is what
   * makes it structural instead of remembered.
   *
   * SEVERITY AND SUBJECT TYPE ARE NOT ARGUMENTS. They come from the registry, because they are facts
   * about the TYPE rather than about this observation — a caller that could pass its own severity
   * would be a caller that could put a credential item in the Proposals column, and the column a card
   * sits in would stop being something the system decides.
   *
   * A RESOLVED ROW OBSERVED AGAIN COMES BACK, AND COMES BACK NEW. §3's table says a resolution returns
   * "no, unless it recurs", and a recurrence is a fresh occurrence rather than a continuation: the
   * count starts again, and so does `first_seen_at`, so the age bar measures how long THIS occurrence
   * has been outstanding. Carrying the old first-seen forward would draw a full age bar on a problem
   * that appeared a minute ago because an earlier instance of it was ignored for a month.
   *
   * THE PAYLOAD IS REPLACED RATHER THAN MERGED, and the caller is the one that merges. Only the
   * generator knows which fields accumulate — `unreviewed_failures` grows a list of run ids,
   * `version_drift` carries a pair that is simply the current one — and a merge in here would have to
   * guess, which for a list means "append forever" and for a version means "keep the stale number".
   */
  async record(ctx: TenantContext, input: RecordInput): Promise<InboxItem> {
    const def = inboxType(input.type);
    const now = input.at ?? nowIso();
    const delta = Math.max(1, Math.trunc(input.count ?? 1));
    const payload = JSON.stringify(input.payload ?? {});

    await this.q(ctx).run(
      `INSERT INTO inbox_items
         (id, workspace_id, type, severity, subject_type, subject_id, dedupe_key, payload,
          state, count, first_seen_at, last_seen_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)
       ON CONFLICT (workspace_id, dedupe_key) DO UPDATE SET
         payload       = excluded.payload,
         severity      = excluded.severity,
         subject_type  = excluded.subject_type,
         subject_id    = excluded.subject_id,
         state         = 'open',
         resolved_at   = NULL,
         last_seen_at  = excluded.last_seen_at,
         -- A recurrence is a new occurrence: it counts from one and it ages from now. Comparing the
         -- stored text column against a literal rather than against a bound parameter, so neither
         -- driver has to infer a type for it.
         count         = CASE WHEN inbox_items.state = 'resolved'
                              THEN excluded.count
                              ELSE inbox_items.count + excluded.count END,
         first_seen_at = CASE WHEN inbox_items.state = 'resolved'
                              THEN excluded.first_seen_at
                              ELSE inbox_items.first_seen_at END`,
      [
        InboxStore.newId(),
        ctx.workspaceId,
        input.type,
        def.severity,
        def.subject,
        input.subjectId ?? null,
        input.dedupeKey,
        payload,
        delta,
        now,
        now,
      ],
    );

    // Read back rather than RETURNING: SQLite's driver here does not answer one, and the caller needs
    // the row — its id for a delta broadcast, its count for the `×40` badge, its `first_seen_at` for
    // the age bar. One extra indexed read on the unique key the write just used.
    const item = await this.byKey(ctx, input.dedupeKey);
    if (!item) throw new Error(`[inbox] recorded ${input.type} and could not read it back`);
    return item;
  }

  /**
   * Every open item in this workspace. The reconciler's read, and nobody else's.
   *
   * NO PER-USER JOIN, deliberately. The sweep asks "is this still true", which is a question about
   * the world and not about anybody's dismissals — an item somebody dismissed is still a problem and
   * still has to resolve when it is fixed, or the next person to look at the board sees a card for
   * something that was fixed last week.
   */
  async listOpen(ctx: TenantContext): Promise<InboxItem[]> {
    const q = this.q(ctx);
    const rows = await q.all(
      `SELECT ${COLUMNS} FROM inbox_items i
        WHERE i.workspace_id = ? AND i.state = 'open'
        ORDER BY i.last_seen_at DESC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(q.dialect, r)).filter((r): r is InboxItem => r !== null);
  }

  /**
   * The board, for one person: every open item with that person's own decisions attached.
   *
   * ONE STATEMENT WITH A LEFT JOIN, and the join direction is the point. An item nobody has touched
   * has no row in the second table at all — which is the ordinary case, since most items are never
   * dismissed or snoozed by anybody — so an inner join would return an empty board and a second query
   * per item would be the N+1 §6.2 spends a whole paragraph refusing.
   *
   * IT DOES NOT FILTER OUT WHAT WAS DISMISSED OR IS SNOOZED. Both are rendered somewhere: a snoozed
   * item lives in §5.4's tray, which is visible precisely so snooze does not silently become
   * dismissal, and the counts have to be computed from the same read the rows are. Deciding what to
   * show is the snapshot builder's, over one read, rather than this method returning a different
   * board depending on which surface asked.
   */
  async listForUser(ctx: TenantContext, userId: string | null): Promise<InboxItemForUser[]> {
    const q = this.q(ctx);
    // A NULL user is a real caller: work nobody triggered — the reconciler broadcasting, a system
    // context — and it has no dismissals. Binding null into the join would match nothing, which is
    // the right answer, but `?` against a NULL is a comparison that is neither true nor false on
    // either driver, so the empty string is bound instead. No user id is ever the empty string.
    const rows = await q.all(
      `SELECT ${COLUMNS}, u.dismissed_at, u.snoozed_until
         FROM inbox_items i
         LEFT JOIN inbox_item_user_state u ON u.item_id = i.id AND u.user_id = ?
        WHERE i.workspace_id = ? AND i.state = 'open'
        ORDER BY i.last_seen_at DESC`,
      [userId ?? "", ctx.workspaceId],
    );
    const out: InboxItemForUser[] = [];
    for (const row of rows) {
      const item = this.hydrate(q.dialect, row);
      if (!item) continue;
      out.push({
        ...item,
        user_state: {
          dismissed_at: (row["dismissed_at"] as string | null) ?? null,
          snoozed_until: (row["snoozed_until"] as string | null) ?? null,
        },
      });
    }
    return out;
  }

  /** One item, in this workspace. Undefined for an id that is not this workspace's — see the header. */
  async get(ctx: TenantContext, id: string): Promise<InboxItem | undefined> {
    const q = this.q(ctx);
    const row = await q.get(
      `SELECT ${COLUMNS} FROM inbox_items i WHERE i.workspace_id = ? AND i.id = ?`,
      [ctx.workspaceId, id],
    );
    if (!row) return undefined;
    return this.hydrate(q.dialect, row) ?? undefined;
  }

  /** One item by its dedupe key, which is what the upsert path and every generator address it by. */
  async byKey(ctx: TenantContext, dedupeKey: string): Promise<InboxItem | undefined> {
    const q = this.q(ctx);
    const row = await q.get(
      `SELECT ${COLUMNS} FROM inbox_items i WHERE i.workspace_id = ? AND i.dedupe_key = ?`,
      [ctx.workspaceId, dedupeKey],
    );
    if (!row) return undefined;
    return this.hydrate(q.dialect, row) ?? undefined;
  }

  /**
   * Write down that these items are settled.
   *
   * IDEMPOTENT BY ITS OWN WHERE, which is what makes the reconciler safe to run twice. `state =
   * 'open'` in the predicate means a second pass over the same row changes nothing and — the part
   * that matters — does not move `resolved_at` forward. A resolution whose timestamp crept on every
   * sweep would make "cleared 14 items this week" count the same fourteen items every week.
   *
   * TAKES A LIST, because the sweep settles a batch and one statement per row would put a round trip
   * per resolved item on a path that already holds a lock.
   */
  async resolve(ctx: TenantContext, ids: readonly string[], at: string = nowIso()): Promise<number> {
    if (ids.length === 0) return 0;
    let changed = 0;
    // Batched for the reason the retention sweeper batches: a parameter list has a limit on both
    // drivers, and a statement that fails at scale is a sweep that works until the first workspace
    // that needed it.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.q(ctx).run(
        `UPDATE inbox_items
            SET state = 'resolved', resolved_at = ?
          WHERE workspace_id = ? AND state = 'open' AND id IN (${placeholders})`,
        [at, ctx.workspaceId, ...chunk],
      );
      changed += res.changes;
    }
    return changed;
  }

  /**
   * Put a resolved item back. Undo's half of §3's five-second toast.
   *
   * `resolved_at` IS CLEARED AND `last_seen_at` IS NOT TOUCHED. The age bar under a card fills from
   * `first_seen_at`, and an undo is a statement that the resolution did not happen — so an item that
   * comes back has the age it always had rather than starting again. Moving either timestamp would
   * make undo a way to reset an item's age, which is a lie about how long somebody has been ignoring
   * something.
   *
   * IT DOES NOT CHECK WHETHER THE PROBLEM IS STILL THERE, on purpose: the very next sweep does, and
   * if the underlying condition really is fixed the item resolves again a moment later. That is the
   * correct outcome — undo restores the row, and the world decides whether it stays.
   */
  async reopen(ctx: TenantContext, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let changed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.q(ctx).run(
        `UPDATE inbox_items
            SET state = 'open', resolved_at = NULL
          WHERE workspace_id = ? AND state = 'resolved' AND id IN (${placeholders})`,
        [ctx.workspaceId, ...chunk],
      );
      changed += res.changes;
    }
    return changed;
  }

  // --- one person's decisions ------------------------------------------------------------------

  /**
   * Record what this person decided about this item.
   *
   * SCOPED THROUGH THE PARENT, because the child table has no `workspace_id` of its own — see
   * migration 050 for why it does not. The `SELECT ... WHERE workspace_id = ?` in the INSERT is not
   * decoration: it is the entire tenancy check on this table, on the driver that has no RLS behind
   * it. An item id from another workspace selects nothing, so the INSERT writes nothing, and the
   * caller gets `false` rather than a dismissal filed against somebody else's problem.
   *
   * AN UPSERT, because dismissing something already snoozed is one row with two columns rather than
   * two rows. WHICH COLUMNS THE CONFLICT CLAUSE TOUCHES IS DECIDED HERE IN TYPESCRIPT rather than by
   * a `CASE WHEN ? = 1` inside the SQL, and that is a deliberate choice over the cleverer one: a
   * bound integer compared against a literal is exactly the shape `test:boolean-literals` exists
   * because of — untyped on the way out of the driver, resolved differently by each dialect — and
   * building two short statements out of one condition is legible in a way a four-branch CASE is not.
   *
   * PASSING ONLY ONE COLUMN MUST NOT CLEAR THE OTHER, which is what makes this a patch rather than a
   * write of the pair. Passing an explicit null MUST clear it, because that is what undo does. The
   * two are told apart by whether the key is present on the object, never by its value.
   *
   * `SELECT ... WHERE workspace_id = ?` RATHER THAN `VALUES`, and the SELECT is the tenancy check —
   * see the paragraph above. SQLite needs that WHERE clause for its own reason too: without one it
   * cannot tell an upsert clause from a join constraint after an INSERT ... SELECT, and refuses to
   * parse the statement.
   */
  async setUserState(
    ctx: TenantContext,
    itemId: string,
    userId: string,
    patch: Partial<InboxUserState>,
  ): Promise<boolean> {
    const dismissedGiven = Object.prototype.hasOwnProperty.call(patch, "dismissed_at");
    const snoozedGiven = Object.prototype.hasOwnProperty.call(patch, "snoozed_until");
    if (!dismissedGiven && !snoozedGiven) return false;

    const updates: string[] = [];
    if (dismissedGiven) updates.push("dismissed_at = excluded.dismissed_at");
    if (snoozedGiven) updates.push("snoozed_until = excluded.snoozed_until");

    const res = await this.q(ctx).run(
      `INSERT INTO inbox_item_user_state (item_id, user_id, dismissed_at, snoozed_until)
       SELECT i.id, ?, ?, ?
         FROM inbox_items i
        WHERE i.workspace_id = ? AND i.id = ?
       ON CONFLICT (item_id, user_id) DO UPDATE SET ${updates.join(", ")}`,
      [
        userId,
        dismissedGiven ? (patch.dismissed_at ?? null) : null,
        snoozedGiven ? (patch.snoozed_until ?? null) : null,
        ctx.workspaceId,
        itemId,
      ],
    );
    return res.changes > 0;
  }

  /** This person's state for one item, or a pair of nulls. What undo reads before it overwrites. */
  async userState(ctx: TenantContext, itemId: string, userId: string): Promise<InboxUserState> {
    const row = await this.q(ctx).get<{ dismissed_at: string | null; snoozed_until: string | null }>(
      `SELECT u.dismissed_at, u.snoozed_until
         FROM inbox_item_user_state u
         JOIN inbox_items i ON i.id = u.item_id
        WHERE i.workspace_id = ? AND u.item_id = ? AND u.user_id = ?`,
      [ctx.workspaceId, itemId, userId],
    );
    return { dismissed_at: row?.dismissed_at ?? null, snoozed_until: row?.snoozed_until ?? null };
  }

  /**
   * How many items this person cleared in a window. §5.3's one line of real statistic.
   *
   * RESOLVED, NOT DISMISSED, and it is the workspace's count rather than one person's. "Cleared 14
   * items this week" is a statement about work that got done — a credential somebody set, a deploy
   * somebody fixed — and counting dismissals in it would let a person clear their own board by
   * hiding things and be congratulated for it.
   */
  async resolvedSince(ctx: TenantContext, since: string): Promise<number> {
    const row = await this.q(ctx).get<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM inbox_items i
        WHERE i.workspace_id = ? AND i.state = 'resolved' AND i.resolved_at IS NOT NULL
          AND i.resolved_at >= ?`,
      [ctx.workspaceId, since],
    );
    return asInt(row?.n, 0);
  }

  /**
   * A brand-new id, minted here rather than by the database.
   *
   * BOTH DRIVERS, ONE SPELLING. Postgres defaults `id` with `gen_random_uuid()` and SQLite has no
   * such thing, so every store in this codebase supplies the id — which also means the caller has it
   * before the write returns and does not need a RETURNING clause SQLite would not answer.
   */
  static newId(): string {
    return randomUUID();
  }
}

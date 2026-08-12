// The agent list, as a table.
//
// It used to be a directory listing: `readdir(runtime/agents/)` plus a parse of each
// project's jaroku.json. That is a fine source of truth for one machine and no source of
// truth at all for several — object storage has no directory to list, and stateless replicas
// have no shared disk to list from.
//
// So the table is authoritative and the directory is a cache it describes. The
// reconciliation runs disk → table, because on this side the disk is still where a project
// actually lives and a user may still drop one in by hand. Session 3 reverses that: files
// move to the object store, `agent_versions` gets a manifest per version, and the directory
// becomes a materialisation of the row rather than the other way round.

import { randomUUID } from "node:crypto";
import { asInt, asBool, jsonFromColumn, type Db, type Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

/** Same pattern the runner enforces on the Python side. A slug is a directory name. */
export const SAFE_SLUG = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * What the next version number is, from the two facts that constrain it.
 *
 * One function rather than one expression written twice, because it IS written twice: the
 * repository picks the number inside the transaction that inserts the row, and the project
 * store has to write the objects for that number BEFORE the row exists (objects first, pointer
 * second — see storage/projectStore.ts). Two spellings of this would disagree exactly once, on
 * the first agent that had been undone, and the symptom would be a version whose objects belong
 * to a different one.
 *
 * `current` matters and is not redundant with `highest`. A fresh agent row starts at
 * current_version 1 with no version rows at all, so `highest` is 0 and the first publish is
 * v2 — which reads oddly and is correct: the row already claims to be at 1, and a publish that
 * produced a second version 1 would be claiming to be what is already live.
 */
export function nextVersionNumber(current: number, highest: number): number {
  return Math.max(current, highest) + 1;
}

export interface Agent {
  id: string;
  slug: string;
  display_name: string | null;
  description: string | null;
  connectors: string[];
  mcp_tools: string[];
  required_env: string[];
  default_provider: string;
  hand_written: boolean;
  current_version: number;
  creation_cost: number | null;
  created_at: string;
}

/** What a version contains: every file, by path, with enough to verify it without fetching it. */
export type VersionManifest = Record<string, { sha256: string; bytes: number }>;

/** What made a version. See migration 014 — `import` is the backfill and says so. */
export type VersionSource = "generation" | "edit" | "import" | "deploy";

/** What CHANGED in a version, as the diff bar renders it. The manifest says what it contains. */
export interface VersionFileStat {
  path: string;
  status: "added" | "modified";
  additions: number;
  deletions: number;
}

export interface VersionMeta {
  source?: VersionSource;
  instruction?: string | null;
  summary?: string | null;
  fileStats?: VersionFileStat[];
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  version: number;
  manifest: VersionManifest;
  source: VersionSource;
  instruction: string | null;
  summary: string | null;
  file_stats: VersionFileStat[];
  total_bytes: number;
  /** Set when `current_version` was moved back past this one. Off the linear history. */
  undone_at: string | null;
  created_at: string;
}

/** What the disk scan produces — the shape jaroku.json plus the directory can describe. */
export interface AgentOnDisk {
  slug: string;
  display_name?: string | null;
  description?: string | null;
  connectors?: string[];
  mcp_tools?: string[];
  required_env?: string[];
  default_provider?: string;
  hand_written?: boolean;
  creation_cost?: number | null;
  created_at?: string | null;
}

const COLUMNS = `id, slug, display_name, description, connectors, mcp_tools, required_env,
                 default_provider, hand_written, current_version, creation_cost, created_at`;

export class AgentRepository {
  constructor(private db: Db) {}

  /** The database, scoped to the request's workspace. See TraceStore's note. */
  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): Agent {
    const d = this.db.dialect;
    const arr = (v: unknown): string[] => {
      const parsed = jsonFromColumn(d, v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    };
    return {
      ...(row as unknown as Agent),
      connectors: arr(row["connectors"]),
      mcp_tools: arr(row["mcp_tools"]),
      required_env: arr(row["required_env"]),
      hand_written: asBool(row["hand_written"]),
      current_version: asInt(row["current_version"], 1),
    };
  }

  /** Newest first, hand-written reference agents last — the order the sidebar renders. */
  async list(ctx: TenantContext): Promise<Agent[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM agents
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY hand_written ASC, created_at DESC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  async bySlug(ctx: TenantContext, slug: string): Promise<Agent | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM agents WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL`,
      [ctx.workspaceId, slug],
    );
    return row ? this.hydrate(row) : undefined;
  }

  async byId(ctx: TenantContext, id: string): Promise<Agent | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM agents WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      [ctx.workspaceId, id],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * Insert an agent whose uuid the CALLER minted.
   *
   * Distinct from `upsertFromDisk`, which takes a slug and invents an id, because generation
   * needs the id before there is anything to record: object keys are built from it, and the
   * staging objects for a project are written before anybody knows whether the project will
   * validate. So the id is decided first and this is where it becomes a row — at the end, only
   * if the generation succeeded, which is why a failed generation leaves no unopenable agent in
   * the sidebar.
   *
   * Insert, not upsert. A slug this workspace already uses is a bug in the caller's uniqueness
   * check rather than something to quietly overwrite: the row it would overwrite belongs to an
   * agent with runs, evals and deployments pointing at it.
   */
  async create(ctx: TenantContext, a: AgentOnDisk & { id: string }): Promise<Agent> {
    if (!SAFE_SLUG.test(a.slug)) throw new Error(`not a usable agent id: ${a.slug}`);
    await this.q(ctx).run(
      `INSERT INTO agents (id, workspace_id, slug, display_name, description, connectors,
         mcp_tools, required_env, default_provider, hand_written, creation_cost, created_by,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.id,
        ctx.workspaceId,
        a.slug,
        a.display_name ?? null,
        a.description ?? null,
        JSON.stringify(a.connectors ?? []),
        JSON.stringify(a.mcp_tools ?? []),
        JSON.stringify(a.required_env ?? []),
        a.default_provider ?? "fake",
        a.hand_written ? 1 : 0,
        a.creation_cost ?? null,
        ctx.actorUserId,
        a.created_at ?? new Date().toISOString(),
      ],
    );
    return (await this.byId(ctx, a.id))!;
  }

  /**
   * Record what is on disk, keeping the row's identity.
   *
   * Upsert on (workspace_id, slug) rather than on id, because the disk has no uuid to offer —
   * a directory knows its name and nothing else. `created_at` is only set on insert, so a
   * re-sync does not keep reshuffling the sidebar.
   */
  async upsertFromDisk(ctx: TenantContext, a: AgentOnDisk): Promise<Agent> {
    if (!SAFE_SLUG.test(a.slug)) throw new Error(`not a usable agent id: ${a.slug}`);
    await this.q(ctx).run(
      `INSERT INTO agents (id, workspace_id, slug, display_name, description, connectors,
         mcp_tools, required_env, default_provider, hand_written, creation_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, slug) DO UPDATE SET
         display_name = excluded.display_name,
         description = excluded.description,
         connectors = excluded.connectors,
         mcp_tools = excluded.mcp_tools,
         required_env = excluded.required_env,
         default_provider = excluded.default_provider,
         hand_written = excluded.hand_written,
         creation_cost = excluded.creation_cost,
         deleted_at = NULL`,
      [
        randomUUID(),
        ctx.workspaceId,
        a.slug,
        a.display_name ?? null,
        a.description ?? null,
        JSON.stringify(a.connectors ?? []),
        JSON.stringify(a.mcp_tools ?? []),
        JSON.stringify(a.required_env ?? []),
        a.default_provider ?? "fake",
        a.hand_written ? 1 : 0,
        a.creation_cost ?? null,
        a.created_at ?? new Date().toISOString(),
      ],
    );
    return (await this.bySlug(ctx, a.slug))!;
  }

  /**
   * Reconcile the table against what is on disk.
   *
   * Soft-deletes rows whose directory has gone rather than deleting them, because runs, evals
   * and deployments still point at that agent by slug and a past comparison has to stay
   * readable after its agent is removed — the same reasoning `deleteDataset` follows.
   *
   * ONLY ROWS THE DISK ALONE PUT THERE. An agent with a published version does not live in
   * `runtime/agents/` any more; it lives in the object store, and the directory is a copy one
   * replica happened to materialise. So an absent directory says "this process has not
   * materialised it" and nothing whatsoever about whether the agent exists — which is the whole
   * assumption this session removes.
   *
   * It used to say otherwise, and the cost was total: boot a second replica, or boot the first
   * one after its runtime directory was cleaned, and every agent in the workspace was
   * soft-deleted on startup while its versions sat intact in the store. A row with no version
   * behind it is still swept, because that one really is nothing but a mirror of a directory.
   */
  async syncFromDisk(ctx: TenantContext, onDisk: AgentOnDisk[]): Promise<Agent[]> {
    for (const a of onDisk) {
      if (SAFE_SLUG.test(a.slug)) await this.upsertFromDisk(ctx, a);
    }
    const seen = new Set(onDisk.map((a) => a.slug));
    for (const existing of await this.list(ctx)) {
      if (!seen.has(existing.slug)) {
        await this.q(ctx).run(
          `UPDATE agents SET deleted_at = ?
            WHERE workspace_id = ? AND slug = ?
              AND NOT EXISTS (SELECT 1 FROM agent_versions v WHERE v.agent_id = agents.id)`,
          [new Date().toISOString(), ctx.workspaceId, existing.slug],
        );
      }
    }
    return this.list(ctx);
  }

  /**
   * Record a new version of an agent's files and make it current, in one transaction.
   *
   * THIS IS THE ATOMIC SWAP NOW. `projectFs.atomicSwap` renamed a staging directory over a live
   * one, which is atomic on one filesystem and means nothing across replicas. The replacement is
   * this UPDATE: the objects for version N are written first and are immutable, so they are
   * either all there or the row that points at them was never written. A reader between the two
   * sees the previous version in full, which is the same promise the rename made and the only
   * one that survives having no shared disk.
   *
   * The manifest is {path: {sha256, bytes}}, so a version can be verified without fetching it.
   * `meta` is what the history list renders — see migration 014 for why those four facts moved
   * off `history.json` and onto the row.
   */
  async addVersion(
    ctx: TenantContext,
    agentId: string,
    manifest: VersionManifest,
    meta: VersionMeta = {},
  ): Promise<number> {
    const version = await this.reserveVersion(ctx, agentId, manifest, meta);
    await this.promoteVersion(ctx, agentId, version);
    return version;
  }

  /**
   * Write a version row WITHOUT making it current.
   *
   * The first half of a publish, and the half that has to happen before the objects exist —
   * because the objects are written under the version's own number and nothing can know that
   * number until a row claims it.
   *
   * PREDICTING THE NUMBER AND CHECKING AFTERWARDS DOES NOT WORK, which is what this replaced.
   * Two publishes both predicted N, both wrote objects to N's prefix, and then one of them
   * found it had been given N+1 — at which point it had already bumped the pointer to a
   * version whose objects were the other publish's, and its cleanup deleted them. The agent was
   * left pointing at a version with no files at all.
   *
   * Reserving first fixes it by construction: two callers get two numbers, each writes its own
   * objects, and the pointer moves only after the bytes exist. The retry is for Postgres, where
   * two transactions genuinely run in parallel and can compute the same number — one insert
   * wins the unique constraint and the other simply asks again.
   */
  async reserveVersion(
    ctx: TenantContext,
    agentId: string,
    manifest: VersionManifest,
    meta: VersionMeta = {},
  ): Promise<number> {
    const totalBytes = Object.values(manifest).reduce((n, f) => n + f.bytes, 0);
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await this.plannedNextVersion(ctx, agentId);
      try {
        await this.q(ctx).run(
          `INSERT INTO agent_versions (id, agent_id, version, manifest, source, instruction,
             summary, file_stats, total_bytes, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(), agentId, next, JSON.stringify(manifest), meta.source ?? "import",
            meta.instruction ?? null, meta.summary ?? null, JSON.stringify(meta.fileStats ?? []),
            totalBytes, ctx.actorUserId, new Date().toISOString(),
          ],
        );
        return next;
      } catch (err) {
        // The (agent_id, version) unique constraint: somebody else took this number between the
        // read and the insert. Ask again — the loop is bounded so a genuinely broken insert
        // surfaces rather than spinning.
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Make a reserved version current.
   *
   * The second half, and the only statement that moves what anybody reads. It runs after the
   * objects are in place, so `agents.current_version` never points at a version whose files do
   * not exist — the invariant the predict-and-check version could not hold.
   */
  async promoteVersion(ctx: TenantContext, agentId: string, version: number): Promise<void> {
    const result = await this.q(ctx).run(
      `UPDATE agents SET current_version = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [version, agentId, ctx.workspaceId],
    );
    if (result.changes === 0) throw new Error(`no such agent in this workspace: ${agentId}`);
  }

  /**
   * The number the next publish will take, without taking it.
   *
   * For the object store, which has to write a version's bytes before the row that names it
   * exists. It is a PREDICTION, not a reservation — `addVersion` recomputes it inside its own
   * transaction and the caller compares, so two publishes racing produce one refusal rather
   * than two versions sharing a number.
   */
  async plannedNextVersion(ctx: TenantContext, agentId: string): Promise<number> {
    const row = await this.q(ctx).get<{ current_version: unknown }>(
      `SELECT current_version FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [agentId, ctx.workspaceId],
    );
    if (!row) throw new Error(`no such agent in this workspace: ${agentId}`);
    const top = await this.q(ctx).get<{ top: unknown }>(
      `SELECT MAX(v.version) AS top FROM agent_versions v JOIN agents a ON a.id = v.agent_id
        WHERE v.agent_id = ? AND a.workspace_id = ?`,
      [agentId, ctx.workspaceId],
    );
    return nextVersionNumber(asInt(row.current_version, 0), asInt(top?.top, 0));
  }

  /** One version's row, or undefined. Scoped through the agent, which carries the workspace. */
  async version(ctx: TenantContext, agentId: string, version: number): Promise<AgentVersion | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT v.id, v.agent_id, v.version, v.manifest, v.source, v.instruction, v.summary,
              v.file_stats, v.total_bytes, v.undone_at, v.created_at
         FROM agent_versions v JOIN agents a ON a.id = v.agent_id
        WHERE v.agent_id = ? AND v.version = ? AND a.workspace_id = ?`,
      [agentId, version, ctx.workspaceId],
    );
    return row ? this.hydrateVersion(row) : undefined;
  }

  /**
   * A version's cached graph introspection result, or undefined if nothing has been cached yet.
   *
   * Kept out of `version()`'s own SELECT list and `AgentVersion` deliberately — the history list
   * and every other version read has no use for a topology blob, and loading one on every row of
   * a list nobody asked to see the graph of is exactly the kind of cost a cache should not add.
   */
  async getGraphCache(ctx: TenantContext, agentId: string, version: number): Promise<unknown | undefined> {
    const row = await this.q(ctx).get<{ graph_cache: unknown }>(
      `SELECT v.graph_cache
         FROM agent_versions v JOIN agents a ON a.id = v.agent_id
        WHERE v.agent_id = ? AND v.version = ? AND a.workspace_id = ?`,
      [agentId, version, ctx.workspaceId],
    );
    if (!row || row.graph_cache === null || row.graph_cache === undefined) return undefined;
    return jsonFromColumn(this.db.dialect, row.graph_cache);
  }

  /**
   * Cache a version's graph introspection result. Scoped through the agent like every other
   * version write, so a workspace can only ever cache a result for its own version — not that a
   * cross-workspace agent id would resolve to a row at all, but the WHERE clause is the same
   * belt-and-braces this repository applies everywhere else rather than trusting the caller.
   */
  async setGraphCache(ctx: TenantContext, agentId: string, version: number, graph: unknown): Promise<void> {
    await this.q(ctx).run(
      `UPDATE agent_versions AS v SET graph_cache = ?
        WHERE v.agent_id = ? AND v.version = ?
          AND EXISTS (SELECT 1 FROM agents a WHERE a.id = v.agent_id AND a.workspace_id = ?)`,
      [JSON.stringify(graph), agentId, version, ctx.workspaceId],
    );
  }

  /**
   * An agent's versions, newest first, still on the line.
   *
   * `undone_at IS NULL` by default because that is what "the history" means to the UI: undoing
   * an edit takes it off the list, exactly as popping `history.json` used to. Pass
   * `includeUndone` to see everything, which is what a retention sweep wants.
   */
  async versions(ctx: TenantContext, agentId: string, includeUndone = false): Promise<AgentVersion[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT v.id, v.agent_id, v.version, v.manifest, v.source, v.instruction, v.summary,
              v.file_stats, v.total_bytes, v.undone_at, v.created_at
         FROM agent_versions v JOIN agents a ON a.id = v.agent_id
        WHERE v.agent_id = ? AND a.workspace_id = ?
          ${includeUndone ? "" : "AND v.undone_at IS NULL"}
        ORDER BY v.version DESC`,
      [agentId, ctx.workspaceId],
    );
    return rows.map((r) => this.hydrateVersion(r));
  }

  /**
   * How many applied edits each agent in this workspace still has behind it.
   *
   * What drives whether Undo is offered at all. It used to be a count of directories under
   * `runtime/agents/.history/<slug>/`, which is a question only the machine that applied the
   * edit could answer; it is now a count of rows, which every replica can.
   *
   * ONE QUERY FOR THE WHOLE WORKSPACE, keyed by agent uuid, because the sidebar renders this
   * for every agent at once and the alternative is a round trip per row — the same reasoning
   * `DeployStore.currentByAgent` follows.
   *
   * `undone_at IS NULL` is the linear history: an undone edit is not one you can undo again.
   */
  async editCounts(ctx: TenantContext): Promise<Map<string, number>> {
    const rows = await this.q(ctx).all<{ agent_id: unknown; n: unknown }>(
      `SELECT v.agent_id AS agent_id, COUNT(*) AS n
         FROM agent_versions v JOIN agents a ON a.id = v.agent_id
        WHERE a.workspace_id = ? AND v.source = 'edit' AND v.undone_at IS NULL
        GROUP BY v.agent_id`,
      [ctx.workspaceId],
    );
    return new Map(rows.map((r) => [String(r.agent_id), asInt(r.n, 0)]));
  }

  /**
   * How many bytes of agent files this workspace is holding, across every version.
   *
   * EVERY VERSION, INCLUDING UNDONE ONES AND SOFT-DELETED AGENTS' — because the objects are
   * still there. `undone_at` moves a pointer and `deleted_at` hides a row from a listing;
   * neither deletes a byte from the object store, and an undo is a pointer move precisely so
   * the bytes survive to be redone. Billing what is stored means billing what is stored, not
   * what is currently reachable from the UI. A retention sweeper is what actually removes
   * objects, and when it does, this number falls on the next sample by itself.
   *
   * Summed from `total_bytes` on the version row rather than by asking the object store. The
   * manifest is written in the same transaction as the pointer, so the row is authoritative and
   * free; listing a prefix on S3 to bill a workspace would be a paid API call per workspace per
   * hour, which is a metering system that costs more than the thing it meters.
   */
  async storedBytes(ctx: TenantContext): Promise<number> {
    const row = await this.q(ctx).get<{ n: unknown }>(
      `SELECT COALESCE(SUM(v.total_bytes), 0) AS n
         FROM agent_versions v JOIN agents a ON a.id = v.agent_id
        WHERE a.workspace_id = ?`,
      [ctx.workspaceId],
    );
    return asInt(row?.n, 0);
  }

  /**
   * Move `current_version` back one, and take the version it left behind off the line.
   *
   * The undo. Not a copy of anything: the previous version's objects were never touched, so
   * pointing at them again is the whole operation — which is what makes an undo survive landing
   * on a different replica from the apply.
   *
   * Both statements are in one transaction because a pointer moved without the row being marked
   * would offer the same undo twice, and a row marked without the pointer moving would hide a
   * version that is still live.
   */
  async undoVersion(ctx: TenantContext, agentId: string): Promise<{ from: number; to: number } | null> {
    return this.db.scoped(ctx.workspaceId, async (tx) => {
      const agent = await tx.get<{ current_version: unknown }>(
        `SELECT current_version FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [agentId, ctx.workspaceId],
      );
      if (!agent) return null;
      const from = asInt(agent.current_version, 0);
      const previous = await tx.get<{ version: unknown }>(
        `SELECT version FROM agent_versions
          WHERE agent_id = ? AND version < ? AND undone_at IS NULL
          ORDER BY version DESC`,
        [agentId, from],
      );
      if (!previous) return null; // nothing behind this one — the first version cannot be undone
      const to = asInt(previous.version, 0);
      await tx.run(`UPDATE agent_versions SET undone_at = ? WHERE agent_id = ? AND version = ?`, [
        new Date().toISOString(), agentId, from,
      ]);
      await tx.run(`UPDATE agents SET current_version = ? WHERE id = ? AND workspace_id = ?`, [
        to, agentId, ctx.workspaceId,
      ]);
      return { from, to };
    });
  }

  private hydrateVersion(row: Record<string, unknown>): AgentVersion {
    const d = this.db.dialect;
    const manifest = jsonFromColumn(d, row["manifest"]);
    const stats = jsonFromColumn(d, row["file_stats"]);
    return {
      id: String(row["id"]),
      agent_id: String(row["agent_id"]),
      version: asInt(row["version"], 1),
      manifest: (manifest && typeof manifest === "object" ? manifest : {}) as VersionManifest,
      source: String(row["source"] ?? "import") as VersionSource,
      instruction: (row["instruction"] as string | null) ?? null,
      summary: (row["summary"] as string | null) ?? null,
      file_stats: Array.isArray(stats) ? (stats as VersionFileStat[]) : [],
      total_bytes: asInt(row["total_bytes"], 0),
      undone_at: (row["undone_at"] as string | null) ?? null,
      created_at: String(row["created_at"]),
    };
  }
}

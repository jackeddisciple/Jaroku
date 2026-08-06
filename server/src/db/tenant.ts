// Who is asking, and on whose behalf.
//
// Every repository method takes one of these as its FIRST argument, and that is a rule with
// a test behind it rather than a convention. The point is not documentation: it is that a
// query which reaches the database without a scope should be impossible to write by
// accident. A parameter you must supply is harder to forget than a WHERE clause you must
// remember, and the RLS policies in a later migration are the backstop for the times
// somebody manages it anyway.
//
// TWO CONTEXTS, because there are genuinely two situations.
//
//   TenantContext — almost everything. A workspace is known, and every row read or written
//   belongs to it.
//
//   SystemContext — the handful of operations that HAPPEN BEFORE a workspace is known, and
//   cannot be scoped because the scope is what they are producing: mapping an auth
//   provider's `sub` to a user on first sight, creating that user's personal workspace,
//   looking up which workspaces somebody belongs to. Giving these a fake TenantContext with
//   some placeholder workspace id would be worse than having a second type — it would make
//   "this ran unscoped" indistinguishable from "this ran scoped to the wrong workspace".
//
// The two are separate types on purpose. A repository method that takes a TenantContext
// cannot be called with a SystemContext, so the compiler refuses to let a tenant query run
// unscoped, and the small set of operations that legitimately have no workspace is visible
// in the signatures rather than buried in the bodies.

/** What a member may do. `system` is a REQUEST's role, never a membership row's. */
export type Role = "owner" | "admin" | "member" | "system";

/** The roles that can appear in `workspace_members`. */
export const MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function isMemberRole(v: unknown): v is MemberRole {
  return typeof v === "string" && (MEMBER_ROLES as readonly string[]).includes(v);
}

/** Common to both contexts: who, and which request. */
export interface BaseContext {
  /**
   * The user this is being done on behalf of, or null for a job nobody triggered.
   *
   * Attribution, never authorisation. Nothing decides what may happen from this field — the
   * workspace scope and the role do that. It exists so an audit row can name a person.
   */
  actorUserId: string | null;
  /** Correlates a log line, an audit row and a trace to one request. */
  requestId: string;
}

/** A request that knows its workspace. Almost everything. */
export interface TenantContext extends BaseContext {
  /** uuid. The scope every tenant query is filtered by, and the RLS policy's input. */
  workspaceId: string;
  role: Role;
}

/** A request that does not have a workspace yet, and is not pretending to. */
export interface SystemContext extends BaseContext {
  role: "system";
}

/** Either. For helpers — logging, audit — that genuinely do not care which they got. */
export type AnyContext = TenantContext | SystemContext;

export function isTenantContext(ctx: AnyContext): ctx is TenantContext {
  return typeof (ctx as TenantContext).workspaceId === "string";
}

/**
 * A context for work no user triggered: startup reconciliation, sweepers, the importer.
 *
 * Still scoped to a workspace — "system" describes the actor, not the reach. A background
 * job that swept every workspace's checkpoints because nobody was logged in would be the
 * exact hole the tenancy layer exists to close.
 */
export function systemContextFor(workspaceId: string, requestId: string): TenantContext {
  return { workspaceId, actorUserId: null, role: "system", requestId };
}

/** A context for the operations that precede a workspace. Sign-up, and little else. */
export function systemContext(requestId: string): SystemContext {
  return { actorUserId: null, role: "system", requestId };
}

/** Short, sortable, and enough to correlate one request across four log lines. */
export function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The workspace migration 004 creates, and backfills every pre-tenancy row into.
 *
 * A fixed id rather than a lookup, because the migration that creates it and the code that
 * reads it have to agree without either being able to ask the other. It is the workspace a
 * local `npm run dev` runs in and the one JAROKU_DEV_WORKSPACE defaults to; on a fresh
 * hosted database it is simply an empty workspace nobody is a member of.
 */
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

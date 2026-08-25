// The conversation routes — §8's composer surface.
//
// Two of them for now: read the settings a conversation is running under, and change them. The
// connector map (§8's `GET/PUT /conversations/:id/connectors`) joins them in M3, in this file,
// because it is the same resource with the same scoping and the same "who is asking" question.
//
// PREFIX ROUTES, because the router matches literal paths and these carry an id in the middle.
// The id is parsed here rather than by the router, which keeps the router the ninety lines it was
// deliberately kept to. What that costs is the parsing below being careful — a path segment is
// user input, and the one thing that must never happen is a conversation id from the URL reaching
// a query without the workspace beside it.
//
// EVERY ROUTE IS WORKSPACE-SCOPED AND THE CLIENT NEVER CHOOSES THE WORKSPACE. `callerFor` resolves
// it from the token through the same resolver every other authenticated route uses. §8: "Every
// route is workspace-scoped and RLS-enforced."
//
// THE PERMISSION MODE IS AUDITED AND THE EFFORT IS NOT, and that asymmetry is deliberate rather
// than an omission. §3.2 requires "Mode changes write to audit_log with actor, conversation, old
// value, new value. In a multi-tenant workspace, 'who loosened the gate and when' must be
// answerable." Reasoning effort is a spending and latency decision; the permission mode is a
// security one, and only one of those is worth a permanent row per keystroke.
//
//   npm run test:conversation-routes

import { HttpError, type Handler, type HttpRequest } from "./router.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  isPermissionMode, type ConversationSettingsStore, type EffectiveSettings, type PermissionMode,
} from "../conversationSettings.ts";
import { isEffort, type Effort } from "../effort.ts";
import type { ConversationConnectorStore } from "../conversationConnectors.ts";
import type { TurnInteractionStore } from "../turnInteraction.ts";

export interface ConversationRoute {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  prefix?: boolean;
  handler: Handler;
}

/** Who is asking, resolved from the token — never from anything the request chose. */
export interface ConversationCaller {
  ctx: TenantContext;
  userId: string | null;
  ip: string | null;
}

export interface ConversationRouteDeps {
  callerFor(req: HttpRequest): Promise<ConversationCaller>;
  settings: ConversationSettingsStore;
  /** Whether this conversation exists IN THIS WORKSPACE. A 404 either way — see `requireThread`. */
  threadExists(ctx: TenantContext, conversationId: string): Promise<boolean>;
  connectors: ConversationConnectorStore;
  /** §5.3's rail reads through here. Personal — every call carries the user. */
  interaction: TurnInteractionStore;
  /**
   * Every connector the WORKSPACE has, with what the deck needs to draw it.
   *
   * Membership lives here and decisions live in `connectors`, and the split is deliberate: a
   * conversation's row says "somebody switched this off", never "this exists". A version of the
   * decision store that also knew the workspace's list would be a second, stale copy of it.
   */
  workspaceConnectors(ctx: TenantContext): Promise<{
    id: string;
    label: string;
    logoUrl: string | null;
    toolCount: number;
    warning: string | null;
  }[]>;
  /** §3.2's audit row. Called only for permission-mode changes, and only when one really changed. */
  audit(
    caller: ConversationCaller,
    detail: { conversationId: string; from: PermissionMode; to: PermissionMode },
  ): Promise<void>;
}

/** `/v1/conversations/{id}/settings` → the id, or a 404-shaped refusal. */
function idFrom(path: string, suffix: string): string {
  const rest = path.slice("/v1/conversations/".length);
  if (!rest.endsWith(suffix)) throw new HttpError(404, "not_found", "no such route");
  const id = rest.slice(0, -suffix.length);
  // A single segment, and nothing that could climb out of it. The store scopes every statement by
  // workspace anyway, so this is the second wall rather than the first — but a route that accepted
  // `../` in an id would be one refactor away from being the first wall as well.
  if (!id || id.includes("/")) throw new HttpError(404, "not_found", "no such route");
  return id;
}

/**
 * A conversation that is not this workspace's answers 404, not 403.
 *
 * The distinction is the whole of it: a 403 confirms the id exists, which turns this route into an
 * oracle for enumerating another tenant's conversation ids. "Not found" is true from where the
 * caller stands, and it is the same answer they get for an id that was never real.
 */
async function requireThread(
  deps: ConversationRouteDeps,
  caller: ConversationCaller,
  conversationId: string,
): Promise<void> {
  if (await deps.threadExists(caller.ctx, conversationId)) return;
  throw new HttpError(404, "not_found", "no such conversation");
}

/** What the client gets back. The EFFECTIVE values, never what it asked for — see the PATCH. */
function view(s: EffectiveSettings): Record<string, unknown> {
  return {
    reasoning_effort: s.effort,
    permission_mode: s.permissionMode,
    permission_mode_pinned: s.pinned,
    fast_disallowed: s.fastDisallowed,
    explicit: s.explicit,
  };
}

/**
 * Read one field of a PATCH body, distinguishing the three things a client can mean.
 *
 * ABSENT, NULL AND A VALUE ARE THREE REQUESTS, not two. Absent leaves the field alone; null clears
 * it back to the workspace default; a value sets it. Collapsing null into absent would leave no
 * way to say "go back to inheriting" — and a client forced to write today's default instead would
 * freeze that conversation against every future change to it.
 */
function readField<T>(
  body: Record<string, unknown>,
  key: string,
  ok: (v: unknown) => v is T,
  what: string,
): T | null | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null) return null;
  if (ok(raw)) return raw;
  throw new HttpError(400, "invalid_value", `${key} must be null or one of ${what}`);
}

/**
 * The deck's rows: the workspace's connectors joined with this conversation's decisions.
 *
 * ONE BUILDER FOR THE GET AND THE PUT. They answer with the same shape, and two constructions of
 * it would drift the first time a field was added — leaving a deck that rendered differently
 * depending on whether it had just been toggled.
 */
async function connectorView(
  deps: ConversationRouteDeps,
  caller: ConversationCaller,
  conversationId: string,
): Promise<Record<string, unknown>[]> {
  const available = await deps.workspaceConnectors(caller.ctx);
  const decisions = await deps.connectors.decisionsFor(caller.ctx, conversationId);
  return available.map((c) => ({
    id: c.id,
    label: c.label,
    logo_url: c.logoUrl,
    tool_count: c.toolCount,
    warning: c.warning,
    // The absent-row rule, at the wire: a connector nobody has ruled on is on.
    enabled: decisions.get(c.id) ?? true,
  }));
}

export function conversationRoutes(deps: ConversationRouteDeps): ConversationRoute[] {
  return [
    {
      // ONE GET ON THE PREFIX, BRANCHING ON THE SUFFIX, and that is a constraint of the router
      // rather than a preference: it matches the FIRST prefix route with this method, so a second
      // `GET /v1/conversations/` would be unreachable code that looks like a mounted route.
      method: "GET",
      path: "/v1/conversations/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        if (req.path.endsWith("/pins")) {
          const id = idFrom(req.path, "/pins");
          await requireThread(deps, caller, id);
          // §12.20: a pin is invisible to anybody else, and the user in this call is what makes
          // that true. There is no shape of this request that could ask for somebody else's — the
          // id comes from the token, not from the URL.
          if (!caller.userId) return { body: { pins: [] } };
          return { body: { pins: await deps.interaction.pinsFor(caller.ctx, id, caller.userId) } };
        }
        if (req.path.endsWith("/connectors")) {
          const id = idFrom(req.path, "/connectors");
          await requireThread(deps, caller, id);
          return { body: { connectors: await connectorView(deps, caller, id) } };
        }
        const id = idFrom(req.path, "/settings");
        await requireThread(deps, caller, id);
        return { body: view(await deps.settings.effective(caller.ctx, id)) };
      },
    },
    {
      method: "PATCH",
      path: "/v1/conversations/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        const id = idFrom(req.path, "/settings");
        await requireThread(deps, caller, id);

        const body = await req.json();
        const effort = readField<Effort>(body, "reasoning_effort", isEffort, "low, medium, high, xhigh");
        const mode = readField<PermissionMode>(body, "permission_mode", isPermissionMode, "strict, smart, fast");

        // Read BEFORE the write, because the audit row needs the old value and the store's return
        // is the new one. Doing this after would leave "from" and "to" identical on every row,
        // which is an audit trail that records that something changed and not what.
        const before = await deps.settings.effective(caller.ctx, id);

        // THE PIN IS REFUSED HERE, LOUDLY. The resolver already ignores a conversation's mode when
        // the workspace has pinned one, so accepting this write would be harmless and dishonest:
        // the client would render a mode nobody is running under until its next read. §3.2 renders
        // the control read-only for exactly this reason; the server saying so is what makes the
        // read-only state a policy rather than a client-side courtesy.
        if (mode !== undefined && before.pinned) {
          throw new HttpError(409, "mode_pinned", "a workspace admin has pinned the permission mode for this workspace");
        }
        if (mode === "fast" && before.fastDisallowed) {
          throw new HttpError(409, "fast_disallowed", "a workspace admin has disallowed Fast mode in this workspace");
        }

        const after = await deps.settings.set(
          caller.ctx, id, { effort, permissionMode: mode }, caller.userId,
        );

        // ONLY WHEN IT ACTUALLY MOVED. A PATCH that sets the mode to what it already was is a
        // no-op, and an audit row per no-op is how "who loosened the gate" becomes unanswerable by
        // volume rather than by absence.
        if (after.permissionMode !== before.permissionMode) {
          await deps.audit(caller, {
            conversationId: id,
            from: before.permissionMode,
            to: after.permissionMode,
          });
        }

        // The EFFECTIVE values, not the requested ones. They differ whenever a workspace policy
        // had something to say, and a client that echoed its own request back would render a
        // setting the server is not running under.
        return { body: view(after) };
      },
    },
    {
      method: "PUT",
      path: "/v1/conversations/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        const id = idFrom(req.path, "/connectors");
        await requireThread(deps, caller, id);

        const body = await req.json<{ connectors?: unknown }>();
        const raw = body.connectors;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          throw new HttpError(400, "invalid_body", "connectors must be an object of id -> boolean");
        }

        // ONLY CONNECTORS THE WORKSPACE ACTUALLY HAS. A decision about a connector that does not
        // exist is harmless at read time — it joins against nothing — and accepting it would still
        // be wrong: the table would accumulate rows nobody can explain, and a typo'd id would look
        // like a setting that quietly does nothing.
        const known = new Set((await deps.workspaceConnectors(caller.ctx)).map((c) => c.id));
        const map: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!known.has(key)) throw new HttpError(400, "unknown_connector", `this workspace has no connector "${key}"`);
          if (typeof value !== "boolean") throw new HttpError(400, "invalid_value", `${key} must be true or false`);
          map[key] = value;
        }

        await deps.connectors.setMany(caller.ctx, id, map, caller.userId);
        return { body: { connectors: await connectorView(deps, caller, id) } };
      },
    },
  ];
}

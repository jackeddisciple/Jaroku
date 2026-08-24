// The turn routes — §8's second group.
//
// Attachments today; variants, notes, pins and feedback join them here in M4, because they are the
// same resource with the same scoping and the same "who is asking" question.
//
// A TURN IS A `thread_items` ROW. Jaroku has no table called `turns`: migration 044's join table
// is the durable per-turn record — a message somebody sent, a plan, a generation, a run — and it
// is what every table in §7 keys on. The spec's vocabulary and this schema's meet here, in the
// foreign key, once.
//
// THE CLIENT SENDS REFS AND NEVER BLOBS (§4.4). Every route below takes a reference and resolves
// it server-side; none of them accepts a file body, and `GET /attachables` is what makes that
// possible — the pickers are populated from the server, so the client never has to have read the
// thing it is attaching. §12.16 states the consequence as an acceptance criterion: "No route
// returns a token; no client request carries one."
//
// AND `attachables` IS ONE ROUTE, NOT FIVE. §4.2: "Each opens a searchable picker built on the
// existing Cmd+K palette infrastructure — same component, different data source. Do not build five
// bespoke modals." The server side of that decision is this: one route, one shape, `kind` selects
// the source.
//
//   npm run test:turn-routes

import { HttpError, type Handler, type HttpRequest } from "./router.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  MAX_ATTACHMENTS, checkBudget, checkCount, isAttachmentKind, labelFor, validateRef,
  type AttachmentKind, type BudgetVerdict, type ResolvedAttachment,
} from "../attachments.ts";
import type { AttachmentStore, StoredAttachment } from "../attachmentStore.ts";

export interface TurnRoute {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  prefix?: boolean;
  handler: Handler;
}

export interface TurnCaller {
  ctx: TenantContext;
  userId: string | null;
  ip: string | null;
}

/** One row a picker can show. Deliberately the same shape for all five sources — see the header. */
export interface Attachable {
  /** What goes into the ref when this row is chosen. Already resolved, already pinned. */
  ref: Record<string, unknown>;
  /** The chip's label and the picker's primary line. */
  label: string;
  /** The picker's secondary line: a status, a relative time, an argument count. */
  detail?: string;
  /** What it will cost the context window, measured server-side. */
  tokenEstimate: number;
  /** §4.2: a protected file attaches with a lock. Never a reason to hide the row. */
  protected?: boolean;
}

export interface TurnRouteDeps {
  callerFor(req: HttpRequest): Promise<TurnCaller>;
  attachments: AttachmentStore;
  /** Whether this turn exists IN THIS WORKSPACE. A 404 either way — see `requireTurn`. */
  turnExists(ctx: TenantContext, turnId: string): Promise<boolean>;
  /**
   * The candidate rows for one picker.
   *
   * SERVER-FILTERED AND PAGINATED, per §8's note on this route. A picker over an agent with two
   * hundred files that shipped the whole list to the browser and filtered it there would be fine
   * until the first agent with two thousand.
   */
  attachables(
    ctx: TenantContext,
    agentId: string,
    kind: AttachmentKind,
    query: string,
    limit: number,
  ): Promise<Attachable[]>;
  /** The model the composer is currently pointed at, for the budget check. */
  modelForTurn(ctx: TenantContext, turnId: string): Promise<string>;
}

/** `/v1/turns/{id}/attachments[/{aid}]` → the two ids. */
function idsFrom(path: string): { turnId: string; attachmentId: string | null } {
  const rest = path.slice("/v1/turns/".length);
  const parts = rest.split("/").filter((p) => p !== "");
  // turn / "attachments" [/ id]
  if (parts.length < 2 || parts[1] !== "attachments") throw new HttpError(404, "not_found", "no such route");
  if (parts.length > 3) throw new HttpError(404, "not_found", "no such route");
  const turnId = parts[0]!;
  // The store scopes every statement by workspace anyway, so this is the second wall — but a route
  // that let a `..` through would be one refactor away from being the first.
  if (!turnId || turnId === "." || turnId === "..") throw new HttpError(404, "not_found", "no such route");
  return { turnId, attachmentId: parts[2] ?? null };
}

/**
 * A turn that is not this workspace's answers 404, not 403.
 *
 * The same reasoning as the conversation routes: a 403 confirms the id exists, which turns this
 * into an oracle for enumerating another tenant's turns. "Not found" is true from where the caller
 * stands, and is the answer an id that was never real gets.
 */
async function requireTurn(deps: TurnRouteDeps, caller: TurnCaller, turnId: string): Promise<void> {
  if (await deps.turnExists(caller.ctx, turnId)) return;
  throw new HttpError(404, "not_found", "no such turn");
}

function view(a: StoredAttachment): Record<string, unknown> {
  return {
    id: a.id,
    kind: a.kind,
    ref: a.ref,
    label: a.label,
    resolved_at: a.resolved_at,
    token_estimate: a.token_estimate,
  };
}

function budgetView(b: BudgetVerdict): Record<string, unknown> {
  return {
    level: b.level,
    tokens: b.tokens,
    window: b.window,
    fraction: b.fraction,
    offending: b.offending,
    message: b.message,
  };
}

export function turnRoutes(deps: TurnRouteDeps): TurnRoute[] {
  return [
    {
      method: "GET",
      path: "/v1/turns/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        const { turnId } = idsFrom(req.path);
        await requireTurn(deps, caller, turnId);
        const rows = await deps.attachments.forTurn(caller.ctx, turnId);
        const model = await deps.modelForTurn(caller.ctx, turnId);
        return {
          body: {
            attachments: rows.map(view),
            budget: budgetView(checkBudget(rows.map(toResolved), model)),
          },
        };
      },
    },
    {
      method: "POST",
      path: "/v1/turns/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        const { turnId, attachmentId } = idsFrom(req.path);
        if (attachmentId) throw new HttpError(404, "not_found", "no such route");
        await requireTurn(deps, caller, turnId);

        const body = await req.json<{ attachments?: unknown }>();
        const raw = Array.isArray(body.attachments) ? body.attachments : null;
        if (!raw || raw.length === 0) {
          throw new HttpError(400, "invalid_body", "attachments must be a non-empty array");
        }

        // THE CAP IS CHECKED AGAINST WHAT IS ALREADY THERE PLUS WHAT IS ARRIVING, not against
        // either alone. Two requests of six would otherwise land twelve.
        const existing = await deps.attachments.countFor(caller.ctx, turnId);
        if (existing + raw.length > MAX_ATTACHMENTS) {
          throw new HttpError(
            409, "too_many_attachments",
            checkCount(existing).message
              ?? `A turn can carry ${MAX_ATTACHMENTS} attachments; this would make ${existing + raw.length}.`,
          );
        }

        const resolved: ResolvedAttachment[] = [];
        for (const item of raw) {
          const rec = (item ?? {}) as Record<string, unknown>;
          const kind = rec.kind;
          if (!isAttachmentKind(kind)) {
            throw new HttpError(400, "invalid_kind", `kind must be one of ${["file", "run", "dataset_case", "tool_schema", "github"].join(", ")}`);
          }
          const problem = validateRef(kind, rec.ref);
          if (problem) throw new HttpError(400, "invalid_ref", problem);
          const ref = rec.ref as Record<string, unknown>;

          // THE ESTIMATE IS NOT TAKEN FROM THE REQUEST. §4.4's budget check is only a check if the
          // number it compares was measured here — a client-supplied estimate would let any request
          // through by claiming to be small, and the overflow would be truncated silently.
          const measured = await deps.attachables(
            caller.ctx, String(rec.agent_id ?? ""), kind, "", 0,
          ).catch(() => [] as Attachable[]);
          const match = measured.find((m) => sameRef(m.ref, ref));

          resolved.push({
            kind,
            ref,
            tokenEstimate: match?.tokenEstimate ?? 0,
            label: labelFor(kind, ref),
            protected: match?.protected,
          });
        }

        // BUDGET BEFORE WRITE. Writing the rows and then reporting they do not fit would leave a
        // turn carrying context it will never be sent with.
        const model = await deps.modelForTurn(caller.ctx, turnId);
        const priorRows = await deps.attachments.forTurn(caller.ctx, turnId);
        const budget = checkBudget([...priorRows.map(toResolved), ...resolved], model);
        if (budget.level === "over") {
          throw new HttpError(413, "over_context_budget", budget.message ?? "this turn's context does not fit");
        }

        const rows = await deps.attachments.attach(caller.ctx, turnId, resolved);
        return { body: { attachments: rows.map(view), budget: budgetView(budget) } };
      },
    },
    {
      method: "DELETE",
      path: "/v1/turns/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        const { turnId, attachmentId } = idsFrom(req.path);
        if (!attachmentId) throw new HttpError(404, "not_found", "no such route");
        await requireTurn(deps, caller, turnId);
        // An attachment that is not there answers the same as one that never was. A different
        // answer would confirm an id, and there is nothing useful a client does with the
        // difference: either way, it is gone.
        await deps.attachments.remove(caller.ctx, turnId, attachmentId);
        const rows = await deps.attachments.forTurn(caller.ctx, turnId);
        const model = await deps.modelForTurn(caller.ctx, turnId);
        return { body: { attachments: rows.map(view), budget: budgetView(checkBudget(rows.map(toResolved), model)) } };
      },
    },
    {
      method: "GET",
      path: "/v1/agents/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        const rest = req.path.slice("/v1/agents/".length).split("/").filter((p) => p !== "");
        if (rest.length !== 2 || rest[1] !== "attachables") throw new HttpError(404, "not_found", "no such route");
        const agentId = rest[0]!;

        const kind = req.url.searchParams.get("kind");
        if (!isAttachmentKind(kind)) throw new HttpError(400, "invalid_kind", "kind must name one of the five sources");

        const query = (req.url.searchParams.get("q") ?? "").slice(0, 200);
        // Bounded here rather than trusted from the query string. A picker asks for 50; a request
        // asking for 50,000 is a request to read an agent's whole tree into memory.
        const asked = Number(req.url.searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 200) : 50;

        const rows = await deps.attachables(caller.ctx, agentId, kind, query, limit);
        return {
          body: {
            kind,
            rows: rows.map((r) => ({
              ref: r.ref,
              label: r.label,
              detail: r.detail ?? null,
              token_estimate: r.tokenEstimate,
              protected: r.protected ?? false,
            })),
          },
        };
      },
    },
  ];
}

function toResolved(a: StoredAttachment): ResolvedAttachment {
  return { kind: a.kind, ref: a.ref, tokenEstimate: a.token_estimate, label: a.label };
}

/**
 * Whether two refs name the same thing.
 *
 * KEY ORDER IS NOT PART OF THE ANSWER, which is why this is not `JSON.stringify(a) ===
 * JSON.stringify(b)`. A ref built by the picker and a ref echoed back by a client can carry the
 * same fields in a different order, and treating those as different attachments would mean the
 * measured token estimate never matched and every attachment silently costed zero.
 */
function sameRef(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k && String(a[k]) === String(b[k]));
}

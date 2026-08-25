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
import {
  isFeedbackReason, type FeedbackReason, type TurnInteractionStore,
} from "../turnInteraction.ts";

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
  interaction: TurnInteractionStore;
  /**
   * Display names for note authors.
   *
   * RESOLVED SERVER-SIDE rather than sent as ids the client looks up, because the client has no
   * member directory for a workspace it is not administering — and a note signed with a uuid is a
   * note nobody knows who wrote.
   */
  displayNames(ctx: TenantContext, userIds: readonly string[]): Promise<Map<string, string>>;
}

/**
 * `/v1/turns/{id}/{resource}[/{sub}]` → its parts.
 *
 * ONE PARSER AND ONE ROUTE PER METHOD, branching on `resource`. That is a constraint of the router
 * rather than a preference: it matches the FIRST prefix route with a given method, so a second
 * `GET /v1/turns/` would be unreachable code that looks exactly like a mounted route.
 */
function partsFrom(path: string): { turnId: string; resource: string; sub: string | null } {
  const rest = path.slice("/v1/turns/".length);
  const parts = rest.split("/").filter((p) => p !== "");
  if (parts.length < 2 || parts.length > 3) throw new HttpError(404, "not_found", "no such route");
  const turnId = parts[0]!;
  // The store scopes every statement by workspace anyway, so this is the second wall — but a route
  // that let a `..` through would be one refactor away from being the first.
  if (!turnId || turnId === "." || turnId === "..") throw new HttpError(404, "not_found", "no such route");
  return { turnId, resource: parts[1]!, sub: parts[2] ?? null };
}

/** The attachment routes' own reading of it, unchanged in meaning. */
function idsFrom(path: string): { turnId: string; attachmentId: string | null } {
  const { turnId, resource, sub } = partsFrom(path);
  if (resource !== "attachments") throw new HttpError(404, "not_found", "no such route");
  return { turnId, attachmentId: sub };
}

/** §5.2's note list, with author names resolved — see `displayNames`. */
async function notesView(
  deps: TurnRouteDeps,
  caller: TurnCaller,
  turnId: string,
): Promise<Record<string, unknown>[]> {
  const notes = await deps.interaction.notesFor(caller.ctx, turnId);
  const names = await deps.displayNames(
    caller.ctx,
    [...new Set(notes.map((n) => n.author_id).filter((id): id is string => Boolean(id)))],
  );
  return notes.map((n) => ({
    id: n.id,
    turn_id: n.turn_id,
    author_id: n.author_id,
    author_name: n.author_id ? (names.get(n.author_id) ?? null) : null,
    body: n.body,
    created_at: n.created_at,
    updated_at: n.updated_at,
  }));
}

/** A body's rating field, distinguishing "clear it" from "you sent nonsense". */
function readRating(raw: unknown): -1 | 1 | null {
  if (raw === null) return null;
  if (raw === 1 || raw === -1) return raw;
  throw new HttpError(400, "invalid_rating", "rating must be 1, -1 or null");
}

function readReasons(raw: unknown): FeedbackReason[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_reasons", "reasons must be an array");
  // UNKNOWN REASONS ARE DROPPED RATHER THAN REFUSED. The set is closed so the aggregate stays
  // countable, and a client one release ahead sending a sixth reason should still have its
  // thumbs-down recorded — losing the signal over a label would be the worse trade.
  return raw.filter(isFeedbackReason);
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
        const { turnId, resource } = partsFrom(req.path);
        await requireTurn(deps, caller, turnId);

        if (resource === "interaction") {
          // ONE READ FOR THE WHOLE ACTION ROW. Notes and feedback are rendered together under every
          // turn, and two requests per turn to draw one strip of glyphs would be a request per turn
          // per resource on every thread open.
          //
          // COUNTS, NOT NAMES, for feedback — §5.5's "workspace-visible in aggregate". The reason
          // text is a separate read the store cannot even return from here.
          return {
            body: {
              notes: await notesView(deps, caller, turnId),
              feedback: await deps.interaction.feedbackFor(caller.ctx, turnId, caller.userId ?? ""),
            },
          };
        }

        if (resource !== "attachments") throw new HttpError(404, "not_found", "no such route");
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
        const { turnId, resource, sub } = partsFrom(req.path);
        await requireTurn(deps, caller, turnId);

        if (resource === "notes") {
          if (sub) throw new HttpError(404, "not_found", "no such route");
          const noteBody = (await req.json<{ body?: unknown }>()).body;
          if (typeof noteBody !== "string" || !noteBody.trim()) {
            throw new HttpError(400, "invalid_body", "a note needs something in it");
          }
          // Bounded, because this is free text a client sends. §5.2 describes a short annotation —
          // "plain text + inline code" — and an unbounded body would make a note a document, with
          // a rendering problem and a storage one that the feature deliberately does not have.
          if (noteBody.length > 2000) {
            throw new HttpError(400, "note_too_long", "a note is an annotation — keep it under 2000 characters");
          }
          await deps.interaction.addNote(caller.ctx, turnId, caller.userId, noteBody.trim());
          return { body: { notes: await notesView(deps, caller, turnId) } };
        }

        if (resource !== "attachments" || sub) throw new HttpError(404, "not_found", "no such route");
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
        const { turnId, resource, sub } = partsFrom(req.path);
        await requireTurn(deps, caller, turnId);

        if (resource === "notes") {
          if (!sub) throw new HttpError(404, "not_found", "no such route");
          if (!caller.userId) throw new HttpError(403, "not_the_author", "only a note's author can delete it");
          // AUTHOR-ONLY, and the store's WHERE is what enforces it — see `deleteNote`. A false
          // return is somebody else's note, and it answers the same as a note that was never there:
          // a different answer would confirm the id exists and who wrote it.
          await deps.interaction.deleteNote(caller.ctx, sub, caller.userId);
          return { body: { notes: await notesView(deps, caller, turnId) } };
        }

        if (resource === "pin") {
          const conversationId = req.url.searchParams.get("conversation");
          if (!conversationId) throw new HttpError(400, "missing_conversation", "a pin needs its conversation");
          if (!caller.userId) throw new HttpError(403, "no_user", "a pin belongs to a person");
          await deps.interaction.unpin(caller.ctx, turnId, caller.userId);
          return { body: { pins: await deps.interaction.pinsFor(caller.ctx, conversationId, caller.userId) } };
        }

        if (resource !== "attachments") throw new HttpError(404, "not_found", "no such route");
        const attachmentId = sub;
        if (!attachmentId) throw new HttpError(404, "not_found", "no such route");
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
      // §5.3's pin and §5.5's feedback. Both are PUTs because both are idempotent statements of a
      // desired state — "this is pinned", "my rating is this" — rather than events to append.
      method: "PUT",
      path: "/v1/turns/",
      prefix: true,
      handler: async (req) => {
        const caller = await deps.callerFor(req);
        const { turnId, resource, sub } = partsFrom(req.path);
        if (sub) throw new HttpError(404, "not_found", "no such route");
        await requireTurn(deps, caller, turnId);
        if (!caller.userId) throw new HttpError(403, "no_user", "this belongs to a person");

        if (resource === "pin") {
          const conversationId = req.url.searchParams.get("conversation");
          if (!conversationId) throw new HttpError(400, "missing_conversation", "a pin needs its conversation");
          const res = await deps.interaction.pin(caller.ctx, conversationId, turnId, caller.userId);
          return {
            body: {
              pins: await deps.interaction.pinsFor(caller.ctx, conversationId, caller.userId),
              // §5.3: "pinning a 6th prompts to unpin one." A FLAG RATHER THAN AN ERROR STATUS,
              // because the client's response is a prompt and not a failure — a 409 here would
              // reach the store's generic error path and render as "something went wrong".
              at_limit: res.atLimit,
            },
          };
        }

        if (resource === "feedback") {
          const body = await req.json<{ rating?: unknown; reasons?: unknown; comment?: unknown }>();
          const rating = readRating(body.rating ?? null);
          const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim().slice(0, 1000) : null;
          // REASONS AND A COMMENT ONLY EVER RIDE WITH A THUMBS DOWN. §5.5: "Thumbs up: fills, no
          // further UI." Storing a reason against a positive rating would put rows in the aggregate
          // that no UI can produce and no report knows how to read.
          const reasons = rating === -1 ? readReasons(body.reasons) : [];
          const summary = await deps.interaction.setFeedback(
            caller.ctx, turnId, caller.userId, rating, reasons, rating === -1 ? comment : null,
          );
          return { body: summary };
        }

        throw new HttpError(404, "not_found", "no such route");
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

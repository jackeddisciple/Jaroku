// The conversation settings routes, and the four refusals they owe a client.
//
// A settings route is easy to get right in the happy case and the failures are what matter here,
// because three of them are policy rather than validation:
//
//   A conversation in another workspace answers 404, not 403 — a 403 confirms the id exists, which
//   makes this route an oracle for enumerating another tenant's conversations.
//   A pinned workspace answers 409 rather than accepting a write the resolver would then ignore.
//   Fast answers 409 where an admin has disallowed it.
//   And the response is the EFFECTIVE settings, never an echo of the request.
//
// Plus §3.2's audit requirement, which is the one assertion here about a row rather than a status:
// "Mode changes write to audit_log with actor, conversation, old value, new value."
//
//   npm run test:conversation-routes

import { randomUUID } from "node:crypto";

import { conversationRoutes, type ConversationCaller } from "./conversations.ts";
import { HttpError, type HttpRequest } from "./router.ts";
import { ConversationSettingsStore, type PermissionMode } from "../conversationSettings.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { newRequestId } from "../db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const OTHER = randomUUID();

/** Just enough of an HttpRequest for these two handlers. */
function req(method: string, path: string, body?: unknown): HttpRequest {
  return {
    requestId: newRequestId(),
    method,
    path,
    url: new URL(`http://localhost${path}`),
    raw: {} as never,
    ip: "127.0.0.1",
    header: () => undefined,
    json: async <T,>() => (body ?? {}) as T,
    buffer: async () => Buffer.alloc(0),
  };
}

async function statusOf(fn: () => unknown): Promise<{ status: number; code: string }> {
  try {
    await fn();
    return { status: 200, code: "" };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code };
    throw e;
  }
}

interface AuditRow { conversationId: string; from: PermissionMode; to: PermissionMode; actor: string | null }

async function harness() {
  const db = await openTestSqlite();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [OTHER, `ws-${OTHER.slice(0, 8)}`, "Other", new Date().toISOString()],
  );
  // A REAL USER ROW, because `conversation_settings.updated_by` references `users(id)` and SQLite
  // enforces it here. Passing a made-up actor id was a foreign-key failure rather than a row with
  // a dangling attribution — which is the right way round, and worth stating: the audit trail and
  // the settings row both name a person, and a person who does not exist must not be nameable.
  const USER = randomUUID();
  await db.run(
    `INSERT INTO users (id, external_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    [USER, `ext-${USER.slice(0, 8)}`, `${USER.slice(0, 8)}@example.test`, "Test User", new Date().toISOString()],
  );

  const settings = new ConversationSettingsStore(db);
  const audits: AuditRow[] = [];

  const seedThread = async (workspaceId: string): Promise<string> => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO threads (id, workspace_id, title, title_is_custom, created_at, last_activity_at, status)
       VALUES (?, ?, 'A thread', 0, ?, ?, 'idle')`,
      [id, workspaceId, now, now],
    );
    return id;
  };

  let caller: ConversationCaller = { ctx, userId: USER, ip: "127.0.0.1" };
  const routes = conversationRoutes({
    callerFor: async () => caller,
    settings,
    threadExists: async (c, id) => {
      const row = await db.forWorkspace(c.workspaceId).get(
        `SELECT id FROM threads WHERE workspace_id = ? AND id = ?`, [c.workspaceId, id],
      );
      return row !== undefined;
    },
    audit: async (c, d) => { audits.push({ ...d, actor: c.userId }); },
  });

  const get = routes.find((r) => r.method === "GET")!.handler;
  const patch = routes.find((r) => r.method === "PATCH")!.handler;
  return {
    db, settings, audits, seedThread, get, patch, userId: USER,
    as: (c: ConversationCaller) => { caller = c; },
    close: () => db.close(),
  };
}

console.log("\na conversation nobody has touched reads as the workspace defaults");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);
  const res = await h.get(req("GET", `/v1/conversations/${thread}/settings`));
  const body = res.body as Record<string, unknown>;
  check("effort is the default", body.reasoning_effort === "medium", String(body.reasoning_effort));
  check("the mode is Smart", body.permission_mode === "smart", String(body.permission_mode));
  check("nothing is pinned", body.permission_mode_pinned === false);
  await h.close();
}

console.log("\nthe response is what is IN EFFECT, never an echo of the request");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);
  const res = await h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { reasoning_effort: "xhigh" }));
  const body = res.body as Record<string, unknown>;
  check("the level took", body.reasoning_effort === "xhigh");
  check("...and it is reported as explicit now",
    JSON.stringify(body.explicit) === JSON.stringify({ effort: true, permissionMode: false }),
    JSON.stringify(body.explicit));

  // The other field is untouched, which is the store's contract surfacing through the route.
  check("the mode was not written", body.permission_mode === "smart");
  await h.close();
}

console.log("\nvalidation refuses a level nobody defined, rather than storing it");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);
  const bad = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { reasoning_effort: "extreme" })));
  check("an invented effort is a 400", bad.status === 400 && bad.code === "invalid_value", JSON.stringify(bad));

  // §3.2's "there is no 'approve everything' mode" reaching the wire. The CHECK constraint would
  // catch it too, but a 500 from a constraint is not an answer a client can act on.
  const worse = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { permission_mode: "all" })));
  check("an invented mode is a 400", worse.status === 400 && worse.code === "invalid_value", JSON.stringify(worse));

  // And null is a legitimate request — "go back to inheriting" — not a validation failure.
  const cleared = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { reasoning_effort: null })));
  check("null is accepted, because clearing is a real request", cleared.status === 200, JSON.stringify(cleared));
  await h.close();
}

console.log("\nanother workspace's conversation is 404, never 403");
{
  const h = await harness();
  const theirs = await h.seedThread(OTHER);

  // A 403 would confirm the id is real, which turns this route into an enumeration oracle for
  // another tenant's conversation ids. "Not found" is true from where the caller stands.
  const read = await statusOf(() => h.get(req("GET", `/v1/conversations/${theirs}/settings`)));
  check("reading theirs is 404", read.status === 404 && read.code === "not_found", JSON.stringify(read));
  const write = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${theirs}/settings`, { reasoning_effort: "low" })));
  check("writing theirs is 404 too", write.status === 404, JSON.stringify(write));

  // ...and it is the SAME answer an id that was never real gets, which is what makes it opaque.
  const never = await statusOf(() => h.get(req("GET", `/v1/conversations/${randomUUID()}/settings`)));
  check("an id that never existed is indistinguishable", never.status === 404 && never.code === read.code);

  // A malformed path is refused rather than reaching a query. The store scopes every statement by
  // workspace anyway, so this is the second wall — but a route that let `../` through would be one
  // refactor away from being the first.
  const climb = await statusOf(() => h.get(req("GET", `/v1/conversations/../../etc/settings`)));
  check("a path that tries to climb out is refused", climb.status === 404, JSON.stringify(climb));
  await h.close();
}

console.log("\n§3.2 — a pinned workspace refuses the write rather than quietly ignoring it");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);
  await h.settings.setWorkspaceDefaults(ctx, { permissionMode: "strict", pinned: true });

  // The resolver already ignores a conversation's mode under a pin, so ACCEPTING this write would
  // be harmless and dishonest: the client would render a mode nobody is running under until its
  // next read.
  const pinned = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { permission_mode: "fast" })));
  check("a pinned mode refuses with 409", pinned.status === 409 && pinned.code === "mode_pinned", JSON.stringify(pinned));

  // The effort control is unaffected — the pin is about the shield, and refusing an unrelated
  // field would make an admin's security policy also a spending policy.
  const effort = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { reasoning_effort: "high" })));
  check("...while effort still writes", effort.status === 200, JSON.stringify(effort));
  await h.close();
}

console.log("\n...and Fast is refused where an admin has disallowed it");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);
  await h.settings.setWorkspaceDefaults(ctx, { fastDisallowed: true });

  const fast = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { permission_mode: "fast" })));
  check("Fast is a 409 naming the policy", fast.status === 409 && fast.code === "fast_disallowed", JSON.stringify(fast));
  const strict = await statusOf(() => h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { permission_mode: "strict" })));
  check("...and the other two still work", strict.status === 200, JSON.stringify(strict));
  await h.close();
}

console.log("\n§3.2 — a mode change is audited, with the actor and BOTH values");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);

  await h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { permission_mode: "fast" }));
  check("one row was written", h.audits.length === 1, String(h.audits.length));
  check("...naming the actor", h.audits[0]?.actor === h.userId, h.audits[0]?.actor ?? "null");
  check("...the conversation", h.audits[0]?.conversationId === thread);
  // BOTH values. "Set to Fast" does not distinguish somebody relaxing Strict from somebody who was
  // already on Fast re-saving, and the first is the event this row exists to make findable.
  check("...the old value", h.audits[0]?.from === "smart", h.audits[0]?.from);
  check("...and the new one", h.audits[0]?.to === "fast", h.audits[0]?.to);

  // An effort change is NOT audited. Reasoning effort is a spending decision; the shield is a
  // security one, and only the second is worth a permanent row per keystroke.
  await h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { reasoning_effort: "low" }));
  check("an effort change writes no audit row", h.audits.length === 1, String(h.audits.length));

  // Neither is a no-op. An audit row per re-save is how "who loosened the gate" becomes
  // unanswerable by volume rather than by absence.
  await h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { permission_mode: "fast" }));
  check("re-saving the same mode writes nothing", h.audits.length === 1, String(h.audits.length));

  await h.patch(req("PATCH", `/v1/conversations/${thread}/settings`, { permission_mode: "strict" }));
  check("a real change writes another", h.audits.length === 2 && h.audits[1]?.from === "fast" && h.audits[1]?.to === "strict");
  await h.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

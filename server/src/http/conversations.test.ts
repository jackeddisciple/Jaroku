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
import { ConversationConnectorStore } from "../conversationConnectors.ts";
import { TurnInteractionStore } from "../turnInteraction.ts";
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
  const connectors = new ConversationConnectorStore(db);
  const interaction = new TurnInteractionStore(db);
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
    connectors,
    interaction,
    // Two connectors, one of them with a dying credential — enough for the deck's join and for
    // §3.2's health row without standing up an OAuth flow in a route suite.
    workspaceConnectors: async () => [
      { id: "slack", label: "Slack", logoUrl: null, toolCount: 12, warning: null },
      { id: "notion", label: "Notion", logoUrl: null, toolCount: 9, warning: "token expires in 3 days" },
    ],
    audit: async (c, d) => { audits.push({ ...d, actor: c.userId }); },
  });

  const get = routes.find((r) => r.method === "GET")!.handler;
  const patch = routes.find((r) => r.method === "PATCH")!.handler;
  const put = routes.find((r) => r.method === "PUT")!.handler;
  return {
    db, settings, connectors, audits, seedThread, get, patch, put, userId: USER,
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

console.log("\n§3.2 — a connector nobody has ruled on is available");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);
  const res = await h.get(req("GET", `/v1/conversations/${thread}/connectors`));
  const rows = (res.body as { connectors: Record<string, unknown>[] }).connectors;

  // THE ABSENT ROW MEANS YES, which is the opposite of the settings table and correct for the same
  // reason it is correct there. A conversation started before Notion was connected must still be
  // able to reach Notion, so nothing is backfilled and nothing defaults to off.
  check("both connectors are listed", rows.length === 2, String(rows.length));
  check("...and both are on", rows.every((r) => r.enabled === true));
  check("...with the deck's fields", rows[0]!.label === "Slack" && rows[0]!.tool_count === 12);
  // §3.2's health row reaches the client rather than being computed in it.
  check("a dying credential is reported", rows[1]!.warning === "token expires in 3 days", String(rows[1]!.warning));
  await h.close();
}

console.log("\n...and switching one off is recorded, not merely rendered");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);

  const res = await h.put(req("PUT", `/v1/conversations/${thread}/connectors`, { connectors: { slack: false } }));
  const rows = (res.body as { connectors: Record<string, unknown>[] }).connectors;
  check("Slack is off", rows.find((r) => r.id === "slack")?.enabled === false);
  // §12.9 / §3.2: a disabled connector STAYS in the list — "its absence would be more confusing
  // than its dimming", and a deck that shrank would read as a workspace disconnection.
  check("...and is still listed", rows.length === 2);
  check("...while the other is untouched", rows.find((r) => r.id === "notion")?.enabled === true);

  // §12.10's other half: the row is what the dispatch reads, so the toggle is a capability rather
  // than a display filter. A version of this that only dimmed a logo would leave the tool in the
  // dispatch, the model would call it anyway, and the user would conclude the control does nothing.
  const enabled = await h.connectors.enabledFor(ctx, thread, ["slack", "notion"]);
  check("the dispatch sees only what is on", enabled.join(",") === "notion", enabled.join(","));

  // Turning it back on WRITES rather than deletes, so "deliberately re-enabled" and "never
  // touched" stay distinguishable — which matters the first time somebody asks why a conversation
  // started using Slack again.
  await h.put(req("PUT", `/v1/conversations/${thread}/connectors`, { connectors: { slack: true } }));
  const decisions = await h.connectors.decisionsFor(ctx, thread);
  check("re-enabling leaves a row behind", decisions.get("slack") === true, JSON.stringify([...decisions]));
  await h.close();
}

console.log("\n...and the workspace connection itself is untouched");
{
  // The other half of §12.10, and the half a user is afraid of: "leaves the workspace connection
  // intact". Scoping a conversation must not reach the workspace's list at all, which is why this
  // table records decisions and never membership.
  const h = await harness();
  const a = await h.seedThread(ctx.workspaceId);
  const b = await h.seedThread(ctx.workspaceId);

  await h.put(req("PUT", `/v1/conversations/${a}/connectors`, { connectors: { slack: false } }));

  const other = (await h.get(req("GET", `/v1/conversations/${b}/connectors`))).body as {
    connectors: Record<string, unknown>[];
  };
  check("a second conversation still has Slack", other.connectors.find((r) => r.id === "slack")?.enabled === true);
  check("...and still has both", other.connectors.length === 2);
  await h.close();
}

console.log("\n...and a connector this workspace does not have is refused");
{
  const h = await harness();
  const thread = await h.seedThread(ctx.workspaceId);
  // Harmless at read time — it joins against nothing — and still wrong: the table would accumulate
  // rows nobody can explain, and a typo'd id would look like a setting that quietly does nothing.
  const bad = await statusOf(() => h.put(req("PUT", `/v1/conversations/${thread}/connectors`, { connectors: { gmail: false } })));
  check("an unknown connector is a 400", bad.status === 400 && bad.code === "unknown_connector", JSON.stringify(bad));
  const wrongType = await statusOf(() => h.put(req("PUT", `/v1/conversations/${thread}/connectors`, { connectors: { slack: "off" } })));
  check("a non-boolean is a 400", wrongType.status === 400 && wrongType.code === "invalid_value", JSON.stringify(wrongType));
  const notAnObject = await statusOf(() => h.put(req("PUT", `/v1/conversations/${thread}/connectors`, { connectors: ["slack"] })));
  check("an array body is a 400", notAnObject.status === 400, JSON.stringify(notAnObject));
  await h.close();
}

console.log("\n...and another workspace's conversation is 404 here too");
{
  const h = await harness();
  const theirs = await h.seedThread(OTHER);
  const read = await statusOf(() => h.get(req("GET", `/v1/conversations/${theirs}/connectors`)));
  check("reading their deck is 404", read.status === 404, JSON.stringify(read));
  const write = await statusOf(() => h.put(req("PUT", `/v1/conversations/${theirs}/connectors`, { connectors: { slack: false } })));
  check("scoping their conversation is 404", write.status === 404, JSON.stringify(write));
  await h.close();
}


console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

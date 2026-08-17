// The threads channel, over a real socket: who is answered, and who is told.
//
// §7.1 states two halves of one convention, and the second is the one a test has to hold down:
//
//   READS ARE ANSWERED LOCALLY, TO THE REQUESTING CLIENT ONLY. `listThreads` and `loadThread` come
//   back on the asking socket. `loadThread` in particular must not broadcast — it is one client's
//   navigation, and a broadcast would collapse every other tab in the workspace out of its
//   full-screen view and into somebody else's conversation.
//
//   MUTATIONS ARE FORWARDED AND ANSWERED WITH A FULL SNAPSHOT. Every client in the workspace
//   receives the same shape a fresh read returns, so no client ever reconciles a partial update
//   against local state — which is also what keeps the §4.4 counts and the §2.1 badge from being
//   one moment behind the rows beside them.
//
// The third thing here is the boundary: two sockets in two workspaces, and a thread id from one
// asked for on the other. It answers "no such thread in this workspace" rather than the row, and
// that sentence is deliberately the same one a genuinely missing id gets.
//
//   npm run test:thread-channel

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { openTestSqlite } from "./db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { TraceStore } from "./store.ts";
import { ThreadStore } from "./threadStore.ts";
import { deriveThreadStatus, NO_FACTS } from "./threadStatus.ts";
import { WsRelay, type ForwardedCommand, type ThreadCounts, type ThreadView } from "./wsRelay.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const threads = new ThreadStore(db);

const A = randomUUID();
const B = randomUUID();
for (const [id, slug] of [[A, "thr-a"], [B, "thr-b"]] as const) {
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [id, slug, slug, new Date().toISOString()],
  );
}
const ctxA = systemContextFor(A, newRequestId());
const ctxB = systemContextFor(B, newRequestId());

/**
 * The app's half, in miniature: derive, count, and broadcast the whole list after a mutation.
 *
 * Deliberately the same shape `index.ts` uses rather than a simplification of it — a harness that
 * answered mutations with anything but a full snapshot would be testing a protocol nothing speaks.
 */
async function snapshot(ctx: TenantContext): Promise<{ threads: ThreadView[]; counts: ThreadCounts }> {
  const rows = await threads.list(ctx);
  const counts: ThreadCounts = { all: 0, needs_you: 0, running: 0, recent: 0, archived: 0 };
  const views = rows.map((row) => {
    const { status, fragment } = deriveThreadStatus({ ...NO_FACTS, archivedAt: row.archived_at });
    if (status === "archived") counts.archived++;
    else if (status === "needs_you" || status === "errored") counts.needs_you++;
    else if (status === "running") counts.running++;
    else counts.recent++;
    return {
      id: row.id,
      agent_id: row.agent_id,
      agent_name: row.agent_name_snapshot,
      agent_deleted: row.agent_id === null && row.agent_name_snapshot !== null,
      title: row.title,
      title_is_custom: row.title_is_custom,
      created_by: row.created_by,
      created_at: row.created_at,
      last_activity_at: row.last_activity_at,
      archived_at: row.archived_at,
      status,
      fragment,
      // The harness stands in for the app, and the app's own snapshot reads these three from the
      // billing ledger and the thread's messages. Nothing in this suite is about either, so they are
      // the honest empty answers: no spend recorded, nothing unpriced, nothing said.
      cost_usd: null,
      cost_known: true,
      preview: null,
    } satisfies ThreadView;
  });
  counts.all = counts.needs_you + counts.running + counts.recent;
  return { threads: views, counts };
}

let connections = 0;
const PORT = 4521;
const relay = new WsRelay({
  port: PORT,
  store,
  clientHtmlPath: "/dev/null",
  contextFor: () => (connections++ === 0 ? ctxA : ctxB),
  listThreads: (ctx) => snapshot(ctx),
  loadThread: async (ctx, id) =>
    (await threads.get(ctx, id)) ? (await snapshot(ctx)).threads.find((t) => t.id === id) : undefined,
  onCommand: (cmd: ForwardedCommand, ctx: TenantContext) => {
    void (async () => {
      if (cmd.cmd === "createThread") await threads.create(ctx, { title: cmd.title });
      else if (cmd.cmd === "renameThread") await threads.rename(ctx, cmd.threadId, cmd.title);
      else if (cmd.cmd === "archiveThread") await threads.archive(ctx, cmd.threadId);
      else if (cmd.cmd === "restoreThread") await threads.restore(ctx, cmd.threadId);
      else return;
      relay.broadcastThreads(ctx, { type: "threads", ...(await snapshot(ctx)) });
    })();
  },
});

interface Client { ws: WebSocket; inbox: Record<string, any>[] }
async function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox: Record<string, any>[] = [];
  ws.on("message", (d) => { try { inbox.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  await new Promise((r) => ws.once("open", r));
  return { ws, inbox };
}
const threadFrames = (c: Client, from = 0): Record<string, any>[] =>
  c.inbox.slice(from).filter((m) => m.channel === "threads");

const a = await connect();
await sleep(150);
const b = await connect();
await sleep(400);

// --- 1. the snapshot arrives unasked, on frame one -----------------------------------------
{
  // §2.1's badge claims you never open the tab just to check. A client that had to ask first would
  // render no badge for as long as the round trip took, which is when somebody decides there is
  // nothing to look at.
  const first = threadFrames(a)[0];
  check("a connecting socket is told about threads without asking", Boolean(first), "no threads frame");
  check("...as a full list with counts", first?.type === "threads" && Boolean(first?.counts));
  check("...empty, honestly, rather than not at all", first?.threads.length === 0 && first?.counts.all === 0);
}

// --- 2. a mutation is forwarded and answered to the whole workspace ------------------------
{
  const beforeA = a.inbox.length;
  const beforeB = b.inbox.length;
  a.ws.send(JSON.stringify({ cmd: "createThread", title: "Stripe webhook retry logic" }));
  await sleep(400);

  const gotA = threadFrames(a, beforeA);
  check("creating a thread answers with a list, not with a row to merge",
    gotA.some((m) => m.type === "threads" && m.threads.length === 1), JSON.stringify(gotA).slice(0, 200));
  check("...carrying the counts computed with it",
    gotA.some((m) => m.type === "threads" && m.counts.all === 1 && m.counts.recent === 1));
  check("...and titled what was asked for",
    gotA.some((m) => m.threads?.[0]?.title === "Stripe webhook retry logic"));

  const gotB = threadFrames(b, beforeB);
  check("the other workspace is told none of it", gotB.length === 0, JSON.stringify(gotB).slice(0, 200));
}

const mine = (await threads.list(ctxA))[0]!;

// --- 3. a read answers the asking socket and nobody else -----------------------------------
{
  const beforeA = a.inbox.length;
  const beforeB = b.inbox.length;
  a.ws.send(JSON.stringify({ cmd: "loadThread", threadId: mine.id }));
  await sleep(300);

  const gotA = threadFrames(a, beforeA);
  check("loadThread answers the client that asked", gotA.some((m) => m.type === "thread"));
  check("...with that thread", gotA.find((m) => m.type === "thread")?.thread?.id === mine.id);
  check("...and does not broadcast, because opening a thread is one client's navigation",
    threadFrames(b, beforeB).length === 0);

  const beforeList = a.inbox.length;
  a.ws.send(JSON.stringify({ cmd: "listThreads" }));
  await sleep(300);
  check("listThreads answers the same shape a mutation broadcasts",
    threadFrames(a, beforeList).some((m) => m.type === "threads" && m.threads.length === 1));
}

// --- 4. rename, archive, restore, each a full snapshot -------------------------------------
{
  a.ws.send(JSON.stringify({ cmd: "renameThread", threadId: mine.id, title: "Retry logic" }));
  await sleep(300);
  check("a rename lands", (await threads.get(ctxA, mine.id))?.title === "Retry logic");
  check("...and is recorded as a person's choice",
    (await threads.get(ctxA, mine.id))?.title_is_custom === true);

  // The WORDING of a blank-rename refusal is decided in the app's handler, which this harness
  // stands in for and therefore cannot assert — a check on it would be a check on the harness. What
  // is asserted here is the half that survives whatever the app says: the store refuses to blank a
  // title, in its own UPDATE, so a rename that arrived with nothing in it cannot leave a nameless
  // row behind even if the sentence above it is never written.
  a.ws.send(JSON.stringify({ cmd: "renameThread", threadId: mine.id, title: "   " }));
  await sleep(300);
  check("a blank rename changes nothing", (await threads.get(ctxA, mine.id))?.title === "Retry logic");

  const beforeArchive = a.inbox.length;
  a.ws.send(JSON.stringify({ cmd: "archiveThread", threadId: mine.id }));
  await sleep(300);
  const archived = threadFrames(a, beforeArchive).find((m) => m.type === "threads");
  check("archiving stamps the row", (await threads.get(ctxA, mine.id))?.archived_at !== null);
  check("...and the snapshot moves it out of the active counts",
    archived?.counts.archived === 1 && archived?.counts.all === 0, JSON.stringify(archived?.counts));
  check("...while the row itself is still in the list, for the Archived filter",
    archived?.threads.length === 1 && archived?.threads[0].status === "archived");

  a.ws.send(JSON.stringify({ cmd: "restoreThread", threadId: mine.id }));
  await sleep(300);
  check("restore brings it back", (await threads.get(ctxA, mine.id))?.archived_at === null);
}

// --- 5. the boundary ------------------------------------------------------------------------
{
  const theirs = await threads.create(ctxB, { title: "theirs" });
  const beforeA = a.inbox.length;
  a.ws.send(JSON.stringify({ cmd: "loadThread", threadId: theirs.id }));
  await sleep(300);

  const answer = threadFrames(a, beforeA).find((m) => m.type === "error" || m.type === "thread");
  check("another workspace's thread id is not answered with the row", answer?.type === "error");
  check("...and the refusal says only that there is no such thread here",
    answer?.message === "no such thread in this workspace", String(answer?.message));

  const beforeRename = b.inbox.length;
  a.ws.send(JSON.stringify({ cmd: "renameThread", threadId: theirs.id, title: "renamed across" }));
  await sleep(300);
  check("renaming across the boundary changes nothing",
    (await threads.get(ctxB, theirs.id))?.title === "theirs");
  check("...and the other workspace is not even told somebody tried",
    threadFrames(b, beforeRename).every((m) => !JSON.stringify(m).includes("renamed across")));
}

a.ws.close();
b.ws.close();
await relay.close();
await store.close();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

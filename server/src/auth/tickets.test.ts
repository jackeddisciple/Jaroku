// The ws-ticket, the origin allowlist, and the upgrade that enforces both.
//
// This is the file that decides whether a socket can be opened by somebody who should not have
// one, so it runs the real relay over a real port and connects to it with a real WebSocket
// client. Two things in particular are only testable that way: that a refusal is an HTTP
// STATUS rather than an opened-then-closed socket, and that consuming a ticket is genuinely
// single-use when two connections race for it.
//
// The store half runs on both drivers, because the single-use guarantee is implemented
// differently on each — SQLite serialises on one connection, Postgres relies on the row lock —
// and "exactly one caller wins" is the kind of property that holds on one and not the other.
//
//   npm run test:tickets
//   JAROKU_PG_URL=postgres://… npm run test:tickets    # runs the store half twice

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { withScratchPostgres, openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { DbTicketStore } from "../db/repositories/tickets.ts";
import { TraceStore } from "../store.ts";
import { WsRelay, UpgradeRefused } from "../wsRelay.ts";
import { memoryTicketStore, hashTicket, looksLikeTicket, type TicketStore } from "./tickets.ts";
import { resolveOriginPolicy } from "./origin.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(new URL("../..", import.meta.url).pathname, "migrations");

// --- the store, on both drivers -------------------------------------------------------------

async function storeSuite(label: string, store: TicketStore, ctx: TenantContext, other: TenantContext): Promise<void> {
  console.log(`\n${label}`);

  console.log("  · issue and redeem");
  {
    const issued = await store.issue(ctx);
    check(looksLikeTicket(issued.ticket), "an issued ticket looks like one");
    check(issued.ticket.length >= 40, `...and carries real entropy (${issued.ticket.length} chars)`);
    const redeemed = await store.consume(issued.ticket);
    check(redeemed?.workspaceId === ctx.workspaceId, "redeeming yields the workspace it was issued for");
    check(redeemed?.role === ctx.role, "...and the role");
    const again = await store.consume(issued.ticket);
    check(again === null, "SINGLE USE — the same ticket cannot be redeemed twice");
  }

  console.log("  · what cannot be redeemed");
  {
    check((await store.consume("never-issued-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")) === null, "an invented ticket is refused");
    check((await store.consume("")) === null, "an empty string is refused");
    check((await store.consume("x")) === null, "a short string is refused before it reaches a query");
    check((await store.consume("../../etc/passwd")) === null, "a path is refused on shape");
    check((await store.consume("a".repeat(500))) === null, "an absurdly long one is refused on shape");

    const expired = await store.issue(ctx, { ttlS: -1 });
    check((await store.consume(expired.ticket)) === null, "an expired ticket is refused");
  }

  console.log("  · concurrency");
  {
    // Two sockets racing for one ticket. Exactly one may be admitted, or "single use" is a
    // comment rather than a guarantee.
    const issued = await store.issue(ctx);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consume(issued.ticket)));
    const winners = results.filter((r) => r !== null);
    check(winners.length === 1, `eight simultaneous redemptions produce exactly one winner (${winners.length})`);
  }

  console.log("  · revocation and sweeping");
  {
    const mine = await store.issue(ctx);
    const theirs = await store.issue(other);
    await store.revoke(ctx.workspaceId);
    check((await store.consume(mine.ticket)) === null, "revoking a workspace kills its outstanding tickets");
    check((await store.consume(theirs.ticket)) !== null, "...and leaves another workspace's alone");

    // The guarantee, rather than a count. `DbTicketStore.issue` sweeps opportunistically, so
    // by the time an explicit sweep runs it may have nothing left to do — asserting "it
    // removed two" would fail on the store that is keeping itself cleanest.
    const stale = await store.issue(ctx, { ttlS: -1 });
    await store.issue(ctx, { ttlS: -1 });
    await store.sweep();
    check((await store.sweep()) === 0, "after a sweep, nothing expired is left to sweep");
    check((await store.consume(stale.ticket)) === null, "...and a swept ticket is gone rather than merely stale");
  }
}

// --- the origin policy ----------------------------------------------------------------------

console.log("\norigin");
{
  const quiet = () => {};
  const dev = resolveOriginPolicy({}, quiet);
  check(dev.allows("http://localhost:5173"), "the Vite dev server is allowed by default");
  check(!dev.allows("https://evil.example"), "another origin is not");
  check(dev.allows(undefined), "an ABSENT origin is allowed — curl and the test suites send none");
  check(!dev.allows("null"), "a literal `null` origin is refused — that is a sandboxed iframe or file://");

  const configured = resolveOriginPolicy({ JAROKU_ALLOWED_ORIGINS: "https://app.example" }, quiet);
  check(configured.allows("https://app.example"), "a configured origin is allowed");
  check(configured.allows("https://APP.example/"), "...case-insensitively and ignoring a trailing slash");
  check(configured.allows("https://app.example:443"), "...and with its default port spelled out");
  check(!configured.allows("http://app.example"), "...but not over plain http, which is a different origin");
  check(!configured.allows("https://app.example.evil.test"), "...and not a suffix of it");
  check(!configured.allows("http://localhost:5173"), "a configured list REPLACES the dev default");

  const star = resolveOriginPolicy({ JAROKU_ALLOWED_ORIGINS: "*" }, quiet);
  check(star.allows("https://anywhere.example"), "* allows everything, for a gateway that already decided");

  let refused = false;
  try {
    resolveOriginPolicy({ NODE_ENV: "production" }, quiet);
  } catch {
    refused = true;
  }
  check(refused, "an unset allowlist in PRODUCTION refuses to start rather than guessing");
}

// --- the upgrade ------------------------------------------------------------------------------

console.log("\nthe upgrade path");
{
  const db = await openTestSqlite();
  const store = new TraceStore(db);
  await store.init();
  const A = randomUUID();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [A, `tick-${A.slice(0, 8)}`, "tickets", new Date().toISOString()],
  );
  const ctxA = systemContextFor(A, newRequestId());
  const tickets = memoryTicketStore();
  const PORT = 4519;

  const relay = new WsRelay({
    port: PORT,
    store,
    clientHtmlPath: "/dev/null",
    originPolicy: resolveOriginPolicy({ JAROKU_ALLOWED_ORIGINS: "http://localhost:5173" }, () => {}),
    contextFor: async (req) => {
      const url = new URL(req.url ?? "/", "http://x");
      const raw = url.searchParams.get("ticket") ?? "";
      const redeemed = await tickets.consume(raw);
      if (!redeemed) throw new UpgradeRefused(401, "that ticket is not valid");
      return { context: systemContextFor(redeemed.workspaceId, newRequestId()), expiresAt: null };
    },
    listAgents: async () => [],
  });
  await new Promise((r) => setTimeout(r, 120));

  /** Connect, and report what happened: open, or the HTTP status of the refusal. */
  const connect = (query: string, headers: Record<string, string> = {}): Promise<string> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`, { headers });
      const done = (v: string): void => {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        resolve(v);
      };
      ws.on("open", () => done("open"));
      // `ws` surfaces a refused upgrade as this event, with the status. That it arrives at all
      // is the assertion: an accepted-then-closed socket would fire `close`, not this.
      ws.on("unexpected-response", (_req, res) => done(`http ${res.statusCode}`));
      ws.on("error", () => done("error"));
      setTimeout(() => done("timeout"), 3000);
    });

  const good = await tickets.issue(ctxA);
  check((await connect(`?ticket=${good.ticket}`)) === "open", "a valid ticket opens a socket");

  const replayed = await tickets.issue(ctxA);
  check((await connect(`?ticket=${replayed.ticket}`)) === "open", "...once");
  check(
    (await connect(`?ticket=${replayed.ticket}`)) === "http 401",
    "REPLAYING it is refused with a status, not an opened-then-closed socket",
  );

  check((await connect("")) === "http 401", "no ticket at all is refused");
  check((await connect("?ticket=made-up-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")) === "http 401", "an invented ticket is refused");

  const forOrigin = await tickets.issue(ctxA);
  check(
    (await connect(`?ticket=${forOrigin.ticket}`, { origin: "https://evil.example" })) === "http 403",
    "a socket from a disallowed origin is refused BEFORE the ticket is even looked at",
  );
  check(
    (await tickets.consume(forOrigin.ticket)) !== null,
    "...and that ticket is still unspent, because the origin check runs first",
  );

  const allowed = await tickets.issue(ctxA);
  check(
    (await connect(`?ticket=${allowed.ticket}`, { origin: "http://localhost:5173" })) === "open",
    "a socket from an allowed origin opens",
  );

  await relay.close();
  await db.close();
}

// --- the store, both drivers -------------------------------------------------------------------

const ctxFor = (id: string): TenantContext => systemContextFor(id, newRequestId());

{
  const A = randomUUID();
  const B = randomUUID();
  await storeSuite("memoryTicketStore", memoryTicketStore(), ctxFor(A), ctxFor(B));
}

const tmp = mkdtempSync(join(tmpdir(), "jaroku-tickets-"));
{
  const db = new SqliteDb(join(tmp, "tickets.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  try {
    await storeSuite("DbTicketStore (SqliteDb)", new DbTicketStore(db), ...(await workspaces(db)));
  } finally {
    await db.close();
  }
}
rmSync(tmp, { recursive: true, force: true });

await withScratchPostgres(async (db) => {
  await storeSuite("DbTicketStore (PostgresDb)", new DbTicketStore(db), ...(await workspaces(db)));
});

/** Two real workspaces, because the table has a foreign key and a hash is not one. */
async function workspaces(db: Db): Promise<[TenantContext, TenantContext]> {
  const ids: string[] = [];
  for (const _ of [0, 1]) {
    const id = randomUUID();
    await db.run(
      `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
      [id, `tick-${id.slice(0, 8)}`, "tickets", new Date().toISOString()],
    );
    ids.push(id);
  }
  return [ctxFor(ids[0]!), ctxFor(ids[1]!)];
}

console.log("\nhashing");
{
  const raw = "a-ticket-value";
  check(hashTicket(raw) === hashTicket(raw), "hashing is stable");
  check(hashTicket(raw) !== hashTicket(`${raw} `), "...and distinguishes near-misses");
  check(!hashTicket(raw).includes(raw), "...and the digest does not contain the ticket");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

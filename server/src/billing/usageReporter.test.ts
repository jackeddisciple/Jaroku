// Batched, not per call — because a usage record that was rate-limited is revenue that never
// happened and nothing anywhere says so.
//
// THE FAILURE THIS PREVENTS HAS NO SYMPTOM. Stripe rate-limits usage records; a system reporting
// one per inference call hits that limit under exactly the load that makes the reporting matter,
// and the dropped records do not appear as an error a user sees or a run that failed. They appear
// as an invoice that is quietly lower than the usage, months later, in a reconciliation nobody
// runs. So the batching is not an optimisation and this suite is not about performance.
//
// TWO TRIGGERS, AND NEITHER IS REDUNDANT. The interval bounds LATENCY, so a quiet workspace's
// overage still reaches the invoice the day it happened. The count bounds SIZE, so a busy one does
// not fold five minutes of a fan-out into one enormous report. Either alone leaves the other case
// unbounded, and it is the kind of pair somebody later "simplifies" to one.
//
// AND A FAILED FLUSH KEEPS ITS ROWS, which is the assertion that matters most here: a provider
// outage has to be a delay rather than a loss, and the tempting implementation — take, post, forget
// — loses the batch precisely when the post fails.
//
// AGAINST A FIXTURE SERVER, not Stripe. `STRIPE_API_BASE` exists for this, and the suite drives
// real HTTP through the real code path rather than asserting against a mock of itself.
//
//   npm run test:usage-reporter

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { newRequestId, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { FLUSH_AT_CALLS, UsageReporter } from "./usageReporter.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

/** Every usage record the fixture was asked to write, and whether it agreed to. */
interface Posted { path: string; body: string; idempotency: string }
const posted: Posted[] = [];
let refuse = false;

const server: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (refuse) {
      res.writeHead(503).end("{}");
      return;
    }
    posted.push({
      path: req.url ?? "",
      body,
      idempotency: String(req.headers["idempotency-key"] ?? ""),
    });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "mbur_1" }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const apiBase = `http://127.0.0.1:${port}`;

const ctx = (): TenantContext => systemContextFor(randomUUID(), newRequestId());
const PERIOD = "2026-08-01T00:00:00.000Z";

/**
 * A reporter pointed at the fixture, billing against one subscription item.
 *
 * `noKey` IS A FLAG RATHER THAN `secretKey: undefined`, because those two are indistinguishable to
 * a function reading an optional property — and the block below needs precisely the absent case.
 * The first version of this helper could not express it, so that assertion passed for the wrong
 * reason until it did not.
 */
function reporter(opts: { item?: string | null; noKey?: boolean } = {}): UsageReporter {
  return new UsageReporter({
    config: () => (opts.noKey ? { apiBase } : { secretKey: "sk_test_fixture", apiBase }),
    subscriptionItemFor: async () => (opts.item === undefined ? "si_test" : opts.item),
    log: () => {},
  });
}

// ---------------------------------------------------------------------------------------------
console.log("\nnothing is reported per call");
// ---------------------------------------------------------------------------------------------
{
  posted.length = 0;
  const r = reporter();
  const a = ctx();
  for (let i = 0; i < 5; i++) await r.record(a, 0.25, PERIOD);

  check(posted.length === 0, "five calls report nothing yet");
  const pending = r.pendingFor(a.workspaceId);
  check(pending?.calls === 5, "...they accumulate instead");
  check(
    pending !== null && Math.abs(pending.quantity - 1.25) < 1e-9,
    `...and the amount adds up (${pending?.quantity})`,
  );

  // The interval is the other trigger, and a suite that waited five minutes for it would be a
  // suite nobody runs. `flushAll` is what the timer calls.
  await r.flushAll();
  check(posted.length === 1, "one report carries all five");
  check(r.pendingFor(a.workspaceId) === null, "...and the buffer is empty afterwards");
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe count trigger bounds how big a batch can get");
// ---------------------------------------------------------------------------------------------
{
  posted.length = 0;
  const r = reporter();
  const a = ctx();
  for (let i = 0; i < FLUSH_AT_CALLS - 1; i++) await r.record(a, 0.01, PERIOD);
  check(posted.length === 0, `${FLUSH_AT_CALLS - 1} calls is still under the bound`);

  await r.record(a, 0.01, PERIOD);
  check(posted.length === 1, `...and the ${FLUSH_AT_CALLS}th sends it, without waiting for the timer`);
  check(r.pendingFor(a.workspaceId) === null, "...leaving nothing behind");
}

// ---------------------------------------------------------------------------------------------
console.log("\nwhat is posted is an increment, in whole units, against the right item");
// ---------------------------------------------------------------------------------------------
{
  posted.length = 0;
  const r = reporter();
  const a = ctx();
  await r.record(a, 2.5, PERIOD);
  await r.flushAll();

  const record = posted[0]!;
  check(record.path.includes("si_test"), "the record is posted against the subscription item");
  check(record.path.includes("usage_records"), "...on the usage-records path");
  // `increment` AND NOT `set`. The buffer holds a delta; `set` would overwrite the period's total
  // with the last five minutes of it, which is a bill that shrinks as the month goes on.
  check(record.body.includes("action=increment"), "the action is increment, because the buffer is a delta");
  // Rounded UP, and once per batch rather than per call — a hundred small calls rounding
  // individually is a systematic error rather than a rounding one.
  check(record.body.includes("quantity=250"), `2.5 reports as 250 cents (${record.body})`);
  check(record.idempotency.includes(a.workspaceId), "the idempotency key names the workspace");
  check(record.idempotency.includes(PERIOD), "...and the period, so two months cannot collide");
}

// ---------------------------------------------------------------------------------------------
console.log("\na failed report keeps its rows");
// ---------------------------------------------------------------------------------------------
{
  posted.length = 0;
  const r = reporter();
  const a = ctx();
  await r.record(a, 1.5, PERIOD);

  refuse = true;
  await r.flushAll();
  refuse = false;

  check(posted.length === 0, "the provider refused, so nothing was recorded");
  // THE ASSERTION THIS SUITE EXISTS FOR. Take, post, forget is the tempting shape and it loses the
  // batch exactly when the post fails — an outage becomes lost revenue rather than a delay.
  const held = r.pendingFor(a.workspaceId);
  check(held !== null && Math.abs(held.quantity - 1.5) < 1e-9, "...and the amount is still waiting");

  await r.flushAll();
  check(posted.length === 1, "the next flush carries it");
  check(posted[0]!.body.includes("quantity=150"), "...in full, not partially");
}

// ---------------------------------------------------------------------------------------------
console.log("\nnothing is reported when there is nothing to report against");
// ---------------------------------------------------------------------------------------------
{
  posted.length = 0;
  const a = ctx();

  // A workspace inside its included credit, on Free, or on a deployment with no metered price: all
  // three answer null, and all three mean "nothing to report" rather than "something went wrong".
  const noItem = reporter({ item: null });
  await noItem.record(a, 5, PERIOD);
  await noItem.flushAll();
  check(posted.length === 0 && noItem.pendingFor(a.workspaceId) === null, "no subscription item, no buffer");

  // Zero and negative overage are not reports. A workspace under its credit contributes nothing,
  // and a negative would be a credit note, which is not what a usage record is.
  const r = reporter();
  await r.record(a, 0, PERIOD);
  await r.record(a, -3, PERIOD);
  check(r.pendingFor(a.workspaceId) === null, "zero and negative overage accumulate nothing");

  // A DEPLOYMENT WITH NO PAYMENTS DROPS RATHER THAN HOLDS. Holding would grow a buffer forever on
  // a local install that will never report anything.
  const local = reporter({ noKey: true });
  await local.record(a, 4, PERIOD);
  await local.flushAll();
  check(posted.length === 0, "a deployment with no Stripe key reports nothing");
  check(local.pendingFor(a.workspaceId) === null, "...and does not grow a buffer forever");
}

// ---------------------------------------------------------------------------------------------
console.log("\na period boundary is reported before it is crossed");
// ---------------------------------------------------------------------------------------------
{
  posted.length = 0;
  const r = reporter();
  const a = ctx();
  await r.record(a, 1, "2026-07-01T00:00:00.000Z");
  await r.record(a, 2, "2026-08-01T00:00:00.000Z");

  // FOLDING JULY INTO AUGUST WOULD PUT THE CHARGE ON THE WRONG INVOICE, which is the one billing
  // error nobody can reconcile afterwards — the amounts are right and the months are not.
  check(posted.length === 1, "the older period is reported when a newer one arrives");
  check(posted[0]!.idempotency.includes("2026-07-01"), "...as July's own record");
  check(posted[0]!.body.includes("quantity=100"), "...carrying only July's amount");
  check(r.pendingFor(a.workspaceId)?.quantity === 2, "and August starts accumulating on its own");
}

// ---------------------------------------------------------------------------------------------
console.log("\nworkspaces are reported separately");
// ---------------------------------------------------------------------------------------------
{
  posted.length = 0;
  const r = reporter();
  const a = ctx();
  const b = ctx();
  await r.record(a, 1, PERIOD);
  await r.record(b, 2, PERIOD);
  await r.flushAll();

  check(posted.length === 2, "two workspaces are two records");
  const keys = posted.map((p) => p.idempotency);
  check(
    keys.some((k) => k.includes(a.workspaceId)) && keys.some((k) => k.includes(b.workspaceId)),
    "...each keyed to its own workspace, so one cannot be billed for the other",
  );
}

await new Promise<void>((r) => server.close(() => r()));
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// `exitCode` RATHER THAN `process.exit`, and only in this suite. The others exit immediately
// because they hold nothing but a database handle; this one has just closed an HTTP server, and on
// Windows tearing the loop down from inside that close callback trips a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`) that turns a passing suite into a crash. Setting the
// code and letting the loop drain is the same answer without the race.
process.exitCode = failures === 0 ? 0 : 1;

// `npm run billing:stuck` — the queue an operator replays, finally readable.
//
// WHAT THIS IS FOR. `http/billing.ts` deliberately leaves a failed webhook row UNPROCESSED and
// answers 500 so the provider retries, with the comment: "The row is left UNPROCESSED on purpose —
// it is the queue an operator replays". `BillingRepository.unprocessedWebhookEvents` is that queue's
// reader, and it had no caller anywhere: no CLI, no route, no metric, no alert. A queue nobody can
// read is a queue nobody drains, and what accumulates in it is money — a subscription that never
// moved a plan, a renewal whose credit was never granted.
//
// WHY THIS CANNOT REPLAY THE EVENT ITSELF, which is the honest limit and the reason the command is
// called `stuck` rather than `replay`. `billing_webhook_events` stores an id, a type, a workspace and
// two timestamps — and NOT the payload, on purpose: the body is a Stripe object graph containing a
// customer, and keeping a copy of every one of them would be a second store of other people's
// billing data with no retention story. The signature is over bytes we no longer have either, so a
// re-run from here could not be verified even if the body were kept.
//
// So the operator action is: read this list, resend the event from the provider's own dashboard by
// id (which re-delivers it through the verified path, and `claimWebhookEvent` makes that safe), and
// then mark the row resolved here so the queue actually drains. Without the second half the list
// only ever grows, which is how an operator queue becomes something people stop reading.
//
//   npm run billing:stuck                          # what is stuck, oldest first
//   npm run billing:stuck -- --resolve evt_123 --note "resent from the dashboard"
//   JAROKU_DB_DRIVER=postgres JAROKU_PG_URL=… npm run billing:stuck

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { BillingRepository } from "../db/repositories/billing.ts";
import { openDb } from "../db/open.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");

/** `--flag value`, or undefined. No dependency for four arguments. */
function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const age = (iso: string): string => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(0, Math.floor(ms / 60_000))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const db = openDb({ sqlitePath: DB_PATH });
const billing = new BillingRepository(db);
let code = 0;

try {
  const resolveId = arg("resolve");
  if (resolveId) {
    // MARKED FINISHED, WITH A NOTE SAYING BY WHOM AND WHY. `outcome` is a free-text column read by
    // whoever asks the same question next month, so "resolved by hand" with no reason would be the
    // least useful thing that could be written into it.
    const note = arg("note") ?? "resolved by an operator";
    const stuck = await billing.unprocessedWebhookEvents(500);
    const row = stuck.find((e) => e.id === resolveId);
    if (!row) {
      // Deliberately not silent: an id that is not in the queue is either a typo or an event
      // somebody already handled, and both are worth saying out loud rather than reporting success.
      console.error(`[billing] ${resolveId} is not in the unprocessed queue — nothing was changed`);
      code = 1;
    } else {
      await billing.finishWebhookEvent(row.id, null, `manual: ${note}`);
      console.log(`[billing] ${row.id} (${row.type}) marked resolved — ${note}`);
    }
  } else {
    const stuck = await billing.unprocessedWebhookEvents(500);
    if (stuck.length === 0) {
      console.log("[billing] nothing stuck: every webhook that arrived was acted on");
    } else {
      console.log(`[billing] ${stuck.length} webhook event(s) arrived and never finished, oldest first:\n`);
      for (const e of stuck) {
        console.log(`  ${e.id}  ${e.type.padEnd(34)} ${age(e.received_at)} ago  (${e.received_at})`);
      }
      console.log(
        `\n  Resend each from the payment provider's dashboard by id — redelivery goes through the\n` +
          `  verified path and the claim makes a duplicate harmless — then mark it resolved:\n` +
          `      npm run billing:stuck -- --resolve <id> --note "what you did"\n`,
      );
      // A NON-ZERO EXIT, so this can be a cron line or a health check rather than only a thing
      // somebody types. Anything in this queue is money that has not moved.
      code = 2;
    }
  }
} catch (err) {
  console.error(`[billing] could not read the queue: ${(err as Error)?.message ?? String(err)}`);
  code = 1;
} finally {
  await db.close();
}

process.exit(code);

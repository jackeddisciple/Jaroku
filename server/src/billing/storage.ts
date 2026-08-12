// Sampling what a workspace is holding, so storage can be metered at all.
//
// Storage is the one billable thing in this system that is not an event. A model call happens
// and is over; a sandbox starts and exits; a stored object just sits there, costing money for
// every hour nobody deletes it. An event log can only record it by SAMPLING — asking, on a
// schedule, how many bytes are held, and writing down the cost of having held them since the
// last time anybody asked.
//
// THE TEMPTING ALTERNATIVE IS WRONG. A version publish IS an event, so metering bytes as they
// are written looks like it fits the existing shape. It would charge a workspace once for a
// file and nothing at all for keeping it — the opposite of what an object store bills, and a
// workspace that wrote a gigabyte and then went quiet for a year would be charged for the
// minute it took to upload.
//
// THE INTERVAL IS BUCKETED, NOT ELAPSED. Each sample belongs to a whole clock hour, and the row
// it writes is keyed by (workspace, that hour). That is what makes this safe on more than one
// replica: every gateway runs this sampler, so at the top of an hour several of them try to
// record the same interval for the same workspace, and the unique index on `idempotency_key`
// makes exactly one of them the charge. A key derived from "now" would instead have every
// replica bill the same hour separately, which is the failure the column exists to prevent,
// arriving through the front door.
//
// A MISSED HOUR IS NOT BACKFILLED, and that is deliberate. A gateway that was down for six
// hours did not observe what was stored during them, and inventing a figure from what is
// stored NOW would bill six hours of the current total — which is wrong in whichever direction
// the workspace happened to move. Undercharging for an outage we caused is the right way to be
// wrong.

import type { TenantContext } from "../db/tenant.ts";
import { systemContextFor, newRequestId } from "../db/tenant.ts";
import type { UsageMeter } from "./usage.ts";
import type { InfraRates } from "./rates.ts";

/** Milliseconds in the sampling interval. One hour: short enough that an outage loses little,
 *  long enough that a thousand workspaces is a thousand rows a day rather than a minute. */
export const SAMPLE_INTERVAL_MS = 60 * 60 * 1000;

/** The start of the clock hour `at` falls in, as the ISO string the key is built from. */
export function intervalStart(at: Date = new Date()): string {
  return new Date(Math.floor(at.getTime() / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS).toISOString();
}

export interface StorageSamplerDeps {
  meter: UsageMeter;
  /** Every live workspace. `workspaces` carries no RLS policy, so this read works as the
   *  application role — which is why the sweep goes workspace-by-workspace rather than issuing
   *  one unscoped query that would return nothing in production. */
  workspaceIds: () => Promise<string[]>;
  /** How many bytes this workspace is holding, right now. */
  bytesHeld: (ctx: TenantContext) => Promise<number>;
  rates?: InfraRates;
}

/**
 * Take one sample for every workspace. Returns how many rows were newly recorded.
 *
 * Sequential rather than parallel, on purpose: this runs hourly against every workspace on the
 * platform and there is nothing waiting on it, so the version that does not spike the
 * connection pool is the correct one. The whole point of a background sampler is that it costs
 * the foreground nothing.
 *
 * One workspace's failure does not stop the rest. A sampler that gave up on the first error
 * would silently stop billing every workspace alphabetically after whichever one has a problem.
 */
export async function sampleStorage(deps: StorageSamplerDeps, at: Date = new Date()): Promise<number> {
  const start = intervalStart(at);
  let recorded = 0;
  for (const workspaceId of await deps.workspaceIds()) {
    const ctx = systemContextFor(workspaceId, newRequestId());
    try {
      const bytes = await deps.bytesHeld(ctx);
      const wrote = await deps.meter.meterStorage(ctx, {
        bytes,
        intervalStart: start,
        intervalHours: SAMPLE_INTERVAL_MS / 3_600_000,
        ...(deps.rates ? { rates: deps.rates } : {}),
      });
      if (wrote) recorded++;
    } catch (err) {
      console.error(`[billing] storage sample failed for ${workspaceId}:`, (err as Error)?.message ?? err);
    }
  }
  return recorded;
}

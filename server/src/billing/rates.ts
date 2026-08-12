// What infrastructure costs, per deployment.
//
// NOT IN billing/plans.ts, and the distinction is the same one migration 020 draws about price
// ids. A plan's concurrency and ceiling are DECISIONS about what a customer gets; a rate per
// sandbox-second is a fact about what this deployment's hosting costs, which differs between a
// laptop, a Fly organisation and somebody's own cluster. Decisions live in code and go through
// review. Facts about an environment come from the environment.
//
// AND NOT IN runtime/pricing.json either, which is deliberately shared with the Python side and
// is about MODELS. A file two runtimes read to price a token is not the place to put a number
// only the Node control plane can know.
//
// DEFAULT ZERO, AND ZERO IS AN ANSWER. A deployment that has not set a rate does not charge for
// sandbox time or storage, and the rows it writes say `cost_usd = 0, cost_known = true` — the
// same "priced, and free" claim the dry-run provider makes. That is emphatically NOT the
// unpriced case: an unrecognised or malformed rate falls back to the default rather than
// becoming NaN, because a NaN cost multiplied through a rollup poisons every total it touches.
// If a deployment ever needs to say "we do not know what this cost", it needs a null, and there
// is deliberately no way to configure one — infrastructure whose price we cannot state is
// infrastructure we should not be metering.

/** How a rate is read, everywhere in this file. Negative and NaN both fall through. */
function usdFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface InfraRates {
  /** USD per second of sandbox wall clock. `JAROKU_SANDBOX_USD_PER_SECOND`. */
  sandboxUsdPerSecond: number;
  /**
   * USD per GiB held for a month. `JAROKU_STORAGE_USD_PER_GIB_MONTH`.
   *
   * Per MONTH rather than per hour because that is the unit every object store quotes, so the
   * number in the environment can be copied from an invoice rather than divided by hand — and a
   * rate somebody has to convert before setting is a rate somebody eventually converts wrong.
   * The conversion to the sampling interval happens once, in meterStorage.
   */
  storageUsdPerGibMonth: number;
}

/**
 * Read lazily, per call, for the reason queue/jobs.ts reads its overrides lazily: a table
 * captured at import is frozen at whatever the environment held the first time anything in the
 * process touched this module, which is silently the wrong number for a suite that sets an
 * override before exercising it — and a comment claiming otherwise is worse than no comment.
 */
export function infraRates(env: NodeJS.ProcessEnv = process.env): InfraRates {
  return {
    sandboxUsdPerSecond: usdFromEnv("JAROKU_SANDBOX_USD_PER_SECOND", 0, env),
    storageUsdPerGibMonth: usdFromEnv("JAROKU_STORAGE_USD_PER_GIB_MONTH", 0, env),
  };
}

/** Bytes in a gibibyte. Object stores quote GiB, so this is the divisor an invoice implies. */
export const BYTES_PER_GIB = 1024 ** 3;

/** Hours in the month a per-GiB-month rate is quoted against. 30 days, stated rather than
 *  computed from a calendar: a rate that changed depending on whether the sample landed in
 *  February would be a rate nobody could reconcile against an invoice. */
export const HOURS_PER_MONTH = 30 * 24;

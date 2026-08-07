// Liveness and readiness, which are two different questions.
//
// `/healthz` asks whether this PROCESS is alive. It touches nothing: no database, no disk, no
// third party. That is not laziness — a liveness probe that checks a dependency turns one
// database blip into every instance being killed and restarted at once, which is how a brief
// outage becomes a long one.
//
// `/readyz` asks whether this instance should be sent TRAFFIC, which it should not be if it
// cannot answer a query. It probes the database with the cheapest statement there is, under a
// deadline, because a probe that hangs is a probe that never says "not ready".
//
// Neither is authenticated. There is nothing in either answer that is not already implied by
// the port being open, and a health check that needs a credential is one a load balancer
// cannot make — the same reasoning `serve.py` applies to a deployed agent's `/health`.

import type { Handler } from "./router.ts";

/** How long a readiness probe waits on the database before calling it unready. */
const PROBE_TIMEOUT_MS = 2000;

export interface HealthDeps {
  /** One trivial query. Resolves if the database answers, rejects otherwise. */
  probe: () => Promise<unknown>;
  /** Which driver is behind it, so a failing probe names something useful. */
  dialect: string;
  startedAt?: number;
}

export function healthz(): Handler {
  return () => ({ body: { ok: true } });
}

export function readyz(deps: HealthDeps): Handler {
  const startedAt = deps.startedAt ?? Date.now();
  return async () => {
    try {
      await withTimeout(deps.probe(), PROBE_TIMEOUT_MS);
      return { body: { ok: true, db: deps.dialect, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) } };
    } catch (err) {
      // 503, not 500: this is a statement about whether to route here, and it may well be
      // true again in a second. The message names the driver because "not ready" with no
      // subject is the least useful line in an incident.
      return {
        status: 503,
        body: { error: { code: "not_ready", message: `the ${deps.dialect} database did not answer: ${(err as Error).message}` } },
      };
    }
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

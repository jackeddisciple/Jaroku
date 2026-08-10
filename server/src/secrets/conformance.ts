// One suite, run against every secret store.
//
// The same argument db/conformance.ts and storage/conformance.ts make. What is different here
// is that most of these assertions are about what a store REFUSES to do, so a store that
// quietly widened its surface — a `get` that returned a value, a `listNames` that leaked one,
// a missing name answered as an empty string — would pass a happy-path test and fail this one.
//
// The one property that cannot be asserted portably is where a value ends up: one store writes
// a file the developer owns, the other writes ciphertext to Postgres. Those get their own
// tests. What every store must agree on is the SHAPE of the promise: values go in and reach a
// run, names come back, and nothing else does.

import { randomUUID } from "node:crypto";
import { systemContextFor, newRequestId, type TenantContext } from "../db/tenant.ts";
import type { SecretStore } from "./secretStore.ts";

export interface SecretConformanceResult {
  failures: number;
}

/**
 * Run the suite against an open store.
 *
 * `runId` must be a run the store can resolve to `ctx`'s workspace — the caller sets that up,
 * because "what is a run" is the one thing the two implementations genuinely disagree about.
 */
export async function runSecretConformance(
  label: string,
  store: SecretStore,
  ctx: TenantContext,
  runId: string,
): Promise<SecretConformanceResult> {
  let failures = 0;
  const check = (ok: boolean, msg: string, detail = ""): void => {
    if (ok) console.log(`  ok   ${msg}`);
    else {
      failures++;
      console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
    }
  };

  console.log(`\n${label}`);
  const NAME = `JAROKU_MCP_CONFORMANCE_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "_")}_TOKEN`;
  const VALUE = "sk-conformance-01234567890-Ω";

  check(store.kind === "dotenv" || store.kind === "kms", `reports a kind (${store.kind})`);

  // --- the round trip ---------------------------------------------------------------
  const set = await store.set(ctx, NAME, VALUE);
  check(set.ok, "a credential can be stored", set.warning ?? "");

  const forRun = await store.getForRun(runId, [NAME]);
  check(forRun[NAME] === VALUE, "...and reaches a run's environment byte for byte, multi-byte characters included");

  // --- the surface that does not exist -----------------------------------------------
  check(
    !("get" in store) || typeof (store as unknown as { get?: unknown }).get !== "function",
    "there is no get() that would hand a plaintext value to a request handler",
  );

  const listed = await store.listNames(ctx);
  const mine = listed.find((s) => s.name === NAME);
  check(mine !== undefined, "listNames reports it as configured");
  check(mine?.configured === true, "...as `configured: true`, which is all a client learns");
  check(
    !JSON.stringify(listed).includes(VALUE),
    "...and the whole listing, serialised, contains no value anywhere",
  );

  // --- absent is absent ----------------------------------------------------------------
  const missing = await store.getForRun(runId, ["JAROKU_MCP_NEVER_SET_TOKEN"]);
  check(
    !("JAROKU_MCP_NEVER_SET_TOKEN" in missing),
    "a name that is not configured is absent, not an empty string",
  );
  const mixed = await store.getForRun(runId, [NAME, "JAROKU_MCP_NEVER_SET_TOKEN"]);
  check(mixed[NAME] === VALUE && Object.keys(mixed).length === 1, "...and asking for both returns only the one that is");

  // --- refusals ------------------------------------------------------------------------
  let badName = false;
  try {
    await store.set(ctx, "not a name", VALUE);
  } catch {
    badName = true;
  }
  check(badName, "a name that is not an environment variable is refused");

  let injected = false;
  try {
    await store.set(ctx, "GOOD_NAME\nANTHROPIC_API_KEY", VALUE);
  } catch {
    injected = true;
  }
  check(injected, "...including one carrying a newline, which would write a second variable");

  const newlineValue = await store.set(ctx, NAME, "line one\nANTHROPIC_API_KEY=stolen");
  check(!newlineValue.ok, "a VALUE containing a line break is refused rather than truncated");
  check(
    (await store.getForRun(runId, [NAME]))[NAME] === VALUE,
    "...leaving the previous value exactly as it was",
  );

  // --- replacement and removal -----------------------------------------------------------
  const replaced = await store.set(ctx, NAME, "sk-second-value");
  check(replaced.ok, "a credential can be replaced");
  check((await store.getForRun(runId, [NAME]))[NAME] === "sk-second-value", "...and the run sees the new one");

  await store.delete(ctx, NAME);
  check(!((await store.getForRun(runId, [NAME]))[NAME]), "delete removes it from a run's environment");
  check(!(await store.listNames(ctx)).some((s) => s.name === NAME), "...and from the listing");
  await store.delete(ctx, NAME);
  check(true, "...and deleting it again is not an error");

  return { failures };
}

/** A context for the suite, so the two callers build one the same way. */
export function conformanceContext(workspaceId: string): TenantContext {
  return systemContextFor(workspaceId, newRequestId());
}

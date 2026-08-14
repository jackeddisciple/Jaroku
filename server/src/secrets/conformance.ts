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

  // The second plaintext exit, and the only other one there will be. A platform-side model call
  // — a generation, a judge verdict — is a value flowing INTO a call and never back out, the
  // same shape as a run's environment, which is why it is a method and not a `get`. Asserted
  // portably so the two stores cannot answer it differently.
  const forPlatform = await store.getForPlatformCall(ctx, [NAME]);
  check(forPlatform[NAME] === VALUE, "...and reaches a platform-side call the same way");
  check(
    Object.keys(await store.getForPlatformCall(ctx, [])).length === 0,
    "asking for no names returns nothing rather than everything",
  );
  check(
    !("JAROKU_MCP_NEVER_SET_TOKEN" in (await store.getForPlatformCall(ctx, ["JAROKU_MCP_NEVER_SET_TOKEN"]))),
    "a name with no value is absent rather than an empty string, here too",
  );

  // --- the surface that does not exist, and the one door that now does -----------------
  //
  // THIS ASSERTION CHANGED, and the change is the point rather than a detail. It used to read
  // "there is no method that would hand a plaintext value to a request handler", which ADR-033
  // stated absolutely and ADR-035 has now narrowed. Deleting it would have left the suite quietly
  // asserting less than it used to; what replaces it is the narrower rule, asserted just as hard.
  check(
    !("get" in store) || typeof (store as unknown as { get?: unknown }).get !== "function",
    "there is still no get() — a caller cannot ask for a value by name and workspace alone",
  );
  check(
    typeof (store as unknown as { revealForUser?: unknown }).revealForUser === "function",
    "and exactly one method reads one back, which takes an elevation receipt rather than a context",
  );
  // A receipt names its own workspace, so one issued elsewhere cannot open the hosted store's
  // rows. The cast is what a caller would have to write to forge one, and it is deliberately ugly
  // — there is no way to build this value from a request body.
  //
  // ASSERTED ONLY ON THE HOSTED STORE, AND THAT IS AN ASYMMETRY WORTH NAMING RATHER THAN HIDING.
  // The two implementations are meant to be indistinguishable, and on this one point they are not:
  // `DotEnvSecretStore` answers from `process.env`, which has no workspace in it, so it cannot
  // check a receipt's workspace against anything. What both stores DO share is the part that
  // matters — the receipt is unforgeable in the type system, so neither can be read without a live
  // elevation. The residual difference costs what the local store's whole threat model already
  // costs: one machine, one developer, and a leak whose worst case is showing somebody their own
  // key. It refuses to run under NODE_ENV=production for that reason, which is what keeps this
  // exemption from reaching a tenant.
  const forged = { workspaceId: randomUUID(), userId: randomUUID(), elevationId: randomUUID() } as never;
  if (store.kind === "kms") {
    check(
      (await store.revealForUser(forged, NAME)) === null,
      "a receipt for another workspace reveals nothing, because the workspace comes off the receipt",
    );
  } else {
    check(
      store.kind === "dotenv",
      "...and the local store is exempt from that one check, because a .env file has no workspace in it",
    );
  }

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

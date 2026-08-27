// Where a deployment's own bearer token goes, and everywhere it must not.
//
//   npm run test:serve-token-store
//
// §8 reverses a property this product used to hold out loud. The old one was "Jaroku does not
// keep a copy"; the new one is "the token lives where every other credential already lives —
// envelope-encrypted, workspace-scoped, with no path to plaintext except the dispatcher." A
// reversal is only defensible if the new property is actually true, so most of this suite is
// about ABSENCE: the value must not be in a log line, in a broadcast, in a column, or in the
// credential panel — and the assertions are built the way `test:log-redaction` builds its, with
// one known secret and every route out of the deploy path tried against it.
//
// The round trip is the small half. Anything can store a string.

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeployStore } from "./deployStore.ts";
import { DeployDispatcher } from "./deployDispatch.ts";
import { DeployRuns } from "./deployRuns.ts";
import { DotEnvSecretStore } from "./secrets/dotEnvSecretStore.ts";
import { serveTokenEnvKeyFor } from "./envWriter.ts";
import { makeScrubber } from "./deploySecrets.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { RunTokenRevocationList } from "./sandbox/runTokens.ts";
import { TraceStore } from "./store.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { randomBytes } from "node:crypto";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const SRC = dirname(fileURLToPath(import.meta.url));
const DB = join(tmpdir(), `jaroku-serve-token-${randomUUID()}.db`);
const ENV_FILE = join(tmpdir(), `jaroku-serve-token-${randomUUID()}.env`);
const db = await openTestSqlite(DB);
const store = new TraceStore(db);
await store.init();
const deployStore = new DeployStore(store.database());
await deployStore.init();
const ctx = testContext();

// THE ONE KNOWN SECRET. Distinctive enough that a substring of it appearing anywhere is
// unambiguous, and shaped like the real thing (`randomBytes(24).toString("base64url")`).
const SERVE_TOKEN = "SrVtOkEn_kNoWn_TeSt_VaLuE_0123456789abcdef";
const SERVICE_ID = `svc-${randomUUID()}`;

// A local store over a scratch .env, so the file itself can be read back and checked.
const written: string[] = [];
const secrets = new DotEnvSecretStore({
  writer: {
    set: (key, value) => { written.push(`${key}=${value}`); process.env[key] = value; return { ok: true, warning: null }; },
    clear: (key) => { delete process.env[key]; },
  },
  envPath: ENV_FILE,
});

// --- 1. the round trip ---------------------------------------------------------------------

{
  check("a deployment with no stored token reads as null",
    (await secrets.getServeToken(ctx, SERVICE_ID)) === null);

  const result = await secrets.setServeToken(ctx, SERVICE_ID, SERVE_TOKEN);
  check("the serve token can be stored", result.ok, result.warning ?? "");
  check("...and read back by the dispatcher, byte for byte",
    (await secrets.getServeToken(ctx, SERVICE_ID)) === SERVE_TOKEN);
  check("...under a name derived from the SERVICE, so a redeploy overwrites rather than accumulates",
    written.some((w) => w.startsWith(`${serveTokenEnvKeyFor(SERVICE_ID)}=`)),
    written.join(" | "));
  check("...and a different deployment's id reads nothing",
    (await secrets.getServeToken(ctx, `svc-${randomUUID()}`)) === null);
}

// --- 2. everywhere it must not be ------------------------------------------------------------

{
  // NOT IN THE CREDENTIAL PANEL. It is host plumbing: nobody typed it, nobody can usefully edit
  // it, and rotating it is a button. One row per deployment would bury the keys the panel exists
  // for — and this is the assertion that keeps the two store implementations agreeing about it.
  const listed = await secrets.listNames(ctx);
  check("the serve token is not listed as one of the workspace's credentials",
    !listed.some((s) => s.name === serveTokenEnvKeyFor(SERVICE_ID)),
    listed.map((s) => s.name).join(", "));
}

{
  // NOT IN A DEPLOYMENT ROW. `env_keys` holds NAMES and there is deliberately no column a value
  // fits in — that is a property of the schema rather than a rule somebody remembers. Asserted by
  // writing a row and reading every field of it back as text.
  const dep = await deployStore.create(ctx, {
    agentId: "a_deployed_agent",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    envKeys: ["ANTHROPIC_API_KEY", serveTokenEnvKeyFor(SERVICE_ID)],
  });
  await deployStore.patch(ctx, dep.id, { railway_service_id: SERVICE_ID, url: "https://agent.example" });
  const row = await deployStore.get(ctx, dep.id);
  check("no field of a deployment row carries the token",
    !JSON.stringify(row).includes(SERVE_TOKEN), JSON.stringify(row).slice(0, 200));
  // AND THE NAME IS FINE TO BE THERE. env_keys is names, which is the whole design — asserting
  // the name is absent too would be asserting the wrong thing.
  check("...though its NAME may be, because names are what that column is for",
    JSON.stringify(row).includes(serveTokenEnvKeyFor(SERVICE_ID)));
}

{
  // NOT IN A LOG LINE. Deploy logs are persisted to `deployment_logs`, broadcast to every browser
  // in the workspace, and read back later — the same three sinks `test:log-redaction` cares
  // about. The scrubber is what stands between a value and all three, so it is exercised on the
  // real thing rather than described.
  const scrub = makeScrubber([SERVE_TOKEN]);
  const line = `starting container with token ${SERVE_TOKEN} on :8080`;
  check("a log line carrying the token is scrubbed before it can be stored or broadcast",
    !scrub(line).includes(SERVE_TOKEN) && scrub(line).includes("••••••••"), scrub(line));

  // AND THE DEPLOY PATH'S OWN SOURCE, which is the half that survives the next person. The token
  // is handed to `onServeToken` (a broadcast, once, by design) and to `storeServeToken`. Any
  // OTHER use of that variable — a console.log added while debugging, a `this.log(...)` that
  // looked harmless — is what this catches.
  const manager = readFileSync(resolve(SRC, "deployManager.ts"), "utf8");
  const uses = manager
    .split("\n")
    .map((l, i) => ({ line: l.replace(/\/\/.*$/, ""), n: i + 1 }))
    .filter((l) => /\bserveToken\b/.test(l.line));
  const allowed = /onServeToken|storeServeToken|const serveToken =|hostEnv\(|if \(serveToken\)/;
  const suspicious = uses.filter((l) => !allowed.test(l.line));
  check("nothing in the deploy manager touches the serve token except minting, setting and storing it",
    suspicious.length === 0, suspicious.map((l) => `${l.n}: ${l.line.trim()}`).join(" | "));

  // AND THE LINE THAT USED TO BE FALSE. "Jaroku does not keep a copy" was a real property with a
  // real argument, and it is not true any more — a header, a log line or a comment that still
  // said it would be the product lying about its own security posture.
  //
  // COMMENTS ARE EXEMPT AND THAT IS DELIBERATE: the old sentence is quoted twice in this file,
  // both times to explain what was reversed and why. Deleting the history would be the wrong
  // fix. What must not survive is a line the USER READS that still says it.
  const speech = manager
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  check("no line the user reads still claims Jaroku keeps no copy",
    !speech.includes("does not keep a copy"),
    speech.split("\n").filter((l) => l.includes("keep a copy")).join(" | "));
  check("...and says instead where the token actually lives",
    manager.includes("stored in this workspace's") && manager.includes("envelope-encrypted"));
}

// --- 3. the dispatcher is the only thing that reads it -----------------------------------------

{
  // AND IT NEVER PUTS IT ANYWHERE BUT THE HEADER. The dispatcher is the one caller of
  // `getServeToken`, and what it does with the value is send it to the user's own container.
  // Asserted by recording the request it actually makes.
  const bus = new RunEventBus();
  const runs = new DeployRuns({ signingKey: randomBytes(32), revocations: new RunTokenRevocationList(), bus });
  let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
  const dispatcher = new DeployDispatcher({
    runs,
    endpoint: async (deploymentId) => ({
      url: "https://agent.example",
      serveToken: await secrets.getServeToken(ctx, deploymentId === "svc" ? SERVICE_ID : SERVICE_ID),
    }),
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      return new Response(JSON.stringify({ run_id: "r", accepted_at: "now" }), { status: 202 });
    }) as unknown as typeof fetch,
  });

  const runId = randomUUID();
  const outcome = await dispatcher.start({
    deploymentId: "svc", workspaceId: ctx.workspaceId, agentId: "a_deployed_agent",
    runId, input: "hello", controlPlaneUrl: "https://jaroku.example",
  });
  check("the dispatcher can reach a deployed agent with the stored token", outcome.ok, JSON.stringify(outcome));
  const request = seen as unknown as { headers: Record<string, string>; body: string } | null;
  check("...presenting it as a bearer header",
    request?.headers["authorization"] === `Bearer ${SERVE_TOKEN}`,
    JSON.stringify(request?.headers));
  // THE BODY CARRIES THE RUN TOKEN, NOT THE SERVE TOKEN. Two different credentials with two
  // different lifetimes: one gets past the front door, the other is scoped to this one run and
  // expires. Putting the long-lived one in the body would hand it to the container to keep.
  check("...and never in the body, which carries the run's own short-lived token instead",
    !(request?.body ?? "").includes(SERVE_TOKEN) && (request?.body ?? "").includes("run_token"),
    (request?.body ?? "").slice(0, 200));
  runs.close(runId, "ended");
}

{
  // A DEPLOYMENT MADE BEFORE THIS EXISTED. Its token was minted, shown once and thrown away, and
  // nothing can recover it — which is a real state with a real answer, not an error to swallow.
  const bus = new RunEventBus();
  const runs = new DeployRuns({ signingKey: randomBytes(32), revocations: new RunTokenRevocationList(), bus });
  const dispatcher = new DeployDispatcher({
    runs,
    endpoint: async () => ({ url: "https://agent.example", serveToken: null }),
    fetchImpl: (async () => new Response("unauthorised", { status: 401 })) as unknown as typeof fetch,
  });
  const outcome = await dispatcher.start({
    deploymentId: "old", workspaceId: ctx.workspaceId, agentId: "a", runId: randomUUID(),
    input: "hello", controlPlaneUrl: "https://jaroku.example",
  });
  check("an agent deployed before Jaroku kept the token cannot be dispatched to",
    !outcome.ok && outcome.reason === "unauthorised", JSON.stringify(outcome));
  // THE ONE FAILURE WITH A BUTTON ATTACHED. The message has to name the fix, because the fix is
  // not something a user can work out: the old credential is gone and only a rotate replaces it.
  check("...and is told the fix by name rather than left with a 401",
    !outcome.ok && outcome.detail.includes("reconnect"), JSON.stringify(outcome));
}

await db.close();
try { rmSync(DB, { force: true }); } catch { /* the OS will get it */ }
try { rmSync(ENV_FILE, { force: true }); } catch { /* likewise */ }
delete process.env[serveTokenEnvKeyFor(SERVICE_ID)];
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

// The deploy control plane: what the record claims, and what it does when nobody is watching.
//
// A deploy creates real resources in somebody's real Railway account, so the failure this
// suite is mostly about is a record that LIES — a row still saying "building" when nothing is
// building, a terminal row with no end time, a cancelled deploy that reads as failed. Every
// one of those sends a user to the wrong place, and one of the wrong places is "deploy it
// again", which makes a second project.
//
// The Railway client's failure classification is here too, exercised against a stub server.
// It belongs with this: "your token is wrong", "Railway is down" and "Railway said no" are
// three different things for the user to do, and collapsing them is the same kind of lie.
//
//   npm run test:deploy-store

import { createServer, type Server } from "node:http";

import { SqliteDb } from "./db/sqlite.ts";

import { DeployStore, isInFlight, type DeployStatus } from "./deployStore.ts";
import { RailwayApi, RailwayError, isTerminalStatus } from "./railwayApi.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function freshStore(): Promise<DeployStore> {
  const store = new DeployStore(new SqliteDb(":memory:"));
  await store.init();
  return store;
}
const seed = (store: DeployStore, agentId = "a1", envKeys: string[] = []) =>
  store.create({ agentId, provider: "anthropic", model: "claude-haiku-4-5", envKeys });

// --- 1. a row exists before anything does ------------------------------------------------
{
  const store = await freshStore();
  const d = await seed(store, "a1", ["ANTHROPIC_API_KEY", "DATABASE_URL"]);

  // The whole point of writing first: the row predates every Railway resource, so it cannot
  // claim to be further along than it is.
  check("a new deployment starts queued", d.status === "queued");
  check("...with no Railway ids yet",
    d.railway_project_id === null && d.railway_service_id === null
      && d.railway_environment_id === null && d.railway_deployment_id === null);
  check("...and no url — never a guess at what it will be", d.url === null);
  check("...and no end time", d.ended_at === null);

  check("env_keys are stored as names", JSON.stringify((await store.get(d.id))?.env_keys)
    === JSON.stringify(["ANTHROPIC_API_KEY", "DATABASE_URL"]));

}

// --- 2. the schema has nowhere to put a credential ----------------------------------------
{
  const db = new SqliteDb(":memory:");
  await new DeployStore(db).init();
  const names = (await db.all<{ name: string }>("PRAGMA table_info(deployments)")).map((c) => c.name);
  check("the deployments table has an env_keys column", names.includes("env_keys"));
  check("...and no column that sounds like a value",
    !names.some((n) => /token|secret|password|value|key$/i.test(n)), names.join(","));

  const logCols = (await db.all<{ name: string }>("PRAGMA table_info(deployment_logs)"))
    .map((c) => c.name);
  check("a log row carries text, stage and stream and nothing else",
    logCols.sort().join(",") === "deployment_id,seq,stage,stream,text,ts", logCols.join(","));
}

// --- 2b. patch writes columns, not whatever it was handed ---------------------------------
{
  const store = await freshStore();
  const d = await seed(store, "a1");
  const patchAny = store as unknown as {
    patch: (id: string, c: Record<string, unknown>) => Promise<unknown>;
  };

  // TypeScript keeps the in-tree callers honest and does nothing at runtime. Passing `id`
  // rewrote the primary key: the deploy driving that row went on patching an id that no
  // longer existed, while the record it thought it was updating became unreachable.
  for (const column of ["id", "agent_id", "created_at"]) {
    let threw = "";
    // Awaited: the refusal is a rejected promise now that the store is async, and an
    // un-awaited call would sail past this catch and be reported as accepted.
    try { await patchAny.patch(d.id, { [column]: "hijacked" }); } catch (e) { threw = (e as Error).message; }
    check(`${column} cannot be patched`, threw.includes("not a patchable column"), threw || "accepted");
  }
  let injected = "";
  try { await patchAny.patch(d.id, { "url = 'x' --": "y" }); } catch (e) { injected = (e as Error).message; }
  check("a key that is not a column at all is refused",
    injected.includes("not a patchable column"), injected || "accepted");

  const row = await store.get(d.id);
  check("...and the row is still itself afterwards",
    row?.id === d.id && row?.agent_id === "a1", JSON.stringify(row?.id));
  await store.patch(d.id, { status: "live", url: "https://x.up.railway.app" });
  check("real patches still apply", (await store.get(d.id))?.url === "https://x.up.railway.app");
}

// --- 3. ended_at follows the status, never the caller --------------------------------------
{
  const store = await freshStore();
  const d = await seed(store);

  for (const status of ["packaging", "uploading", "building", "deploying"] as DeployStatus[]) {
    await store.patch(d.id, { status });
    check(`${status} is in flight and has no end time`,
      isInFlight(status) && (await store.get(d.id))?.ended_at === null);
  }

  await store.patch(d.id, { status: "live", url: "https://x.up.railway.app" });
  const live = (await store.get(d.id))!;
  check("live stamps an end time", live.ended_at !== null);
  check("...and keeps the url", live.url === "https://x.up.railway.app");

  // A settled deploy that gets patched again must not appear to have finished later than it
  // did — an end time that drifts is an end time nobody can reason about.
  await store.patch(d.id, { status: "live" });
  check("re-entering a terminal status does not move the end time",
    (await store.get(d.id))?.ended_at === live.ended_at);

  // And the reverse: a row that goes back in flight must not keep a stale end time.
  await store.patch(d.id, { status: "building" });
  check("leaving a terminal status clears the end time", (await store.get(d.id))?.ended_at === null);
}

// --- 4. the terminal statuses say different things ------------------------------------------
{
  const store = await freshStore();
  for (const status of ["failed", "cancelled", "interrupted", "removed"] as DeployStatus[]) {
    const d = await seed(store, "a1");
    await store.patch(d.id, { status, error: status === "failed" ? "the build failed" : null });
    const row = (await store.get(d.id))!;
    check(`${status} is terminal and stamped`, !isInFlight(status) && row.ended_at !== null);
  }
  // Cancelled and interrupted are deliberately NOT failed. One means the user stopped it, one
  // means nobody was watching, and "your deploy failed" is wrong advice for both — it sends
  // someone to debug an agent that is fine.
  check("cancelled carries no error", (await store.list()).find((d) => d.status === "cancelled")?.error === null);
  check("interrupted carries no error of its own here",
    (await store.list()).find((d) => d.status === "interrupted")?.error === null);
  check("removed is hidden from the list", !(await store.list()).some((d) => d.status === "removed"));
}

// --- 5. a restart cannot leave a row claiming to be in flight ---------------------------------
{
  const store = await freshStore();
  const building = await seed(store, "a1");
  await store.patch(building.id, { status: "building", railway_project_id: "prj_1" });
  const live = await seed(store, "a2");
  await store.patch(live.id, { status: "live", url: "https://a2.up.railway.app" });
  const failed = await seed(store, "a3");
  await store.patch(failed.id, { status: "failed", error: "boom" });

  const reconciled = await store.reconcileInterrupted();
  check("only the in-flight row is reconciled",
    reconciled.length === 1 && reconciled[0]?.id === building.id);
  check("...and becomes interrupted", (await store.get(building.id))?.status === "interrupted");
  check("...with an end time", (await store.get(building.id))?.ended_at !== null);

  // The message has to be actionable: whatever was already created still exists in the user's
  // account, and the only useful next step is to look at it there.
  const message = (await store.get(building.id))?.error ?? "";
  check("...and an error that points at the dashboard",
    message.includes("Railway account") && message.includes("restart"), message);

  check("a live deployment is untouched by a restart", (await store.get(live.id))?.status === "live");
  check("a failed one keeps its own reason", (await store.get(failed.id))?.error === "boom");
  check("reconciling twice is a no-op", (await store.reconcileInterrupted()).length === 0);
}

// --- 6. logs are ordered, appendable and readable back ----------------------------------------
{
  const store = await freshStore();
  const d = await seed(store);
  // Appended one at a time on purpose. Firing all three concurrently is a different test —
  // that the store's own transaction keeps them from colliding on (deployment_id, seq) — and
  // this one is about the seqs a caller gets back being 0, 1, 2 in the order it asked.
  const seqs: number[] = [];
  for (const t of ["one", "two", "three"]) {
    seqs.push(await store.appendLog(d.id, "building", "build", t));
  }
  check("seq is assigned in order from zero", JSON.stringify(seqs) === "[0,1,2]");
  check("logs read back in seq order",
    (await store.logs(d.id)).map((l) => l.text).join(",") === "one,two,three");
  check("a backfill can start after a point the client already has",
    (await store.logs(d.id, 0)).map((l) => l.seq).join(",") === "1,2");

  // Two deployments must not interleave: each one's log is its own.
  const other = await seed(store, "a2");
  await store.appendLog(other.id, "building", "build", "elsewhere");
  check("another deployment's log starts at zero again",
    (await store.logs(other.id)).length === 1 && (await store.logs(other.id))[0]?.seq === 0);
  check("...and does not appear in the first one's", (await store.logs(d.id)).length === 3);
}

// --- 7. what the sidebar reads ------------------------------------------------------------------
{
  const store = await freshStore();
  const old = await seed(store, "a1");
  await store.patch(old.id, { status: "live", url: "https://old.up.railway.app" });
  const current = await seed(store, "a1");
  await store.patch(current.id, { status: "building" });

  // A redeploy is the ordinary case. While one is in flight it is what the row should say,
  // even though a previous deploy of the same agent is still live and is newer in no sense.
  check("an in-flight deploy wins over a finished one for the same agent",
    (await store.currentForAgent("a1"))?.id === current.id);
  await store.patch(current.id, { status: "failed", error: "no" });
  check("...and once it settles, the most recent row wins",
    (await store.currentForAgent("a1"))?.id === current.id);

  const byAgent = await store.currentByAgent();
  check("currentByAgent answers the whole list in one pass",
    byAgent.size === 1 && byAgent.get("a1")?.id === current.id);
  check("an agent with no deployment is absent rather than null", !byAgent.has("a2"));
  check("inFlight() is empty once nothing is running", (await store.inFlight()).length === 0);
}

// --- 8. Railway failures are three different things, not one ------------------------------------
{
  let mode = "ok";
  const SECRET = "sk-ant-ECHOED-BACK-0000000";
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (mode === "401") { res.writeHead(401); res.end("unauthorized"); return; }
      if (mode === "500") { res.writeHead(500); res.end("bad gateway"); return; }
      if (mode === "gqlAuth") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "Not Authorized" }] }));
        return;
      }
      if (mode === "gqlEcho") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: `bad value ${SECRET}` }] }));
        return;
      }
      if (mode === "garbage") { res.writeHead(200); res.end("<html>"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { projects: { edges: [{ node: { id: "p" } }] } } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}/graphql/v2`;
  const scrub = (t: string): string => t.split(SECRET).join("••••••••");
  const api = new RailwayApi({ token: "tok", endpoint, scrub, timeoutMs: 3000 });

  const kindOf = async (m: string): Promise<{ kind: string; message: string }> => {
    mode = m;
    try {
      await api.verify();
      return { kind: "none", message: "" };
    } catch (err) {
      const e = err as RailwayError;
      return { kind: e.kind, message: e.message };
    }
  };

  mode = "ok";
  check("a working token verifies", (await api.verify()).ok === true);

  check("a 401 is an auth failure the user can fix", (await kindOf("401")).kind === "auth");
  check("...and does not quote the response body",
    !(await kindOf("401")).message.includes("unauthorized"));

  // Railway reports an expired or under-scoped token as a GraphQL error rather than a 401, so
  // a classifier that only looked at the status would send "fix your token" out as
  // "Railway said no".
  check("a GraphQL authorization error is auth, not api",
    (await kindOf("gqlAuth")).kind === "auth");

  check("a 5xx is unreachable, not a refusal", (await kindOf("500")).kind === "unreachable");
  check("a non-JSON answer is an api failure", (await kindOf("garbage")).kind === "api");

  // The case the scrubber exists for: an error that quotes back the input that caused it,
  // when the input was a credential.
  const echoed = await kindOf("gqlEcho");
  check("an error echoing a secret comes back redacted",
    !echoed.message.includes(SECRET) && echoed.message.includes("••••••••"), echoed.message);

  server.close();

  const dead = new RailwayApi({ token: "t", endpoint: "http://127.0.0.1:1/graphql", timeoutMs: 1500 });
  let deadKind = "";
  try { await dead.verify(); } catch (err) { deadKind = (err as RailwayError).kind; }
  check("a host that is not there is unreachable", deadKind === "unreachable");
}

// --- 9. an unrecognised build status is not success ------------------------------------------
{
  check("SUCCESS is terminal", isTerminalStatus("SUCCESS"));
  check("FAILED and CRASHED are terminal",
    isTerminalStatus("FAILED") && isTerminalStatus("CRASHED"));
  check("BUILDING and DEPLOYING are not", !isTerminalStatus("BUILDING") && !isTerminalStatus("DEPLOYING"));
  check("matching ignores case", isTerminalStatus("success"));

  // A status Railway adds tomorrow must read as "still going", never as "finished fine". The
  // same rule the eval engine uses for unrecognised failures: fail toward the expensive
  // answer rather than the silent one.
  check("a status we have never seen is NOT terminal", !isTerminalStatus("HIBERNATING"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

// introspectGraphCached: a version's topology is introspected at most once, ever — exercised
// against a fake CodeCheckSandbox and a fake store, so the caching DECISION is tested without
// paying for a real uv/Python process on every assertion (codeCheck.test.ts already covers the
// sandbox contract itself for real).
//
//   npm run test:graph-introspect

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { introspectGraphCached, type GraphCacheStore, type GraphResult } from "./graphIntrospect.ts";
import type { CodeCheckSandbox, CodeCheckSpec, CodeCheckResult } from "./sandbox/codeCheck.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

class FakeSandbox implements CodeCheckSandbox {
  calls = 0;
  constructor(private results: CodeCheckResult[]) {}
  async run(_spec: CodeCheckSpec): Promise<CodeCheckResult> {
    this.calls++;
    return this.results[Math.min(this.calls - 1, this.results.length - 1)]!;
  }
}

class FakeStore implements GraphCacheStore {
  cache = new Map<string, unknown>();
  async getGraphCache(agentId: string, version: number) {
    return this.cache.get(`${agentId}@${version}`);
  }
  async setGraphCache(agentId: string, version: number, graph: unknown) {
    this.cache.set(`${agentId}@${version}`, graph);
  }
}

const ok: GraphResult = { agent_id: "a1", nodes: [{ id: "start", type: "start" }], edges: [] };
const okResult: CodeCheckResult = { stdout: JSON.stringify(ok), stderr: "", timedOut: false, exitCode: 0, spawnError: null, truncated: false };

await (async () => {
  const sandbox = new FakeSandbox([okResult]);
  const store = new FakeStore();
  const first = await introspectGraphCached("/rt", "a1", 1, store, undefined, sandbox);
  const second = await introspectGraphCached("/rt", "a1", 1, store, undefined, sandbox);
  check("the first call actually runs the sandbox", sandbox.calls === 1);
  check("a second call for the SAME version reuses the cache, not the sandbox", sandbox.calls === 1);
  check("both calls return the same result", JSON.stringify(first) === JSON.stringify(second));
})();

await (async () => {
  const sandbox = new FakeSandbox([okResult]);
  const store = new FakeStore();
  await introspectGraphCached("/rt", "a1", 1, store, undefined, sandbox);
  await introspectGraphCached("/rt", "a1", 2, store, undefined, sandbox);
  check("a DIFFERENT version is introspected fresh, not served from version 1's cache", sandbox.calls === 2);
})();

await (async () => {
  const sandbox = new FakeSandbox([okResult]);
  const store = new FakeStore();
  await introspectGraphCached("/rt", "agent-a", 1, store, undefined, sandbox);
  await introspectGraphCached("/rt", "agent-b", 1, store, undefined, sandbox);
  check("a different agent id at the SAME version number is not confused with the first", sandbox.calls === 2);
})();

await (async () => {
  const failing: CodeCheckResult = { stdout: "", stderr: "boom", timedOut: false, exitCode: 1, spawnError: null, truncated: false };
  const sandbox = new FakeSandbox([failing, okResult]);
  const store = new FakeStore();
  const first = await introspectGraphCached("/rt", "a1", 1, store, undefined, sandbox);
  check("a failed introspection reports the error", !!first.error);
  const second = await introspectGraphCached("/rt", "a1", 1, store, undefined, sandbox);
  check("a FAILED result is never cached — the next call tries again", sandbox.calls === 2);
  check("...and can succeed once the transient problem is gone", !second.error);
})();

// ---------------------------------------------------------------------------------------------
// THE ONE ERROR PATH IN THIS PRODUCT THAT IS WIRED END TO END, and it delivered less information
// than a raw string dump. This is the read that CATCHES a missing object and explains it, which
// makes it the diagnosis a user meets first when a version's objects are unreachable — and the
// client fed the whole explanation through a path truncator, which is built to keep the last
// segment and collapse everything before it. "could not read this agent's files: no such object:
// ws/…/v2/.env.example" rendered as `.env.example`, under a heading it had no relationship to.
//
// The fix is that the sentence and the key are two fields, so nothing has to find the boundary by
// parsing prose. Asserted here on the SERVER because that boundary is decided here: what makes it
// a read rather than a guess is that `ObjectNotFound` already carries its own key.
// ---------------------------------------------------------------------------------------------
console.log("\nan unreadable object explains itself without putting a key in the sentence");
{
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  const branch = /if \(err instanceof ObjectNotFound\) \{[\s\S]*?\n        \}/.exec(source)?.[0] ?? "";
  check("the graph read has a branch for a missing object", branch.length > 0);
  check(
    "...answering with the key as its own field",
    /errorKey: err\.key/.test(branch),
  );
  check(
    "...and a sentence that does not interpolate it",
    /error: "could not read this agent's files"/.test(branch) && !/\$\{.*key.*\}/.test(branch),
  );

  // AND THE SHAPE IS ON THE TYPE, both sides. A field the server sends and the client's copy of
  // the type does not declare is a field no component can read, which is the same silence the
  // whole finding is about.
  const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src", "types.ts");
  const clientTypes = readFileSync(CLIENT, "utf8");
  const agentGraph = /export interface AgentGraph \{[\s\S]*?\n\}/.exec(clientTypes)?.[0] ?? "";
  check("the client's AgentGraph declares errorKey too", /errorKey\?: string/.test(agentGraph));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

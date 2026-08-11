// introspectGraphCached: a version's topology is introspected at most once, ever — exercised
// against a fake CodeCheckSandbox and a fake store, so the caching DECISION is tested without
// paying for a real uv/Python process on every assertion (codeCheck.test.ts already covers the
// sandbox contract itself for real).
//
//   npm run test:graph-introspect

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
const okResult: CodeCheckResult = { stdout: JSON.stringify(ok), stderr: "", timedOut: false, exitCode: 0, spawnError: null };

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
  const failing: CodeCheckResult = { stdout: "", stderr: "boom", timedOut: false, exitCode: 1, spawnError: null };
  const sandbox = new FakeSandbox([failing, okResult]);
  const store = new FakeStore();
  const first = await introspectGraphCached("/rt", "a1", 1, store, undefined, sandbox);
  check("a failed introspection reports the error", !!first.error);
  const second = await introspectGraphCached("/rt", "a1", 1, store, undefined, sandbox);
  check("a FAILED result is never cached — the next call tries again", sandbox.calls === 2);
  check("...and can succeed once the transient problem is gone", !second.error);
})();

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

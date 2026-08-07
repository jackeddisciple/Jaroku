// No store keeps a row across a workspace switch.
//
// The server can be flawless — every query scoped, every broadcast filtered, RLS behind all of
// it — and the app can still show one workspace's runs under another workspace's name, because
// the browser kept them. That is a cross-tenant leak in the UI, and it is the one the spec
// calls out by name in "things that will bite you".
//
// TWO ASSERTIONS, and the second is the one that survives this session. The first fills every
// store with recognisable data, resets, and checks that none of it is left. The second reads
// the store DIRECTORY and fails when a store exists that is neither reset nor explicitly
// excluded — because the leak that actually happens is not in a store somebody tested, it is
// in the one added six months later that nobody wired in.
//
//   npm run test:reset

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NOT_WORKSPACE_SCOPED, WORKSPACE_STORES, resetWorkspaceStores } from "./reset.ts";
import { useBuildStore } from "./buildStore.ts";
import { useChatStore } from "./chatStore.ts";
import { useDeployStore } from "./deployStore.ts";
import { useEvalStore } from "./evalStore.ts";
import { useGraphStore } from "./graphStore.ts";
import { useMcpStore } from "./mcpStore.ts";
import { useMemberStore } from "./memberStore.ts";
import { useProviderStore } from "./providerStore.ts";
import { useTraceStore } from "./traceStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

/** The string that must not survive. Distinctive enough to find anywhere in a serialised store. */
const TENANT_A = "workspace-a-secret-payload";

console.log("\nfilling every store with one workspace's data");
{
  useTraceStore.setState({
    // A Record keyed by run id, not an array — the shape the store actually holds.
    runs: { "run-1": { id: "run-1", agent_id: TENANT_A, provider: "fake", model: "m", status: "completed",
                       started_at: "", ended_at: null, cost: 0, tokens: 0, error: null } },
    stepsByRun: { "run-1": [{ id: "s1", run_id: "run-1", seq: 0, type: "llm_call", name: TENANT_A,
                              input: { secret: TENANT_A }, output: null, state_before: null, state_after: null,
                              tokens: null, cost: null, latency_ms: 0, error: null, parent_step_id: null,
                              started_at: "" }] },
    activeRunId: "run-1",
    logs: [{ level: "stderr", text: TENANT_A }],
  } as never);
  useBuildStore.setState({ agents: [{ agent_id: TENANT_A, name: TENANT_A }], activeAgentId: TENANT_A } as never);
  useChatStore.setState({ messages: [{ id: "1", role: "user", text: TENANT_A }] } as never);
  useEvalStore.setState({ datasets: [{ id: "d1", name: TENANT_A }] } as never);
  useGraphStore.setState({ graphs: { [TENANT_A]: { agent_id: TENANT_A } } } as never);
  useMcpStore.setState({ servers: [{ id: "s1", label: TENANT_A }] } as never);
  useMemberStore.setState({ members: [{ email: TENANT_A }], invites: [{ email: TENANT_A }] } as never);
  useProviderStore.setState({ providers: [{ id: "anthropic", configured: true, note: TENANT_A }] } as never);
  useDeployStore.setState({ deployments: [{ id: "d1", agent_id: TENANT_A }] } as never);

  // The fixture has to actually be findable, or the assertion below passes on an empty app.
  const before = Object.entries(WORKSPACE_STORES).filter(([, s]) =>
    JSON.stringify((s as unknown as { getState(): unknown }).getState()).includes(TENANT_A),
  );
  check(
    before.length === Object.keys(WORKSPACE_STORES).length,
    `every store is holding the fixture before the switch (${before.length}/${Object.keys(WORKSPACE_STORES).length})`,
  );
}

console.log("\nswitching workspace");
{
  resetWorkspaceStores();

  const leaked = Object.entries(WORKSPACE_STORES)
    .filter(([, s]) => JSON.stringify((s as unknown as { getState(): unknown }).getState()).includes(TENANT_A))
    .map(([name]) => name);
  check(leaked.length === 0, `NO store retains a row across a switch (leaked: ${leaked.join(", ") || "none"})`);

  // Spot-checks, so a failure above names something concrete rather than just "a store".
  check(Object.keys(useTraceStore.getState().runs).length === 0, "the run history is empty");
  check(Object.keys(useTraceStore.getState().stepsByRun).length === 0, "...and so are the step payloads");
  check(useTraceStore.getState().activeRunId === null, "...and nothing is selected");
  check(useBuildStore.getState().agents.length === 0, "the agent list is empty");
  check(useBuildStore.getState().activeAgentId === null, "...with no agent selected");
  check(useMemberStore.getState().members.length === 0, "the member list is empty — those are email addresses");
  check(useEvalStore.getState().datasets.length === 0, "the datasets are gone");
  check(useDeployStore.getState().deployments.length === 0, "the deployments are gone");

  // A reset that wiped the ACTIONS would leave a store that looks empty and then throws on the
  // first message from the new workspace — which reads as "the switch broke the app".
  check(typeof useTraceStore.getState().applyHistory === "function", "the store's actions survive the reset");
  check(typeof useBuildStore.getState().setAgents === "function", "...on every store, not just the first");
  check(typeof useMemberStore.getState().setMembers === "function", "...including the ones added this session");
}

console.log("\nevery store is accounted for");
{
  // The assertion that outlives this session. Read from the directory, so a store added later
  // fails here rather than quietly keeping the previous tenant's rows.
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const stores = readdirSync(dir)
    .filter((f: string) => f.endsWith("Store.ts") && !f.endsWith(".test.ts"))
    .map((f: string) => f.replace(/\.ts$/, ""));
  check(stores.length >= 9, `found the store directory (${stores.length} stores)`);

  const accounted = new Set([...Object.keys(WORKSPACE_STORES), ...NOT_WORKSPACE_SCOPED]);
  const unaccounted = stores.filter((s: string) => !accounted.has(s));
  check(
    unaccounted.length === 0,
    `every store is either reset or explicitly excluded (unaccounted: ${unaccounted.join(", ") || "none"})`,
  );

  const phantom = [...accounted].filter((s) => !stores.includes(s));
  check(phantom.length === 0, `no entry names a store that no longer exists (${phantom.join(", ") || "none"})`);

  // The exclusions are a short, deliberate list. Growing it is how this assertion gets
  // defeated, so its exact contents are the assertion.
  check(
    NOT_WORKSPACE_SCOPED.length === 2 &&
      NOT_WORKSPACE_SCOPED.includes("sessionStore") &&
      NOT_WORKSPACE_SCOPED.includes("uiStore"),
    `only sessionStore and uiStore are excluded (${NOT_WORKSPACE_SCOPED.join(", ")})`,
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

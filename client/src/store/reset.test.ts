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

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NOT_WORKSPACE_SCOPED, WORKSPACE_STORES, resetWorkspaceStores } from "./reset.ts";
import { hasElevationToken, setElevationToken } from "../lib/secrets.ts";
import { useBillingStore } from "./billingStore.ts";
import { useBuildStore } from "./buildStore.ts";
import { useChatStore } from "./chatStore.ts";
import { useDeployStore } from "./deployStore.ts";
import { useEvalStore } from "./evalStore.ts";
import { useGraphStore } from "./graphStore.ts";
import { useConnectionStore } from "./connectionStore.ts";
import { useMcpStore } from "./mcpStore.ts";
import { useMemberStore } from "./memberStore.ts";
import { useProviderStore } from "./providerStore.ts";
import { useSecretsStore } from "./secretsStore.ts";
import { useTraceStore } from "./traceStore.ts";
import { useSessionStore } from "./sessionStore.ts";
import { inputKey, INPUT_KEY_PREFIX, useUiStore } from "./uiStore.ts";

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

// A localStorage, because there is no browser here. Enough of the API for the audit below, and
// deliberately not a dependency: the thing under test is which KEY is written, not what a real
// implementation does with it.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    get length(): number {
      return map.size;
    },
    key: (i: number): string | null => [...map.keys()][i] ?? null,
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => void map.set(k, String(v)),
    removeItem: (k: string): void => void map.delete(k),
    clear: (): void => map.clear(),
  };
}

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
  // An account label is the leak here: one tenant's email address rendered under another
  // tenant's name, beside a Disconnect button that would act in the wrong workspace.
  useConnectionStore.setState({
    connections: [{ connectorId: "gmail", account: TENANT_A, label: TENANT_A }],
  } as never);
  useMemberStore.setState({ members: [{ email: TENANT_A }], invites: [{ email: TENANT_A }] } as never);
  useProviderStore.setState({ providers: [{ id: "anthropic", configured: true, note: TENANT_A }] } as never);
  // A credential NAME and the fact this session is unlocked. The names are what a workspace
  // integrates with, and `elevated` is worse than a stale row: carried across a switch it would
  // leave the second workspace's gate standing open because somebody unlocked the first.
  useSecretsStore.setState({
    secrets: [{ name: TENANT_A, kind: "custom", maskedHint: TENANT_A }],
    elevated: true,
    expiresAt: TENANT_A,
    passcodeSet: true,
  } as never);
  useDeployStore.setState({ deployments: [{ id: "d1", agent_id: TENANT_A }] } as never);
  // Session 6. A spend figure held across a switch is one workspace's invoice shown under
  // another's name — the same class of leak as a trace row, and harder to explain afterwards.
  useBillingStore.setState({
    usage: { plan: { id: "free", label: TENANT_A }, byAgent: [{ label: TENANT_A }] },
    loaded: true,
  } as never);

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
  // THE ONE PIECE OF WORKSPACE STATE THE LOOP CANNOT REACH. The elevation token is a module
  // variable in lib/secrets.ts rather than a store field, on purpose, so `getInitialState()` walks
  // past it — and a tab that still believes it holds an elevation skips the rejoin and 403s on
  // every request until the next poll.
  setElevationToken("a-token-issued-for-the-workspace-being-left");
  check(hasElevationToken(), "a token from the workspace being left is in hand");

  resetWorkspaceStores();

  check(!hasElevationToken(), "...and the switch forgets it, along with every store");

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

console.log("\nand so is everything the browser keeps");
{
  // THE BLIND SPOT THIS SUITE HAD. Everything above audits STORES, and a store is memory —
  // it dies on the reset and again on the reload. localStorage does neither, and the leak that
  // actually shipped was there: `jaroku.input.<agent>` remembered the last test input keyed by
  // agent slug alone, and slugs stopped being globally unique in Session 1. Two workspaces with
  // a same-named agent on one browser meant one tenant's last input loaded into the other's
  // composer, surviving not just a switch but a sign-out.
  //
  // `resetWorkspaceStores` could never have caught it and neither could the directory scan
  // above, because localStorage is not a store. So: read the source for every `jaroku.` key the
  // client writes, and require each to be classified.
  const src = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(src, { recursive: true }).filter(
    (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes("node_modules"),
  );
  check(files.length > 20, `read the client source (${files.length} files)`);
  const keys = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(`${src}/${f}`, "utf8").matchAll(/["'`]jaroku\.([a-z]+)/g)) {
      keys.add(`jaroku.${m[1]!}`);
    }
  }

  /** Keys whose VALUE belongs to one workspace. Each must carry a workspace id in the key. */
  const WORKSPACE_SCOPED = new Set(["jaroku.input"]);
  /** Keys that hold nothing a workspace owns. Each is a decision, not an oversight. */
  const NOT_TENANT_DATA = new Set([
    "jaroku.token",      // the bearer token — the account's, not a workspace's, and cleared on sign-out
    "jaroku.workspace",  // WHICH workspace, not anything in one. Cleared on sign-out
    // First-run progress: a step name and a list of hint ids, and nothing else — WHETHER
    // somebody has onboarded is the server's answer now (users.onboarded_at). Keyed by user
    // rather than swept on sign-out, so a returning person resumes an unfinished flow instead
    // of restarting it, and the next person at this browser does not inherit it.
    "jaroku.onboarding",
  ]);

  const unclassified = [...keys].filter((k) => !WORKSPACE_SCOPED.has(k) && !NOT_TENANT_DATA.has(k));
  check(
    unclassified.length === 0,
    `every jaroku.* browser key is classified (${keys.size} found; unclassified: ${unclassified.join(", ") || "none"})`,
  );

  // ...and the workspace-scoped ones actually carry the workspace, rather than being trusted to.
  useSessionStore.setState({ workspaceId: "ws-AAA" } as never);
  const inA = inputKey("support_bot");
  useSessionStore.setState({ workspaceId: "ws-BBB" } as never);
  const inB = inputKey("support_bot");
  check(inA !== inB, "the SAME agent slug in two workspaces gets two different keys");
  check(inA.includes("ws-AAA") && inB.includes("ws-BBB"), "...each naming its own workspace");
  check(inA.startsWith(INPUT_KEY_PREFIX) && inB.startsWith(INPUT_KEY_PREFIX), "...under the prefix the sign-out sweep uses");

  // The leak, end to end: A remembers an input, B must not read it back.
  useSessionStore.setState({ workspaceId: "ws-AAA" } as never);
  localStorage.setItem(inputKey("support_bot"), TENANT_A);
  useSessionStore.setState({ workspaceId: "ws-BBB" } as never);
  check(
    (localStorage.getItem(inputKey("support_bot")) ?? "") !== TENANT_A,
    "a remembered test input does NOT cross to a same-named agent in another workspace",
  );
  localStorage.removeItem(`${INPUT_KEY_PREFIX}ws-AAA.support_bot`);

  // The same shape one level up: onboarding PROGRESS is per user, so two accounts sharing a
  // browser do not resume each other's flow. (Whether onboarding is finished is not here at
  // all — it is users.onboarded_at, which is the point of migration 013.)
  useSessionStore.setState({ user: { id: "user-1", email: "a@x", displayName: null, onboarded: false } } as never);
  useUiStore.getState().setOnboardingStep("run");
  check(useUiStore.getState().onboardingStep === "run", "one user reaches onboarding step 'run'");

  useSessionStore.setState({ user: { id: "user-2", email: "b@x", displayName: null, onboarded: false } } as never);
  useUiStore.getState().loadOnboarding();
  check(
    useUiStore.getState().onboardingStep === "welcome",
    "a DIFFERENT account on the same browser starts at 'welcome' rather than inheriting it",
  );

  useSessionStore.setState({ user: { id: "user-1", email: "a@x", displayName: null, onboarded: false } } as never);
  useUiStore.getState().loadOnboarding();
  check(
    useUiStore.getState().onboardingStep === "run",
    "...and the first one resumes where they actually were",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

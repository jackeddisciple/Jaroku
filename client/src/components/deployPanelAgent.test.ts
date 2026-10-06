// The Deploy panel shows the selected agent's deployment, and a one-time token only beside its own.
//
// THE BUG. After Margot's deploy, selecting Bruno still showed Margot's deployment — her one-time
// bearer token included, as if it were Bruno's — and Bruno's deploy form was only reachable through
// "Deploy another" at the very bottom of the panel.
//
//   npm run test:deploy-panel-agent

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g["localStorage"] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g["window"] = { location: { search: "", href: "http://localhost/", origin: "http://localhost" }, history: { replaceState() {} } };

const { markup, seed } = await import("../lib/testRender.ts");
const { useBuildStore } = await import("../store/buildStore.ts");
const { useDeployStore } = await import("../store/deployStore.ts");
const { DeployPanel } = await import("./DeployPanel.tsx");

const deployment = (id: string, agent: string, created: string) => ({
  id, agent_id: agent, target: "railway", status: "live" as const, url: `https://${agent}.up.railway.app`,
  provider: "anthropic", model: "claude-haiku-4-5", env_keys: [], error: null, version: 2,
  created_at: created, updated_at: created, ended_at: null,
});
const TOKEN = "jrk_serve_token_for_margot_only";

function render(selectedId: string): string {
  seed(useBuildStore, { agents: [{ agent_id: "margot", name: "Margot" }, { agent_id: "bruno", name: "Bruno" }] as never, activeAgentId: "bruno" });
  seed(useDeployStore, {
    deployments: [deployment("d-margot", "margot", "2026-10-01T10:00:00Z"), deployment("d-bruno", "bruno", "2026-09-30T10:00:00Z")],
    railwayConfigured: true, loaded: true, plan: null, planning: false, error: null, notice: null,
    selectedId, serveToken: { deploymentId: "d-margot", url: "https://margot.up.railway.app", token: TOKEN },
    logs: {}, stage: {},
  } as never);
  return markup(createElement(DeployPanel));
}

console.log("\na one-time token beside its own deployment, and nowhere else");
{
  check(!render("d-bruno").includes(TOKEN), "Bruno's deployment does not show Margot's token");
  check(render("d-margot").includes(TOKEN), "...while Margot's still does, until it is dismissed");
}

console.log("\nthe panel follows the agent");
{
  const panel = readFileSync(fileURLToPath(new URL("./DeployPanel.tsx", import.meta.url)), "utf8");
  check(/\.filter\(\(d\) => d\.agent_id === agentId\)/.test(panel) && /select\(mine\?\.id \?\? null\)/.test(panel) && /\}, \[agentId, select\]\);/.test(panel),
    "choosing an agent opens its latest deployment, or its form when it has none");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

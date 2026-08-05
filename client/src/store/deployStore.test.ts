// The deploy panel's state, and the races it has to survive.
//
// Everything here is a fact the SERVER owns and this store only mirrors, which makes the
// interesting failures ones of timing rather than logic: a snapshot arriving while the user is
// part-way through something, and taking the screen away from them.
//
//   npm run test:deploy-store

import { useDeployStore, deploymentFor, selectedDeployment, liveAgentIds } from "./deployStore.ts";
import { agentStatus } from "../lib/agentStatus.ts";
import type { Deployment, DeployStatus } from "../types.ts";
let fails = 0;
const check = (n: string, ok: boolean, d = "") => { console.log((ok?"  ok   ":"  FAIL ")+n+(ok||!d?"":" — "+d)); if(!ok) fails++; };
const dep = (id: string, agent: string, status: DeployStatus, url: string | null = null): Deployment => ({
  id, agent_id: agent, target: "railway", status, url, provider: "anthropic", model: "m",
  env_keys: [], error: null, created_at: "2026-01-01T00:00:00Z", updated_at: "x", ended_at: null,
});
const S = () => useDeployStore.getState();

console.log("--- 'Deploy another' must survive a snapshot ---");
S().setDeployments([dep("d1", "a", "live", "https://a")], true);
check("a snapshot selects something to show", S().selectedId === "d1");
S().select(null);
check("deselecting shows the form", S().selectedId === null);
S().setDeployments([dep("d1", "a", "live", "https://a")], true);
check("a later snapshot does NOT yank the form away", S().selectedId === null, `selected ${S().selectedId}`);

S().setDeployments([dep("d1", "a", "live", "https://a"), dep("d0","a","failed")], true);
check("...however many snapshots arrive", S().selectedId === null, `selected ${S().selectedId}`);
S().select("d1");
check("picking one closes the form", S().selectedId === "d1");
S().setDeployments([dep("d1", "a", "live", "https://a")], true);
check("...and a snapshot keeps that pick", S().selectedId === "d1");

console.log("--- a NEW deploy still takes focus ---");
S().setStage("d2", "packaging");
check("a stage event selects the deploy it is about", S().selectedId === "d2");

console.log("--- logs ---");
useDeployStore.setState({ logs: {}, selectedId: null });
for (let i = 0; i < 2100; i++) S().appendLog({ deployment_id: "d1", seq: i, ts: "t", stage: "building", stream: "build", text: "line " + i });
const kept = S().logs["d1"]!;
check("the log is capped", kept.length === 2000, String(kept.length));
check("...keeping the newest, not the oldest", kept[kept.length-1]?.text === "line 2099", String(kept[kept.length-1]?.text));
S().appendLog({ deployment_id: "other", seq: 0, ts: "t", stage: "s", stream: "build", text: "elsewhere" });
check("another deployment's log is separate", S().logs["other"]?.length === 1 && S().logs["d1"]?.length === 2000);
S().setLogs("d1", [{ deployment_id: "d1", seq: 0, ts: "t", stage: "s", stream: "build", text: "backfilled" }]);
check("a backfill replaces rather than merges", S().logs["d1"]?.length === 1);

console.log("--- the serve token is never retained ---");
S().setServeToken({ deploymentId: "d1", url: "https://a", token: "sekrit-token-value" });
check("it is held for the panel", S().serveToken?.token === "sekrit-token-value");
S().setDeployments([dep("d1","a","live","https://a")], true);
check("a snapshot does not clear it out from under the user", S().serveToken !== null);
S().dismissServeToken();
check("dismiss clears it", S().serveToken === null);
check("nothing wrote it to localStorage",
  typeof localStorage === "undefined" || !JSON.stringify(localStorage).includes("sekrit-token-value"));

console.log("--- selectors ---");
const many = [dep("x1","a","live","https://one"), dep("x2","a","building"), dep("x3","b","failed")];
check("an in-flight deploy wins for its agent", deploymentFor(many, "a")?.id === "x2");
check("an agent with none gets null", deploymentFor(many, "z") === null);
check("liveAgentIds counts only live", [...liveAgentIds(many)].join(",") === "a");
check("selectedDeployment tolerates a stale id",
  selectedDeployment({ deployments: many, selectedId: "gone" }) === null);

console.log("--- agentStatus precedence ---");
const runs = { r: { id: "r", agent_id: "a", status: "running", started_at: "t", ended_at: null } } as never;
check("a local run outranks a deployment",
  agentStatus("a", runs, { id: "x", status: "live", url: "u" }) === "running");
check("live -> deployed", agentStatus("b", {}, { id: "x", status: "live", url: "u" }) === "deployed");
check("building -> deploying", agentStatus("b", {}, { id: "x", status: "building", url: null }) === "deploying");
check("failed is not shown as state", agentStatus("b", {}, { id: "x", status: "failed", url: null }) === "draft");
check("superseded is not shown as state", agentStatus("b", {}, { id: "x", status: "superseded", url: "u" }) === "draft");
check("no deployment at all -> draft", agentStatus("b", {}) === "draft");
check("null deployment is tolerated", agentStatus("b", {}, null) === "draft");

console.log(fails === 0 ? "\nALL CORRECT" : `\n${fails} FAILURES`);
if (fails > 0) throw new Error(`${fails} failures`);

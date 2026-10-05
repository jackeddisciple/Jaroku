// The deploy form's pre-check: whose credentials it reads, and from where.
//
// Two bugs met on the way to a live agent, and both were the check asking a different question
// from the deploy it guards:
//
//   THE WRONG PLACE. The check read the Secrets tab's registry while the deploy read the process
//   environment, so a key in `runtime/.env` was "not set" and Deploy stayed disabled — until
//   "Deploy anyway" was ticked, and then the key was sent after all.
//
//   THE WRONG WORKSPACE. The plan ran under the deploy manager's own context, which is whichever
//   workspace deployed last, so workspace B's form was checked against A's credentials and A's
//   Railway token.
//
//   npm run test:deploy-plan

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newRequestId, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { planDeploy, type DeployManagerDeps } from "./deployManager.ts";
import type { DeployStore } from "./deployStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const runtimeDir = mkdtempSync(join(tmpdir(), "jaroku-plan-"));
const agentDir = join(runtimeDir, "agents", "bruno");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "agent.py"), "print\n");
writeFileSync(join(agentDir, "jaroku.json"), JSON.stringify({ required_env: ["SLACK_BOT_TOKEN"] }));

const A = systemContextFor("00000000-0000-4000-8000-00000000000a", newRequestId());
const B = systemContextFor("00000000-0000-4000-8000-00000000000b", newRequestId());

/** What each workspace holds. B has the agent's credential; A has only a Railway token. */
const held: Record<string, Set<string>> = {
  [A.workspaceId]: new Set(),
  [B.workspaceId]: new Set(["ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN"]),
};
const railway: Record<string, string | null> = { [A.workspaceId]: "railway-of-A", [B.workspaceId]: null };
const asked: { ctx: TenantContext; names: string[] }[] = [];

const deps = {
  runtimeDir,
  store: { reusableTarget: async () => null } as unknown as DeployStore,
  // THE DEPLOY IN FLIGHT IS A'S. A plan that read this context was the bug.
  context: () => A,
  token: async (ctx: TenantContext) => railway[ctx.workspaceId] ?? null,
  configuredNames: async (ctx: TenantContext, names: string[]) => {
    asked.push({ ctx, names });
    return new Set(names.filter((n) => held[ctx.workspaceId]?.has(n)));
  },
  agentBusy: () => false,
} as unknown as DeployManagerDeps;

// None of these is in this process's environment, so a check that fell back to it would fail.
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["SLACK_BOT_TOKEN"];

const plan = await planDeploy(deps, {
  agentId: "bruno", provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
}, B);

check("the check asks the store about the ASKING workspace, not the one deploying",
  asked.length === 1 && asked[0]!.ctx.workspaceId === B.workspaceId, JSON.stringify(asked.map((a) => a.ctx.workspaceId)));
check("...for every name the agent needs, the provider key included",
  ["ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN"].every((n) => asked[0]?.names.includes(n)), asked[0]?.names.join(","));
check("a credential the workspace holds is configured, though the process environment has none",
  plan.secrets.every((s) => s.configured), JSON.stringify(plan.secrets));
check("...so nothing is reported missing",
  !plan.problems.some((p) => p.startsWith("not set for this workspace")), plan.problems.join(" · "));
check("B has no Railway token of its own, so the plan says so — A's is not B's",
  plan.problems.some((p) => p.startsWith("no Railway token")), plan.problems.join(" · "));

const planA = await planDeploy(deps, {
  agentId: "bruno", provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
}, A);
check("A, holding none of the agent's credentials, is told which are missing",
  planA.problems.some((p) => p.startsWith("not set for this workspace") && p.includes("SLACK_BOT_TOKEN")),
  planA.problems.join(" · "));
check("...and is not told it lacks a Railway token, because it has one",
  !planA.problems.some((p) => p.startsWith("no Railway token")), planA.problems.join(" · "));

rmSync(runtimeDir, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

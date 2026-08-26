// One resolver, every command classified, and the tier table says what the pricing says.
//
// THE STRUCTURAL HALF IS THE POINT, and it is the fourth audit of this shape in the codebase —
// `test:capabilities` reads the relay for every command and fails on one with no capability, and
// this reads the same source and fails on one with no ENTITLEMENT. The failure it exists for is
// not in the code anybody is looking at today: it is `createSomething`, added a year from now,
// absent from the table, unlimited on every tier forever, with nothing anywhere saying so. A list
// kept by hand passes that day. A list that reads the source does not.
//
// THE SECOND STRUCTURAL ASSERTION IS SUBTLER AND MATTERS MORE. `requireEntitlement` answers `null`
// — allow — for a kind that is in neither `QUOTA_CHECKS` nor `FEATURE_CHECKS`. That is the right
// behaviour for a check nobody wrote and a catastrophe for one somebody MEANT to write: adding
// `canUsePolicyEngine` to the union and forgetting to give it a limit produces a gate that opens
// for everybody, silently, and reads as working. So the union is enumerated against both maps.
//
// AND THEN THE NUMBERS, one assertion per line of the pricing table, because that table is a
// promise made to people who paid and the file it lives in is edited by hand.
//
//   npm run test:entitlements

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLANS, PLAN_IDS } from "./plans.ts";
import {
  ADMIN_ENTITLEMENTS, entitlementsForPlan, resolveEntitlements, unlockingTier, within,
  type TierEntitlements,
} from "./entitlements.ts";
import {
  COMMAND_ENTITLEMENT, NO_ENTITLEMENT, USAGE_METRICS, entitlementFor, refusalMessage,
  requireEntitlement, type EntitlementCounts, type EntitlementKind,
} from "./entitlementGate.ts";
import { systemContextFor, newRequestId, type TenantContext } from "../db/tenant.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const here = fileURLToPath(new URL(".", import.meta.url));
const src = (...p: string[]): string => readFileSync(join(here, "..", ...p), "utf8");

// ---------------------------------------------------------------------------------------------
console.log("\nevery command the relay accepts is classified");
// ---------------------------------------------------------------------------------------------
{
  // The same two shapes `test:capabilities` reads, from the same file, so the two audits cannot
  // disagree about what the command surface IS while disagreeing about whether it is covered.
  const relay = src("wsRelay.ts");
  const commands = new Set<string>();
  for (const m of relay.matchAll(/msg\.cmd === "([a-zA-Z]+)"/g)) commands.add(m[1]!);
  for (const m of relay.matchAll(/^const [A-Z_]+_COMMANDS = new Set\(\[([\s\S]*?)\]\);/gm)) {
    for (const q of m[1]!.matchAll(/"([a-zA-Z]+)"/g)) commands.add(q[1]!);
  }
  check(commands.size > 40, `found the relay's command surface (${commands.size} commands)`);

  const unclassified = [...commands].filter((c) => entitlementFor(c) === undefined);
  check(
    unclassified.length === 0,
    `every relay command has an entitlement or an explicit none (unclassified: ${unclassified.join(", ") || "none"})`,
  );

  // The other direction. An entry for a command the relay dropped is a rule nothing enforces, and
  // it makes this table read as covering more than it does.
  const stale = Object.keys(COMMAND_ENTITLEMENT).filter((c) => !commands.has(c));
  check(stale.length === 0, `no entry names a command the relay dropped (stale: ${stale.join(", ") || "none"})`);

  check(entitlementFor("no-such-command") === undefined, "an unknown command yields undefined, not a default");
  // A plain-object key that assigns a prototype rather than an entry reads as classified to any
  // lookup that does not guard it. Same refusal as `capabilityFor` and the MCP tool names.
  check(entitlementFor("__proto__") === undefined, "...including __proto__, which is not an entry");

  // The audit has to be able to FAIL, or a pass proves only that it ran. `test:db-boundary`
  // asserts the same thing about itself for the same reason.
  const gate = src("billing", "entitlementGate.ts");
  check(
    !gate.includes("?? NO_ENTITLEMENT") && !gate.includes("|| NO_ENTITLEMENT"),
    "the table has no fallback — an unlisted command is undefined, which is what the audit reads",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nno check is declared without something to check it against");
// ---------------------------------------------------------------------------------------------
{
  // `requireEntitlement` returns null — ALLOW — for a kind in neither map. Correct for a kind
  // nobody wrote, catastrophic for one somebody meant to. The union is read from the source
  // rather than restated, so a kind added tomorrow is covered by this assertion tonight.
  const gate = src("billing", "entitlementGate.ts");
  const union = gate.slice(gate.indexOf("export type EntitlementKind"));
  const kinds = [...union.slice(0, union.indexOf(";")).matchAll(/"([a-zA-Z0-9]+)"/g)].map((m) => m[1]!);
  check(kinds.length >= 8, `read the EntitlementKind union (${kinds.length} kinds)`);

  const quota = new Set(
    [...gate.matchAll(/^ {2}(can[A-Za-z]+): \{ limit:/gm)].map((m) => m[1]!),
  );
  const feature = new Set(
    [...gate.slice(gate.indexOf("const FEATURE_CHECKS")).matchAll(/^ {2}([a-zA-Z0-9]+): "/gm)].map((m) => m[1]!),
  );
  const unhandled = kinds.filter((k) => !quota.has(k) && !feature.has(k));
  check(
    unhandled.length === 0,
    `every kind resolves to a limit or a flag (unhandled: ${unhandled.join(", ") || "none"})`,
  );

  // And every kind the command table actually USES is a kind that exists.
  const used = new Set(Object.values(COMMAND_ENTITLEMENT).filter((v) => v !== NO_ENTITLEMENT));
  const bogus = [...used].filter((v) => !kinds.includes(v));
  check(bogus.length === 0, `every value in the command table is a real kind (${bogus.join(", ") || "all real"})`);
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe admin object is complete, and cannot be reached by asking");
// ---------------------------------------------------------------------------------------------
{
  const free = entitlementsForPlan("free");
  const missing = (Object.keys(free) as (keyof TierEntitlements)[]).filter(
    (k) => ADMIN_ENTITLEMENTS[k] === undefined,
  );
  // A field added to the interface and forgotten here is `undefined`, which reads as false for a
  // flag and as NaN for a limit — so the bypass would silently DENY the one user it exists for.
  check(missing.length === 0, `admin entitlements cover every field (missing: ${missing.join(", ") || "none"})`);

  const asAdmin = resolveEntitlements({ plan: "free", isAdmin: true, adminMode: true });
  check(asAdmin.maxAgents === "unlimited" && asAdmin.policyEngine, "admin mode on a free workspace lifts every limit");

  // THE ESCALATION THE WHOLE MODEL REFUSES. `adminMode` is a claim; `isAdmin` is derived from the
  // environment at session hydration and is the only thing that makes the claim true.
  const claimed = resolveEntitlements({ plan: "free", isAdmin: false, adminMode: true });
  check(claimed.maxAgents === 3, "adminMode alone grants nothing — isAdmin is what the environment says");
  const dormant = resolveEntitlements({ plan: "free", isAdmin: true, adminMode: false });
  check(dormant.maxAgents === 3, "...and an admin who has not turned it on is an ordinary user");

  // Frozen, and a copy comes back, so a caller that mutates its answer cannot widen the constant
  // for every later caller in the process.
  const a = resolveEntitlements({ plan: "free", isAdmin: true, adminMode: true });
  a.maxAgents = 1;
  check(
    resolveEntitlements({ plan: "free", isAdmin: true, adminMode: true }).maxAgents === "unlimited",
    "the admin constant survives a caller mutating what it was handed",
  );

  check(
    ADMIN_ENTITLEMENTS.traceRetentionDays > 3650 && Number.isFinite(ADMIN_ENTITLEMENTS.traceRetentionDays),
    "admin retention is a century rather than Infinity — the sweeper multiplies this by a day",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe tier table says what the pricing says");
// ---------------------------------------------------------------------------------------------
{
  const free = entitlementsForPlan("free");
  check(free.maxAgents === 3, "free: three agents");
  check(free.maxWorkspaces === 1, "free: one workspace");
  check(free.maxMembers === 1, "free: solo");
  check(free.maxLiveDeployments === 1, "free: one live deployment");
  check(free.runsPerMonth === 500, "free: 500 runs a month");
  check(free.evalRunsPerMonth === 20, "free: 20 eval runs a month");
  check(free.maxMcpServers === 3, "free: three MCP servers");
  check(free.traceRetentionDays === 7 && free.auditRetentionDays === 7, "free: seven days of history");
  check(
    !free.githubPhase1 && !free.githubPhase2 && !free.perAgentAccessGrants &&
    !free.approvalBatchApprove && !free.policyEngine && !free.evalCiGate,
    "free: every gated feature is off",
  );

  const pro = entitlementsForPlan("pro");
  check(pro.maxAgents === "unlimited", "pro: agents are not counted");
  check(pro.maxWorkspaces === 3, "pro: three workspaces");
  check(pro.maxMembers === 1, "pro: still solo — Team is what collaboration costs");
  check(pro.maxLiveDeployments === 5, "pro: five live deployments");
  check(pro.runsPerMonth === 10_000, "pro: 10,000 runs a month");
  check(pro.evalRunsPerMonth === 500, "pro: 500 eval runs a month");
  check(pro.maxMcpServers === "unlimited", "pro: MCP servers are not counted");
  check(pro.traceRetentionDays === 90 && pro.auditRetentionDays === 90, "pro: ninety days of history");
  check(pro.githubPhase1 && !pro.githubPhase2, "pro: GitHub pushes, and does not read back");
  check(pro.approvalBatchApprove, "pro: batch approvals");
  check(!pro.perAgentAccessGrants, "pro: no per-agent grants, because there is nobody to grant to");
  check(!pro.evalCiGate, "pro: no CI gate — it fails a pull request, and that is phase two");
  check(!pro.policyEngine, "pro: no policy engine");

  const team = entitlementsForPlan("team");
  check(team.maxAgents === "unlimited" && team.maxWorkspaces === "unlimited", "team: agents and workspaces uncounted");
  check(team.maxMembers === 20, "team: twenty, and the twenty-first is a conversation");
  check(team.maxLiveDeployments === "unlimited", "team: deployments uncounted");
  check(team.runsPerMonth === 50_000, "team: 50,000 runs a month, pooled");
  check(team.evalRunsPerMonth === 2_500, "team: 2,500 eval runs a month, pooled");
  check(team.traceRetentionDays === 365 && team.auditRetentionDays === 365, "team: a year of history");
  check(
    team.githubPhase1 && team.githubPhase2 && team.perAgentAccessGrants &&
    team.approvalBatchApprove && team.policyEngine && team.evalCiGate,
    "team: every gated feature is on",
  );

  // The direction, on every axis that is a number, for the same reason `test:plans` asserts it
  // about credits and retention: the day somebody edits one plan and not the others is the day a
  // paid tier quietly has less than a free one.
  const rank = (v: number | "unlimited"): number => (v === "unlimited" ? Infinity : v);
  const tiers = PLAN_IDS.map((id) => entitlementsForPlan(id));
  for (const axis of ["maxAgents", "maxWorkspaces", "maxLiveDeployments", "runsPerMonth", "evalRunsPerMonth", "maxMcpServers"] as const) {
    check(
      rank(tiers[0]![axis]) <= rank(tiers[1]![axis]) && rank(tiers[1]![axis]) <= rank(tiers[2]![axis]),
      `${axis} never decreases as the tier rises`,
    );
  }
  check(
    tiers[0]!.traceRetentionDays <= tiers[1]!.traceRetentionDays &&
    tiers[1]!.traceRetentionDays <= tiers[2]!.traceRetentionDays,
    "traceRetentionDays never decreases as the tier rises",
  );
  // SEATS IS >=, NOT >, AND THAT IS THE PRICING RATHER THAN A WEAKENED ASSERTION. Pro is the
  // single-operator tier: one seat, the same as Free, because Team is what buying a second costs.
  // Written as its own assertion with its own reason so that nobody later reads the loop above and
  // concludes the direction rule was quietly relaxed for everything.
  check(
    PLANS.free.seats === 1 && PLANS.pro.seats === 1 && PLANS.team.seats === 20,
    "seats go 1, 1, 20 — Pro does not seat more people than Free, deliberately",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\na refusal names the figure, the limit and what would change it");
// ---------------------------------------------------------------------------------------------
{
  const ctx: TenantContext = systemContextFor("00000000-0000-4000-8000-000000000001", newRequestId()) as TenantContext;
  const counting = (n: number): EntitlementCounts => ({
    agents: async () => n,
    liveDeployments: async () => n,
    mcpServers: async () => n,
    members: async () => n,
    workspacesForUser: async () => n,
    usage: async () => n,
  });
  const refuse = async (kind: EntitlementKind, n: number, plan = "free") =>
    requireEntitlement(kind, ctx, plan, entitlementsForPlan(plan), counting(n));

  check((await refuse("canCreateAgent", 2)) === null, "a free workspace may create a third agent");
  const fourth = await refuse("canCreateAgent", 3);
  check(fourth?.error === "quota_exceeded", "...and is refused the fourth");
  check(
    fourth?.error === "quota_exceeded" && fourth.current === 3 && fourth.limit === 3 && fourth.tier === "free",
    "...with the figure, the limit and the tier in the body",
  );
  check(
    fourth?.upgradeUrl === "/billing/upgrade?to=pro&reason=agents",
    "...and an upgrade URL naming both the target tier and the reason",
  );

  check((await refuse("canStartRun", 499)) === null, "the 500th run of the month starts");
  check((await refuse("canStartRun", 500))?.error === "quota_exceeded", "...and the 501st does not");
  check((await refuse("canInviteMember", 1))?.error === "quota_exceeded", "a free workspace cannot invite anybody");
  check((await refuse("canInviteMember", 1, "pro"))?.error === "quota_exceeded", "...nor can a Pro one — Pro is solo");
  check((await refuse("canInviteMember", 5, "team")) === null, "a Team workspace can invite a sixth");
  check((await refuse("canInviteMember", 20, "team"))?.error === "quota_exceeded", "...and is stopped at twenty-one");

  const gh = await refuse("githubPhase1", 0);
  check(gh?.error === "feature_unavailable", "GitHub on free is a feature refusal");
  check(
    gh !== null && !("current" in gh),
    "...and carries no numbers — a feature is not zero of zero, and a meter reading 0/0 is worse than none",
  );
  check((await refuse("githubPhase1", 0, "pro")) === null, "...while Pro pushes");
  check((await refuse("githubPhase2", 0, "pro"))?.error === "feature_unavailable", "...and does not read back");
  check((await refuse("githubPhase2", 0, "team")) === null, "Team does both");

  // An unlimited tier never asks the counter. This runs in front of every run start, and a
  // `SELECT count(*)` on a workspace that could not be refused is a query bought with nothing.
  let asked = 0;
  const counted: EntitlementCounts = { ...counting(0), agents: async () => { asked++; return 0; } };
  await requireEntitlement("canCreateAgent", ctx, "pro", entitlementsForPlan("pro"), counted);
  check(asked === 0, "an unlimited limit does not count anything");
  await requireEntitlement("canCreateAgent", ctx, "free", entitlementsForPlan("free"), counted);
  check(asked === 1, "...and a bounded one counts exactly once");

  check(refusalMessage(fourth!).includes("3 of 3"), "the sentence carries the numbers");
  check(refusalMessage(fourth!).includes("stays exactly as it is"), "...and says the work is not going anywhere");
  check(refusalMessage(gh!).includes("nothing you have made changes"), "the feature sentence says the same thing");

  // -------------------------------------------------------------------------------------------
  // WHICH PLAN WOULD ACTUALLY LIFT IT, which is the one thing this card exists to say and which
  // it got wrong for three of the seven kinds a Free workspace can hit. The old rule was "free's
  // next step is Pro, a paid tier's is Team", written in `upgradeUrl` here and mirrored as
  // `nextTier` on the card, and it drove the sentence, the button label AND the URL. Every
  // assertion below is one of the three, or one of the four the heuristic got right — because a
  // lookup that only fixed the wrong answers by hard-coding them would pass the first three.
  // -------------------------------------------------------------------------------------------

  // The right answers, which must stay right.
  check(fourth?.unlocksLabel === "Pro", "a Free workspace out of agents is told Pro, which does raise it");
  check((await refuse("canStartRun", 500))?.unlocksLabel === "Pro", "...and out of runs, likewise");
  check((await refuse("canDeploy", 1))?.unlocksLabel === "Pro", "...and out of deployments");
  check(gh?.unlocksLabel === "Pro", "...and GitHub phase one really is a Pro feature");

  // THE THREE THAT WERE FALSE. Each of these read "Pro" and each leaves a Free workspace refused
  // identically after paying.
  const seats = await refuse("canInviteMember", 1);
  check(seats?.unlocksLabel === "Team", "a Free workspace inviting somebody is told TEAM, because Pro's seat count is also 1");
  check(
    (await refuse("githubPhase2", 0))?.unlocksLabel === "Team",
    "GitHub sync on Free is Team, not Pro — Pro's features have it false",
  );
  check(
    (await refuse("perAgentAccessGrants", 0))?.unlocksLabel === "Team",
    "per-agent access on Free is Team for the same reason",
  );

  // AND FROM PRO, where the heuristic happened to be right and the lookup must agree.
  check((await refuse("canInviteMember", 1, "pro"))?.unlocksLabel === "Team", "a Pro workspace inviting somebody is told Team");
  check((await refuse("githubPhase2", 0, "pro"))?.unlocksLabel === "Team", "...and for sync");

  // THE TOP OF THE LADDER ANSWERS NULL rather than naming itself. Team's twenty-first seat is the
  // Enterprise handoff, and "Team raises this limit" said to a Team workspace is a sentence that
  // sends somebody to buy what they already have.
  const capped = await refuse("canInviteMember", 20, "team");
  check(capped?.unlocks === null && capped.unlocksLabel === null, "a Team workspace at twenty seats is told no plan raises it");
  check(
    refusalMessage(capped!).includes("no plan raises it"),
    "...and the sentence says so rather than naming a tier",
  );

  // THE URL FOLLOWS THE SAME ANSWER, because it is the thing the button opens and a checkout for
  // the wrong plan is the expensive half of this bug.
  check(seats?.upgradeUrl === "/billing/upgrade?to=team&reason=members", "the URL targets the plan that works, not the next one up");
  check(capped?.upgradeUrl === "/billing/upgrade?reason=members", "...and names no target when none would work");

  // THE LOOKUP ITSELF, against the two shapes the comparison has to tell apart. A `>=` here is
  // what would recommend Pro for a seat, since Pro's count EQUALS Free's.
  check(unlockingTier("githubPhase2", "free") === "team", "unlockingTier reads a flag");
  check(unlockingTier("maxMembers", "free") === "team", "...and a number, strictly");
  check(unlockingTier("maxAgents", "free") === "pro", "...and treats becoming unlimited as an increase");
  check(unlockingTier("maxAgents", "pro") === null, "...while already-unlimited cannot be improved on");
  check(unlockingTier("policyEngine", "free") === "team", "a flag no surface gates still resolves from the table");
  check(unlockingTier("maxAgents", "enterprise") === "pro", "an unrecognised tier searches from the bottom rather than answering null");
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe metric names are the ones 052 counts under");
// ---------------------------------------------------------------------------------------------
{
  check(USAGE_METRICS.includes("runs") && USAGE_METRICS.includes("eval_runs"), "runs and eval_runs are metrics");
  check(USAGE_METRICS.length === 5, "five dimensions, matching the specification's list");
  // 052 deliberately put no CHECK constraint on `metric`, so this list IS the closed set. If the
  // migration ever grows one, these two have to agree, and this is where that is noticed.
  const migration = readFileSync(join(here, "..", "..", "migrations", "postgres", "052_subscription_tiers.sql"), "utf8");
  // COMMENTS STRIPPED FIRST. The migration's own header argues at length about why there is no
  // CHECK here, and quotes the constraint it is declining to write — so a regex over the raw file
  // matches that prose and fails on a migration that is exactly right. The claim is about the DDL.
  const ddl = migration.replace(/^\s*--.*$/gm, "");
  check(
    !/CHECK\s*\(\s*metric/i.test(ddl),
    "the migration constrains `metric` in code rather than in schema, so a new dimension is a constant",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nwithin() is the one comparison");
// ---------------------------------------------------------------------------------------------
{
  check(within(0, 1) && !within(1, 1) && !within(2, 1), "a limit of one admits one and refuses the second");
  check(within(Number.MAX_SAFE_INTEGER, "unlimited"), "unlimited admits anything");
  check(!within(0, 0), "a limit of zero admits nothing — which is what an abuse clamp sets");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

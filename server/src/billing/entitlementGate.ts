// The refusal side of an entitlement: what is checked, against what count, and what a refusal says.
//
// `entitlements.ts` answers "what may this workspace have". This answers "may it have one more",
// which is a different question with a database in it — a limit is a number and the thing it bounds
// has to be counted before anybody can be told no.
//
// THE SPECIFICATION ASSUMES EXPRESS AND THIS SERVER IS NOT EXPRESS. `router.post('/agents',
// requireEntitlement({ kind: 'canCreateAgent' }), handler)` describes a system where the quota-
// relevant actions are HTTP routes. Here they are not: the HTTP surface answers authentication,
// billing, secrets, GitHub callbacks and workspace lifecycle, and every action a tier bounds —
// generating an agent, starting a run, deploying, connecting an MCP server — arrives as a
// WebSocket command. So the middleware's real analogue is `COMMAND_ENTITLEMENT` below, applied at
// the same point in `wsRelay.authorized` where `COMMAND_CAPABILITY` already is, and the HTTP form
// exists for the two things that genuinely are routes.
//
// UNCLASSIFIED IS A BUILD FAILURE, NOT A DEFAULT. This is the same decision `COMMAND_CAPABILITY`
// made and it is worth restating because the safe default points the other way here: an
// unclassified capability is refused, but an unclassified ENTITLEMENT cannot be, because most
// commands legitimately have no tier dimension and refusing them all would be an outage. So
// "no entitlement applies" is spelled `"none"` and written down, and `test:entitlements` fails on
// a command that has neither a check nor that word. The failure mode being prevented is the one
// that actually happens: somebody adds `createSomething` a year from now, it is not in this table,
// and it is unlimited on every tier forever with nothing anywhere saying so.
//
// TWO REFUSAL SHAPES, AND THE SECOND IS NOT IN THE SPECIFICATION. §5.2 gives one body, for a
// quota: `current`, `limit`, and a `kind` like `runs_per_month`. A FEATURE gate has neither number
// — "GitHub is not on Free" is not 0 of 0 — and filling them with zeroes would render in the
// upsell card as a meter reading "0 of 0 used", which is worse than no meter. So a feature refusal
// says `feature_unavailable` and carries no numbers, and the card branches on which it got.

import type { TenantContext } from "../db/tenant.ts";
import type { Limit, TierEntitlements } from "./entitlements.ts";

/**
 * The checks that exist, and the four that are declared with nothing yet to check.
 *
 * `perAgentAccessGrants`, `approvalBatchApprove`, `policyEngine` and `evalCiGate` are tier flags in
 * `TierEntitlements` because the pricing sells them, and they appear in no row of the table below
 * because the surfaces they gate — the Access tab, the Approval System, the Policy Engine, an eval
 * that can fail a pull request — are other specifications and are not built. Declaring them now and
 * wiring them when the surface lands is the right order: the alternative is inventing a command to
 * hang them on, which is how `bulkInboxAction` would have quietly become "batch approvals" and put
 * a shipped Inbox feature behind Pro on the strength of a similar-sounding name.
 */
export type EntitlementKind =
  | "canCreateAgent"
  | "canStartRun"
  | "canStartEvalRun"
  | "canDeploy"
  | "canConnectMcpServer"
  | "canInviteMember"
  | "canCreateWorkspace"
  | "githubPhase1"
  | "githubPhase2";

/** The word for "this command has no tier dimension", written rather than implied. */
export const NO_ENTITLEMENT = "none" as const;

/**
 * Which entitlement each WebSocket command needs, or `none`.
 *
 * Grouped by why rather than alphabetically, because the interesting question about this table is
 * never "where is X" — it is "why is X not gated", and the answer has to be next to it.
 */
export const COMMAND_ENTITLEMENT: Record<string, EntitlementKind | typeof NO_ENTITLEMENT> = {
  // --- the counted things ---------------------------------------------------------------------

  // Generating and forking both END with an agent that did not exist, which is what `maxAgents`
  // counts. `edit`, `applyEdit` and `restoreAgentVersion` publish a new VERSION of an agent that
  // already exists and are deliberately not here: version history is explicitly never truncated by
  // tier — the agent's code is the user's — so a limit on editing would be a limit on the product.
  generate: "canCreateAgent",
  forkAgent: "canCreateAgent",

  // A run is counted where its status first becomes `running`, so both doors to that state are
  // gated and no other command is. `resumeRun` is NOT one: a paused run was already counted when
  // it started, and counting it again would mean pausing to think costs a run.
  run: "canStartRun",
  branchRun: "canStartRun",

  // Eval runs are counted per dataset CASE rather than per batch — a batch over a hundred cases is
  // a hundred — which is decided at dispatch rather than here. This gates the dispatch.
  startEval: "canStartEvalRun",
  // Estimating is reading a price list. Gating it would mean a workspace at its limit could not
  // find out what going over would cost, which is the moment it most wants to know.
  estimateEval: NO_ENTITLEMENT,

  deploy: "canDeploy",
  // Planning a deployment renders what WOULD happen. Same argument as the eval estimate.
  planDeploy: NO_ENTITLEMENT,
  // Cancelling and forgetting REDUCE what is live. A workspace over its limit after a downgrade has
  // to be able to get under it, and a gate here would be a trap that only an upgrade opens.
  cancelDeploy: NO_ENTITLEMENT,
  forgetDeployment: NO_ENTITLEMENT,

  addMcpServer: "canConnectMcpServer",
  // Same argument as cancelDeploy: removing is how somebody gets back under a limit.
  removeMcpServer: NO_ENTITLEMENT,

  inviteMember: "canInviteMember",
  removeMember: NO_ENTITLEMENT,

  // --- the feature gates ---------------------------------------------------------------------
  //
  // PHASE ONE IS THE OUTBOUND HALF and phase two is everything that reads a repository back. The
  // split is not by noun — several of these touch the same repository — but by which direction the
  // authority points: pushing is this workspace writing to a repo it owns, and pulling, opening a
  // pull request, running against somebody's branch or answering a review comment is Jaroku acting
  // on a repository's behalf, continuously, while nobody is watching.
  linkGithub: "githubPhase1",
  pushGithub: "githubPhase1",
  commitGithub: "githubPhase1",
  createGithubBranch: "githubPhase1",
  switchGithubBranch: "githubPhase1",
  generateGithubMessage: "githubPhase1",

  pullGithub: "githubPhase2",
  openGithubPr: "githubPhase2",
  shadowRunGithub: "githubPhase2",
  resolveReviewComment: "githubPhase2",
  setAgentCiConfig: "githubPhase2",

  // The GitHub reads, and `unlinkGithub`, all deliberately open. A workspace that downgrades keeps
  // its link and its history — the specification's second principle is that a downgrade gates
  // features off and never destroys data — so it has to be able to LOOK at what it has and to
  // disconnect it. A gate on unlink would be a workspace unable to remove a connection it is no
  // longer entitled to, which is the worst of both.
  listGithub: NO_ENTITLEMENT,
  listGithubRepos: NO_ENTITLEMENT,
  checkGithubRepo: NO_ENTITLEMENT,
  refreshGithub: NO_ENTITLEMENT,
  unlinkGithub: NO_ENTITLEMENT,
  semanticDiffGithub: NO_ENTITLEMENT,
  listScanFindings: NO_ENTITLEMENT,
  listShadowRuns: NO_ENTITLEMENT,

  // --- everything else -------------------------------------------------------------------------
  //
  // Reads, and writes with no tier dimension. Listed one per line rather than swept up by a default
  // for the reason the file header gives: a default is what makes the command added next year
  // unlimited on every tier with nothing saying so.
  loadRun: NO_ENTITLEMENT,
  loadHistory: NO_ENTITLEMENT,
  listAgents: NO_ENTITLEMENT,
  listAgentGrid: NO_ENTITLEMENT,
  loadAgentDetail: NO_ENTITLEMENT,
  loadAgentFiles: NO_ENTITLEMENT,
  loadAgentGraph: NO_ENTITLEMENT,
  loadAgentVersion: NO_ENTITLEMENT,
  explain: NO_ENTITLEMENT,
  diagnoseFile: NO_ENTITLEMENT,
  planAgent: NO_ENTITLEMENT,
  discardPlan: NO_ENTITLEMENT,
  edit: NO_ENTITLEMENT,
  applyEdit: NO_ENTITLEMENT,
  undoEdit: NO_ENTITLEMENT,
  discardEdit: NO_ENTITLEMENT,
  archiveAgent: NO_ENTITLEMENT,
  restoreAgent: NO_ENTITLEMENT,
  renameAgent: NO_ENTITLEMENT,
  restoreAgentVersion: NO_ENTITLEMENT,
  pauseRun: NO_ENTITLEMENT,
  resumeRun: NO_ENTITLEMENT,
  cancelRun: NO_ENTITLEMENT,
  promoteTestInput: NO_ENTITLEMENT,
  createDataset: NO_ENTITLEMENT,
  renameDataset: NO_ENTITLEMENT,
  deleteDataset: NO_ENTITLEMENT,
  listDatasets: NO_ENTITLEMENT,
  loadDataset: NO_ENTITLEMENT,
  addExample: NO_ENTITLEMENT,
  updateExample: NO_ENTITLEMENT,
  deleteExample: NO_ENTITLEMENT,
  saveRubric: NO_ENTITLEMENT,
  loadRubric: NO_ENTITLEMENT,
  listEvals: NO_ENTITLEMENT,
  loadEvalResults: NO_ENTITLEMENT,
  cancelEval: NO_ENTITLEMENT,
  listMcpServers: NO_ENTITLEMENT,
  rediscoverMcpServer: NO_ENTITLEMENT,
  setMcpServerAuth: NO_ENTITLEMENT,
  setMcpToolImpact: NO_ENTITLEMENT,
  resolveMcpConfirm: NO_ENTITLEMENT,
  listConnections: NO_ENTITLEMENT,
  connectConnector: NO_ENTITLEMENT,
  disconnectConnector: NO_ENTITLEMENT,
  listProviders: NO_ENTITLEMENT,
  listDeployments: NO_ENTITLEMENT,
  loadDeployLogs: NO_ENTITLEMENT,
  setRailwayToken: NO_ENTITLEMENT,
  testRailwayToken: NO_ENTITLEMENT,
  listMembers: NO_ENTITLEMENT,
  setMemberRole: NO_ENTITLEMENT,
  revokeInvite: NO_ENTITLEMENT,
  listAudit: NO_ENTITLEMENT,
  loadUsage: NO_ENTITLEMENT,
  setSpendCeiling: NO_ENTITLEMENT,
  // CHOOSING TO PAY FOR YOUR OWN INFERENCE IS NEVER GATED. A workspace turning BYOK on is asking to
  // stop spending our money, and a tier check in front of that would be refusing somebody the right
  // to cost us less. Turning it OFF is bounded by the platform-key gate at run time, where the
  // question is actually about our money, rather than here.
  setByok: NO_ENTITLEMENT,
  setOwnKeyForPlatform: NO_ENTITLEMENT,
  loadEnforcement: NO_ENTITLEMENT,
  appealEnforcement: NO_ENTITLEMENT,
  listThreads: NO_ENTITLEMENT,
  loadThread: NO_ENTITLEMENT,
  createThread: NO_ENTITLEMENT,
  renameThread: NO_ENTITLEMENT,
  archiveThread: NO_ENTITLEMENT,
  restoreThread: NO_ENTITLEMENT,
  listInbox: NO_ENTITLEMENT,
  dismissInboxItem: NO_ENTITLEMENT,
  snoozeInboxItem: NO_ENTITLEMENT,
  resolveInboxItem: NO_ENTITLEMENT,
  undoInboxAction: NO_ENTITLEMENT,
  // Acting on several Inbox cards at once, and NOT the "batch approvals" the pricing sells. That
  // is the Approval System's surface and it does not exist here — see `EntitlementKind`.
  bulkInboxAction: NO_ENTITLEMENT,
  getActivity: NO_ENTITLEMENT,
  getActivityFeed: NO_ENTITLEMENT,
};

/** The entitlement a command needs, or undefined when nobody has decided. Guards `__proto__`. */
export function entitlementFor(cmd: string): EntitlementKind | typeof NO_ENTITLEMENT | undefined {
  return Object.prototype.hasOwnProperty.call(COMMAND_ENTITLEMENT, cmd)
    ? COMMAND_ENTITLEMENT[cmd]
    : undefined;
}

// --- refusals ---------------------------------------------------------------------------------

/** The metric names `workspace_usage_periods` counts under. A closed set, in code — see 052. */
export const USAGE_METRICS = [
  "runs",
  "eval_runs",
  "inference_tokens_in",
  "inference_tokens_out",
  "inference_cost_usd",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export interface QuotaRefusal {
  error: "quota_exceeded";
  /** Snake case, because it names the LIMIT rather than the check — `runs_per_month`, not `canStartRun`. */
  kind: string;
  current: number;
  limit: number;
  tier: string;
  upgradeUrl: string;
}

export interface FeatureRefusal {
  error: "feature_unavailable";
  kind: string;
  tier: string;
  upgradeUrl: string;
}

export type EntitlementRefusal = QuotaRefusal | FeatureRefusal;

/** Where an upsell sends somebody, with the reason attached so the target can say it back. */
function upgradeUrl(reason: string, tier: string): string {
  // Free's next step is Pro and a paid tier's is Team. Naming the target rather than making the
  // billing page guess means the upgrade screen opens on the right comparison.
  const to = tier === "free" ? "pro" : "team";
  return `/billing/upgrade?to=${to}&reason=${reason}`;
}

/** What each check bounds: the limit to read, the metric or count to compare, and its public name. */
const QUOTA_CHECKS: Record<string, { limit: keyof TierEntitlements; name: string }> = {
  canCreateAgent: { limit: "maxAgents", name: "agents" },
  canStartRun: { limit: "runsPerMonth", name: "runs_per_month" },
  canStartEvalRun: { limit: "evalRunsPerMonth", name: "eval_runs_per_month" },
  canDeploy: { limit: "maxLiveDeployments", name: "live_deployments" },
  canConnectMcpServer: { limit: "maxMcpServers", name: "mcp_servers" },
  canInviteMember: { limit: "maxMembers", name: "members" },
  canCreateWorkspace: { limit: "maxWorkspaces", name: "workspaces" },
};

/** The boolean gates, and the flag each reads. */
const FEATURE_CHECKS: Record<string, keyof TierEntitlements> = {
  githubPhase1: "githubPhase1",
  githubPhase2: "githubPhase2",
};

/**
 * How many of the counted thing this workspace already has.
 *
 * An interface rather than a repository, so this file imports no database and the relay that calls
 * it imports none either — `test:db-boundary` is what makes that a rule rather than a habit.
 * `index.ts` supplies the implementation, where the stores already are.
 */
export interface EntitlementCounts {
  agents(ctx: TenantContext): Promise<number>;
  liveDeployments(ctx: TenantContext): Promise<number>;
  mcpServers(ctx: TenantContext): Promise<number>;
  members(ctx: TenantContext): Promise<number>;
  /** Workspaces this USER belongs to — the one limit not scoped to the workspace being acted in. */
  workspacesForUser(ctx: TenantContext): Promise<number>;
  /** A counter from `workspace_usage_periods` for the current calendar month. */
  usage(ctx: TenantContext, metric: UsageMetric): Promise<number>;
}

async function currentFor(
  check: EntitlementKind,
  ctx: TenantContext,
  counts: EntitlementCounts,
): Promise<number> {
  switch (check) {
    case "canCreateAgent": return counts.agents(ctx);
    case "canDeploy": return counts.liveDeployments(ctx);
    case "canConnectMcpServer": return counts.mcpServers(ctx);
    case "canInviteMember": return counts.members(ctx);
    case "canCreateWorkspace": return counts.workspacesForUser(ctx);
    case "canStartRun": return counts.usage(ctx, "runs");
    case "canStartEvalRun": return counts.usage(ctx, "eval_runs");
    default: return 0;
  }
}

/**
 * May this workspace do one more of this? `null` when yes, a refusal when no.
 *
 * NULL FOR YES rather than a boolean, because the caller needs the refusal's contents and a
 * boolean would mean building them twice — once to decide and once to send. The same shape
 * `BudgetGate.mayStart` already returns for the same reason.
 *
 * THE COUNT IS READ ONLY WHEN A LIMIT EXISTS. An unlimited tier never queries, which matters
 * because this runs in front of every run start: a `SELECT count(*)` per run on a workspace that
 * could never be refused is a query bought with nothing.
 */
export async function requireEntitlement(
  check: EntitlementKind,
  ctx: TenantContext,
  tier: string,
  entitlements: TierEntitlements,
  counts: EntitlementCounts,
): Promise<EntitlementRefusal | null> {
  const feature = FEATURE_CHECKS[check];
  if (feature) {
    if (entitlements[feature] === true) return null;
    return { error: "feature_unavailable", kind: feature, tier, upgradeUrl: upgradeUrl(feature, tier) };
  }

  const quota = QUOTA_CHECKS[check];
  if (!quota) return null;
  const cap = entitlements[quota.limit] as Limit;
  if (cap === "unlimited") return null;

  const current = await currentFor(check, ctx, counts);
  if (current < cap) return null;
  return {
    error: "quota_exceeded",
    kind: quota.name,
    current,
    limit: cap,
    tier,
    upgradeUrl: upgradeUrl(quota.name, tier),
  };
}

/**
 * A refusal as a sentence somebody reads, for the channel that has no card to render.
 *
 * Every string here names the figure, the limit and what would change it, which is the same rule
 * `billing/gate.ts` writes its refusals under: "quota exceeded" sends somebody to a dashboard to
 * work out what happened, and naming the number means the message IS the answer.
 */
export function refusalMessage(r: EntitlementRefusal): string {
  if (r.error === "feature_unavailable") {
    return `that is not part of the ${r.tier} plan — upgrading turns it on, and nothing you have made changes`;
  }
  return `${r.current} of ${r.limit} ${r.kind.replace(/_/g, " ")} used on the ${r.tier} plan — upgrading raises it, and everything you have made stays exactly as it is`;
}

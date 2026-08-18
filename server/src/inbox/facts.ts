// One aggregate pass over one workspace, and everything every predicate is allowed to ask about.
//
// §6.2 REQUIRES THE SWEEP TO BE CHEAP: "One aggregate pass per workspace, not one query per agent.
// Test that its query count is constant in the number of agents." That is only achievable if the
// predicates cannot reach a database, which is why they take a value rather than an interface — and
// this is the function that builds it. Everything below is a read bounded by the workspace and
// grouped or keyed in the database; the joining is Map lookups.
//
// EIGHT READS AND NOT ONE PER AGENT, which is the same shape and the same argument
// `agentGridSnapshot` makes. The naive version walks the agent list asking five questions per row,
// which is 5N round trips on a path that holds a cross-replica lock — invisible at three agents and
// the whole cost of the sweep at forty.
//
// EVERY DEPENDENCY IS INJECTED, and not because this file is fastidious. The facts come from the
// secret refs, the agent repository, the MCP registry, the deploy store, the billing ledger and the
// identity repository — six subsystems, and importing all six here would make the reconciler's
// module graph most of the server. Injected, it is also drivable by a suite with six small stubs.
//
// WHAT IS DELIBERATELY NOT HERE: a secret value, a fragment of one, or its length. §6.5 is explicit
// that a credential item carries the NAME of the missing credential, and the cheapest way to keep
// that true is for `configuredSecrets` to be a set of names — there is no shape in `InboxFacts` a
// value could travel in.

import { driftOf } from "../agentHealth.ts";
import type { TenantContext } from "../db/tenant.ts";
import { COST_ANOMALY_MULTIPLE, type AgentInboxFacts, type InboxFacts, type McpInboxFacts } from "./registry.ts";

/**
 * How far back the anomaly rule looks for "usual".
 *
 * SEVEN DAYS, which is §2.2's own words — "3× its trailing 7-day rolling average" — and the same
 * window the Agents grid computes its activity level and 7-day spend over. One window, read once, so
 * a card that says an agent is spending four times its usual and a grid that says it spent $12 this
 * week are talking about the same seven days.
 */
export const ANOMALY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The reads this needs, each one already existing somewhere in the server. */
export interface FactDeps {
  /** Every credential name declared in this workspace, and whether a value is actually behind it. */
  secretRefs: (ctx: TenantContext) => Promise<readonly { name: string; configured: boolean; kind?: string }[]>;
  /** Every agent, archived included — an archived agent's problems are still this workspace's. */
  agents: (ctx: TenantContext) => Promise<
    readonly {
      id: string;
      slug: string;
      display_name: string | null;
      required_env: readonly string[];
      mcp_tools: readonly string[];
      current_version: number;
      archived_at: string | null;
    }[]
  >;
  /** The most recent deployment per agent SLUG, whatever became of it. */
  deployments: (ctx: TenantContext) => Promise<
    ReadonlyMap<
      string,
      {
        status: string;
        version: number | null;
        updated_at: string;
        ended_at: string | null;
        /**
         * What the last deploy of this agent used.
         *
         * HERE SO THE DRIFT CARD CAN CARRY IT, which is what makes §4.5's inline redeploy possible
         * rather than a navigation. "Redeploy" honestly means "put the current version out the way
         * this agent was already put out", and the only place that answer exists is the deployment
         * row — a card that guessed a provider would be a second, weaker way to put something on the
         * internet.
         *
         * NAMES ONLY. `env_keys` is the list of variable NAMES the host was handed, and there is no
         * column on `deployments` that could hold a value.
         */
        provider: string;
        model: string;
        env_keys: readonly string[];
      }
    >
  >;
  /** Every MCP server this workspace has connected. */
  mcpServers: (ctx: TenantContext) => Promise<
    readonly { id: string; label: string; server_name: string | null; status: string; discovered_at: string | null; created_at: string }[]
  >;
  /** Every tool the registry knows, so a grant can be classified without a lookup per ref. */
  mcpTools: (ctx: TenantContext) => Promise<readonly { server_id: string; name: string; impact: string }[]>;
  /** Spend per agent slug over a window, with whether every call in it was priced. */
  spend: (
    ctx: TenantContext,
    since: string,
  ) => Promise<readonly { agentId: string | null; usd: number; costKnown: boolean }[]>;
  /** The workspace's own ceiling, or null for "whatever the plan says". */
  spendCeiling: (ctx: TenantContext) => Promise<number | null>;
  /** Invitations that have neither been accepted, revoked nor expired. */
  invites: (ctx: TenantContext) => Promise<readonly { id: string; accepted_at: string | null; revoked_at: string | null; expires_at: string }[]>;
  /** Who is in the workspace, by user id. */
  members: (ctx: TenantContext) => Promise<readonly { user_id: string }[]>;
  /** Whether this is a Team workspace. §2.4's three types are hidden entirely in Personal. */
  isTeam: (ctx: TenantContext) => Promise<boolean>;
  /**
   * Agents whose confirmation gate is DISABLED, by uuid.
   *
   * INJECTED AND DEFAULTING TO NONE, because answering it honestly costs a read of an agent's own
   * code and there is no column that could hold it. v0.2.1 recorded the gap plainly: generated agent
   * code can set the environment variable that turns the bridge's high-impact gate off, and nothing
   * in this schema records that it did. The derived generator supplies this, bounded to the agents
   * that hold a high-impact grant at all — which in most workspaces is none of them, so the scan is
   * skipped entirely rather than run per agent.
   *
   * ABSENT MEANS EVERY GATE IS ON, which is the safe direction for a fact used only to RAISE an
   * item: a missing answer produces no card rather than a card about an agent that is fine.
   */
  gatesDisabled?: (
    ctx: TenantContext,
    candidates: readonly { id: string; slug: string }[],
  ) => Promise<ReadonlySet<string>>;
}

/**
 * Gather everything one sweep of one workspace needs.
 *
 * SCOPED, LIKE EVERY OTHER READ IN THIS FEATURE. It takes a `TenantContext` and hands it to each
 * dependency, so the pass that §6.3 calls the highest-risk code in the feature cannot answer for a
 * workspace it was not asked about — there is no call below that could.
 */
export async function inboxFacts(deps: FactDeps, ctx: TenantContext, now: number = Date.now()): Promise<InboxFacts> {
  const since = new Date(now - ANOMALY_WINDOW_MS).toISOString();

  const [refs, agents, deployments, servers, tools, spend, ceiling, invites, members, team] = await Promise.all([
    deps.secretRefs(ctx),
    deps.agents(ctx),
    deps.deployments(ctx),
    deps.mcpServers(ctx),
    deps.mcpTools(ctx),
    deps.spend(ctx, since),
    deps.spendCeiling(ctx),
    deps.invites(ctx),
    deps.members(ctx),
    deps.isTeam(ctx),
  ]);

  // `configured` IS THE TEST, NOT EXISTENCE — the same rule `missingCredentials` states. A row exists
  // for every name any agent has ever DECLARED, with the flag false until a value landed in the
  // vault, so a membership test against the table would report every declared credential as present.
  const configuredSecrets = new Set(refs.filter((r) => r.configured).map((r) => r.name));

  // §2.5's `setup_api_key` waits on this and nothing else. A provider key is the one credential a
  // workspace cannot build anything without.
  const hasProviderKey = refs.some((r) => r.configured && r.kind === "provider_key");

  const impactByRef = new Map(tools.map((t) => [`${t.server_id}/${t.name}`, t.impact]));
  const spendBySlug = new Map(spend.map((s) => [s.agentId ?? "", s]));

  // THE TRAILING AVERAGE, FROM THE SAME WINDOW. §2.2 compares spend against "its trailing 7-day
  // rolling average", and with one window in hand the honest reading is the window's own daily mean:
  // an agent that spent $70 over seven days averages $10, and $40 today is four times usual. A second
  // query for a second window would buy a more precise baseline at the cost of the "one aggregate
  // pass" this whole file exists to keep.
  const DAYS = ANOMALY_WINDOW_MS / 86_400_000;

  const agentFacts = new Map<string, AgentInboxFacts>();
  const highImpactHolders: { id: string; slug: string }[] = [];
  for (const a of agents) {
    const deployment = deployments.get(a.slug);
    // DRIFT IS ONLY A FACT ABOUT SOMETHING THAT IS SERVING, which the Agents grid learned the hard
    // way: a deploy that FAILED still carries the version it meant to build, and computing drift off
    // it put `v2 → v9` on a card with nothing deployed at all.
    const live = deployment?.status === "live" ? deployment : null;
    const money = spendBySlug.get(a.slug);
    const highImpactTools = a.mcp_tools.filter((ref) => impactByRef.get(ref) === "high");
    if (highImpactTools.length > 0) highImpactHolders.push({ id: a.id, slug: a.slug });

    agentFacts.set(a.id, {
      uuid: a.id,
      slug: a.slug,
      name: a.display_name ?? a.slug,
      requiredEnv: a.required_env,
      currentVersion: a.current_version,
      deployedVersion: live ? (driftOf(live.version, a.current_version)?.deployed ?? live.version) : null,
      // When the thing that is serving started serving. `ended_at` is what a finished deploy wrote;
      // `updated_at` covers one still reporting. A failed deploy's card is resolved by a LATER
      // success, so this timestamp is the comparison and a wrong one would resolve it early.
      liveDeployAt: live ? (live.ended_at ?? live.updated_at) : null,
      // FROM THE LAST DEPLOY WHATEVER BECAME OF IT, not only from a live one: `retry_deploy` is on a
      // card about a deploy that FAILED, and the configuration it failed with is exactly what a
      // retry should use.
      lastDeploy: deployment
        ? { provider: deployment.provider, model: deployment.model, envKeys: deployment.env_keys }
        : null,
      highImpactTools,
      // Filled in below for the agents that could possibly qualify. See `gatesDisabled`.
      confirmGateEnabled: true,
      spendUsd: money ? money.usd : null,
      // NULL RATHER THAN ZERO for an agent that has spent nothing, and the distinction is the one
      // v0.1.9 made permanent: unknown is not zero. An agent with no spend has no average to be
      // three times of, and treating its baseline as $0 would make every first call an anomaly.
      trailingAvgUsd: money && money.usd > 0 ? money.usd / DAYS : null,
      // AN AGENT WHOSE MODEL HAS NO PRICING IS EXCLUDED FROM ANOMALY DETECTION ENTIRELY. v0.1.9
      // fixed the lie that unpriced means free, and §2.2 says in as many words that it does not come
      // back through this door: such an agent must never appear as a $0 baseline that everything
      // spikes against.
      pricingKnown: money ? money.costKnown : true,
      archivedAt: a.archived_at,
    });
  }

  // ONLY THE AGENTS THAT COULD QUALIFY, which is what keeps this from being the per-agent query the
  // rest of the file exists to avoid. An agent holding no high-impact grant cannot raise
  // `ungated_high_impact` however its gate is set, so asking about it would be a read whose answer
  // changes nothing.
  if (deps.gatesDisabled && highImpactHolders.length > 0) {
    const disabled = await deps.gatesDisabled(ctx, highImpactHolders);
    for (const uuid of disabled) {
      const fact = agentFacts.get(uuid);
      if (fact) agentFacts.set(uuid, { ...fact, confirmGateEnabled: false });
    }
  }

  const mcpServers = new Map<string, McpInboxFacts>(
    servers.map((s) => [
      s.id,
      {
        id: s.id,
        name: s.server_name || s.label || s.id,
        status: s.status as McpInboxFacts["status"],
        // WHEN IT LAST WORKED, which is what "unreachable for over 24 hours" is actually measured
        // from. There is no status-changed column on `mcp_servers` and adding one would be a second
        // copy of a fact `discovered_at` already implies: a successful handshake is the only thing
        // that writes it, so a server whose last handshake was three days ago has not worked for
        // three days whatever its status column says. `created_at` covers one that never worked.
        statusSince: s.discovered_at ?? s.created_at,
      },
    ]),
  );

  return {
    now,
    configuredSecrets,
    agents: agentFacts,
    mcpServers,
    spendCeilingUsd: ceiling,
    // NEITHER ACCEPTED, REVOKED NOR EXPIRED. §2.4's item resolves when an invitation stops being
    // pending, and expiry is the case a predicate written as "accepted" would miss — it is also the
    // common one.
    pendingInvites: new Set(
      invites
        .filter((i) => !i.accepted_at && !i.revoked_at && Date.parse(i.expires_at) > now)
        .map((i) => i.id),
    ),
    memberIds: new Set(members.map((m) => m.user_id)),
    hasProviderKey,
    // ARCHIVED ONES COUNT. Somebody who built an agent and put it away has started, and asking them
    // to build their first one again would be the product forgetting what they did.
    agentCount: agents.length,
    team,
  };
}

/**
 * Is this agent's spend an anomaly, and by how much?
 *
 * HERE RATHER THAN IN THE REGISTRY, because it is the TRIGGER and not the resolve condition. The
 * predicate asks whether spend has been normal for 48 hours; this asks whether it is abnormal right
 * now, and the derived generator is what turns the second into a row.
 *
 * NULL FOR AN AGENT THAT IS EXCLUDED, and there are three ways to be: no spend at all, no baseline
 * to compare against, and — the one §2.2 insists on — a model with no pricing entry. All three
 * answer "there is nothing to say", which is different from "it is fine".
 */
export function costMultiple(agent: AgentInboxFacts): number | null {
  if (!agent.pricingKnown) return null;
  if (agent.spendUsd === null || agent.trailingAvgUsd === null || agent.trailingAvgUsd <= 0) return null;
  return agent.spendUsd / agent.trailingAvgUsd;
}

/** True when this agent's spend crosses §2.2's multiple. See `costMultiple` for the exclusions. */
export function isCostAnomaly(agent: AgentInboxFacts): boolean {
  const multiple = costMultiple(agent);
  return multiple !== null && multiple >= COST_ANOMALY_MULTIPLE;
}

// The item-type registry, as claims about the vocabulary and about every predicate in it.
//
// PURE, AND THEREFORE THE SUITE THAT CAN COVER ALL SIXTEEN. §9 asks for every item type's resolve
// condition to be tested by actually resolving it externally — setting the credential somewhere else
// and asserting the item disappears without a dismissal — and the half of that which is a decision
// rather than a database lives here: given facts in which the problem is fixed, does the predicate
// say so. The other half, that the sweep then actually removes the row, is `reconciler.test.ts`.
//
// EVERY TYPE IS EXERCISED IN BOTH DIRECTIONS, and the second direction is the one that catches the
// real bug. A predicate that returns `true` unconditionally passes any test that only checks the
// resolved case, and the item type it belongs to then silently never appears on the board.
//
//   npm run test:inbox-registry

import {
  COST_NORMAL_FOR_MS,
  INBOX_TYPES,
  TEAM_NOTICE_TTL_MS,
  dedupeKey,
  inboxType,
  isInboxItemType,
  isResolved,
  type AgentInboxFacts,
  type InboxFacts,
  type InboxItemFacts,
  type InboxItemType,
  type InboxPayload,
  type McpInboxFacts,
} from "./registry.ts";

let failures = 0;
const check = (name: string, ok: boolean): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`);
  }
};

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function agent(over: Partial<AgentInboxFacts> = {}): AgentInboxFacts {
  return {
    uuid: "agent-1",
    slug: "api_gateway",
    name: "API Gateway",
    requiredEnv: ["STRIPE_KEY"],
    currentVersion: 9,
    deployedVersion: null,
    liveDeployAt: null,
    highImpactTools: [],
    confirmGateEnabled: true,
    spendUsd: null,
    trailingAvgUsd: null,
    pricingKnown: true,
    archivedAt: null,
    ...over,
  };
}

function server(over: Partial<McpInboxFacts> = {}): McpInboxFacts {
  return { id: "mcp-1", name: "linear", status: "connected", statusSince: ago(2 * DAY), ...over };
}

function facts(over: Partial<InboxFacts> = {}): InboxFacts {
  return {
    now: NOW,
    configuredSecrets: new Set<string>(),
    agents: new Map([["agent-1", agent()]]),
    mcpServers: new Map([["mcp-1", server()]]),
    spendCeilingUsd: null,
    pendingInvites: new Set<string>(),
    memberIds: new Set<string>(["user-1"]),
    hasProviderKey: false,
    agentCount: 1,
    team: true,
    ...over,
  };
}

function item(type: InboxItemType, over: Partial<InboxItemFacts> = {}): InboxItemFacts {
  return {
    type,
    subject_id: null,
    payload: {} as InboxPayload,
    first_seen_at: ago(HOUR),
    last_seen_at: ago(HOUR),
    ...over,
  };
}

// --- the vocabulary itself ---------------------------------------------------------------------

console.log("\nthe table is a table");
{
  check("the catalog's sixteen types are all registered", INBOX_TYPES.length === 16);
  check(
    "every entry's `type` matches the key it is filed under",
    INBOX_TYPES.every((t) => inboxType(t).type === t),
  );
  check(
    "every entry offers at least one action, because an item with nothing to do about it is Activity",
    INBOX_TYPES.every((t) => inboxType(t).actions.length > 0),
  );
  check(
    "no entry lists the same action twice",
    INBOX_TYPES.every((t) => new Set(inboxType(t).actions).size === inboxType(t).actions.length),
  );
  check(
    "`dismiss` is never the primary action, because the primary action is what to DO about it",
    INBOX_TYPES.every((t) => inboxType(t).actions[0] !== "dismiss"),
  );
  check(
    "the four types the catalog gives no dismissal are the four that do not offer one",
    ["mcp_auth_required", "deploy_failed", "mcp_unreachable", "memory_proposal"].every(
      (t) => !inboxType(t as InboxItemType).actions.includes("dismiss"),
    ),
  );
  check(
    "exactly the three §2.4 types are team-only, so a Personal workspace is not shown a members list it has not got",
    INBOX_TYPES.filter((t) => inboxType(t).teamOnly).join(",") ===
      "invite_pending,member_joined,agent_deleted_by_other",
  );
  check("an unknown type is not a type", !isInboxItemType("credential_found"));
  check("...and asking for one throws rather than answering with an undefined definition", (() => {
    try {
      inboxType("nope" as InboxItemType);
      return false;
    } catch {
      return true;
    }
  })());
  check(
    "every subject line survives an empty payload, because a predicate must never throw on a row",
    INBOX_TYPES.every((t) => typeof inboxType(t).subjectLine({}) === "string"),
  );
}

console.log("\na dedupe key is the same string for the same problem");
{
  check(
    "one agent's one missing name is one key",
    dedupeKey("credential_missing", "agent-1", "STRIPE_KEY") ===
      dedupeKey("credential_missing", "agent-1", "STRIPE_KEY"),
  );
  check(
    "...and two missing names on one agent are two, so the card is per credential",
    dedupeKey("credential_missing", "agent-1", "STRIPE_KEY") !==
      dedupeKey("credential_missing", "agent-1", "SLACK_TOKEN"),
  );
  check(
    "a workspace-subject item keys on the workspace rather than on the empty string",
    dedupeKey("setup_api_key", null) === "setup_api_key:workspace",
  );
  check(
    "a drift key carries the version PAIR, which is what makes a dismissal version-scoped",
    dedupeKey("version_drift", "agent-1", "5-9") !== dedupeKey("version_drift", "agent-1", "5-10"),
  );
}

// --- §2.1 blocking ------------------------------------------------------------------------------

console.log("\ncredential_missing resolves when the credential is set somewhere else entirely");
{
  const it = item("credential_missing", { subject_id: "agent-1", payload: { credential: "STRIPE_KEY" } });
  check("a declared name with nothing behind it is unresolved", !isResolved(it, facts()));
  check(
    "...and setting it — from the Agents tab, a thread, or a script — resolves it with no dismissal",
    isResolved(it, facts({ configuredSecrets: new Set(["STRIPE_KEY"]) })),
  );
  check(
    "a different name being configured is not this one",
    !isResolved(it, facts({ configuredSecrets: new Set(["SLACK_TOKEN"]) })),
  );
  check(
    "the comparison is case-sensitive, because an environment variable name is",
    !isResolved(it, facts({ configuredSecrets: new Set(["stripe_key"]) })),
  );
}

console.log("\nmcp_auth_required resolves when the server answers again");
{
  const it = item("mcp_auth_required", { subject_id: "mcp-1", payload: { server_name: "linear" } });
  check(
    "a server asking for a credential is unresolved",
    !isResolved(it, facts({ mcpServers: new Map([["mcp-1", server({ status: "auth_required" })]]) })),
  );
  check("...and connected resolves it", isResolved(it, facts()));
  check(
    "a server that was REMOVED resolves it too, which is the second exit the actions offer",
    isResolved(it, facts({ mcpServers: new Map() })),
  );
  check(
    "unreachable is not authenticated, and does not resolve an auth item",
    !isResolved(it, facts({ mcpServers: new Map([["mcp-1", server({ status: "unreachable" })]]) })),
  );
}

console.log("\ndeploy_failed resolves only on a deploy that succeeded AFTER it");
{
  const it = item("deploy_failed", {
    subject_id: "dep-1",
    payload: { agent_uuid: "agent-1", agent_name: "API Gateway" },
    first_seen_at: ago(2 * HOUR),
  });
  check("a failure with nothing serving is unresolved", !isResolved(it, facts()));
  check(
    "a deploy that succeeded BEFORE the failure does not resolve it — it is the one that was already live",
    !isResolved(
      it,
      facts({ agents: new Map([["agent-1", agent({ liveDeployAt: ago(6 * HOUR) })]]) }),
    ),
  );
  check(
    "...and one that succeeded after it does",
    isResolved(it, facts({ agents: new Map([["agent-1", agent({ liveDeployAt: ago(HOUR) })]]) })),
  );
  check(
    "an agent that no longer exists resolves it, because a failed deploy of nothing waits on nobody",
    isResolved(it, facts({ agents: new Map() })),
  );
}

console.log("\nbudget_ceiling_hit resolves when the ceiling moves, not when somebody looks");
{
  const it = item("budget_ceiling_hit", { subject_id: "eval-1", payload: { ceiling_usd: 25 } });
  check("the ceiling still where it was is unresolved", !isResolved(it, facts({ spendCeilingUsd: 25 })));
  check("raising it resolves", isResolved(it, facts({ spendCeilingUsd: 50 })));
  check("removing it entirely resolves", isResolved(it, facts({ spendCeilingUsd: null })));
  check("lowering it does not", !isResolved(it, facts({ spendCeilingUsd: 10 })));
  check(
    "the copy says the eval stopped STARTING jobs and never that it was halted, which v0.1.9 recorded is untrue",
    (() => {
      const line = inboxType("budget_ceiling_hit").subjectLine({ ceiling_usd: 25 });
      return line.includes("stopped starting new jobs") && !/halt|stopped dead|killed/i.test(line);
    })(),
  );
}

// --- §2.2 attention -----------------------------------------------------------------------------

console.log("\nunreviewed_failures resolves when any one of those traces is opened");
{
  const it = item("unreviewed_failures", {
    subject_id: "agent-1",
    payload: { agent_name: "API Gateway", run_ids: ["run-a", "run-b", "run-c"] },
  });
  check("nothing opened is unresolved", !isResolved(it, facts()));
  // THE STAMP IS ON THE ROW rather than in a set of reviewed run ids the sweep is handed, because
  // that set would be this process's memory and a restart would empty it — resurrecting every card
  // somebody dealt with last week, which is the one thing Law 2 promises does not happen.
  const reviewed = item("unreviewed_failures", {
    subject_id: "agent-1",
    payload: { agent_name: "API Gateway", run_ids: ["run-a", "run-b"], reviewed_at: ago(HOUR) },
  });
  check("opening any one of those traces resolves it, from anywhere a trace can be opened", isResolved(reviewed, facts()));
}

console.log("\nversion_drift resolves when the pair stops being the pair");
{
  const it = item("version_drift", {
    subject_id: "agent-1",
    payload: { agent_name: "API Gateway", deployed: 5, current: 9 },
  });
  const drifting = facts({ agents: new Map([["agent-1", agent({ deployedVersion: 5, currentVersion: 9 })]]) });
  check("still v5 against v9 is unresolved", !isResolved(it, drifting));
  check(
    "redeploying so the versions match resolves it",
    isResolved(it, facts({ agents: new Map([["agent-1", agent({ deployedVersion: 9, currentVersion: 9 })]]) })),
  );
  check(
    "removing the deployment resolves it, because nothing serving cannot be behind",
    isResolved(it, facts({ agents: new Map([["agent-1", agent({ deployedVersion: null })]]) })),
  );
  check(
    "publishing v10 resolves THIS row, so the newer pair is a new row a stale dismissal does not cover",
    isResolved(it, facts({ agents: new Map([["agent-1", agent({ deployedVersion: 5, currentVersion: 10 })]]) })),
  );
  check(
    "a deployed version AHEAD of current is not drift — an undo moves current backwards and the container serves on",
    isResolved(it, facts({ agents: new Map([["agent-1", agent({ deployedVersion: 11, currentVersion: 9 })]]) })),
  );
}

console.log("\neval_finished resolves when the results are opened from anywhere");
{
  const it = item("eval_finished", { subject_id: "eval-1", payload: { dataset_name: "regression" } });
  check("results nobody opened is unresolved", !isResolved(it, facts()));
  const opened = item("eval_finished", {
    subject_id: "eval-1",
    payload: { dataset_name: "regression", opened_at: ago(HOUR) },
  });
  check("opening them in the Evals tab resolves the Inbox card, with nothing pressed on the card", isResolved(opened, facts()));
}

console.log("\nmcp_unreachable resolves when the server comes back");
{
  const it = item("mcp_unreachable", { subject_id: "mcp-1", payload: { server_name: "linear" } });
  check(
    "still unreachable is unresolved",
    !isResolved(it, facts({ mcpServers: new Map([["mcp-1", server({ status: "unreachable" })]]) })),
  );
  check("connected resolves", isResolved(it, facts()));
  check("removed resolves", isResolved(it, facts({ mcpServers: new Map() })));
}

console.log("\ncost_anomaly resolves only after spend has been normal for 48 hours");
{
  const spiking = item("cost_anomaly", { subject_id: "agent-1", payload: { agent_name: "API Gateway", multiple: 4.2 } });
  check("a spike with no quiet period recorded is unresolved", !isResolved(spiking, facts()));
  const quietOneHour = item("cost_anomaly", {
    subject_id: "agent-1",
    payload: { agent_name: "API Gateway", multiple: 4.2, normal_since: ago(HOUR) },
  });
  check("one quiet hour is not 48, so it does not resolve", !isResolved(quietOneHour, facts()));
  const quietTwoDays = item("cost_anomaly", {
    subject_id: "agent-1",
    payload: { agent_name: "API Gateway", multiple: 4.2, normal_since: ago(COST_NORMAL_FOR_MS + HOUR) },
  });
  check("48 hours of normal spend resolves it", isResolved(quietTwoDays, facts()));
}

// --- §2.3 proposals -----------------------------------------------------------------------------

console.log("\nmemory_proposal is answered rather than resolved by the world");
{
  const open = item("memory_proposal", { subject_id: "agent-1", payload: { agent_name: "API Gateway" } });
  check("an unanswered proposal stands", !isResolved(open, facts()));
  check(
    "saving it resolves",
    isResolved(item("memory_proposal", { payload: { decision: "saved" } }), facts()),
  );
  check(
    "rejecting it resolves too — both are answers, and only ignoring it is not",
    isResolved(item("memory_proposal", { payload: { decision: "rejected" } }), facts()),
  );
  check(
    "an unrecognised decision does not resolve it, so a typo cannot silently clear a proposal",
    !isResolved(item("memory_proposal", { payload: { decision: "maybe" } }), facts()),
  );
}

console.log("\nungated_high_impact resolves by the gate or by the grant");
{
  const ungated = agent({ highImpactTools: ["linear/delete_issue"], confirmGateEnabled: false });
  const it = item("ungated_high_impact", {
    subject_id: "agent-1",
    payload: { agent_name: "API Gateway", tools: ["linear/delete_issue"] },
  });
  check("a high-impact grant with the gate off is unresolved", !isResolved(it, facts({ agents: new Map([["agent-1", ungated]]) })));
  check(
    "enabling the gate resolves it",
    isResolved(it, facts({ agents: new Map([["agent-1", agent({ highImpactTools: ["linear/delete_issue"] })]]) })),
  );
  check(
    "removing the grant resolves it",
    isResolved(it, facts({ agents: new Map([["agent-1", agent({ confirmGateEnabled: false })]]) })),
  );
  check(
    "the copy states what is true and never that surfacing it made the agent safe",
    !/safe|secure|protected|fixed/i.test(
      inboxType("ungated_high_impact").subjectLine({ agent_name: "API Gateway", tools: ["a"] }),
    ),
  );
}

// --- §2.4 team ----------------------------------------------------------------------------------

console.log("\nthe three team notices");
{
  const invite = item("invite_pending", { subject_id: "inv-1", payload: { email: "sam@example.com" } });
  check(
    "an invitation still outstanding is unresolved",
    !isResolved(invite, facts({ pendingInvites: new Set(["inv-1"]) })),
  );
  check("accepted, revoked or expired all read the same from here, and all resolve", isResolved(invite, facts()));

  const joined = item("member_joined", { subject_id: "user-1", payload: { name: "Sam" }, first_seen_at: ago(HOUR) });
  check("a fresh arrival stands", !isResolved(joined, facts()));
  check(
    "a member who has since left resolves it",
    isResolved(joined, facts({ memberIds: new Set() })),
  );
  const oldJoin = item("member_joined", { subject_id: "user-1", first_seen_at: ago(TEAM_NOTICE_TTL_MS + HOUR) });
  check("...and an arrival stops being news on its own clock", isResolved(oldJoin, facts()));

  const deleted = item("agent_deleted_by_other", {
    subject_id: "agent-1",
    payload: { agent_name: "API Gateway", actor_name: "Sam" },
    first_seen_at: ago(HOUR),
  });
  check(
    "an archived agent you created is unresolved while it is still away",
    !isResolved(deleted, facts({ agents: new Map([["agent-1", agent({ archivedAt: ago(HOUR) })]]) })),
  );
  check("restoring it resolves — from this card or from the sidebar, which is the point", isResolved(deleted, facts()));
}

// --- §2.5 onboarding ------------------------------------------------------------------------------

console.log("\nthe two seeded items resolve by the thing actually being done");
{
  const key = item("setup_api_key", { subject_id: null });
  check("a workspace with no provider credential is unresolved", !isResolved(key, facts()));
  check("adding one anywhere resolves it", isResolved(key, facts({ hasProviderKey: true })));

  const first = item("setup_first_agent", { subject_id: null });
  check("a workspace with no agents is unresolved", !isResolved(first, facts({ agentCount: 0 })));
  check("building one resolves it", isResolved(first, facts({ agentCount: 1 })));
  check(
    "...and archiving that agent afterwards does not ask them to build their first one again",
    isResolved(first, facts({ agentCount: 1, agents: new Map([["agent-1", agent({ archivedAt: ago(HOUR) })]]) })),
  );
}

// --- the assertion that stops a predicate being a stub --------------------------------------------

console.log("\nno predicate is a constant");
{
  // A predicate that always answers `true` passes every test above that checks the resolved case,
  // and the item type it belongs to then never appears on a board. This is the assertion that a
  // sixteenth entry copied from a fifteenth has actually been finished.
  const alwaysTrue: InboxItemType[] = [];
  for (const t of INBOX_TYPES) {
    // EVERY SUBJECT THIS PROBE HAS, because the subject id is what half of these look up and a
    // lookup that misses resolves — correctly, since a subject that is gone is a problem that is
    // gone. Handing the MCP types an agent's id would make them look like stubs when what they
    // actually did was answer "that server was removed" honestly.
    const subjects: (string | null)[] = [null, "agent-1", "mcp-1", "eval-1", "user-1"];
    const candidates = subjects.map((subject_id) =>
      item(t, {
        subject_id,
        payload: { credential: "STRIPE_KEY", agent_uuid: "agent-1", ceiling_usd: 25, run_ids: ["run-a"], deployed: 5, current: 9 },
        first_seen_at: ago(HOUR),
      }),
    );
    const blocked = facts({
      agents: new Map([["agent-1", agent({ deployedVersion: 5, currentVersion: 9, confirmGateEnabled: false, highImpactTools: ["x/y"], archivedAt: ago(HOUR) })]]),
      mcpServers: new Map([["mcp-1", server({ status: "auth_required" })]]),
      spendCeilingUsd: 25,
      pendingInvites: new Set(["user-1"]),
      memberIds: new Set(["user-1"]),
      hasProviderKey: false,
      agentCount: 0,
    });
    if (candidates.every((c) => isResolved(c, blocked))) alwaysTrue.push(t);
  }
  check(
    `every type has facts under which it is unresolved${alwaysTrue.length ? ` — always-true: ${alwaysTrue.join(", ")}` : ""}`,
    alwaysTrue.length === 0,
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
if (failures > 0) process.exit(1);

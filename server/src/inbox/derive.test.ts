// The derived generators: what gets raised, what deliberately does not, and the round trip.
//
// THE ROUND TRIP IS THE ASSERTION THIS FILE EXISTS FOR. A trigger and its resolve predicate are the
// two halves of one statement about the world, and they live in two files — so the failure mode is
// a rule that raises an item the predicate immediately resolves, which produces a card that appears
// and vanishes on every sweep forever, or one the predicate can never resolve, which produces a card
// nothing can clear. Both look fine in review. The last block here derives an item from facts that
// trigger it and asserts the predicate says UNRESOLVED, for every derived type.
//
// AND THE FOUR EXCLUSIONS, each of which is a card that would look right and be wrong:
//
//   An archived agent raises nothing. Blocking means work is stopped, and an agent somebody put away
//   is not running — a credential card for it asks them to unblock nothing.
//
//   An agent with no pricing is out of anomaly detection entirely. v0.1.9 fixed the lie that unknown
//   is zero, and §2.2 says it does not come back through this door.
//
//   A server unreachable for ten minutes raises nothing. That is a network. A day of it is a
//   decision somebody made without telling this workspace.
//
//   An agent with the gate off and no high-impact grant raises nothing. There is nothing ungated.
//
//   npm run test:inbox-derive

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { DERIVED_RULES, deriveInboxItems, disablesConfirmGate } from "./derive.ts";
import { InboxStore } from "./inboxStore.ts";
import {
  INBOX_TYPES,
  MCP_UNREACHABLE_AFTER_MS,
  inboxType,
  isResolved,
  type AgentInboxFacts,
  type InboxFacts,
  type InboxItemType,
  type McpInboxFacts,
} from "./registry.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const AGENT = "11111111-1111-4111-8111-111111111111";

function agent(over: Partial<AgentInboxFacts> = {}): AgentInboxFacts {
  return {
    uuid: AGENT,
    slug: "api_gateway",
    name: "API Gateway",
    requiredEnv: [],
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
  return { id: "linear", name: "Linear", status: "connected", statusSince: ago(HOUR), ...over };
}

function facts(over: Partial<InboxFacts> = {}): InboxFacts {
  return {
    now: NOW,
    configuredSecrets: new Set(),
    agents: new Map(),
    mcpServers: new Map(),
    spendCeilingUsd: null,
    pendingInvites: new Set(),
    memberIds: new Set(),
    hasProviderKey: true,
    agentCount: 1,
    team: false,
    ...over,
  };
}

const rule = (t: InboxItemType) => DERIVED_RULES[t]!;

// --- 1. the table itself --------------------------------------------------------------------

console.log("\nevery type the registry calls derived has a rule that can raise it");
{
  const derivedTypes = INBOX_TYPES.filter((t) => inboxType(t).origin === "derived");
  const withRules = derivedTypes.filter((t) => DERIVED_RULES[t]);
  check(
    "the five derived types all have one — a type that can be resolved and never raised is a feature nothing can reach",
    withRules.length === derivedTypes.length,
    `missing: ${derivedTypes.filter((t) => !DERIVED_RULES[t]).join(", ")}`,
  );
  check(
    "...and nothing non-derived has one, or an event would be written twice",
    Object.keys(DERIVED_RULES).every((t) => inboxType(t as InboxItemType).origin === "derived"),
  );
}

// --- 2. credential_missing ------------------------------------------------------------------

console.log("\na declared name with nothing behind it, one card per name");
{
  const two = agent({ requiredEnv: ["STRIPE_KEY", "SLACK_TOKEN"] });
  const out = rule("credential_missing")(facts({ agents: new Map([[AGENT, two]]) }), []);
  check("two missing names are two cards, because each has its own form and its own fix", out.length === 2);
  check("...each naming one credential", new Set(out.map((r) => r.payload!["credential"])).size === 2);
  check(
    "...and nothing else — there is no field on the payload a value could be in",
    out.every((r) => !Object.keys(r.payload!).some((k) => /value|secret$|token$/i.test(k))),
  );

  const oneSet = rule("credential_missing")(
    facts({ agents: new Map([[AGENT, two]]), configuredSecrets: new Set(["STRIPE_KEY"]) }),
    [],
  );
  check("configuring one leaves the other", oneSet.length === 1 && oneSet[0]?.payload!["credential"] === "SLACK_TOKEN");

  check(
    "an ARCHIVED agent raises nothing, because there is no work of its to unblock",
    rule("credential_missing")(
      facts({ agents: new Map([[AGENT, agent({ requiredEnv: ["STRIPE_KEY"], archivedAt: ago(HOUR) })]]) }),
      [],
    ).length === 0,
  );
  check(
    "a name declared twice is one card",
    rule("credential_missing")(
      facts({ agents: new Map([[AGENT, agent({ requiredEnv: ["STRIPE_KEY", "STRIPE_KEY"] })]]) }),
      [],
    ).length === 1,
  );
}

// --- 3. version_drift -----------------------------------------------------------------------

console.log("\ndrift is a fact about something that is serving, and its key carries the pair");
{
  const drifting = agent({ deployedVersion: 5, currentVersion: 9 });
  const out = rule("version_drift")(facts({ agents: new Map([[AGENT, drifting]]) }), []);
  check("v5 serving against v9 current is one card", out.length === 1);
  check("...carrying both numbers so the card reads left to right as live then current",
    out[0]?.payload!["deployed"] === 5 && out[0]?.payload!["current"] === 9);
  check("...keyed on the PAIR, which is what makes a dismissal version-scoped",
    out[0]?.dedupeKey.endsWith(":5-9") === true, out[0]?.dedupeKey);

  const newer = rule("version_drift")(
    facts({ agents: new Map([[AGENT, agent({ deployedVersion: 5, currentVersion: 10 })]]) }),
    [],
  );
  check("publishing v10 produces a DIFFERENT key, so a stale dismissal does not cover it",
    newer[0]?.dedupeKey !== out[0]?.dedupeKey);

  check(
    "nothing deployed is not drift",
    rule("version_drift")(facts({ agents: new Map([[AGENT, agent({ deployedVersion: null })]]) }), []).length === 0,
  );
  check(
    "a deployed version AHEAD of current is not drift either — an undo moves current backwards",
    rule("version_drift")(
      facts({ agents: new Map([[AGENT, agent({ deployedVersion: 11, currentVersion: 9 })]]) }),
      [],
    ).length === 0,
  );
}

// --- 4. mcp_unreachable ---------------------------------------------------------------------

console.log("\nten minutes unreachable is a network; a day of it is somebody's decision");
{
  const brief = server({ status: "unreachable", statusSince: ago(10 * 60_000) });
  check(
    "ten minutes raises nothing",
    rule("mcp_unreachable")(facts({ mcpServers: new Map([["linear", brief]]) }), []).length === 0,
  );

  const long = server({ status: "unreachable", statusSince: ago(MCP_UNREACHABLE_AFTER_MS + HOUR) });
  const out = rule("mcp_unreachable")(facts({ mcpServers: new Map([["linear", long]]) }), []);
  check("over a day raises one", out.length === 1);
  check("...naming when it last worked, which is what the duration is measured from",
    out[0]?.payload!["last_seen_at"] === long.statusSince);

  check(
    "a CONNECTED server raises nothing however long ago it was discovered",
    rule("mcp_unreachable")(
      facts({ mcpServers: new Map([["linear", server({ statusSince: ago(90 * 24 * HOUR) })]]) }),
      [],
    ).length === 0,
  );
  check(
    "a timestamp nothing can read is not evidence of a day of anything",
    rule("mcp_unreachable")(
      facts({ mcpServers: new Map([["linear", server({ status: "unreachable", statusSince: "not a date" })]]) }),
      [],
    ).length === 0,
  );
}

// --- 5. cost_anomaly, and the exclusion v0.1.9 paid for -------------------------------------

console.log("\nan agent with no pricing is out of anomaly detection entirely");
{
  const spiking = agent({ spendUsd: 40, trailingAvgUsd: 10, pricingKnown: true });
  const out = rule("cost_anomaly")(facts({ agents: new Map([[AGENT, spiking]]) }), []);
  check("4× the average is an anomaly", out.length === 1);
  check("...carrying the multiple the card renders", out[0]?.payload!["multiple"] === 4);

  check(
    "2× is not, because §2.2 says three",
    rule("cost_anomaly")(
      facts({ agents: new Map([[AGENT, agent({ spendUsd: 20, trailingAvgUsd: 10 })]]) }),
      [],
    ).length === 0,
  );
  check(
    "AN UNPRICED MODEL IS EXCLUDED, so it never appears as a $0 baseline everything spikes against",
    rule("cost_anomaly")(
      facts({ agents: new Map([[AGENT, agent({ spendUsd: 40, trailingAvgUsd: 0, pricingKnown: false })]]) }),
      [],
    ).length === 0,
  );
  check(
    "an agent that has spent nothing has no average to be three times of",
    rule("cost_anomaly")(facts({ agents: new Map([[AGENT, agent()]]) }), []).length === 0,
  );

  // The 48-hour memory. Without it the card clears the first quiet hour and returns the next busy
  // one, which is a card that flickers rather than a statement about a week.
  const calm = agent({ spendUsd: 10, trailingAvgUsd: 10 });
  const openCard = {
    id: "i1", type: "cost_anomaly" as const, severity: "attention" as const, subject_type: "agent" as const,
    subject_id: AGENT, dedupe_key: "cost_anomaly:" + AGENT, payload: { agent_name: "API Gateway", multiple: 4 },
    state: "open" as const, count: 1, first_seen_at: ago(3 * HOUR), last_seen_at: ago(HOUR), resolved_at: null,
  };
  const stamped = rule("cost_anomaly")(facts({ agents: new Map([[AGENT, calm]]) }), [openCard]);
  check("spend going back to normal starts the clock on the open card", stamped.length === 1);
  check("...by stamping when it calmed down", typeof stamped[0]?.payload!["normal_since"] === "string");

  const already = rule("cost_anomaly")(
    facts({ agents: new Map([[AGENT, calm]]) }),
    [{ ...openCard, payload: { ...openCard.payload, normal_since: ago(HOUR) } }],
  );
  check("...and a second quiet tick does not move it, or the 48 hours never elapse", already.length === 0);
  check(
    "a calm agent with no card at all raises nothing",
    rule("cost_anomaly")(facts({ agents: new Map([[AGENT, calm]]) }), []).length === 0,
  );
}

// --- 6. ungated_high_impact ------------------------------------------------------------------

console.log("\nsurfacing an ungated grant, and not claiming it is fixed");
{
  const ungated = agent({ highImpactTools: ["linear/delete_issue"], confirmGateEnabled: false });
  const out = rule("ungated_high_impact")(facts({ agents: new Map([[AGENT, ungated]]) }), []);
  check("a high-impact grant with the gate off raises one", out.length === 1);
  check("...naming the tools, so `remove grant` knows what to remove",
    JSON.stringify(out[0]?.payload!["tools"]) === JSON.stringify(["linear/delete_issue"]));

  check(
    "the gate off with NO high-impact grant raises nothing, because there is nothing ungated",
    rule("ungated_high_impact")(
      facts({ agents: new Map([[AGENT, agent({ confirmGateEnabled: false })]]) }),
      [],
    ).length === 0,
  );
  check(
    "a grant WITH the gate on raises nothing",
    rule("ungated_high_impact")(
      facts({ agents: new Map([[AGENT, agent({ highImpactTools: ["linear/delete_issue"] })]]) }),
      [],
    ).length === 0,
  );

  // The detector, driven as a rule rather than as a regex.
  check("code that sets the variable to skip is detected", disablesConfirmGate('os.environ["JAROKU_MCP_CONFIRM"] = "skip"'));
  check("...including through setdefault", disablesConfirmGate("os.environ.setdefault('JAROKU_MCP_CONFIRM', 'off')"));
  check(
    "setting it TO require is somebody turning the gate ON, and is not the trigger",
    !disablesConfirmGate('os.environ["JAROKU_MCP_CONFIRM"] = "require"'),
  );
  check("ordinary code is not", !disablesConfirmGate("import os\\nprint(os.environ.get('HOME'))"));
}

// --- 7. the round trip -----------------------------------------------------------------------

console.log("\nwhat a rule raises, its own predicate calls unresolved");
{
  // FACTS THAT TRIGGER EVERY DERIVED RULE AT ONCE. A rule whose trigger and predicate disagree
  // produces either a card that appears and vanishes on every sweep or one nothing can clear, and
  // both look correct in review.
  const spiking = agent({
    requiredEnv: ["STRIPE_KEY"],
    deployedVersion: 5,
    currentVersion: 9,
    highImpactTools: ["linear/delete_issue"],
    confirmGateEnabled: false,
    spendUsd: 40,
    trailingAvgUsd: 10,
  });
  const world = facts({
    agents: new Map([[AGENT, spiking]]),
    mcpServers: new Map([["linear", server({ status: "unreachable", statusSince: ago(MCP_UNREACHABLE_AFTER_MS + HOUR) })]]),
  });

  const db = await openTestSqlite();
  const inbox = new InboxStore(db);
  const written = await deriveInboxItems(inbox, ctx, world, [], () => {});
  const open = await inbox.listOpen(ctx);

  check("all five derived types are raised from one set of facts", written === 5, `${written}`);
  check("...as five rows", open.length === 5);
  const unresolvable = open.filter((i) => isResolved(i, world)).map((i) => i.type);
  check(
    `every one of them is UNRESOLVED against the facts that raised it${unresolvable.length ? ` — contradicting: ${unresolvable.join(", ")}` : ""}`,
    unresolvable.length === 0,
  );

  // And a second pass over the same facts changes nothing but the timestamps, which is what makes
  // the whole sweep idempotent rather than merely repeatable.
  await deriveInboxItems(inbox, ctx, world, open, () => {});
  const again = await inbox.listOpen(ctx);
  check("a second derive over the same facts is still five rows", again.length === 5);
  check(
    "...and none of their counts moved, because a condition observed twice happened once",
    again.every((i) => i.count === 1),
    again.map((i) => `${i.type}=${i.count}`).join(","),
  );

  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
if (fail > 0) process.exit(1);

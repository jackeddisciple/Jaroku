// The derived generators: what should be on the board right now, from facts nothing emits.
//
// §6.2'S OTHER HALF. An event-driven item is written by the handler for something that happened —
// a run failed, a deploy failed. These five have no event to hang off, because each is a COMPARISON
// between two states that are both simply true: a name in `required_env` with no configured secret
// behind it, a deployed version behind a current one, a server that last worked a day ago, spend
// three times its own average, a high-impact grant with the gate off. Nothing in the product emits
// "these two facts now disagree", and inventing an event so they could be written like the others
// would mean adding to the frozen schema — which §6.2 refuses in as many words.
//
// A TABLE, LIKE THE REGISTRY, AND FOR THE SAME REASON. Each rule is one entry that turns facts into
// the rows that should exist. The sweep calls `deriveInboxItems` and knows nothing about any of
// them, so a sixth derived type is an entry here and no line anywhere else.
//
// THE RULES ARE PURE AND THE WRITING IS NOT. Every entry below is `(facts, open) => RecordInput[]` —
// no database, no clock of its own, no ability to fail — which is what lets the suite assert "an
// agent with no pricing is not in the anomaly list" without a database at all. `deriveInboxItems`
// is the only thing here that writes.
//
// AND THE RULE THAT KEEPS THIS HONEST: A TRIGGER HERE MUST AGREE WITH ITS PREDICATE IN THE REGISTRY.
// They are the two halves of one statement about the world, and this is the file where the halves
// are furthest apart — so every entry names the predicate it is the other side of, and the suite
// asserts the pair round-trips: derive an item from facts that trigger it, and the predicate must
// say it is unresolved.

import type { TenantContext } from "../db/tenant.ts";
import { costMultiple, isCostAnomaly } from "./facts.ts";
import type { InboxItem, InboxStore, RecordInput } from "./inboxStore.ts";
import {
  MCP_UNREACHABLE_AFTER_MS,
  dedupeKey,
  type InboxFacts,
  type InboxItemType,
} from "./registry.ts";

/** What a derived rule is: facts plus the board, in; the rows that should exist, out. */
export type DerivedRule = (facts: InboxFacts, open: readonly InboxItem[]) => RecordInput[];

/**
 * §2.1: a name in an agent's `required_env` with no corresponding configured secret.
 *
 * ONE CARD PER AGENT PER NAME, which is what the discriminator in the key buys. Two missing
 * credentials on one agent are two things to do — each has its own inline form and each is fixed
 * separately — and collapsing them would give a card whose primary action can only set one of them.
 *
 * ARCHIVED AGENTS ARE EXCLUDED, and that is a decision rather than an oversight. Blocking means work
 * is stopped, and an archived agent is not running: a card asking somebody to set a credential for
 * an agent they deliberately put away is asking them to unblock nothing. It comes back with the
 * agent if they restore it, because the next sweep sees it again.
 *
 * The other half is `credential_missing.resolved`, which asks whether the name is configured now.
 */
const credentialMissing: DerivedRule = (facts) => {
  const out: RecordInput[] = [];
  for (const agent of facts.agents.values()) {
    if (agent.archivedAt) continue;
    const seen = new Set<string>();
    for (const name of agent.requiredEnv) {
      // The comparison is exact and case-sensitive, because an environment variable name is:
      // `AIRTABLE_KEY` and `airtable_key` are two different names to every process that reads one.
      if (typeof name !== "string" || !name || seen.has(name)) continue;
      seen.add(name);
      if (facts.configuredSecrets.has(name)) continue;
      out.push({
        type: "credential_missing",
        subjectId: agent.uuid,
        dedupeKey: dedupeKey("credential_missing", agent.uuid, name),
        // THE NAME, AND THERE IS NO FIELD HERE A VALUE COULD BE IN. §6.5 in one line.
        payload: { credential: name, agent_name: agent.name, agent_slug: agent.slug },
      });
    }
  }
  return out;
};

/**
 * §2.2: an agent's deployed version is behind its current version.
 *
 * THE KEY CARRIES THE PAIR, and that is the whole mechanism behind "dismissal is scoped to that
 * version pair, so publishing a newer version raises it again". A dismissal is a row in the per-user
 * table keyed by ITEM, so making a newer pair a different item is what makes the dismissal stop
 * applying — there is no expiry to write and no dismissal to clear.
 *
 * DRIFT IS ONLY A FACT ABOUT SOMETHING THAT IS SERVING, which `facts.ts` has already applied: a
 * deploy that FAILED still carries the version it meant to build, and computing drift off it put
 * `v2 → v9` on a card with nothing deployed at all. A deployed version AHEAD of current is also not
 * drift — an undo moves current backwards while the container serves on — and reads as null here.
 *
 * The other half is `version_drift.resolved`, which asks whether the pair is still the pair.
 */
const versionDrift: DerivedRule = (facts) => {
  const out: RecordInput[] = [];
  for (const agent of facts.agents.values()) {
    if (agent.archivedAt) continue;
    if (agent.deployedVersion === null) continue;
    if (agent.deployedVersion >= agent.currentVersion) continue;
    out.push({
      type: "version_drift",
      subjectId: agent.uuid,
      dedupeKey: dedupeKey("version_drift", agent.uuid, `${agent.deployedVersion}-${agent.currentVersion}`),
      payload: {
        agent_name: agent.name,
        agent_slug: agent.slug,
        deployed: agent.deployedVersion,
        current: agent.currentVersion,
      },
    });
  }
  return out;
};

/**
 * §2.2: an MCP server has been unreachable for over 24 hours.
 *
 * THE DURATION IS THE TRIGGER, WHICH IS WHY THIS IS DERIVED AND `mcp_auth_required` IS NOT. A server
 * that is unreachable for ten minutes is a network; one unreachable for a day is a decision somebody
 * made without telling this workspace. Raised on the status event, it would put a card on the board
 * every time a third party restarted — and only something that goes and looks can ask how long a
 * state has held.
 *
 * MEASURED FROM WHEN IT LAST WORKED. `mcp_servers` has no status-changed column, and adding one
 * would be a second copy of a fact `discovered_at` already implies: a successful handshake is the
 * only thing that writes it, so a server whose last handshake was three days ago has not worked for
 * three days whatever else is true.
 *
 * A FAILED REFRESH MUST STILL NEVER DESTROY A WORKING TOOL LIST — v0.2.0's rule, untouched by this
 * feature and worth restating where somebody might think a card about an unreachable server is a
 * reason to clean up after it. Nothing here removes a tool, a grant or a server.
 *
 * The other half is `mcp_unreachable.resolved`, which asks whether the server is connected again.
 */
const mcpUnreachable: DerivedRule = (facts) => {
  const out: RecordInput[] = [];
  for (const server of facts.mcpServers.values()) {
    if (server.status !== "unreachable") continue;
    const since = Date.parse(server.statusSince);
    // A timestamp that cannot be read is not evidence of a day of anything. No card rather than a
    // card built on `NaN`.
    if (!Number.isFinite(since)) continue;
    if (facts.now - since < MCP_UNREACHABLE_AFTER_MS) continue;
    out.push({
      type: "mcp_unreachable",
      subjectId: server.id,
      dedupeKey: dedupeKey("mcp_unreachable", server.id),
      payload: { server_name: server.name, last_seen_at: server.statusSince },
    });
  }
  return out;
};

/**
 * §2.2: an agent's spend is 3× its trailing 7-day rolling average.
 *
 * AN AGENT WHOSE MODEL HAS NO PRICING ENTRY IS EXCLUDED ENTIRELY. §2.2 is unusually emphatic about
 * this and the reason is a bug that already shipped once: v0.1.9 established that unknown is not
 * zero, and an unpriced agent sitting at a $0 baseline is a baseline everything spikes against. The
 * exclusion lives in `costMultiple`, which answers null for it — so there is one place it can be got
 * wrong rather than one per caller.
 *
 * `normal_since` IS MAINTAINED HERE AND READ BY THE PREDICATE. §2.2's resolve condition is "spend
 * normalises for 48 hours", which needs a memory: "is it normal right now" would clear the card the
 * first quiet hour and raise it again the next busy one, which is a card that flickers rather than a
 * statement about a week. So an agent that is spiking has the stamp cleared, and one that has calmed
 * down gets it set once — and the predicate resolves the row two days later.
 *
 * The other half is `cost_anomaly.resolved`, which reads exactly that stamp.
 */
const costAnomaly: DerivedRule = (facts, open) => {
  const out: RecordInput[] = [];
  const openByKey = new Map(open.filter((i) => i.type === "cost_anomaly").map((i) => [i.dedupe_key, i]));

  for (const agent of facts.agents.values()) {
    if (agent.archivedAt) continue;
    const key = dedupeKey("cost_anomaly", agent.uuid);
    const existing = openByKey.get(key);
    const multiple = costMultiple(agent);

    if (isCostAnomaly(agent)) {
      out.push({
        type: "cost_anomaly",
        subjectId: agent.uuid,
        dedupeKey: key,
        // The stamp is deliberately ABSENT rather than null: a spiking agent has no quiet period, and
        // writing one would resolve the card 48 hours later whatever spend did in between.
        payload: { agent_name: agent.name, agent_slug: agent.slug, multiple: multiple ?? 0 },
      });
      continue;
    }

    // NOT SPIKING, AND THERE IS A CARD ABOUT IT. This is where the clock starts. Set once and never
    // moved, because moving it on every quiet tick would mean the 48 hours never elapse.
    if (existing && typeof existing.payload["normal_since"] !== "string") {
      out.push({
        type: "cost_anomaly",
        subjectId: agent.uuid,
        dedupeKey: key,
        payload: { ...existing.payload, normal_since: new Date(facts.now).toISOString() },
      });
    }
  }
  return out;
};

/**
 * §2.3: an agent holds a high-impact MCP tool grant while its confirmation gate is disabled.
 *
 * A PROPOSAL RATHER THAN SOMETHING BLOCKING, which is where the catalog files it and is right: the
 * agent works. What is missing is a safety property somebody probably did not choose to give up.
 *
 * THIS CLOSES A GAP v0.2.1 RECORDED OPENLY, AND SURFACING IT IS NOT THE FIX. That release said
 * generated agent code can set the environment variable that disables the bridge's confirmation
 * gate, and that a validation rule was needed. This is not that rule. The card says what is true —
 * these tools can be called without a confirmation — and deliberately does not say the agent is now
 * safe, which is a claim this feature has not earned.
 *
 * THE GATE FACT IS ONLY ASKED ABOUT FOR AGENTS THAT HOLD A GRANT AT ALL, which `facts.ts` arranges:
 * an agent with no high-impact tool cannot raise this however its gate is set, so the read that
 * answers it is skipped entirely for the workspaces — most of them — where nobody has one.
 *
 * The other half is `ungated_high_impact.resolved`: the gate is on, or the grant is gone.
 */
const ungatedHighImpact: DerivedRule = (facts) => {
  const out: RecordInput[] = [];
  for (const agent of facts.agents.values()) {
    if (agent.archivedAt) continue;
    if (agent.confirmGateEnabled) continue;
    if (agent.highImpactTools.length === 0) continue;
    out.push({
      type: "ungated_high_impact",
      subjectId: agent.uuid,
      dedupeKey: dedupeKey("ungated_high_impact", agent.uuid),
      payload: {
        agent_name: agent.name,
        agent_slug: agent.slug,
        // The refs themselves, so the card can name what it is about and `remove grant` knows what
        // to remove. Names, as everything in a payload is.
        tools: agent.highImpactTools,
      },
    });
  }
  return out;
};

/**
 * The five derived types, as a table.
 *
 * A `Partial` OVER THE TYPE UNION rather than a plain array, so an entry is filed under the item
 * type it produces and the compiler refuses one filed under a type that does not exist. It is also
 * what lets a suite assert that every type whose registry entry says `origin: "derived"` has a rule
 * here — the failure mode being an item type that can be resolved and never raised.
 */
export const DERIVED_RULES: Partial<Record<InboxItemType, DerivedRule>> = {
  credential_missing: credentialMissing,
  version_drift: versionDrift,
  mcp_unreachable: mcpUnreachable,
  cost_anomaly: costAnomaly,
  ungated_high_impact: ungatedHighImpact,
};

/**
 * Run every derived rule and write what they produce. Returns how many rows were touched.
 *
 * THE ONLY THING IN THIS FILE THAT WRITES, and it goes through `record` like every other generator —
 * so a problem that recurs re-opens on the same key, a count moves, and none of that had to be
 * arranged here.
 *
 * A RULE THAT THROWS TAKES ONLY ITSELF DOWN. Five rules read five different corners of a workspace,
 * and one of them tripping over a payload nobody expected must not stop the other four — the same
 * argument the sweep makes about one workspace not stopping the others, one level in.
 */
export async function deriveInboxItems(
  inbox: InboxStore,
  ctx: TenantContext,
  facts: InboxFacts,
  open: readonly InboxItem[],
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  let written = 0;
  for (const [type, rule] of Object.entries(DERIVED_RULES) as [InboxItemType, DerivedRule][]) {
    let wanted: RecordInput[];
    try {
      wanted = rule(facts, open);
    } catch (err) {
      log(`[inbox] the ${type} rule threw: ${(err as Error)?.message ?? err}`);
      continue;
    }
    for (const input of wanted) {
      try {
        await inbox.record(ctx, input);
        written++;
      } catch (err) {
        log(`[inbox] could not record ${type}: ${(err as Error)?.message ?? err}`);
      }
    }
  }
  return written;
}

/**
 * How generated agent code turns the high-impact confirmation gate off.
 *
 * THE GAP v0.2.1 RECORDED, AS A PATTERN. The bridge reads `JAROKU_MCP_CONFIRM` and treats anything
 * other than `require` as permission to proceed without asking — so a line of generated code setting
 * it to `skip` disables the one thing standing between a model and a destructive third-party call.
 * That release said a validation rule was needed and this is not it: a pattern that finds the
 * obvious spelling is a way to SURFACE the state, and code determined to evade it will.
 *
 * WHICH IS WHY A MISS PRODUCES NO CARD RATHER THAN A REASSURING ONE. Nothing anywhere in this
 * feature says an agent's gate is on; the only claim made is about agents where it is demonstrably
 * off. A detector used to raise an item can afford to be incomplete; one used to declare something
 * safe cannot, and this is deliberately the first kind.
 *
 * TWO SPELLINGS, because Python offers two and generated code uses both: assigning into
 * `os.environ` by subscript, and `os.environ.setdefault`. The value is checked rather than assumed —
 * setting it TO `require` is somebody turning the gate ON, which is the opposite of the trigger.
 */
const GATE_OFF = [
  /os\.environ\s*\[\s*["']JAROKU_MCP_CONFIRM["']\s*\]\s*=\s*["'](?!require["'])[^"']*["']/,
  /os\.environ\.setdefault\s*\(\s*["']JAROKU_MCP_CONFIRM["']\s*,\s*["'](?!require["'])[^"']*["']/,
  /putenv\s*\(\s*["']JAROKU_MCP_CONFIRM["']\s*,\s*["'](?!require["'])[^"']*["']/,
];

/** True when this file turns the gate off. Exported so the suite can drive the rule, not the regex. */
export function disablesConfirmGate(source: string): boolean {
  return GATE_OFF.some((re) => re.test(source));
}

// What can be in the Inbox, as one table.
//
// SIXTEEN ENTRIES AND ONE SHAPE. Every item type declares its severity, what it is about, how it is
// produced, what it renders as, what can be done about it and — the load-bearing one — the predicate
// that says whether it is still true. A seventeenth type is an entry here and nothing else: no branch
// in the sweep, no case in a handler, no second list in the client.
//
// THE PREDICATE IS THE WHOLE REASON THIS IS A TABLE. Law 2 of the specification is that every item
// dies on its own: if somebody sets the missing credential from the Agents tab, from a thread, or
// from a script nobody has written yet, the item disappears without anybody dismissing it. That is
// only true if the condition is evaluated by something that never sees the user action — the
// reconciler, sweeping every open row against facts it gathered independently. An item that leaves
// because a button was pressed is an item that stays when the same fix arrives by another door, and
// an Inbox that shows stale items is dead in a week.
//
// SO A PREDICATE MUST NEVER BE WRITTEN INLINE IN THE SWEEP. The trigger that creates an item and the
// condition that removes it are two halves of one statement about the world, and separated by a file
// they drift: somebody widens the trigger, nothing widens the predicate, and the item type quietly
// becomes one that can be raised and never cleared. They sit in the same object here, three lines
// apart, so a change to one is a change somebody makes while looking at the other.
//
// EVERY PREDICATE IS PURE AND TOTAL. It takes a row and a bag of facts and returns a boolean, with no
// database handle, no clock of its own and no ability to fail. That is what makes the suite for §9 —
// "resolve every item type externally and assert it disappears" — possible without standing a server
// up, and it is why `InboxFacts` is a value the reconciler assembles rather than an interface it
// implements.
//
// WHAT IS NOT HERE, and deliberately: the SQL, the sweep, the WebSocket shapes and the icons' actual
// paths. This file is the vocabulary. `inboxStore.ts` writes rows, `reconciler.ts` loops, and the
// client's own registry maps these icon names onto SVGs — structurally rather than by import, the
// same way every other wire shape in this codebase is restated where it lands.
//
// THE CATALOG NAMES SIXTEEN TYPES AND THE SPECIFICATION'S PROSE SAYS EIGHTEEN TWICE. §2 closes with
// "adding a nineteenth item type later" and §9 asks for "all eighteen types", while §2.1–§2.5 name
// four blocking, five attention, two proposal, three team and two onboarding — sixteen. Nothing was
// dropped: two of the sixteen have never had a second reading, and the arithmetic is what it is. The
// sixteen that are specified are implemented, and `INBOX_TYPES` below is the count anything asserting
// against this should read rather than a number in a sentence.

/** The three columns of §4.2's board. Assigned by the system; a card never moves between them. */
export type InboxSeverity = "blocking" | "attention" | "proposal";

export const INBOX_SEVERITIES: readonly InboxSeverity[] = ["blocking", "attention", "proposal"];

/**
 * What an item is about.
 *
 * `workspace` is a real subject and not a placeholder: the two onboarding items and the two team
 * notices are about the workspace itself, and `subject_id` is null for them because `workspace_id`
 * already says which one. Modelling that as "no subject" would make the left rail's per-agent
 * breakdown have to distinguish "about nothing" from "about the workspace".
 */
export type InboxSubjectType = "agent" | "mcp_server" | "deployment" | "eval" | "user" | "workspace";

/**
 * How a row comes to exist, which decides who writes it.
 *
 * `event`   — something already happened and something already emitted it. A run failed, a deploy
 *             failed, an eval finished, an MCP server changed status, an edit was applied. These
 *             upsert on `dedupe_key` from the handler that is already there. §6.2 is explicit that
 *             the frozen event schema gains nothing for this: we subscribe to what the control
 *             plane already emits.
 * `derived` — nothing emits it, because it is a comparison between two states that are both simply
 *             true. A credential is missing; a deployed version is behind; a server has been
 *             unreachable for a day; spend is three times its own average; a grant is ungated. The
 *             reconciler computes these from one aggregate pass and no event exists to hang them on.
 * `seed`    — written once when a workspace is new (§2.5), and resolved by the thing actually being
 *             done. Never re-raised, because its predicate can only go one way.
 */
export type InboxOrigin = "event" | "derived" | "seed";

/**
 * Every action a card can offer, as one vocabulary.
 *
 * NAMES RATHER THAN HANDLERS, because half of these are commands this socket already has —
 * `setSecret`, `deploy`, `rediscoverMcpServer`, `setMcpToolImpact` — and §6.4 is explicit that the
 * inline resolve path reuses them rather than reimplementing them behind new names. What travels on
 * the wire is which actions a card offers; what each one DOES is the command the client already
 * knows how to send.
 *
 * `dismiss` IS IN THIS LIST RATHER THAN BEING A PROPERTY OF EVERY CARD, and that is the catalog's
 * own decision: `mcp_auth_required`, `deploy_failed`, `mcp_unreachable` and `memory_proposal` do not
 * offer it. A server whose credential has expired does not stop needing one because somebody looked
 * away, and a proposal is answered rather than ignored. The `×` on a card renders only when this
 * appears in its action set.
 */
export type InboxActionName =
  // Blocking
  | "set_secret"
  | "open_agent"
  | "set_mcp_credential"
  | "rediscover"
  | "remove_server"
  | "view_logs"
  | "retry_deploy"
  | "cancel_deploy"
  | "raise_ceiling"
  | "view_results"
  // Attention
  | "open_latest_failure"
  | "view_all_failures"
  | "dismiss_all"
  | "redeploy"
  | "view_diff"
  | "open_comparison"
  | "export_results"
  | "view_usage"
  | "set_budget"
  // Proposals
  | "view_evidence"
  | "save_memory"
  | "reject_memory"
  | "enable_gate"
  | "remove_grant"
  // Team
  | "open_invites"
  | "open_members"
  | "restore_agent"
  // Onboarding
  | "open_providers"
  | "new_agent"
  // Everywhere it is offered at all
  | "dismiss";

/**
 * The icon a type wears, by name.
 *
 * A NAME AND NOT A COMPONENT, because this file runs on the server and the SVG lives in the client.
 * The client's `inboxIcons.tsx` maps each of these onto one drawing at the app's one stroke weight,
 * and a name with no drawing is a compile error there rather than a blank square here.
 */
export type InboxIconName =
  | "key"
  | "plug"
  | "rocket"
  | "wallet"
  | "alert"
  | "drift"
  | "flask"
  | "unplugged"
  | "spike"
  | "memory"
  | "shield"
  | "invite"
  | "person"
  | "trash"
  | "spark";

/** The sixteen. A union rather than a string, so a typo is a compile error at every call site. */
export type InboxItemType =
  // §2.1 Blocking — work is stopped
  | "credential_missing"
  | "mcp_auth_required"
  | "deploy_failed"
  | "budget_ceiling_hit"
  // §2.2 Attention — you should look
  | "unreviewed_failures"
  | "version_drift"
  | "eval_finished"
  | "mcp_unreachable"
  | "cost_anomaly"
  // §2.3 Proposals — Jaroku is asking
  | "memory_proposal"
  | "ungated_high_impact"
  // §2.4 Team — Team workspaces only
  | "invite_pending"
  | "member_joined"
  | "agent_deleted_by_other"
  // §2.5 Onboarding — a new workspace is not an empty one
  | "setup_api_key"
  | "setup_first_agent";

/**
 * What a payload may hold.
 *
 * §6.5's discipline expressed as a type: names, ids, counts and short summaries. There is no shape
 * here a credential VALUE could take that a name could not, which is the honest limit of what a type
 * can promise — the guarantee itself is `boundPayload` in `payload.ts`, which every write goes
 * through, and the suite that asserts a known secret cannot reach one.
 */
export type InboxPayloadValue = string | number | boolean | null | readonly string[];
export type InboxPayload = Readonly<Record<string, InboxPayloadValue>>;

/** One row, as the predicates read it. The store's own type, restated with only what they need. */
export interface InboxItemFacts {
  type: InboxItemType;
  subject_id: string | null;
  payload: InboxPayload;
  first_seen_at: string;
  last_seen_at: string;
}

// --- the facts a predicate is allowed to ask about ---------------------------------------------
//
// ONE AGGREGATE PASS, ASSEMBLED BY THE RECONCILER, HANDED TO EVERY PREDICATE. §6.2 requires the
// sweep to be cheap — one pass per workspace, not one query per agent, with a test asserting the
// query count is constant in the number of agents — and the only way a predicate can be part of that
// is if it cannot reach a database at all. So it gets a value.
//
// EVERY MAP IS KEYED BY THE ID THE ROW CARRIES, so a predicate is a lookup rather than a scan. That
// is not a micro-optimisation: this runs once per open item per sweep, and a linear search inside it
// would make the sweep quadratic in exactly the workspace it matters for.

/** One agent, as every predicate about an agent needs it. */
export interface AgentInboxFacts {
  uuid: string;
  slug: string;
  name: string;
  /** Environment names the agent's manifest declares. Names, never values. */
  requiredEnv: readonly string[];
  currentVersion: number;
  /** The version a LIVE deployment is serving, or null — see `driftOf` for why the three nulls. */
  deployedVersion: number | null;
  /** When the newest LIVE deployment of this agent landed, ISO. Null when nothing is serving. */
  liveDeployAt: string | null;
  /** `server/tool` refs this agent holds that the registry classifies as high impact. */
  highImpactTools: readonly string[];
  /**
   * Whether a high-impact call on this agent actually stops for confirmation.
   *
   * FALSE IS THE GAP v0.2.1 RECORDED OPENLY: generated agent code can set the environment variable
   * that disables the bridge's confirmation gate. Surfacing it here is not a substitute for the
   * validation rule that release said was needed, and `ungated_high_impact`'s copy must not imply
   * that it is.
   */
  confirmGateEnabled: boolean;
  /** Spend over the anomaly window, or null when nothing has been spent. */
  spendUsd: number | null;
  /** The trailing 7-day rolling average this window is compared against, or null. */
  trailingAvgUsd: number | null;
  /**
   * False when anything this agent ran used a model with no pricing entry.
   *
   * THE EXCLUSION §2.2 INSISTS ON. v0.1.9 established that unknown is not zero, and an agent whose
   * model has no price would otherwise sit at a $0 baseline that everything spikes against. Such an
   * agent is out of anomaly detection entirely rather than being compared against a lie.
   */
  pricingKnown: boolean;
  archivedAt: string | null;
}

/** One MCP server, as the two MCP predicates need it. */
export interface McpInboxFacts {
  id: string;
  name: string;
  status: "connected" | "unreachable" | "auth_required" | "error" | "pending";
  /** When the current status was last written, ISO. What §2.2's "over 24 hours" is measured from. */
  statusSince: string;
}

export interface InboxFacts {
  /** The sweep's own clock, passed in so a predicate has none of its own and a test can move it. */
  now: number;
  /** Every credential name in this workspace with a value actually behind it (`configured`). */
  configuredSecrets: ReadonlySet<string>;
  agents: ReadonlyMap<string, AgentInboxFacts>;
  mcpServers: ReadonlyMap<string, McpInboxFacts>;
  /** The workspace's spend ceiling in USD, or null when there is none. */
  spendCeilingUsd: number | null;
  /** Invitations still awaiting an answer, by invite id. */
  pendingInvites: ReadonlySet<string>;
  /** Members of this workspace, by user id. A member who left is simply absent. */
  memberIds: ReadonlySet<string>;
  /** True when this workspace has at least one configured provider credential. */
  hasProviderKey: boolean;
  /** How many agents exist, archived included. Zero is what `setup_first_agent` waits on. */
  agentCount: number;
  /** Team workspaces show §2.4's three types; Personal ones hide them entirely. */
  team: boolean;
}

// --- the table ---------------------------------------------------------------------------------

export interface InboxTypeDef {
  type: InboxItemType;
  severity: InboxSeverity;
  /** Null for the two types whose subject is a name in a payload rather than a row. */
  subject: InboxSubjectType;
  origin: InboxOrigin;
  icon: InboxIconName;
  /** Team workspaces only (§2.4). Hidden entirely in Personal — not greyed, not empty: absent. */
  teamOnly: boolean;
  /**
   * In order, primary first. §7: the primary action is an ICON and the rest live in the overflow,
   * so the order here is the order the card renders and the first entry is the one on the row.
   */
  actions: readonly InboxActionName[];
  /**
   * What §4.4's subject line says, from the payload.
   *
   * ON THE SERVER RATHER THAN IN THE CLIENT, for the same reason `ThreadView.fragment` is: the
   * sentence is a decision about which fact matters, and two surfaces deriving it independently is
   * how they end up disagreeing. The client renders the string and decides nothing.
   */
  subjectLine(payload: InboxPayload): string;
  /**
   * Is the underlying problem fixed?
   *
   * TRUE MEANS THE ROW LEAVES THE BOARD. Evaluated by the reconciler against facts it gathered
   * without ever seeing what the user did, which is Law 2 in one sentence. A predicate that reads
   * a field only an action on the item itself can set — `memory_proposal`'s decision, for instance —
   * says so at its own entry, because that is a real exception and not the default.
   */
  resolved(item: InboxItemFacts, facts: InboxFacts): boolean;
}

/**
 * §2.2's window: an MCP server has to have been unreachable for this long before it is worth saying.
 *
 * A DAY, because a server that is unreachable for ten minutes is a network, and one unreachable for
 * a day is a decision somebody made without telling this workspace. Anything shorter would put a
 * card on the board every time a third party restarted.
 */
export const MCP_UNREACHABLE_AFTER_MS = 24 * 60 * 60 * 1000;

/** §2.2's multiple: spend at or above this times the trailing average is an anomaly. */
export const COST_ANOMALY_MULTIPLE = 3;

/** §2.2: how long spend has to have been normal again before the anomaly is over. */
export const COST_NORMAL_FOR_MS = 48 * 60 * 60 * 1000;

/**
 * How long a team NOTICE stands before it is history rather than news.
 *
 * §2.4 gives resolve conditions for none of its three, and two of them genuinely have no external
 * condition to wait for: nothing in the world changes when you have finished noticing that somebody
 * joined. The honest reading of Law 2 for those is that they age out — an arrival stops being news,
 * and a deletion somebody has had a week to notice is the record rather than the inbox. Stated as a
 * constant rather than buried in two predicates so it is one decision.
 */
export const TEAM_NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Read a payload string, or the empty string. Predicates must not throw. */
const str = (p: InboxPayload, key: string): string => (typeof p[key] === "string" ? (p[key] as string) : "");

/** Read a payload number, or null. `0` is a real answer and must survive. */
const num = (p: InboxPayload, key: string): number | null =>
  typeof p[key] === "number" && Number.isFinite(p[key] as number) ? (p[key] as number) : null;

/** Read a payload string list, or an empty one. */
const list = (p: InboxPayload, key: string): readonly string[] =>
  Array.isArray(p[key]) ? ((p[key] as readonly unknown[]).filter((v) => typeof v === "string") as string[]) : [];

/** Milliseconds since an ISO timestamp, or Infinity for one that cannot be read. */
const ageMs = (facts: InboxFacts, iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? facts.now - t : Number.POSITIVE_INFINITY;
};

const DEFS: Record<InboxItemType, InboxTypeDef> = {
  // --- §2.1 blocking ---------------------------------------------------------------------------

  credential_missing: {
    type: "credential_missing",
    severity: "blocking",
    subject: "agent",
    origin: "derived",
    icon: "key",
    teamOnly: false,
    // The inline form first, because §4.5's whole goal is that a board can be cleared without
    // leaving it and this is the type most able to honour it.
    actions: ["set_secret", "open_agent", "dismiss"],
    // `credential` is the NAME. There is no field on this payload a value could be in.
    subjectLine: (p) => `${str(p, "agent_name") || "An agent"} needs ${str(p, "credential")}`,
    // `configured` IS THE TEST AND NOT EXISTENCE. `secret_refs` holds a row for every name any agent
    // has ever DECLARED, with `configured` false until a value actually landed in the vault — so a
    // membership test against the table would resolve this item the moment the agent was generated,
    // which is the exact moment it should be raised.
    resolved: (item, facts) => facts.configuredSecrets.has(str(item.payload, "credential")),
  },

  mcp_auth_required: {
    type: "mcp_auth_required",
    severity: "blocking",
    subject: "mcp_server",
    origin: "event",
    icon: "plug",
    teamOnly: false,
    // No `dismiss`. A server that cannot authenticate does not stop needing a credential because
    // somebody looked away, and the two exits are giving it one or removing it.
    actions: ["set_mcp_credential", "rediscover", "remove_server"],
    subjectLine: (p) => `${str(p, "server_name") || "An MCP server"} needs a credential`,
    // A SERVER THAT IS GONE RESOLVES THIS, which is the second exit the action set offers. Reading
    // "absent" as "unresolved" would leave a permanent card pointing at a server this workspace
    // removed precisely in order to be rid of it.
    resolved: (item, facts) => {
      const server = item.subject_id ? facts.mcpServers.get(item.subject_id) : undefined;
      return !server || server.status === "connected";
    },
  },

  deploy_failed: {
    type: "deploy_failed",
    severity: "blocking",
    subject: "deployment",
    origin: "event",
    icon: "rocket",
    teamOnly: false,
    actions: ["view_logs", "retry_deploy", "cancel_deploy"],
    subjectLine: (p) => `Deploying ${str(p, "agent_name") || "an agent"} failed`,
    // A LATER SUCCESSFUL DEPLOY OF THAT AGENT, which is what §2.1 asks for and is not the same as
    // "the agent has a live deployment". A deploy that failed on Tuesday is not resolved by one that
    // succeeded on Monday and is still serving — the comparison has to be against when THIS failure
    // happened, which is why the timestamp is read rather than the boolean.
    resolved: (item, facts) => {
      const agent = facts.agents.get(str(item.payload, "agent_uuid"));
      if (!agent) return true; // The agent is gone; a failed deploy of nothing is not waiting on anybody.
      if (!agent.liveDeployAt) return false;
      return Date.parse(agent.liveDeployAt) > Date.parse(item.first_seen_at);
    },
  },

  budget_ceiling_hit: {
    type: "budget_ceiling_hit",
    severity: "blocking",
    subject: "eval",
    origin: "event",
    icon: "wallet",
    teamOnly: false,
    actions: ["raise_ceiling", "view_results", "dismiss"],
    // THE COPY MUST NOT CLAIM THE EVAL STOPPED DEAD. v0.1.9 documented the limit plainly: a ceiling
    // bounds what gets STARTED, never what is already running, and jobs in flight when it was
    // crossed ran to completion. "stopped starting new jobs" is the true sentence and it is the one
    // rendered, because a card that said "the eval was halted" would be teaching somebody a wrong
    // model of their own bill.
    subjectLine: (p) =>
      `An eval hit the $${(num(p, "ceiling_usd") ?? 0).toFixed(2)} ceiling and stopped starting new jobs`,
    // RAISED, OR REMOVED. `acknowledged` is the other exit §2.1 names and it is a DISMISSAL, which is
    // per user and is not this predicate's business — a shared row resolved by one person's
    // acknowledgement would clear the board of a teammate who has not seen it.
    resolved: (item, facts) => {
      const hit = num(item.payload, "ceiling_usd");
      if (hit === null) return false;
      return facts.spendCeilingUsd === null || facts.spendCeilingUsd > hit;
    },
  },

  // --- §2.2 attention --------------------------------------------------------------------------

  unreviewed_failures: {
    type: "unreviewed_failures",
    severity: "attention",
    subject: "agent",
    origin: "event",
    icon: "alert",
    teamOnly: false,
    actions: ["open_latest_failure", "view_all_failures", "dismiss_all"],
    subjectLine: (p) => `${str(p, "agent_name") || "An agent"} is failing and nobody has looked`,
    // ANY ONE OF THOSE TRACES BEING OPENED, recorded ON THE ROW rather than read out of a set of
    // reviewed run ids the sweep is handed. Both spellings look the same from here and only one of
    // them survives a deploy: this process could remember which traces were opened, and a restart
    // would empty that memory, the sweep would conclude nothing had been reviewed, and every card
    // somebody dealt with last week would come back. Law 2 promises a fixed problem stays gone, and
    // a fact that does not outlive a restart cannot keep that promise. `loadRun` writes the stamp —
    // from the sidebar, the health sparkline, the palette or a deep link, none of which is this
    // card — and the sweep is still the only thing that resolves the row.
    resolved: (item) => str(item.payload, "reviewed_at") !== "",
  },

  version_drift: {
    type: "version_drift",
    severity: "attention",
    subject: "agent",
    origin: "derived",
    icon: "drift",
    teamOnly: false,
    actions: ["redeploy", "view_diff", "dismiss"],
    subjectLine: (p) =>
      `${str(p, "agent_name") || "An agent"} is serving v${num(p, "deployed") ?? "?"}, current is v${num(p, "current") ?? "?"}`,
    // THE PAIR, NOT THE FACT. §2.2 requires dismissal to be scoped to that version pair so publishing
    // a newer version raises it again, and the mechanism is the dedupe key: a new pair is a new row,
    // which the old dismissal does not cover. What that costs is this predicate — the old row has to
    // resolve when the pair moves on, or the board carries one card per version anybody ever
    // published.
    resolved: (item, facts) => {
      const agent = facts.agents.get(item.subject_id ?? "");
      if (!agent || agent.deployedVersion === null) return true; // Nothing deployed: nothing to drift.
      if (agent.deployedVersion >= agent.currentVersion) return true;
      return (
        agent.deployedVersion !== num(item.payload, "deployed") ||
        agent.currentVersion !== num(item.payload, "current")
      );
    },
  },

  eval_finished: {
    type: "eval_finished",
    severity: "attention",
    subject: "eval",
    origin: "event",
    icon: "flask",
    teamOnly: false,
    actions: ["open_comparison", "export_results", "dismiss"],
    subjectLine: (p) => `${str(p, "dataset_name") || "An eval"} finished`,
    // RESULTS OPENED, stamped on the row by the one path into a comparison — `loadEvalResults` —
    // however somebody arrived at it. Opening it from the Evals tab clears this card, which is Law
    // 2's whole point. Durable for the reason `unreviewed_failures` is: see its predicate.
    resolved: (item) => str(item.payload, "opened_at") !== "",
  },

  mcp_unreachable: {
    type: "mcp_unreachable",
    severity: "attention",
    subject: "mcp_server",
    origin: "derived",
    icon: "unplugged",
    teamOnly: false,
    // No dismiss, for the reason `mcp_auth_required` has none.
    actions: ["rediscover", "remove_server"],
    subjectLine: (p) => `${str(p, "server_name") || "An MCP server"} has been unreachable for a day`,
    resolved: (item, facts) => {
      const server = item.subject_id ? facts.mcpServers.get(item.subject_id) : undefined;
      return !server || server.status === "connected";
    },
  },

  cost_anomaly: {
    type: "cost_anomaly",
    severity: "attention",
    subject: "agent",
    origin: "derived",
    icon: "spike",
    teamOnly: false,
    actions: ["view_usage", "set_budget", "dismiss"],
    subjectLine: (p) =>
      `${str(p, "agent_name") || "An agent"} is spending ${(num(p, "multiple") ?? 0).toFixed(1)}× its usual`,
    // NORMALISED FOR 48 HOURS, WHICH NEEDS A MEMORY. "Is it normal right now" would clear the card
    // the first quiet hour and raise it again the next busy one, which is a card that flickers rather
    // than a statement about a week. The derived pass writes `normal_since` when the ratio drops and
    // clears it when the ratio comes back, so this reads one timestamp — and an agent with no pricing
    // is excluded from the whole rule upstream and therefore never reaches here with a lie in it.
    resolved: (item, facts) => {
      const since = str(item.payload, "normal_since");
      if (!since) return false;
      return ageMs(facts, since) >= COST_NORMAL_FOR_MS;
    },
  },

  // --- §2.3 proposals --------------------------------------------------------------------------

  memory_proposal: {
    type: "memory_proposal",
    severity: "proposal",
    subject: "agent",
    origin: "event",
    icon: "memory",
    teamOnly: false,
    // No dismiss: a proposal is answered. Saving it and rejecting it are the two answers, and
    // ignoring it is what snooze is for.
    actions: ["view_evidence", "save_memory", "reject_memory"],
    subjectLine: (p) => `Jaroku learned something about ${str(p, "agent_name") || "an agent"}`,
    // THE ONE PREDICATE THAT READS A DECISION MADE ON THE ITEM ITSELF, and it is stated here rather
    // than left to be noticed. §2.3 gives "accepted or rejected" as the resolve condition, and there
    // is no external world in which a proposal becomes answered — the answer IS the action. That
    // makes it a genuine exception to Law 2's shape rather than a shortcut: everything else here
    // resolves from facts nobody in this product had to touch.
    resolved: (item) => {
      const decision = str(item.payload, "decision");
      return decision === "saved" || decision === "rejected";
    },
  },

  ungated_high_impact: {
    type: "ungated_high_impact",
    severity: "proposal",
    subject: "agent",
    origin: "derived",
    icon: "shield",
    teamOnly: false,
    actions: ["enable_gate", "remove_grant", "dismiss"],
    // THE COPY MUST NOT IMPLY THIS CLOSES THE GAP. v0.2.1 recorded openly that generated agent code
    // can set the environment variable that disables the confirmation gate, and said a validation
    // rule was needed. Surfacing the state is not that rule. "is not gated" is a statement about
    // what is true; "is now safe" would be a claim this feature has not earned.
    subjectLine: (p) =>
      `${str(p, "agent_name") || "An agent"} can call ${list(p, "tools").length} high-impact tool(s) without confirmation`,
    resolved: (item, facts) => {
      const agent = facts.agents.get(item.subject_id ?? "");
      if (!agent) return true;
      return agent.confirmGateEnabled || agent.highImpactTools.length === 0;
    },
  },

  // --- §2.4 team -------------------------------------------------------------------------------

  invite_pending: {
    type: "invite_pending",
    severity: "attention",
    subject: "user",
    origin: "event",
    icon: "invite",
    teamOnly: true,
    actions: ["open_invites", "dismiss"],
    subjectLine: (p) => `${str(p, "email") || "Somebody"} has not accepted their invitation`,
    // ACCEPTED, REVOKED OR EXPIRED all read the same way from here: the invitation is no longer
    // pending. An invitation that expires on its own clock is the case a predicate written as
    // "accepted" would miss, and it is the common one.
    resolved: (item, facts) => !item.subject_id || !facts.pendingInvites.has(item.subject_id),
  },

  member_joined: {
    type: "member_joined",
    severity: "proposal",
    subject: "user",
    origin: "event",
    icon: "person",
    teamOnly: true,
    actions: ["open_members", "dismiss"],
    subjectLine: (p) => `${str(p, "name") || "Somebody"} joined this workspace`,
    // TWO WAYS OUT, AND NEITHER IS A BUTTON. They left, or the arrival has stopped being news — see
    // TEAM_NOTICE_TTL_MS for why a notice with no external condition ages out rather than standing
    // forever waiting for somebody to acknowledge it.
    resolved: (item, facts) =>
      !item.subject_id ||
      !facts.memberIds.has(item.subject_id) ||
      ageMs(facts, item.first_seen_at) >= TEAM_NOTICE_TTL_MS,
  },

  agent_deleted_by_other: {
    type: "agent_deleted_by_other",
    severity: "attention",
    subject: "agent",
    origin: "event",
    icon: "trash",
    teamOnly: true,
    actions: ["restore_agent", "dismiss"],
    // THE ITEM EXISTS BECAUSE DELETION IN A TEAM WORKSPACE IS COLLABORATIVE. The confirmation dialog
    // names the creator as a safety net, and this is the other half of that net: if somebody else
    // archives an agent you created, you find out here rather than by looking for it.
    subjectLine: (p) => `${str(p, "actor_name") || "Somebody"} archived ${str(p, "agent_name") || "an agent"} you created`,
    resolved: (item, facts) => {
      const agent = facts.agents.get(item.subject_id ?? "");
      // It came back — the action on this card, or a restore from anywhere else.
      if (agent && agent.archivedAt === null) return true;
      return ageMs(facts, item.first_seen_at) >= TEAM_NOTICE_TTL_MS;
    },
  },

  // --- §2.5 onboarding -------------------------------------------------------------------------
  //
  // REAL ITEMS WITH REAL RESOLVE CONDITIONS, not decoration. A brand-new workspace with a genuinely
  // empty Inbox is confusing rather than delightful, and the two things a new workspace actually has
  // to do are the two things these wait on. They resolve the moment the thing is done — from the
  // onboarding flow, from the Secrets tab, from a script — and, because they are seeded once per
  // workspace on a stable dedupe key, a resolved one is never raised again.

  setup_api_key: {
    type: "setup_api_key",
    severity: "blocking",
    subject: "workspace",
    origin: "seed",
    icon: "key",
    teamOnly: false,
    actions: ["open_providers"],
    subjectLine: () => "Add a provider key to start building",
    resolved: (_item, facts) => facts.hasProviderKey,
  },

  setup_first_agent: {
    type: "setup_first_agent",
    severity: "proposal",
    subject: "workspace",
    origin: "seed",
    icon: "spark",
    teamOnly: false,
    actions: ["new_agent"],
    subjectLine: () => "Describe your first agent",
    // ARCHIVED ONES COUNT. Somebody who built an agent and put it away has started; asking them to
    // build their first one again would be the product forgetting what they did.
    resolved: (_item, facts) => facts.agentCount > 0,
  },
};

/** Every type, in catalog order. What a count should be read from — see the header. */
export const INBOX_TYPES = Object.keys(DEFS) as InboxItemType[];

export function isInboxItemType(v: unknown): v is InboxItemType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DEFS, v);
}

/**
 * The one lookup.
 *
 * THROWS ON AN UNKNOWN TYPE rather than returning undefined, and that is what makes the absence of a
 * CHECK constraint on `inbox_items.type` safe: every write goes through the store, the store asks
 * this, and a type nothing has defined cannot reach a row. A silent undefined here would be a row
 * with no severity, no actions and no way to leave the board.
 */
export function inboxType(type: InboxItemType): InboxTypeDef {
  const def = DEFS[type];
  if (!def) throw new Error(`[inbox] no such item type: ${String(type)}`);
  return def;
}

/**
 * Is this item still true?
 *
 * The generic sweep's whole body. `reconciler.ts` loops open rows and calls this; nothing anywhere
 * else may decide that an item is resolved, which is what stops a predicate being written twice and
 * the two copies disagreeing.
 */
export function isResolved(item: InboxItemFacts, facts: InboxFacts): boolean {
  return inboxType(item.type).resolved(item, facts);
}

/**
 * The dedupe key for one item, which is Law 3 expressed as a string.
 *
 * TYPE PLUS SUBJECT PLUS WHATEVER ELSE MAKES TWO OCCURRENCES THE SAME OCCURRENCE. Forty failed runs
 * of one agent share a key and become one row with a count of forty; two agents failing are two keys
 * and two rows, because they are two problems. The discriminator is what `version_drift` uses to make
 * a dismissal version-scoped and what `credential_missing` uses to keep one card per missing NAME
 * rather than one per agent.
 *
 * `:` IS THE SEPARATOR AND THE PARTS ARE IDS, so a key is stable across restarts and across replicas
 * — the constraint is only worth anything if the same problem produces the same string every time.
 */
export function dedupeKey(
  type: InboxItemType,
  subjectId: string | null,
  discriminator?: string,
): string {
  const parts = [type, subjectId ?? "workspace"];
  if (discriminator) parts.push(discriminator);
  return parts.join(":");
}

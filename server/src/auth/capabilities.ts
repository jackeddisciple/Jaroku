// What each role may do, as data.
//
// The alternative — `if (ctx.role !== "owner")` scattered across fifty command handlers — is
// how you get a hole, and the hole is always in the handler nobody thought about. So there is
// one table here, one function that reads it, and a test that fails when a command is added
// without an entry. Whether a capability is right is then a decision somebody makes while
// looking at every other capability, rather than a line typed while thinking about something
// else.
//
// THE ROLES ARE NESTED, and expressed that way rather than by copying lists. An owner can do
// everything an admin can; an admin everything a member can. Written as three independent
// arrays, the day somebody adds a member capability and forgets to add it to the other two is
// the day admins stop being able to do something members can, and nothing says so.
//
// `system` IS NOT A MEMBERSHIP ROLE. It is the role a REQUEST has when nobody triggered it —
// the startup reconciliations, the checkpoint sweeper, an eval job draining in the background.
// It holds every capability because it is the server acting on its own behalf, and it can
// never arrive from a client: it is minted by `systemContextFor` in code, and the resolver in
// resolve.ts only ever produces `owner`, `admin` or `member` from a membership row.
//
// THE SPLIT BETWEEN member AND admin follows one question: does this change what the WORKSPACE
// is, or what is IN it? Building, running, editing and evaluating agents is the product, and
// every member does it. Connecting a third-party MCP server, storing a provider key, or
// putting an agent on a public URL commits the whole workspace to something — money, an
// external dependency, an internet-facing endpoint — and those are admin. Membership and the
// existence of the workspace itself are the owner's.

import { forbidden } from "../http/router.ts";
import type { Role, TenantContext } from "../db/tenant.ts";

export const CAPABILITIES = [
  // --- the product itself: every member does these ---------------------------------------
  /** Read runs, traces, agent files, the graph, and ask for an explanation. */
  "agent:read",
  /** Plan, generate, edit, apply, undo. Nothing here reaches outside the workspace. */
  "agent:write",
  /** Start a run, and pause / resume / branch it. */
  "run:execute",
  /** Answer a high-impact MCP confirmation. Whoever is watching a run must be able to. */
  "mcp:confirm",
  "eval:read",
  "eval:write",
  /** Start or cancel an eval. Spends money under BYOK, which the budget ceiling bounds. */
  "eval:run",
  "mcp:read",
  "provider:read",
  /**
   * List the workspace's credentials as METADATA: names, kinds, masks, health, where each is used.
   *
   * A member capability, and the elevation gate is what actually holds this back — the two answer
   * different questions. A capability asks "is this person entitled to this class of thing at
   * all"; elevation asks "is it still them, right now". Making this admin-only would not remove
   * the need for elevation, and would stop a member seeing that the credential their own agent
   * depends on is the one that expired.
   *
   * It carries no value and cannot: nothing under this capability reaches a plaintext credential.
   */
  "secret:read",
  /** See what this workspace has connected, and which connection needs reconnecting. */
  "connector:read",
  "deploy:read",
  /** See where an agent's code is pushed, and how far the two lineages have drifted. */
  "github:read",
  "member:read",
  /**
   * See what this workspace has spent, and against which ceiling.
   *
   * A MEMBER capability, not an owner one, and that is a decision rather than an oversight. A
   * member whose run is refused for budget has to be able to see the number it was refused
   * against, or the refusal is unactionable and they open a ticket. Spend is not a secret from
   * the people generating it; CHANGING what may be spent is `billing:manage`, which is the
   * owner's.
   */
  "billing:read",
  /**
   * See which rung of the abuse ladder this workspace is under, and answer it.
   *
   * ONE CAPABILITY FOR THE READ AND THE APPEAL, and a MEMBER's, which is two decisions worth
   * stating. A member's, for the reason `billing:read` is a member's: the rung is what refused their
   * work, and a refusal nobody affected may read is unactionable. One capability, because the
   * repository's own doc is explicit that the appeal has to be available to the workspace rather
   * than to the party that applied the rung — a split where a member could read the sentence and
   * only an owner could answer it would reintroduce exactly the asymmetry the column exists to
   * remove, in a workspace whose owner may be the person on holiday.
   *
   * It does not lift anything. An appeal is a note a human reads; `lift` is not a capability any
   * role in this table holds, because it is the platform's.
   */
  "enforcement:appeal",

  // --- commits the workspace to something outside itself: admin ---------------------------
  /** Connect, re-discover, remove or re-classify a third-party MCP server. */
  "mcp:manage",
  /** Store or test a model-provider API key. */
  "provider:manage",
  /**
   * Add, rotate, revoke or reveal a credential.
   *
   * ADMIN, by the rule the header states: does this change what the workspace IS, or what is in
   * it? Storing a credential commits the whole workspace to something, exactly as
   * `provider:manage` and `connector:manage` do — and revoking one can break every deployed agent
   * that reads it, which is not a lesser act than adding it.
   */
  "secret:manage",
  /**
   * Connect or disconnect a third-party account on the workspace's behalf.
   *
   * Admin for the same reason `mcp:manage` is, and rather more so: connecting Gmail points every
   * agent in the workspace at one person's mailbox, and the grant is made against THEIR account.
   * A member who could do that could have an agent read the founder's mail by clicking a button
   * and signing in as themselves. Disconnecting is the same capability, not a lesser one — the
   * ability to break every agent that depends on a connection is not a read.
   */
  "connector:manage",
  /** Put an agent on a public URL in the workspace's own hosting account. */
  "deploy:manage",
  /**
   * Link an agent to a repository, push to it, pull from it, or override a refusal.
   *
   * ADMIN, by the rule the header states, and it is the clearest case of it in the table: a push
   * writes this workspace's source code into an account outside the workspace, and a LINK decides
   * which account that is. The read is a member's — somebody debugging an agent has to be able to
   * see where its code went — but choosing the destination is committing the workspace to
   * something, in the same sense `connector:manage` and `deploy:manage` are.
   */
  "github:manage",

  // --- what the workspace IS: owner --------------------------------------------------------
  /** Invite, remove, and change roles. */
  "member:manage",
  "workspace:manage",
  /** Session 6's surface. Named now so the matrix does not have to be reopened for it. */
  "billing:manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Everything a member may do. The floor for every other role. */
const MEMBER: readonly Capability[] = [
  "agent:read",
  "agent:write",
  "run:execute",
  "mcp:confirm",
  "eval:read",
  "eval:write",
  "eval:run",
  "mcp:read",
  "provider:read",
  "secret:read",
  "connector:read",
  "deploy:read",
  "github:read",
  "member:read",
  "billing:read",
  "enforcement:appeal",
];

/** What an admin adds. Nested, so a new member capability is automatically an admin's too. */
const ADMIN: readonly Capability[] = [
  ...MEMBER, "mcp:manage", "provider:manage", "secret:manage", "connector:manage", "deploy:manage",
  "github:manage",
];

const OWNER: readonly Capability[] = [...ADMIN, "member:manage", "workspace:manage", "billing:manage"];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  member: MEMBER,
  admin: ADMIN,
  owner: OWNER,
  // The server acting on its own behalf. Never resolvable from a membership row.
  system: CAPABILITIES,
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

// --- the same idea, one level down: what may this person do to THIS agent ----------------------
//
// EVERYTHING ABOVE IS ABOUT A WORKSPACE and answers "may this person deploy". Everything below is
// about ONE AGENT and answers "may this person deploy THIS". They are the same mechanism at two
// scopes — data, read in one place, with a test that fails when something is added without a
// decision — and they are deliberately in one file rather than two.
//
// THAT IS THE WHOLE POINT AND IT IS WORTH BEING BLUNT ABOUT. The value of the table above was
// never the table; it was that there is exactly ONE of it. A second file with a second vocabulary
// and a second `can` would be two tables that drift, and the one that drifts OPEN is the one
// nobody notices — a `canUserDoX` somewhere that says yes where this says no is not a bug anybody
// reports, because nothing fails. So per-agent access is an extension of this matrix, checked by
// the same resolver, and there is no second checker anywhere in the codebase.
//
// A SEPARATE VOCABULARY, THOUGH, and that is not a contradiction. `agent:write` is a statement
// about a workspace — may this person build agents here at all — and `edit` is a statement about
// one agent. Collapsing them into one list would mean either a workspace capability that is
// sometimes agent-scoped, or seven more strings in a list whose every existing member means
// something workspace-wide. Two vocabularies, one resolver.

/**
 * The seven, in the order the panel renders them: widening authority, left to right.
 *
 * NAMED WITHOUT A PREFIX, unlike the workspace capabilities above. `deploy` rather than
 * `agent:deploy`, because the noun is already fixed by the function that asks —
 * `resolveCapabilities(ctx, agentId)` takes the agent — and a prefix repeating it would be
 * decoration. It also makes the two vocabularies impossible to confuse at a call site, which is
 * the property that matters most: `can(role, "deploy:manage")` and `holds(set, "deploy")` cannot
 * be mistyped into each other.
 */
export const AGENT_CAPABILITIES = [
  /** See the agent at all: its graph, its trace, its versions, its history. */
  "view",
  /** Execute it, and pause, resume, branch or answer a confirmation on a run. */
  "run",
  /** Change its code — plan, generate, apply an edit, undo one. */
  "edit",
  /** Start and cancel evaluations, and edit the datasets they run against. */
  "eval",
  /** Put it on a public URL, or take it down. */
  "deploy",
  /** Manage the credentials scoped to this agent. */
  "secrets",
  /** Manage who may do any of the above to this agent. Everything in the Access tab. */
  "admin",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export function isAgentCapability(v: unknown): v is AgentCapability {
  return typeof v === "string" && (AGENT_CAPABILITIES as readonly string[]).includes(v);
}

/**
 * What each capability drags in with it, as data.
 *
 * IMPLICATION IS IN THE TABLE AND NOT IN A CHECKBOX HANDLER, which is the one structural decision
 * in this block. The grant dialog has to apply these rules while somebody is ticking boxes — check
 * `edit` and `run` lights up; untick `view` and everything goes out — and the obvious place to put
 * that is the handler, where it is a rule about a form. Then the resolver applies its own closure
 * server-side, from a second copy, and the two disagree the first time one is edited: the dialog
 * shows a set the server will not honour, or honours one the dialog never showed. So there is one
 * table, the closure is a function over it, and the dialog calls that function.
 *
 * THE THREE NON-IMPLICATIONS ARE THE INTERESTING ENTRIES, and each is a decision rather than an
 * omission:
 *
 *   `secrets` does not imply `edit`, and `edit` does not imply `secrets`. A contractor who writes
 *   an agent's code and a person who holds the production credentials it runs on are genuinely
 *   different roles, and a product that could not express the difference would have one of them
 *   holding the other's authority in every workspace that hired either.
 *
 *   `admin` does not imply `secrets`. Managing who has access is not the same as holding the keys,
 *   and the person who administers access is precisely the one who should not silently acquire
 *   them by being made an administrator.
 *
 *   `admin` does not imply `edit`, `run`, `deploy` or `eval` either. An access administrator who
 *   automatically became able to publish is an escalation with one click and no record of it.
 */
const AGENT_IMPLIES: Record<AgentCapability, readonly AgentCapability[]> = {
  // There is no such thing as "can deploy but cannot see", so every other capability names this
  // one. Written on each of them rather than as a special case in the closure, because a special
  // case is a rule the dialog would have to know about separately.
  view: [],
  run: ["view"],
  // Transitively `view`, through `run`. You cannot meaningfully change what you cannot execute:
  // an editor who could not run would be publishing code they had no way to have tried.
  edit: ["run"],
  eval: ["view"],
  deploy: ["view"],
  secrets: ["view"],
  admin: ["view"],
};

/**
 * A capability set with everything it implies, transitively.
 *
 * TRANSITIVE RATHER THAN ONE HOP, which is the whole reason this is a walk and not a `flatMap`:
 * `edit` names `run` and `run` names `view`, so a single pass over `AGENT_IMPLIES` produces
 * {edit, run} and loses the one capability that every other capability implies. The failure is
 * quiet in the direction that hides things — somebody granted `edit` and nothing else would see
 * an agent they can edit and cannot open.
 */
export function closeAgentCapabilities(set: Iterable<AgentCapability>): Set<AgentCapability> {
  const out = new Set<AgentCapability>();
  const pending = [...set];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (!isAgentCapability(next) || out.has(next)) continue;
    out.add(next);
    pending.push(...AGENT_IMPLIES[next]);
  }
  return out;
}

/** What a member holds on every agent by default: the product, and nothing that commits the workspace. */
const AGENT_MEMBER: readonly AgentCapability[] = ["view", "run", "edit", "eval"];

/**
 * The default set each workspace role holds on any agent — which is also its CEILING.
 *
 * DEFAULT AND CEILING ARE ONE LIST, deliberately, and that is invariant B expressed as a data
 * structure rather than as two tables that could disagree. A grant may narrow this set or widen
 * within it; nothing can widen past it. Two lists — "what you get" and "what you could be given"
 * — would make "a grant that exceeds the role" a state the schema could represent, and anything
 * the schema can represent eventually exists.
 *
 * THE SPECIFICATION'S FOUR ROLES ARE THIS SCHEMA'S THREE. §3.3 lists owner / admin / member /
 * viewer; `workspace_members.role` has a CHECK constraint admitting owner, admin and member and
 * nothing else, and migration 003 is explicit about why. So `viewer` is not mapped to something
 * approximate here — it is absent, and the row it would have held is absent with it. Inventing a
 * fourth role in this table that no membership row can carry would be a set of defaults nobody can
 * ever be assigned, sitting in the file that is supposed to be the answer.
 *
 * ADMIN HOLDS ALL SEVEN AND SO DOES OWNER, which looks like a missing distinction and is not.
 * Everything that separates the two at the WORKSPACE level — membership, billing, the workspace's
 * own existence — is above this scope entirely: there is no per-agent act that an owner may
 * perform and an admin may not. Making `admin` narrower here would be inventing a difference to
 * make the table look more interesting.
 *
 * `system` HOLDS EVERYTHING, for the reason it does above: it is the server acting on its own
 * behalf, it is never resolvable from a membership row, and a reconciliation refused access to an
 * agent it is reconciling is a background job that silently does nothing.
 */
export const ROLE_AGENT_CAPABILITIES: Record<Role, readonly AgentCapability[]> = {
  member: AGENT_MEMBER,
  admin: AGENT_CAPABILITIES,
  owner: AGENT_CAPABILITIES,
  system: AGENT_CAPABILITIES,
};

/**
 * The ceiling a workspace role puts on any grant, closed under implication.
 *
 * CLOSED HERE TOO, even though every default set is already closed by inspection. The closure is
 * cheap and the alternative is a rule that holds because somebody checked once: a capability added
 * to `AGENT_MEMBER` later without its implications would produce a ceiling that refuses `view` to
 * a member who holds `eval`, and the symptom would be an agent that cannot be opened by the person
 * evaluating it.
 */
export function agentCeiling(role: Role): Set<AgentCapability> {
  return closeAgentCapabilities(ROLE_AGENT_CAPABILITIES[role] ?? []);
}

/**
 * The MEMBERSHIP roles, weakest first. `system` is deliberately not among them.
 *
 * It is the server acting on its own behalf, never resolvable from a membership row, so putting it
 * in an ordering that a refusal reads from would let a client be told to "ask a system" — which is
 * not a person, not a role anybody can be promoted to, and not an answer.
 */
const ROLE_LADDER: readonly Role[] = ["member", "admin", "owner"];

/**
 * The weakest membership role that holds a capability, or null if none does.
 *
 * §13.5 — WHAT A REFUSAL NAMES. The server has always said "a member cannot do this — it needs
 * connector:manage", which is precise and is addressed to whoever reads the source. `connector:
 * manage` is not a thing anybody can be granted: what a person actually does about a refusal is
 * ask somebody with a role, so the refusal has to carry the role.
 *
 * THE WEAKEST ONE, not the one that happens to be first in the table, because the answer is
 * advice: "ask an admin" is actionable in a workspace with an admin and an owner, and "ask an
 * owner" sent to somebody whose admin could have done it is advice that costs a round trip to the
 * one person on holiday. The ladder is walked upwards for exactly that reason, and it reads from
 * `ROLE_CAPABILITIES` rather than from a second table — a hand-maintained "which role for which
 * capability" map is the copy that goes stale the day a capability moves between roles, and the
 * symptom is a refusal telling somebody to ask the wrong person.
 */
export function roleFor(capability: Capability): Role | null {
  return ROLE_LADDER.find((role) => can(role, capability)) ?? null;
}

/**
 * A role with the article it actually takes: "an admin", "a member", "an owner".
 *
 * `a ${ctx.role}` READ "a admin", WHICH IS THE ONE ROLE THAT SEES THIS. An owner is refused
 * nothing and `system` holds everything, so `requireCapability` and the relay's refusal are
 * reached by admins and members alone — and one of those two produced a sentence with the wrong
 * article in it, in the copy a panel renders. It is the smallest possible defect and it is on the
 * one screen somebody reads while already annoyed that a button did not work.
 *
 * BY THE LETTER RATHER THAN BY A LIST OF THE THREE, so a fourth role added later is right without
 * anybody remembering this function exists. Roles are ASCII identifiers from `ROLE_LADDER`, not
 * prose, so the vowel test is exact here in a way it would not be for arbitrary English.
 */
export function withArticle(role: string): string {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

/**
 * The one check. Throws a 403 naming the capability and the role that lacks it.
 *
 * Naming both is deliberate: "forbidden" with no subject sends somebody to read source, and
 * neither the capability nor their own role is a secret from a member of the workspace.
 */
export function requireCapability(ctx: TenantContext, capability: Capability): void {
  if (!can(ctx.role, capability)) {
    throw forbidden(`${withArticle(ctx.role)} cannot do this — it needs ${capability}`);
  }
}

/**
 * Which capability each WebSocket command needs.
 *
 * The mapping is exhaustive and a test proves it against the relay's own command union, so a
 * command added without an entry fails the build rather than defaulting to something. There is
 * deliberately no default: "unlisted means allowed" is the hole, and "unlisted means denied"
 * is the same hole in a year when somebody adds a command and cannot work out why it 403s.
 */
export const COMMAND_CAPABILITY: Record<string, Capability> = {
  // reads
  loadRun: "agent:read",
  // A bigger window on the same list the connect snapshot already sends. See LoadHistoryCommand.
  loadHistory: "agent:read",
  listAgents: "agent:read",
  loadAgentFiles: "agent:read",
  loadAgentGraph: "agent:read",
  explain: "agent:read",

  /**
   * The agent lifecycle: archive, restore, rename.
   *
   * `agent:write`, beside generate and edit, and that is the decision. Archiving is reversible and
   * destroys nothing — the versions, runs, traces and threads all stay exactly where they were — so
   * it is the same authority as editing the agent, not the workspace-shaped authority that deleting
   * one would need. It is also the same call the thread commands make for the same reason: a member
   * who may build an agent may put one away, and it is one click back either way.
   */
  archiveAgent: "agent:write",
  restoreAgent: "agent:write",
  renameAgent: "agent:write",

  /**
   * Fork, and restore-to-a-version.
   *
   * `agent:write` FOR BOTH, and neither is more than that. A fork creates a new agent out of a
   * manifest this workspace already owns and resets its MCP grants to zero, so it can reach strictly
   * less than the agent it came from — there is nothing here that a member allowed to generate could
   * not already do by generating. A restore publishes a NEW version pointing at an old manifest; it
   * rewrites no history and moves no pointer backwards, which makes it the same act as applying an
   * edit and reversible the same way.
   */
  forkAgent: "agent:write",
  restoreAgentVersion: "agent:write",

  /**
   * The Agents tab's three reads.
   *
   * `agent:read`, beside `listAgents` and `loadAgentFiles`, because that is what they are: the grid
   * is the agent list with its derived tags, the detail is one agent's own record, and the version
   * read is `loadAgentFiles` for a version other than the current one. A capability of their own
   * would be a second gate in front of the list the sidebar already shows unguarded.
   */
  listAgentGrid: "agent:read",
  loadAgentDetail: "agent:read",
  loadAgentVersion: "agent:read",

  // build
  planAgent: "agent:write",
  discardPlan: "agent:write",
  generate: "agent:write",
  edit: "agent:write",
  applyEdit: "agent:write",
  undoEdit: "agent:write",
  discardEdit: "agent:write",

  // execution
  run: "run:execute",
  pauseRun: "run:execute",
  resumeRun: "run:execute",
  cancelRun: "run:execute",
  branchRun: "run:execute",

  // threads
  //
  // `agent:read` / `agent:write` RATHER THAN A CAPABILITY OF THEIR OWN, and that is a decision
  // about what a thread IS. A thread is the session a plan, a generation and an edit happen inside
  // — the same work `agent:write` already names — so a separate `thread:write` would be a second
  // gate in front of one activity, and the two could disagree: a member allowed to generate but not
  // to open a thread to generate in is a role nobody meant to create.
  //
  // MEMBER-LEVEL, deliberately, because §6 is explicit that Team workspaces are fully
  // collaborative: all members see all threads and any member may act on any thread. The author
  // column exists to make that legible, not to restrict it — so archiving somebody else's thread is
  // not a privileged act, and it is reversible in one click either way.
  listThreads: "agent:read",
  loadThread: "agent:read",
  createThread: "agent:write",
  renameThread: "agent:write",
  archiveThread: "agent:write",
  restoreThread: "agent:write",

  // inbox
  //
  // `agent:read` FOR THE BOARD AND `agent:write` FOR THE THREE VERBS, and no capability of its own,
  // for the reason the thread commands have none: an item is a fact about work `agent:read` already
  // covers — a credential an agent needs, a deploy that failed, a version that is behind — and a
  // second gate in front of it could disagree with the one on the work itself. A member who may see
  // that an agent's deploy failed and may not see the card saying so is a role nobody meant to
  // create.
  //
  // MEMBER-LEVEL, LIKE THREADS, because two of the three verbs are PERSONAL: a dismissal and a
  // snooze change one person's own board and nobody else's. Making them privileged would mean a
  // member could not tidy their own triage surface. The third, resolve, is shared — and it is shared
  // in the direction that is safe, because the sweep raises the item again if the problem is not
  // actually fixed.
  listInbox: "agent:read",
  resolveInboxItem: "agent:write",
  dismissInboxItem: "agent:write",
  snoozeInboxItem: "agent:write",
  undoInboxAction: "agent:write",
  bulkInboxAction: "agent:write",

  // activity
  //
  // BOTH READS, AND §1 SAYS THERE WILL NEVER BE ANOTHER KIND. This tab is workspace-level,
  // cross-agent, aggregate, historical and READ-ONLY — "clicking navigates, and hovering
  // highlights, and that is the entire interaction vocabulary" — so `agent:read` is not a starting
  // point that a later verb widens. Anything on this surface that wanted to change something would
  // belong in the Inbox, which is where the actions are.
  //
  // `agent:read` RATHER THAN A CAPABILITY OF ITS OWN, for the reason the thread and inbox reads
  // share theirs: a second gate in front of facts a member can already reach one at a time would be
  // a role that can see a run but not a count of runs.
  getActivity: "agent:read",
  getActivityFeed: "agent:read",

  // eval
  listDatasets: "eval:read",
  loadDataset: "eval:read",
  loadRubric: "eval:read",
  loadEvalResults: "eval:read",
  listEvals: "eval:read",
  estimateEval: "eval:read",
  createDataset: "eval:write",
  renameDataset: "eval:write",
  deleteDataset: "eval:write",
  addExample: "eval:write",
  updateExample: "eval:write",
  deleteExample: "eval:write",
  promoteTestInput: "eval:write",
  saveRubric: "eval:write",
  startEval: "eval:run",
  cancelEval: "eval:run",

  // MCP
  listMcpServers: "mcp:read",
  addMcpServer: "mcp:manage",
  removeMcpServer: "mcp:manage",
  rediscoverMcpServer: "mcp:manage",
  setMcpServerAuth: "mcp:manage",
  setMcpToolImpact: "mcp:manage",
  // Not mcp:manage. The gate halts a RUN, and whoever started it has to be able to answer —
  // a member whose run is blocked waiting for an admin is a gate that times out, and timing
  // out denies. The tool was already approved in principle when an admin connected the
  // server and it was selected during planning; what is being approved here is this call.
  resolveMcpConfirm: "mcp:confirm",

  // connectors
  listConnections: "connector:read",
  connectConnector: "connector:manage",
  // The same capability as connecting, deliberately. Breaking every agent that depends on a
  // connection is not a lesser act than making one, and a "disconnect is only a read" reading
  // is how a member ends an integration the workspace depends on.
  disconnectConnector: "connector:manage",

  // providers
  listProviders: "provider:read",
  // `setProviderKey` and `testProviderKey` are not here because they no longer exist. A credential
  // written over the socket could not be gated by elevation — that rides on a request header — so
  // the passcode gate was bypassable by anyone with a session. See wsRelay.ts.

  // provider:manage rather than billing:manage. It decides which of two credentials pays for a
  // call, not what the workspace is subscribed to — and the person who connected the key is the
  // one who knows whether their provider account should carry the platform's calls too.
  setOwnKeyForPlatform: "provider:manage",

  // membership
  loadUsage: "billing:read",
  // `billing:manage`, which is the owner's, and the split is the one `billing:read`'s own comment
  // states: spend is not a secret from the people generating it, and changing what MAY be spent is
  // a decision about the workspace's money. A member whose run is refused for budget can see the
  // number; raising it is not theirs.
  setSpendCeiling: "billing:manage",
  /**
   * Choosing whose provider key the agents run on.
   *
   * `billing:manage`, beside the ceiling, because that is what it decides: turning BYOK on stops
   * inference charges and turning it off starts them again. It is the owner's for the same reason
   * the plan is — a member who could flip it could move the workspace's bill in either direction.
   */
  setByok: "billing:manage",

  // The rung a workspace is under, and the note it answers with. A MEMBER's, because the refusal
  // it explains is a member's — see the capability's own entry.
  loadEnforcement: "enforcement:appeal",
  appealEnforcement: "enforcement:appeal",

  listMembers: "member:read",
  /**
   * Giving up your own membership.
   *
   * `member:read` — A MEMBER'S — AND NOT `member:manage` BESIDE THE FOUR BELOW, which looks like
   * the entry most likely to be wrong in this table and is the one decision here that could not go
   * the other way. `member:manage` is the owner's, and an owner is precisely the role that may NOT
   * leave: §6.5 says ownership is handed over deliberately, never dropped. Filing this under it
   * would produce a command that exactly nobody can use — refused for every role that wants it and
   * held only by the role it refuses.
   *
   * So it sits under the member capability for the membership surface, and the thing that makes
   * that safe is the command's SHAPE rather than this line: `leaveWorkspace` carries no user id,
   * so the only membership it can reach is the socket's own. Widening `member:read` to cover it is
   * widening it to "may end your own presence here", which is not an authority over anybody else.
   */
  leaveWorkspace: "member:read",
  /**
   * The workspace's audit trail.
   *
   * `workspace:manage` — THE OWNER'S — and not `member:read` beside it, because of what the rows
   * contain rather than because reading is privileged: who revealed which credential, who overrode
   * a secret-scan refusal on a push, who was removed and by whom. Those are facts about people, and
   * a member does not need them to do any of the work `member:read` exists for.
   *
   * Not a capability of its own for the reason the thread commands are not: a second gate in front
   * of one surface is a gate that can disagree with the surface, and "may read what happened to this
   * workspace" is the same authority as "may change what this workspace is".
   */
  listAudit: "workspace:manage",
  inviteMember: "member:manage",
  revokeInvite: "member:manage",
  setMemberRole: "member:manage",
  removeMember: "member:manage",

  // deploy
  listDeployments: "deploy:read",
  loadDeployLogs: "deploy:read",
  planDeploy: "deploy:manage",
  deploy: "deploy:manage",
  cancelDeploy: "deploy:manage",
  forgetDeployment: "deploy:manage",
  setRailwayToken: "deploy:manage",
  testRailwayToken: "deploy:manage",

  // github
  //
  // The three reads are a member's: where an agent's code lives, which repositories are on offer,
  // and whether a name is taken are all questions somebody debugging an agent legitimately asks.
  // Everything below them writes — to a repository outside this workspace, or to the pointer that
  // decides which repository that is — and is an admin's.
  //
  // `refreshGithub` IS A READ despite moving a stored column. All it moves is the watermark: it
  // updates what we last SAW, never what we last DID, and a member who could not refresh would be
  // reading a verdict computed from whenever an admin last looked.
  listGithub: "github:read",
  listGithubRepos: "github:read",
  checkGithubRepo: "github:read",
  refreshGithub: "github:read",
  linkGithub: "github:manage",
  unlinkGithub: "github:manage",
  pushGithub: "github:manage",
  pullGithub: "github:manage",
  switchGithubBranch: "github:manage",
  createGithubBranch: "github:manage",
  openGithubPr: "github:manage",
  commitGithub: "github:manage",
  // `github:manage` rather than `agent:write`, even though what it produces is only text. It reads
  // the agent's unpushed diff to write about it, and it spends a model call against the
  // workspace's balance — both of which belong to the person who is allowed to push, not to
  // everybody who can read where the code went.
  generateGithubMessage: "github:manage",

  // §B.3's live diagnostics. `github:read` and not `manage`: it analyses a buffer and returns
  // squiggles, it changes nothing, and §B.3.2 is explicit that it never blocks a commit — so
  // requiring push rights to SEE a problem would gate the cheap half of the validator behind the
  // permission for the expensive half.
  diagnoseFile: "github:read",
  // §B.2's shadow run. `github:manage`, and the reason is money rather than mutation: it publishes
  // nothing and moves no pointer, but it runs an agent on a real provider against this workspace's
  // balance. §B.2.2 says it plainly — a shadow run is disposable to the product and is not
  // disposable to the bill.
  shadowRunGithub: "github:manage",
  listShadowRuns: "github:read",
  // §B.7. Presentation over two trees the reader can already see — permanently, per §B.7.3.
  semanticDiffGithub: "github:read",
  // §B.5.3. It posts to somebody else's pull request under this workspace's token, which is a
  // write to the repository even though it changes no code.
  resolveReviewComment: "github:manage",
  // §B.1.2's opt-in. `github:manage` and not `eval:write`, even though the thing it names is a
  // dataset: what this decides is whether a PULL REQUEST — including a stranger's — may run an eval
  // against this workspace's provider balance. That is the sharpest case of "commits the workspace
  // to something outside itself" in the table, and it is the same authority as choosing which
  // repository the code goes to.
  setAgentCiConfig: "github:manage",
  // §B.6's findings history. `github:read`, beside the other reads: it names paths and rule ids in
  // this workspace's own source and carries no value — the same posture the live refusal already has.
  listScanFindings: "github:read",

  // An export is deliberately NOT here, and its absence is the decision rather than an omission:
  // it is an HTTP route, not a socket command — see http/lifecycle.ts. A copy of everything the
  // workspace has is a file a browser downloads, and a download is a request with a URL, not a
  // frame on a multiplexed socket. It checks `workspace:manage` at the door like everything else.
};

/** The capability a command needs, or undefined for one nothing has classified. */
export function capabilityFor(cmd: string): Capability | undefined {
  return Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITY, cmd)
    ? COMMAND_CAPABILITY[cmd]
    : undefined;
}

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

// --- the resolver ------------------------------------------------------------------------------

/**
 * What the resolver needs from the database, and nothing else.
 *
 * AN INTERFACE RATHER THAN THE REPOSITORY ITSELF, for one structural reason: this module is
 * imported by the client's `test:permission-ui` as TEXT and by the relay as code, and it must not
 * drag a database driver behind it — `test:db-boundary`'s first rule is that `node:sqlite` and `pg`
 * are reachable from exactly one directory. A one-method interface keeps the resolver where the
 * matrix is, which is what invariant A asks for, without putting SQL in front of the matrix.
 *
 * It is also what makes the resolver testable against a table of grants rather than against a
 * database, which is the difference between a suite that asserts the INTERSECTION and one that
 * asserts that a query returned a row.
 */
export interface GrantSource {
  /**
   * The stored grant for (workspace, agent, user), or undefined.
   *
   * THE STORED SET, NOT THE EFFECTIVE ONE. Anything that intersected before handing it back would
   * be a second resolver wearing a repository's clothes, and the two would eventually disagree
   * about a ceiling. The row goes in; the effective set comes out of exactly one function.
   */
  find(
    ctx: TenantContext,
    agentId: string,
    userId: string,
  ): Promise<{ capabilities: AgentCapability[]; expires_at: string | null } | undefined>;
}

/** Why a resolution came out the way it did, for the audit row and for the panel's provenance line. */
export type GrantProvenance =
  /** No grant row. The effective set is the workspace role's default, which is also its ceiling. */
  | { kind: "role" }
  /** A live grant, intersected with the ceiling. `capped` is what the role took back off it. */
  | { kind: "grant"; capped: AgentCapability[] }
  /** A grant whose `expires_at` has passed. Treated as absent — see `resolveCapabilities`. */
  | { kind: "expired"; at: string }
  /** Not a member of this workspace. The empty set, and the agent reads as absent. */
  | { kind: "none" };

export interface ResolvedAccess {
  capabilities: Set<AgentCapability>;
  provenance: GrantProvenance;
}

/**
 * THE resolver. Every gated command asks this function and there is no second one.
 *
 * Five steps, in this order, and the order is the security property rather than a style:
 *
 *   1. The workspace role. Absent — not a member — is the EMPTY SET, and everything downstream
 *      intersects with it, so a non-member resolves to nothing regardless of what rows exist. That
 *      is what makes "absent rather than forbidden" enforceable at the resolver instead of at
 *      thirty call sites: the caller cannot distinguish "no such agent" from "not yours" because
 *      the answer to both is an empty set.
 *   2. The role's default set from the matrix, which is also its ceiling.
 *   3. The grant row, if there is one and it has not expired.
 *   4. THE INTERSECTION WITH THE CEILING, ALWAYS — invariant B, and the step that is easiest to
 *      argue away. `grantAccess` already refuses a set exceeding the ceiling at write time, so this
 *      looks redundant, and it is redundant for exactly as long as nobody's role changes. Demote an
 *      admin to member and every grant they hold is a set their role no longer permits, sitting in
 *      a table that was validated once. Write-time validation is about the moment of writing; this
 *      is about every moment after it. It is also the only thing standing between a row written
 *      directly to the database and an authorisation.
 *   5. The implication closure, from the same table the dialog uses.
 *
 * EXPIRY IS EVALUATED HERE AND NOWHERE ELSE. Not in a sweeper, not in a scheduled job: a control
 * that is correct only as often as a cron fires is one whose failure leaves live access in place
 * with nothing on screen saying so. A grant that ran out five seconds ago is refused by the first
 * command after it did.
 *
 * NOTHING CACHES THE RESULT ACROSS COMMANDS. §5.2 is explicit and the reason is v0.2.6's bug in a
 * different costume: a socket resolves its workspace context live rather than holding the one it
 * connected with, precisely so a demotion bites without a reconnect. A per-socket capability cache
 * would reintroduce that for grants — revocation would take effect whenever the socket happened to
 * be replaced, which is to say when somebody closed a laptop lid.
 */
export async function resolveCapabilities(
  ctx: TenantContext,
  agentId: string,
  grants: GrantSource,
  now: () => number = Date.now,
): Promise<ResolvedAccess> {
  // Step 1 and 2. `role` on the context IS the workspace membership, resolved live per command by
  // the relay's revalidation — see wsRelay's `contextOf`. A role this table does not know holds
  // nothing, which is the same answer `can` gives one level up and for the same reason: a server
  // that grew a fourth role must not silently grant it everything.
  const ceiling = agentCeiling(ctx.role);
  if (ceiling.size === 0) return { capabilities: new Set(), provenance: { kind: "none" } };

  // No actor is a request nobody triggered. It cannot hold a personal grant — a grant is made TO
  // somebody — so it resolves to the role's set, which for `system` is everything.
  const userId = ctx.actorUserId;
  const grant = userId ? await grants.find(ctx, agentId, userId) : undefined;

  if (!grant) return { capabilities: closeAgentCapabilities(ceiling), provenance: { kind: "role" } };

  // Step 3. An expired grant is ABSENT rather than empty, which is a decision worth stating: the
  // person falls back to their workspace role's default set rather than to nothing. The other
  // reading — expiry revokes everything — would make a time-boxed WIDENING into a time-boxed
  // lockout, so granting somebody `deploy` for eight hours would remove their ability to run the
  // agent on the ninth. A grant that must take access away is a grant that narrows, and narrowing
  // grants do not expire into more access than they started with.
  if (grant.expires_at && Date.parse(grant.expires_at) <= now()) {
    return {
      capabilities: closeAgentCapabilities(ceiling),
      provenance: { kind: "expired", at: grant.expires_at },
    };
  }

  // Step 4 — the intersection, and step 5 — the closure. IN THAT ORDER, which matters: closing
  // first and intersecting after would be the same answer here only by luck, and would stop being
  // so the moment an implication pointed at something outside a role's ceiling.
  const capped = grant.capabilities.filter((c) => !ceiling.has(c));
  const effective = closeAgentCapabilities(grant.capabilities.filter((c) => ceiling.has(c)));
  return { capabilities: effective, provenance: { kind: "grant", capped } };
}

/**
 * Whether a resolved set holds a capability. The one question a command handler asks.
 *
 * A FUNCTION RATHER THAN `set.has`, so that every gated call site reads the same and so that the
 * grep invariant A rests on has something to find. It is deliberately not called `can` — that name
 * is taken, one scope up, and two functions called `can` in one file is precisely the confusion
 * this whole feature exists to prevent.
 */
export function holds(resolved: ResolvedAccess, capability: AgentCapability): boolean {
  return resolved.capabilities.has(capability);
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
  // A QUESTION ABOUT WHAT AN AGENT HAS DONE IS A READ, and it is `agent:read` rather than anything
  // stronger for the reason Part 3 §3 makes it possible to say at all: a question never touches the
  // container. No dispatch, no run, no spend on the agent's key. It reads `work_items` and answers
  // from them, so it is the same authority as opening the Cockpit and reading the same rows by eye.
  askRecord: "agent:read",

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
  // Changing which MCP tools an agent may call. `agent:write` rather than something narrower for
  // the reason the whole per-tool design rests on: what bounds a grant is the REGISTRY, which only
  // holds servers this workspace connected, so this can never widen past what somebody with
  // `mcp:manage` already admitted. Anybody who may edit the code may decide what it may reach.
  setAgentTools: "agent:write",

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
  // The same as the other board verbs: every member may answer a proposal about an agent they can
  // write to, and the decision is the workspace's rather than one person's.
  answerMemoryProposal: "agent:write",
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

  // the Cockpit
  //
  // §8'S TABLE, WITH ITS ONE UNRESOLVED NAME RESOLVED. The specification files "see the Cockpit"
  // under `deploy:read + agent:read`, the three job verbs under `run:execute`, the confirmation
  // under `mcp:confirm`, and Reconnect and kill under "the deploy capability — check the real name
  // in capabilities.ts". The real name is `deploy:manage`: `deploy:read` is the read, and both of
  // those commands change something in the user's own hosting account.
  //
  // THE THREE READS ARE `deploy:read` AND NOT `agent:read`, which is the one place this table
  // narrows what §8 allows rather than widening it. §8 asks for both, and a capability check takes
  // one — so it takes the sharper of the two. Every member already holds `agent:read`, so filing
  // the reads there would make the pair meaningless; `deploy:read` is also a member capability, so
  // nothing is actually shut out, and it is the one that names what this tab is ABOUT.
  listWork: "deploy:read",
  loadWorkItem: "deploy:read",
  listFleet: "deploy:read",
  // The container's own log pane. A read, and the same capability the build log already has.
  loadAgentLogs: "deploy:read",
  //
  // DISPATCH, CANCEL AND RETRY ARE `run:execute`, beside `run` and `cancelRun`, and that is what
  // they are: starting an agent and stopping it. Not `deploy:manage` — a member who may run an
  // agent locally may run the deployed one, and requiring the deploy capability would mean the
  // person who operates the fleet has to be the person who publishes it.
  dispatchWork: "run:execute",
  cancelWork: "run:execute",
  retryWork: "run:execute",
  //
  // AND THE TWO THAT REACH INTO RAILWAY ARE `deploy:manage`, beside `deploy` and `cancelDeploy`.
  // Reconnect sets a variable, which RESTARTS the service and drops every run in flight in it;
  // kill deletes the service outright. Both change what exists in somebody's hosting account,
  // which is the line the header draws for admin.
  reconnectAgent: "deploy:manage",
  killAgent: "deploy:manage",

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
  /**
   * The access channel, and the one place in this table where the workspace-level answer is
   * deliberately the WEAKER of two gates rather than the whole of one.
   *
   * `agent:read` FOR BOTH READS, which is §9.2's decision expressed as data: reading who can
   * deploy an agent is a normal operation, not a privileged one. "Who can deploy this?" is a
   * question a member should be able to answer without asking an admin, and hiding the answer
   * produces exactly the Slack thread the tab exists to eliminate. What a non-admin cannot do is
   * CHANGE any of it, and that is decided one scope down.
   *
   * THE REAL GATE ON BOTH IS `view` AT THE AGENT SCOPE, from `COMMAND_AGENT_CAPABILITY`. This
   * entry is the floor underneath it: it is what refuses somebody with no agent read capability at
   * all, and it is what makes the pair still classified if the agent-level check is ever
   * unreachable. Filing them higher — at `member:read`, say — would have made the Access tab
   * absent for exactly the person §9.2 says must be able to open it.
   */
  loadAccess: "agent:read",
  loadExposure: "agent:read",
  /**
   * The three mutations, at `member:read` — a MEMBER capability, which looks far too weak and is
   * the right floor.
   *
   * WHAT ACTUALLY GATES THESE IS `admin` AT THE AGENT SCOPE, and the choice here is only about what
   * happens BEFORE that check. The candidates were `member:manage`, which is the owner's, and this.
   * `member:manage` would mean a workspace ADMIN could not grant access to an agent they
   * administer — the exact person §11 is written for — because the coarse gate would refuse them
   * before the fine one ran. So the floor is the weakest capability that still means "may see who
   * is in this workspace at all", which is what these commands operate on, and the authority to
   * change anything is decided per agent.
   *
   * THE COST OF THAT IS ONE THING AND IT IS NAMED: a member sending `grantAccess` by hand passes
   * this check and is refused by the agent-level one, which is where `access.denied` is written.
   * That is the correct place for it to be refused and the correct row to write — a member
   * repeatedly hitting that wall is exactly the signal §4.3 says the event exists to make visible.
   */
  grantAccess: "member:read",
  modifyGrant: "member:read",
  revokeGrant: "member:read",
  // §14's two, at the same floor and gated at `admin` on the agent for the same reason. They read
  // and end CONNECTIONS rather than change permissions, which is why they are not `workspace:manage`
  // beside `listAudit`: ending a session takes nothing away — the person reconnects if their access
  // still allows it — and a floor only an owner could pass would put "somebody left a laptop logged
  // in" on the one person in the workspace most likely to be elsewhere.
  loadSessions: "member:read",
  endSession: "member:read",
  // §15's history, at the same floor and gated at `admin` on the agent — which is where it
  // deliberately differs from `listAudit` beside it. That one is `workspace:manage`, the owner's,
  // because it is the whole log; this is the same rows narrowed to one agent, and the person who
  // administers that agent is exactly who needs to read them.
  loadAccessHistory: "member:read",
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

/**
 * Which AGENT-level capability each agent-scoped command needs.
 *
 * A SECOND TABLE IN THE SAME FILE, NOT A SECOND MATRIX. `COMMAND_CAPABILITY` above answers "may
 * this person do this in this workspace"; this answers "and to THIS agent". Both are read by one
 * dispatch point, both feed one resolver, and a command in this table is refused unless both say
 * yes. The alternative — one table with a sometimes-agent-scoped column — is a column whose
 * meaning depends on the row, which is the shape nobody can audit.
 *
 * ONLY THE COMMANDS WHOSE MESSAGE NAMES AN AGENT ARE IN HERE, and that boundary is a real
 * limitation rather than a tidy one. `pauseRun` carries a run id, `applyEdit` a proposal id,
 * `cancelDeploy` a deployment id, `addExample` a dataset id — every one of those belongs to an
 * agent, and none of them says which. Resolving the agent for them would mean a database lookup
 * inside the relay, which imports no database by construction (`test:db-boundary`, rule 1), or a
 * second authorisation pass inside each handler, which is invariant A's failure exactly.
 *
 * SO WHAT THAT COSTS, SAID PLAINLY: a person who may not `run` an agent may still `pauseRun` a run
 * of it that somebody else started, and may still `applyEdit` a proposal on it. Both are gated by
 * the workspace capability, so neither is reachable by somebody with no authority at all — what
 * they are not gated by is the per-agent narrowing. The commands that CREATE those ids — `run`,
 * `edit`, `deploy`, `startEval` — are all in this table, so the narrowing holds at the door and
 * leaks at the follow-up. Closing it properly means the id carrying its agent, which is a change
 * to four message shapes and their clients; it is worth doing and it is not this release.
 *
 * A COMMAND THAT CARRIES AN `agentId` AND IS ABSENT FROM THIS TABLE IS REFUSED, not allowed —
 * `test:capabilities` asserts the set is empty, so that branch is a floor rather than a behaviour,
 * and it is the same rule `capabilityFor` follows one scope up. "Unlisted means allowed" is the
 * hole; "unlisted means denied" is the same hole in a year, so neither is left to a default.
 */
export const COMMAND_AGENT_CAPABILITY: Record<string, AgentCapability> = {
  // --- view: reads about the agent ------------------------------------------------------------
  loadAgentDetail: "view",
  loadAgentFiles: "view",
  loadAgentGraph: "view",
  loadAgentVersion: "view",
  explain: "view",
  // `view`, beside `explain`, and NOT beside `dispatchWork`. The whole of Part 3's classifier exists
  // so that a question and a command are different things; making them the same capability would
  // put them back together at the only layer that is actually enforced, and somebody with read
  // access to an agent would be unable to ask what it had done.
  askRecord: "view",
  // The datasets belonging to an agent, and what a comparison would cost. Both are reads, and the
  // second is the estimate the entitlement gate deliberately leaves ungated for the same reason: a
  // workspace at its limit has to be able to find out what going over would cost, and a person who
  // may see an agent has to be able to see what evaluating it would.
  listDatasets: "view",
  estimateEval: "view",
  // What this one agent has been doing. `view`, beside the reads above, because that is what it is
  // — the Activity feed narrowed to one agent, carrying nothing the detail pane does not.
  getActivityFeed: "view",
  // The work list narrowed to one agent, which is the same shape one line up and the same answer.
  // §8 files "see the Cockpit" under `view` at this scope, and a jobs list for an agent somebody
  // cannot see would be a list of what it was asked to do by somebody who may not know it exists.
  //
  // ONLY THE FILTERED FORM IS GATED HERE, which is what the resolver does with an absent `agentId`:
  // the unfiltered list is a workspace read and is gated by `deploy:read` one scope up. That is not
  // a hole — an agent whose jobs a person may not see individually would still have its rows in the
  // workspace list, and closing that properly means filtering the LIST by the caller's per-agent
  // grants, which is a read that resolves a grant per row and is not this release. The same
  // limitation `COMMAND_AGENT_CAPABILITY`'s header already names, stated where it applies.
  listWork: "view",
  // Planning a deployment renders what WOULD happen and changes nothing. Same argument the
  // entitlement table makes about it, one gate over.
  planDeploy: "view",
  // A FORK IS A READ OF THIS AGENT, and the decision is worth stating because it looks lenient.
  // What a fork needs OF THE AGENT IT COPIES is the right to see its source — which `view` already
  // grants through `loadAgentFiles`, so somebody with `view` could reproduce a fork by hand. What
  // it needs in order to CREATE the copy is `agent:write` on the workspace, which is checked one
  // scope up and is not this table's question. Gating it at `edit` would mean a person who may
  // read an agent's code may not press the button that copies it.
  forkAgent: "view",
  // Opening a build session ON an agent, which is not itself an act on the agent: every verb inside
  // the thread — generate, edit, run — is gated by its own row here or above.
  createThread: "view",
  // §9.2 — THE ACCESS TAB IS READ-ONLY WITHOUT `admin` RATHER THAN HIDDEN, so both of its reads
  // sit at `view` beside every other read about the agent. Nothing here is a credential: this is a
  // list of who may do what and a statement about a URL, and the mutations are gated separately.
  // Filing the reads at `admin` would mean a member cannot find out who to ask, which is the
  // question the section exists to answer.
  // --- admin: manage who may do any of the above ----------------------------------------------
  //
  // The three mutations, and they are the only rows in this table at `admin`. Everything else on
  // the Access tab is a read; these are what the capability is for.
  grantAccess: "admin",
  modifyGrant: "admin",
  revokeGrant: "admin",
  // §14.1 — the session list names colleagues and says how long each has been connected, which is
  // `admin` rather than `view` because it is a fact about PEOPLE rather than about the agent.
  // Everything else on this tab describes the agent; this describes who is at it right now.
  loadSessions: "admin",
  endSession: "admin",
  // §15 — "Requires admin capability (agent-level). Non-admins do not see History." The rows name
  // who granted what to whom and what somebody was refused, which is the same class of fact the
  // workspace audit log restricts to an owner.
  loadAccessHistory: "admin",

  loadAccess: "view",
  // AND THE EXPOSURE READ IS `view` FOR A SHARPER REASON. It is the section that says a deployed
  // agent is reachable by anyone with the URL and that nothing in this panel governs that — the
  // one fact on the surface most worth somebody stumbling across. Requiring `admin` to see it
  // would restrict a warning to the people least likely to need telling.
  loadExposure: "view",
  // The GitHub reads. Where the code went, how far the two lineages have drifted, what the scanner
  // found, what a shadow run did, and the squiggles in a buffer. None writes anything.
  listGithub: "view",
  refreshGithub: "view",
  listScanFindings: "view",
  listShadowRuns: "view",
  semanticDiffGithub: "view",
  diagnoseFile: "view",

  // --- run: execute and debug -----------------------------------------------------------------
  run: "run",
  // §8's per-agent column: giving THIS agent a job needs `run` on it. The workspace capability is
  // `run:execute`, which is the floor; this is the narrowing, and it is the row that makes a grant
  // of `view` on one agent unable to spend money on it.
  //
  // `cancelWork` AND `retryWork` ARE DELIBERATELY ABSENT, and their absence is the limitation
  // `COMMAND_AGENT_CAPABILITY`'s own header names rather than a decision made here: they carry a
  // work-item id, not an agent id, and resolving the agent for them would mean a database lookup
  // inside the relay, which imports no database by construction. Both are still gated by
  // `run:execute` at the workspace scope, so neither is reachable by somebody with no authority at
  // all — what they are not gated by is the per-agent narrowing, exactly as `pauseRun` is not.
  dispatchWork: "run",
  // §B.2's shadow run executes the agent against a branch. It publishes nothing and moves no
  // pointer — what it does is RUN, which is what this capability is for.
  shadowRunGithub: "run",

  // --- edit: change the agent's code ----------------------------------------------------------
  edit: "edit",
  undoEdit: "edit",
  // The lifecycle. `edit`, beside generate and apply, for the reason the workspace matrix files
  // them under `agent:write`: archiving destroys nothing and is one click back, so it is the same
  // authority as editing rather than a workspace-shaped one.
  archiveAgent: "edit",
  restoreAgent: "edit",
  renameAgent: "edit",
  // Publishing a NEW version that points at an old manifest. It rewrites no history and moves no
  // pointer backwards, which makes it the same act as applying an edit.
  restoreAgentVersion: "edit",
  // The same narrowing as the three above: deciding what an agent may reach is deciding what it
  // does, which is what editing is.
  setAgentTools: "edit",

  // --- eval: start, cancel, and the datasets they run against ---------------------------------
  startEval: "eval",
  createDataset: "eval",
  deleteDataset: "eval",
  promoteTestInput: "eval",

  // --- deploy: put it where somebody outside Jaroku can reach it ------------------------------
  deploy: "deploy",
  // THE GITHUB WRITES ARE `deploy` AND NOT `edit`, which is the least obvious row in this table.
  // What they do to the agent's SOURCE is nothing — the code is unchanged either way. What they do
  // is put it somewhere outside this product, under an account this workspace chose, where it can
  // be read, run and forked by people who have no membership here. That is the same act `deploy`
  // names, and it is emphatically not the same act as changing a file: a contractor granted `edit`
  // to fix one agent has not been granted the right to publish that agent's source to the
  // company's GitHub organisation. Both are still behind `github:manage` at the workspace scope,
  // which is the admin's; this is the narrowing on top of it.
  linkGithub: "deploy",
  unlinkGithub: "deploy",
  pushGithub: "deploy",
  pullGithub: "deploy",
  createGithubBranch: "deploy",
  switchGithubBranch: "deploy",
  openGithubPr: "deploy",
  commitGithub: "deploy",
  generateGithubMessage: "deploy",
  resolveReviewComment: "deploy",
  // §B.1.2's opt-in decides whether a stranger's pull request may spend this workspace's provider
  // balance against this agent. It is the sharpest "commits us to something outside ourselves" in
  // the table, which is why it sits with the pushes rather than with the evals it names.
  setAgentCiConfig: "deploy",
};

/** The agent-level capability a command needs, or undefined for one that is not agent-scoped. */
export function agentCapabilityFor(cmd: string): AgentCapability | undefined {
  return Object.prototype.hasOwnProperty.call(COMMAND_AGENT_CAPABILITY, cmd)
    ? COMMAND_AGENT_CAPABILITY[cmd]
    : undefined;
}

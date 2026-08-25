// What this account may do here, as data — the client's copy of the server's own matrix.
//
// §8.1 OFFERS TWO WAYS TO DO THIS AND THIS IS THE FIRST: "The client needs a copy of the same
// matrix, or the session should carry a resolved set of capabilities. The former is simpler and
// guarantees they match; the latter avoids shipping the matrix."
//
// A COPY DOES NOT GUARANTEE ANYTHING BY ITSELF — that is the one claim in §8.1 that is only true
// if something makes it true, and a copy nobody checks is the definition of a table that goes
// stale. What makes it true here is `test:permission-ui`, which reads
// `server/src/auth/capabilities.ts` as text and fails when the two disagree, in either direction:
// a capability moved between roles, a command added on the server with no entry here, an entry
// here naming a command the relay dropped. It is the same shape `test:capabilities` already uses
// to hold the server's own matrix to the relay's command surface, one file further out.
//
// WHY A COPY AT ALL, GIVEN THAT. Because the alternative puts a list of strings on the session
// that has to be recomputed and re-sent every time a role changes mid-connection — which it does:
// `revalidateAll` updates a socket's role in place once a minute without reconnecting, and a
// resolved set delivered at hydration would be the one thing that did not move with it. A matrix
// plus the role from the session re-derives the answer on every render, from a role the relay
// keeps current.
//
// AND WHAT THIS IS NOT. It is not enforcement and cannot be: every command is checked again by the
// relay against the same table, and every HTTP route checks at the door. What it decides is what
// to RENDER — §8's rule is that an affordance a role cannot use is ABSENT from the DOM, and this
// is what an affordance asks in order to be absent. A client-side check that was the only check
// would be a check the next `curl` skips.

/** The three membership roles. `system` is the server acting on its own behalf and never arrives here. */
export type Role = "owner" | "admin" | "member";

/**
 * Everything a member may do. The floor for every other role.
 *
 * NESTED, EXACTLY AS THE SERVER NESTS THEM, and copied in that shape rather than as three flat
 * lists for the reason the server's own comment gives: written as three independent arrays, the
 * day somebody adds a member capability and forgets the other two is the day admins stop being
 * able to do something members can, and nothing says so.
 */
const MEMBER = [
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
] as const;

/** What an admin adds: everything that commits the workspace to something outside itself. */
const ADMIN = [
  ...MEMBER,
  "mcp:manage",
  "provider:manage",
  "secret:manage",
  "connector:manage",
  "deploy:manage",
  "github:manage",
] as const;

/**
 * What an owner adds: membership, the workspace's own existence, and its money.
 *
 * THESE THREE ARE THE OWNER'S AND NOT THE ADMIN'S, which is worth stating here because §8.2's
 * checklist says otherwise — it lists "Members: invite, remove, role change", "Export workspace"
 * and every billing row as "Owner, Admin". The same section also says, in bold, "Do NOT guess
 * which capabilities map to which roles. Read COMMAND_CAPABILITY in the server source", and the
 * server source puts `member:manage`, `workspace:manage` and `billing:manage` in `OWNER` alone.
 * The source wins: a matrix that widened them to match the prose would hand every admin in every
 * team the ability to change who is in it and what it is charged, which is precisely the "a member
 * can do something they shouldn't (security bug)" half of what §8.2 warns the cost is.
 */
const OWNER = [...ADMIN, "member:manage", "workspace:manage", "billing:manage"] as const;

export const ROLE_CAPABILITIES: Record<Role, readonly string[]> = {
  member: MEMBER,
  admin: ADMIN,
  owner: OWNER,
};

/** Every capability there is, which is the owner's set — see the nesting above. */
export const CAPABILITIES: readonly string[] = OWNER;

/**
 * Whether a role holds a capability.
 *
 * A NULL ROLE HOLDS NOTHING, which is the state before a session has landed and after a sign-out.
 * Answering `true` there would flash every admin control on screen for the frame before the
 * session arrives, on every load, for everybody — and answering `true` for an UNKNOWN role would
 * be the same failure with a worse cause: a server that grew a fourth role would silently grant
 * it everything in this client until somebody noticed.
 */
export function can(role: string | null | undefined, capability: string): boolean {
  if (!role) return false;
  const held = ROLE_CAPABILITIES[role as Role];
  return held ? held.includes(capability) : false;
}

/**
 * Which capability each WebSocket command needs. The server's `COMMAND_CAPABILITY`, copied.
 *
 * A GUARD SHOULD NAME THE COMMAND, NOT THE CAPABILITY, wherever it can — `canRun(role, "deploy")`
 * rather than `can(role, "deploy:manage")`. The two are the same answer and a different question:
 * the second asks whoever wrote the component to remember that the Deploy button sends `deploy`
 * and that `deploy` needs `deploy:manage`, and a wrong answer there is invisible in review because
 * both halves look plausible. §8.2's own checklist gets several of these wrong for exactly that
 * reason — it files Deploy under `agent:write` — which is what this table exists to make
 * unnecessary.
 */
export const COMMAND_CAPABILITY: Record<string, string> = {
  // reads
  loadRun: "agent:read",
  loadHistory: "agent:read",
  listAgents: "agent:read",
  loadAgentFiles: "agent:read",
  loadAgentGraph: "agent:read",
  explain: "agent:read",
  listAgentGrid: "agent:read",
  loadAgentDetail: "agent:read",
  loadAgentVersion: "agent:read",

  // the agent lifecycle, and the build loop
  archiveAgent: "agent:write",
  restoreAgent: "agent:write",
  renameAgent: "agent:write",
  forkAgent: "agent:write",
  restoreAgentVersion: "agent:write",
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
  listThreads: "agent:read",
  loadThread: "agent:read",
  createThread: "agent:write",
  renameThread: "agent:write",
  archiveThread: "agent:write",
  restoreThread: "agent:write",

  // inbox
  listInbox: "agent:read",
  resolveInboxItem: "agent:write",
  dismissInboxItem: "agent:write",
  snoozeInboxItem: "agent:write",
  undoInboxAction: "agent:write",
  bulkInboxAction: "agent:write",

  // activity
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
  resolveMcpConfirm: "mcp:confirm",

  // connectors
  listConnections: "connector:read",
  connectConnector: "connector:manage",
  disconnectConnector: "connector:manage",

  // providers
  listProviders: "provider:read",
  setOwnKeyForPlatform: "provider:manage",

  // membership, billing, enforcement
  loadUsage: "billing:read",
  setSpendCeiling: "billing:manage",
  setByok: "billing:manage",
  loadEnforcement: "enforcement:appeal",
  appealEnforcement: "enforcement:appeal",
  listMembers: "member:read",
  leaveWorkspace: "member:read",
  // The access channel's two reads. `agent:read` on both, which is §9.2's rule copied rather than
  // re-derived: reading who can deploy an agent is a normal operation, so the tab renders
  // READ-ONLY for a non-admin instead of being absent. What a non-admin cannot do is change any of
  // it, and that is decided per agent rather than by this table — see `useCapability`'s second
  // argument.
  loadAccess: "agent:read",
  loadExposure: "agent:read",
  // The three mutations, at the same weak floor the server files them under — see its own note.
  // A GUARD MUST NOT USE THESE ROWS ALONE: `member:read` is every member's, so `useCanRun(
  // "grantAccess")` would render a Grant button for everybody. The real gate is `admin` at the
  // agent scope, which is what `useCapability("admin", agent.id)` asks; these entries exist so the
  // table stays a complete copy of the server's, which is what `test:permission-ui` holds it to.
  grantAccess: "member:read",
  modifyGrant: "member:read",
  revokeGrant: "member:read",
  // §14's two, at the same floor and gated at `admin` on the agent — they read and END connections
  // rather than change permissions, which is why they are not filed with the audit log.
  loadSessions: "member:read",
  // §15's history, at the same floor and gated at `admin` on the agent — where it deliberately
  // differs from `listAudit`: that one is the whole log and the owner's, this is the same rows
  // narrowed to one agent, and whoever administers that agent is who needs to read them.
  loadAccessHistory: "member:read",
  endSession: "member:read",
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
  listGithub: "github:read",
  listGithubRepos: "github:read",
  checkGithubRepo: "github:read",
  refreshGithub: "github:read",
  diagnoseFile: "github:read",
  listShadowRuns: "github:read",
  semanticDiffGithub: "github:read",
  listScanFindings: "github:read",
  linkGithub: "github:manage",
  unlinkGithub: "github:manage",
  pushGithub: "github:manage",
  pullGithub: "github:manage",
  switchGithubBranch: "github:manage",
  createGithubBranch: "github:manage",
  openGithubPr: "github:manage",
  commitGithub: "github:manage",
  generateGithubMessage: "github:manage",
  shadowRunGithub: "github:manage",
  resolveReviewComment: "github:manage",
  setAgentCiConfig: "github:manage",
};

/**
 * The capabilities behind the surfaces that are HTTP routes rather than socket commands.
 *
 * FOUR OF §8.2's ROWS ARE NOT COMMANDS AT ALL, and a checklist walked with `COMMAND_CAPABILITY`
 * alone would find nothing to guard them with. Each one is HTTP for a reason the server states
 * where it lives: a credential cannot go over a socket because elevation rides on a request header
 * a WebSocket cannot carry, and an export is a file a browser downloads rather than a frame on a
 * multiplexed connection.
 *
 * NAMED HERE RATHER THAN INLINE at the four call sites, so the answer to "what does this surface
 * need" is in one file for every surface — and so `test:permission-ui` can assert these against the
 * routes' own checks the way it asserts the table above against the relay's.
 */
export const ROUTE_CAPABILITY: Record<string, string> = {
  /** `POST /v1/secrets` and its rotate / reveal siblings. Also the Connections tab's key fields. */
  secretWrite: "secret:manage",
  /** `GET /v1/secrets` — names, masks, health. No value ever crosses this. */
  secretRead: "secret:read",
  /** `POST /v1/workspace/export`, and the status poll behind it. */
  workspaceExport: "workspace:manage",
  /** `DELETE /v1/workspace` — the one that also requires the id typed out. */
  workspaceDelete: "workspace:manage",
  /** `POST /v1/workspaces/rename`. The route accepts an admin as well; see its own note. */
  workspaceRename: "workspace:manage",
  /** `POST /v1/billing/checkout` and the plan changes reached from it. */
  billingCheckout: "billing:manage",
};

/** The capability a command needs, or undefined for one nothing has classified. */
export function capabilityFor(cmd: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITY, cmd)
    ? COMMAND_CAPABILITY[cmd]
    : undefined;
}

/**
 * Whether a role may send a command.
 *
 * AN UNCLASSIFIED COMMAND IS REFUSED, not allowed, which is the relay's own rule and matters more
 * here than it looks: the relay refuses one loudly, so a client that RENDERED an affordance for it
 * would be offering a button whose only outcome is an error on a channel. `test:permission-ui`
 * asserts the set cannot be reached, so this branch is a floor rather than a behaviour.
 */
export function canRun(role: string | null | undefined, cmd: string): boolean {
  const capability = capabilityFor(cmd);
  return capability === undefined ? false : can(role, capability);
}

// --- the same idea, one level down: what may this account do to ONE agent ----------------------
//
// A COPY OF THE SERVER'S AGENT-LEVEL MATRIX, held to it by `test:permission-ui` exactly as the
// table above is, and copied for the same reason §8.1 gives: the alternative puts a resolved set on
// the session that has to be recomputed and re-sent every time anything changes — and here things
// change more often, because a grant can be written by somebody else while this tab is open.
//
// WHAT IS **NOT** COPIED IS THE GRANT ITSELF. The ceiling and the implications are data and live
// here; the grant is a row and lives in `accessStore`, fetched by `loadAccess` per agent. Those two
// are combined by `useCapability(cap, agentId)` — one function, the same shape as the server's
// resolver, and deliberately not a second hook. See `useCapability`'s own note for why a
// `useAgentCapability` would be the two-resolver drift this whole feature exists to prevent.

/** The seven, in the order the panel renders them. Spelled exactly as the server spells them. */
export const AGENT_CAPABILITIES = [
  "view", "run", "edit", "eval", "deploy", "secrets", "admin",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * Whether a string is one of the seven.
 *
 * THE TWO VOCABULARIES ARE DISJOINT ON PURPOSE — every workspace capability carries a colon and no
 * agent capability does — and this is what lets `useCapability` tell which question it is being
 * asked. A guard that passed `"deploy:manage"` with an agent id is asking about a workspace and
 * naming an agent, which is a mistake rather than a request, and answering it as either would be
 * answering a question nobody asked.
 */
export function isAgentCapability(v: unknown): v is AgentCapability {
  return typeof v === "string" && (AGENT_CAPABILITIES as readonly string[]).includes(v);
}

/**
 * What each capability drags in with it. The server's `AGENT_IMPLIES`, copied.
 *
 * THE GRANT DIALOG READS THIS, which is the reason it is data rather than three lines in a
 * checkbox handler: §11.1 asks that ticking `edit` light up `run` and that unticking `view` clear
 * everything, and a handler implementing that would be a second copy of a rule the server applies
 * again when it stores the row. Two copies means a dialog that shows a set the server will not
 * honour, or honours one the dialog never showed.
 */
const AGENT_IMPLIES: Record<AgentCapability, readonly AgentCapability[]> = {
  view: [],
  run: ["view"],
  // Transitively `view`, through `run`.
  edit: ["run"],
  eval: ["view"],
  deploy: ["view"],
  secrets: ["view"],
  admin: ["view"],
};

/**
 * A capability set with everything it implies, transitively.
 *
 * A WALK RATHER THAN ONE PASS, for the reason the server's is: `edit` names `run` and `run` names
 * `view`, so a single pass produces {edit, run} and loses the capability every other capability
 * implies. The failure hides things — somebody granted `edit` would see an agent they can edit and
 * cannot open.
 */
export function closeAgentCapabilities(set: Iterable<string>): Set<AgentCapability> {
  const out = new Set<AgentCapability>();
  const pending = [...set];
  while (pending.length > 0) {
    const next = pending.pop() as AgentCapability;
    if (!(AGENT_CAPABILITIES as readonly string[]).includes(next) || out.has(next)) continue;
    out.add(next);
    pending.push(...AGENT_IMPLIES[next]);
  }
  return out;
}

/** What a member holds on every agent by default. The server's `AGENT_MEMBER`. */
const AGENT_MEMBER: readonly AgentCapability[] = ["view", "run", "edit", "eval"];

/**
 * The default set each workspace role holds on any agent — which is also its CEILING.
 *
 * ONE LIST FOR BOTH, as on the server, because that is invariant B as a data structure: a grant may
 * narrow this or widen within it and nothing can widen past it, so two lists would make "a grant
 * that exceeds the role" a state this client could represent and therefore eventually render.
 *
 * ADMIN AND OWNER HOLD ALL SEVEN, which is not a missing distinction: everything separating the two
 * — membership, billing, the workspace itself — is above this scope entirely, and there is no
 * per-agent act an owner may perform and an admin may not.
 */
export const ROLE_AGENT_CAPABILITIES: Record<Role, readonly AgentCapability[]> = {
  member: AGENT_MEMBER,
  admin: AGENT_CAPABILITIES,
  owner: AGENT_CAPABILITIES,
};

/**
 * The ceiling a workspace role puts on any grant.
 *
 * A NULL OR UNKNOWN ROLE HOLDS NOTHING, which is the state before a session lands and after a sign
 * out — the same answer `can` gives one scope up, and for the same reason: answering otherwise
 * would flash every control on screen for the frame before the session arrives, on every load.
 */
export function agentCeiling(role: string | null | undefined): Set<AgentCapability> {
  const declared = role ? ROLE_AGENT_CAPABILITIES[role as Role] : undefined;
  return closeAgentCapabilities(declared ?? []);
}

/**
 * The effective set: the role's ceiling, narrowed or widened by a grant, closed under implication.
 *
 * THE SERVER'S `resolveCapabilities`, ONE STEP SHORTER. Steps 1, 2, 4 and 5 are here; step 3 —
 * loading the grant and checking its expiry — happened when `loadAccess` answered, so what arrives
 * is the set the server already decided was live. The intersection is repeated anyway, for the
 * reason the server repeats it: a role can change in this tab, in place, on a revalidation tick,
 * without the grant being refetched.
 *
 * AND NONE OF THIS IS ENFORCEMENT. Every command is resolved again by the relay against the same
 * matrix; what this decides is what to RENDER.
 */
export function effectiveAgentCapabilities(
  role: string | null | undefined,
  grant: readonly string[] | null,
): Set<AgentCapability> {
  const ceiling = agentCeiling(role);
  if (!grant) return ceiling;
  return closeAgentCapabilities([...grant].filter((c) => ceiling.has(c as AgentCapability)));
}

/**
 * Which AGENT-level capability each agent-scoped command needs. The server's table, copied.
 *
 * WHY A GUARD SHOULD REACH FOR THIS RATHER THAN NAMING A CAPABILITY, for the reason the workspace
 * table above gives: `canRunOnAgent(role, grant, "deploy")` names the button's own command, where
 * `useCapability("deploy", id)` names a conclusion somebody drew about it — and the conclusion is
 * the half that looks equally plausible in review when it is wrong.
 */
export const COMMAND_AGENT_CAPABILITY: Record<string, AgentCapability> = {
  loadAgentDetail: "view",
  loadAgentFiles: "view",
  loadAgentGraph: "view",
  loadAgentVersion: "view",
  explain: "view",
  listDatasets: "view",
  estimateEval: "view",
  getActivityFeed: "view",
  planDeploy: "view",
  forkAgent: "view",
  createThread: "view",
  listGithub: "view",
  refreshGithub: "view",
  listScanFindings: "view",
  listShadowRuns: "view",
  semanticDiffGithub: "view",
  diagnoseFile: "view",
  loadAccess: "view",
  loadExposure: "view",

  run: "run",
  shadowRunGithub: "run",

  edit: "edit",
  undoEdit: "edit",
  archiveAgent: "edit",
  restoreAgent: "edit",
  renameAgent: "edit",
  restoreAgentVersion: "edit",

  startEval: "eval",
  createDataset: "eval",
  deleteDataset: "eval",
  promoteTestInput: "eval",

  deploy: "deploy",
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
  setAgentCiConfig: "deploy",

  grantAccess: "admin",
  modifyGrant: "admin",
  revokeGrant: "admin",
  loadSessions: "admin",
  loadAccessHistory: "admin",
  endSession: "admin",
};

/** The agent-level capability a command needs, or undefined for one that is not agent-scoped. */
export function agentCapabilityFor(cmd: string): AgentCapability | undefined {
  return Object.prototype.hasOwnProperty.call(COMMAND_AGENT_CAPABILITY, cmd)
    ? COMMAND_AGENT_CAPABILITY[cmd]
    : undefined;
}

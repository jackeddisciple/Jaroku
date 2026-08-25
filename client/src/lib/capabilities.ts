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

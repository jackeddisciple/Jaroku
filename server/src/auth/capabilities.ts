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
  /** See what this workspace has connected, and which connection needs reconnecting. */
  "connector:read",
  "deploy:read",
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

  // --- commits the workspace to something outside itself: admin ---------------------------
  /** Connect, re-discover, remove or re-classify a third-party MCP server. */
  "mcp:manage",
  /** Store or test a model-provider API key. */
  "provider:manage",
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
  "connector:read",
  "deploy:read",
  "member:read",
  "billing:read",
];

/** What an admin adds. Nested, so a new member capability is automatically an admin's too. */
const ADMIN: readonly Capability[] = [
  ...MEMBER, "mcp:manage", "provider:manage", "connector:manage", "deploy:manage",
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

/**
 * The one check. Throws a 403 naming the capability and the role that lacks it.
 *
 * Naming both is deliberate: "forbidden" with no subject sends somebody to read source, and
 * neither the capability nor their own role is a secret from a member of the workspace.
 */
export function requireCapability(ctx: TenantContext, capability: Capability): void {
  if (!can(ctx.role, capability)) {
    throw forbidden(`a ${ctx.role} cannot do this — it needs ${capability}`);
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
  listAgents: "agent:read",
  loadAgentFiles: "agent:read",
  loadAgentGraph: "agent:read",
  explain: "agent:read",

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
  setProviderKey: "provider:manage",
  testProviderKey: "provider:manage",
  // provider:manage rather than billing:manage. It decides which of two credentials pays for a
  // call, not what the workspace is subscribed to — and the person who connected the key is the
  // one who knows whether their provider account should carry the platform's calls too.
  setOwnKeyForPlatform: "provider:manage",

  // membership
  loadUsage: "billing:read",

  listMembers: "member:read",
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

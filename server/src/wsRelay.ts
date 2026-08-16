// WebSocket relay (doc §8): pushes trace events to browser clients in real time, and
// serves the static debug client over the same HTTP port. On connect, a client receives the
// run history snapshot; thereafter it receives live events as they arrive.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import type { TraceStore } from "./store.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { TraceEvent } from "./types.ts";
import type { Router } from "./http/router.ts";
import {
  CONNECTIONS_CHECK_INTERVAL_MS,
  documentSecurityHeaders,
  HEADERS_READ_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_READ_TIMEOUT_MS,
} from "./http/security.ts";
import { can, capabilityFor } from "./auth/capabilities.ts";

export type RunCommand = {
  cmd: "run";
  input?: string;
  provider?: string;
  model?: string;
  agentId?: string;
};
export type LoadRunCommand = { cmd: "loadRun"; runId: string };
export type GenerateCommand = {
  cmd: "generate";
  prompt: string;
  connectors?: string[];
  /**
   * The MCP tools this agent is scoped to, as `"server/tool"` refs.
   *
   * Per-TOOL rather than per-server, and that is the least-privilege rule in one field: a
   * connected server's whole catalogue is never handed to an agent because the server
   * happens to be connected. Only what was selected here can reach the manifest.
   */
  mcpTools?: string[];
  name?: string;
  /** A plan the user confirmed. The server builds what that plan describes, not what this
   *  command's other fields say — see planner.take(). */
  planId?: string;
};
// The pre-generation gate: describe the agent, see a plan, confirm. `revisePlanId` turns
// `prompt` into feedback on the plan with that id rather than a fresh brief.
export type PlanAgentCommand = {
  cmd: "planAgent";
  prompt: string;
  connectors?: string[];
  /** Scoped MCP tools, as `"server/tool"` refs. See GenerateCommand.mcpTools. */
  mcpTools?: string[];
  name?: string;
  revisePlanId?: string;
};
export type DiscardPlanCommand = { cmd: "discardPlan"; planId: string };
export type ListAgentsCommand = { cmd: "listAgents" };
// The fix loop (doc §8 Week 4): every mutation is proposal -> explicit apply/undo.
export type EditCommand = { cmd: "edit"; agentId: string; instruction: string };
export type ApplyEditCommand = { cmd: "applyEdit"; proposalId: string };
export type UndoEditCommand = { cmd: "undoEdit"; agentId: string };
export type DiscardEditCommand = { cmd: "discardEdit"; proposalId: string };
export type LoadAgentFilesCommand = { cmd: "loadAgentFiles"; agentId: string };
// Graph View (Week 5): request the agent's static LangGraph topology. Answered locally by
// spawning the isolated `jaroku_runner.graph` entrypoint — never touches the trace stream.
export type LoadAgentGraphCommand = { cmd: "loadAgentGraph"; agentId: string };
// Debug depth (Week 6): pause a running run at its next node boundary, or resume a paused run
// from its durable checkpoint. Both are forwarded to the app (control-plane, never touch the
// frozen trace stream).
export type PauseRunCommand = { cmd: "pauseRun"; runId: string };
export type ResumeRunCommand = { cmd: "resumeRun"; runId: string };
// Session 5: stop a run outright rather than pausing it at its next boundary. Distinct from
// pauseRun — a paused run is resumable from its checkpoint, a cancelled one is not; it is
// killed and its interactive reservation (if it held one) is released immediately rather
// than waiting for the process to unwind on its own.
export type CancelRunCommand = { cmd: "cancelRun"; runId: string };
// Fork a new run from `fromRunId` at step `atSeq` (its node boundary), optionally with a
// validated domain-field edit applied to the state before continuing. Original run is untouched.
export type BranchRunCommand = {
  cmd: "branchRun";
  fromRunId: string;
  atSeq: number;
  editNode?: string;
  editedState?: Record<string, unknown>;
};
// Eval Engine (Week 7): dataset CRUD. These are control-plane commands like pause/resume —
// they mutate the eval tables and never touch the frozen trace stream. They're forwarded
// to the app rather than answered here so the relay stays a transport and doesn't grow a
// second store dependency; the app answers by broadcasting on the "eval" channel.
export type CreateDatasetCommand = { cmd: "createDataset"; agentId: string; name: string };
export type RenameDatasetCommand = { cmd: "renameDataset"; datasetId: string; name: string };
export type DeleteDatasetCommand = { cmd: "deleteDataset"; datasetId: string; agentId: string };
export type ListDatasetsCommand = { cmd: "listDatasets"; agentId?: string };
export type LoadDatasetCommand = { cmd: "loadDataset"; datasetId: string };
export type AddExampleCommand = {
  cmd: "addExample";
  datasetId: string;
  input: string;
  expected?: string | null;
  notes?: string | null;
};
export type UpdateExampleCommand = {
  cmd: "updateExample";
  datasetId: string;
  exampleId: string;
  input?: string;
  expected?: string | null;
  notes?: string | null;
};
export type DeleteExampleCommand = { cmd: "deleteExample"; datasetId: string; exampleId: string };
// One-click "promote this test input into the eval dataset" (doc §4.7.6). It resolves the
// target dataset server-side (agent's most recent, or a new default) so promotion is a
// single round trip and lands in the SAME dataset_examples table the builder writes —
// there is deliberately no second way to create an eval example.
export type PromoteTestInputCommand = {
  cmd: "promoteTestInput";
  agentId: string;
  agentName?: string;
  input: string;
  expected?: string | null;
};
/** Fan a dataset out across providers. `budgetUsd` is a hard ceiling on TRUE spend. */
export type StartEvalCommand = {
  cmd: "startEval";
  datasetId: string;
  agentId: string;
  targets: { provider: string; model: string }[];
  budgetUsd?: number | null;
};
export type CancelEvalCommand = { cmd: "cancelEval"; evalId: string };
// The rubric is product surface, not a constant — "correct" for a refund bot is not
// "correct" for a SQL agent. Saving one for a dataset overrides the shared default.
export type LoadRubricCommand = { cmd: "loadRubric"; datasetId: string };
/** The comparison dashboard's data: per-provider rollups plus per-example rows. */
export type LoadEvalResultsCommand = { cmd: "loadEvalResults"; evalId: string };
/** Past evals for a dataset (or all), so a finished comparison stays reachable. */
export type ListEvalsCommand = { cmd: "listEvals"; datasetId?: string };
/** What a real-provider eval will roughly cost, BEFORE committing to it. */
export type EstimateEvalCommand = {
  cmd: "estimateEval";
  datasetId: string;
  agentId: string;
  targets: { provider: string; model: string }[];
};
export type SaveRubricCommand = {
  cmd: "saveRubric";
  datasetId: string;
  name?: string;
  criteria: { id: string; label: string; description: string; weight: number }[];
};

// MCP server management. Control-plane commands like the eval set: they mutate the MCP
// registry tables and never touch the frozen trace stream. Forwarded to the app rather than
// answered here because connecting is a network round trip against an unreviewed third
// party — it can take seconds, fail in four different ways, and the app owns the registry
// that knows which. `listMcpServers` is the exception and is answered locally, like
// `listAgents`, because it is a pure read of state already in memory.
export type AddMcpServerCommand = {
  cmd: "addMcpServer";
  endpoint: string;
  label?: string;
  /**
   * A bearer token or API key, if the server needs one.
   *
   * This is the first of three fields on any command in this file that carry a secret (see
   * SetProviderKeyCommand.key and SetRailwayTokenCommand.token). It travels
   * one way — browser to server, over the loopback socket the whole product runs on — and
   * is written to runtime/.env and forgotten. Nothing ever sends it back: a server reports
   * `configured: true`, never its credential. See envWriter.ts.
   */
  token?: string;
};
export type RemoveMcpServerCommand = { cmd: "removeMcpServer"; serverId: string };
/** Re-run the handshake. On failure the previously discovered tools are kept. */
export type RediscoverMcpServerCommand = { cmd: "rediscoverMcpServer"; serverId: string };
export type ListMcpServersCommand = { cmd: "listMcpServers" };
/**
 * A user's explicit override of the impact classification. `impact: null` clears it and
 * returns the tool to whatever the classifier says.
 */
export type SetMcpToolImpactCommand = {
  cmd: "setMcpToolImpact";
  serverId: string;
  toolName: string;
  impact: "high" | "low" | null;
};

/**
 * Answer a pending confirmation. `verdict` is "once" | "run" | "deny".
 *
 * "run" grants for the remainder of THIS run only; nothing persists past it.
 */
export type ResolveMcpConfirmCommand = {
  cmd: "resolveMcpConfirm";
  runId: string;
  nonce: string;
  verdict: "once" | "run" | "deny";
};

/** Set or clear a server's credential. `token: null` removes the key entirely. */
export type SetMcpServerAuthCommand = {
  cmd: "setMcpServerAuth";
  serverId: string;
  token: string | null;
};

// Connector connections. Three commands, and none of them carries a credential in either
// direction — which is the difference between this set and the MCP and provider sets above,
// where a token travels browser-to-server exactly once. Here the credential never touches this
// process from the browser at all: it is minted by the provider and collected at the callback.

/** Every connector this deployment can connect, with what this workspace has done about each. */
export type ListConnectionsCommand = { cmd: "listConnections" };

/**
 * Begin a flow. Answered with a URL to navigate to, never with a redirect.
 *
 * `returnTo` is a PATH within this app and is treated as one — see oauth/provider.ts, where
 * anything that could be absolute is discarded rather than sanitised. A callback that redirects
 * to whatever it was handed is a phishing primitive on our own domain wearing our own certificate.
 */
export type ConnectConnectorCommand = { cmd: "connectConnector"; connectorId: string; returnTo?: string };

/**
 * Hand the grant back and forget the credentials.
 *
 * Named `disconnect` rather than `delete` because both halves happen and the second is the one
 * people forget: the tokens are revoked AT THE PROVIDER, not merely dropped locally. A token
 * deleted from our vault and left live in Google's is a grant the user believes they have ended.
 */
export type DisconnectConnectorCommand = { cmd: "disconnectConnector"; connectorId: string };

// Model-provider credentials. Grouped and forwarded exactly like the MCP set above, for the
// same reason: writing a key touches runtime/.env and — for the test — makes a network call
// against someone else's API, so the app answers with a precise result rather than the relay
// guessing. `listProviders` is the exception and is answered locally, like `listMcpServers`,
// because it is a pure read of state already in memory.

// STORING AND TESTING A PROVIDER KEY ARE NOT COMMANDS ON THIS SOCKET, AND THAT IS THE POINT.
//
// They were: `setProviderKey` took a raw key from the browser and wrote it, and `testProviderKey`
// probed one. Both were classified `provider:manage` and both worked with nothing but a session —
// which meant the passcode gate the entire Secrets surface is built on could be walked around by
// anybody who opened the top bar's popover. A gate that holds on one transport and not the other
// is not a gate, and the brief says so in its opening section: gating the UI is not gating the data.
//
// It cannot be fixed by adding a check here, because elevation rides on a REQUEST HEADER and a
// browser cannot set one on a WebSocket — that constraint is exactly why the secrets routes are
// HTTP in the first place. So the commands are gone rather than guarded, and `POST /v1/secrets` and
// `POST /v1/secrets/:name/test` are the one way in. That also settles §5.1's other complaint: two
// homes for a credential meant two rotation paths and two validation paths, and this was the one
// that classified nothing, stored no mask, and wrote no audit row.
export type ListProvidersCommand = { cmd: "listProviders" };

/** Provider-channel commands, grouped so the forwarding switch stays readable. */
/**
 * Decide whether THIS WORKSPACE'S key pays for the platform's own calls on its behalf —
 * generation, the plan gate, the fix loop, explain, the judge.
 *
 * An explicit boolean rather than a toggle, so two clicks racing end up where the user last
 * said rather than wherever the ordering left them. Carries no credential: the key is already
 * stored, and this decides only what it is allowed to pay for.
 */
export type SetOwnKeyForPlatformCommand = { cmd: "setOwnKeyForPlatform"; on: boolean };

/**
 * What this workspace has spent this period, and against what.
 *
 * Its own channel rather than a field on `providers`, because the two answer different questions
 * at different rates: what is connected changes when somebody pastes a key, and what has been
 * spent changes on every step of every run. A snapshot that carried both would either be sent
 * far too often or be stale half the time.
 */
export type LoadUsageCommand = { cmd: "loadUsage" };

/** The billing channel. A full snapshot, like every other channel here — never a merge. */
export type BillingEvent =
  | { type: "usage"; usage: unknown }
  | { type: "error"; message: string };

export type ProviderCommand = SetOwnKeyForPlatformCommand;

const PROVIDER_COMMANDS = new Set(["setOwnKeyForPlatform"]);

/**
 * Forwarded, not answered locally — unlike `listProviders` and `listAgents` beside it.
 *
 * The relay holds no billing repository and should not grow one. What it would have to reach for
 * is a balance, a plan, a period rollup and a ceiling, which is four dependencies for one read;
 * the app already owns all four and answers on the `billing` channel.
 */
const BILLING_COMMANDS = new Set(["loadUsage"]);

// Deploy. Everything below rides beside the frozen schema in a new channel, exactly as
// pause/resume, the eval engine and the MCP registry did — a deploy is not an agent run and
// emits no trace events at all.
//
// One rule governs every shape here: NAMES TRAVEL, VALUES DO NOT. A deploy hands the user's
// own credentials to their own hosting account, and nothing about that transaction needs a
// value to cross this socket. The only exception is the same one the other two credential
// commands are: a token going ONE WAY, browser to server, to be written to runtime/.env.

/**
 * What a deploy would need, before committing to one. Answered on the deploy channel with a
 * plan: variable names, what is missing, what would be refused. Nothing is created and
 * nothing is spent, so this is safe to call whenever the form changes.
 */
export type PlanDeployCommand = {
  cmd: "planDeploy";
  agentId: string;
  provider: string;
  model: string;
};

/** Start a deploy. `envKeys` are NAMES the user ticked — the server reads the values. */
export type DeployCommand = {
  cmd: "deploy";
  agentId: string;
  provider: string;
  model: string;
  envKeys: string[];
  /** Proceed even though a declared variable has no value on this machine. */
  allowMissing?: boolean;
  /** Serve with no bearer token. The UI has to ask for this explicitly; it is never default. */
  publicEndpoint?: boolean;
};

export type CancelDeployCommand = { cmd: "cancelDeploy"; deploymentId: string };

/** Detach a deployment record from Jaroku. Never touches anything in the user's account. */
export type ForgetDeploymentCommand = { cmd: "forgetDeployment"; deploymentId: string };

export type ListDeploymentsCommand = { cmd: "listDeployments" };
export type LoadDeployLogsCommand = { cmd: "loadDeployLogs"; deploymentId: string; sinceSeq?: number };

/**
 * Store the user's Railway token. Answered with a fresh deploy snapshot.
 *
 * `token` is the third and last field on any command in this file that carries a secret (see
 * AddMcpServerCommand.token and SetProviderKeyCommand.key). Same discipline, same writer: one
 * way, browser to server, into runtime/.env, forgotten. What comes back is `configured: true`.
 * `token: null` removes the key.
 */
export type SetRailwayTokenCommand = { cmd: "setRailwayToken"; token: string | null };

/**
 * Prove a Railway token works without storing it — the "Test connection" button, again.
 *
 * A separate command for the reason testProviderKey is: a test that wrote first would put a
 * credential on disk before the user pressed Save.
 */
export type TestRailwayTokenCommand = { cmd: "testRailwayToken"; token: string };

/** Deploy-channel commands, grouped so the forwarding switch stays readable. */
export type DeployChannelCommand =
  | PlanDeployCommand
  | DeployCommand
  | CancelDeployCommand
  | ForgetDeploymentCommand
  | LoadDeployLogsCommand
  | SetRailwayTokenCommand
  | TestRailwayTokenCommand;

const DEPLOY_COMMANDS = new Set([
  "planDeploy", "deploy", "cancelDeploy", "forgetDeployment", "loadDeployLogs",
  "setRailwayToken", "testRailwayToken",
]);

// GitHub. Full git control from inside Jaroku, on its own channel.
//
// NOT ONE COMMAND HERE CARRIES A CREDENTIAL, and that is the constraint the whole command set is
// shaped around rather than an accident of what happened to be needed. Elevation rides on a
// request header and a browser cannot set one on a WebSocket — which is exactly why
// `setProviderKey` was removed from this file — so linking a GitHub account is an HTTP route in
// the secrets group and everything below it is a socket command about REPOSITORIES, not about
// tokens. `githubConnected` is a boolean and an account login; the token behind it is a name in
// the vault that never leaves the server.
//
// The read/manage split follows `deploy:read` / `deploy:manage`. Looking at where an agent's code
// went is a read every member does; pointing an agent at a different repository commits the
// workspace to something outside itself, and pushing writes source code into somebody's account.
export type ListGithubCommand = { cmd: "listGithub"; agentId?: string };
/** The repositories this workspace's token can write to. Answers names, never a credential. */
export type ListGithubReposCommand = { cmd: "listGithubRepos"; query?: string };
/** §2.2's live availability check, one keystroke at a time. Creates nothing. */
export type CheckGithubRepoCommand = { cmd: "checkGithubRepo"; name: string };
export type LinkGithubCommand = {
  cmd: "linkGithub";
  agentId: string;
  /** An existing `owner/repo`, or the bare name of one to create under the linked account. */
  repoFullName?: string;
  createName?: string;
  createPrivate?: boolean;
  branch?: string;
  subdirectory?: string | null;
  includeArtifacts?: boolean;
};
export type UnlinkGithubCommand = { cmd: "unlinkGithub"; agentId: string };
/**
 * Re-read the remote and recompute the verdict. Read-only, and the cheap one.
 *
 * It updates `last_known_remote_sha` and touches neither the working state nor the divergence
 * flow, so it carries none of the confirmation weight push and pull do — which is what makes it
 * safe to run on opening the panel rather than only on a click.
 */
export type RefreshGithubCommand = {
  cmd: "refreshGithub";
  agentId: string;
  /**
   * Whether a person asked for this — §A.1's Fetch.
   *
   * ONE COMMAND RATHER THAN TWO, and the flag is the whole difference. The panel already refreshes
   * on open, and "Fetch" does exactly the same read: it updates `last_known_remote_sha` without
   * touching the working tree or opening the divergence flow, which is why it carries none of the
   * confirmation weight Push and Pull do. A second command would be a second implementation of one
   * read, and the day they drift the automatic one and the deliberate one disagree about what the
   * remote says.
   *
   * What the flag buys is the AUDIT ROW. "Somebody checked at 14:02" is worth recording; "the panel
   * was open" is not, and writing an event per render would drown the history the force-override
   * rows live in.
   */
  explicit?: boolean;
};
export type PushGithubCommand = {
  cmd: "pushGithub";
  agentId: string;
  /** §2.3's opt-in. Per push, never a stored preference. */
  squash?: boolean;
  /**
   * Overwrite the branch.
   *
   * Carried as a field rather than as its own command so that the ordinary path and the escape
   * hatch go through one handler and one audit row — a separate `forcePushGithub` would be a
   * second code path that could drift out of writing the event.
   */
  force?: boolean;
  /** The agent slug, typed by the user, when `force` is set. Refused without it. */
  confirmSlug?: string;
  /**
   * §B.4.1's hand-staged subset. Absent means the ordinary push; an empty array means somebody
   * unticked everything, which is refused rather than treated as the same thing.
   */
  stage?: { path: string; hunks: number[] }[];
  /**
   * §B.4.4's restacked order over the UNPUSHED list. A step with several ids is a squash, an
   * omitted version is a drop, and an amend is a squash of the tip with the version before it.
   *
   * CARRIED WITH THE PUSH RATHER THAN STORED, which is why §B.9 needs no table for it: a restack
   * rearranges the commits THIS push writes and has no lifetime beyond it. Cancelling leaves every
   * `agent_versions` row exactly where it was.
   */
  steps?: { versionIds: string[] }[];
  /** §3.4's message box, for a hand-staged subset that has no version's instruction to borrow. */
  message?: string;
  /**
   * §B.6.1's "Ignore & push anyway", from under the kebab.
   *
   * Its own field rather than its own command, for the reason `force` is: one handler, one scan,
   * one recorded outcome — and the findings are written either way, which is what makes the
   * override auditable at all.
   */
  ignoreSecrets?: boolean;
};
export type PullGithubCommand = {
  cmd: "pullGithub";
  agentId: string;
  /** Publish a candidate the validator refused. Same typed-slug bar as a force push. */
  force?: boolean;
  confirmSlug?: string;
};
export type SwitchGithubBranchCommand = {
  cmd: "switchGithubBranch";
  agentId: string;
  branch: string;
  /** §3.2 offers three answers when there is unpushed work, and never a silent overwrite. */
  onUnpushed?: "push" | "keep" | "cancel";
};
export type CreateGithubBranchCommand = { cmd: "createGithubBranch"; agentId: string; branch: string };
export type OpenGithubPrCommand = { cmd: "openGithubPr"; agentId: string };
/** §3.4's commit box: a hand-staged subset of the changed files, with a message. */
export type CommitGithubCommand = {
  cmd: "commitGithub";
  agentId: string;
  /**
   * NO `paths` FIELD, and its removal is the design being stated rather than a capability lost.
   *
   * It carried the unlocked changed files and the handler ignored every one of them, which was
   * survivable only because the client could not compute anything else to send: the Changes region
   * has no stage/unstage control, because Jaroku has no working tree and there is no half-committed
   * state a checkbox could describe. A field that always holds a derivable value and is never read
   * is a promise of partial staging that this surface cannot keep — see ChangesRegion's own note.
   * Partial staging arrives with a real index behind it or not at all.
   */
  message: string;
  /** §A.8's second half — commit, then push, in one step. */
  push?: boolean;
  /**
   * §B.6.1's "Ignore & push anyway", here as well as on `pushGithub`.
   *
   * NOT A DUPLICATE FIELD SO MUCH AS THE SAME ONE ON THE OTHER DOOR. The commit box resolves to a
   * push — `handleGithubCommand` says so at length — so the scan refuses it identically, and a
   * surface that could be refused with no way to override would be an escape hatch that exists
   * everywhere except where somebody hit the wall.
   */
  ignoreSecrets?: boolean;
};

/**
 * §3.4's ✨ generate.
 *
 * A SEPARATE COMMAND RATHER THAN A FLAG ON `commitGithub`, because it is the one thing in this
 * family that COSTS MONEY. Folding it into the commit would mean a commit that sometimes makes a
 * model call and sometimes does not, metered against a workspace's balance, decided by a checkbox
 * — and the default path (§3.4's pre-fill from the version's own instruction and summary) needs no
 * call at all, which is the property worth keeping visible.
 */
export type GenerateGithubMessageCommand = { cmd: "generateGithubMessage"; agentId: string };

/**
 * §B.3's live diagnostics: analyse a buffer nobody has saved.
 *
 * ON THE GITHUB CHANNEL BECAUSE THE SURFACE IS, and that is worth stating because the file editor
 * is not otherwise a GitHub thing. §B.3 puts a real editor in the diff/file view — the view this
 * addendum's staging column, semantic diff and PR loop all live in — and the diagnostics it draws
 * are read there. A channel of its own would be a channel with one message on it, delivered to the
 * same clients, cleared by the same navigation.
 *
 * THE SOURCE TRAVELS WITH THE COMMAND, which is the one place this differs from every other
 * command in this file: the rest name something the server can look up, and this one carries text
 * the server has never seen. That is the whole point — the buffer is unsaved, so there is nothing
 * to look up — and it is why the handler treats the content as untrusted input to a parser rather
 * than as an agent's published bytes.
 */
export type DiagnoseFileCommand = {
  cmd: "diagnoseFile";
  agentId: string;
  /** Project-relative, POSIX. Used to decide whether the contract checks apply. */
  path: string;
  source: string;
  /**
   * A monotonic number the client increments per request.
   *
   * ECHOED BACK UNCHANGED so a client can drop an answer that is about text it has already
   * replaced. Answers arrive over a socket in whatever order the network delivers them, and a
   * stale one would paint squiggles under lines that have since moved — the same staleness the
   * repo-name availability check solves by comparing the name back.
   */
  nonce?: number;
};

/**
 * §B.2's `[ Run ◆ ]`: run a ref once, without switching to it.
 *
 * DELIBERATELY NOT `switchGithubBranch` WITH A FLAG. §3.2 treats switching as heavy because it
 * re-materialises the agent's working state, and the whole point of a shadow run is that it does
 * not do that — folding the two into one command with a boolean would put the heavy action and the
 * disposable one behind the same name, one keystroke apart.
 */
export type ShadowRunGithubCommand = {
  cmd: "shadowRunGithub";
  agentId: string;
  /** The ref, as the user named it: a branch, a tag, or a sha. */
  ref: string;
  /** The test input to run it against. The same field an ordinary run takes. */
  input?: string;
  provider?: string;
  model?: string;
};

/** §B.2.2's transient list, which is deliberately not the ordinary run history. */
export type ListShadowRunsCommand = { cmd: "listShadowRuns"; agentId: string };

export type GithubCommand =
  | ListGithubCommand
  | ListGithubReposCommand
  | CheckGithubRepoCommand
  | LinkGithubCommand
  | UnlinkGithubCommand
  | RefreshGithubCommand
  | PushGithubCommand
  | PullGithubCommand
  | SwitchGithubBranchCommand
  | CreateGithubBranchCommand
  | OpenGithubPrCommand
  | CommitGithubCommand
  | GenerateGithubMessageCommand
  | DiagnoseFileCommand
  | ShadowRunGithubCommand
  | ListShadowRunsCommand;

const GITHUB_COMMANDS = new Set([
  "listGithub", "listGithubRepos", "checkGithubRepo", "linkGithub", "unlinkGithub",
  "refreshGithub", "pushGithub", "pullGithub", "switchGithubBranch", "createGithubBranch",
  "openGithubPr", "commitGithub", "generateGithubMessage", "diagnoseFile",
  "shadowRunGithub", "listShadowRuns",
]);

/** MCP-channel commands, grouped so the forwarding switch stays readable. */
export type McpCommand =
  | AddMcpServerCommand
  | RemoveMcpServerCommand
  | RediscoverMcpServerCommand
  | SetMcpToolImpactCommand
  | SetMcpServerAuthCommand
  | ResolveMcpConfirmCommand;

const MCP_COMMANDS = new Set([
  "addMcpServer", "removeMcpServer", "rediscoverMcpServer", "setMcpToolImpact",
  "setMcpServerAuth", "resolveMcpConfirm",
]);

/** Connection-channel commands, grouped so the forwarding switch stays readable. */
export type ConnectionCommand =
  | ListConnectionsCommand
  | ConnectConnectorCommand
  | DisconnectConnectorCommand;

// Forwarded rather than answered locally, INCLUDING the read. `listConnections` looks like
// `listMcpServers` — a pure read the relay could answer from state it already has — and is not:
// its answer depends on whether this DEPLOYMENT has an OAuth app configured, which is the app's
// business and not the relay's, and every mutation beside it makes a network call to a third
// party that can take seconds and fail four ways.
const CONNECTION_COMMANDS = new Set(["listConnections", "connectConnector", "disconnectConnector"]);

// Membership. Who may act in this workspace, and as what.
//
// Forwarded like every other mutation, and grouped so the switch stays readable. Reads are
// forwarded too rather than answered locally, which is a departure from `listAgents` and
// `listMcpServers` — those are lists of things the workspace owns, and this is a list of
// PEOPLE, with their email addresses. The relay holds no identity repository and should not
// grow one; the app answers on the `members` channel.
//
// Accepting an invite is deliberately NOT here. The accepter is not a member yet, so they have
// no socket scoped to the workspace they are joining — it is `POST /v1/invites/accept`, over
// HTTP, with a bearer token and nothing else. See auth/session.ts.
export type ListMembersCommand = { cmd: "listMembers" };
export type InviteMemberCommand = { cmd: "inviteMember"; email: string; role: string };
export type RevokeInviteCommand = { cmd: "revokeInvite"; inviteId: string };
export type SetMemberRoleCommand = { cmd: "setMemberRole"; userId: string; role: string };
export type RemoveMemberCommand = { cmd: "removeMember"; userId: string };

export type MemberCommand =
  | ListMembersCommand
  | InviteMemberCommand
  | RevokeInviteCommand
  | SetMemberRoleCommand
  | RemoveMemberCommand;

const MEMBER_COMMANDS = new Set([
  "listMembers", "inviteMember", "revokeInvite", "setMemberRole", "removeMember",
]);

// The members channel. Every mutation answers with a full snapshot, the same discipline the
// eval, MCP, provider and deploy channels follow — a client replaces rather than merges, so it
// can never hold a half-applied view of who is in the workspace.
//
// `inviteLink` is the exception, and it is the second credential this file ever sends to a
// browser (the first is the deploy bearer token). It is shown once because there is no email
// sender here to hand it to, and only a hash of it is stored — so this message is the only
// chance anybody has to see it, exactly like `serveToken`.
export type MemberEvent =
  | { type: "members"; members: unknown[]; invites: unknown[] }
  | { type: "inviteLink"; email: string; role: string; token: string; expiresAt: string }
  | { type: "error"; message: string }
  | { type: "notice"; message: string };

// Unified composer "explain": a prose answer about a step / node / the agent, built from
// in-context data — the one genuinely-new composer intent (no code change).
export type ExplainSubject =
  | { kind: "step"; step: { name: string; type: string; seq: number; error: string | null; input: unknown; output: unknown } }
  | { kind: "node"; nodeId: string }
  | { kind: "agent" };
/**
 * What the composer has attached from GitHub — §7.
 *
 * A LIST OF REFERENCES ON THE EXISTING COMMAND rather than a command of its own, and that shape is
 * the rule §7 closes with: the ⊕ menu brings context IN and never takes a git action. There is no
 * `attachGithub` verb here because attaching is not a thing that happens to a repository — it is
 * something a QUESTION carries, and the question is `explain`.
 *
 * Resolved server-side at send time, so a chip made five minutes ago describes the repository as it
 * is rather than as it was — see `githubService.resolveAttachments`.
 */
export type GithubAttachment =
  | { kind: "unpushed" }
  | { kind: "commit"; sha: string }
  | { kind: "file"; path: string; ref: string }
  | { kind: "sinceSync" }
  | { kind: "pr" };

export type ExplainCommand = {
  cmd: "explain";
  agentId: string;
  question: string;
  subject: ExplainSubject;
  github?: GithubAttachment[];
};
export type ClientCommand =
  | RunCommand
  | LoadRunCommand
  | GenerateCommand
  | PlanAgentCommand
  | DiscardPlanCommand
  | ListAgentsCommand
  | EditCommand
  | ApplyEditCommand
  | UndoEditCommand
  | DiscardEditCommand
  | LoadAgentFilesCommand
  | LoadAgentGraphCommand
  | PauseRunCommand
  | ResumeRunCommand
  | CancelRunCommand
  | BranchRunCommand
  | ExplainCommand
  | EvalCommand
  | McpCommand
  | ListMcpServersCommand
  | ProviderCommand
  | ListProvidersCommand
  | ConnectionCommand
  | LoadUsageCommand
  | DeployChannelCommand
  | ListDeploymentsCommand
  | GithubCommand
  | MemberCommand;

/** Eval-channel commands, grouped so the forwarding switch stays readable. */
export type EvalCommand =
  | CreateDatasetCommand
  | RenameDatasetCommand
  | DeleteDatasetCommand
  | ListDatasetsCommand
  | LoadDatasetCommand
  | AddExampleCommand
  | UpdateExampleCommand
  | DeleteExampleCommand
  | PromoteTestInputCommand
  | StartEvalCommand
  | CancelEvalCommand
  | LoadRubricCommand
  | SaveRubricCommand
  | LoadEvalResultsCommand
  | ListEvalsCommand
  | EstimateEvalCommand;

const EVAL_COMMANDS = new Set([
  "createDataset", "renameDataset", "deleteDataset", "listDatasets",
  "loadDataset", "addExample", "updateExample", "deleteExample", "promoteTestInput",
  "startEval", "cancelEval", "loadRubric", "saveRubric",
  "loadEvalResults", "listEvals", "estimateEval",
]);

/** Commands the relay forwards to the app rather than answering locally. */
export type ForwardedCommand =
  | RunCommand
  | GenerateCommand
  | PlanAgentCommand
  | DiscardPlanCommand
  | EditCommand
  | ApplyEditCommand
  | UndoEditCommand
  | DiscardEditCommand
  | PauseRunCommand
  | ResumeRunCommand
  | CancelRunCommand
  | BranchRunCommand
  | ExplainCommand
  | EvalCommand
  | McpCommand
  | ProviderCommand
  | ConnectionCommand
  | DeployChannelCommand
  | GithubCommand
  | MemberCommand
  | LoadUsageCommand;

// Generation rides its own channel, deliberately parallel to "trace". It never enters the
// trace store or the event schema — schema/events.md v1 stays frozen.
export type GenEvent =
  | { type: "file_start"; path: string }
  | { type: "file_delta"; path: string; text: string }
  | { type: "file_end"; path: string }
  | { type: "started"; prompt: string }
  | { type: "done"; agentId: string; name: string; files: string[]; usage: unknown; planUsage: unknown }
  | { type: "error"; message: string; problems?: string[] }
  // The pre-generation plan gate. These ride "gen" rather than a channel of their own because
  // a plan is an earlier phase of the same generation, not a separate feature.
  //
  // plan_error is deliberately NOT the "error" member above: that one is wired to
  // buildStore.fail() on the client, which paints the build pane as a FAILED GENERATION. A
  // plan refusal happens when no generation is running, so reusing it would report a failure
  // that never occurred.
  | { type: "plan_started"; prompt: string; input: string; revision: number }
  | { type: "plan_delta"; text: string }
  | {
      type: "plan";
      planId: string;
      prompt: string;
      connectors: string[];
      name?: string;
      plan: unknown;
      warnings: string[];
      usage: unknown;
      revision: number;
    }
  | { type: "plan_discarded"; planId: string }
  | { type: "plan_error"; message: string };

// Editing rides its own channel too, parallel to "gen" — it never enters the trace store
// or the frozen event schema either. Payload shapes are owned by editor.ts.
export type EditEvent =
  | { type: "started"; agentId: string; instruction: string }
  | { type: "file_start"; path: string }
  | { type: "file_delta"; path: string; text: string }
  | { type: "file_end"; path: string }
  | { type: "proposal"; proposalId: string; agentId: string; instruction: string; summary: string; files: unknown[]; usage: unknown }
  | { type: "applied"; proposalId: string; agentId: string; version: number; summary: string }
  | { type: "undone"; agentId: string; version: number; summary: string }
  | { type: "discarded"; proposalId: string; agentId: string }
  | { type: "error"; message: string; problems?: string[]; agentId?: string; proposalId?: string };

// Debug depth rides its own channel too, parallel to "trace"/"gen"/"edit". It carries only
// control-plane facts (a run paused / resumed / a boundary reached / a control error); the run's
// own steps still flow as normal schema-v1 trace events on the "trace" channel.
// The "explain" reply rides its own channel too, parallel to trace/gen/edit/debug — a streaming
// prose answer that never touches the trace store or the frozen event schema.
export type ReplyEvent =
  | { type: "started"; agentId: string; question: string }
  | { type: "delta"; agentId: string; text: string }
  | { type: "done"; agentId: string }
  | { type: "error"; agentId: string; message: string };

// Eval rides its own channel too, parallel to trace/gen/edit/debug/reply.
//
// This channel deliberately carries NO step traffic. An eval's individual runs still
// persist as ordinary Run/Step rows and are still read back through the existing
// `loadRun` path — but their live events must not go out on "trace", because
// traceStore.applyEvent focuses activeRunId on every run_start, and twenty parallel eval
// runs would thrash the timeline out from under whatever the user was reading.
export type EvalEvent =
  | { type: "datasets"; agentId: string | null; datasets: unknown[] }
  | { type: "dataset"; datasetId: string; examples: unknown[] }
  | { type: "datasetDeleted"; datasetId: string }
  // Answer to a one-click promotion, so the composer can confirm where the input landed.
  // `duplicate` means the dataset already had that exact input and nothing was added.
  | { type: "promoted"; datasetId: string; datasetName: string; duplicate: boolean }
  // Eval lifecycle. Progress is counts only — the individual runs' steps stay off this
  // channel (and off "trace") so a fan-out never disturbs the timeline.
  | {
      type: "evalStarted";
      evalId: string;
      datasetId: string;
      agentId: string;
      total: number;
      targets: { provider: string; model: string }[];
    }
  | { type: "evalProgress"; evalId: string; total: number; done: number; running: number; queued: number; failed: number }
  | { type: "evalFinished"; evalId: string; status: string; error?: string }
  | { type: "rubric"; datasetId: string; rubric: unknown; isDefault: boolean }
  // Scoring runs after the runs finish, so quality lands after the rest of the row. A null
  // score is UNSCORED (with a reason), never a zero.
  | { type: "scored"; evalId: string; jobId: string; score: number | null; error?: string | null }
  | { type: "scoringFinished"; evalId: string; scored: number; unscored: number }
  | { type: "evalResults"; evalId: string; results: unknown }
  | { type: "evals"; evals: unknown[] }
  | { type: "estimate"; estimate: unknown }
  | { type: "error"; message: string; datasetId?: string };

// MCP rides its own channel too, parallel to trace/gen/edit/debug/reply/eval.
//
// Like the eval channel it deliberately carries no step traffic: an agent's MCP tool call
// is an ORDINARY tool_call Step and arrives on "trace" with everything else. What travels
// here is registry state — which servers are connected, what they advertise, and how each
// tool was classified.
//
// Every mutation answers with a full `servers` snapshot rather than a delta, the same
// discipline as the eval channel: the client replaces rather than merges, so it can never
// hold a half-applied view of what a third-party server said.
//
// Nothing on this channel ever carries a credential. `configured` says a key is set.
export type McpEvent =
  | { type: "servers"; servers: unknown[] }
  // A handshake is a network round trip against someone else's server; the UI needs to be
  // able to say it is waiting rather than appear to have ignored the click.
  | { type: "discovering"; serverId: string | null; endpoint: string }
  | { type: "error"; message: string; serverId?: string }
  // A discovery that succeeded but is worth a word anyway (e.g. a truncated tool list).
  | { type: "notice"; message: string; serverId?: string }
  // A run has HALTED before a high-impact MCP tool's first call and is waiting for an
  // answer. This is the one message on any channel that describes a blocked process, which
  // is why the client renders it as a modal rather than a notification.
  | {
      type: "confirmRequest";
      runId: string;
      nonce: string;
      server: string;
      tool: string;
      /** Why the tool was classified high-impact, so the ask can be argued with. */
      impactReason: string;
      /** The arguments the model produced, as JSON text. Capped by the bridge. */
      args: string;
      /** Seconds the runner will wait before denying. */
      timeoutS: number;
      requestedAt: string;
    }
  // The request is over: answered, or the run died, or the runner gave up waiting.
  | { type: "confirmResolved"; runId: string; nonce: string; verdict: string };

// Model-provider credentials ride their own channel, parallel to trace/gen/edit/debug/reply/
// eval/mcp — still one socket, and still no second transport.
//
// It is not folded into "mcp" because that channel means "the MCP registry": every message on
// it is a full snapshot of the connected third-party servers, and the client REPLACES its
// whole server list on each one. A provider key is not an MCP server, and smuggling it
// through would make a message about Anthropic look like a claim about somebody's MCP
// endpoints.
//
// Same discipline as the eval and MCP channels: every mutation answers with a full snapshot,
// so a client replaces rather than merges. And like them, nothing here ever carries a
// credential — `configured` says a NAMED VARIABLE IS SET, and that is the whole of it.
/**
 * What a client learns about this workspace's model credentials. Names and one preference.
 *
 * `ownKeyForPlatform` is a preference, not a credential: whether THIS WORKSPACE'S key pays for the
 * platform's own calls on its behalf — generation, the plan gate, the fix loop, explain, the judge.
 * It rides the providers snapshot because it is meaningless without the list of what is connected,
 * and because a client that had to ask twice could render a checkbox out of step with the keys
 * beside it.
 *
 * REQUIRED, not optional. It was optional, and so two of the three places that build this message
 * left it out — the on-connect snapshot and the answer to `listProviders`, which between them are
 * every message a client receives before it changes anything.
 */
export interface ProviderSnapshot {
  providers: unknown[];
  ownKeyForPlatform: boolean;
}

export type ProviderEvent =
  | ({ type: "providers" } & ProviderSnapshot)
  // The answer to "Test connection": did that key authenticate. Nothing was written.
  | { type: "testResult"; provider: string; ok: boolean; message: string | null }
  // A write that could not happen (an unknown provider, a value the .env format cannot store
  // faithfully — see envWriter.renderLine).
  | { type: "error"; message: string; provider?: string }
  // A write that happened but comes with a caveat worth a sentence — most often that the same
  // variable is exported in the server's shell and will win again after a restart.
  | { type: "notice"; message: string; provider?: string };

// Connector connections: what this workspace has authorised Jaroku to reach on its behalf.
//
// Its own channel rather than a field on `providers`, and the distinction is not cosmetic. A
// provider key is a credential the workspace HOLDS and pasted in; a connection is a grant somebody
// else's system made to us, which can be revoked from the other end at any moment, needs a consent
// screen to create, and has a state (`reauth_required`) that no API key has. A snapshot carrying
// both would have to explain why half its entries have a "Reconnect" button.
//
// Same discipline as every channel beside it: a full snapshot on every mutation, so a client
// replaces rather than merges. And as everywhere else, NOTHING HERE CARRIES A CREDENTIAL — a
// connection reports a status, the scopes that were granted, and a label naming the account, which
// is the whole of what a browser is ever told.

/** One connection, as a browser sees it. Not one field of this is a token. */
export interface ConnectionView {
  connectorId: string;
  label: string;
  provider: string;
  /** `active` | `reauth_required` | `revoked` | `disconnected` — the last meaning never connected. */
  status: string;
  /** What the user actually granted, in the provider's own vocabulary. */
  scopes: string[];
  /** What they are agreeing to, in sentences, from the connector spec. Shown before connecting. */
  consent: string[];
  /** Which mailbox, which Slack. Null when the provider told us nothing a person would recognise. */
  account: string | null;
  connectedAt: string | null;
  /** Why it needs attention, when it does. The provider's own words, bounded and stripped. */
  lastError: string | null;
  /**
   * Whether this DEPLOYMENT can run the flow at all.
   *
   * False locally, where there is no OAuth app — and that is not an error state. The panel renders
   * the connector with the two environment variables somebody has to set, rather than hiding it,
   * because an empty page looks like a missing feature rather than an unconfigured one.
   */
  available: boolean;
}

export type ConnectionEvent =
  | { type: "connections"; connections: ConnectionView[] }
  /**
   * Where the browser must go to give consent.
   *
   * A URL rather than a redirect, because the request that asked came down a WebSocket and a
   * socket cannot redirect anything. The client navigates. The URL is single-use in the sense
   * that matters — the state behind it is — and carries the PKCE challenge, never the verifier.
   */
  | { type: "authorize"; connectorId: string; url: string; expiresAt: number }
  | { type: "error"; message: string; connectorId?: string }
  | { type: "notice"; message: string; connectorId?: string };

// Deploy rides its own channel, for the same reason providers does: a deployment is not an
// MCP server and not a provider, and the other channels are full snapshots of something else.
// schema/events.md v1 is untouched — a deploy emits no trace events at all.
//
// Every mutation answers with a full snapshot, so a client replaces rather than merges. And
// as everywhere else: `deployments[].env_keys` are NAMES, `railwayConfigured` says a named
// variable is set, and nothing on this channel carries a credential — with one deliberate,
// one-shot exception, `serveToken` below.
export type DeployEvent =
  // The whole picture: every deployment, plus whether a Railway token is configured.
  | { type: "deployments"; deployments: unknown[]; railwayConfigured: boolean; cliVersion?: string | null }
  // What a deploy would need, answered before anything is created or spent.
  | { type: "plan"; agentId: string; secrets: unknown[]; problems: string[]; warnings: string[]; redeploy: boolean }
  | { type: "started"; deploymentId: string; agentId: string }
  // One per phase transition. The UI reads `stage` for the narrative and `status` for the row.
  | { type: "stage"; deploymentId: string; stage: string; status: string }
  // One line of build output, already scrubbed of every secret this deploy handled.
  | { type: "log"; deploymentId: string; seq: number; stage: string; stream: string; text: string }
  // A backfill of stored lines, for a client that connected mid-deploy or reloaded.
  | { type: "logs"; deploymentId: string; lines: unknown[] }
  | { type: "finished"; deploymentId: string; status: string; url: string | null; error: string | null }
  /**
   * The bearer token for a newly live endpoint, sent exactly once.
   *
   * The one credential that travels server -> browser anywhere in this file, and it is
   * deliberate: Jaroku generated it, set it on Railway, and keeps no copy, so this message is
   * the only chance the user has to see it. It is not persisted, not in the deployment row,
   * and not in the log table — which is exactly why it has to be its own event rather than a
   * `log` line.
   */
  | { type: "serveToken"; deploymentId: string; url: string; token: string }
  | { type: "testResult"; ok: boolean; message: string | null }
  | { type: "error"; message: string; deploymentId?: string }
  | { type: "notice"; message: string; deploymentId?: string };

// GitHub rides its own channel, for the same reason deploy does: a repository link is not a
// deployment and not a connector, and the other channels are full snapshots of something else.
//
// ONE `state` EVENT CARRIES THE WHOLE PANEL, and that is a deliberate departure from the
// finer-grained shapes elsewhere. Every region in §1 answers a question about the same underlying
// pair of lineages, and a client that received "here is the link" and "here are the versions"
// separately would render, for a frame, a verdict computed from a link that had already moved.
// The panel's whole promise is that it is legible at every moment; a half-applied snapshot breaks
// exactly that.
//
// Nothing here carries a credential. `connected` is a boolean, `accountLogin` is a name GitHub
// prints on a profile page, and the token behind both is a name in the vault.
export type GithubEvent =
  /** The whole picture for one agent, plus the workspace-wide facts the sidebar needs. */
  | {
      type: "state";
      agentId: string | null;
      connected: boolean;
      accountLogin: string | null;
      /** Every live link in the workspace, for the sidebar's Synced filter. */
      links: unknown[];
      /** The active agent's link, verdict, versions and remote commits. Null when unlinked. */
      view: unknown | null;
    }
  /** §2.2's existing-repo search. Names and default branches, filtered to what the token can write. */
  | { type: "repos"; repos: unknown[] }
  /** §2.2's live availability check, one answer per keystroke. */
  | { type: "nameCheck"; name: string; available: boolean }
  /**
   * One phase transition of a push or a pull.
   *
   * `op` rather than two event types, so §2.4's rail and §3.6's rail are one component. They are
   * the same shape — named stages in three tenses — and the only difference is the list.
   */
  | { type: "stage"; agentId: string; op: "push" | "pull"; stage: string; status: "active" | "done" | "error" }
  /**
   * A pull the validator turned away.
   *
   * ITS OWN EVENT RATHER THAN AN `error`, because §3.6 is explicit that this is a refusal and not a
   * warning: it names the file and the missing symbol, it says the agent is unchanged, and it
   * offers three specific actions. An error strip carrying a sentence could do none of that.
   */
  | {
      type: "refused";
      agentId: string;
      /** `parse`, `import`, `contract`, `protected`, `size` — which bar it failed. */
      check: string;
      path: string | null;
      message: string;
      /** The candidate version that was staged and discarded, for the "View diff" link. */
      candidate: number | null;
    }
  /**
   * A commit message the model wrote — §3.4's ✨ generate.
   *
   * Its own event rather than a field on `state`, because it is an answer to a click and not a
   * fact about the world: folding it into the snapshot would mean every later refresh re-filling a
   * box the user has since edited.
   */
  | { type: "message"; agentId: string; message: string }
  /**
   * A restacked order the validator turned away — §B.4.4.
   *
   * ITS OWN EVENT FOR THE SAME REASON `refused` IS, and with the same argument one feature over: the
   * panel highlights the ROW at the failing position and renders the validator's own words beneath
   * it, and an error strip carrying one sentence could do neither. The position is a number rather
   * than a phrase inside the message, because parsing it back out of prose is how a UI ends up
   * highlighting a different row than the one that failed.
   */
  /**
   * §B.6.1's refusal card: a push the scanner turned away.
   *
   * ITS OWN EVENT, for the third time in this channel and the third time for the same reason — the
   * card names a file, a rule and two actions, and an error strip could carry none of that. It is
   * also not an error: nothing failed, and the branch is exactly where it was.
   *
   * NO FINDING CARRIES A MATCHED VALUE. `secretScan.Finding` has no field one would fit in, which
   * is what lets this go over a socket to a browser at all.
   */
  | {
      type: "scanRefused";
      agentId: string;
      message: string;
      findings: { path: string; kind: string; rule: string; line: number | null; message: string }[];
    }
  | {
      type: "restackRefused";
      agentId: string;
      /** Zero-based, in the NEW order. What the user just moved, not where it used to be. */
      position: number;
      message: string;
      problems: string[];
    }
  /**
   * §B.3's PROBLEMS list, for one buffer.
   *
   * ADDRESSED BY (agent, path, nonce) AND CARRYING THE WHOLE LIST, never a delta. A diagnostic set
   * is small — a handful of lines — and the alternative is a client reconciling additions against
   * removals for a buffer that is changing under both of them. The same coarse-snapshot argument
   * `githubService` makes for the panel, at a scale where it is not even a trade.
   *
   * AN EMPTY `diagnostics` IS A REAL ANSWER and is the common one: it means the buffer is clean
   * right now, and the client clears its squiggles on it. That is why the array is not optional.
   */
  | {
      type: "diagnostics";
      agentId: string;
      path: string;
      nonce: number;
      diagnostics: {
        line: number;
        column?: number;
        endColumn?: number;
        rule: number | null;
        message: string;
        severity: "warning";
      }[];
    }
  /**
   * §B.2.2's transient list: this agent's shadow runs, newest first.
   *
   * ITS OWN MESSAGE RATHER THAN A FIELD ON `state`, and the separation is the requirement rather
   * than a preference: §B.2.2 says shadow runs never appear in the agent's ordinary run history,
   * and the way that stays true is that nothing which assembles the ordinary history ever sees
   * them. A field on the panel snapshot would be one refactor away from being merged in.
   */
  | {
      type: "shadowRuns";
      agentId: string;
      runs: {
        id: string;
        ref: string;
        headSha: string;
        runId: string | null;
        status: string;
        error: string | null;
        createdAt: string;
        endedAt: string | null;
        /** False once the staging directory is gone. The TRACE outlives it — see hasReadableTrace. */
        staged: boolean;
      }[];
    }
  | { type: "error"; message: string; agentId?: string }
  | { type: "notice"; message: string; agentId?: string };

// The session channel: the only one that is about the CONNECTION rather than about the work.
//
// It exists because a WebSocket is the one thing in this system with no natural expiry. An
// HTTP request presents a token and is checked; a socket is checked once, at the upgrade, and
// then lives for as long as a browser tab is open. Eight hours later it is still acting on a
// membership that may have been revoked in the first ten minutes, and nothing about the socket
// itself would ever notice.
//
// So a socket is re-checked on a timer, and what it is told is one of these. Every one of them
// means "this connection is over, open a new one" — a client that wants to keep working gets a
// fresh token and a fresh ticket, which puts it back through the whole membership check.
export type SessionEvent =
  // The token behind this socket is close to expiring. The client should refresh and
  // reconnect at its convenience, rather than being cut off mid-generation.
  | { type: "expiring"; expiresAt: number }
  | { type: "expired" }
  // No longer a member. The socket closes immediately: it is not a warning.
  | { type: "revoked"; message: string }
  // The workspace itself is gone. Distinct from `revoked` because the client's move is
  // different — reconnect into another workspace it belongs to, rather than sign in again.
  | { type: "workspace_changed"; message: string }
  // Still a member, at a different role. The socket stays open and re-authorises against the
  // new one; a demotion does not need to interrupt somebody mid-sentence, it needs to stop
  // them doing the thing they no longer may.
  | { type: "role_changed"; role: string };

/**
 * Why a socket was closed, in the 4000–4999 application range.
 *
 * The event above says it in words, but a client can miss the last frame before a close — so
 * the code carries the same decision in the one place that is guaranteed to arrive. The
 * distinction the client needs is exactly one bit: reconnect, or stop and show sign-in.
 */
export const CLOSE_UNAUTHORISED = 4001;
export const CLOSE_RECONNECT = 4002;

export type DebugEvent =
  | { type: "paused"; runId: string; seq: number }
  | { type: "resumed"; runId: string; seqOffset: number }
  | { type: "boundary"; runId: string; seq: number; next: string[] }
  | { type: "branched"; parentRunId: string; branchId: string; fromSeq: number }
  | { type: "cancelled"; runId: string }
  | { type: "error"; runId?: string; message: string };

/**
 * What a socket is, once it has been let in.
 *
 * The context is the scope every read and every forwarded command is answered in. `expiresAt`
 * is the token's expiry, carried so the revalidation timer can end a socket whose credential
 * has run out rather than letting it live until somebody closes the tab.
 */
export interface SocketSession {
  context: TenantContext;
  /** Unix seconds, or null when the socket was opened without a token (the dev path). */
  expiresAt?: number | null;
  userId?: string | null;
}

/**
 * Decide whether an upgrade is allowed, and in which workspace.
 *
 * THROWING REFUSES THE CONNECTION. That is the contract, and it is why this returns a session
 * rather than taking a callback: a socket that opens and is then closed has already been
 * counted, has already had a snapshot queued for it, and looks to a client exactly like a
 * server that dropped the connection. A refusal has to happen before the handshake completes,
 * and it has to be an HTTP status the client can read.
 */
export type SocketAuthorizer = (
  req: IncomingMessage,
) => TenantContext | SocketSession | Promise<TenantContext | SocketSession>;

/**
 * Which channel a command's answer — including a refusal — belongs on.
 *
 * A client listens per channel. A "you may not do that" broadcast on the wrong one is
 * indistinguishable from nothing arriving, so the panel that made the request sits waiting
 * while an unrelated one shows an error about something it never asked for.
 *
 * The default is `log`, deliberately visible rather than silent: every channel below is a
 * feature's own, and a command with no feature is still worth a line the user can see.
 */
export const COMMAND_CHANNEL: Record<string, string> = {
  // These five answer on channels whose payload IS the data — `trace`, `agents`, `agentFiles`,
  // `graph`, `runSteps` — and none of those has an error shape a client would recognise.
  // Inventing one would mean teaching five stores to distinguish a refusal from a snapshot, so
  // their refusals go to `log`, which the status bar already renders. Listed explicitly rather
  // than left to the fallback: "log because that is right" and "log because nobody decided"
  // must not look the same.
  run: "log", loadRun: "log", listAgents: "log", loadAgentFiles: "log", loadAgentGraph: "log",

  planAgent: "gen", discardPlan: "gen", generate: "gen",
  edit: "edit", applyEdit: "edit", undoEdit: "edit", discardEdit: "edit",
  pauseRun: "debug", resumeRun: "debug", cancelRun: "debug", branchRun: "debug",
  explain: "reply",
  createDataset: "eval", renameDataset: "eval", deleteDataset: "eval", listDatasets: "eval",
  loadDataset: "eval", addExample: "eval", updateExample: "eval", deleteExample: "eval",
  promoteTestInput: "eval", startEval: "eval", cancelEval: "eval", loadRubric: "eval",
  saveRubric: "eval", loadEvalResults: "eval", listEvals: "eval", estimateEval: "eval",
  listMcpServers: "mcp", addMcpServer: "mcp", removeMcpServer: "mcp", rediscoverMcpServer: "mcp",
  setMcpServerAuth: "mcp", setMcpToolImpact: "mcp", resolveMcpConfirm: "mcp",
  listProviders: "providers", setOwnKeyForPlatform: "providers",
  listConnections: "connections", connectConnector: "connections", disconnectConnector: "connections",
  loadUsage: "billing",
  listMembers: "members", inviteMember: "members", revokeInvite: "members",
  setMemberRole: "members", removeMember: "members",
  listDeployments: "deploy", planDeploy: "deploy", deploy: "deploy", cancelDeploy: "deploy",
  forgetDeployment: "deploy", loadDeployLogs: "deploy", setRailwayToken: "deploy",
  testRailwayToken: "deploy",

  // Every GitHub command answers on `github`, including the reads. The channel HAS an error shape
  // — `{ type: "error", agentId }` — so unlike `loadAgentFiles` there is nowhere better for a
  // refusal to go, and a rate-limit refusal about a push that landed in the status bar instead of
  // the panel would leave the panel waiting on an answer that already came.
  listGithub: "github", listGithubRepos: "github", checkGithubRepo: "github",
  linkGithub: "github", unlinkGithub: "github", refreshGithub: "github",
  pushGithub: "github", pullGithub: "github", switchGithubBranch: "github",
  createGithubBranch: "github", openGithubPr: "github", commitGithub: "github",
  generateGithubMessage: "github",
};

export function channelFor(cmd: string): string {
  return Object.prototype.hasOwnProperty.call(COMMAND_CHANNEL, cmd) ? COMMAND_CHANNEL[cmd]! : "log";
}

/** What a re-check of an open socket concluded. */
export type SessionVerdict =
  | { ok: true; role: TenantContext["role"] }
  | { ok: false; reason: "revoked" | "workspace_gone" };

/** How close to expiry a token gets before the client is told to refresh. */
export const EXPIRY_WARNING_S = 300;

/**
 * The largest message a client may send over the socket.
 *
 * `ws` defaults to 100 MiB, which is not a limit so much as a number. The HTTP router next to
 * this caps a request body at 64 KiB, and every command that arrives here is the same kind of
 * thing a request body carries — so without this, the socket was the way around the cap: one
 * authenticated client, one frame, a hundred megabytes buffered in the server's heap and then
 * handed to `JSON.parse`, per socket, on a control plane shared by every tenant.
 *
 * A megabyte rather than the router's 64 KiB because the fattest command here is a real one: an
 * eval example or a rubric is prose a user pasted, and refusing a long one would be a product
 * decision made by a denial-of-service guard. Sixteen times the router's cap and a hundredth of
 * the library's default is the room that costs nothing.
 *
 * Enforced by the library, before a byte is buffered — a frame declaring more is refused at the
 * protocol level and the socket is closed with 1009. That is the part a check inside the message
 * handler could not do, because by then the message is already in memory.
 */
export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

/** A refusal with an HTTP status, for the upgrade path. */
export class UpgradeRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpgradeRefused";
  }
}

const asSession = (v: TenantContext | SocketSession): SocketSession =>
  "context" in v ? v : { context: v, expiresAt: null, userId: v.actorUserId };

/**
 * Where the upgrade handler leaves its answer for the connection handler.
 *
 * A symbol rather than a string property, so nothing that iterates a request's own keys —
 * a logger, a serialiser — can pick up a resolved session and put it somewhere.
 */
const SESSION = Symbol("jaroku.socketSession");
type AuthorizedRequest = IncomingMessage & { [SESSION]?: SocketSession };

/**
 * Refuse an upgrade with a status the client can read, then close.
 *
 * Written by hand because at this point there is no `ServerResponse` — the socket has been
 * detached from the HTTP server for the handshake. The body is plain text: a client that got
 * this far is reading a status line, and nothing here is machine-parsed.
 */
function refuseUpgrade(socket: Socket, status: number, message: string): void {
  const reason = status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : "Bad Request";
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      `content-type: text/plain; charset=utf-8\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
  socket.destroy();
}

export interface RelayOptions {
  port: number;
  store: TraceStore;
  /**
   * The workspace a SOCKET acts in, resolved when it connects.
   *
   * The relay answers reads locally rather than forwarding them, which is correct for a
   * single-user localhost app and a data breach in a hosted one — every `loadRun`,
   * `listAgents` and `listMcpServers` was a query with no scope and an answer sent to
   * whoever asked. Now the scope is resolved once per connection and every read and every
   * forwarded command carries it.
   *
   * Per socket rather than per process, which is the shape Session 2 needs: there it is
   * resolved from the single-use ticket the client presented, and nothing else here changes.
   * A workspace switch is a NEW socket, deliberately, because a switch that mutated a live
   * one would have to reason about the reads already in flight on it.
   */
  contextFor: SocketAuthorizer;
  /**
   * Which `Origin` values may open a socket. Absent means every one, which is only correct
   * for a test — see auth/origin.ts for why this is not optional in front of a browser.
   */
  originPolicy?: { allows(origin: string | undefined): boolean };
  clientHtmlPath: string;
  /**
   * The HTTP surface, in front of the static fallback client.
   *
   * A browser cannot put an `Authorization` header on a WebSocket, so the credential exchange
   * has to happen over HTTP before the socket exists — which is why this server grew a real
   * HTTP side at all. The router answers what it claims and reports what it does not, so
   * `GET /` stays the debug client without the router needing to know that.
   */
  router?: Router;
  // "loadRun", "listAgents", "loadAgentFiles", "loadAgentGraph", "listMcpServers" and
  // "listProviders" are answered locally; the rest are forwarded.
  onCommand?: (cmd: ForwardedCommand, ctx: TenantContext) => void;
  // Every read takes the asking socket's context, the filesystem-backed ones included: the
  // directory they read is global, so the caller's right to a given agent is a question only
  // the database can answer. Session 3's object store makes the key itself workspace-scoped
  // and the check becomes structural rather than a lookup.
  listAgents?: (ctx: TenantContext) => unknown[] | Promise<unknown[]>;
  listAgentFiles?: (ctx: TenantContext, agentId: string) => unknown[] | Promise<unknown[]>;
  getAgentGraph?: (ctx: TenantContext, agentId: string) => Promise<unknown>;
  listMcpServers?: (ctx: TenantContext) => unknown[] | Promise<unknown[]>;
  /**
   * Which provider keys are set, by name, and whether this workspace's own pays for our calls.
   *
   * Takes the asking socket's context, like every other read here. It used to take nothing,
   * because a provider key lived in one `runtime/.env` and genuinely was process-wide. Hosted
   * it is per workspace, and a snapshot answered without a scope would tell every connected
   * client that a provider is connected because the SERVER has one.
   *
   * ONE FUNCTION RETURNING THE WHOLE SNAPSHOT, rather than a list plus a second option beside it.
   * `ProviderEvent` has always carried `ownKeyForPlatform` and this file's two emitters have
   * always omitted it: the flag arrived only on the broadcast that follows a mutation, so a client
   * learned the truth on frame one of nothing and was left rendering a default. Two options would
   * be two things a caller can fill in separately, which is how that happened. One cannot drift.
   */
  listProviders?: (ctx: TenantContext) => ProviderSnapshot | Promise<ProviderSnapshot>;
  /**
   * Re-check an open socket's session. Called on a timer; absent means never.
   *
   * The relay deliberately knows nothing about memberships or tokens — it asks, and acts on
   * the answer. That keeps the identity layer in one place and means this file has no reason
   * to import a repository.
   */
  revalidate?: (session: SocketSession) => Promise<SessionVerdict>;
  /** How often to ask. Default 60s; a socket lives hours, so this is not a hot path. */
  revalidateMs?: number;
  /** Every deployment, plus whether a Railway token is configured. Names only. */
  listDeployments?: (ctx: TenantContext) =>
    | { deployments: unknown[]; railwayConfigured: boolean }
    | Promise<{ deployments: unknown[]; railwayConfigured: boolean }>;
  /** Session 5: fired after every broadcastTo, so a caller can fan it out to other gateway
   *  replicas over Redis — see queue/eventBridge.ts. Absent means single-replica, no bridge,
   *  exactly today's behaviour. */
  onBroadcast?: (ctx: TenantContext, payload: unknown) => void;
}

export class WsRelay {
  private wss: WebSocketServer;
  private http: ReturnType<typeof createServer>;
  private clients = new Set<WebSocket>();
  /**
   * Each socket's workspace.
   *
   * Broadcasts are the reason this is a map rather than one value. A broadcast goes to every
   * connected client, and every one of them is in some workspace — so a snapshot built once
   * and sent to all of them is a cross-tenant read wearing a different hat. See
   * `broadcastHistory` and `broadcastAgents`, which now build per recipient.
   */
  private contexts = new Map<WebSocket, TenantContext>();
  /** The fuller picture per socket: who, and when their credential runs out. */
  private sessions = new Map<WebSocket, SocketSession>();
  /** Sockets already told their token is nearly out, so they are told once and not per tick. */
  private warned = new WeakSet<WebSocket>();
  private revalidator?: ReturnType<typeof setInterval>;
  private store: TraceStore;
  private onCommand?: (cmd: ForwardedCommand, ctx: TenantContext) => void;

  constructor(private opts: RelayOptions) {
    this.store = opts.store;
    this.onCommand = opts.onCommand;

    // SLOWLORIS, WHICH IS NOT THE SAME PROBLEM AS A SLOW HANDLER. The router puts a deadline on
    // OUR work; these bound how long somebody else is allowed to take dribbling a request in.
    // Node's defaults — 60s of headers, 300s of body — mean a few hundred sockets each sending a
    // byte a minute cost an attacker nothing and cost this process its connection table. The
    // keep-alive number is deliberately longer than a browser needs between the session call and
    // the ws-ticket that follows it, and deliberately shorter than a load balancer's own idle
    // timeout: a connection the balancer thinks is alive and this process has already closed is
    // the classic source of sporadic 502s, so we are the side that hangs up.
    //
    // `connectionsCheckingInterval` is here rather than left at its default because the other
    // three are swept rather than timed — see http/security.ts. At the default thirty seconds a
    // twenty-second request timeout is enforced somewhere in the next fifty, which is most of
    // the protection given away for nothing.
    this.http = createServer(
      {
        headersTimeout: HEADERS_READ_TIMEOUT_MS,
        requestTimeout: REQUEST_READ_TIMEOUT_MS,
        keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
        connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS,
      },
      (req, res) => {
        void this.serveHttp(req, res);
      },
    );
    // `noServer`, not `server`. With `server` the library completes the handshake and the only
    // way to refuse is to close an already-open socket — which the client cannot distinguish
    // from a network drop, and which its reconnect loop then retries forever. Doing the
    // upgrade by hand means a refusal is an HTTP status the client can read and act on.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
    this.http.on("upgrade", (req, socket, head) => {
      void this.upgrade(req, socket as Socket, head);
    });

    this.wss.on("connection", (ws, req) => {
      this.clients.add(ws);
      // Resolved once, here, and held for the life of the socket. Every read this connection
      // asks for and every command it forwards is answered in this workspace and no other.
      //
      // By the time this fires the authoriser has already run and succeeded in `upgrade` —
      // this reads its answer out of the request rather than asking again, so a ticket is
      // consumed exactly once per connection.
      const authorized = (req as AuthorizedRequest)[SESSION];
      const pending: Promise<TenantContext> = authorized
        ? Promise.resolve(authorized.context)
        : Promise.resolve(asSession(this.opts.contextFor(req) as TenantContext)).then((s) => s.context);
      if (authorized) this.sessions.set(ws, authorized);
      pending.then((ctx) => this.contexts.set(ws, ctx)).catch(() => {});
      const withContext = async (fn: (ctx: TenantContext) => Promise<void> | void): Promise<void> => {
        await fn(await pending);
      };
      // Snapshot: recent runs + the agent list so a reconnecting client isn't blank.
      //
      // Sent from one async block rather than five, so they still arrive in this order. A
      // client that received `agents` before `history` would render a sidebar whose runs
      // belong to agents it has not been told about yet.
      void (async () => {
        const ctx = await pending;
        this.sendTo(ws, { channel: "history", runs: await this.store.listRuns(ctx) });
        this.sendTo(ws, { channel: "agents", agents: (await this.opts.listAgents?.(ctx)) ?? [] });
        this.sendTo(ws, { channel: "mcp", type: "servers", servers: (await this.opts.listMcpServers?.(ctx)) ?? [] });
        // Which providers are connected, so a first-run client knows on frame one whether it
        // is looking at a configured install or an empty one.
        this.sendTo(ws, {
          channel: "providers",
          type: "providers",
          ...((await this.opts.listProviders?.(ctx)) ?? { providers: [], ownKeyForPlatform: false }),
        });
        // And what is deployed, so the sidebar's Deployed filter is right on frame one rather
        // than after a round trip.
        const deploySnapshot = (await this.opts.listDeployments?.(ctx)) ?? {
          deployments: [],
          railwayConfigured: false,
        };
        this.sendTo(ws, { channel: "deploy", type: "deployments", ...deploySnapshot });
      })().catch((err) => console.error("[relay] initial snapshot failed:", (err as Error).message));

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientCommand;
          if (!msg || typeof msg.cmd !== "string") return;
          // AUTHORISATION, BEFORE ANYTHING ELSE LOOKS AT THE MESSAGE.
          //
          // The socket already proved which workspace it acts in — that was the ticket. This is
          // the second question: whether the ROLE it holds there may do this particular thing.
          // It happens here, once, rather than in fifty handlers, and a command with no
          // capability is refused rather than allowed, so a command added without an entry in
          // the matrix fails loudly instead of arriving ungated.
          void this.authorized(ws, msg.cmd, pending).then((allowed) => {
            if (allowed) this.dispatch(ws, msg, pending);
          });
        } catch {
          /* ignore malformed client messages */
        }
      });
      const forget = (): void => {
        this.clients.delete(ws);
        this.contexts.delete(ws);
        this.sessions.delete(ws);
      };
      ws.on("close", forget);
      ws.on("error", forget);
    });

    this.http.listen(opts.port, () => {
      console.log(`[relay] http+ws listening on http://localhost:${opts.port}`);
    });

    if (opts.revalidate) {
      this.revalidator = setInterval(() => {
        void this.revalidateAll();
      }, opts.revalidateMs ?? 60_000);
      // The process must still be able to exit. A timer that keeps Node alive turns every
      // test that forgets to close a relay into a hang, and turns SIGTERM into a wait.
      this.revalidator.unref?.();
    }
  }

  /**
   * Re-check every open socket, and end the ones that should no longer be open.
   *
   * WHAT THIS CATCHES that nothing else does: a socket authorised eight hours ago on a
   * membership revoked seven hours ago. Every HTTP request re-checks; a socket is checked once,
   * at the upgrade, and then never again by anything.
   *
   * The membership read goes AROUND the resolver's cache — see `stillAMember`. A cached
   * positive is precisely what a revocation needs to see past, and this runs once a minute per
   * socket, which is not a load worth caching away.
   */
  async revalidateAll(): Promise<void> {
    const revalidate = this.opts.revalidate;
    if (!revalidate) return;
    const nowS = Math.floor(Date.now() / 1000);

    for (const [ws, session] of [...this.sessions]) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        // Expiry first, because it needs no query and because a socket whose credential has
        // run out should not cost a database round trip to close.
        if (typeof session.expiresAt === "number") {
          if (nowS >= session.expiresAt) {
            this.endSession(ws, { type: "expired" }, CLOSE_UNAUTHORISED);
            continue;
          }
          if (session.expiresAt - nowS <= EXPIRY_WARNING_S && !this.warned.has(ws)) {
            // A warning, not a close. Cutting somebody off mid-generation because their token
            // has four minutes left would be the server creating the outage it is warning
            // about. Once per socket, or a client gets one of these every minute.
            this.warned.add(ws);
            this.sendTo(ws, { channel: "session", type: "expiring", expiresAt: session.expiresAt });
          }
        }

        const verdict = await revalidate(session);
        if (!verdict.ok) {
          if (verdict.reason === "workspace_gone") {
            this.endSession(
              ws,
              { type: "workspace_changed", message: "that workspace no longer exists" },
              CLOSE_RECONNECT,
            );
          } else {
            this.endSession(
              ws,
              { type: "revoked", message: "your access to this workspace was removed" },
              CLOSE_UNAUTHORISED,
            );
          }
          continue;
        }
        if (verdict.role !== session.context.role) {
          // A role change does NOT close the socket. The connection is still legitimately
          // theirs; what changed is what it may do, and the capability check at the door reads
          // this context on every command — so updating it here is the whole of the
          // enforcement. Interrupting the connection would be theatre.
          const updated: TenantContext = { ...session.context, role: verdict.role };
          this.sessions.set(ws, { ...session, context: updated });
          this.contexts.set(ws, updated);
          this.sendTo(ws, { channel: "session", type: "role_changed", role: verdict.role });
        }
      } catch (err) {
        // A failed re-check does NOT close the socket. The database being briefly unavailable
        // is our problem, and signing every user out over it would turn a blip into an outage —
        // the same reasoning the JWKS cache applies to a failed refresh. The next tick asks
        // again, sixty seconds from now.
        console.error("[relay] session revalidation failed:", (err as Error).message);
      }
    }
  }

  /** Tell the socket why, then close it with a code that survives a dropped frame. */
  private endSession(ws: WebSocket, event: SessionEvent, code: number): void {
    this.sendTo(ws, { channel: "session", ...event });
    console.log(`[relay] closing a socket: ${event.type}`);
    // A beat, so the frame above is written before the close. `ws.close()` flushes queued
    // frames, but the client still has to process the message — and the close code carries the
    // same decision, so nothing is lost if it does not.
    setTimeout(() => ws.close(code, event.type), 20);
  }

  /**
   * May this socket's role run this command?
   *
   * A refusal is ANSWERED, on the channel the command belongs to, rather than dropped. A
   * client that silently gets nothing back cannot tell "you may not" from "the server is
   * broken", and the UI's only honest response to the second is to keep waiting.
   */
  private async authorized(ws: WebSocket, cmd: string, pending: Promise<TenantContext>): Promise<boolean> {
    let ctx: TenantContext;
    try {
      ctx = await this.contextOf(ws, pending);
    } catch {
      return false;
    }
    const capability = capabilityFor(cmd);
    if (!capability) {
      // Unclassified is refused, not allowed. `test:capabilities` asserts this cannot happen
      // for any command the relay knows, so reaching here means a command was added without a
      // decision about who may run it — and defaulting that to "anyone" is the hole.
      console.warn(`[relay] refused unclassified command "${cmd}"`);
      this.sendTo(ws, {
        channel: channelFor(cmd),
        type: "error",
        message: `"${cmd}" is not a command this server authorises`,
      });
      return false;
    }
    if (can(ctx.role, capability)) return true;
    this.sendTo(ws, {
      channel: channelFor(cmd),
      type: "error",
      message: `a ${ctx.role} cannot do this — it needs ${capability}`,
    });
    return false;
  }

  /**
   * The socket's CURRENT context, not the one it connected with.
   *
   * These differ exactly when revalidation has changed a role mid-connection, and reading the
   * captured one there would make a promotion or demotion a notification rather than an
   * enforcement — the client would be told its role changed while every command it sent was
   * still judged against the old one. The map is authoritative from the moment the upgrade
   * resolves; the promise is only for the handful of milliseconds before that.
   */
  private async contextOf(ws: WebSocket, pending: Promise<TenantContext>): Promise<TenantContext> {
    return this.contexts.get(ws) ?? (await pending);
  }

  /** Route an authorised command: answered locally, or forwarded to the app. */
  private dispatch(ws: WebSocket, msg: ClientCommand, pending: Promise<TenantContext>): void {
    // Every branch below resolves through this, so a forwarded command carries the role the
    // socket holds NOW — the same one `authorized` just judged it against.
    const live = this.contextOf(ws, pending);
    const withContext = async (fn: (ctx: TenantContext) => Promise<void> | void): Promise<void> => {
      await fn(await live);
    };
    try {
      {
          if (msg.cmd === "run") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "generate" && typeof msg.prompt === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "planAgent" && typeof msg.prompt === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "discardPlan" && typeof msg.planId === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "edit" && typeof msg.agentId === "string" && typeof msg.instruction === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "applyEdit" && typeof msg.proposalId === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "undoEdit" && typeof msg.agentId === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "discardEdit" && typeof msg.proposalId === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "loadAgentFiles" && typeof msg.agentId === "string") {
            const agentId = msg.agentId;
            void this.answer(ws, async (ctx) => ({
              channel: "agentFiles",
              agentId,
              files: (await this.opts.listAgentFiles?.(ctx, agentId)) ?? [],
            }), live);
          } else if (msg.cmd === "loadAgentGraph" && typeof msg.agentId === "string") {
            // Async: spawn introspection, then answer only the requesting client.
            const agentId = msg.agentId;
            void live
              .then((ctx) => this.opts.getAgentGraph?.(ctx, agentId))
              .then((graph) => this.sendTo(ws, { channel: "graph", agentId, graph: graph ?? null }))
              .catch((err) =>
                this.sendTo(ws, {
                  channel: "graph",
                  agentId,
                  graph: { agent_id: agentId, error: String((err as Error)?.message ?? err) },
                }),
              );
          } else if (msg.cmd === "pauseRun" && typeof msg.runId === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "resumeRun" && typeof msg.runId === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "cancelRun" && typeof msg.runId === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "branchRun" && typeof msg.fromRunId === "string" && typeof msg.atSeq === "number") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "explain" && typeof msg.agentId === "string" && typeof msg.question === "string") {
            void withContext((ctx) => this.onCommand?.(msg, ctx));
          } else if (msg.cmd === "listMcpServers") {
            void this.answer(ws, async (ctx) => ({
              channel: "mcp",
              type: "servers",
              servers: (await this.opts.listMcpServers?.(ctx)) ?? [],
            }), live);
          } else if (msg.cmd === "listDeployments") {
            void this.answer(ws, async (ctx) => ({
              channel: "deploy",
              type: "deployments",
              ...((await this.opts.listDeployments?.(ctx)) ?? { deployments: [], railwayConfigured: false }),
            }), live);
          } else if (msg.cmd === "listProviders") {
            void withContext(async (ctx) =>
              this.sendTo(ws, {
                channel: "providers",
                type: "providers",
                ...((await this.opts.listProviders?.(ctx)) ?? { providers: [], ownKeyForPlatform: false }),
              }));
          } else if (DEPLOY_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the deploy manager and can answer with a
            // precise error on the "deploy" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as DeployChannelCommand, ctx));
          } else if (BILLING_COMMANDS.has(msg.cmd)) {
            // Forwarded like a mutation even though it is a read — see BILLING_COMMANDS.
            void withContext((ctx) => this.onCommand?.(msg as LoadUsageCommand, ctx));
          } else if (PROVIDER_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the credential writer and can answer with a
            // precise error on the "providers" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as ProviderCommand, ctx));
          } else if (MCP_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the registry and can answer with a
            // precise error on the "mcp" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as McpCommand, ctx));
          } else if (CONNECTION_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the OAuth service and can answer with a
            // precise error on the "connections" channel rather than dropping the message here.
            // The read is forwarded too — see CONNECTION_COMMANDS for why it is not local.
            void withContext((ctx) => this.onCommand?.(msg as ConnectionCommand, ctx));
          } else if (GITHUB_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the GitHub client and the object store and can
            // answer with a precise error on the "github" channel rather than dropping the
            // message here. The reads are forwarded too, for the reason CONNECTION_COMMANDS gives:
            // every one of them makes a network call to a third party that can take seconds and
            // fail five ways, and the relay holds no token to make it with.
            void withContext((ctx) => this.onCommand?.(msg as GithubCommand, ctx));
          } else if (MEMBER_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the identity repository and can answer with
            // a precise error on the "members" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as MemberCommand, ctx));
          } else if (EVAL_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the eval store and can answer with a
            // precise error on the "eval" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as EvalCommand, ctx));
          } else if (msg.cmd === "listAgents") {
            void this.answer(ws, async (ctx) => ({
              channel: "agents",
              agents: (await this.opts.listAgents?.(ctx)) ?? [],
            }), live);
          } else if (msg.cmd === "loadRun" && typeof msg.runId === "string") {
            // Answer only the requesting client with that run's steps (ordered by seq).
            const runId = msg.runId;
            // The read that used to be the hole: `loadRun` took an id from the client and
            // answered with that run's steps, with nothing checking whose run it was. Scoped
            // now, so an id belonging to another workspace resolves to an empty list.
            void this.answer(ws, async (ctx) => ({
              channel: "runSteps",
              runId,
              steps: await this.store.stepsForRun(ctx, runId),
            }), live);
          }
      }
    } catch {
      /* a command whose shape does not match; the switch above dropped it */
    }
  }

  /**
   * Decide, before the handshake, whether this connection may exist.
   *
   * Two gates, in this order and for different attackers:
   *
   *   THE ORIGIN, first, because it is free and because it is the cross-site-hijacking defence.
   *   WebSockets are not covered by CORS, so a page on another origin can open one against
   *   this server with the user's browser doing the connecting. See auth/origin.ts.
   *
   *   THE TICKET, second, because it costs a database round trip. The authoriser consumes it,
   *   and consuming is single-use — so a refusal here has already burned the ticket, which is
   *   correct: a ticket presented to a rejected upgrade must never work on a second attempt.
   *
   * A refusal is an HTTP response on the raw socket. `ws` is never handed the connection at
   * all, so nothing counts it, nothing snapshots to it, and the client reads a status.
   */
  private async upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const origin = req.headers.origin;
    if (this.opts.originPolicy && !this.opts.originPolicy.allows(origin)) {
      console.warn(`[relay] refused a socket from origin ${JSON.stringify(origin)}`);
      return refuseUpgrade(socket, 403, "origin not allowed");
    }
    let session: SocketSession;
    try {
      session = asSession(await this.opts.contextFor(req));
    } catch (err) {
      const status = err instanceof UpgradeRefused ? err.status : 401;
      // The message is the authoriser's, and everything that reaches here was written in this
      // codebase for a person to read — never a driver's or a third party's.
      return refuseUpgrade(socket, status, (err as Error).message || "not authorised");
    }
    (req as AuthorizedRequest)[SESSION] = session;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  /** The router first, then the static fallback client, then 404. */
  private async serveHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.opts.router && (await this.opts.router.handle(req, res))) return;
    await this.serveStatic(req, res);
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    // The DOCUMENT policy, not the API's. `debug-client.html` is one file with its style and its
    // script inside it, so the policy that permits nothing would serve a blank page — see
    // http/security.ts for what it still forbids, which is everything that turns an injection
    // into an exfiltration. The 404 and the 500 get it too: both are documents as far as a
    // browser is concerned, and a response with no policy is the one worth finding.
    const secure = documentSecurityHeaders();
    if (path === "/" || path === "/index.html") {
      try {
        const html = await readFile(this.opts.clientHtmlPath);
        res.writeHead(200, { ...secure, "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(500, secure).end("debug client not found");
      }
      return;
    }
    res.writeHead(404, secure).end("not found");
  }

  private sendTo(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  /**
   * Send to the clients in ONE workspace.
   *
   * Every channel below except `providers` carries something a workspace owns: a run's
   * payloads, an agent's generated source, a build log, an MCP confirmation showing the
   * arguments a model just produced. Sending any of them to every connected socket is the
   * same leak the history and agent snapshots were fixed for, and it is a worse one — those
   * were lists of names, these are the contents.
   *
   * A socket whose context has not resolved yet receives nothing rather than everything. It
   * is mid-handshake and about to get a full snapshot anyway; guessing would be the only way
   * to get this wrong.
   */
  private broadcastTo(ctx: TenantContext, payload: unknown): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (this.contexts.get(ws)?.workspaceId !== ctx.workspaceId) continue;
      ws.send(msg);
    }
    // Session 5: fan this SAME decision out to every other gateway replica, so a client
    // connected to a different one sees it too — see queue/eventBridge.ts. Fired AFTER local
    // delivery, and only from here: every broadcastX method already funnels through this one
    // function, which is what makes one hook enough rather than one per channel. Firing it
    // for ANYTHING that reaches broadcastTo also means it fires for exactly what was already
    // decided to broadcast — an eval run's events that isEvalRun() kept off "trace" never
    // reach broadcastTo for "trace" in the first place, so they never reach this hook either,
    // with no separate cross-replica bookkeeping needed to preserve that.
    this.opts.onBroadcast?.(ctx, payload);
  }

  /**
   * The other half of the hook above: deliver a payload ANOTHER replica already decided to
   * broadcast, to sockets on THIS one — without re-firing onBroadcast, which would publish it
   * right back and the two replicas would ping-pong the same message forever. See
   * queue/eventBridge.ts's subscriber, the only caller.
   *
   * Deliberately its own copy of broadcastTo's loop rather than a shared helper the two call
   * — channels.test.ts statically inspects broadcastTo's OWN body for the workspace
   * comparison, on purpose (a chokepoint worth keeping self-contained and boring), and this
   * method carries the identical comparison for the identical reason, not because sharing it
   * was hard.
   */
  deliverFromPeer(ctx: TenantContext, payload: unknown): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (this.contexts.get(ws)?.workspaceId !== ctx.workspaceId) continue;
      ws.send(msg);
    }
  }

  /** Rebuild a snapshot per recipient. For the channels whose payload IS a query result. */
  async broadcastMcpServers(): Promise<void> {
    await this.perClient(async (ws, ctx) => {
      this.sendTo(ws, { channel: "mcp", type: "servers", servers: (await this.opts.listMcpServers?.(ctx)) ?? [] });
    });
  }

  async broadcastDeployments(): Promise<void> {
    await this.perClient(async (ws, ctx) => {
      const snapshot = (await this.opts.listDeployments?.(ctx)) ?? {
        deployments: [],
        railwayConfigured: false,
      };
      this.sendTo(ws, { channel: "deploy", type: "deployments", ...snapshot });
    });
  }

  /** Stop listening. For tests; the server itself runs until the process does. */
  async close(): Promise<void> {
    if (this.revalidator) clearInterval(this.revalidator);
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.contexts.clear();
    this.sessions.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /**
   * Answer one client with something a database has to be asked for.
   *
   * A read that throws must not take the socket down with it: the client asked a question,
   * the answer is unavailable, and the connection is still good for every other question.
   * `sendTo` already no-ops on a socket that closed while the query was in flight.
   */
  private async answer(
    ws: WebSocket,
    build: (ctx: TenantContext) => Promise<unknown>,
    pending: Promise<TenantContext>,
  ): Promise<void> {
    try {
      this.sendTo(ws, await build(await pending));
    } catch (err) {
      console.error("[relay] read failed:", (err as Error).message);
    }
  }

  // Broadcast a trace event to every connected client.
  broadcastTrace(ctx: TenantContext, event: TraceEvent): void {
    this.broadcastTo(ctx, { channel: "trace", event });
  }

  // Broadcast a diagnostic (stderr line, parse error) for visibility in the client.
  broadcastLog(ctx: TenantContext, level: "stderr" | "parseError", text: string): void {
    this.broadcastTo(ctx, { channel: "log", level, text });
  }

  // Broadcast a generation event. Separate channel from "trace" by design.
  broadcastGen(ctx: TenantContext, event: GenEvent): void {
    this.broadcastTo(ctx, { channel: "gen", ...event });
  }

  // Broadcast an edit-flow event. Separate channel from "trace" and "gen" by design.
  broadcastEdit(ctx: TenantContext, event: EditEvent): void {
    this.broadcastTo(ctx, { channel: "edit", ...event });
  }

  // Broadcast a debug-depth control event (pause/resume/boundary/branched). Separate channel by
  // design — the run's steps still arrive as normal schema-v1 events on "trace".
  broadcastDebug(ctx: TenantContext, event: DebugEvent): void {
    this.broadcastTo(ctx, { channel: "debug", ...event });
  }

  // Broadcast an "explain" reply event (unified composer). Separate channel by design — it never
  // enters the trace store or the frozen event schema.
  broadcastReply(ctx: TenantContext, event: ReplyEvent): void {
    this.broadcastTo(ctx, { channel: "reply", ...event });
  }

  // Broadcast an eval-channel event (datasets, and later eval progress/results). Separate
  // channel by design — it never carries trace steps, so a running eval can't steal the
  // Trace timeline's focus.
  broadcastEval(ctx: TenantContext, event: EvalEvent): void {
    this.broadcastTo(ctx, { channel: "eval", ...event });
  }

  // Broadcast an MCP registry event. Separate channel by design — an MCP tool call itself
  // is an ordinary tool_call Step and still arrives on "trace" like any other.
  broadcastMcp(ctx: TenantContext, event: McpEvent): void {
    this.broadcastTo(ctx, { channel: "mcp", ...event });
  }

  /** Broadcast a connections event. Separate channel by design — see ConnectionEvent. */
  broadcastConnections(ctx: TenantContext, event: ConnectionEvent): void {
    this.broadcastTo(ctx, { channel: "connections", ...event });
  }

  /** Broadcast a deploy event. Separate channel by design — see DeployEvent. */
  broadcastDeploy(ctx: TenantContext, event: DeployEvent): void {
    this.broadcastTo(ctx, { channel: "deploy", ...event });
  }

  /** Broadcast a GitHub event. Separate channel by design — see GithubEvent. */
  broadcastGithub(ctx: TenantContext, event: GithubEvent): void {
    this.broadcastTo(ctx, { channel: "github", ...event });
  }

  /** Broadcast a membership event to the workspace it concerns. See MemberEvent. */
  broadcastMembers(ctx: TenantContext, event: MemberEvent): void {
    this.broadcastTo(ctx, { channel: "members", ...event });
  }

  /**
   * Send a membership event to ONE socket.
   *
   * For `inviteLink`, which carries a credential. Broadcasting it would hand the link to every
   * admin with a tab open, when exactly one person asked for it and is about to send it on.
   */
  sendMembers(ctx: TenantContext, requestId: string, event: MemberEvent): void {
    for (const [ws, session] of this.sessions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (session.context.workspaceId !== ctx.workspaceId) continue;
      if (session.context.requestId !== requestId) continue;
      this.sendTo(ws, { channel: "members", ...event });
    }
  }

  /**
   * Broadcast a provider-credential event. Separate channel by design — see ProviderEvent.
   *
   * SCOPED, like every other broadcast. This was the last one that went to every connected
   * client regardless of workspace, and Session 1 left it that way because provider keys live
   * in one `runtime/.env` and genuinely are process-wide. That is still true of the VALUES —
   * and it is exactly why the message must not be — because "anthropic is configured" is a
   * fact about the install that a workspace has no business being told by another workspace's
   * admin pressing Save. Worse, a `testResult` or a `notice` is the answer to somebody else's
   * click, arriving in a panel nobody opened.
   *
   * Session 6 makes keys per-workspace via the SecretStore, at which point this is not a
   * courtesy but a hard boundary. The shape is already right for it.
   */
  broadcastProviders(ctx: TenantContext, event: ProviderEvent): void {
    this.broadcastTo(ctx, { channel: "providers", ...event });
  }

  /**
   * What a workspace has spent, and against what.
   *
   * Scoped like every other broadcast, and it matters more here than on most of them: a spend
   * figure sent to the wrong workspace is not a leak of a row, it is one tenant reading another's
   * invoice.
   */
  broadcastBilling(ctx: TenantContext, event: BillingEvent): void {
    this.broadcastTo(ctx, { channel: "billing", ...event });
  }

  // Push a refreshed run-history snapshot to everyone (e.g. after a branch is created, so the new
  // branch run appears in history without needing a run_start event of its own).
  /**
   * Push a refreshed history to each client, IN ITS OWN WORKSPACE.
   *
   * One query whose result went to everybody was the shape of every broadcast here, and it is
   * the one thing a tenant boundary cannot survive. Per recipient now — more queries, and the
   * only correct number of them.
   */
  async broadcastHistory(): Promise<void> {
    await this.perClient(async (ws, ctx) => {
      this.sendTo(ws, { channel: "history", runs: await this.store.listRuns(ctx) });
    });
  }

  /** Run `fn` once per connected client, with that client's own context. */
  private async perClient(fn: (ws: WebSocket, ctx: TenantContext) => Promise<void>): Promise<void> {
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const ctx = this.contexts.get(ws);
      if (!ctx) continue; // still resolving; its initial snapshot will carry the answer
      try {
        await fn(ws, ctx);
      } catch (err) {
        console.error("[relay] broadcast failed:", (err as Error).message);
      }
    }
  }

  /**
   * Push an agent's current files to the workspace that owns it, after an apply or undo.
   *
   * SCOPED, and not merely per recipient. `perClient` alone rebuilds the payload with each
   * client's own context, so no other workspace ever received the FILES — but every one of
   * them still received the message, and the message names the agent. Slugs are chosen by
   * users, so that is one tenant learning that another has an agent called
   * `acme_invoice_reconciler`, pushed to them unasked every time it is edited.
   *
   * The context is the editing workspace's, so this reaches exactly the clients entitled to
   * know the edit happened.
   */
  broadcastAgentFiles(ctx: TenantContext, agentId: string): void {
    void this.perClient(async (ws, clientCtx) => {
      if (clientCtx.workspaceId !== ctx.workspaceId) return;
      this.sendTo(ws, {
        channel: "agentFiles",
        agentId,
        files: (await this.opts.listAgentFiles?.(clientCtx, agentId)) ?? [],
      });
    });
  }

  /**
   * Push a refreshed graph to the workspace that owns the agent, after an apply or undo whose
   * edit may have changed its topology. Scoped for the reason `broadcastAgentFiles` is.
   */
  async broadcastAgentGraph(ctx: TenantContext, agentId: string): Promise<void> {
    await this.perClient(async (ws, clientCtx) => {
      if (clientCtx.workspaceId !== ctx.workspaceId) return;
      const graph = (await this.opts.getAgentGraph?.(clientCtx, agentId)) ?? null;
      this.sendTo(ws, { channel: "graph", agentId, graph });
    });
  }

  // Push a refreshed agent list to everyone (after a generation lands).
  async broadcastAgents(): Promise<void> {
    await this.perClient(async (ws, ctx) => {
      this.sendTo(ws, { channel: "agents", agents: (await this.opts.listAgents?.(ctx)) ?? [] });
    });
  }
}

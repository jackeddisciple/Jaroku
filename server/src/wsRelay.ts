// WebSocket relay (doc §8): pushes trace events to browser clients in real time, and
// serves the static debug client over the same HTTP port. On connect, a client receives the
// run history snapshot; thereafter it receives live events as they arrive.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import type { TraceStore } from "./store.ts";
import type { ThreadStatus } from "./threadStore.ts";
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
  /**
   * The build session this work belongs to (§7.1, migration 044).
   *
   * OPTIONAL ON EVERY COMMAND THAT CARRIES IT, and that is deliberate rather than transitional. A
   * client that does not name a thread gets the agent's most recently active one, which is the
   * continuity the backfill established — and a run started by something with no session at all,
   * like a CI check reacting to a webhook, has no thread to name and should not be made to invent
   * one.
   */
  threadId?: string;
};
export type LoadRunCommand = { cmd: "loadRun"; runId: string };

/**
 * A LARGER WINDOW ON THE RUN HISTORY — the paging this product had none of.
 *
 * WHAT WAS UNREACHABLE. Every list read is `ORDER BY <time> DESC LIMIT 50` with no offset, no cursor
 * and no way to ask for more, so the 51st-newest run could not be opened: `loadRun` needs an id, and
 * the only source of ids was the list that stopped at fifty. The sidebar's search box filters what
 * was fetched, so looking for an older run found nothing and said so as though it did not exist —
 * while retention keeps traces for a month to a year, by plan.
 *
 * A GROWING WINDOW RATHER THAN A CURSOR, and that is a deliberate trade. Every channel in this
 * product is a full-snapshot channel: a client REPLACES rather than merges, which is what makes it
 * impossible to hold a list assembled from two moments. A cursor plus an append would break that
 * invariant for one feature; asking for a bigger window keeps it, at the cost of re-sending rows the
 * client already has. `applyHistory` merges by run id, so the cost is bytes and never duplicates.
 *
 * Capped, because a client asking for everything is a client asking this process to read a year of
 * runs into memory. `complete` on the answer is what a "load more" control needs: it is true when the
 * window returned fewer rows than it asked for, which is the only reliable signal that there is
 * nothing further back.
 */
export type LoadHistoryCommand = { cmd: "loadHistory"; limit?: number };

/** The most rows one client may pull into a sidebar. See LoadHistoryCommand. */
export const HISTORY_WINDOW_MAX = 500;
export type GenerateCommand = {
  cmd: "generate";
  prompt: string;
  /** The session this build happens in. See RunCommand.threadId. */
  threadId?: string;
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
  /** The session this plan happens in. See RunCommand.threadId. */
  threadId?: string;
  connectors?: string[];
  /** Scoped MCP tools, as `"server/tool"` refs. See GenerateCommand.mcpTools. */
  mcpTools?: string[];
  name?: string;
  revisePlanId?: string;
};
export type DiscardPlanCommand = { cmd: "discardPlan"; planId: string };
export type ListAgentsCommand = { cmd: "listAgents" };

/**
 * The agent lifecycle: put one away, bring it back, give it a name a person chose.
 *
 * WHAT THESE REPLACE. Nothing. Until now the product's central object had no lifecycle operation of
 * any kind — no delete, no archive, no rename, in any layer — while every other resource in it had
 * one, and the Threads specification devoted a section to what happens when an agent is deleted and
 * used that deletion as the reason not to build a thread-delete confirmation.
 *
 * ARCHIVE RATHER THAN DELETE, for the reason threads are archived: an agent's versions, runs, traces
 * and costs are the record every past comparison points at, and destroying them because somebody
 * tidied a sidebar is not a trade this product makes. Reversible in one command, and nothing else
 * moves — the threads keep pointing at it, because an archived agent is not a deleted one.
 *
 * `agentId` IS THE SLUG, like every other agent-addressed command on this socket. The rename changes
 * `display_name` and never the slug: the slug is the directory on disk, the key datasets and eval
 * runs hold, and the id every past run row names.
 */
export type ArchiveAgentCommand = { cmd: "archiveAgent"; agentId: string };
export type RestoreAgentCommand = { cmd: "restoreAgent"; agentId: string };
export type RenameAgentCommand = { cmd: "renameAgent"; agentId: string; name: string };

/**
 * Duplicate an agent: its connectors and its current version, and none of its MCP grants (§7.5).
 *
 * CHEAP BY CONSTRUCTION — a manifest and a pointer. The forked agent's first version names the SAME
 * objects the original's current version does, because they are content-addressed and immutable, so
 * nothing is copied and neither agent can affect the other's bytes.
 *
 * IT RESETS MCP GRANTS TO ZERO, and that is the decision rather than an omission. Copying them would
 * silently re-grant high-impact third-party tools to a brand-new agent without anybody ticking a
 * box, and the entire MCP design rests on access being granted per tool, deliberately. Connectors
 * ARE copied, because a connector is a reviewed template this workspace has already audited and
 * carries no third-party grant with it.
 */
export type ForkAgentCommand = { cmd: "forkAgent"; agentId: string };

/**
 * Publish a NEW version whose manifest is an old one's (§6).
 *
 * NOT A POINTER MOVE BACKWARDS, and the distinction is the whole of it. `undoEdit` walks
 * `current_version` back one and marks what it left behind — a linear history with a shape. This is
 * a person saying "go back to v3" from a list, which may be six versions back and may be a version
 * that has already been undone, and answering that by moving the pointer would rewrite the history
 * that made the request legible. Publishing forward instead mirrors the publish-reserves-then-
 * promotes fix in the storage layer: the new version's objects are the old version's objects, which
 * are immutable and therefore cannot have been collected out from under a pointer that now names
 * them.
 */
export type RestoreAgentVersionCommand = {
  cmd: "restoreAgentVersion";
  agentId: string;
  version: number;
};

export type AgentCommand =
  | ArchiveAgentCommand
  | RestoreAgentCommand
  | RenameAgentCommand
  | ForkAgentCommand
  | RestoreAgentVersionCommand;

const AGENT_COMMANDS = new Set([
  "archiveAgent", "restoreAgent", "renameAgent", "forkAgent", "restoreAgentVersion",
]);

/**
 * The Agents tab's three reads (§4, §6).
 *
 * ON THE EXISTING `agents` CHANNEL rather than a new one, which §7.4 asks to be argued either way.
 * There is no reason to open one: every message here is the same subject the channel already
 * carries — this workspace's agents — every recipient is a socket already receiving that subject,
 * and `test:channels` classifies a channel once, by what it carries. A second channel would be a
 * second classification of one fact and a second place a broadcast could forget to be scoped.
 *
 * ALL THREE ARE ANSWERED TO THE ASKING SOCKET, like `listAgents` beside them: they are rows this
 * process can already reach, and opening a card is one client's navigation. The MUTATIONS —
 * archive, restore, rename, fork, restore-version — broadcast the whole grid, so no client ever
 * merges a partial update into a list whose derived tags it did not compute.
 */
export type ListAgentGridCommand = { cmd: "listAgentGrid" };
export type LoadAgentDetailCommand = { cmd: "loadAgentDetail"; agentId: string };
/** One version's files, for §6's browser and for the overflow menu's Export. */
export type LoadAgentVersionCommand = {
  cmd: "loadAgentVersion";
  agentId: string;
  /** Omitted means the agent's current version, which is what the browser opens on. */
  version?: number;
};
// The fix loop (doc §8 Week 4): every mutation is proposal -> explicit apply/undo.
export type EditCommand = {
  cmd: "edit";
  agentId: string;
  instruction: string;
  /** The session this edit happens in. See RunCommand.threadId. */
  threadId?: string;
};
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
  /** The session this sweep was started from. See RunCommand.threadId. */
  threadId?: string;
};
export type CancelEvalCommand = { cmd: "cancelEval"; evalId: string };
// The rubric is product surface, not a constant — "correct" for a refund bot is not
// "correct" for a SQL agent. Saving one for a dataset overrides the shared default.
export type LoadRubricCommand = { cmd: "loadRubric"; datasetId: string };
/** The comparison dashboard's data: per-provider rollups plus per-example rows. */
export type LoadEvalResultsCommand = { cmd: "loadEvalResults"; evalId: string };
/** Past evals for a dataset (or all), so a finished comparison stays reachable. */
/** `limit` is a growing WINDOW, capped at HISTORY_WINDOW_MAX — see LoadHistoryCommand. */
export type ListEvalsCommand = { cmd: "listEvals"; datasetId?: string; limit?: number };
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

/**
 * The workspace's OWN spend ceiling, which is not the same thing as its plan's.
 *
 * THREE MEANINGFUL VALUES, and that is why `usd` is `number | null` rather than a number:
 *
 *   `null`  use the plan's ceiling. The default, and the way back from having set one.
 *   `0`     start nothing. A real state — it is what an abuse response applies — and one a
 *           signature that treated 0 as "unset" could not express.
 *   `n`     start at most `n` this period.
 *
 * It bounds what may be STARTED, never what is spent: a run already in flight finishes, which is
 * the rule every ceiling in this codebase follows.
 */
export type SetSpendCeilingCommand = { cmd: "setSpendCeiling"; usd: number | null };

export type BillingCommand = LoadUsageCommand | SetSpendCeilingCommand;

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
const BILLING_COMMANDS = new Set(["loadUsage", "setSpendCeiling"]);

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

/**
 * §B.6's findings, as a HISTORY rather than as the live refusal.
 *
 * THE LIVE REFUSAL ALREADY REACHES THE PANEL. What did not was the record: every finding is stored
 * with whether it was OVERRIDDEN and by whom — the rows `auditGithubOverride` exists to make
 * answerable — and `GithubRepository.findings` had no caller, so "has anybody pushed past a secret
 * scan on this agent, and what did they push past" could only be asked in SQL.
 *
 * ON DEMAND rather than on the snapshot, unlike the check markers beside it: this is a question asked
 * during a review, the answer is empty for almost every agent, and a row per push on every panel
 * render would be a read nobody asked for.
 */
export type ListScanFindingsCommand = { cmd: "listScanFindings"; agentId: string };

/**
 * §B.7's Agent diff: what changed about the agent, between the current version and a ref.
 *
 * COMPUTED ON DEMAND RATHER THAN CARRIED ON THE SNAPSHOT, because it costs a tree read from GitHub
 * and a Python parse of both sides — and §1's snapshot is assembled on every panel open, for every
 * agent somebody clicks. A toggle is a click; a snapshot is a render.
 */
export type SemanticDiffCommand = { cmd: "semanticDiffGithub"; agentId: string; ref?: string };

/**
 * §B.5.3: an edit that answers a review comment has landed, so tell the reviewer where.
 *
 * SEPARATE FROM APPLYING THE EDIT, and that separation is the feature rather than an accident of
 * plumbing. §B.5.1's whole design is that a review comment is context and not an instruction — so
 * the edit is applied by the ordinary Apply on the ordinary diff card, through the ordinary
 * validator, and this is what happens AFTERWARDS. An apply that also replied would be a write path
 * that a review comment reached, which is precisely what §B's governing constraint forbids.
 *
 * `resolution` LETS SOMEBODY CLOSE A COMMENT WITHOUT ACTING ON IT. `dismissed` exists so that
 * deciding not to change anything is a decision the region records, rather than being
 * indistinguishable from never having read it.
 */
export type ResolveReviewCommentCommand = {
  cmd: "resolveReviewComment";
  agentId: string;
  commentId: string;
  resolution: "applied" | "dismissed";
  /** The version the applied edit produced, when there is one. */
  version?: number;
  /** What to say back on GitHub. Absent means resolve locally and post nothing. */
  reply?: string;
};

/**
 * §B.1.2's opt-in: which dataset a pull request runs, and whose money it may spend.
 *
 * TWO FIELDS, BOTH OPTIONAL, BECAUSE THE DIFFERENCE BETWEEN "SET THIS TO NULL" AND "LEAVE IT
 * ALONE" IS LOAD-BEARING — the same rule `patchLink` follows. Clearing the dataset (turning checks
 * off) must keep the policy somebody chose, and choosing a policy must not clear the dataset.
 *
 * WHY IT IS ON THE GITHUB CHANNEL and not the eval one, even though it names a dataset: what is
 * being configured is what happens on a PULL REQUEST, it is read by the webhook branch, and its
 * results are the markers the GitHub panel already renders. The dataset is the parameter, not the
 * subject.
 *
 * `github:manage`, like every other write in this family. It decides whether a stranger's pull
 * request can spend this workspace's provider balance, which is the sharpest version of what
 * "commits the workspace to something outside itself" means.
 */
export type SetAgentCiConfigCommand = {
  cmd: "setAgentCiConfig";
  agentId: string;
  /** Null turns checks off while keeping the policy. Absent leaves it alone. */
  datasetId?: string | null;
  policy?: "dry_run_only" | "collaborators_paid" | "always_paid";
};

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
  | ListShadowRunsCommand
  | SemanticDiffCommand
  | ResolveReviewCommentCommand
  | ListScanFindingsCommand
  | SetAgentCiConfigCommand;

const GITHUB_COMMANDS = new Set([
  "listGithub", "listGithubRepos", "checkGithubRepo", "linkGithub", "unlinkGithub",
  "refreshGithub", "pushGithub", "pullGithub", "switchGithubBranch", "createGithubBranch",
  "openGithubPr", "commitGithub", "generateGithubMessage", "diagnoseFile",
  "shadowRunGithub", "listShadowRuns", "semanticDiffGithub", "resolveReviewComment",
  "setAgentCiConfig", "listScanFindings",
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

/**
 * The workspace's own record of what has been done to it.
 *
 * A CHANNEL OF ITS OWN rather than a field on `members`, even though the identity repository owns
 * both. `audit_log` is written by membership mutations, by every GitHub safety override, by secret
 * reveals and rotations, by enforcement appeals and by workspace export and deletion — five
 * subsystems, only one of which is membership. Answering it on the members channel would make the
 * widest read in the product a footnote on the narrowest one.
 *
 * ANSWERED TO THE ASKING SOCKET, never broadcast. It is a read, nothing about it changes, and its
 * rows name who revealed which credential and who removed whom — there is no reason for one
 * person's decision to open a log to put that on every other tab in the workspace.
 */
export type ListAuditCommand = { cmd: "listAudit"; limit?: number };

export type AuditEvent =
  | { type: "audit"; entries: unknown[] }
  | { type: "error"; message: string };

const AUDIT_COMMANDS = new Set(["listAudit"]);

/**
 * What rung this workspace is under, and its answer to it.
 *
 * TWO COMMANDS, AND THE APPEAL IS THE POINT. The abuse ladder is one-sided by construction: a
 * score rises, a rung is applied, work is refused, and the workspace is told. `appeal_note` is the
 * column that makes it two-sided, and the repository's own doc says why it is a MEMBER's write —
 * "an appeal that has to go through the party that applied the enforcement is not an appeal". It
 * had no command, no route and no surface, so the note could only be written by SQL, which is the
 * one hand that does not need an appeal mechanism.
 *
 * ITS OWN CHANNEL, not `billing` and not `providers`. Today the only signal a workspace gets is a
 * refusal on whichever channel it was working in plus a `providers` notice, so "why can I not start
 * anything" is answered in a different place each time. A rung is a fact about the workspace's
 * standing, which is neither its money nor its credentials.
 */
export type LoadEnforcementCommand = { cmd: "loadEnforcement" };
export type AppealEnforcementCommand = { cmd: "appealEnforcement"; note: string };

export type EnforcementCommand = LoadEnforcementCommand | AppealEnforcementCommand;

export type EnforcementEvent =
  | { type: "enforcement"; state: unknown; history: unknown[] }
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

const ENFORCEMENT_COMMANDS = new Set(["loadEnforcement", "appealEnforcement"]);

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
  /** The session this question was asked in. See RunCommand.threadId. */
  threadId?: string;
};
export type ClientCommand =
  | RunCommand
  | LoadRunCommand
  | LoadHistoryCommand
  | GenerateCommand
  | PlanAgentCommand
  | DiscardPlanCommand
  | ListAgentsCommand
  | ListAgentGridCommand
  | LoadAgentDetailCommand
  | LoadAgentVersionCommand
  | AgentCommand
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
  | ListInboxCommand
  | InboxCommand
  | ListMcpServersCommand
  | ProviderCommand
  | ListProvidersCommand
  | ConnectionCommand
  | BillingCommand
  | DeployChannelCommand
  | ListDeploymentsCommand
  | GithubCommand
  | MemberCommand
  | ListAuditCommand
  | EnforcementCommand
  | ThreadCommand
  | ListThreadsCommand
  | LoadThreadCommand;

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
  | AgentCommand
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
  | ListAuditCommand
  | EnforcementCommand
  | ThreadCommand
  | InboxCommand
  | BillingCommand;

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
  // `spentDeltaUsd` is §4.3.3's live figure for an eval, and it is the only cost this channel
  // carries. Eval runs are kept off `trace` on purpose, so this is the one route a running eval's
  // spend has to a client — see EvalProgress. It rides an event already broadcast per job
  // completion, so §7.1's "no polling channel" rule is untouched.
  | {
      type: "evalProgress"; evalId: string; total: number; done: number; running: number;
      queued: number; failed: number; spentDeltaUsd: number;
    }
  | { type: "evalFinished"; evalId: string; status: string; error?: string }
  | { type: "rubric"; datasetId: string; rubric: unknown; isDefault: boolean }
  // Scoring runs after the runs finish, so quality lands after the rest of the row. A null
  // score is UNSCORED (with a reason), never a zero.
  | { type: "scored"; evalId: string; jobId: string; score: number | null; error?: string | null }
  | { type: "scoringFinished"; evalId: string; scored: number; unscored: number }
  | { type: "evalResults"; evalId: string; results: unknown }
  // `complete` is false when there are older evals than the window returned; `window` is what was
  // actually served after the cap, so a "load more" control asks for the next size up rather than
  // guessing what it already has.
  | { type: "evals"; evals: unknown[]; complete?: boolean; window?: number }
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
  /**
   * Every model a run may be started on, grouped by provider — the SELECTABLE CATALOGUE.
   *
   * ON THE SNAPSHOT BECAUSE THE ALTERNATIVE DRIFTED. The client held the catalogue as a hardcoded
   * array, and `runtime/pricing.json` — which declares itself the single source of truth for models
   * and is read by both the Node estimator and the Python interceptor — had moved on without it:
   * four priced models, including the newest Anthropic one, could not be selected for a run, added
   * as an eval leg, or deployed with. A model added to the price sheet (the deliberate, reviewed,
   * auditable step) silently changed nothing a user could do.
   *
   * So it comes from the same file the prices do. `free` is what makes the dry-run path
   * identifiable without a second list of which providers cost money.
   */
  models: { id: string; provider: string; label: string; free: boolean }[];
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
  /**
   * §B.6's HISTORY, as opposed to the refusal above it: which findings this agent has had, and which
   * were pushed past anyway.
   *
   * A DIFFERENT SHAPE FROM THE REFUSAL'S, on purpose. A live finding carries the scanner's sentence
   * about the line it just refused; a historical one carries `overridden` and when it was recorded,
   * because the question asked of a record is "did somebody push past this, and when" rather than
   * "what does this line look like". Neither carries a matched value — there is no field one would
   * fit in, which is what lets either go to a browser at all.
   */
  | {
      type: "scanFindings";
      agentId: string;
      findings: {
        path: string;
        kind: string;
        rule: string;
        line: number | null;
        overridden: boolean;
        created_at: string;
      }[];
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
  /**
   * §B.7's Agent diff rows.
   *
   * `verb` AND `object` SEPARATELY, so the client renders them through `ActionRow` — the same
   * narrative-line vocabulary as everything else in the app, which is what makes "tool added" here
   * read exactly like "tool added" in a plan card. A pre-composed sentence would be a second
   * vocabulary in one product.
   */
  | {
      type: "semanticDiff";
      agentId: string;
      ref: string;
      rows: { kind: string; verb: string; object: string; detail?: string; warn?: boolean }[];
      /** Set when one side could not be fully parsed. The rows that DID come back are still real. */
      partial?: string;
    }
  | { type: "error"; message: string; agentId?: string }
  | { type: "notice"; message: string; agentId?: string };

// Threads ride their own channel, parallel to eval / mcp / deploy / github, and for the same
// reason each of those is not a field on another: a build session is not a run, not an agent and
// not a deployment, and every channel beside it is a full snapshot of something else.
//
// THE FROZEN SCHEMA IS UNTOUCHED. Nothing here is a trace event and nothing here changes one.
// schema/events.md v1 stays as it is, exactly as pause/resume, the eval engine and MCP support all
// did: new capability in new tables and a new channel BESIDE the timeline (§7).
//
// TWO READS ANSWERED HERE, FOUR MUTATIONS FORWARDED (§7.1). `listThreads` and `loadThread` are
// pure snapshots of rows this process can already reach, so they go back to the socket that asked
// and to nobody else — the same shape `listAgents` and `listMcpServers` take. Creating, renaming,
// archiving and restoring are forwarded to the app, which answers by broadcasting the whole list.
// A client therefore never merges a partial update into local state; it replaces.
export type ListThreadsCommand = { cmd: "listThreads" };
export type CreateThreadCommand = {
  cmd: "createThread";
  /** Optional: a thread legitimately exists before any agent does — §3.1's planning stage. */
  agentId?: string | null;
  /** Optional: a thread with nothing said in it is "Untitled thread" until the first message. */
  title?: string;
};
export type RenameThreadCommand = { cmd: "renameThread"; threadId: string; title: string };
export type ArchiveThreadCommand = { cmd: "archiveThread"; threadId: string };
export type RestoreThreadCommand = { cmd: "restoreThread"; threadId: string };
export type LoadThreadCommand = { cmd: "loadThread"; threadId: string };

/** Thread-channel commands, grouped so the forwarding switch stays readable. */
export type ThreadCommand =
  | CreateThreadCommand
  | RenameThreadCommand
  | ArchiveThreadCommand
  | RestoreThreadCommand;

// The four that MUTATE. The two reads are not here because they are answered locally — see the
// header above, and see `dispatch`, where each has a branch of its own.
const THREAD_COMMANDS = new Set(["createThread", "renameThread", "archiveThread", "restoreThread"]);

/**
 * One thread, as a row is rendered (§4.3).
 *
 * DERIVED FIELDS TRAVEL WITH THE ROW, rather than being recomputed in the browser. §3.3's status
 * is a function of pending diffs, in-flight runs, failed steps and awaiting plans — none of which
 * a client can see — so a client that derived its own would be guessing from less. The same goes
 * for the fragment beside it, which §4.3 defines as the same decision in words.
 */
export interface ThreadView {
  id: string;
  /** Null when there is no agent yet, and null again once one is deleted — see `agent_name`. */
  agent_id: string | null;
  /**
   * What to render on the agent chip: the live name, the snapshot of a deleted one, or null.
   *
   * Null with a null `agent_id` is §4.3's `(no agent)`. A name with a null `agent_id` is
   * `name (deleted)`, dimmed. The pair is what lets the row tell those two apart.
   */
  agent_name: string | null;
  /** True when the name above is a snapshot of an agent that no longer exists. */
  agent_deleted: boolean;
  title: string;
  title_is_custom: boolean;
  /** The user id, for the Team-only author column. Never rendered in a Personal workspace. */
  created_by: string | null;
  created_at: string;
  last_activity_at: string;
  archived_at: string | null;
  status: ThreadStatus;
  /** §4.3's state fragment: one decision-relevant fact, or null when there is nothing to say. */
  fragment: string | null;
  /**
   * Cumulative spend attributed to this thread, or null when nothing has cost anything yet.
   *
   * THREE STATES, NOT TWO, because §4.3 and §9 both insist on it: null is "nothing spent",
   * `cost_known: false` beside a figure is "this is a floor" (§4.3's `$0.04+`), and a figure with
   * `cost_known: true` is the answer. A zero would claim the third about the first.
   */
  cost_usd: number | null;
  /** False when something in this thread ran on an unpriced model. See `cost_usd`. */
  cost_known: boolean;
  /**
   * §4.3's preview: the last thing the USER said, never Jaroku's reply.
   *
   * "The user's own intent is what makes a thread recognisable; the assistant's response is not" —
   * which is also why only the user's turns are stored at all (migration 044).
   */
  preview: string | null;
  /**
   * The runs of this thread that are in flight (§4.3.3).
   *
   * NOT A SEVENTH MESSAGE TYPE, which is the point §7.1's protocol note makes: a running thread's cost
   * increments from the per-step cost events the trace and eval channels already carry, and these ids
   * are what let a client attribute one of those to a session. The snapshot itself is still broadcast
   * only on genuine state transitions — sending it per cost tick would turn a full-snapshot channel
   * into a polling one wearing a different hat.
   *
   * Empty for anything not running: a finished run's cost is in `cost_usd` already.
   */
  live_run_ids: string[];
  /**
   * The evals of this thread that are in flight, by eval id.
   *
   * THE SAME JOB `live_run_ids` DOES, for the channel that carries an eval's cost. A step arriving
   * on `trace` names its run; a progress event arriving on `eval` names its EVAL, and without this
   * the client had no way to decide which session's figure to move — which is half of why a running
   * eval's cost sat still. Eval runs are deliberately kept off `trace`, so their ids in
   * `live_run_ids` never receive a step and cannot serve this.
   *
   * Empty for anything not running, for the same reason as above.
   */
  live_eval_ids: string[];
  /**
   * How far a running eval has got, when one is attributed to this thread.
   *
   * THE NUMBERS, NOT THE STRING. `fragment` renders `eval 34/120` for a person to read; a client that
   * parsed that back out in order to project a total would be reading a display string as an API, and
   * the first change to the wording would silently stop the projection. Null when no eval is running
   * here, which is also the honest answer to "what will this cost" for a generation or an interactive
   * run: there is no denominator, so §4.3.3 says show no projection at all.
   */
  eval_progress: { done: number; total: number } | null;
  /**
   * How many threads on THIS agent are blocked or running right now (§4.3.4).
   *
   * ONE COUNTED FACT, NOT A FLAG, and it counts the thread it is on: `2` means this one and one other,
   * which is what the marker renders as `⚠ 2 active`. A boolean would say that a collision exists and
   * leave "how many" to a second query.
   *
   * `needs_you`, `errored` AND `running`. An idle or archived thread on the same agent is not a
   * collision, it is history — and counting it would put a warning on every agent anybody has ever
   * used twice.
   *
   * A DELIBERATE DEVIATION FROM §4.3.4's LETTER, which says "counts only `needs_you` and `running`",
   * and this said the same for a while and was already untrue of `activePerAgent`. An `errored`
   * thread is in the Needs You section (§4.2) and is unresolved work against the same files — a
   * failed run somebody has not dealt with is exactly the other session it is dangerous not to know
   * about. Stated here rather than left as a disagreement between the implementation and its own
   * type documentation.
   *
   * It is on the ROW rather than in a per-agent map beside the list, because the row is where it renders
   * and a map would be a second thing to keep in step with the statuses it was derived from.
   */
  agent_active: number;
  /**
   * True when this session accounts for a large share of what the workspace has spent this period
   * (§4.3.6).
   *
   * A FLAG AND NOT A PERCENTAGE, on purpose. A bare `$0.04` carries no sense of whether that is
   * typical, and the answer — "this one is worth a second look" — is the whole of what the row needs.
   * The number itself belongs in Activity: this view is a triage surface, not a cost dashboard, and a
   * percentage on the row would be a second metric competing for space in an already-dense line.
   *
   * The share is computed against the rolling spend the billing layer already aggregates. No new spend
   * computation exists for this: it is a threshold comparison over a figure the usage panel is drawn
   * from.
   */
  cost_share_high: boolean;
}

/** The five §4.4 chips, counted once on the server and rendered twice (§2.1). */
export interface ThreadCounts {
  all: number;
  /**
   * The Needs You SECTION's size — `needs_you` plus `errored`, which is what §4.2 puts in it.
   *
   * ONE COUNT, because §2.1 requires the nav badge and this chip to be the same number: two
   * independently-derived counts of "what is waiting on me" that disagree about whether a failure
   * counts is precisely the trust-eroding mismatch the GitHub header/badge split was built to
   * avoid, and it would be visible in two places at once.
   *
   * WHICH MEANS THE BADGE COUNTS `errored` TOO, and §2.1's letter is "the `needs_you` count only".
   * The deviation is deliberate and is recorded here because two surfaces compare this number: the
   * badge exists so nobody opens the tab to check whether anything is blocked, and a run that ended
   * in error is blocked in every sense a person cares about. Making the badge smaller than the
   * section it points at would be the same mismatch by a different route.
   */
  needs_you: number;
  running: number;
  /** Everything else that is not archived. §4.2's third section. */
  recent: number;
  archived: number;
}

/** What `listThreads` answers with: the list and the counts, computed together. */
export interface ThreadSnapshot {
  threads: ThreadView[];
  counts: ThreadCounts;
}

/**
 * What a socket is told when nothing answers `listThreads`.
 *
 * An empty list with zeroed counts rather than no message at all, because §4.6 has three empty
 * states and every one of them is a rendered surface. A client that received nothing could not
 * tell "no threads" from "not answered yet", and the difference is a skeleton row versus a
 * sentence naming the workspace.
 */
const EMPTY_THREADS: ThreadSnapshot = {
  threads: [],
  counts: { all: 0, needs_you: 0, running: 0, recent: 0, archived: 0 },
};

/**
 * One row of what a thread owns, as the client rehydrates it (§4.5).
 *
 * The store's own `ThreadItem` minus `thread_id`, which the client already knows because it asked
 * for this thread. Structural rather than imported so the wire shape is stated where every other
 * wire shape is, and so a column added to `thread_items` is a deliberate decision to send.
 */
export interface ThreadItemView {
  kind: "run" | "eval" | "plan" | "generation" | "proposal" | "message";
  ref_id: string | null;
  role: "user" | null;
  body: string | null;
  created_at: string;
}

export type ThreadEvent =
  /**
   * The whole list for one workspace, with derived status and counts.
   *
   * A FULL SNAPSHOT ON EVERY MUTATION, the same discipline the eval, MCP, provider, deploy and
   * members channels follow. There is deliberately no per-thread update message: a client that
   * merged one would have to reconcile counts it did not compute against rows it did, and the
   * counts are what the nav badge is drawn from.
   */
  | { type: "threads"; threads: ThreadView[]; counts: ThreadCounts }
  /**
   * One thread, opened into the three-pane view (§4.5), with what happened in it.
   *
   * Answered to the asking socket only. It is the request "put me back where I was", which is a
   * fact about one client's navigation and means nothing to the other tabs in the workspace.
   *
   * `items` IS WHAT MAKES OPENING A THREAD SHOW ANYTHING. Without it the row could be selected and
   * the centre pane still rendered whatever the agent's conversation happened to be — so two
   * threads on one agent showed the same turns and a reopened thread showed none. The rehydrated
   * conversation is the user's own turns plus a stub per run, plan, generation, proposal and eval;
   * Jaroku's replies are deliberately not stored (migration 044) and do not come back.
   */
  //
  // `reason` DISTINGUISHES THE TWO THINGS THAT ANSWER WITH ONE ROW, because the client does
  // different things with them. `loaded` is the answer to `loadThread`, which the client sent
  // BECAUSE it was already opening that thread. `created` is the row `createThread` just made, and
  // nothing had opened it — the client showed the new row in the list and left it there, so `+ New
  // thread` produced a permanently empty, permanently untitled row that no work could reach.
  | { type: "thread"; thread: ThreadView; items: ThreadItemView[]; reason: "loaded" | "created" }
  | { type: "error"; message: string; threadId?: string }
  | { type: "notice"; message: string; threadId?: string };

// --- the Inbox: what is waiting on somebody, and the three verbs -------------------------------
//
// ITS OWN CHANNEL, parallel to threads / agents / eval / mcp / deploy / github, and for the reason
// each of those is not a field on another: what is waiting on you is not a session, not an artifact
// and not a run. §6.4 asks for the established shape exactly, and the established shape is this one.
//
// THE ONE THING THAT IS GENUINELY DIFFERENT: A SNAPSHOT IS PER PERSON. Every other channel here
// answers a question about a workspace, so one payload is correct for every socket in it. Two of the
// three verbs are personal — a dismissal and a snooze are one person's judgement — so two people in
// one workspace are entitled to two different boards, and a payload built once and fanned out would
// show Ada's dismissals on Bob's screen. `broadcastInbox` therefore builds per RECIPIENT and memoises
// per (workspace, user) rather than per workspace.
//
// THE FROZEN SCHEMA IS UNTOUCHED. Nothing here is a trace event and nothing here changes one, exactly
// as threads, evals and MCP all did: new capability in new tables and a new channel BESIDE the
// timeline.
export type ListInboxCommand = { cmd: "listInbox" };
export type ResolveInboxItemCommand = { cmd: "resolveInboxItem"; itemId: string };
export type DismissInboxItemCommand = { cmd: "dismissInboxItem"; itemId: string };
export type SnoozeInboxItemCommand = { cmd: "snoozeInboxItem"; itemId: string; duration?: string };
/** §3's undo, by the token the toast was given. See UndoLedger for why the client sends only that. */
export type UndoInboxActionCommand = { cmd: "undoInboxAction"; token: string };
/** §3's bulk: a range, or a column's overflow menu. One action, one token, one undo. */
export type BulkInboxActionCommand = {
  cmd: "bulkInboxAction";
  action: string;
  itemIds: string[];
  duration?: string;
};

export type InboxCommand =
  | ResolveInboxItemCommand
  | DismissInboxItemCommand
  | SnoozeInboxItemCommand
  | UndoInboxActionCommand
  | BulkInboxActionCommand;

// The five that MUTATE. `listInbox` is not here because it is answered locally — see `dispatch`.
const INBOX_COMMANDS = new Set([
  "resolveInboxItem", "dismissInboxItem", "snoozeInboxItem", "undoInboxAction", "bulkInboxAction",
]);

/**
 * What `listInbox` answers with. Structural rather than imported, like every other wire shape here.
 *
 * `unknown[]` FOR THE ROWS RATHER THAN THE SERVER'S OWN TYPE, which is the same choice `listMembers`
 * and `listDeployments` make. The relay's job is to carry this to the socket that asked; restating
 * a sixteen-field card shape here would be a second definition of it that the first change to a
 * payload field makes wrong.
 */
export interface InboxSnapshotPayload {
  items: unknown[];
  snoozed: unknown[];
  counts: unknown;
  agents: unknown[];
  cleared_this_week: number;
}

/**
 * What a socket is told when nothing answers `listInbox`.
 *
 * An empty board with zeroed counts rather than no message at all, for the reason the threads
 * channel has the same constant: §5.3's zero state and "we have not been told yet" are two different
 * renderings, and a client that received nothing could not tell them apart.
 */
const EMPTY_INBOX_PAYLOAD: InboxSnapshotPayload = {
  items: [],
  snoozed: [],
  counts: { all: 0, blocking: 0, attention: 0, proposals: 0, team: 0, snoozed: 0, badge: 0 },
  agents: [],
  cleared_this_week: 0,
};

export type InboxEvent =
  /**
   * The whole board for one person, with counts.
   *
   * A FULL SNAPSHOT ON EVERY MUTATION, the discipline every channel here follows: a client REPLACES
   * rather than merges, so it can never hold a board assembled from two moments and the badge can
   * never be one snapshot behind the cards beside it.
   */
  | ({ type: "inbox" } & InboxSnapshotPayload)
  /**
   * One card, changed. §5.6's live resolution.
   *
   * A DELTA EXISTS ONLY FOR FACTS THAT ARE THE SAME FOR EVERY PERSON IN THE WORKSPACE, which is what
   * makes it safe on a channel whose snapshots are per person. A resolution is shared — the problem
   * is fixed, for everybody — so "this card is gone" is true on every board that was showing it. A
   * DISMISSAL IS NOT, and there is deliberately no delta for one: it would arrive at a teammate who
   * never made that judgement.
   *
   * `added` CARRIES THE WHOLE CARD, and is only emitted for an item that has just come into
   * existence — one nobody can have dismissed yet. A re-opened item goes out as a full snapshot
   * instead, because somebody may be holding an old dismissal of it.
   *
   * The client re-renders the affected card only, which §5.6 asks for and which is a rendering
   * decision made against a board it already holds — never a licence for the server to send half of
   * one.
   */
  | { type: "inboxDelta"; kind: "resolved"; itemId: string }
  | { type: "inboxDelta"; kind: "count"; itemId: string; count: number; last_seen_at: string }
  | { type: "inboxDelta"; kind: "added"; item: unknown }
  /** The toast's token, to the socket that acted. Nobody else's undo. */
  | { type: "inboxUndo"; token: string | null; action: string; changed: number }
  | { type: "error"; message: string; itemId?: string }
  | { type: "notice"; message: string; itemId?: string };

// --- the Agents tab: one card per agent, and one agent in full ---------------------------------
//
// DERIVED FIELDS TRAVEL WITH THE ROW, exactly as they do on `ThreadView` and for the same reason.
// Health is a function of the validator's verdict on the live version and a rolling error rate off
// `runs`; drift is a function of what a deploy recorded against what the agent has now; a missing
// credential is `required_env` against `secret_refs.configured`. None of those is visible to a
// browser, so a client that derived its own would be guessing from less — and forty cards each
// guessing differently is the grid disagreeing with itself.
//
// WHAT IS DELIBERATELY NOT HERE: a secret value, a fragment of one, or its length. §5.2 and §5.5 are
// both explicit — names only — and the cheapest way to keep that true across a broadcast, a
// clipboard and a log sink is for the value never to enter the shape.

/** How busy an agent has been over seven days, bucketed. See `agentHealth.activityOf`. */
export type AgentActivityLevel = "quiet" | "steady" | "high";

/** One recent run, as §5.5's clickable sparkline draws it. Oldest first. */
export interface AgentRunBar {
  run_id: string;
  outcome: "ok" | "error" | "running" | "paused";
  started_at: string;
  /**
   * The step the failure happened at, for §5.5's "a failed bar opens on the failing step".
   *
   * REUSED RATHER THAN RE-DERIVED. The mapping from a step to its place in a trace already exists
   * and was built deliberately rather than by name matching; this carries the step's id so the click
   * lands on it, and nothing here re-implements the mapping.
   */
  failed_step_id: string | null;
}

/**
 * One agent, as the grid renders a card (§5).
 *
 * `agent_id` IS THE SLUG. Every other thing the client holds calls the slug "the agent id" —
 * `listAgents` maps it that way, the sidebar selects by it, run rows carry it — so sending the uuid
 * under that name would make this the one place an agent id means something else. The uuid rides
 * alongside as `uuid`, because the version, thread and credential reads are keyed by it.
 */
export interface AgentCardView {
  agent_id: string;
  uuid: string;
  name: string;
  slug: string;
  description: string | null;

  created_at: string;
  /** The user id, for §4's Team-only `created_by` filter and §5.2's creator avatar. */
  created_by: string | null;
  /** Null means live. §4: archived agents are hidden unless the Archived filter is on. */
  archived_at: string | null;
  hand_written: boolean;
  /**
   * The SLUG of the agent this one was copied from, or null (migration 049).
   *
   * What §5.4's `Forked` tag renders. It was absent from this shape while `agentTags` already read
   * it, which made that tag unreachable code claiming to be a feature — the worst kind of gap,
   * because nothing about the screen looks wrong.
   */
  forked_from: string | null;

  current_version: number;
  /** What made the live version. Null when nothing has been published — see `agentHealth`. */
  version_source: "generation" | "edit" | "import" | "deploy" | null;
  /** Null renders as unknown and never as `$0` — v0.1.9's rule, and §6 restates it. */
  creation_cost: number | null;

  connectors: string[];
  mcp_tools: string[];
  required_env: string[];
  /** NAMES ONLY. §5.2's amber warning line is `missing_env.length` credentials missing. */
  missing_env: string[];
  /** Granted MCP tools whose impact classification asks for a confirmation before the first call. */
  high_impact_tools: number;
  default_provider: string;

  /** Live sessions on this agent. Archived ones excluded — see `ThreadStore.agentThreadFacts`. */
  thread_count: number;
  /** §5.2's current-work line. Null is "Not started yet", and nothing is fabricated. */
  latest_thread: {
    id: string;
    title: string;
    last_activity_at: string;
    /** The user's last turn in it, or null for a session nobody has spoken in. */
    last_turn: string | null;
  } | null;

  /** §5.4's Runtime family, already resolved to one member. */
  runtime: "idle" | "running" | "generating" | "deploying" | "paused";
  /** §5.4's Health family, likewise. Runtime and Health never collapse into one tag. */
  health: "healthy" | "degraded" | "failing" | "unverified";
  activity: AgentActivityLevel;

  /** The grid's default sort key. Null for an agent that has never run. */
  last_run_at: string | null;
  runs_7d: number;
  errors_7d: number;
  /** The last ~20 outcomes, oldest first. §5.5's sparkline, and what `health` was derived from. */
  outcomes: AgentRunBar[];
  /** The most recent failure's message, for the card and for §5.5's copy-context block. */
  last_error: string | null;

  /**
   * What this agent's runs cost over seven days, or null when nothing has been spent.
   *
   * THREE STATES, NOT TWO, exactly as `ThreadView.cost_usd` has: null is "nothing yet",
   * `spend_known: false` beside a figure is "this is a floor because something ran on an unpriced
   * model", and a figure with `spend_known: true` is the answer. §5.4's `Cost unknown` tag is the
   * middle case, and a zero would claim the third about the first.
   */
  spend_7d: number | null;
  spend_known: boolean;

  deployment: { id: string; status: string; url: string | null; version: number | null } | null;
  /** §5.2's `v5 → v9`. Null when there is nothing to say — see `agentHealth.driftOf`. */
  drift: { deployed: number; current: number } | null;
}

/** What `listAgentGrid` answers with. */
export interface AgentGridSnapshot {
  cards: AgentCardView[];
  /**
   * Whether this workspace has a members list at all.
   *
   * §4's `created_by` filter and §5.2's creator avatar are Team-only, and the honest place to decide
   * that is here rather than in the browser: a personal workspace has one member, so the filter is a
   * control with one option and the avatar is a picture of the only person who could have made it.
   */
  team: boolean;
}

/** A version, as §6's history list renders it. The manifest itself stays on the server. */
export interface AgentVersionView {
  version: number;
  source: "generation" | "edit" | "import" | "deploy";
  instruction: string | null;
  summary: string | null;
  file_stats: { path: string; status: string; additions: number; deletions: number }[];
  total_bytes: number;
  undone_at: string | null;
  created_at: string;
  created_by: string | null;
  /** True for the version `agents.current_version` points at. */
  current: boolean;
}

/** One file of one version, as §6's browser renders it. */
export interface AgentFileView {
  path: string;
  content: string;
  bytes: number;
  read_only: boolean;
  /** Why it cannot be edited, in the words the block list gives. Null when it can be. */
  read_only_reason: string | null;
  /** §6's per-file blame: the version this path last changed in. Null when nothing recorded one. */
  last_changed_in: number | null;
}

/** One granted MCP tool, as §6's Capabilities tab shows it. */
export interface AgentToolView {
  /** `server/tool`, the ref the manifest holds. */
  ref: string;
  server: string;
  tool: string;
  /** low | high, or null for a tool whose server this workspace no longer has. */
  impact: string | null;
  /** The stored reason the classification carries. Never invented here. */
  reason: string | null;
}

/** One agent, in full (§6). Everything the five tabs need that the card does not already carry. */
export interface AgentDetailView {
  card: AgentCardView;
  versions: AgentVersionView[];
  tools: AgentToolView[];
  /** `required_env` against `secret_refs`, by name, with whether a value has landed. Names only. */
  credentials: { name: string; configured: boolean; scope: string | null }[];
  /** Latency over the same window `outcomes` covers. Null rather than zero — see `percentiles`. */
  p50_ms: number | null;
  p95_ms: number | null;
  /** Cost per run over the two windows §6's Health tab asks for. Null is unknown, never zero. */
  cost_per_run_7d: number | null;
  cost_per_run_30d: number | null;
  /** Datasets belonging to this agent and its last eval, for tab 4. */
  evals: {
    datasets: { id: string; name: string; example_count: number }[];
    last: { id: string; status: string; started_at: string; winner: string | null } | null;
  };
  /** Threads on this agent and its recent runs, for tab 5 — the one link back to the conversation. */
  threads: { id: string; title: string; status: string; last_activity_at: string; archived: boolean }[];
  runs: { id: string; status: string; started_at: string; provider: string; model: string }[];
}

export type AgentEvent =
  /**
   * The whole grid for one workspace.
   *
   * A FULL SNAPSHOT ON EVERY MUTATION, the same discipline every other channel here follows. There
   * is deliberately no per-agent update message: a client that merged one would be holding a list
   * whose tags were derived at two different moments, and §5.4's precedence rules are computed
   * against the row as a whole.
   */
  | { type: "grid"; cards: AgentCardView[]; team: boolean }
  /** One agent, for the client that asked to open it. Answered to that socket only. */
  | { type: "detail"; detail: AgentDetailView }
  /** One version's files, for the browser and for Export. */
  | { type: "version"; agentId: string; version: number; files: AgentFileView[] }
  | { type: "error"; message: string; agentId?: string }
  | { type: "notice"; message: string; agentId?: string };

/**
 * What a socket is told when nothing answers `listAgentGrid`.
 *
 * An empty grid rather than no message at all, for the reason `EMPTY_THREADS` exists: §4's two empty
 * states are both rendered surfaces, and a client that received nothing could not tell "no agents"
 * from "not answered yet" — which is a skeleton card versus a prompt to describe one.
 */
const EMPTY_GRID: AgentGridSnapshot = { cards: [], team: false };

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
  run: "log", loadRun: "log", loadHistory: "log", listAgents: "log", loadAgentFiles: "log",
  loadAgentGraph: "log",
  // The three lifecycle commands answer on `log` for the same reason `listAgents` does, and it is
  // the same decision rather than the same oversight: their success IS the refreshed agent snapshot,
  // which every client already applies, and the `agents` channel has no error shape a store would
  // recognise. A refusal ("that name is too long", "no such agent") lands in the status bar, which is
  // where every other refusal about the agent list already lands.
  // THE AGENT LIFECYCLE MOVES OFF `log` AND ONTO `agents`, which is where its answer already went.
  // Each of these is answered by a re-broadcast agent snapshot, so a REFUSAL that landed in the
  // status bar left the surface that asked — the sidebar row, and now the Agents grid — waiting on
  // an answer that had already come and gone somewhere else. The channel has an error shape for
  // exactly this, the same reason the thread and github commands are classified here.
  archiveAgent: "agents", restoreAgent: "agents", renameAgent: "agents",
  forkAgent: "agents", restoreAgentVersion: "agents",
  // §4 and §6's three reads. On `agents` beside `listAgents` rather than on a channel of their own
  // — see ListAgentGridCommand for why this is not a new channel.
  listAgentGrid: "agents", loadAgentDetail: "agents", loadAgentVersion: "agents",

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
  loadUsage: "billing", setSpendCeiling: "billing",
  listMembers: "members", inviteMember: "members", revokeInvite: "members",
  setMemberRole: "members", removeMember: "members",
  listAudit: "audit",
  loadEnforcement: "enforcement", appealEnforcement: "enforcement",
  // All six on `threads`, the reads included. The channel HAS an error shape, so unlike
  // `loadAgentFiles` there is nowhere better for a refusal to go — and a refusal about a rename
  // that landed in the status bar instead of the list would leave the row it was about still
  // showing the old name with nothing saying why.
  listThreads: "threads", loadThread: "threads", createThread: "threads",
  renameThread: "threads", archiveThread: "threads", restoreThread: "threads",
  // All six on `inbox`, the read included, for the reason the thread commands are all on `threads`:
  // the channel HAS an error shape, so a refusal about a snooze that landed in the status bar would
  // leave the card it was about still sitting there with nothing saying why.
  listInbox: "inbox", resolveInboxItem: "inbox", dismissInboxItem: "inbox",
  snoozeInboxItem: "inbox", undoInboxAction: "inbox", bulkInboxAction: "inbox",
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
  // The addendum's three. All on `github`, because all three are read or acted on in that panel —
  // and a command whose channel is missing here answers on `log` by default, which puts its
  // refusals in the status bar instead of the surface that asked for them.
  diagnoseFile: "github", shadowRunGithub: "github", listShadowRuns: "github",
  semanticDiffGithub: "github", resolveReviewComment: "github",
  // §B.1.2's opt-in. On `github` because what it configures happens on a pull request.
  setAgentCiConfig: "github", listScanFindings: "github",
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
  /**
   * The workspace's threads, with §3.3's derived status and §4.4's counts.
   *
   * Answered locally, like `listAgents` and `listMcpServers`, because it is rows this process can
   * already reach and no third party is involved. Forwarding it would put a read that the sidebar
   * badge needs on frame one behind the app's dispatch chain for no benefit.
   */
  listThreads?: (ctx: TenantContext) => ThreadSnapshot | Promise<ThreadSnapshot>;
  /**
   * One person's board (§4), with the counts §5.1 and §5.2 are drawn from.
   *
   * ANSWERED LOCALLY, like `listThreads` and `listAgentGrid` beside it, because it is rows this
   * process can already reach. The sidebar badge needs it on frame one; putting it behind the app's
   * dispatch chain would buy nothing and cost a round trip on the read that decides whether somebody
   * even opens the tab.
   *
   * TAKES THE ASKING SOCKET'S CONTEXT, AND THE PERSON IS IN IT. `ctx.actorUserId` is who this board
   * is for — two people in one workspace get two different boards, because two of the three verbs
   * are personal. That is why this cannot be memoised per workspace the way the agent grid is.
   */
  listInbox?: (ctx: TenantContext) => InboxSnapshotPayload | Promise<InboxSnapshotPayload>;
  /**
   * One thread, for the client that asked to open it (§4.5).
   *
   * Returns undefined for an id that is not this workspace's, which is what the scoped read
   * produces for another tenant's thread — the refusal and the "no such thread" are deliberately
   * the same answer, so a client learns nothing about what exists elsewhere.
   */
  loadThread?: (
    ctx: TenantContext,
    threadId: string,
  ) => Promise<{ thread: ThreadView; items: ThreadItemView[] } | undefined>;
  /**
   * The Agents grid (§4), with every card's tags already derived.
   *
   * Answered locally, like `listAgents` and `listThreads` beside it, because it is rows this process
   * can already reach. Forwarding a read the grid needs on frame one behind the app's dispatch chain
   * would buy nothing.
   */
  listAgentGrid?: (ctx: TenantContext) => AgentGridSnapshot | Promise<AgentGridSnapshot>;
  /**
   * One agent in full (§6), for the client that clicked its card.
   *
   * Returns undefined for an id that is not this workspace's, which is what a scoped read produces
   * for another tenant's agent. §7.3: an id belonging to another workspace reads as ABSENT, not as
   * forbidden — the refusal and the "no such agent" are deliberately the same answer.
   */
  loadAgentDetail?: (ctx: TenantContext, agentId: string) => Promise<AgentDetailView | undefined>;
  /** One version's files (§6's browser, and the overflow menu's Export). Scoped the same way. */
  loadAgentVersion?: (
    ctx: TenantContext,
    agentId: string,
    version: number | undefined,
  ) => Promise<{ version: number; files: AgentFileView[] } | undefined>;
  /**
   * Who is in this workspace, for the initial snapshot.
   *
   * `undefined` MEANS "DO NOT SEND IT", which is how a personal workspace answers: there is one
   * member, §4.3's author column does not exist there, and a list nothing renders is a payload on
   * every connection for nothing. The membership commands still answer it on request either way.
   *
   * `member:read` is a MEMBER capability, so every socket that reaches this point is entitled to
   * what it returns — the invite LINK, which is the one credential this channel ever carries, goes
   * through `sendMembers` to the socket that asked and never through here.
   */
  listMembers?: (
    ctx: TenantContext,
  ) => Promise<{ members: unknown[]; invites: unknown[] } | undefined>;
  /** Every deployment, plus whether a Railway token is configured. Names only. */
  listDeployments?: (ctx: TenantContext) =>
    | { deployments: unknown[]; railwayConfigured: boolean }
    | Promise<{ deployments: unknown[]; railwayConfigured: boolean }>;
  /** Session 5: fired after every broadcastTo, so a caller can fan it out to other gateway
   *  replicas over Redis — see queue/eventBridge.ts. Absent means single-replica, no bridge,
   *  exactly today's behaviour. */
  onBroadcast?: (ctx: TenantContext, payload: unknown) => void;
  /**
   * Somebody opened a trace. The Inbox's `unreviewed_failures` resolve condition, as an event.
   *
   * A CALLBACK RATHER THAN A CALL, because this file deliberately knows nothing about the Inbox —
   * the same posture `revalidate` takes towards memberships and tokens. It reports what happened
   * and acts on nothing.
   *
   * IT IS HERE AND NOT AT ONE OF THE PLACES A TRACE IS OPENED FROM, which is the whole point.
   * `loadRun` is the one path into a trace whether somebody arrived from the sidebar's run list,
   * the Agents tab's health sparkline, the command palette or a deep link — so a card resolving
   * when the trace is read is structural rather than four call sites that have to be remembered.
   *
   * Fired after the answer is sent, and never allowed to affect it: a client asking for steps must
   * get them whatever happens to a card.
   */
  onTraceOpened?: (ctx: TenantContext, runId: string) => void;
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
        this.sendTo(ws, { channel: "history", ...(await this.historyWindow(ctx)) });
        this.sendTo(ws, { channel: "agents", agents: (await this.opts.listAgents?.(ctx)) ?? [] });
        this.sendTo(ws, { channel: "mcp", type: "servers", servers: (await this.opts.listMcpServers?.(ctx)) ?? [] });
        // Which providers are connected, so a first-run client knows on frame one whether it
        // is looking at a configured install or an empty one.
        this.sendTo(ws, {
          channel: "providers",
          type: "providers",
          ...((await this.opts.listProviders?.(ctx)) ?? { providers: [], ownKeyForPlatform: false, models: [] }),
        });
        // And what is deployed, so the sidebar's Deployed filter is right on frame one rather
        // than after a round trip.
        const deploySnapshot = (await this.opts.listDeployments?.(ctx)) ?? {
          deployments: [],
          railwayConfigured: false,
        };
        this.sendTo(ws, { channel: "deploy", type: "deployments", ...deploySnapshot });
        // And what is waiting on somebody, so the sidebar's Threads badge (§2.1) is right on frame
        // one rather than after a round trip. The badge's whole claim is that you never open the
        // tab just to check; a client that had to ask first would render no badge for as long as
        // that took, which is the moment a person decides there is nothing to look at.
        this.sendTo(ws, {
          channel: "threads",
          type: "threads",
          ...((await this.opts.listThreads?.(ctx)) ?? EMPTY_THREADS),
        });
        // AND WHAT IS WAITING ON THIS PERSON, so §5.2's sidebar badge is right on frame one. The
        // badge's whole claim is that nobody has to open the tab to find out whether anything is
        // blocked; a client that had to ask first renders no badge for as long as that takes, which
        // is the moment somebody decides there is nothing to look at. Exactly the argument the
        // Threads badge above it makes.
        this.sendTo(ws, {
          channel: "inbox",
          type: "inbox",
          ...((await this.opts.listInbox?.(ctx)) ?? EMPTY_INBOX_PAYLOAD),
        });
        // And WHO IS IN THE WORKSPACE, for the same reason and only where it means something.
        //
        // §4.3's author column exists so a Team workspace can tell whose session a row is, and it
        // resolves a name out of this list — which nothing ever asked for. `sendListMembers` was
        // exported and never called, `setMembers` had one caller (a broadcast that only fires after
        // somebody MUTATES membership), and the list was therefore empty for the whole life of a
        // tab. Teammates' rows rendered no author at all, which is precisely the case the column
        // was built for.
        //
        // Here rather than in the client, matching the badge's argument directly above: a column
        // that appears one round trip late is a column somebody has already decided is empty.
        // Undefined for a personal workspace, where the caller declines to answer because the
        // column does not exist there — see the option's own doc.
        const members = await this.opts.listMembers?.(ctx);
        if (members) this.sendTo(ws, { channel: "members", type: "members", ...members });
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
          } else if (msg.cmd === "listThreads") {
            void this.answer(ws, async (ctx) => ({
              channel: "threads",
              type: "threads",
              ...((await this.opts.listThreads?.(ctx)) ?? EMPTY_THREADS),
            }), live);
          } else if (msg.cmd === "loadThread" && typeof msg.threadId === "string") {
            // To the asking socket only. Opening a thread is one client's navigation, and
            // broadcasting it would move everybody else's centre pane.
            const threadId = msg.threadId;
            void this.answer(ws, async (ctx) => {
              const loaded = await this.opts.loadThread?.(ctx, threadId);
              return loaded
                ? { channel: "threads", type: "thread", reason: "loaded", thread: loaded.thread, items: loaded.items }
                : {
                    channel: "threads",
                    type: "error",
                    threadId,
                    // The same sentence for "gone" and "not yours", on purpose — see `loadThread`.
                    message: "no such thread in this workspace",
                  };
            }, live);
          } else if (msg.cmd === "listInbox") {
            void this.answer(ws, async (ctx) => ({
              channel: "inbox",
              type: "inbox",
              ...((await this.opts.listInbox?.(ctx)) ?? EMPTY_INBOX_PAYLOAD),
            }), live);
          } else if (INBOX_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the store and the undo ledger and can answer with
            // a precise error on the "inbox" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as InboxCommand, ctx));
          } else if (THREAD_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the thread store and can answer with a precise
            // error on the "threads" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as ThreadCommand, ctx));
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
                ...((await this.opts.listProviders?.(ctx)) ?? { providers: [], ownKeyForPlatform: false, models: [] }),
              }));
          } else if (DEPLOY_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the deploy manager and can answer with a
            // precise error on the "deploy" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as DeployChannelCommand, ctx));
          } else if (BILLING_COMMANDS.has(msg.cmd)) {
            // Forwarded like a mutation even though it is a read — see BILLING_COMMANDS.
            void withContext((ctx) => this.onCommand?.(msg as BillingCommand, ctx));
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
          } else if (ENFORCEMENT_COMMANDS.has(msg.cmd)) {
            // Forwarded, like the audit read below it and for the same reason: the relay holds no
            // enforcement repository, and the ladder's own state lives with the gate that applies it.
            void withContext((ctx) => this.onCommand?.(msg as EnforcementCommand, ctx));
          } else if (AUDIT_COMMANDS.has(msg.cmd)) {
            // Forwarded rather than answered locally, for the reason BILLING_COMMANDS is: the relay
            // holds no identity repository and should not grow one. Shape-checked in the app.
            void withContext((ctx) => this.onCommand?.(msg as ListAuditCommand, ctx));
          } else if (MEMBER_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the identity repository and can answer with
            // a precise error on the "members" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as MemberCommand, ctx));
          } else if (EVAL_COMMANDS.has(msg.cmd)) {
            // Shape-checked in the app, which owns the eval store and can answer with a
            // precise error on the "eval" channel rather than dropping the message here.
            void withContext((ctx) => this.onCommand?.(msg as EvalCommand, ctx));
          } else if (AGENT_COMMANDS.has(msg.cmd)) {
            // Forwarded, not answered here: the relay holds no agent repository and the answer is a
            // re-broadcast agent snapshot, which the app owns.
            void withContext((ctx) => this.onCommand?.(msg as AgentCommand, ctx));
          } else if (msg.cmd === "listAgents") {
            void this.answer(ws, async (ctx) => ({
              channel: "agents",
              agents: (await this.opts.listAgents?.(ctx)) ?? [],
            }), live);
          } else if (msg.cmd === "listAgentGrid") {
            void this.answer(ws, async (ctx) => ({
              channel: "agents",
              type: "grid",
              ...((await this.opts.listAgentGrid?.(ctx)) ?? EMPTY_GRID),
            }), live);
          } else if (msg.cmd === "loadAgentDetail" && typeof msg.agentId === "string") {
            // To the asking socket only. Opening a card is one client's navigation, and
            // broadcasting it would move everybody else's centre pane — the same reason
            // `loadThread` is answered this way.
            const agentId = msg.agentId;
            void this.answer(ws, async (ctx) => {
              const detail = await this.opts.loadAgentDetail?.(ctx, agentId);
              return detail
                ? { channel: "agents", type: "detail", detail }
                : {
                    channel: "agents",
                    type: "error",
                    agentId,
                    // §7.3: the same sentence for "gone" and "not yours", so a caller learns
                    // nothing about what exists in another workspace.
                    message: "no such agent in this workspace",
                  };
            }, live);
          } else if (msg.cmd === "loadAgentVersion" && typeof msg.agentId === "string") {
            const agentId = msg.agentId;
            const asked = typeof msg.version === "number" && Number.isFinite(msg.version)
              ? Math.floor(msg.version)
              : undefined;
            void this.answer(ws, async (ctx) => {
              const loaded = await this.opts.loadAgentVersion?.(ctx, agentId, asked);
              return loaded
                ? { channel: "agents", type: "version", agentId, version: loaded.version, files: loaded.files }
                : { channel: "agents", type: "error", agentId, message: "no such agent version in this workspace" };
            }, live);
          } else if (msg.cmd === "loadHistory") {
            // ANSWERED LOCALLY, like the other reads the relay can serve from the store it already
            // holds, and to the ASKING SOCKET only: one person scrolling back through their own
            // history is not a reason to push five hundred run rows at every other tab.
            const asked = typeof msg.limit === "number" && Number.isFinite(msg.limit) ? Math.floor(msg.limit) : 50;
            const limit = Math.max(1, Math.min(asked, HISTORY_WINDOW_MAX));
            // Fewer rows than the window asked for is the only reliable "there is nothing further
            // back" — a count would be a second query, and an equal count is genuinely ambiguous,
            // which is why the control asks again rather than guessing.
            void this.answer(ws, async (ctx) => ({
              channel: "history",
              ...(await this.historyWindow(ctx, limit)),
            }), live);
          } else if (msg.cmd === "loadRun" && typeof msg.runId === "string") {
            // Answer only the requesting client with that run's steps (ordered by seq).
            const runId = msg.runId;
            // The read that used to be the hole: `loadRun` took an id from the client and
            // answered with that run's steps, with nothing checking whose run it was. Scoped
            // now, so an id belonging to another workspace resolves to an empty list.
            void this.answer(ws, async (ctx) => {
              const steps = await this.store.stepsForRun(ctx, runId);
              // AFTER THE READ AND OUTSIDE ITS RESULT. An empty list is still an opened trace as
              // far as the client is concerned, but it is also what another workspace's run id
              // answers with — so the notice is only sent for a run this workspace really has.
              if (steps.length > 0) this.opts.onTraceOpened?.(ctx, runId);
              return { channel: "runSteps", runId, steps };
            }, live);
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

  /**
   * Broadcast a generation event. Separate channel from "trace" by design.
   *
   * `threadId` RIDES THE ENVELOPE RATHER THAN EACH MEMBER, because it answers the same question for
   * all of them — which session this belongs to — and putting it on ten event shapes would be ten
   * places to forget it. Every client in the workspace receives these, and without it none of them
   * can file the turns under the right thread: the sender knows which thread it asked from, the
   * other tabs do not, and a conversation only the originating tab could place is not a shared one.
   *
   * Omitted for a refusal answered to whoever asked — that belongs to no session.
   */
  broadcastGen(ctx: TenantContext, event: GenEvent, threadId?: string | null): void {
    this.broadcastTo(ctx, { channel: "gen", ...event, ...(threadId ? { threadId } : {}) });
  }

  // Broadcast an edit-flow event. Separate channel from "trace" and "gen" by design.
  // `threadId` as above: which session the diff and its instruction belong to.
  broadcastEdit(ctx: TenantContext, event: EditEvent, threadId?: string | null): void {
    this.broadcastTo(ctx, { channel: "edit", ...event, ...(threadId ? { threadId } : {}) });
  }

  // Broadcast a debug-depth control event (pause/resume/boundary/branched). Separate channel by
  // design — the run's steps still arrive as normal schema-v1 events on "trace".
  broadcastDebug(ctx: TenantContext, event: DebugEvent): void {
    this.broadcastTo(ctx, { channel: "debug", ...event });
  }

  // Broadcast an "explain" reply event (unified composer). Separate channel by design — it never
  // enters the trace store or the frozen event schema.
  // `threadId` as on broadcastGen: an explanation is a turn in a session like any other.
  broadcastReply(ctx: TenantContext, event: ReplyEvent, threadId?: string | null): void {
    this.broadcastTo(ctx, { channel: "reply", ...event, ...(threadId ? { threadId } : {}) });
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
   * Broadcast the thread list. Separate channel by design — see ThreadEvent.
   *
   * TO THE WHOLE WORKSPACE, not to the socket that asked, and that is §6's collaboration rule in
   * one line: a Team workspace is fully collaborative, so a thread somebody else archived has to
   * leave everybody's list rather than only theirs. The badge and the chips are drawn from the
   * counts in this payload, so a client that missed it would sit showing a number that is no
   * longer true.
   */
  broadcastThreads(ctx: TenantContext, event: ThreadEvent): void {
    this.broadcastTo(ctx, { channel: "threads", ...event });
  }

  /**
   * The board, to every socket in the workspace — REBUILT PER RECIPIENT.
   *
   * `perClient` RATHER THAN `broadcastTo`, and here the reason is stronger than it is anywhere else
   * on this relay. Every other channel's payload is a fact about a workspace, so one build fanned out
   * is merely a cross-tenant risk; this payload is a fact about a PERSON, so one build fanned out
   * would put Ada's dismissals and Ada's snoozes on Bob's screen inside the same workspace. There is
   * no payload here that is correct for two people.
   *
   * MEMOISED PER (WORKSPACE, USER) rather than per workspace, for exactly that reason — two tabs
   * belonging to one person are entitled to the identical board and should not pay for it twice, and
   * two people are not. The memo lives for the length of this call and is thrown away; a cache that
   * outlived it would be the thing full-snapshot channels exist to avoid.
   */
  async broadcastInbox(): Promise<void> {
    const byViewer = new Map<string, Promise<InboxSnapshotPayload>>();
    await this.perClient(async (ws, ctx) => {
      const key = `${ctx.workspaceId}:${ctx.actorUserId ?? ""}`;
      let building = byViewer.get(key);
      if (!building) {
        building = Promise.resolve(this.opts.listInbox?.(ctx) ?? EMPTY_INBOX_PAYLOAD);
        byViewer.set(key, building);
      }
      this.sendTo(ws, { channel: "inbox", type: "inbox", ...(await building) });
    });
  }

  /**
   * One card's change, to the workspace it belongs to. §5.6's live resolution.
   *
   * SAFE TO BROADCAST AS ONE PAYLOAD, unlike a snapshot, because a delta only ever carries a fact
   * that is the same for everybody: an item resolved, an item's count moved, an item that has just
   * come into existence. A dismissal has no delta on purpose — see `InboxEvent`.
   */
  broadcastInboxDelta(ctx: TenantContext, event: InboxEvent): void {
    this.broadcastTo(ctx, { channel: "inbox", ...event });
  }

  /**
   * Answer ONE client about the Inbox — the socket whose command this is.
   *
   * Same mechanism as `sendThreads`, and the undo token is why it has to exist: the toast belongs to
   * the person who pressed the thing, and broadcasting a token would hand every teammate the ability
   * to take back somebody else's action. A REFUSAL is one person's click too — a snooze somebody's
   * client sent for an item that had already resolved must not paint a red strip across every board
   * in the workspace.
   */
  sendInbox(ctx: TenantContext, requestId: string, event: InboxEvent): void {
    for (const [ws, session] of this.sessions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (session.context.workspaceId !== ctx.workspaceId) continue;
      if (session.context.requestId !== requestId) continue;
      this.sendTo(ws, { channel: "inbox", ...event });
    }
  }

  /**
   * Answer ONE client about a thread — the socket whose request this is.
   *
   * Same mechanism as `sendMembers` and for a related reason: opening a thread (§4.5) is a fact
   * about one client's navigation. Broadcasting it would collapse every other tab in the workspace
   * out of its full-screen view and into somebody else's conversation.
   */
  sendThreads(ctx: TenantContext, requestId: string, event: ThreadEvent): void {
    for (const [ws, session] of this.sessions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (session.context.workspaceId !== ctx.workspaceId) continue;
      if (session.context.requestId !== requestId) continue;
      this.sendTo(ws, { channel: "threads", ...event });
    }
  }

  /**
   * Answer ONE client about an agent — the socket whose command this is.
   *
   * Same mechanism as `sendThreads`, and for both the same reasons. A REFUSAL is about one person's
   * click: a rename somebody mistyped must not paint a red strip across every teammate's grid, which
   * is the failure `refuseThread` exists to have already fixed once. And opening a card (§6) is one
   * client's navigation — broadcasting the detail would collapse every other tab in the workspace
   * out of whatever it was showing and into somebody else's agent.
   */
  sendAgents(ctx: TenantContext, requestId: string, event: AgentEvent): void {
    for (const [ws, session] of this.sessions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (session.context.workspaceId !== ctx.workspaceId) continue;
      if (session.context.requestId !== requestId) continue;
      this.sendTo(ws, { channel: "agents", ...event });
    }
  }

  /**
   * Answer ONE client on the MCP channel — the socket whose command this is.
   *
   * The same shape as `sendThreads` and `sendMembers`, for the refusal that most obviously needed
   * it: "that confirmation is no longer waiting" is about one person's second click on a modal, and
   * it went to every socket in the workspace. One member double-clicking Allow — or holding Escape,
   * which repeats — put that sentence in front of every teammate, about a dialog they may never
   * have seen.
   */
  sendMcpTo(ctx: TenantContext, requestId: string, event: McpEvent): void {
    for (const [ws, session] of this.sessions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (session.context.workspaceId !== ctx.workspaceId) continue;
      if (session.context.requestId !== requestId) continue;
      this.sendTo(ws, { channel: "mcp", ...event });
    }
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
   * Broadcast the workspace's standing: which rung is in force, and what it has said about it.
   *
   * BROADCAST rather than answered to the asker, unlike the audit log beside it, and the difference
   * is what the payload is about. A rung applies to the WORKSPACE — every member's work is refused
   * by it — so one member appealing is something every open tab should see, exactly as a plan change
   * is. The rows carry no third party's identity: the reason, the rung, and the note the workspace
   * itself wrote.
   */
  broadcastEnforcement(ctx: TenantContext, event: EnforcementEvent): void {
    this.broadcastTo(ctx, { channel: "enforcement", ...event });
  }

  /**
   * Send the audit log to ONE socket — the one that asked for it.
   *
   * Never broadcast, and this is the strongest case for that of any channel here: the rows name who
   * revealed which credential, who overrode a secret-scan refusal, and who removed whom. One
   * person opening a log is not a reason to put that in front of every other tab. It is also a pure
   * read — nothing changes, so there is nothing for anybody else to be kept in step with.
   */
  sendAudit(ctx: TenantContext, requestId: string, event: AuditEvent): void {
    for (const [ws, session] of this.sessions) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (session.context.workspaceId !== ctx.workspaceId) continue;
      if (session.context.requestId !== requestId) continue;
      this.sendTo(ws, { channel: "audit", ...event });
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
  /**
   * One window on the run history, with whether there is anything behind it.
   *
   * SHARED BY THE CONNECT SNAPSHOT AND EVERY REFRESH, so the "load older runs" control is honest
   * from frame one rather than only after somebody has already pressed it once. `complete` is
   * computed the one way that needs no second query: a window that came back short is the end.
   */
  private async historyWindow(
    ctx: TenantContext,
    limit = 50,
  ): Promise<{ runs: unknown[]; complete: boolean; window: number }> {
    const runs = await this.store.listRuns(ctx, limit);
    return { runs, complete: runs.length < limit, window: limit };
  }

  async broadcastHistory(): Promise<void> {
    await this.perClient(async (ws, ctx) => {
      this.sendTo(ws, { channel: "history", ...(await this.historyWindow(ctx)) });
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

  /**
   * The Agents grid, to every socket in every workspace that has one — rebuilt per recipient.
   *
   * `perClient` RATHER THAN `broadcastTo`, like `broadcastAgents` above it and for the same reason:
   * the payload is a workspace's own derived rows, so there is no one payload that could correctly
   * go to two workspaces. One built and fanned out is a cross-tenant read wearing a different hat,
   * which is precisely what `test:channels` enumerates this file to catch.
   *
   * A FULL SNAPSHOT ON EVERY MUTATION. §5.5's live grid re-renders the affected card only, which is
   * a rendering decision the browser makes against a list it has replaced — not a licence for the
   * server to send half a list.
   */
  async broadcastAgentGrid(): Promise<void> {
    /**
     * ONE BUILD PER WORKSPACE, NOT ONE PER SOCKET.
     *
     * `perClient` rebuilds the payload with each client's own context, which is what makes it safe —
     * and for a grid it was also making it expensive in a way nothing else on this relay is. The
     * snapshot behind this is ten statements over the whole workspace, and it fires on every
     * transition a run produces; a person with four tabs open was paying forty of them per burst,
     * for four byte-identical answers.
     *
     * THE MEMO IS PER CALL AND KEYED BY WORKSPACE, which is the only key that is safe: two sockets
     * in the same workspace are entitled to exactly the same rows, and two in different ones share
     * nothing. It lives for the length of this broadcast and is thrown away, so nothing here can go
     * stale — a cache that outlived the call would be the very thing full-snapshot channels exist to
     * avoid.
     *
     * The promise is cached rather than the value, so N sockets that arrive together await one
     * in-flight build instead of starting N.
     */
    const byWorkspace = new Map<string, Promise<AgentGridSnapshot>>();
    await this.perClient(async (ws, ctx) => {
      let building = byWorkspace.get(ctx.workspaceId);
      if (!building) {
        building = Promise.resolve(this.opts.listAgentGrid?.(ctx) ?? EMPTY_GRID);
        byWorkspace.set(ctx.workspaceId, building);
      }
      this.sendTo(ws, { channel: "agents", type: "grid", ...(await building) });
    });
  }
}

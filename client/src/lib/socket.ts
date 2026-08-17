// WebSocket client for the Jaroku relay. Mirrors the reconnect pattern of the original
// debug-client.html (1s backoff) and dispatches each server message into the trace store.
// The relay only speaks WebSocket, so this is the single channel between UI and pipeline.

import { useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useChatStore } from "../store/chatStore.ts";
import { useGraphStore } from "../store/graphStore.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { useMcpStore } from "../store/mcpStore.ts";
import { useProviderStore } from "../store/providerStore.ts";
import { useConnectionStore } from "../store/connectionStore.ts";
import { useBillingStore } from "../store/billingStore.ts";
import { useDeployStore } from "../store/deployStore.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useDiagnosticsStore } from "../store/diagnosticsStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useMemberStore } from "../store/memberStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { resetWorkspaceStores } from "../store/reset.ts";
import { INPUT_KEY_PREFIX } from "../store/uiStore.ts";
import {
  fetchSession, fetchTicket, socketUrl, storeToken, storeWorkspace, storedToken, storedWorkspace,
  type AuthFailure,
} from "./auth.ts";
import type {
  ClientCommand, EvalTarget, ExplainSubject, GithubAttachment, GithubHunkSelection,
  GithubRestackStep, McpConfirmVerdict, McpImpact, RubricCriterion, ServerMessage,
} from "../types.ts";

const RECONNECT_MS = 1000;
/** The ceiling on backoff. Long enough to be kind to a server that is down, short enough that
 *  a laptop coming out of sleep does not sit disconnected for a minute. */
const MAX_RECONNECT_MS = 15_000;
/** The server's close code for "stop, sign in again" — see wsRelay.CLOSE_UNAUTHORISED. */
const CLOSE_UNAUTHORISED = 4001;

let ws: WebSocket | null = null;
let started = false;
/** Set by an explicit stop (sign-out, workspace switch), so nothing reconnects behind it. */
let stopped = false;
/** Consecutive failed attempts. Reset by a socket that OPENS, not by one that was tried. */
let attempt = 0;

function dispatch(msg: ServerMessage): void {
  const s = useTraceStore.getState();
  switch (msg.channel) {
    case "history":
      s.applyHistory(msg.runs);
      break;
    case "trace":
      s.applyEvent(msg.event);
      break;
    case "runSteps":
      s.applyRunSteps(msg.runId, msg.steps);
      break;
    case "log":
      s.addLog({ level: msg.level, text: msg.text });
      break;
    case "agents":
      useBuildStore.getState().setAgents(msg.agents);
      break;
    case "agentFiles":
      useBuildStore.getState().setAgentFiles(msg.agentId, msg.files);
      break;
    case "graph":
      useGraphStore.getState().setGraph(msg.agentId, msg.graph);
      break;
    case "gen": {
      // Generation is routed to its own store — it never touches trace state.
      // Lifecycle events are mirrored into the conversation (chatStore); the file
      // streaming itself stays in buildStore only.
      const b = useBuildStore.getState();
      const c = useChatStore.getState();
      switch (msg.type) {
        case "started": b.startGeneration(msg.prompt); c.genStarted(msg.prompt); break;
        case "file_start": b.fileStart(msg.path); break;
        case "file_delta": b.fileDelta(msg.path, msg.text); break;
        case "file_end": b.fileEnd(msg.path); break;
        case "done": b.finish(msg.agentId, msg.usage); c.genDone(msg.agentId, msg.files, msg.usage, msg.planUsage); break;
        case "error": b.fail(msg.message, msg.problems); c.genError(msg.message, msg.problems); break;
        // The pre-generation gate. NOTE that none of these touch buildStore: a plan writes no
        // files, so the build pane has nothing to show and — crucially — nothing to mark as
        // failed. plan_error goes to the conversation, never to b.fail().
        case "plan_started": c.planStarted(msg.input, msg.revision); break;
        case "plan_delta": c.planDelta(msg.text); break;
        case "plan": c.planReady(msg); break;
        case "plan_discarded": c.planDiscarded(msg.planId); break;
        case "plan_error": c.planError(msg.message); break;
        default:
          // This switch used to drop anything it didn't know silently, so a server running
          // ahead of the client showed nothing at all rather than saying so.
          console.warn("[gen] unknown event type", (msg as { type?: string }).type);
      }
      break;
    }
    case "edit": {
      // The fix loop lives in the conversation — it never touches trace or build state
      // (the post-apply file refresh arrives separately on "agentFiles").
      const c = useChatStore.getState();
      switch (msg.type) {
        case "started": c.editStarted(msg.agentId, msg.instruction); break;
        case "file_start": c.editFileStart(msg.path); break;
        case "file_delta": c.editFileDelta(msg.path, msg.text.length); break;
        case "file_end": c.editFileEnd(msg.path); break;
        case "proposal": c.proposal(msg); break;
        case "applied": c.applied(msg.proposalId, msg.agentId, msg.version); break;
        case "undone": c.undone(msg.agentId, msg.version, msg.summary); break;
        case "discarded": c.discarded(msg.proposalId, msg.agentId); break;
        case "error": c.editError(msg); break;
      }
      break;
    }
    case "debug": {
      // Debug depth control plane: reflect pause/resume on the run's status. The run's steps
      // still arrive as normal "trace" events; "boundary" is informational (no state change).
      if (msg.type === "paused") s.setRunStatus(msg.runId, "paused");
      else if (msg.type === "resumed") s.setRunStatus(msg.runId, "running");
      else if (msg.type === "branched") {
        // The new branch run is in the refreshed history; focus it and load its (copied) prefix.
        s.selectRun(msg.branchId);
        sendLoadRun(msg.branchId);
      } else if (msg.type === "error") s.addLog({ level: "stderr", text: `debug: ${msg.message}` });
      break;
    }
    case "eval": {
      // Eval control plane. Every message is a full snapshot of what it names, so these
      // are replaces, not merges. Nothing here touches trace state — an eval's runs are
      // ordinary runs, loaded on demand through the normal loadRun path.
      const e = useEvalStore.getState();
      if (msg.type === "datasets") e.setDatasets(msg.datasets);
      else if (msg.type === "dataset") e.setExamples(msg.datasetId, msg.examples);
      else if (msg.type === "datasetDeleted") e.removeDataset(msg.datasetId);
      else if (msg.type === "promoted") e.setPromoted(msg.datasetName, msg.duplicate);
      else if (msg.type === "evalStarted") {
        e.setProgress({ evalId: msg.evalId, total: msg.total, done: 0, running: 0, queued: msg.total, failed: 0 });
        e.selectEval(msg.evalId);
      } else if (msg.type === "evalProgress") e.setProgress({ ...msg });
      else if (msg.type === "evalFinished") {
        // Runs are done; scoring may still be in flight, so the panel says so rather than
        // showing a quality column that's about to fill in.
        e.patchProgress({ status: msg.status, scoring: true });
        sendLoadEvalResults(msg.evalId);
        sendListEvals();
      } else if (msg.type === "scored") {
        // Refresh the aggregate so the quality column fills in as verdicts land.
        sendLoadEvalResults(msg.evalId);
      } else if (msg.type === "scoringFinished") {
        e.patchProgress({ scoring: false });
        sendLoadEvalResults(msg.evalId);
      } else if (msg.type === "evalResults") e.setResults(msg.evalId, msg.results);
      else if (msg.type === "evals") e.setEvals(msg.evals);
      else if (msg.type === "rubric") e.setRubric(msg.rubric, msg.isDefault);
      else if (msg.type === "estimate") e.setEstimate(msg.estimate);
      else if (msg.type === "error") e.setError(msg.message);
      break;
    }
    case "mcp": {
      // The MCP registry. Every message is a full snapshot of the server list, so this is a
      // replace and never a merge — see mcpStore. Nothing here touches trace state: an
      // agent's MCP tool call is an ordinary tool_call Step and arrives on "trace".
      const m = useMcpStore.getState();
      if (msg.type === "servers") m.setServers(msg.servers);
      else if (msg.type === "discovering") m.setDiscovering(msg.serverId, msg.endpoint);
      else if (msg.type === "error") m.setError(msg.message);
      else if (msg.type === "notice") m.setNotice(msg.message);
      else if (msg.type === "confirmRequest") m.addConfirm(msg);
      else if (msg.type === "confirmResolved") m.resolveConfirm(msg.runId, msg.nonce);
      break;
    }
    case "providers": {
      // Model-provider credentials. Like the MCP channel, every `providers` message is a full
      // snapshot and this is a replace, never a merge — and nothing on it carries a key, so
      // there is nothing here to be careful with beyond not inventing state the server owns.
      const p = useProviderStore.getState();
      if (msg.type === "providers") p.setProviders(msg.providers, msg.ownKeyForPlatform);
      else if (msg.type === "testResult") p.setTestResult({ provider: msg.provider, ok: msg.ok, message: msg.message });
      else if (msg.type === "error") p.setError(msg.message);
      else if (msg.type === "notice") p.setNotice(msg.message);
      break;
    }
    case "connections": {
      // What this workspace has authorised us to reach. A full snapshot like every channel
      // beside it, and nothing on it is a credential — see connectionStore.
      const c = useConnectionStore.getState();
      if (msg.type === "connections") c.setConnections(msg.connections);
      else if (msg.type === "authorize") {
        // THE BROWSER HAS TO GO THERE. A socket cannot redirect anything, and a consent screen is
        // a page a person reads — so the server answers with a URL and this is the navigation.
        // `assign` rather than `replace`, so Back returns to the app rather than skipping past it.
        window.location.assign(msg.url);
      } else if (msg.type === "error") c.setError(msg.message);
      else if (msg.type === "notice") c.setNotice(msg.message);
      break;
    }
    case "billing": {
      // What this workspace has spent. A full snapshot like every other channel here, and
      // nothing on it is recomputed client-side — see billingStore for why that matters more
      // here than elsewhere.
      const b = useBillingStore.getState();
      if (msg.type === "usage") b.setUsage(msg.usage);
      else if (msg.type === "error") b.setError(msg.message);
      break;
    }
    case "deploy": {
      // Deploy state. Full-snapshot discipline like `providers` and `mcp`: `deployments`
      // replaces the list rather than merging into it. The one thing here to be careful with
      // is `serveToken` — the only credential the server ever sends a client, delivered once
      // because Jaroku keeps no copy. It goes into memory for the panel to show and is never
      // persisted anywhere.
      const d = useDeployStore.getState();
      if (msg.type === "deployments") d.setDeployments(msg.deployments, msg.railwayConfigured);
      else if (msg.type === "plan") {
        d.setPlan({
          agentId: msg.agentId, secrets: msg.secrets, problems: msg.problems,
          warnings: msg.warnings, redeploy: msg.redeploy,
        });
      } else if (msg.type === "stage") d.setStage(msg.deploymentId, msg.stage);
      else if (msg.type === "log") {
        d.appendLog({
          deployment_id: msg.deploymentId, seq: msg.seq, ts: new Date().toISOString(),
          stage: msg.stage, stream: msg.stream, text: msg.text,
        });
      } else if (msg.type === "logs") d.setLogs(msg.deploymentId, msg.lines);
      else if (msg.type === "serveToken") {
        d.setServeToken({ deploymentId: msg.deploymentId, url: msg.url, token: msg.token });
      } else if (msg.type === "finished") {
        // The snapshot that follows carries the row; this only makes the outcome loud.
        if (msg.error) d.setError(msg.error);
      } else if (msg.type === "testResult") d.setTestResult({ ok: msg.ok, message: msg.message });
      else if (msg.type === "error") d.setError(msg.message);
      else if (msg.type === "notice") d.setNotice(msg.message);
      break;
    }
    case "github": {
      // Two lineages, reconciled. Full-snapshot discipline like `providers` and `deploy`: a
      // `state` message replaces rather than merges, because §1's four regions are views of ONE
      // reconciliation and a merged half would let the verdict line disagree with the version list
      // it sits above.
      //
      // Nothing on this channel is a credential — `connected` is a boolean and `accountLogin` is a
      // name GitHub prints on a public profile.
      const g = useGithubStore.getState();
      if (msg.type === "state") {
        g.applyState({
          agentId: msg.agentId,
          connected: msg.connected,
          accountLogin: msg.accountLogin,
          links: msg.links,
          view: msg.view,
        });
      } else if (msg.type === "repos") g.setRepos(msg.repos);
      else if (msg.type === "nameCheck") g.setNameCheck(msg.name, msg.available);
      else if (msg.type === "stage") g.applyStage(msg.agentId, msg.op, msg.stage, msg.status);
      else if (msg.type === "refused") {
        // Its own store field rather than the error strip. §3.6's refusal names a file, a check
        // and three actions; a one-line error could carry none of that, and calling a working
        // safety guarantee an "error" is the wrong word for what just happened.
        g.setRefusal({
          agentId: msg.agentId,
          check: msg.check,
          path: msg.path,
          message: msg.message,
          candidate: msg.candidate,
        });
      } else if (msg.type === "semanticDiff") {
        g.setSemanticDiff({
          agentId: msg.agentId,
          ref: msg.ref,
          rows: msg.rows,
          ...(msg.partial ? { partial: msg.partial } : {}),
        });
      } else if (msg.type === "shadowRuns") {
        g.setShadowRuns(msg.agentId, msg.runs);
      } else if (msg.type === "scanRefused") {
        // §B.6.1. Its own field, for the third time on this channel and the third time for the same
        // reason: the card names files and rules and offers two actions, and nothing about it is an
        // error — the branch is exactly where it was.
        g.setScanRefusal({ agentId: msg.agentId, message: msg.message, findings: msg.findings });
      } else if (msg.type === "restackRefused") {
        // §B.4.4's refusal, and its own field for the same reason the one above is: the panel puts
        // a border on the row at `position` and prints the validator's own words under it, neither
        // of which an error strip could do. Nothing was written when this arrives — the versions
        // are exactly where they were — so it is not an error either.
        g.setRestackRefusal({
          agentId: msg.agentId,
          position: msg.position,
          message: msg.message,
          problems: msg.problems,
        });
      } else if (msg.type === "diagnostics") {
        // §B.3. Its own store, not this one: these answer a question THIS tab asked about text
        // THIS tab is holding, and a `state` message from somebody else's push must not clear them.
        useDiagnosticsStore
          .getState()
          .apply(msg.agentId, msg.path, msg.nonce, msg.diagnostics);
      } else if (msg.type === "message") g.setGenerated(msg.agentId, msg.message);
      else if (msg.type === "error") g.setError(msg.message);
      else if (msg.type === "notice") g.setNotice(msg.message);
      break;
    }
    case "session": {
      // The only channel that is about the CONNECTION rather than the work. Every message on
      // it means the connection is over or about to be — see wsRelay's SessionEvent.
      const sess = useSessionStore.getState();
      if (msg.type === "expiring") sess.setExpiring(true);
      else if (msg.type === "expired") sess.signOut("your session expired");
      else if (msg.type === "revoked") sess.signOut(msg.message);
      else if (msg.type === "workspace_changed") {
        // Not a sign-out: they are still signed in, the workspace they were in is gone. Drop
        // the remembered one so the reconnect lands in a workspace they still belong to.
        storeWorkspace(null);
        sess.setStatus("connecting", msg.message);
      } else if (msg.type === "role_changed") {
        // The socket stays open at the new role. Reflect it so the UI stops offering what the
        // server would now refuse — the enforcement is the server's, this is honesty.
        const { workspaces, workspaceId } = sess;
        sess.setWorkspaces(workspaces.map((w) => (w.id === workspaceId ? { ...w, role: msg.role } : w)));
      }
      break;
    }
    case "members": {
      const m = useMemberStore.getState();
      if (msg.type === "members") m.setMembers(msg.members, msg.invites);
      else if (msg.type === "inviteLink") m.setInviteLink(msg);
      else if (msg.type === "error") m.setError(msg.message);
      else if (msg.type === "notice") m.setNotice(msg.message);
      break;
    }
    case "threads": {
      // Every message here is a FULL SNAPSHOT except `thread`, which is one row answered to this
      // client because it asked to open it. Nothing merges: see threadStore's own header.
      const t = useThreadStore.getState();
      if (msg.type === "threads") t.setThreads(msg.threads, msg.counts);
      else if (msg.type === "thread") t.setThread(msg.thread);
      else if (msg.type === "error") t.setError(msg.message);
      // A notice is not an error and must not render as one. Nothing on this channel sends one yet;
      // it is handled rather than dropped so a server running ahead of the client is visible.
      else if (msg.type === "notice") console.info("[threads]", msg.message);
      break;
    }
    case "reply": {
      // Unified composer "explain": a streaming prose answer in the conversation (chatStore).
      const c = useChatStore.getState();
      if (msg.type === "started") c.replyStarted(msg.agentId, msg.question);
      else if (msg.type === "delta") c.replyDelta(msg.agentId, msg.text);
      else if (msg.type === "done") c.replyDone(msg.agentId);
      else if (msg.type === "error") c.replyError(msg.agentId, msg.message);
      break;
    }
  }
}

/**
 * Open a socket, which is now three requests rather than one.
 *
 * A WebSocket cannot carry an `Authorization` header, so the credential is exchanged over HTTP
 * first: token → session → ticket → socket. See lib/auth.ts for why each step exists.
 *
 * THE HARD DISTINCTION THIS FUNCTION EXISTS TO MAKE. "Disconnected" and "unauthorised" arrive
 * at a WebSocket client looking exactly the same — the socket closes — and treating the second
 * as the first produces the worst possible behaviour: a client that retries a 401 every second,
 * forever, behind a spinner, while the user has no idea they need to sign in. So a refusal
 * STOPS the loop and shows the sign-in screen; everything else backs off and tries again.
 */
async function connect(): Promise<void> {
  if (stopped) return;
  const session = useSessionStore.getState();
  useTraceStore.getState().setConnection("connecting");

  const token = storedToken();
  if (!token) {
    // Never signed in, or signed out. Not an error and not worth retrying.
    session.setStatus("signed_out");
    useTraceStore.getState().setConnection("closed");
    return;
  }

  let ticket: string;
  try {
    // The session is refreshed on every connect rather than cached: it is what tells us the
    // workspace list and the token's expiry, and both can have changed while the socket was
    // down — a membership added, a role changed, a token renewed in another tab.
    const view = await fetchSession(token);
    const wanted = useSessionStore.getState().workspaceId ?? storedWorkspace();
    // A remembered workspace this account is not in — because they signed in as somebody else,
    // or were removed while away — falls back to the default rather than 403ing on every
    // attempt. Falling back is not a security decision: the server checks membership either way.
    const target = view.workspaces.some((w) => w.id === wanted) ? wanted! : view.defaultWorkspaceId;
    const issued = await fetchTicket(token, target);
    useSessionStore.getState().applySession(view, issued.workspaceId);
    storeWorkspace(issued.workspaceId);
    ticket = issued.ticket;
  } catch (err) {
    const failure = err as AuthFailure;
    if (!failure.retryable) {
      // 401 or 403. The token is bad, or this account may not be here. Stop.
      useSessionStore.getState().signOut(failure.message);
      useTraceStore.getState().setConnection("closed");
      return;
    }
    useSessionStore.getState().setStatus("connecting", failure.message);
    useTraceStore.getState().setConnection("closed");
    scheduleReconnect();
    return;
  }

  ws = new WebSocket(socketUrl(ticket));

  ws.onopen = () => {
    // A connection that stayed open is what resets the backoff, not one that was merely
    // attempted — otherwise a server refusing every socket is retried at full speed forever.
    attempt = 0;
    useTraceStore.getState().setConnection("open");
    useSessionStore.getState().setStatus("ready");
  };

  ws.onmessage = (ev) => {
    try {
      dispatch(JSON.parse(ev.data as string) as ServerMessage);
    } catch {
      /* ignore malformed server frames */
    }
  };

  ws.onclose = (ev) => {
    useTraceStore.getState().setConnection("closed");
    ws = null;
    if (stopped) return;
    if (ev.code === CLOSE_UNAUTHORISED) {
      // The server told us why on the `session` channel a moment ago, and the code is here in
      // case that frame did not land. Either way: stop, do not retry.
      const state = useSessionStore.getState();
      if (state.status !== "signed_out") state.signOut(state.message ?? "your session ended");
      return;
    }
    // CLOSE_RECONNECT and every ordinary drop take the same path: get a new ticket and try
    // again. A ticket is single-use, so a reconnect is always a fresh exchange.
    scheduleReconnect();
  };

  // On error the socket also fires close; let close drive reconnection.
  ws.onerror = () => ws?.close();
}

/**
 * Back off, so a server that is down is not hit once a second by every open tab.
 *
 * The original client retried at a flat one second, which was right when the server was a
 * subprocess on the same machine. It is not right against a hosted one: a restart brings every
 * client back simultaneously, and the flat interval keeps them synchronised. Exponential with
 * jitter, capped, and reset only by a connection that actually opened.
 */
function scheduleReconnect(): void {
  if (stopped) return;
  const backoff = Math.min(RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS);
  attempt++;
  // Jitter, or every client that dropped together comes back together.
  const delay = backoff * (0.7 + Math.random() * 0.6);
  setTimeout(() => void connect(), delay);
}

/** Start the singleton connection once (safe under React StrictMode double-invoke). */
export function startSocket(): void {
  if (started) return;
  started = true;
  stopped = false;
  void connect();
}

/**
 * Close the socket and stop reconnecting.
 *
 * For signing out and for switching workspace. A switch is a NEW socket rather than a message
 * on the current one — simpler, and impossible to get subtly wrong: the workspace a socket
 * acts in was decided by the ticket it was opened with, and there is no message that could
 * change it.
 */
export function signOut(): void {
  stopSocket();
  // The same reasoning as a workspace switch: the rows in these stores belong to a workspace,
  // and the next person to sign in at this browser must not find them.
  resetWorkspaceStores();
  forgetRememberedInputs();
  storeToken(null);
  useSessionStore.getState().signOut();
}

/**
 * Drop every remembered test input.
 *
 * The stores are memory and die with the reset above; these are localStorage and outlive not
 * just a workspace switch but the whole session, which is a longer life than the sentence
 * "the next person to sign in at this browser must not find them" allows. Keying them by
 * workspace (see uiStore.inputKey) stops one tenant READING another's; this is the other half,
 * for the browser two people share.
 *
 * A sweep by prefix rather than a list, because the keys are per agent and there is no register
 * of which ones were written.
 */
function forgetRememberedInputs(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(INPUT_KEY_PREFIX)) doomed.push(key);
    }
    // Collected first, then removed: removing during the walk reindexes it and skips keys.
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* private browsing — see lib/auth.ts storedToken */
  }
}

export function stopSocket(): void {
  stopped = true;
  started = false;
  attempt = 0;
  const open = ws;
  ws = null;
  try {
    open?.close();
  } catch {
    /* already closing */
  }
  useTraceStore.getState().setConnection("closed");
}

/** Close, then open again — in whatever workspace the session store now names. */
export function restartSocket(): void {
  stopSocket();
  startSocket();
}

/**
 * Switch workspace.
 *
 * A NEW SOCKET, not a message on the current one. Simpler, and impossible to get subtly wrong:
 * the workspace a socket acts in was decided by the ticket it was opened with, so there is no
 * message that could change it and nothing to reason about regarding reads already in flight.
 *
 * The stores are emptied BEFORE the new socket opens, and that ordering is the security part.
 * Resetting afterwards would leave a window — however short — in which the new workspace's
 * first snapshot merges into the previous one's rows, and a UI that briefly showed both is a
 * UI that showed one tenant the other's data. See store/reset.ts.
 */
export function switchWorkspace(workspaceId: string): void {
  const session = useSessionStore.getState();
  if (session.workspaceId === workspaceId) return;
  if (!session.workspaces.some((w) => w.id === workspaceId)) return;

  stopSocket();
  resetWorkspaceStores();
  storeWorkspace(workspaceId);
  useSessionStore.setState({ workspaceId, status: "connecting", message: null });
  startSocket();
}

function send(cmd: ClientCommand): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

export function sendRun(
  input?: string,
  provider?: string,
  model?: string,
  agentId?: string,
): void {
  // `model` is forwarded now — the relay and index.ts always accepted it, but this client
  // was dropping it, so a real-provider run silently used the agent's default model.
  send({ cmd: "run", input: input || undefined, provider, model, agentId });
}

export function sendLoadRun(runId: string): void {
  send({ cmd: "loadRun", runId });
}

/** Confirm a plan. `planId` is what makes the server build the plan the user approved rather
 *  than whatever the composer says now — see planner.take(). */
export function sendGenerate(
  prompt: string,
  connectors: string[],
  name?: string,
  planId?: string,
): void {
  send({ cmd: "generate", prompt, connectors, name, planId });
}

/** Ask for a plan. With `revisePlanId`, `prompt` is feedback on that plan, not a fresh brief. */
export function sendPlanAgent(
  prompt: string,
  connectors: string[],
  name?: string,
  revisePlanId?: string,
  /** Scoped MCP tools, as `"server/tool"` refs — per tool, never per server. */
  mcpTools?: string[],
): void {
  send({ cmd: "planAgent", prompt, connectors, mcpTools, name, revisePlanId });
}

export function sendDiscardPlan(planId: string): void {
  send({ cmd: "discardPlan", planId });
}

/** Ask for a fresh usage snapshot. Sent when the panel opens, never on a timer — see UsagePanel. */
/** Ask for the connections snapshot. Answered on the `connections` channel. */
export function sendListConnections(): void {
  send({ cmd: "listConnections" });
}

/**
 * Begin a consent flow. Answered with a URL this client then navigates to.
 *
 * `returnTo` is a PATH and is treated as one by the server — anything that could be absolute is
 * discarded rather than cleaned, because a callback that redirects wherever it is told is a
 * phishing primitive on our own domain.
 */
export function sendConnectConnector(connectorId: string, returnTo = "/"): void {
  send({ cmd: "connectConnector", connectorId, returnTo });
}

/** Hand the grant back and forget the credentials. */
export function sendDisconnectConnector(connectorId: string): void {
  send({ cmd: "disconnectConnector", connectorId });
}

export function sendLoadUsage(): void {
  send({ cmd: "loadUsage" });
}

export function sendListAgents(): void {
  send({ cmd: "listAgents" });
}

// --- fix loop -------------------------------------------------------------

export function sendEdit(agentId: string, instruction: string): void {
  send({ cmd: "edit", agentId, instruction });
}

export function sendApplyEdit(proposalId: string): void {
  send({ cmd: "applyEdit", proposalId });
}

export function sendUndoEdit(agentId: string): void {
  send({ cmd: "undoEdit", agentId });
}

export function sendDiscardEdit(proposalId: string): void {
  send({ cmd: "discardEdit", proposalId });
}

export function sendLoadAgentFiles(agentId: string): void {
  send({ cmd: "loadAgentFiles", agentId });
}

export function sendLoadAgentGraph(agentId: string): void {
  useGraphStore.getState().markLoading(agentId);
  send({ cmd: "loadAgentGraph", agentId });
}

// Debug depth: pause the live run at its next node boundary, or resume a paused run from its
// durable checkpoint. The server answers on the "debug" channel (status) + "trace" (new steps).
export function sendPauseRun(runId: string): void {
  send({ cmd: "pauseRun", runId });
}
export function sendResumeRun(runId: string): void {
  send({ cmd: "resumeRun", runId });
}
// Fork a new run from `fromRunId` at step `atSeq` (its node boundary), optionally applying a
// validated domain-field edit (editedState) attributed to editNode before continuing.
export function sendBranchRun(
  fromRunId: string,
  atSeq: number,
  editNode?: string,
  editedState?: Record<string, unknown>,
): void {
  send({ cmd: "branchRun", fromRunId, atSeq, editNode, editedState });
}
// Unified composer "explain": ask for a prose answer about a step / node / the agent, built from
// in-context data. Answered on the "reply" channel (chatStore), never a code change.
export function sendExplain(
  agentId: string,
  question: string,
  subject: ExplainSubject,
  /** §7's attachments. References, resolved server-side at send time — never content. */
  github?: GithubAttachment[],
): void {
  send({ cmd: "explain", agentId, question, subject, ...(github?.length ? { github } : {}) });
}

// --- MCP: server registry --------------------------------------------------
// Answered on the "mcp" channel with a fresh snapshot of the whole server list, so callers
// never optimistically patch local state.

export function sendListMcpServers(): void {
  send({ cmd: "listMcpServers" });
}
/** Connect a server. `token` is written to runtime/.env server-side and never comes back. */
export function sendAddMcpServer(endpoint: string, label?: string, token?: string): void {
  send({ cmd: "addMcpServer", endpoint, label, token });
}
export function sendRemoveMcpServer(serverId: string): void {
  send({ cmd: "removeMcpServer", serverId });
}
/** Re-run the handshake. On failure the previously discovered tools are kept. */
export function sendRediscoverMcpServer(serverId: string): void {
  send({ cmd: "rediscoverMcpServer", serverId });
}
/** Store or clear a credential. `null` removes the key from runtime/.env entirely. */
export function sendSetMcpServerAuth(serverId: string, token: string | null): void {
  send({ cmd: "setMcpServerAuth", serverId, token });
}
/**
 * Answer a pending confirmation. The run is blocked until this lands.
 *
 * "once" allows this call, "run" allows this tool for the rest of this run and nothing
 * beyond it, "deny" refuses — and a refusal becomes a red step, never silence.
 */
export function sendResolveMcpConfirm(runId: string, nonce: string, verdict: McpConfirmVerdict): void {
  send({ cmd: "resolveMcpConfirm", runId, nonce, verdict });
}

/** Override the impact classification for one tool. `null` restores the classifier's call. */
export function sendSetMcpToolImpact(serverId: string, toolName: string, impact: McpImpact | null): void {
  send({ cmd: "setMcpToolImpact", serverId, toolName, impact });
}

// --- model providers -------------------------------------------------------
// Answered on the "providers" channel. A mutation comes back as a fresh snapshot of every
// provider's configured state, so the caller never optimistically patches local state — and
// the key never comes back at all.

export function sendListProviders(): void {
  send({ cmd: "listProviders" });
}

/**
 * Decide whether THIS WORKSPACE'S key pays for the calls Jaroku makes on its behalf.
 *
 * The one provider command that survived, and the reason it did: it carries no credential. Both
 * keys are already stored — this says which of them the plan gate, generation, the fix loop,
 * explain and the judge are billed to.
 *
 * Explicit boolean rather than a toggle, matching the server: two clicks racing end up where the
 * user last said rather than wherever the ordering left them.
 */
export function sendSetOwnKeyForPlatform(on: boolean): void {
  send({ cmd: "setOwnKeyForPlatform", on });
}

// STORING AND TESTING A PROVIDER KEY ARE NOT COMMANDS ON THIS SOCKET. They were, and they were
// the way around the Secrets passcode gate: elevation rides on a request header and a browser
// cannot set one on a WebSocket, so a credential command here is one nothing can gate. Both live on
// the secrets routes now — see lib/secrets.ts, which is HTTP for exactly this reason.

// --- deploy ----------------------------------------------------------------
// Answered on the "deploy" channel. Every mutation comes back as a fresh snapshot of every
// deployment, so nothing here optimistically patches local state.

export function sendListDeployments(): void {
  send({ cmd: "listDeployments" });
}

/** What a deploy would need. Creates nothing, spends nothing — safe on every form change. */
export function sendPlanDeploy(agentId: string, provider: string, model: string): void {
  useDeployStore.getState().startPlanning();
  send({ cmd: "planDeploy", agentId, provider, model });
}

/**
 * Start a deploy.
 *
 * `envKeys` are variable NAMES the user ticked. The server reads their values out of its own
 * environment at the moment it hands them to Railway — no value is ever sent from here.
 */
export function sendDeploy(opts: {
  agentId: string;
  provider: string;
  model: string;
  envKeys: string[];
  allowMissing?: boolean;
  publicEndpoint?: boolean;
}): void {
  send({ cmd: "deploy", ...opts });
}

export function sendCancelDeploy(deploymentId: string): void {
  send({ cmd: "cancelDeploy", deploymentId });
}

/** Detach a record from Jaroku. Nothing in the user's Railway account is touched. */
export function sendForgetDeployment(deploymentId: string): void {
  send({ cmd: "forgetDeployment", deploymentId });
}

export function sendLoadDeployLogs(deploymentId: string, sinceSeq?: number): void {
  send({ cmd: "loadDeployLogs", deploymentId, sinceSeq });
}

/**
 * Store the user's Railway token. `null` removes it.
 *
 * Travels one way, exactly as a provider key does: written to runtime/.env server-side by the
 * same credential writer, and the answer is `railwayConfigured: true` — never the token.
 */
export function sendSetRailwayToken(token: string | null): void {
  send({ cmd: "setRailwayToken", token });
}

/** Prove a token works without storing it. Separate command, same reason as the provider one. */
export function sendTestRailwayToken(token: string): void {
  useDeployStore.getState().startTest();
  send({ cmd: "testRailwayToken", token });
}

// --- membership ------------------------------------------------------------
// Answered on the "members" channel with a full snapshot, the same discipline as every other
// control-plane channel. `inviteLink` is the exception: it carries a credential, is sent only
// to the socket that asked, and is never stored — see wsRelay's MemberEvent.

export function sendListMembers(): void {
  send({ cmd: "listMembers" });
}
export function sendInviteMember(email: string, role: string): void {
  send({ cmd: "inviteMember", email, role });
}
export function sendRevokeInvite(inviteId: string): void {
  send({ cmd: "revokeInvite", inviteId });
}
export function sendSetMemberRole(userId: string, role: string): void {
  send({ cmd: "setMemberRole", userId, role });
}
export function sendRemoveMember(userId: string): void {
  send({ cmd: "removeMember", userId });
}

// --- eval: dataset CRUD ----------------------------------------------------
// Each of these is answered on the "eval" channel with a fresh snapshot of whatever it
// changed, so callers never have to optimistically patch local state.

export function sendListDatasets(agentId?: string): void {
  send({ cmd: "listDatasets", agentId });
}
export function sendLoadDataset(datasetId: string): void {
  send({ cmd: "loadDataset", datasetId });
}
export function sendCreateDataset(agentId: string, name: string): void {
  send({ cmd: "createDataset", agentId, name });
}
export function sendRenameDataset(datasetId: string, name: string): void {
  send({ cmd: "renameDataset", datasetId, name });
}
export function sendDeleteDataset(datasetId: string, agentId: string): void {
  send({ cmd: "deleteDataset", datasetId, agentId });
}
export function sendAddExample(
  datasetId: string,
  input: string,
  expected?: string | null,
  notes?: string | null,
): void {
  send({ cmd: "addExample", datasetId, input, expected, notes });
}
export function sendUpdateExample(
  datasetId: string,
  exampleId: string,
  patch: { input?: string; expected?: string | null; notes?: string | null },
): void {
  send({ cmd: "updateExample", datasetId, exampleId, ...patch });
}
export function sendDeleteExample(datasetId: string, exampleId: string): void {
  send({ cmd: "deleteExample", datasetId, exampleId });
}

/** One-click "save this test input to the eval dataset" (doc §4.7.6). The target dataset
 *  is resolved server-side — the agent's most recent, or a new default — so this is one
 *  round trip and lands in the same table the dataset builder writes to. */
export function sendPromoteTestInput(
  agentId: string,
  input: string,
  agentName?: string,
  expected?: string | null,
): void {
  send({ cmd: "promoteTestInput", agentId, agentName, input, expected });
}

// --- eval runs -------------------------------------------------------------

/** Fan a dataset out across providers. `budgetUsd` is a hard ceiling on TRUE spend. */
export function sendStartEval(
  datasetId: string,
  agentId: string,
  targets: EvalTarget[],
  budgetUsd?: number | null,
): void {
  send({ cmd: "startEval", datasetId, agentId, targets, budgetUsd });
}
export function sendCancelEval(evalId: string): void {
  send({ cmd: "cancelEval", evalId });
}
export function sendLoadEvalResults(evalId: string): void {
  send({ cmd: "loadEvalResults", evalId });
}
export function sendListEvals(datasetId?: string): void {
  send({ cmd: "listEvals", datasetId });
}
/** Ask what a real-provider eval would roughly cost, BEFORE committing to it. */
export function sendEstimateEval(datasetId: string, agentId: string, targets: EvalTarget[]): void {
  send({ cmd: "estimateEval", datasetId, agentId, targets });
}
export function sendLoadRubric(datasetId: string): void {
  send({ cmd: "loadRubric", datasetId });
}
export function sendSaveRubric(datasetId: string, criteria: RubricCriterion[], name?: string): void {
  send({ cmd: "saveRubric", datasetId, criteria, name });
}

// --- threads ---------------------------------------------------------------
// §7.1: the two reads are answered to this client alone, the four mutations come back as a full
// snapshot to the whole workspace. So nothing here optimistically patches local state — a client that
// did would be holding a list assembled from its own guess and the server's answer, and the §4.4
// counts beside it would belong to only one of the two.

/** The whole list for the active workspace, with derived status and counts. */
export function sendListThreads(): void {
  send({ cmd: "listThreads" });
}

/** Open one thread. Answered to this client only — opening is one client's navigation (§4.5). */
export function sendLoadThread(threadId: string): void {
  send({ cmd: "loadThread", threadId });
}

/**
 * Open a new thread, optionally on an agent.
 *
 * `agentId` is omitted for §3.1's planning stage: a thread legitimately exists before any agent does,
 * and that is the state somebody is in when they start describing one.
 */
export function sendCreateThread(agentId?: string | null, title?: string): void {
  send({ cmd: "createThread", agentId, title });
}

export function sendRenameThread(threadId: string, title: string): void {
  send({ cmd: "renameThread", threadId, title });
}

/** §3.4. Sets a timestamp; there is no delete command, because there is no delete path. */
export function sendArchiveThread(threadId: string): void {
  send({ cmd: "archiveThread", threadId });
}

export function sendRestoreThread(threadId: string): void {
  send({ cmd: "restoreThread", threadId });
}

// --- github ----------------------------------------------------------------
// Answered on the "github" channel. Every mutation comes back as a full snapshot, so nothing here
// optimistically patches local state.
//
// THERE IS NO `sendConnectGithub`. Storing a GitHub token is `POST /v1/github/connect`, in the
// secrets group, behind the elevation gate — a browser cannot put an elevation header on a
// WebSocket, so a credential command here would be one nothing can gate. Same reason
// `setProviderKey` is not in this file. See lib/github.ts.

/** The whole panel for one agent, or the workspace-wide half when no agent is selected. */
export function sendListGithub(agentId?: string): void {
  send({ cmd: "listGithub", agentId });
}

export function sendListGithubRepos(query?: string): void {
  useGithubStore.getState().startRepos();
  send({ cmd: "listGithubRepos", query });
}

/** §2.2's live availability check. Creates nothing and costs one request per keystroke. */
export function sendCheckGithubRepo(name: string): void {
  send({ cmd: "checkGithubRepo", name });
}

/** Link an agent. Either an existing `owner/repo`, or a bare name to create under the account. */
export function sendLinkGithub(opts: {
  agentId: string;
  repoFullName?: string;
  createName?: string;
  createPrivate?: boolean;
  branch?: string;
  subdirectory?: string | null;
  includeArtifacts?: boolean;
}): void {
  send({ cmd: "linkGithub", ...opts });
}

/** Detach. The repository and everything in it is untouched — see §6. */
export function sendUnlinkGithub(agentId: string): void {
  send({ cmd: "unlinkGithub", agentId });
}

/**
 * Re-read the remote and recompute the verdict.
 *
 * Read-only: it moves what we last SAW, never what we last DID, which is what makes it safe to
 * fire on opening the panel rather than only on a click.
 */
export function sendRefreshGithub(agentId: string, explicit = false): void {
  send({ cmd: "refreshGithub", agentId, explicit });
}

/**
 * Push every unpushed version.
 *
 * `squash` is per push and never a stored preference — §2.3. `force` requires `confirmSlug` to be
 * the agent's own slug, typed by the user, and the server refuses it before it reaches the network.
 */
export function sendPushGithub(
  agentId: string,
  opts: {
    squash?: boolean;
    force?: boolean;
    confirmSlug?: string;
    /** §B.4.1's staged subset. Omit for the ordinary push — an empty array is refused as a no-op. */
    stage?: GithubHunkSelection[];
    /** §B.4.4's restacked order over the UNPUSHED list. */
    steps?: GithubRestackStep[];
    message?: string;
    /** §B.6.1's override. Available, never the path of least resistance, always recorded. */
    ignoreSecrets?: boolean;
  } = {},
): void {
  send({ cmd: "pushGithub", agentId, ...opts });
}

/**
 * §B.3: ask for diagnostics on an unsaved buffer.
 *
 * THE NONCE IS RECORDED BEFORE THE SEND, so an answer that arrives after a later request has
 * already been recorded is dropped rather than painted. Doing it the other way round would leave a
 * window in which the newest request is not yet the newest known one.
 */
export function sendDiagnoseFile(agentId: string, path: string, source: string): void {
  const store = useDiagnosticsStore.getState();
  const nonce = store.nextNonce();
  store.markSent(agentId, path, nonce);
  send({ cmd: "diagnoseFile", agentId, path, source, nonce });
}

/** §B.2: run a ref once, without switching the agent to it. */
export function sendShadowRunGithub(
  agentId: string,
  ref: string,
  opts: { input?: string; provider?: string; model?: string } = {},
): void {
  send({ cmd: "shadowRunGithub", agentId, ref, ...opts });
}

/** §B.5.3: record what happened to a review comment, and reply in its thread. */
export function sendResolveReviewComment(
  agentId: string,
  commentId: string,
  resolution: "applied" | "dismissed",
  opts: { version?: number; reply?: string } = {},
): void {
  send({ cmd: "resolveReviewComment", agentId, commentId, resolution, ...opts });
}

/** §B.7: what changed about the AGENT between the current version and a ref. */
export function sendSemanticDiffGithub(agentId: string, ref?: string): void {
  send({ cmd: "semanticDiffGithub", agentId, ...(ref ? { ref } : {}) });
}

/** §B.2.2's transient list. Its own read, because it is deliberately not the run history. */
export function sendListShadowRuns(agentId: string): void {
  send({ cmd: "listShadowRuns", agentId });
}

/** Pull, through the same validate-before-promote path every generation passes. */
export function sendPullGithub(
  agentId: string,
  opts: { force?: boolean; confirmSlug?: string } = {},
): void {
  send({ cmd: "pullGithub", agentId, ...opts });
}

/** §3.2. With unpushed work the server refuses anything but an explicit answer. */
export function sendSwitchGithubBranch(
  agentId: string,
  branch: string,
  onUnpushed?: "push" | "keep" | "cancel",
): void {
  send({ cmd: "switchGithubBranch", agentId, branch, onUnpushed });
}

export function sendCreateGithubBranch(agentId: string, branch: string): void {
  send({ cmd: "createGithubBranch", agentId, branch });
}

/** §3.7's clean handoff: detection here, resolution on GitHub, where review already works. */
export function sendOpenGithubPr(agentId: string): void {
  send({ cmd: "openGithubPr", agentId });
}

/**
 * §3.4's ✨ generate.
 *
 * For the case where the staged files do not map cleanly onto one version — a hand-staged subset,
 * or a post-pull merge. The DEFAULT message needs none of this: it is pre-filled from the
 * version's own instruction and summary, which the version row already carries.
 */
export function sendGenerateGithubMessage(agentId: string): void {
  useGithubStore.getState().startGenerating(agentId);
  send({ cmd: "generateGithubMessage", agentId });
}

/** §3.4's commit box. `push` false is refused server-side — there is no local repository here. */
export function sendCommitGithub(agentId: string, message: string, push = true): void {
  send({ cmd: "commitGithub", agentId, message, push });
}

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
import {
  useAccessStore,
  type AccessHistoryEntry, type AccessPerson, type Exposure, type LiveSession, type PendingInvite,
} from "../store/accessStore.ts";
import type { AgentCapability } from "./capabilities.ts";
import { useAuditStore } from "../store/auditStore.ts";
import { useEnforcementStore } from "../store/enforcementStore.ts";
import { isRefusal, useEntitlementStore } from "../store/entitlementStore.ts";
import { refusedRole } from "./useCapability.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import { useActivityStore } from "../store/activityStore.ts";
import { useAgentGridStore } from "../store/agentGridStore.ts";
import { resetWorkspaceStores } from "../store/reset.ts";
import { INPUT_KEY_PREFIX, useUiStore } from "../store/uiStore.ts";
// A thread this client just created is opened here, which is a navigation — see the `threads`
// handler. `threadNav` imports this module for `sendLoadThread`; the cycle is fine because both
// sides only reach each other from inside a function, never at module scope.
import { openThread } from "./threadNav.ts";
import {
  fetchSession, fetchTicket, socketUrl, storeToken, storeWorkspace, storedToken, storedWorkspace,
  type AuthFailure,
} from "./auth.ts";
import type {
  ClientCommand, EvalTarget, ExplainSubject, GithubAttachment, GithubHunkSelection,
  GithubProviderPolicy, GithubRestackStep, InboxAction, McpConfirmVerdict, McpImpact,
  RubricCriterion, ServerMessage, SnoozeDuration,
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
/**
 * Which era of this tab's connection we are in. Bumped by every explicit stop.
 *
 * WHAT IT CLOSES. `scheduleReconnect` armed a bare `setTimeout` with no handle, and `stopSocket`'s
 * only defence was `stopped = true` — which `startSocket` sets straight back to false, and
 * `switchWorkspace` calls the two in exactly that order. So an orphaned timer armed before a
 * workspace switch fired afterwards, sailed past `connect`'s one guard, and opened a SECOND socket
 * beside the one the switch had just started. Both then dispatched every broadcast into the same
 * stores, and when the loser eventually closed it nulled the shared `ws` — after which every
 * command in the tab was silently dropped until the next reconnect.
 *
 * A generation is captured at the top of each `connect` and re-checked at every point it could
 * have been superseded, which a boolean cannot express: "stopped" is a state that comes back, and
 * "this attempt belongs to an era that has ended" does not.
 */
let generation = 0;

function dispatch(msg: ServerMessage): void {
  const s = useTraceStore.getState();

  // A TIER REFUSAL, LIFTED OUT BEFORE THE SWITCH AND THEN LEFT TO FALL THROUGH IT.
  //
  // The server answers a refused command on the channel that command belonged to — `gen` for a
  // fourth agent on Free, `deploy` for a sixth deployment, `members` for an invite Pro cannot make
  // — and every one of those already carries a `type: "error"` its own panel knows how to show. The
  // structure rides ALONGSIDE that string rather than replacing it, so this reads it once here
  // instead of eighteen error shapes each gaining an optional field and eighteen handlers each
  // deciding whether to look.
  //
  // NO `return`, DELIBERATELY. The channel's own error still reaches its own store, so a surface
  // with no card to render is not one where the refusal disappears — it shows the sentence it would
  // have shown anyway. The card is an upgrade on that, never a replacement.
  const carried = (msg as { entitlement?: unknown }).entitlement;
  if (carried !== undefined && isRefusal(carried)) {
    useEntitlementStore.getState().refuse(msg.channel, carried);
  }

  // §8.3's OTHER refusal, lifted out beside the tier one and for the same reason — the server
  // answers a role refusal on the channel the command belonged to, and every one of those already
  // carries a `type: "error"` its own panel knows how to show. Read once here rather than in
  // eighteen error shapes.
  //
  // "MAY THIS PERSON" AND "HAS THIS WORKSPACE ANY LEFT" ARE DIFFERENT QUESTIONS and they are
  // answered by different people: one by asking an owner, the other by paying. So a role refusal
  // is a toast naming the role, and a tier refusal is the inline card naming the figure — never
  // the same surface, because "ask your owner" and "upgrade" are not interchangeable advice.
  //
  // NO `return`, DELIBERATELY, exactly as above: the channel's own error still reaches its own
  // store, so a surface with no toast in view is not one where the refusal disappears.
  const role = refusedRole(msg);
  if (role) useUiStore.getState().setRefusedRole(role);

  switch (msg.channel) {
    case "history":
      s.applyHistory(msg.runs, { complete: msg.complete, window: msg.window });
      break;
    case "trace":
      s.applyEvent(msg.event);
      // §4.3.3: a running thread's cost figure moves with the steps it is paying for. The event is the
      // frozen schema's own `step`, unchanged and unextended — the thread it belongs to is resolved from
      // the run id, against the `live_run_ids` the last snapshot carried. Nothing about the trace knows
      // that threads exist, which is the whole arrangement §7 asks for.
      if (msg.event.kind === "step" && msg.event.step.cost != null) {
        useThreadStore.getState().addStepCost(msg.event.step.run_id, msg.event.step.cost, msg.event.step.id);
        // §5.5's live spend ticker, from the same event and by the same route: the frozen schema has
        // no agent field either, so the card is found through the run ids the last grid snapshot
        // carried. Two stores reading one event rather than one store holding both lists — see
        // agentGridStore's header for why they are separate.
        useAgentGridStore.getState().addStepCost(msg.event.step.run_id, msg.event.step.cost, msg.event.step.id);
      }
      break;
    case "runSteps":
      s.applyRunSteps(msg.runId, msg.steps);
      break;
    case "log":
      s.addLog({ level: msg.level, text: msg.text });
      break;
    case "agents": {
      // TWO SHAPES ON ONE CHANNEL, discriminated by whether `type` is there. The untyped one is the
      // sidebar's list and predates the Agents tab; giving it a discriminator would have meant
      // touching the sidebar, the composer's target list and the eval picker to add a tab.
      const a = useAgentGridStore.getState();
      if (msg.type === undefined) useBuildStore.getState().setAgents(msg.agents);
      else if (msg.type === "grid") a.setGrid(msg.cards, msg.team);
      else if (msg.type === "detail") a.setDetail(msg.detail);
      else if (msg.type === "version") a.setVersion(msg.agentId, msg.version, msg.files);
      else if (msg.type === "error") a.setError(msg.message);
      else if (msg.type === "notice") a.setNotice(msg.message);
      break;
    }
    case "agentFiles":
      // The failure branch first, because it is the one that used to be no message at all: a read
      // that threw left this store on its initial state forever and the ⊕ menu explaining that the
      // agent had never been generated.
      if (msg.error !== undefined) useBuildStore.getState().setAgentFilesError(msg.agentId, msg.error);
      else useBuildStore.getState().setAgentFiles(msg.agentId, msg.files);
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
      // Every one of these is handed the whole message, so the session on the envelope reaches the
      // store that files the turn. A tab that did not send the command learns which thread the work
      // belongs to from here and nowhere else.
      //
      // AND IT HAS TO BE *SELECTED*, NOT MERELY FILED, WHICH IS WHAT THIS BLOCK IS FOR.
      //
      // A conversation is keyed by thread — `threadFor` reads `threads[activeThreadId]`, and with
      // no active thread it reads `pending`. Sending a plan without naming a session is legal and
      // is what the FIRST prompt of a new workspace does: there is no thread yet, so the server
      // makes one and names it on the envelope. The store then files the turns under that id
      // correctly, and the screen goes on reading `pending` — so the plan card, and any refusal
      // in its place, is written into a conversation nothing is displaying.
      //
      // What that looked like: type the first thing you ever type into Jaroku, press send, and
      // the text disappears and NOTHING happens. No card, no error, no spinner. It reproduces
      // every time on a fresh install, because a fresh install has no provider key, so the plan
      // fails and the failure is filed exactly as invisibly as a success would have been.
      //
      // Only when this tab has no thread open: adopting one while somebody is looking at another
      // conversation would yank them out of it, and a broadcast from a teammate's work would move
      // their view. The narrow case is the one that is broken.
      if (msg.threadId && !useThreadStore.getState().activeThreadId) {
        useThreadStore.getState().selectThread(msg.threadId);
      }
      switch (msg.type) {
        case "started": b.startGeneration(msg.prompt); c.genStarted(msg); break;
        case "file_start": b.fileStart(msg.path); break;
        case "file_delta": b.fileDelta(msg.path, msg.text); break;
        case "file_end": b.fileEnd(msg.path); break;
        case "done": b.finish(msg.agentId, msg.usage); c.genDone(msg); break;
        case "error": b.fail(msg.message, msg.problems); c.genError(msg); break;
        // The pre-generation gate. NOTE that none of these touch buildStore: a plan writes no
        // files, so the build pane has nothing to show and — crucially — nothing to mark as
        // failed. plan_error goes to the conversation, never to b.fail().
        case "plan_started": c.planStarted(msg); break;
        case "plan_delta": c.planDelta(msg); break;
        case "plan": c.planReady(msg); break;
        case "plan_discarded": c.planDiscarded(msg); break;
        case "plan_restored": c.planRestored(msg); break;
        case "plan_error": c.planError(msg); break;
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
        case "started": c.editStarted(msg); break;
        case "file_start": c.editFileStart(msg.path); break;
        case "file_delta": c.editFileDelta(msg.path, msg.text.length); break;
        case "file_end": c.editFileEnd(msg.path); break;
        case "proposal": c.proposal(msg); break;
        case "applied": c.applied(msg); break;
        case "undone": c.undone(msg); break;
        case "discarded": c.discarded(msg); break;
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
      } else if (msg.type === "cancelled") {
        // The row stops saying `running` now rather than when the next history snapshot lands.
        // `error` is the status the server stores for it ("cancelled by user" is the reason on the
        // row), so this agrees with what a reload would show rather than inventing a fifth state.
        s.setRunStatus(msg.runId, "error");
        s.addLog({ level: "stderr", text: "debug: run cancelled" });
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
      } else if (msg.type === "evalProgress") {
        e.setProgress({ ...msg });
        // §4.3.3, the eval half. An eval's runs are kept off the `trace` channel on purpose, so
        // this is the only route its spend has to a thread row — and the progress numbers are what
        // give `projectCost` a denominator that moves. Both go to `threadStore` rather than being
        // read out of `evalStore` by the row, because the row's question is "what has THIS SESSION
        // spent", which is a fact about a thread and not about the eval panel's selection.
        const t = useThreadStore.getState();
        t.addEvalCost(msg.evalId, msg.spentDeltaUsd);
        t.noteEvalProgress(msg.evalId, { done: msg.done, total: msg.total });
      }
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
      else if (msg.type === "evals") e.setEvals(msg.evals, { complete: msg.complete, window: msg.window });
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
      if (msg.type === "providers") p.setProviders(msg.providers, msg.ownKeyForPlatform, msg.models);
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
      } else if (msg.type === "scanFindings") {
        // §B.6's history, answered on demand. Its own field rather than the refusal's: one is the
        // card about the push that just happened, the other is the record behind it.
        g.setScanFindings(msg.agentId, msg.findings);
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
    case "enforcement": {
      // The workspace's standing. Broadcast rather than answered to one socket, because a rung
      // applies to the workspace: one member appealing is something every open tab should see.
      const e = useEnforcementStore.getState();
      if (msg.type === "enforcement") e.apply(msg.state, msg.history);
      else if (msg.type === "notice") e.setNotice(msg.message);
      else if (msg.type === "error") e.setError(msg.message);
      break;
    }
    case "audit": {
      // A read, answered to this socket alone — so unlike every other channel here there is no
      // broadcast to reconcile with, and a snapshot replaces rather than merges.
      const a = useAuditStore.getState();
      if (msg.type === "audit") a.setEntries(msg.entries);
      else if (msg.type === "error") a.setError(msg.message);
      break;
    }
    case "access": {
      const a = useAccessStore.getState();
      if (msg.type === "access") {
        a.setAccess({
          agentId: msg.agentId,
          agentSlug: msg.agentSlug,
          people: msg.people as AccessPerson[],
          orphans: msg.orphans as AccessPerson[],
          viewer: msg.viewer as AgentCapability[],
          invites: msg.invites as PendingInvite[],
        });
      } else if (msg.type === "exposure") a.setExposure(msg.exposure as Exposure);
      else if (msg.type === "sessions") a.setSessions(msg.agentId, msg.sessions as LiveSession[]);
      else if (msg.type === "history") a.setHistory(msg.agentId, msg.entries as AccessHistoryEntry[]);
      else if (msg.type === "recheck") {
        // §7 AND §8.2 — THE CACHE GOES, AND THEN THE PANEL ASKS AGAIN IF IT IS OPEN.
        //
        // In that order, and both halves are needed. Emptying alone would leave every guard on the
        // fallback — the workspace default — which is wider than a narrowing grant and would put
        // affordances back on screen that had just been taken away. Refetching alone would leave
        // the old set rendering until the answer landed, which is the same wrongness for a shorter
        // time. Emptied, then refetched, means the interval between them is spent at the workspace
        // default, which is exactly the state §8.2 says is acceptable and why.
        a.invalidate();
        const open = useUiStore.getState().accessAgentId;
        if (open) sendLoadAccess(open);
      } else if (msg.type === "error") a.setError(msg.message);
      else if (msg.type === "notice") console.info("[access]", msg.message);
      break;
    }
    case "members": {
      const m = useMemberStore.getState();
      if (msg.type === "members") m.setMembers(msg.members, msg.invites);
      else if (msg.type === "inviteLink") m.setInviteLink(msg);
      else if (msg.type === "left") leftWorkspace();
      else if (msg.type === "error") m.setError(msg.message);
      else if (msg.type === "notice") m.setNotice(msg.message);
      break;
    }
    case "inbox": {
      // A SNAPSHOT REPLACES AND A DELTA TOUCHES ONE CARD. §5.6 asks that a resolving card collapse
      // and fade with only the affected card re-rendering, which is why the resolution arrives as a
      // delta at all — and what makes that safe is that a delta only ever carries a fact that is
      // true for everybody in the workspace. See inboxStore's own header.
      const i = useInboxStore.getState();
      if (msg.type === "inbox") i.setSnapshot(msg);
      else if (msg.type === "inboxDelta") {
        if (msg.kind === "resolved") i.noteResolved(msg.itemId);
        else if (msg.kind === "count") i.noteCount(msg.itemId, msg.count, msg.last_seen_at);
        else i.noteAdded(msg.item);
      } else if (msg.type === "inboxUndo") {
        // A NULL TOKEN IS THE ANSWER TO AN UNDO, not the offer of one: the action has been taken
        // back and there is nothing further to take back. Clearing the toast is what says so.
        i.setUndo(msg.token ? { token: msg.token, action: msg.action, changed: msg.changed, at: Date.now() } : null);
      } else if (msg.type === "error") i.setError(msg.message);
      else if (msg.type === "notice") console.info("[inbox]", msg.message);
      break;
    }
    case "work": {
      // A SNAPSHOT REPLACES AND A DELTA TOUCHES ONE ROW, and here the delta is the common case
      // rather than the exception: §5 makes a transition a single item precisely because a work
      // list moves every few seconds. What makes broadcasting one payload safe is that the store
      // filters it — see `matchesFilters`.
      const w = useWorkStore.getState();
      if (msg.type === "snapshot") {
        // A PAGE AFTER THE FIRST IS APPENDED RATHER THAN REPLACING. The cursor is what tells
        // them apart, and it is the client's own record of what it asked for — the server sends
        // the same shape either way, because a page is a page.
        if (pendingWorkPage) {
          pendingWorkPage = false;
          w.appendPage({ items: msg.items, nextCursor: msg.nextCursor });
        } else {
          w.setSnapshot(msg);
        }
      } else if (msg.type === "item") {
        // THE FILTER IS APPLIED HERE, which is the one thing this store decides. A broadcast
        // item carries no filter — it cannot, it goes to every socket in the workspace — so a
        // client holding "mine, failed" receives transitions for jobs it is not showing.
        const viewer = useSessionStore.getState().user?.id ?? null;
        if ("input" in msg.item) w.openItem(msg.item);
        // THE STORE APPLIES THE FILTER, because it is the one that holds the list: a delta can
        // ADD a row that has just come into existence, UPDATE one it holds, or REMOVE one that
        // has left the filter, and only the list knows which of the three this is.
        w.noteItem(msg.item, viewer);
        // A ROW CANNOT CLOSE THE PANEL'S ACCOUNT OF THE JOB, so an ending is re-read.
        //
        // A delta carries a ROW, and a row deliberately has no `input` or `output` — a page of
        // fifty rows carrying full inputs and outputs is a page of fifty customer emails on the
        // wire. Merging one over the detail therefore leaves whatever the panel was opened with,
        // which for a job dispatched a moment ago is `output: null`. The panel would sit on a
        // finished job saying nothing came back until somebody closed and reopened it.
        //
        // ONLY FOR THE OPEN PANEL AND ONLY ON AN ENDING: one extra read, for the one job somebody
        // is actually looking at, at the one moment its answer comes into existence.
        const ended = msg.item.ended_at !== null;
        if (ended && !("input" in msg.item) && useWorkStore.getState().open?.id === msg.item.id) {
          sendLoadWorkItem(msg.item.id);
        }
      } else if (msg.type === "fleet") w.setFleet(msg.cards, msg.anyLive);
      else if (msg.type === "dispatched") {
        // NAVIGATION, WHICH IS WHY IT IS ANSWERED TO THIS SOCKET AND NOT BROADCAST: the composer
        // clears and the detail panel opens on the job that was just started.
        w.openItem(msg.item);
        // §19: IT SETTLES THE ROW THE COMPOSER ALREADY DREW, in place and with no motion — "it was
        // already in the right position". `settleOptimistic` falls back to an ordinary arrival when
        // there is no placeholder to replace, which is what a retry from the detail panel produces.
        if (msg.clientRef) w.settleOptimistic(msg.clientRef, msg.item);
        // AND IT JOINS THE LIST BY THE SAME RULE AS ANY OTHER DELTA. A job dispatched while the
        // page is filtered to `failed` does not belong on it, and the panel opening is the
        // navigation that answers the dispatch — not a row appearing under a filter it fails.
        else w.noteItem(msg.item, useSessionStore.getState().user?.id ?? null);
      }
      else if (msg.type === "logs") w.setLogs({ deploymentId: msg.deploymentId, lines: msg.lines, cursor: msg.cursor });
      else if (msg.type === "error") {
        w.setError(msg.message);
        // §19: ON REFUSAL THE ROW DOES NOT VANISH — it becomes a failed row carrying the reason.
        // "A row that appears and then disappears makes the user wonder whether the job ran, and
        // 'did it run or not' is the one question this tab exists to never leave open." The strip
        // above the list says it too, because §10 requires the refusal to be somewhere that does
        // not scroll away; the row is what somebody finds later.
        if (msg.clientRef) w.refuseOptimistic(msg.clientRef, msg.message);
      }
      else if (msg.type === "notice") w.setNotice(msg.message);
      break;
    }
    case "activity": {
      // SIX ANSWERS TO ONE COMMAND, and each one is filed the moment it lands. §3.6: "Cards fill
      // independently as their queries return — a slow leaderboard must not hold up the hero row."
      //
      // THE STORE DROPS ANYTHING FOR A WINDOW IT HAS MOVED OFF, which is why every message carries
      // its range and why that check lives in the store rather than here: six replies can arrive in
      // any order, and a page assembled from two windows is the one thing §1's single global range
      // exists to prevent.
      const a = useActivityStore.getState();
      if (msg.type === "activitySummary") {
        a.applySummary(msg.range, { computedAt: msg.computedAt, live: msg.live }, msg.summary);
      } else if (msg.type === "activityLeaderboard") {
        a.applyLeaderboard(msg.range, { computedAt: msg.computedAt, live: msg.live }, msg.rows, msg.truncated, msg.mix);
      } else if (msg.type === "activityReleases") {
        a.applyReleases(msg.range, { computedAt: msg.computedAt, live: msg.live }, msg.entries);
      } else if (msg.type === "activityToolUsage") {
        a.applyTools(msg.range, { computedAt: msg.computedAt, live: msg.live }, msg.usage);
      } else if (msg.type === "activityTeam") {
        a.applyTeam(msg.range, { computedAt: msg.computedAt, live: msg.live }, msg.scope, msg.members, msg.personal);
      } else if (msg.type === "activityFeed") {
        a.applyFeed(msg.range, msg.rows, msg.cursor, msg.next);
      } else if (msg.type === "error") a.setError(msg.message);
      else if (msg.type === "notice") console.info("[activity]", msg.message);
      break;
    }
    case "threads": {
      // Every message here is a FULL SNAPSHOT except `thread`, which is one row answered to this
      // client because it asked to open it. Nothing merges: see threadStore's own header.
      const t = useThreadStore.getState();
      if (msg.type === "threads") t.setThreads(msg.threads, msg.counts);
      else if (msg.type === "thread") {
        t.setThread(msg.thread);
        // §4.5: opening a thread has to show that thread's conversation, and after a reload this
        // is the only place it can come from — the turns live in `thread_items` server-side and
        // nowhere in this tab.
        useChatStore.getState().hydrate(msg.thread.id, msg.items);
        // A THREAD THIS CLIENT JUST MADE IS OPENED, not merely filed. `+ New thread` used to leave
        // the row sitting in the list — `setThread` deliberately selects nothing — so every press
        // added a permanently empty, permanently untitled row that no work could ever land in.
        // `loaded` is the other case and must not re-navigate: it answers a `loadThread` this
        // client sent BECAUSE it was already opening that thread.
        if (msg.reason === "created") openThread(msg.thread, { haveConversation: true });
      }
      else if (msg.type === "error") t.setError(msg.message);
      // A notice is not an error and must not render as one. Nothing on this channel sends one yet;
      // it is handled rather than dropped so a server running ahead of the client is visible.
      else if (msg.type === "notice") console.info("[threads]", msg.message);
      break;
    }
    case "reply": {
      // Unified composer "explain": a streaming prose answer in the conversation (chatStore).
      const c = useChatStore.getState();
      if (msg.type === "started") c.replyStarted(msg);
      else if (msg.type === "delta") c.replyDelta(msg);
      else if (msg.type === "done") c.replyDone(msg);
      else if (msg.type === "error") c.replyError(msg);
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
  // The era this attempt belongs to. Everything below awaits — a session fetch and a ticket
  // exchange — and a stop during either means this attempt is for a workspace the tab has left.
  const era = generation;
  const superseded = (): boolean => era !== generation;
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
    // The pins belong to this WORKSPACE and are read from localStorage by its id, so they can only be
    // read once there is one. Same shape as onboarding progress being re-read when the user lands.
    useUiStore.getState().loadPinnedAgents();
    ticket = issued.ticket;
  } catch (err) {
    const failure = err as AuthFailure;
    useTraceStore.getState().setConnection("closed");
    // §5.2 — A SWITCH IN FLIGHT TAKES NEITHER OF THE TWO BRANCHES BELOW. Both of them are right
    // for the workspace this tab is already in and wrong for one it is trying to enter: signing
    // out over a 403 would end the session in A because B refused, and backing off would leave the
    // tab behind a scrim retrying a workspace it is never going to reach. See `revertSwitch`.
    if (revertSwitch(failure.message)) return;
    if (!failure.retryable) {
      // 401 or 403. The token is bad, or this account may not be here. Stop.
      useSessionStore.getState().signOut(failure.message);
      return;
    }
    useSessionStore.getState().setStatus("connecting", failure.message);
    scheduleReconnect();
    return;
  }

  // The ticket was fetched for a workspace this tab may since have left. Opening it now would put
  // the previous workspace's socket beside the current one's — which is the leak `switchWorkspace`
  // resets the stores to prevent, arriving by a different route.
  if (superseded()) return;
  const socket = new WebSocket(socketUrl(ticket));
  ws = socket;

  socket.onopen = () => {
    // A socket from an era that has ended is closed rather than adopted. It cannot happen after
    // the check above unless a stop landed in the same tick, which is exactly the race.
    if (superseded()) {
      try { socket.close(); } catch { /* already closing */ }
      return;
    }
    // A connection that stayed open is what resets the backoff, not one that was merely
    // attempted — otherwise a server refusing every socket is retried at full speed forever.
    attempt = 0;
    useTraceStore.getState().setConnection("open");
    useSessionStore.getState().setStatus("ready");
    // §5.1 STEP 7 — UNLOCK, AND HERE RATHER THAN AFTER THE SNAPSHOTS. `onopen` is the moment the
    // relay has accepted the ticket and the Origin, which is the last thing that can refuse this
    // switch; the snapshots that follow are data arriving into stores the UI already renders
    // empty. Waiting for them would mean holding the scrim over a working application until the
    // slowest channel answered, and would need a rule for which channels count — a workspace with
    // no agents sends an empty agent list, which is indistinguishable from one that has not sent.
    disarmSwitchDeadline();
    useSessionStore.getState().endSwitch();
    // WHAT THE INITIAL SNAPSHOT DOES NOT CARRY. The relay pushes history, agents, mcp, providers,
    // deploy, threads and members on connect; a workspace's STANDING is not among them, and it is
    // the one fact that changes what every other surface is allowed to do. Asked for here rather
    // than by the panel that renders it, because a suspended workspace has to say so on frame one —
    // the alternative is a user pressing Run, being refused, and having nowhere to read why.
    sendLoadEnforcement();
  };

  socket.onmessage = (ev) => {
    // Dispatching from a superseded socket would apply another workspace's broadcasts to this
    // one's stores, and would double every event a duplicate connection received.
    if (superseded()) return;
    try {
      dispatch(JSON.parse(ev.data as string) as ServerMessage);
    } catch {
      /* ignore malformed server frames */
    }
  };

  socket.onclose = (ev) => {
    // AND IT ONLY NULLS ITS OWN. This used to clear the shared `ws` unconditionally, so an orphan
    // closing took the LIVE socket's handle with it and every `send` afterwards was dropped.
    if (ws === socket) ws = null;
    if (superseded()) return;
    useTraceStore.getState().setConnection("closed");
    if (stopped) return;
    // §5.2 — THE HANDSHAKE IS THE OTHER THING THAT CAN REFUSE A SWITCH, and it refuses by closing
    // rather than by rejecting. A socket that closes before it ever opened, while a switch is in
    // flight, is the target workspace saying no — a revoked ticket, a membership that ended
    // between the ticket and the upgrade, an Origin the relay does not allow.
    if (revertSwitch("could not open that workspace")) return;
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
  socket.onerror = () => socket.close();
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
  // The era this reconnect belongs to, captured at arming time. `stopped` cannot serve here:
  // `startSocket` clears it, and `switchWorkspace` calls stop-then-start, so by the time an
  // orphaned timer fired the flag it was meant to be caught by had been reset for it.
  const era = generation;
  setTimeout(() => {
    if (era !== generation) return;
    void connect();
  }, delay);
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
  // The deadline belongs to the attempt this is ending. `switchWorkspace` re-arms it immediately
  // afterwards; every other caller — sign out, a plain restart — has no switch to time out.
  disarmSwitchDeadline();
  // Every reconnect armed before this moment, and every connect attempt mid-await, now belongs to
  // an era that has ended. See `generation`.
  generation++;
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
/**
 * §6.5's landing — where somebody goes after they have left a workspace.
 *
 * "THEY LAND ON THEIR PERSONAL WORKSPACE", which is the one destination that is always there: it
 * is created in the same transaction as the account and nothing can remove somebody from it,
 * because leaving refuses an owner and they are its owner. Falling back to "the first one left" if
 * it is somehow absent, and to a sign-out if there is nothing at all — an account with no
 * workspace has nothing to render, and a tab sitting on an empty shell is worse than a screen that
 * says what happened.
 *
 * THE MEMBERSHIP LIST IS PRUNED HERE, IN THE CLIENT. The session is fetched once per connect and
 * the departure happened on a socket, so nothing would otherwise take the workspace out of the
 * switcher until the next reconnect — and `switchWorkspace` refuses a target it cannot see a
 * membership for, which is a guard that would refuse this switch if the list still contained the
 * workspace being left. Removing it first is what makes the destination the personal one.
 */
function leftWorkspace(): void {
  const session = useSessionStore.getState();
  const gone = session.workspaceId;
  const remaining = session.workspaces.filter((w) => w.id !== gone);
  session.setWorkspaces(remaining);
  const home = remaining.find((w) => w.kind === "personal") ?? remaining[0];
  if (!home) {
    session.signOut("you are no longer a member of any workspace");
    return;
  }
  useUiStore.getState().setInviteNotice({
    ok: true,
    // Names the workspace being LEFT rather than the one being landed in, because the sentence is
    // a confirmation of something irreversible-ish — §6.5's own wording is "you'll need a new
    // invite to rejoin" — and the destination is visible in the switcher a moment later anyway.
    message: `You left ${session.workspaces.find((w) => w.id === gone)?.name ?? "that workspace"}`,
  });
  switchWorkspace(home.id);
}

export function switchWorkspace(workspaceId: string): void {
  // The lock goes on FIRST, and `beginSwitch` is what decides whether there is a switch at all —
  // already there, not a membership, or one already in flight. Nothing below this line is
  // reversible, so the guard cannot be after it.
  if (!useSessionStore.getState().beginSwitch(workspaceId)) return;

  stopSocket();
  resetWorkspaceStores();
  storeWorkspace(workspaceId);
  // The workspace panel is a view of the workspace being left. Its own store is reset above, so
  // leaving it open would render an empty members list under the new workspace's name until the
  // snapshot landed — a panel showing the wrong tenant's shape, briefly, which is the thing the
  // reset ordering exists to prevent.
  useUiStore.getState().closeWorkspacePanel();
  armSwitchDeadline();
  startSocket();
}

/**
 * §5.2's upper bound on the lock.
 *
 * FIFTEEN SECONDS, WHICH IS NOT THE SPEC'S FIGURE AND IS NOT MEANT TO BE. §5.2 asks for the whole
 * transition to take "under 500ms on a local connection and under 2 seconds on a typical remote
 * connection" — that is a performance target, and a deadline set to a performance target reverts
 * the switches that were merely slow. This is the other kind of number: the point past which
 * nothing is going to arrive, and staying locked is worse than being wrong. A tab that has been
 * showing a scrim over an empty app for fifteen seconds has already failed.
 *
 * IT EXISTS BECAUSE NOT EVERY FAILURE HAS AN EVENT. A refused ticket rejects, a refused handshake
 * closes — both reach `connect` and both revert. A socket that opens and never completes its
 * upgrade, a request to a host that black-holes packets, a machine that suspends mid-exchange: no
 * error, no close, no frame, and the lock has nothing to be cleared by.
 */
const SWITCH_DEADLINE_MS = 15_000;
let switchDeadline: ReturnType<typeof setTimeout> | null = null;

function armSwitchDeadline(): void {
  if (switchDeadline) clearTimeout(switchDeadline);
  const era = generation;
  switchDeadline = setTimeout(() => {
    // A deadline armed for a switch that has since been superseded — by a second switch, a sign
    // out, a reconnect — belongs to an era that has ended. The same guard the reconnect timer
    // needs, for the same reason.
    if (era !== generation) return;
    revertSwitch("that workspace did not answer");
  }, SWITCH_DEADLINE_MS);
}

function disarmSwitchDeadline(): void {
  if (switchDeadline) clearTimeout(switchDeadline);
  switchDeadline = null;
}

/**
 * Give up on a switch in flight and reconnect to the workspace it left. §5.2 and §5.5.
 *
 * WHAT MAKES THIS DIFFERENT FROM AN ORDINARY RECONNECT is which failures reach it. Outside a
 * switch, a retryable failure backs off and tries again — correctly, because the workspace it is
 * retrying is one this tab was already in and will be in again. Inside a switch there is no such
 * workspace: retrying means retrying the TARGET, and a target that refused a ticket will refuse
 * the next one too, so the tab would sit behind a scrim backing off against a workspace it is
 * never going to enter while the one it came from is a keystroke away.
 *
 * AND IT CATCHES THE 403 THAT USED TO SIGN PEOPLE OUT. `fetchTicket` answers 403 for a workspace
 * you are not a member of, `AuthFailure` marks that not-retryable, and `connect`'s handling of
 * not-retryable is `signOut`. Correct for the workspace you are already in — a membership revoked
 * under you is the end of that session — and badly wrong for a switch: being refused entry to B
 * ended the session in A. Somebody removed from a team while their tab was open would click it in
 * the switcher and land on the sign-in screen.
 */
function revertSwitch(message: string): boolean {
  const session = useSessionStore.getState();
  if (!session.switching) return false;
  disarmSwitchDeadline();
  // Cleared BEFORE the reconnect, so what follows is an ordinary connect to an ordinary workspace
  // — otherwise the revert's own failures would be read as this switch's and revert again.
  session.failSwitch(message);
  storeWorkspace(useSessionStore.getState().workspaceId);
  // `restartSocket` rather than `connect`: it bumps the generation, which supersedes the attempt
  // this was called from and every timer armed by it.
  restartSocket();
  return true;
}

/**
 * Put a command on the wire, and say whether it went.
 *
 * IT USED TO RETURN NOTHING, and a closed socket therefore dropped writes in silence. That is fine
 * for a read whose answer is a fresh snapshot nobody is waiting on, and it is not fine for a
 * mutation: §3.4's archive wrote "Archived · discarded a pending diff (+42−11)" into the UI and
 * then sent an `archiveThread` that never left the tab, so the notice named something that had not
 * happened and Undo did nothing either. A caller that cares can now ask.
 */
function send(cmd: ClientCommand): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(cmd));
  return true;
}

/**
 * The session new work belongs to (§3.1), for the six commands the relay accepts a `threadId` on.
 *
 * READ HERE RATHER THAN PASSED BY EVERY CALLER. "Which thread am I in" is a fact about the app's
 * navigation, not an argument a composer or an eval bar knows — and every one of them forgetting it
 * is exactly what happened: the server accepted and validated the field from the first day, no
 * sender ever set it, and every command fell through to `ensureForAgent`. Two threads on one agent
 * then filed their work into whichever was touched last, which is the one thing §3.1 exists to stop.
 *
 * Undefined when nothing is open, which is a real state — the composer before anything has been
 * said — and the server's own resolution applies to it exactly as before.
 */
function activeThread(): string | undefined {
  return useThreadStore.getState().activeThreadId ?? undefined;
}

export function sendRun(
  input?: string,
  provider?: string,
  model?: string,
  agentId?: string,
): void {
  // `model` is forwarded now — the relay and index.ts always accepted it, but this client
  // was dropping it, so a real-provider run silently used the agent's default model.
  send({ cmd: "run", input: input || undefined, provider, model, agentId, threadId: activeThread() });
}

/**
 * Ask for a LARGER WINDOW on the run history.
 *
 * The 51st-newest run used to be unreachable: `loadRun` needs an id, and the only source of ids was a
 * list that stopped at fifty, while retention keeps traces for a month to a year by plan. A window
 * rather than a page, so the channel keeps its full-snapshot discipline — `applyHistory` merges by
 * run id, so a bigger window adds rows and can never assemble a list out of two moments.
 */
export function sendLoadHistory(limit: number): void {
  send({ cmd: "loadHistory", limit });
}

export function sendLoadRun(runId: string): void {
  send({ cmd: "loadRun", runId });
}

/** Confirm a plan. `planId` is what makes the server build the plan the user approved rather
 *  than whatever the composer says now — see planner.take(). */
/**
 * §4's attachments, as they go on the wire.
 *
 * REFERENCES AND NEVER CONTENT, which is the same rule §7's GitHub attachments follow: the server
 * resolves each ref at send time from the store that owns that kind of thing. What is deliberately
 * absent is the token estimate — the client has one, for the rail's meter, and sending it would
 * make the budget check a check of a number the client chose. The server re-measures.
 */
export interface CommandAttachment {
  kind: "file" | "run" | "dataset_case" | "tool_schema" | "github";
  ref: Record<string, unknown>;
  /** Which agent the ref is relative to. A file path means nothing without one. */
  agent_id: string;
}

/** Only sent when there is something to send, so an unattached message is the frame it always was. */
const withAttachments = (a?: readonly CommandAttachment[]): { attachments?: CommandAttachment[] } =>
  a && a.length > 0 ? { attachments: [...a] } : {};

export function sendGenerate(
  prompt: string,
  connectors: string[],
  name?: string,
  planId?: string,
  attachments?: readonly CommandAttachment[],
): void {
  send({ cmd: "generate", prompt, connectors, name, planId, threadId: activeThread(), ...withAttachments(attachments) });
}

/** Ask for a plan. With `revisePlanId`, `prompt` is feedback on that plan, not a fresh brief. */
export function sendPlanAgent(
  prompt: string,
  connectors: string[],
  name?: string,
  revisePlanId?: string,
  /** Scoped MCP tools, as `"server/tool"` refs — per tool, never per server. */
  mcpTools?: string[],
  attachments?: readonly CommandAttachment[],
): boolean {
  // THE ONE SENDER IN THIS FILE THAT RETURNS WHETHER IT SENT, and it does because it has a caller
  // that cannot recover on its own. Every other `send` here is fired from a composer sitting inside
  // a connected app, where a closed socket is a reconnect the user can already see and the frame is
  // legitimately dropped. §5.1s step 4 is not that: it is a button on an onboarding screen that
  // advances to "You are all set" the moment it returns, so a dropped frame there is a flow that
  // reports success and generated nothing — with an empty app behind it and no way to tell why.
  return send({
    cmd: "planAgent", prompt, connectors, mcpTools, name, revisePlanId,
    threadId: activeThread(), ...withAttachments(attachments),
  });
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

/**
 * Set this workspace's own spend ceiling, or clear it back to the plan's with `null`.
 *
 * A budget you can see and cannot set is a dashboard rather than a control, and until now the only
 * reachable number was whatever the plan said. The server answers with a fresh usage snapshot, so
 * the meter, its bar and the over-ceiling state all move from one computation.
 */
/**
 * Run this workspace's agents on its own provider keys, or on the platform's.
 *
 * Instant and with no proration — inference is usage-based, so the next call simply routes the
 * other way. The server refuses turning it on with no key configured, rather than accepting it and
 * quietly continuing to bill platform credit.
 */
export function sendSetByok(on: boolean): boolean {
  return send({ cmd: "setByok", on });
}

export function sendSetSpendCeiling(usd: number | null): void {
  send({ cmd: "setSpendCeiling", usd });
}

export function sendListAgents(): void {
  send({ cmd: "listAgents" });
}

/**
 * The agent lifecycle — archive, restore, rename.
 *
 * WHAT THESE REPLACE. Nothing: the product's central object had no lifecycle operation of any kind,
 * in any layer, while every other resource in it had one. An agent created by mistake stayed in the
 * sidebar, the filter counts, the eval picker and the composer's target list forever.
 *
 * Each answers with a refreshed agent snapshot rather than a per-command event, which is why there
 * is nothing here to handle on the way back: the list every surface renders IS the answer.
 */
export function sendArchiveAgent(agentId: string): void {
  send({ cmd: "archiveAgent", agentId });
}
/**
 * §7.5: which MCP tools this agent may call, as the WHOLE set.
 *
 * NOT AN ADD OR A REMOVE. A grant is a least-privilege decision and its honest unit is these tools
 * and no others — two tabs each sending an add would produce a set neither of them chose. A caller
 * removing one sends the rest.
 */
export function sendSetAgentTools(agentId: string, mcpTools: readonly string[]): void {
  send({ cmd: "setAgentTools", agentId, mcpTools: [...mcpTools] });
}

export function sendRestoreAgent(agentId: string): void {
  send({ cmd: "restoreAgent", agentId });
}
export function sendRenameAgent(agentId: string, name: string): void {
  send({ cmd: "renameAgent", agentId, name });
}

/**
 * §7.5's fork: connectors and the current manifest copied, MCP grants reset to zero.
 *
 * Answered with a refreshed grid plus a notice naming the new slug, so there is nothing here to
 * handle on the way back — the grid IS the answer, and the notice is what says which card is new.
 */
export function sendForkAgent(agentId: string): boolean {
  return send({ cmd: "forkAgent", agentId });
}

/**
 * §6's restore: publish a NEW version pointing at an old manifest.
 *
 * Deliberately not "go back to v3": nothing here moves a pointer backwards, because that would
 * rewrite the history the request was made from and leave the pointer on objects a cleanup is
 * entitled to consider superseded.
 */
export function sendRestoreAgentVersion(agentId: string, version: number): boolean {
  return send({ cmd: "restoreAgentVersion", agentId, version });
}

// --- the Agents tab --------------------------------------------------------
// §7.4: the three reads are answered to THIS client alone, and every mutation above comes back as a
// full grid to the whole workspace. So nothing here optimistically patches local state — a client
// that did would be holding a list whose §5.4 tags were derived from its own guess.

/** The whole grid for the active workspace, with every card's tags already derived. */
export function sendListAgentGrid(): void {
  send({ cmd: "listAgentGrid" });
}

/** Open one agent (§6). Answered to this client only — opening a card is one client's navigation. */
export function sendLoadAgentDetail(agentId: string): void {
  useAgentGridStore.getState().startDetail(agentId);
  send({ cmd: "loadAgentDetail", agentId });
}

/**
 * One version's files, for §6's browser and for the overflow menu's Export.
 *
 * `version` omitted means the agent's current one, which is what the browser opens on. The files come
 * out of the object store rather than off disk, so a replica that has never run this agent answers
 * byte-identically to the one that generated it.
 */
export function sendLoadAgentVersion(agentId: string, version?: number): void {
  useAgentGridStore.getState().startVersion();
  send({ cmd: "loadAgentVersion", agentId, ...(version === undefined ? {} : { version }) });
}

// --- fix loop -------------------------------------------------------------

export function sendEdit(
  agentId: string,
  instruction: string,
  attachments?: readonly CommandAttachment[],
): void {
  send({ cmd: "edit", agentId, instruction, threadId: activeThread(), ...withAttachments(attachments) });
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
/**
 * Stop a run outright. Nothing is left to resume from — that is the difference from a pause.
 *
 * The slot a stuck run holds is process-wide: while it is in flight nothing else can start, be
 * branched, be resumed, or have an edit applied, and two of the server's own refusals tell the
 * user to stop it first. So this is not a nicety beside Pause; it is the way out of that state.
 */
export function sendCancelRun(runId: string): void {
  send({ cmd: "cancelRun", runId });
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
  /** §4's, from the ⊕ picker. Same rule, same resolution point — see `CommandAttachment`. */
  attachments?: readonly CommandAttachment[],
  /** §5.4: this is a re-run of the turn with this id, not a new question. See rerunTurn. */
  regenerateOf?: string,
): void {
  send({
    cmd: "explain", agentId, question, subject, threadId: activeThread(),
    ...(github?.length ? { github } : {}), ...withAttachments(attachments),
    ...(regenerateOf ? { regenerateOf } : {}),
  });
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
/**
 * Answer a blocking confirmation, and say whether the answer left the tab.
 *
 * THIS IS THE ONE COMMAND WHERE SILENCE DECIDES. The run is blocked on a timer, and mcp_bridge's
 * own clock DENIES when it runs out — so a dropped `resolveMcpConfirm` is not a lost click, it is a
 * denial the user believes they prevented. The modal refuses visibly instead.
 */
export function sendResolveMcpConfirm(runId: string, nonce: string, verdict: McpConfirmVerdict): boolean {
  return send({ cmd: "resolveMcpConfirm", runId, nonce, verdict });
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

/**
 * Which rung this workspace is under, and everything it has been under.
 *
 * Sent once per connection from `connect`, not polled: a rung changes when a person or the ladder
 * moves it, which is rare, and every mutation to it re-broadcasts the snapshot anyway.
 */
export function sendLoadEnforcement(): void {
  send({ cmd: "loadEnforcement" });
}

/**
 * Answer the rung. Records a note on the live enforcement and changes nothing else.
 *
 * The one write in the product that is deliberately available to a MEMBER about their own
 * workspace: an appeal that has to go through the party that applied the enforcement is not an
 * appeal.
 */
export function sendAppealEnforcement(note: string): boolean {
  return send({ cmd: "appealEnforcement", note });
}

/**
 * The workspace's audit trail, newest first.
 *
 * Bounded by the server at 500 and defaulted there too, so a caller that wants "the recent ones"
 * sends no limit. Answered to this socket alone.
 */
export function sendListAudit(limit?: number): void {
  send(limit === undefined ? { cmd: "listAudit" } : { cmd: "listAudit", limit });
}

// --- per-agent access ---------------------------------------------------------------------------
//
// `agentId` IS WHATEVER THE CALLER HAS — a uuid from the Agents grid, a slug from the composer —
// and the server resolves both. What comes BACK is always keyed by the uuid, which is what the
// store caches under and what `useCapability` is called with, so the two spellings never meet.

/** Ask for one agent's people, provenance and effective sets. Marks the agent as loading first. */
export function sendLoadAccess(agentId: string): void {
  // MARKED BEFORE THE SEND, so a panel can distinguish "we have not asked" from "nobody has
  // access" for the round trip in between. Those render identically without it, and one of them is
  // alarming.
  useAccessStore.getState().markLoading(agentId);
  send({ cmd: "loadAccess", agentId });
}

/** Ask what can reach this agent without going through Jaroku at all. */
export function sendLoadExposure(agentId: string): void {
  send({ cmd: "loadExposure", agentId });
}

export function sendGrantAccess(opts: {
  agentId: string;
  userId: string;
  capabilities: string[];
  expiresAt?: string | null;
  note?: string | null;
}): void {
  send({ cmd: "grantAccess", ...opts });
}

export function sendModifyGrant(opts: {
  agentId: string;
  userId: string;
  capabilities: string[];
  expiresAt?: string | null;
  note?: string | null;
}): void {
  send({ cmd: "modifyGrant", ...opts });
}

export function sendRevokeGrant(agentId: string, userId: string): void {
  send({ cmd: "revokeGrant", agentId, userId });
}

/** Who is connected. Asked when the Access tab opens, and again on §7's recheck. */
export function sendLoadSessions(agentId: string): void {
  send({ cmd: "loadSessions", agentId });
}

/** §15's rows, out of `audit_log`. Admin-only; the server refuses it without the capability. */
export function sendLoadAccessHistory(agentId: string, limit?: number): void {
  send(limit === undefined ? { cmd: "loadAccessHistory", agentId } : { cmd: "loadAccessHistory", agentId, limit });
}

/** §14.2 — close one socket. It revokes nothing; see the confirmation the caller shows first. */
export function sendEndSession(agentId: string, sessionId: string): void {
  send({ cmd: "endSession", agentId, sessionId });
}

export function sendListMembers(): void {
  send({ cmd: "listMembers" });
}
/**
 * §7.1 — an invitation, addressed or not.
 *
 * THE FIELD IS OMITTED RATHER THAN SENT EMPTY when there is no address. The server reads an absent
 * `email` and an empty one identically, so this is not a correctness requirement — it is what makes
 * the frame say what was meant: `{ cmd, role }` is a link for whoever opens it, and `{ cmd, email:
 * "", role }` is a form somebody left blank, which is the same bytes and a different sentence in
 * every log this passes through.
 */
export function sendInviteMember(
  email: string | null,
  role: string,
  /**
   * §12.2's pre-staged grant, applied atomically when the invitation is accepted.
   *
   * OPTIONAL, AND ABSENT IS WHAT EVERY EXISTING CALL SITE SENDS — the Members panel invites to the
   * workspace and stages nothing, which is what an invitation has always done. The Access tab
   * passes one, because the case it is for is somebody brought in FOR one agent.
   */
  agentGrant?: { agentId: string; capabilities: string[]; note?: string | null } | null,
): void {
  const address = email?.trim();
  const base = address ? { cmd: "inviteMember" as const, email: address, role } : { cmd: "inviteMember" as const, role };
  send(agentGrant ? { ...base, agentGrant } : base);
}

/**
 * §6.5 — give up your own membership.
 *
 * IT CARRIES NOTHING, and that is the safety rather than a convenience: the subject is whoever
 * holds this socket, which the ticket already proved. The server refuses an owner outright — §6.5
 * says ownership is transferred rather than dropped — and answers on the `members` channel, which
 * is where the landing below is driven from.
 */
export function sendLeaveWorkspace(): void {
  send({ cmd: "leaveWorkspace" });
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
  send({ cmd: "startEval", datasetId, agentId, targets, budgetUsd, threadId: activeThread() });
}
export function sendCancelEval(evalId: string): void {
  send({ cmd: "cancelEval", evalId });
}
export function sendLoadEvalResults(evalId: string): void {
  send({ cmd: "loadEvalResults", evalId });
}
/**
 * The eval history, optionally for one dataset, with a growing window.
 *
 * `limit` is the same growing-window idea `loadHistory` uses and for the same reason: this list was
 * `ORDER BY started_at DESC LIMIT 50` with no way to ask past it, so the 51st-oldest comparison was
 * unreachable — including from the dashboard whose whole job is to compare.
 */
export function sendListEvals(datasetId?: string, limit?: number): void {
  send({ cmd: "listEvals", datasetId, ...(limit === undefined ? {} : { limit }) });
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
// THE FOUR MUTATIONS REPORT WHETHER THEY LEFT. Everything about this channel is answered as a full
// snapshot, so a client never patches its own state — which makes a dropped write invisible unless
// the sender says so. The view uses this to write §3.4's notice only about an archive that actually
// happened, rather than about one it hoped for.
export function sendCreateThread(agentId?: string | null, title?: string): boolean {
  return send({ cmd: "createThread", agentId, title });
}

export function sendRenameThread(threadId: string, title: string): boolean {
  return send({ cmd: "renameThread", threadId, title });
}

/** §3.4. Sets a timestamp; there is no delete command, because there is no delete path. */
export function sendArchiveThread(threadId: string): boolean {
  return send({ cmd: "archiveThread", threadId });
}

export function sendRestoreThread(threadId: string): boolean {
  return send({ cmd: "restoreThread", threadId });
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
/**
 * §B.6's finding history for one agent — what has been refused here, and what was pushed anyway.
 *
 * The rows have always been written, with `overridden` and who did it, and nothing could read them:
 * "has anybody pushed past a secret scan on this agent" was a question only SQL could answer.
 */
export function sendListScanFindings(agentId: string): void {
  send({ cmd: "listScanFindings", agentId });
}

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
/**
 * §B.1.2's opt-in: run this dataset as a check on every pull request, and decide whose money it may
 * spend.
 *
 * BOTH FIELDS OPTIONAL AND THE OMISSION IS MEANINGFUL — the server patches field by field. Passing
 * `datasetId: null` turns checks off and keeps the policy; passing only a policy leaves the dataset
 * alone. A sender that always sent both would make every policy change a re-statement of the
 * dataset, which is the shape that loses one of them under two tabs.
 */
export function sendSetAgentCiConfig(
  agentId: string,
  patch: { datasetId?: string | null; policy?: GithubProviderPolicy },
): void {
  send({ cmd: "setAgentCiConfig", agentId, ...patch });
}

export function sendGenerateGithubMessage(agentId: string): void {
  useGithubStore.getState().startGenerating(agentId);
  send({ cmd: "generateGithubMessage", agentId });
}

/** §3.4's commit box. `push` false is refused server-side — there is no local repository here. */
export function sendCommitGithub(agentId: string, message: string, push = true): void {
  send({ cmd: "commitGithub", agentId, message, push });
}

// --- the Inbox: one read and five mutations (§6.4) ---------------------------------------------
//
// EVERY MUTATION RETURNS WHETHER IT LEFT THE TAB, which is the lesson §3.4's archive notice taught
// on the channel next door: a toast claiming forty items were dismissed over a socket that silently
// dropped the command is a promise the product did not keep. The board's own actions check.

/**
 * Whether the snapshot now in flight is a NEXT PAGE rather than a fresh list.
 *
 * ON THE CLIENT RATHER THAN IN THE PAYLOAD, because the server sends the same shape either way
 * — a page is a page — and only the caller knows which of the two it asked for. A flag rather
 * than a queue because there is only ever one list on screen: a second `load more` while the
 * first is in flight is the same request, and the guard in `sendListWork` is what makes it a
 * no-op instead of two appends of the same rows.
 */
let pendingWorkPage = false;

/**
 * One page of the work list, under the filters the store is holding.
 *
 * THE FILTERS COME FROM THE STORE rather than from the caller, for the reason `sendGetActivity`
 * reads the range there: "which list am I looking at" is a fact about the app's state rather
 * than an argument a row knows, and every caller forgetting one is how two surfaces end up
 * describing different lists.
 */
export function sendListWork(opts: { more?: boolean } = {}): void {
  const s = useWorkStore.getState();
  if (opts.more && (!s.nextCursor || pendingWorkPage)) return;
  pendingWorkPage = opts.more === true;
  send({
    cmd: "listWork",
    scope: s.filters.scope,
    status: s.filters.status ?? undefined,
    agentId: s.filters.agentId ?? undefined,
    cursor: opts.more ? s.nextCursor : null,
  });
}

export function sendListFleet(): void {
  send({ cmd: "listFleet" });
}

/** One job in full. The panel opens on the id first, so it is never a blank slide-over. */
export function sendLoadWorkItem(itemId: string): void {
  useWorkStore.getState().openingItem(itemId);
  send({ cmd: "loadWorkItem", itemId });
}

/**
 * `clientRef` IS §19's OPTIMISTIC HANDLE and it is optional here for one reason: a caller that does
 * not draw a row does not need one. The composer always passes it; a future caller that dispatches
 * without a placeholder gets the old behaviour, where the answer joins the list as an ordinary
 * arrival.
 */
export function sendDispatchWork(
  agentId: string,
  input: string,
  clientRef?: string,
  /**
   * The operate thread this command was given in — Part 3 §6.
   *
   * IT IS A NOTE ABOUT WHERE THE JOB CAME FROM, NOT A ROUTE. §6: "A command in an operate thread is
   * an ordinary `dispatchWork`. Same command, same store, same run token, same trace, same work
   * item." So this is the same send the Cockpit composer makes, through the same pre-flight gate,
   * with one more field — and absent is the ordinary case, because a job dispatched from the fleet
   * strip did not happen in a conversation.
   */
  threadId?: string,
): boolean {
  return send({ cmd: "dispatchWork", agentId, input, clientRef, ...(threadId ? { threadId } : {}) });
}

/**
 * A question about what an agent has done, answered from the record — Part 3 §7.
 *
 * NOT `sendExplain`, and the difference is §3 rather than tidiness: `explain` grounds its answer in
 * the agent's CODE (the step you selected, the prompt on disk) and this grounds its answer in the
 * RECORD. A question about what happened must not be answerable from what the agent is capable of.
 *
 * It answers on the REPLY channel, which the two do share — prose streaming into a conversation is
 * something this product already does exactly one way.
 */
export function sendAskRecord(agentId: string, question: string, threadId?: string): boolean {
  return send({ cmd: "askRecord", agentId, question, ...(threadId ? { threadId } : {}) });
}

export function sendCancelWork(itemId: string): boolean {
  return send({ cmd: "cancelWork", itemId });
}

export function sendRetryWork(itemId: string): boolean {
  return send({ cmd: "retryWork", itemId });
}

/** §9's Reconnect. The caller warns about the restart BEFORE this is sent, never after. */
export function sendReconnectAgent(deploymentId: string): boolean {
  return send({ cmd: "reconnectAgent", deploymentId });
}

/**
 * One window of a container's runtime log.
 *
 * THE CURSOR IS A TIMESTAMP AND IS PASSED BACK EXACTLY AS IT ARRIVED — never rebuilt from the
 * last line on screen. Railway's log query answers with the most recent N lines of a stream that
 * is still being written, so a cursor derived from what is rendered walks backwards through a
 * moving window. See `DeployOps.runtimeLogs`, which is where that bug is argued at length.
 */
export function sendLoadAgentLogs(deploymentId: string, since?: string | null): void {
  send({ cmd: "loadAgentLogs", deploymentId, since: since ?? null });
}

export function sendKillAgent(deploymentId: string): boolean {
  return send({ cmd: "killAgent", deploymentId });
}

/** Ask for the board again. A full-snapshot channel's way of checking it is not stale. */
export function sendListInbox(): void {
  send({ cmd: "listInbox" });
}

/**
 * §5.5's `getActivity`: ask for one window, receive six answers.
 *
 * THE RANGE COMES FROM THE STORE rather than from the caller, for the reason `activeThread()` above
 * is read here rather than passed: "which window am I looking at" is a fact about the app's state,
 * not an argument a card knows — and every caller forgetting it is exactly how six modules end up
 * describing different windows.
 */
export function sendGetActivity(): void {
  const { range, custom } = useActivityStore.getState();
  send({ cmd: "getActivity", range, from: custom?.from, to: custom?.to });
}

/**
 * One page of §5's feed, after the first.
 *
 * THE CURSOR IS PASSED BACK EXACTLY AS IT ARRIVED, never rebuilt from the last row on screen. A
 * virtualiser can have rows mounted that the store has since replaced, and a cursor derived from
 * what is rendered rather than from what was received is a cursor for a page boundary that may not
 * exist any more.
 */
export function sendGetActivityFeed(filters?: {
  kinds?: string[];
  agentId?: string | null;
  actorUserId?: string | null;
}): void {
  const s = useActivityStore.getState();
  if (s.feedLoading) return;
  s.feedRequested();
  send({
    cmd: "getActivityFeed",
    range: s.range,
    from: s.custom?.from,
    to: s.custom?.to,
    cursor: s.feedNext ?? undefined,
    kinds: filters?.kinds,
    agentId: filters?.agentId ?? undefined,
    actorUserId: filters?.actorUserId ?? undefined,
  });
}

export function sendResolveInboxItem(itemId: string): boolean {
  return send({ cmd: "resolveInboxItem", itemId });
}

/**
 * §2.3: answer a memory proposal.
 *
 * A SENDER OF ITS OWN rather than a fourth bulk verb, matching the command. The decision is
 * written onto the row and the sweep is what resolves the card, so this reports only whether it
 * SENT — the board arrives on the channel like every other change to it.
 */
export function sendAnswerMemoryProposal(itemId: string, decision: "saved" | "rejected"): boolean {
  return send({ cmd: "answerMemoryProposal", itemId, decision });
}

export function sendDismissInboxItem(itemId: string): boolean {
  return send({ cmd: "dismissInboxItem", itemId });
}

/** §3's three durations, by name. The server decides what tomorrow means — see `snoozeUntil`. */
export function sendSnoozeInboxItem(itemId: string, duration: SnoozeDuration): boolean {
  return send({ cmd: "snoozeInboxItem", itemId, duration });
}

/**
 * §3's bulk: a shift-clicked range, or a column's overflow menu.
 *
 * ONE COMMAND FOR ONE AND FOR FORTY, because the server's path is the same one — and because a
 * separate single-item command would be a second place the undo token has to be handled.
 */
export function sendBulkInboxAction(
  action: InboxAction,
  itemIds: string[],
  duration?: SnoozeDuration,
): boolean {
  return send({ cmd: "bulkInboxAction", action, itemIds, duration });
}

/** §3's undo, by the token the toast was handed. The client never names the items. */
export function sendUndoInboxAction(token: string): boolean {
  return send({ cmd: "undoInboxAction", token });
}

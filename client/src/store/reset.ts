// Emptying every store, because a workspace switch is a tenant boundary the UI has to honour.
//
// THE FAILURE THIS PREVENTS. The server can be flawless — every query scoped, every broadcast
// filtered, RLS behind all of it — and the app can still show one workspace's runs under
// another workspace's name, because the browser kept them. A `traceStore` still holding the
// previous workspace's step payloads after a switch is a cross-tenant leak in the UI, and it
// is not a rendering bug: those rows contain user email content, database output and Slack
// messages, which is the regulated data Session 8's retention rules are about.
//
// So: switching workspace resets everything and opens a NEW socket. Not a message on the
// existing one, which would have to reason about the reads already in flight on it — the
// workspace a socket acts in was decided by the ticket it was opened with, and there is no
// message that could change that.
//
// HOW THE RESET WORKS, and why there is no per-store code. Zustand's `getInitialState()`
// returns the exact object the store was created with — data fields and action functions
// together — so `setState(initial, true)` restores it completely. A hand-written `reset()` per
// store would be eleven places to forget a field, and forgetting one is invisible: the store
// looks empty in the devtools panel somebody happens to open, and the field nobody looked at
// still holds the last tenant's data.

import { useActivityStore } from "./activityStore.ts";
import { useAgentGridStore } from "./agentGridStore.ts";
import { useAuditStore } from "./auditStore.ts";
import { useBillingStore } from "./billingStore.ts";
import { useBuildStore } from "./buildStore.ts";
import { useChatStore } from "./chatStore.ts";
import { useConnectionStore } from "./connectionStore.ts";
import { useDeployStore } from "./deployStore.ts";
import { useDiagnosticsStore } from "./diagnosticsStore.ts";
import { useEnforcementStore } from "./enforcementStore.ts";
import { useEntitlementStore } from "./entitlementStore.ts";
import { useEvalStore } from "./evalStore.ts";
import { useGithubStore } from "./githubStore.ts";
import { useInboxStore } from "./inboxStore.ts";
import { useGraphStore } from "./graphStore.ts";
import { useMcpStore } from "./mcpStore.ts";
import { useMemberStore } from "./memberStore.ts";
import { useProviderStore } from "./providerStore.ts";
import { useSecretsStore } from "./secretsStore.ts";
import { useThreadStore } from "./threadStore.ts";
import { useTraceStore } from "./traceStore.ts";
import { forgetElevation } from "../lib/secrets.ts";

/** Enough of a zustand store for this file. Avoids importing its generics for one call. */
interface Resettable {
  getInitialState: () => unknown;
  setState: (state: never, replace: true) => void;
}

/**
 * Every store that holds WORKSPACE DATA.
 *
 * Two are deliberately absent, and `resetAll.test.ts` asserts that the list of exclusions is
 * exactly these two rather than "whatever was forgotten":
 *
 *   `sessionStore` — it is the thing performing the switch. Resetting it mid-switch would
 *   throw away the workspace list and the user that the new socket is about to be opened with.
 *
 *   `uiStore` — it holds no workspace data at all: which tab is showing, whether the composer
 *   is in Test mode, and the per-INSTALL onboarding progress read from localStorage. Resetting
 *   it would restore the onboarding flags captured at page load, so somebody who finished
 *   onboarding and then switched workspace would be sent back to the welcome screen.
 */
export const WORKSPACE_STORES: Record<string, Resettable> = {
  // A month of one workspace's operations in one object: what it spent and on which models, which of
  // its agents are expensive and which are flaky, what it shipped and what failed, and which of its
  // high-impact tool calls somebody refused. Held across a switch it would put one tenant's whole
  // operating picture under another tenant's name — and the leaderboard's rows would offer to
  // navigate to agents the new workspace cannot see.
  //
  // THE RANGE ITSELF IS NOT IN HERE, and that is not an oversight: it lives in `localStorage`, keyed
  // by workspace, because it is a per-person view preference rather than workspace data — the same
  // argument `uiStore`'s exclusion note makes. Resetting the store restores its default and the view
  // reads the remembered one for the workspace being switched TO.
  activityStore: useActivityStore as unknown as Resettable,
  // The Agents grid, and whichever agent record is open in the detail view. Every card carries the
  // workspace's own agent names, the last error one of its runs produced, and — most of all — the
  // NAMES of the credentials each agent is missing. Held across a switch it would show one tenant's
  // agents under another tenant's name, and the `+ New thread` button on each card would offer to
  // start work against an agent the new workspace cannot see.
  agentGridStore: useAgentGridStore as unknown as Resettable,
  // Who revealed which credential, who overrode a secret-scan refusal, who removed whom. The most
  // person-identifying list in the client after the member list, and for the same reason it is here:
  // held across a switch it would show one workspace's decisions under another workspace's name.
  auditStore: useAuditStore as unknown as Resettable,
  // A spend figure held across a switch is one workspace's invoice shown under another's name —
  // the same class of leak as a trace row, and rather harder to explain afterwards.
  billingStore: useBillingStore as unknown as Resettable,
  buildStore: useBuildStore as unknown as Resettable,
  // What is waiting on somebody in THIS workspace, which is a map of everything currently wrong in
  // it: the NAMES of the credentials its agents are missing, which of its MCP servers cannot
  // authenticate, which deploys failed and with what error. Held across a switch it would show one
  // tenant's live weaknesses under another tenant's name — and the sidebar badge, which is drawn
  // from the same counts, would be reporting the previous workspace's blocked work.
  inboxStore: useInboxStore as unknown as Resettable,
  chatStore: useChatStore as unknown as Resettable,
  // Which accounts a workspace has connected, and whose mailbox each points at. An account label
  // held across a switch would show one tenant's email address under another tenant's name, and
  // the "Reconnect" button beside it would start a flow in the wrong workspace.
  connectionStore: useConnectionStore as unknown as Resettable,
  deployStore: useDeployStore as unknown as Resettable,
  // §B.3's squiggles, keyed by agent uuid and path. It looks like the one store here that holds
  // nothing worth clearing — a diagnostic is a rule number and a line — but the KEY is a path out
  // of another tenant's project and the message quotes the line it is about, which is source. And
  // an agent uuid from the old workspace can never be asked for again, so nothing would ever
  // overwrite these: they would sit in the store for the life of the tab.
  diagnosticsStore: useDiagnosticsStore as unknown as Resettable,
  // The last thing a tier refused, which is a claim about ONE workspace's limits and its usage.
  // Carried across a switch it would say "3 of 3 agents used on the free plan" over a workspace on
  // Team with none — a number that is wrong, attributed to the wrong tenant, and sitting beside an
  // Upgrade button that would charge the wrong account.
  entitlementStore: useEntitlementStore as unknown as Resettable,
  // Which rung a workspace is under and what it said about it. The reason it must not survive a
  // switch is the loudest one on this list: a strip reading "this workspace is suspended" over the
  // workspace you have just moved to would be the app accusing the wrong tenant.
  enforcementStore: useEnforcementStore as unknown as Resettable,
  evalStore: useEvalStore as unknown as Resettable,
  // Which repository each agent's code goes to, under whose GitHub account, and every commit
  // message on the way. Held across a switch it would name one tenant's private repositories
  // under another tenant's agent — and the Push button beside it would be pointed at them.
  githubStore: useGithubStore as unknown as Resettable,
  graphStore: useGraphStore as unknown as Resettable,
  mcpStore: useMcpStore as unknown as Resettable,
  memberStore: useMemberStore as unknown as Resettable,
  providerStore: useProviderStore as unknown as Resettable,
  // The credential list, the health counts and — most of all — whether this session is elevated.
  // Carrying elevation across a workspace switch would be the worst version of this leak: not one
  // tenant's rows shown under another's name, but the gate on the second workspace standing open
  // because somebody unlocked the first.
  secretsStore: useSecretsStore as unknown as Resettable,
  // Every build session in the workspace: what it was called, what it left unresolved, what it cost,
  // and the last thing somebody typed into it. The preview line alone is a person's own words — held
  // across a switch it would show one tenant's questions under another tenant's name, and the row
  // beside it would offer to open a thread the new workspace cannot see.
  threadStore: useThreadStore as unknown as Resettable,
  traceStore: useTraceStore as unknown as Resettable,
};

/**
 * Stores that hold nothing a workspace owns. Named, so the omission is a decision.
 *
 * `hostStore` is the third, and the argument is a different one from the other two. It holds what
 * the process that started this application says about the backend it supervises: which phase it
 * is in, why it stopped, where its log is. None of that belongs to a workspace, a session or an
 * account — it belongs to the MACHINE, and it is equally true a millisecond after a switch as a
 * millisecond before. Resetting it would blank a failure notice at the exact moment somebody was
 * reading one, and would do so on the switch that failure had just made impossible.
 */
export const NOT_WORKSPACE_SCOPED = ["sessionStore", "uiStore", "hostStore"] as const;

/**
 * Empty every store that holds a workspace's data.
 *
 * AND THE ONE PIECE OF WORKSPACE STATE THAT IS NOT IN A STORE. The elevation token lives in a
 * module variable in `lib/secrets.ts` rather than in `secretsStore`, deliberately — a store is what
 * devtools serialise and error reporters attach — which means `getInitialState()` cannot reach it
 * and the loop above walks straight past it.
 *
 * The server refuses it either way: an elevation is scoped to the workspace it was issued for, so
 * the old workspace's token matches nothing in the new one. What it costs to leave behind is a tab
 * that believes it holds an elevation it cannot use — `hasElevationToken()` is what decides whether
 * to rejoin the session's existing elevation, so a session already unlocked in the workspace being
 * switched TO would render its content and 403 on every request until the next poll noticed.
 */
export function resetWorkspaceStores(): void {
  for (const store of Object.values(WORKSPACE_STORES)) {
    store.setState(store.getInitialState() as never, true);
  }
  forgetElevation();
}

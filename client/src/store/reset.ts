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

import { useAuditStore } from "./auditStore.ts";
import { useBillingStore } from "./billingStore.ts";
import { useBuildStore } from "./buildStore.ts";
import { useChatStore } from "./chatStore.ts";
import { useConnectionStore } from "./connectionStore.ts";
import { useDeployStore } from "./deployStore.ts";
import { useDiagnosticsStore } from "./diagnosticsStore.ts";
import { useEnforcementStore } from "./enforcementStore.ts";
import { useEvalStore } from "./evalStore.ts";
import { useGithubStore } from "./githubStore.ts";
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
  // Who revealed which credential, who overrode a secret-scan refusal, who removed whom. The most
  // person-identifying list in the client after the member list, and for the same reason it is here:
  // held across a switch it would show one workspace's decisions under another workspace's name.
  auditStore: useAuditStore as unknown as Resettable,
  // A spend figure held across a switch is one workspace's invoice shown under another's name —
  // the same class of leak as a trace row, and rather harder to explain afterwards.
  billingStore: useBillingStore as unknown as Resettable,
  buildStore: useBuildStore as unknown as Resettable,
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

/** Stores that hold nothing a workspace owns. Named, so the omission is a decision. */
export const NOT_WORKSPACE_SCOPED = ["sessionStore", "uiStore"] as const;

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

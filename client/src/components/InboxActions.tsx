// What a card's actions actually DO, and the one rule that decides all of it.
//
// §6.4: "plus the inline resolve commands, which REUSE EXISTING COMMANDS — `setSecret`, `deploy`,
// `rediscoverMcpServer`, `setMcpToolImpact` — rather than reimplementing them behind new names."
// Every function below is therefore a call into something that already exists, and there is no path
// in this file that writes a credential, starts a deploy or changes a grant by any route other than
// the one the rest of the product uses.
//
// WHY THAT RULE MATTERS MORE THAN IT LOOKS. A second way to set a credential is a second thing that
// has to be elevation-gated, audited, redacted and refused correctly when the workspace is
// suspended — and the second one is the one that forgets. Setting a credential from a card goes
// through `createSecret`, which means it goes through the same guarded route, the same audit row and
// the same vault write as setting it from the Secrets tab. What the card contributes is that you did
// not have to go there.
//
// AND THE PAYOFF §4.5 IS AFTER: "a user should be able to clear an entire Inbox without leaving the
// Inbox. That is the whole design goal of this surface. Navigation is the fallback, not the path."
// So an action either resolves the item where it stands, or — when it genuinely cannot — takes
// somebody to where it can be, and those two are visibly different things rather than one button
// that sometimes navigates.

import { createSecret } from "../lib/secrets.ts";
import { openAgentDetail } from "../lib/agentNav.ts";
import {
  sendDeploy,
  sendListInbox,
  sendLoadDeployLogs,
  sendLoadRun,
  sendRediscoverMcpServer,
  sendRestoreAgent,
  sendSetMcpToolImpact,
  sendSetSpendCeiling,
} from "../lib/socket.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { can, canRun, ROUTE_CAPABILITY } from "../lib/capabilities.ts";
import type { InboxActionName, InboxItemView } from "../types.ts";

/** What a control says, so the icon it wears has a name a screen reader can read (§7). */
export const ACTION_LABEL: Record<InboxActionName, string> = {
  set_secret: "Set this credential",
  open_agent: "Open the agent",
  set_mcp_credential: "Set this server's credential",
  rediscover: "Try this server again",
  remove_server: "Remove this server",
  view_logs: "View the build log",
  retry_deploy: "Deploy again",
  cancel_deploy: "Cancel this deployment",
  raise_ceiling: "Raise the ceiling",
  view_results: "View the results",
  open_latest_failure: "Open the latest failure",
  view_all_failures: "View every failure",
  dismiss_all: "Dismiss all of them",
  redeploy: "Deploy the current version",
  view_diff: "See what changed",
  open_comparison: "Open the comparison",
  export_results: "Export the results",
  view_usage: "View usage",
  set_budget: "Set a budget",
  view_evidence: "View the evidence",
  save_memory: "Save this",
  reject_memory: "Reject this",
  enable_gate: "Turn the confirmation gate on",
  remove_grant: "Remove the grant",
  open_invites: "Open invitations",
  open_members: "Open the members list",
  restore_agent: "Bring it back",
  open_providers: "Add a provider key",
  new_agent: "Describe an agent",
  dismiss: "Dismiss",
};

/**
 * Actions that RESOLVE where they stand, and actions that navigate.
 *
 * TWO DIFFERENT PROMISES, and a surface whose whole goal is that a board can be cleared without
 * leaving it has to keep them apart. An inline action is one this card can complete; a navigating
 * one is the fallback, and the card renders it as such.
 */
export const INLINE_ACTIONS = new Set<InboxActionName>([
  "set_secret", "set_mcp_credential", "rediscover", "retry_deploy", "redeploy",
  "raise_ceiling", "enable_gate", "remove_grant", "save_memory", "reject_memory",
]);

/** Actions that need somewhere to type before they can run. §4.5's "the form itself". */
export const FORM_ACTIONS = new Set<InboxActionName>(["set_secret", "set_mcp_credential", "raise_ceiling"]);

/**
 * §8.2, on the Inbox — which command each action actually sends.
 *
 * THE INBOX IS THE ONE SURFACE WHERE §8.2's CHECKLIST DOES NOT REACH, and it is the surface where
 * a missed guard is most likely: every card here OFFERS a fix, the fixes come from five different
 * subsystems, and the card does not otherwise care which. "Redeploy" on a failed-deploy card is
 * `deploy`; "Set the credential" on a missing-secret card is `POST /v1/secrets`; "Raise the
 * ceiling" is `setSpendCeiling`, which is the owner's. Nothing about the cards says so.
 *
 * A TABLE RATHER THAN A CHECK PER ACTION, so `InboxCardActions` filters what it offers through one
 * lookup and a new action added later fails loudly — an unmapped name answers `undefined`, which
 * `canRun` refuses, so the affordance is absent until somebody decides who may use it. Defaulting
 * the other way would let a new fix arrive ungated.
 *
 * THE ACTIONS NOT IN HERE ARE MEMBER-LEVEL ON PURPOSE: dismiss, snooze and the two memory verbs
 * are `agent:write`, which every member holds, and two of them change one person's own board.
 * `open_*` and `new_agent` are navigations that send nothing at all.
 */
export const ACTION_COMMAND: Partial<Record<InboxActionName, string>> = {
  set_secret: "__route:secretWrite",
  set_mcp_credential: "setMcpServerAuth",
  rediscover: "rediscoverMcpServer",
  retry_deploy: "deploy",
  redeploy: "deploy",
  raise_ceiling: "setSpendCeiling",
  enable_gate: "setMcpToolImpact",
  remove_grant: "setMcpToolImpact",
};

/**
 * The subset of a card's actions this account may actually take.
 *
 * A HOOK RATHER THAN A PURE FILTER BECAUSE THE ROLE MOVES. `revalidateAll` updates a socket's role
 * in place once a minute without reconnecting, so a list computed once at mount would keep
 * offering a demoted admin the fixes they can no longer apply — on a board whose whole promise is
 * that pressing the button clears the card.
 *
 * AN ACTION WITH NO ENTRY IN `ACTION_COMMAND` IS ALLOWED, and that is the opposite default from
 * `canRun`'s. The table lists what needs a capability; everything else is a navigation, a snooze,
 * a dismissal or a resolve — none of which send a gated command, and all of which every member
 * holds. Defaulting those to refused would empty the board for members.
 */
export function useAllowedActions(actions: readonly InboxActionName[]): InboxActionName[] {
  const role = useSessionStore((s) => s.role());
  return actions.filter((a) => {
    const key = ACTION_COMMAND[a];
    if (key === undefined) return true;
    const routeKey = key.startsWith("__route:") ? key.slice("__route:".length) : null;
    if (routeKey) {
      const capability = ROUTE_CAPABILITY[routeKey];
      return capability === undefined ? false : can(role, capability);
    }
    return canRun(role, key);
  });
}

const str = (item: InboxItemView, key: string): string =>
  typeof item.payload[key] === "string" ? (item.payload[key] as string) : "";

const num = (item: InboxItemView, key: string): number | null =>
  typeof item.payload[key] === "number" ? (item.payload[key] as number) : null;

/**
 * Run an action that needs no input.
 *
 * RETURNS WHETHER IT LEFT THE TAB, which every mutation in this client now does — the lesson §3.4's
 * archive notice taught: a card that said "deploying…" over a socket that had silently dropped the
 * command is a promise the product did not keep.
 *
 * IT DOES NOT RESOLVE THE ITEM. Nothing here marks anything settled: the fix goes out, and the next
 * sweep notices the problem is gone. That is Law 2 rather than an omission — an item that left
 * because a button was pressed is an item that stays when the same fix arrives by another door.
 */
export function runAction(action: InboxActionName, item: InboxItemView): boolean {
  switch (action) {
    // --- inline, no input -----------------------------------------------------------------------
    case "rediscover":
      // THE COMMAND THAT ALREADY EXISTS. A failed refresh still never destroys a working tool list —
      // v0.2.0's rule, and it holds here because this is the same call the MCP panel makes.
      sendRediscoverMcpServer(item.subject_id ?? "");
      return true;
    case "retry_deploy":
    case "redeploy": {
      const agentId = str(item, "agent_slug");
      const provider = str(item, "provider");
      const model = str(item, "model");
      // WITH THE PROVIDER AND MODEL THE LAST DEPLOY USED, which the server puts on the payload
      // because it has the deployment row and this card does not. That is what "redeploy" honestly
      // means — put the current version out the way this agent was already put out — and it is the
      // reason these two fields are on the payload at all.
      //
      // NOTHING IS INVENTED WHEN THEY ARE ABSENT. A card that guessed a provider would be a second,
      // weaker way to put something on the internet, so a payload without them falls back to the
      // Deploy panel, where the choice is made deliberately.
      if (!agentId || !provider || !model) {
        if (agentId) openAgentDetail(agentId);
        return Boolean(agentId);
      }
      // `deploy` UNCHANGED, which means the plan gate, the credential check and the health gate all
      // still happen — it is the command the Deploy panel sends.
      const envKeys = Array.isArray(item.payload["env_keys"]) ? (item.payload["env_keys"] as string[]) : [];
      sendDeploy({ agentId, provider, model, envKeys });
      return true;
    }
    case "remove_grant": {
      // Lowering a tool's impact is the existing command; removing the GRANT itself is the agent's
      // own capability list, which is a decision about the agent rather than about this card — so
      // this offers the one it can do here and the overflow's `open_agent` is the other half.
      const tools = Array.isArray(item.payload["tools"]) ? (item.payload["tools"] as string[]) : [];
      const first = tools[0];
      if (!first) return false;
      const [serverId, toolName] = first.split("/");
      if (!serverId || !toolName) return false;
      sendSetMcpToolImpact(serverId, toolName, "low");
      return true;
    }

    // --- navigation: the fallback, not the path ---------------------------------------------------
    case "open_agent":
    case "view_diff": {
      const slug = str(item, "agent_slug");
      if (!slug) return false;
      openAgentDetail(slug);
      return true;
    }
    case "restore_agent": {
      const slug = str(item, "agent_slug");
      if (!slug) return false;
      sendRestoreAgent(slug);
      return true;
    }
    case "open_latest_failure": {
      const runs = Array.isArray(item.payload["run_ids"]) ? (item.payload["run_ids"] as string[]) : [];
      const latest = runs[0];
      if (!latest) return false;
      // OPENING THE TRACE IS WHAT RESOLVES THIS ITEM, and it resolves it because the trace was read
      // rather than because this button was pressed — `loadRun` is the one path into a trace from any
      // of the four surfaces that offer one, and the server stamps the review there.
      sendLoadRun(latest);
      useUiStore.getState().closeNav();
      return true;
    }
    case "view_logs":
      // The log is fetched onto the deploy channel and the Deploy tab is where it renders. Asking
      // for it before switching means the panel has it by the time it is looked at.
      sendLoadDeployLogs(item.subject_id ?? "");
      useUiStore.getState().setRightTab("deploy");
      useUiStore.getState().closeNav();
      return true;
    case "open_comparison":
    case "view_results":
    case "export_results":
      useUiStore.getState().setRightTab("evals");
      // The Evals surface owns all three, and opening the comparison there is what stamps the item
      // as read — from the Evals tab exactly as from here, which is Law 2's whole point.
      useUiStore.getState().closeNav();
      return true;
    case "view_usage":
    case "set_budget":
      // The Usage panel is a TAB on the right rather than a workspace overlay, so this is a tab
      // switch and a return to the three panes — the same two calls every other navigating action
      // here makes.
      useUiStore.getState().setRightTab("usage");
      useUiStore.getState().closeNav();
      return true;
    case "open_invites":
    case "open_members":
      useUiStore.getState().openWorkspacePanel("members");
      return true;
    case "open_providers":
      // Provider credentials live in the Secrets tab, which is where the one guarded write to a
      // credential is — the same route `submitCredential` below posts to.
      useUiStore.getState().setRightTab("secrets");
      useUiStore.getState().closeNav();
      return true;
    case "new_agent":
      // The one composer, and the one place a brief is submitted from. This opens it rather than
      // sending anything, for the reason the Threads empty state does the same.
      useUiStore.getState().closeNav();
      useUiStore.getState().focusChat();
      return true;
    default:
      return false;
  }
}

/**
 * Set the credential this card names, from the card.
 *
 * THROUGH `createSecret`, WHICH IS THE GUARDED HTTP ROUTE THE SECRETS TAB USES. That is the whole of
 * §6.4's reuse rule applied to the one action that touches a credential: the elevation gate, the
 * audit row, the vault write and the refusal when the workspace is suspended are all the same ones,
 * because it is the same route.
 *
 * THE VALUE NEVER ENTERS A STORE. It is held in the component's own state for as long as the field is
 * on screen and handed straight to the request — the same discipline `revealSecret`'s caller keeps,
 * and the reason there is no `useState` for it anywhere near the item.
 */
export async function submitCredential(name: string, value: string): Promise<string | null> {
  try {
    await createSecret({ name, value, kind: "custom" });
    // ASK FOR THE BOARD AGAIN rather than resolving the card here. The sweep is what notices the
    // credential exists; this only makes it notice sooner than the next tick.
    sendListInbox();
    return null;
  } catch (err) {
    return (err as Error)?.message ?? "that could not be saved";
  }
}

/** Raise the workspace's ceiling from the card. `setSpendCeiling` is the existing command. */
export function submitCeiling(item: InboxItemView, usd: number): boolean {
  const hit = num(item, "ceiling_usd");
  // A ceiling at or below the one that was crossed would leave the item exactly as it is, and the
  // card would appear to do nothing. Refused where somebody can see why.
  if (hit !== null && usd <= hit) return false;
  sendSetSpendCeiling(usd);
  return true;
}

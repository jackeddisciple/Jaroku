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
  sendAnswerMemoryProposal,
  sendBulkInboxAction,
  sendCancelDeploy,
  sendDeploy,
  sendListInbox,
  sendLoadDeployLogs,
  sendLoadRun,
  sendRediscoverMcpServer,
  sendRemoveMcpServer,
  sendRestoreAgent,
  sendSetMcpToolImpact,
  sendSetSpendCeiling,
} from "../lib/socket.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useInboxStore } from "../store/inboxStore.ts";
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
  // "TURN THE CONFIRMATION GATE ON" WAS A PROMISE NO COMMAND COULD KEEP. The gate is off because
  // a line in the agent's OWN SOURCE turned it off — `os.environ["JAROKU_MCP_CONFIRM"] = "skip"`,
  // which is what `disablesConfirmGate` detects — so nothing on this card can put it back. Only an
  // edit to that file can, and the label now says where to make it. Renaming it is the fix rather
  // than a retreat from one: the old label was the reason the button read as broken instead of as
  // absent, and §4.5 is explicit that navigation is a legitimate fallback when a card genuinely
  // cannot complete a fix — what it must not do is look like an inline one.
  enable_gate: "Open the code that turns it off",
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
  "raise_ceiling", "remove_grant", "save_memory", "reject_memory",
  // `cancel_deploy` and `remove_server` complete where they stand — both send the same command
  // their own panel sends — and `dismiss_all` clears a whole type off this board without leaving
  // it, which is the surface's stated goal in one press. `enable_gate` has LEFT this set: it
  // navigates now, because the gate is off by a line in the agent's own code and nothing but an
  // edit can put it back. See its label.
  "cancel_deploy", "remove_server", "dismiss_all",
]);

/**
 * Actions the registry may offer and this client cannot yet run.
 *
 * DECLARED RATHER THAN LEFT TO FALL THROUGH, and that is the whole point of it existing. Eight
 * action names had no case in `runAction`, so pressing them did nothing at all — no state change,
 * no toast, no error — and the overflow closed either way, which reads as confirmation. A silent
 * no-op is the worst failure shape available here, because the surrounding design (a menu that
 * closes, a sweep that resolves cards on its own schedule) makes "nothing visible happened"
 * indistinguishable from "it worked and the board will catch up."
 *
 * So an action that cannot run is not RENDERED. `useAllowedActions` filters it out exactly as it
 * filters one the role may not take, and the card falls through to its next-best action — which is
 * what keeps a board clearable at every role and is now what keeps it honest about an unfinished
 * one.
 *
 * IT IS EMPTY, AND THAT IS THE POINT OF LEAVING IT HERE. It held `save_memory` and `reject_memory`
 * until `answerMemoryProposal` existed; every name in the vocabulary now runs. The set stays
 * because the next action declared ahead of its command needs somewhere honest to sit, and the
 * alternative — leaving it out of the dispatch and letting it fall through — is the exact defect
 * this whole mechanism exists to prevent.
 */
export const UNIMPLEMENTED_ACTIONS = new Set<InboxActionName>([]);

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
  // The two memory verbs are member-level, like dismiss and snooze: answering a proposal about an
  // agent somebody can write to is the workspace's judgement rather than an admin's.
  save_memory: "answerMemoryProposal",
  reject_memory: "answerMemoryProposal",
  remove_grant: "setMcpToolImpact",
  // THE THREE THAT WERE MISSING FROM THIS TABLE AS WELL AS FROM THE DISPATCH, and their absence
  // here was the more dangerous half: a name absent from this map is treated as ungated-and-allowed
  // by `useAllowedActions`, so cancelling a deployment and removing an MCP server were offered to
  // every member — they simply happened to do nothing, which is what stopped that being a defect.
  // Both are the same command their own panel sends and are gated the same way it is.
  cancel_deploy: "cancelDeploy",
  remove_server: "removeMcpServer",
  // `dismiss_all` is deliberately NOT here, with `dismiss` and `snooze`: a dismissal is one
  // person's own board and changes nothing anybody else sees, which is why every member holds it.
  // `enable_gate` has left this table because it no longer sends a command at all — it navigates.
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
    // AN ACTION THIS CLIENT CANNOT RUN IS NOT OFFERED, which is the same answer as a capability
    // the role does not hold and for the same reason: the card falls through to its next-best
    // action and stays clearable, instead of rendering a control that closes a menu and does
    // nothing. See `UNIMPLEMENTED_ACTIONS`.
    if (UNIMPLEMENTED_ACTIONS.has(a)) return false;
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
    case "cancel_deploy": {
      // THE SAME COMMAND THE DEPLOY PANEL SENDS, which is §6.4's rule and the reason this is one
      // line: a second way to stop a deployment is a second thing that has to be capability-gated,
      // audited and refused correctly on a suspended workspace, and the second one is the one that
      // forgets. The subject of a `deploy_failed` card is the deployment.
      //
      // A CARD WITH NO SUBJECT SENDS NOTHING, here and below. `subject_id` is non-null for both of
      // these types by construction, and an empty string reaching the relay would be a command
      // refused on the server for a reason nobody could see from the card.
      if (!item.subject_id) return false;
      sendCancelDeploy(item.subject_id);
      return true;
    }
    case "remove_server": {
      // Likewise, the MCP panel's own command. Both cards that offer this — `mcp_auth_required`
      // and `mcp_unreachable` — are about a server that cannot be reached, and removing it is the
      // answer when re-authenticating is not.
      if (!item.subject_id) return false;
      sendRemoveMcpServer(item.subject_id);
      return true;
    }
    case "dismiss_all": {
      // EVERY CARD OF THIS TYPE, BY ID, because that is what the command takes. The audit's sketch
      // passed `item.type` as the second argument; `bulkInboxAction` has never accepted a type —
      // it takes ids, deliberately, so the server never has to resolve a filter the client believed
      // it was applying. The ids come from the store's own snapshot, which is the same list the
      // board is rendering, so "all of them" means the ones somebody can see.
      const ids = useInboxStore.getState().items.filter((i) => i.type === item.type).map((i) => i.id);
      if (ids.length === 0) return false;
      return sendBulkInboxAction("dismiss", ids);
    }
    case "view_evidence":
      // EXPAND, RATHER THAN STOP THE CLICK THAT WOULD HAVE EXPANDED. The card already opens on
      // click; `IconButton` calls `stopPropagation` so that dismissing something does not also
      // open it — correct for every other control and exactly wrong for this one, which meant the
      // button labelled "View the evidence" PREVENTED the evidence from being shown. Clicking
      // anywhere else on the card worked better than clicking its primary control.
      useInboxStore.getState().setExpanded(item.id);
      return true;

    // --- navigation: the fallback, not the path ---------------------------------------------------
    case "open_agent":
    case "view_diff":
    case "enable_gate": {
      // `enable_gate` IS A NAVIGATION AND NOT AN INLINE FIX, which is the honest shape of it. The
      // gate is off because a line in the agent's own generated source turned it off, so there is
      // no command anywhere that turns it back on — only an edit to that file. Its old label said
      // otherwise, which is why it read as a broken button rather than as a link. v0.2.1 recorded
      // that a validation rule is what would actually close this, and surfacing the state is still
      // not that rule.
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

    case "save_memory":
    case "reject_memory":
      // §2.3's ANSWER, and the only way this card can settle. `memory_proposal` is deliberately
      // excluded from derived resolution — "there is no external world in which a proposal becomes
      // answered" — so its resolve predicate reads a `decision` field that only this writes. Until
      // `answerMemoryProposal` existed, both verbs closed the overflow and changed nothing, and the
      // card could only ever be cleared by the generic "Mark as done" or by snoozing it.
      //
      // NOT `resolveInboxItem`, which would clear the card while losing which answer was given —
      // and which answer was given is the only thing the card asked.
      return sendAnswerMemoryProposal(item.id, action === "save_memory" ? "saved" : "rejected");
    // --- handled elsewhere, and named here so the switch is exhaustive ---------------------------
    case "set_secret":
    case "set_mcp_credential":
    case "raise_ceiling":
      // §4.5's "the form itself" — `FORM_ACTIONS`, rendered by `InlineForm` and submitted by
      // `submitCredential` / `submitCeiling` below. They need somewhere to type before they can
      // run, so there is nothing for a one-press dispatcher to do; `InboxCardActions` renders the
      // form instead of a button for exactly these three.
      return false;
    case "dismiss":
      // The `×` on the card, handled by `InboxCardActions` rather than by this dispatcher, because
      // it takes the item id and nothing off the payload.
      return false;

    default: {
      /**
       * EXHAUSTIVE, SO THE NEXT DEAD GLYPH CANNOT SHIP.
       *
       * Eight of twenty-nine action names had no case here and fell through to `return false`,
       * which nothing read — the primary button ignored it and the overflow closed either way. Two
       * card types had a DEAD PRIMARY, so the most prominent control on the card was the one that
       * did nothing.
       *
       * `ACTION_COMMAND`'s own comment argues that an unmapped name should fail loudly, and it is
       * right — but it guards the CAPABILITY table, where an absent entry means ungated-and-allowed.
       * The dispatch table had no backstop at all. This is it: a new `InboxActionName` now fails
       * the client typecheck rather than shipping as a control that closes a menu and does nothing.
       * It is the same structural audit `test:channels` and `test:reset` apply on the server side.
       */
      const _never: never = action;
      return Boolean(_never);
    }
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

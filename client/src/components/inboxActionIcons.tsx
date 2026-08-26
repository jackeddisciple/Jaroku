// Which mark a card's primary action wears.
//
// §7: "Extend `lib/actionIcons.tsx` where an action already has an icon, verb and accent. DO NOT
// DEFINE A SECOND ICON FOR AN ACTION THAT ALREADY HAS ONE — resolve, retry, view logs, deploy and
// rediscover all exist already." So this file draws nothing. It is a mapping from the Inbox's action
// names onto marks the app already has, and the one thing it must never do is grow a drawing.
//
// WHERE EACH ONE COMES FROM, and why that is the honest source rather than a nearest match:
//
//   `rediscover` and `retry_deploy` are the REFRESH mark, which is what the MCP panel and the Deploy
//   panel already use for exactly these two commands.
//   `view_logs` and `view_diff` are the EYE, which `actionIcons`'s `read` kind already owns — "looked
//   at something without changing it" is precisely what both do.
//   `redeploy` is the ROCKET, which the Deploy panel uses for the same command.
//   `open_agent`, `open_comparison`, `open_invites`, `open_members`, `view_usage` and
//   `open_providers` are all NAVIGATION, and they share the chevron — the app's one mark for
//   "this takes you somewhere". Giving each its own glyph would be six new marks for one idea,
//   which is the thing v0.2.2's pass existed to undo.
//
// A FALLBACK EXISTS AND IT IS THE CHEVRON, not a question mark: every action that reaches this
// without a specific mark is one that opens something, and an unfamiliar glyph is worse than the
// honest generic one.

import { actionFor } from "../lib/actionIcons.tsx";
import {
  CheckIcon,
  ChevronRightIcon,
  KeyIcon,
  PlugIcon,
  RefreshIcon,
  RocketIcon,
  ShieldCheckIcon,
  SparklesIcon,
  XIcon,
} from "./panelIcons.tsx";
import type { InboxActionName } from "../types.ts";

type IconComponent = (p: { size?: number; className?: string }) => React.ReactElement;

const BY_ACTION: Partial<Record<InboxActionName, IconComponent>> = {
  // The two that already have a mark in `lib/actionIcons.tsx`, taken from it rather than redrawn.
  view_logs: actionFor("read").Icon,
  view_diff: actionFor("read").Icon,
  view_evidence: actionFor("read").Icon,
  view_results: actionFor("read").Icon,
  save_memory: CheckIcon,
  reject_memory: XIcon,

  // The commands whose panels already use these marks for the same command.
  rediscover: RefreshIcon,
  retry_deploy: RefreshIcon,
  redeploy: RocketIcon,
  set_secret: KeyIcon,
  set_mcp_credential: KeyIcon,
  remove_server: PlugIcon,
  enable_gate: ShieldCheckIcon,
  remove_grant: ShieldCheckIcon,
  new_agent: SparklesIcon,
  open_providers: KeyIcon,
  cancel_deploy: XIcon,
  dismiss_all: XIcon,
  raise_ceiling: ChevronRightIcon,
};

/** The one lookup. Everything without an entry navigates, and navigation is the chevron. */
export function actionIconFor(action: InboxActionName): IconComponent {
  return BY_ACTION[action] ?? ChevronRightIcon;
}

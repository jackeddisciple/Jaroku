// §5.7's pointer strip: "2 items need you", at the top of the Agent detail view.
//
// "THIS IS A POINTER, NOT A DUPLICATE SURFACE — it renders the count and nothing else." That
// restriction is the whole design of the component and the reason it is eleven lines of markup: the
// moment it rendered a list, or the subject of the first item, or an action, there would be two
// places an Inbox item can be dealt with and two places to keep in step. It says how many, and it
// opens the board.
//
// WHY IT EXISTS AT ALL: "somebody working inside one agent should not have to open the Inbox to
// learn something is stuck." An agent's detail view is where somebody goes when they are already
// suspicious, and the answer to "is anything wrong with this one" living one tab away is the answer
// being found late.
//
// THE COUNT IS THE SNAPSHOT'S OWN, from the same per-agent breakdown §5.1's rail is drawn from. Not
// derived here from the items in hand, and not asked for separately — one quantity computed once,
// which is the rule the two badges already follow. A number here that disagreed with the rail would
// be visible to anybody who clicked through.
//
// NOTHING RENDERS AT ZERO. An agent with nothing waiting on it gets no strip, no empty state and no
// reserved space — the same empty-sections discipline the rest of the app keeps, and the reason the
// strip reads as information rather than as chrome.

import { ICON } from "../lib/tokens.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ChevronRightIcon, InboxIcon } from "./panelIcons.tsx";

export function InboxPointer({ agentUuid }: { agentUuid: string | null }) {
  const count = useInboxStore((s) => s.agents.find((a) => a.agent_id === agentUuid)?.count ?? 0);
  const openInboxForAgent = useUiStore((s) => s.openInboxForAgent);

  if (!agentUuid || count === 0) return null;

  return (
    <button
      onClick={() => openInboxForAgent(agentUuid)}
      // The whole strip is the target rather than a link inside it: it is one sentence and one
      // destination, and a hit area smaller than the thing it describes is a control people miss.
      className="flex w-full shrink-0 items-center gap-2 border-b border-hair px-4 py-1.5 text-left text-tiny text-muted transition-colors hover:bg-active/40 hover:text-ink"
      title="Open the Inbox, filtered to this agent"
    >
      <span className="shrink-0 text-faint" aria-hidden>
        <InboxIcon size={ICON.xs} />
      </span>
      <span className="text-ink">{count}</span>
      <span>item{count === 1 ? "" : "s"} need{count === 1 ? "s" : ""} you</span>
      <span className="ml-auto shrink-0 text-faint" aria-hidden>
        <ChevronRightIcon size={ICON.xs} />
      </span>
    </button>
  );
}

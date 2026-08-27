// §6's 3-pane detail: the agent as an artifact, and the five tabs that say what it can touch.
//
// WHERE THIS SITS, AND WHY IT IS ONE COMPONENT RATHER THAN A FOURTH COLUMN.
//
// §2's layout law is that clicking a card "restores the 3-pane layout with that entity selected",
// and this repository's three panes are the sidebar, the composer and the right panel. §6 then names
// its own three — composer, centre, right — which would make four columns beside the sidebar and
// would put the trace, the graph and every other right-panel tab out of reach the moment somebody
// arrived from the Agents tab. So the detail is a TAB of the right panel: the composer keeps the
// centre exactly as §6 requires ("unchanged behaviour, unchanged routing"), §6's centre and right
// become the two columns inside this surface, and Trace stays one click away.
//
// TWO COLUMNS WITH A REAL HANDLE, not a fixed split. The artifact side holds a version history and a
// file browser and the tab side holds five panels, and which of those somebody is reading changes by
// the minute — a 50/50 that cannot be dragged is a decision made for them. It stacks below a width
// where two columns would each be too narrow to read a path in, which is the awkward case §10 asks
// to be checked.
//
// EVERY REGION IS ITS OWN COMPONENT IN ITS OWN FILE BELOW THIS ONE. This file is the geography.

import { useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AgentWorkPointer } from "./AgentOps.tsx";
import { InboxPointer } from "./InboxPointer.tsx";
import { AgentOverview } from "./AgentOverview.tsx";
import { AgentVersions } from "./AgentVersions.tsx";
import { AgentFiles } from "./AgentFiles.tsx";
import { AgentTabs } from "./AgentTabs.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { AlertTriangleIcon, SparklesIcon } from "./panelIcons.tsx";
import { sendLoadAccess, sendLoadAgentDetail, sendLoadExposure } from "../lib/socket.ts";
import { useAgentGridStore } from "../store/agentGridStore.ts";

/**
 * Below this the two columns stop being two columns.
 *
 * A NUMBER RATHER THAN A CONTAINER QUERY, because the split is a `PanelGroup` whose panels are sized
 * in percentages — there is no element whose width a query could watch that is not itself decided by
 * the answer. The observer below watches the surface as a whole, which is the thing that actually
 * changes when somebody drags the sidebar or narrows the window.
 */
const STACK_BELOW_PX = 720;

export function AgentDetail() {
  const detail = useAgentGridStore((s) => s.detail);
  const loading = useAgentGridStore((s) => s.detailLoading);
  const error = useAgentGridStore((s) => s.error);
  const openAgentId = useAgentGridStore((s) => s.openAgentId);
  const [narrow, setNarrow] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  // §8.2 — THE GRANT IS FETCHED WHEN THE DETAIL PANE OPENS, not when the Access tab is selected.
  //
  // THAT DISTINCTION IS THE WHOLE VALUE OF THE FETCH. Every agent-scoped guard in the client reads
  // this cache — the Deploy button in the title bar, the GitHub panel's writes, the Deploy tab —
  // and none of them is inside the Access tab. Fetching only when somebody opened Access would mean
  // per-agent narrowing was invisible on every surface except the one that displays it, which is
  // the worst possible place for it to be the only place it works.
  //
  // ON THE UUID, which is the id this pane has and the one the server answers with. `activeAgentId`
  // elsewhere is a slug; the store's alias map is what lets both find the same entry.
  //
  // ONCE PER AGENT, on open. The recheck is what refreshes it after that — see socket.ts — so this
  // is not a poll and does not need to be one.
  //
  // EXPOSURE RIDES ALONG FOR THE BADGE, which is the second reason this fetch is here rather than
  // in the Access tab. §9.3's warning dot is drawn on the TAB — a dot that only appeared once
  // somebody opened the tab it is meant to send them to would be the badge arriving after the
  // question it answers. Same argument the Threads badge makes about frame one.
  const openUuid = detail?.card.uuid;
  useEffect(() => {
    if (openUuid) {
      sendLoadAccess(openUuid);
      sendLoadExposure(openUuid);
    }
  }, [openUuid]);

  useEffect(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < STACK_BELOW_PX);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);

  // Nothing picked. Not an error and not a spinner — the grid is where an agent is picked, and the
  // sidebar's already-active Agents item is how somebody gets back to it.
  if (!openAgentId) {
    return (
      <EmptyState
        icon={SparklesIcon}
        title="No agent open"
        hint="Pick one from the Agents tab. Its versions, capabilities and health open here."
      />
    );
  }

  /**
   * A REFUSAL IS SHOWN HERE, not left to the grid's error strip.
   *
   * The comment this replaces said "a refusal has already replaced this with the grid's own error
   * strip", and that was simply false: opening a card collapses the full-screen view, so `AgentsView`
   * — which is where the strip lives — is not mounted. A `loadAgentDetail` that was refused therefore
   * showed three grey skeleton bars and the word "Ask again", with the actual sentence the server
   * sent rendered nowhere at all. The pane that asked is the pane that has to say.
   */
  if (!detail && error) {
    return (
      <EmptyState
        icon={AlertTriangleIcon}
        title="That agent could not be opened"
        hint={
          <>
            <span>{error}</span>
            <button
              onClick={() => sendLoadAgentDetail(openAgentId)}
              className="ml-2 text-muted underline decoration-dotted hover:text-ink"
            >
              Try again
            </button>
          </>
        }
      />
    );
  }

  if (!detail) {
    // NOT A SPINNER (§9). Skeleton at the real geometry, so the pane does not jump when the record
    // lands. A refusal took the branch above; this is the wait, and the line under it is for the
    // case where neither ever arrives — a dropped frame on a reconnect.
    return (
      <div className="h-full space-y-3 p-4">
        <div className="h-4 w-1/3 rounded-chip bg-active" />
        <div className="h-3 w-1/2 rounded-chip bg-active" />
        <div className="h-3 w-2/3 rounded-chip bg-active" />
        {!loading && (
          <button
            onClick={() => sendLoadAgentDetail(openAgentId)}
            className="pt-4 text-tiny text-muted underline decoration-dotted hover:text-ink"
          >
            Ask again
          </button>
        )}
      </div>
    );
  }

  const artifact = (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <AgentOverview detail={detail} />
      <AgentVersions detail={detail} />
      <AgentFiles detail={detail} />
    </div>
  );

  return (
    <div ref={setHost} className="flex h-full flex-col bg-bg">
      {/* §5.7: a thin strip saying how many Inbox items are about this agent, and nothing else.
          Above everything, because it is the reason somebody might stop reading the rest — and it
          renders nothing at all when there is nothing waiting. */}
      {/* THE UUID, NOT THE SLUG, because an Inbox item's `subject_id` is an agent's uuid — a slug is
          renameable and a card keyed on one would be orphaned by a rename. `card.uuid` is where the
          grid carries it. */}
      <InboxPointer agentUuid={detail.card.uuid} />
      {/* §3: "Do not put a work list inside Agent detail; a second place a job can be dealt with is
          the mistake the Inbox already refused. Put a pointer strip there instead." Below the Inbox
          pointer rather than above it, because what is BROKEN outranks what is merely in flight. */}
      <AgentWorkPointer agentUuid={detail.card.uuid} />
      {narrow ? (
        // STACKED, ARTIFACT FIRST. The overview and the version history are what the surface is
        // about; the tabs are what you go to next, which is the right order to scroll through.
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {artifact}
          <div className="min-h-0 border-t border-hair">
            <AgentTabs detail={detail} />
          </div>
        </div>
      ) : (
        <PanelGroup direction="horizontal" autoSaveId="jaroku-agent-detail-v1" className="min-h-0 flex-1">
          <Panel defaultSize={52} minSize={30} order={1}>
            {artifact}
          </Panel>
          <PanelResizeHandle className="w-[3px] bg-hair transition-colors duration-fast hover:bg-grip" />
          <Panel defaultSize={48} minSize={28} order={2}>
            <AgentTabs detail={detail} />
          </Panel>
        </PanelGroup>
      )}
    </div>
  );
}

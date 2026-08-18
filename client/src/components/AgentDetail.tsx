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
import { AgentOverview } from "./AgentOverview.tsx";
import { AgentVersions } from "./AgentVersions.tsx";
import { AgentFiles } from "./AgentFiles.tsx";
import { AgentTabs } from "./AgentTabs.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { SparklesIcon } from "./panelIcons.tsx";
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
  const openAgentId = useAgentGridStore((s) => s.openAgentId);
  const [narrow, setNarrow] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);

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

  if (!detail) {
    // NOT A SPINNER (§9). Skeleton at the real geometry, so the pane does not jump when the record
    // lands — and a refusal has already replaced this with the grid's own error strip.
    return (
      <div className="h-full space-y-3 p-4">
        <div className="h-4 w-1/3 rounded bg-active" />
        <div className="h-3 w-1/2 rounded bg-active/70" />
        <div className="h-3 w-2/3 rounded bg-active/70" />
        {!loading && (
          <div className="pt-4 text-[11px] text-faint">Ask again from the Agents tab.</div>
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
          <PanelResizeHandle className="w-[3px] bg-hair transition-colors duration-fast hover:bg-[#3a3a3f]" />
          <Panel defaultSize={48} minSize={28} order={2}>
            <AgentTabs detail={detail} />
          </Panel>
        </PanelGroup>
      )}
    </div>
  );
}

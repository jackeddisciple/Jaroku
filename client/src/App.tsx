import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./components/Sidebar.tsx";
import { BuildPane } from "./components/BuildPane.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { CodeOverlay } from "./components/CodeOverlay.tsx";
import { McpConfirmModal } from "./components/McpConfirmModal.tsx";
import { sendLoadAgentFiles, startSocket } from "./lib/socket.ts";
import { useBuildStore } from "./store/buildStore.ts";
import { useTraceStore } from "./store/traceStore.ts";

export function App() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");

  useEffect(() => {
    startSocket();
  }, []);

  // Selecting an agent loads its current on-disk files into the Code tab. Also re-fires
  // on reconnect, so a server restart doesn't leave a stale view.
  useEffect(() => {
    if (activeAgentId && connected) sendLoadAgentFiles(activeAgentId);
  }, [activeAgentId, connected]);

  return (
    <div className="flex h-full flex-col">
      {/* top bar */}
      <TopBar />

      {/* three-column body (doc §4): agents+runs · build · trace/code */}
      <PanelGroup direction="horizontal" autoSaveId="jaroku-layout-v3" className="flex-1 min-h-0">
        <Panel defaultSize={20} minSize={14} maxSize={34}>
          <Sidebar />
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-hair hover:bg-[#3a3a3f] transition-colors" />
        <Panel defaultSize={36} minSize={24}>
          <BuildPane />
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-hair hover:bg-[#3a3a3f] transition-colors" />
        <Panel defaultSize={44} minSize={26}>
          <RightPanel />
        </Panel>
      </PanelGroup>

      {/* the run control now lives inside the single composer (BuildPane) via its Chat/Test toggle */}
      <StatusBar />

      {/* command palette (Cmd+K) + global keyboard nav — mounted once, renders in a portal */}
      <CommandPalette />
      {/* code opens on demand (diff card / Cmd+P), overlaying the conversation */}
      <CodeOverlay />
      {/* Mounted last so it sits above everything. A run is halted mid-graph waiting for
          this answer, on a timer, and nothing else on screen can be more important. */}
      <McpConfirmModal />
    </div>
  );
}

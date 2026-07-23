import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./components/Sidebar.tsx";
import { BuildPane } from "./components/BuildPane.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { RunTrigger } from "./components/RunTrigger.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
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
      <div className="flex items-center gap-2 px-4 h-10 shrink-0 bg-panel">
        <span className="text-ink font-semibold">Jaroku</span>
        <span className="text-faint">·</span>
        <span className="text-muted text-[12px]">build · trace</span>
      </div>

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

      {/* run bar spans the app so it stays reachable from any tab */}
      <RunTrigger />
      <StatusBar />

      {/* command palette (Cmd+K) + global keyboard nav — mounted once, renders in a portal */}
      <CommandPalette />
    </div>
  );
}

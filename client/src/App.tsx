import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./components/Sidebar.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { CodeOverlay } from "./components/CodeOverlay.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { McpConfirmModal } from "./components/McpConfirmModal.tsx";
import { ComposerColumn } from "./components/onboarding/ComposerColumn.tsx";
import { WelcomeStep } from "./components/onboarding/WelcomeStep.tsx";
import { useOnboarding } from "./components/onboarding/useOnboarding.ts";
import { sendLoadAgentFiles, startSocket } from "./lib/socket.ts";
import { useBuildStore } from "./store/buildStore.ts";
import { useSessionStore } from "./store/sessionStore.ts";
import { useTraceStore } from "./store/traceStore.ts";

export function App() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  const sessionStatus = useSessionStore((s) => s.status);

  // First run. Everything below is the normal app once `phase` is "complete", which it is for
  // every session after the first — see components/onboarding/useOnboarding.ts.
  const { phase, mountSidebar, mountRightPanel } = useOnboarding();

  useEffect(() => {
    startSocket();
  }, []);

  // Selecting an agent loads its current on-disk files into the Code tab. Also re-fires
  // on reconnect, so a server restart doesn't leave a stale view.
  useEffect(() => {
    if (activeAgentId && connected) sendLoadAgentFiles(activeAgentId);
  }, [activeAgentId, connected]);

  // BEFORE EVERYTHING, INCLUDING ONBOARDING. There is no session, so there is no workspace,
  // and every screen below this line — the welcome step included — is a view of one
  // workspace's data. Rendering any of it would mean showing a first-run flow to somebody who
  // may well have been using the product for months in an account they are not signed into.
  //
  // Only `signed_out` gets this. `connecting` deliberately does not: a dropped network must
  // not throw a sign-in form over a working session, which is precisely the "retry vs stop"
  // distinction lib/socket.ts exists to keep straight.
  if (sessionStatus === "signed_out") return <SignIn />;

  // The welcome step replaces the layout entirely rather than covering it. It has nothing to say
  // about an agent, a run or a trace, so mounting three empty columns underneath it would be
  // paying to render what nobody can see. It owns the whole surface.
  if (phase === "welcome") return <WelcomeStep />;

  return (
    // The app is a panel on a surface, not the surface. A few pixels of inset and one outer
    // shadow, so the three columns read as a lifted object with edges — which is what they are
    // once this is wrapped as a desktop window, and is worth the eight pixels in a browser tab
    // too. The layout inside is untouched: same PanelGroup, same sizes, same resize handles.
    <div className="h-full bg-void p-2">
      <div className="flex h-full flex-col overflow-hidden rounded-modal border border-edge bg-bg shadow-overlay">
        {/* top bar */}
        <TopBar />

        {/* three-column body (doc §4): agents+runs · build · trace/code
            Steps 3 and 4 are this same layout with columns not yet mounted, not a different
            screen. ONE PanelGroup for the whole session: completion is only "both flags become
            true", so there is no remount, no reload and no jump at the moment step 5 promises
            the user lands exactly where they already were. */}
        <PanelGroup direction="horizontal" autoSaveId="jaroku-layout-v3" className="flex-1 min-h-0">
          {mountSidebar && (
            <>
              <Panel defaultSize={20} minSize={14} maxSize={34} order={1}>
                <div className="h-full animate-panel-in motion-reduce:animate-none">
                  <Sidebar />
                </div>
              </Panel>
              <PanelResizeHandle className="w-[3px] bg-hair transition-colors duration-fast hover:bg-[#3a3a3f]" />
            </>
          )}
          <Panel defaultSize={36} minSize={24} order={2}>
            {/* The composer, alone during step 3 and still the centre of the screen through
                step 4. Wrapped rather than swapped, so BuildPane is never torn down. */}
            <ComposerColumn phase={phase} />
          </Panel>
          {mountRightPanel && (
            <>
              <PanelResizeHandle className="w-[3px] bg-hair transition-colors duration-fast hover:bg-[#3a3a3f]" />
              <Panel defaultSize={44} minSize={26} order={3}>
                <div className="h-full animate-panel-in motion-reduce:animate-none">
                  <RightPanel />
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>

        {/* the run control now lives inside the single composer (BuildPane) via its Chat/Test toggle */}
        <StatusBar />
      </div>

      {/* Outside the shell on purpose: all three are fixed-position and cover the viewport, and
          the shell clips its own overflow so the columns can round their corners. */}
      {/* command palette (Cmd+K) + global keyboard nav — mounted once, renders in a portal.
          Held back until onboarding is over: its shortcuts jump between panels that are not
          mounted yet, and a first-run user has nothing to navigate to. */}
      {phase === "complete" && <CommandPalette />}
      {/* code opens on demand (diff card / Cmd+P), overlaying the conversation */}
      <CodeOverlay />
      {/* Mounted last so it sits above everything. A run is halted mid-graph waiting for
          this answer, on a timer, and nothing else on screen can be more important — including
          during onboarding, where a generated agent can reach an MCP tool on its first run. */}
      <McpConfirmModal />
    </div>
  );
}

import { useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./components/Sidebar.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { CodeOverlay } from "./components/CodeOverlay.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { McpConfirmModal } from "./components/McpConfirmModal.tsx";
import { FullScreenView } from "./components/FullScreenView.tsx";
import { EnforcementStrip } from "./components/EnforcementStrip.tsx";
import { WorkspacePanel } from "./components/WorkspacePanel.tsx";
import { InviteNotice } from "./components/InviteNotice.tsx";
import { redeemPendingInvite } from "./lib/invite.ts";
import { switchWorkspace } from "./lib/socket.ts";
import { ComposerColumn } from "./components/onboarding/ComposerColumn.tsx";
import { WelcomeStep } from "./components/onboarding/WelcomeStep.tsx";
import { useOnboarding } from "./components/onboarding/useOnboarding.ts";
import { sendLoadAgentFiles, startSocket } from "./lib/socket.ts";
import { useBuildStore } from "./store/buildStore.ts";
import { useSessionStore } from "./store/sessionStore.ts";
import { useTraceStore } from "./store/traceStore.ts";
import { useUiStore } from "./store/uiStore.ts";

/**
 * The seam between two panes.
 *
 * A HAIRLINE THAT IS PAINTED 1px AND HIT AT 5px. It was a flat `w-[3px] bg-hair` bar, which is
 * three times wider than every border in the system and therefore read as a drawn column rather
 * than as the join between two surfaces — while still being a small target to grab. Separating
 * what the eye gets from what the pointer gets fixes both at once: the line is one pixel, the
 * element around it is five.
 *
 * `cursor-col-resize` at rest, because react-resizable-panels only injects a cursor once a drag
 * is already underway — so a divider you have not yet grabbed showed the ordinary arrow, and the
 * only way to find out it was draggable was to try. An affordance that appears after you commit
 * to the action is not an affordance.
 */
function PaneDivider() {
  return (
    <PanelResizeHandle className="group relative w-[5px] shrink-0 cursor-col-resize">
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-hair transition-colors duration-fast group-hover:bg-grip" />
      {/* A GRIP, revealed on approach. A colour shift on a one-pixel line is not discoverable —
          you have to already be looking at it to see it change. Two pixels by sixteen at the
          vertical centre says "this moves" the moment the pointer is near, and says nothing at
          all when it is not. */}
      <span className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors duration-fast group-hover:bg-chrome" />
    </PanelResizeHandle>
  );
}

export function App() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  const sessionStatus = useSessionStore((s) => s.status);
  // §2's whole mechanism, as one nullable field. Null is the ordinary three panes.
  const navView = useUiStore((s) => s.navView);

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

  // AN INVITATION IN THE URL, redeemed once there is a session to redeem it with.
  //
  // Here rather than in `lib/socket.ts`'s connect loop, because a redemption is not part of
  // opening a socket: it succeeds or fails exactly once per link, and a reconnect must not retry
  // it. The ref is what makes "exactly once" true across the re-renders `sessionStatus` causes.
  //
  // It waits for a session rather than for a socket. The redemption is an HTTP request carrying a
  // bearer token, and the workspace being joined is by definition not the one this tab's socket is
  // scoped to — so there is nothing to wait for the socket to finish.
  const redeemed = useRef(false);
  useEffect(() => {
    if (redeemed.current) return;
    if (sessionStatus !== "ready" && sessionStatus !== "connecting") return;
    redeemed.current = true;
    void redeemPendingInvite().then((outcome) => {
      if (outcome.kind === "none") {
        // Nothing was there, or there was no credential yet. Either way this may run again once
        // the session lands — which is why the latch is released rather than kept.
        redeemed.current = false;
        return;
      }
      if (outcome.kind === "failed") {
        useUiStore.getState().setInviteNotice({ ok: false, message: outcome.message });
        return;
      }
      useUiStore.getState().setInviteNotice({
        ok: true,
        message: `You have joined ${outcome.name} as ${outcome.role === "admin" ? "an" : "a"} ${outcome.role}.`,
      });
      // The membership is real now; this is the navigation. A no-op when the invitation was to
      // the workspace this tab is already in, which is the case when somebody re-uses a link.
      switchWorkspace(outcome.workspaceId);
    });
  }, [sessionStatus]);

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

        {/* WHY THE WORKSPACE CANNOT START ANYTHING, when that is the case. Directly under the top
            bar and above every pane, because it is not a setting somebody goes looking for: it is
            the reason the last thing they pressed was refused, and until now the only place that
            sentence appeared was an error strip on whichever channel they happened to be using.
            Renders nothing at all when no rung is in force, which is almost always. */}
        <EnforcementStrip />

        {/* TWO NESTED GROUPS RATHER THAN ONE, WHICH IS WHAT §2 COSTS.
            The outer group is [sidebar | everything else], and the inner one inside it is the
            centre/right split that used to be part of the outer. That split is the whole
            mechanism: a full-screen view replaces the contents of the SECOND outer panel, so the
            sidebar's own width is not part of the swap and cannot move when one opens — which is
            §2's first promise, made structural rather than remembered.

            `jaroku-layout-v4`, because the outer group's panels are not the ones v3 saved sizes
            for. Reusing the id would restore a two-panel layout into a two-panel group whose
            second panel is now a container, and the composer/right split would come back at
            whatever width the trace panel used to have. */}
        <PanelGroup direction="horizontal" autoSaveId="jaroku-layout-v4" className="flex-1 min-h-0">
          {mountSidebar && (
            <>
              <Panel defaultSize={20} minSize={14} maxSize={34} order={1}>
                <div className="h-full animate-panel-in motion-reduce:animate-none">
                  <Sidebar />
                </div>
              </Panel>
              <PaneDivider />
            </>
          )}
          <Panel order={2}>
            {/* THE THREE PANES STAY MOUNTED WHILE A FULL-SCREEN VIEW IS UP, and that is the second
                promise §2 makes: clicking the active agent in the sidebar "returns you to the
                three-pane view exactly where you left it". Unmounting would lose a half-typed
                message, the conversation's scroll position and the trace's selected step — and
                "exactly where you left it" would then mean "at the top, with an empty composer".

                `invisible` rather than `hidden`: the inner group keeps its real dimensions, so its
                resize observer is never handed a zero-width container and its saved sizes survive
                the round trip. It also drops out of the tab order, which is what stops the keyboard
                reaching a composer nobody can see. */}
            <div className="relative h-full">
              <div className={`absolute inset-0 ${navView ? "invisible" : ""}`}>
                <PanelGroup direction="horizontal" autoSaveId="jaroku-panes-v1" className="h-full">
                  <Panel defaultSize={45} minSize={30} order={1}>
                    {/* The composer, alone during step 3 and still the centre of the screen through
                        step 4. Wrapped rather than swapped, so BuildPane is never torn down. */}
                    <ComposerColumn phase={phase} />
                  </Panel>
                  {mountRightPanel && (
                    <>
                      <PaneDivider />
                      <Panel defaultSize={55} minSize={32} order={2}>
                        <div className="h-full animate-panel-in motion-reduce:animate-none">
                          <RightPanel />
                        </div>
                      </Panel>
                    </>
                  )}
                </PanelGroup>
              </div>
              {navView && (
                <div className="absolute inset-0 animate-panel-in motion-reduce:animate-none">
                  <FullScreenView destination={navView} />
                </div>
              )}
            </div>
          </Panel>
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
      {/* Who is in this workspace, and everything else true of the workspace rather than of an
          agent in it. Outside the shell like the other overlays, and above the three panes: its
          subject is the scope they are all inside. */}
      <WorkspacePanel />
      {/* What became of the invitation this tab was opened with, if it was opened with one. */}
      <InviteNotice />
      {/* Mounted last so it sits above everything. A run is halted mid-graph waiting for
          this answer, on a timer, and nothing else on screen can be more important — including
          during onboarding, where a generated agent can reach an MCP tool on its first run. */}
      <McpConfirmModal />
    </div>
  );
}

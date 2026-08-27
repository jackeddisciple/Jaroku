import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./components/Sidebar.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { CodeOverlay } from "./components/CodeOverlay.tsx";
import { AuthFlow, SignInSwapPrompt } from "./components/auth/AuthFlow.tsx";
import { SetUpAccountScreen } from "./components/auth/SetUpAccountScreen.tsx";
import { FirstRun } from "./components/firstrun/FirstRun.tsx";
import { firstRunOnScreen, useFirstRunStore } from "./store/firstRunStore.ts";
import { McpConfirmModal } from "./components/McpConfirmModal.tsx";
import { FullScreenView } from "./components/FullScreenView.tsx";
import { AdminModeBanner } from "./components/AdminModeBanner.tsx";
import { EnforcementStrip } from "./components/EnforcementStrip.tsx";
import { WorkspacePanel } from "./components/WorkspacePanel.tsx";
import { WorkspaceSwitchLock } from "./components/WorkspaceSwitchLock.tsx";
import { setWindowTitle } from "./lib/windowTitle.ts";
import { SIDEBAR_DEFAULT_MIN_PCT, SIDEBAR_MAX_PCT, SIDEBAR_MIN_PX, pixelFloorPercent } from "./lib/paneFloor.ts";
import { RoleRefusal } from "./components/RoleRefusal.tsx";
import { InviteNotice } from "./components/InviteNotice.tsx";
import { redeemPendingInvite } from "./lib/invite.ts";
import { switchWorkspace } from "./lib/socket.ts";
import { ComposerColumn } from "./components/onboarding/ComposerColumn.tsx";
import {
  AccountOnboarding,
  accountOnboardingOnScreen,
  useAccountOnboardingHydration,
} from "./components/onboarding/account/AccountOnboarding.tsx";
import { FinishSetupBanner } from "./components/onboarding/account/FinishSetupBanner.tsx";
import { useAccountOnboardingStore } from "./store/accountOnboardingStore.ts";
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
/**
 * The sidebar's pixel floor, converted to the percentage `Panel` takes, against the group's real
 * width — see lib/paneFloor.
 *
 * MEASURED ON THE SHELL rather than on the `PanelGroup`, because `PanelGroup`'s ref is an
 * imperative handle (`getLayout`/`setLayout`) and not a DOM node. The shell is the group's parent
 * and differs from it by the one-pixel border on each side, which is below the resolution of a
 * floor whose job is to stop a column reaching 149px.
 */
function useSidebarFloor(shell: HTMLElement | null, fallback: number, max: number): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!shell || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setWidth(shell.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shell]);
  return pixelFloorPercent(SIDEBAR_MIN_PX, width, max, fallback);
}

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
  // THE SHELL, AS A NODE, so the sidebar's pixel floor can be converted against the width the pane
  // group actually has. A callback ref rather than `useRef`, because the measurement has to start
  // when the node arrives and a ref object's assignment does not re-render anything.
  //
  // DECLARED HERE, ABOVE EVERY EARLY RETURN. Half a dozen screens below this line return before the
  // layout renders — sign-in, first-run, the name screen, account onboarding — and a hook called
  // after one of them would be a hook whose call order changes with the session.
  const [shell, setShell] = useState<HTMLElement | null>(null);
  const sidebarMin = useSidebarFloor(shell, SIDEBAR_DEFAULT_MIN_PCT, SIDEBAR_MAX_PCT);

  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  const sessionStatus = useSessionStore((s) => s.status);
  // §2's whole mechanism, as one nullable field. Null is the ordinary three panes.
  const navView = useUiStore((s) => s.navView);

  // First run. Everything below is the normal app once `phase` is "complete", which it is for
  // every session after the first — see components/onboarding/useOnboarding.ts.
  const { phase, mountSidebar, mountRightPanel } = useOnboarding();

  // The MACHINE's first run, which is a different question from the person's — see §1.3, and the
  // gate below where it is spent. Both selectors read the same store; `firstRunOnScreen` is what
  // decides, in one place, so two readers cannot answer differently.
  const firstRunProgress = useFirstRunStore((s) => s.progress);
  const firstRunNeeded = useFirstRunStore(firstRunOnScreen);

  // Whether this account still has to say what to call it. Null rather than empty: the server
  // stores a trimmed non-empty string or nothing at all, so there is no third state to consider.
  const needsName = useSessionStore((s) => s.user !== null && s.user.displayName === null);

  /**
   * §9.2 — the workspace's name on the window, updated whenever it changes.
   *
   * HERE RATHER THAN IN `switchWorkspace`, and that is the decision. A switch is not the only way
   * this name moves: a rename arrives on a broadcast, the session refreshes on every reconnect,
   * and the very first name arrives when hydration lands rather than when anybody switched. Hung
   * off the value it renders, the title is correct in all four cases and cannot be forgotten by a
   * fifth; hung off the switch, it would be right exactly once per switch and stale otherwise.
   */
  const workspaceName = useSessionStore(
    (s) => s.workspaces.find((w) => w.id === s.workspaceId)?.name ?? null,
  );
  useEffect(() => {
    setWindowTitle(workspaceName);
  }, [workspaceName]);

  // §5.3s resume point, read off the session once it lands. A hook rather than an effect inside
  // `AccountOnboarding`, because the store has to hydrate whether or not the flow is on screen —
  // the gate below reads `step !== null`, so a component that only hydrated while it was already
  // rendering would never render at all.
  useAccountOnboardingHydration();
  const onboardingNeeded = useAccountOnboardingStore(accountOnboardingOnScreen);

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

  // BEFORE THE SIGN-IN SCREEN, AND THEREFORE BEFORE EVERYTHING. §1.3's trigger matrix is two
  // columns because these are two different events with two different triggers: first-run is about
  // the MACHINE and is gated by a marker file on this disk, account onboarding is about the PERSON
  // and is gated by a flag on the server. Conflating them is how re-installing the app re-runs
  // account onboarding, and how a returning user on a second device is walked through a welcome
  // screen for a product they use daily.
  //
  // It outranks sign-in because there is nothing to sign in TO yet: on this launch the backend is
  // still unpacking, and a sign-in form in front of a server that is not listening is a form whose
  // only outcome is a spinner. A `jaroku://` link that arrives during it is queued rather than
  // dropped — §4.5, and lib/authLink.ts is where it waits.
  //
  // FALSE IN A BROWSER FOREVER, so `npm run dev` in a tab renders exactly what it always did.
  if (firstRunNeeded) {
    return <FirstRun progress={firstRunProgress!} onDone={() => useFirstRunStore.getState().dismiss()} />;
  }

  // Then the session. There is no workspace without one, and every screen below this line — the
  // welcome step included — is a view of one workspace's data. Rendering any of it would mean
  // showing a first-run flow to somebody who may well have been using the product for months in an
  // account they are not signed into.
  //
  // Only `signed_out` gets this. `connecting` deliberately does not: a dropped network must
  // not throw a sign-in form over a working session, which is precisely the "retry vs stop"
  // distinction lib/socket.ts exists to keep straight.
  if (sessionStatus === "signed_out") return <AuthFlow />;

  // §3.4 AND §4.4 STEP 6 — a verified address and nothing else known about the person.
  //
  // MAGIC-LINK ACCOUNTS ONLY, and the condition says so structurally rather than by checking which
  // provider was used: a Google account arrives with `display_name` already set from the ID
  // token's claim, so it is never null and this never renders. Branching on the provider instead
  // would be a second way of asking the same question, and the one that goes wrong the day a
  // provider stops supplying a name.
  //
  // BEFORE ACCOUNT ONBOARDING, because step 1 of it says "Welcome, {firstName}" and there is no
  // first name yet. §5.1's whole first screen is personalised; running it against a null would
  // greet somebody by their email address, which is the opposite of what that screen is for.
  //
  // IT SELF-HEALS THE CASE §10 SAYS SHOULD NOT HAPPEN. "Onboarding completed but user was created
  // with name: NULL" — if a row ever reaches that state, this is what asks.
  if (needsName) return <SetUpAccountScreen />;

  // §5 — the five screens between a session and a working workspace.
  //
  // IT OWNS THE WHOLE SURFACE rather than covering the layout, for the reason the old welcome step
  // did: it has nothing to say about an agent, a run or a trace, so mounting three empty columns
  // underneath it would be paying to render what nobody can see.
  //
  // AND IT IS THE LAST GATE. Everything above it — first-run, sign-in, the name screen — is about
  // getting to a session; this is the only one that runs WITH one, which is why it is the only one
  // that can greet somebody by name.
  if (onboardingNeeded) return <AccountOnboarding />;

  return (
    // The app is a panel on a surface, not the surface. A few pixels of inset and one outer
    // shadow, so the three columns read as a lifted object with edges — which is what they are
    // once this is wrapped as a desktop window, and is worth the eight pixels in a browser tab
    // too. The layout inside is untouched: same PanelGroup, same sizes, same resize handles.
    // `min-w-[900px]` and a horizontal scroll below it. The shell had no minimum at all, and the
    // pane minimums are PERCENTAGES — at a 1000px window the sidebar's `minSize={14}` is 140px,
    // narrower than its own rows plus their padding, which is why its filter row used to clip. The
    // clipping was the symptom; a percentage floor on a fixed-content column is the cause.
    //
    // AND THAT CAUSE IS GONE NOW rather than moved again. Raising the shell floor and the
    // percentage moved the threshold to 1024×768, where the same failure returned in full: agent
    // names vanished entirely, run rows were cut mid-word and a horizontal scrollbar appeared
    // inside a vertical list. The sidebar's floor is stated in PIXELS and converted against the
    // width this group actually has — see lib/paneFloor.
    <div className="h-full min-w-[900px] overflow-x-auto bg-void p-2">
      <div
        ref={setShell}
        className="flex h-full flex-col overflow-hidden rounded-modal border border-edge bg-bg shadow-overlay"
      >
        {/* top bar */}
        <TopBar />

        {/* WHY THE WORKSPACE CANNOT START ANYTHING, when that is the case. Directly under the top
            bar and above every pane, because it is not a setting somebody goes looking for: it is
            the reason the last thing they pressed was refused, and until now the only place that
            sentence appeared was an error strip on whichever channel they happened to be using.
            Renders nothing at all when no rung is in force, which is almost always. */}
        {/* ABOVE the enforcement strip, because it is the more urgent of the two: an enforcement
            describes what this workspace may not do, and this describes every limit not being
            applied at all. Both are true about the whole session rather than about whatever is on
            screen, which is why neither lives in a panel. */}
        {/* §4.5's last row: a sign-in link arrived while somebody else is signed in. A strip
            rather than a modal, beside the app rather than instead of it — taking the screen away
            to ask about an event they may not have caused is the modal-mid-flow pattern this
            product refuses everywhere else. Renders nothing at all when no link is waiting. */}
        {/* §5.1s "Skip setup" left somebody in the app with nothing set up. Persistent, with no
            dismiss, because the state it describes does not resolve on its own and there is no
            other surface that mentions it. Renders nothing for everybody who did not skip. */}
        <FinishSetupBanner />
        <SignInSwapPrompt />
        <AdminModeBanner />
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
              {/* `minSize` IS A MEASURED PIXEL FLOOR, not a share of the window. 16% is 307px
                  at 1920 and 164px at 1024 — one rule expressing two different requirements, and
                  the narrow one is the one nobody is looking at while writing it. */}
              <Panel defaultSize={20} minSize={sidebarMin} maxSize={SIDEBAR_MAX_PCT} order={1}>
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
      {/* §8.3 — the safety net under §8s guards. It should never appear; when it does, a surface
          rendered a control for a role that cannot use it. */}
      <RoleRefusal />
      {/* §5.1 — the lock over the shell while a workspace switch is in flight. Above the workspace
          panel and below the MCP modal: it must cover the panel it just closed, and it must not
          cover a run halted mid-graph waiting for an answer. */}
      <WorkspaceSwitchLock />
      {/* Mounted last so it sits above everything. A run is halted mid-graph waiting for
          this answer, on a timer, and nothing else on screen can be more important — including
          during onboarding, where a generated agent can reach an MCP tool on its first run. */}
      <McpConfirmModal />
    </div>
  );
}

// Left sidebar — the agent/run library (doc §4.1). Top: New Agent, search, and status filter
// tabs over the agent list. A flexible middle holds recent runs (how you re-open a past trace).
// Bottom-anchored: Settings and the user/plan chip. Restraint-first: rows float on the panel,
// separated by spacing and a thin accent on the active one — never boxed.

import { useEffect, useRef, useState } from "react";
import { orderedRuns, useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import type { AgentSummary, RunSummary, RunStatus } from "../types.ts";
import { absTime, relTime } from "../lib/format.ts";
import { agentStatus, type AgentStatus } from "../lib/agentStatus.ts";
import { selectAgent, selectRun } from "../lib/selection.ts";
import {
  sendArchiveAgent, sendLoadHistory, sendLoadRun, sendRenameAgent, sendRestoreAgent, signOut,
} from "../lib/socket.ts";
import { ICON, SURFACE, TYPE } from "../lib/tokens.ts";
import { quietBtn, secondaryBtn } from "./buttons.ts";
import { AlertTriangleIcon } from "./panelIcons.tsx";
import { useUiStore, type NavDestination } from "../store/uiStore.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useWorkStore, workBadgeCount } from "../store/workStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { AgentIdentityLine, identityTitle } from "./AgentIdentityLine.tsx";
import { RUN_PHASE } from "../lib/domainPhase.ts";
import { EmptyState } from "./EmptyState.tsx";
import { keyHint } from "../lib/modKey.ts";
import { hasHostWindow } from "../lib/windowStage.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { CheckIcon, GlobeIcon, RocketIcon, LoaderIcon, SearchIcon, SparklesIcon } from "./panelIcons.tsx";

/**
 * §2's nav buttons, in the order the spec lists them.
 *
 * DATA RATHER THAN FOUR COPIES OF THE SAME MARKUP, so the badge that lands on one of them later is a
 * field here rather than a special case in one of four branches.
 */
const NAV_DESTINATIONS: { id: NavDestination; label: string; icon: IconComponent }[] = [
  { id: "threads", label: "Threads", icon: Icon.nav.threads },
  { id: "agents", label: "Agents", icon: Icon.nav.agents },
  { id: "work", label: "Cockpit", icon: Icon.nav.cockpit },
  { id: "inbox", label: "Inbox", icon: Icon.nav.inbox },
  { id: "activity", label: "Activity", icon: Icon.nav.activity },
];

// `archived` is the sixth, and it is a filter rather than a section for the reason §3.4 gives about
// threads: an archived thing has LEFT the default list, and a list that showed both would make
// "archived" a decoration instead of a state. It is last, after the states that describe live work.
type Filter = "all" | "running" | "deployed" | "synced" | "drafts" | "archived";

// A run's outcome, in the product's one status vocabulary.
//
// IT WAS FONT CHARACTERS ONCE — a pulsing ●, a ✗ and a ✓ — which sat on the text baseline at
// whatever weight the row happened to be and never optically matched the icons two panels over.
// Then it was four `StatusDot`s: a spinning loader, a pause, a cross and a tick, in three colours.
// Both were right about this list and unrelated to the six the Cockpit drew for the same four facts
// one tab over. `RUN_PHASE` is what makes them the same marks now.
//
// `paused` STILL DOES NOT FALL THROUGH TO THE TICK, which is the defect this function was rewritten
// for once already: it arrived after the other three and wore the same green as a run that finished,
// and this list is the only place a paused run can be found and resumed from. `RUN_PHASE` is a
// `Record<RunStatus, Phase>`, so a fifth status is a compile error rather than a silent fall-through.
//
// THE WORDS ARE THIS LIST'S OWN. "paused — resumable" says the thing somebody scanning for a run to
// pick back up is looking for, which the phase's own "stopped" does not.
const RUN_WORD: Record<RunStatus, string> = {
  running: "running",
  paused: "paused — resumable",
  error: "error",
  completed: "completed",
};

function RunPhaseGlyph({ status }: { status: RunStatus }) {
  return <StatusGlyph phase={RUN_PHASE[status]} title={RUN_WORD[status]} />;
}

// FIVE STATES, FIVE MARKS. It was five states and TWO colours: `running` and `deploying` were
// both a pulsing amber dot, `deployed` and `ran` were both a static green one — so two of the four
// live states were indistinguishable at a glance and the only way to tell them apart was to hover
// for the tooltip.
//
// The colour still carries how it is doing; the glyph narrows what kind, which is exactly the
// escape hatch `StatusDot` was given for this and which `StatusGlyph` above already uses for runs.
// Two states move, and both mean "this is changing right now", which is the only thing motion is
// ever allowed to mean here.
function AgentDot({ status }: { status: AgentStatus }) {
  switch (status) {
    case "running":
      return <StatusDot state="pending" icon={LoaderIcon} spin size={ICON.xs} title="running" />;
    case "deploying":
      return <StatusDot state="pending" icon={RocketIcon} pulse size={ICON.xs} title="deploying" />;
    case "deployed":
      return <StatusDot state="ok" icon={GlobeIcon} size={ICON.xs} title="deployed" />;
    case "ran":
      return <StatusDot state="ok" icon={CheckIcon} size={ICON.xs} title="ran" />;
    case "draft":
      return <span title="draft" className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />;
  }
}

function RunRow({ run }: { run: RunSummary }) {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const needsLoad = useTraceStore((s) => s.needsLoad);
  const active = run.id === activeRunId;

  return (
    <button
      onClick={() => { if (needsLoad(run.id)) sendLoadRun(run.id); selectRun(run.id); }}
      className={`relative w-full text-left px-4 py-2 transition-colors ${active ? "bg-sidebar-active" : "hover:bg-sidebar-hover"}`}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}
      {/* ONE LINE, FIGURES RIGHT-ALIGNED AND MONO — the form `StepRow` already proves works for
          exactly this data, two panels over. It was two lines: a title line, then a second line
          carrying a provider chip, a step count and a branch marker at a third indent.

          Branches (debug depth) are indented under the run they forked from, with a fork mark. The
          indent is ONE step now. It used to be three values inside one row — 12px on line one,
          28px on line two, against 16px for an unbranched row's line two — so the two halves of a
          single branched row began at different left edges from each other and from their parent.
          A 1px connector in the gutter does what indentation alone cannot at 16px: say the row
          below belongs to the row above even when the parent has scrolled off. */}
      <div className={`relative flex items-center gap-2 ${run.parent_run_id ? "pl-4" : ""}`}>
        {run.parent_run_id && (
          <>
            <span className="absolute left-[7px] top-0 bottom-0 w-px bg-sidebar-border" aria-hidden />
            <span className="relative shrink-0 bg-inherit text-faint" title="branch">
              <Icon.agents.fork size={ICON.xs} />
            </span>
          </>
        )}
        <RunPhaseGlyph status={run.status} />
        <Truncate className={`text-caption ${active ? "text-accent" : "text-ink"}`} title={run.agent_id}>{run.agent_id}</Truncate>
        {/* `min-w-0` ON THE FIGURES TOO. The group is `shrink-0` so the run id truncates first,
            which is right — but at the width the sidebar reaches on a 1024px screen there is
            nothing left for it to give and the row overflowed its own column instead, rendering
            `fake 13 steps 13h ` cut mid-word with no ellipsis to say so. It may now reach one. */}
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden text-tiny tabular-nums text-faint">
          <span className="truncate">{run.provider}</span>
          {run.step_count != null && <span>{run.step_count} steps</span>}
          {run.parent_run_id != null && run.branch_from_seq != null && (
            <span title="branched from this step">@{run.branch_from_seq}</span>
          )}
          <span title={absTime(run.started_at)}>{relTime(run.started_at)}</span>
        </span>
      </div>
    </button>
  );
}

/**
 * The window's own top row, and the first thing in the sidebar rather than a bar above it.
 *
 * IT IS THE TITLE BAR. The macOS window is built with an overlay title bar (see
 * `src-tauri/src/window.rs`), so the page extends under the traffic lights and this strip is what
 * sits behind them — which is why it reserves their width on the left and carries
 * `data-tauri-drag-region`: take that off and the window can no longer be dragged by its own top
 * edge, because there is no longer a title bar to grab.
 *
 * THE RESERVATION IS CONDITIONAL, because in a browser tab there are no traffic lights and 76px of
 * nothing would be a hole. `hasHostWindow()` is the same check `windowStage` uses to decide whether
 * there is a shell to talk to at all.
 */
function SidebarChrome() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const underHost = hasHostWindow();

  return (
    <div
      data-tauri-drag-region
      className={`flex h-11 shrink-0 items-center gap-1 pr-2 ${underHost ? "pl-[76px]" : "pl-2"}`}
    >
      <span className="flex-1" data-tauri-drag-region />
      {/* SEARCH IS ONE CONTROL FOR BOTH SEARCHES. The palette already carries "Go to agent…"
          beside every other destination, so a second, narrower agent-only box beside it would be
          two answers to one question — and the one people reach for is whichever is nearer. */}
      <button
        onClick={() => setPaletteOpen(true)}
        title={`Search agents and commands — ${keyHint("⌘K")} opens the palette`}
        aria-label="Search agents and commands"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <Icon.agents.search size={ICON.sm} />
      </button>
      {/* THE LABEL NAMES THE ACTION, not the state — the `IconButton` contract, and the reason one
          mark serves both directions. */}
      <button
        onClick={toggleSidebar}
        title="Hide the sidebar"
        aria-label="Hide the sidebar"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <Icon.nav.sidebarToggle size={ICON.sm} />
      </button>
    </div>
  );
}

/**
 * The five destinations, as rows rather than as a rail of glyphs.
 *
 * A GLYPH PLUS ITS NAME, ALWAYS. The rail traded the names for forty pixels of width and put them
 * behind a hover tooltip, which is an affordance you have to already know about to find. These are
 * the product's five surfaces; they are worth a line each.
 */
function NavList() {
  const navSection = useUiStore((s) => s.navSection);
  const openNav = useUiStore((s) => s.openNav);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const needsYou = useThreadStore((s) => s.counts.needs_you);
  const waiting = useInboxStore((s) => s.counts.badge);
  const waitingOnYou = useWorkStore((s) => workBadgeCount(s.workspaceCounts));

  return (
    <div className="flex shrink-0 flex-col px-2 pb-1">
      {/* NEW IS THE FIRST THING AND THE DEFAULT ONE, which is what makes it a destination rather
          than a button that happened to be moved here. It was a `+` in the Recents header, filed
          with that section's filter — a creation control scoped by a list it does not belong to.

          IT IS ACTIVE WHEN NOTHING ELSE IS. `activeAgentId === null` IS the empty composer: it is
          the state the application already opens in, so this row is lit on first paint without
          anything having to select it. `navSection` has to be null too, or opening Threads would
          leave two rows looking chosen. */}
      <button
        onClick={() => { useUiStore.getState().closeNav(); selectAgent(null); }}
        aria-current={activeAgentId === null && navSection === null ? "page" : undefined}
        className={`flex h-8 w-full shrink-0 items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
          activeAgentId === null && navSection === null
            ? "bg-sidebar-active text-accent"
            : "text-muted hover:bg-sidebar-hover hover:text-ink"
        }`}
      >
        <Icon.agents.new size={ICON.lg} />
        <span className="min-w-0 flex-1 truncate text-label">New</span>
      </button>

      {NAV_DESTINATIONS.map(({ id, label, icon: Mark }) => {
        const active = navSection === id;
        const badge = id === "inbox" ? waiting : id === "threads" ? needsYou : id === "work" ? waitingOnYou : 0;
        const badgeTitle =
          id === "inbox"
            ? `${waiting} item${waiting === 1 ? "" : "s"} blocked or waiting on a decision`
            : id === "work"
              ? `${waitingOnYou} job${waitingOnYou === 1 ? "" : "s"} waiting for somebody to answer something`
              : `${needsYou} thread${needsYou === 1 ? "" : "s"} waiting on you`;
        return (
          <button
            key={id}
            onClick={() => openNav(id)}
            aria-current={active ? "page" : undefined}
            className={`flex h-8 w-full shrink-0 items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              active ? "bg-sidebar-active text-accent" : "text-muted hover:bg-sidebar-hover hover:text-ink"
            }`}
          >
            <Mark size={ICON.lg} />
            <span className="min-w-0 flex-1 truncate text-label">{label}</span>
            {badge > 0 && (
              <span
                title={badgeTitle}
                className={`shrink-0 rounded-xs px-1 text-tiny leading-[15px] tabular-nums ${
                  id === "threads" ? "text-run" : "text-ink"
                }`}
                style={id === "threads" ? undefined : { background: SURFACE.chrome }}
              >
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** How many of an agent's runs are shown before "Show more" — a glance, not a history. */
const RUNS_AT_FIRST = 5;

/**
 * The per-agent overflow: rename, archive, restore.
 *
 * REVEALED ON HOVER AND ON FOCUS. `group-hover` alone is a control the keyboard can reach but
 * never see, so the same opacity is tied to `focus-within` — the row it lives in is the group.
 */
function AgentActions({ agent, onRename }: { agent: AgentSummary; onRename: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const archived = Boolean(agent.archived_at);

  if (archived) {
    // A GLYPH, LIKE THE OTHER TWO ACTIONS ON THIS ROW. It was the word `Restore` while a live row
    // ended in an icon-only pencil and X — so the same list switched between a text affordance and
    // an icon affordance depending on row state, which is visible the moment an archived row sits
    // among live ones.
    return (
      <button
        onClick={() => sendRestoreAgent(agent.agent_id)}
        title="Bring this agent back"
        aria-label="Restore this agent"
        className="shrink-0 rounded-control p-1 text-muted transition-colors hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink"
      >
        <Icon.agents.restore size={ICON.xs} />
      </button>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <button
        onClick={onRename}
        title="Rename (double-click the row)"
        aria-label="Rename this agent"
        className="rounded-control p-1 text-faint transition-colors hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink"
      >
        <Icon.agentDetail.rename size={ICON.xs} />
      </button>
      {confirming ? (
        <button
          autoFocus
          onBlur={() => setConfirming(false)}
          onClick={() => {
            sendArchiveAgent(agent.agent_id);
            setConfirming(false);
          }}
          className="rounded-control border border-sidebar-border px-1.5 py-0.5 text-tiny text-ink"
        >
          Archive?
        </button>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          // The tooltip is the promise. Archiving is reversible and destroys nothing, and somebody
          // reaching for a control on the product's central object is entitled to know that before
          // they press it rather than after.
          title="Archive — nothing is deleted; its versions, runs and threads stay"
          className="rounded-control p-1 text-faint transition-colors hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink"
        >
          <Icon.threads.archive size={ICON.xs} />
        </button>
      )}
    </span>
  );
}

/**
 * An agent, and its runs beneath it when you open it.
 *
 * THE TREE IS THE POINT, and it replaces two flat lists that were not related to each other on
 * screen. Runs used to sit in their own section under every agent, so the question "what has THIS
 * agent been doing" was answered by reading a mixed list and matching ids by eye. A run belongs to
 * exactly one agent; nesting is what that fact looks like.
 *
 * AN AGENT WITH NO RUNS DOES NOT OPEN, and shows no chevron. A disclosure control that discloses
 * nothing is the dead control this codebase has a suite about — and the absence of the twisty is
 * itself the answer to "has this ever run".
 */
function AgentTreeRow({ agent, runs }: { agent: AgentSummary; runs: RunSummary[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(agent.name);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const selected = activeAgentId === agent.agent_id;
  const hasRuns = runs.length > 0;
  const shown = all ? runs : runs.slice(0, RUNS_AT_FIRST);

  const commit = (): void => {
    const next = draft.trim();
    // SENT EVEN WHEN IT MATCHES the name already shown, because committing the editor is a CHOICE:
    // the server's rename also sets the custom flag that stops the next disk sync overwriting it, so
    // "I want this name" and "this name happens to be what the file says" are different states.
    if (next) sendRenameAgent(agent.agent_id, next);
    setRenaming(false);
  };

  return (
    <>
      <div
        className={`group flex h-8 w-full items-center gap-1 rounded-control pr-1 transition-colors duration-fast ${
          selected ? "bg-sidebar-active" : "hover:bg-sidebar-hover"
        }`}
      >
        {/* THE TWISTY AND THE NAME ARE TWO CONTROLS, because they do two things: one opens the
            agent's runs, the other selects the agent into the three panes. Nesting a button inside
            a button is invalid markup and makes the inner one unreachable by keyboard. */}
        {hasRuns ? (
          <button
            onClick={() => setOpen((v) => !v)}
            title={open ? `Hide ${agent.name}'s runs` : `Show ${agent.name}'s runs`}
            aria-label={open ? `Hide ${agent.name}'s runs` : `Show ${agent.name}'s runs`}
            aria-expanded={open}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {open ? <Icon.workspace.switcherOpen size={ICON.xs} /> : <Icon.workspace.switcherClosed size={ICON.xs} />}
          </button>
        ) : (
          // The twisty's width, kept, so names line up whether or not an agent has ever run.
          <span className="h-5 w-5 shrink-0" aria-hidden />
        )}
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              // ESCAPE ABANDONS, and puts the draft back to the name on screen — otherwise
              // reopening the editor starts from the edit somebody just decided against.
              if (e.key === "Escape") { setDraft(agent.name); setRenaming(false); }
            }}
            className="min-w-0 flex-1 rounded-input bg-sidebar-active px-1.5 py-0.5 text-caption text-ink outline-none focus-visible:shadow-focusring"
          />
        ) : (
          <button
            onClick={() => selectAgent(agent.agent_id)}
            title={identityTitle(agent.name, agent.category)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left focus-visible:outline-none focus-visible:shadow-focusring"
          >
            <AgentDot status={agentStatus(agent.agent_id, useTraceStore.getState().runs, agent.deployment)} />
            <AgentIdentityLine emoji={agent.emoji} name={agent.name} category={agent.category} nameClassName="text-label" />
          </button>
        )}
        {!renaming && (
          <AgentActions agent={agent} onRename={() => { setDraft(agent.name); setRenaming(true); }} />
        )}
      </div>

      {open && hasRuns && (
        <div className="flex flex-col">
          {shown.map((r) => (
            // Indented to the twisty's width, so a run reads as belonging to the row above it.
            <div key={r.id} className="pl-5">
              <RunRow run={r} />
            </div>
          ))}
          {/* Offered only when there is genuinely more, and it says how much more rather than
              "Show more" — a count is the difference between a control you can decide about and
              one you have to press to find out. */}
          {!all && runs.length > RUNS_AT_FIRST && (
            <button
              onClick={() => setAll(true)}
              className="w-full py-1 pl-10 pr-3 text-left text-tiny text-muted transition-colors hover:bg-sidebar-hover hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
            >
              Show {runs.length - RUNS_AT_FIRST} more…
            </button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Who is signed in, and what this workspace is paying.
 *
 * THREE LITERALS USED TO LIVE HERE: the avatar letter `J`, the name `jaroku`, and a `Free` chip.
 * Every signed-in user saw all three, whatever their account and whatever their plan — and the
 * product holds a correct copy of both facts elsewhere, which makes this the exact anti-pattern the
 * Threads spec argues against for the nav badge: one quantity, rendered twice, derived twice. A paid
 * workspace reading `Free` in the sidebar while the Usage panel reads `Pro` is worse than showing
 * nothing.
 *
 * SO BOTH COME FROM THE SESSION, and the plan's LABEL comes from the server — `planFor`, the same
 * function the budget gate resolves limits through. Nothing is mapped here; a plan-id-to-name table
 * in the client would be the second copy all over again.
 *
 * It is also the door to the workspace panel, because that is what somebody clicking their own name
 * is reaching for.
 */
function AccountRow() {
  const user = useSessionStore((s) => s.user);
  const workspaces = useSessionStore((s) => s.workspaces);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const openWorkspacePanel = useUiStore((s) => s.openWorkspacePanel);
  const setProviderPanel = useUiStore((s) => s.setProviderPanel);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const name = user?.displayName || user?.email;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /**
   * The three ways out, on one listener — the shape `WorkspaceSwitcher` already uses.
   *
   * `mousedown` RATHER THAN `click`, so a press that starts outside closes the menu before the
   * thing underneath it receives the release. With `click` the first press anywhere else both
   * closes this and activates whatever it landed on, which is one gesture doing two things.
   */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // Before the session lands there is no account to name. An empty row is quieter than a
  // placeholder that flashes into somebody else's initial.
  if (!user) return <div className="h-8" />;

  /**
   * WHAT THE MENU OPENS, AND WHERE. Each row here closes the menu and opens a panel that renders
   * CENTRED over the application — the workspace panel and the provider-key dialog both already
   * do, and they are the two things somebody clicking their own name is reaching for. The menu is
   * the near thing, anchored to the row; the dialog is the far thing, over everything.
   */
  const choose = (run: () => void) => () => { setOpen(false); run(); };

  return (
    <div ref={ref} className="relative">
      {open && (
        // ANCHORED TO THE BOTTOM OF THE SIDEBAR, opening UPWARD, because the row it belongs to is
        // the last one in the column: a menu that dropped down would open off the bottom edge.
        <div
          role="menu"
          aria-label="Account"
          className="absolute bottom-full left-0 z-30 mb-1 w-full overflow-hidden rounded-control border border-sidebar-border bg-panel py-1 shadow-pop"
        >
          <button role="menuitem" onClick={choose(() => openWorkspacePanel("account"))} className={ACCOUNT_MENU_ROW}>
            <Icon.workspace.settings size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">Account &amp; workspace</span>
          </button>
          <button role="menuitem" onClick={choose(() => setProviderPanel(true))} className={ACCOUNT_MENU_ROW}>
            <Icon.nav.providerKeys size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">Provider keys</span>
          </button>
          <AdminModeToggle />
        </div>
      )}

      {/* TWO CONTROLS, NOT ONE BUTTON WITH A SECOND INSIDE IT. Nesting is invalid markup and the
          browser's own recovery from it is to flatten — which is how a "sign out" glyph inside a
          row ends up firing the row's own click as well. */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={name}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-sidebar-hover active:bg-sidebar-active focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {/* The first letter of whoever is actually here, uppercased. */}
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control bg-sidebar-active text-tiny text-ink">
            {(name ?? "?").trim().charAt(0).toUpperCase()}
          </span>
          <Truncate className="min-w-0 flex-1 text-label text-ink" title={name}>{name}</Truncate>
          {/* Only when the session carries one. A chip is a claim about what the workspace is
              paying, and inventing a default for it is how the hardcoded `Free` got there in the
              first place. */}
          {workspace?.plan?.label && (
            <Chip caps size="sm" tone="faint" className="shrink-0">{workspace.plan.label}</Chip>
          )}
          <span className="shrink-0 text-faint">
            {open ? <Icon.workspace.switcherOpen size={ICON.xs} /> : <Icon.workspace.switcherClosed size={ICON.xs} />}
          </span>
        </button>
        {/* SIGN OUT LIVES WITH THE PERSON, and stays OUT of the menu above it. Ending a session is
            the one irreversible-feeling thing here, and a list you open to change a setting is the
            wrong place to put it — it is its own control, beside the name, where a mis-aimed click
            on a menu row cannot reach it. */}
        <button
          onClick={signOut}
          title="Sign out"
          aria-label="Sign out"
          className="shrink-0 rounded-control p-1.5 text-faint transition-colors hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <Icon.auth.signOut size={ICON.sm} />
        </button>
      </div>
    </div>
  );
}

/** One row of the account menu. Spelled once so the three cannot drift apart. */
const ACCOUNT_MENU_ROW =
  "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-caption text-muted transition-colors hover:bg-sidebar-hover hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring";

function AdminModeToggle() {
  const user = useSessionStore((s) => s.user);
  const setAdminMode = useSessionStore((s) => s.setAdminMode);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user?.isAdmin) return null;

  const apply = async (on: boolean): Promise<void> => {
    setError(null);
    try {
      await setAdminMode(on);
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (user.adminMode) {
    // While it is ON the banner across the top is the primary control. This stays as a second door
    // so the switch is where somebody looks for it, and reads as a state rather than an offer.
    return (
      <button
        onClick={() => void apply(false)}
        className="mt-0.5 flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-tiny text-err transition-colors hover:bg-sidebar-hover"
      >
        <span className="shrink-0"><AlertTriangleIcon size={ICON.badge} /></span>
        <span>Admin mode on — turn off</span>
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="mt-0.5 rounded-control border border-run/40 bg-run/[0.06] px-2 py-1.5">
        <p className="text-tiny leading-[1.5] text-ink">
          Enable admin mode? This bypasses every tier limit and feature gate. Everything you do
          while it is on is logged as admin-privileged.
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button className={secondaryBtn} onClick={() => void apply(true)}>Enable</button>
          <button className={quietBtn} onClick={() => { setConfirming(false); setError(null); }}>
            Cancel
          </button>
        </div>
        {error && <p className="mt-1 text-tiny text-err">{error}</p>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="mt-0.5 flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-tiny text-faint transition-colors hover:bg-sidebar-hover hover:text-muted"
    >
      <span>Admin mode</span>
      <span className="ml-auto shrink-0">off</span>
    </button>
  );
}

/**
 * The six status filters, behind one funnel.
 *
 * THEY WERE SIX TEXT TABS IN A NON-WRAPPING ROW, and at the sidebar's default width the row
 * overflowed its own pane: `Synced` was cut mid-word at the edge and `Drafts` was not on screen at
 * all. A control row that clips two of its own options at the width it ships at has failed before
 * any question of style is asked — and widening the words was never the fix, because the pane is
 * resizable and there is no width at which six labels and a list both fit comfortably.
 *
 * The funnel carries the current choice: it is muted with no dot while the filter is `all`, and
 * accented with the count beside it otherwise, so the state is legible without opening anything.
 * Nothing is removed — the same six, in the same order, with the same counts and the same rule
 * about Archived appearing only when there is something in it.
 */
function FilterMenu({
  filter,
  setFilter,
  counts,
  className = "",
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  counts: Record<"running" | "deployed" | "synced" | "drafts" | "archived", number>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const entries: { id: Filter; label: string; count?: number }[] = [
    { id: "all", label: "All" },
    { id: "running", label: "Running", count: counts.running },
    { id: "deployed", label: "Deployed", count: counts.deployed },
    { id: "synced", label: "Synced", count: counts.synced },
    { id: "drafts", label: "Drafts", count: counts.drafts },
  ];
  // Only when there is something in it. An Archived entry on a workspace that has never archived
  // anything leads to an empty state, which is the same noise an empty section is in Threads.
  if (counts.archived > 0) entries.push({ id: "archived", label: "Archived", count: counts.archived });

  const current = entries.find((e) => e.id === filter);
  const filtering = filter !== "all";

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={filtering ? `Filtered: ${current?.label}` : "Filter agents"}
        aria-label={filtering ? `Filtered: ${current?.label}` : "Filter agents"}
        aria-expanded={open}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-control px-1 transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
          filtering || open ? "bg-sidebar-active text-accent" : "text-muted hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink"
        }`}
      >
        <Icon.agents.filter size={ICON.sm} />
        {filtering && current?.count != null && (
          <span className="text-tiny tabular-nums">{current.count}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[170px] animate-slide-in rounded-card border border-sidebar-border bg-elevated p-1 shadow-floating motion-reduce:animate-none">
          {entries.map((e) => (
            <button
              key={e.id}
              onClick={() => {
                setFilter(e.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-caption transition-colors duration-fast ${
                filter === e.id ? "bg-sidebar-active text-ink" : "text-muted hover:bg-sidebar-hover hover:text-ink"
              }`}
            >
              {e.label}
              {e.count != null && e.count > 0 && (
                <span className="ml-auto text-tiny tabular-nums text-faint">{e.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const runs = useTraceStore((s) => s.runs);
  const agents = useBuildStore((s) => s.agents);
  const [filter, setFilter] = useState<Filter>("all");
  // Searching moved into the palette (see `SidebarChrome`), so the query the list filters by
  // is now only ever empty here. Kept as the one place the filter reads from, so restoring an
  // in-column box later is a change to one component rather than to the filter predicate.
  const query = "";
  const [recentsOpen, setRecentsOpen] = useState(true);
  // Per AGENT rather than per workspace — §4. Different agents legitimately belong in different
  // repositories, and one repo per workspace would break the monorepo case the subdirectory field
  // exists for.
  const githubViews = useGithubStore((s) => s.views);
  // §2: pinned agents, then the active/recent ones. The pins are this person's own, from localStorage
  // keyed by workspace — see uiStore.
  const pinnedIds = useUiStore((s) => s.pinnedAgents);

  const counts = { running: 0, deployed: 0, synced: 0, drafts: 0, archived: 0 };
  for (const a of agents) {
    // COUNTED FIRST AND THEN SKIPPED. An archived agent is not running, not a draft and not
    // deployed as far as this column is concerned — it is not offering work at all — so counting it
    // under a live state would put a number beside a tab whose list does not contain it.
    if (a.archived_at) {
      counts.archived++;
      continue;
    }
    const st = agentStatus(a.agent_id, runs, a.deployment);
    if (st === "running") counts.running++;
    else if (st === "draft") counts.drafts++;
    // Counted separately from the filter's `else if` chain: an agent that is deployed AND
    // running locally is both, and a Deployed tab that hid it while a test run was in flight
    // would flicker its own count.
    if (st === "deployed" || st === "deploying") counts.deployed++;
    // Counted outside the status chain for the reason Deployed is: linked and running are
    // orthogonal facts, and a Synced count that flickered while a test run was in flight would be
    // counting the wrong thing.
    if (githubViews[a.agent_id]) counts.synced++;
  }

  const q = query.trim().toLowerCase();
  const visible = agents.filter((a) => {
    if (q && !(`${a.name} ${a.agent_id}`.toLowerCase().includes(q))) return false;
    // ARCHIVED IS ITS OWN LIST AND IS IN NO OTHER, which is what makes archiving mean something:
    // §3.4's rule for threads, applied to the object threads hang off.
    if (filter === "archived") return Boolean(a.archived_at);
    if (a.archived_at) return false;
    if (filter === "all") return true;
    const st = agentStatus(a.agent_id, runs, a.deployment);
    if (filter === "running") return st === "running";
    if (filter === "synced") return Boolean(githubViews[a.agent_id]);
    if (filter === "drafts") return st === "draft";
    // Deployed shows what is live AND what is on its way there — the tab is about where an
    // agent is, and a deploy in flight is the most interesting answer that question has.
    return st === "deployed" || st === "deploying";
  });

  // In the order they were pinned, and only the ones that still exist: a pin outlives the agent it
  // names (an agent can be deleted while a pin sits in localStorage), and rendering a row for one that
  // is gone would be a sidebar entry that cannot be selected.
  const pinned = pinnedIds
    .map((id) => agents.find((a) => a.agent_id === id))
    // ...and not the ones that have been put away. A pinned agent that is archived would sit at the
    // top of the column it was just removed from, which is the one place it must not be.
    .filter((a): a is AgentSummary => a !== undefined && !a.archived_at);

  const runList = orderedRuns(runs);
  // How wide the window is, and whether the server says there is anything behind it.
  const historyWindow = useTraceStore((st) => st.historyWindow);
  const historyComplete = useTraceStore((st) => st.historyComplete);

  /**
   * Every run, filed under the agent that produced it.
   *
   * BUILT ONCE PER RENDER RATHER THAN FILTERED PER ROW. A `runList.filter(...)` inside `AgentRow`
   * is O(agents x runs) and this column is the one that redraws on every trace event — the list is
   * already ordered newest-first, so a single pass keeps that order inside each bucket for free.
   */
  const runsByAgent = new Map<string, RunSummary[]>();
  for (const r of runList) {
    const bucket = runsByAgent.get(r.agent_id);
    if (bucket) bucket.push(r);
    else runsByAgent.set(r.agent_id, [r]);
  }

  // §2: pinned first, then everything else, with no agent appearing twice.
  const pinnedSet = new Set(pinned.map((a) => a.agent_id));
  const recents = [...pinned, ...visible.filter((a) => !pinnedSet.has(a.agent_id))];

  return (
    /**
     * ONE COLUMN, NO DIVISIONS. This was a 40px rail of glyphs beside a list, with a switcher
     * spanning both and a status strip under the whole application. Five regions stacked in one
     * plane replace it: the window's own title row, the workspace, the five destinations, the
     * agents, and whoever is signed in — in that order, because that is the order they scope each
     * other in. Only the agents scroll; everything else is chrome and stays put.
     */
    <div className="flex h-full flex-col bg-sidebar">
      <SidebarChrome />
      <WorkspaceSwitcher />
      <NavList />

      {/* RECENTS — the agents, and their runs under them. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 pl-1.5 pr-2">
          <button
            onClick={() => setRecentsOpen((v) => !v)}
            aria-expanded={recentsOpen}
            title={recentsOpen ? "Collapse recents" : "Expand recents"}
            aria-label={recentsOpen ? "Collapse recents" : "Expand recents"}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {recentsOpen ? <Icon.workspace.switcherOpen size={ICON.xs} /> : <Icon.workspace.switcherClosed size={ICON.xs} />}
          </button>
          <span className={`min-w-0 flex-1 ${TYPE.panelLabel}`}>Recents</span>
          {/* THE PLUS LEFT THIS ROW for the `New` destination at the top of the column. A control
              that creates an agent was filed beside the filter that narrows a list of them, which
              made "new" read as a thing you do to the list rather than the first thing you do at
              all. What is left here is what genuinely belongs to Recents: how it is filtered. */}
          <FilterMenu filter={filter} setFilter={setFilter} counts={counts} />
        </div>

        {/* `overflow-x-hidden` RATHER THAN NOTHING: a row that runs out of room truncates, and a
            truncation ends in an ellipsis rather than in a horizontal scrollbar nobody looks for. */}
        {recentsOpen && (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
            {recents.length === 0 ? (
              <EmptyState
                size="inline"
                icon={agents.length === 0 ? SparklesIcon : SearchIcon}
                title={agents.length === 0 ? "No agents yet" : "Nothing here"}
                hint={
                  agents.length === 0
                    ? "Describe one in the composer and you’ll get a plan to approve first."
                    : undefined
                }
              />
            ) : (
              recents.map((a) => (
                <AgentTreeRow key={a.agent_id} agent={a} runs={runsByAgent.get(a.agent_id) ?? []} />
              ))
            )}

            {/* THE WINDOW, WIDENED FROM HERE. The history read stops at a cap, so the runs nested
                above are the ones that have been FETCHED — this is how the 51st-newest becomes
                reachable at all, and it stays out of any one agent's subtree because it widens the
                window for all of them. */}
            {runList.length >= historyWindow && !historyComplete && (
              <button
                onClick={() => sendLoadHistory(Math.min(historyWindow * 2, 500))}
                className="mt-1 w-full rounded-control px-2 py-1.5 text-left text-tiny text-muted transition-colors hover:bg-sidebar-hover hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
              >
                Load older runs…
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom-anchored: who is signed in. */}
      <div className="shrink-0 border-t border-sidebar-border px-2 py-2">
        <AccountRow />
      </div>
    </div>
  );
}

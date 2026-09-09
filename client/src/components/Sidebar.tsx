// Left sidebar — the agent/run library (doc §4.1). Top: New Agent, search, and status filter
// tabs over the agent list. A flexible middle holds recent runs (how you re-open a past trace).
// Bottom-anchored: Settings and the user/plan chip. Restraint-first: rows float on the panel,
// separated by spacing and a thin accent on the active one — never boxed.

import { useEffect, useRef, useState } from "react";
import { orderedRuns, useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import type { AgentSummary, RunSummary, RunStatus } from "../types.ts";
import { absTime, relTime } from "../lib/format.ts";
import { agentStatus } from "../lib/agentStatus.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { RUN_PHASE } from "../lib/domainPhase.ts";
import { PHASE_WORD, type Phase } from "../lib/statusPhase.ts";
import { selectAgent, selectRun } from "../lib/selection.ts";
import {
  sendLoadHistory, sendLoadRun, sendOpenGithubPr, sendRun, signOut,
} from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { quietBtn, secondaryBtn } from "./buttons.ts";
import { AlertTriangleIcon } from "./panelIcons.tsx";
import { useUiStore, type NavDestination } from "../store/uiStore.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useWorkStore, workBadgeCount } from "../store/workStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
import { Truncate } from "./Truncate.tsx";
import { identityTitle } from "./AgentIdentityLine.tsx";
import { AgentEmoji, EMOJI_SIZE } from "./AgentEmoji.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { keyHint } from "../lib/modKey.ts";
import { startNewAgent } from "../lib/newAgent.ts";
import { goBack, goForward } from "../lib/navHistory.ts";
import { canGoBack, canGoForward, useHistoryStore } from "../store/historyStore.ts";
import { hasHostWindow } from "../lib/windowStage.ts";
import { loadAvatar } from "../lib/avatar.ts";
import { useMenuFocus } from "../lib/menuFocus.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { SearchIcon, SparklesIcon } from "./panelIcons.tsx";


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
/**
 * How long a run took, from the two timestamps it already carries.
 *
 * SHOWN ONLY WHEN IT FINISHED. A duration computed against `Date.now()` for a run still in flight
 * is a number that changes every render and means "so far" while reading as "took" — and the row
 * already says `running` in its capsule, which is the honest answer to how long it took.
 */
function runDuration(run: RunSummary): string | null {
  if (!run.ended_at) return null;
  const ms = new Date(run.ended_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * The first line of an error, short enough to sit at the end of a row.
 *
 * The stored message is a whole Python traceback in the common case — `BadRequestError: Error code:
 * 400 - {...}` runs to three hundred characters. What fits here is the class and the first clause,
 * and the full text is one click away in the trace.
 */
function errorSnippet(error: string): string {
  const first = error.split("\n")[0] ?? error;
  const clipped = first.length > 34 ? `${first.slice(0, 33)}…` : first;
  return clipped;
}

/**
 * A run's outcome as a capsule: a coloured ground, the SHARED glyph, and the phase's own word.
 *
 * THE MARK IS `StatusGlyph` AND THE WORD IS `PHASE_WORD`, NOT A CHECK AND A CROSS PICKED HERE.
 * This product draws one status vocabulary across nine surfaces — the Cockpit, Threads, Deploy,
 * MCP, evals, the agent cards — and `test:status-glyph` holds every one of them to it, in both
 * directions: the surfaces that must draw it and the four that must not. A tick chosen locally
 * would have been a tenth vocabulary that agreed with the other nine today and drifted the first
 * time `done` changed shape.
 *
 * WHAT IS NEW HERE IS THE CAPSULE, not the glyph: a soft ground and the word beside the mark, so a
 * run's outcome reads at a glance in a dense list. `RUN_PHASE` maps the four run statuses onto the
 * four phases, so `paused` gets amber and its own word for free rather than falling into an
 * `ok ? green : red` that would call it a failure.
 */
const PHASE_TONE: Record<Phase, string> = {
  pending: "bg-sidebar-active text-muted",
  ready: "bg-sidebar-active text-muted",
  // The only phase permitted amber, here as everywhere else.
  active: "bg-run/10 text-run",
  waiting: "bg-sidebar-active text-muted",
  // GREEN FOR DONE IS THIS CAPSULE'S OWN CHOICE, and worth naming: `PHASE_COLOUR` draws a finished
  // thing NEUTRAL across the product, because "it worked" is the ordinary case and a wall of green
  // ticks is a wall of noise. On one row inside a list of runs the outcome IS the content, so the
  // ground carries it. The GLYPH is still the shared one; only the capsule around it is new.
  done: "bg-ok/10 text-ok",
  failed: "bg-err/10 text-err",
  halted: "bg-sidebar-active text-muted",
};

function RunStatusCapsule({ status }: { status: RunStatus }) {
  const phase = RUN_PHASE[status];
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-tiny font-medium ${PHASE_TONE[phase]}`}
    >
      <StatusGlyph phase={phase} size={ICON.xs} />
      {PHASE_WORD[phase]}
    </span>
  );
}

/**
 * The overflow, revealed on hover and on focus.
 *
 * TWO ITEMS, NOT FOUR. The specification asked for view trace, retry, delete and export logs; the
 * first two are commands this application has (`loadRun`/`selectRun`, and `run` against the agent),
 * and the second two are not — there is no `deleteRun` and no log export on the wire, and deleting
 * a run correctly means cascading across `steps` (partitioned by month), `usage_events` and the
 * checkpoints, none of which has a foreign key onto `runs`. A menu row that closes the menu and
 * does nothing is the exact control `test:dead-controls` exists to keep out, so the two that cannot
 * work are absent rather than disabled-with-a-tooltip.
 */
function RunOverflow({ run, agentId }: { run: RunSummary; agentId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  // See lib/menuFocus.ts — the panel is rendered BEFORE its trigger, so without this the
  // keyboard steps straight over the menu it just opened, and Escape drops focus to <body>.
  useMenuFocus(open, ref);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        aria-label={`More actions for run ${shortRunId(run.id)}`}
        className={`flex h-6 w-6 items-center justify-center rounded-control text-faint transition-opacity hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring ${
          open ? "opacity-100" : "opacity-0 group-hover/run:opacity-100 group-focus-within/run:opacity-100"
        }`}
      >
        <Icon.agents.more size={ICON.sm} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Run actions"
          className="absolute right-0 top-full z-30 mt-1 w-40 origin-top animate-menu-in overflow-hidden rounded-control border border-sidebar-border bg-panel py-1 shadow-pop motion-reduce:animate-none"
        >
          <button
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              if (useTraceStore.getState().needsLoad(run.id)) sendLoadRun(run.id);
              selectRun(run.id);
            }}
            className={ACCOUNT_MENU_ROW}
          >
            <Icon.panel.trace size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">View trace</span>
          </button>
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setOpen(false); selectAgent(agentId); sendRun(); }}
            className={ACCOUNT_MENU_ROW}
          >
            <Icon.cockpit.refresh size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">Run again</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Which run this is, for a person rather than for a database.
 *
 * A POSITION, NOT AN IDENTIFIER, AND THAT IS A REAL LIMITATION. There is no per-agent counter on
 * the server — a run is a uuid — so this counts backwards from the newest run LOADED. The history
 * is a window, so a run's number changes when older runs arrive behind it: today's run is #12 of
 * twelve loaded and #47 once the rest are fetched. It is the right shape for the row and the wrong
 * shape for anything durable, which is why nothing quotes it and the tooltip carries the id.
 */
function runNumber(runs: RunSummary[], run: RunSummary): number {
  return runs.length - runs.indexOf(run);
}

/** The first segment of a uuid — enough to tell two runs apart in a tooltip. */
const shortRunId = (id: string): string => id.slice(0, 8);

function RunRow({ run, runs, agentId }: { run: RunSummary; runs: RunSummary[]; agentId: string }) {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const needsLoad = useTraceStore((s) => s.needsLoad);
  const active = run.id === activeRunId;
  const duration = runDuration(run);
  const failed = run.status === "error";

  return (
    <div
      className={`group/run relative flex h-7 w-full items-center gap-2 rounded-control pl-2 pr-1 transition-colors ${
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover"
      }`}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" aria-hidden />}
      <button
        onClick={() => { if (needsLoad(run.id)) sendLoadRun(run.id); selectRun(run.id); }}
        title={`${shortRunId(run.id)} · ${run.provider} · ${absTime(run.started_at)}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <RunStatusCapsule status={run.status} />
        {/* Branches keep their fork mark: a branched run is a different thing from a re-run. */}
        {run.parent_run_id && (
          <span className="shrink-0 text-faint" title="branch"><Icon.agents.fork size={ICON.xs} /></span>
        )}
        {/* THE SELECTED RUN IS SAID BY THE ROW, NOT BY THE FIGURE. This was
            `active ? "text-accent" : "text-ink"`, and it worked while the accent was a near-navy;
            new-theme.pdf's accent is §05's charcoal, which is `ink` — the same value on both arms.
            The row already carries `bg-sidebar-active` and a 2px bar, which is how every other
            selected thing in the product says so, and dimming the unselected run numbers to buy a
            third signal would cost the column the one figure people scan it for. */}
        <span className="shrink-0 text-caption tabular-nums text-ink">
          Run #{runNumber(runs, run)}
        </span>
        {/* THE TIME, THEN WHAT IT COST YOU — a duration when it worked, the reason when it did not.
            One slot, because they answer the same question: what happened after it started. */}
        <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-tiny tabular-nums text-faint">
          <span className="shrink-0" title={absTime(run.started_at)}>{relTime(run.started_at)}</span>
          {failed && run.error
            ? <span className="min-w-0 truncate text-err" title={run.error}>{errorSnippet(run.error)}</span>
            : duration && <span className="shrink-0">{duration}</span>}
        </span>
      </button>
      <RunOverflow run={run} agentId={agentId} />
    </div>
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
  const back = useHistoryStore(canGoBack);
  const forward = useHistoryStore(canGoForward);
  const underHost = hasHostWindow();

  return (
    <div
      data-tauri-drag-region
      className={`flex h-11 shrink-0 items-center gap-1 pr-2 ${underHost ? "pl-[76px]" : "pl-2"}`}
    >
      {/* WHERE YOU HAVE BEEN, since there is no address bar to hold it. A place here is a
          destination plus the agent the panes are pointed at — see `store/historyStore`.

          DISABLED IS THE HONEST STATE AND IT IS SAID TWICE: `disabled` so the pointer and the
          keyboard both skip it, and the ink drops to `faint` so it reads as unavailable before
          anybody presses it. At the start of a session both are dim, which is correct — there is
          nowhere behind you yet. */}
      <button
        onClick={goBack}
        disabled={!back}
        title="Back"
        aria-label="Back"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
          back ? "text-ink hover:bg-sidebar-hover" : "cursor-default text-faint"
        }`}
      >
        <Icon.nav.historyBack size={ICON.md} />
      </button>
      <button
        onClick={goForward}
        disabled={!forward}
        title="Forward"
        aria-label="Forward"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
          forward ? "text-ink hover:bg-sidebar-hover" : "cursor-default text-faint"
        }`}
      >
        <Icon.nav.historyForward size={ICON.md} />
      </button>
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
        <Icon.agents.search size={ICON.md} />
      </button>
      {/* THE LABEL NAMES THE ACTION, not the state — the `IconButton` contract, and the reason one
          mark serves both directions. */}
      <button
        onClick={toggleSidebar}
        title="Hide the sidebar"
        aria-label="Hide the sidebar"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-sidebar-hover active:bg-sidebar-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <Icon.nav.sidebarToggle size={ICON.md} />
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
  const newIsCurrent = activeAgentId === null && navSection === null;
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
        onClick={startNewAgent}
        // ACCURATE EVEN THOUGH THE FILL IS NOT. The background below is permanent; `aria-current`
        // is not, because two rows announcing themselves as the current page is worse for somebody
        // reading this column through a screen reader than no emphasis at all.
        aria-current={newIsCurrent ? "page" : undefined}
        title={`New agent — ${keyHint("⌘N")}`}
        className={`group/new flex h-7 w-full shrink-0 items-center gap-2.5 rounded-control bg-sidebar-active px-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
          // THE FILL IS ALWAYS THERE; ONLY THE INK MOVES. Every other row in this column is lit
          // only while it is the destination you are in, and this one is not a destination — it is
          // the thing to press. Keeping the surface makes it read as the column's one button
          // rather than as a tab that happens to be selected, and the accent still says whether
          // you are actually sitting in it.
          newIsCurrent ? "text-accent" : "text-muted hover:text-ink"
        }`}
      >
        {/* THE MARK GETS THE FILL, NOT THE ROW. `New` is the column's one button and the tile is
            what says so — a small black square with a white plus, the size of the marks beside it,
            so the row still scans as a row. Filling the whole row instead would make it a banner
            and put a black bar across the top of a column of quiet text. */}
        <span
          aria-hidden
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-xs bg-ink text-bg"
        >
          <Icon.nav.newAgent size={ICON.sm} />
        </span>
        <span className="min-w-0 flex-1 truncate text-label">New</span>
        {/* THE CHORD, ON APPROACH. A shortcut printed permanently is a second thing to read on a
            row with two words on it; one that appears when the pointer arrives is there exactly
            when somebody is deciding whether to click or to type. `group-focus-within` as well, so
            the keyboard is told what the pointer is told. */}
        <kbd className="shrink-0 text-tiny leading-none text-faint opacity-0 transition-opacity duration-fast group-hover/new:opacity-100 group-focus-within/new:opacity-100">
          {keyHint("⌘N")}
        </kbd>
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
            className={`flex h-7 w-full shrink-0 items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              active ? "bg-sidebar-active text-accent" : "text-muted hover:bg-sidebar-hover hover:text-ink"
            }`}
          >
            <Mark size={ICON.lg} />
            <span className="min-w-0 flex-1 truncate text-label">{label}</span>
            {badge > 0 && (
              <span
                title={badgeTitle}
                // A CLASS RATHER THAN AN INLINE STYLE, so the material can reach it. An inline
                // `background` wins over every stylesheet rule there is, which left this badge the
                // one opaque patch in the column that could not be softened with the rest.
                className={`shrink-0 rounded-xs px-1 text-tiny leading-[15px] tabular-nums ${
                  id === "threads" ? "text-run" : "bg-chrome text-ink"
                }`}
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
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const selected = activeAgentId === agent.agent_id;
  const hasRuns = runs.length > 0;
  const shown = all ? runs : runs.slice(0, RUNS_AT_FIRST);
  // `runs` is newest-first, so the head is when this agent last did anything — and when it has
  // never run, when it was made. THE ROW SHOWED NOTHING for a new agent, which is the one moment
  // the column is most likely to be looked at: the agent you just described, with no time beside
  // it. Two different facts, so the label below says which.
  const lastRunAt = runs[0]?.started_at ?? null;
  const stamp = lastRunAt ?? agent.created_at ?? null;
  const stampWord = lastRunAt ? "last run" : "created";
  // Null until this agent has a pull request open — see the marker below.
  const pr = useGithubStore((st) => st.views[agent.agent_id]?.pr ?? null);
  // Whether this agent has a repository behind it at all — which decides whether the control below
  // opens a pull request or opens the panel where one becomes possible.
  const linked = useGithubStore((st) => Boolean(st.views[agent.agent_id]?.link));
  // WHETHER THE COUNT BESIDE THE NAME IS A TOTAL OR A WINDOW. `listRuns` takes a cap, so until the
  // server says the history is complete this agent may have runs nobody has fetched — and a badge
  // reading `5 Runs` on an agent with forty-seven is the wrong-count failure §13 names: "A missing
  // count is fine. A wrong count is not." The figure stays (it is what the row is for) and the
  // sentence on hover stops it being a claim about the total.
  const historyComplete = useTraceStore((st) => st.historyComplete);



  return (
    <>
      <div
        // ELEVEN, NOT SEVEN. This row carries two lines now — a name over a category and a time —
        // and 28px was the height of the single-line row it replaced: the two lines met in the
        // middle with nothing between them and nothing above or below. 44px is the pair plus the
        // air that makes them read as one row rather than as two cramped ones.
        //
        // AND IT SAYS WHICH AGENT IS SELECTED THE WAY EVERY OTHER ROW IN THIS COLUMN DOES. It did
        // not: the only mark was the name in `text-accent`, which worked while the accent was a
        // near-navy and says nothing at all now that new-theme.pdf's accent is §05's charcoal — the
        // same value the name already had. A fill and a 2px bar are what the run rows under this
        // one and the five destinations above it use, so this is the pattern arriving somewhere it
        // was missing rather than a new one, and it survives an accent that is a neutral.
        className={`group relative flex h-11 w-full items-center gap-1 rounded-control pr-1 transition-colors duration-fast ${
          selected ? "bg-sidebar-active" : "hover:bg-sidebar-hover"
        }`}
      >
        {/* NO SELECTION BAR HERE, AND IT WAS HERE FOR TWO COMMITS. It was added when the accent was
            the only thing marking a selected agent and the row had no fill at all — but the accent
            is §05's charcoal, so on a translucent column a 2px bar of it is a hard black stroke
            against a soft material, which is the one thing in the column that does not belong to
            it. The row's fill says "this one" now, and says it in the material's own terms. */}
        {/* THE TWISTY AND THE NAME ARE TWO CONTROLS, because they do two things: one opens the
            agent's runs, the other selects the agent into the three panes. Nesting a button inside
            a button is invalid markup and makes the inner one unreachable by keyboard. */}
        {hasRuns ? (
          <button
            onClick={() => setOpen((v) => !v)}
            title={open ? `Hide ${agent.name}'s runs` : `Show ${agent.name}'s runs`}
            aria-label={open ? `Hide ${agent.name}'s runs` : `Show ${agent.name}'s runs`}
            aria-expanded={open}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {open ? <Icon.workspace.switcherOpen size={ICON.lg} /> : <Icon.workspace.switcherClosed size={ICON.lg} />}
          </button>
        ) : (
          // The twisty's width, kept, so names line up whether or not an agent has ever run.
          <span className="h-6 w-6 shrink-0" aria-hidden />
        )}
        <button
          onClick={() => selectAgent(agent.agent_id)}
          title={identityTitle(agent.name, agent.category)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <AgentEmoji emoji={agent.emoji} size={EMOJI_SIZE.sidebar} />
          {/* TWO LINES: who it is, then what it is and when it last ran. The category and the
              timestamp are both qualifiers on the name, so they share the second line and the
              name gets the first to itself — at 13px semibold it is the thing the eye lands on
              when scanning a column of agents. */}
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            {/* Ink whether or not it is the selected one — see the run row above for why the
                ternary that used to be here had the same value on both arms, and why the fill and
                the bar are what say "this one". A name is content; content does not dim. */}
            <Truncate className="text-label text-ink" title={agent.name}>
              {agent.name}
            </Truncate>
            <span className="flex min-w-0 items-center gap-1.5 text-tiny text-faint">
              {agent.category && <Truncate className="min-w-0" title={agent.category}>{agent.category}</Truncate>}
              {agent.category && stamp && <span aria-hidden>·</span>}
              {stamp && (
                <span className="shrink-0 tabular-nums" title={`${stampWord} ${absTime(stamp)}`}>
                  {relTime(stamp)}
                </span>
              )}
            </span>
          </span>
        </button>
        {/* THE PULL REQUEST, AND IT IS ON EVERY ROW because it is a control rather than a badge.
            "Only when there is one" made it invisible on exactly the agents somebody would want to
            open one FOR — and an affordance you cannot find until after you have used it is not an
            affordance. It has a real action in all three states, so it is never a dead control:

              a PR is open        green, and it opens that PR on GitHub
              linked, no PR       muted, and it opens one — `sendOpenGithubPr`
              not linked yet      muted, and it opens the GitHub panel, where linking happens

            Green ONLY for the first, because green here means "there is something to look at"
            rather than "this worked" — the run capsules own that meaning two rows down. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (pr) { window.open(pr.url, "_blank", "noopener,noreferrer"); return; }
            if (linked) { sendOpenGithubPr(agent.agent_id); return; }
            selectAgent(agent.agent_id);
            useUiStore.getState().setRightTab("github");
          }}
          title={
            pr ? `Pull request #${pr.number} — ${pr.title}`
              : linked ? "Open a pull request for this agent"
              : "Connect this agent to a repository"
          }
          aria-label={
            pr ? `Open pull request #${pr.number} on GitHub`
              : linked ? "Open a pull request for this agent"
              : "Connect this agent to a repository"
          }
          // GREEN IN EVERY STATE. It was green only when a PR was open and muted otherwise, which
          // made the mark carry the state as well as the action — and the state is already in the
          // tooltip and in what pressing it does. What the colour buys here is a control the eye
          // finds on a row of grey text; the three states differ in behaviour, not in shade.
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-ok transition-colors hover:bg-sidebar-hover focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <Icon.github.openPullRequest size={ICON.sm} />
        </button>
        {/* THE RUN COUNT, ALWAYS — `0 Runs` included. A badge that disappears at zero makes the
            one state somebody most wants to see at a glance, "this has never run", the only
            state with nothing to read. */}
        <span
          title={
            historyComplete
              ? `${runs.length} run${runs.length === 1 ? "" : "s"}`
              : `${runs.length} run${runs.length === 1 ? "" : "s"} loaded — older runs have not been fetched`
          }
          className="flex shrink-0 items-center gap-1 rounded-full bg-runssoft px-2.5 py-1 text-tiny font-medium text-runsink"
        >
          <Icon.agents.runsBadge size={ICON.xs} />
          {/* THE MARK AND THE FIGURE, AND NOTHING ELSE. `Runs` was a third element on a row that is
              already two lines of words, and the play glyph beside a number says what it counts. */}
          <span className="tabular-nums">{runs.length}</span>
        </span>
      </div>

      {open && hasRuns && (
        <div className="flex flex-col">
          {shown.map((r) => (
            // Indented to the twisty's width, so a run reads as belonging to the row above it.
            <div key={r.id} className="pl-5">
              <RunRow run={r} runs={runs} agentId={agent.agent_id} />
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
/**
 * The person's mark in the footer: their picture when there is one, their initial when there is not.
 *
 * A COMPONENT RATHER THAN A `<span>` INLINE, and it is deliberately extracted before it needs to be.
 * The next pass gives this an image — from the Google `picture` claim on sign-in, or from an upload
 * the person crops in settings — and the difference between "the footer draws a letter" and "the
 * footer draws whatever identifies you" should be one file, not a rewrite of the row around it. The
 * geometry, the radius and the fallback all live here so the image slots into a shape that already
 * exists.
 *
 * THE INITIAL IS THE FALLBACK AND IT IS NOT A PLACEHOLDER TO BE ASHAMED OF: it is what every
 * account has on the day it is made, it is stable, and it is what the member list already draws.
 */
function Avatar({ name }: { name: string | null | undefined }) {
  const hasAvatar = useSessionStore((s) => s.user?.hasAvatar ?? false);
  const [url, setUrl] = useState<string | null>(null);

  // FETCHED, NOT SRC'D. See lib/avatar.ts — the route needs a bearer token, which an `<img src>`
  // cannot carry. `loadAvatar` is cached and reference-counted, so mounting this in two places
  // makes one request. The `live` flag is the ordinary guard against a resolve landing after the
  // component has gone.
  useEffect(() => {
    if (!hasAvatar) { setUrl(null); return; }
    let live = true;
    void loadAvatar().then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [hasAvatar]);

  return (
    <span
      aria-hidden
      className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-control bg-sidebar-active text-tiny text-ink"
    >
      {/* THE INITIAL IS NOT A SPINNER. While the picture is being fetched — and forever, for
          somebody who has none — this is what shows, and it is the same mark the member list
          draws. A blank square that fills in a moment later reads as a bug on every launch. */}
      {url
        ? <img src={url} alt="" className="h-full w-full object-cover" />
        : (name ?? "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

function AccountRow() {
  const user = useSessionStore((s) => s.user);
  const openWorkspacePanel = useUiStore((s) => s.openWorkspacePanel);
  const setProviderPanel = useUiStore((s) => s.setProviderPanel);
  const name = user?.displayName || user?.email;
  /**
   * WHAT THE FOOTER CALLS THEM, in the order the person themselves would expect.
   *
   * The username is a label they chose for exactly this row, so it wins when it exists. Everything
   * below it is a fallback: the display name is who they are, and the address is what is left when
   * an account has neither — which is every account older than migration 070 until they pick one.
   */
  const label = user?.username || name;
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

  // See lib/menuFocus.ts — the panel is rendered BEFORE its trigger, so without this the
  // keyboard steps straight over the menu it just opened, and Escape drops focus to <body>.
  useMenuFocus(open, ref);

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
          className="absolute bottom-full left-0 z-30 mb-1 w-full origin-bottom animate-menu-in-up overflow-hidden rounded-control border border-sidebar-border bg-panel py-1 shadow-pop motion-reduce:animate-none"
        >
          <button role="menuitem" onClick={choose(() => openWorkspacePanel("account"))} className={ACCOUNT_MENU_ROW}>
            <Icon.workspace.settings size={ICON.md} />
            <span className="min-w-0 flex-1 truncate">Account &amp; workspace</span>
          </button>
          <button role="menuitem" onClick={choose(() => setProviderPanel(true))} className={ACCOUNT_MENU_ROW}>
            <Icon.nav.providerKeys size={ICON.md} />
            <span className="min-w-0 flex-1 truncate">Provider keys</span>
          </button>
          <AdminModeToggle />
          {/* THE PLAN IS NOT HERE AND NOT ON THE ROW. It was a `Free` chip beside the name, which
              put a fact about the WORKSPACE'S BILLING on a row whose subject is a human being, and
              made three things out of what should read as one name. It is not relocated into this
              menu either: "Account & workspace" above already opens the surface that owns billing,
              and a second, shallower copy of the same fact is how two places to read a plan end up
              disagreeing. */}
          {/* SIGN OUT, LAST AND SEPARATED. It was its own control beside the name, on the argument
              that ending a session is irreversible-feeling and a menu row is easy to hit by
              mistake — which is a real risk and is answered better by a divider and last place
              than by leaving a permanent one-click exit on the row. What the old arrangement cost
              was the row itself: a name, a chip and two buttons, where the whole point of the
              footer is to say who you are. */}
          <div className="my-1 h-px bg-sidebar-border" role="separator" />
          <button role="menuitem" onClick={choose(signOut)} className={ACCOUNT_MENU_ROW}>
            <Icon.auth.signOut size={ICON.md} />
            <span className="min-w-0 flex-1 truncate">Sign out</span>
          </button>
        </div>
      )}

      {/* ONE CONTROL, AND ONE SUBJECT. The row was a button with a chip and a second button beside
          it; it is a picture, a name and a disclosure now — press it and everything else is in the
          menu. Nothing is nested, which is what the two-control arrangement was avoiding: the
          sign-out glyph that used to sit here would have fired the row's own click as well. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-sidebar-hover active:bg-sidebar-active focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <Avatar name={label} />
        {/* THE USERNAME IF THEY CHOSE ONE, and their name if they did not. See `label` above. */}
        <Truncate className="min-w-0 flex-1 text-label text-ink" title={label}>{label}</Truncate>
        <span className="shrink-0 text-faint">
          {open ? <Icon.workspace.switcherOpen size={ICON.sm} /> : <Icon.workspace.switcherClosed size={ICON.sm} />}
        </span>
      </button>
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

  // See lib/menuFocus.ts — the panel is rendered BEFORE its trigger, so without this the
  // keyboard steps straight over the menu it just opened, and Escape drops focus to <body>.
  useMenuFocus(open, ref);

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
        {/* `md`, NOT `lg`. The ladder's top rung is for a NAVIGATION row — a mark that anchors a
            line you scan a column for — and this is a control sitting beside an 11px section
            label, where 18px read as the loudest thing in the header. */}
        <Icon.agents.filter size={ICON.md} />
        {filtering && current?.count != null && (
          <span className="text-tiny tabular-nums">{current.count}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[170px] origin-top animate-menu-in rounded-card border border-sidebar-border bg-elevated p-1 shadow-floating motion-reduce:animate-none">
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
    <div className="sidebar-material flex h-full flex-col bg-sidebar">
      <SidebarChrome />
      <WorkspaceSwitcher />
      <NavList />

      {/* RECENTS — the agents, and their runs under them. */}
      {/* THE GAP IS THE SECTION BREAK. Above it are six places you can go; below it is the contents
          of one of them. They were four pixels apart, so the column read as ten interchangeable
          rows and `Recents` looked like a seventh destination rather than a heading over a list. */}
      <div className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 pl-1.5 pr-2">
          <button
            onClick={() => setRecentsOpen((v) => !v)}
            aria-expanded={recentsOpen}
            title={recentsOpen ? "Collapse recents" : "Expand recents"}
            aria-label={recentsOpen ? "Collapse recents" : "Expand recents"}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {recentsOpen ? <Icon.workspace.switcherOpen size={ICON.lg} /> : <Icon.workspace.switcherClosed size={ICON.lg} />}
          </button>
          {/* NOT `TYPE.panelLabel`, which uppercases. This heading names a place in a column of
              places — `New`, `Threads`, `Agents` — and shouting one of them makes it a
              different kind of thing from the rows above it. */}
          <span className="min-w-0 flex-1 text-caption tracking-wide text-faint">Recents</span>
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

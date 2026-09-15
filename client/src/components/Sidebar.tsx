// Left sidebar — the agent/run library (doc §4.1). Top: New Agent, search, and status filter
// tabs over the agent list; an agent's runs are in the right panel's Runs tab.
// Bottom-anchored: Settings and the user/plan chip. Restraint-first: rows float on the panel,
// separated by spacing and a thin accent on the active one — never boxed.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { orderedRuns, useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import type { AgentSummary, ThreadView } from "../types.ts";
import { openThread } from "../lib/threadNav.ts";
import { useTypedText } from "../lib/typedText.ts";
import { chatTitle } from "../lib/chatTitle.ts";
import { useCanRun } from "../lib/useCapability.ts";
import { ThreadGlyph } from "./ThreadGlyph.tsx";
import { absTime, relTime } from "../lib/format.ts";
import { agentStatus } from "../lib/agentStatus.ts";
import { selectAgent } from "../lib/selection.ts";
import {
  sendDeleteAgent, sendOpenGithubPr, sendRenameAgent, sendRestoreThread, signOut,
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
import { Capable } from "./Capable.tsx";
import { keyHint } from "../lib/modKey.ts";
import { startNewChat } from "../lib/newChat.ts";
import { goBack, goForward } from "../lib/navHistory.ts";
import { canGoBack, canGoForward, useHistoryStore } from "../store/historyStore.ts";
import { hasHostWindow } from "../lib/windowStage.ts";
import { useAvatar } from "../lib/avatar.ts";
import { useMenuFocus } from "../lib/menuFocus.ts";
import { useAnchoredMenu } from "../lib/anchoredMenu.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";


/**
 * §2's nav buttons, in the order the spec lists them.
 *
 * DATA RATHER THAN FOUR COPIES OF THE SAME MARKUP, so the badge that lands on one of them later is a
 * field here rather than a special case in one of four branches.
 */
const NAV_DESTINATIONS: { id: NavDestination; label: string; icon: IconComponent }[] = [
  { id: "agents", label: "Agents", icon: Icon.nav.agents },
  { id: "work", label: "Cockpit", icon: Icon.nav.cockpit },
  { id: "inbox", label: "Inbox", icon: Icon.nav.inbox },
  { id: "activity", label: "Activity", icon: Icon.nav.activity },
];

// `archived` is the sixth, and it is a filter rather than a section for the reason §3.4 gives about
// threads: an archived thing has LEFT the default list, and a list that showed both would make
// "archived" a decoration instead of a state. It is last, after the states that describe live work.
type Filter = "all" | "running" | "deployed" | "synced" | "drafts" | "archived";

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
  const back = useHistoryStore(canGoBack);
  const forward = useHistoryStore(canGoForward);
  const underHost = hasHostWindow();

  return (
    <div
      data-tauri-drag-region
      className={`flex h-11 shrink-0 items-center gap-1 pr-2 ${underHost ? "pl-[76px]" : "pl-2"}`}
    >
      {/* THE SLACK COMES FIRST, so the whole row's controls sit together at the right edge. What
          is on the left is the traffic lights and the space this reserves for them — and that
          space is the drag handle, which is the other reason to leave it empty. */}
      <span className="flex-1" data-tauri-drag-region />
      {/* WHERE YOU HAVE BEEN, since there is no address bar to hold it. A place here is a
          destination plus the agent the panes are pointed at — see `store/historyStore`.

          BESIDE THE TOGGLE RATHER THAN ACROSS THE ROW FROM IT. These three are the window's
          controls — where you were, and how much of the window the column takes — and they were
          split to opposite ends with the title bar's slack between them, which made two clusters
          out of one group and left `Back` sitting where a title would go.

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
      {/* SEARCH HAS LEFT THIS ROW for the workspace row below it — see `WorkspaceSwitcher`. It is
          the one control here that was not about the window, and it now sits at the end of the row
          that names what is being searched. */}
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
  // `navView`, NOT `navSection` — the product owner's call on 2026-09-15. `navSection` remembers the
  // list you descended FROM, so opening a chat out of Agents left Agents lit and the chat dark: the
  // column said you were in a section you were no longer looking at, and the row you actually
  // pressed said nothing. What is lit is what is on screen.
  const navView = useUiStore((s) => s.navView);
  const openNav = useUiStore((s) => s.openNav);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  // ONE ROW IS LIT IN THIS COLUMN AT A TIME — the product owner's call on 2026-09-15. `New` is the
  // last of them: it is where you are only when there is no conversation open, no agent chosen and
  // no section showing. Anything else selected means you are somewhere, and that somewhere is lit.
  const newIsCurrent = activeThreadId === null && activeAgentId === null && navView === null;
  const waiting = useInboxStore((s) => s.counts.badge);
  const waitingOnYou = useWorkStore((s) => workBadgeCount(s.workspaceCounts));

  return (
    <div className="flex shrink-0 flex-col px-2 pb-1">
      {/* NEW IS THE FIRST THING, which is what makes it a destination rather than a button that
          happened to be moved here. It was a `+` in the Recents header, filed with that section's
          filter — a creation control scoped by a list it does not belong to.

          IT IS LIT WHEN IT IS WHERE YOU ARE, and not before. The fill used to be permanent, on the
          argument that this row is a button rather than a tab — which left `New` looking chosen
          under every conversation somebody opened, two selections in a column that can only be in
          one place. It lights like the five rows under it now, and for the same reason. */}
      <button
        onClick={startNewChat}
        // ACCURATE EVEN THOUGH THE FILL IS NOT. The background below is permanent; `aria-current`
        // is not, because two rows announcing themselves as the current page is worse for somebody
        // reading this column through a screen reader than no emphasis at all.
        aria-current={newIsCurrent ? "page" : undefined}
        title={`New chat — ${keyHint("⌘N")}`}
        className={`group/new flex h-7 w-full shrink-0 items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
          newIsCurrent ? "bg-sidebar-active text-accent" : "text-muted hover:bg-sidebar-hover hover:text-ink"
        }`}
      >
        {/* THE MARK CARRIES ITSELF NOW. This was a plain plus on a filled ink tile — the one solid
            black object in a column of quiet grey text, which made `New` shout rather than lead,
            and read as heavier still once the column became a translucent material. `AddSquareIcon`
            is the same idea drawn rather than built: a plus already inside its square, at the same
            stroke weight as every other mark in the column. */}
        {/* `md`, THE SAME RUNG AS THE FIVE DESTINATIONS BELOW IT. All six came down from `lg` together
            on 2026-09-11 at the product owner's call. `New` was once drawn a rung under the rest to
            fit a black tile, and a leading row whose mark is smaller than every mark under it reads
            as the odd one out — so it moves with them rather than on its own. */}
        <Icon.nav.newAgent size={ICON.md} />
        <span className="min-w-0 flex-1 truncate text-body font-medium">New</span>
        {/* THE CHORD, ON APPROACH. A shortcut printed permanently is a second thing to read on a
            row with two words on it; one that appears when the pointer arrives is there exactly
            when somebody is deciding whether to click or to type. `group-focus-within` as well, so
            the keyboard is told what the pointer is told. */}
        <kbd className="shrink-0 text-tiny leading-none text-faint opacity-0 transition-opacity duration-fast group-hover/new:opacity-100 group-focus-within/new:opacity-100">
          {keyHint("⌘N")}
        </kbd>
      </button>

      {NAV_DESTINATIONS.map(({ id, label, icon: Mark }) => {
        const active = navView === id;
        const badge = id === "inbox" ? waiting : id === "work" ? waitingOnYou : 0;
        const badgeTitle =
          id === "inbox"
            ? `${waiting} item${waiting === 1 ? "" : "s"} blocked or waiting on a decision`
            : `${waitingOnYou} job${waitingOnYou === 1 ? "" : "s"} waiting for somebody to answer something`;
        return (
          <button
            key={id}
            onClick={() => openNav(id)}
            aria-current={active ? "page" : undefined}
            className={`flex h-7 w-full shrink-0 items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              active ? "bg-sidebar-active text-accent" : "text-muted hover:bg-sidebar-hover hover:text-ink"
            }`}
          >
            <Mark size={ICON.md} />
            <span className="min-w-0 flex-1 truncate text-body font-medium">{label}</span>
            {badge > 0 && (
              <span
                title={badgeTitle}
                // A CLASS RATHER THAN AN INLINE STYLE, so the material can reach it. An inline
                // `background` wins over every stylesheet rule there is, which left this badge the
                // one opaque patch in the column that could not be softened with the rest.
                className="shrink-0 rounded-xs bg-chrome px-1 text-caption leading-[16px] tabular-nums text-ink"
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

/**
 * An agent, as a row in the column. Its runs are not under it: they are in the right panel's Runs
 * tab, which lists the selected agent's runs beside its trace.
 */
/**
 * What you can do to an agent, at the end of its row.
 *
 * THE FIVE ARE NOT A LIST OF EVERYTHING — they are the things somebody reaches for while LOOKING AT
 * the column rather than while working inside an agent. Pin and Rename change the row itself,
 * Configure leaves for the surface that owns the agent's settings, and Delete removes it. Anything
 * that needs the agent open belongs where the agent is open.
 *
 * DELETE ASKS FOR THE NAME. It is the one action here with no undo — `archiveAgent` has
 * `restoreAgent`, this has nothing — so the row turns into a field and the button stays disabled
 * until what is typed matches the slug. Two presses of a menu item should never be able to destroy
 * an agent's history, and a confirm dialog that only asks "are you sure" is one press plus a reflex.
 */
function AgentRowMenu({ agent }: { agent: AgentSummary }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(agent.name);
  const ref = useRef<HTMLDivElement>(null);
  // The panel is portalled out of the list, so it needs a ref of its own: `ref` no longer contains
  // it, and every listener below that used to ask one element now has to ask both.
  const panelRef = useRef<HTMLDivElement>(null);
  const pinned = useUiStore((st) => st.pinnedAgents.includes(agent.agent_id));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      // BOTH, OR THE MENU CANNOT BE CLICKED. Once the panel is portalled it is no longer inside
      // `ref`, so a press on one of its own items counted as a click outside: the menu closed on
      // `mousedown` and the item it was closing over never received the `click`. Every item in it
      // was dead for exactly as long as the portal existed without this line.
      const t = e.target as Node;
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // See lib/menuFocus.ts — the panel renders before its trigger, so without this the keyboard
  // steps over the menu it just opened. The items live in the portal and the button stays in the
  // row, which is why this one names both.
  useMenuFocus(open, panelRef, ref);
  // ...and lib/anchoredMenu.ts, which puts the portalled panel back where the row expects it.
  useAnchoredMenu(open, ref, panelRef);

  // CLOSING RESETS THE TWO SUB-STATES. A menu reopened on a half-typed delete confirmation, or on
  // a rename field holding a name somebody abandoned, is a menu that remembers a decision they
  // walked away from.
  useEffect(() => {
    if (open) return;
    setConfirming(false);
    setTyped("");
    setRenaming(false);
    setName(agent.name);
  }, [open, agent.name]);

  const choose = (run: () => void) => () => { setOpen(false); run(); };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Actions for ${agent.name}`}
        aria-label={`Actions for ${agent.name}`}
        // VISIBLE WHILE OPEN, which the portal made necessary. The panel used to be a child of the
        // row, so moving the pointer onto it kept the row hovered and this button shown; now that
        // it is in `document.body` the row un-hovers the moment somebody reaches for the menu, and
        // the trigger faded out from under its own open panel. `RunOverflow` above has always
        // spelled it this way.
        className={`flex h-6 w-6 items-center justify-center rounded-control text-faint transition-[color,opacity] duration-fast hover:bg-sidebar-hover hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring ${
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        }`}
      >
        <Icon.agents.rowMore size={ICON.sm} />
      </button>

      {/* INTO `document.body`, NOT INTO THE ROW — see lib/anchoredMenu.ts. This is the only menu in
          the application that opens from inside a scroller, and an `overflow` ancestor clips its
          absolutely-positioned descendants no matter what `z-index` they carry.
          `top-0 left-0` IS THE STARTING POINT, NOT THE POSITION. `useAnchoredMenu` overwrites both
          in a layout effect — before paint, so nothing is ever seen in the corner — and it has to
          be after mount because choosing between opening down and opening up means measuring a
          panel that has been laid out. */}
      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={`Actions for ${agent.name}`}
          className="fixed left-0 top-0 z-50 min-w-[210px] origin-top animate-menu-in overflow-hidden rounded-card border border-sidebar-border bg-elevated p-1 shadow-floating motion-reduce:animate-none"
        >
          {renaming ? (
            // IN PLACE, NOT IN A DIALOG. A rename is one short string and the row it belongs to is
            // three pixels away; taking over the screen to ask for it would be more ceremony than
            // the change deserves.
            <form
              className="flex flex-col gap-1 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                const next = name.trim();
                if (next && next !== agent.name) sendRenameAgent(agent.agent_id, next);
                setOpen(false);
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                aria-label="Agent name"
                className="w-full rounded-input border border-edge bg-panel px-2 py-1 text-caption text-ink outline-none focus-visible:shadow-focusring"
              />
              <div className="flex gap-2 px-1 pb-0.5">
                <button type="submit" className="text-tiny text-ink underline underline-offset-2">Rename</button>
                <button type="button" onClick={() => setRenaming(false)} className="text-tiny text-muted underline underline-offset-2">Cancel</button>
              </div>
            </form>
          ) : confirming ? (
            <form
              className="flex flex-col gap-1 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim() !== agent.agent_id) return;
                sendDeleteAgent(agent.agent_id, agent.agent_id);
                setOpen(false);
              }}
            >
              {/* THE SLUG, NOT THE NAME, and not a yes/no. A name can be anything including another
                  agent's; the slug is what identifies this one, and typing it is the only part of
                  this flow that requires having read which agent is about to go. */}
              <p className="px-1 py-0.5 text-tiny leading-[1.5] text-muted">
                This removes {agent.name}, its runs and its history. Type <span className="text-ink">{agent.agent_id}</span> to confirm.
              </p>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                aria-label={`Type ${agent.agent_id} to confirm deletion`}
                className="w-full rounded-input border border-edge bg-panel px-2 py-1 text-caption text-ink outline-none focus-visible:shadow-focusring"
              />
              <div className="flex gap-2 px-1 pb-0.5">
                <button
                  type="submit"
                  disabled={typed.trim() !== agent.agent_id}
                  className="text-tiny text-err underline underline-offset-2 disabled:cursor-default disabled:text-disabled disabled:no-underline"
                >
                  Delete for good
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="text-tiny text-muted underline underline-offset-2">Cancel</button>
              </div>
            </form>
          ) : (
            <>
              <button role="menuitem" onClick={choose(() => useUiStore.getState().togglePinnedAgent(agent.agent_id))} className={ACCOUNT_MENU_ROW}>
                <Icon.agents.pin size={ICON.sm} />
                <span className="min-w-0 flex-1 truncate">{pinned ? "Unpin" : "Pin"}</span>
              </button>
              <button role="menuitem" onClick={() => setRenaming(true)} className={ACCOUNT_MENU_ROW}>
                <Icon.agents.rename size={ICON.sm} />
                <span className="min-w-0 flex-1 truncate">Rename</span>
              </button>
              <button
                role="menuitem"
                onClick={choose(() => { selectAgent(agent.agent_id); useUiStore.getState().openNav("agents"); })}
                className={ACCOUNT_MENU_ROW}
              >
                <Icon.agents.configure size={ICON.sm} />
                <span className="min-w-0 flex-1 truncate">Configure agent</span>
              </button>
              {/* HIDDEN RATHER THAN REFUSED. Deleting an agent is gated at `workspace:manage` — the
                  owner alone — and at `admin` on the agent itself; without this, everybody else
                  would see the item, press it, type an agent's slug to confirm, and only then be
                  told no. `Capable` asks the same two questions the relay asks, in the same order,
                  from the copy of the matrix `test:permission-ui` holds to the server's.

                  THE SEPARATOR GOES WITH IT, because a divider above nothing is a line at the
                  bottom of a menu that says something was removed. */}
              <Capable cmd="deleteAgent" agentId={agent.agent_id}>
                <div className="my-1 h-px bg-sidebar-border" role="separator" />
                <button role="menuitem" onClick={() => setConfirming(true)} className={`${ACCOUNT_MENU_ROW} text-err`}>
                  <Icon.agents.delete size={ICON.sm} />
                  <span className="min-w-0 flex-1 truncate">Delete</span>
                </button>
              </Capable>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function AgentTreeRow({
  agent,
  lastRunAt,
  threads,
}: {
  agent: AgentSummary;
  lastRunAt: string | null;
  /** This agent's chats, most recently active first, archived and pinned ones already left out. */
  threads: ThreadView[];
}) {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const navView = useUiStore((s) => s.navView);
  // THE CONVERSATION WINS. Opening a chat selects its agent too — the composer needs one — so both
  // rows lit, and the column said you were in two places. The agent row is lit while the agent is
  // where you are and no chat of its own is open; the chat's own row takes it from there.
  const selected = activeAgentId === agent.agent_id && activeThreadId === null && navView === null;
  // When this agent last did anything — and when it has never run, when it was made. THE ROW SHOWED
  // NOTHING for a new agent, which is the one moment the column is most likely to be looked at: the
  // agent you just described, with no time beside it. Two different facts, so the label below says which.
  const stamp = lastRunAt ?? agent.created_at ?? null;
  const stampWord = lastRunAt ? "last run" : "created";
  // Null until this agent has a pull request open — see the marker below.
  const pr = useGithubStore((st) => st.views[agent.agent_id]?.pr ?? null);
  // Whether this agent has a repository behind it at all — which decides whether the control below
  // opens a pull request or opens the panel where one becomes possible.
  const linked = useGithubStore((st) => Boolean(st.views[agent.agent_id]?.link));
  // THE RUN COUNT IS NO LONGER ON THIS ROW, so neither is the qualifier that made it honest. §13's
  // rule — "a missing count is fine, a wrong count is not" — is satisfied by not making the claim:
  // the subtree below lists the runs that have actually been fetched, and `Load older runs…` says
  // the rest exist. See `AgentRowMenu`, which took the capsule's place.



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
        // AND ITS EMOJI SITS IN THE TABS' ICON COLUMN — the product owner's call on 2026-09-11. The
        // row's 10px of left padding lands its 16px mark box on the same 16px the tab icons start at,
        // and the 10px gap after it starts the name where the tab labels start. The runs twisty that
        // used to hold this column moved to the row's right end, before the pull request.
        className={`group relative flex h-11 w-full items-center gap-1 rounded-control pl-2.5 pr-1 transition-colors duration-fast ${
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
        <button
          onClick={() => selectAgent(agent.agent_id)}
          title={identityTitle(agent.name, agent.category)}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {/* The tab icons' own box, `md`, so the mark is centred under them whatever width its glyph
              draws — an emoji's is its own, and a bat is wider than a robot. */}
          <span className="inline-flex shrink-0 justify-center" style={{ width: ICON.md }}>
            <AgentEmoji emoji={agent.emoji} size={EMOJI_SIZE.sidebar} />
          </span>
          {/* TWO LINES: who it is, then what it is and when it last ran. The category and the
              timestamp are both qualifiers on the name, so they share the second line and the
              name gets the first to itself — at 13px medium, the product owner's call on
              2026-09-11: a rung under the 14px tab labels, and still one over the 12px line it
              heads, so the name stays the thing the eye lands on in a column of agents. */}
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            {/* Ink whether or not it is the selected one — see the run row above for why the
                ternary that used to be here had the same value on both arms, and why the fill and
                the bar are what say "this one". A name is content; content does not dim. */}
            <Truncate className="text-label text-ink" title={agent.name}>
              {agent.name}
            </Truncate>
            <span className="flex min-w-0 items-center gap-1.5 text-caption text-faint">
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
        {/* THE PULL REQUEST, ON EVERY ROW AND SHOWN ON HOVER. On every row because it is a control
            rather than a badge: "only when there is one" hid it on exactly the agents somebody would
            want to open one FOR. Shown on hover — and on keyboard focus — like the row's menu beside
            it, the product owner's call on 2026-09-11: a green mark resting on every agent was the
            loudest thing in the column, and pointing at any row still finds it. It has a real action
            in all three states, so it is never a dead control:

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
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-ok opacity-0 transition-[background-color,opacity] duration-fast hover:bg-sidebar-hover group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <Icon.github.openPullRequest size={ICON.sm} />
        </button>
        {/* THE RUN COUNT, ALWAYS — `0 Runs` included. A badge that disappears at zero makes the
            one state somebody most wants to see at a glance, "this has never run", the only
            state with nothing to read. */}
        {/* THE ROW'S OWN MENU, WHERE A RUNS CAPSULE USED TO BE. The capsule was a pink count on
            every row of a column of grey text — the loudest thing in the sidebar, spent on a
            number that is also the first line of the agent's own subtree the moment you open it.
            What a row actually needs at its end is the things you can DO to it. */}
        <AgentRowMenu agent={agent} />
      </div>

      {/* ITS CHATS, INDENTED UNDER IT AND ALWAYS SHOWN, which is what makes the agent a project: the
          conversations about it live with it, with no fold to open to find one. */}
      {threads.length > 0 && (
        <div className="flex flex-col">
          {threads.map((t) => (
            <ThreadListRow key={t.id} thread={t} />
          ))}
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
  // FETCHED, NOT SRC'D. See lib/avatar.ts — the route needs a bearer token, which an `<img src>`
  // cannot carry. The hook is shared with the settings row, which is what keeps the two in step:
  // this used to be its own effect keyed on `hasAvatar`, and replacing a picture leaves that
  // `true` → `true`, so the footer went on rendering a blob the upload had already revoked.
  const url = useAvatar(useSessionStore((s) => s.user?.hasAvatar ?? false));

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
  // anything leads to an empty list, which is the same noise an empty section is in Threads.
  // ARCHIVED IS LISTED WHEN THERE ARE ANY **OR WHEN IT IS THE ONE YOU ARE ON**, and the second
  // half is the bug this had. The entry existed only while the count was above zero — so
  // un-archiving the last archived agent while looking at that filter took the entry out from
  // under the active selection: `current` became undefined, the trigger's title AND its
  // `aria-label` read "Filtered: undefined", and the menu no longer contained the row you were
  // standing on. Keeping it while selected shows an honest `Archived 0` and leaves the way out
  // visible, which is better than silently resetting somebody's filter for them.
  if (counts.archived > 0 || filter === "archived") {
    entries.push({ id: "archived", label: "Archived", count: counts.archived });
  }

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
        {/* `sm`, A RUNG UNDER THE TAB ICONS. Those are `md` now, and a navigation row's mark is what
            anchors a line you scan the column for; this is a control sitting beside a 13px section
            label, so it takes the rung below — the product owner's call on 2026-09-11, when `md`
            read as big as the tabs themselves. */}
        <Icon.agents.filter size={ICON.sm} />
        {filtering && current?.count != null && (
          <span className="text-caption tabular-nums">{current.count}</span>
        )}
      </button>
      {open && (
        // A MENU WITH NO ROLE AT ALL, WHICH IS WHY `test:menu-keys` NEVER SAW IT. The panel was a
        // bare `<div>` of buttons: the suite scans for `role="menu"`, so the one sidebar dropdown
        // that never declared itself was the one it could not check — and `useMenuFocus` found no
        // items in it either, so the arrow keys it was wired for did nothing.
        //
        // `menuitemradio` RATHER THAN `menuitem`, because this is a single-select: exactly one
        // filter is in force and the others are not. `aria-checked` is what says which, and it is
        // the difference between a screen reader announcing "Running" and "Running, checked".
        <div
          role="menu"
          aria-label="Filter agents"
          className="absolute right-0 top-full z-30 mt-1 min-w-[170px] origin-top animate-menu-in rounded-card border border-sidebar-border bg-elevated p-1 shadow-floating motion-reduce:animate-none"
        >
          {entries.map((e) => (
            <button
              key={e.id}
              role="menuitemradio"
              aria-checked={filter === e.id}
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

/**
 * The small circle beside every chat in the sidebar — what marks a row as a conversation.
 *
 * IN THE AGENT EMOJI'S OWN BOX, and that is the product owner's call on 2026-09-15: "threads icon
 * should fall just below the agent emoji". The circle is narrower than an emoji, so a shared left
 * edge is not enough — it takes the same `ICON.md` box and the same 10px gap after it, which puts
 * the circle under the emoji and a chat's name under its agent's.
 */
function ChatDot() {
  return (
    <span className="mr-2.5 inline-flex shrink-0 justify-center text-faint" style={{ width: ICON.md }} aria-hidden>
      <Icon.threads.chat size={ICON.sm} />
    </span>
  );
}

/**
 * A chat in the column: its name, and a press that opens it.
 *
 * NO INDENT, UNDER AN AGENT OR NOT — the product owner's call on 2026-09-15. A chat under its agent
 * in Projects used to start 36px in; it starts where every other row starts now, and what says it
 * belongs to the agent above it is the order and the circle in the emoji's column, not a step.
 */
function ThreadListRow({ thread }: { thread: ThreadView }) {
  // AND NOT WHILE A SECTION IS ON SCREEN. Opening the Inbox or Activity is going somewhere else;
  // a chat row still lit under it would be the second selection this column no longer has.
  const active = useThreadStore((s) => s.activeThreadId === thread.id)
    && useUiStore((s) => s.navView) === null;
  // The same typing as the header when a topic title arrives — see lib/typedText.ts.
  const shownTitle = useTypedText(chatTitle(thread.title), !thread.title_is_custom);
  return (
    <button
      type="button"
      onClick={() => openThread(thread)}
      title={chatTitle(thread.title)}
      className={`flex h-7 w-full shrink-0 items-center rounded-control pl-2.5 pr-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover"
      }`}
    >
      <ChatDot />
      <Truncate className={`min-w-0 flex-1 text-label ${active ? "text-ink" : "text-muted"}`} title={chatTitle(thread.title)}>
        {shownTitle}
      </Truncate>
      {/* WHAT IS OUTSTANDING, AT THE ROW'S END. The circle holds the left for every chat alike; a chat
          that needs you, is running or has failed says so after its name, in the shared glyph. */}
      {thread.status !== "idle" && thread.status !== "archived" && (
        <span className="ml-2 shrink-0"><ThreadGlyph status={thread.status} /></span>
      )}
    </button>
  );
}

/**
 * An archived chat, listed while the filter is on Archived: its name, which opens it, and Restore.
 *
 * RESTORE IS ABSENT FOR SOMEBODY WHO CANNOT RESTORE, and disabled while reconnecting, with the reason.
 */
function ArchivedThreadRow({ thread }: { thread: ThreadView }) {
  // AND NOT WHILE A SECTION IS ON SCREEN. Opening the Inbox or Activity is going somewhere else;
  // a chat row still lit under it would be the second selection this column no longer has.
  const active = useThreadStore((s) => s.activeThreadId === thread.id)
    && useUiStore((s) => s.navView) === null;
  const connected = useTraceStore((s) => s.connection === "open");
  const canRestore = useCanRun("restoreThread");
  return (
    <div
      className={`flex h-7 w-full shrink-0 items-center rounded-control pr-1 transition-colors duration-fast ${
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover"
      }`}
    >
      <button
        type="button"
        onClick={() => openThread(thread)}
        title={chatTitle(thread.title)}
        className="flex min-w-0 flex-1 items-center pl-2.5 text-left focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <ChatDot />
        <Truncate className="min-w-0 flex-1 text-label text-muted" title={chatTitle(thread.title)}>{chatTitle(thread.title)}</Truncate>
      </button>
      {canRestore && (
        <button
          type="button"
          onClick={() => sendRestoreThread(thread.id)}
          disabled={!connected}
          title={connected ? "Restore this chat" : "Reconnecting — restoring needs a connection"}
          aria-label={`Restore ${chatTitle(thread.title)}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-default disabled:text-disabled"
        >
          <Icon.threads.restore size={ICON.sm} />
        </button>
      )}
    </div>
  );
}

/**
 * A list's heading: its name, with room for a control of its own at the end.
 *
 * NO FOLD. The chats a heading sits over are always shown, so there is nothing for it to open or close,
 * and the name lines up with the rows under it.
 */
function ListHeading({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 pl-4 pr-2">
      {/* NOT `TYPE.panelLabel`, which uppercases. This heading names a place in a column of places, and
          shouting one of them makes it a different kind of thing from the rows above it. */}
      <span className="min-w-0 flex-1 text-label font-normal tracking-wide text-faint">{label}</span>
      {children}
    </div>
  );
}

/**
 * A pinned chat on the Pinned shelf: its name, and a press that opens it.
 *
 * ONE LINE, NOT THE AGENT ROW'S TWO. A chat has no category and no run history to show under its
 * name, and the pin mark in the icon column is what says why it is up here rather than in the list.
 */
function PinnedThreadRow({ thread }: { thread: ThreadView }) {
  // AND NOT WHILE A SECTION IS ON SCREEN. Opening the Inbox or Activity is going somewhere else;
  // a chat row still lit under it would be the second selection this column no longer has.
  const active = useThreadStore((s) => s.activeThreadId === thread.id)
    && useUiStore((s) => s.navView) === null;
  const shownTitle = useTypedText(chatTitle(thread.title), !thread.title_is_custom);
  return (
    <button
      type="button"
      onClick={() => openThread(thread)}
      title={chatTitle(thread.title)}
      className={`flex h-8 w-full shrink-0 items-center gap-2.5 rounded-control pl-2.5 pr-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover"
      }`}
    >
      <span className="inline-flex shrink-0 justify-center text-faint" style={{ width: ICON.md }} aria-hidden>
        <Icon.threads.chat size={ICON.sm} />
      </span>
      <Truncate className="min-w-0 flex-1 text-label text-ink" title={chatTitle(thread.title)}>
        {shownTitle}
      </Truncate>
    </button>
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
  // Per AGENT rather than per workspace — §4. Different agents legitimately belong in different
  // repositories, and one repo per workspace would break the monorepo case the subdirectory field
  // exists for.
  const githubViews = useGithubStore((s) => s.views);
  // §2: pinned agents, then the active/recent ones. The pins are this person's own, from localStorage
  // keyed by workspace — see uiStore.
  const pinnedIds = useUiStore((s) => s.pinnedAgents);
  // Pinned chats sit on the same shelf, above the agents, in the order they were pinned — and only
  // the ones that still exist and are not archived, for the reasons given for agents below.
  const pinnedThreadIds = useUiStore((s) => s.pinnedThreads);
  const threadRows = useThreadStore((s) => s.threads);
  const pinnedThreads = pinnedThreadIds
    .map((id) => threadRows.find((t) => t.id === id))
    .filter((t): t is ThreadView => t !== undefined && !t.archived_at);

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
  // ARCHIVED CHATS LIVE HERE NOW, under the same filter as archived agents: the Threads tab that listed
  // them is gone, and a chat put away has to stay findable to be put back.
  const archivedThreads = threadRows
    .filter((t) => t.archived_at)
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  counts.archived += archivedThreads.length;

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

  /**
   * When each agent last ran, for the time on its row.
   *
   * BUILT ONCE PER RENDER RATHER THAN FILTERED PER ROW — this column redraws on every trace event,
   * and the list is newest-first, so the first run seen for an agent is its latest.
   */
  const lastRunByAgent = new Map<string, string>();
  for (const r of orderedRuns(runs)) {
    if (!lastRunByAgent.has(r.agent_id)) lastRunByAgent.set(r.agent_id, r.started_at);
  }

  /**
   * Every chat, filed under its agent — or in Recents when it has none.
   *
   * A CHAT STARTED WITHOUT AN AGENT IS IN RECENTS AND NOWHERE ELSE, and so is one whose agent this
   * workspace no longer lists: a row filed under a project that is not in the column could not be
   * found. Archived chats are in neither, and a pinned one is on the shelf instead, for the reason a
   * pinned agent leaves the list below it. Most recently active first, in both lists.
   */
  const agentSlugs = new Set(agents.map((a) => a.agent_id));
  const pinnedThreadSet = new Set(pinnedThreadIds);
  const threadsByAgent = new Map<string, ThreadView[]>();
  const recentThreads: ThreadView[] = [];
  for (const t of [...threadRows].sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))) {
    if (t.archived_at || pinnedThreadSet.has(t.id)) continue;
    if (t.agent_id && agentSlugs.has(t.agent_id)) {
      const bucket = threadsByAgent.get(t.agent_id);
      if (bucket) bucket.push(t);
      else threadsByAgent.set(t.agent_id, [t]);
    } else {
      recentThreads.push(t);
    }
  }

  // §2 wanted pinned agents first and no agent appearing twice; a section of their own gives both,
  // and says out loud what "first" only implied.
  const pinnedSet = new Set(pinned.map((a) => a.agent_id));
  // PINNED AGENTS LEAVE RECENTS ENTIRELY. They used to be sorted to the top of it, which is a
  // silent ordering: pinning something moved it a few rows and nothing on screen said why, and the
  // agent still counted as a recent one. A section of its own is what a pin is FOR — a shelf you
  // put things on, above the list they came from.
  const projectAgents = visible.filter((a) => !pinnedSet.has(a.agent_id));
  // Filtered like everything else. A pinned agent that the current filter excludes — archived, or
  // not running — should not reappear on a shelf above the filter that hid it, which would make
  // the filter look broken on the one row a person is most attached to.
  const visibleSet = new Set(visible.map((a) => a.agent_id));
  const pinnedVisible = pinned.filter((a) => visibleSet.has(a.agent_id));

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

      {/* PINNED — a shelf above the list, and only when something is on it.
          NOTHING WHEN EMPTY, deliberately: a permanent `Pinned` header over nothing is a section
          that teaches people it is broken — the same rule that leaves an empty Recents empty. It
          appears the moment somebody pins one and goes away again when they unpin the last. */}
      {(pinnedVisible.length > 0 || pinnedThreads.length > 0) && (
        <div className="mt-4 flex shrink-0 flex-col">
          <ListHeading label="Pinned" />
          {/* CAPPED, WHICH IS THE DIFFERENCE FROM RECENTS. The shelf is `shrink-0` so the list below
              can never squeeze it — and that is exactly what makes an unbounded one dangerous:
              forty pinned agents would push Recents to nothing and shove the account row off the
              bottom of the window. Past the cap it scrolls, so the shelf stays a shelf however many
              things somebody puts on it. In `vh` rather than `%` because a percentage height
              resolves against a parent that is `auto` here, which is to say it does not. */}
            <div className="flex max-h-[38vh] flex-col overflow-y-auto overflow-x-hidden px-1.5">
              {pinnedThreads.map((t) => (
                <PinnedThreadRow key={t.id} thread={t} />
              ))}
              {pinnedVisible.map((a) => (
                <AgentTreeRow
                  key={a.agent_id}
                  agent={a}
                  lastRunAt={lastRunByAgent.get(a.agent_id) ?? null}
                  threads={threadsByAgent.get(a.agent_id) ?? []}
                />
              ))}
            </div>
        </div>
      )}

      {/* PROJECTS, THEN RECENTS. Projects are the agents, each with its chats indented under it; Recents
          are the chats started without one. THE GAP IS THE SECTION BREAK between the destinations
          above and the lists below. */}
      <div className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col">
        {/* THE PROJECTS HEADING STAYS OUT OF THE SCROLLER, and that is for its filter: the filter's
            panel hangs below it, and inside an `overflow` it would be clipped by the list it filters. */}
        <ListHeading label="Projects">
          <FilterMenu filter={filter} setFilter={setFilter} counts={counts} />
        </ListHeading>

        {/* ONE SCROLLER FOR BOTH LISTS. `overflow-x-hidden` rather than nothing: a row that runs out of
            room truncates, and a truncation ends in an ellipsis rather than a scrollbar nobody looks for. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
          {/* NOTHING WHEN EMPTY, the product owner's call on 2026-09-11 — no mark, no "No agents yet".
              The filter in the heading says what is narrowing the list, and `New` leads the column. */}
            <div className="flex min-w-0 flex-col px-1.5">
              {projectAgents.map((a) => (
                <AgentTreeRow
                  key={a.agent_id}
                  agent={a}
                  lastRunAt={lastRunByAgent.get(a.agent_id) ?? null}
                  threads={threadsByAgent.get(a.agent_id) ?? []}
                />
              ))}
            </div>

          <div className="mt-4">
            {/* ON ARCHIVED, THE SECOND LIST IS THE ARCHIVED CHATS — beside the archived agents above it —
                rather than Recents, which only ever holds live ones. */}
            <ListHeading label={filter === "archived" ? "Archived chats" : "Recents"} />
              <div className="flex min-w-0 flex-col px-1.5">
                {filter === "archived"
                  ? archivedThreads.map((t) => <ArchivedThreadRow key={t.id} thread={t} />)
                  : recentThreads.map((t) => <ThreadListRow key={t.id} thread={t} />)}
              </div>
          </div>
        </div>
      </div>

      {/* Bottom-anchored: who is signed in. */}
      <div className="shrink-0 border-t border-sidebar-border px-2 py-2">
        <AccountRow />
      </div>
    </div>
  );
}

// §4's full-width Agents grid — the surface the Agents nav item opens.
//
// FILTER STATE IS LOCAL, WHICH IS THE REQUIREMENT RATHER THAN A SHORTCUT, exactly as it is in the
// Threads view: the state is per session, and local state does that by construction because the view
// unmounts when you leave it. A store would have to be remembered to be cleared.
//
// THE TWO EMPTY STATES MEAN DIFFERENT THINGS AND ARE DIFFERENT COMPONENTS (§4). "No agents in this
// workspace" is an ENTRY POINT — a prompt that opens a thread with no agent and the composer focused
// — and "nothing matches these filters" is a quieter one that names what is on and offers to clear
// it. Reusing one for the other would tell somebody with four filters set that they have no agents.
//
// THE GRID RE-RENDERS ONE CARD, NOT ALL OF THEM (§5.5). Each card subscribes to `liveSpend` itself
// rather than being handed a figure, so a step cost arriving for one agent re-renders that card and
// nothing else. That is why the spend is read inside `AgentCard` and not computed here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentCard } from "./AgentCard.tsx";
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { useAgentKeys } from "./useAgentKeys.ts";
import { FilterIcon, GridIcon, RowsIcon, ICON as AGENT_ICON } from "./agentIcons.tsx";
import { PlusIcon, RefreshIcon, SearchIcon, SparklesIcon, XIcon } from "./panelIcons.tsx";
import {
  AGENT_SORTS, NO_FILTERS, SORT_LABEL, connectorOptions, describeFilters, hasActiveFilters,
  visibleAgents, type AgentDensity, type AgentFilterState, type AgentSort,
} from "../lib/agentFilter.ts";
import { openAgentDetail, startAgentThread } from "../lib/agentNav.ts";
import { downloadVersion } from "../lib/agentExport.ts";
import {
  sendArchiveAgent, sendForkAgent, sendListAgentGrid, sendLoadAgentVersion, sendRenameAgent,
  sendRestoreAgent,
} from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useAgentGridStore } from "../store/agentGridStore.ts";
import { useMemberStore } from "../store/memberStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { AgentCardView } from "../types.ts";

/**
 * §4's first empty state, which is an ENTRY POINT rather than a notice.
 *
 * The same shape the Threads view's first empty state takes, and for the same reason: there is one
 * composer in this product and one place a brief is submitted from, so this does not send anything
 * itself. It hands the text to the composer and goes there — a second sender here would be a second
 * set of promises about the plan gate, the connector selection and the provider.
 *
 * NO ILLUSTRATION, NO MARKETING COPY (§4). One line and one field.
 */
function FirstAgentStart({ workspaceName }: { workspaceName: string | null }) {
  const [draft, setDraft] = useState("");
  const start = (): void => {
    const text = draft.trim();
    if (!text) return;
    useUiStore.getState().prefillChat(text);
    useUiStore.getState().closeNav();
    useUiStore.getState().focusChat();
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-[min(560px,90%)]">
        <div className="text-center text-[13px] text-ink">
          {workspaceName ? `No agents in ${workspaceName} yet` : "No agents yet"}
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-control border border-edge bg-panel px-3 py-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter starts it; nothing else here is a shortcut, and the view's own J/K must not
              // fire from inside a field somebody is typing a sentence into.
              e.stopPropagation();
              if (e.key === "Enter") start();
            }}
            placeholder="Describe an agent and Jaroku will build it"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint outline-none"
          />
          <span className="shrink-0 text-[10px] text-faint">↵</span>
        </div>
      </div>
    </div>
  );
}

/**
 * §4's filter controls, behind one button.
 *
 * FIVE PICKERS IN A ROW WOULD BE THE WIDEST THING ON THE SCREEN and would push the search field off
 * a narrow window — so they live in a popover under one icon, with the count of what is set on the
 * button. The count is what makes a collapsed control honest: a filter you cannot see is a filter you
 * forget you set, which is precisely how somebody ends up believing their agents have disappeared.
 */
function FilterMenu({
  filters,
  onChange,
  connectors,
  team,
  members,
}: {
  filters: AgentFilterState;
  onChange: (next: AgentFilterState) => void;
  connectors: string[];
  team: boolean;
  members: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const active = [
    filters.status !== null,
    filters.connector !== null,
    filters.deployed !== null,
    filters.createdBy !== null,
    filters.archived,
  ].filter(Boolean).length;

  const row = (label: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-1.5 px-2 py-2">
      <span className={TYPE.sectionLabel}>{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Filter the grid"
        aria-label="Filter the grid"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-control px-2 py-1.5 text-[12px] transition-colors duration-fast ${
          active > 0 ? "bg-active text-ink" : "text-muted hover:bg-active hover:text-ink"
        }`}
      >
        <FilterIcon size={ICON.sm} />
        {active > 0 && <span className="tabular-nums text-[11px]">{active}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" aria-hidden onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-card border border-edge bg-panel p-1 shadow-floating">
            {row(
              "Status",
              (["healthy", "degraded", "failing", "unverified"] as const).map((s) => (
                <Chip
                  key={s}
                  size="sm"
                  selected={filters.status === s}
                  onClick={() => onChange({ ...filters, status: filters.status === s ? null : s })}
                >
                  {s}
                </Chip>
              )),
            )}
            {connectors.length > 0 &&
              row(
                "Connector",
                connectors.map((c) => (
                  <Chip
                    key={c}
                    size="sm"
                    mono
                    selected={filters.connector === c}
                    onClick={() => onChange({ ...filters, connector: filters.connector === c ? null : c })}
                  >
                    {c}
                  </Chip>
                )),
              )}
            {row(
              "Deployed",
              [
                { label: "Live", value: true },
                { label: "Not deployed", value: false },
              ].map(({ label, value }) => (
                <Chip
                  key={label}
                  size="sm"
                  selected={filters.deployed === value}
                  onClick={() => onChange({ ...filters, deployed: filters.deployed === value ? null : value })}
                >
                  {label}
                </Chip>
              )),
            )}
            {/* TEAM ONLY. In a personal workspace this is a picker with one option, which is a
                control that cannot narrow anything. */}
            {team && members.length > 1 &&
              row(
                "Created by",
                members.map((m) => (
                  <Chip
                    key={m.id}
                    size="sm"
                    selected={filters.createdBy === m.id}
                    onClick={() => onChange({ ...filters, createdBy: filters.createdBy === m.id ? null : m.id })}
                  >
                    {m.name}
                  </Chip>
                )),
              )}
            {row(
              "Archived",
              <Chip
                size="sm"
                selected={filters.archived}
                onClick={() => onChange({ ...filters, archived: !filters.archived })}
              >
                Show archived
              </Chip>,
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function AgentsView() {
  const cards = useAgentGridStore((s) => s.cards);
  const team = useAgentGridStore((s) => s.team);
  const loaded = useAgentGridStore((s) => s.loaded);
  const error = useAgentGridStore((s) => s.error);
  const notice = useAgentGridStore((s) => s.notice);
  const version = useAgentGridStore((s) => s.version);
  const exportRequest = useAgentGridStore((s) => s.exportRequest);
  const workspaceName = useSessionStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.name ?? null);
  // NO CAST. The one that was here invented a shape with an `id` on it, and the store's real `Member`
  // is keyed by `user_id` — so the filter below read a field that does not exist and typechecked
  // anyway. A cast that describes a type wrongly is worse than no type at all.
  const members = useMemberStore((s) => s.members);
  // Whether this view's mutations can actually leave the tab. The composer has read the same thing
  // since it was written; a dropped write is otherwise invisible.
  const connected = useTraceStore((s) => s.connection === "open");

  const [filters, setFilters] = useState<AgentFilterState>(NO_FILTERS);
  const [sort, setSort] = useState<AgentSort>("active");
  const [density, setDensity] = useState<AgentDensity>("comfortable");
  const [cursor, setCursor] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);

  // ASK ON MOUNT. The grid is a read the relay answers to this socket alone, so unlike the sidebar's
  // list nothing pushes it before somebody opens the tab.
  useEffect(() => {
    if (connected) sendListAgentGrid();
  }, [connected]);

  /**
   * A notice belongs to the visit it happened in.
   *
   * "Forked to api_gateway_copy" is worth reading once, on the surface where the fork was made. It
   * lives in the store because the answer arrives after the broadcast that caused it — but the store
   * outlives this view, so without this it was still sitting there days later, greeting somebody who
   * opened the tab to do something else entirely. Cleared on the way out rather than on the way in,
   * so a notice that lands in the same tick as a navigation is still shown before it goes.
   */
  useEffect(() => () => useAgentGridStore.getState().setNotice(null), []);

  const visible = useMemo(() => visibleAgents(cards, filters, sort), [cards, filters, sort]);
  const connectors = useMemo(() => connectorOptions(cards), [cards]);
  /**
   * The workspace's people, as the `created_by` filter and the creator avatar need them.
   *
   * `user_id`, NOT `id`, AND THAT WAS THE WHOLE BUG. `Member` is keyed by `user_id` — the column
   * `workspace_members` actually holds — and this read `m.id`, which is not a field on that type at
   * all. Every option came out with `id: undefined`, so §4's Team-only creator filter matched
   * nothing whatever was picked and §5.2's avatar never rendered on any card. It typechecked because
   * the store's array was cast on the way in; the cast is gone, so the type is what catches this now.
   */
  const memberOptions = useMemo(
    () => members.map((m) => ({ id: m.user_id, name: m.display_name || m.email || m.user_id.slice(0, 6) })),
    [members],
  );

  const openCard = useCallback((agent: AgentCardView) => openAgentDetail(agent.slug), []);
  const newThread = useCallback((agent: AgentCardView) => startAgentThread(agent.slug), []);

  useAgentKeys({
    cards: visible,
    cursor,
    setCursor,
    focusSearch: () => searchInput.current?.focus(),
    onOpen: openCard,
    onNewThread: newThread,
  });

  // §5.5: "Focus must be visible, and it must survive a filter change." A cursor on a card that is
  // no longer rendered — filtered out, archived, or removed by somebody else's snapshot — falls back
  // to the first card rather than to nothing, so the next keystroke does something.
  useEffect(() => {
    if (cursor && !visible.some((c) => c.slug === cursor)) setCursor(visible[0]?.slug ?? null);
  }, [cursor, visible]);

  /**
   * §5.2's "Export current version", finished.
   *
   * THE MENU ENTRY COULD ONLY ASK; THIS IS WHAT ANSWERS. Exporting is a round trip — the files are in
   * the object store, not in the grid snapshot — so the card sets a one-shot intent and the payload
   * that comes back is saved here. Without this half the menu entry fetched a version into the store
   * and downloaded nothing at all, which is a control that appears to work and does not.
   *
   * MATCHED ON THE AGENT, so a version somebody happens to be BROWSING in the detail is never saved
   * by accident: the intent names a slug, and only a payload for that slug consumes it.
   */
  useEffect(() => {
    if (!exportRequest || !version || version.agentId !== exportRequest) return;
    downloadVersion(version.agentId, version.version, version.files);
    useAgentGridStore.getState().clearExportRequest();
  }, [exportRequest, version]);

  // AND THE FOCUSED CARD IS SCROLLED TO. A cursor that is visible only when it happens to be on
  // screen is a cursor somebody loses on the second J.
  useEffect(() => {
    if (!cursor) return;
    document
      .querySelector(`[data-agent-card="${CSS.escape(cursor)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor]);

  const initialFor = (agent: AgentCardView): string | null => {
    if (!team || !agent.created_by) return null;
    const member = memberOptions.find((m) => m.id === agent.created_by);
    return (member?.name ?? "?").slice(0, 1).toUpperCase();
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* §4's header bar. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair px-5 py-3">
        {/* §4: "Workspace name and agent count." The NAME, not just the word Agents — this is a
            full-width surface with no other chrome saying whose agents these are, and a Team
            workspace switcher two clicks away makes "which workspace am I looking at" a real
            question. It falls back to the section name before the session lands rather than
            rendering a placeholder that flashes into somebody else's workspace. */}
        <span className={TYPE.panelLabel}>{workspaceName ?? "Agents"}</span>
        <span className="text-faint text-[11px] tabular-nums">{cards.filter((c) => !c.archived_at).length}</span>
        {workspaceName && <span className="text-[11px] text-faint">agents</span>}
        {!connected && (
          <span className="text-[11px] text-muted" title="Changes here need a connection">
            reconnecting…
          </span>
        )}

        {/* Live filter over display_name and slug. `/` focuses it — see useAgentKeys. */}
        <div className="ml-2 flex min-w-[180px] flex-1 items-center gap-2 rounded-control border border-hair bg-panel px-2 py-1 focus-within:border-edge">
          <SearchIcon size={ICON.xs} className="shrink-0 text-faint" />
          <input
            ref={searchInput}
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setFilters((f) => ({ ...f, query: "" }));
            }}
            placeholder="Search agents…"
            aria-label="Search agents by name or slug"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-faint outline-none"
          />
          {filters.query && (
            <button
              onClick={() => setFilters((f) => ({ ...f, query: "" }))}
              title="Clear the search"
              aria-label="Clear the search"
              className="shrink-0 text-faint transition-colors hover:text-ink"
            >
              <XIcon size={ICON.xs} />
            </button>
          )}
        </div>

        <FilterMenu
          filters={filters}
          onChange={setFilters}
          connectors={connectors}
          team={team}
          members={memberOptions}
        />

        {/* SORT AS A SELECT, WHICH IS THE ONE PLACE THIS TAB USES ONE. §8's rule is that every row
            action, tab, filter and overflow entry is an icon — and four mutually exclusive orders
            with names ("Last active", "7-day spend") are not four icons anybody could name. */}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as AgentSort)}
          aria-label="Sort the grid"
          title="Sort the grid"
          className="shrink-0 rounded-control border border-hair bg-panel px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:border-edge hover:text-ink"
        >
          {AGENT_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>

        {/* §4's density toggle. Two icon-only controls, each with a label and a tooltip. */}
        <div className="flex shrink-0 items-center rounded-control border border-hair">
          {(
            [
              ["comfortable", GridIcon, "Comfortable — three per row, with the current work"],
              ["compact", RowsIcon, "Compact — more per row, shorter cards"],
            ] as const
          ).map(([id, Icon, title]) => (
            <button
              key={id}
              type="button"
              onClick={() => setDensity(id)}
              title={title}
              aria-label={title}
              aria-pressed={density === id}
              className={`p-1.5 transition-colors duration-fast first:rounded-l-control last:rounded-r-control ${
                density === id ? "bg-active text-ink" : "text-faint hover:text-ink"
              }`}
            >
              <Icon size={AGENT_ICON.sm} />
            </button>
          ))}
        </div>

        <button
          onClick={() => sendListAgentGrid()}
          disabled={!connected}
          className="shrink-0 rounded-control p-1.5 text-faint transition-colors hover:bg-active hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          title="Ask for the grid again"
          aria-label="Ask for the grid again"
        >
          <RefreshIcon size={12} />
        </button>

        {/* §9 keeps a label on the two `+ New` actions, which is where a label genuinely carries
            meaning. §5.4 is explicit that no `New` pill goes beside it — there it would read as a
            label ON the button rather than as a description of anything. */}
        <button
          onClick={() => {
            useUiStore.getState().closeNav();
            useUiStore.getState().focusChat();
          }}
          disabled={!connected}
          className="flex shrink-0 items-center gap-1.5 rounded-control px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-active hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          title={connected ? "Describe a new agent in the composer" : "Reconnecting — a new agent needs a connection"}
        >
          <PlusIcon size={12} /> New agent
        </button>
      </div>

      {/* A refusal is shown rather than swallowed, and it is dismissed by the next snapshot. */}
      {error && <div className="shrink-0 border-b border-hair px-5 py-2 text-[11px] text-err">{error}</div>}
      {notice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hair bg-active/40 px-5 py-1.5 text-[11px] text-muted">
          <span>{notice}</span>
          <button
            onClick={() => useAgentGridStore.getState().setNotice(null)}
            title="Dismiss"
            aria-label="Dismiss"
            className="ml-auto shrink-0 text-faint transition-colors hover:text-ink"
          >
            <XIcon size={ICON.xs} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {!loaded ? (
          // NOT A SPINNER (§9). Skeleton cards at the card's own geometry, so the grid does not jump
          // when the real ones land.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="overflow-hidden rounded-card border border-hair bg-panel">
                <div className="h-[104px] w-full bg-active" />
                <div className="space-y-2 p-3">
                  <div className="h-3 w-1/2 rounded bg-active" />
                  <div className="h-2.5 w-1/3 rounded bg-active/70" />
                  <div className="h-2.5 w-3/4 rounded bg-active/70" />
                </div>
              </div>
            ))}
          </div>
        ) : cards.length === 0 ? (
          <FirstAgentStart workspaceName={workspaceName} />
        ) : visible.length === 0 ? (
          // §4's SECOND empty state, which is a different sentence from the first. It names what is
          // on and offers to clear it — telling somebody with four filters set that they have no
          // agents is the one thing this must not do.
          <EmptyState
            icon={SearchIcon}
            title="Nothing matches these filters"
            hint={
              <>
                <span>{describeFilters(filters).join(" · ")}</span>
                {hasActiveFilters(filters) && (
                  <button
                    onClick={() => setFilters(NO_FILTERS)}
                    className="ml-2 text-muted underline decoration-dotted hover:text-ink"
                  >
                    Clear them
                  </button>
                )}
              </>
            }
          />
        ) : (
          <div
            className={`grid gap-4 ${
              // BOTH DENSITIES ARE REAL LAYOUTS (§4): comfortable targets three per row at desktop
              // width, compact four or five with a shorter card. `auto-fill` with a minimum rather
              // than a fixed column count, so the grid reflows honestly when somebody drags the
              // sidebar instead of overflowing at a width nobody tested.
              density === "compact"
                ? "grid-cols-[repeat(auto-fill,minmax(210px,1fr))]"
                : "grid-cols-[repeat(auto-fill,minmax(300px,1fr))]"
            }`}
          >
            {visible.map((agent) => (
              <AgentCard
                key={agent.slug}
                agent={agent}
                density={density}
                focused={agent.slug === cursor}
                creatorInitial={initialFor(agent)}
                onOpen={() => openCard(agent)}
                onNewThread={() => newThread(agent)}
                onFork={() => sendForkAgent(agent.slug)}
                onRename={() => {
                  // The rename is a prompt rather than an inline field, and only here. The sidebar
                  // already renames in place on the row, which is where somebody who has picked an
                  // agent does it; a second inline editor on a card in a grid would be a second
                  // place the same edit can be half-finished.
                  const next = window.prompt(`Rename ${agent.name}`, agent.name);
                  if (next && next.trim()) sendRenameAgent(agent.slug, next.trim());
                }}
                onExport={() => {
                  // The intent first, then the request: on a warm store the answer can land in the
                  // same tick, and an intent set afterwards would be one nothing consumes.
                  useAgentGridStore.getState().requestExport(agent.slug);
                  sendLoadAgentVersion(agent.slug);
                }}
                onArchive={() => {
                  // §7.5's confirmation, NAMING THE CREATOR, as the collaborative-workspace safety
                  // net. It sits on archive because archive is the destructive-looking act this
                  // product actually has — there is no delete path for an agent, deliberately.
                  const who = agent.created_by
                    ? memberOptions.find((m) => m.id === agent.created_by)?.name ?? "someone else"
                    : null;
                  const line = who
                    ? `Archive ${agent.name}? It was created by ${who}.`
                    : `Archive ${agent.name}?`;
                  if (window.confirm(`${line}\n\nIts versions, runs and threads all stay. You can restore it.`)) {
                    sendArchiveAgent(agent.slug);
                  }
                }}
                onRestore={() => sendRestoreAgent(agent.slug)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The mark the unbuilt destinations used for Agents, kept here so the nav item and the view agree. */
export const AGENTS_ICON = SparklesIcon;

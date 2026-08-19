// Left sidebar — the agent/run library (doc §4.1). Top: New Agent, search, and status filter
// tabs over the agent list. A flexible middle holds recent runs (how you re-open a past trace).
// Bottom-anchored: Settings and the user/plan chip. Restraint-first: rows float on the panel,
// separated by spacing and a thin accent on the active one — never boxed.

import { useState } from "react";
import { orderedRuns, useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import type { AgentSummary, RunSummary, RunStatus } from "../types.ts";
import { relTime } from "../lib/format.ts";
import { agentStatus, type AgentStatus } from "../lib/agentStatus.ts";
import { ProviderMark, ConnectorDot } from "../lib/icons.tsx";
import { selectAgent, selectRun } from "../lib/selection.ts";
import {
  sendArchiveAgent, sendLoadHistory, sendLoadRun, sendRenameAgent, sendRestoreAgent,
} from "../lib/socket.ts";
import { ICON, STATUS, SURFACE, TYPE } from "../lib/tokens.ts";
import { useUiStore, type NavDestination } from "../store/uiStore.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { EmptyState } from "./EmptyState.tsx";
import {
  ActivityIcon, GitForkIcon, GithubIcon, GlobeIcon, HashIcon, InboxIcon,
  LoaderIcon, PauseIcon, PencilIcon, PlusIcon, SearchIcon, SettingsIcon, SparklesIcon, XIcon,
} from "./panelIcons.tsx";

/**
 * §2's nav buttons, in the order the spec lists them.
 *
 * DATA RATHER THAN FOUR COPIES OF THE SAME MARKUP, so the badge that lands on one of them later is a
 * field here rather than a special case in one of four branches.
 */
const NAV_DESTINATIONS: { id: NavDestination; label: string; icon: (p: { size?: number }) => React.ReactElement }[] = [
  { id: "threads", label: "Threads", icon: HashIcon },
  { id: "agents", label: "Agents", icon: SparklesIcon },
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "activity", label: "Activity", icon: ActivityIcon },
];

// `archived` is the sixth, and it is a filter rather than a section for the reason §3.4 gives about
// threads: an archived thing has LEFT the default list, and a list that showed both would make
// "archived" a decoration instead of a state. It is last, after the states that describe live work.
type Filter = "all" | "running" | "deployed" | "synced" | "drafts" | "archived";

// A run's outcome, in the same marks the rest of the app uses for the same facts.
// It was font characters — a pulsing ●, a ✗ and a ✓ — which sat on the text baseline at
// whatever weight the row happened to be and never optically matched the icons two panels over.
//
// `paused` is exhaustive here on purpose. It arrived after the other three and fell through to
// the ✓, so a run halted mid-graph wore the same green tick as one that ran to completion — and
// this list is the only place a paused run can be found and resumed from.
function StatusGlyph({ status }: { status: RunStatus }) {
  switch (status) {
    case "running":
      return <StatusDot state="pending" icon={LoaderIcon} spin title="running" />;
    case "paused":
      return <StatusDot state="pending" icon={PauseIcon} title="paused — resumable" />;
    case "error":
      return <StatusDot state="error" icon={XIcon} title="error" />;
    case "completed":
      return <StatusDot state="ok" title="completed" />;
  }
}

// Two states pulse: a local run and a deploy in flight. Both mean "this is changing right
// now", which is the only thing the animation is ever allowed to mean.
const DOT_COLOR: Record<AgentStatus, string> = {
  running: "bg-run",
  deploying: "bg-run",
  draft: "bg-faint",
  deployed: "bg-ok",
  ran: "bg-ok",
};

function AgentDot({ status }: { status: AgentStatus }) {
  const moving = status === "running" || status === "deploying";
  return (
    <span
      title={status}
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_COLOR[status]} ${
        moving ? "animate-stream-pulse motion-reduce:animate-none" : ""
      }`}
    />
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const needsLoad = useTraceStore((s) => s.needsLoad);
  const active = run.id === activeRunId;

  return (
    <button
      onClick={() => { if (needsLoad(run.id)) sendLoadRun(run.id); selectRun(run.id); }}
      className={`relative w-full text-left px-4 py-2 transition-colors ${active ? "bg-active" : "hover:bg-active/40"}`}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}
      {/* Branches (debug depth) are indented under the run they forked from, with a fork mark. */}
      <div className={`flex items-center gap-2 ${run.parent_run_id ? "pl-3" : ""}`}>
        {run.parent_run_id && (
          <span className="shrink-0 text-faint" title="branch">
            <GitForkIcon size={ICON.xs} />
          </span>
        )}
        <StatusGlyph status={run.status} />
        <Truncate className={`text-[12px] ${active ? "text-accent" : "text-ink"}`} title={run.agent_id}>{run.agent_id}</Truncate>
        <span className="ml-auto text-faint text-[11px] shrink-0">{relTime(run.started_at)}</span>
      </div>
      <div className={`mt-0.5 text-[11px] text-muted flex items-center gap-1.5 ${run.parent_run_id ? "pl-7" : "pl-4"}`}>
        {/* The same bare chip the agent row uses for the same fact, so a run and the agent it
            belongs to name their provider identically. */}
        <Chip size="sm" tone="faint" mono variant="bare">{run.provider}</Chip>
        {run.step_count != null && <><span className="text-faint">·</span><span>{run.step_count} steps</span></>}
        {run.parent_run_id != null && run.branch_from_seq != null && (
          <><span className="text-faint">·</span><span className="text-faint">branch @{run.branch_from_seq}</span></>
        )}
      </div>
    </button>
  );
}

/**
 * The row's lifecycle actions — PS-01's missing affordance.
 *
 * THERE WAS NO WAY TO REMOVE OR RENAME AN AGENT AT ALL. The row was a single button with no context
 * menu and no overflow, and there was no `deleteAgent`, `renameAgent` or `archiveAgent` anywhere in
 * the product — so an agent created by mistake stayed in this list, in the filter counts, in the eval
 * picker and in the composer's targets forever, while every other resource in the product had a
 * lifecycle.
 *
 * ARCHIVE, NOT DELETE, which is the answer threads got and for the same reasons: the versions, runs,
 * traces and costs hanging off an agent are the record, and "tidy the sidebar" must not be the same
 * button as "destroy the history". One press back either way.
 *
 * ON HOVER AND ON KEYBOARD FOCUS, not always. Two controls on every row of a dense column would
 * out-weigh the agent's own name; `group-focus-within` is what keeps them reachable without a mouse,
 * which is the trap a hover-only affordance sets.
 */
function AgentActions({ agent, onRename }: { agent: AgentSummary; onRename: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const archived = Boolean(agent.archived_at);

  if (archived) {
    return (
      <button
        onClick={() => sendRestoreAgent(agent.agent_id)}
        title="Bring this agent back"
        className="shrink-0 rounded-control px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-active hover:text-ink"
      >
        Restore
      </button>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <button
        onClick={onRename}
        title="Rename (double-click the row)"
        className="rounded-control p-1 text-faint transition-colors hover:bg-active hover:text-ink"
      >
        <PencilIcon size={ICON.xs} />
      </button>
      {confirming ? (
        <button
          autoFocus
          onBlur={() => setConfirming(false)}
          onClick={() => {
            sendArchiveAgent(agent.agent_id);
            setConfirming(false);
          }}
          className="rounded-control border border-hair px-1.5 py-0.5 text-[11px] text-ink"
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
          className="rounded-control p-1 text-faint transition-colors hover:bg-active hover:text-ink"
        >
          <XIcon size={ICON.xs} />
        </button>
      )}
    </span>
  );
}

function AgentRow({ agent }: { agent: AgentSummary }) {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const runs = useTraceStore((s) => s.runs);
  // §4: the same delta the tab badge carries, on the row. An agent list that says "synced" without
  // saying HOW synced makes you open each one to find out which is the one with work on it.
  const github = useGithubStore((s) => s.views[agent.agent_id]);
  const active = agent.agent_id === activeAgentId;
  const status = agentStatus(agent.agent_id, runs, agent.deployment);
  const archived = Boolean(agent.archived_at);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(agent.name);

  // Newest run for this agent → last-active timestamp.
  let last: RunSummary | undefined;
  for (const r of Object.values(runs)) {
    if (r.agent_id === agent.agent_id && (!last || r.started_at > last.started_at)) last = r;
  }

  const commit = (): void => {
    const next = draft.trim();
    // SENT EVEN WHEN IT MATCHES the name already shown, because committing the editor is a CHOICE:
    // the server's rename also sets the custom flag that stops the next disk sync overwriting it, so
    // "I want this name" and "this name happens to be what the file says" are different states. That
    // is the same mistake §5's thread rename made and the same fix.
    if (next) sendRenameAgent(agent.agent_id, next);
    setRenaming(false);
  };

  return (
    // A DIV WRAPPING TWO BUTTONS rather than one button wrapping everything, which is what it was:
    // a control inside a control is invalid markup and un-clickable in practice, so the row's own
    // selection and its lifecycle actions have to be siblings.
    <div
      className={`group relative transition-colors ${active ? "bg-active" : "hover:bg-active/40"} ${
        archived ? "opacity-60" : ""
      }`}
      onDoubleClick={() => {
        if (archived) return;
        setDraft(agent.name);
        setRenaming(true);
      }}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}
      <div className="flex items-start gap-1 px-4 py-2.5">
        <button onClick={() => selectAgent(agent.agent_id)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            {agent.runnable ? (
              <AgentDot status={status} />
            ) : (
              <StatusDot state="error" icon={XIcon} title="missing agent.py" />
            )}
            {renaming ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") setRenaming(false);
                }}
                // The click that lands in the field must not also select the agent underneath it.
                onClick={(e) => e.stopPropagation()}
                className="min-w-0 flex-1 rounded-control bg-void px-1.5 py-0.5 text-[13px] text-ink outline-none"
              />
            ) : (
              <Truncate className={active ? "text-accent" : "text-ink"} title={agent.name}>{agent.name}</Truncate>
            )}
            {archived && <Chip size="sm" tone="faint" variant="bare">archived</Chip>}
            {github?.badge && (
              <span
                className={`ml-auto shrink-0 font-mono text-[10px] tabular-nums ${
                  github.badge === "↕" || github.badge === "⚠" ? "text-err" : "text-faint"
                }`}
                title={github.verdict}
              >
                {github.badge}
              </span>
            )}
            {last && <span className={`text-faint text-[11px] shrink-0 ${github?.badge ? "" : "ml-auto"}`}>{relTime(last.started_at)}</span>}
          </div>
          {/* A provider and a connector are both names of things this agent is wired to — the same
              kind of label the plan card puts on a reviewed tool. Bare rather than filled: a row of
              four filled chips under every agent would out-weigh the agent's own name above it. */}
          <div className="mt-0.5 pl-2 flex flex-wrap items-center gap-0.5">
            <Chip
              size="sm"
              tone="faint"
              mono
              variant="bare"
              icon={<ProviderMark provider={agent.default_provider} size={ICON.badge} />}
            >
              {agent.default_provider}
            </Chip>
            {agent.connectors.map((c) => (
              <Chip key={c} size="sm" tone="faint" mono variant="bare" icon={<ConnectorDot id={c} />}>
                {c}
              </Chip>
            ))}
            {/* Where its code lives, for the same reason the URL below is here: a list that says
                "synced" without saying where makes you open the tab to find out. */}
            {github && (
              <Chip size="sm" tone="faint" mono variant="bare" icon={<GithubIcon size={ICON.badge} />} title={github.verdict}>
                {github.link.repo_full_name}
              </Chip>
            )}
            {/* Where it is serving, not just that it is. A URL is the whole point of a deploy, and
                an agent list that says "deployed" without saying where makes you go and look. */}
            {agent.deployment?.status === "live" && agent.deployment.url && (
              <Chip
                size="sm"
                tone="faint"
                mono
                variant="bare"
                icon={<span style={{ color: STATUS.ok }}><GlobeIcon size={ICON.badge} /></span>}
              >
                {agent.deployment.url.replace(/^https?:\/\//, "")}
              </Chip>
            )}
          </div>
        </button>
        <AgentActions
          agent={agent}
          onRename={() => {
            setDraft(agent.name);
            setRenaming(true);
          }}
        />
      </div>
    </div>
  );
}

/**
 * The four top-level destinations (§2), with §2.1's live badge on Threads.
 *
 * THE BADGE IS THE COUNT OF WHAT IS BLOCKED, AND NOTHING ELSE. Never `running`: a run is cost accruing,
 * not something waiting on a person, and a badge that added the two would answer two different
 * questions at once — which is exactly the ambiguity the GitHub tab's badge vocabulary was designed to
 * avoid. Zero renders NO badge at all, matching the empty-sections discipline: a badge showing 0 is
 * noise, not information.
 *
 * IT IS THE SAME NUMBER THE `Needs you` CHIP SHOWS, from the same snapshot field — one count, computed
 * once on the server, rendered twice. Two independently-derived counts of "what is waiting on me" that
 * disagreed would be visible in two places a person compares, which is the trust-eroding mismatch §2.1
 * names.
 *
 * The active one wears the same left accent and `bg-active` an agent row does when selected, because
 * it is the same fact — this is what the panel to the right is showing. A second visual vocabulary for
 * "current" in one column would make the two compete.
 */
function NavRail() {
  /**
   * `navSection`, NOT `navView` — §2's fourth rule.
   *
   * "The sidebar item stays visually active the entire time, in both the full-width and the 3-pane
   * state." Picking a row or a card collapses the full-width view, which is the transition, so an
   * item drawn from `navView` went dark at exactly the moment the spec says it must not — and the
   * only way back to the list stopped looking like a way back to anything.
   */
  const navSection = useUiStore((s) => s.navSection);
  const openNav = useUiStore((s) => s.openNav);
  const needsYou = useThreadStore((s) => s.counts.needs_you);
  /**
   * §5.2's badge: BLOCKING PLUS PROPOSALS ONLY.
   *
   * ATTENTION IS DELIBERATELY EXCLUDED, and the specification asks in as many words that nobody
   * "fix" it: if the badge counted everything it would never reach zero, and a badge that is never
   * zero is a badge people train themselves to ignore.
   *
   * ONE NUMBER, COMPUTED ONCE ON THE SERVER. `counts.badge` is the same field the board's own rail
   * reads, which is the rule the Threads badge above already follows — two independently-derived
   * counts of "what is waiting on me" that disagree are visible in two places somebody compares.
   */
  const waiting = useInboxStore((s) => s.counts.badge);

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 py-2">
      {NAV_DESTINATIONS.map(({ id, label, icon: Icon }) => {
        const active = navSection === id;
        const badge = id === "inbox" ? waiting : id === "threads" ? needsYou : 0;
        const badgeTitle =
          id === "inbox"
            ? `${waiting} item${waiting === 1 ? "" : "s"} blocked or waiting on a decision`
            : `${needsYou} thread${needsYou === 1 ? "" : "s"} waiting on you`;
        return (
          <button
            key={id}
            onClick={() => openNav(id)}
            // The tooltip IS the label. Four words of chrome bought nothing that a glyph plus a
            // name on hover does not, and they cost a hundred pixels of the column the agent list
            // is trying to use.
            title={label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              active ? "bg-active text-accent" : "text-muted hover:bg-active/40 hover:text-ink"
            }`}
          >
            <Icon size={ICON.md} />
            {/* Present only when there is something to say, and `tabular-nums` so a count going
                from 9 to 10 does not shift the glyph beside it. Neutral rather than amber on the
                Inbox: amber means RUNNING in this palette, which is the one thing v0.2.2's
                wordmark pass established it may never be borrowed for. */}
            {badge > 0 && (
              <span
                title={badgeTitle}
                className={`absolute -right-0.5 -top-0.5 min-w-[13px] rounded-chip px-0.5 text-center text-[10px] leading-[13px] tabular-nums ${
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

      {/* THE FOOT OF THE RAIL. A bare gear, where a `⚙ Settings ›` row used to spend a whole line
          on one word and a chevron that pointed at nothing navigable. */}
      <button
        onClick={() => useUiStore.getState().setProviderPanel(true)}
        title="Provider keys"
        aria-label="Provider keys"
        className="mt-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-active/40 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <SettingsIcon size={ICON.md} />
      </button>
    </div>
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
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const name = user?.displayName || user?.email;

  // Before the session lands there is no account to name. An empty row is quieter than a
  // placeholder that flashes into somebody else's initial.
  if (!user) return <div className="h-8" />;

  return (
    <button
      onClick={() => openWorkspacePanel("members")}
      title={`${user.email}${workspace ? ` — ${workspace.role} of ${workspace.name}` : ""}`}
      className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-active"
    >
      {/* The first letter of whoever is actually here, uppercased. */}
      <span className="flex h-5 w-5 items-center justify-center rounded-control bg-active text-[11px] text-ink">
        {(name ?? "?").trim().charAt(0).toUpperCase()}
      </span>
      <Truncate className="text-[12px] text-ink" title={name}>{name}</Truncate>
      {/* Only when the session carries one. A chip is a claim about what the workspace is paying,
          and inventing a default for it is how the hardcoded `Free` got there in the first place. */}
      {workspace?.plan?.label && (
        <Chip caps size="sm" tone="faint" className="ml-auto shrink-0">{workspace.plan.label}</Chip>
      )}
    </button>
  );
}

export function Sidebar() {
  const runs = useTraceStore((s) => s.runs);
  const agents = useBuildStore((s) => s.agents);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
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
  const tab = (id: Filter, label: string, count?: number) => (
    <button
      onClick={() => setFilter(id)}
      className={`text-[11px] px-2 py-1 rounded-control transition-colors ${filter === id ? "bg-active text-ink" : "text-muted hover:text-ink"}`}
    >
      {label}{count != null && count > 0 && <span className="ml-1 text-faint">{count}</span>}
    </button>
  );

  return (
    // rail | column. §2's four destinations become the rail — the sidebar itself still never
    // collapses and never hides, and clicking one still replaces the centre pane and the right
    // panel with one full-width view while leaving this column exactly as it is, selection
    // included. What changes is that they cost forty pixels of width instead of a hundred pixels
    // of height plus a divider, and the column beside them belongs entirely to the list.
    <div className="flex h-full bg-bg">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col border-l border-hair">
      {/* New Agent */}
      <div className="px-3 pt-3 shrink-0">
        <button
          onClick={() => selectAgent(null)}
          className={`w-full text-left text-[13px] rounded-control px-3 py-2 transition-colors flex items-center gap-2 ${
            activeAgentId === null ? "bg-active text-ink" : "text-muted hover:bg-active/50 hover:text-ink"
          }`}
        >
          <PlusIcon size={ICON.sm} /> New Agent
        </button>
      </div>

      {/* search */}
      <div className="px-3 pt-2 shrink-0">
        <div className="flex items-center gap-2 bg-active rounded-control px-2.5 py-1.5">
          <span className="shrink-0 text-faint"><SearchIcon size={ICON.xs} /></span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="flex-1 min-w-0 bg-transparent text-ink placeholder:text-faint text-[12px] outline-none"
          />
          <span className="text-faint text-[11px]">⌘K</span>
        </div>
      </div>

      {/* filter tabs */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-1 shrink-0">
        {tab("all", "All")}
        {tab("running", "Running", counts.running)}
        {tab("deployed", "Deployed", counts.deployed)}
        {tab("synced", "Synced", counts.synced)}
        {tab("drafts", "Drafts", counts.drafts)}
        {/* Only when there is something in it. An Archived tab on a workspace that has never
            archived anything is a tab that leads to an empty state, which is the same noise an empty
            section is in the Threads view. */}
        {counts.archived > 0 && tab("archived", "Archived", counts.archived)}
      </div>

      {/* PINNED, above the rest of the list — §2's order for this column.
          Only when there is something pinned: an empty PINNED heading is the same noise as an empty
          section in the Threads view, and the same rule applies. Pinning is `P` on a selected thread,
          which pins that thread's AGENT — see uiStore's pins for why it is per person and not shared. */}
      {pinned.length > 0 && (
        <div className="shrink-0">
          <div className="flex items-center px-4 pt-2 pb-1">
            <span className={TYPE.panelLabel}>Pinned</span>
            <span className="ml-auto text-faint text-[11px]">{pinned.length}</span>
          </div>
          {pinned.map((a) => <AgentRow key={`pinned-${a.agent_id}`} agent={a} />)}
          <div className="mt-1 border-t border-hair" />
        </div>
      )}

      {/* agent list */}
      <div className="max-h-[38%] overflow-auto shrink-0">
        {visible.length === 0 ? (
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
          visible.map((a) => <AgentRow key={a.agent_id} agent={a} />)
        )}
      </div>

      {/* runs — how you re-open a past trace */}
      <div className="mt-1 flex shrink-0 items-center border-t border-hair px-4 py-2">
        <span className={TYPE.panelLabel}>Runs</span>
        <span className="ml-auto text-faint text-[11px]">{runList.length}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {runList.length === 0 ? (
          <EmptyState size="inline" icon={ActivityIcon} title="No runs yet" />
        ) : (
          runList.map((r) => <RunRow key={r.id} run={r} />)
        )}
        {/* OLDER RUNS — the paging this product had none of.
            The list read stops at a window, and until now that window could not be widened: the
            51st-newest run was unreachable because `loadRun` needs an id and the only source of ids
            was this list. It offers itself once the window is full, because before that there is
            demonstrably nothing behind it, and it disappears when the server says a window came back
            short — which is the only reliable end-of-list signal there is. */}
        {runList.length >= historyWindow && !historyComplete && (
          <button
            onClick={() => sendLoadHistory(Math.min(historyWindow * 2, 500))}
            className="w-full px-4 py-2 text-left text-[11px] text-muted transition-colors hover:bg-active/40 hover:text-ink"
          >
            Load older runs…
          </button>
        )}
        {/* AND THE HONEST NOTE ABOUT THE SEARCH BOX. It filters what has been loaded, so somebody
            searching for last month's run used to be told there was no such run. Said plainly rather
            than left to be inferred, and only while there is more to load. */}
        {q && !historyComplete && (
          <p className="px-4 pb-2 text-[11px] leading-[1.5] text-faint">
            Searching the {runList.length} loaded runs. Load older ones to search further back.
          </p>
        )}
      </div>

      {/* bottom-anchored: who is signed in, and what this workspace is paying. Settings moved to
          the foot of the rail — a gear is the whole control, and the row it used to sit in spent a
          line on one word plus a chevron that pointed at nothing navigable. */}
      <div className="shrink-0 border-t border-hair px-3 py-2.5">
        <AccountRow />
        </div>
      </div>
    </div>
  );
}

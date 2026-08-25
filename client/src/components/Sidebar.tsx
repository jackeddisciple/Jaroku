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
import { ProviderMark } from "../lib/icons.tsx";
import { selectAgent, selectRun } from "../lib/selection.ts";
import {
  sendArchiveAgent, sendLoadHistory, sendLoadRun, sendRenameAgent, sendRestoreAgent,
} from "../lib/socket.ts";
import { ICON, SURFACE, TYPE } from "../lib/tokens.ts";
import { quietBtn, secondaryBtn } from "./buttons.ts";
import { AlertTriangleIcon } from "./panelIcons.tsx";
import { useUiStore, type NavDestination } from "../store/uiStore.ts";
import { useGithubStore } from "../store/githubStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ArchiveRestoreIcon, FilterIcon } from "./agentIcons.tsx";
import {
  ActivityIcon, CheckIcon, GitForkIcon, GlobeIcon, HashIcon, InboxIcon, RocketIcon,
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
      className={`relative w-full text-left px-4 py-2 transition-colors ${active ? "bg-active" : "hover:bg-active/40"}`}
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
            <span className="absolute left-[7px] top-0 bottom-0 w-px bg-hair" aria-hidden />
            <span className="relative shrink-0 bg-inherit text-faint" title="branch">
              <GitForkIcon size={ICON.xs} />
            </span>
          </>
        )}
        <StatusGlyph status={run.status} />
        <Truncate className={`text-[12px] ${active ? "text-accent" : "text-ink"}`} title={run.agent_id}>{run.agent_id}</Truncate>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-faint">
          <span>{run.provider}</span>
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
    // A GLYPH, LIKE THE OTHER TWO ACTIONS ON THIS ROW. It was the word `Restore` while a live row
    // ended in an icon-only pencil and X — so the same list switched between a text affordance and
    // an icon affordance depending on row state, which is visible the moment an archived row sits
    // among live ones.
    return (
      <button
        onClick={() => sendRestoreAgent(agent.agent_id)}
        title="Bring this agent back"
        aria-label="Restore this agent"
        className="shrink-0 rounded-control p-1 text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
      >
        <ArchiveRestoreIcon size={ICON.xs} />
      </button>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <button
        onClick={onRename}
        title="Rename (double-click the row)"
        className="rounded-control p-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
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
          className="rounded-control p-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
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

  // Everything the old second line said, as one sentence. Assembled from what is true rather than
  // from a fixed template, so an agent with no connectors and no repository does not advertise two
  // empty fields.
  const detail = [
    agent.default_provider,
    agent.connectors.length > 0 ? agent.connectors.join(", ") : null,
    github ? `${github.link.repo_full_name} — ${github.verdict}` : null,
    agent.deployment?.status === "live" && agent.deployment.url
      ? agent.deployment.url.replace(/^https?:\/\//, "")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
      <div className="flex items-center gap-1 px-4 py-2">
        <button
          onClick={() => selectAgent(agent.agent_id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          // WHAT THE SECOND LINE USED TO SAY. The row carried a wrapping chip strip under the
          // name — provider, every connector, the repository and the deploy URL — which is four
          // or more chips that could wrap to a third line, on the app's primary list, at two to
          // three times the height of the row it is a list of. The facts are not gone; they are
          // where a fact you consult belongs, rather than where a fact you scan belongs.
          title={detail}
        >
          {agent.runnable ? (
            <AgentDot status={status} />
          ) : (
            <StatusDot state="error" icon={XIcon} title="missing agent.py" />
          )}
          {/* The provider's mark rides inline before the name instead of as a chip beneath it —
              it is one glyph, it is always present, and it is the one thing on the old second
              line that reads at a glance. */}
          <span className="shrink-0 text-faint" aria-hidden>
            <ProviderMark provider={agent.default_provider} size={ICON.badge} />
          </span>
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
              className="min-w-0 flex-1 rounded-control bg-void px-1.5 py-0.5 text-[13px] text-ink outline-none focus-visible:shadow-focusring"
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
          {last && (
            <span
              className={`shrink-0 text-[11px] tabular-nums text-faint ${github?.badge ? "" : "ml-auto"}`}
              title={absTime(last.started_at)}
            >
              {relTime(last.started_at)}
            </span>
          )}
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
    <div>
      <button
        onClick={() => openWorkspacePanel("members")}
        title={`${user.email}${workspace ? ` — ${workspace.role} of ${workspace.name}` : ""}`}
        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-active active:bg-chrome"
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
      {/* RENDERED ONLY FOR AN ADMIN, and `AdminModeToggle` itself returns null otherwise — so for
          everybody else there is no element, no comment and nothing in view-source suggesting the
          mode exists. Absent rather than hidden, which is the specification's own instruction and
          the difference between invisible and one devtools panel away. */}
      <AdminModeToggle />
    </div>
  );
}

/**
 * The founder's switch, in the one place a session-wide setting belongs.
 *
 * NOTHING AT ALL FOR A NON-ADMIN. Not a disabled control, not a tooltip explaining why — the
 * component returns null, so the DOM contains no evidence that admin mode is a thing this product
 * has. That is deliberate: a greyed-out "Admin mode" row would be an invitation.
 *
 * IT CONFIRMS BEFORE TURNING ON AND NOT BEFORE TURNING OFF. Enabling removes every limit and starts
 * logging every bypass, which is worth a sentence somebody reads; disabling puts things back, and a
 * confirmation there would be friction on the safe direction — the one somebody reaches for when
 * they have just realised they are recording a demo.
 */
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
        className="mt-0.5 flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-[11px] text-err transition-colors hover:bg-active"
      >
        <span className="shrink-0"><AlertTriangleIcon size={ICON.badge} /></span>
        <span>Admin mode on — turn off</span>
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="mt-0.5 rounded-control border border-run/40 bg-run/[0.06] px-2 py-1.5">
        <p className="text-[11px] leading-[1.5] text-ink">
          Enable admin mode? This bypasses every tier limit and feature gate. Everything you do
          while it is on is logged as admin-privileged.
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button className={secondaryBtn} onClick={() => void apply(true)}>Enable</button>
          <button className={quietBtn} onClick={() => { setConfirming(false); setError(null); }}>
            Cancel
          </button>
        </div>
        {error && <p className="mt-1 text-[11px] text-err">{error}</p>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="mt-0.5 flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-[11px] text-faint transition-colors hover:bg-active hover:text-muted"
    >
      <span>Admin mode</span>
      <span className="ml-auto shrink-0">off</span>
    </button>
  );
}

/**
 * A section's heading inside the sidebar's one scroller.
 *
 * ONE RULE, STATED ONCE. The column drew four dividers at four different top margins — 8px after
 * the nav, 4px after the pinned group, none on the Runs header, none on the footer — which reads
 * as a rhythm error down a 280px column even when nobody can say which line is wrong. The rule is:
 * a hairline sits above a section's label, never between a label and its own rows.
 *
 * Sticky, because a single scroller needs its headings to stay put. `bg-bg` rather than
 * transparent for the same reason: a sticky header that rows scroll through is worse than no
 * header at all.
 */
function SectionHeader({ label, count, first = false }: { label: string; count: number; first?: boolean }) {
  return (
    <div
      className={`sticky top-0 z-10 flex items-center bg-bg px-4 py-1.5 ${first ? "" : "mt-1 border-t border-hair"}`}
    >
      <span className={TYPE.panelLabel}>{label}</span>
      <span className="ml-auto text-[11px] tabular-nums text-faint">{count}</span>
    </div>
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
          filtering || open ? "bg-active text-accent" : "text-muted hover:bg-active active:bg-chrome hover:text-ink"
        }`}
      >
        <FilterIcon size={ICON.sm} />
        {filtering && current?.count != null && (
          <span className="text-[10px] tabular-nums">{current.count}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[170px] animate-slide-in rounded-card border border-edge bg-panel p-1 shadow-floating motion-reduce:animate-none">
          {entries.map((e) => (
            <button
              key={e.id}
              onClick={() => {
                setFilter(e.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-[12px] transition-colors duration-fast ${
                filter === e.id ? "bg-active text-ink" : "text-muted hover:bg-active/40 hover:text-ink"
              }`}
            >
              {e.label}
              {e.count != null && e.count > 0 && (
                <span className="ml-auto text-[11px] tabular-nums text-faint">{e.count}</span>
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
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
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

  return (
    // header over (rail | column). §2's four destinations are the rail — the sidebar itself still
    // never collapses and never hides, and clicking one still replaces the centre pane and the
    // right panel with one full-width view while leaving this column exactly as it is, selection
    // included. What changes is that they cost forty pixels of width instead of a hundred pixels
    // of height plus a divider, and the column beside them belongs entirely to the list.
    //
    // THE SWITCHER SPANS BOTH, which is the one thing in this layout that is not free: it costs a
    // row the agent list would otherwise have. §2.1 asks for it "at the top of the sidebar, above
    // the four tab destinations", and above BOTH is the only reading that is true — the four
    // destinations are views of this workspace and the list beneath them is this workspace's
    // agents, so a switcher inside the column would be scoped by something it scopes.
    <div className="flex h-full flex-col bg-bg">
      <WorkspaceSwitcher />
      <div className="flex min-h-0 flex-1">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col border-l border-hair">
      {/* THE COLUMN'S HEADER ROW. `+ New Agent` was a full-width text button spending a whole row
          on two words for the one control that is unmistakably a plus. It sits here now beside the
          column's own name, which is where a creation affordance goes. */}
      <div className="flex shrink-0 items-center gap-1 px-3 pt-3">
        {/* THE FIELD IS A GLYPH UNTIL IT IS WANTED. It was a full row of its own beneath a full
            row of `New Agent`, permanently open, on a column whose entire job is to be a list —
            and a search box at rest is a control asking to be noticed for something nobody is
            doing yet. Open it and it takes the row; leave it empty and it gives the row back. */}
        {searching ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-control bg-active px-2 py-0.5">
            <span className="shrink-0 text-faint"><SearchIcon size={ICON.xs} /></span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => { if (!query) setSearching(false); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setQuery(""); setSearching(false); }
              }}
              placeholder="search agents…"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none focus-visible:shadow-focusring placeholder:text-faint"
            />
            {query && (
              <button
                onClick={() => { setQuery(""); setSearching(false); }}
                title="Clear"
                aria-label="Clear search"
                className="shrink-0 text-faint transition-colors hover:text-ink"
              >
                <XIcon size={ICON.xs} />
              </button>
            )}
          </div>
        ) : (
          <span className={TYPE.panelLabel}>Agents</span>
        )}
        {!searching && (
          <button
            onClick={() => setSearching(true)}
            title="Search agents — ⌘K opens the palette"
            aria-label="Search agents"
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-active active:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            <SearchIcon size={ICON.sm} />
          </button>
        )}
        <FilterMenu filter={filter} setFilter={setFilter} counts={counts} />
        <button
          onClick={() => selectAgent(null)}
          title="New agent"
          aria-label="New agent"
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
            activeAgentId === null ? "bg-active text-accent" : "text-muted hover:bg-active active:bg-chrome hover:text-ink"
          }`}
        >
          <PlusIcon size={ICON.sm} />
        </button>
      </div>



      {/* ONE SCROLLER, WITH THE SECTION HEADINGS PINNED TO IT.
          There were two: the agent list capped at `max-h-[38%]` with its own `overflow-auto`, and
          the runs list below it on `flex-1` with another. Two independently scrolling regions in
          one 280px column, which also meant two ten-pixel scrollbars stacked vertically inside it
          — and a 38% cap that decides how many agents you may see regardless of how many runs
          there are to look at.

          The section rule is one rule now, and it is stated once here rather than four times at
          four different offsets: a hairline sits ABOVE a section's label and never between a label
          and its own rows. `sticky` on the header is what makes a single scroller readable — the
          heading you are under stays where you can see it. */}
      {/* NO `scroll-fade` HERE, deliberately. A top fade and a sticky header are the same pixels
            arguing: the heading pins itself to the top edge and the mask then dims the thing it
            pinned. The sticky headers are the stronger cue in this column — they say what you are
            under as well as that there is more — so they win and the mask goes to the scrollers
            that have no headings. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* PINNED, above the rest of the list — §2's order for this column.
            Only when there is something pinned: an empty PINNED heading is the same noise as an
            empty section in the Threads view, and the same rule applies. Pinning is `P` on a
            selected thread, which pins that thread's AGENT — see uiStore's pins for why it is per
            person and not shared. */}
        {pinned.length > 0 && (
          <>
            <SectionHeader label="Pinned" count={pinned.length} first />
            {pinned.map((a) => <AgentRow key={`pinned-${a.agent_id}`} agent={a} />)}
          </>
        )}

        {pinned.length > 0 && <SectionHeader label="All agents" count={visible.length} />}
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

        {/* runs — how you re-open a past trace */}
        <SectionHeader label="Runs" count={runList.length} />
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
    </div>
  );
}

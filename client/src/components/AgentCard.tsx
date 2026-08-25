// §5's agent card. A glance, not a dashboard: every element below is one line or one badge.
//
// THE SEVEN STATES §5.3 ASKS TO BE BUILT AND LOOKED AT are all reachable from this one component,
// and none of them is a variant of it: never-run, working, failing, deployed, drifted,
// credential-missing and archived are the same card with different facts true of it. That is
// deliberate — a card that switched layout per state would have seven layouts to keep in step, and
// the states co-occur (an archived agent can be drifted; a failing one can be missing a credential).
//
// THE TWO DENSITIES ARE REAL LAYOUTS, NOT A SCALE TRANSFORM (§4). Compact drops the current-work
// subtitle line and shrinks the thumbnail; it does not shrink the type, because the type ladder is
// three sizes and a fourth one produced by `transform: scale` is a fourth size with no name.
//
// STRUCTURE IN HAIRLINES, NOT FILLS (§9). One border, one radius from the size ladder, one elevation
// — and the hover is `shadow-glow` rather than a fill change, because a card that answers the
// pointer by changing colour has spent a surface step to say something a border can say for free.
// The argument used to be narrower than that: on #0d0d0f a card could not get meaningfully darker
// and could only get brighter at its edge. The palette is light now and `shadow-glow` deepens the
// border instead of brightening it, which is the same treatment arriving from the other direction.

import { useState } from "react";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { AgentTagRow } from "./AgentTagRow.tsx";
import { AgentSparkline } from "./AgentSparkline.tsx";
import { ThumbnailMark, ArchiveIcon, ArchiveRestoreIcon, CopyIcon, DownloadIcon } from "./agentIcons.tsx";
import { AlertTriangleIcon, GitForkIcon, KebabIcon, PencilIcon, PlusIcon } from "./panelIcons.tsx";
import { agentContextMarkdown } from "../lib/agentContext.ts";
import { absTime, fmtCost, relTime } from "../lib/format.ts";
import { ICON, STATUS, TYPE } from "../lib/tokens.ts";
import { spendFor, useAgentGridStore } from "../store/agentGridStore.ts";
import type { AgentCardView } from "../types.ts";
import type { AgentDensity } from "../lib/agentFilter.ts";

/** §5.2's footer word, from the bucket the server already resolved. */
const ACTIVITY_LABEL = { quiet: "Quiet", steady: "Steady", high: "High" } as const;

/** §5.2's overflow menu: Fork · Rename · Export current version · Archive. */
function Overflow({
  agent,
  onFork,
  onRename,
  onExport,
  onArchive,
  onRestore,
}: {
  agent: AgentCardView;
  onFork: () => void;
  onRename: () => void;
  onExport: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const archived = agent.archived_at !== null;

  const item = (
    label: string,
    Icon: (p: { size?: number }) => React.ReactElement,
    onPick: () => void,
    danger = false,
  ) => (
    <button
      key={label}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        onPick();
      }}
      className={`flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-caption transition-colors duration-fast hover:bg-active active:bg-chrome ${
        danger ? "text-err hover:text-err" : "text-muted hover:text-ink"
      }`}
    >
      <Icon size={ICON.xs} />
      {label}
    </button>
  );

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        // §8: every icon-only control gets an accessible label and a tooltip. An icon nobody can name
        // is a worse button than a text button.
        title="More actions"
        aria-label={`More actions for ${agent.name}`}
        aria-expanded={open}
        className="rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active active:bg-chrome hover:text-ink"
      >
        <KebabIcon size={ICON.sm} />
      </button>
      {open && (
        <>
          {/* A full-screen catcher rather than a document listener: it closes on any click outside,
              including one that would otherwise open a different card, and it disappears with the
              menu rather than outliving it. */}
          <div className="fixed inset-0 z-30" aria-hidden onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-0 top-full z-30 mt-1 w-52 animate-slide-in rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none">
            {archived
              ? item("Restore", ArchiveRestoreIcon, onRestore)
              : [
                  item("Fork", GitForkIcon, onFork),
                  item("Rename", PencilIcon, onRename),
                  item("Export current version", DownloadIcon, onExport),
                  // ARCHIVE, AND THERE IS NO DELETE HERE. §5.2 lists both and this product has no
                  // delete path for an agent, deliberately: its versions, runs, traces and costs are
                  // the record every past comparison points at. The confirmation §7.5 asks for —
                  // naming the creator, as the collaborative-workspace safety net — is on this,
                  // because this is the destructive-looking act that actually exists.
                  item("Archive", ArchiveIcon, onArchive, true),
                ]}
          </div>
        </>
      )}
    </div>
  );
}

export interface AgentCardProps {
  agent: AgentCardView;
  density: AgentDensity;
  /** True while the keyboard cursor is on this card. §5.5: focus must be visible. */
  focused: boolean;
  /** Names, for §5.2's creator avatar. Team workspaces only — see `AgentGridSnapshot.team`. */
  creatorInitial: string | null;
  onOpen: () => void;
  onNewThread: () => void;
  onFork: () => void;
  onRename: () => void;
  onExport: () => void;
  onArchive: () => void;
  onRestore: () => void;
}

export function AgentCard({
  agent, density, focused, creatorInitial,
  onOpen, onNewThread, onFork, onRename, onExport, onArchive, onRestore,
}: AgentCardProps) {
  const liveSpend = useAgentGridStore((s) => s.liveSpend);
  const [copied, setCopied] = useState(false);
  const compact = density === "compact";
  const working = agent.runtime === "running" || agent.runtime === "generating" || agent.runtime === "deploying";
  const spend = spendFor(agent, liveSpend);

  const copyContext = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(agentContextMarkdown(agent));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // A clipboard that refuses is a browser permission, not a failure worth an error strip —
      // and the tick simply does not appear, which is the honest signal that nothing was copied.
    }
  };

  return (
    <div
      // A DIV WITH A ROLE RATHER THAN A BUTTON, because this card CONTAINS buttons — the sparkline's
      // twenty bars, the overflow menu, `+ New thread` — and a button inside a button is invalid HTML
      // that browsers resolve by dropping one of them.
      role="button"
      tabIndex={-1}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-agent-card={agent.slug}
      aria-label={agent.name}
      // THE HOVER IS A CLASS, NOT AN IMPERATIVE STYLE, and the difference is not tidiness. Writing
      // `element.style.boxShadow` from a pointer handler on an element whose `style` prop React also
      // owns means React wins on the next render — and §5.5's whole promise is that this grid
      // re-renders whenever a broadcast lands, so a hovered card lost its glow every time an
      // unrelated agent's run emitted a step. `shadow-glow` is the same token from `tailwind.config`
      // that `GLOW.hover` is in `tokens.ts`, so nothing about the appearance changes.
      className={`group flex cursor-pointer flex-col overflow-hidden rounded-card border bg-panel text-left transition-shadow duration-fast ${
        focused ? "border-edge shadow-glow" : "border-hair hover:border-edge hover:shadow-glow"
      } ${agent.archived_at ? "opacity-70" : ""}`}
    >
      <div className={`flex min-w-0 flex-1 flex-col ${compact ? "gap-1.5 p-2.5" : "gap-2 p-3"}`}>
        {/* Title, slug, and the actions that belong to the card rather than to the grid. */}
        <div className="flex min-w-0 items-start gap-2">
          {/* THE MARK, IN THE TITLE ROW. It used to sit centred on a 104px full-bleed generated
              gradient at the head of every card — about forty percent of the card's height, in
              full colour, carrying no information: three cards on screen meant three landscape
              gradients and three copies of the same centred logo. A palette whose rule is that
              colour means something cannot spend its largest area on art.

              The mark itself is worth keeping. It says "this is an agent" in one glyph, and at
              16px in the title row it does that without being the thing you look at first. */}
          <span
            className={`mt-px shrink-0 text-faint ${working ? "animate-stream-pulse motion-reduce:animate-none" : ""}`}
            aria-hidden
          >
            <ThumbnailMark size={ICON.md} />
          </span>
          <div className="min-w-0 flex-1">
            <Truncate className={TYPE.title} title={agent.name}>
              {agent.name}
            </Truncate>
            {/* The slug at the smaller size — §5.2. It was also in the mono face, on the argument
                that it is an identifier and the prose/code split tells a reader which of the two
                lines they can type. typography.pdf §04 names "agent IDs/slugs" in its Sans list
                explicitly, so what separates the two lines now is size and colour, which is what
                §03 says hierarchy is supposed to come from anyway. */}
            <Truncate className="mt-0.5 text-tiny text-faint" title={agent.slug}>
              {agent.slug}
            </Truncate>
          </div>
          {/* §5.2's primary action, ON THE CARD, and now a glyph beside the other two rather than
              a full-width outlined button under everything. Absent for an archived agent, which §4
              requires: an agent that has been put away should not be offering work.

              A full-width button per card is the heaviest per-item affordance there is, and the
              grid renders three across — so three cards meant three outlined bars of equal weight
              competing with the three agent names above them. */}
          {!agent.archived_at && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNewThread();
              }}
              title={`Start a new thread on ${agent.name}`}
              aria-label={`Start a new thread on ${agent.name}`}
              className="shrink-0 rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active active:bg-chrome hover:text-ink"
            >
              <PlusIcon size={ICON.sm} />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void copyContext();
            }}
            title={copied ? "Copied" : "Copy this agent's context as markdown"}
            aria-label={`Copy ${agent.name}'s context`}
            className="shrink-0 rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active active:bg-chrome hover:text-ink"
          >
            <CopyIcon size={ICON.sm} />
          </button>
          <Overflow
            agent={agent}
            onFork={onFork}
            onRename={onRename}
            onExport={onExport}
            onArchive={onArchive}
            onRestore={onRestore}
          />
        </div>

        {/* §5.4's tag row, beside the title, because these are properties of the AGENT. */}
        <AgentTagRow agent={agent} />

        {/* §5.2's current work. Dropped entirely at compact density — that is what makes the two
            densities different layouts rather than one at two scales. */}
        {!compact && (
          <div className="min-w-0">
            {agent.latest_thread ? (
              <>
                <Truncate className="text-caption text-ink" title={agent.latest_thread.title}>
                  {agent.latest_thread.title}
                </Truncate>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  {agent.latest_thread.last_turn ? (
                    <Truncate className="min-w-0 flex-1 text-tiny text-muted" title={agent.latest_thread.last_turn}>
                      {agent.latest_thread.last_turn}
                    </Truncate>
                  ) : (
                    <span className="flex-1 text-tiny text-faint">Nothing said in it yet</span>
                  )}
                  <Chip size="sm" mono tone="faint" className="shrink-0" title="The model this agent runs on">
                    {agent.default_provider}
                  </Chip>
                </div>
              </>
            ) : (
              // NOTHING IS FABRICATED. §5.2: "If the agent has no threads, the line reads 'Not
              // started yet'." No invented summary, no placeholder title.
              <div className="text-caption text-faint">Not started yet</div>
            )}
          </div>
        )}

        {/* §5.2's warning line — "the single most important line on the card". Names only, and rose
            rather than amber, because amber means running and a warning must never wear it. */}
        {agent.missing_env.length > 0 && (
          <div
            className="flex min-w-0 items-center gap-1.5 text-tiny"
            style={{ color: STATUS.error }}
            title={`No credential is configured for ${agent.missing_env.join(", ")}`}
          >
            {/* A REAL GLYPH ON THE LINE THIS CARD CALLS ITS MOST IMPORTANT. It was the font
                character ⚠, which inherits the text weight rather than ICON.strokeWidth — the
                one mark on the card that was not drawn by the icon system. */}
            <span className="shrink-0" aria-hidden><AlertTriangleIcon size={ICON.badge} /></span>
            <Truncate className="min-w-0">
              {agent.missing_env.length === 1
                ? `1 credential missing — ${agent.missing_env[0]}`
                : `${agent.missing_env.length} credentials missing — ${agent.missing_env.join(", ")}`}
            </Truncate>
          </div>
        )}

        {/* §5.5's clickable sparkline, and the deploy dot beside it. */}
        <div className="flex min-w-0 items-center gap-2">
          <AgentSparkline outcomes={agent.outcomes} max={compact ? 12 : 20} height={compact ? 10 : 12} />
          {agent.deployment?.status === "live" && (
            <span
              className="ml-auto flex shrink-0 items-center gap-1 text-tiny"
              style={{ color: agent.drift ? STATUS.error : STATUS.ok }}
              title={
                agent.drift
                  ? `Deployed from v${agent.drift.deployed}; this agent is now at v${agent.drift.current}`
                  : agent.deployment.url ?? "Serving on a public URL"
              }
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} aria-hidden />
              {agent.drift ? `v${agent.drift.deployed} → v${agent.drift.current}` : "live"}
            </span>
          )}
        </div>

        {/* §5.2's footer, and the one action the card owns. `mt-auto` so a card with a short
            current-work line still puts its footer on the bottom edge — a grid whose footers sit at
            different heights reads as misaligned rather than as varied. */}
        <div className="mt-auto flex min-w-0 items-center gap-2 border-t border-hair pt-2 text-tiny text-faint">
          <span className="tabular-nums" title={`${agent.thread_count} open thread${agent.thread_count === 1 ? "" : "s"}`}>
            {agent.thread_count} thread{agent.thread_count === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <span title={`${agent.runs_7d} run${agent.runs_7d === 1 ? "" : "s"} in the last 7 days`}>
            {ACTIVITY_LABEL[agent.activity]}
          </span>
          {/* THE FIGURE ONLY WHEN THERE IS ONE. Null is "nothing spent", never `$0` — the same rule
              `creation_cost` follows, and `spend_known: false` renders the floor with a `+`. */}
          {spend !== null && (
            <>
              <span aria-hidden>·</span>
              <span
                className="tabular-nums"
                title={agent.spend_known ? "Spend over the last 7 days" : "A floor — something here ran on an unpriced model"}
              >
                {fmtCost(spend)}
                {!agent.spend_known && "+"}
              </span>
            </>
          )}
          {agent.last_run_at && (
            <>
              <span aria-hidden>·</span>
              <span title={absTime(agent.last_run_at)}>{relTime(agent.last_run_at)}</span>
            </>
          )}
          {/* Team workspaces only. In a personal one this is a picture of the only person who could
              have made it, which is a pixel spent saying nothing. */}
          {creatorInitial && (
            <span
              // THE ACCOUNT ROW'S TREATMENT. This was a 16px circle with a 9px muted initial
              // against the sidebar's 20px rounded square with an 11px ink one — two
              // initial-avatars in one app at two shapes, two sizes and two ink levels. And it
              // was `aria-hidden` while carrying a `title`, so the tooltip sat on an element
              // removed from the accessibility tree and reached nobody.
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-control bg-active text-tiny text-ink"
              title="Who created this agent"
              role="img"
              aria-label="Who created this agent"
            >
              {creatorInitial}
            </span>
          )}
        </div>

      </div>
    </div>
  );
}

// The full-screen Activity tab (§1–§10): a metric dashboard, and deliberately not a fifth list.
//
// FOUR TABS, FOUR GENUINELY DIFFERENT LAYOUTS. Threads is rows, Agents is a card grid, the Inbox is a
// severity board, and this is a grid of cards each led by one large figure. That is the core design
// decision of the surface and the reason it is worth being a fourth destination rather than a filter
// on one of the other three — §1 says it in one line: "Do not build a fifth list of rows."
//
// THE ONE RULE THAT KEEPS IT HONEST, AND IT IS ENFORCED BY WHAT IS ABSENT. Nothing here is
// clickable-to-change. There are no actions, no dismissals, no resolves, no retries and no toggles
// that mutate anything: clicking navigates, hovering highlights, and that is the entire interaction
// vocabulary. The channel has no mutating command to call even if a component wanted one — see
// `wsRelay`'s note on the absent `ACTIVITY_COMMANDS`.
//
// NUMBERS ARE THE HERO AND CHARTS ARE NOT (§3.2). Every card leads with one large figure in the mono
// face at tabular width, with a muted context line beneath it that names its own window. Sparklines
// sit in the card BACKGROUND. A dashboard where charts dominate is a dashboard nobody reads.
//
// NO SPINNERS (§3.6). Skeletons render at each card's final dimensions so nothing shifts when data
// lands, and cards fill independently — the store carries a `loaded` per module rather than one for
// the page, because a slow leaderboard must not hold up the hero row. `stream-pulse`, never
// `animate-pulse`: fading a live element to 50% reads as disabled.

import { useEffect } from "react";

import { RANGE_LABEL, readRange, writeRange, type ActivityRange } from "../lib/activityRange.ts";
import { ACTIVITY_RANGES } from "../lib/activityRange.ts";
import { sendGetActivity } from "../lib/socket.ts";
import { ICON, RADIUS, TYPE } from "../lib/tokens.ts";
import { useActivityStore } from "../store/activityStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { Truncate } from "./Truncate.tsx";
import { RangeIcon } from "./activityIcons.tsx";

/**
 * §1's greeting: the time of day, by the clock on the machine reading it.
 *
 * THE CLIENT'S CLOCK AND NOT THE SERVER'S, which is the one place on this tab where that is right.
 * Every figure here is computed against one window on the server precisely so that two people see
 * the same numbers; a greeting is the opposite — it is about the person reading, and "Good evening"
 * at their nine in the morning because the gateway is in another timezone is the sort of small wrong
 * thing that makes somebody distrust the large right ones underneath it.
 */
function greeting(at: Date): string {
  const h = at.getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * §1's header: who, where, what scope, and the one control that drives everything below it.
 *
 * THE RANGE CONTROL IS THE ONLY CONTROL ON THIS PAGE, which is why it sits in the header rather than
 * on a card. There is no per-card range: "Every figure on the screen describes the same window,
 * always." Putting it anywhere else would invite a second one.
 */
function Header() {
  const range = useActivityStore((s) => s.range);
  const setRange = useActivityStore((s) => s.setRange);
  const summary = useActivityStore((s) => s.summary);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const user = useSessionStore((s) => s.user);
  const workspaces = useSessionStore((s) => s.workspaces);

  // The workspace's own name comes from the summary once it lands, and from the session list before
  // that — so the header is never blank while the first answer is in flight. Two sources for one
  // string is acceptable here and nowhere else on this page: it is a LABEL, not a figure, and a
  // label that appears a beat late is the thing §3.6's skeletons exist to avoid.
  const name = summary?.workspace?.name ?? workspaces.find((w) => w.id === workspaceId)?.name ?? "";
  const team = summary?.workspace?.kind === "team";
  const members = summary?.workspace?.members ?? 0;

  const choose = (next: ActivityRange): void => {
    if (next === range) return;
    // Custom needs two dates and there is no picker on this pass — see the note in `RANGE_LABEL`.
    // Selecting it without ends would put the control in a state whose own value is missing, so it
    // is offered only when a custom range is already remembered for this workspace.
    if (next === "custom") return;
    setRange(next, null);
    writeRange(workspaceId, next, null);
  };

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-hair px-5 py-3">
      {/* A TITLE AND A BREADCRUMB, the same two lines the top bar carries.
          It was a 15px greeting on one line, a workspace name beside it, and a bordered scope chip
          on a line of its own — three levels of chrome, and the largest and least actionable text
          in the app sitting above a page whose entire content is figures. The greeting stays,
          because a page that opens with your name is not a fault, but it stays at the size
          everything else in this product's chrome is. */}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">
          {greeting(new Date())}
          {user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}
        </div>
        {/* §1's scope. A member COUNT and never a list — the member list has its own channel with
            its own capability behind it, and a second copy here would be a second place to leak
            it. As a breadcrumb rather than a bordered chip: it says where you are, and where you
            are is not something to press. */}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-faint">
          {name && <Truncate className="min-w-0 max-w-[220px]" title={name}>{name}</Truncate>}
          {name && <span aria-hidden>·</span>}
          <span className="shrink-0">{team ? "team" : "personal"}</span>
          {team && members > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">
                {members} member{members === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>
      </div>

      {/* THE GLOBAL RANGE. Text survives here because §4 names the range control as one of the five
          places a label carries irreplaceable meaning — `24h` is shorter and clearer than any glyph
          for it. The calendar marks the control; the values are words. */}
      <div
        className="flex items-center gap-1 rounded-control border border-hair p-0.5"
        role="group"
        aria-label="Date range"
      >
        <span className="pl-1.5 pr-0.5 text-faint" aria-hidden>
          <RangeIcon size={ICON.xs} />
        </span>
        {ACTIVITY_RANGES.filter((r) => r !== "custom" || range === "custom").map((r) => (
          <button
            key={r}
            onClick={() => choose(r)}
            aria-pressed={r === range}
            title={`Show ${RANGE_LABEL[r]}`}
            className={`rounded-chip px-2 py-1 text-[11px] tabular-nums transition-colors duration-fast ${
              r === range ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {RANGE_LABEL[r]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A card's skeleton, at the card's FINAL dimensions.
 *
 * §3.6: "Skeletons render at each card's final dimensions, so nothing shifts when data lands." That
 * is why this takes a height rather than filling its container: a skeleton that grows into the real
 * card's size is a layout shift with a nicer name, and on a page of nine cards it is nine of them.
 *
 * `stream-pulse`, NEVER `animate-pulse`. Tailwind's fades to 50% opacity, which on text reads as
 * disabled rather than as loading; this one holds most of its opacity and moves slowly, which is
 * what the rest of this app already uses to say "alive".
 */
export function CardSkeleton({ height, label }: { height: number; label: string }) {
  return (
    <div
      className="animate-stream-pulse rounded-card border border-hair bg-panel/40 motion-reduce:animate-none"
      style={{ height, borderRadius: RADIUS.card }}
      aria-busy
      aria-label={`${label} loading`}
    />
  );
}

/**
 * The shell: header, then the grid §3.1 lays out, in the order it lays it out.
 *
 * THREE RHYTHMS, ONE GRID, USED IN SEQUENCE — a three-up hero row, a wide band, then pairs. It is a
 * twelve-column grid rather than three separate flex rows because the hero row's 2/3 + 1/3 split and
 * the pairs below it have to agree on where the gutter is; three independent rows would line up on
 * a wide screen and drift apart on a narrow one.
 *
 * NARROW WIDTHS ARE ONE COLUMN WITH ONE EXCEPTION (§3.8): the hero row stays three-across, just
 * compact, because three numbers fit on a phone. That is why the hero's own children are a
 * `grid-cols-3` that never collapses while everything around them does.
 */
export function ActivityView({ children }: { children?: React.ReactNode }) {
  const range = useActivityStore((s) => s.range);
  const custom = useActivityStore((s) => s.custom);
  const error = useActivityStore((s) => s.error);
  const setRange = useActivityStore((s) => s.setRange);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const connected = useTraceStore((s) => s.connection === "open");

  // THE REMEMBERED RANGE, READ WHEN THE WORKSPACE IS KNOWN. Not at module scope: `localStorage` is
  // keyed by workspace and the workspace arrives with the session, so a read at import time would
  // always miss and always fall back to the default.
  useEffect(() => {
    if (!workspaceId) return;
    const stored = readRange(workspaceId);
    if (stored.range !== range || stored.custom?.from !== custom?.from) {
      setRange(stored.range, stored.custom);
    }
    // DELIBERATELY KEYED ON THE WORKSPACE ALONE, and the omission is the point rather than an
    // oversight: re-running when the range changes would read storage back and undo the change
    // somebody had just made. This repository has no lint toolchain to argue with about it, so the
    // reason is written here instead.
  }, [workspaceId]);

  // ONE ASK PER (WORKSPACE, RANGE, CONNECTION). The socket is in the dependency list because a
  // reconnect leaves this tab holding figures from before the drop with no way to know they are
  // stale — the same reason `App` re-fires `sendLoadAgentFiles` on reconnect.
  useEffect(() => {
    if (!connected) return;
    sendGetActivity();
  }, [connected, range, custom?.from, custom?.to]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <Header />
      {error && (
        <div className="shrink-0 border-b border-err/30 bg-err/10 px-5 py-2 text-[11px] text-err">
          {error}
        </div>
      )}
      {/* The one scroll container. Cards never scroll individually except the feed, which owns its
          own viewport because it is virtualised. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * A card: a hairline, a title, and whatever leads it.
 *
 * STRUCTURE IS HAIRLINES, NEVER BACKGROUND FILLS (§3.2), which is the rule this component exists to
 * apply once rather than nine times. Content nests three levels — card → section → well — and the
 * radius is chosen by box size from `RADIUS`, not by what the component is called.
 */
export function Card({
  title,
  icon: Icon,
  context,
  freshness,
  className = "",
  children,
}: {
  title: string;
  icon?: (p: { size?: number }) => React.ReactElement;
  /** The muted line under the figure. §1: it names its own window, so a screenshot is unambiguous. */
  context?: React.ReactNode;
  /** §5.3's quiet "as of" line. Rendered only when the figure is genuinely behind. */
  freshness?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-card border border-hair bg-panel/30 px-4 py-3 ${className}`}
      style={{ borderRadius: RADIUS.card }}
    >
      <div className="flex items-center gap-1.5">
        {Icon && (
          <span className="text-faint" aria-hidden>
            <Icon size={ICON.xs} />
          </span>
        )}
        <h2 className={TYPE.panelLabel}>{title}</h2>
        {freshness && <span className="ml-auto text-[10px] text-faint">{freshness}</span>}
      </div>
      {children}
      {context && <div className="mt-1 text-[11px] text-muted">{context}</div>}
    </section>
  );
}

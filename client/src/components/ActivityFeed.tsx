// §5's unified event feed: the union, chronological, filterable, scrollable, virtualised.
//
// THE FOURTH LENS ON §3.4'S ONE DATASET. Hovering a leaderboard row dims every feed row that is not
// that agent's; hovering a Model Mix segment dims every row whose agent did not run that model.
// Nothing is fetched when it happens — the rows already carry their agent, and the leaderboard
// already carries each agent's models, which is why those fields are on the wire at all.
//
// ROWS NAVIGATE AND NOTHING ACTS (§5). A run row opens its trace, a deploy row opens that agent's
// Deploy panel, an edit row opens the version. There is no action on any row, and the channel has no
// command that could change anything if one were added.
//
// `ActionRow` IS REUSED RATHER THAN IMITATED, which §5 asks for by name: the feed "is exactly the
// shared narrative line of icon, verb, object and trailing figures". The verbs come from
// `lib/actionIcons.tsx` so a feed row reads "Called send_message" in the same voice the trace two
// panels over already uses — same icon, same word, same accent.
//
// VIRTUALISED WITH NO DEPENDENCY. The arithmetic is in `lib/feedWindow.ts` with a suite that drives
// it at ten thousand rows; what is here is the scroll container, the spacer and the slice.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FEED_KINDS, actionForFeedKind, type FeedKind } from "../lib/actionIcons.tsx";
import { RANGE_PROSE } from "../lib/activityRange.ts";
import { EMPTY_FIGURE } from "../lib/activityMetrics.ts";
import { FEED_ROW_HEIGHT, feedWindow, shouldFetchMore } from "../lib/feedWindow.ts";
import { absTime, relTime } from "../lib/format.ts";
import { selectAgent, selectRun } from "../lib/selection.ts";
import { sendGetActivityFeed, sendLoadRun } from "../lib/socket.ts";
import { ICON, STATUS } from "../lib/tokens.ts";
import { dimmedBy, useActivityStore } from "../store/activityStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ActionRow } from "./ActionRow.tsx";
import { Card } from "./ActivityView.tsx";
import { Truncate } from "./Truncate.tsx";
import { FunnelIcon } from "./activityIcons.tsx";

/** The feed's own viewport. Taller than the cards beside it, because it is the one thing scrolled. */
const FEED_HEIGHT = 236;

/** The same viewport on a narrow screen, where §3.8 gives the feed more room. */
const FEED_HEIGHT_NARROW = 340;

export function EventFeedCard() {
  const rows = useActivityStore((s) => s.feed);
  const loaded = useActivityStore((s) => s.feedLoaded);
  const loading = useActivityStore((s) => s.feedLoading);
  const next = useActivityStore((s) => s.feedNext);
  const hover = useActivityStore((s) => s.hover);
  const setHover = useActivityStore((s) => s.setHover);
  const range = useActivityStore((s) => s.range);
  const closeNav = useUiStore((s) => s.closeNav);
  const needsLoad = useTraceStore((s) => s.needsLoad);

  // §5's filter, per session and local — the same decision the Inbox's rail makes, and for the same
  // reason: it is a way of looking at this list right now, not a preference about the workspace.
  const [kinds, setKinds] = useState<Set<FeedKind>>(new Set());
  const [showFilters, setShowFilters] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  // §3.8: the feed keeps its virtualisation and gets a taller viewport on a narrow screen. Measured
  // rather than assumed, because the panel it lives in is resizable and a media query would not see
  // the drag.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") {
      if (el) setViewport(el.clientHeight);
      return;
    }
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // FILTERING IS LOCAL FOR THE KINDS ALREADY IN HAND AND A RE-ASK FOR THE REST. Narrowing what is
  // rendered is instant; the SERVER filter is what makes a narrow kind reach further back than the
  // page boundary, which is why changing it resets the scroll and asks again. Both are needed: a
  // purely local filter over one page shows four deploys and calls it the month's deploys.
  const visible = useMemo(
    () => (kinds.size === 0 ? rows : rows.filter((r) => kinds.has(r.kind))),
    [rows, kinds],
  );

  const win = feedWindow(visible.length, scrollTop, viewport);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    if (shouldFetchMore(win, visible.length, next !== null, loading)) {
      sendGetActivityFeed(kinds.size ? { kinds: [...kinds] } : undefined);
    }
  }, [win.end, visible.length, next, loading, kinds]);

  const toggleKind = (kind: FeedKind): void => {
    const nextKinds = new Set(kinds);
    if (nextKinds.has(kind)) nextKinds.delete(kind);
    else nextKinds.add(kind);
    setKinds(nextKinds);
    // The scroll position belongs to the old list. Keeping it would land the reader in the middle of
    // a shorter list at an offset that means nothing.
    scroller.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  };

  return (
    <Card
      title="Event feed"
      icon={FunnelIcon}
      context={visible.length > 0 ? `everything that happened, ${RANGE_PROSE[range]}` : undefined}
      freshness={
        // §4: an icon-only control with an accessible label and a tooltip. "An icon nobody can name
        // is worse than a text button."
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`rounded-chip p-0.5 transition-colors duration-fast ${
            kinds.size > 0 ? "text-ink" : "text-faint hover:text-muted"
          }`}
          title={kinds.size > 0 ? `Filtered to ${[...kinds].join(", ")}` : "Filter by kind"}
          aria-label="Filter the feed by kind"
          aria-expanded={showFilters}
        >
          <FunnelIcon size={ICON.xs} />
        </button>
      }
    >
      {showFilters && (
        <div className="mt-2 flex flex-wrap gap-1 border-b border-hair pb-2">
          {FEED_KINDS.map((k) => {
            const action = actionForFeedKind(k);
            const on = kinds.has(k);
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                aria-pressed={on}
                title={`${on ? "Stop showing only" : "Show only"} ${action.verb.toLowerCase()}`}
                className={`flex items-center gap-1 rounded-chip px-1.5 py-0.5 text-[10px] transition-colors duration-fast ${
                  on ? "bg-active text-ink" : "text-faint hover:text-muted"
                }`}
              >
                <span style={{ color: on ? action.accent : undefined }} aria-hidden>
                  <action.Icon size={ICON.badge} />
                </span>
                {action.verb}
              </button>
            );
          })}
        </div>
      )}

      {!loaded ? (
        // §3.6's skeleton, at the viewport's final height so nothing shifts when the page lands.
        <div
          className="mt-2 animate-stream-pulse rounded-control bg-hair/40 motion-reduce:animate-none"
          style={{ height: FEED_HEIGHT }}
          aria-busy
          aria-label="Event feed loading"
        />
      ) : visible.length === 0 ? (
        <div className="flex h-[64px] items-center gap-2 text-[12px] text-muted">
          <span className="font-mono text-[15px] text-faint">{EMPTY_FIGURE}</span>
          {kinds.size > 0 ? "nothing of that kind in this range" : `nothing happened in ${RANGE_PROSE[range]}`}
        </div>
      ) : (
        <div
          ref={scroller}
          onScroll={onScroll}
          className="mt-2 overflow-y-auto"
          style={{ height: FEED_HEIGHT, maxHeight: FEED_HEIGHT_NARROW }}
        >
          {/* The spacer is the FULL list's height, so the scrollbar is the size of the whole feed
              rather than of the slice currently rendered. */}
          <div style={{ height: win.totalHeight, position: "relative" }}>
            <div style={{ position: "absolute", top: win.offsetTop, left: 0, right: 0 }}>
              {visible.slice(win.start, win.end).map((r) => {
                const action = actionForFeedKind(r.kind);
                const dim = dimmedBy(hover, { agentId: r.agent_id });
                return (
                  <div
                    key={r.id}
                    style={{ height: FEED_ROW_HEIGHT }}
                    className={`flex items-center transition-opacity motion-reduce:transition-none ${
                      dim ? "opacity-30" : "opacity-100"
                    }`}
                    onMouseEnter={() => r.agent_id && setHover({ kind: "agent", id: r.agent_id })}
                    onMouseLeave={() => setHover(null)}
                  >
                    <ActionRow
                      className="w-full px-1 py-1"
                      action={action}
                      state={r.outcome === "error" ? "error" : r.outcome === "refused" ? "pending" : "done"}
                      object={
                        <Truncate className="inline-block max-w-[16ch] align-bottom font-mono text-[11px] text-ink" title={r.object ?? ""}>
                          {r.object ?? r.agent_id ?? ""}
                        </Truncate>
                      }
                      detail={
                        <span className="text-[11px]">
                          {r.agent_id && r.object !== r.agent_id ? r.agent_id : ""}
                          {r.num !== null && r.kind === "version" ? ` v${r.num}` : ""}
                          {r.outcome === "refused" && <span style={{ color: STATUS.error }}> refused</span>}
                        </span>
                      }
                      trailing={<span className="text-faint" title={absTime(r.at)}>{relTime(r.at)}</span>}
                      title={navigationHint(r.target_type)}
                      onClick={() => open(r, needsLoad, closeNav)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {loading && (
            <div className="py-1 text-center text-[10px] text-faint">loading more…</div>
          )}
        </div>
      )}
    </Card>
  );
}

/** What clicking a row does, per §5's list. Navigation only — never an action. */
function navigationHint(target: string): string {
  if (target === "run" || target === "step") return "Open the trace";
  if (target === "deploy") return "Open the agent's Deploy panel";
  if (target === "version") return "Open the version";
  if (target === "eval") return "Open the agent's Evals panel";
  return "";
}

/**
 * §5's navigation.
 *
 * EVERY DESTINATION IS SOMEWHERE THAT ALREADY EXISTS, which is §1's non-redundancy rule in the click
 * handler: the trace, the Deploy panel, the version browser. This tab shows nothing per-agent
 * itself, so every row's job is to hand somebody off to the surface that does.
 */
function open(
  row: { target_type: string; target_id: string; agent_id: string | null },
  needsLoad: (runId: string) => boolean,
  closeNav: () => void,
): void {
  if (row.target_type === "run" || row.target_type === "step") {
    // `loadRun` is the one path into a trace from any surface, which is also what resolves the
    // Inbox's `unreviewed_failures` card — see the relay's `onTraceOpened`.
    const runId = row.target_id;
    if (row.target_type === "run") {
      if (needsLoad(runId)) sendLoadRun(runId);
      selectRun(runId);
      closeNav();
    }
    return;
  }
  if (row.agent_id) {
    selectAgent(row.agent_id);
    closeNav();
  }
}

// §6–§9's four cards: the leaderboard, the model mix, the release timeline and the tool rollup.
//
// THE LEADERBOARD IS A TABLE AND THE OTHER THREE ARE NOT, which is the point of having four of them.
// §7 is explicit about why a table has to exist at all: "The Agents tab shows cards, and cards
// cannot be ranked against each other. This is the surface that answers which agent is expensive and
// which agent is flaky — the two questions a card grid structurally cannot."
//
// EVERY ROW NAVIGATES AND NOTHING ACTS (§1). A leaderboard row opens that agent's detail, a release
// row opens its deploy, a tool row opens nothing at all because a tool is not a place. There is no
// button anywhere in this file that changes state, and the channel has no command one could call.
//
// SORTING IS LOCAL AND HAS NO ROUND TRIP. §7 asks for "sortable by any column", and the whole
// leaderboard is already in hand — asking the server to re-sort would be a request that returns the
// same rows in a different order, and would make a click on a column header feel like a page load.

import { useMemo, useState } from "react";

import { EMPTY_FIGURE, formatMetric } from "../lib/activityMetrics.ts";
import { RANGE_PROSE } from "../lib/activityRange.ts";
import { actionForFeedKind } from "../lib/actionIcons.tsx";
import { absTime, relTime } from "../lib/format.ts";
import { selectAgent } from "../lib/selection.ts";
import { ICON, MOTION, STATUS, TEXT } from "../lib/tokens.ts";
import { dimmedBy, useActivityStore } from "../store/activityStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { Card, CardSkeleton } from "./ActivityView.tsx";
import { FreshnessNote } from "./ActivityFigures.tsx";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { McpBadge } from "./McpBadge.tsx";
import {
  ExpandIcon, LeaderboardIcon, MixIcon, ReleaseTagIcon, ShareIcon,
} from "./activityIcons.tsx";
import { ShieldCheckIcon, SparklesIcon, WrenchIcon } from "./panelIcons.tsx";

const CARD_HEIGHT = 300;

/**
 * §3.4's de-emphasis, as one class.
 *
 * "HIGHLIGHT IS A DE-EMPHASIS OF EVERYTHING ELSE, NOT A COLOUR CHANGE ON THE TARGET, so it stays
 * legible in a palette this restrained." Opacity is the only channel available: this app spends
 * colour on status and nothing else, so brightening a target would either invent a hue or borrow one
 * that already means something.
 *
 * `motion-reduce` DROPS THE TRANSITION AND KEEPS THE HIGHLIGHT. §3.4: "Disable it under
 * prefers-reduced-motion only if you animate the transition; the highlight itself should still
 * work." The distinction matters — somebody who asked for less movement still needs the dashboard to
 * answer which rows use a model.
 */
const dimClass = (dim: boolean): string =>
  `transition-opacity motion-reduce:transition-none ${dim ? "opacity-30" : "opacity-100"}`;

// --- §7: the agent leaderboard ------------------------------------------------------------------

type SortKey = "usd" | "runs" | "successRate" | "p95" | "lastActive" | "name";

/** Which direction each column is most useful in FIRST. */
const SORT_DESC: Record<SortKey, boolean> = {
  usd: true,
  runs: true,
  // A rate sorts ASCENDING first, because the question is "which agent is flaky" and the answer is
  // at the bottom of a descending sort. A column whose first click shows the least interesting end
  // is a column people click twice every time.
  successRate: false,
  p95: true,
  lastActive: true,
  name: false,
};

export function LeaderboardCard() {
  const rows = useActivityStore((s) => s.leaderboard);
  const fresh = useActivityStore((s) => s.leaderboardFresh);
  const truncated = useActivityStore((s) => s.leaderboardTruncated);
  const hover = useActivityStore((s) => s.hover);
  const setHover = useActivityStore((s) => s.setHover);
  const range = useActivityStore((s) => s.range);
  const closeNav = useUiStore((s) => s.closeNav);
  const [sort, setSort] = useState<SortKey>("usd");
  const [desc, setDesc] = useState(true);

  const sorted = useMemo(() => {
    const pick = (r: (typeof rows)[number]): number | string => {
      switch (sort) {
        case "usd": return r.usd;
        case "runs": return r.runs;
        // NULL SORTS LAST IN BOTH DIRECTIONS, which is why it is mapped to an extreme rather than to
        // zero. An agent whose runs have not settled has no rate; putting it at 0% would make it
        // look like the worst agent in the workspace, which is the exact false-zero §3.5 forbids.
        case "successRate": return r.success_rate ?? (desc ? -1 : 2);
        case "p95": return r.p95 ?? (desc ? -1 : Number.MAX_SAFE_INTEGER);
        case "lastActive": return r.last_active ?? "";
        case "name": return r.name.toLowerCase();
      }
    };
    return [...rows].sort((a, b) => {
      const x = pick(a);
      const y = pick(b);
      const cmp = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return desc ? -cmp : cmp;
    });
  }, [rows, sort, desc]);

  if (!fresh) return <CardSkeleton height={CARD_HEIGHT} label="Agent leaderboard" />;

  const header = (key: SortKey, label: string, align = "text-right") => (
    <button
      onClick={() => {
        if (key === sort) setDesc(!desc);
        else { setSort(key); setDesc(SORT_DESC[key]); }
      }}
      className={`${align} w-full text-[10px] uppercase tracking-wider transition-colors duration-fast ${
        key === sort ? "text-muted" : "text-faint hover:text-muted"
      }`}
      title={`Sort by ${label.toLowerCase()}`}
      aria-sort={key === sort ? (desc ? "descending" : "ascending") : "none"}
    >
      {label}
      {/* §4: the sort affordance is a mark, not a word. It appears only on the active column, since
          an arrow on every header says nothing about which one is sorted. */}
      {key === sort && <span aria-hidden> {desc ? "↓" : "↑"}</span>}
    </button>
  );

  return (
    <Card title="Agent leaderboard" icon={LeaderboardIcon} freshness={<FreshnessNote fresh={fresh} />}>
      {rows.length === 0 ? (
        <Empty>no agent ran in {RANGE_PROSE[range]}</Empty>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse">
            <thead>
              <tr className="border-b border-hair">
                <th className="pb-1 text-left">{header("name", "Agent", "text-left")}</th>
                <th className="pb-1">{header("runs", "Runs")}</th>
                <th className="pb-1">{header("successRate", "Success")}</th>
                <th className="pb-1">{header("usd", "Spend")}</th>
                <th className="pb-1">{header("p95", "p95")}</th>
                <th className="pb-1">{header("lastActive", "Last")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.agent_id}
                  // §3.4's HOVER SUBJECT. Set here and read by every other module; nothing is
                  // fetched and nothing changes.
                  onMouseEnter={() => setHover({ kind: "agent", id: r.agent_id })}
                  onMouseLeave={() => setHover(null)}
                  // §1: clicking NAVIGATES. This is the agent's own detail view, which is where
                  // everything per-agent already lives.
                  onClick={() => { selectAgent(r.agent_id); closeNav(); }}
                  className={`cursor-pointer border-b border-hair/50 hover:bg-active/40 ${dimClass(
                    dimmedBy(hover, { agentId: r.agent_id, models: r.models }),
                  )}`}
                  style={{ transitionDuration: `${MOTION.fast}ms` }}
                  title={`Open ${r.name}`}
                >
                  <td className="max-w-0 py-1.5 pr-2">
                    <div className="flex items-center gap-1.5">
                      <Truncate className="text-[12px] text-ink" title={r.name}>{r.name}</Truncate>
                      {/* An archived agent still spent money last week, so it stays in the table —
                          and says what it is, so nobody wonders why it is not in the Agents grid. */}
                      {r.archived && <Chip size="sm" tone="faint" variant="bare">archived</Chip>}
                    </div>
                  </td>
                  <td className="py-1.5 text-right font-mono text-[11px] tabular-nums text-muted">{r.runs}</td>
                  <td className="py-1.5 text-right font-mono text-[11px] tabular-nums">
                    <span style={{ color: rateHue(r.success_rate) }}>{formatMetric("percent", r.success_rate)}</span>
                  </td>
                  <td
                    className="py-1.5 text-right font-mono text-[11px] tabular-nums text-muted"
                    // §2: a row whose spend is a floor says so, and never renders a confident number.
                    title={r.cost_known ? undefined : "a floor — this agent ran a model with no pricing entry"}
                  >
                    {formatMetric("usd", r.usd)}
                    {!r.cost_known && <span className="text-faint">+</span>}
                  </td>
                  <td className="py-1.5 text-right font-mono text-[11px] tabular-nums text-muted">
                    {formatMetric("ms", r.p95)}
                  </td>
                  <td className="py-1.5 text-right text-[11px] tabular-nums text-faint">
                    <span title={r.last_active ? absTime(r.last_active) : undefined}>{r.last_active ? relTime(r.last_active) : EMPTY_FIGURE}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {truncated && (
            <div className="mt-1.5 text-[10px] text-faint">
              showing the first {rows.length} agents by spend
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** A success rate's colour. The only figure in the table that gets one — see §3.7. */
function rateHue(rate: number | null): string {
  if (rate === null) return TEXT.faint;
  if (rate >= 0.95) return STATUS.ok;
  if (rate >= 0.5) return TEXT.muted;
  return STATUS.error;
}

// --- §6: the model and provider mix -------------------------------------------------------------

export function ModelMixCard() {
  const mix = useActivityStore((s) => s.mix);
  const fresh = useActivityStore((s) => s.leaderboardFresh);
  const hover = useActivityStore((s) => s.hover);
  const setHover = useActivityStore((s) => s.setHover);
  const range = useActivityStore((s) => s.range);
  // §6's toggle. Per session and in the view, exactly as the Inbox's filter rail is — it is a way of
  // looking at one card, not a preference about the workspace.
  const [view, setView] = useState<"spend" | "volume">("spend");

  if (!fresh) return <CardSkeleton height={CARD_HEIGHT} label="Model mix" />;

  // THE TWO VIEWS HAVE DIFFERENT POPULATIONS, which is the whole reason the toggle exists. An
  // unpriced model is in the volume view and out of the spend view — labelled rather than dropped,
  // so the two views do not appear to disagree about which models the workspace runs.
  const models = view === "spend" ? (mix?.models ?? []).filter((m) => m.priced) : (mix?.models ?? []);
  const total = view === "spend" ? (mix?.priced_usd ?? 0) : (mix?.total_tokens ?? 0);
  const unpriced = (mix?.models ?? []).filter((m) => !m.priced);

  return (
    <Card
      title="Model mix"
      icon={MixIcon}
      freshness={<FreshnessNote fresh={fresh} />}
      context={total > 0 ? `by share of ${view}, ${RANGE_PROSE[range]}` : undefined}
    >
      <div className="mt-1 flex items-center justify-end">
        {/* §4: an icon-only control, with a label and a tooltip. "An icon nobody can name is worse
            than a text button." */}
        <button
          onClick={() => setView(view === "spend" ? "volume" : "spend")}
          className="rounded-chip p-1 text-faint transition-colors duration-fast hover:text-ink"
          title={view === "spend" ? "Show share of volume" : "Show share of spend"}
          aria-label={view === "spend" ? "Show share of volume" : "Show share of spend"}
        >
          <ShareIcon size={ICON.xs} />
        </button>
      </div>

      {total === 0 ? (
        <Empty>no model ran in {RANGE_PROSE[range]}</Empty>
      ) : (
        <>
          {/* One stacked bar, bare. No legend — the series are named in the rows beneath it. */}
          <div className="flex h-1.5 overflow-hidden rounded-chip bg-hair">
            {models.map((m) => {
              const value = view === "spend" ? m.usd : m.tokens;
              return (
                <div
                  key={`${m.provider}/${m.model}`}
                  onMouseEnter={() => setHover({ kind: "model", id: m.model })}
                  onMouseLeave={() => setHover(null)}
                  className={dimClass(dimmedBy(hover, { model: m.model }))}
                  style={{ width: `${(value / total) * 100}%`, background: modelHue(m.provider), minWidth: 2 }}
                  title={`${m.model} · ${
                    view === "spend" ? formatMetric("usd", m.usd) : formatMetric("tokens", m.tokens)
                  }`}
                />
              );
            })}
          </div>

          <ul className="mt-2 space-y-1">
            {models.slice(0, 6).map((m) => {
              const value = view === "spend" ? m.usd : m.tokens;
              return (
                <li
                  key={`${m.provider}/${m.model}`}
                  onMouseEnter={() => setHover({ kind: "model", id: m.model })}
                  onMouseLeave={() => setHover(null)}
                  className={`flex items-center gap-2 ${dimClass(dimmedBy(hover, { model: m.model }))}`}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: modelHue(m.provider) }}
                    aria-hidden
                  />
                  <Truncate className="min-w-0 flex-1 font-mono text-[11px] text-muted" title={`${m.provider}/${m.model}`}>
                    {m.model}
                  </Truncate>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                    {Math.round((value / total) * 100)}%
                  </span>
                </li>
              );
            })}
          </ul>

          {/* §6: unpriced models are LABELLED rather than dropped silently. In the volume view they
              are already rows above; in the spend view this line is the whole of their presence. */}
          {view === "spend" && unpriced.length > 0 && (
            <div className="mt-2 text-[10px] text-faint" title={unpriced.map((m) => m.model).join(", ")}>
              {unpriced.length} model{unpriced.length === 1 ? "" : "s"} excluded — no pricing entry
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** A provider's hue in the mix. See `ActivityHero`'s note — colour is spent here and almost nowhere. */
function modelHue(provider: string): string {
  const palette: Record<string, string> = {
    anthropic: "#c98a5e",
    openai: "#5eb99a",
    google: "#7fa9db",
    together: "#a98cc4",
    groq: "#c99a52",
    nobody: TEXT.faint,
  };
  return palette[provider.toLowerCase()] ?? TEXT.faint;
}

// --- §8: the release timeline -------------------------------------------------------------------

export function ReleasesCard() {
  const entries = useActivityStore((s) => s.releases);
  const fresh = useActivityStore((s) => s.releasesFresh);
  const hover = useActivityStore((s) => s.hover);
  const setHover = useActivityStore((s) => s.setHover);
  const range = useActivityStore((s) => s.range);
  const closeNav = useUiStore((s) => s.closeNav);

  if (!fresh) return <CardSkeleton height={CARD_HEIGHT} label="Releases" />;

  return (
    <Card
      title="Releases"
      icon={ReleaseTagIcon}
      freshness={<FreshnessNote fresh={fresh} />}
      context={entries.length > 0 ? `published and deployed, ${RANGE_PROSE[range]}` : undefined}
    >
      {entries.length === 0 ? (
        <Empty>nothing shipped in {RANGE_PROSE[range]}</Empty>
      ) : (
        // A VERTICAL TIMELINE, which is what makes "three agents were deployed on Tuesday and two of
        // them failed" visible at all. The rail is one hairline; the marks sit on it.
        <ol className="relative mt-2 max-h-[236px] overflow-y-auto pl-4">
          <div className="absolute bottom-1 left-[5px] top-1 w-px bg-hair" aria-hidden />
          {entries.map((e) => {
            const action = actionForFeedKind(e.kind === "version" ? "version" : "deploy");
            return (
              <li
                key={e.id}
                onMouseEnter={() => setHover({ kind: "agent", id: e.agent_id })}
                onMouseLeave={() => setHover(null)}
                onClick={() => { selectAgent(e.agent_id); closeNav(); }}
                className={`relative cursor-pointer py-1 ${dimClass(dimmedBy(hover, { agentId: e.agent_id }))}`}
                title={`Open ${e.agent_name}`}
              >
                <span
                  className="absolute -left-4 top-[7px] h-[7px] w-[7px] rounded-full border"
                  style={{
                    borderColor: outcomeHue(e.outcome),
                    // A failure is filled and a success is hollow, which is the opposite of the
                    // reflex and is right: the eye is caught by the filled marks, and the ones worth
                    // catching on a release log are the ones that did not work.
                    background: e.outcome === "error" ? outcomeHue(e.outcome) : "transparent",
                  }}
                  aria-hidden
                />
                <div className="flex items-baseline gap-1.5">
                  <span className="shrink-0" style={{ color: action.accent }} aria-hidden>
                    <action.Icon size={ICON.xs} />
                  </span>
                  <Truncate className="min-w-0 flex-1 text-[12px] text-ink" title={e.agent_name}>
                    {e.agent_name}
                  </Truncate>
                  {e.version !== null && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">v{e.version}</span>
                  )}
                  <span className="shrink-0 text-[10px] tabular-nums text-faint" title={absTime(e.at)}>{relTime(e.at)}</span>
                </div>
                <div className="ml-[18px] text-[10px] text-muted">
                  {action.verb.toLowerCase()} · {e.detail}
                  {e.outcome === "error" && <span style={{ color: STATUS.error }}> · failed</span>}
                  {e.outcome === "running" && <span className="text-faint"> · in flight</span>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function outcomeHue(outcome: "ok" | "error" | "running"): string {
  return outcome === "ok" ? STATUS.ok : outcome === "error" ? STATUS.error : TEXT.faint;
}

// --- §9: the tool and MCP usage rollup -----------------------------------------------------------

export function ToolUsageCard() {
  const usage = useActivityStore((s) => s.tools);
  const fresh = useActivityStore((s) => s.toolsFresh);
  const range = useActivityStore((s) => s.range);
  const [expanded, setExpanded] = useState(false);

  if (!fresh || !usage) return <CardSkeleton height={CARD_HEIGHT} label="Tool & MCP usage" />;

  const refusals = usage.denied + usage.timed_out;
  const shown = expanded ? usage.tools : usage.tools.slice(0, 5);

  return (
    <Card
      title="Tool & MCP usage"
      icon={WrenchIcon}
      freshness={<FreshnessNote fresh={fresh} />}
      context={usage.total_calls > 0 ? `across every agent, ${RANGE_PROSE[range]}` : undefined}
    >
      {usage.total_calls === 0 ? (
        <Empty>no tool was called in {RANGE_PROSE[range]}</Empty>
      ) : (
        <>
          {/* THE FOUR NUMBERS NOTHING ELSE IN THE PRODUCT REPORTS. Each is `--` rather than a
              percentage when its own denominator is empty: a refusal rate over no high-impact calls
              rendered as 0% would read as "every call was approved". */}
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat
              label="High impact"
              value={usage.high_impact_calls > 0 ? String(usage.high_impact_calls) : EMPTY_FIGURE}
              hint="calls to tools classified high-impact, which stop for a confirmation"
            />
            <Stat
              label="Refused"
              value={
                usage.high_impact_calls === 0
                  ? EMPTY_FIGURE
                  : `${Math.round((refusals / usage.high_impact_calls) * 100)}%`
              }
              hint={`${usage.denied} declined, ${usage.timed_out} timed out — both count as a refusal`}
              tone={refusals > 0 ? "warn" : undefined}
            />
            <Stat
              label="Truncated"
              value={`${Math.round((usage.truncated_calls / usage.total_calls) * 100)}%`}
              hint={`${usage.truncated_calls} of ${usage.total_calls} results hit the size cap`}
            />
            <Stat
              label="Reviewed failures"
              value={String(usage.reviewed_failures)}
              hint="failures of audited connector tools — a number that should be zero"
              tone={usage.reviewed_failures > 0 ? "bad" : undefined}
            />
          </div>

          <ul className="mt-3 space-y-1 border-t border-hair pt-2">
            {shown.map((t) => (
              <li key={`${t.server_id ?? ""}/${t.name}`} className="flex items-center gap-1.5">
                <span className="shrink-0 text-faint" aria-hidden>
                  <OriginIcon origin={t.origin} />
                </span>
                <Truncate className="min-w-0 flex-1 font-mono text-[11px] text-muted" title={t.name}>
                  {t.name}
                </Truncate>
                {/* §9: "MCP-sourced tools carry the MCP marking they carry everywhere else. A
                    reviewed connector and an unread server tool must never look alike here either."
                    THE SAME COMPONENT, in its compact form — a second badge that merely looked like
                    the MCP one is exactly what that sentence rules out. The classification rides the
                    tooltip, because a high-impact tool is not a different KIND of tool. */}
                {t.origin === "mcp" && (
                  <McpBadge
                    variant="compact"
                    title={
                      t.impact === "high"
                        ? `From the ${t.server_id} MCP server — high impact, so every first call stops for a confirmation`
                        : `From the ${t.server_id} MCP server — third-party code Jaroku has not reviewed`
                    }
                  />
                )}
                {t.failures > 0 && (
                  <span className="shrink-0 font-mono text-[10px] tabular-nums" style={{ color: STATUS.error }}>
                    {t.failures}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{t.calls}</span>
              </li>
            ))}
          </ul>

          {usage.tools.length > 5 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1.5 flex items-center gap-1 text-[10px] text-faint transition-colors duration-fast hover:text-muted"
              title={expanded ? "Show the top five tools" : `Show all ${usage.tools.length} tools`}
              aria-label={expanded ? "Collapse the tool list" : "Expand the tool list"}
              aria-expanded={expanded}
            >
              <ExpandIcon size={ICON.badge} />
              {expanded ? "fewer" : `${usage.tools.length - 5} more`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

/** §9's three origins, each with the mark it already wears elsewhere in the app. */
function OriginIcon({ origin }: { origin: "reviewed" | "mcp" | "bespoke" }) {
  if (origin === "reviewed") return <ShieldCheckIcon size={ICON.xs} />;
  if (origin === "bespoke") return <SparklesIcon size={ICON.xs} />;
  return <WrenchIcon size={ICON.xs} />;
}

/** One small figure with a label. Same tabular discipline as the hero, one size down. */
function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "warn" | "bad";
}) {
  const color = tone === "bad" ? STATUS.error : tone === "warn" ? TEXT.ink : TEXT.muted;
  return (
    <div title={hint}>
      <div className="font-mono text-[15px] tabular-nums leading-none" style={{ color }}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-faint">{label}</div>
    </div>
  );
}

/**
 * §3.5's per-card empty: a dash and a short line of context.
 *
 * "Never `0`, never `$0.00`, never an empty chart axis implying a flat line at zero. Per-card
 * empties, using EmptyState. No page-level empty state — the header and the range control are still
 * meaningful." This is the inline form: `EmptyState`'s own `inline` size centres a mark and a title
 * in a block of its own, which inside a 300px card with a header already on it reads as a second
 * card rather than as an absent figure.
 */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[64px] items-center gap-2 text-[12px] text-muted">
      <span className="font-mono text-[15px] text-faint">{EMPTY_FIGURE}</span>
      {children}
    </div>
  );
}

// What this workspace has spent, and against what.
//
// The organising rule of this panel is the oldest rule in the cost model: UNKNOWN IS NOT ZERO,
// and a number that is a floor has to say so where the number is. Every figure here that could
// be incomplete is rendered beside the reason it is — not in a footnote, not behind a tooltip,
// and not as a lower-contrast asterisk somebody reads past. A cost dashboard's only job is to be
// believed, and a total presented as exact when it is a floor is the one thing that ends that.
//
// NOTHING IS COMPUTED HERE. Not the total, not the headroom, not whether the workspace is over
// its ceiling. Every one comes from the same `BudgetGate.status` the server refuses a run with,
// so the number on this page and the number in a refusal are one computation. A billing page
// that disagrees with a refusal is worse than no billing page.
//
// TWO METERS, NOT ONE, and the difference is the whole of BYOK. "Spent this period" is
// everything the workspace's work cost, whoever paid. "On our key" is the part WE paid, against
// its own smaller ceiling. A workspace running on its own credential sees a full figure in the
// first and zero in the second, which is the clearest possible statement of what BYOK bought
// them.

import { useEffect } from "react";
import { useBillingStore } from "../store/billingStore.ts";
import type { UsageBreakdown } from "../types.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendLoadUsage, sendLoadRun } from "../lib/socket.ts";
import { fmtCost, fmtTokens } from "../lib/format.ts";
import { ICON, STATUS, TEXT } from "../lib/tokens.ts";
import { EmptyState } from "./EmptyState.tsx";
import { AlertTriangleIcon, DatabaseIcon, InfoIcon } from "./panelIcons.tsx";

/** A date somebody reads, from an ISO timestamp. Never the time — a period boundary is a day. */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The mark that says a figure is a floor.
 *
 * Rendered inline, at full contrast, with words rather than a symbol. An asterisk would be read
 * as a footnote and a dimmed hint would be read as unimportant, and this is neither: it is the
 * difference between "$4.20" and "at least $4.20", which changes what somebody should do next.
 */
function Incomplete({ what = "some usage could not be priced" }: { what?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px]"
      style={{ color: STATUS.pending }}
      title={what}
    >
      <AlertTriangleIcon size={ICON.sm} />
      <span>a floor</span>
    </span>
  );
}

/** A cost, with the floor mark beside it when it is one. Never one without the other. */
function Cost({ row }: { row: UsageBreakdown }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="font-mono text-[12px] text-ink">{fmtCost(row.usd)}</span>
      {!row.costKnown && <Incomplete />}
    </span>
  );
}

/**
 * One meter: a figure, its limit, and how much of it is gone.
 *
 * The bar is clamped at 100% and turns red past it, because a bar that overflows its track reads
 * as a rendering bug rather than as being over budget — and being over budget is the state this
 * panel most needs to communicate unambiguously.
 */
function Meter({
  label, spentUsd, ceilingUsd, costKnown, note,
}: {
  label: string;
  spentUsd: number;
  ceilingUsd: number | null;
  costKnown: boolean;
  note?: string;
}) {
  const over = ceilingUsd !== null && spentUsd >= ceilingUsd;
  const pct = ceilingUsd === null || ceilingUsd === 0
    ? 0
    : Math.min(100, Math.round((spentUsd / ceilingUsd) * 100));
  return (
    <div className="rounded-control border border-hair px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-muted">{label}</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-[13px] text-ink">
            {!costKnown && "at least "}{fmtCost(spentUsd)}
          </span>
          <span className="text-[12px] text-faint">
            {ceilingUsd === null ? "of no limit" : `of ${fmtCost(ceilingUsd)}`}
          </span>
        </span>
      </div>
      {ceilingUsd !== null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-active">
          <div
            className="h-full rounded-full transition-[width]"
            style={{ width: `${pct}%`, background: over ? STATUS.error : STATUS.ok }}
          />
        </div>
      )}
      {note && <div className="mt-1.5 text-[11px] leading-[1.5] text-faint">{note}</div>}
      {!costKnown && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: STATUS.pending }}>
          <AlertTriangleIcon size={ICON.sm} />
          <span>
            some usage in this period could not be priced, so the figure is a floor rather than a total
          </span>
        </div>
      )}
    </div>
  );
}

export function UsagePanel() {
  const usage = useBillingStore((s) => s.usage);
  const loaded = useBillingStore((s) => s.loaded);
  const error = useBillingStore((s) => s.error);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const selectRun = useTraceStore((s) => s.selectRun);

  // Asked for on mount and not on a timer. Spend changes on every step of every run, and a
  // panel that polled would put a query per second per open tab against the table the ingest
  // chain is writing to. Opening the tab is the signal that somebody wants a fresh number.
  useEffect(() => {
    sendLoadUsage();
  }, []);

  if (!loaded && !error) {
    return (
      <EmptyState
        title="Loading usage"
        hint="What this workspace has spent this period, and against which limits."
        icon={DatabaseIcon}
      />
    );
  }
  if (error) {
    return <EmptyState title="Usage is unavailable" hint={error} icon={AlertTriangleIcon} />;
  }
  if (!usage) return null;

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium text-ink">{usage.plan.label} plan</div>
        <div className="text-[11px] text-faint">
          {day(usage.periodStart)} – {day(usage.periodEnd)}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <Meter
          label="Spent this period"
          spentUsd={usage.spentUsd}
          ceilingUsd={usage.ceilingUsd}
          costKnown={usage.costKnown}
          note={
            usage.overCeiling
              ? "over the limit — new runs are refused until it resets, or an owner raises it. Runs already going finish."
              : undefined
          }
        />
        {/* The other half of BYOK, and only worth showing when there is one. A workspace that
            has never touched the platform's key does not need a meter reading zero. */}
        {(usage.platformSpentUsd > 0 || usage.platformCeilingUsd !== null) && (
          <Meter
            label="On our provider key"
            spentUsd={usage.platformSpentUsd}
            ceilingUsd={usage.platformCeilingUsd}
            costKnown={usage.costKnown}
            note={
              usage.ownKeyForPlatform
                ? "your own key pays for generation, edits and the judge too — this covers what is left"
                : "what this plan covers on our key. Connect your own to run past it."
            }
          />
        )}
        {usage.balanceUsd > 0 && (
          <div className="rounded-control border border-hair px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-muted">Credit</span>
              <span className="font-mono text-[13px] text-ink">{fmtCost(usage.availableUsd)}</span>
            </div>
            {usage.reservedUsd > 0 && (
              <div className="mt-1.5 text-[11px] text-faint">
                {fmtCost(usage.reservedUsd)} is held for runs in flight and comes back when they finish
              </div>
            )}
          </div>
        )}
      </div>

      <Section title="By agent" empty="Nothing has spent anything this period.">
        {usage.byAgent.map((a) => (
          <Row key={a.agentId ?? "platform"} label={a.label} sub={a.runs ? `${a.runs} run${a.runs === 1 ? "" : "s"}` : undefined}>
            <span className="text-[11px] text-faint">{fmtTokens(a.tokens)}</span>
            <Cost row={a} />
          </Row>
        ))}
      </Section>

      <Section title="Most expensive runs" empty="No runs this period.">
        {usage.byRun.map((r) => (
          <Row
            key={r.runId}
            label={r.label ?? r.runId.slice(0, 8)}
            sub={r.runId.slice(0, 8)}
            // The drill-down the spec asks for: a row opens the run's own trace, where every
            // step's cost is already itemised. There is deliberately no second cost view — the
            // trace IS the itemisation, and a parallel one could disagree with it.
            onClick={() => {
              selectRun(r.runId);
              sendLoadRun(r.runId);
              setRightTab("trace");
            }}
          >
            <span className="text-[11px] text-faint">{fmtTokens(r.tokens)}</span>
            <Cost row={r} />
          </Row>
        ))}
      </Section>

      <Section title="By kind" empty="Nothing metered yet.">
        {usage.byKind.map((k) => (
          <Row
            key={`${k.kind}:${k.payer}`}
            label={k.kind}
            sub={k.payer === "workspace" ? "your key" : "our key"}
          >
            <span className="text-[11px] text-faint">{k.tokens > 0 ? fmtTokens(k.tokens) : ""}</span>
            <Cost row={k} />
          </Row>
        ))}
      </Section>

      <div className="mt-4 flex items-start gap-1.5 text-[11px] leading-[1.55] text-faint">
        <span className="mt-0.5 shrink-0" style={{ color: TEXT.faint }}>
          <InfoIcon size={ICON.sm} />
        </span>
        <span>
          Cost is summed from a run's steps, never from the run row — a run that crashes mid-graph
          never writes a total, and its steps record what it really spent.
        </span>
      </div>
    </div>
  );
}

function Section({
  title, empty, children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-faint">{title}</div>
      {children.length === 0 ? (
        <div className="px-1 py-2 text-[12px] text-faint">{empty}</div>
      ) : (
        <div className="divide-y divide-hair">{children}</div>
      )}
    </div>
  );
}

function Row({
  label, sub, onClick, children,
}: {
  label: string;
  sub?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const inner = (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-[12px] text-ink">{label}</div>
        {sub && <div className="truncate font-mono text-[11px] text-faint">{sub}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
  return onClick ? (
    <button className="w-full rounded-control px-1 text-left transition-colors hover:bg-active/40" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="px-1">{inner}</div>
  );
}

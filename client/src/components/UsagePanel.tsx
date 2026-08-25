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

import { useEffect, useState } from "react";
import { useBillingStore } from "../store/billingStore.ts";
import type { UsageBreakdown, UsageSnapshot } from "../types.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { sendLoadUsage, sendLoadRun, sendSetSpendCeiling } from "../lib/socket.ts";
import { useCanReach, useCanRun } from "../lib/useCapability.ts";
import { startCheckout } from "../lib/workspaceApi.ts";
import { fmtCost, fmtTokens } from "../lib/format.ts";
import { ICON, STATUS, TEXT } from "../lib/tokens.ts";
import { EmptyState, LoadingLine } from "./EmptyState.tsx";
import { ExportIcon } from "./activityIcons.tsx";
import { iconBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { download, usageStem, usageToCsv } from "../lib/evalExport.ts";
import {
  AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon, InfoIcon,
} from "./panelIcons.tsx";

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
 * The workspace's own ceiling, as a control rather than a figure.
 *
 * WHY IT IS ON THE METER AND NOT IN A SETTINGS PANEL. `BudgetGate.status` already prefers the
 * workspace's own ceiling over its plan's, and this panel already renders the result — so the number
 * was visible, was the thing runs are refused against, and could only be changed with SQL. A budget
 * you can see and cannot set is a dashboard.
 *
 * THREE STATES, ALL REACHABLE, because the repository's contract has three and a control that could
 * only send a number would be a one-way door: `null` goes back to the plan's ceiling, `0` means
 * start nothing, and anything else is a limit of this workspace's own. "Use the plan's" is offered
 * as its own button rather than as an empty field, because clearing an input is not a statement.
 */
function CeilingControl({ ceilingUsd, planCeilingUsd }: { ceilingUsd: number | null; planCeilingUsd: number | null }) {
  // NAMES THE COMMAND IT SENDS. This was `role !== "owner"`, which is the same answer today and
  // stops being one the moment `billing:manage` moves — and it is the guess §8.2 ends by ruling
  // out. `sendSetSpendCeiling` is directly below; `canRun` is what knows what that needs.
  const canSet = useCanRun("setSpendCeiling");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!canSet) return null;

  const commit = (): void => {
    const trimmed = draft.trim();
    const value = Number(trimmed);
    // A blank field is not a decision, so it closes rather than sending anything. `null` has its
    // own button; that is what makes the difference between the two sayable.
    if (trimmed !== "" && Number.isFinite(value) && value >= 0) sendSetSpendCeiling(value);
    setEditing(false);
    setDraft("");
  };

  if (!editing) {
    return (
      <button
        className={quietBtn}
        onClick={() => {
          setDraft(ceilingUsd === null ? "" : String(ceilingUsd));
          setEditing(true);
        }}
        title="Set this workspace's own ceiling, whatever its plan says"
      >
        {ceilingUsd === null ? "Set a limit" : "Change"}
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[11px] text-faint">$</span>
      <input
        autoFocus
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-20 rounded-control border border-hair bg-void px-1.5 py-0.5 font-mono text-[11px] text-ink outline-none focus-visible:shadow-focusring focus:border-edge"
      />
      <button className={quietBtn} onClick={commit}>Save</button>
      {/* Only when there IS one to clear. Offering "use the plan's" while already on the plan's
          would be a button whose effect is nothing. */}
      {ceilingUsd !== null && (
        <button
          className={quietBtn}
          title={
            planCeilingUsd === null
              ? "Back to the plan's, which sets no ceiling of its own"
              : `Back to the plan's ${fmtCost(planCeilingUsd)}`
          }
          onClick={() => {
            sendSetSpendCeiling(null);
            setEditing(false);
          }}
        >
          Use the plan&rsquo;s
        </button>
      )}
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
  label, spentUsd, ceilingUsd, costKnown, note, control,
}: {
  label: string;
  spentUsd: number;
  ceilingUsd: number | null;
  costKnown: boolean;
  note?: string;
  /** A control that changes the limit this meter is drawn against, for the one meter that has one. */
  control?: React.ReactNode;
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
          {control}
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

/** Where a quota stops being a number and starts being a warning. §8.3's figure. */
const NEARING = 0.8;

/**
 * A COUNT against a limit, which is not the same shape as money against a ceiling.
 *
 * A SEPARATE COMPONENT RATHER THAN A PARAMETER ON `Meter`, and the reason is what each one says
 * when it has nothing to say. A spend meter with no ceiling reads "of no limit", which is correct
 * and mildly reassuring. A quota with no limit is a tier that does not count this at all, and the
 * useful rendering there is the count on its own — "1,204 runs this month" — with no bar, because a
 * bar with no end is a bar that always looks empty.
 *
 * AND IT WARNS BEFORE IT REFUSES. §8.3 asks for a soft warning past eighty per cent, which exists
 * because the alternative is finding out at the moment you are stopped. Amber at 80, red at 100,
 * and the sentence names what would change it — the same rule every refusal in this codebase is
 * written under.
 */
function QuotaMeter({
  label, used, limit, unit,
}: {
  label: string;
  used: number;
  limit: number | "unlimited";
  unit: string;
}) {
  if (limit === "unlimited") {
    return (
      <div className="rounded-control border border-hair px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-muted">{label}</span>
          <span className="font-mono text-[13px] tabular-nums text-ink">
            {used.toLocaleString()}
            <span className="ml-1 text-[12px] text-faint">this period</span>
          </span>
        </div>
      </div>
    );
  }

  const ratio = limit === 0 ? 1 : used / limit;
  const at = used >= limit;
  const nearing = !at && ratio >= NEARING;
  const pct = Math.min(100, Math.round(ratio * 100));

  return (
    <div className="rounded-control border border-hair px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-muted">{label}</span>
        <span className="font-mono text-[13px] tabular-nums text-ink">
          {used.toLocaleString()}
          <span className="ml-1 text-[12px] text-faint">of {limit.toLocaleString()}</span>
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-active">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: at ? STATUS.error : nearing ? STATUS.pending : STATUS.ok }}
        />
      </div>
      {(at || nearing) && (
        <div
          className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-[1.5]"
          style={{ color: at ? STATUS.error : STATUS.pending }}
        >
          <span className="mt-0.5 shrink-0"><AlertTriangleIcon size={ICON.sm} /></span>
          <span>
            {at
              ? `no ${unit} left this period — the count resets at the start of next month, and upgrading raises the limit`
              : `${limit - used} ${unit} left this period`}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * What this workspace is on, and what else it could be on.
 *
 * WHY IT IS HERE AND NOT IN A SETTINGS SCREEN. The panel already names the plan and draws the
 * ceiling that plan sets; "how do I raise this" is the question the meter above it provokes, and the
 * answer belongs where the question is asked. Every layer of this existed — a checkout route that
 * validates the plan against the table and never against a client-supplied price, the full
 * subscription webhook state machine, credit granted on `invoice.paid`, three suites — and no
 * button. A deployment with Stripe configured had a paid tier nobody could buy.
 *
 * COLLAPSED UNTIL ASKED. The plans are a list of five facts each; expanded by default they would
 * out-weigh the spend figures that are the reason somebody opened this tab.
 */
function PlanChoice({ usage }: { usage: UsageSnapshot }) {
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `billing:manage`, asked of the matrix rather than spelled as a role. Reading spend is a
  // member's — a member whose run was refused for budget has to be able to see the number it was
  // refused against — and CHANGING what may be spent is not. `billingCheckout` names the route
  // `startCheckout` calls, so a capability that moves moves this with it.
  const canBuy = useCanReach("billingCheckout");
  const buyable = usage.plans.filter((p) => p.purchasable && !p.current);
  // Nothing to offer: no payments on this deployment, or already on the top tier. Saying nothing is
  // right for the first (the local path is not a degraded state) and for the second.
  if (!usage.paymentsConfigured || buyable.length === 0) return null;

  const go = async (plan: string): Promise<void> => {
    if (!workspaceId || busy) return;
    setBusy(plan);
    setError(null);
    try {
      const { url } = await startCheckout(plan, workspaceId);
      // THE BROWSER HAS TO GO THERE. A payment form is a page a person reads, and `assign` rather
      // than `replace` so Back returns to the app rather than skipping past it — the same choice
      // the connector consent flow makes for the same reason.
      window.location.assign(url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-control border border-hair px-3 py-2.5">
      <button
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-[12px] text-muted">Plans</span>
        <span className="text-[11px] text-faint">
          {buyable.length === 1 ? `${buyable[0]!.label} is available` : `${buyable.length} others available`}
        </span>
        <span className="ml-auto text-faint">
          {open ? <ChevronDownIcon size={ICON.xs} /> : <ChevronRightIcon size={ICON.xs} />}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {usage.plans.map((p) => (
            <div key={p.id} className="flex items-start gap-3 border-t border-hair pt-1.5 first:border-t-0 first:pt-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink">{p.label}</span>
                  {p.current && <span className="text-[10px] uppercase tracking-wider text-faint">current</span>}
                </div>
                {/* THE FACTS A CHOICE ACTUALLY TURNS ON, in the units the rest of the panel uses:
                    what it grants, what it lets you start, how long a trace survives, how many
                    people may be here. Not a marketing line — this panel's whole job is to be
                    believed. */}
                <div className="text-[11px] leading-[1.55] text-faint">
                  {fmtCost(p.monthlyCreditsUsd)} credit each period ·{" "}
                  {p.budgetCeilingUsd === null ? "no plan ceiling" : `up to ${fmtCost(p.budgetCeilingUsd)} started`} ·{" "}
                  {p.retentionDays}-day traces · {p.seats === null ? "unlimited seats" : `${p.seats} seats`}
                  {p.deploy ? " · deploys" : " · no deploys"}
                </div>
              </div>
              {/* §8.2 — "Usage / Billing / Change plan / checkout / billing:manage". Absent rather
                  than disabled: it was greyed with "only an owner can change the plan" as its
                  tooltip, which is §8's forbidden shape and also the least useful place to put a
                  sentence — a tooltip on a disabled control is text somebody has to hover a dead
                  button to read. The sentence below the list says the same thing once, where it
                  is read without hovering anything. */}
              {!p.current && p.purchasable && canBuy && (
                <button
                  className={secondaryBtn}
                  disabled={busy !== null}
                  title={`Change to ${p.label}`}
                  onClick={() => void go(p.id)}
                >
                  {busy === p.id ? "Opening…" : "Choose"}
                </button>
              )}
            </div>
          ))}
          {!canBuy && (
            <p className="text-[11px] text-faint">
              Only an owner can change the plan — spend is everybody&rsquo;s to see, and what may be
              spent is theirs to set.
            </p>
          )}
          {error && <p className="text-[11px] text-err">{error}</p>}
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
      <LoadingLine label="Loading usage…" />
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
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] text-faint">
            {day(usage.periodStart)} – {day(usage.periodEnd)}
          </span>
          {/* The same rule as the eval exports, on the newest surface: every caveat on this
              page survives into the file. See usageToCsv — an unpriced row is an empty cell
              with `cost_known: no` beside it, never a zero somebody sums. */}
          {/* The glyph exists in `activityIcons.tsx` and was unused here — two words of chrome in
              a panel header, on the one control in it whose mark is unambiguous. */}
          <button
            className={iconBtn}
            title="Export CSV"
            aria-label="Export CSV"
            onClick={() => download(`${usageStem(usage)}.csv`, usageToCsv(usage), "text/csv")}
          >
            <ExportIcon size={ICON.sm} />
          </button>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <Meter
          label="Spent this period"
          spentUsd={usage.spentUsd}
          ceilingUsd={usage.ceilingUsd}
          costKnown={usage.costKnown}
          // THE ONE METER WITH A CONTROL. The platform-key meter below it is OUR ceiling on what we
          // will spend on this workspace's behalf, which is not the customer's to set — and the
          // credit block is a balance rather than a limit.
          control={
            <CeilingControl
              ceilingUsd={usage.ceilingUsd}
              planCeilingUsd={usage.plans.find((p) => p.current)?.budgetCeilingUsd ?? null}
            />
          }
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
        {/* WHAT THE TIER BOUNDS, under what the money bounds, because they are two different
            limits and a workspace can be nowhere near one while sitting on the other. A BYOK
            workspace is the clearest case: nothing spent on our key, and its runs counted all the
            same. */}
        <QuotaMeter
          label="Runs this period"
          used={usage.quota.runs.used}
          limit={usage.quota.runs.limit}
          unit="runs"
        />
        {/* Only when the tier counts them. A plan with unlimited eval runs still renders the plain
            figure above; a workspace that has run no evals at all does not need a row saying so. */}
        {(usage.quota.evalRuns.used > 0 || usage.quota.evalRuns.limit !== "unlimited") && (
          <QuotaMeter
            label="Eval runs this period"
            used={usage.quota.evalRuns.used}
            limit={usage.quota.evalRuns.limit}
            unit="eval runs"
          />
        )}
        {/* Inside the meters block, directly under the ceiling it is about. "How do I raise this"
            is the question the bar above provokes. */}
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

      <PlanChoice usage={usage} />

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
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{title}</div>
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

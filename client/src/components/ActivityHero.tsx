// §3.1's hero row and the wide band under it: spend, tokens, run health, and the pulse.
//
// THREE NUMBERS AND ONE CHART, IN THAT ORDER OF IMPORTANCE. The hero is the answer to "what is this
// workspace doing" at a glance; the band underneath is the shape of it over time. §3.2's rule holds
// throughout: the figure is the headline, the chart is texture behind it.
//
// EVERY CARD STATES ITS OWN WINDOW (§1). The context line under each figure names the range, so a
// screenshot of one card is never ambiguous about what it is measuring. That is why `Figure` takes
// the range rather than reading it from the store — a card that had to be inside a provider to know
// its own window would be a card that could be rendered without one.
//
// AMBER APPEARS NOWHERE. §3.7: "Amber means running, and nothing on a historical dashboard is
// running." The run-health card's split is the success/failure pair and nothing else, and a run that
// is still executing is counted in the total and left out of the rate rather than being given a
// colour of its own.

import { Figure, FreshnessNote, Sparkline } from "./ActivityFigures.tsx";
import { Card, CardSkeleton } from "./ActivityView.tsx";
import { MixIcon, PulseIcon, RingIcon } from "./activityIcons.tsx";
import { EMPTY_FIGURE, formatMetric } from "../lib/activityMetrics.ts";
import { RANGE_PROSE } from "../lib/activityRange.ts";
import { SHARE_ORDER, SHARE_RAMP, STATUS, TEXT } from "../lib/tokens.ts";
import { useActivityStore } from "../store/activityStore.ts";
import { ActivityIcon } from "./panelIcons.tsx";

/** The hero cards' agreed height, so all three skeletons and all three cards are one row. */
const HERO_HEIGHT = 132;

/**
 * §2's spend rollup: the sum against the budget, with the provider split.
 *
 * THE RING IS A RING AND NOT A BAR, because it is a fraction of a WHOLE — spend against a ceiling
 * somebody set — and a bar with no visible end does not say what the whole is. When there is no
 * ceiling there is no ring: a gauge with no maximum is a decoration, so the card falls back to the
 * provider split alone rather than inventing a denominator.
 *
 * "$12.40 · 2 agents unpriced" IS THE SENTENCE §2 ASKS FOR, and it is rendered whenever the total
 * mixes priced and unpriced models. Not as a warning and not in a colour: it is a caveat on a
 * number, and the number is still the best answer available.
 */
function SpendCard() {
  const summary = useActivityStore((s) => s.summary);
  const fresh = useActivityStore((s) => s.summaryFresh);
  const range = useActivityStore((s) => s.range);

  if (!summary) return <CardSkeleton height={HERO_HEIGHT} label="Spend" />;
  const spend = summary.spend;
  // §3.5: no usage rows at all is `--`; rows that summed to nothing is a real `$0.00`.
  const value = spend.events === 0 ? null : spend.usd;
  const share = spend.budget_usd && spend.budget_usd > 0 ? Math.min(1, spend.usd / spend.budget_usd) : null;

  return (
    <Card title="Spend" icon={RingIcon} freshness={<FreshnessNote fresh={fresh} />}>
      <div className="mt-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Figure
            id="spend"
            value={value}
            previous={spend.previous_usd}
            range={range}
            comparable={summary.comparable}
            context={
              value === null ? undefined : (
                <>
                  {spend.budget_usd !== null && spend.budget_usd > 0
                    ? `of ${formatMetric("usd", spend.budget_usd)}, ${RANGE_PROSE[range]}`
                    : `across the workspace, ${RANGE_PROSE[range]}`}
                  {!spend.cost_known && spend.unpriced_agents > 0 && (
                    <>
                      {" · "}
                      <span title={`unpriced: ${spend.unpriced_models.join(", ")}`}>
                        {spend.unpriced_agents} agent{spend.unpriced_agents === 1 ? "" : "s"} unpriced
                      </span>
                    </>
                  )}
                </>
              )
            }
          />
        </div>
        {share !== null && <BudgetRing share={share} />}
      </div>

      {/* §2's provider split. Bare segments on one line, named inline — §3.2 forbids a legend, and
          three providers do not need one. */}
      {spend.by_provider.length > 0 && spend.usd > 0 && (
        <div className="mt-2.5 flex items-center gap-2 overflow-hidden">
          <div className="flex h-1 min-w-0 flex-1 overflow-hidden rounded-chip bg-hair">
            {spend.by_provider.map((p) => (
              <div
                key={p.provider}
                title={`${p.provider} · ${formatMetric("usd", p.usd)}`}
                style={{ width: `${(p.usd / spend.usd) * 100}%`, background: providerHue(p.provider) }}
              />
            ))}
          </div>
          <span className="shrink-0 text-tiny text-faint">{spend.by_provider[0]?.provider}</span>
        </div>
      )}
    </Card>
  );
}

/**
 * §2's ring gauge: spend against budget, as an arc.
 *
 * A STROKE-DASH ARC RATHER THAN A CONIC GRADIENT, because the app draws structure as hairlines and a
 * conic gradient is a fill. It is also the only form that keeps its weight when the card resizes.
 *
 * PAST THE CEILING IT DOES NOT WRAP. A ring that went round twice would read as 20% of a second
 * budget nobody has; it fills and stops, and the figure beside it is what says by how much.
 */
function BudgetRing({ share }: { share: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg width={38} height={38} viewBox="0 0 38 38" aria-hidden className="shrink-0">
      <circle cx="19" cy="19" r={r} fill="none" stroke={TEXT.faint} strokeWidth={2} opacity={0.25} />
      <circle
        cx="19"
        cy="19"
        r={r}
        fill="none"
        // Ink rather than a status colour: §3.7 keeps colour for the provider split and the
        // success/failure pair, and "how much of the budget" is a proportion rather than a verdict.
        stroke={TEXT.ink}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${(c * share).toFixed(2)} ${c.toFixed(2)}`}
        transform="rotate(-90 19 19)"
        opacity={0.7}
      />
      <text
        x="19"
        y="22"
        textAnchor="middle"
        className="fill-muted text-tiny tabular-nums"
      >
        {Math.round(share * 100)}
      </text>
    </svg>
  );
}

/**
 * §3's token volume: the figure, the delta, and the cached split behind it.
 *
 * THE CACHED SPLIT IS THE CHEAPEST REAL INSIGHT ON THIS PAGE — it tells somebody whether prompt
 * caching is actually engaging, which nothing else in the product surfaces. It is also the figure
 * most easily rendered as a lie: a usage row records a cache breakdown only when the caller HAD one,
 * so a workspace whose agents all meter through the step path has a genuine `0` that means "nobody
 * measured". When the whole window is unsplit the card says `--` and says why.
 */
function TokensCard() {
  const summary = useActivityStore((s) => s.summary);
  const fresh = useActivityStore((s) => s.summaryFresh);
  const range = useActivityStore((s) => s.range);

  if (!summary) return <CardSkeleton height={HERO_HEIGHT} label="Tokens" />;
  const t = summary.tokens;
  const value = t.events === 0 ? null : t.total;
  const measured = t.total - t.unsplit_tokens;
  // A cached figure is only meaningful over the volume whose split was recorded.
  const cached = measured > 0 ? t.cached : null;

  return (
    <Card title="Tokens" icon={ActivityIcon} freshness={<FreshnessNote fresh={fresh} />}>
      <div className="relative mt-2">
        {/* THE SPARKLINE IS BEHIND THE NUMBER, at low opacity and full card width — §3.2's "texture
            behind the number, not the headline". */}
        {/* AND ONLY WHEN THERE IS A NUMBER TO BE BEHIND. §3.5: "never an empty chart axis implying a
            flat line at zero." A range with no model call in it still has a full row of pulse
            buckets — seven of them over a week — every one of them zero, and `Sparkline`'s own rule
            that a flat series is drawn along the floor then painted a hairline directly under the
            words "no model calls in this range". The card was making two statements about the same
            window and only one of them was true. `pulse.length` answers "is there a series"; the
            figure answers "is there anything in it", and it is the second question this is. */}
        {value !== null && summary.pulse.length > 1 && (
          <Sparkline
            values={summary.pulse.map((c) => c.tokens)}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 w-full opacity-70"
          />
        )}
        <div className="relative">
          <Figure
            id="tokens"
            value={value}
            previous={t.previous_total}
            range={range}
            comparable={summary.comparable}
            context={
              value === null ? undefined : (
                <>
                  {cached === null
                    ? "no call in this range recorded a cache split"
                    : `${formatMetric("tokens", cached)} cached · ${formatMetric("tokens", t.total - t.cached)} fresh`}
                  {cached !== null && t.unsplit_tokens > 0 && (
                    <span title={`${formatMetric("tokens", t.unsplit_tokens)} recorded no split`}>
                      {" · split over "}
                      {Math.round((measured / t.total) * 100)}%
                    </span>
                  )}
                </>
              )
            }
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * §4's run health strip: the rate, the percentiles, and the failure split.
 *
 * THE CARD SAYS WHICH LATENCY IT IS SHOWING, which §4 requires in as many words: "Latency is per
 * run, computed from step timings, and states which it is on the card." The two are genuinely
 * different — a run paused for four hours and resumed has four hours of wall clock and seconds of
 * work — and a p95 nobody can interpret is a p95 that gets quoted wrongly.
 *
 * INTERRUPTED RUNS ARE THEIR OWN SLICE. §4 forbids folding them into the failure rate silently; the
 * strip shows them beside the failures with their own word, so a deploy that bounced the server
 * cannot be read as the workspace's agents breaking.
 */
function HealthCard() {
  const summary = useActivityStore((s) => s.summary);
  const fresh = useActivityStore((s) => s.summaryFresh);
  const range = useActivityStore((s) => s.range);

  if (!summary) return <CardSkeleton height={HERO_HEIGHT} label="Run health" />;
  const h = summary.health;
  const settled = h.ok + h.failed;

  return (
    <Card title="Run health" icon={PulseIcon} freshness={<FreshnessNote fresh={fresh} />}>
      <div className="mt-2">
        <Figure
          id="successRate"
          value={h.success_rate}
          previous={h.previous_success_rate}
          range={range}
          comparable={summary.comparable}
          context={
            h.runs === 0 ? undefined : (
              <>
                {h.runs.toLocaleString("en-US")} run{h.runs === 1 ? "" : "s"} · p50{" "}
                <span className="tabular-nums">{formatMetric("ms", h.p50)}</span> · p95{" "}
                <span className="tabular-nums">{formatMetric("ms", h.p95)}</span>
                <span className="text-faint"> (summed step time)</span>
              </>
            )
          }
        />

        {/* The success/failure split — one of the only two places §3.7 allows colour on this tab. */}
        {settled > 0 && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="flex h-1 min-w-0 flex-1 overflow-hidden rounded-chip bg-hair">
              <div style={{ width: `${(h.ok / settled) * 100}%`, background: STATUS.ok }} title={`${h.ok} ok`} />
              <div style={{ width: `${(h.failed / settled) * 100}%`, background: STATUS.error }} title={`${h.failed} failed`} />
            </div>
            {/* §4: interrupted is a DISTINCT outcome, shown rather than folded in — and deliberately
                outside the bar, because it is not part of the rate the bar is drawn from. */}
            {h.interrupted > 0 && (
              <span
                className="shrink-0 text-tiny tabular-nums text-faint"
                title="closed out by a restart or a cancellation — not counted as failures"
              >
                {h.interrupted} interrupted
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * §3.1's WORKSPACE PULSE band: runs and spend over the range, read against each other.
 *
 * TWO SERIES ON ONE GRID, because "spend went up and runs did not" is the whole question the band
 * answers. Two charts stacked would let a column in one sit beside a different hour in the other,
 * which is the ambiguity a shared window exists to remove.
 *
 * BARE: no gridlines, no axis ticks, one hairline baseline, and the series named INLINE rather than
 * in a legend — §3.2. The runs series is drawn as columns because a count is discrete; the spend
 * series is a line because money is continuous. That is not decoration: a line through run counts
 * implies values between the hours that do not exist.
 */
function PulseBand() {
  const summary = useActivityStore((s) => s.summary);
  const fresh = useActivityStore((s) => s.summaryFresh);
  const range = useActivityStore((s) => s.range);

  if (!summary) return <CardSkeleton height={116} label="Workspace pulse" />;
  const cols = summary.pulse;
  const anything = cols.some((c) => c.runs > 0 || c.usd > 0);
  const maxRuns = Math.max(1, ...cols.map((c) => c.runs));

  return (
    <Card
      title="Workspace pulse"
      icon={MixIcon}
      freshness={<FreshnessNote fresh={fresh} />}
      context={
        anything ? (
          <>
            runs and spend over {RANGE_PROSE[range]} · <span style={{ color: TEXT.muted }}>columns are runs</span>,{" "}
            <span style={{ color: STATUS.ok }}>the line is spend</span>
          </>
        ) : undefined
      }
    >
      {!anything ? (
        // §3.5: never an empty chart axis implying a flat line at zero.
        <div className="flex h-[64px] items-center text-caption text-muted">
          {EMPTY_FIGURE} nothing has run in {RANGE_PROSE[range]}
        </div>
      ) : (
        <div className="relative mt-2 h-[64px]">
          {/* Columns: one per bucket, height by run count. Gaps are real periods with nothing in
              them, so they render as full-width columns of zero height rather than as absences. */}
          <div className="absolute inset-0 flex items-end gap-px">
            {cols.map((c) => (
              <div
                key={c.at}
                className="min-w-0 flex-1 rounded-t-[1px]"
                style={{
                  height: `${(c.runs / maxRuns) * 100}%`,
                  // A column with failures in it carries the failure colour at its share of the
                  // height — the second of §3.7's two permitted uses of colour.
                  background: c.errors > 0 ? STATUS.error : TEXT.faint,
                  opacity: c.errors > 0 ? 0.55 : 0.4,
                }}
                title={`${c.at.slice(0, 16).replace("T", " ")} · ${c.runs} run${c.runs === 1 ? "" : "s"}${
                  c.errors > 0 ? `, ${c.errors} failed` : ""
                } · ${formatMetric("usd", c.usd)}`}
              />
            ))}
          </div>
          <Sparkline
            values={cols.map((c) => c.usd)}
            hue={STATUS.ok}
            filled
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
          {/* The one hairline. An axis, not a gridline. */}
          <div className="absolute inset-x-0 bottom-0 h-px bg-hair" />
        </div>
      )}
    </Card>
  );
}

/**
 * A provider's colour on the spend ring.
 *
 * ONE OF ONLY TWO PLACES COLOUR IS SPENT ON THIS TAB (§3.7), and the palette is deliberately small
 * and neutral-leaning: these are segments of a 4px bar, not brand marks, and a full-saturation strip
 * across the top of the page would be the loudest thing on a surface built to be quiet. Brand LOGOS
 * remain the recorded exception and belong in Model Mix, where a segment is large enough to carry
 * one.
 */
function providerHue(provider: string): string {
  const at = SHARE_ORDER.indexOf(provider.toLowerCase() as (typeof SHARE_ORDER)[number]);
  return at === -1 ? TEXT.faint : SHARE_RAMP[at % SHARE_RAMP.length]!;
}

/** §3.1's hero row. Always three across — §3.8's one exception to the narrow-width stack. */
export function ActivityHero() {
  return (
    <>
      <SpendCard />
      <TokensCard />
      <HealthCard />
    </>
  );
}

export { PulseBand };

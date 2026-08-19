// §3.2's discipline, as four components: the figure, the badge, the texture behind it, and the
// quiet line that says how old it is.
//
// NUMBERS ARE THE HERO, CHARTS ARE NOT. "Every card leads with one large figure in the mono face
// using tabular figures, with a muted context line beneath. v0.2.2 already moved the trace from
// `1,204 tok · $0.0031 · 820 ms` inline to figures as tabular columns — the same discipline applies
// here, and columns of numbers must align on the decimal."
//
// TABULAR FIGURES ARE NOT DECORATION. A proportional `1` is narrower than a `4`, so a column of
// spend figures updating live jitters sideways as the digits change, and two rows of a leaderboard
// do not line up on the decimal even though they are the same width. `tabular-nums` is what makes a
// column of numbers readable AS a column, which is the entire reason the leaderboard is a table.
//
// SPARKLINES SIT IN THE CARD BACKGROUND, NOT THE FOREGROUND. The chart is texture behind the number,
// not the headline — §3.2 again, and the reason `Sparkline` is absolutely positioned with the figure
// stacked above it rather than beside it.
//
// CHARTS ARE DRAWN BARE: no gridlines, hairline axes only, one hue, no legend. Structure is
// hairlines, never background fills, exactly as everywhere else in this app.

import { EMPTY_FIGURE, deltaOf, formatDelta, formatMetric, metric, type MetricId } from "../lib/activityMetrics.ts";
import { RANGE_PROSE, type ActivityRange } from "../lib/activityRange.ts";
import { STATUS, TEXT } from "../lib/tokens.ts";
import type { Freshness } from "../store/activityStore.ts";

/**
 * One card's large figure, its delta badge and its context line.
 *
 * THE POLARITY COMES FROM THE REGISTRY AND NEVER FROM THIS COMPONENT (§3.3). Spend up is bad, tokens
 * up is neutral, latency down is good — so the badge asks `activityMetrics` what the movement MEANS
 * and renders that, rather than deciding from the arrow. A component that decided would get one of
 * them wrong the day a fifth metric is added beside it.
 *
 * `empty` IS A DISTINCT STATE FROM ZERO (§3.5). A card whose range genuinely held nothing renders
 * `--` and the metric's own line of context; a card whose range held rows that summed to nothing
 * renders the number. The caller decides which by passing `null` versus `0`, which is why every
 * aggregate on the server carries an `events` count beside its total.
 */
export function Figure({
  id,
  value,
  previous,
  range,
  comparable = true,
  context,
  size = "hero",
}: {
  id: MetricId;
  /** `null` means the range held nothing — see §3.5. `0` is a real figure. */
  value: number | null;
  previous?: number | null;
  range: ActivityRange;
  /** §3.3: false when the workspace is younger than the previous window, so the delta is `--`. */
  comparable?: boolean;
  /** Overrides the registry's context line, for a card that has something more specific to say. */
  context?: React.ReactNode;
  size?: "hero" | "inline";
}) {
  const def = metric(id);
  const empty = value === null || value === undefined;
  const delta = empty ? null : deltaOf(value, previous, def.goodWhen, comparable);

  return (
    <div className="relative">
      <div className="flex items-baseline gap-2">
        {/* 18px for a hero figure, not 26. The rule this product's typography is built on is that
            hierarchy comes from WEIGHT and COLOUR, not from scale — and a 26px number (30px on the
            hero card) was the loudest element in the entire application, three of them filling a
            third of the viewport to say three things.

            `leading-none` for the hero ONLY. At inline size it collided with the caption's own
            `mt-1.5` below: zero line-height removes the descender space, so the two lines sat a
            pixel closer than every other label/value pair on the page. */}
        <span
          className={`font-mono tabular-nums text-ink ${
            size === "hero" ? "text-[18px] leading-none" : "text-[15px]"
          }`}
          // The figure is the thing a screenshot is taken of, so it carries its own full precision
          // for anybody who hovers — the displayed form is shortened past a thousand.
          title={empty ? def.empty : String(value)}
        >
          {formatMetric(def.unit, value)}
        </span>
        {!empty && <DeltaBadge delta={delta} />}
      </div>
      <div className="mt-1.5 text-[11px] leading-[1.45] text-muted">
        {context ?? (empty ? def.empty : def.context(RANGE_PROSE[range]))}
      </div>
    </div>
  );
}

/**
 * §3.3's badge: a signed percentage, coloured by what the movement MEANS.
 *
 * THREE TONES AND NO ARROW GLYPH. The sign carries the direction and the colour carries the verdict,
 * which is one mark doing one job each; an arrow as well would be a third encoding of the first one.
 *
 * `--` FOR NO COMPARISON, and it is rendered rather than hidden. §3.3: "A delta with no comparable
 * previous window renders `--`, not `0%` and not `100%`." An absent badge would read as "nothing
 * changed"; the dash reads as "there is nothing to compare with", which is the truth.
 */
export function DeltaBadge({ delta }: { delta: ReturnType<typeof deltaOf> }) {
  const tone = delta?.tone ?? "neutral";
  const color = tone === "good" ? STATUS.ok : tone === "bad" ? STATUS.error : TEXT.muted;
  return (
    <span
      className="font-mono text-[11px] tabular-nums leading-none"
      style={{ color }}
      title={
        delta
          ? `against the previous equivalent window`
          : `no comparable previous window`
      }
    >
      {delta ? formatDelta(delta) : EMPTY_FIGURE}
    </span>
  );
}

/**
 * The texture behind a figure. One hue, no axes, no fill under the line unless asked.
 *
 * DRAWN AS A `preserveAspectRatio="none"` VIEWBOX IN THE SERIES' OWN COORDINATES, so the component
 * never has to know its rendered pixel size. A sparkline that measured its container would need a
 * resize observer to stay correct inside a resizable panel, which is a lot of machinery for a shape
 * that is deliberately not precise.
 *
 * A FLAT SERIES DRAWS A FLAT LINE AT THE BOTTOM, NOT THROUGH THE MIDDLE. When every value is equal
 * the normalisation has no range to divide by, and centring it would draw a line that looks like a
 * steady non-zero level whatever the level actually is — including zero. Along the floor is the
 * honest shape for "nothing varied".
 *
 * AN EMPTY SERIES DRAWS NOTHING AT ALL (§3.5): "never an empty chart axis implying a flat line at
 * zero". The caller renders the card's empty state instead.
 */
export function Sparkline({
  values,
  hue = TEXT.faint,
  filled = false,
  className = "",
}: {
  values: readonly number[];
  hue?: string;
  filled?: boolean;
  className?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const W = 100;
  const H = 24;
  const x = (i: number): number => (i / (values.length - 1)) * W;
  const y = (v: number): number => (span === 0 ? H : H - ((v - min) / span) * H);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
      focusable="false"
    >
      {filled && (
        // The area is the same path closed along the floor, at a fraction of the stroke's opacity.
        // No gradient: §3.2's charts are one hue, and a gradient is two.
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={hue} opacity={0.08} />
      )}
      {/* `vectorEffect` keeps the stroke one pixel however the box is scaled — without it a sparkline
          stretched across a wide card draws a hairline vertically and a smear horizontally. */}
      <path
        d={line}
        fill="none"
        stroke={hue}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity={0.55}
      />
    </svg>
  );
}

/**
 * §5.3's quiet freshness line. Renders NOTHING when the figure is live or newly computed.
 *
 * "IF A FIGURE IS UP TO SIXTY SECONDS STALE, THE CARD SAYS SO QUIETLY. Do not present cached numbers
 * as live." Quietly is the operative word: this is 10px, faint, and in the card's header rather than
 * beside the figure, because a staleness note that competed with the number would suggest the number
 * is wrong. It is not wrong — it is a minute old, which is a different thing and usually fine.
 *
 * THE THRESHOLD IS FIVE SECONDS RATHER THAN ZERO. A cached figure served two seconds after it was
 * computed is not meaningfully behind, and a card that said "as of 1s ago" on every render would be
 * noise that teaches people to ignore the line on the day it says forty.
 */
export function FreshnessNote({ fresh, now = Date.now() }: { fresh: Freshness | null; now?: number }) {
  if (!fresh || fresh.live) return null;
  const at = Date.parse(fresh.computedAt);
  if (!Number.isFinite(at)) return null;
  // Never negative: the server's clock and this browser's are not the same clock, and "as of -1s
  // ago" is the kind of thing that makes somebody distrust every other number on the page.
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return null;
  return <span title={`computed at ${fresh.computedAt}`}>as of {seconds}s ago</span>;
}

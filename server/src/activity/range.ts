// The one window every figure on the Activity tab describes.
//
// THERE IS NO PER-CARD RANGE, and that is the load-bearing decision this module exists to make
// structural rather than remembered. §3.4's cross-highlighting — hover a leaderboard row, watch that
// agent's slice light up in Model Mix, its rows in the feed and its deploys in the timeline — is
// only coherent because all four are looking at the same seconds. A card that quietly kept its own
// window would break the highlight in a way nobody could see: the numbers would still be right, and
// they would be about different days.
//
// SO THE WINDOW IS RESOLVED ONCE, HERE, AND HANDED TO EVERY AGGREGATE. Ten modules take a `Window`
// rather than a range name, so none of them can decide what "7d" means, and none of them can drift
// from the other nine when somebody changes it.
//
// PURE, AND IN ITS OWN MODULE FOR THE REASON `agentHealth.ts` IS. Every rule below looks obviously
// right in a screenshot and is wrong in the case nobody had that day: a previous window that reaches
// back before the workspace existed, a custom range somebody inverted, a bucket count that turns a
// 30-day chart into eight hundred one-hour columns. A rule that lives inside a SELECT can only be
// exercised by standing a database up, so the query takes what this decides.

/** §1's control. Four values and no more — a fifth would be a fifth thing to be inconsistent about. */
export const ACTIVITY_RANGES = ["24h", "7d", "30d", "custom"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export function isActivityRange(v: unknown): v is ActivityRange {
  return typeof v === "string" && (ACTIVITY_RANGES as readonly string[]).includes(v);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long each named range is. `custom` has no fixed length and is absent on purpose. */
const SPAN_MS: Record<Exclude<ActivityRange, "custom">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

/**
 * The longest custom range this tab will answer.
 *
 * A YEAR, and the number is a bound on a SCAN rather than a product opinion. Every aggregate here is
 * `WHERE workspace_id = ? AND <time> >= ?` against an index whose second column is that time — so
 * the range IS the bound, and a request for "since 2019" is a request to read the whole table into
 * this process. Retention keeps traces for a month to a year by plan, so a year is also the most
 * that could ever answer with anything.
 *
 * Clamped rather than refused. Somebody who drags a date picker past the end of the data should see
 * everything there is, not an error about a limit they did not know existed.
 */
export const MAX_CUSTOM_SPAN_MS = 365 * DAY;

/** The narrowest custom range. Below a minute the buckets are shorter than a run. */
export const MIN_CUSTOM_SPAN_MS = MINUTE;

/**
 * A resolved window: the seconds this screen is about, and the seconds it is compared against.
 *
 * `from` IS INCLUSIVE AND `to` IS EXCLUSIVE, which is the convention every existing aggregate in
 * this codebase already uses (`started_at >= ?`, `occurred_at >= ?`). Stating it here rather than
 * per query is what stops one module counting a run twice at a bucket boundary while its neighbour
 * counts it never.
 */
export interface Window {
  range: ActivityRange;
  /** ISO-8601 UTC, inclusive. */
  from: string;
  /** ISO-8601 UTC, exclusive. */
  to: string;
  /** The equivalent window immediately before this one — §3.3's delta baseline. */
  previousFrom: string;
  previousTo: string;
  /** How wide one column of the pulse chart is, in ms. See `bucketFor`. */
  bucketMs: number;
  /**
   * Where the column grid starts: `from`, floored to a whole multiple of `bucketMs` since the
   * epoch.
   *
   * THE GRID IS ALIGNED AND THE WINDOW IS NOT, and the two are different things on purpose.
   *
   * A window is "the last seven days", which ends now and therefore begins at whatever o'clock it
   * happens to be. A COLUMN whose boundary is 14:37 is a column nobody can name, and §3.2's charts
   * are drawn bare — no gridlines, hairline axes only — so a column carries its meaning entirely in
   * where it starts. Aligning to the epoch puts six-hour columns on 00/06/12/18 and daily ones on
   * midnight, which is what somebody reading the chart already assumes.
   *
   * It also makes the fold from a grain cell to a column EXACT rather than approximate. `pulse`
   * groups in SQL by minute, hour or day — the three grains both dialects can produce with `substr`
   * — and every one of those is itself epoch-aligned and divides every width on the ladder. So a
   * grain cell always falls entirely inside one column. On an unaligned grid it would straddle two,
   * and a chart would be silently smeared by up to one bucket.
   *
   * THE FIRST AND LAST COLUMNS ARE PARTIAL, and that is correct rather than tolerated. Rows are
   * still bounded by `[from, to)` exactly, so the first column holds only the part of its hour that
   * is inside the window and the last holds only the part of the current hour that has happened.
   * The columns therefore still sum to the window's own totals, which is the property that matters:
   * a pulse chart that did not add up to the hero row above it would be two answers to one question.
   */
  bucketFrom: string;
  /** How many columns that produces, from `bucketFrom` to `to`. Bounded — see `bucketFor`. */
  buckets: number;
  /**
   * Whether this window is the live one (§5.5).
   *
   * ONLY `24h`. That is the range somebody watches while working, so it is computed on every
   * broadcast and never served from the cache; a 30-day aggregate re-run on every run completion
   * would be a full re-scan to move a figure by four decimal places.
   */
  live: boolean;
}

/**
 * How wide one bucket of the workspace-pulse series should be.
 *
 * TARGETED AT A COLUMN COUNT, NOT AT A DURATION, and that is why it is arithmetic rather than a
 * lookup table. A chart drawn bare — no gridlines, one hue, §3.2 — carries its resolution entirely
 * in the width of its columns, so the honest target is "as many columns as a card can show without
 * them becoming lines". Under about two dozen and the shape of a week disappears; over about ninety
 * and a column is a pixel and the chart is a smear.
 *
 * The named ranges land on round numbers by construction — 24h on the hour, 7d on six hours, 30d on
 * the day — because a bucket boundary somebody cannot name is a bucket boundary they will not trust.
 * A custom span falls through to the nearest of those that keeps the count in band.
 */
export const BUCKET_TARGET = { min: 24, max: 96 } as const;

/** The bucket widths this tab will use, coarsest first. Round numbers, on purpose — see above. */
const BUCKET_LADDER = [7 * DAY, DAY, 12 * HOUR, 6 * HOUR, 3 * HOUR, HOUR, 15 * MINUTE, 5 * MINUTE];

export function bucketFor(spanMs: number): { bucketMs: number; buckets: number } {
  const span = Math.max(MIN_CUSTOM_SPAN_MS, spanMs);
  // THE COARSEST WIDTH THAT STILL CARRIES ENOUGH COLUMNS, which is why the ladder is walked this
  // way round. Finest-first picks the narrowest acceptable width instead, and that is how 24h ends
  // up drawn in fifteen-minute columns: a legal count, ninety-six of them, and a boundary nobody
  // reading the chart could name. Coarsest-first lands the three named ranges on the hour, on six
  // hours and on the day, which is what the comment above claims and what somebody would expect.
  for (const bucketMs of BUCKET_LADDER) {
    const buckets = Math.ceil(span / bucketMs);
    if (buckets >= BUCKET_TARGET.min && buckets <= BUCKET_TARGET.max) return { bucketMs, buckets };
  }
  // Nothing on the ladder is in band, which happens at both ends and means two different things.
  //
  // TOO SHORT — an hour, say — and even five-minute columns cannot reach two dozen. Fewer columns
  // is the honest answer there: a one-hour window genuinely has twelve five-minute periods in it,
  // and manufacturing ninety-six by dividing the span would produce a 37.5-second bucket, which is
  // a boundary that means nothing and a chart that reads as noise.
  const finest = BUCKET_LADDER[BUCKET_LADDER.length - 1]!;
  if (Math.ceil(span / finest) < BUCKET_TARGET.min) {
    return { bucketMs: finest, buckets: Math.max(1, Math.ceil(span / finest)) };
  }
  // TOO LONG — past about eighteen months, which `MAX_CUSTOM_SPAN_MS` already forbids and which is
  // handled anyway rather than left to produce a hundred and fifty columns. Divide the span.
  const bucketMs = Math.max(MIN_CUSTOM_SPAN_MS, Math.ceil(span / BUCKET_TARGET.max));
  return { bucketMs, buckets: Math.ceil(span / bucketMs) };
}

/** A custom range as the client asks for it. Both ends, both ISO-8601. */
export interface CustomRange {
  from: string;
  to: string;
}

/**
 * Resolve a range name into the window every module reads.
 *
 * `now` IS A PARAMETER rather than read from the clock, for the reason every dated helper in this
 * codebase takes one: a suite that cannot fix the moment can only assert that two numbers are close,
 * and "close" is what a bucket-boundary bug looks like.
 *
 * A MALFORMED OR INVERTED CUSTOM RANGE FALLS BACK TO 7d rather than throwing. This resolves a value
 * that arrived over a socket, and the two honest answers to `from: "yesterday"` are a refusal on a
 * channel that has an error shape, or the default window — never an exception on the read path that
 * every card on the screen is waiting for. The caller learns which it got from `range`.
 */
export function resolveWindow(range: ActivityRange, now: Date, custom?: CustomRange | null): Window {
  const end = now.getTime();

  if (range === "custom") {
    const from = Date.parse(custom?.from ?? "");
    const to = Date.parse(custom?.to ?? "");
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      const span = Math.min(MAX_CUSTOM_SPAN_MS, Math.max(MIN_CUSTOM_SPAN_MS, to - from));
      // Anchored on the END the caller chose, so clamping a very long range shortens its reach
      // backwards rather than moving the window somebody was looking at.
      return windowOf("custom", to - span, to, span);
    }
    return resolveWindow("7d", now, null);
  }

  const span = SPAN_MS[range];
  return windowOf(range, end - span, end, span);
}

function windowOf(range: ActivityRange, from: number, to: number, span: number): Window {
  const { bucketMs } = bucketFor(span);
  // Floored to the epoch grid — see `Window.bucketFrom`. The column count is then measured from
  // there rather than from `from`, so the grid covers the whole window and never stops short of it.
  const bucketFrom = Math.floor(from / bucketMs) * bucketMs;
  const buckets = Math.max(1, Math.ceil((to - bucketFrom) / bucketMs));
  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    // IMMEDIATELY BEFORE, AND EXACTLY AS LONG. §3.3's delta is "against the previous equivalent
    // window", and an equivalent window that were merely "the previous calendar month" would make a
    // 31-day month look 3% busier than a 30-day one for no reason anybody could see.
    previousFrom: new Date(from - span).toISOString(),
    previousTo: new Date(from).toISOString(),
    bucketMs,
    bucketFrom: new Date(bucketFrom).toISOString(),
    buckets,
    live: range === "24h",
  };
}

/**
 * The grain `pulse` groups by in SQL, chosen so a grain cell always fits inside one column.
 *
 * THREE GRAINS, BECAUSE `substr` IS THE ONLY DATE ARITHMETIC BOTH DIALECTS SPELL THE SAME WAY.
 * SQLite has `julianday` and Postgres has `EXTRACT(EPOCH FROM …)`, and a bucketing expression
 * written in either is a query that runs on one driver — which is the class of difference this
 * codebase has a whole conformance suite to prevent. An ISO-8601 timestamp sorts lexicographically
 * and truncates by character, so `substr(at, 1, 13)` is "the hour" on both, exactly.
 *
 * The fold from grain cells to columns then happens in JavaScript, over a bounded number of rows:
 * at most 120 minute cells (a grain only used for spans under two hours), at most 720 hour cells
 * (thirty days), at most 366 day cells. That is the whole reason for the grain — the alternative is
 * reading one row per RUN into this process, which for a busy month is tens of thousands.
 */
export type PulseGrain = "minute" | "hour" | "day";

export function grainFor(bucketMs: number): PulseGrain {
  if (bucketMs < 3_600_000) return "minute";
  if (bucketMs < 86_400_000) return "hour";
  return "day";
}

/** How many characters of an ISO-8601 timestamp one grain keeps, and what completes it again. */
export const GRAIN_PREFIX: Record<PulseGrain, { length: number; suffix: string }> = {
  minute: { length: 16, suffix: ":00.000Z" },
  hour: { length: 13, suffix: ":00:00.000Z" },
  day: { length: 10, suffix: "T00:00:00.000Z" },
};

/** A grain key back into the instant it names. The inverse of the `substr` the query does. */
export function grainInstant(grain: PulseGrain, key: string): string {
  return `${key}${GRAIN_PREFIX[grain].suffix}`;
}

/**
 * Whether a previous window exists to compare against (§3.3).
 *
 * "A workspace that is four days old has no previous 30 days", and the delta then renders `--`
 * rather than `0%` or `100%`. Both of those are claims: `0%` says nothing changed, `100%` says
 * everything is new, and the truth is that there is nothing to compare with.
 *
 * THE TEST IS THE WORKSPACE'S AGE, not whether the previous window happens to be empty. A workspace
 * that existed and did nothing last week genuinely did nothing, and a token count that doubled
 * against a real zero is a real doubling — reporting that as "no comparison" would hide the most
 * interesting week a workspace ever has. What is not comparable is a window that predates the
 * workspace itself.
 *
 * Unknown creation time reads as comparable. That is the direction to be wrong in: the alternative
 * is every delta on the page rendering `--` because one lookup returned nothing.
 */
export function comparable(w: Window, workspaceCreatedAt: string | null | undefined): boolean {
  if (!workspaceCreatedAt) return true;
  const created = Date.parse(workspaceCreatedAt);
  if (!Number.isFinite(created)) return true;
  return Date.parse(w.previousFrom) >= created;
}

/**
 * Which column of the chart a moment belongs to, as an index into `bucketStarts`.
 *
 * THE GRID DECIDES THE COLUMN AND THE QUERY DECIDES MEMBERSHIP, and that division is worth stating
 * because getting it the other way round drops rows silently — which it did, once, before this
 * function was named for what it actually answers.
 *
 * `pulse` bounds its reads by the window exactly (`started_at >= from AND < to`), so anything that
 * reaches here is already known to be inside it. What it is asked about is a GRAIN CELL'S OWN
 * START, and for the first, partial column that instant is deliberately EARLIER than the window's
 * start: the window begins at 14:37 and the hour cell holding its first rows begins at 14:00. A
 * function that re-checked the window here would refuse that cell and quietly take its rows off the
 * chart while the total above the chart still counted them — a pulse band that did not add up to
 * its own hero row, which is the one thing a shared window exists to prevent.
 *
 * Outside the GRID is still -1, and that is not defensive either: a moment before `bucketFrom` or
 * at/after `to` has no column, and clamping it into the first or last one would pile whatever
 * produced it onto an edge and draw it as data.
 */
export function columnFor(w: Window, at: string): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return -1;
  const grid = Date.parse(w.bucketFrom);
  if (t < grid || t >= Date.parse(w.to)) return -1;
  return Math.min(w.buckets - 1, Math.floor((t - grid) / w.bucketMs));
}

/** The ISO start of each column, for a series that has to name its own x-axis. */
export function bucketStarts(w: Window): string[] {
  const grid = Date.parse(w.bucketFrom);
  return Array.from({ length: w.buckets }, (_, i) => new Date(grid + i * w.bucketMs).toISOString());
}

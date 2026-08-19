// §5.3's cache, as claims.
//
// FOUR RULES FROM THE SPECIFICATION AND ONE THAT IS NOT IN IT:
//
//   The freshness travels, so a card can say a figure is a minute old instead of implying it is now.
//   Invalidation happens on the events that move the numbers, not on the timer alone.
//   The 24h range is never cached, because it is the one people watch while working.
//   And nothing here is a materialised rollup, which §5.3 declines in this session.
//
//   SINGLE-FLIGHT is the fifth, and it is the one a cache of RESULTS cannot give you: ten sockets
//   connecting at once against a cold cache launch ten identical thirty-day scans in the same
//   millisecond, and by the time the first finishes the other nine are already running. Storing the
//   in-flight promise is what makes the tenth caller await the first caller's work.
//
// THE CLOCK IS INJECTED, so staleness is asserted rather than slept for. A suite that measured a
// sixty-second TTL by waiting sixty seconds is a suite nobody runs.
//
//   npm run test:activity-cache

import {
  ACTIVITY_CACHE_MAX,
  ACTIVITY_TTL_MS,
  ActivityCache,
  activityKey,
  stalenessSeconds,
} from "./cache.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

let clock = Date.parse("2026-08-19T12:00:00.000Z");
const now = (): number => clock;
const advance = (ms: number): void => { clock += ms; };

/** A computation that counts how many times it actually ran. */
function counted<T>(value: T): { run: () => Promise<T>; calls: () => number } {
  let n = 0;
  return { run: async () => { n++; return value; }, calls: () => n };
}

// --- the key ---------------------------------------------------------------------------------------

console.log("\nthe key identifies the answer, not the moment");
{
  // A window resolved a second later has different ends. Keying on them would miss every time.
  check("a named range keys on the range", activityKey("ws1", "7d") === "ws1:7d");
  check("two workspaces do not share an entry", activityKey("ws1", "7d") !== activityKey("ws2", "7d"));
  check("two ranges do not either", activityKey("ws1", "7d") !== activityKey("ws1", "30d"));

  // For a custom range the ends ARE the range, so two fortnights must not collide.
  const a = activityKey("ws1", "custom", { from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" });
  const b = activityKey("ws1", "custom", { from: "2026-07-01T00:00:00.000Z", to: "2026-07-15T00:00:00.000Z" });
  check("two custom ranges do not share an entry", a !== b);
  // ...but a picker emitting a fresh millisecond per keystroke must not fill the cache.
  const c = activityKey("ws1", "custom", { from: "2026-08-01T00:00:12.345Z", to: "2026-08-15T00:00:59.999Z" });
  const d = activityKey("ws1", "custom", { from: "2026-08-01T00:00:41.000Z", to: "2026-08-15T00:00:02.000Z" });
  check("...and the same minute is the same entry", c === d);
  // The workspace leads it, which is what makes invalidation a prefix match.
  check("the workspace leads the key", a.startsWith("ws1:"));
}

// --- the live range is never cached -------------------------------------------------------------------

console.log("\nthe 24h range is computed live, every time");
{
  const cache = new ActivityCache(now);
  const c = counted(42);
  const first = await cache.get("ws1:24h", true, c.run);
  const second = await cache.get("ws1:24h", true, c.run);

  check("both answers are correct", first.value === 42 && second.value === 42);
  check("both actually ran", c.calls() === 2);
  check("both say they are live", first.live && second.live);
  check("and nothing was stored", cache.size() === 0);
}

// --- a cached range is served, and says it was ----------------------------------------------------------

console.log("\na cached range is served with its age attached");
{
  const cache = new ActivityCache(now);
  const c = counted("thirty days of numbers");

  const first = await cache.get("ws1:30d", false, c.run);
  check("the first call computes", c.calls() === 1);
  check("...and does not claim to be live", !first.live);

  advance(30_000);
  const second = await cache.get("ws1:30d", false, c.run);
  check("half a minute later it is served from the cache", c.calls() === 1);
  check("...with the moment it was computed, not the moment it was served", second.computedAt === first.computedAt);
  check("...and it is thirty seconds old", stalenessSeconds(second.computedAt, now()) === 30);
  // §5.3: "Do not present cached numbers as live."
  check("...and says so", !second.live);

  advance(ACTIVITY_TTL_MS);
  const third = await cache.get("ws1:30d", false, c.run);
  check("past the TTL it computes again", c.calls() === 2);
  check("...and the age resets", stalenessSeconds(third.computedAt, now()) === 0);
}

// --- single-flight ------------------------------------------------------------------------------------------

console.log("\nten sockets connecting at once are one scan, not ten");
{
  const cache = new ActivityCache(now);
  let started = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = async (): Promise<string> => {
    started++;
    await gate;
    return "expensive";
  };

  const all = Promise.all(Array.from({ length: 10 }, () => cache.get("ws1:30d", false, slow)));
  // Every caller has now reached the cache; none of the work has finished.
  check("only one scan started", started === 1, `${started}`);
  release!();
  const results = await all;
  check("all ten got the answer", results.every((r) => r.value === "expensive"));
  check("...and still only one scan ran", started === 1);
  check("...and none of them calls itself live", results.every((r) => !r.live));
}

// --- invalidation on the events that move the numbers -----------------------------------------------------------

console.log("\na deploy landing drops the figures it would have moved");
{
  const cache = new ActivityCache(now);
  const seven = counted("7d");
  const thirty = counted("30d");
  const other = counted("someone else's");

  await cache.get("ws1:7d", false, seven.run);
  await cache.get("ws1:30d", false, thirty.run);
  await cache.get("ws2:30d", false, other.run);
  check("three entries", cache.size() === 3);

  cache.invalidate("ws1");
  check("both of this workspace's ranges are gone", cache.size() === 1);

  await cache.get("ws1:7d", false, seven.run);
  await cache.get("ws1:30d", false, thirty.run);
  check("...so both recompute", seven.calls() === 2 && thirty.calls() === 2);

  await cache.get("ws2:30d", false, other.run);
  // The other workspace's entry is untouched, which is the tenancy rule reaching the cache: one
  // tenant's deploy must not cost another tenant a scan, and must certainly not serve them a figure.
  check("and the other workspace's is untouched", other.calls() === 1);
}

// --- a failure is not remembered -------------------------------------------------------------------------------------

console.log("\na transient failure is not served for a minute");
{
  const cache = new ActivityCache(now);
  let attempts = 0;
  const flaky = async (): Promise<string> => {
    attempts++;
    if (attempts === 1) throw new Error("connection reset");
    return "recovered";
  };

  let threw = false;
  try { await cache.get("ws1:30d", false, flaky); } catch { threw = true; }
  check("the failure reaches the caller that triggered it", threw);
  check("...rather than becoming a silently empty dashboard", attempts === 1);
  check("nothing was remembered", cache.size() === 0);

  const after = await cache.get("ws1:30d", false, flaky);
  check("the next request tries again and succeeds", after.value === "recovered" && attempts === 2);
}

// --- the bound ---------------------------------------------------------------------------------------------------------

console.log("\nthe cache is bounded, because a long-lived process is a long time");
{
  const cache = new ActivityCache(now);
  for (let i = 0; i < ACTIVITY_CACHE_MAX + 40; i++) {
    await cache.get(`ws${i}:30d`, false, counted(i).run);
  }
  check(`it holds at most ${ACTIVITY_CACHE_MAX}`, cache.size() <= ACTIVITY_CACHE_MAX, `${cache.size()}`);
  // Oldest first, so the entries that survive are the ones most recently asked for.
  const survivors = await cache.get(`ws${ACTIVITY_CACHE_MAX + 39}:30d`, false, counted(-1).run);
  check("and the newest is still one of them", survivors.value !== -1);

  // Expired entries are swept on insert as well, so a quiet process does not hold a stale minute
  // of every workspace it ever served.
  advance(ACTIVITY_TTL_MS + 1);
  await cache.get("fresh:30d", false, counted("new").run);
  check("expiry sweeps the rest", cache.size() === 1, `${cache.size()}`);
}

// --- staleness never reads as the future ------------------------------------------------------------------------------------

console.log("\nan age is never negative");
{
  const future = new Date(now() + 5_000).toISOString();
  check("a clock a few seconds behind still reads as zero", stalenessSeconds(future, now()) === 0);
  check("and an unparseable stamp reads as zero rather than NaN", stalenessSeconds("whenever", now()) === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

// §5.3's cache, and the honest version of it.
//
// THE PROBLEM IS REAL. A thirty-day aggregate over a busy workspace reads runs, steps, usage rows,
// versions, deployments and audit rows, and every socket that connects asks for the whole tab at
// once. Ten tabs open on a Monday morning is ten identical full scans, and they arrive together.
//
// THE FOUR RULES §5.3 SETS, EACH IMPLEMENTED HERE RATHER THAN REMEMBERED:
//
//   SHOW THE FRESHNESS. A cached figure carries `computedAt`, and the card says so quietly when it
//   is behind. "Do not present cached numbers as live" is the whole point: this page is
//   screenshotted and quoted, and a number that is a minute old and says nothing is a number
//   somebody will quote as current.
//
//   INVALIDATE ON THE EVENTS THAT WOULD MOVE THEM, not on a timer alone. A run finishing, a deploy
//   landing, a version published — the control plane already broadcasts all of these, so the cache
//   listens rather than waiting out its TTL. A TTL alone means a workspace watching its own deploy
//   sees the old number for up to a minute after it lands.
//
//   THE 24h RANGE IS COMPUTED LIVE. It is the one people watch while working, and it is also the
//   cheapest to compute. `Window.live` says which, so the decision is made once in `range.ts` and
//   read here rather than being a second copy of the same condition.
//
//   AND NO MATERIALISED ROLLUP TABLE. §5.3 declines one explicitly in this session, and this is the
//   thing that stands in its place: a bounded in-process cache with a short life. If it turns out
//   not to be enough, the answer is measurements and a deliberate design, not a table snuck in.
//
// ONE MORE RULE THAT IS NOT IN THE SPECIFICATION AND IS THE REASON THIS IS A CLASS RATHER THAN A
// MAP: SINGLE-FLIGHT. Ten sockets connecting at once against a cold cache is ten scans launched in
// the same millisecond, and a cache that only stores RESULTS cannot prevent it — by the time the
// first one finishes, the other nine are already running. So the in-flight PROMISE is what is
// stored, and the tenth caller awaits the first caller's work.

/** How long a cached aggregate may be served for. §5.3: "up to sixty seconds stale". */
export const ACTIVITY_TTL_MS = 60_000;

/**
 * The most (workspace, range) pairs held at once.
 *
 * A BOUND, BECAUSE AN UNBOUNDED CACHE IN A LONG-LIVED PROCESS IS A LEAK WITH A NICER NAME. A gateway
 * serving a thousand workspaces, each asking for three ranges plus custom ones, would otherwise hold
 * every aggregate it ever computed until the process restarted. Evicted oldest-first on insert,
 * which is enough for a cache whose entries expire in a minute anyway — an LRU's bookkeeping would
 * cost more than it saves at this lifetime.
 */
export const ACTIVITY_CACHE_MAX = 256;

/** A value, and when it was true. The pair travels because the freshness is part of the answer. */
export interface Fresh<T> {
  value: T;
  /** ISO-8601. What the card's "as of" line is drawn from. */
  computedAt: string;
  /**
   * Whether this was computed for this request or served from the cache.
   *
   * A SEPARATE FIELD FROM THE AGE, because they answer different questions and a client that
   * derived one from the other would get it wrong at the boundary: a live 24h figure computed 900ms
   * ago is not "stale by a second", it is live, and a cached figure served 200ms after it was
   * computed is still cached. §5.3 asks the card not to present cached numbers as live, which is a
   * statement about provenance rather than about elapsed time.
   */
  live: boolean;
}

interface Entry {
  /** The in-flight or settled computation. See the header on single-flight. */
  work: Promise<unknown>;
  computedAt: number;
}

/**
 * The cache key.
 *
 * THE WINDOW'S OWN ENDS ARE NOT IN IT, and that is deliberate rather than sloppy. A window resolved
 * a second later has a different `from` and `to` — it is "the last 7 days" from a moment later — so
 * keying on them would produce a miss on every single request and a cache that never hits once.
 * What identifies the answer is the workspace and the RANGE, and the TTL is what bounds how far the
 * window may have moved underneath it.
 *
 * A CUSTOM RANGE KEYS ON ITS ENDS, because there the ends ARE the range: two people looking at two
 * different fortnights must not share an entry. They are truncated to the minute, so a picker that
 * emits a fresh millisecond on every render does not fill the cache with one entry per keystroke.
 */
export function activityKey(
  workspaceId: string,
  range: string,
  custom?: { from: string; to: string } | null,
): string {
  if (range !== "custom") return `${workspaceId}:${range}`;
  const cut = (s: string): string => s.slice(0, 16);
  return `${workspaceId}:custom:${cut(custom?.from ?? "")}:${cut(custom?.to ?? "")}`;
}

export class ActivityCache {
  private entries = new Map<string, Entry>();

  /** Injected so a suite can fix the clock. Every dated helper in this codebase takes one. */
  constructor(private now: () => number = () => Date.now()) {}

  /**
   * Answer from the cache, or compute and remember.
   *
   * `live` SHORT-CIRCUITS EVERYTHING. A live window is neither read from nor written to the cache:
   * writing it would let a later non-live request be served a value computed for a different
   * window, and reading it would be the 24h figure not being live, which is the one thing §5.3
   * asks of this range.
   *
   * A FAILED COMPUTATION IS NOT REMEMBERED. The entry is dropped when the promise rejects, so a
   * transient database error does not become a minute of the same error served to everyone. It
   * still rejects for the caller that triggered it — swallowing it would turn a broken query into a
   * silently empty dashboard.
   */
  async get<T>(key: string, live: boolean, compute: () => Promise<T>): Promise<Fresh<T>> {
    if (live) {
      return { value: await compute(), computedAt: new Date(this.now()).toISOString(), live: true };
    }

    const existing = this.entries.get(key);
    if (existing && this.now() - existing.computedAt < ACTIVITY_TTL_MS) {
      return {
        value: (await existing.work) as T,
        computedAt: new Date(existing.computedAt).toISOString(),
        // FALSE EVEN FOR THE CALLER THAT STARTED IT, and that is the honest answer rather than a
        // rounding of one. A second socket awaiting the first's in-flight work receives a figure
        // computed for a window resolved a moment before its own, which is exactly what "cached"
        // means here. Calling it live for whoever happened to arrive first would make the label
        // depend on the race rather than on the number.
        live: false,
      };
    }

    const computedAt = this.now();
    const work = compute();
    this.entries.set(key, { work, computedAt });
    this.evict();
    try {
      const value = (await work) as T;
      return { value, computedAt: new Date(computedAt).toISOString(), live: false };
    } catch (err) {
      // Only if it is still ours: a later request may already have replaced it after an invalidate.
      if (this.entries.get(key)?.work === work) this.entries.delete(key);
      throw err;
    }
  }

  /**
   * Drop everything this workspace has cached. §5.3's event-based invalidation.
   *
   * BY WORKSPACE RATHER THAN BY RANGE, because the events that move these figures move all of them:
   * a run finishing changes the 7-day spend, the 30-day leaderboard and every custom range that
   * contains it. Working out which ranges a moment falls inside would be arithmetic to avoid
   * recomputing something that costs a minute of staleness anyway.
   *
   * A PREFIX MATCH ON THE KEY, which is why the workspace id leads it — the same reason it leads
   * every index in this schema.
   */
  invalidate(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Everything, for a workspace switch in a test or a process-wide reset. */
  clear(): void {
    this.entries.clear();
  }

  /** How many entries are held. For the bound's own test, and for a gauge. */
  size(): number {
    return this.entries.size;
  }

  /** Oldest-first eviction, plus a sweep of anything already past its TTL. See ACTIVITY_CACHE_MAX. */
  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.computedAt >= ACTIVITY_TTL_MS) this.entries.delete(key);
    }
    while (this.entries.size > ACTIVITY_CACHE_MAX) {
      // Map iteration is insertion-ordered, so the first key is the oldest still held.
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * How stale a figure is, in whole seconds. What the card's quiet "as of" line renders.
 *
 * NEVER NEGATIVE. A cached value's `computedAt` is this process's clock and the client's is its
 * own; a browser a second behind would otherwise render "as of -1s ago", which is the kind of thing
 * that makes somebody distrust every other number on the page. The Inbox's tray line makes the same
 * guarantee for the same reason.
 */
export function stalenessSeconds(computedAt: string, now: number): number {
  const at = Date.parse(computedAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 1000));
}

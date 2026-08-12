// The numbers a dashboard reads, and the one whose expected value is zero.
//
// A METRIC IS A DIFFERENT INSTRUMENT FROM A TRACE, and this codebase now has both because they
// answer different questions. A trace explains ONE request: which four processes it touched, and
// where the four seconds went. A metric explains ALL of them: is the sandbox slower than it was
// yesterday, is the eval queue draining, did the error rate move when we deployed. Neither
// substitutes for the other, and the usual mistake is to try — sampling a trace makes it useless
// as a rate, and aggregating a counter makes it useless as an explanation.
//
// PROMETHEUS TEXT EXPOSITION, and again the protocol is not reinvented: `/metrics` answers in the
// format every scraper on earth already parses. What is written here is the registry — four
// instrument types, labels, and a renderer — because the alternative is a client library in the
// request path of a server whose whole design is that there is not one.
//
// FOUR INSTRUMENTS, AND THE CHOICE BETWEEN THEM IS NOT COSMETIC:
//
//   COUNTER only goes up. Rates are computed from it by the scraper, which is why a counter must
//   never be reset — a counter that resets looks like a rate spike to every query built on it.
//
//   GAUGE is a level: queue depth, active sandboxes, workspaces suspended. Sampled, not summed.
//
//   HISTOGRAM is a distribution, and it is what makes a p95 possible at all. An average latency
//   is the least useful number in observability: it hides exactly the tail that users notice.
//
//   The buckets are explicit and per-metric, because a bucket set that does not straddle the
//   interesting value gives a p95 that is a bucket boundary rather than a measurement.
//
// THE CROSS-TENANT DENIAL COUNTER IS THE ONE THAT MATTERS. Its expected value is zero, forever,
// and the alert on it fires on any non-zero value — see obs/slo.ts. Every other metric here is
// about how well the platform is working; that one is about whether its central promise held.

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  name: string;
  kind: MetricKind;
  /** Shown by every scraper next to the value. A sentence, not a restatement of the name. */
  help: string;
  /** Label names this metric carries. A metric's labels are fixed; a stray one is a new series. */
  labels?: readonly string[];
  /** Histogram bucket upper bounds, in the metric's own unit. Required for histograms. */
  buckets?: readonly number[];
}

/**
 * Every metric this system exports, in one table.
 *
 * The fifth table of this shape in the codebase, for the same reason as the other four: the
 * useful question is "what do we measure", asked of all of them at once. It is also what lets
 * `obs/slo.ts` assert that every alert names a metric that exists — an alert on a metric nobody
 * emits is an alert that never fires, which is worse than no alert because it looks like cover.
 */
export const METRICS = {
  // --- the promise ------------------------------------------------------------------------
  cross_tenant_denials_total: {
    name: "jaroku_cross_tenant_denials_total",
    kind: "counter",
    help: "Attempts to act in a workspace the actor is not a member of. EXPECTED VALUE: zero.",
    labels: ["reason"],
  },

  // --- runs -------------------------------------------------------------------------------
  runs_total: {
    name: "jaroku_runs_total",
    kind: "counter",
    help: "Runs that reached a terminal state, by status. Success rate is the ratio of these.",
    labels: ["status", "kind"],
  },
  sandbox_start_seconds: {
    name: "jaroku_sandbox_start_seconds",
    kind: "histogram",
    help: "Time from asking for a sandbox to the process being ready to receive work.",
    labels: ["sandbox"],
    // Straddling the interesting region: a local subprocess starts in tens of milliseconds and a
    // Fly machine in a few seconds. Buckets past 30s exist because the number that matters when
    // something is wrong is how far past the SLO it went, not that it was over.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  },
  active_sandboxes: {
    name: "jaroku_active_sandboxes",
    kind: "gauge",
    help: "Sandboxes currently running. The number capacity planning is done against.",
  },

  // --- the trace pipeline -----------------------------------------------------------------
  trace_ingest_lag_seconds: {
    name: "jaroku_trace_ingest_lag_seconds",
    kind: "histogram",
    help: "Time between a step being emitted in a sandbox and being persisted.",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 60],
  },
  trace_ingest_dropped_total: {
    name: "jaroku_trace_ingest_dropped_total",
    kind: "counter",
    help: "Trace lines that could not be parsed or were refused. Never silently discarded.",
    labels: ["reason"],
  },

  // --- the queue --------------------------------------------------------------------------
  queue_depth: {
    name: "jaroku_queue_depth",
    kind: "gauge",
    help: "Jobs waiting, by class. What workers autoscale on — never CPU.",
    labels: ["class"],
  },
  queue_oldest_pending_seconds: {
    name: "jaroku_queue_oldest_pending_seconds",
    kind: "gauge",
    help: "Age of the oldest waiting job, by class. Depth without this hides a starved workspace.",
    labels: ["class"],
  },

  // --- money and providers ------------------------------------------------------------------
  provider_errors_total: {
    name: "jaroku_provider_errors_total",
    kind: "counter",
    help: "Failed calls to a model provider, by provider and classification.",
    labels: ["provider", "class"],
  },
  workspace_spend_usd: {
    name: "jaroku_workspace_spend_usd",
    kind: "gauge",
    help: "Spend this period, by payer. A FLOOR when any of it is unpriced — unknown is not zero.",
    labels: ["payer"],
  },

  // --- abuse and enforcement ------------------------------------------------------------------
  abuse_signals_total: {
    name: "jaroku_abuse_signals_total",
    kind: "counter",
    help: "Abuse observations recorded, by kind.",
    labels: ["kind"],
  },
  workspaces_enforced: {
    name: "jaroku_workspaces_enforced",
    kind: "gauge",
    help: "Workspaces currently under an enforcement rung, by level.",
    labels: ["level"],
  },
  rate_limited_total: {
    name: "jaroku_rate_limited_total",
    kind: "counter",
    help: "Requests and commands refused by a rate limit, by action.",
    labels: ["action"],
  },

  // --- the HTTP surface ------------------------------------------------------------------------
  http_requests_total: {
    name: "jaroku_http_requests_total",
    kind: "counter",
    help: "Requests answered, by route and status class.",
    labels: ["route", "status"],
  },
  http_request_seconds: {
    name: "jaroku_http_request_seconds",
    kind: "histogram",
    help: "How long a request took to answer, by route.",
    labels: ["route"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },

  // --- the data lifecycle -----------------------------------------------------------------------
  steps_default_partition_rows: {
    name: "jaroku_steps_default_partition_rows",
    kind: "gauge",
    help: "Steps in the DEFAULT partition. Non-zero means retention cannot drop them by month.",
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;

export type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
  /** Histograms only: counts per bucket, plus a sum. */
  buckets?: number[];
  sum?: number;
  count?: number;
}

/**
 * Everything measured, in one process.
 *
 * A module-level default instance plus a constructible class, for the same reason the logger has
 * both: production wants one registry and the suites want a fresh one per test. Metrics are
 * process-local and are aggregated by the scraper across replicas, which is why nothing here
 * talks to Redis — a "global" counter maintained across replicas would be a distributed counter
 * with all of the cost and none of the correctness.
 */
export class MetricsRegistry {
  private series = new Map<string, Map<string, Series>>();

  /** Add to a counter. Never negative — a counter that goes down is a broken rate everywhere. */
  increment(name: MetricName, labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error(`a counter cannot decrease: ${name}`);
    const s = this.seriesFor(name, labels);
    s.value += by;
  }

  /** Set a gauge to what it currently is. */
  set(name: MetricName, value: number, labels: Labels = {}): void {
    this.seriesFor(name, labels).value = value;
  }

  /** Record one observation into a histogram. */
  observe(name: MetricName, value: number, labels: Labels = {}): void {
    const def = METRICS[name];
    if (def.kind !== "histogram") throw new Error(`${name} is not a histogram`);
    const s = this.seriesFor(name, labels);
    const bounds = (def as MetricDefinition).buckets ?? [];
    s.buckets ??= new Array(bounds.length).fill(0);
    for (let i = 0; i < bounds.length; i++) {
      if (value <= bounds[i]!) s.buckets[i]! += 1;
    }
    s.sum = (s.sum ?? 0) + value;
    s.count = (s.count ?? 0) + 1;
  }

  /** One series' current value, for tests and for a health endpoint that wants one number. */
  value(name: MetricName, labels: Labels = {}): number {
    const key = labelKey(labels);
    const found = this.series.get(name)?.get(key);
    if (!found) return 0;
    return METRICS[name].kind === "histogram" ? (found.count ?? 0) : found.value;
  }

  /** Everything, in Prometheus text exposition format. What `/metrics` answers. */
  render(): string {
    const out: string[] = [];
    for (const [name, def] of Object.entries(METRICS) as [MetricName, MetricDefinition][]) {
      const series = this.series.get(name);
      if (!series || series.size === 0) continue;
      out.push(`# HELP ${def.name} ${def.help}`);
      out.push(`# TYPE ${def.name} ${def.kind}`);
      for (const s of series.values()) {
        if (def.kind === "histogram") {
          const bounds = def.buckets ?? [];
          for (let i = 0; i < bounds.length; i++) {
            out.push(`${def.name}_bucket${renderLabels({ ...s.labels, le: String(bounds[i]) })} ${s.buckets?.[i] ?? 0}`);
          }
          // `+Inf` is required: without it a scraper cannot tell how many observations fell past
          // the last bucket, and every quantile it computes is wrong in the tail.
          out.push(`${def.name}_bucket${renderLabels({ ...s.labels, le: "+Inf" })} ${s.count ?? 0}`);
          out.push(`${def.name}_sum${renderLabels(s.labels)} ${s.sum ?? 0}`);
          out.push(`${def.name}_count${renderLabels(s.labels)} ${s.count ?? 0}`);
        } else {
          out.push(`${def.name}${renderLabels(s.labels)} ${s.value}`);
        }
      }
    }
    return `${out.join("\n")}\n`;
  }

  /** Forget everything. For tests; a running process never resets a counter — see the header. */
  reset(): void {
    this.series.clear();
  }

  private seriesFor(name: MetricName, labels: Labels): Series {
    // Read through the interface rather than through the literal's inferred type: `as const
    // satisfies` keeps every metric's exact shape, which is what makes `METRICS.x.help` a string
    // literal — and also means the metrics WITHOUT labels have no `labels` property at all to
    // read. One widening here, at the only place that asks the question generically.
    const def = METRICS[name] as MetricDefinition;
    const declared = new Set(def.labels ?? []);
    for (const key of Object.keys(labels)) {
      if (!declared.has(key)) {
        // A stray label is a NEW SERIES, forever, and the usual way a metrics backend's
        // cardinality explodes is a label somebody added with a run id in it. Refused loudly at
        // the point of the mistake rather than discovered on an invoice.
        throw new Error(`${name} has no label "${key}" — declared: ${[...declared].join(", ") || "none"}`);
      }
    }
    let bucket = this.series.get(name);
    if (!bucket) {
      bucket = new Map();
      this.series.set(name, bucket);
    }
    const key = labelKey(labels);
    let s = bucket.get(key);
    if (!s) {
      s = { labels, value: 0 };
      bucket.set(key, s);
    }
    return s;
  }
}

/** Labels in a stable order, so the same set is always the same series. */
function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    // Escaped per the exposition format: a backslash, a quote or a newline in a label value
    // would otherwise end the value and produce a line no scraper can parse.
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
  return `{${rendered}}`;
}

/** The process's registry. */
export const metrics = new MetricsRegistry();

/** Which status class a code belongs to, as a label. Full codes would be needless cardinality. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/**
 * A route as a metric label, with the variable parts removed.
 *
 * `/v1/runs/<uuid>/control` becomes `/v1/runs/:id/control`. Without this every run id in the
 * system becomes its own series and the metrics backend falls over — the single most common way
 * a `/metrics` endpoint becomes an outage.
 */
export function routeLabel(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{22,}(?=\/|$)/g, "/:id")
    .slice(0, 100);
}

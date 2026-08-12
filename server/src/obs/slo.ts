// What "working" means as a number, and what wakes somebody up when it stops being true.
//
// AN SLO IS A DECISION, NOT A MEASUREMENT. "The p95 sandbox start is under ten seconds" is a
// promise somebody made about how the product should feel, and it belongs in a file that takes a
// pull request to change — not in a dashboard somebody edited during an incident. The same
// reasoning that puts plan limits in `billing/plans.ts` and job concurrency in `queue/jobs.ts`.
//
// EVERY ALERT NAMES A METRIC THAT EXISTS, and the suite asserts it. An alert on a metric nobody
// emits never fires, which is strictly worse than having no alert: it looks like cover. That
// check is the entire reason these are structured objects rather than a hand-written YAML file.
//
// SEVERITY IS ABOUT WHO IS WOKEN, and it is deliberately coarse:
//
//   `page`   somebody is woken now. Reserved for the promise being broken and for the product
//            being down. There are four.
//   `ticket` somebody looks at it during working hours.
//   `watch`  it goes on a dashboard and nothing is sent. Most of them.
//
// THE FIRST ALERT IS THE ONE THAT MATTERS. `cross_tenant_denials_total` has an expected value of
// zero, and its alert fires on ANY non-zero value with no threshold and no window — because the
// question it answers is not "how bad is this" but "did the thing this whole migration exists to
// guarantee just fail". A rate threshold on it would be a decision that some cross-tenant access
// attempts are acceptable.

import { METRICS, type MetricName } from "./metrics.ts";

export type Severity = "page" | "ticket" | "watch";

export interface Slo {
  id: string;
  /** What is being promised, in a sentence somebody outside the team could read. */
  objective: string;
  /** The metric it is measured on. Checked against the registry by the suite. */
  metric: MetricName;
  /** The target, in the metric's own unit. `null` when the objective is simply "zero". */
  target: number | null;
  /** How the target is read: a quantile, a ratio, or an absolute ceiling. */
  kind: "quantile" | "ratio" | "absolute";
  /** For a quantile objective. 0.95 means p95. */
  quantile?: number;
  /** The window an SLO is evaluated over. Alerts may use a shorter one. */
  window: string;
}

export interface Alert {
  id: string;
  severity: Severity;
  metric: MetricName;
  /** PromQL. Rendered into the alerting rules file; readable on its own. */
  expr: string;
  /** How long the condition must hold before it fires. Empty for "immediately". */
  forDuration: string;
  /** What the person woken up is told, and what they should do first. */
  summary: string;
  runbook: string;
}

export const SLOS: readonly Slo[] = [
  {
    id: "tenant-isolation",
    objective: "No request ever succeeds in a workspace the actor is not a member of.",
    metric: "cross_tenant_denials_total",
    target: null,
    kind: "absolute",
    window: "always",
  },
  {
    id: "run-success-rate",
    objective: "99% of interactive runs reach a terminal state without a platform error.",
    metric: "runs_total",
    target: 0.99,
    kind: "ratio",
    window: "28d",
  },
  {
    id: "sandbox-start-p95",
    objective: "A sandbox is ready to receive work within 10 seconds, 95% of the time.",
    metric: "sandbox_start_seconds",
    target: 10,
    kind: "quantile",
    quantile: 0.95,
    window: "28d",
  },
  {
    id: "trace-ingest-lag-p95",
    objective: "A step is persisted within 2 seconds of being emitted, 95% of the time.",
    metric: "trace_ingest_lag_seconds",
    target: 2,
    kind: "quantile",
    quantile: 0.95,
    window: "7d",
  },
  {
    id: "api-latency-p95",
    objective: "An API request is answered within 500ms, 95% of the time.",
    metric: "http_request_seconds",
    target: 0.5,
    kind: "quantile",
    quantile: 0.95,
    window: "28d",
  },
  {
    id: "queue-freshness",
    objective: "No eval job waits more than 5 minutes before being admitted.",
    metric: "queue_oldest_pending_seconds",
    target: 300,
    kind: "absolute",
    window: "7d",
  },
];

export const ALERTS: readonly Alert[] = [
  {
    id: "CrossTenantDenial",
    severity: "page",
    metric: "cross_tenant_denials_total",
    // ANY increase, over any minute. No threshold, deliberately — see the header.
    expr: `increase(jaroku_cross_tenant_denials_total[5m]) > 0`,
    forDuration: "",
    summary: "Somebody was refused access to a workspace they are not a member of.",
    runbook:
      "This should never fire. Find the audit_log rows with action='workspace.access_denied' for " +
      "the window, identify the actor, and establish whether it is a probe, a bug in a client, or " +
      "a real attempt. The refusal itself worked — this alert is about knowing it happened.",
  },
  {
    id: "SandboxStartSlow",
    severity: "page",
    metric: "sandbox_start_seconds",
    expr: `histogram_quantile(0.95, sum(rate(jaroku_sandbox_start_seconds_bucket[10m])) by (le)) > 10`,
    forDuration: "15m",
    summary: "Sandboxes are taking more than 10s at p95 to become ready.",
    runbook:
      "Check the substrate's own status first (Fly machine creation), then whether the image " +
      "digest changed in the last deploy — a cold image is the usual cause. Runs still work; they " +
      "start slowly, so this is a page rather than a ticket only because it precedes a queue backup.",
  },
  {
    id: "TraceIngestBacklog",
    severity: "page",
    metric: "trace_ingest_lag_seconds",
    expr: `histogram_quantile(0.95, sum(rate(jaroku_trace_ingest_lag_seconds_bucket[10m])) by (le)) > 30`,
    forDuration: "10m",
    summary: "Steps are taking more than 30s to be persisted.",
    runbook:
      "The trace is the product; a run whose steps arrive minutes late is a run nobody can watch. " +
      "Check database write latency and the ingest batch size. At-least-once delivery means " +
      "nothing is lost while this is firing — it is late, not gone.",
  },
  {
    id: "RunFailureRate",
    severity: "page",
    metric: "runs_total",
    expr:
      `sum(rate(jaroku_runs_total{status="error"}[15m])) / clamp_min(sum(rate(jaroku_runs_total[15m])), 0.001) > 0.1`,
    forDuration: "15m",
    summary: "More than 10% of runs are ending in error.",
    runbook:
      "Distinguish a provider outage (see jaroku_provider_errors_total by provider) from a " +
      "platform fault. A provider's bad afternoon is not ours to fix and should be visible on the " +
      "status page rather than paged on; anything else is.",
  },
  {
    id: "QueueStarvation",
    severity: "ticket",
    metric: "queue_oldest_pending_seconds",
    expr: `max(jaroku_queue_oldest_pending_seconds) > 900`,
    forDuration: "10m",
    summary: "A job has been waiting more than 15 minutes.",
    runbook:
      "Depth alone does not show this — one workspace's 500-job eval can leave another's single " +
      "job waiting while the ring rotates. Check the fairness ratio in the load-test report and " +
      "whether worker replicas are healthy.",
  },
  {
    id: "DefaultPartitionFilling",
    severity: "ticket",
    metric: "steps_default_partition_rows",
    expr: `jaroku_steps_default_partition_rows > 0`,
    forDuration: "1h",
    summary: "Steps are landing in the DEFAULT partition.",
    runbook:
      "Rows there cannot be dropped by month, so the retention promise is quietly not being kept " +
      "for them. Usually means the partition-ensuring job has not run. Create the missing months " +
      "and move the rows, in that order.",
  },
  {
    id: "ProviderErrorRate",
    severity: "ticket",
    metric: "provider_errors_total",
    expr: `sum(rate(jaroku_provider_errors_total[10m])) by (provider) > 1`,
    forDuration: "15m",
    summary: "A model provider is failing more than one call a second.",
    runbook: "Check the provider's status page before anything else. Then whether one workspace's key is being rate limited.",
  },
  {
    id: "AbuseSpike",
    severity: "ticket",
    metric: "abuse_signals_total",
    expr: `sum(increase(jaroku_abuse_signals_total[1h])) by (kind) > 50`,
    forDuration: "",
    summary: "An unusual number of abuse signals in the last hour.",
    runbook:
      "Not necessarily abuse: a detector that has started misfiring produces exactly this shape. " +
      "Check which kind, and whether it is one workspace or many, before touching an enforcement.",
  },
  {
    id: "EnforcementWave",
    severity: "ticket",
    metric: "workspaces_enforced",
    expr: `sum(jaroku_workspaces_enforced) > 20`,
    forDuration: "30m",
    summary: "An unusual number of workspaces are under an enforcement rung.",
    runbook:
      "The ladder is automatic up to `verify`, so a mis-tuned weight can limit a lot of people at " +
      "once. Compare against the signal counts; if the signals are flat and the enforcements are " +
      "not, the thresholds are wrong rather than the customers.",
  },
  {
    id: "RateLimitSurge",
    severity: "watch",
    metric: "rate_limited_total",
    expr: `sum(rate(jaroku_rate_limited_total[5m])) by (action) > 5`,
    forDuration: "10m",
    summary: "A lot of requests are being refused by a rate limit.",
    runbook: "Usually a client with a retry loop. Check whether it is one address or many before changing a limit.",
  },
];

export interface RenderedObservability {
  version: number;
  generatedFrom: string;
  slos: readonly Slo[];
  /** Prometheus alerting rules, in the shape a `rule_files:` entry expects. */
  groups: {
    name: string;
    rules: {
      alert: string;
      expr: string;
      for?: string;
      labels: { severity: Severity; metric: string };
      annotations: { summary: string; runbook: string };
    }[];
  }[];
}

/** The alerting rules and the SLOs, as one deterministic document. See abuse/edgeRules.ts. */
export function renderObservability(): RenderedObservability {
  return {
    version: 1,
    generatedFrom: "server/src/obs/slo.ts",
    slos: SLOS,
    groups: [
      {
        name: "jaroku",
        rules: ALERTS.map((a) => ({
          alert: a.id,
          expr: a.expr,
          ...(a.forDuration ? { for: a.forDuration } : {}),
          labels: { severity: a.severity, metric: METRICS[a.metric].name },
          annotations: { summary: a.summary, runbook: a.runbook },
        })),
      },
    ],
  };
}

export function renderObservabilityJson(): string {
  return `${JSON.stringify(renderObservability(), null, 2)}\n`;
}

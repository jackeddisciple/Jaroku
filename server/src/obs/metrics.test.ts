// The instruments, the exposition format, and the alert that must never fire.
//
// TWO PROPERTIES ARE WORTH MORE THAN THE REST:
//
//   EVERY ALERT NAMES A METRIC THAT EXISTS, and every PromQL expression names the metric its rule
//   claims to be about. An alert on a metric nobody emits never fires — which is strictly worse
//   than no alert, because it looks like cover. This is the check that a YAML file edited by hand
//   cannot have.
//
//   A LABEL THAT WAS NEVER DECLARED IS REFUSED. The standard way a metrics bill becomes an
//   incident is somebody adding a label with a run id in it; every distinct value is a new series
//   forever. Refusing at the call site is the only place that mistake is cheap.
//
//   npm run test:metrics

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METRICS, MetricsRegistry, routeLabel, statusClass, type MetricName } from "./metrics.ts";
import { ALERTS, SLOS, renderObservabilityJson } from "./slo.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nthe metric table");
{
  const names = Object.values(METRICS).map((m) => m.name);
  check(new Set(names).size === names.length, "every metric has a unique exported name");
  check(names.every((n) => /^jaroku_[a-z0-9_]+$/.test(n)), "...namespaced and in snake_case, as the format wants");
  check(
    Object.values(METRICS).every((m) => m.help.length > 20),
    "every metric says what it is in a sentence — a scraper shows this next to the number",
  );
  check(
    Object.values(METRICS)
      .filter((m) => m.kind === "counter")
      .every((m) => m.name.endsWith("_total")),
    "counters end in _total, which is the convention every dashboard assumes",
  );
  check(
    Object.values(METRICS)
      .filter((m) => m.kind === "histogram")
      .every((m) => (m.buckets?.length ?? 0) > 3 && m.name.endsWith("_seconds")),
    "histograms have buckets and name their unit — a p95 with no unit is a number nobody can act on",
  );
  check(
    METRICS.cross_tenant_denials_total.help.toLowerCase().includes("zero"),
    "the cross-tenant counter says in its own help text that its expected value is zero",
  );
}

console.log("\ncounters, gauges, histograms");
{
  const r = new MetricsRegistry();
  r.increment("cross_tenant_denials_total", { reason: "not_a_member" });
  r.increment("cross_tenant_denials_total", { reason: "not_a_member" });
  check(r.value("cross_tenant_denials_total", { reason: "not_a_member" }) === 2, "a counter counts");
  check(r.value("cross_tenant_denials_total", { reason: "other" }) === 0, "...per label set");

  let refusedNegative = false;
  try {
    r.increment("runs_total", { status: "ok", kind: "interactive" }, -1);
  } catch {
    refusedNegative = true;
  }
  check(refusedNegative, "a counter cannot be decreased — a counter that goes down is a broken rate everywhere");

  r.set("queue_depth", 12, { class: "run.eval" });
  r.set("queue_depth", 3, { class: "run.eval" });
  check(r.value("queue_depth", { class: "run.eval" }) === 3, "a gauge is a level, not a sum");

  for (const v of [0.02, 0.2, 2, 20]) r.observe("sandbox_start_seconds", v, { sandbox: "fly" });
  check(r.value("sandbox_start_seconds", { sandbox: "fly" }) === 4, "a histogram counts its observations");

  let refusedKind = false;
  try {
    r.observe("queue_depth", 1, { class: "x" });
  } catch {
    refusedKind = true;
  }
  check(refusedKind, "...and only a histogram can be observed into");
}

console.log("\ncardinality");
{
  const r = new MetricsRegistry();
  let refused = false;
  try {
    // The classic: a run id as a label. Every run becomes a series, forever.
    r.increment("runs_total", { status: "ok", kind: "interactive", run_id: "run-1234" } as never);
  } catch {
    refused = true;
  }
  check(refused, "AN UNDECLARED LABEL IS REFUSED — this is how a metrics bill becomes an incident");

  check(routeLabel("/v1/runs/4bf92f35-77b3-4da6-a3ce-929d0e0e4736/control") === "/v1/runs/:id/control", "a uuid in a path is collapsed");
  check(routeLabel("/v1/workspace/export/4bf92f35-77b3-4da6-a3ce-929d0e0e4736") === "/v1/workspace/export/:id", "...wherever it appears");
  check(routeLabel("/v1/objects/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") === "/v1/objects/:id", "...as is an opaque key");
  check(routeLabel("/healthz") === "/healthz", "and an ordinary path is left alone");
  check(statusClass(404) === "4xx" && statusClass(200) === "2xx", "a status becomes its class, not its code");
}

console.log("\nexposition");
{
  const r = new MetricsRegistry();
  r.increment("http_requests_total", { route: "/healthz", status: "2xx" }, 3);
  r.set("active_sandboxes", 7);
  r.observe("http_request_seconds", 0.03, { route: "/v1/ws-ticket" });
  const text = r.render();

  check(text.includes("# TYPE jaroku_http_requests_total counter"), "each metric declares its type");
  check(text.includes("# HELP jaroku_active_sandboxes"), "...and its help");
  check(text.includes(`jaroku_http_requests_total{route="/healthz",status="2xx"} 3`), "a counter renders with its labels");
  check(text.includes("jaroku_active_sandboxes 7"), "a gauge with no labels renders bare");
  check(text.includes(`jaroku_http_request_seconds_bucket{le="+Inf",route="/v1/ws-ticket"} 1`), "a histogram has an +Inf bucket");
  check(text.includes("jaroku_http_request_seconds_sum"), "...a sum");
  check(text.includes("jaroku_http_request_seconds_count"), "...and a count");
  check(text.endsWith("\n"), "the body ends with a newline, which the format requires");

  const nasty = new MetricsRegistry();
  nasty.increment("provider_errors_total", { provider: 'we"ird\nvalue', class: "timeout" });
  const line = nasty.render().split("\n").find((l) => l.startsWith("jaroku_provider_errors_total"))!;
  check(!line.includes('"we"ird'), "a quote in a label value is escaped rather than ending the value");
  check(!line.includes("\n\n"), "...and a newline cannot split the line in two");
}

console.log("\nSLOs and alerts");
{
  const known = new Set(Object.keys(METRICS) as MetricName[]);
  check(SLOS.every((s) => known.has(s.metric)), "every SLO is measured on a metric that exists");
  check(ALERTS.every((a) => known.has(a.metric)), "EVERY ALERT NAMES A METRIC THAT EXISTS");
  check(
    ALERTS.every((a) => a.expr.includes(METRICS[a.metric].name)),
    "...and its expression is actually about that metric",
  );
  check(ALERTS.every((a) => a.runbook.length > 60), "every alert carries a runbook, not just a title");
  check(new Set(ALERTS.map((a) => a.id)).size === ALERTS.length, "alert ids are unique");
  check(
    SLOS.every((s) => (s.kind === "quantile" ? typeof s.quantile === "number" : true)),
    "a quantile objective says which quantile",
  );

  const paging = ALERTS.filter((a) => a.severity === "page");
  check(paging.length <= 5, `only ${paging.length} alerts page — an alert that wakes somebody is a promise about their sleep`);

  const isolation = ALERTS.find((a) => a.id === "CrossTenantDenial")!;
  check(isolation.severity === "page", "a cross-tenant denial pages");
  check(isolation.expr.includes("> 0"), "...on ANY non-zero value");
  check(isolation.forDuration === "", "...immediately, with no window to ride out");
  check(
    !/> *[1-9]/.test(isolation.expr.replace("> 0", "")),
    "...and with no threshold, because a threshold would say some cross-tenant attempts are fine",
  );
  check(SLOS.find((s) => s.id === "tenant-isolation")!.target === null, "and its objective is zero rather than a number");
}

console.log("\nthe committed file");
{
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "observability", "alerts.json");
  let onDisk: string | null = null;
  try {
    onDisk = readFileSync(path, "utf8");
  } catch {
    onDisk = null;
  }
  check(onDisk !== null, "deploy/observability/alerts.json exists");
  check(onDisk === renderObservabilityJson(), "...and is what the tables render to — `npm run obs:render` if this fails");
}

// --- an alert on a metric nobody emits ---------------------------------------------------------

console.log("\nevery alerted metric is actually emitted");

// METRICS.TS SAYS THIS IN ITS OWN HEADER and the codebase was not checking it: "an alert on a
// metric nobody emits is an alert that never fires, which is worse than no alert because it looks
// like cover." What was checked is that an alert names a metric that exists IN THE TABLE. Five
// alerted metrics existed in the table and were emitted by nothing at all — including the
// ingestion-lag and queue SLOs, both of which the spec names.
//
// A metric is only real where something calls `increment`, `observe` or `set` on it, so the check
// is a read of the server's own source. Structural for the usual reason: index.ts is a script
// that opens sockets on import, and the emission sites are spread across it, the worker and the
// repositories.
{
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && p !== join(SRC, "obs", "metrics.ts")) {
        sources.push(readFileSync(p, "utf8"));
      }
    }
  };
  walk(SRC);
  const all = sources.join("\n");
  const emits = (name: string): boolean =>
    new RegExp(`\\.(?:increment|observe|set)\\(\\s*"${name}"`).test(all);

  /**
   * Declared, alerted, and NOT YET EMITTED — recorded rather than left to be discovered.
   *
   * Each needs a source of numbers that does not exist yet, which is why none of them is a
   * one-line fix and why leaving them silently dead was the wrong shape. Recording them here is
   * the same choice escapeSuite.test.ts makes about the gaps it cannot close: an explicit line
   * somebody reads, rather than a green tick over an alert that cannot fire.
   */
  const NOT_YET_EMITTED: Record<string, string> = {
    queue_oldest_pending_seconds:
      "needs a backend that can report the age of the oldest pending job; QueueBackend only answers pendingCount per workspace",
    sandbox_start_seconds:
      "needs a timing hook around sandbox acquisition, which the Fly and local sandboxes would both have to carry",
    provider_errors_total:
      "needs the provider call sites to classify a failure by provider rather than logging it",
  };

  const alerted = new Set<string>([...ALERTS.map((a) => a.metric), ...SLOS.map((s) => s.metric)]);
  check(alerted.size >= 8, `${alerted.size} metrics carry an alert or an SLO`);

  const dead = [...alerted].filter((m) => !emits(m) && !(m in NOT_YET_EMITTED)).sort();
  check(dead.length === 0, `every alerted metric has an emission site (${dead.join(", ") || "all do"})`);

  // The recorded gaps have to stay honest in both directions: one that has since been wired is a
  // line telling the next reader that a working alert does not work.
  const wired = Object.keys(NOT_YET_EMITTED).filter((m) => emits(m)).sort();
  check(wired.length === 0, `...and nothing recorded as unwired is in fact wired (${wired.join(", ") || "none is"})`);
  const notAlerted = Object.keys(NOT_YET_EMITTED).filter((m) => !alerted.has(m)).sort();
  check(notAlerted.length === 0, `...and each recorded gap is still an alerted metric (${notAlerted.join(", ") || "all are"})`);

  // And the reader can still find one, or it would report that everything is emitted forever.
  check(emits("http_requests_total"), "the reader finds a metric that IS emitted");
  check(!emits("jaroku_not_a_metric_at_all"), "...and does not find one that is not");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

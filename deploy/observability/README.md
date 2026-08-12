# Observability

Three instruments, answering three different questions.

| | Question | Where |
|---|---|---|
| **Logs** | *What happened, in words?* | Structured JSON, redacted at the sink — `server/src/obs/log.ts` |
| **Traces** | *Where did this one request's four seconds go, across four processes?* | OTLP/HTTP — `server/src/obs/trace.ts` |
| **Metrics** | *Is the platform working, across all of them?* | Prometheus text on `/metrics` — `server/src/obs/metrics.ts` |

None substitutes for another. A sampled trace is useless as a rate; an aggregated counter is
useless as an explanation.

## What is in this directory

| File | What |
|---|---|
| `alerts.json` | **Generated.** Do not edit. The rendered form of `server/src/obs/slo.ts` — the SLO table and the Prometheus alerting rules. |

```bash
cd server
npm run obs:render            # rewrite alerts.json from the tables
npm run obs:render -- --check # fail if it is out of date  (the deploy pipeline runs this)
npm run test:metrics          # asserts every alert names a metric that is actually emitted
```

The `groups` array is shaped for a Prometheus `rule_files:` entry; convert to YAML with any JSON
→ YAML step in your pipeline, or feed the JSON directly to an Alertmanager provisioning API that
accepts it.

## Scraping

`GET /metrics` answers the Prometheus text exposition format.

- **Authenticated when `JAROKU_METRICS_TOKEN` is set**, with a constant-time comparison, and
  **refused entirely under `NODE_ENV=production` when it is not**. Queue depths, spend and
  enforcement counts are a description of the business; an unauthenticated `/metrics` on a public
  origin publishes it.
- Metrics are **per process**. Aggregation across replicas is the scraper's job — a counter
  synchronised across replicas would be a distributed counter with all of the cost and none of
  the correctness.

## The alert that matters

`CrossTenantDenial` fires on **any** non-zero value, immediately, with no threshold and no
window. Every other alert here is about how well the platform is working. That one is about
whether the promise this entire migration exists to keep — that no request ever succeeds in a
workspace the actor is not a member of — has held. A rate threshold on it would be a decision
that some cross-tenant access attempts are acceptable.

When it fires, the refusal already worked: nobody read anything. What the alert is for is
knowing it was attempted. The audit rows are `action = 'workspace.access_denied'` for the same
window.

## Severities

| | Meaning | Count |
|---|---|---|
| `page` | Somebody is woken now | 4 |
| `ticket` | Somebody looks during working hours | 4 |
| `watch` | Dashboard only; nothing is sent | 1 |

An alert that wakes somebody is a promise about their sleep, and the number of them is kept small
on purpose. A paging alert with no runbook is not merged — every entry in the table carries one,
and `test:metrics` asserts it is more than a restatement of the title.

// One trace, four tiers, and the id that joins them.
//
// THE SCENARIO IS THE TEST. A request arrives at a gateway, enqueues work, a worker on another
// machine picks it up, and a sandbox on a third machine calls home — and the assertion is that
// all four spans share one trace id, form the right parent chain, and every one of them carries
// the run id. That is the thing a trace is FOR, and it is the thing that breaks silently when
// context propagation is subtly wrong.
//
//   npm run test:tracing

import {
  OtlpExporter,
  Tracer,
  formatTraceparent,
  parseTraceparent,
  toOtlp,
  type FinishedSpan,
} from "./trace.ts";
import { protectSecret, resetProtection } from "./log.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nW3C trace context");
{
  const ctx = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
  check(formatTraceparent(ctx) === "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "a context formats as the spec writes it");
  check(formatTraceparent({ ...ctx, sampled: false }).endsWith("-00"), "...with the sampled flag in the flags byte");

  const round = parseTraceparent(formatTraceparent(ctx));
  check(round?.traceId === ctx.traceId && round?.spanId === ctx.spanId && round.sampled, "and parses back to itself");
  check(parseTraceparent(undefined) === null, "an absent header is no context");
  check(parseTraceparent("garbage") === null, "...as is a malformed one");
  check(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`) === null, "...as is the spec's own invalid trace id");
  check(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`) === null, "...and an invalid parent span id");
  check(
    parseTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")?.traceId === ctx.traceId,
    "a header from a caller that shouted is still a header",
  );
}

console.log("\nfour tiers, one trace");
{
  const spans: FinishedSpan[] = [];
  const collect = (s: FinishedSpan[]): void => void spans.push(...s);
  const runId = "run-4f2c";

  // 1. The gateway, with no incoming traceparent: this is a root.
  const gateway = new Tracer({ tier: "gateway", export: collect, sampleRatio: 1 });
  const request = gateway.start("POST /v1/runs", { attributes: { "jaroku.run_id": runId, "http.route": "/v1/runs" } });

  // 2. The queue, as a child, in the same process.
  const enqueue = gateway.start("enqueue run.eval", { parent: request.context, tier: "queue", attributes: { "jaroku.run_id": runId } });
  enqueue.end();

  // 3. A WORKER IN ANOTHER PROCESS, which has only the header the job carried.
  const carried = formatTraceparent(request.context);
  const worker = new Tracer({ tier: "worker", export: collect, sampleRatio: 0 /* would not sample a root */ });
  const job = worker.start("run.eval", { parent: parseTraceparent(carried), attributes: { "jaroku.run_id": runId } });

  // 4. And the sandbox, which received the same header in its environment.
  const sandbox = new Tracer({ tier: "sandbox", export: collect, sampleRatio: 0 });
  const call = sandbox.start("POST /v1/runs/:id/trace", {
    parent: parseTraceparent(formatTraceparent(job.context)),
    attributes: { "jaroku.run_id": runId },
  });
  call.end();
  job.end();
  request.end();

  check(spans.length === 4, `all four tiers produced a span (${spans.length})`);
  check(new Set(spans.map((s) => s.context.traceId)).size === 1, "ONE TRACE ID ACROSS ALL FOUR");
  check(
    spans.every((s) => s.attributes["jaroku.run_id"] === runId),
    "...and every span carries the run id, which is the correlating attribute",
  );
  check(new Set(spans.map((s) => s.attributes["jaroku.tier"])).size === 4, "...each naming its own tier");

  const byName = new Map(spans.map((s) => [s.name, s]));
  check(byName.get("enqueue run.eval")!.parentSpanId === request.context.spanId, "the queue span is the request's child");
  check(byName.get("run.eval")!.parentSpanId === request.context.spanId, "the worker's job is too, across a process boundary");
  check(byName.get("POST /v1/runs/:id/trace")!.parentSpanId === job.context.spanId, "and the sandbox's call is the job's child");
  check(byName.get("POST /v1/runs")!.parentSpanId === undefined, "the root has no parent");

  // The point of head sampling: the worker's own ratio is zero, and it still recorded, because
  // the decision came down the wire. A tier that decided for itself would leave holes.
  check(
    byName.get("run.eval")!.context.sampled,
    "A CHILD INHERITS THE SAMPLING DECISION — a tier deciding for itself puts holes in traces",
  );
}

console.log("\nsampling");
{
  const spans: FinishedSpan[] = [];
  const never = new Tracer({ tier: "gateway", export: (s) => spans.push(...s), sampleRatio: 0 });
  never.start("dropped", {}).end();
  check(spans.length === 0, "an unsampled root exports nothing");

  const always = new Tracer({ tier: "gateway", export: (s) => spans.push(...s), sampleRatio: 1 });
  always.start("kept", {}).end();
  check(spans.length === 1, "...and a sampled one does");

  const half = new Tracer({ tier: "gateway", export: () => {}, sampleRatio: 0.5, random: () => 0.4 });
  check(half.start("x", {}).context.sampled, "a ratio is a comparison against the roll, not a coin flip per span");
}

console.log("\nfailures and double-ends");
{
  const spans: FinishedSpan[] = [];
  const tracer = new Tracer({ tier: "worker", export: (s) => spans.push(...s), sampleRatio: 1 });

  resetProtection();
  protectSecret("sk-a-registered-credential-value", "PROVIDER_KEY");
  await tracer
    .in("job", { attributes: { "jaroku.run_id": "r1" } }, () => {
      throw new Error("provider rejected sk-a-registered-credential-value");
    })
    .catch(() => {});
  check(spans[0]!.status === "error", "a throw inside a span marks it failed");
  // Serialised the way the exporter does — timestamps are BigInt, which JSON.stringify refuses.
  check(
    !JSON.stringify(toOtlp([spans[0]!])).includes("sk-a-registered"),
    "AND THE MESSAGE IS REDACTED — a collector is a third party",
  );
  check(spans[0]!.errorMessage?.includes("provider rejected") === true, "...while the rest of it survives");
  check(spans[0]!.attributes["error"] === true, "...and the span is marked");

  const span = tracer.start("once", {});
  span.end();
  span.end();
  check(spans.length === 2, "ending twice does not produce a second span");
  resetProtection();
}

console.log("\nthe OTLP payload");
{
  const spans: FinishedSpan[] = [];
  const tracer = new Tracer({ tier: "gateway", serviceName: "jaroku-gateway", export: (s) => spans.push(...s), sampleRatio: 1 });
  const s = tracer.start("GET /healthz", { attributes: { "http.status_code": 200, "jaroku.cached": true, "jaroku.ratio": 0.5 } });
  s.end();

  const body = toOtlp(spans) as { resourceSpans: Record<string, any>[] };
  const resource = body.resourceSpans[0]!;
  check(resource.resource.attributes[0].key === "service.name", "the resource names the service");
  const span = resource.scopeSpans[0].spans[0];
  check(/^[0-9a-f]{32}$/.test(span.traceId), "the trace id is 32 hex characters, as OTLP wants it");
  check(/^[0-9a-f]{16}$/.test(span.spanId), "...and the span id 16");
  check(typeof span.startTimeUnixNano === "string", "times are nanosecond STRINGS — a JS number cannot hold one");
  check(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano), "...and end is not before start");
  const attrs = new Map<string, any>(span.attributes.map((a: Record<string, any>) => [a.key as string, a.value]));
  check(attrs.get("http.status_code").intValue === "200", "an integer attribute is an intValue string");
  check(attrs.get("jaroku.cached").boolValue === true, "a boolean is a boolValue");
  check(attrs.get("jaroku.ratio").doubleValue === 0.5, "and a fraction is a doubleValue");
  check(span.status.code === 0, "an ordinary span's status is unset rather than ok");
}

console.log("\nthe exporter");
{
  const sent: unknown[] = [];
  const exporter = new OtlpExporter("http://collector.invalid/v1/traces", {
    flushIntervalMs: 3_600_000,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch,
  });

  const tracer = new Tracer({ tier: "gateway", export: (s) => exporter.accept(s), sampleRatio: 1 });
  for (let i = 0; i < 3; i++) tracer.start(`span-${i}`, {}).end();
  check(exporter.stats().queued === 3, "spans queue rather than posting one request each");
  await exporter.flush();
  check(sent.length === 1, "...and leave in one batch");
  check(exporter.stats().queued === 0, "...leaving the queue empty");
  await exporter.flush();
  check(sent.length === 1, "flushing an empty queue sends nothing");

  // A collector having a bad afternoon costs visibility and nothing else.
  const failing = new OtlpExporter("http://collector.invalid/v1/traces", {
    flushIntervalMs: 3_600_000,
    fetchImpl: (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch,
    log: () => {},
  });
  failing.accept([{ ...({} as FinishedSpan) }]);
  await failing.flush();
  check(failing.stats().failed === 1, "a failed export is counted rather than retried into a storm");
  failing.close();

  const bounded = new OtlpExporter("http://collector.invalid/v1/traces", { maxQueue: 2, flushIntervalMs: 3_600_000 });
  const t2 = new Tracer({ tier: "gateway", export: (s) => bounded.accept(s), sampleRatio: 1 });
  for (let i = 0; i < 5; i++) t2.start(`s${i}`, {}).end();
  check(bounded.stats().queued === 2, "the queue is bounded");
  check(bounded.stats().dropped === 3, "...and what it drops is counted, not silent");
  bounded.close();
  exporter.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

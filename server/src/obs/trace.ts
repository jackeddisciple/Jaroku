// Spans across four tiers, and the id that ties them together.
//
// THE PROBLEM THIS SOLVES IS NOT "WE HAVE NO LOGS". It is that one user action now touches four
// processes: a gateway replica answers the request, a queue holds the work, a worker on another
// machine picks it up, and a sandbox on a third machine executes it. Four `requestId`s in four
// log streams describe the same second of somebody's afternoon, and nothing joins them. A trace
// is the join.
//
// WRITTEN RATHER THAN INSTALLED, and the reason is the one this codebase gives every time: the
// OpenTelemetry SDK is a large dependency in the request path, it monkey-patches modules to
// auto-instrument, and what is actually needed here is a span with a parent, W3C context
// propagation, and an OTLP exporter — which is this file. What is NOT reimplemented is the
// PROTOCOL: `traceparent` is the W3C spec's, and the export payload is OTLP/HTTP JSON, so any
// collector — Honeycomb, Tempo, Jaeger, Datadog — receives it without a translator.
//
// THE RUN ID IS THE CORRELATING ATTRIBUTE, per the migration spec. Every span that has anything
// to do with a run carries `jaroku.run_id`, so "show me everything that happened for this run"
// is one query across all four tiers — including the sandbox's, because the run's environment
// carries a `TRACEPARENT` and the runner's control-plane calls come back in the same trace.
//
// SAMPLING IS A HEAD DECISION AND IS INHERITED. The gateway decides once, at the root, and the
// `sampled` flag rides the traceparent everywhere else. A worker that sampled independently
// would produce traces with holes in them — the most confusing possible artefact, because a
// missing span reads as a step that did not happen.
//
// AND EVERY ATTRIBUTE GOES THROUGH THE REDACTOR. A span attribute is a log line with a different
// shape and a different destination, and the destination is a third party. `obs/log.ts` already
// owns that decision; this defers to it rather than making a second one.

import { randomBytes } from "node:crypto";
import { redactValue } from "./log.ts";

export const OTLP_ENDPOINT_ENV = "JAROKU_OTLP_ENDPOINT";
export const OTLP_HEADERS_ENV = "JAROKU_OTLP_HEADERS";
export const SAMPLE_RATIO_ENV = "JAROKU_TRACE_SAMPLE";
export const SERVICE_NAME_ENV = "JAROKU_SERVICE_NAME";

/** The four tiers, named once so a query can group by them. */
export type Tier = "gateway" | "queue" | "worker" | "sandbox";

export interface SpanContext {
  /** 32 hex characters. The same across all four tiers. */
  traceId: string;
  /** 16 hex characters. This span's own id, and its children's parent. */
  spanId: string;
  /** Head-sampled at the root and inherited unchanged. See the header. */
  sampled: boolean;
}

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface FinishedSpan {
  name: string;
  tier: Tier;
  context: SpanContext;
  parentSpanId?: string;
  startedAtNs: bigint;
  endedAtNs: bigint;
  attributes: SpanAttributes;
  /** OTLP's status codes: 0 unset, 1 ok, 2 error. Only `error` is ever set explicitly. */
  status: "unset" | "error";
  errorMessage?: string;
}

export interface Span {
  readonly context: SpanContext;
  /** Add an attribute after the fact — a status code, a row count, a decision. */
  set(key: string, value: string | number | boolean | undefined): void;
  /** Mark it failed. The message is redacted like everything else. */
  fail(err: unknown): void;
  end(): void;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

/** A span id that means "no span". OTLP's own convention, and what a root has as its parent. */
const NO_SPAN = "0".repeat(16);

// --- W3C trace context --------------------------------------------------------------------------

/**
 * `traceparent`, exactly as the W3C spec writes it: `00-<32 hex>-<16 hex>-<2 hex flags>`.
 *
 * Parsed strictly. A malformed header is not a reason to fail a request, and it is also not a
 * reason to trust it — an all-zero trace id is the spec's own "invalid", and a header from a
 * caller we do not control could be anything at all. Invalid means "start a new trace", which is
 * the only behaviour that cannot be used to poison somebody else's.
 */
export function parseTraceparent(header: string | undefined): SpanContext | null {
  if (!header) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, traceId, spanId, flags] = m;
  if (traceId === "0".repeat(32) || spanId === NO_SPAN) return null;
  return { traceId: traceId!, spanId: spanId!, sampled: (parseInt(flags!, 16) & 0x01) === 1 };
}

export function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

// --- the tracer -----------------------------------------------------------------------------------

export interface TracerOptions {
  tier: Tier;
  serviceName?: string;
  /** 0 to 1. A head decision, made once per trace at whichever tier starts it. */
  sampleRatio?: number;
  /** Where finished spans go. Defaults to the OTLP exporter, or to nothing when unconfigured. */
  export?: (spans: FinishedSpan[]) => void;
  now?: () => bigint;
  random?: () => number;
}

export class Tracer {
  private tier: Tier;
  private serviceName: string;
  private sampleRatio: number;
  private exportSpans: (spans: FinishedSpan[]) => void;
  private now: () => bigint;
  private random: () => number;

  constructor(opts: TracerOptions) {
    this.tier = opts.tier;
    this.serviceName = opts.serviceName ?? process.env[SERVICE_NAME_ENV] ?? `jaroku-${opts.tier}`;
    const configured = Number(process.env[SAMPLE_RATIO_ENV]);
    this.sampleRatio = opts.sampleRatio ?? (Number.isFinite(configured) ? configured : 1);
    this.exportSpans = opts.export ?? (() => {});
    this.now = opts.now ?? nowNs;
    this.random = opts.random ?? Math.random;
  }

  /**
   * Start a span, as a child of `parent` when there is one and as a root when there is not.
   *
   * A ROOT'S SAMPLING IS DECIDED HERE AND NOWHERE ELSE. A child inherits, always — including
   * when the ratio has since changed, because a trace half of whose spans exist is worse than
   * one that does not.
   */
  start(
    name: string,
    opts: { parent?: SpanContext | null; attributes?: SpanAttributes; tier?: Tier } = {},
  ): Span {
    const parent = opts.parent ?? null;
    const context: SpanContext = {
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      sampled: parent ? parent.sampled : this.random() < this.sampleRatio,
    };
    const attributes: SpanAttributes = {
      "service.name": this.serviceName,
      "jaroku.tier": opts.tier ?? this.tier,
      ...(opts.attributes ?? {}),
    };
    const startedAtNs = this.now();
    let ended = false;
    let status: "unset" | "error" = "unset";
    let errorMessage: string | undefined;

    return {
      context,
      set: (key, value) => {
        attributes[key] = value;
      },
      fail: (err) => {
        status = "error";
        // Through the same redactor every log line goes through. A span attribute is a log line
        // with a different shape and a WORSE destination — somebody else's collector.
        errorMessage = String(redactValue((err as Error)?.message ?? err));
        attributes["error"] = true;
      },
      end: () => {
        // Ending twice is a no-op rather than a second span. A `finally` that ends a span the
        // handler already ended is ordinary code, not a bug worth reporting.
        if (ended) return;
        ended = true;
        if (!context.sampled) return;
        this.exportSpans([
          {
            name,
            tier: (opts.tier ?? this.tier) as Tier,
            context,
            parentSpanId: parent?.spanId,
            startedAtNs,
            endedAtNs: this.now(),
            attributes: redactValue(attributes) as SpanAttributes,
            status,
            errorMessage,
          },
        ]);
      },
    };
  }

  /** Run `fn` inside a span, ending it whatever happens and recording a throw as a failure. */
  async in<T>(
    name: string,
    opts: { parent?: SpanContext | null; attributes?: SpanAttributes; tier?: Tier },
    fn: (span: Span) => Promise<T> | T,
  ): Promise<T> {
    const span = this.start(name, opts);
    try {
      return await fn(span);
    } catch (err) {
      span.fail(err);
      throw err;
    } finally {
      span.end();
    }
  }
}

// --- the exporter ------------------------------------------------------------------------------

/**
 * OTLP/HTTP JSON, batched.
 *
 * BATCHED AND FIRE-AND-FORGET, because the alternative is a request path that waits on an
 * observability vendor. A collector having a bad afternoon must cost visibility and nothing else
 * — so the queue is bounded, the oldest spans are dropped when it is full, and a failed export is
 * a counter rather than a retry storm. Losing spans is the correct failure mode for telemetry;
 * losing requests is not.
 *
 * The timer is unref'd for the reason every timer in this codebase is: telemetry must never be
 * the thing holding a process open.
 */
export class OtlpExporter {
  private queue: FinishedSpan[] = [];
  private dropped = 0;
  private failed = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private endpoint: string,
    private opts: {
      headers?: Record<string, string>;
      maxQueue?: number;
      flushIntervalMs?: number;
      fetchImpl?: typeof fetch;
      log?: (line: string) => void;
    } = {},
  ) {
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 5_000);
    this.timer.unref?.();
  }

  accept(spans: FinishedSpan[]): void {
    const max = this.opts.maxQueue ?? 2048;
    for (const span of spans) {
      if (this.queue.length >= max) {
        this.queue.shift();
        this.dropped++;
      }
      this.queue.push(span);
    }
  }

  /** Send what is queued. Safe to call at any time; a no-op when there is nothing. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
        body: JSON.stringify(toOtlp(batch)),
      });
      if (!res.ok) {
        this.failed++;
        this.opts.log?.(`[otel] collector answered ${res.status}; ${batch.length} span(s) dropped`);
      }
    } catch (err) {
      this.failed++;
      this.opts.log?.(`[otel] export failed: ${(err as Error)?.message ?? err}`);
    }
  }

  stats(): { queued: number; dropped: number; failed: number } {
    return { queued: this.queue.length, dropped: this.dropped, failed: this.failed };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** The OTLP/HTTP JSON body. Shaped by the spec, not by preference. */
export function toOtlp(spans: readonly FinishedSpan[]): Record<string, unknown> {
  const byService = new Map<string, FinishedSpan[]>();
  for (const span of spans) {
    const service = String(span.attributes["service.name"] ?? "jaroku");
    const list = byService.get(service) ?? [];
    list.push(span);
    byService.set(service, list);
  }
  return {
    resourceSpans: [...byService.entries()].map(([service, list]) => ({
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeSpans: [
        {
          scope: { name: "jaroku", version: "1" },
          spans: list.map((s) => ({
            traceId: s.context.traceId,
            spanId: s.context.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name,
            // 1 = INTERNAL. Every span here is work this system did; a CLIENT/SERVER distinction
            // would be a claim about who called whom that the tier attribute already makes.
            kind: 1,
            startTimeUnixNano: s.startedAtNs.toString(),
            endTimeUnixNano: s.endedAtNs.toString(),
            attributes: Object.entries(s.attributes)
              .filter(([, v]) => v !== undefined)
              .map(([key, value]) => ({ key, value: otlpValue(value!) })),
            status: s.status === "error" ? { code: 2, message: s.errorMessage ?? "" } : { code: 0 },
          })),
        },
      ],
    })),
  };
}

function otlpValue(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

/**
 * The tracer this process uses: exporting when a collector is configured, inert when it is not.
 *
 * Inert rather than absent, which is what keeps the call sites free of `if (tracing)`. An
 * unconfigured deployment builds spans that end immediately and go nowhere — a few objects per
 * request, and the alternative is every instrumented line growing a conditional.
 */
export function openTracer(tier: Tier, env: NodeJS.ProcessEnv = process.env): { tracer: Tracer; exporter?: OtlpExporter } {
  const endpoint = env[OTLP_ENDPOINT_ENV];
  if (!endpoint) return { tracer: new Tracer({ tier, sampleRatio: 0 }) };
  const exporter = new OtlpExporter(endpoint, { headers: parseHeaders(env[OTLP_HEADERS_ENV]) });
  return { tracer: new Tracer({ tier, export: (spans) => exporter.accept(spans) }), exporter };
}

/** `key=value,key2=value2` — the same spelling `OTEL_EXPORTER_OTLP_HEADERS` uses. */
function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

// A dropped trace event is a gap in what the server knows about a run — worth counting, per the
// migration spec's own instruction ("Add a trace_ingest_dropped counter rather than silently
// discarding"), because a run that is quietly losing every event looks, from history and the
// dashboard alone, identical to one that simply had a quiet run. A counter is the difference
// between "nobody noticed" and "there is a number that would have told them".

export interface DropReason {
  runId: string;
  reason: string;
}

export class TraceIngestMetrics {
  private droppedTotal = 0;
  private droppedByRun = new Map<string, number>();

  get dropped(): number {
    return this.droppedTotal;
  }

  droppedFor(runId: string): number {
    return this.droppedByRun.get(runId) ?? 0;
  }

  recordDropped({ runId, reason }: DropReason): void {
    this.droppedTotal++;
    this.droppedByRun.set(runId, (this.droppedByRun.get(runId) ?? 0) + 1);
    console.warn(`[trace-ingest] dropped an event for run ${runId}: ${reason}`);
  }
}

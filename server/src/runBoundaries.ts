// Which checkpoint a step belongs to, whatever order the step and its boundary arrive in.
//
// BRANCHING NEEDS EVERY STEP STAMPED WITH THE CHECKPOINT AFTER ITS NODE. A `boundary` control line
// says "checkpoint C covers everything up to seq N", and the store stamped the steps already written
// with seq ≤ N and no checkpoint yet. That held while a run's stdout was its only channel, because the
// boundary always came after the steps it covered. A run on somebody's desktop app pushes its steps
// and its control lines over two separate HTTP routes, and the runner sent each boundary at once
// while it batched the steps — so a boundary landed before its steps, stamped nothing, and the next
// boundary stamped them instead; by the end every step carried the last checkpoint, and "Branch a
// run from here" on the first node branched from the end of the run and re-ran nothing.
//
// So the boundaries a live run has announced are kept here, and a step that arrives after its
// boundary is stamped on arrival with the earliest boundary that covers it. In memory, for the run's
// life: a step arrives while its run is live, and the runner sends everything before it exits.

interface Boundary {
  seqHigh: number;
  checkpointId: string;
}

export class RunBoundaries {
  private byRun = new Map<string, Boundary[]>();

  /** A boundary a run announced: checkpoint `checkpointId` covers its steps up to `seqHigh`. */
  note(runId: string, seqHigh: number, checkpointId: string): void {
    const list = this.byRun.get(runId) ?? [];
    list.push({ seqHigh, checkpointId });
    list.sort((a, b) => a.seqHigh - b.seqHigh);
    this.byRun.set(runId, list);
  }

  /** The checkpoint a step belongs to — the earliest boundary at or after its seq — if one has been announced. */
  checkpointFor(runId: string, seq: number): string | undefined {
    return this.byRun.get(runId)?.find((b) => b.seqHigh >= seq)?.checkpointId;
  }

  /** The run's process is gone; nothing more of it will arrive. */
  forget(runId: string): void {
    this.byRun.delete(runId);
  }

  /** How many runs are being kept, for a test to see that an ended one is dropped. */
  get size(): number {
    return this.byRun.size;
  }
}

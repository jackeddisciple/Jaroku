// A live run's "now", read on the run's own clock.
//
// A RUN'S TIMES ARE THE RUNNER'S AND THEY ARRIVE LATE. A step is stamped where it ran and reaches
// this app after a trip through the server — on a desktop run, after waiting in the runner's batch
// for the event behind it. Elapsed was `Date.now()` less the run's start, so it ran ahead of the run
// by that trip: 10.1s while live, then the run's own end said 9.4s and the figure went backwards.
//
// So the moment is taken less the smallest delay any of this run's events has arrived with
// (`traceStore.lagByRun`) — the trip itself and any skew between the two clocks, without the time an
// event sat waiting in a batch. Live figures then count to where the run has really got to, and its
// end lands on the number they were already showing.

import { useEffect, useState } from "react";
import { useTraceStore } from "../store/traceStore.ts";

/** Re-render every `ms` while `active`, with the moment on `runId`'s clock. */
export function useRunClock(runId: string | undefined, active: boolean, ms: number): number {
  const lag = useTraceStore((s) => (runId ? s.lagByRun[runId] : undefined)) ?? 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now - lag;
}

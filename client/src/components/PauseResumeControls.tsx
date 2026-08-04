// Debug depth (Week 6): pause the live run at its next node boundary, or resume a paused run
// from its durable checkpoint. Pure control-plane — it sends a command and the run's own steps
// keep streaming on the trace channel; status flips arrive on the "debug" channel.

import { useTraceStore } from "../store/traceStore.ts";
import { sendPauseRun, sendResumeRun } from "../lib/socket.ts";

export function PauseResumeControls() {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const status = useTraceStore((s) => (activeRunId ? s.runs[activeRunId]?.status : undefined));
  if (!activeRunId || (status !== "running" && status !== "paused")) return null;

  const base =
    "flex items-center gap-1.5 rounded-control px-2 py-1 text-[11px] transition-colors border";

  if (status === "running") {
    return (
      <button
        onClick={() => sendPauseRun(activeRunId)}
        className={`${base} border-hair text-run hover:bg-active`}
        title="Pause at the next step boundary"
      >
        <span className="text-[9px] leading-none">❚❚</span> Pause
      </button>
    );
  }
  return (
    <button
      onClick={() => sendResumeRun(activeRunId)}
      className={`${base} border-hair text-ok hover:bg-active`}
      title="Resume from the durable checkpoint"
    >
      <span className="text-[9px] leading-none">▶</span> Resume
    </button>
  );
}

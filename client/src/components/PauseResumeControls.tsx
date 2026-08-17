// Debug depth (Week 6): pause the live run at its next node boundary, resume a paused run from
// its durable checkpoint, or stop it for good. Pure control-plane — it sends a command and the
// run's own steps keep streaming on the trace channel; status flips arrive on the "debug" channel.
//
// STOP IS BESIDE BOTH OF THEM RATHER THAN INSTEAD OF EITHER, and it is the one that gets the
// workspace unstuck. The interactive slot is process-wide: while a run is in flight nothing else
// can start, be branched, be resumed, or have an edit applied — and two of the server's own
// refusals ("stop it before resuming this one", "stop it before branching") are instructions to
// press a button that did not exist. A user's only remedy was to wait for a timeout.

import { useState } from "react";
import { useTraceStore } from "../store/traceStore.ts";
import { sendCancelRun, sendPauseRun, sendResumeRun } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { PauseIcon, PlayIcon, StopIcon } from "./panelIcons.tsx";

export function PauseResumeControls() {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const status = useTraceStore((s) => (activeRunId ? s.runs[activeRunId]?.status : undefined));
  // CONFIRMED IN PLACE, not in a dialog. Stopping a run destroys nothing that was written — the
  // steps, the cost and the trace all stay — so a modal would be heavier than the act. But it is
  // not resumable either, and a mis-click on the button next to Pause would read as a pause that
  // silently killed the run, so the second press is the confirmation.
  const [confirming, setConfirming] = useState(false);
  if (!activeRunId || (status !== "running" && status !== "paused")) return null;

  const base =
    "flex items-center gap-1.5 rounded-control px-2 py-1 text-[11px] transition-colors border";

  const stop = confirming ? (
    <button
      onClick={() => {
        sendCancelRun(activeRunId);
        setConfirming(false);
      }}
      onBlur={() => setConfirming(false)}
      autoFocus
      className={`${base} border-err/40 bg-err/10 text-err hover:bg-err/20`}
      title="This cannot be resumed"
    >
      <StopIcon size={ICON.xs} /> Stop this run?
    </button>
  ) : (
    <button
      onClick={() => setConfirming(true)}
      className={`${base} border-hair text-muted hover:bg-active hover:text-err`}
      title="Stop the run — nothing is left to resume from"
    >
      <StopIcon size={ICON.xs} /> Stop
    </button>
  );

  return (
    <div className="flex items-center gap-1.5">
      {/* A paused run is still holding the slot, so Stop is offered in both states — the pair is
          Pause/Stop while it moves and Resume/Stop once it has stopped moving. */}
      {status === "running" ? (
        <button
          onClick={() => sendPauseRun(activeRunId)}
          className={`${base} border-hair text-run hover:bg-active`}
          title="Pause at the next step boundary"
        >
          <PauseIcon size={ICON.xs} /> Pause
        </button>
      ) : (
        <button
          onClick={() => sendResumeRun(activeRunId)}
          className={`${base} border-hair text-ok hover:bg-active`}
          title="Resume from the durable checkpoint"
        >
          <PlayIcon size={ICON.xs} /> Resume
        </button>
      )}
      {stop}
    </div>
  );
}

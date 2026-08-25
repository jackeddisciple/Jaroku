// What a window says when its own backend is not coming back.
//
// THE STATE THIS REPLACES. Every way a desktop launch can fail reached the page as one fact — the
// socket did not open — and the page rendered "disconnected, retrying", correctly describing what
// it was doing and never mentioning that nothing was going to answer. A payload that failed to
// extract, a port held by something else, a backend that crashed three times and a supervisor
// that had stopped all looked like a slow network. That is the freeze as somebody experiences it:
// not a hang, an application with no way to say it has failed.
//
// IT RENDERS ONLY WHEN THE HOST HAS GIVEN UP. `restarting` is not this — the shell is still
// working on it and the connection strip already says so — and rendering a failure over a
// recoverable state is how a screen like this stops being believed. In a browser it never renders
// at all, because nothing there ever sets a host status.
//
// THE THREE THINGS IT OFFERS ARE THE THREE THAT EXIST. A retry that actually starts the backend
// again rather than merely re-asking a dead port a question — the supervisor stops after three
// consecutive failures on purpose, and the condition is often transient in a way it cannot see, so
// the person watching is the one who gets to say "try that again". The log's path, because the
// whole story is in it and the shell wrote it down. And quit-and-reopen, which is stated as a
// sentence rather than offered as a button: the button would need shell permission this
// application deliberately does not grant its own webview, and a control that cannot do what it
// says is worse than an instruction that can.

import { useState } from "react";
import { restartBackend, type BackendStatus } from "../lib/hostBackend.ts";

export function BackendFailure({ status, onRetry }: { status: BackendStatus; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const retry = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const problem = await restartBackend();
    if (problem) {
      setRefusal(problem);
      setBusy(false);
      return;
    }
    // The button stays busy. The next status the shell sends is what ends this panel — either it
    // starts and the phase moves off `failed`, or it fails again and the message changes. A
    // button that re-enabled itself immediately would invite a second press into a start that is
    // still in flight, which is the one thing the shell refuses.
    onRetry?.();
  };

  const copyPath = async (): Promise<void> => {
    if (!status.logPath) return;
    try {
      await navigator.clipboard.writeText(status.logPath);
      setCopied(true);
    } catch {
      // Refused, or no clipboard. The path is selectable text either way, which is why it is
      // rendered rather than hidden behind the button.
      setCopied(false);
    }
  };

  return (
    <div className="mt-5 space-y-3 rounded-control border border-err/30 bg-err/5 px-3 py-3">
      <p className="text-label text-err">Jaroku&rsquo;s backend is not running.</p>
      {/* The shell's own sentence, verbatim. It names the actual cause — a port, a missing
          payload, a runtime that would not unpack — and paraphrasing it here would be a second
          description of a failure that already has one. */}
      {status.message && <p className="text-caption leading-relaxed text-muted">{status.message}</p>}
      <p className="text-tiny leading-relaxed text-faint">
        Quitting Jaroku from the tray and opening it again starts it over. If it keeps happening, the log below has
        every step of the launch in it.
      </p>
      {refusal && <p className="text-tiny text-err">{refusal}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void retry()}
          disabled={busy}
          className="rounded-control border border-edge px-2.5 py-1 text-tiny text-ink outline-none hover:border-chrome focus-visible:shadow-focusring disabled:opacity-50"
        >
          {busy ? "Starting…" : "Start it again"}
        </button>
        {status.logPath && (
          <button
            type="button"
            onClick={() => void copyPath()}
            className="rounded-control border border-edge px-2.5 py-1 text-tiny text-muted outline-none hover:border-chrome hover:text-ink focus-visible:shadow-focusring"
          >
            {copied ? "Path copied" : "Copy log path"}
          </button>
        )}
      </div>
      {status.logPath && (
        <p className="select-all break-all font-mono text-tiny text-faint">{status.logPath}</p>
      )}
    </div>
  );
}

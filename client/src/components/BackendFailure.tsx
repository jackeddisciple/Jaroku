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
// THE THREE THINGS IT OFFERS ARE THE THREE THAT EXIST. Retry, which re-runs whatever the caller
// was waiting on. The log's path, because the whole story is in it and the shell wrote it down.
// And quit-and-reopen, which is stated as a sentence rather than offered as a button: the button
// would need shell permission this application deliberately does not grant its own webview, and a
// control that cannot do what it says is worse than an instruction that can.

import { useState } from "react";
import type { BackendStatus } from "../lib/hostBackend.ts";

export function BackendFailure({ status, onRetry }: { status: BackendStatus; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);

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
      <p className="text-[13px] text-err">Jaroku&rsquo;s backend is not running.</p>
      {/* The shell's own sentence, verbatim. It names the actual cause — a port, a missing
          payload, a runtime that would not unpack — and paraphrasing it here would be a second
          description of a failure that already has one. */}
      {status.message && <p className="text-[12px] leading-relaxed text-muted">{status.message}</p>}
      <p className="text-[11px] leading-relaxed text-faint">
        Quitting Jaroku from the tray and opening it again starts it over. If it keeps happening, the log below has
        every step of the launch in it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-control border border-edge px-2.5 py-1 text-[11px] text-ink outline-none hover:border-chrome focus-visible:shadow-focusring"
          >
            Try again
          </button>
        )}
        {status.logPath && (
          <button
            type="button"
            onClick={() => void copyPath()}
            className="rounded-control border border-edge px-2.5 py-1 text-[11px] text-muted outline-none hover:border-chrome hover:text-ink focus-visible:shadow-focusring"
          >
            {copied ? "Path copied" : "Copy log path"}
          </button>
        )}
      </div>
      {status.logPath && (
        <p className="select-all break-all font-mono text-[10px] text-faint">{status.logPath}</p>
      )}
    </div>
  );
}

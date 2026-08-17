// A run has stopped, and is waiting for you.
//
// This is the only blocking modal in Jaroku, and it earns that by describing something that
// is actually blocked: a generated agent is halted mid-graph, on a timer, before calling a
// tool on a third-party server that nobody here has reviewed. Everything else in the product
// can be answered later; this cannot, and if it is missed the run stalls and then denies.
//
// The design decision that matters most is showing the ARGUMENTS. A confirmation that says
// only "create_issue wants to run" is a rubber stamp: the tool was already approved in
// principle when it was selected during planning. What was never approved is THIS call, with
// these values, which the model just made up. So the arguments are the body of the dialog,
// not a detail behind a disclosure triangle.
//
// The second is showing WHY it was classified high-impact. A verdict nobody can see the
// reasoning behind is not something anyone can meaningfully disagree with — and disagreeing
// is exactly what the MCP panel's override control is for.
//
// Escape maps to Deny, never to dismiss. There is no way to make this question go away
// without answering it, because the run has already stopped and the only outcomes are allow
// and refuse. A dismissible prompt would silently become a denial two minutes later.

import { useEffect, useState } from "react";
import { useMcpStore } from "../store/mcpStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { sendResolveMcpConfirm } from "../lib/socket.ts";
import { ACCENT, ICON, STATUS, TYPE } from "../lib/tokens.ts";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { McpBadge } from "./McpBadge.tsx";
import { ShieldAlertIcon } from "./panelIcons.tsx";
import type { McpConfirmVerdict } from "../types.ts";

/** Pretty-print the bridge's JSON args, falling back to the raw text if it isn't JSON. */
function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // The bridge caps and may truncate the payload, so unparseable is expected, not a bug.
    return raw;
  }
}

export function McpConfirmModal() {
  // One at a time, oldest first. Several high-impact calls in one graph turn each block
  // independently, and a combined "approve all of these" prompt is a prompt nobody reads.
  const request = useMcpStore((s) => s.confirms[0]);
  const [remaining, setRemaining] = useState(0);
  /**
   * The nonce this modal has already answered, if any.
   *
   * IT HAD NO IN-FLIGHT STATE AT ALL, and stays mounted until the server's `confirmResolved`
   * broadcast removes it — so a double-click sent `resolveMcpConfirm` twice, and holding Escape
   * sent a burst of denials. The server handles the second correctly (it deletes the key before
   * acting), but answers it with a workspace-wide error, which put "that confirmation is no longer
   * waiting" in front of every teammate because one person clicked twice.
   *
   * Keyed by nonce rather than a boolean: several high-impact calls in one turn queue here, and a
   * flag would carry an answer from the one just resolved into the one that replaces it.
   */
  const [answeredNonce, setAnsweredNonce] = useState<string | null>(null);
  const connected = useTraceStore((s) => s.connection === "open");

  useEffect(() => {
    if (!request) return;
    const deadline = new Date(request.requestedAt).getTime() + request.timeoutS * 1000;
    const tick = () => setRemaining(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape denies. It does not dismiss — see the file header. Guarded like the buttons: held
      // down it repeats, and every repeat past the first was a workspace-wide error.
      if (e.key === "Escape") {
        e.preventDefault();
        answer("deny");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, answeredNonce, connected]);

  if (!request) return null;

  const answered = answeredNonce === request.nonce;

  /**
   * Answer once, and only over a socket that can carry it.
   *
   * A CLOSED SOCKET MUST NOT ANSWER BY DEFAULT. `send` drops a command in silence when the socket
   * is down, and this run is blocked on a timer — so somebody who watched themselves click Allow
   * got a denial from `mcp_bridge`'s own clock instead. Refusing visibly is the honest version: the
   * timeout still denies, but it stops being something the user was told they had prevented.
   */
  const answer = (verdict: McpConfirmVerdict): void => {
    if (answered || !connected) return;
    if (!sendResolveMcpConfirm(request.runId, request.nonce, verdict)) return;
    setAnsweredNonce(request.nonce);
  };

  const queued = useMcpStore.getState().confirms.length - 1;
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    // No click-to-dismiss on the scrim, for the same reason Escape denies rather than closes.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mcp-confirm-title"
        className="w-[min(560px,94vw)] overflow-hidden rounded-modal bg-panel shadow-overlay"
        style={{ border: `1px solid ${ACCENT.mcp}33` }}
      >
        <div className="px-5 pt-4">
          <div className="flex items-center gap-2">
            <span style={{ color: STATUS.pending }}>
              <ShieldAlertIcon size={ICON.md} />
            </span>
            <h2 id="mcp-confirm-title" className="text-[13px] text-ink">
              A tool is waiting for you
            </h2>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
              {/* Counting down to a DENIAL. Saying which way it falls matters: a bare timer
                  reads as "hurry up", not as "doing nothing refuses this". */}
              denies in {mm}:{ss}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* The badge itself, not a copy of it. This is the one dialog where a user has to
                recognise the mark instantly, and a hand-drawn near-match would be the version
                they had never seen before. */}
            <McpBadge title="From an MCP server — third-party code Jaroku has not reviewed" />
            <span className="font-mono text-[13px] text-ink">{request.tool}</span>
            <span className="text-[11px] text-muted">on {request.server}</span>
          </div>

          <p className="mt-1.5 text-[11px] leading-[1.5] text-muted">
            <span className="text-ink">This runs on a third-party server Jaroku has not reviewed.</span>{" "}
            It was classified high-impact because {request.impactReason}.
          </p>
        </div>

        {/* The body of the dialog. Approving the tool happened at planning time; what has
            never been approved is this call, with these values. */}
        <div className="mt-3 px-5">
          <p className={TYPE.sectionLabel}>
            Arguments the agent produced
          </p>
          <pre className="mt-1 max-h-56 overflow-auto rounded-control border border-hair bg-bg/60 p-2.5 font-mono text-[11px] leading-[1.55] text-ink">
            {formatArgs(request.args)}
          </pre>
        </div>

        <div className="mt-3 flex items-center gap-2 px-5 pb-4">
          <span className="font-mono text-[10px] text-faint">
            run {request.runId.slice(0, 8)}
            {queued > 0 && ` · ${queued} more waiting`}
          </span>
          {/* STATE WHAT'S TRUE. Disabled buttons over a dead socket read as a broken dialog unless
              something says why — and this is the one place in the product where saying nothing
              means the run gets denied on a clock the user cannot see. */}
          {!connected && (
            <span className="text-[10px] text-muted">reconnecting — this cannot be answered yet</span>
          )}
          {connected && answered && <span className="text-[10px] text-muted">sent…</span>}
          <div className="ml-auto flex items-center gap-2">
            {/* Deny sits first and unstyled: refusing must be as reachable as allowing, and
                the two allow buttons must not be the only things that look clickable. */}
            <button className={quietBtn} onClick={() => answer("deny")} disabled={answered || !connected} autoFocus>
              Deny
            </button>
            <button
              className={primaryBtn}
              onClick={() => answer("once")}
              disabled={answered || !connected}
              title="Allow this one call. The next call to this tool asks again."
            >
              Allow once
            </button>
            <button
              className={primaryBtn}
              onClick={() => answer("run")}
              disabled={answered || !connected}
              title="Allow this tool for the rest of this run. Nothing carries past it."
            >
              Allow for this run
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

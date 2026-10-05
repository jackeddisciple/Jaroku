// A run has stopped, and is waiting for you.
//
// A generated agent is halted mid-graph, on a timer, before calling a tool on a third-party server
// nobody here has reviewed. If nobody answers, the run denies itself when the timer runs out. So
// this stays on screen until every ask is answered — but it is a TRAY, not a modal, and that is the
// decision this file turns on.
//
// IT WAS THE ONLY BLOCKING MODAL IN JAROKU, and blocking was the bug. With a job waiting, a scrim
// covered the whole window and could not be dismissed: the Inbox pointer to the waiting job, the
// waiting row, its detail panel, its Stop button, the fleet card and the composer were all behind
// it, so the person at the keyboard could not use the very surfaces built for a waiting job — and
// "stop this job" was not one of the three answers on offer.
//
// IT NEVER TAKES FOCUS, AND NO KEY ANYWHERE ANSWERS IT. The modal appeared unprompted fourteen
// seconds after a dispatch, took focus, and put it on Deny: the next space or Return somebody typed
// into the composer denied the tool, and Escape pressed to close the job panel denied it too. Here
// focus moves into the tray only when somebody asks it to — the waiting row's control does — its
// buttons ignore a press in the first moment after an ask appears, and Escape inside it only folds
// it away.
//
// EVERY ASK IS ON SCREEN AT ONCE, MOST URGENT FIRST. They used to come one at a time, but every
// clock starts when its run began waiting — so with four waiting, the later ones opened with forty
// seconds left, and with a slower reader they were denied before anybody saw them.
//
// What is unchanged is what made the modal worth having: the ARGUMENTS are the body of an ask, not
// a detail behind a disclosure — the tool was approved in principle at planning, and what nobody
// approved is THIS call with these values — and WHY it was classified high-impact is said, so it can
// be argued with.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMcpStore } from "../store/mcpStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { sendCancelWork, sendResolveMcpConfirm } from "../lib/socket.ts";
import { ACCENT, ICON, STATUS, TYPE } from "../lib/tokens.ts";
import { primaryBtn, quietBtn } from "./buttons.ts";
import { Capable } from "./Capable.tsx";
import { McpBadge } from "./McpBadge.tsx";
import { ShieldAlertIcon } from "./panelIcons.tsx";
import type { McpConfirmRequest, McpConfirmVerdict } from "../types.ts";

/**
 * How long an ask's buttons ignore a press after it comes on screen.
 *
 * Long enough that a click or a key aimed at whatever was under the tray a moment ago does not
 * land on Deny or Allow; short enough that nobody reading the arguments ever meets it.
 */
const ARM_MS = 700;

/** Pretty-print the bridge's JSON args, falling back to the raw text if it isn't JSON. */
function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // The bridge caps and may truncate the payload, so unparseable is expected, not a bug.
    return raw;
  }
}

/** When the runner denies this ask on its own clock. */
function deadlineOf(request: McpConfirmRequest): number {
  return new Date(request.requestedAt).getTime() + request.timeoutS * 1000;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whose ask it is, in words: the agent when the run is a deployed job, otherwise the run. */
function whose(request: McpConfirmRequest): string {
  return request.agentName ?? `run ${request.runId.slice(0, 8)}`;
}

export function McpConfirmModal() {
  const confirms = useMcpStore((s) => s.confirms);
  const revealNonce = useMcpStore((s) => s.revealNonce);
  const connected = useTraceStore((s) => s.connection === "open");
  const [now, setNow] = useState(() => Date.now());
  /** The ask that is open. Null means the most urgent one. */
  const [openNonce, setOpenNonce] = useState<string | null>(null);
  /** Folded down to one line. It still counts down, and it comes back open when a new ask arrives. */
  const [folded, setFolded] = useState(false);
  /**
   * The asks this tray has already answered, by nonce.
   *
   * The tray stays mounted until the server's `confirmResolved` removes an ask, so without this a
   * double-click sent two answers — and the second was a workspace-wide "no longer waiting" error.
   */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  /** When each ask first came on screen — what `ARM_MS` is measured from. */
  const shownAt = useRef(new Map<string, number>());
  const trayRef = useRef<HTMLElement>(null);
  const [announcement, setAnnouncement] = useState("");

  // MOST URGENT FIRST: the one the runner will deny soonest is the one to read first.
  const ordered = useMemo(
    () => [...confirms].sort((a, b) => deadlineOf(a) - deadlineOf(b)),
    [confirms],
  );
  const open = ordered.find((c) => c.nonce === openNonce) ?? ordered[0];

  // ONE TICK FOR EVERY CLOCK ON SCREEN, and none at all when nothing is waiting.
  useEffect(() => {
    if (ordered.length === 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [ordered.length]);

  // A NEW ASK IS SAID ALOUD, AND THE TRAY UNFOLDS FOR IT — but focus stays where it was. Politely,
  // because a screen reader mid-sentence should finish it; the tray is not going anywhere.
  const known = useRef(new Set<string>());
  useEffect(() => {
    const fresh = ordered.filter((c) => !known.current.has(c.nonce));
    known.current = new Set(ordered.map((c) => c.nonce));
    if (fresh.length === 0) return;
    for (const c of fresh) if (!shownAt.current.has(c.nonce)) shownAt.current.set(c.nonce, Date.now());
    setFolded(false);
    const first = fresh[0]!;
    setAnnouncement(`${whose(first)} is waiting on you to allow ${first.tool} on ${first.server}.`);
  }, [ordered]);

  // THE ONE WAY FOCUS MOVES IN: somebody asked to see this ask — the waiting row's control.
  useEffect(() => {
    if (!revealNonce) return;
    if (ordered.some((c) => c.nonce === revealNonce)) {
      setOpenNonce(revealNonce);
      setFolded(false);
      requestAnimationFrame(() => trayRef.current?.querySelector<HTMLElement>("[data-confirm-open]")?.focus());
    }
    useMcpStore.getState().revealConfirm(null);
  }, [revealNonce, ordered]);

  // Forget answers for asks that are gone, so the set does not grow for the life of the session.
  useEffect(() => {
    const live = new Set(ordered.map((c) => c.nonce));
    if ([...answered].some((n) => !live.has(n))) setAnswered(new Set([...answered].filter((n) => live.has(n))));
    for (const n of [...shownAt.current.keys()]) if (!live.has(n)) shownAt.current.delete(n);
  }, [ordered, answered]);

  if (ordered.length === 0 || !open) return null;

  const soonest = deadlineOf(ordered[0]!) - now;
  const label = ordered.length === 1 ? "A tool is waiting for you" : `${ordered.length} tools are waiting for you`;

  return (
    // A REGION, NOT A DIALOG: no scrim, no `aria-modal`, nothing behind it stops working. It sits at
    // the top centre, where nothing in any destination keeps a control — not over the composer and
    // its send button at the bottom, nor the toasts in the bottom-right corner.
    <section
      ref={trayRef}
      role="region"
      aria-label={label}
      onKeyDown={(e) => {
        // ESCAPE FOLDS THE TRAY AND NOTHING ELSE — it never answers, and it must not also reach the
        // window, where the job panel's own Escape would close the panel underneath.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setFolded(true);
        }
      }}
      className="fixed left-1/2 top-3 z-50 w-[min(560px,94vw)] -translate-x-1/2 overflow-hidden rounded-lg bg-elevated shadow-overlay"
      style={{ border: `1px solid ${ACCENT.mcp}33` }}
    >
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

      <div className="flex items-center gap-2 px-4 py-2.5">
        <span style={{ color: STATUS.pending }} className="shrink-0">
          <ShieldAlertIcon size={ICON.sm} />
        </span>
        <h2 className="text-label text-ink">{label}</h2>
        {/* COUNTING DOWN TO A DENIAL, and saying so: a bare timer reads as "hurry up", not as
            "doing nothing refuses this". Folded, this is the soonest of them. */}
        <span className="ml-auto text-tiny tabular-nums text-faint">
          {folded && ordered.length > 1 ? "next " : ""}denies in {clock(soonest)}
        </span>
        <button
          type="button"
          className="rounded-control px-2 py-0.5 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          onClick={() => setFolded((v) => !v)}
          aria-expanded={!folded}
          title={folded ? "Show what is waiting" : "Fold this away — it keeps counting down, and comes back for a new ask"}
        >
          {folded ? "Show" : "Later"}
        </button>
      </div>

      {!folded && (
        <ul className="max-h-[min(70vh,560px)] overflow-y-auto border-t border-hair">
          {ordered.map((request) => {
            const isOpen = request.nonce === open.nonce;
            const left = deadlineOf(request) - now;
            return (
              <li key={request.nonce} className="border-b border-hair last:border-b-0">
                {/* THE ASK'S OWN LINE: whose it is, which tool, and its own clock. Pressing it opens
                    the ask, which is the only way anything in this tray changes what is shown. */}
                <button
                  type="button"
                  data-confirm-open={isOpen ? "" : undefined}
                  onClick={() => setOpenNonce(request.nonce)}
                  aria-expanded={isOpen}
                  className={`flex w-full items-center gap-2 px-4 py-2 text-left transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
                    isOpen ? "bg-active/40" : "hover:bg-active/30"
                  }`}
                >
                  <McpBadge title="From an MCP server — third-party code Jaroku has not reviewed" />
                  <span className="min-w-0 truncate text-caption text-ink">
                    <span className="text-muted">{whose(request)} wants </span>
                    {request.tool}
                    <span className="text-muted"> on {request.server}</span>
                  </span>
                  <span className={`ml-auto shrink-0 text-tiny tabular-nums ${left < 30_000 ? "text-err" : "text-faint"}`}>
                    {clock(left)}
                  </span>
                </button>
                {isOpen && (
                  <AskBody
                    request={request}
                    connected={connected}
                    answered={answered.has(request.nonce)}
                    armed={now - (shownAt.current.get(request.nonce) ?? 0) >= ARM_MS}
                    onAnswered={() => setAnswered(new Set([...answered, request.nonce]))}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** One ask, open: why it was held, the arguments, and the answers — including stopping the job. */
function AskBody({ request, connected, answered, armed, onAnswered }: {
  request: McpConfirmRequest;
  connected: boolean;
  answered: boolean;
  /** False for the first moment after the ask appeared. See `ARM_MS`. */
  armed: boolean;
  onAnswered: () => void;
}) {
  /**
   * Answer once, and only over a socket that can carry it.
   *
   * A CLOSED SOCKET MUST NOT ANSWER BY DEFAULT. `send` drops a command in silence when the socket is
   * down, and this run is blocked on a timer — so somebody who watched themselves click Allow got a
   * denial from the bridge's own clock instead. Refusing visibly is the honest version.
   */
  const answer = (verdict: McpConfirmVerdict): void => {
    if (answered || !connected || !armed) return;
    if (!sendResolveMcpConfirm(request.runId, request.nonce, verdict)) return;
    onAnswered();
  };
  const disabled = answered || !connected || !armed;

  return (
    <div className="px-4 pb-3">
      <p className="text-tiny leading-[1.5] text-muted">
        <span className="text-ink">This runs on a third-party server Jaroku has not reviewed.</span>{" "}
        {/* THE REASON THE MANIFEST GAVE, or nothing. A placeholder here read "classified
            high-impact because it is classified high-impact". */}
        {request.impactReason
          ? `It was classified high-impact because ${request.impactReason}.`
          : "It was classified high-impact."}
      </p>

      {/* The body of the ask. Approving the tool happened at planning time; what has never been
          approved is this call, with these values. */}
      <p className={`mt-2 ${TYPE.sectionLabel}`}>Arguments the agent produced</p>
      <pre className="mt-1 max-h-40 overflow-auto rounded-control border border-hair bg-void p-2.5 font-mono text-tiny leading-[1.55] text-ink">
        {formatArgs(request.args)}
      </pre>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {/* STATE WHAT'S TRUE. Disabled buttons over a dead socket read as a broken ask unless
            something says why — and saying nothing here means the run is denied on a clock. */}
        {!connected && <span className="text-tiny text-muted">reconnecting — this cannot be answered yet</span>}
        {connected && answered && <span className="text-tiny text-muted">sent…</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* STOP IS AN ANSWER TOO, for a deployed job: the person decided the job should not go
              on, not merely that this call should not happen. The server denies the call and asks
              the job to stop, so it does not sit here until the clock runs out. */}
          {request.workItemId && (
            <Capable cmd="cancelWork">
              <button
                type="button"
                className={quietBtn}
                disabled={disabled}
                onClick={() => {
                  if (disabled || !request.workItemId) return;
                  if (sendCancelWork(request.workItemId)) onAnswered();
                }}
                title="Deny this call and stop the job"
              >
                Stop job
              </button>
            </Capable>
          )}
          {/* Deny sits first and unstyled: refusing must be as reachable as allowing, and the two
              allow buttons must not be the only things that look clickable. */}
          <button type="button" className={quietBtn} onClick={() => answer("deny")} disabled={disabled}>
            Deny
          </button>
          <button
            type="button"
            className={primaryBtn}
            onClick={() => answer("once")}
            disabled={disabled}
            title="Allow this one call. The next call to this tool asks again."
          >
            Allow once
          </button>
          <button
            type="button"
            className={primaryBtn}
            onClick={() => answer("run")}
            disabled={disabled}
            title="Allow this tool for the rest of this run. Nothing carries past it."
          >
            Allow for this run
          </button>
        </div>
      </div>
    </div>
  );
}

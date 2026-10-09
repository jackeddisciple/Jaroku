// §14 — who is connected right now, and the one blunt instrument on this panel.
//
// WHAT IS DELIBERATELY NOT HERE IS THE DESIGN. No IP addresses — §14.1 is explicit, and the reason
// is not privacy theatre: an internal access panel is not the place to expose colleagues' network
// locations, and anybody with a genuine investigative need has `audit_log`. No ticket ids, no
// tokens, no raw User-Agent. What a row carries is a name, two words about the browser, and how
// long the session has been open, which is exactly enough for somebody to recognise a session and
// decide whether to end it.
//
// END SESSION IS A BLUNT INSTRUMENT AND READS AS ONE. It closes a socket. It revokes nothing, the
// person can reconnect immediately if their access still allows it, and §14.2 requires the
// confirmation to say so — because the failure this prevents is an administrator who believes they
// have removed somebody's access and has removed their tab.
//
// THE COUNT IS ANNOUNCED POLITELY. §17: "Live-session count is announced via a polite live region on
// change, not on every poll." A count that interrupted a screen reader every time somebody opened a
// laptop would be the least usable thing on this surface.

import { useState } from "react";
import { Truncate } from "./Truncate.tsx";
import { quietBtn } from "./buttons.ts";
import { Dialog, DialogContent } from "./ui/dialog.tsx";
import { relTime } from "../lib/format.ts";
import { TYPE } from "../lib/tokens.ts";
import type { LiveSession } from "../store/accessStore.ts";

function ConfirmEnd({
  session,
  onCancel,
  onConfirm,
}: {
  session: LiveSession;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    // A RADIX DIALOG (ui/dialog.tsx, 2026-10-09): it had the role and none of the behaviour. Escape
    // and the scrim cancel — nothing here is typed — and focus stays inside until it is answered.
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        inline
        aria-label={`End ${session.name}'s session`}
        aria-describedby={undefined}
        overlayClassName="items-center bg-ink/35 px-4"
        className="w-full max-w-md rounded-lg border border-edge bg-elevated p-4 shadow-overlay"
      >
        <div className={TYPE.sectionLabel}>End session</div>
        {/* §14.2's sentence, close to verbatim, and §17's rule that the consequence is in the BODY
            rather than only in the title. Both halves matter: what it does, and what it does not
            do — an administrator who reads only the first half has just been told they revoked
            somebody's access, which is not what happened. */}
        <p className="mt-2 text-caption leading-[1.55] text-ink">
          This will disconnect {session.name}&apos;s session.
        </p>
        <p className="mt-1.5 text-tiny leading-[1.55] text-muted">
          It does not revoke their access — they can reconnect if their permissions still allow it.
          To take access away, revoke their grant in the People section above.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={onConfirm}
            className="rounded-control border border-err/40 bg-err/10 px-3 py-1.5 text-caption text-err transition-colors hover:bg-err/20"
          >
            End session
          </button>
          <button onClick={onCancel} className={quietBtn}>
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AccessSessions({
  sessions,
  canAdmin,
  onEnd,
}: {
  sessions: LiveSession[] | undefined;
  canAdmin: boolean;
  onEnd: (sessionId: string) => void;
}) {
  const [confirming, setConfirming] = useState<LiveSession | null>(null);

  if (!sessions) return <div className="text-tiny text-faint">Reading who is connected…</div>;

  if (sessions.length === 0) {
    return <div className="text-tiny text-faint">Nobody has a session open in this workspace.</div>;
  }

  return (
    <div className="space-y-0.5">
      {/* §17's polite live region. `aria-live="polite"` rather than `assertive`, and on the COUNT
          rather than on the list: a screen reader announcing every row every time somebody opens a
          laptop is a section nobody can use. */}
      <p aria-live="polite" className="sr-only">
        {sessions.length} session{sessions.length === 1 ? "" : "s"} open
      </p>

      {sessions.map((s) => (
        <div
          key={s.id}
          className="flex min-w-0 items-center gap-2 rounded-control px-1 py-1.5 transition-colors hover:bg-active/40"
        >
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <Truncate className="min-w-0 text-caption text-ink">{s.name}</Truncate>
              {/* WHICH SESSIONS ARE ON THIS AGENT, marked rather than filtered — see the server's
                  `liveSessions`. Both answers are useful, and hiding the others would give a count
                  that disagrees with the presence dots in the People section above. */}
              {s.onThisAgent && (
                <span className="shrink-0 text-tiny uppercase tracking-wider text-faint" title="Looking at this agent">
                  here
                </span>
              )}
            </div>
            <div className="text-tiny text-faint">
              {/* NULL DEVICE RENDERS NOTHING rather than "Unknown browser", which beside somebody's
                  name reads as a warning about their session rather than as a missing header. */}
              {s.device && <span>{s.device} · </span>}
              <span>open {relTime(s.startedAt)}</span>
            </div>
          </div>

          {/* §14.1 — ABSENT for a non-admin, not disabled. */}
          {canAdmin && (
            <button type="button" className={quietBtn} onClick={() => setConfirming(s)}>
              End session
            </button>
          )}
        </div>
      ))}

      {confirming && (
        <ConfirmEnd
          session={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            onEnd(confirming.id);
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}

// The rung this workspace is under, and the one thing it can say back.
//
// WHY IT IS A STRIP AND NOT A PANEL SECTION. An enforcement is not a setting somebody goes looking
// for — it is the reason their work was just refused, and the sentence explaining it arrived on
// whichever channel they happened to be working in. So it sits above the shell, on every screen,
// for exactly as long as a rung is in force, and nowhere at all when none is.
//
// AND THE APPEAL IS THE POINT. The ladder is one-sided by construction: a score rises, a rung is
// applied, work is refused. `appeal_note` is the column that makes it two-sided, and until now it
// could only be written with SQL — which is the one hand that does not need an appeal mechanism.
// The repository says why it is a MEMBER's write: an appeal that has to go through the party that
// applied the enforcement is not an appeal.
//
// IT PROMISES NOTHING. Recording a note changes no rung, and the copy says so in as many words. A
// control that looked like it lifted a suspension and did not would be worse than no control.

import { useState } from "react";
import { sendAppealEnforcement } from "../lib/socket.ts";
import { underEnforcement, useEnforcementStore } from "../store/enforcementStore.ts";
import { fmtUntil, relTime } from "../lib/format.ts";
import { ICON } from "../lib/tokens.ts";
import { AlertTriangleIcon, XIcon } from "./panelIcons.tsx";

/** What each rung is called where a person reads it. The level names are for the ladder. */
const RUNG_LABEL: Record<string, string> = {
  watch: "Watched",
  soft_limit: "Temporarily limited",
  verify: "Verification needed",
  suspended: "Suspended",
  blocked: "Blocked",
};

export function EnforcementStrip() {
  const state = useEnforcementStore((s) => s.state);
  const history = useEnforcementStore((s) => s.history);
  const notice = useEnforcementStore((s) => s.notice);
  const error = useEnforcementStore((s) => s.error);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [dismissed, setDismissed] = useState(false);
  // `watch` changes nothing about what the workspace may do — the ladder's own words — so a banner
  // for it would be an alarm about a recorded observation. The row is still in the history, and the
  // audit trail has it; what it is not is something to interrupt somebody with.
  if (!underEnforcement(state) || state === null || state.level === "watch") return null;
  if (dismissed && !state.refusesWork) return null;

  // The live row, which is the one an appeal lands on. Its `appealed_at` is how this knows whether
  // the workspace has already answered — asking twice would overwrite the first note.
  const live = history.find((h) => h.lifted_at === null);
  const alreadyAppealed = live?.appealed_at != null;
  // Everything that is over. `watch` is excluded here too: it changed nothing while it was in
  // force, so listing it would pad the line with rungs that never cost anybody anything.
  const past = history.filter((h) => h.lifted_at !== null && h.level !== "watch");

  const submit = (): void => {
    const text = note.trim();
    if (!text) return;
    if (sendAppealEnforcement(text)) {
      setNote("");
      setOpen(false);
    }
  };

  return (
    <div
      className={`shrink-0 border-b px-4 py-2 ${
        state.refusesWork ? "border-err/40 bg-err/[0.07]" : "border-run/40 bg-run/[0.06]"
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${state.refusesWork ? "text-err" : "text-run"}`}>
          <AlertTriangleIcon size={ICON.sm} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[12px] font-medium text-ink">
              {RUNG_LABEL[state.level] ?? state.level}
            </span>
            {/* WHEN IT LAPSES, when it does. The three automatic rungs expire on their own, and
                "this lifts itself on Thursday" is the single most useful fact on this strip for
                somebody deciding whether to write anything at all. */}
            {state.expiresAt && (
              <span className="text-[11px] text-faint">lifts {fmtUntil(state.expiresAt)}</span>
            )}
            {state.byHuman && <span className="text-[11px] text-faint">applied by a person</span>}
          </div>
          {/* THE RUNG'S OWN SENTENCE, from the server, which is the same one a refusal carries. */}
          <p className="mt-0.5 text-[11px] leading-[1.55] text-muted">{state.explain}</p>
          {state.reason && (
            <p className="mt-0.5 text-[11px] leading-[1.55] text-faint">Reason recorded: {state.reason}</p>
          )}

          {/* PREVIOUSLY, when there is one, and only three of them. `history()` exists because an
              appeal review reads it, and the same fact is worth one line to the workspace: a rung
              that has been applied and lifted twice before is a different situation from a first
              one, and reading it here is cheaper than opening the audit log to find out. */}
          {past.length > 0 && (
            <p className="mt-0.5 text-[11px] leading-[1.55] text-faint">
              Previously:{" "}
              {past.slice(0, 3).map((h, i) => (
                <span key={h.id}>
                  {i > 0 ? ", " : ""}
                  {RUNG_LABEL[h.level] ?? h.level}
                  {h.lifted_at ? ` (lifted ${relTime(h.lifted_at)})` : ""}
                </span>
              ))}
              {past.length > 3 ? ` and ${past.length - 3} more` : ""}
            </p>
          )}

          {notice && <p className="mt-1 text-[11px] text-ink">{notice}</p>}
          {error && <p className="mt-1 text-[11px] text-err">{error}</p>}

          {alreadyAppealed ? (
            <p className="mt-1 text-[11px] text-faint">
              Appealed — a person reviews it, and nothing changes until they do.
            </p>
          ) : open ? (
            <div className="mt-1.5">
              <textarea
                autoFocus
                rows={3}
                value={note}
                maxLength={4000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What happened, from your side. This goes to whoever reviews the enforcement."
                className="w-full rounded-control border border-hair bg-void px-2 py-1.5 text-[12px] text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring focus:border-edge"
              />
              <div className="mt-1 flex items-center gap-2">
                <button
                  onClick={submit}
                  disabled={note.trim().length === 0}
                  className="rounded-control bg-panel px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-active disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Send appeal
                </button>
                <button onClick={() => setOpen(false)} className="px-1 text-[11px] text-muted hover:text-ink">
                  Cancel
                </button>
                <span className="text-[11px] text-faint">
                  One note, not a conversation. It changes no limit by itself.
                </span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setOpen(true)}
              className="mt-1 text-[11px] text-muted underline decoration-hair underline-offset-2 transition-colors hover:text-ink"
            >
              Appeal this
            </button>
          )}
        </div>
        {/* NO DISMISS FOR A RUNG THAT REFUSES WORK. Hiding the explanation for why nothing starts
            would leave the product silently broken. The reversible rungs can be put away. */}
        {!state.refusesWork && (
          <button
            // LOCAL, not a write to the store. The rung is still in force and the panel still says
            // so; what has been dismissed is this banner, for this tab, until it reconnects. A
            // dismiss that edited the state would be the UI telling itself the enforcement is over.
            onClick={() => setDismissed(true)}
            title="Hide until the next reconnect"
            className="shrink-0 rounded-control px-1 py-0.5 text-faint transition-colors hover:bg-active hover:text-ink"
          >
            <XIcon size={ICON.xs} />
          </button>
        )}
      </div>
    </div>
  );
}

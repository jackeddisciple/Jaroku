// §5.2's note, and §5.5's feedback — the two halves of the action row that ask a question.
//
// A NOTE IS AN ANNOTATION AND NOT A COMMENT SYSTEM. §13 puts mentions, threading and reactions
// explicitly out of scope, and §5.2 says why: "a comment system is a product, and this is
// deliberately an annotation." So: plain text, one box, Cmd+Enter to save, Esc to cancel, and no
// affordance anywhere that hints at a reply.
//
// THUMBS UP ASKS NOTHING. §5.5: "Thumbs up: fills, no further UI. Do not interrupt a satisfied
// user." Thumbs down opens the reason picker, because a negative signal with no reason is a number
// nobody can act on — and because §5.5 turns exactly that into the highest-value thing available:
// "a thumbs-down on a turn that produced a version should offer 'Add this case to an eval dataset'
// as a secondary action. That converts a shrug into a regression test."

import { useEffect, useRef, useState } from "react";
import { GLYPH, Glyph } from "../icons.ts";
import { Icon } from "../../lib/icons/registry.ts";
import { ActionButton } from "./TurnActions.tsx";
import { Popover, PopoverNote } from "./Popover.tsx";
import { CheckboxField } from "../Checkbox.tsx";
import { relTime } from "../../lib/format.ts";
import { STATUS } from "../../lib/tokens.ts";
import { keyHint } from "../../lib/modKey.ts";
import {
  FEEDBACK_REASONS, useTurnInteractionStore, type FeedbackReason,
} from "../../store/turnInteractionStore.ts";

export function NoteControl({ turnId, disabled = false }: { turnId: string; disabled?: boolean }) {
  const notes = useTurnInteractionStore((s) => s.notes[turnId] ?? []);
  const addNote = useTurnInteractionStore((s) => s.addNote);
  const deleteNote = useTurnInteractionStore((s) => s.deleteNote);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = (): void => {
    // §5.2: "Esc cancels (confirm if dirty)." A note somebody has typed and not saved is exactly
    // the thing an accidental Escape should not take, and this popover closes on outside clicks
    // too — so the confirm covers both.
    if (draft.trim() && !window.confirm("Discard this note?")) return;
    setDraft("");
    setOpen(false);
  };

  const save = (): void => {
    const body = draft.trim();
    if (!body) return;
    void addNote(turnId, body);
    setDraft("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <ActionButton
        buttonRef={triggerRef}
        icon={Icon.turn.note}
        name={notes.length > 0 ? `Notes (${notes.length})` : "Add a note"}
        title="Annotate this turn for the workspace"
        // §5.2: "Icon shows a count badge when > 0."
        count={notes.length}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={close} triggerRef={triggerRef} label="Note on this turn" width={320}>
        <div className="px-1 pb-1">
          <div className="px-1 pb-1.5 text-tiny uppercase tracking-wider text-faint">Note on this turn</div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
            }}
            rows={3}
            placeholder="This plan looks right but it drops the retry on 429."
            className="w-full resize-none rounded-control bg-bg px-2 py-1.5 text-caption text-ink outline-none placeholder:text-faint focus-visible:shadow-focusring"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={close}
              className="rounded-control px-2 py-1 text-tiny text-muted transition-colors duration-fast hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!draft.trim()}
              title={keyHint("⌘↵")}
              className="rounded-control bg-ink px-2.5 py-1 text-tiny text-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
            >
              Save
            </button>
          </div>
        </div>

        {notes.length > 0 && (
          <div className="mt-1 border-t border-hair pt-1">
            {notes.map((n) => (
              <div key={n.id} className="px-2 py-1.5">
                <div className="flex items-baseline gap-1.5 text-tiny text-faint">
                  <span className="text-muted">{n.author_name ?? "Someone"}</span>
                  <span>{relTime(n.created_at)}</span>
                  {/* §9's pending treatment, and the failure that must never be silent. */}
                  {n.pending && <span className="text-muted">saving…</span>}
                  {n.error && <span style={{ color: STATUS.error }}>{n.error}</span>}
                  <button
                    type="button"
                    onClick={() => void deleteNote(turnId, n.id)}
                    className="ml-auto text-faint transition-colors duration-fast hover:text-ink"
                    title="Delete this note"
                    aria-label="Delete this note"
                  >
                    ×
                  </button>
                </div>
                <p className={`mt-0.5 whitespace-pre-wrap break-words text-caption ${n.pending ? "text-muted" : "text-ink"}`}>
                  {n.body}
                </p>
              </div>
            ))}
          </div>
        )}

        <PopoverNote>
          {/* The scope, said once. A note that looked private would be a warning nobody reads; one
              that looked public when it was not would be worse. */}
          Visible to everyone in this workspace. Notes stay attached to the turn through a
          regeneration.
        </PopoverNote>
      </Popover>
    </div>
  );
}

export function FeedbackControls({
  turnId,
  /** §5.5: a thumbs-down on a code-producing turn offers eval-dataset promotion. */
  producedVersion = false,
  onPromoteToDataset,
  disabled = false,
}: {
  turnId: string;
  producedVersion?: boolean;
  onPromoteToDataset?: () => void;
  disabled?: boolean;
}) {
  const summary = useTurnInteractionStore((s) => s.feedback[turnId] ?? { up: 0, down: 0, mine: null });
  const setFeedback = useTurnInteractionStore((s) => s.setFeedback);
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<FeedbackReason[]>([]);
  const [comment, setComment] = useState("");
  const downRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) { setReasons([]); setComment(""); }
  }, [open]);

  const toggleReason = (id: FeedbackReason): void =>
    setReasons((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));

  return (
    <>
      <ActionButton
        icon={Icon.turn.thumbUp}
        name={summary.mine === 1 ? "Remove your positive feedback" : "This was good"}
        title="This was good"
        pressed={summary.mine === 1}
        disabled={disabled}
        // §5.5: "Mutually exclusive; clicking the active one clears it." and "Thumbs up: fills, no
        // further UI. Do not interrupt a satisfied user."
        onClick={() => void setFeedback(turnId, summary.mine === 1 ? null : 1)}
        className={summary.mine === 1 ? "!text-ok" : ""}
      />

      <div className="relative">
        <ActionButton
          buttonRef={downRef}
          icon={Icon.turn.thumbDown}
          name={summary.mine === -1 ? "Remove your negative feedback" : "This was not good"}
          title="This was not good"
          pressed={summary.mine === -1}
          disabled={disabled}
          onClick={() => {
            if (summary.mine === -1) { void setFeedback(turnId, null); return; }
            // The reason picker, which a thumbs UP deliberately does not get.
            setOpen(true);
          }}
          className={summary.mine === -1 ? "!text-warn" : ""}
        />
        <Popover open={open} onClose={() => setOpen(false)} triggerRef={downRef} label="What went wrong" width={300}>
          <div className="px-2 pb-1 pt-0.5 text-tiny uppercase tracking-wider text-faint">What went wrong?</div>
          <div className="px-2">
            {FEEDBACK_REASONS.map((r) => (
              <div key={r.id} className="py-1">
                {/* Multi-select, per §5.5 — a response can be wrong in more than one way, and
                    forcing one reason would make the aggregate a story about the picker. */}
                <CheckboxField checked={reasons.includes(r.id)} onChange={() => toggleReason(r.id)}>
                  {r.label}
                </CheckboxField>
              </div>
            ))}
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Anything else? (optional)"
              className="mt-1 w-full rounded-control bg-bg px-2 py-1 text-tiny text-ink outline-none placeholder:text-faint focus-visible:shadow-focusring"
            />
            <div className="mt-1.5 flex items-center justify-end gap-1.5 pb-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-control px-2 py-1 text-tiny text-muted transition-colors duration-fast hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void setFeedback(turnId, -1, reasons, comment.trim() || null);
                  setOpen(false);
                }}
                className="rounded-control bg-ink px-2.5 py-1 text-tiny text-bg"
              >
                Send
              </button>
            </div>
          </div>

          {producedVersion && onPromoteToDataset && (
            <PopoverNote>
              {/* §5.5's own argument, and it is the strongest sentence in the section: "That
                  converts a shrug into a regression test, which is the single highest-value thing
                  a negative signal can become in this product." */}
              <button
                type="button"
                onClick={() => { onPromoteToDataset(); setOpen(false); }}
                className="inline-flex items-center gap-1.5 text-accent hover:underline"
              >
                <Glyph icon={Icon.attach.dataset} size={GLYPH.meta} />
                Add this case to an eval dataset
              </button>
            </PopoverNote>
          )}
        </Popover>
      </div>

      {/* §5.5: "workspace-visible in aggregate (counts on the turn)". Only above one, because a
          count of one beside a filled thumb is the same fact written twice. */}
      {summary.up + summary.down > 1 && (
        <span className="ml-0.5 self-center text-tiny tabular-nums text-faint" aria-hidden>
          {summary.up > 0 && `+${summary.up}`}
          {summary.up > 0 && summary.down > 0 && " "}
          {summary.down > 0 && `−${summary.down}`}
        </span>
      )}
    </>
  );
}

// Two questions, and the agent exists when they are answered. The one place an agent is
// deliberately created outside onboarding — and it creates a DRAFT, never a build.
//
// IT DOES NOT PLAN AND IT DOES NOT GENERATE, WHICH IS A HARD RULE RATHER THAN A PREFERENCE. The
// product owner's words: there must be no place to generate an agent until the user comes into the
// composer himself and writes it. This dialog used to send a PLAN — one step short of a build, with
// its own gate — and a plan raised from a dialog is a build somebody started by filling in a form,
// which is the thing the rule forbids. It writes a row and closes.
//
// SO IT SENDS THE SAME COMMAND ONBOARDING DOES, `createDraftAgent`, and the two screens ask the
// same two things for the same reason: what it should help with is a sentence, and the category is
// a word from a list. What comes back is an agent in the Agents tab with a name, a face, a category
// and a description, and no code — which the card already has a word for: `DRAFT`.
//
// NOTHING HERE ASKS FOR A NAME OR A FACE. Both are given, paired, from the eleven — see
// `lib/agentFaces.ts` — by the agent's position in its workspace's creation order, which is a count
// only the server can take.
//
// ── THE PURPOSE COMES FIRST, AND THE TAXONOMY IS ONE LINE ──────────────────────────────────────
//
// It asked them the other way round, with all forty presets laid out as chips in six labelled
// groups, and the sentence that says what the agent is FOR was below six hundred pixels of
// vocabulary — reachable only by scrolling a dialog that had to cap itself at 86% of the viewport
// to fit. The taxonomy was the biggest thing on a form whose whole job is to get a brief written.
//
// SO THE TEXTAREA IS THE FIELD, and the category is a `CategoryPicker` trigger under it: one line
// that opens a searchable popover, which is also where somebody names their own (its search field
// offers what you typed when nothing matches, replacing the "Name your own" button and the input it
// revealed). Two answers, both optional, and the dialog is short enough that neither is below a
// fold.
//
// RADII: the brief asks for 10–14px and the scale already has both ends of that. The fields are
// `input` (10px), which §11 requires of every text field and `test:surface-system` enforces; the
// popover is `card` (12px); the shell stays at `lg` (16px), which the scale names for "dialogs" — a
// 12px dialog beside five 16px ones is a rounding the eye reads as a mistake, not a decision.
//
//   npm run test:agent-category

import { useEffect, useId, useState } from "react";

import { CategoryPicker } from "./CategoryPicker.tsx";
import { outlineBtn, primaryBtn } from "./buttons.ts";
import { AGENT_CATEGORIES, UNCATEGORIZED } from "../lib/agentCategories.ts";
import { useDialog } from "../lib/dialog.ts";
import { Icon } from "../lib/icons/registry.ts";
import { sendCreateDraftAgent } from "../lib/socket.ts";
import { ICON, LAYER, TYPE } from "../lib/tokens.ts";

export function NewAgentDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const labelId = useId();
  const session = useId();
  const { ref, dialogProps } = useDialog(open, labelId);

  const [helpWith, setHelpWith] = useState("");
  const [category, setCategory] = useState<string>(UNCATEGORIZED);

  /**
   * ESCAPE CLOSES IT, which it did not — and the close button has said "Close (Esc)" since the
   * redesign, so the promise was on screen before the behaviour was.
   *
   * IT IS THE DIALOG'S OWN LISTENER, not `useDialog`'s. That hook's header explains why: "adding a
   * second Escape listener would mean two closers per dialog and a nested pair closing both at
   * once", so each overlay owns its key and `ProviderKeysDialog` is the shape this copies. What
   * makes the nested case safe here is the other half of it — `CategoryPicker` calls
   * `stopPropagation` on the Escape that closes its popover, so the first press closes the popover
   * and only the second reaches this.
   *
   * SAFE TO CLOSE ON, in `GrantDialog`'s terms: nothing is blocked waiting on this answer. It does
   * discard a typed brief, which is what the button beside Create also does and what the backdrop
   * has always done.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // A FRESH DIALOG EVERY TIME IT OPENS. Left as it was, somebody who cancelled halfway through
  // reopens onto half of a decision they abandoned — and the brief in particular would be the one
  // they were writing for a different agent.
  useEffect(() => {
    if (!open) return;
    setHelpWith("");
    setCategory(UNCATEGORIZED);
  }, [open, session]);

  /**
   * BOTH ANSWERS ARE OPTIONAL, so this is always available.
   *
   * It required a brief when it sent a plan, because there is nothing to plan from without one.
   * There is nothing to plan at all now: the row is an identity and a sentence, and an agent with
   * neither a category nor a description is still a real row somebody can build into — the same
   * thing onboarding's Skip produces.
   */
  const create = (): void => {
    // A DRAFT, NOT A PLAN AND NOT A GENERATION. See the header.
    sendCreateDraftAgent({
      category,
      description: helpWith.trim() || undefined,
    });
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-ink/20 p-6"
      style={{ zIndex: LAYER.modal }}
      // The backdrop is the dismissal, as every other overlay here offers.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={ref}
        {...dialogProps}
        aria-labelledby={labelId}
        className="relative flex w-full max-w-[480px] flex-col rounded-lg border border-edge bg-elevated shadow-overlay"
      >
        {/* NO SCROLL CONTAINER AND NO VIEWPORT CAP. It had `max-h-[86vh]` and an
            `overflow-y-auto` body because forty chips do not fit on a laptop; two fields do, on
            anything. A dialog that can scroll is a dialog somebody has to check for more. */}
        <div className="px-4 pb-3 pt-3.5 pr-11">
          <h2 id={labelId} className={TYPE.title}>New agent</h2>
          <p className="mt-0.5 text-tiny text-faint">
            It appears in Agents straight away. You build it from the composer when you are ready.
          </p>
        </div>

        <div className="border-t border-hair px-4 py-3.5">
          {/* THERE IS NO NAME FIELD. It was the first thing this dialog asked and it is given now,
              paired with the face, from the eleven — so the question had one honest answer the
              product already knew, and a field for it was a question with a right answer nobody
              has. Rename is a pencil on the agent's own detail header, where somebody who has met
              the agent can change its name having seen it. */}

          {/* ── 1. WHAT IT SHOULD HELP WITH — the field, and the reason the dialog exists ──────
              It is a DESCRIPTION rather than a brief. It read "What should it do?" and was
              required, because the dialog generated from it and there is nothing to generate from
              nothing. It generates nothing now: this is stored on the row so the card and the
              detail header have something to say about an agent that has not been built, and it is
              optional like the other answer.

              THE SAME WORDING AS THE ONBOARDING SCREEN, deliberately. Two surfaces asking the same
              question in two different ways is two questions as far as anybody answering is
              concerned. */}
          <label className="block">
            <span className={TYPE.sectionLabel}>What should it help you with?</span>
            {/* SIX ROWS, WHICH IS THE WHOLE POINT OF THE REDESIGN. At three it was the smaller of
                two controls on the form and read as an afterthought under the taxonomy. A sentence
                or two of intent should look like the thing being asked for. */}
            <textarea
              value={helpWith}
              onChange={(e) => setHelpWith(e.target.value)}
              rows={6}
              placeholder="Chase unpaid invoices over email and tell me what came back."
              className="mt-1.5 w-full resize-none rounded-input border border-edge bg-elevated px-3 py-2.5 text-body leading-[1.55] text-ink outline-none placeholder:text-faint focus:border-chrome focus:shadow-focusring"
            />
          </label>

          {/* ── 2. CATEGORY, as one line ──────────────────────────────────────────────────────
              Stored identically whether it came from the list or from the search field: the column
              is TEXT and the presets are a vocabulary, not a constraint (I6). */}
          <div className="mt-3.5">
            <span className={TYPE.sectionLabel}>Category</span>
            <div className="mt-1.5">
              <CategoryPicker value={category} onChange={setCategory} />
            </div>
          </div>

          {/* THERE IS NO STEP HERE FOR WHAT AN AGENT LOOKS LIKE, which is now true of every surface
              in the product rather than just this one. An agent is given one of the eleven faces,
              and the name paired with it, by its position in its workspace's creation order — so a
              picker here would be a control for a decision nothing can make. Nor is there a model,
              a tool list or a permission set: those belong to an agent that has been built, and
              this makes one that has not. */}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-hair px-4 py-3">
          {/* WHAT IS ABOUT TO BE WRITTEN, and the name is not in it because this side does not know
              it — the server pairs it with the face at creation. So the line says the category, or
              says that nothing has been chosen, which is a real state and a fine one. */}
          <span className="min-w-0 truncate text-tiny text-faint">
            {category === UNCATEGORIZED ? "No category" : category}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={onClose} className={outlineBtn}>Cancel</button>
            {/* NEVER DISABLED. It was, on an empty brief, because the dialog planned from it. Both
                answers are optional now and the row is worth writing either way — an agent with a
                face and a name and nothing else is what onboarding's Skip produces, and it is a
                thing somebody can build into. A primary button that is dead on arrival is the
                dead control this pass is hunting elsewhere. */}
            <button
              type="button"
              onClick={create}
              title="Add this agent to the Agents tab"
              className={primaryBtn}
            >
              Create
            </button>
          </div>
        </div>

        {/* LAST IN THE DOM, TOP-RIGHT ON SCREEN. `useDialog` puts focus on the first focusable
            thing inside the panel, and that should be the field this dialog is for — not its
            dismissal. Absolute rather than in the header row so reading order and tab order can
            disagree on purpose. */}
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close (Esc)"
          className="absolute right-3 top-3 rounded-control px-1.5 py-1 text-faint transition-colors hover:bg-active hover:text-ink active:bg-chrome"
        >
          <Icon.workspace.close size={ICON.sm} />
        </button>
      </div>
    </div>
  );
}

/** Exported for the suite: the presets a picker offers, in the order it offers them. */
export const PICKER_CATEGORIES = AGENT_CATEGORIES;

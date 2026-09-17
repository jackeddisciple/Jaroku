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
// same two things in the same order for the same reason: the category is a choice from a list, and
// what it should help with is a sentence. What comes back is an agent in the Agents tab with a
// name, a face, a category and a description, and no code — which the card already has a word for:
// `DRAFT`.
//
// NOTHING HERE ASKS FOR A NAME OR A FACE. Both are given, paired, from the eleven — see
// `lib/agentFaces.ts` — by the agent's position in its workspace's creation order, which is a count
// only the server can take.

import { useEffect, useId, useState } from "react";

import { Chip } from "./Chip.tsx";
import { outlineBtn, primaryBtn, quietBtn } from "./buttons.ts";
import {
  AGENT_CATEGORIES, CATEGORY_GROUPS, normalizeCategory, UNCATEGORIZED,
} from "../lib/agentCategories.ts";
import { useDialog } from "../lib/dialog.ts";
import { sendCreateDraftAgent } from "../lib/socket.ts";
import { LAYER, TYPE } from "../lib/tokens.ts";

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
  const [custom, setCustom] = useState("");
  const [naming, setNaming] = useState(false);

  // A FRESH DIALOG EVERY TIME IT OPENS. Left as it was, somebody who cancelled halfway through
  // reopens onto half of a decision they abandoned — and the avatar in particular would be the one
  // they were considering for a different agent.
  useEffect(() => {
    if (!open) return;
    setHelpWith("");
    setCategory(UNCATEGORIZED);
    setCustom("");
    setNaming(false);
  }, [open, session]);


  const chosenCategory = naming ? normalizeCategory(custom) : category;
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
      category: chosenCategory,
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
        className="flex max-h-[86vh] w-full max-w-[560px] flex-col rounded-lg border border-edge bg-elevated shadow-overlay"
      >
        <div className="border-b border-hair px-4 py-3">
          <h2 id={labelId} className="text-label text-ink">New agent</h2>
          <p className="mt-0.5 text-tiny text-faint">
            It appears in Agents straight away. You build it from the composer when you are ready.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* THERE IS NO NAME FIELD. It was the first thing this dialog asked and it is given now,
              paired with the face, from the eleven — so the question had one honest answer the
              product already knew and a field for it was a question with a right answer nobody has.
              Rename is a pencil on the agent's own detail header, where somebody who has met the
              agent can change its name having seen it. */}

          {/* ── 1. Category ────────────────────────────────────────────────────────────── */}
          <div>
            <span className={TYPE.sectionLabel}>Category</span>
            <div className="mt-1.5 space-y-2">
              {CATEGORY_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="text-tiny text-faint">{group.label}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {group.categories.map((c) => (
                      <Chip
                        key={c}
                        size="sm"
                        onClick={() => { setCategory(c); setNaming(false); }}
                        selected={!naming && category === c}
                        variant={!naming && category === c ? undefined : "outline"}
                      >
                        {c}
                      </Chip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* NAME YOUR OWN, AT THE BOTTOM, REVEALING A FIELD — §6's shape exactly. Stored
                identically either way: the column is TEXT and the presets are a vocabulary, not a
                constraint (I6). */}
            <button
              type="button"
              onClick={() => setNaming((v) => !v)}
              className={`${quietBtn} mt-2`}
              aria-expanded={naming}
            >
              Name your own
            </button>
            {naming && (
              <input
                autoFocus
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Vendor chasing"
                className="mt-1.5 w-full rounded-input border border-edge bg-elevated px-2.5 py-1.5 text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
              />
            )}
          </div>

          {/* THERE IS NO AVATAR STEP HERE ANY MORE. Choosing a face is a thing somebody does once,
              while they are being introduced to the product, and the carousel on the onboarding
              screen is the one place it is asked. A picker here would be a third surface competing
              for the same decision, on a form whose actual job is to get a brief written — and an
              agent made from this dialog takes the avatar its uuid hashes to, which is the same
              answer the server has always given when nobody chose. */}

          {/* ── 2. WHAT IT SHOULD HELP WITH, and it is a DESCRIPTION rather than a brief. It read
              "What should it do?" and was required, because the dialog generated from it and there
              is nothing to generate from nothing. It generates nothing now: this is stored on the
              row so the card and the detail header have something to say about an agent that has
              not been built, and it is optional like everything else here.

              THE SAME WORDING AS THE ONBOARDING SCREEN, deliberately. Two surfaces asking the same
              question in two different ways is two questions as far as anybody answering is
              concerned. */}
          <label className="mt-4 block">
            <span className={TYPE.sectionLabel}>What should it help you with?</span>
            <textarea
              value={helpWith}
              onChange={(e) => setHelpWith(e.target.value)}
              rows={3}
              placeholder="Chase unpaid invoices over email and tell me what came back."
              className="mt-1 w-full resize-y rounded-input border border-edge bg-elevated px-2.5 py-1.5 text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
            />
          </label>
        </div>

        {/* Cancel first in the DOM and first on screen — `useDialog` focuses the first focusable
            element, and the destructive-adjacent control should not be the one it lands on. */}
        <div className="flex items-center justify-between gap-2 border-t border-hair px-4 py-3">
          {/* WHAT IS ABOUT TO BE WRITTEN, and the name is not in it because this side does not know
              it — the server pairs it with the face at creation. So the line says the category, or
              says that nothing has been chosen, which is a real state and a fine one. */}
          <span className="min-w-0 text-tiny text-faint">
            {chosenCategory === UNCATEGORIZED ? "No category" : chosenCategory}
          </span>
          <div className="flex items-center gap-2">
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
      </div>
    </div>
  );
}

/** Exported for the suite: the presets a picker offers, in the order it offers them. */
export const PICKER_CATEGORIES = AGENT_CATEGORIES;

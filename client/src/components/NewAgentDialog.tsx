// §6's three inputs, in §6's order, as the one place an agent is deliberately created.
//
// WHY A DIALOG AND NOT THREE MORE FIELDS IN THE COMPOSER. The composer can already start an agent —
// type a brief, get a plan, press Generate — and that path stays exactly as it was. What it cannot
// do is ask three questions in an order, because it is one text field with chips around it, and §6's
// order is load-bearing: a name is what you know first, a category is a choice from a list, and an
// avatar is a picture you look at. Strung along a chip row those become three controls competing
// with the brief for the same glance.
//
// IT DOES NOT SEND A GENERATION. It sends a PLAN, exactly as the composer's first move does — "the
// plan gate is the only way in, so nothing gets built that the user hasn't seen described first" —
// and the three identity fields ride the plan record so that generation builds what was approved.
// A dialog that generated directly would be a second entry point with its own promises about the
// gate, the connectors and the provider, and the two would drift.
//
// THE AVATAR STEP IS SKIPPABLE AND IS PRE-ANSWERED, which is the same thing said twice. One is
// preselected by hash before the dialog opens, so the grid is never empty and somebody who does not
// care can press Create having read three words and typed one line. §6 asks for exactly that.
//
// A DUPLICATE IS ALLOWED AND WARNED. "Also used by Stacey" under the grid, and Create stays enabled:
// it is their workspace, and a hard block on a cosmetic choice is worse than a duplicate.

import { useEffect, useId, useRef, useState } from "react";

import { Chip } from "./Chip.tsx";
import { outlineBtn, primaryBtn, quietBtn } from "./buttons.ts";
import {
  AGENT_CATEGORIES, CATEGORY_GROUPS, normalizeCategory, UNCATEGORIZED,
} from "../lib/agentCategories.ts";
import { useDialog } from "../lib/dialog.ts";
import { sendPlanAgent } from "../lib/socket.ts";
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

  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [category, setCategory] = useState<string>(UNCATEGORIZED);
  const [custom, setCustom] = useState("");
  const [naming, setNaming] = useState(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // A FRESH DIALOG EVERY TIME IT OPENS. Left as it was, somebody who cancelled halfway through
  // reopens onto half of a decision they abandoned — and the avatar in particular would be the one
  // they were considering for a different agent.
  useEffect(() => {
    if (!open) return;
    setName("");
    setBrief("");
    setCategory(UNCATEGORIZED);
    setCustom("");
    setNaming(false);
  }, [open, session]);


  const chosenCategory = naming ? normalizeCategory(custom) : category;
  const canCreate = brief.trim().length > 0;

  const create = (): void => {
    if (!canCreate) return;
    // A PLAN, NOT A GENERATION. See the header: one gate, one entry point to it.
    sendPlanAgent(brief.trim(), [], name.trim() || undefined, undefined, undefined, undefined, {
      // The neutral value is what the server would write anyway; sending it says the same thing and
      // keeps the wire shape honest about what was on screen.
      category: chosenCategory,
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
            You will see a plan before anything is built.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* ── 1. Name ──────────────────────────────────────────────────────────────────
              FREE TEXT, NO PRESET LIST, NO UNIQUENESS CONSTRAINT beyond whatever exists today.
              Optional, because the generator already takes a name from the brief when none is
              given, and a required field here would be a question with a right answer nobody has
              yet. */}
          <label className="block">
            <span className={TYPE.sectionLabel}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Stacey"
              className="mt-1 w-full rounded-control border border-edge bg-panel px-2.5 py-1.5 text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
            />
            <span className="mt-1 block text-tiny text-faint">
              Optional — otherwise it is taken from what you describe below.
            </span>
          </label>

          {/* ── 2. Category ────────────────────────────────────────────────────────────── */}
          <div className="mt-4">
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
                className="mt-1.5 w-full rounded-control border border-edge bg-panel px-2.5 py-1.5 text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
              />
            )}
          </div>

          {/* THERE IS NO AVATAR STEP HERE ANY MORE. Choosing a face is a thing somebody does once,
              while they are being introduced to the product, and the carousel on the onboarding
              screen is the one place it is asked. A picker here would be a third surface competing
              for the same decision, on a form whose actual job is to get a brief written — and an
              agent made from this dialog takes the avatar its uuid hashes to, which is the same
              answer the server has always given when nobody chose. */}

          {/* THE BRIEF, LAST AND REQUIRED, and it is not one of §6's three. §6 describes a form for
              a product where an agent is a row somebody fills in; here an agent is generated from a
              description, and there is nothing to create without one. Putting it after the three
              keeps §6's order intact and puts the one required field next to the button. */}
          <label className="mt-4 block">
            <span className={TYPE.sectionLabel}>What should it do?</span>
            <textarea
              ref={briefRef}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              placeholder="Chase unpaid invoices over email and summarise what came back."
              className="mt-1 w-full resize-y rounded-control border border-edge bg-panel px-2.5 py-1.5 text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
            />
          </label>
        </div>

        {/* Cancel first in the DOM and first on screen — `useDialog` focuses the first focusable
            element, and the destructive-adjacent control should not be the one it lands on. */}
        <div className="flex items-center justify-between gap-2 border-t border-hair px-4 py-3">
          <span className="min-w-0 text-tiny text-faint">
            {name.trim() || "Unnamed"}
            {chosenCategory !== UNCATEGORIZED && ` — ${chosenCategory}`}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={outlineBtn}>Cancel</button>
            <button
              type="button"
              onClick={create}
              disabled={!canCreate}
              title={canCreate ? "Write a plan for this agent" : "Describe what the agent should do"}
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

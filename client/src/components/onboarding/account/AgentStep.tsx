// §5.1 step 4 — the first agent. ONE question, and it is the only one somebody can answer this early.
//
// ── WHAT THIS SCREEN HAS ASKED FOR, IN ORDER, AND WHY IT KEEPS SHRINKING ───────────────────────
//
// FIRST IT ASKED FOR A DESCRIPTION. It offered a sample agent or a text box and generated from
// whichever you picked, because the plan card appearing mid-onboarding was the "wow" moment §5.1 was
// built around. What it also was, on somebody's fourth screen, was a composer: a blank rectangle
// asking for a paragraph, from a person who has been in the product for ninety seconds and does not
// yet know what it can build. So the description moved to where descriptions belong — the composer,
// with the whole application around it for context.
//
// THEN IT ASKED FOR THREE THINGS: a name, a face, and a kind of work. That was defensible — they
// are the three things a person CAN answer that early — and two of the three turned out to be
// questions with no wrong answer, which is a different thing from a question worth asking. A
// carousel of twenty-eight characters is a decision somebody makes for thirty seconds and never
// revisits, and a name field on screen four is answered with "Agent 1" as often as with "Stacey".
//
// NOW IT ASKS TWO THINGS, AND NEITHER IS A NAME OR A FACE. What sort of agent it is, and what it
// should help with — the product owner's call. Those are the two a person CAN answer on their
// fourth screen, and the two the product cannot answer for itself: §14's filter reads the category,
// the sidebar's line shows it, a fork inherits it, and the sentence is what the card has to say
// about an agent nobody has built yet. The name and the face are GIVEN, paired, from the eleven —
// see `lib/agentFaces.ts` — so the agent in the Agents tab is Iris with Iris's picture rather than
// "Untitled agent" with whatever the person clicked past.
//
// WHAT IT DOES NOT DO IS BUILD ANYTHING. This screen used to generate, and the plan card appearing
// mid-onboarding was the "wow" moment §5.1 was designed around. It is not allowed to any more: an
// agent may only be generated from the composer, by somebody who went there and wrote it. So the
// sentence typed here is STORED — it becomes the row's description — and the first build is a
// deliberate act on a surface built for it.
//
// AND BOTH ARE STILL SKIPPABLE. Neither is required, so Continue is available from the first frame
// and somebody who does not care passes through in one click.

import { useState } from "react";

import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { sendCreateDraftAgent } from "../../../lib/socket.ts";
import { PrimaryButton } from "../../auth/controls.tsx";
import { StepShell } from "./StepShell.tsx";
import { CheckIcon } from "../../panelIcons.tsx";
import {
  AGENT_CATEGORIES, UNCATEGORIZED, normalizeCategory,
} from "../../../lib/agentCategories.ts";
import { ICON, STATUS } from "../../../lib/tokens.ts";

export function AgentStep() {
  const advance = useAccountOnboardingStore((s) => s.advance);
  const remember = useAccountOnboardingStore((s) => s.setFirstAgentIdentity);

  /** The chosen preset, or null. §7's neutral value is an absence here, not an option. */
  const [category, setCategory] = useState<string | null>(null);
  /** "Or type your own", which stores identically — the column is TEXT and the presets are a list. */
  const [custom, setCustom] = useState("");
  /** What it should help with. Stored as the row's description; nothing is generated from it. */
  const [helpWith, setHelpWith] = useState("");

  const chosen = custom.trim() ? normalizeCategory(custom) : category ?? UNCATEGORIZED;

  const keep = (): void => {
    // THE ROW IS WRITTEN HERE, NOT LATER. The agent is in the Agents tab from this moment — a name,
    // a face and a category, with every other figure on the card honestly absent rather than zero.
    // Waiting until somebody described it would mean finishing setup and finding an empty product.
    //
    // AND THE NAME AND THE FACE ARE NOT SENT, BECAUSE THIS SIDE MUST NOT DECIDE THEM. They come from
    // the agent's POSITION in its workspace's creation order, and only the server can count that:
    // `listAgents` excludes archived rows, so a browser counting what it holds would hand the
    // eleventh agent the fourth face. See `server/src/agents/faces.ts`.
    sendCreateDraftAgent({ category: chosen, description: helpWith.trim() || undefined });
    // AND THE CATEGORY IS REMEMBERED, because the composer needs to know which row the first
    // description belongs to and what was chosen for it. The list arrives over the socket a moment
    // after this, so the answer cannot be read out of it yet.
    remember({ category: chosen });
    advance();
  };

  return (
    <StepShell
      step={4}
      title="Your first agent"
      subtitle="Tell us what sort of work it is for and what it should help with. It appears in Agents right away, with a name and a face of its own — you build it when you are ready."
      skip={{ label: "Skip for now", onSkip: advance }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          keep();
        }}
        className="flex flex-col gap-5"
      >
        {/* WHAT SORT OF AGENT IT IS, AND IT IS THE WHOLE SCREEN NOW. Forty presets and a field, and
            the field stores exactly what a preset does — the column is TEXT and this list is a
            vocabulary, not a constraint (I6). Grouped headings are dropped here: on a setup screen
            the groups are a second thing to read, and the answer somebody wants is usually in the
            first line. */}
        <div className="flex flex-col gap-2">
          {/* THE ROW THAT GETS CUT IS FADED, NOT CLIPPED. Forty pills is seven rows and the card
              cannot hold them all above the fold, so the list scrolls — and a hard cut through the
              middle of a row of buttons reads as a rendering fault rather than as more below. The
              mask says "keep going" in the one way that needs no label. */}
          <div
            className="flex max-h-[224px] flex-wrap gap-1.5 overflow-y-auto pb-1
              [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{
              maskImage: "linear-gradient(to bottom, #000 82%, transparent)",
              WebkitMaskImage: "linear-gradient(to bottom, #000 82%, transparent)",
            }}
          >
            {AGENT_CATEGORIES.map((c) => {
              const picked = !custom.trim() && category === c;
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={picked}
                  onClick={() => {
                    setCustom("");
                    setCategory(picked ? null : c);
                  }}
                  className={`inline-flex items-center gap-1 rounded-xs border px-2 py-1 text-caption
                    transition-colors duration-fast ${
                      picked
                        ? "border-transparent bg-active text-ink"
                        : "border-edge text-muted hover:border-chrome hover:text-ink"
                    }`}
                >
                  {/* THE TICK IS THE SELECTION AND IT IS GREEN, which is the one place in this
                      product a green mark is right: it says "this is settled", not "this is
                      healthy". `reserveIcon`'s argument applies — the slot is held whether or not
                      the tick is in it, so a pill does not change width because you pressed it and
                      shove the forty below it onto a different line. */}
                  <span
                    className="inline-flex w-3 shrink-0 justify-center"
                    style={{ color: STATUS.ok }}
                    aria-hidden
                  >
                    {picked && <CheckIcon size={ICON.badge} />}
                  </span>
                  {c}
                </button>
              );
            })}
          </div>
          <input
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              if (e.target.value.trim()) setCategory(null);
            }}
            placeholder="…or type your own"
            aria-label="Type your own category"
            className="w-full rounded-input border border-edge bg-elevated px-3.5 py-2 text-caption
              text-ink outline-none transition-colors duration-fast placeholder:text-faint
              focus-visible:shadow-focusring focus:border-chrome"
          />
        </div>

        {/* WHAT IT SHOULD HELP WITH — the second and last question, and the one this screen did not
            ask for several versions. It is a DESCRIPTION and not a brief: it is stored on the row so
            the card has something to say about an agent nobody has built, and nothing is generated
            from it. The composer is the only place a build may start.

            A TEXTAREA RATHER THAN AN INPUT, because the honest answer is a sentence and a
            single-line field that scrolls sideways invites three words. Three rows is enough to see
            what you wrote without turning the screen into a document editor.

            AUTOFOCUSED, because the category above is a list somebody clicks and this is the only
            thing on the screen that wants a keyboard. */}
        <label className="flex flex-col gap-2">
          <span className="text-caption text-muted">What should it help you with?</span>
          <textarea
            value={helpWith}
            onChange={(e) => setHelpWith(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Chase unpaid invoices over email and tell me what came back."
            className="w-full resize-y rounded-input border border-edge bg-elevated px-3.5 py-2.5
              text-caption text-ink outline-none transition-colors duration-fast
              placeholder:text-faint focus-visible:shadow-focusring focus:border-chrome"
          />
        </label>

        <PrimaryButton type="submit">Continue</PrimaryButton>
      </form>
    </StepShell>
  );
}

// §5.1 step 4 — the first agent's IDENTITY. Three inputs, and not one of them is a description.
//
// WHAT THIS SCREEN USED TO DO AND WHY IT NO LONGER DOES. It offered a sample agent or a text box,
// and generated from whichever you picked — the plan card appearing mid-onboarding was the "wow"
// moment §5.1 was built around. What it also was, on somebody's fourth screen, was a composer: a
// blank rectangle asking for a paragraph, from a person who has been in the product for ninety
// seconds and does not yet know what it can build.
//
// So the screen asks the three things a person CAN answer that early — what is it called, what does
// it look like, what sort of thing is it — and the description is asked where descriptions belong,
// in the composer, with the whole application around it for context. The identity waits in
// `accountOnboardingStore` and the first plan that goes out carries it.
//
// EVERY ONE OF THE THREE IS OPTIONAL AND EVERY ONE IS PRE-ANSWERED. The avatar opens on a hashed
// entry, the category defaults to nothing, and the name to nothing — so Continue is always
// available and somebody who does not care can pass through in one click. §6 asks for exactly that
// of the avatar; it is true of all three here because none of them is a fact the product needs.

import { useId, useState } from "react";

import { useAccountOnboardingStore } from "../../../store/accountOnboardingStore.ts";
import { PrimaryButton } from "../../auth/controls.tsx";
import { StepShell } from "./StepShell.tsx";
import { AvatarCarousel } from "../../AvatarCarousel.tsx";
import { GlossStageProvider } from "../../GlossAvatar.tsx";
import { CheckIcon } from "../../panelIcons.tsx";
import {
  AGENT_CATEGORIES, UNCATEGORIZED, normalizeCategory,
} from "../../../lib/agentCategories.ts";
import { GLOSS_ROSTER, avatarIdFor } from "../../../lib/gloss/roster.ts";
import { ICON, STATUS } from "../../../lib/tokens.ts";

export function AgentStep() {
  const advance = useAccountOnboardingStore((s) => s.advance);
  const remember = useAccountOnboardingStore((s) => s.setFirstAgentIdentity);

  /**
   * A value to hash the opening avatar out of.
   *
   * THE AGENT HAS NO UUID YET — it does not exist until generation writes the row — so the strip
   * cannot open on the avatar this agent will eventually be assigned. What it opens on only has to
   * satisfy two things: it must not always be the first entry, so the strip has characters on both
   * sides and reads as something to scroll; and it must not change while somebody is looking at it.
   */
  const session = useId();

  const [name, setName] = useState("");
  const [avatarId, setAvatarId] = useState<string>(() => avatarIdFor(session) ?? GLOSS_ROSTER[0]!.id);
  /** The chosen preset, or null. §7's neutral value is an absence here, not an option. */
  const [category, setCategory] = useState<string | null>(null);
  /** "Or type your own", which stores identically — the column is TEXT and the presets are a list. */
  const [custom, setCustom] = useState("");

  const chosen = custom.trim() ? normalizeCategory(custom) : category ?? UNCATEGORIZED;

  const keep = (): void => {
    remember({ name: name.trim(), category: chosen, avatarId });
    advance();
  };

  return (
    <StepShell
      step={4}
      title="Your first agent"
      subtitle="Give it a name and a face. You will describe what it does next."
      skip={{ label: "Skip for now", onSkip: advance }}
      // WIDER THAN EVERY OTHER STEP, and the carousel is the reason. A strip has to show a character
      // either side of the centre one for the scroll to be legible at all; inside the 520px every
      // other screen uses, the neighbours are clipped by the fade before they are visible.
      width="wider"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          keep();
        }}
        className="flex flex-col gap-5"
      >
        {/* 1. THE NAME. Free text, no preset list, no uniqueness constraint beyond whatever exists
            today — "Stacey", "John", "Claire". Optional: generation takes a name from the
            description when none is given. */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name it — Stacey, John, Claire…"
          aria-label="Name your agent"
          autoFocus
          className="w-full rounded-control border border-edge bg-void px-3.5 py-2.5 text-label
            text-ink outline-none transition-colors duration-fast placeholder:text-faint
            focus-visible:shadow-focusring focus:border-chrome"
        />

        {/* 2. THE FACE, and it is the largest thing on this screen on purpose: it is the one
            decision here worth LOOKING at rather than reading. */}
        <GlossStageProvider active className="relative isolate">
          <AvatarCarousel current={avatarId} onChoose={setAvatarId} />
        </GlossStageProvider>

        {/* 3. WHAT SORT OF AGENT IT IS. Forty presets and a field, and the field stores exactly what
            a preset does — the column is TEXT and this list is a vocabulary, not a constraint (I6).
            Grouped headings are dropped here: on a setup screen the groups are a second thing to
            read, and the answer somebody wants is usually in the first line. */}
        <div className="flex flex-col gap-2">
          <span className="text-caption text-muted">What sort of agent is it?</span>
          {/* THE ROW THAT GETS CUT IS FADED, NOT CLIPPED. Forty pills is seven rows and the card
              cannot hold them all above the fold, so the list scrolls — and a hard cut through the
              middle of a row of buttons reads as a rendering fault rather than as more below. The
              mask says "keep going" in the one way that needs no label. */}
          <div
            className="flex max-h-[150px] flex-wrap gap-1.5 overflow-y-auto pb-1
              [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{
              maskImage: "linear-gradient(to bottom, #000 78%, transparent)",
              WebkitMaskImage: "linear-gradient(to bottom, #000 78%, transparent)",
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
                  className={`inline-flex items-center gap-1 rounded-chip border px-2 py-1 text-caption
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
            className="w-full rounded-control border border-edge bg-void px-3.5 py-2 text-caption
              text-ink outline-none transition-colors duration-fast placeholder:text-faint
              focus-visible:shadow-focusring focus:border-chrome"
          />
        </div>

        <PrimaryButton type="submit">Continue</PrimaryButton>
      </form>
    </StepShell>
  );
}

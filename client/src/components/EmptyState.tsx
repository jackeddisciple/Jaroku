// A panel with nothing in it yet, still looking like part of a living tool.
//
// Six panels can be empty and every one of them said so with two lines of flat grey centred in a
// void: "No trace yet / Run the agent below to watch its execution stream in." That is accurate
// and it reads as broken. A user opening Jaroku for the first time lands on three panels in that
// state at once, and the whole app looks switched off before it has been asked to do anything.
//
// What is added is presence, not decoration:
//
//   * a mark for the thing that is missing, so the panel says what it IS as well as what it lacks
//   * one step of type hierarchy, so the title reads as a title
//
// THERE USED TO BE A THIRD THING: a 340px radial glow in the periwinkle state accent, blurred
// wide, breathing on a 4.2s loop behind the icon. It was argued for as "the difference between a
// panel that is empty and a panel that is off", and the argument was good for one screen. The
// problem is that this component is mounted at about twenty call sites, so the ornament was not
// on one screen — it was a coloured, animated, purely decorative element rendered behind every
// empty surface in the product, several of them visible at once on a first run. A palette that
// spends its one rule on "colour means something, never decoration" cannot also do that.
//
// The onboarding hero keeps its halo, and that is not an inconsistency: a device used once at the
// moment a product introduces itself is a moment; the same device used twenty times is wallpaper.

import { ICON } from "../lib/tokens.ts";

export function EmptyState({
  title,
  hint,
  icon,
  /**
   * `full` fills its panel and centres. `inline` sits in the flow at the size of a couple of
   * rows — for a narrow column like the sidebar, where a full-height centred block would push
   * everything else off screen. `line` is one muted sentence in the flow, with whatever action
   * it has at the end of it.
   *
   * `line` IS THE RIGHT DEFAULT FOR A PANEL THAT WILL HOLD CONTENT SHORTLY, and most of the
   * twenty call sites are that: "No trace yet" is not a state of the product, it is the ten
   * seconds before a run starts. A full-height centred illustration for a condition that clears
   * itself is a screen announcing its own emptiness. The full treatment is for a genuinely
   * first-run surface — a workspace with no agents at all — where there really is nothing yet
   * and somebody needs to be told what this panel is for.
   */
  size = "full",
  className = "",
}: {
  title: string;
  hint?: React.ReactNode;
  /** A mark for the missing thing, from the app's one icon set. */
  icon?: (p: { size?: number }) => React.ReactElement;
  size?: "full" | "inline" | "line";
  className?: string;
}) {
  const Icon = icon;
  const full = size === "full";

  if (size === "line") {
    return (
      <div className={`flex items-baseline gap-2 px-4 py-3 text-[12px] leading-[1.5] text-muted ${className}`}>
        {Icon && (
          <span className="shrink-0 text-faint" aria-hidden>
            <Icon size={ICON.xs} />
          </span>
        )}
        <span className="min-w-0">
          {title}
          {/* An em dash rather than a line break: the action belongs at the end of the sentence,
              which is what makes this a sentence with an action rather than a panel with a
              button in it. */}
          {hint ? <> — {hint}</> : null}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden px-6 text-center ${
        full ? "h-full" : "py-8"
      } ${className}`}
    >
      <div className="relative">
        {Icon && (
          <div className="mb-2.5 flex justify-center text-faint" aria-hidden>
            <Icon size={full ? 22 : ICON.md} />
          </div>
        )}
        <div className={`font-medium text-ink ${full ? "text-[13px]" : "text-[12px]"}`}>{title}</div>
        {hint && (
          <div className="mx-auto mt-1 max-w-[38ch] text-[12px] leading-[1.55] text-muted">{hint}</div>
        )}
      </div>
    </div>
  );
}

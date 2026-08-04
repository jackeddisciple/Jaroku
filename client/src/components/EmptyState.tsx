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
//   * a slow ambient glow behind it, on the `breathe` keyframe the graph nodes already idle on
//   * one step of type hierarchy, so the title reads as a title
//
// The glow is a single radial stop at 6% alpha in the periwinkle the app already uses for state,
// blurred wide. At that strength it is not a colour anybody can name — it is the difference
// between a panel that is empty and a panel that is off. Anything more and it becomes the thing
// you look at, which is exactly wrong for a surface whose whole job is to be replaced.
//
// `motion-reduce` turns the idle off. An animation with no state change behind it is the first
// thing that should stop when somebody has asked for less movement.

import { ACCENT, ICON } from "../lib/tokens.ts";

export function EmptyState({
  title,
  hint,
  icon,
  /**
   * `full` fills its panel and centres. `inline` sits in the flow at the size of a couple of
   * rows — for a narrow column like the sidebar, where a full-height centred block would push
   * everything else off screen.
   */
  size = "full",
  className = "",
}: {
  title: string;
  hint?: React.ReactNode;
  /** A mark for the missing thing, from the app's one icon set. */
  icon?: (p: { size?: number }) => React.ReactElement;
  size?: "full" | "inline";
  className?: string;
}) {
  const Icon = icon;
  const full = size === "full";
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden px-6 text-center ${
        full ? "h-full" : "py-8"
      } ${className}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div
          className="animate-breathe rounded-full motion-reduce:animate-none"
          style={{
            width: full ? 340 : 180,
            height: full ? 340 : 180,
            background: `radial-gradient(circle, ${ACCENT.state}0f 0%, ${ACCENT.state}05 42%, transparent 70%)`,
            filter: "blur(18px)",
          }}
        />
      </div>

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

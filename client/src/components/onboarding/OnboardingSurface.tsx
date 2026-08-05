// The surface steps 1 and 2 sit on.
//
// It reuses App's outer shell — the inset, the rounded border, the one outer shadow — so the
// first two screens read as the same lifted object the app becomes, rather than as a separate
// splash page the product cuts away from. What it does NOT do is mount the three columns
// (see WelcomeStep for why), so this is one div and a scroll container.
//
// Three things it adds on top of that, and each of them is the same argument: a first-run screen
// holding one paragraph and one button has to earn its full-bleed with something other than
// emptiness, and on a near-black surface the only materials available are light and rhythm.
//
//   * A dot field. The same grid the Graph View canvas already draws, at a third the strength and
//     masked to fade before it reaches an edge. It is the product's own texture, so the first
//     screen is made of the same stuff as the fourth rather than of nothing.
//
//   * One neutral bloom behind the content, on the `breathe` keyframe the empty panels already
//     idle on. Not a colour — §4.2 spends hue on status only — just light, at the strength where
//     you would not name it if asked but would notice the screen going flat without it.
//
//   * A step rail. Two screens stand between a fresh clone and a composer, and saying so is worth
//     more than any reassurance: "there are three of these and you are on the first" is the fact
//     that makes somebody read the screen instead of hunting for the way out of it.

import { TYPE } from "../../lib/tokens.ts";

/** The rail's own model. `prompt` is the app itself, so it is only ever the step ahead. */
const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "provider", label: "Connect" },
  { id: "prompt", label: "Build" },
] as const;

export type SurfaceStep = (typeof STEPS)[number]["id"];

function StepRail({ current }: { current: SurfaceStep }) {
  const at = STEPS.findIndex((s) => s.id === current);
  return (
    <div
      className="relative flex shrink-0 items-center justify-center gap-4 border-t border-hair px-8 py-3.5"
      role="group"
      aria-label={`Step ${at + 1} of ${STEPS.length}`}
    >
      {STEPS.map((s, i) => {
        const done = i < at;
        const here = i === at;
        return (
          <span key={s.id} className="flex items-center gap-2">
            {/* The segment carries the state; the word only names it. A segment that grows when
                it becomes current means the rail is readable at a glance without reading it. */}
            <span
              aria-hidden
              className={`h-[2px] rounded-full transition-all duration-base ease-state ${
                here ? "w-6 bg-ink" : done ? "w-3 bg-muted" : "w-3 bg-chrome"
              }`}
            />
            <span
              className={`${TYPE.panelLabel} transition-colors duration-base ${
                here ? "!text-muted" : "!text-faint"
              }`}
              aria-current={here ? "step" : undefined}
            >
              {s.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function OnboardingSurface({
  step,
  children,
}: {
  step: SurfaceStep;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full bg-void p-2">
      <div className="relative flex h-full flex-col overflow-hidden rounded-modal border border-edge bg-bg shadow-overlay">
        {/* Depth, drawn rather than cast. Both layers are behind everything and take no clicks. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: "radial-gradient(rgba(228,228,231,0.055) 1px, transparent 1px)",
              backgroundSize: "22px 22px",
              // Fades out well before the border, so the field reads as depth rather than as a
              // texture somebody applied to a rectangle.
              maskImage: "radial-gradient(ellipse 78% 62% at 50% 34%, #000 30%, transparent 100%)",
              WebkitMaskImage:
                "radial-gradient(ellipse 78% 62% at 50% 34%, #000 30%, transparent 100%)",
            }}
          />
          <div
            className="absolute left-1/2 top-[-16%] h-[620px] w-[880px] -translate-x-1/2 animate-breathe motion-reduce:animate-none"
            style={{
              background:
                "radial-gradient(closest-side, rgba(228,228,231,0.06), rgba(228,228,231,0.02) 46%, transparent 74%)",
              filter: "blur(26px)",
            }}
          />
        </div>

        {/* Scrolls rather than clips: step 2 grows when a provider card is expanded, and a
            short window must not put the Save button out of reach. */}
        <div className="relative flex flex-1 min-h-0 items-center justify-center overflow-y-auto px-8 py-10">
          <div className="w-full max-w-[720px]">{children}</div>
        </div>

        <StepRail current={step} />
      </div>
    </div>
  );
}

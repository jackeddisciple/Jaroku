// The surface every screen before a session sits on, and the pieces they are built from.
//
// ONE SHELL FOR ELEVEN SCREENS. First-run has three plus two failure states, authentication has
// two, name collection has one, and account onboarding has five. Every one of them is the same
// composition — a mark, a line of display type, an optional subtitle, one card, and a legal or
// helper line under it — and the reason to build that once is not tidiness. These screens are seen
// in sequence, in the first ninety seconds somebody uses this product, and a card that is four
// pixels wider on the third one than on the second is a stutter in the only sequence where nobody
// has any reason to give the product the benefit of the doubt yet.
//
// IT IS NOT `OnboardingSurface`. That one exists, it is good, and it is for a different surface:
// it renders the app's own lifted-panel shell with a step rail along the bottom, for the two
// screens that stand between a signed-in user and the composer. This is the surface BEFORE that —
// full-bleed, no rail, no panel — because a person on these screens has no workspace, and drawing
// the app's chrome around a screen that cannot show the app is a promise the screen cannot keep.
//
// THE COMPOSITION, FROM THE OUTSIDE IN:
//
//   THE FIELD. Near-black, with the same dot grid the Graph View canvas and OnboardingSurface
//   already draw. It is the product's own texture, so the first screen is made of the same stuff
//   as the fourth. Full-bleed and evenly lit here rather than masked to an ellipse: these screens
//   are a page, and a vignette on a page reads as a spotlight nobody asked for.
//
//   THE MARK. The same three contours as everywhere else, at `BRAND.screen`, in ink.
//
//   THE TITLE, in the display serif, and this is the one decision that makes these screens read as
//   a product rather than as a dialog. See src/index.css for why a third family exists at all.
//
//   THE CARD. One surface, one border, one radius. Everything a screen actually asks for goes
//   inside it, so "what am I being asked" has exactly one answer on every screen in the sequence.
//
//   THE FOOTNOTE. The legal line, or the alternative path, or nothing. Outside the card on
//   purpose: it is true about the product rather than about the question being asked.

import { JarokuGlyph } from "../../lib/icons.tsx";
import { openExternal } from "../../lib/openExternal.ts";
import { BRAND } from "../../lib/tokens.ts";

/**
 * The dot field, and the one bloom behind the content.
 *
 * Extracted rather than inlined because two containers need it — the shell below and the full-
 * bleed failure screens, which draw no card — and a texture that differs between them would make
 * a failure look like a different application.
 */
function Field() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(rgba(228,228,231,0.05) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      {/* Light rather than colour, on the keyframe the empty panels already idle on. At the
          strength where you would not name it if asked, and would notice the screen going flat
          without it. */}
      <div
        className="absolute left-1/2 top-[-10%] h-[560px] w-[820px] -translate-x-1/2 animate-breathe motion-reduce:animate-none"
        style={{
          background:
            "radial-gradient(closest-side, rgba(228,228,231,0.05), rgba(228,228,231,0.018) 46%, transparent 74%)",
          filter: "blur(30px)",
        }}
      />
    </div>
  );
}

export interface AuthShellProps {
  /** The display line. One per screen, and it is the screen's name to the person reading it. */
  title?: string;
  /** Under it, in the same serif at prose size. Two short lines, never a paragraph. */
  subtitle?: React.ReactNode;
  /** Whether to draw the mark. Off for the steps deep inside a flow, where it is furniture. */
  mark?: boolean;
  /** The card's contents — the question this screen is asking. */
  children: React.ReactNode;
  /** Under the card, outside it. The legal line, or the way back. */
  footnote?: React.ReactNode;
  /**
   * How wide the card may get.
   *
   * TWO WIDTHS AND NO THIRD. `narrow` is a form — sign-in, a name, a workspace name — where a wide
   * measure makes a single input look lost. `wide` is a list of choices, where the labels need
   * room. A third would be somebody eyeballing it against whatever screen they had open.
   */
  width?: "narrow" | "wide";
}

export function AuthShell({
  title,
  subtitle,
  mark = true,
  children,
  footnote,
  width = "narrow",
}: AuthShellProps) {
  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-void">
      <Field />
      {/* `my-auto` rather than `justify-center`, so a tall screen centres and a short one scrolls
          from the top instead of clipping its own heading — which is what centring does the moment
          the content is taller than the window, and the runtime-check screen is the tallest here. */}
      <div className="relative my-auto flex w-full flex-col items-center px-6 py-12">
        {mark && (
          <span className="text-ink">
            <JarokuGlyph size={BRAND.screen} />
          </span>
        )}
        {title && (
          <h1
            className={`${mark ? "mt-6" : ""} text-center font-serif text-[34px] font-normal leading-[1.15] tracking-[-0.005em] text-ink`}
          >
            {title}
          </h1>
        )}
        {subtitle && (
          // The serif carries down into the subtitle, which is what makes the two read as one
          // block of voice rather than as a heading with a caption stuck under it.
          <p className="mt-3 max-w-[38ch] text-center font-serif text-[15px] leading-[1.5] text-muted">
            {subtitle}
          </p>
        )}

        <div
          className={`mt-8 w-full ${width === "narrow" ? "max-w-[420px]" : "max-w-[520px]"}
            rounded-modal border border-edge bg-bg/80 p-7 shadow-overlay backdrop-blur-[2px]`}
        >
          {children}
        </div>

        {footnote && (
          <div className="mt-6 max-w-[440px] text-center text-[12px] leading-[1.6] text-muted">
            {footnote}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A screen with no card — the failure and offline states, and the "ready" moment.
 *
 * The card is a container for a QUESTION, and these three ask nothing: they report. Wrapping a
 * sentence and one button in a bordered box would make a report look like a form.
 */
export function AuthNotice({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-void">
      <Field />
      <div className="relative my-auto flex w-full flex-col items-center px-6 py-12 text-center">
        <div className="w-full max-w-[440px]">{children}</div>
      </div>
    </div>
  );
}

/**
 * The legal line. §3.1 requires it before any action that creates an account, and requires it to
 * be a sentence rather than a checkbox.
 *
 * "By continuing" is standard, enforceable consent for a low-stakes product, and the checkboxes
 * are saved for things that are actually optional — which, on the screen after this one, is
 * exactly one thing.
 */
export function LegalLine() {
  return (
    <>
      By continuing, you agree to our <TextLink href="https://jaroku.dev/terms">Terms of Service</TextLink> and{" "}
      <TextLink href="https://jaroku.dev/privacy">Privacy Policy</TextLink>.
    </>
  );
}

/**
 * A link out of the app, or an action that reads as one.
 *
 * `href` OPENS THE SYSTEM BROWSER UNDER A HOST rather than navigating the webview. A packaged app
 * that navigated away from itself has no route back — the frontend is served from `tauri://` and
 * nothing on the open web can return to it — so an ordinary `<a>` here is a one-way trip out of
 * the application. See lib/openExternal.ts, which is where the allowlist that decides lives.
 */
export function TextLink({
  href,
  onClick,
  children,
}: {
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (onClick) onClick();
        else if (href) void openExternal(href);
      }}
      className="rounded-chip underline decoration-ember/50 underline-offset-2 text-ember outline-none
        transition-colors duration-fast hover:text-emberlit hover:decoration-emberlit
        focus-visible:shadow-focusring"
    >
      {children}
    </button>
  );
}

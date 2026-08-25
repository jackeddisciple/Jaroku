// The controls every pre-session screen is built from.
//
// SEPARATE FROM `onboarding/Cta.tsx`, AND THE SPLIT IS THE SURFACE RATHER THAN THE COMPONENT.
// Those two buttons are inline, auto-width and sit in the middle of a full-bleed onboarding
// screen; these are full-width and sit inside a card, because that is what images the design was
// drawn from show and because a 420px card with a 140px button floating in the middle of it reads
// as a dialog that has not decided what it wants. Two shapes of button in two places, each correct
// where it is, and neither pretending to be a general-purpose control.
//
// FOUR CONTROLS AND NO FIFTH. A filled button, a bordered one, a text field and a checkbox. Every
// screen in the sequence is made of those, and the day one needs a fifth is a day worth stopping
// on: eleven screens that ask for a name, an email, a workspace name, a key and a choice do not
// need a component library.
//
// FOCUS IS `focus-visible`, NEVER `focus`. `focus:` fires on a mouse press too, so a clicked
// button keeps a ring nobody asked for and the ring stops meaning "the keyboard is here". The same
// correction `Cta.tsx` made and for the same reason.

import { ICON } from "../../lib/tokens.ts";

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  autoFocus?: boolean;
  /** A mark before the label — the Google G, a mail glyph. Never decoration. */
  icon?: React.ReactNode;
  className?: string;
}

/**
 * The decision the screen exists to ask. One per screen, filled, canvas on ink.
 *
 * CHARCOAL RATHER THAN THE ACCENT, which is the same choice `PrimaryCta` makes: the accent is a
 * selection colour and there is nothing selected on any of these screens. §08 names this exact
 * control — "charcoal for primary high-contrast actions" — and a filled ink button is the
 * highest-contrast thing that can be on the surface, which is what "this is the one thing to press"
 * should look like when it is the only thing to press. It was off-white text on near-black before
 * and it is canvas on charcoal now; what makes it work is the distance, not the direction.
 */
export function PrimaryButton({
  children,
  onClick,
  type = "button",
  disabled,
  autoFocus,
  icon,
  className = "",
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`flex w-full items-center justify-center gap-2.5 rounded-control bg-ink px-4 py-3
        text-label text-void outline-none transition-all duration-base ease-state
        hover:shadow-glow-cta focus-visible:shadow-focusring
        disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * The other way forward, and not a lesser one.
 *
 * §3.1: "Both buttons appear equally valid. Google is primary in visual weight because it's the
 * majority path, but 'Continue with email' is not buried as a 'more options' link — that's the
 * pattern that quietly kills the alternative path for legitimate users who prefer it." So this is
 * a full-width control of the same height and the same radius as the one above it, differing in
 * fill and in nothing else.
 */
export function SecondaryButton({
  children,
  onClick,
  type = "button",
  disabled,
  autoFocus,
  icon,
  className = "",
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`flex w-full items-center justify-center gap-2.5 rounded-control border border-edge
        bg-panel px-4 py-3 text-label text-ink outline-none
        transition-all duration-base ease-state hover:border-chrome hover:shadow-glow
        focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * A quiet third weight, for "Skip for now" and "Start over".
 *
 * BARE TEXT AND NOT A THIRD BOX. §5.1 puts a skip beside a continue on four consecutive screens,
 * and two bordered controls of equal weight side by side is a screen that has not said which one it
 * expects — which is the one thing those screens must say, since the skip is genuinely first-class
 * but the continue is what the step is for.
 */
export function QuietButton({ children, onClick, disabled, className = "" }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-control px-3 py-2 text-caption text-muted outline-none
        transition-colors duration-fast hover:text-ink focus-visible:shadow-focusring
        disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export interface FieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "email" | "password";
  autoFocus?: boolean;
  disabled?: boolean;
  /** A mark inside the field, before the text. The mail glyph on the sign-in screen. */
  icon?: React.ReactNode;
  /** Marks the field as holding something the user must fix, for assistive tech and for the eye. */
  invalid?: boolean;
  maxLength?: number;
  name?: string;
  ariaLabel?: string;
}

/**
 * The one input shape.
 *
 * NO FLOATING LABEL AND NO LABEL ABOVE IT BY DEFAULT. Every field on these screens is preceded by a
 * question in prose — "What should we call you?", "Name your workspace" — and a label repeating
 * that question two lines lower is furniture. Where a field needs naming for assistive technology
 * and has no visible label, `ariaLabel` says so.
 */
export function TextField({
  value,
  onChange,
  placeholder,
  type = "text",
  autoFocus,
  disabled,
  icon,
  invalid,
  maxLength,
  name,
  ariaLabel,
}: FieldProps) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-control border bg-void px-3.5 transition-colors
        duration-fast focus-within:shadow-focusring
        ${invalid ? "border-err/60" : "border-edge focus-within:border-chrome"}`}
    >
      {icon && <span className="shrink-0 text-faint">{icon}</span>}
      <input
        type={type}
        name={name}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        maxLength={maxLength}
        // `autoComplete` off for nothing: an email field on a sign-in screen is exactly where a
        // password manager should offer to fill, and turning that off is a habit that costs people
        // real time for no security benefit whatsoever.
        autoComplete={type === "email" ? "email" : undefined}
        // The one deliberate exception to the type ladder, and the same one the composer takes:
        // this is the thing you type into, and it is allowed to be the largest text on the screen.
        className="w-full bg-transparent py-3 text-body text-ink outline-none
          placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

/**
 * The one checkbox, and there is exactly one in the whole sequence.
 *
 * §3.4: the marketing opt-in is unchecked by default, opt-in rather than opt-out. Everything else
 * these screens ask for is required or is a "Skip for now", and neither of those is a checkbox —
 * "By continuing" is the consent pattern for the legal line, and a checkbox in front of it would
 * be asking somebody to agree twice.
 *
 * DRAWN RATHER THAN NATIVE, for the reason the six `<select>`s in this app are: nothing in this
 * product is painted by the operating system, and a native checkbox is a control from another
 * application whichever way up this one's palette is. The real input is still there, still focusable, still
 * announced — it is `sr-only`, not `display: none`, which is the difference between styling a
 * control and replacing one.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="group flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-chip
          border transition-colors duration-fast peer-focus-visible:shadow-focusring
          ${checked ? "border-ink bg-ink text-void" : "border-edge bg-void group-hover:border-chrome"}`}
      >
        {checked && (
          <svg width={ICON.badge} height={ICON.badge} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-label leading-[1.4] text-ink">{label}</span>
        {hint && <span className="mt-1 block text-caption leading-[1.5] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * The rule with a word in it, from §3.1's sign-in screen.
 *
 * A hairline either side rather than a full-width line with a chip on top, because the second one
 * needs to know the surface colour behind it and this component sits on two of them.
 */
export function OrDivider({ label = "or" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span aria-hidden className="h-px flex-1 bg-hair" />
      <span className="text-caption text-muted">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-hair" />
    </div>
  );
}

/**
 * Something went wrong with what the person just did, said where they did it.
 *
 * Inside the card, under the control that produced it, never a toast. A refusal that appears in a
 * corner of the screen is a refusal somebody has to go looking for, and every failure on these
 * screens is about the field directly above this line.
 */
export function FormError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-caption leading-[1.5] text-err">
      {children}
    </p>
  );
}

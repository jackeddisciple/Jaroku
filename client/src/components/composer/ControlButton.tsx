// One control in the composer's bottom bar.
//
// Every button in that row is the same shape — a registry glyph, sometimes a text label, always a
// tooltip, always an accessible name — and the row is the one place in the product where a control
// that is four pixels smaller than its neighbours is immediately visible. So it is a component
// rather than a class string: seven call sites spelling the same padding is seven chances to spell
// it differently.
//
// THE HIT TARGET IS A MINIMUM, NOT A SIZE. §2.3: ">= 32x32 regardless of glyph size". A labelled
// control is wider than 32px and that is fine; what must never happen is a 20px glyph in a 20px
// box, which is what you get by padding to the glyph. `minWidth`/`minHeight` rather than a fixed
// square, so the label can extend it without a second recipe.
//
// AND THE NAME IS NOT THE TOOLTIP. `title` is a hover affordance and screen readers do not
// reliably announce it; `aria-label` is the name. §10 requires both on every icon-only button
// here, and requires `aria-pressed` on the ones that carry state — which is why `pressed` is a
// tri-state prop: `undefined` means this control is not a toggle, and rendering
// `aria-pressed="false"` on a button that is not one tells a screen reader it is a toggle that is
// off.

import { GLYPH, HIT_TARGET, Glyph, type Icon as IconRegistry } from "../icons.ts";

type Registry = typeof IconRegistry;

export function ControlButton({
  icon,
  label,
  name,
  title,
  onClick,
  disabled = false,
  pressed,
  expanded,
  active = false,
  size = GLYPH.toolbar,
  className = "",
  buttonRef,
}: {
  icon: Registry[keyof Registry];
  /** The text beside the glyph — "High", "Smart". Dropped below ~720px; see composerBar.ts. */
  label?: string;
  /** The accessible name. Required, because half of these controls have no visible text. */
  name: string;
  /** The hover tooltip. Defaults to the name, and differs from it wherever there is more to say —
   *  a disabled control's tooltip is the reason it is disabled, which the name must not become. */
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** A toggle's state. Leave undefined on anything that is not a toggle. */
  pressed?: boolean;
  /** A popover trigger's state. Leave undefined on anything that does not open one. */
  expanded?: boolean;
  /** Whether this control's setting is non-default, and so worth showing as engaged. */
  active?: boolean;
  size?: number;
  className?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={name}
      aria-pressed={pressed}
      aria-expanded={expanded}
      title={title ?? name}
      // `px-1.5` only when there is a label — an icon-only control is centred in its minimum box,
      // and padding it would make the box wider than the minimum for no reason.
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control text-caption
        transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring
        disabled:cursor-not-allowed disabled:opacity-30
        ${label ? "px-1.5" : ""}
        ${active ? "text-ink" : "text-muted"}
        ${disabled ? "" : "hover:bg-active hover:text-ink"}
        ${className}`}
      style={{ minWidth: HIT_TARGET, minHeight: HIT_TARGET }}
    >
      <Glyph icon={icon} size={size} />
      {label && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
}

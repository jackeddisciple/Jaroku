// The one checkbox.
//
// THE APP HAD TWO VOCABULARIES FOR IT AND NEITHER WAS RIGHT. Five call sites used a bare
// `<input type="checkbox">` with no styling at all, so a system-blue OS control sat on a near-black
// surface — the same problem the six native `<select>`s had, except these were not even given a
// border. The sixth was hand-drawn in the staging panel: a 12×12px `<button role="checkbox">`
// carrying `✓` and `–` as text characters at 9px, which is a font glyph standing in for an icon
// that already exists, in the smallest type size in the product.
//
// So: one mark, drawn with the app's own `CheckIcon` and `MinusIcon`, at the app's own stroke
// weight. Indeterminate is a first-class state because the staging panel genuinely has one — a
// file with some of its hunks staged is neither on nor off, and `aria-checked="mixed"` is how that
// is said.
//
// THE HIT AREA IS BIGGER THAN THE MARK. The staging checkbox was a 12px target, below every
// pointer-target guideline, and it is the control somebody clicks most in that flow. Negative
// margin means the padding costs no layout: the box still occupies 12px in its row.

import { ICON } from "../lib/tokens.ts";
import { CheckIcon, MinusIcon } from "./panelIcons.tsx";

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  label,
  title,
  className = "",
}: {
  /** `"mixed"` for a partial selection — some of this thing's children are chosen. */
  checked: boolean | "mixed";
  onChange: () => void;
  disabled?: boolean;
  /** The accessible name. Required: a mark with no name is a control nobody can use. */
  label: string;
  title?: string;
  className?: string;
}) {
  const on = checked === true;
  const mixed = checked === "mixed";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? "mixed" : on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onChange}
      className={`-m-1.5 inline-flex shrink-0 items-center justify-center rounded-control p-1.5 transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      <span
        className={`inline-flex h-3 w-3 items-center justify-center rounded-chip border transition-colors duration-fast ${
          on || mixed ? "border-accent bg-accent text-bg" : "border-hair text-transparent"
        }`}
      >
        {mixed ? <MinusIcon size={ICON.badge} /> : <CheckIcon size={ICON.badge} />}
      </span>
    </button>
  );
}

/**
 * A checkbox with its sentence beside it, which is how five of the six call sites use one.
 *
 * The whole row is the target — clicking the words toggles the box, which is what a `<label>`
 * bought before and what a hand-rolled control loses unless it is put back.
 */
export function CheckboxField({
  checked,
  onChange,
  disabled = false,
  title,
  align = "center",
  children,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
  /** `start` when the sentence wraps to more than one line. */
  align?: "center" | "start";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={onChange}
      className={`flex w-full gap-2 text-left text-tiny text-muted transition-colors duration-fast hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-40 ${
        align === "start" ? "items-start" : "items-center"
      }`}
    >
      <span
        aria-hidden
        className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-chip border transition-colors duration-fast ${
          align === "start" ? "mt-0.5" : ""
        } ${checked ? "border-accent bg-accent text-bg" : "border-hair text-transparent"}`}
      >
        <CheckIcon size={ICON.badge} />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

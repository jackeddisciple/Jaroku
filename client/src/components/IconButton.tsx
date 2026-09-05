// One icon-only control. Every icon-only control in the product goes through it.
//
// THE LABEL IS REQUIRED, AND IT IS BOTH THE ACCESSIBLE NAME AND THE TOOLTIP — one string, so the
// two cannot disagree. That is invariant I5, and making it a required prop is the only version of
// the rule that survives contact with a hundred call sites: a component you cannot construct
// without a name is a rule nobody has to remember. An icon-only button with no accessible name is
// unusable with a screen reader and unguessable with a mouse, and this product had a dozen of them.
//
// `title` is the tooltip primitive, deliberately. §8 says use the existing one and do not add a
// second, and the existing one in this codebase is the native title attribute — it is what every
// `title=` in these components already is, it needs no portal, and it works while the app is
// mid-render. Introducing a floating tooltip here would mean two tooltip behaviours in one row.
//
// HIT TARGET IS 32×32 REGARDLESS OF THE MARK INSIDE IT, from `HIT_TARGET`. A 14px icon in a 14px
// button is a control you miss on a trackpad and cannot hit at all on touch, and the composer's
// bar is seven of them in a row — the place where a near-miss costs most, because the neighbour
// you hit instead is a different setting. The mark's size and the button's size are separate
// numbers for that reason.
//
// A TOGGLE'S LABEL NAMES THE ACTION, NOT THE STATE. `Icon.workspace.switcherClosed` sits in a
// button labelled "Open the workspace switcher", never "closed" — the caller passes the label, so
// this is a rule the call sites keep, but it is written here because here is where somebody looks.

import { HIT_TARGET } from "./icons.ts";
import { ICON } from "../lib/tokens.ts";
import type { IconComponent } from "../lib/icons/registry.ts";

export interface IconButtonProps {
  /** The mark, from the registry. Never a generated component imported directly — see I4. */
  icon: IconComponent;
  /**
   * What pressing it does. Becomes `aria-label` AND the tooltip.
   *
   * An action, in the imperative: "Fork agent", "Retry this work item". Not a noun, and not the
   * current state of a toggle.
   */
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /**
   * Why it cannot be pressed. Non-null disables the button AND replaces the tooltip.
   *
   * §8: a disabled control carries its reason in the tooltip rather than being a bare greyed mark.
   * The rest of this product names the exact thing that is wrong — the stdout guard names the file
   * and line, a plan refusal names the rule — and a dimmed button with no sentence breaks that the
   * moment it appears. The label is still the accessible name; only the tooltip changes, because a
   * screen reader user needs to know what the control IS before they need to know why it is off.
   */
  disabledReason?: string | null;
  /**
   * Destructive treatment — `fleet.kill`, `workspace.delete`, `evals.deleteDataset`.
   *
   * The error red, never amber. Amber means running in this product, and drawing "kill the thing
   * that is running" in the colour of running is the one confusion this control must not create.
   */
  danger?: boolean;
  /** Pressed state for a toggle, and `aria-pressed` with it. */
  active?: boolean;
  /** The mark's own size. The button stays 32×32 whatever this is. */
  size?: number;
  /**
   * Stop the click reaching an enclosing clickable row.
   *
   * Inbox cards and agent cards expand on click and carry controls, so without this, dismissing
   * something also opened it.
   */
  stopPropagation?: boolean;
  className?: string;
}

export function IconButton({
  icon: Mark,
  label,
  onClick,
  disabledReason = null,
  danger = false,
  active = false,
  size = ICON.sm,
  stopPropagation = false,
  className,
}: IconButtonProps) {
  const disabled = disabledReason !== null && disabledReason !== undefined;
  const tone = danger
    ? "text-faint hover:text-err hover:bg-active"
    : active
      ? "text-accent hover:bg-active"
      : "text-muted hover:text-ink hover:bg-active";

  return (
    <button
      type="button"
      // ONE STRING, TWO JOBS — the whole of I5. When the control is off, the tooltip becomes the
      // reason and the accessible name stays the action.
      title={disabled ? (disabledReason as string) : label}
      aria-label={label}
      aria-pressed={active ? true : undefined}
      disabled={disabled}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        onClick?.(event);
      }}
      style={{ minWidth: HIT_TARGET, minHeight: HIT_TARGET }}
      className={[
        "inline-flex items-center justify-center rounded-control transition-colors",
        "focus-visible:outline-none focus-visible:shadow-focusring",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
        tone,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Mark size={size} />
    </button>
  );
}

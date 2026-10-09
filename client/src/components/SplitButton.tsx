// One button, two affordances.
//
// §3.5 gives every sync state exactly one primary action, which is correct as a default — the
// verdict line should never make somebody choose between five equally-weighted buttons before it
// has told them anything. But "one action" and "only one action is REACHABLE" are different
// claims, and until now they were the same button. A user who is ↑2 ahead and wants to pull anyway
// — to see what changed upstream before pushing — had no path to it without leaving the region.
//
// So: the left half is the verdict's suggested action, unchanged, with the same click target and
// the same keyboard shortcut; the right half is a caret that opens the full command set. Nothing
// about the default gets quieter, and nothing about the escape hatch stays hidden.
//
// THIS IS NOT A NEW INTERACTION VOCABULARY. The panel's own keyboard legend already binds five
// distinct git verbs to one surface — S, U, Cmd+Enter, Cmd+Shift+P, Cmd+Shift+L — so the command
// set exists and is merely keyboard-only. The caret makes it visible.
//
// A DIVIDER IS A SEMANTIC BOUNDARY HERE, not decoration. Everything above it is an everyday
// action; everything below it can destroy work, and putting the two in one undifferentiated list
// would be the design saying they are the same weight of thing.

import { useState } from "react";

import { ICON } from "../lib/tokens.ts";
import { AlertTriangleIcon } from "./panelIcons.tsx";
import { Icon } from "../lib/icons/registry.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";

export interface SplitAction {
  id: string;
  label: string;
  onSelect: () => void;
  /** Renders below the divider, in the warning tone. For anything that can overwrite work. */
  danger?: boolean;
  /** §A.2: a menu entry that cannot be used says why, in place, rather than merely dimming. */
  reason?: string | null;
  title?: string;
}

export function SplitButton({
  primary,
  actions,
  /** The whole control is unavailable — §A.1's broken-link row disables the dropdown too. */
  disabled = false,
  className = "",
}: {
  /**
   * The left half, or null for a state with no suggested action.
   *
   * NULL IS A REAL CASE. §A.1's table gives `✓ in sync` no primary at all and has the button read
   * "Sync" instead — because inventing a suggested action for a state that needs none would put a
   * button in front of somebody who has nothing to do, which is exactly what §3.5 avoids by
   * omitting it.
   */
  primary: { label: string; onSelect: () => void; reason?: string | null; title?: string } | null;
  actions: SplitAction[];
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const everyday = actions.filter((a) => !a.danger);
  const dangerous = actions.filter((a) => a.danger);
  const primaryBlocked = Boolean(primary?.reason) || disabled;

  return (
    // A RADIX MENU (ui/dropdown-menu.tsx) behind the caret: focus into it and back, arrow keys,
    // Escape and a press outside — what a hand-wired listener and the focus hook did here.
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div className={`relative ${className}`}>
        {/* One rounded box with a hairline between the halves, the same pairing §A.8 uses for
            Commit and ↑ — so they read as one control with two affordances rather than as two
            buttons that happen to be adjacent. */}
        <span className="inline-flex overflow-hidden rounded-control bg-panel">
          <button
            type="button"
            className="px-3 py-1.5 text-caption text-ink transition-colors hover:bg-active active:bg-chrome disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!primary || primaryBlocked}
            title={primary?.title}
            onClick={() => primary?.onSelect()}
          >
            {/* "Sync" for a state with no suggested action — see the `primary` note above. */}
            {primary?.label ?? "Sync"}
          </button>
          <span className="w-px shrink-0 bg-hair" aria-hidden />
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More sync actions"
            title="More sync actions"
              className="px-1.5 py-1.5 text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled}
            >
              <span className={`inline-block transition-transform duration-fast ${open ? "rotate-180" : ""}`}>
                <Icon.github.syncMore size={ICON.xs} />
              </span>
            </button>
          </DropdownMenuTrigger>
        </span>

        <DropdownMenuContent align="end" aria-label="Sync actions">
          {everyday.map((a) => <MenuRow key={a.id} action={a} />)}
          {dangerous.length > 0 && (
            <>
              {everyday.length > 0 && <DropdownMenuSeparator className="bg-hair" />}
              {dangerous.map((a) => <MenuRow key={a.id} action={a} />)}
            </>
          )}
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  );
}

function MenuRow({ action }: { action: SplitAction }) {
  const blocked = Boolean(action.reason);
  return (
    <div>
      <DropdownMenuItem
        size="compact"
        tone={action.danger ? "danger" : "default"}
        disabled={blocked}
        title={action.title}
        onSelect={action.onSelect}
      >
        {action.label}
        {/* The warning mark rides with the label rather than replacing it, so the row is still a
            verb somebody can read at a glance. */}
        {action.danger && (
          <span className="ml-auto shrink-0 text-err" aria-hidden>
            <AlertTriangleIcon size={ICON.xs} />
          </span>
        )}
      </DropdownMenuItem>
      {/* §A.2 inside the menu too: a dimmed row with no explanation is the same silent failure a
          dimmed button is, and a menu is where somebody has gone LOOKING for the action. */}
      {action.reason && (
        <div className="px-2 pb-1 text-tiny leading-[1.4] text-faint">{action.reason}</div>
      )}
    </div>
  );
}

// ⊕ Add — the explicit context channel, §4.
//
// WHY IT EXISTS, in the spec's own terms: Jaroku's context is passive and selection-based — the
// composer scopes to whatever trace step or graph node happens to be selected. That is right for
// the common case and useless for the rest. There is no way to reference a file you have not
// clicked, a run from yesterday, or a failing eval case without leaving the conversation. ⊕ is the
// explicit channel, and it is ADDITIVE to selection context rather than a replacement for it.
//
// THE BOUNDARY IS THE POINT (§4.5). ⊕ only brings context IN. It never pushes, pulls, commits,
// force-overrides, writes files or executes tools. Those are deliberate, confirmed, audit-logged
// actions and they live in their own panels. The composer gathers intent; it never performs
// privileged actions — and this is the control where blurring that line would be easiest and
// worst, because "attach a commit" and "push a commit" are one word apart.
//
// FIVE ROWS, ONE PICKER (§4.2). Each row opens the same searchable picker with a different data
// source, on the command-palette infrastructure — "same component, different data source. Do not
// build five bespoke modals."
//
// A SOURCE WITH NOTHING BEHIND IT IS HIDDEN, NOT DISABLED. The spec says this about GitHub — "an
// empty menu item that always fails is worse than no item" — and the same reasoning covers the
// other four: an agent that has never been generated has no file tree, and a row that opens an
// empty picker teaches people not to open the menu.

import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../EmptyState.tsx";
import { Glyph, GLYPH } from "../icons.ts";
import { Icon } from "../../lib/icons/registry.ts";
import { ControlButton } from "./ControlButton.tsx";
import { Popover, PopoverRow } from "./Popover.tsx";
import { AttachPicker, SOURCES, type AttachKind, type AttachableRow } from "./AttachPicker.tsx";

export function AddMenu({
  agentId,
  /** Which sources have anything behind them. A source absent from this set is not rendered. */
  available,
  /**
   * Why the list is empty, when the reason is a read that failed rather than an agent with
   * nothing in it. The two are indistinguishable from `available` alone — both are an empty set —
   * and telling somebody to "generate an agent" about an agent with two published versions is a
   * confident wrong answer rather than a missing one, which is the failure this field prevents.
   */
  unavailable = null,
  onPick,
  disabled = false,
  openSignal = 0,
}: {
  agentId: string | null;
  available: ReadonlySet<AttachKind>;
  unavailable?: string | null;
  onPick: (kind: AttachKind, rows: AttachableRow[]) => void;
  disabled?: boolean;
  /** §3.3's ⌘/. A counter rather than a boolean: the chord pressed twice must open the menu
   *  twice, and a flag that is already true is a keystroke that does nothing. */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<AttachKind | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Not on the first render — a nonce starting at 0 would open the menu on mount, which is a
  // popover over the composer every time somebody opens a thread.
  useEffect(() => {
    if (openSignal > 0 && !disabled) setOpen(true);
  }, [openSignal, disabled]);

  const rows = SOURCES.filter((s) => available.has(s.kind));

  return (
    <div className="relative shrink-0">
      <ControlButton
        buttonRef={triggerRef}
        icon={Icon.composer.attach}
        name="Attach context"
        title="Attach a file, run, dataset case, tool schema or GitHub reference"
        expanded={open}
        active={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      />

      <Popover open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Attach context" width={300}>
        {rows.length > 0 ? (
          rows.map((s) => (
            <PopoverRow
              key={s.kind}
              label={s.label}
              detail={s.hint}
              icon={<Glyph icon={s.icon} size={GLYPH.menu} />}
              onSelect={() => {
                // The menu closes as the picker opens. Two stacked overlays would put two Escape
                // handlers over each other, and §3.3's Esc order has exactly one popover in it.
                setOpen(false);
                setPicking(s.kind);
              }}
            />
          ))
        ) : (
          <EmptyState
            size="inline"
            icon={({ size }) => <Glyph icon={Icon.composer.attach} size={size ?? GLYPH.empty} />}
            title={unavailable ? "Nothing to attach right now" : "Nothing to attach yet"}
            hint={
              unavailable
                ? `This agent's files could not be read, so there is nothing here to reference. ${unavailable}`
                : "Generate an agent, run it, or link it to GitHub — then its files, runs and commits can be referenced from here."
            }
          />
        )}
      </Popover>

      {picking && (
        <AttachPicker
          kind={picking}
          agentId={agentId}
          open
          onClose={() => setPicking(null)}
          onPick={(chosen) => onPick(picking, chosen)}
        />
      )}
    </div>
  );
}

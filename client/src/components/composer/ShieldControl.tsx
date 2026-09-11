// The permission shield — control 4 in the bar, §3.2.
//
// THIS CONTROL DECIDES NOTHING. It writes a row; the server reads that row at the moment a tool
// call stops and asks. That separation is the feature, not an implementation detail: §12.7 asks for
// the invariant to be verified "server-side with the client bypassed", which is only a meaningful
// test if the client was never where the decision lived. Everything visible here is a report of a
// policy that is enforced somewhere else.
//
// WHICH IS ALSO WHY A REFUSAL IS RENDERED RATHER THAN PREVENTED. A workspace admin can pin the
// mode or disallow Auto, and this control can be looking at a stale row when they do. So the
// server answers 409 with a sentence naming the policy, and that sentence is what the user sees —
// rather than a control that silently snaps back, which reads as the app being broken.
//
// THREE MODES, AND THERE IS NO FOURTH. The spec is unusually direct: "There is no 'approve
// everything' mode, and adding one later is a product decision, not an implementation shortcut."
//
// COLOUR IS NEVER THE ONLY SIGNAL (§10), and on the bar it is no signal at all: the shield draws
// one blue in every mode (2026-09-10), §04's info a shade darker — see `SHIELD_BLUE` — and
// deliberately NOT the amber used for in-flight, which has exactly one meaning in this app and
// keeps it. Auto carries a different word and a caution mark, so the state survives a monochrome
// screen and a colour-blind reader.

import { useRef, useState } from "react";
import { Icon } from "../../lib/icons/registry.ts";
import { ControlButton } from "./ControlButton.tsx";
import { Popover, PopoverNote, PopoverRow } from "./Popover.tsx";
import { SHIELD_BLUE, STATUS } from "../../lib/tokens.ts";
import type { PermissionMode } from "../../store/composerSettingsStore.ts";

/**
 * §3.2's three, with its own descriptions.
 *
 * THE IDS ARE NOT THE NAMES. The product owner renamed the modes on 2026-09-11: `smart` reads
 * "Fast" and `fast` reads "Auto". The ids stayed, because they are what a conversation row, the
 * workspace policy, the audit log and the runtime's PERMISSION_MODE all store — so a comment
 * anywhere else that says "Fast" means the `fast` id, which people now see as Auto.
 */
const MODES: { id: PermissionMode; label: string; detail: string }[] = [
  { id: "strict", label: "Strict", detail: "confirm every tool call" },
  { id: "smart", label: "Fast", detail: "confirm writes & destructive" },
  { id: "fast", label: "Auto", detail: "auto-approve read-only tools" },
];

/** What a mode is called on screen — from the table, never from the id. */
export function modeLabel(mode: PermissionMode): string {
  return MODES.find((m) => m.id === mode)?.label ?? mode;
}

export function ShieldControl({
  value,
  dense,
  pinned,
  fastDisallowed,
  disabled = false,
  onPick,
}: {
  value: PermissionMode;
  dense: boolean;
  /** An admin pinned the workspace default — the control renders read-only with a tooltip (§3.2). */
  pinned: boolean;
  /** Auto (`fast`) is disallowed workspace-wide. The option is DISABLED, never hidden — see the row. */
  fastDisallowed: boolean;
  disabled?: boolean;
  onPick: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative shrink-0">
      {/* BLUE IN EVERY MODE, the glyph and the word — the product owner's call on 2026-09-10, in
          `SHIELD_BLUE`, a shade darker than §04's info. The colour is a derived value rather than a
          class, so it rides on this box-less span and the button inherits it: `!text-current` so
          neither the bar's hover ink nor an open popover turns it grey or black. Auto is told apart
          by its word and its caution mark, which is what §10 asks of it anyway. */}
      <span className="contents" style={{ color: SHIELD_BLUE }}>
        <ControlButton
          buttonRef={triggerRef}
          icon={Icon.composer.permissions}
          // The word stays at every width the bar shows the shield — composerBar.ts's KEEPS_LABEL —
          // and Auto carries a caution mark in it, because §10 requires the state to be carried by
          // more than colour.
          label={dense ? undefined : value === "fast" ? `${modeLabel(value)} ⚠` : modeLabel(value)}
          name={`Permission mode: ${modeLabel(value)}`}
          title={
            pinned
              ? `Permission mode is pinned to ${modeLabel(value)} by a workspace policy`
              : `Permission mode — ${MODES.find((m) => m.id === value)?.detail ?? modeLabel(value)}`
          }
          expanded={open}
          active={open}
          disabled={disabled || pinned}
          onClick={() => setOpen((v) => !v)}
          className="!text-current"
        />
      </span>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Permission mode" width={320}>
        {MODES.map((m) => {
          const blocked = m.id === "fast" && fastDisallowed;
          return (
            <PopoverRow
              key={m.id}
              label={
                <span style={m.id === "fast" && !blocked ? { color: STATUS.warn } : undefined}>
                  {m.label}
                  {m.id === "fast" && " ⚠"}
                </span>
              }
              // DISABLED, NOT HIDDEN. A missing option is a question ("where did Auto go?") with no
              // answer on screen; a disabled one with the policy written under it answers it.
              detail={blocked ? "disallowed by a workspace policy" : m.detail}
              disabled={blocked}
              selected={m.id === value}
              onSelect={() => {
                onPick(m.id);
                setOpen(false);
              }}
            />
          );
        })}
        <PopoverNote>
          {/* The spec's own footnote, and it is load-bearing rather than reassuring: it is the one
              place a user is told that the mode they are choosing does NOT reach these files. A
              shield with three settings and no statement of what none of them can do would read as
              "Auto means anything goes". */}
          Protected files are never writable in any mode. Reviewed connectors,{" "}
          <code className="font-mono text-tiny">tools/__init__.py</code> and the MCP bridge stay
          read-only.
        </PopoverNote>
      </Popover>
    </div>
  );
}

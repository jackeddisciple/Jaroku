// The message action row — §5.
//
// ALWAYS VISIBLE ON THE LAST TURN, on hover or focus for earlier ones, and NEVER hidden from the
// keyboard. That last clause is the one that makes this more than a CSS rule: §5 says the row "must
// be reachable in tab order", so the earlier turns' rows are hidden with opacity rather than with
// `display: none`, and `focus-within` brings them back. A row that only existed under a pointer
// would put copy, regenerate and feedback out of reach of anybody driving this app by keyboard —
// which is most of the people it was built for.
//
// COPY AND REGENERATE HERE; note, pin and feedback join them next, in this component, because they
// are the same row with the same visibility rule and the same keyboard model.
//
// REGENERATION IS BLOCKED WHILE A TURN IS STREAMING (§5.4, §9), and the tooltip says why rather
// than the button simply being grey. A disabled control with no explanation is one people press
// twice and then report as broken.

import { useRef, useState } from "react";
import { Glyph, Icon, GLYPH, HIT_TARGET } from "../icons.ts";
import { CopyTurn } from "./CopyTurn.tsx";
import { Popover, PopoverRow } from "./Popover.tsx";

/** One glyph in the row. The geometry is shared so five of them form an even strip. */
export function ActionButton({
  icon,
  name,
  title,
  onClick,
  disabled = false,
  pressed,
  count,
  className = "",
  buttonRef,
}: {
  icon: (typeof Icon)[keyof typeof Icon];
  name: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** A badge — the note count. Rendered only above zero (§5.2). */
  count?: number;
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
      title={title ?? name}
      className={`relative inline-flex items-center justify-center rounded-control text-muted
        transition-colors duration-fast hover:bg-active hover:text-ink
        focus-visible:outline-none focus-visible:shadow-focusring
        disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
      style={{ minWidth: HIT_TARGET, minHeight: HIT_TARGET }}
    >
      <Glyph icon={icon} size={GLYPH.action} />
      {typeof count === "number" && count > 0 && (
        <span
          className="absolute right-1 top-1 rounded-full bg-accent px-1 text-[9px] font-medium leading-[1.4] text-bg"
          aria-hidden
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function TurnActions({
  /** The markdown SOURCE of the response. §5.1 — never the rendered text. */
  source,
  /** Always visible on the last turn; on hover/focus otherwise. */
  isLast = false,
  streaming = false,
  onRegenerate,
  onRegenerateWith,
  /** The models offered by "Regenerate with different model". From the server's catalogue. */
  models = [],
  className = "",
}: {
  source: string;
  isLast?: boolean;
  streaming?: boolean;
  onRegenerate?: () => void;
  onRegenerateWith?: (opts: { modelId?: string; effort?: "high" | "xhigh" }) => void;
  models?: { id: string; label: string }[];
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className={`flex items-center gap-0.5 transition-opacity duration-fast
        focus-within:opacity-100 group-hover/turn:opacity-100 motion-reduce:transition-none
        ${isLast ? "opacity-100" : "opacity-0"} ${className}`}
      // OPACITY, NOT `display: none`. §5's rule that the row stays in tab order on every turn — a
      // hidden element is not focusable, and `focus-within` above can never fire for it.
      role="group"
      aria-label="Response actions"
    >
      <CopyTurn source={source} />

      {onRegenerate && (
        <ActionButton
          icon={Icon.Regenerate}
          name="Regenerate this response"
          title={
            streaming
              // §9: "Regenerate during stream — Blocked, tooltip explains." The sentence is the
              // point; a grey button with no reason is one people press twice.
              ? "Wait for this response to finish before regenerating it"
              : "Re-run the same message with the current settings"
          }
          disabled={streaming}
          onClick={onRegenerate}
        />
      )}

      {onRegenerateWith && (
        <div className="relative">
          {/* §5.4's kebab: "Regenerate with different model" and "Regenerate with higher effort" —
              "the two things people actually want when a response disappoints, without re-typing." */}
          <button
            ref={kebabRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={streaming}
            aria-label="Regenerate with different settings"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="Regenerate with a different model or more effort"
            className="inline-flex items-center justify-center rounded-control text-muted transition-colors
              duration-fast hover:bg-active hover:text-ink focus-visible:outline-none
              focus-visible:shadow-focusring disabled:cursor-not-allowed disabled:opacity-30"
            style={{ minWidth: HIT_TARGET / 1.6, minHeight: HIT_TARGET }}
          >
            <span aria-hidden className="text-[13px] leading-none">⌄</span>
          </button>
          <Popover
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            triggerRef={kebabRef}
            label="Regenerate with different settings"
            width={260}
          >
            <PopoverRow
              label="Regenerate with higher effort"
              detail="same model, more thinking"
              onSelect={() => { onRegenerateWith({ effort: "xhigh" }); setMenuOpen(false); }}
            />
            {models.map((m) => (
              <PopoverRow
                key={m.id}
                label={`Regenerate with ${m.label}`}
                detail={m.id}
                onSelect={() => { onRegenerateWith({ modelId: m.id }); setMenuOpen(false); }}
              />
            ))}
          </Popover>
        </div>
      )}
    </div>
  );
}

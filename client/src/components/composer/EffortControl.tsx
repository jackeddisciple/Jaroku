// Reasoning effort — control 3 in the bar, §3.2.
//
// FOUR LEVELS, AND THE VALUE ACTUALLY APPLIED IS NOT THIS CONTROL'S BUSINESS. What this sets is
// what the NEXT turn asks for; what a past turn got is on that turn's record, and §6.2 reads it
// from there. The two drift constantly — somebody switches model, a budget clamps — and a metadata
// row that re-derived the level from this control would report the effort of a request that has
// not happened yet.
//
// A PER-TURN OVERRIDE IS NOT STICKY (§3.2). The popover's checkbox is what makes a choice
// persist, and the default is UNCHECKED — so the common case, "more thinking just for this one",
// costs nothing and leaves nothing behind. That is the opposite of how a settings control usually
// behaves, and it is the right way round here: effort is a property of a question, not of a
// conversation, and a workspace that quietly drifted to XHigh because somebody once needed it
// would be a bill nobody can account for.
//
// DEGRADATION IS VISIBLE (§12.4). A model with no reasoning control renders this DISABLED with a
// tooltip naming the model, rather than hiding it. Hiding would move nothing — the bar is packed,
// not spread — but it would also leave a user wondering where a control went; "Claude Haiku
// doesn't expose a reasoning control" answers the question they actually have.
//
// AND THE COST HINT IS A MULTIPLE, NEVER A DOLLAR FIGURE. §3.2: "Do not show a fake precise dollar
// figure pre-flight." Nobody knows what a request will spend before it runs.

import { useRef, useState } from "react";
import { Icon } from "../../lib/icons/registry.ts";
import { ControlButton } from "./ControlButton.tsx";
import { Popover, PopoverNote, PopoverRow } from "./Popover.tsx";
import { CheckboxField } from "../Checkbox.tsx";
import type { Effort } from "../../store/composerSettingsStore.ts";
import type { ProviderModel } from "../../types.ts";

/** §3.2's own descriptions, in its own order. */
const LEVELS: { id: Effort; label: string; detail: string }[] = [
  { id: "low", label: "Low", detail: "fastest, cheapest" },
  { id: "medium", label: "Medium", detail: "balanced" },
  { id: "high", label: "High", detail: "deeper planning" },
  { id: "xhigh", label: "XHigh", detail: "slowest, most thorough" },
];

export function effortLabel(level: Effort): string {
  return level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1);
}

/**
 * The relative cost hint, mirroring the server's `relativeCost`.
 *
 * A SECOND IMPLEMENTATION, AND SAID OUT LOUD RATHER THAN PRETENDED AWAY. The server's version is
 * what a request is actually planned against; this one exists because the hint is rendered on
 * every popover open and a round trip per open would make the menu feel broken. It is derived from
 * the same ratios and it describes the same table — but it is a hint, and if the two ever disagree
 * the server's is the one that decided anything.
 *
 * It is deliberately NOT precise. §3.2 rules out a dollar figure pre-flight, and a multiple is the
 * most anybody can honestly say before a single token has been spent.
 */
function costHint(model: ProviderModel | undefined, level: Effort): string | null {
  if (!model?.reasoning || level === "medium") return null;
  if (model.reasoning === "effort") {
    return level === "low" ? "cheaper than Medium" : "more than Medium";
  }
  // Mirrors runtime/pricing.json's budgets: 0 / 4000 / 16000 / 32000.
  const ratio: Record<Effort, number> = { low: 0, medium: 1, high: 4, xhigh: 8 };
  const r = ratio[level];
  return r === 0 ? "no thinking tokens" : `~${r}× tokens vs Medium`;
}

export function EffortControl({
  value,
  model,
  dense,
  disabled = false,
  remembered,
  onPick,
}: {
  value: Effort;
  /** The selected model's catalogue entry — the server's capability record, not a local table. */
  model: ProviderModel | undefined;
  /** Below ~720px the control is icon-only; the value moves into the tooltip. */
  dense: boolean;
  disabled?: boolean;
  /** Whether this conversation has said anything of its own about effort. */
  remembered: boolean;
  /** `remember` false is a per-turn override and must not persist — §3.2. */
  onPick: (level: Effort, remember: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(remembered);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // §12.4. `reasoning: null` means the model exposes no control at all.
  const unsupported = !model?.reasoning;

  return (
    <div className="relative shrink-0">
      <ControlButton
        buttonRef={triggerRef}
        icon={Icon.composer.effort}
        label={dense ? undefined : effortLabel(value)}
        name={`Reasoning effort: ${effortLabel(value)}`}
        title={
          unsupported
            // The spec's own worked tooltip. It names the MODEL rather than saying "unsupported",
            // because the useful next action is switching model and the sentence should say so.
            ? `${model?.id ?? "This model"} doesn't expose a reasoning control.`
            : `Reasoning effort — ${effortLabel(value)}`
        }
        expanded={open}
        // Non-default is worth showing as engaged; Medium is the resting state and should not
        // light up, or every composer in the product renders with a control already active.
        active={open || value !== "medium"}
        disabled={disabled || unsupported}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Reasoning effort" width={280}>
        {LEVELS.map((l) => (
          <PopoverRow
            key={l.id}
            label={l.label}
            detail={
              <>
                {l.detail}
                {/* The hint sits with the level it is about rather than in a footer, so the
                    comparison is where the decision is made. */}
                {costHint(model, l.id) && <span className="text-faint"> · {costHint(model, l.id)}</span>}
              </>
            }
            selected={l.id === value}
            onSelect={() => {
              onPick(l.id, remember);
              setOpen(false);
            }}
          />
        ))}
        <PopoverNote>
          {/* THE CHECKBOX IS THE STICKY-NESS, and it is unchecked by default. Clicking a level
              above applies it to the next turn; ticking this first is what makes it the
              conversation's answer. */}
          <CheckboxField
            checked={remember}
            onChange={() => setRemember((v) => !v)}
            title="Off by default: a level picked without this applies to the next turn only"
          >
            Remember for this workspace
          </CheckboxField>
        </PopoverNote>
      </Popover>
    </div>
  );
}

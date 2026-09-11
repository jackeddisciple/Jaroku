// Reasoning effort — control 3 in the bar, §3.2 — as a slider, in ink.
//
// FIVE LEVELS, NAMED BY THE PROVIDER. What a stop is called comes from the catalogue: Claude's "Low,
// Medium, High effort, XHigh, Max effort" and OpenAI's "Light, Medium, High, Extra High, Ultra" — the
// product owner's words, 2026-09-11. Which stops a model HAS comes from there too, and a model with
// none — Muse Spark by that same call, Haiku 4.5 because it takes no effort — has no control at all:
// the composer leaves the slot out rather than drawing a slider that would change nothing.
//
// THE VALUE ACTUALLY APPLIED IS NOT THIS CONTROL'S BUSINESS. What this sets is what the NEXT turn
// asks for; what a past turn got is on that turn's record, and §6.2 reads it from there. The two
// drift constantly — somebody switches model, a budget clamps — and a metadata row that re-derived
// the level from this control would report the effort of a request that has not happened yet.
//
// A PER-TURN OVERRIDE IS NOT STICKY (§3.2). The checkbox is what makes a choice persist, and the
// default is UNCHECKED — so "more thinking just for this one" costs nothing and leaves nothing
// behind. Effort is a property of a question, not of a conversation, and a workspace that quietly
// drifted to Max because somebody once needed it would be a bill nobody can account for.
//
// AND THE COST HINT IS A DIRECTION OR A MULTIPLE, NEVER A DOLLAR FIGURE. §3.2: "Do not show a fake
// precise dollar figure pre-flight." Nobody knows what a request will spend before it runs.

import { useCallback, useRef, useState } from "react";
import { Icon } from "../../lib/icons/registry.ts";
import { ICON } from "../../lib/tokens.ts";
import { effortName, effortStops, stopFor } from "../../lib/effortLevels.ts";
import { ControlButton } from "./ControlButton.tsx";
import { Popover, PopoverNote } from "./Popover.tsx";
import { CheckboxField } from "../Checkbox.tsx";
import type { Effort } from "../../store/composerSettingsStore.ts";
import type { ProviderModel } from "../../types.ts";

// The metadata row names a past turn's level with this; it lives beside the stops now.
export { effortLabel } from "../../lib/effortLevels.ts";

/** The thumb's diameter. The end stops sit half of it in from each end, so it never overhangs. */
const THUMB = 22;

/**
 * The relative cost hint, mirroring the server's `relativeCost`.
 *
 * A SECOND IMPLEMENTATION, AND SAID OUT LOUD RATHER THAN PRETENDED AWAY. The server's version is
 * what a request is actually planned against; this one exists because the hint is rendered on every
 * open and a round trip per open would make the control feel broken. On a named-effort model — every
 * one the product offers — the honest hint is a direction: named levels expose no budget to compare.
 */
function costHint(model: ProviderModel | undefined, level: Effort): string | null {
  if (!model?.reasoning || level === "medium") return null;
  if (model.reasoning === "effort") return level === "low" ? "cheaper than Medium" : "more than Medium";
  // Mirrors runtime/pricing.json's budgets: 0 / 4000 / 16000 / 32000 / 64000.
  const ratio: Record<Effort, number> = { low: 0, medium: 1, high: 4, xhigh: 8, max: 16 };
  const r = ratio[level];
  return r === 0 ? "no thinking tokens" : `~${r}× tokens vs Medium`;
}

/**
 * The slider itself: a track, a fill in ink up to the thumb, and a dot for every stop.
 *
 * IT SNAPS. A level is one of a model's stops, not a number between them, so a press or a drag lands
 * on the nearest stop and the keyboard steps from one to the next — the way a slider answers arrows,
 * Home and End, announced by the level's own name rather than by an index nobody chose.
 */
function EffortSlider({
  stops,
  value,
  nameOf,
  onChange,
}: {
  stops: readonly Effort[];
  value: Effort;
  nameOf: (level: Effort) => string;
  onChange: (level: Effort) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const index = Math.max(0, stops.indexOf(value));
  const last = Math.max(1, stops.length - 1);
  // Where stop `i` sits: THUMB/2 in from the left, across the width that leaves THUMB/2 at the right.
  const at = (i: number): string => `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${i / last})`;

  const go = (level: Effort | undefined): void => {
    if (level && level !== value) onChange(level);
  };
  const pickAt = (clientX: number): void => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= THUMB) return;
    const f = Math.min(1, Math.max(0, (clientX - r.left - THUMB / 2) / (r.width - THUMB)));
    go(stops[Math.round(f * last)]);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-valuemin={0}
      aria-valuemax={stops.length - 1}
      aria-valuenow={index}
      aria-valuetext={nameOf(value)}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        pickAt(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) pickAt(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
        if (step) go(stops[Math.min(stops.length - 1, Math.max(0, index + step))]);
        else if (e.key === "Home") go(stops[0]);
        else if (e.key === "End") go(stops[stops.length - 1]);
        else return;
        e.preventDefault();
      }}
      className="relative mt-3 h-8 cursor-pointer touch-none select-none rounded-full outline-none focus-visible:shadow-focusring"
    >
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-edge" />
      {/* THE FILL, IN INK — the product owner asked for the slider in black, and ink is this palette's
          black. It runs from the start of the track to the thumb's centre. */}
      <span
        aria-hidden
        className="absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-ink transition-[width] duration-fast ease-state motion-reduce:transition-none"
        style={{ width: at(index) }}
      />
      {stops.map((s, i) => (
        <span
          key={s}
          aria-hidden
          className={`absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            i < index ? "bg-elevated/60" : i > index ? "bg-faint" : "hidden"
          }`}
          style={{ left: at(i) }}
        />
      ))}
      <span
        aria-hidden
        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-edge bg-elevated shadow-floating transition-[left] duration-fast ease-state motion-reduce:transition-none"
        style={{ left: at(index), width: THUMB, height: THUMB }}
      />
    </div>
  );
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
  /** The selected model's catalogue entry — its stops and its provider's names for them. */
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
  // STABLE, BECAUSE THE POPOVER RE-RUNS ITS OPEN EFFECT WHEN THIS CHANGES — and that effect puts focus
  // on the first row. Every step of the slider re-renders this control while it is open, so an inline
  // `() => setOpen(false)` sent focus to the reset button after each key and the next key went nowhere.
  const close = useCallback(() => setOpen(false), []);

  const stops = effortStops(model);
  // No stops, no control. The composer already leaves the slot out for such a model; this is the
  // same answer for anything else that mounts the control.
  if (stops.length === 0) return null;

  // A remembered level this model does not have sits at the highest stop below it — which is also
  // the level the server would run it at.
  const at = stopFor(stops, value) ?? stops[0]!;
  const name = effortName(model, at);
  const hint = costHint(model, at);

  return (
    <div className="relative shrink-0">
      <ControlButton
        buttonRef={triggerRef}
        icon={Icon.composer.effort}
        label={dense ? undefined : name}
        name={`Reasoning effort: ${name}`}
        title={`Reasoning effort — ${name}`}
        expanded={open}
        // Non-default is worth showing as engaged; Medium is the resting state and should not light
        // up, or every composer in the product renders with a control already active.
        active={open || at !== "medium"}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={close} triggerRef={triggerRef} label="Reasoning effort" width={300}>
        <div className="px-2 pb-2 pt-1.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-ink">{name}</div>
              <div className="mt-0.5 truncate text-caption text-muted">
                {model?.name}
                {hint && <span className="text-faint"> · {hint}</span>}
              </div>
            </div>
            {/* BACK TO MEDIUM, the resting level — offered only when there is somewhere to go back from. */}
            {at !== "medium" && stops.includes("medium") && (
              <button
                type="button"
                onClick={() => onPick("medium", remember)}
                title={`Back to ${effortName(model, "medium")}`}
                aria-label={`Reset effort to ${effortName(model, "medium")}`}
                className="-mr-1 rounded-control p-1 text-muted transition-colors duration-fast hover:bg-active hover:text-ink"
              >
                <Icon.composer.effortReset size={ICON.sm} />
              </button>
            )}
          </div>
          <EffortSlider
            stops={stops}
            value={at}
            nameOf={(level) => effortName(model, level)}
            onChange={(level) => onPick(level, remember)}
          />
        </div>
        <PopoverNote>
          {/* THE CHECKBOX IS THE STICKY-NESS, and it is unchecked by default. Moving the slider
              applies the level to the next turn; ticking this first is what makes it the
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

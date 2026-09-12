// The response metadata row — §6.
//
// ◆ Claude Sonnet 4.6   🧠 High   { } v14   ⧗ 12.4s        ‹ 2/2 ›
//
// SMALL, MUTED, ONE LINE, AND ONE SATURATED THING IN IT. §6.1 spends the row's only colour on the
// provider mark, and gives the reason: it is "the fastest way to answer 'which model wrote this?'
// when comparing across a thread, and Jaroku is explicitly multi-provider." Colouring anything else
// here would cost that mark the thing that makes it findable.
//
// THE ORDER IS FIXED AND ABSENT ITEMS COLLAPSE — §6.5, and the rules live in lib/turnMetadata.ts
// with their own suite, because the natural implementation (map over what exists) passes every
// hand-written case and moves the duration on any turn that produced code.
//
// IT READS THE TURN RECORD, NEVER THE TOOLBAR. §6.2: the effort shown is "the level actually
// applied to this request, read from the turn record — not the current toolbar value, which may
// have changed since." Same for the model. A row that re-derived from the composer would describe
// a request that has not happened yet.
//
// AND IT IS A NAVIGATION SURFACE, not only a readout (§6.3): the build chip opens that version's
// diff. "The fastest path from 'this response' to 'the code it wrote'."

import { useState } from "react";

import { Glyph, GLYPH, HIT_TARGET } from "../icons.ts";
import { Chip } from "../Chip.tsx";
import { fmtCost, fmtTokens } from "../../lib/format.ts";
import { Icon } from "../../lib/icons/registry.ts";
import { ProviderMark } from "../../lib/icons.tsx";
import { DiffStat } from "../DiffStat.tsx";
import { Truncate } from "../Truncate.tsx";
import {
  METADATA_SLOTS, diffSummary, formatDuration, isClamped, presentSlots, variantLabel,
  type TurnMeta,
} from "../../lib/turnMetadata.ts";
import { effortLabel } from "./EffortControl.tsx";
import type { Effort } from "../../store/composerSettingsStore.ts";

export function TurnMetadata({
  meta,
  /** True while this turn is still streaming — the duration counts up in amber (§6.4). */
  streaming = false,
  /** Live elapsed ms while streaming. Ignored once the turn has a recorded duration. */
  elapsedMs = null,
  onOpenVersion,
  onSwitchVariant,
  modelLabel,
}: {
  meta: TurnMeta;
  streaming?: boolean;
  elapsedMs?: number | null;
  onOpenVersion?: () => void;
  onSwitchVariant?: (ordinal: number) => void;
  /** From the shared model metadata file — §6.1 forbids a hardcoded display string. */
  modelLabel?: string | null;
}) {
  // §13.2's EXPANSION, and it is local rather than a store: which turn's reason is showing is a
  // fact about one row on one screen, and a store would make it a fact about the conversation.
  const [why, setWhy] = useState(false);
  const present = presentSlots(meta);
  const clamped = isClamped(meta);
  // While streaming there is no recorded duration yet, so the live figure stands in for it — and
  // the slot is occupied either way, which is what stops the row reflowing on completion.
  const duration = streaming ? formatDuration(elapsedMs) : formatDuration(meta.durationMs);
  const diff = diffSummary(meta);

  const slot = (name: (typeof METADATA_SLOTS)[number]): React.ReactNode => {
    switch (name) {
      /**
       * §13.1's ROUTE, as a chip — and the chip expands to say why.
       *
       * `Chip.tsx`, WHICH §13.1 NAMES. Not a bare word and not a new component: the client had
       * eleven versions of a chip before `Chip.tsx` existed, and a route label is exactly what a
       * chip is for — "a short label ABOUT something".
       *
       * MUTED, NEVER COLOURED (§13.3). "Colour carries meaning only, and 'which model answered' is
       * not a status." The same holds for which route: a coloured route chip would compete with the
       * one saturated element in this row, which §6.1 spends deliberately on the provider mark.
       *
       * A BUTTON ONLY WHEN THERE IS A REASON TO SHOW. §13.2's explanation "comes from the record
       * the router already writes" — so a turn with no recorded reason has nothing to expand, and a
       * control that opened an empty popover would be the dead control this product refuses.
       */
      case "route": {
        if (!present.has("route")) return null;
        const reason = meta.routeReason;
        return (
          <span key="route" className="inline-flex shrink-0 items-center gap-1">
            <Chip
              size="sm"
              tone="muted"
              variant="outline"
              // NOT MONO, AND `test:type-scale` IS RIGHT TO REFUSE IT. §04's rule is that the mono
              // face marks an IDENTIFIER — a path, a ref, a model id — and a route name is a word:
              // `chat`, `edit`, `explain`. §13.1 reserves the monospace treatment for the MODEL on
              // this line and says nothing about the route, which is the same distinction from the
              // other direction.
              onClick={reason ? () => setWhy((v) => !v) : undefined}
              title={reason ?? `Handled by the ${meta.route} route`}
            >
              {meta.route}
            </Chip>
            {/* §13.2's ONE LINE, IN PLAIN LANGUAGE, and it is the router's own sentence rather than
                a number. "Do not expose a raw confidence number. A score without a scale invites
                the user to reason about a number they cannot calibrate. State the signal, not the
                arithmetic." */}
            {reason && why && <span className="text-tiny text-faint">{reason}</span>}
          </span>
        );
      }

      case "model":
        if (!present.has("model")) return null;
        return (
          <span key="model" className="inline-flex min-w-0 items-center gap-1.5">
            {/* The only saturated element in the row. `active` keeps it in full colour: this is a
                statement of fact about a finished response, not a selection state. */}
            <ProviderMark provider={meta.provider ?? "unknown"} active size={GLYPH.meta} />
            {/* From the catalogue, never a hardcoded string — §6.1. Falls back to the raw id, which
                is honest, rather than to a prettified guess. */}
            <Truncate className="text-muted">{modelLabel || meta.modelId}</Truncate>
          </span>
        );

      case "effort":
        if (!present.has("effort")) return null;
        return (
          <span
            key="effort"
            className="inline-flex shrink-0 items-center gap-1 text-muted"
            title={
              clamped
                // §6.2's exact sentence. It names what was asked for, which is the half a user
                // cannot otherwise recover.
                ? `${effortLabel(meta.effortRequested as Effort)} requested; this model caps at ${effortLabel(meta.effortApplied as Effort)}.`
                : `Reasoning effort: ${effortLabel(meta.effortApplied as Effort)}`
            }
          >
            <Glyph icon={Icon.composer.effort} size={GLYPH.meta} />
            {effortLabel(meta.effortApplied as Effort)}
            {/* The clamp marker. A glyph rather than a colour, so §10's "state must be conveyed by
                more than colour" holds in a row that is deliberately monochrome. */}
            {clamped && <span aria-hidden>⌄</span>}
          </span>
        );

      case "build":
        if (!present.has("build")) return null;
        return (
          <button
            key="build"
            type="button"
            onClick={onOpenVersion}
            disabled={!onOpenVersion}
            title={
              meta.versionStaged
                ? `${meta.versionLabel} is staged and not published yet`
                : `Open ${meta.versionLabel}'s diff`
            }
            aria-label={`Open ${meta.versionLabel}'s diff`}
            className={`inline-flex shrink-0 items-center gap-1 rounded-xs px-1 transition-colors duration-fast
              hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring
              disabled:cursor-default
              ${meta.versionStaged ? "text-run animate-stream-pulse motion-reduce:animate-none" : "text-muted"}`}
            style={{ minHeight: HIT_TARGET / 2 }}
          >
            <Glyph icon={Icon.meta.build} size={GLYPH.meta} />
            {meta.versionLabel}
            {/* §6.3's trailing figures, only while they are still a summary — see `diffSummary`. */}
            {diff && <DiffStat additions={diff.plus} deletions={diff.minus} />}
          </button>
        );

      case "duration": {
        // While streaming the slot is occupied by the live figure even before a duration is
        // recorded, so the row does not reflow the moment the stream ends.
        if (!present.has("duration") && !streaming) return null;
        if (!duration) return null;
        return (
          <span
            key="duration"
            className={`inline-flex shrink-0 items-center gap-1 tabular-nums ${
              // §6.4: counts up live in amber with stream-pulse, freezes on completion. Amber
              // means IN-FLIGHT here, which is the one meaning it has everywhere in this app.
              streaming ? "text-run animate-stream-pulse motion-reduce:animate-none" : "text-muted"
            }`}
            title={streaming ? "Still generating" : "Wall clock, from dispatch to the end of the stream"}
          >
            <Glyph icon={Icon.meta.duration} size={GLYPH.meta} />
            {duration}
          </span>
        );
      }

      /**
       * §13.1's TOKENS: "total for the turn, tabular figure."
       *
       * TABULAR, WHICH IS NOT DECORATION HERE. Two turns one above the other are read as a column,
       * and proportional digits make `1,204` and `987` look like different lengths of the same
       * number. Every figure in this row is `tabular-nums` for the same reason.
       */
      case "tokens": {
        if (!present.has("tokens")) return null;
        return (
          <span key="tokens" className="shrink-0 tabular-nums text-muted" title="Tokens this response spent">
            {fmtTokens(meta.totalTokens, "exact")}
          </span>
        );
      }

      /**
       * §13.1's COST, AND THIS LINE IS WHERE IT LIVES.
       *
       * "§10's figure. Not duplicated elsewhere on the turn — this line IS where cost lives."
       *
       * `fmtCost` RENDERS `null` AS `—`, which is the whole of §10's rule in one call: an unpriced
       * model shows unknown rather than `$0.00`, because a zero next to a real figure one row down
       * reads as "this one was free". The tooltip says which it is, since an em dash alone is a
       * shape rather than a sentence.
       */
      case "cost": {
        if (!present.has("cost")) return null;
        const known = meta.costUsd !== null;
        return (
          <span
            key="cost"
            className="shrink-0 tabular-nums text-muted"
            title={known
              ? "What this response cost"
              // §10: UNKNOWN IS NOT ZERO, and the tooltip is where the reason fits.
              : "Unknown — this model has no pricing entry, so the cost was not recorded"}
          >
            {fmtCost(meta.costUsd)}
          </span>
        );
      }

      case "variants": {
        if (!present.has("variants")) return null;
        const label = variantLabel(meta);
        return (
          <span key="variants" className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-muted">
            <button
              type="button"
              onClick={() => onSwitchVariant?.(meta.ordinal - 1)}
              disabled={meta.ordinal <= 1 || !onSwitchVariant}
              aria-label="Previous response"
              title="Previous response"
              className="rounded-xs px-1 transition-colors duration-fast hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:opacity-30"
            >
              ‹
            </button>
            <span className="tabular-nums" aria-label={`Response ${label}`}>{label}</span>
            <button
              type="button"
              onClick={() => onSwitchVariant?.(meta.ordinal + 1)}
              disabled={meta.ordinal >= meta.total || !onSwitchVariant}
              aria-label="Next response"
              title="Next response"
              className="rounded-xs px-1 transition-colors duration-fast hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring disabled:opacity-30"
            >
              ›
            </button>
          </span>
        );
      }
    }
  };

  const cells = METADATA_SLOTS.map(slot).filter(Boolean);
  if (cells.length === 0) return null;

  return (
    // WRAPPING TO TWO LINES ON NARROW WIDTHS is the spec's own allowance (§6) and is why this is
    // `flex-wrap` rather than the composer bar's `flex-nowrap`. A readout may wrap; a row of
    // controls may not, because wrapping moves the send button.
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-tiny text-muted">
      {/* WALKED IN THE FIXED ORDER AND OMITTED, never filtered and mapped — §6.5. The difference is
          the whole criterion: iterate the order and skip, and positions hold; iterate what is
          present, and they do not. */}
      {cells}
    </div>
  );
}

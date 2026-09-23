// §5.4's tag row: at most three tags, then a `+n` chip that reveals the rest.
//
// EVERY DECISION IS UPSTREAM. Which tags are true, what order they come in, and which three survive
// the trim are `lib/agentTags.ts`'s answers — the specification asks for exactly that split ("one
// component driven by a pure function… do not scatter tag decisions across the card's JSX"), and the
// reason is that the interesting half is a precedence rule that can only be tested as one. What is
// left here is geometry.
//
// `Chip` RATHER THAN A HAND-ROLLED PILL. Eleven hand-rolled pills at six heights were already
// collapsed into one component; this is a strip of tag-shaped labels sitting beside a title, which is
// the exact case that component was written for. Its `color` prop tints the surface with the same
// colour at low alpha, so a tag's fill can never disagree with its text.

import { useState } from "react";
import { Chip } from "./Chip.tsx";
import { agentTagRow, tagColour, tagLabel, type AgentTag, type TagInput } from "../lib/agentTags.ts";

function Tag({ tag }: { tag: AgentTag }) {
  const colour = tagColour(tag);
  return (
    // A TINTED CAPSULE WITH A SOLID DOT, at the full-round rung — the reference exactly. `Chip`
    // builds all of it from the one colour: the text and the dot take it directly and the ground is
    // the same hue at twelve percent, so a capsule's fill can never disagree with what is written
    // on it. `pill` is §04's rung for "status tags, badges and semantic pills", which is what these
    // are and what nothing else using `Chip` is.
    <Chip
      pill
      size="sm"
      color={colour}
      title={tag.title}
      className="shrink-0"
      // THE DOT IS THE CHIP'S ICON SLOT rather than a span in the label, so it sits in the same
      // place the date chip's calendar mark does and inherits the gap the chip already sets.
      // `currentColor` rather than the value again: the chip has already set the text to it.
      icon={<span className="block h-1.5 w-1.5 rounded-full bg-current" />}
    >
      {/* SENTENCE CASE, EXCEPT FOR AN IDENTIFIER — see `tagLabel`. */}
      {tagLabel(tag.label)}
    </Chip>
  );
}

/**
 * The row, beside the agent title.
 *
 * THE OVERFLOW OPENS ON HOVER *AND* ON A CLICK, which is §5.4's "reveals the rest on hover or tap".
 * A hover-only disclosure is unreachable on touch, and this grid's own §5.5 rules already refuse a
 * hover-to-flip thumbnail for that reason — so the chip is a real button that toggles, and the hover
 * is a convenience on top of it rather than the only way in.
 *
 * IT EXPANDS IN PLACE rather than opening a popover. A popover over a card in a grid has to decide
 * which way to open, clips against the scroll container, and closes when the pointer crosses the gap
 * to it. Two more chips on the same line, wrapping if they must, is the whole of what is needed.
 */
export function AgentTagRow({ agent, className = "" }: { agent: TagInput; className?: string }) {
  const [open, setOpen] = useState(false);
  const { shown, overflow } = agentTagRow(agent);
  const expanded = open && overflow.length > 0;

  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}
      // Hover reveals; the pointer leaving puts it back. On touch there is no hover and the button
      // below is what works, which is why both exist.
      onMouseEnter={() => overflow.length > 0 && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {shown.map((t) => (
        <Tag key={t.id} tag={t} />
      ))}
      {expanded && overflow.map((t) => <Tag key={t.id} tag={t} />)}
      {overflow.length > 0 && !expanded && (
        <button
          type="button"
          // The click is the touch path. `stopPropagation` because this sits inside a card whose own
          // click opens the agent — revealing two more tags is not a request to navigate.
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          title={overflow.map((t) => t.label).join(" · ")}
          aria-label={`Show ${overflow.length} more: ${overflow.map((t) => t.label).join(", ")}`}
          className="shrink-0 rounded-xs px-1.5 py-[2px] text-tiny text-faint transition-colors duration-fast hover:text-ink"
        >
          +{overflow.length}
        </button>
      )}
    </div>
  );
}

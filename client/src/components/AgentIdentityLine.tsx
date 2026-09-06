// §7's sidebar line: `[emoji] Stacey — Billing`, on one line, with one rule about what may be cut.
//
// THE NAME NEVER TRUNCATES. It is the identity, and a cut name is a different agent — `invoice_par…`
// and `invoice_parser_v2` are two agents that read as one, in the list whose whole job is telling
// them apart. So the name is `shrink-0` and takes whatever it needs; everything after it lives in
// what is left.
//
// THE CATEGORY DOES, and it is the only thing here that does. It takes the remaining width and gets
// an ellipsis when it runs out — through the existing `Truncate`, not through a rule of its own.
// §7 is explicit about why there is no character count: the correct cut depends on RENDERED WIDTH,
// and a 20-character rule cuts "Personal Assistant" on a wide sidebar and leaves "Summarization"
// overflowing a narrow one. `Truncate` already measures.
//
// AND WHEN THE CATEGORY IS `Uncategorized`, THE NAME STANDS ALONE. Not "Stacey — Uncategorized",
// which is a column of identical noise down a list of agents nobody has categorised — which is
// every list, the day this ships. The em dash goes with it: a separator with nothing after it is a
// worse artefact than the placeholder it was separating.
//
// A COMPONENT RATHER THAN MARKUP IN THE ROW, because the rule is what is worth keeping in one
// place. The row is a button with a rename editor, a provider mark, a status dot and two badges in
// it; the three facts §7 governs are these.
//
//   npm run test:sidebar-identity

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { AgentEmoji, EMOJI_SIZE } from "./AgentEmoji.tsx";
import { Truncate } from "./Truncate.tsx";
import { showsCategory } from "../lib/agentCategories.ts";

/**
 * What belongs in the row's `title`.
 *
 * §7: "The full name and category go in the row's title attribute for the hover case." Exported
 * because the row owns its own tooltip — it has other facts to put there — and this is the half
 * §7 specifies.
 */
export function identityTitle(name: string, category: string | null | undefined): string {
  return showsCategory(category) ? `${name} — ${category}` : name;
}

/**
 * How narrow the category's slot has to get before it is dropped entirely.
 *
 * FORTY-FOUR PIXELS IS AN EM DASH PLUS ABOUT THREE CHARACTERS at the row's 12px type. Below it,
 * `text-overflow: ellipsis` renders whatever fits — and what fits at fourteen pixels is the em dash
 * on its own, because the dash is narrower than the ellipsis that would have replaced it. `Doc
 * Indexer —` is the dangling separator §7 warns about, arriving through the layout instead of
 * through the markup.
 *
 * THIS IS NOT A SECOND TRUNCATION RULE, which §7 forbids and is right to. It decides whether the
 * category is DRAWN, never where its text is cut; the cut is still `Truncate`'s, still measured, and
 * still the only one in the row. And it is measured rather than counted for the same reason §7 gives
 * for refusing a character count: the answer depends on rendered width.
 */
const CATEGORY_FLOOR = 44;

export function AgentIdentityLine({
  emoji,
  name,
  category,
  nameClassName = "",
}: {
  emoji: string | null | undefined;
  name: string;
  category: string | null | undefined;
  /** The row's own colour for the name — active rows draw it in the accent. */
  nameClassName?: string;
}) {
  const slotRef = useRef<HTMLSpanElement>(null);
  const [roomForCategory, setRoomForCategory] = useState(true);

  /**
   * Is there room for a category at all?
   *
   * MEASURED EVERY RENDER AND ON RESIZE, because both change it: the name can get longer without the
   * sidebar moving (a rename), and the sidebar can be dragged narrower without the name changing.
   * Starting at `true` means the first paint draws the category and the measurement takes it away if
   * it does not fit — the other way round, a category that fits would flash in.
   */
  const measure = (): void => {
    const el = slotRef.current;
    if (el) setRoomForCategory(el.clientWidth >= CATEGORY_FLOOR);
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const el = slotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [name, category]);

  return (
    <>
      {/* §8.4'S EXPLICIT ASK, AND THE REASON THE EMOJI FEATURE EXISTS. Twenty agents each carrying
          the same robot mark is a list nobody can scan, and the eye finds a shape far faster than it
          reads a name. Bare, on the baseline — no box, because at 16px the box would be larger and
          louder than the glyph in it. I4: no 3D here; this size is the emoji's. */}
      <AgentEmoji emoji={emoji} size={EMOJI_SIZE.sidebar} />
      {/* `shrink-0`, WHICH IS THE WHOLE RULE. Without it the flex row shrinks the name first,
          because it is the longest item — exactly backwards. */}
      <span className={`shrink-0 whitespace-nowrap ${nameClassName}`}>{name}</span>
      {showsCategory(category) && (
        // THE SLOT IS ALWAYS RENDERED, and what it holds depends on how wide it turned out. A slot
        // that appeared only when there was room could never be measured, because it would have no
        // width until it existed.
        <span ref={slotRef} className="flex min-w-0 flex-1 basis-0 items-center">
          {/* AN EM DASH, AND IT IS PART OF THE CATEGORY'S BOX rather than a sibling of it. Outside,
              a row too narrow for any category at all renders a name, a dash and nothing — the
              artefact §7 is avoiding one case earlier.

              `flex-1 basis-0`, WHICH IS WHAT MAKES THAT TRUE. Found by looking at a real sidebar:
              with `min-w-0` alone the box sizes to its CONTENT and is then clipped by the row, so a
              long-named agent rendered `Doc Indexer —` with the dash surviving and the category
              gone — the exact artefact, arriving by a different route. Sharing the remaining space
              instead lets the box reach zero, and at zero it draws nothing at all. */}
          {roomForCategory && (
            <Truncate className="min-w-0 flex-1 basis-0 text-faint" title={category}>
              {`— ${category}`}
            </Truncate>
          )}
        </span>
      )}
    </>
  );
}

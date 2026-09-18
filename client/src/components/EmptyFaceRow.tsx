// Six illustrated badges, overlapping, where the new-agent screen used to wear a faint Jaroku mark
// and a rotating emoji.
//
// WHAT IT REPLACED, AND WHY BOTH THINGS WENT AT ONCE. The empty state carried two identity marks a
// heading apart: a 32px Jaroku glyph above the question, and `GreetingEmoji` after it — one emoji
// from the signed-in account's own set, swapped every second on a crossfade. Between them they said
// "this is Jaroku" and "here is a small animated thing", neither of which is what somebody reads an
// empty state to find out. The product owner's call was to take both out and put one row here.
//
// THE ORDER IS img1 THROUGH img6 AND NOTHING SHUFFLES IT — asked for by name, and worth a line in
// the code because the thing it replaced did shuffle, every second, and because a row of six is
// exactly the shape somebody later reaches for a `sort` or a `Math.random` on. `EMPTY_FACE_FILES`
// is the order; this maps it front to back and does nothing else to it.
//
// ── THE OVERLAP ───────────────────────────────────────────────────────────────────────────────
//
// NEGATIVE MARGIN RATHER THAN ABSOLUTE POSITIONING. Six absolutely-positioned badges need a parent
// with a width, and that width is then a seventh number to keep in step with the badge size and the
// overlap — three constants that must agree or the row sits off its own centre. A flex row of six
// with `-10px` on five of them measures itself: change `BADGE` and the row still centres.
//
// AND THE STACKING IS THE DOM ORDER, which is what the reference image shows — each badge over the
// one to its left. That is what overlapping siblings do already, so there is no `z-index` here and
// there should not be one: a z-index would be a second statement of an order the markup already
// makes, and the two can disagree.
//
// ── WHY `<img>` AND NOT A SPRITE OR AN INLINE SVG ─────────────────────────────────────────────
//
// SIX REQUESTS, ONCE, FOR 224KB TOTAL — and this screen is the one place in the product they are
// drawn. A sprite sheet would save five requests on a view somebody sees at most a few times a
// session and cost the browser a decode of all six whenever any one of them is wanted. They are
// photographs of drawings rather than shapes, so there is no SVG of them to inline.
//
// `loading="eager"` IS THE DEFAULT AND IS LEFT ALONE DELIBERATELY. These sit at the top of an empty
// screen, above the fold by construction — lazy-loading something that is already on screen buys
// nothing and costs a frame where the row is six gaps.

import { EMPTY_FACE_FILES } from "../lib/emptyFaceFiles.ts";

/**
 * How big each badge is drawn.
 *
 * FORTY-FOUR, between the 32px mark this replaced and the 56px that was the other candidate — the
 * product owner's call. At 32 the row read as a piece of chrome the eye skips; at 56 it took the
 * first read away from the question under it, which is the one thing the empty state exists to ask.
 *
 * A NUMBER HERE RATHER THAN A TOKEN, for `AgentFace`'s reason one file over: this is the size of a
 * picture, set against the heading beside it, not a step on a ladder anything else stands on. The
 * generator reads it in the comment above `BADGE` and delivers at four times it.
 */
const BADGE = 44;

/**
 * How far each badge sits over the one before it.
 *
 * TEN PIXELS, a shade under a quarter of the badge. The reference image overlaps by about that, and
 * it is the amount that reads as a stack rather than as either a row with tight gaps or a pile: at
 * five the badges look like they are touching by accident, and past fifteen the rims start hiding
 * the artwork they belong to.
 */
const OVERLAP = 10;

export function EmptyFaceRow() {
  return (
    <div
      className="flex items-center"
      // ONE `aria-hidden` ON THE GROUP, not six `alt=""` — this is decoration, and six empty alts
      // are six nodes a screen reader has to walk past to reach the question. The question is the
      // content; nothing here is named anywhere else in the product, so there is no name to give.
      aria-hidden
    >
      {EMPTY_FACE_FILES.map((face, i) => (
        <img
          key={face.id}
          src={`/empty-faces/${face.file}`}
          alt=""
          width={BADGE}
          height={BADGE}
          // `shrink-0` because this row lives inside the empty state's centred column, which is a
          // flex container: without it a narrow window squeezes six badges into ovals rather than
          // letting them run to the padding.
          className="block shrink-0"
          style={{
            width: BADGE,
            height: BADGE,
            marginLeft: i === 0 ? 0 : -OVERLAP,
          }}
        />
      ))}
    </div>
  );
}

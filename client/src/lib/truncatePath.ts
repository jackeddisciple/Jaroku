// Truncating a path, which is not truncating prose.
//
// `Truncate.tsx` fades at the right edge, and for a sentence that is correct — a sentence cut at
// the right edge still reads as a sentence, and the fade says "this continues" without pretending
// to measure how far. A path is not prose. The information that identifies WHICH FILE THIS IS
// lives disproportionately at the end, in the filename and its extension, and a right-edge fade
// throws away exactly that: `tools/we…` and `tools/tr…` are indistinguishable in a Changes list at
// three files and actively misleading at twenty.
//
// So this truncates from the MIDDLE, anchoring both ends. Four tiers, in order of preference:
//
//   1. IT FITS. Render it plain — no ellipsis logic runs at all, and no character is spent saying
//      that nothing was removed.
//
//   2. COLLAPSE THE MIDDLE. Keep the first segment (enough to place the file) and the last segment
//      (the filename, whole) and replace everything between them with a single `…` — then spend
//      whatever budget is left over putting the next leading segments back, one at a time, while
//      they still fit. The minimum is what the spec requires; the leftover is free and buys the
//      thing the variant exists for, because `agents/…/client.py` is the same string for two
//      agents and `agents/weather/…/client.py` is not.
//
//   3. SHORTEN THE FIRST SEGMENT, from its own tail, when the first segment plus the filename
//      still does not fit. `.astro/col…/blog.schema.json` — the leading directory is SHORTENED,
//      not dropped, because a shortened one still disambiguates two files with the same name in
//      different trees and a dropped one does not.
//
//   4. AND THE EXTENSION SURVIVES EVERY TIER. `.py`, `.json`, `.ts` are often the only signal
//      distinguishing a generated stub from its test file at a glance, so when even the filename
//      has to give way it gives way in the STEM and never in the suffix.
//
// A PURE FUNCTION OF A STRING AND A CHARACTER BUDGET, deliberately. The measuring belongs to the
// element and the deciding belongs here, which is what makes all four tiers assertable without a
// DOM — including the deep-nesting cases that only appear at one particular column width.

/** The single character that stands for "something was removed here". */
const ELLIPSIS = "…";

/**
 * The extension, including its dot, or "" — and `.env` is not one.
 *
 * A leading dot is a HIDDEN FILE and not a suffix: reading `.env` as an extension would leave the
 * stem empty, and tier 4 would then protect the whole name while claiming to protect four
 * characters of it. `lastIndexOf` past position zero is the whole of the rule.
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * `path`, shortened to at most `budget` characters.
 *
 * `budget` is a CHARACTER COUNT rather than a pixel width, because the callers that matter render
 * paths in the mono face where the two are proportional — and a function that took pixels would
 * need a font, which is the thing that makes it untestable.
 *
 * A budget of zero or less returns the path unchanged. That is deliberate rather than defensive: a
 * width of zero means the element has not been measured yet, and rendering an ellipsis during the
 * first frame of every list would flash a truncation onto paths that were never going to need one.
 */
export function truncatePath(path: string, budget: number): string {
  if (budget <= 0 || path.length <= budget) return path;

  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? path;

  // A path with no directory to collapse. Nothing between the ends to remove, so tier 4 is the
  // only one left: cut the stem and keep the extension.
  if (segments.length === 1) return shortenName(filename, budget);

  const first = segments[0] ?? "";

  // TIER 2. `first/…/filename`, where the `/…/` costs three characters.
  const tier2 = `${first}/${ELLIPSIS}/${filename}`;
  if (tier2.length <= budget) {
    // Only worth doing if it actually saves something. For a short path the collapsed form can be
    // longer than the original, and rendering a longer string to indicate shortening is absurd.
    if (tier2.length >= path.length) return path;
    // SPEND WHAT IS LEFT. Every leading segment put back is a segment that can distinguish this
    // path from its sibling, and stopping at the minimum throws away room the row already has.
    let kept = 1;
    while (kept < segments.length - 1) {
      const wider = `${segments.slice(0, kept + 1).join("/")}/${ELLIPSIS}/${filename}`;
      if (wider.length > budget || wider.length >= path.length) break;
      kept++;
    }
    return `${segments.slice(0, kept).join("/")}/${ELLIPSIS}/${filename}`;
  }

  // TIER 3. The filename is kept whole and the first segment gives way from its own tail. The two
  // separators and the ellipsis are the fixed cost.
  const fixed = filename.length + 2 + ELLIPSIS.length;
  const forFirst = budget - fixed;
  if (forFirst >= 2) {
    return `${first.slice(0, forFirst)}${ELLIPSIS}/${filename}`;
  }

  // TIER 4. There is not even room for two characters of the leading directory beside the
  // filename. The directory goes entirely — a one-character stub of it disambiguates nothing and
  // costs the two characters the filename needs — and the filename gives way in its stem.
  return shortenName(filename, budget);
}

/**
 * A filename, shortened in the stem, with the extension intact.
 *
 * When the extension alone is longer than the budget the extension wins anyway, and the result
 * overflows. That is the right failure: a budget of three characters against `.schema.json` has no
 * good answer, and returning the suffix is the one that still says what kind of file it is.
 */
function shortenName(name: string, budget: number): string {
  if (name.length <= budget) return name;
  const ext = extensionOf(name);
  const stem = name.slice(0, name.length - ext.length);
  const forStem = budget - ext.length - ELLIPSIS.length;
  if (forStem < 1) return `${ELLIPSIS}${ext}`;
  return `${stem.slice(0, forStem)}${ELLIPSIS}${ext}`;
}

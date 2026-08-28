// §17's figures: four kinds of number on one surface, formatted one way each.
//
// "INCONSISTENT NUMBER FORMATTING IS THE CHEAPEST WAY TO MAKE A PRODUCT FEEL UNMAINTAINED, and
// this tab shows four kinds of figure at once." A cost, a duration, a token count and a time, on
// the row AND on the card AND in the detail — twelve renderings of four rules, which is how a
// surface ends up saying `$0.00310` in one place and `$0.00` in another about the same job.
//
// THIS IS NOT A SECOND SET OF FORMATTERS AND MUST NOT BECOME ONE. `format.ts` already decides
// every one of the four, with the argument written beside each, and §17 says so twice: "Time is
// `relTime` from `lib/format.ts` and nothing else. Do not write a second one, do not add a ceiling
// of your own." So every function here DELEGATES, and what it adds is the one thing `format.ts`
// deliberately does not carry — the sentence that goes with the figure.
//
// WHY THE SENTENCE IS THE POINT. §17: "Unknown is an em dash, and the em dash carries a tooltip
// saying why it is unknown." An em dash on its own is a figure the reader files as a bug in the
// product rather than as an absence in the record, and the two reasons a Cockpit cost is missing
// are genuinely different facts — nothing could be priced, or the job has not produced anything
// yet. A formatter returning a bare string cannot carry that, so every one of these returns the
// figure and its title together, and a call site physically cannot render one without the other.
//
// AND THE COST PRECISION RULE, DECIDED ONCE — §17's own instruction, and the answer is that it was
// already decided. `fmtCost` renders unknown as an em dash, a real zero as `$0.00`, a sub-cent
// amount at FIVE decimal places and anything above at four. That is §17's "sub-cent amounts need
// more places" exactly, and `test:format` has pinned it since the two money formatters in this
// client were reconciled. Writing a second rule for this tab would put the Cockpit's row at odds
// with the Usage panel's for the same run, which is the failure §17 opens by describing.
//
//   npm run test:cockpit-format

import { absTime, fmtCost, fmtDuration, fmtTokens, relTime } from "./format.ts";
import { DETAIL } from "./cockpitCopy.ts";

/**
 * A figure and the sentence that explains it.
 *
 * `title` IS NULL WHEN THE FIGURE SPEAKS FOR ITSELF, rather than being a restatement of the digits.
 * A tooltip reading "$0.0031" over the text `$0.0031` is noise a screen reader reads twice, and the
 * whole reason this shape exists is the case where the figure is an ABSENCE and the tooltip is the
 * only thing carrying the meaning.
 */
export interface Figure {
  text: string;
  title: string | null;
  /**
   * Whether this figure is a FLOOR rather than a total — some call in the run could not be priced.
   *
   * ON THE FIGURE RATHER THAN BESIDE IT, because the row renders the marker as a `+` and the detail
   * renders it as a sentence, and those are two spellings of ONE fact. They were two independent
   * expressions before this module — `${spend}+` inside the fleet sentence and a `<span>` inside
   * the row — which is exactly the arrangement where one of them gets fixed and the other does not.
   */
  floor: boolean;
}

const plain = (text: string): Figure => ({ text, title: null, floor: false });

/**
 * Money, for the row, the card and the detail — the same three surfaces §17 names.
 *
 * `complete` IS A SEPARATE ARGUMENT FROM THE AMOUNT because they answer different questions: the
 * amount is what was spent, and `complete` is whether that is the whole of it. A run with one
 * unpriced `llm_call` has a real total and an incomplete one, and collapsing the two into `null`
 * would throw away a figure somebody can act on to avoid overstating certainty — which is the
 * opposite of the trade §17 asks for.
 *
 * UNKNOWN IS AN EM DASH AND NEVER `$0.00` — the rule this whole file exists under, and `fmtCost`'s
 * own. `null` is "nothing here could be priced" and `0` is "this was free", and a product that
 * renders them the same has told the reader nothing about either.
 */
export function cockpitCost(cost: number | null | undefined, complete = true): Figure {
  if (cost == null) return { text: fmtCost(null), title: DETAIL.costUnknown, floor: false };
  return {
    text: fmtCost(cost),
    title: complete ? null : DETAIL.costPartial,
    floor: !complete,
  };
}

/**
 * How long a job took.
 *
 * NULL IS "IT HAS NOT ENDED", NOT ZERO. A running job genuinely has no duration yet, and a growing
 * number would be reporting one for something that has not got one — the same null-versus-zero rule
 * the cost follows, one field over. `fmtDuration` owns the house spelling (`4m 29s`, never `269s`
 * and never `00:04:29`), and this adds only the reason the dash is there.
 */
export function cockpitDuration(ms: number | null | undefined): Figure {
  if (ms == null) return { text: "—", title: DETAIL.durationUnknown, floor: false };
  return plain(fmtDuration(ms));
}

/**
 * A token count, abbreviated above a thousand — §17, "the abbreviation is the app's existing one".
 *
 * IT IS, AND IT IS `shortCount` REACHED THROUGH `fmtTokens`. There were two implementations of this
 * idea in this client once, so the same quantity read `11,646 tok` in one panel and `11.6K` one
 * screen away; `format.ts` records that and resolved it. Reaching for the short form here rather
 * than the exact one is a property of the SURFACE and not of the number: this tab is scanned.
 */
export function cockpitTokens(tokens: number | null | undefined): Figure {
  if (tokens == null) return { text: "—", title: DETAIL.tokensUnknown, floor: false };
  return plain(fmtTokens(tokens, "short"));
}

/**
 * When something happened, relatively — and the exact moment on hover.
 *
 * `relTime` AND NOTHING ELSE, per §17, including its stated week ceiling and its habit of dropping
 * the year when it is this one. The absolute instant is the TITLE rather than the text, which is
 * what `absTime` exists for: §17 allows an absolute timestamp only in the detail panel's metadata
 * line, "where the reader arrived on purpose", and a hover is that same bargain in miniature.
 */
export function cockpitTime(iso: string | null | undefined): Figure {
  if (!iso) return { text: "—", title: null, floor: false };
  const text = relTime(iso);
  // An unparseable instant renders as an em dash rather than as an empty cell: `relTime` answers
  // "" for one, and a blank column reads as a rendering fault rather than as an absent record.
  if (text === "") return { text: "—", title: null, floor: false };
  return { text, title: absTime(iso), floor: false };
}

/**
 * The one place a timestamp is written out in full — §17's exception, and it is one exception.
 *
 * "ABSOLUTE TIMESTAMPS APPEAR ONLY IN THE DETAIL PANEL'S METADATA LINE." An ISO string on a
 * glance-level surface is a figure nobody reads, and a row of them is a column of noise; the detail
 * panel is different because somebody navigated to it to find exactly this kind of fact.
 */
export function cockpitAbsolute(iso: string | null | undefined): Figure {
  if (!iso) return { text: "—", title: null, floor: false };
  const text = absTime(iso);
  return text === "" ? { text: "—", title: null, floor: false } : plain(text);
}

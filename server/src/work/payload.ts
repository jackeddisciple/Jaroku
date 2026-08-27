// What may land in `output` and `error`, and what is done to it on the way in.
//
// §6's Bounds, in one sentence: "every string into output or error through the same redactor the
// log sinks use, before truncation never after, with the cap announced rather than silent." That
// is three separate requirements and each of them is a different failure.
//
// THE REDACTION. These two columns hold text nobody in this codebase wrote: `output` is what a
// model produced inside somebody's container, and `error` is a traceback from a process that had
// every credential the deploy handed it in its environment. An agent that prints its own settings,
// a library that logs a connection string, a stack frame that repr()s a config object — all of
// them end up here, and from here they go into a row that outlives the job and into a snapshot
// broadcast to every socket in the workspace. That is a sink in exactly the sense a log is, and
// `redact` is the filter the log sinks already use.
//
// BEFORE TRUNCATION, NEVER AFTER, and the order is the whole point rather than a preference. A key
// cut in half is a key the redactor's patterns no longer match, so truncating first leaves the
// first sixteen characters of a live credential visible and redacts nothing — §6.5 of the Inbox
// specification rules out exactly this and uses the same words: not even partial ones.
//
// AND THE CAP IS ANNOUNCED. A silently truncated agent answer is worse than a short one, because
// the operator reads it as the whole answer and acts on it. The tail says what was cut and by how
// much, so "the agent stopped mid-sentence" and "we stopped storing it" are distinguishable.
//
// ONE PLACE, ON THE WAY IN. `WorkStore.finish` is the only writer of either column and it calls
// this — bounding at render time would leave the ROW holding the unbounded text for the next
// surface to read raw, and bounding at each call site would mean the next call site does not.

import { redact } from "../obs/log.ts";

/**
 * The longest agent answer this stores, in BYTES.
 *
 * SIXTEEN KILOBYTES, which is a quarter of what a job may be GIVEN and is generous for what one
 * comes back with: an agent's final message is prose, and sixteen thousand bytes of it is several
 * pages. It is deliberately not the input cap — the two are asymmetric on purpose. An input is a
 * thing a person composed and can shorten; an output is a thing that has already happened, so a
 * cap here cannot refuse, only truncate, and a cap that truncates should be the one somebody
 * hits by accident rather than routinely.
 */
export const MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * The longest failure text this stores.
 *
 * Two kilobytes, which is a sentence and a full Python traceback with room over. Shorter than the
 * output cap because the shapes are different: an answer is prose that gets longer the more the
 * agent had to say, and an error is a fixed structure whose useful part — the exception, and the
 * frames nearest it — is at one end. `describe()` in `deployDispatch.ts` already cuts a
 * container's own body to 300 characters before it reaches this, which is the tighter cap on the
 * one path where the text is somebody else's HTTP response rather than a trace.
 */
export const MAX_ERROR_BYTES = 2 * 1024;

/**
 * The one line a row shows, in characters rather than bytes.
 *
 * CHARACTERS HERE AND BYTES ABOVE, which looks inconsistent and is the right pair. The caps above
 * bound what crosses a wire and sits in a column, which is a size in bytes; this bounds what fits
 * on one line of a list, which is a count of glyphs. A preview cut at 160 BYTES would be 40
 * characters of an answer written in Japanese and 160 of one written in English, on the same row
 * of the same list.
 */
export const PREVIEW_CHARS = 160;

/**
 * Redact, then truncate, then say so.
 *
 * `undefined`/`null` PASS THROUGH AS NULL rather than becoming an empty string, because the two
 * mean different things in these columns: null is "there was none", and "" is "the agent said
 * nothing", which §11's honesty rules would have the card render differently.
 */
export function boundText(value: string | null | undefined, maxBytes: number): string | null {
  if (value === null || value === undefined) return null;
  const redacted = redact(value);
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes <= maxBytes) return redacted;

  // CUT ON A CHARACTER BOUNDARY, not on a byte one. Slicing the Buffer would land mid-sequence and
  // produce a replacement character at the join — which is a corrupted last glyph in an answer
  // somebody is reading, from a truncation that was supposed to be honest about itself.
  let out = redacted;
  while (Buffer.byteLength(out, "utf8") > maxBytes - ANNOUNCEMENT_BUDGET && out.length > 0) {
    // Proportional rather than one character at a time: a 10 MB traceback would otherwise be
    // millions of `byteLength` calls on a string that is still 10 MB.
    const over = Buffer.byteLength(out, "utf8") - (maxBytes - ANNOUNCEMENT_BUDGET);
    out = out.slice(0, Math.max(0, out.length - Math.max(1, Math.ceil(over / 4))));
  }
  return `${out}\n… truncated — ${bytes.toLocaleString()} bytes were stored down to ${maxBytes.toLocaleString()}`;
}

/**
 * Room kept aside for the sentence that announces the cut.
 *
 * Reserved rather than appended, so the announced total is itself inside the cap — a truncation
 * whose announcement pushed the value back over the limit would be a bound that does not bound.
 */
const ANNOUNCEMENT_BUDGET = 96;

/** What `WorkStore.finish` writes into `output`. */
export function boundOutput(value: string | null | undefined): string | null {
  return boundText(value, MAX_OUTPUT_BYTES);
}

/** What `WorkStore.finish` writes into `error`. */
export function boundError(value: string | null | undefined): string | null {
  return boundText(value, MAX_ERROR_BYTES);
}

/**
 * The one line a work row renders, from text that is already bounded and already redacted.
 *
 * IT DOES NOT REDACT AGAIN, and that is deliberate rather than an omission: its input comes out of
 * a column this module is the only writer of, so a second pass would be redacting text that has
 * already been through the filter — cheap, but it would also make it possible to call this on raw
 * text and have it look safe. The property worth having is that nothing unredacted can reach the
 * column, not that every reader re-checks.
 *
 * NEWLINES BECOME SPACES rather than being dropped, for the reason `boundString` gives one module
 * over: dropping them runs words together, and the point of the flattening is that one line stays
 * one line.
 */
export function preview(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const flat = flatten(value);
  if (flat.length === 0) return "";
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/**
 * One line, out of text that may be several.
 *
 * BY CHARACTER CODE RATHER THAN BY A WHITESPACE CLASS, and the difference is what it catches: `\s`
 * leaves an ESCAPE byte alone, so an agent that printed ANSI colour codes would put an invisible
 * terminal instruction on a row in a browser. Everything below 0x20 and DEL goes, which is every
 * newline, tab and control byte a container's output can carry.
 *
 * REPLACED WITH A SPACE RATHER THAN DROPPED, because dropping runs words together — `line one` and
 * `line two` become `line onelinetwo` — and the point is that one line stays one line, not that
 * the text is minimised.
 */
function flatten(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

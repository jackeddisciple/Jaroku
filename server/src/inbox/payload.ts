// What may land in a payload, and what is done to it on the way in.
//
// §6.5: "`payload` is rendered into every connected client's snapshot AND STORED. It carries names,
// ids, counts and short summaries only. No secret values, not even partial ones." That is two
// different risks in one sentence, and this file answers both.
//
// THE FIRST IS BREADTH. A payload goes to every socket in the workspace and into a row that outlives
// the problem it describes, so anything that reaches it has travelled further than the thing it came
// from. An MCP server's name, a tool's description and a build log's error string are all
// third-party or user text arriving on that path — which is exactly the path that made unbounded
// advertisement text a problem in v0.2.1. The answer is the same one that release reached for:
// bound it, and strip what breaks the surface it lands on.
//
// THE SECOND IS CREDENTIALS. Nothing here should ever hold one, and the shape mostly guarantees it —
// a credential item carries the NAME of the missing credential and there is no field a value could
// be in. "Mostly" is not a guarantee, though: an ERROR STRING is free-form text somebody else wrote,
// and a build that echoed its own environment would put a key in one. So every string goes through
// the same redactor that protects the log sinks, and there is a suite asserting a known secret
// cannot reach a payload — by the same pattern `test:log-redaction` uses, which §6.5 asks for by name.
//
// ONE PLACE, ON THE WAY IN. Bounding at render time would mean the row still HOLDS the unbounded
// text and the next surface to read it gets it raw; bounding at each of the eleven call sites that
// build a payload would mean the twelfth does not. The store calls this, and nothing else may write
// a payload.

import { redact } from "../obs/log.ts";
import type { InboxPayload, InboxPayloadValue } from "./registry.ts";

/**
 * The longest string a payload field may hold.
 *
 * TWO HUNDRED, which is a card's subject line and its context line with room to spare. §4.4 gives a
 * card one bold line and one line of context, both inside a `Truncate` — so a longer string is
 * bytes crossing a socket to be faded out at the same pixel. It is deliberately generous rather than
 * tight: an error string cut at forty characters is an error string nobody can act on.
 */
export const MAX_STRING = 200;

/** How many entries a list field may hold. See `RUN_IDS_MAX` for the field this exists for. */
export const MAX_LIST = 20;

/**
 * How many keys one payload may have.
 *
 * A BOUND ON THE SHAPE AND NOT ONLY ON THE VALUES, because the values being bounded says nothing
 * about how many of them there are. Nothing in the registry comes close to this; it is here so that a
 * generator written later cannot make a payload large by making it wide.
 */
export const MAX_KEYS = 24;

/**
 * Bring a string down to something that can sit on a card.
 *
 * REDACTED FIRST, THEN STRIPPED, THEN CUT, and the order is load-bearing. Redacting after cutting
 * would leave a key that had been truncated mid-value unmatched by the redactor and therefore
 * PARTIALLY VISIBLE — which §6.5 rules out in as many words: not even partial ones.
 *
 * NEWLINES AND CONTROL CHARACTERS BECOME SPACES rather than being dropped. Dropping them runs words
 * together — `line one` + `line two` becomes `line onelinetwo` — and the point of the strip is that
 * a card's one line stays one line, not that the text is minimised.
 */
export function boundString(value: string): string {
  const redacted = redact(value);
  // Every C0 control character and DEL: newlines, tabs, and the ANSI escape sequences a
  // third-party server's error text can carry. Written as an explicit range rather than as a
  // whitespace class, because whitespace leaves an escape byte alone and an invisible terminal
  // instruction rendered on a card is exactly the sort of thing v0.2.1 bounded server text for.
  const flattened = redacted.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flattened.length > MAX_STRING ? `${flattened.slice(0, MAX_STRING - 1)}…` : flattened;
}

/**
 * One value, made safe to store and to broadcast. `undefined` means "drop this key".
 *
 * FIVE SHAPES ARE ALLOWED AND EVERYTHING ELSE IS DROPPED, which is what makes the type's promise
 * mechanical rather than aspirational. A nested object would be a place a future generator could put
 * an entire response body without noticing; a function or a Date would serialise into something the
 * client has to guess at. Dropped rather than coerced, because a payload with a key whose value
 * turned into `"[object Object]"` is worse than one without the key.
 */
function boundValue(value: unknown): InboxPayloadValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") return boundString(value);
  // NaN AND Infinity ARE NOT NUMBERS A CARD CAN RENDER. `JSON.stringify` turns both into `null`, so
  // a count that overflowed would arrive as an absent field rather than as an obvious wrong one —
  // dropping the key here makes that explicit instead of accidental.
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out = value
      .filter((v): v is string => typeof v === "string")
      .slice(0, MAX_LIST)
      .map(boundString);
    return out;
  }
  return undefined;
}

/**
 * Every write of a payload goes through this. There is no second way in.
 *
 * KEYS ARE BOUNDED TOO, and by the same rule as values: a key is a string somebody chose, and a
 * generator that built one out of user text would put that text on the wire under a different name.
 * They are stripped to an identifier shape, so a key cannot arrive carrying punctuation the client
 * would have to escape before rendering it.
 */
export function boundPayload(payload: InboxPayload | undefined): InboxPayload {
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, InboxPayloadValue> = {};
  let keys = 0;
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    if (keys >= MAX_KEYS) break;
    const key = rawKey.slice(0, 40).replace(/[^A-Za-z0-9_]/g, "_");
    if (!key) continue;
    const value = boundValue(rawValue);
    if (value === undefined) continue;
    out[key] = value;
    keys++;
  }
  return out;
}

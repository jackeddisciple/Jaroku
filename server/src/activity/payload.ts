// What may leave this tab, and what is done to it on the way out.
//
// §6: "This payload reaches every connected client and is quoted in screenshots. It carries names,
// ids, counts and short summaries only." Three risks live in that sentence and this file answers all
// three, in one place, on the way out — which is the same posture `inbox/payload.ts` takes and for
// the same reason: bounding at render time leaves the SOURCE holding the raw text for the next
// surface to read, and bounding at each of a dozen call sites means the thirteenth does not.
//
//   CREDENTIALS. Nothing on this tab should hold one and the shapes mostly guarantee it — the whole
//   surface is counts and ids. "Mostly" is not a guarantee: a deploy's error string, an MCP server's
//   name and a tool description are all free-form text somebody else wrote, arriving on a path that
//   goes to every socket in the workspace. A build that echoed its own environment would put a key
//   in one. So every string goes through the same redactor that protects the log sinks, and
//   `test:activity-payload` asserts a known secret cannot reach a payload by exactly the pattern
//   `test:log-redaction` uses — which §6 asks for by name.
//
//   UNBOUNDED THIRD-PARTY TEXT. v0.2.1 bounded advertisement text from MCP servers for this reason,
//   and this wire travels the same path: a server name is whatever a third party called itself, and
//   a tool name in the rollup is a string that server chose.
//
//   RAW NEWLINES AND CONTROL BYTES. A card renders one line inside a `Truncate`; a newline in a tool
//   name turns that into three, and an ANSI escape is an invisible terminal instruction sitting in a
//   payload that gets stored, broadcast and screenshotted.
//
// AND THE NARROWING FROM v0.2.4, WHICH IS THE HALF THAT IS EASY TO GET WRONG. The scrubber once
// treated ordinary host values — `anthropic`, `claude-haiku-4-5` — as secrets and produced
// unreadable output. Redacting a MODEL NAME on a page whose whole job is to say which models ran
// would be worse than useless: it would delete the answer. So this file redacts genuine secrets and
// leaves identifiers alone, and `boundIdentifier` below is what marks the difference structurally
// rather than by hoping the redactor's patterns stay narrow.

import { redact } from "../obs/log.ts";

/**
 * Every control character, as a Unicode property rather than as a literal range.
 *
 * NOT A WHITESPACE CLASS, for the reason `inbox/payload.ts` gives: `\s` leaves an ESC byte alone,
 * and an invisible terminal instruction rendered on a card is precisely the sort of thing v0.2.1
 * bounded third-party text for.
 *
 * AND NOT A LITERAL RANGE EITHER, which is the same set spelled with escapes that are easy to
 * mangle — a source file that ends up holding the raw bytes instead still compiles and still
 * matches, so the mistake is invisible in review and in the diff. `\p{Cc}` says what it means, and
 * a positive class is spelled by negating the negated one: `[^\P{Cc}]` is "anything that is not a
 * non-control", which is every control and nothing else. It covers the C1 range too, which the
 * literal form did not.
 */
const CONTROL = /[^\P{Cc}]+/gu;

/** The same, plus ordinary whitespace, for a value that is supposed to be one token. */
const CONTROL_OR_SPACE = /(?:[^\P{Cc}]|\s)+/gu;

/**
 * The longest free-form string this payload may carry.
 *
 * A HUNDRED AND TWENTY, shorter than the Inbox's two hundred, because these strings are shorter
 * things: a deploy target, a tool name, an MCP server's label. The Inbox's bound is generous because
 * an error string cut at forty is an error nobody can act on; nothing on this tab is an error string
 * somebody is meant to act on — the Inbox is where that lives, which is §1's non-redundancy rule
 * showing up as a smaller number.
 */
export const MAX_TEXT = 120;

/**
 * The longest identifier: a model id, an agent slug, a tool name.
 *
 * LONGER THAN THE PROSE BOUND WOULD SUGGEST, deliberately. `claude-haiku-4-5` is short and
 * `accounts/fireworks/models/llama-v3p1-405b-instruct` is not, and a model id cut in half is a model
 * nobody can look up. It is still bounded, because the value arrives from a third party.
 */
export const MAX_ID = 96;

/** How many rows one list in a payload may carry. See `boundList`. */
export const MAX_ROWS = 200;

/**
 * A free-form string, made safe to broadcast: redacted, flattened, cut.
 *
 * THE ORDER IS LOAD-BEARING, and it is the same order `inbox/payload.ts` argues for. Redacting after
 * cutting would leave a key that had been truncated mid-value unmatched by the redactor and
 * therefore PARTIALLY visible — which §6 rules out in as many words: "No secret values, not even
 * partial ones."
 *
 * CONTROL CHARACTERS BECOME A SPACE rather than being dropped. Dropping them runs words together —
 * `line one` + `line two` becomes `line onelinetwo` — and the point of the strip is that a card's
 * one line stays one line, not that the text is minimised.
 */
export function boundText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const redacted = redact(value);
  const flat = redacted.replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/**
 * An identifier — a slug, a model id, a tool name — bounded but not narrowed.
 *
 * IT STILL GOES THROUGH THE REDACTOR, because an identifier is only an identifier by convention: a
 * tool name comes from a third-party server and an agent slug from a user, and neither is a
 * guarantee about content. What is different is the LENGTH, and the reason is v0.2.4's narrowing —
 * see the header. An identifier a redaction pattern genuinely matches was never an identifier.
 *
 * WHITESPACE IS REMOVED RATHER THAN COLLAPSED, because none of these has any: a slug, a model id and
 * a tool name are single tokens by construction, and a space inside one is either a bug upstream or
 * something pretending to be an id.
 */
export function boundIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const clean = redact(value).replace(CONTROL_OR_SPACE, "");
  return clean.length > MAX_ID ? clean.slice(0, MAX_ID) : clean;
}

/**
 * A URL, kept only if it is one. Anything else becomes null rather than a string on a link.
 *
 * `http(s)` ONLY. A deployment's URL column is written by the deploy manager and is always one, but
 * this payload is rendered as an anchor — and `javascript:` in an href is the one string that turns
 * a read-only dashboard into something else entirely. §1 says nothing on this tab may change state;
 * this is that rule surviving contact with a column somebody else fills in.
 */
export function boundUrl(value: unknown): string | null {
  const clean = boundIdentifier(value);
  return /^https?:\/\//i.test(clean) ? clean : null;
}

/** A finite number, or null. NaN and Infinity are not figures a card can render. */
export function boundNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/**
 * A list, bounded by length.
 *
 * A CAP ON THE ROWS AS WELL AS ON EACH ROW, because bounding the values says nothing about how many
 * of them there are. A workspace with nine thousand distinct tool names would otherwise put nine
 * thousand bounded strings on every socket — the same class of problem, one level up. `truncated`
 * travels so a card can say the list is partial rather than implying it is complete.
 */
export function boundList<T>(rows: readonly T[], max = MAX_ROWS): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, max), truncated: rows.length > max };
}

/**
 * The one field on this tab that is genuinely a person's identity, and how it is carried.
 *
 * AN ID, NEVER AN EMAIL. §5's per-user attribution needs to say WHICH member did something, and the
 * client already has a member list on its own channel with its own capability behind it — so the
 * feed carries the id and the client resolves the name. Putting an email address on this wire would
 * be the most person-identifying string in the product travelling on the one payload that is built
 * to be screenshotted.
 */
export function boundActor(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // A uuid shape, or nothing. Anything else on this field is a bug upstream, and passing it through
  // would be passing through whatever that bug produced.
  return /^[0-9a-fA-F-]{8,40}$/.test(value) ? value : null;
}

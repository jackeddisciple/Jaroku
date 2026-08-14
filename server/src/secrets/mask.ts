// The display mask: `sk-ant-...4f2a`, or a row of dots.
//
// WHY THIS IS COMPUTED HERE AND NOWHERE ELSE. The mask is the ONLY thing about a stored credential
// a browser ever sees, and it is stored as its own column rather than derived on read — deriving
// it would mean decrypting on read, which is the one thing the vault's shape exists to prevent.
// So it is computed exactly once, at the moment the value passes through `set`, from a plaintext
// that is already in hand and about to be discarded.
//
// WHAT A MASK MAY REVEAL, and the reasoning for the line drawn:
//
//   A PREFIX IS NOT SECRET. `sk-ant-`, `ghp_`, `xoxb-` are published vendor conventions. Every key
//   that provider issues starts with them, so showing one distinguishes nothing except which
//   vendor it is — which the row already says out loud in its `provider` column.
//
//   FOUR TRAILING CHARACTERS ARE THE RECOGNITION HANDLE, and the reason a mask exists at all: a
//   user with two Anthropic keys needs to tell "the one in production" from "the one I rotated
//   last week", and the last four is how every payment form and cloud console has answered that.
//
//   BUT ONLY ON A VALUE LONG ENOUGH FOR IT TO BE A SMALL FRACTION. Four characters of a
//   forty-character key is a tenth of it and no help to an attacker. Four characters of an
//   eight-character value is half the credential. So anything short gets dots and nothing else —
//   the recognition handle is worth having, and it is not worth having at that price.

/** What everything without a recognisable shape looks like. Matches the deploy panel's redaction. */
export const GENERIC_MASK = "••••••••";

/**
 * Prefixes worth keeping, longest first so `sk-ant-` is preferred over `sk-`.
 *
 * A list rather than a regex over "everything before the first dash", because that heuristic turns
 * a credential which merely CONTAINS a dash into one whose first segment is published. These are
 * documented vendor prefixes and nothing else qualifies.
 */
const KNOWN_PREFIXES = [
  "sk-ant-api03-",
  "sk-ant-",
  "sk-proj-",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "ghp_",
  "gho_",
  "AIza",
  "sk-",
];

/**
 * The shortest value that may show its last four characters.
 *
 * Twenty: at that length four characters is a fifth of the value, and every real API key from
 * every provider named above is comfortably longer. Below it, dots.
 */
const MIN_LENGTH_FOR_TAIL = 20;

/**
 * A mask for this value.
 *
 * Never throws and never returns the value: for any input, the output is either dots or a
 * published prefix plus four characters. The empty string masks like anything else, because a
 * caller that has somehow reached here with one should not get a distinguishable answer.
 */
export function maskFor(value: string): string {
  if (typeof value !== "string" || value.length < MIN_LENGTH_FOR_TAIL) return GENERIC_MASK;
  const tail = value.slice(-4);
  const prefix = KNOWN_PREFIXES.find((p) => value.startsWith(p));
  // Even with a known prefix, what is shown is prefix + ellipsis + tail — never anything from the
  // middle, which is where the entropy is.
  return prefix ? `${prefix}...${tail}` : `${GENERIC_MASK}${tail}`;
}

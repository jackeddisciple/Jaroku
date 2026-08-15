// Inline trigger characters in the composer — §A.6.
//
// The ⊕ menu is the discoverable path and stays exactly as it is: a new user finds GitHub attach by
// opening it once. But it is a two-click tax on every use after the first, for something that is
// fast to type once learned. So `#`, `@` and `!` open the SAME attach surface without leaving the
// keyboard — the same way `#`-style mention pickers work in chat products generally, scoped tightly
// to what §7 already allows to attach and nothing more.
//
// A PURE FUNCTION OF TEXT AND A CARET POSITION, which is the whole reason this is a module rather
// than a handful of conditions inside the composer. The cases that matter are the ones where a
// trigger must NOT fire — an email address, a Python decorator, a shell command, a `#` inside a
// word — and every one of them is a string and a cursor index. None needs a DOM.
//
// THE RULE THAT KILLS THE FALSE POSITIVES: a trigger only counts at the START of a word. `@` after
// a non-space character is an email address or a decorator argument, `#` after one is an anchor or
// a colour, and firing a picker into either is a picker somebody has to dismiss to keep typing.
// That single rule covers `ada@example.com`, `#ff0000`, `issue#42` and `--flag=@ref` without a list
// of exceptions to maintain.

/** Which surface a trigger opens. Exactly §7's attachable set — nothing new is reachable here. */
export type TriggerKind =
  /** A commit, by sha prefix or message text. Live in Phase 1: it needs only push history. */
  | "commit"
  /** A file at a ref. Needs real sync-state machinery behind it, so Phase 2 only. */
  | "file"
  /**
   * The diff since last sync.
   *
   * NO TYPED FILTER — there is only ever one "since last sync" diff at a time, so it is a
   * single-token insert rather than a picker. And it still only ATTACHES CONTEXT: `!` is the
   * shortcut most likely to be misread as an imperative, which is exactly why it is scoped this
   * narrowly and says so here.
   */
  | "sync";

export interface ActiveTrigger {
  kind: TriggerKind;
  /** What has been typed after the trigger character, for filtering. Empty for `!`. */
  query: string;
  /** Where the trigger character sits, so the caller can replace from there on selection. */
  start: number;
  /** Where the query ends — the caret. */
  end: number;
}

const CHAR_TO_KIND: Record<string, TriggerKind> = { "#": "commit", "@": "file", "!": "sync" };

/**
 * Whether `char` can precede a trigger.
 *
 * START OF INPUT, WHITESPACE, OR AN OPENING BRACKET. The bracket cases are not decoration: people
 * write "(see #a1b2)" and "check [@tools/x.py]", and a rule that only accepted whitespace would
 * refuse both while accepting the email address it was written to refuse.
 */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s([{]/.test(char);
}

/**
 * The trigger the caret is currently inside, or null.
 *
 * SCANS BACKWARD FROM THE CARET AND STOPS AT THE FIRST WHITESPACE, so only the word being typed can
 * be a trigger. A forward scan or a regex over the whole string would find a `#` from three
 * sentences ago and reopen its picker every time somebody edited a later word.
 *
 * `available` IS PASSED IN RATHER THAN ASSUMED. §A.6 says `@` and `!` are ABSENT before Phase 2 —
 * not shown-and-disabled — matching how §7 hides its Phase-2 menu entries rather than greying them
 * out. A trigger that is not available is not a trigger: typing `@` types an `@`.
 */
export function activeTrigger(
  text: string,
  caret: number,
  available: readonly TriggerKind[],
): ActiveTrigger | null {
  const upto = text.slice(0, caret);
  for (let i = upto.length - 1; i >= 0; i--) {
    const char = upto[i]!;
    // A space ends the word. Nothing before it can be the trigger the caret is inside.
    if (/\s/.test(char)) return null;
    const kind = CHAR_TO_KIND[char];
    if (!kind) continue;
    if (!isBoundary(upto[i - 1])) return null;
    if (!available.includes(kind)) return null;
    const query = upto.slice(i + 1);
    // `!` TAKES NO FILTER. Typing `!later` is a word with an exclamation in front of it, not a
    // query against a picker that has one entry — so the trigger ends the moment anything follows.
    if (kind === "sync" && query.length > 0) return null;
    return { kind, query, start: i, end: caret };
  }
  return null;
}

/**
 * `text` with the trigger and its query replaced by nothing, ready for the chip to stand in its
 * place.
 *
 * THE TOKEN IS REMOVED RATHER THAN REPLACED WITH A LABEL. The attachment is a chip above the
 * composer, not a string in the sentence — leaving `#a1b2c3d` in the prose would send the model the
 * same reference twice, once as text it cannot resolve and once as context it can.
 *
 * A trailing space is collapsed so "check #a1b2 now" does not become "check  now".
 */
export function removeTrigger(text: string, trigger: ActiveTrigger): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const joined = `${before}${after}`;
  // Only when the removal put two spaces together — a single space either side is what the user
  // typed and is theirs to keep.
  const cleaned = before.endsWith(" ") && after.startsWith(" ") ? `${before}${after.slice(1)}` : joined;
  return { text: cleaned, caret: before.length };
}

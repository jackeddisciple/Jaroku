// THE KEY THE USER ACTUALLY HAS.
//
// Every shortcut hint in this client is a literal `⌘`. Every handler behind those hints already
// accepts both modifiers — `const mod = e.metaKey || e.ctrlKey`, in eleven places — so Ctrl
// genuinely works and only the labels are wrong. A search for `navigator.platform`,
// `userAgentData`, `isMac` or any platform check across `client/src` returned nothing at all.
//
// SO ON WINDOWS AND LINUX THE PRODUCT TELLS PEOPLE TO PRESS A KEY THAT IS NOT ON THEIR KEYBOARD,
// and the chord that does work is discoverable only by guessing. This repository ships a Tauri
// desktop build with a Windows target, so the mislabelled surface is a shipped one — the palette's
// `⌘P` and `⌘N`, the composer's `Send (⌘↵)`, `Write in a larger editor (⌘⇧F)`, the sidebar's
// "Search agents — ⌘K opens the palette", the Inbox undo toast's `⌘Z`.
//
// ONE HELPER, AND THE CHORD IS STILL WRITTEN THE MAC WAY AT THE CALL SITE. `keyHint("⌘⇧F")` reads
// as the thing it is at the place it is used, and the translation happens once. The alternative —
// a conditional at each hint — is the shape that produces a twelfth hint written without one.
//
// SPELLED OUT RATHER THAN SUBSTITUTED ONE GLYPH FOR ANOTHER on the non-Apple side: `Ctrl+Shift+F`,
// not `Ctrl⇧F`. `⇧` and `↵` are Mac keyboard engravings too — a Windows keyboard says Shift and
// Enter — so translating the modifier and keeping the symbols would produce a hint half in each
// vocabulary, which is harder to read than either.
//
//   npm run test:mod-key

/**
 * Whether this is an Apple keyboard, decided once.
 *
 * `userAgentData.platform` first because `navigator.platform` is deprecated, and `navigator.platform`
 * second because `userAgentData` is Chromium-only — and this runs in a Tauri WebView as well as in
 * a browser. Both absent resolves to "not Apple", which is the safe default in the one direction
 * that matters: `Ctrl` on a Mac is a key that exists and does something else, while `⌘` on a PC is
 * a key that does not exist at all.
 */
export function detectApple(nav: unknown = typeof navigator === "undefined" ? undefined : navigator): boolean {
  const n = nav as { userAgentData?: { platform?: string }; platform?: string } | undefined;
  const platform = n?.userAgentData?.platform ?? n?.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** What each Mac engraving is called on a keyboard that does not carry it. */
const SPELLED: Record<string, string> = {
  "⌘": "Ctrl",
  "⌥": "Alt",
  "⇧": "Shift",
  "↵": "Enter",
  "⌫": "Backspace",
  "⎋": "Esc",
};

/**
 * A chord written the Mac way, rendered for `apple` or not.
 *
 * PURE AND TAKING THE PLATFORM, so the whole rule is checkable without a browser and both sides of
 * it are checkable at once. `keyHint` below is the two-argument version with the argument already
 * decided.
 */
export function formatChord(chord: string, apple: boolean): string {
  if (apple) return chord;
  const parts: string[] = [];
  let literal = "";
  for (const ch of chord) {
    const spelled = SPELLED[ch];
    if (spelled) {
      if (literal) { parts.push(literal); literal = ""; }
      parts.push(spelled);
    } else {
      literal += ch;
    }
  }
  if (literal) parts.push(literal);
  return parts.join("+");
}

const APPLE = detectApple();

/**
 * The hint to render for a chord, on this machine.
 *
 * Call sites keep writing `⌘` — it is the shortest way to say "the modifier this app means" and it
 * is what the specification uses. What comes out is what the person reading it can press.
 */
export function keyHint(chord: string): string {
  return formatChord(chord, APPLE);
}

/** Just the modifier, for a sentence that names it rather than drawing a keycap. */
export function modKey(): string {
  return keyHint("⌘");
}

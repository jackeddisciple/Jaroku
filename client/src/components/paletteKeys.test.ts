// A KEYCAP IS A PROMISE, AND THE PALETTE WAS MAKING ONE IT DID NOT KEEP.
//
// The command palette draws `⌘N` beside *New thread*. The palette is reachable from every screen in
// the product, so a keycap on one of its rows says "this works from here" — and the only handler
// for `n` in the whole client was `useThreadKeys`, which `ThreadsView` mounts. Four screens out of
// five the chord did nothing at all, and on Windows it fell through to the browser and opened a new
// window, which is the one outcome worse than nothing.
//
// THE `kbd` PROP IS DECORATIVE, and that is the shape of the defect rather than an aside: it draws a
// keycap with no relationship to any binding, so nothing anywhere connects the two and nothing ever
// will unless something checks. `test:dead-controls` covers a button with no handler; this is the
// same failure one layer over, on a control that is a piece of text.
//
// SO THIS READS THE SOURCE, the way `test:dead-controls` and `test:type-scale` do. It pulls every
// keycap the palette advertises out of its own JSX, pulls every chord the palette's global handler
// answers to out of the same file, and holds the two to each other. A rule like that is worth what
// it can be broken by, which is any future row somebody adds a keycap to.
//
//   npm run test:palette-keys

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The same way `deadControls.test.ts` finds its source: this package deliberately has no
// `@types/node`, so `node:path` is not declared and a suite that wanted it would be asking for a
// shim rather than for a path. A directory URL and two names is enough.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PALETTE = `${HERE}CommandPalette.tsx`;
const THREAD_KEYS = `${HERE}useThreadKeys.ts`;

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const palette = readFileSync(PALETTE, "utf8");
const threadKeys = readFileSync(THREAD_KEYS, "utf8");

/**
 * Every keycap the palette renders, as the letter the chord is on. `⌘P` → `p`.
 *
 * The cap is written the Mac way at the call site and translated by `keyHint` for the keyboard the
 * reader has, so the chord is matched inside that call rather than in a bare attribute — see
 * lib/modKey. A literal `kbd="⌘P"` still matches, because a hint that stopped going through the
 * helper is a hint that has gone back to naming a key Windows does not have.
 */
const advertised = [...palette.matchAll(/kbd=(?:"|\{keyHint\(")⌘([A-Za-z])/g)]
  .map((m) => (m[1] ?? "").toLowerCase());

/** Every chord the palette's own global handler answers to. */
const bound = [...palette.matchAll(/mod && e\.key\.toLowerCase\(\) === "([a-z])"/g)].map((m) => m[1] ?? "");

console.log("\nthe palette advertises keycaps, and they are real");
{
  // ⌘K is not among them on purpose: it is the chord that OPENS the palette, so there is no row
  // inside it to draw a keycap on. The rows that carry one are ⌘P and ⌘N.
  check("it draws keycaps on rows", advertised.length >= 2, advertised.join(","));
  check("its global handler binds three chords", bound.length >= 3, bound.join(","));
  // The two the audit used as controls: both worked from the same place ⌘N did not.
  check("⌘K is bound", bound.includes("k"));
  check("⌘P is bound", bound.includes("p"));
  // The one that was not.
  check("⌘N is bound", bound.includes("n"), bound.join(","));
}

console.log("\nevery keycap on a palette row has a binding behind it in the same file");
{
  const orphans = advertised.filter((letter) => !bound.includes(letter));
  check("no keycap is decoration", orphans.length === 0,
    orphans.length ? `⌘${orphans.join(", ⌘").toUpperCase()} advertised with no global handler` : "");
}

console.log("\nand no chord has two owners");
{
  // The file's own rule, written above the ⌘/ removal: "a chord with two owners is a chord whose
  // behaviour depends on which listener ran first." ⌘N was moved here rather than added here, so
  // the board's own handler must no longer answer to it — or the Threads view creates two threads.
  check("useThreadKeys no longer binds n", !/=== "n"/.test(threadKeys), "the board still handles ⌘N");
  check("...and no longer sends a thread creation at all",
    !threadKeys.includes("sendCreateThread("), "the board still creates threads on a chord");
  // Its own bare keys are untouched — this was a chord, and the bare letters belong to the view.
  check("the board keeps its bare keys", /e\.key/.test(threadKeys));
}

console.log("\nthe palette's chords survive a full-screen destination");
{
  // The bare-key guard stands down while a destination owns the screen; the chords deliberately do
  // not, because ⌘K and ⌘P are not about what is on screen — and ⌘N is now one of them. The guard
  // is applied AFTER the three chord branches, and that ordering is the whole of it.
  // The CALL, not the import at the top of the file.
  const guardAt = palette.indexOf("!paneOwnsBareKey(");
  const lastChordAt = Math.max(
    ...["k", "p", "n"].map((c) => palette.indexOf(`mod && e.key.toLowerCase() === "${c}"`)),
  );
  check("every chord is handled before the bare-key guard", lastChordAt > -1 && guardAt > lastChordAt,
    `chord@${lastChordAt} guard@${guardAt}`);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

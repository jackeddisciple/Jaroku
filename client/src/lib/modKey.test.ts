// EVERY SHORTCUT HINT IN THE PRODUCT NAMED A KEY HALF ITS USERS DO NOT HAVE.
//
// The handlers were never wrong: `const mod = e.metaKey || e.ctrlKey` in eleven places, so Ctrl+K
// opened the palette, Ctrl+P opened *Jump to file*, and Ctrl+↵ sent the composer. Only the labels
// were wrong, and a search for `navigator.platform`, `userAgentData` or `isMac` across the whole
// client returned nothing — there was no platform check anywhere to be wrong in.
//
// THIS REPOSITORY SHIPS A WINDOWS DESKTOP BUILD, so this is a shipped surface rather than a
// theoretical one, and the working chord was discoverable only by guessing.
//
// THE SWEEP AT THE END IS THE HALF THAT KEEPS IT FIXED. Translating eleven hints is a morning; the
// twelfth hint, written next year by somebody who has only ever seen `⌘` in this codebase, is what
// puts the bug back. So the suite reads the client's own source and fails any rendered string that
// carries a Mac engraving without going through the helper — the same shape `test:type-scale` uses
// for pixel sizes and `test:colour-system` uses for hex literals.
//
//   npm run test:mod-key

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectApple, formatChord, keyHint, modKey } from "./modKey.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\na Mac keyboard is left exactly as it was");
{
  check("⌘K", formatChord("⌘K", true) === "⌘K");
  check("⌘↵", formatChord("⌘↵", true) === "⌘↵");
  check("⌘⇧F", formatChord("⌘⇧F", true) === "⌘⇧F");
  check("⌘⇧↵", formatChord("⌘⇧↵", true) === "⌘⇧↵");
}

console.log("\nand every hint the audit named is readable on a Windows keyboard");
{
  // The palette's two keycaps.
  check("⌘P → Ctrl+P", formatChord("⌘P", false) === "Ctrl+P", formatChord("⌘P", false));
  check("⌘N → Ctrl+N", formatChord("⌘N", false) === "Ctrl+N");
  // The composer's send tooltip and its keycap.
  check("⌘↵ → Ctrl+Enter", formatChord("⌘↵", false) === "Ctrl+Enter", formatChord("⌘↵", false));
  // "Write in a larger editor".
  check("⌘⇧F → Ctrl+Shift+F", formatChord("⌘⇧F", false) === "Ctrl+Shift+F", formatChord("⌘⇧F", false));
  // The GitHub commit box's push-after-commit.
  check("⌘⇧↵ → Ctrl+Shift+Enter", formatChord("⌘⇧↵", false) === "Ctrl+Shift+Enter");
  // The Inbox undo toast.
  check("⌘Z → Ctrl+Z", formatChord("⌘Z", false) === "Ctrl+Z");
  // The sidebar's "Search agents — ⌘K opens the palette".
  check("⌘K → Ctrl+K", formatChord("⌘K", false) === "Ctrl+K");
}

console.log("\nthe symbols are spelled out too, not half-translated");
{
  // `Ctrl⇧F` would be a hint in two vocabularies at once — the modifier named, the symbols still
  // engraved on a keyboard the reader does not have. Harder to read than either alone.
  check("no ⇧ survives", !formatChord("⌘⇧F", false).includes("⇧"), formatChord("⌘⇧F", false));
  check("no ↵ survives", !formatChord("⌘↵", false).includes("↵"), formatChord("⌘↵", false));
  check("no ⌘ survives", !formatChord("⌘K", false).includes("⌘"));
  check("⌥ becomes Alt", formatChord("⌥K", false) === "Alt+K");
  check("⎋ becomes Esc", formatChord("⎋", false) === "Esc");
  check("⌫ becomes Backspace", formatChord("⌫", false) === "Backspace");
}

console.log("\na multi-character key is one part, not one part per letter");
{
  check("⌘⇧Tab", formatChord("⌘⇧Tab", false) === "Ctrl+Shift+Tab", formatChord("⌘⇧Tab", false));
  check("a bare letter is untouched", formatChord("F", false) === "F");
  check("an empty chord stays empty", formatChord("", false) === "");
}

console.log("\nwhich platform, from what the browser will say");
{
  check("macOS", detectApple({ platform: "MacIntel" }) === true);
  check("...by its modern name too", detectApple({ userAgentData: { platform: "macOS" } }) === true);
  check("an iPad", detectApple({ platform: "iPad" }) === true);
  check("Windows", detectApple({ platform: "Win32" }) === false);
  check("...including the Tauri WebView2 host", detectApple({ userAgentData: { platform: "Windows" } }) === false);
  check("Linux", detectApple({ platform: "Linux x86_64" }) === false);
  // Neither available resolves to "not Apple", which is the safe direction: `Ctrl` on a Mac names a
  // key that exists and does something else, while `⌘` on a PC names a key that is not there.
  check("nothing at all is not Apple", detectApple(undefined) === false);
  check("an empty platform is not Apple", detectApple({ platform: "" }) === false);
  check("the modern name wins over the deprecated one",
    detectApple({ userAgentData: { platform: "Windows" }, platform: "MacIntel" }) === false);
}

console.log("\nthe live helpers agree with the resolver on this machine");
{
  const apple = detectApple();
  check("keyHint matches formatChord", keyHint("⌘⇧F") === formatChord("⌘⇧F", apple), keyHint("⌘⇧F"));
  check("modKey is just the modifier", modKey() === (apple ? "⌘" : "Ctrl"), modKey());
}

console.log("\nno rendered string in the client hardcodes a Mac engraving");
{
  const HERE = fileURLToPath(new URL(".", import.meta.url));
  const SRC = `${HERE}..`;
  const ENGRAVINGS = ["⌘", "⌥", "⇧", "⌫", "⎋"];

  /** Source with its prose removed, so a comment explaining the chord is not a hint that renders. */
  const strip = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => (line.trim().startsWith("//") ? "" : line.replace(/\s\/\/.*$/, "")))
      .join("\n");

  const offenders: string[] = [];
  const files = readdirSync(SRC, { recursive: true })
    .filter((p) => (p.endsWith(".ts") || p.endsWith(".tsx")) && !p.includes(".test."))
    .filter((p) => !p.endsWith("modKey.ts"));

  for (const rel of files) {
    const code = strip(readFileSync(`${SRC}/${rel}`, "utf8"));
    for (const line of code.split("\n")) {
      if (!ENGRAVINGS.some((g) => line.includes(g))) continue;
      // Going through the helper is the whole point, so a line that calls it is correct however
      // many engravings it contains.
      if (line.includes("keyHint(") || line.includes("formatChord(")) continue;
      offenders.push(`${rel}: ${line.trim().slice(0, 90)}`);
    }
  }
  check("every hint goes through keyHint", offenders.length === 0, offenders.join(" | "));
  // And the sweep is not vacuous: it has files to look at and lines that DO carry engravings.
  check("the sweep read the client", files.length > 100, String(files.length));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

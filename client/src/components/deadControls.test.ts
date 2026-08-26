// No control in this client renders as pressable and does nothing.
//
// WHAT THIS IS FOR. Share sat in the top bar — the one strip present on every surface of the
// application — with no `onClick`, no `disabled`, and a `title` reading "Share — not available
// yet". Enabled, focusable, in tab order, and the only signal that it did nothing was a tooltip
// somebody had to hover a dead control to find. It was the single element in an otherwise rigorous
// UI that behaved as decoration, and it survived because nothing anywhere could observe it: a
// button with no handler typechecks, renders, and passes every existing suite.
//
// THE PRINCIPLE IS ALREADY WRITTEN DOWN, twice, in this codebase's own words. `EnforcementStrip`:
// "A control that looked like it lifted a suspension and did not would be worse than no control."
// And commit 5d0b034, which removed a greyed control with an explanatory tooltip because "a greyed
// control with 'only an owner can do this' beside it has decided somebody should keep looking at
// it". Both are arguments about the same thing and neither had a check behind it.
//
// A SUITE OF ITS OWN RATHER THAN A SECTION IN ONE THAT HAD ROOM. The CI file complains at length
// about eleven suites that shipped and were never run because a feature's tests went wherever
// there was space; this rule is about neither typography nor colour nor icons, so it goes here and
// a reader looking for "what stops a dead control shipping" finds one file.
//
// WHAT IT CANNOT SEE, said out loud. It reads source text, so a handler that is present and does
// nothing — `onClick={() => {}}` — passes, and so does one whose body is a no-op branch. Those are
// a different failure and a harder one; this catches the shape that actually shipped, which is a
// control with no handler at all. GAP-008's exhaustive `runAction` switch is the answer to the
// other half, and it is enforced by the typechecker rather than by a text scan.
//
//   npm run test:dead-controls

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}..`;

/**
 * Source with its prose removed, LINE COUNT PRESERVED.
 *
 * EVERY FILE IN THIS CLIENT ARGUES WITH ITSELF AT LENGTH, and four of those arguments are about
 * what a `<button>` should be — "a real `<button>` with aria-haspopup", "it cannot be a real
 * <button>", "a 12×12px `<button role='checkbox'>`". A scan that read those found four dead
 * controls that do not exist, which is the failure mode a structural audit must not have: a suite
 * nobody believes is a suite nobody keeps.
 *
 * Comments become spaces rather than disappearing, so a reported line number still points at the
 * line somebody has to open. `//` is only stripped at the start of a line, because `https://` is
 * not a comment and a className full of slashes is not either.
 */
function strip(text: string): string {
  const blanked = (m: string): string => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blanked)
    .replace(/^[ \t]*\/\/.*$/gm, blanked);
}

/** Every .tsx under src. A rule about what renders can only be asked of the files that render. */
function components(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, "/"))
    .filter((path) => /\.tsx$/.test(path) && !/\.test\.tsx$/.test(path))
    .map((path) => ({ path, text: strip(readFileSync(`${SRC}/${path}`, "utf8")) }));
}

const FILES = components();

console.log("\nevery rendered button can be pressed for a reason");
{
  check(FILES.length > 40, `read the client's components (${FILES.length})`);

  /**
   * Each `<button …>` opening tag, with its attributes.
   *
   * Depth-counted to the closing `>` rather than regexed to one, because these tags carry JSX
   * expressions full of `>` — a ternary, a comparison, an arrow function — and a regex that stops
   * at the first one truncates the attributes and reads a handler as absent.
   */
  function openingTags(text: string): { at: number; attrs: string }[] {
    const out: { at: number; attrs: string }[] = [];
    for (const m of text.matchAll(/<button(?=[\s>])/g)) {
      let i = m.index! + m[0].length;
      let depth = 0;
      for (; i < text.length; i++) {
        const c = text[i]!;
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
      }
      out.push({ at: m.index!, attrs: text.slice(m.index! + m[0].length, i) });
    }
    return out;
  }

  const dead: string[] = [];
  let counted = 0;
  for (const { path, text } of FILES) {
    for (const { at, attrs } of openingTags(text)) {
      counted++;
      // A `type="submit"` is pressed by its FORM, not by a handler of its own, and a spread
      // (`{...props}`) may carry one this scan cannot see. Both are genuine and both are rare.
      if (/type=["']submit["']/.test(attrs)) continue;
      if (/\{\.\.\./.test(attrs)) continue;
      // `disabled` with a literal `true` is a control that says so; a disabled expression is a
      // state, and a control that is only sometimes disabled still needs a handler for the rest.
      if (/disabled(?:=\{true\}|(?=[\s>]))/.test(attrs)) continue;
      if (/onClick|onMouseDown|onPointerDown|onKeyDown/.test(attrs)) continue;
      const line = text.slice(0, at).split("\n").length;
      dead.push(`${path}:${line}`);
    }
  }

  check(counted > 60, `found the buttons (${counted})`);
  check(
    dead.length === 0,
    "no <button> renders enabled with nothing behind it",
    dead.length ? `DEAD: ${dead.join(", ")}` : "",
  );
}

console.log("\nand the one that did is gone rather than hidden");
{
  // NAMED, because its absence is the fix. A regression would put it back as one line, and a rule
  // that only counted dead buttons would pass the moment somebody gave it an empty handler.
  const topBar = FILES.find((f) => f.path === "components/TopBar.tsx")?.text ?? "";
  check(topBar.length > 0, "read the top bar");
  check(!/ShareOutIcon/.test(topBar), "Share is not rendered in the strip that is on every screen");
  check(
    !/not available yet/.test(topBar),
    "...and no control there explains itself with a tooltip instead of working",
  );
  // The capability it was the obvious candidate for still has its two entry points, and they are
  // CONTEXTUAL — a card's overflow and the file browser — because what is exported is one version
  // of one agent. The top bar renders where no version is in view.
  const exporters = FILES.filter((f) => /downloadVersion\(/.test(f.text)).map((f) => f.path);
  check(
    exporters.length === 2,
    `exporting a version is still reachable from its two contextual call sites (${exporters.join(", ")})`,
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// Reached through globalThis, like every other suite here: the client has no @types/node on
// purpose, so that a component touching `process` fails to compile rather than fails to run.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

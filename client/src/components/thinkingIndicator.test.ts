// §9's thinking indicator, and §16.2's regression check on `animate-pulse`.
//
// WHY A SOURCE-READING SUITE RATHER THAN A RENDER. Both properties §9 asks for are decisions about
// which class string is used and when — and both have a wrong answer that looks completely correct
// on screen for the first second:
//
//   `animate-pulse` FADES TO 50% AND READS AS DISABLED. v0.2.2 replaced it across nine live
//   elements for exactly that reason, and §16.2 asks for a regression check that it "has not
//   returned on any live element". A new element using it reintroduces a fixed bug, and the only
//   way to notice is to look.
//
//   THE INDICATOR MUST GIVE WAY TO THE TEXT (§9), not sit beside it. A component that rendered both
//   would look fine while an answer streams and would keep saying "Thinking…" above a finished
//   paragraph for the length of the render.
//
// AND NO STATIC SPINNER ANYWHERE IN THIS PATH (§9). This product has never had one; asserted here
// because "never" is the kind of claim that needs a reader.
//
//   npm run test:thinking-indicator

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}..`;

/**
 * Source with its prose removed, LINE COUNT PRESERVED — the same helper `deadControls.test.ts`
 * needed for the same reason, and this suite is the second proof of why.
 *
 * WITHOUT IT THIS CHECK REPORTS ITS OWN DOCUMENTATION. Three files in this client explain at length
 * why `animate-pulse` is NOT used — `StatusGlyph`, `ActivityView` and the indicator below — and a
 * search over raw source reads every one of those sentences as a relapse. It is the same
 * over-broad-pattern mistake `providerFailure.ts` made with `refused` inside `ECONNREFUSED`: narrow
 * the search to what the check actually means, which here is a CLASS STRING.
 *
 * `//` ONLY AT THE START OF A LINE, because `https://` is not a comment and a className full of
 * slashes is not either.
 */
function strip(text: string): string {
  const blanked = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blanked).replace(/^[ \t]*\/\/.*$/gm, blanked);
}

const pane = readFileSync(`${SRC}/components/BuildPane.tsx`, "utf8");

console.log("\n§9 — the indicator");
{
  check("there is one, and it is named", /function ThinkingIndicator\(\)/.test(pane));
  // v0.1.11's LANGUAGE: a word in `text-run`, which is what the plan card already says while a
  // plan streams. Not a new colour and not a new shape.
  const body = /function ThinkingIndicator\(\)[\s\S]*?\n\}/.exec(strip(pane))?.[0] ?? "";
  check("it uses the in-flight colour v0.1.11 established", /text-run/.test(body), body);
  check("...and stream-pulse", /animate-stream-pulse/.test(body), body);
  // §9 AND §16.2: `animate-pulse` FADES TO 50% AND READS AS DISABLED.
  check("...and never animate-pulse", !/\banimate-pulse\b/.test(body), body);
  // MOTION-REDUCE IS NOT OPTIONAL. Every pulsing element in this client carries it, and §5's
  // acceptance asks for `prefers-reduced-motion` on this path by name.
  check("...and honours reduced motion", /motion-reduce:animate-none/.test(body), body);
  check("no spinner in it", !/spin/i.test(body), body);
}

console.log("\n§9 — it gives way to the text");
{
  // THE `waiting` GATE IS THE CLAUSE. §9: "the indicator gives way to streamed text the moment the
  // first token lands; it does not sit alongside partial text."
  check("waiting is 'streaming with nothing painted yet'",
    /const waiting = turn\.status === "streaming" && text\.length === 0;/.test(pane), "");
  check("the indicator renders INSTEAD of the prose", /\{waiting \? <ThinkingIndicator \/> : \(/.test(pane), "");
  // AND THE CARET GOES WITH IT, because a caret with no text in front of it reads as a cursor
  // rather than as work happening — which is what this path rendered before.
  check("the streaming caret is suppressed while waiting",
    /turn\.status === "streaming" && !waiting/.test(pane), "");
}

// --- §16.2's regression check, across the whole client ----------------------------------------
//
// §16.2 ASKS FOR THIS BY NAME: "`animate-pulse` has not returned on any live element (v0.2.2)."
// Checked across every component rather than only the one this commit touched, because the value of
// the claim is that it holds everywhere — and this is the file that will be read the next time
// somebody adds a pulsing element.

console.log("\n§16.2 — animate-pulse has not returned anywhere");
{
  const offenders: string[] = [];
  for (const entry of readdirSync(SRC, { recursive: true })) {
    const rel = String(entry).replace(/\\/g, "/");
    if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel)) continue;
    const text = strip(readFileSync(`${SRC}/${rel}`, "utf8"));
    // `animate-pulse` AS A WHOLE CLASS. `animate-stream-pulse` is the one that is correct and does
    // not contain this as a substring, but the boundaries also keep a future `animate-pulse-slow`
    // from reading as the banned class.
    if (/(^|[\s"'`:{])animate-pulse([\s"'`}]|$)/.test(text)) offenders.push(rel);
  }
  check(`no live element uses animate-pulse (${offenders.length} found)`, offenders.length === 0, offenders.join(", "));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

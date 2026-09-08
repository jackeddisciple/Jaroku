// A SAVED PANE LAYOUT IS KEYED BY THE PANEL, NOT BY THE PANEL'S ARITHMETIC.
//
// `autoSaveId` on a `PanelGroup` is the whole of "remember how I sized this". What it saves under
// is not obvious: when a `Panel` carries no `id`, react-resizable-panels builds the storage key out
// of the panel's own constraints — `${order}:${JSON.stringify(constraints)}` — and says so in a
// comment that also says why that is safe: "Using the min/max size attributes should work well
// enough as a backup."
//
// THAT BACKUP ASSUMES THE CONSTRAINTS ARE CONSTANTS, AND HERE THEY ARE MEASUREMENTS. App.tsx's two
// groups both take a `minSize` from `usePaneFloor`, which converts a pixel floor against the live
// container width — deliberately, and paneFloor.test.ts is the suite that keeps that arithmetic
// honest. The consequence was one level up and nothing could see it: every window width produced a
// different key, so a sidebar dragged to 402px at 1440 came back at the 20% default at 1600, and
// localStorage collected another entry each time. Not "layout lost" — layout remembered PER WINDOW
// SIZE, which looks like working persistence right up until somebody resizes a window, and which
// no assertion about `pixelFloorPercent` could ever have caught.
//
// TWO HALVES, BECAUSE THE FIX RESTS ON SOMEBODY ELSE'S BEHAVIOUR. The first asserts what this
// repository controls: every `<Panel>` in App.tsx carries a literal `id`. The second asserts the
// library rule that makes an `id` worth passing — that it is preferred over the constraints when
// the key is built — read out of the copy in node_modules, so an upgrade that changed it fails
// here rather than silently going back to per-width keys.
//
//   npm run test:pane-identity

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = readFileSync(`${HERE}../App.tsx`, "utf8");

/** Comments blanked, line count preserved — deadControls.test.ts's rule, for its reason. */
function strip(text: string): string {
  const blanked = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blanked).replace(/^[ \t]*\/\/.*$/gm, blanked);
}

const SOURCE = strip(APP);

console.log("\nevery saved pane layout is keyed by a panel that keeps its name");
{
  // Each `<Panel …>` opening tag with its attributes. `<PanelGroup` and `<PanelResizeHandle` are
  // excluded by requiring the next character to be whitespace or `>`.
  const tags = [...SOURCE.matchAll(/<Panel(?=[\s>])[^>]*>/g)].map((m) => ({
    text: m[0],
    line: SOURCE.slice(0, m.index ?? 0).split("\n").length,
  }));

  check("read App.tsx's panels", tags.length >= 4, `found ${tags.length}`);

  const anonymous = tags.filter((t) => !/\bid=("[^"]+"|\{[^}]+\})/.test(t.text));
  check(
    "every panel carries an id",
    anonymous.length === 0,
    anonymous.map((t) => `App.tsx:${t.line}`).join(", "),
  );

  // The ids have to be distinct or two panels collapse to one key, which is the same bug wearing
  // the fix's clothes.
  const ids = tags.map((t) => /\bid="([^"]+)"/.exec(t.text)?.[1]).filter(Boolean) as string[];
  check("the ids are distinct", new Set(ids).size === ids.length, ids.join(", "));

  // AND THE RULE STAYS RELEVANT ONLY WHILE THE FLOORS ARE MEASURED. If App.tsx ever went back to
  // literal minimums the key would be stable without an id and this suite would be asserting a
  // habit rather than a requirement — so it checks that the reason is still there.
  check(
    "the pane minimums are still measured, which is why the ids are load-bearing",
    /minSize=\{sidebarMin\}/.test(SOURCE) && /minSize=\{composerMin\}/.test(SOURCE),
  );
}

console.log("\na panel that is alone does not declare a share of a sibling that is not there");
{
  // The composer renders without the right panel through onboarding step 3. A `defaultSize` of 45
  // in a one-panel group is a layout totalling 45%, which the library normalises and warns about
  // on every mount.
  const composer = /<Panel\s+id="composer"[\s\S]*?>/.exec(SOURCE)?.[0] ?? "";
  check("the composer's default share is conditioned on its sibling", /defaultSize=\{mountRightPanel\s*\?/.test(composer), composer.replace(/\s+/g, " ").slice(0, 120));
}

console.log("\nthe library still prefers an id over the constraints when it builds the key");
{
  // Read from the installed copy rather than restated here: this is the assumption the fix rests
  // on, and the point is to notice when it stops being true.
  let lib = "";
  for (const name of [
    "react-resizable-panels.browser.cjs.js",
    "react-resizable-panels.browser.esm.js",
  ]) {
    try { lib = readFileSync(`${HERE}../../node_modules/react-resizable-panels/dist/${name}`, "utf8"); break; }
    catch { /* try the next build */ }
  }
  check("found the installed library", lib.length > 0);

  if (lib) {
    // `getPanelKey` returns the id when it came from props, and the constraints otherwise.
    const fn = /function getPanelKey\(panels\)\s*\{[\s\S]*?\n\}/.exec(lib)?.[0] ?? "";
    check("getPanelKey is where the storage key comes from", fn.length > 0);
    check("it returns the id when the id came from props", /if\s*\(idIsFromProps\)\s*\{\s*return id;/.test(fn), fn.replace(/\s+/g, " ").slice(0, 200));
    check(
      "and falls back to the constraints when it did not — the case this repo must not be in",
      /JSON\.stringify\(constraints\)/.test(fn),
    );
    // And that an absent `id` prop really is what makes `idIsFromProps` false.
    check(
      "an omitted id prop is what makes the fallback fire",
      /idIsFromProps:\s*idFromProps\s*!==\s*undefined/.test(lib),
    );
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// Through `globalThis`, like every other suite here: the client has no @types/node on purpose, so
// that a component touching `process` fails to compile rather than fails to run.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

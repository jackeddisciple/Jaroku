// A MODAL THAT DIMS THE APPLICATION AND THEN HANDS THE KEYBOARD BACK TO IT.
//
// The workspace panel had a scrim, an Escape and an outside-click, and to anything that is not a
// pair of eyes it was a `<div>`. The probe: `{ dialogs: 0, ariaModal: 0, bodyOverflow: 'visible',
// focusedOnOpen: <the button that opened it> }`. Fifteen consecutive Tab presses walked out of the
// panel into the greyed-out sidebar behind it and landed on a rename box, which took a focus ring
// while the panel stayed open above it.
//
// THE TRAP IS RADIX'S NOW (ui/dialog.tsx, 2026-10-09), and the hand-built `lib/dialog.ts` whose wrap
// arithmetic this suite used to check is gone with it. What stays testable without a browser is the
// SEMANTICS, which are markup — so they are asserted on the markup the component actually produces:
// a `role` attribute nobody rendered is an accessibility claim in a comment. The event wiring needs a
// browser — see testRender's own note on why there is no jsdom here — and is not claimed.
//
//   npm run test:dialog

import { createElement } from "react";
import { markup, seed, sessionAs } from "./testRender.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { WorkspacePanel } from "../components/WorkspacePanel.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe panel announces itself — asserted on the markup, not on the intent");
{
  seed(useSessionStore, sessionAs("owner", { kind: "personal", name: "Local" }));
  seed(useUiStore, { workspaceSection: "general" });
  const html = markup(createElement(WorkspacePanel));

  check("it is a dialog", /role="dialog"/.test(html));
  check("...and says it is modal", /aria-modal="true"/.test(html));
  // A dialog whose accessible name is "dialog" tells somebody that SOMETHING opened. WHICHEVER ID IT
  // IS: the panel is a Radix dialog since 2026-10-09, and Radix names it after its title with an id
  // of its own making — what matters is that the name points at an element that is there.
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1] ?? null;
  check("...and points at a name", labelledBy !== null);
  check("...which is a real element on the page", labelledBy !== null && html.includes(`id="${labelledBy}"`));
  check("...that says what opened", labelledBy !== null && new RegExp(`id="${labelledBy}"[^>]*>Workspace<`).test(html));
  // The container has to be focusable for the case where it holds nothing focusable itself, and
  // for the initial focus the panel never performed.
  check("...and is a focus target itself", /tabindex="-1"/.test(html));
}

console.log("\nand renders nothing at all when no section is open");
{
  seed(useUiStore, { workspaceSection: null });
  const closed = markup(createElement(WorkspacePanel));
  check("a closed panel is not in the document", closed === "", closed.slice(0, 80));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

// A MODAL THAT DIMS THE APPLICATION AND THEN HANDS THE KEYBOARD BACK TO IT.
//
// The workspace panel had a scrim, an Escape and an outside-click, and to anything that is not a
// pair of eyes it was a `<div>`. The probe: `{ dialogs: 0, ariaModal: 0, bodyOverflow: 'visible',
// focusedOnOpen: <the button that opened it> }`. Fifteen consecutive Tab presses walked out of the
// panel into the greyed-out sidebar behind it and landed on a rename box, which took a focus ring
// while the panel stayed open above it.
//
// TWO HALVES ARE TESTABLE HERE AND THE THIRD IS NOT, and saying which is which matters more than
// pretending otherwise. The SEMANTICS are markup, so they are asserted on the markup the component
// actually produces — a `role` attribute nobody rendered is an accessibility claim in a comment.
// The WRAP is arithmetic, so it is asserted directly, and it is the half that gets written wrong:
// forgetting that Shift+Tab from the first element goes to the LAST leaves a trap that holds
// forwards and leaks backwards, which passes every check somebody does by hand because forwards is
// the direction people try. The event wiring itself needs a browser — see testRender's own note on
// why there is no jsdom here — and is not claimed.
//
//   npm run test:dialog

import { createElement } from "react";
import { FOCUSABLE_SELECTOR, nextFocusIndex } from "./dialog.ts";
import { markup, seed, sessionAs } from "./testRender.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { WorkspacePanel } from "../components/WorkspacePanel.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe wrap — the half a hand check never reaches");
{
  // Forwards through a cycle of four.
  check("0 → 1", nextFocusIndex(0, 4, false) === 1);
  check("2 → 3", nextFocusIndex(2, 4, false) === 3);
  check("the last wraps to the first", nextFocusIndex(3, 4, false) === 0, String(nextFocusIndex(3, 4, false)));

  // And backwards, which is where a modulus written the obvious way produces -1 and focus escapes.
  check("3 → 2 backwards", nextFocusIndex(3, 4, true) === 2);
  check("the first wraps to the LAST", nextFocusIndex(0, 4, true) === 3, String(nextFocusIndex(0, 4, true)));
  check("...never to -1", nextFocusIndex(0, 4, true) >= 0);
}

console.log("\nfocus that is not in the cycle at all enters at the near end");
{
  // `-1` is focus on the container itself, or focus that has already escaped — the exact state the
  // panel was left in on open, when nothing moved it off the trigger.
  check("Tab enters at the first", nextFocusIndex(-1, 4, false) === 0);
  check("Shift+Tab enters at the last", nextFocusIndex(-1, 4, true) === 3);
}

console.log("\na dialog with nothing focusable in it");
{
  check("forwards has nowhere to go", nextFocusIndex(0, 0, false) === -1);
  check("backwards either", nextFocusIndex(-1, 0, true) === -1);
  // The hook focuses the container in that case, which is why it carries tabIndex -1.
  check("a single stop cycles to itself", nextFocusIndex(0, 1, false) === 0);
  check("...in both directions", nextFocusIndex(0, 1, true) === 0);
}

console.log("\nthe selector excludes what it must");
{
  // The container's own `tabIndex={-1}` is a focus TARGET and never a stop in the cycle. Including
  // it would put the panel itself between the last control and the first.
  check("tabindex -1 is not a stop", FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
  check("a disabled button is not a stop", FOCUSABLE_SELECTOR.includes("button:not([disabled])"));
  check("a disabled input is not a stop", FOCUSABLE_SELECTOR.includes("input:not([disabled])"));
  check("a link needs an href to be one", FOCUSABLE_SELECTOR.includes("a[href]"));
}

console.log("\nthe panel announces itself — asserted on the markup, not on the intent");
{
  seed(useSessionStore, sessionAs("owner", { kind: "personal", name: "Local" }));
  seed(useUiStore, { workspaceSection: "general" });
  const html = markup(createElement(WorkspacePanel));

  check("it is a dialog", /role="dialog"/.test(html));
  check("...and says it is modal", /aria-modal="true"/.test(html));
  // A dialog whose accessible name is "dialog" tells somebody that SOMETHING opened.
  check("...and points at a name", /aria-labelledby="workspace-panel-title"/.test(html));
  check("...which is a real element on the page", /id="workspace-panel-title"/.test(html));
  // The container has to be focusable for the case where it holds nothing focusable itself, and
  // for the initial focus the panel never performed.
  check("...and is a focus target itself", /tabindex="-1"/.test(html));
}

console.log("\nand renders nothing at all when no section is open");
{
  seed(useUiStore, { workspaceSection: null });
  const closed = markup(createElement(WorkspacePanel));
  check("a closed panel is not in the document", closed === "", closed.slice(0, 80));
  // Which is exactly why the hook is called ABOVE the early return: a hook that stops being called
  // on close never runs its cleanup, and the cleanup is what gives the focus back to the trigger.
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

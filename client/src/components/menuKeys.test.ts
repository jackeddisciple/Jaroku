// EVERY MENU IN THE SIDEBAR IS DRIVABLE FROM THE KEYBOARD, and none of them was.
//
// THE BUG THIS GUARDS IS INVISIBLE WITH A MOUSE AND INVISIBLE TO THE TYPECHECKER. All three sidebar
// menus render as `{open && <div role="menu">…}` placed BEFORE their trigger in the markup — which
// is right for the account menu, whose panel opens upward and belongs above the button. But tab
// order is DOM order, not visual order: opening a menu and pressing Tab moved to whatever follows
// the TRIGGER, stepping over every item. They were reachable only backwards, by Shift+Tab. And
// Escape unmounted the panel with focus still inside it, so focus fell to `<body>` and the next Tab
// restarted from the top of the document.
//
// A SOURCE SCAN, for `deadControls.test.ts`'s reason and with its limits. This client has no DOM
// harness, and what went wrong is a component that declares `role="menu"` without wiring the
// behaviour that role promises — which is a property of the text. What it CANNOT see is the hook
// being wired and then not working; what it CAN see is the shape that actually shipped, and the
// regression that actually happens: somebody adds a fourth menu and does not know this exists.
//
// THE RULE IS "DECLARES A MENU ⇒ DRIVES A MENU". `role="menu"` is a promise to assistive technology
// that Up/Down move between items — Tab alone satisfies "reachable" and not "behaves like the thing
// it says it is" — so the two are asserted together rather than separately.
//
//   npm run test:menu-keys

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}..`;
const read = (path: string): string => readFileSync(`${SRC}/${path}`, "utf8");

/**
 * The source with its comments blanked out.
 *
 * THIS SUITE HAS NOW BEEN FOOLED BY ITS OWN PROSE TWICE — first by the paragraph in the old `menuFocus.ts`
 * explaining that focus is not an `aria-activedescendant`, then by the one in `IconButton.tsx`
 * explaining why that component accepts a role at all. Both mention the exact string being scanned
 * for. A file that TALKS about menus is not a file that HAS one, and the difference is the thing a
 * source scan is worst at unless it is told.
 *
 * The same treatment `colourSystem.test.ts` applies for the same reason, blanking rather than
 * deleting so any line number a failure reports still points at the right line.
 */
const withoutComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

const SOURCES = readdirSync(SRC, { recursive: true })
  .map((e) => String(e).replace(/\\/g, "/"))
  .filter((p) => /\.tsx$/.test(p) && !p.endsWith(".test.tsx"))
  .map((path) => ({ path, text: withoutComments(read(path)) }));

console.log("\nevery component that declares a menu also drives one");
{
  // The components that own a `role="menu"` panel. Found rather than listed, so a fourth menu is
  // covered by this suite on the day it is written rather than the day somebody remembers.
  const owners = SOURCES.filter((f) => /role="menu"/.test(f.text));
  // THE RADIX MENUS COUNT TOWARD FINDING THEM, and only toward that. Since 2026-10-09 the menus move
  // to `ui/dropdown-menu.tsx`, whose roles, arrow keys, Escape and focus are Radix's; the checks below
  // are for a menu somebody wires by hand, and this floor only says the scan read the client at all.
  const radix = SOURCES.filter((f) => /<DropdownMenuContent/.test(f.text));
  check("found the menus", owners.length + radix.length >= 3, `${owners.length} hand-built, ${radix.length} Radix`);

  for (const f of owners) {
    // THE RULE IS THE BEHAVIOUR, NOT THE IMPLEMENTATION — and this suite was wrong about that
    // first. `composer/Popover.tsx` and `WorkspaceSwitcher.tsx` already handled their own arrows
    // and focus, written before the shared hook existed, and demanding the hook by name failed
    // two components that were not broken. What a menu owes is that Up and Down move between its
    // items; whether it borrows that or writes it is not this suite's business.
    const driven = /useMenuFocus\(/.test(f.text) || (/ArrowDown/.test(f.text) && /\.focus\(/.test(f.text));
    check(`${f.path} drives its menu from the keyboard`, driven);
    // A MENU WITH NO ITEMS IS THE OTHER WAY TO FAIL THIS, and `FleetStrip` did: it declared the
    // role and every interactive child was a plain button, so assistive technology announced an
    // empty menu and the hook had nothing to move between. Any of the three item roles counts —
    // the agent filter is single-select, so its options are `menuitemradio`.
    check(`${f.path} contains items to move between`,
      /role="menuitem(radio|checkbox)?"/.test(f.text));
    // ON A RADIX POPOVER, ESCAPE AND THE PRESS OUTSIDE ARE ITS DISMISSABLE LAYER'S (2026-10-09) — the
    // composer's popover keeps only its arrow keys. Built by hand, a menu still has to show both.
    const radixLayer = /from "\.\.?\/ui\/popover\.tsx"/.test(f.text);
    // Escape was already handled everywhere; asserted so a new menu does not arrive without it.
    check(`${f.path} closes on Escape`, radixLayer || /"Escape"/.test(f.text));
    // And the click-away, which is the mouse half of the same "a menu is dismissible" promise.
    // Either a document listener or a full-screen catcher under the panel — the agent card uses
    // the catcher so that the click that dismisses its menu cannot also open the card beneath it.
    check(`${f.path} closes on a click outside`,
      radixLayer || /mousedown/.test(f.text) || /fixed inset-0[^>]*onClick=/.test(f.text));
  }
}

// THE HOOK'S OWN SECTION IS GONE WITH THE HOOK. `lib/menuFocus.ts` was deleted on 2026-10-09 once the
// last menu that used it moved to `ui/dropdown-menu.tsx`, whose roles, arrows, wrapping, typeahead and
// focus return are Radix's. A menu wired by hand again is still held to the checks above.

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

// A MENU THAT OPENS FROM INSIDE A SCROLLER MUST LEAVE IT, and two of them did not.
//
// THE BUG THIS GUARDS. `AgentRowMenu` and `RunOverflow` are the only menus in the application that
// open from inside a scrolling list — every other one sits in chrome that never scrolls. Both drew
// their panel with `position: absolute` inside the row, which works right up until an ancestor
// grows an `overflow`: an element with `overflow` other than `visible` CLIPS its absolutely
// positioned descendants, and no `z-index` climbs out of a clip. `z-index` orders what is painted;
// `overflow` decides what there is to paint.
//
// It went from latent to obvious when the Pinned shelf got a height cap, because a cap needs a
// scroller. With one agent pinned the shelf is about fifty pixels tall, so a two-hundred-pixel menu
// opened from it was cut off to nothing and read as hiding behind Recents. The identical clip was
// already sitting on the bottom rows of Recents, where it took a full list to run into.
//
// WHAT THIS ACTUALLY CHECKS, and what it cannot. A source scan for `deadControls.test.ts`'s reason:
// this client has no DOM harness, so nothing here measures a rectangle. What it can see is the
// shape that caused the bug — a panel positioned inside the list rather than portalled out of it —
// and the regression that really happens, which is somebody adding a third menu to a row and not
// knowing this is a rule.
//
//   npm run test:menu-clip

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (path: string): string => readFileSync(`${HERE}../${path}`, "utf8");

/** Comments blanked, for the reason `menuKeys.test.ts` spells out: prose about a bug is not a bug. */
const withoutComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

// THE RUNS TAB HOLDS THE OTHER LIST MENU NOW. Run rows left the sidebar for the right panel, and their
// menu still opens from inside a scroller, so the wiring counts below read both files.
const sidebar = withoutComments(read("components/Sidebar.tsx"));
const runsPanel = withoutComments(read("components/RunsPanel.tsx"));
const both = sidebar + runsPanel;

/**
 * Every component in `Sidebar.tsx`, sliced at its top-level `function` boundaries.
 *
 * WHICH MENUS ARE IN THE SCROLLER IS A DOM QUESTION and this is a source scan, so the answer is
 * reached the only way text can reach it: a menu is in the list if the list REACHES it. Walking
 * out from `AgentTreeRow` — the component the scroller maps over — gives exactly the menus that
 * render inside it, which is why `FilterMenu` is correctly absent: it sits in the Recents header,
 * a sibling of the scroller, and is not clipped by anything.
 *
 * Listing the two by name would have been shorter and would not have covered the regression that
 * actually happens, which is a THIRD menu added to a row by somebody who has never read this file.
 */
const bodies = ((): Map<string, string> => {
  const out = new Map<string, string>();
  const heads = [...sidebar.matchAll(/^function (\w+)\(/gm)];
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : sidebar.length;
    out.set(m[1]!, sidebar.slice(m.index!, end));
  });
  return out;
})();

/** Everything `AgentTreeRow` renders, transitively — the components that live inside the list. */
const inTheList = ((): Set<string> => {
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const body = bodies.get(name);
    if (!body) return;
    for (const m of body.matchAll(/<([A-Z]\w+)/g)) walk(m[1]!);
  };
  walk("AgentTreeRow");
  return seen;
})();

console.log("\nevery menu that opens from inside the scrolling list is portalled out of it");
{
  // A RADIX MENU COUNTS, AND IS PORTALLED BY CONSTRUCTION. The sidebar's menus moved to
  // `ui/dropdown-menu.tsx` on 2026-10-09, whose content renders through Radix's Portal — so a menu
  // drawn with `DropdownMenuContent` is checked by checking that component once, below.
  const menus = [...inTheList].filter((n) => /role="menu"|<DropdownMenuContent/.test(bodies.get(n) ?? ""));
  check("found the menus in the list", menus.length >= 1, `${menus.join(", ") || "none"}`);
  const ui = withoutComments(read("components/ui/dropdown-menu.tsx"));
  check("the shared menu renders its content through a portal",
    /<MenuPrimitive\.Portal>[\s\S]*<MenuPrimitive\.Content/.test(ui));

  for (const name of menus) {
    const body = bodies.get(name)!;
    if (/<DropdownMenuContent/.test(body)) {
      check(`${name} does not position its panel inside the row`, !/className="absolute/.test(body));
      continue;
    }
    check(`${name} renders its panel through a portal`, /createPortal\(/.test(body));
    check(`${name} portals into the body, which has no scrolling ancestor`,
      /document\.body,/.test(body));
    // THE DEFECT ITSELF: a panel positioned inside the row. `absolute` hangs it off the trigger,
    // which puts it inside the list's `overflow` and therefore inside the list's clip.
    check(`${name} does not position its panel inside the row`,
      !/className="absolute/.test(body),
      "an absolutely-positioned panel is clipped by the list's overflow");
  }
}

console.log("\n...and the Runs tab's run menu, which opens from inside its own scrolling list");
{
  // A RADIX MENU SINCE 2026-10-09, portalled by construction (see the shared check above).
  const radixRuns = /<DropdownMenuContent/.test(runsPanel);
  check("RunsPanel declares a run menu", /role="menu"/.test(runsPanel) || radixRuns);
  check("...rendered through a portal into the body",
    radixRuns || (/createPortal\(/.test(runsPanel) && /document\.body,/.test(runsPanel)));
  check("...not positioned inside the row", !/className="absolute/.test(runsPanel));
  // AND A PORTAL STILL BUBBLES THROUGH REACT: a click in the panel reaches the row, which opens the run.
  check("...and a click in it does not reach the row",
    !radixRuns || /<DropdownMenuContent[\s\S]{0,600}?onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(runsPanel));
}

console.log("\n...and the agent card's menu, which opens from inside a card that clips");
{
  // THE THIRD OF THE SAME BUG. A card is `overflow-hidden` so its banner keeps the rounded corners,
  // and its `⋯` sits on the card's last row — so a panel hung `top-full` inside it was cut flush at
  // the card's edge, and Export and Archive, the last two items, could not be reached at all.
  const card = withoutComments(read("components/AgentCard.tsx"));
  const overflow = /function Overflow\([\s\S]*?\n\}\n/.exec(card)?.[0] ?? "";
  check("AgentCard declares its overflow menu", overflow.length > 0);
  // A RADIX MENU SINCE 2026-10-09: portalled and anchored by construction (the shared check above).
  const radixCard = /<DropdownMenuContent/.test(overflow);
  check("...rendered through a portal into the body",
    radixCard || (/createPortal\(/.test(overflow) && /document\.body,/.test(overflow)));
  check("...not positioned inside the card", !/className="absolute/.test(overflow));
  check("...anchored back to its trigger", radixCard || /useAnchoredMenu\(open, ref, panelRef\)/.test(overflow));
  check("...and a click on it does not open the card through the portal",
    /onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(overflow));
}

console.log("\n...and a portalled panel keeps the wiring the portal breaks");
{
  // CLICK-AWAY IS THE ONE THAT FAILS SILENTLY AND TOTALLY. Once the panel is not inside the
  // trigger's subtree, a `mousedown` on one of its own items counts as a click outside: the menu
  // closes on mousedown and the item never receives the click. Every item is dead, and the menu
  // still looks completely normal.
  // PER HAND-BUILT MENU, AND THE RADIX ONES ARE EXEMPT. The sidebar's and the Runs tab's moved to
  // `ui/dropdown-menu.tsx` on 2026-10-09, and Radix owns click-away, focus and placement for its own
  // portalled content; these three are the wiring a HAND-BUILT portal has to remember.
  for (const [file, text] of [["Sidebar.tsx", sidebar], ["RunsPanel.tsx", runsPanel]] as const) {
    if (!(/createPortal\(/.test(text) && /role="menu"/.test(text))) continue;
    check(`${file}: click-away tests the panel as well as the trigger`, /panelRef\.current\?\.contains\(t\)/.test(text),
      "a portalled panel is `outside` its own trigger, so its items stop receiving clicks");
    // And the keyboard: `useMenuFocus` looks for items in the element it is given, so a portalled
    // menu has to hand it the panel — and the trigger separately, since they are no longer one tree.
    check(`${file}: the focus hook is given the panel and the trigger separately`, /useMenuFocus\(open, panelRef, ref\)/.test(text));
    check(`${file}: anchored back to its trigger`, /useAnchoredMenu\(open, ref, panelRef\)/.test(text));
  }
}

console.log("\n...and the trigger does not fade out from under its own open menu");
{
  // The panel used to be a child of the row, so hovering it kept `group-hover` alive and the
  // overflow button shown. Portalled, the row un-hovers the moment somebody reaches for the menu.
  const openStays = both.match(/open \? "opacity-100"/g) ?? [];
  check("an open menu pins its trigger visible", openStays.length >= 2, `${openStays.length} found`);
}

// THE ANCHORING HOOK'S SECTION IS GONE WITH THE HOOK. `lib/anchoredMenu.ts` was deleted on
// 2026-10-09 once the last portalled menu moved to `ui/dropdown-menu.tsx`, whose content Radix places
// against its trigger, flips at the window's edge and keeps there while a list scrolls.

console.log("\nthe fleet card's menu leaves the card");
{
  // THE COCKPIT'S CARD IS `overflow-hidden` INSIDE A STRIP THAT SCROLLS SIDEWAYS, and its menu was
  // `absolute` inside it: only "Today" and a sliver of Logs, Reconnect and Kill showed, and the log
  // pane not at all. Same rule as the list menus above — portalled out and anchored by hand.
  const strip = withoutComments(read("components/FleetStrip.tsx"));
  // A RADIX MENU SINCE 2026-10-09: portalled and placed against its trigger by construction.
  const radixStrip = /<DropdownMenuContent/.test(strip);
  check("the fleet card's menu is portalled out of the card", radixStrip || /createPortal\(/.test(strip));
  check("...and placed against its trigger", radixStrip || /useAnchoredMenu\(open, ref, panelRef\)/.test(strip));
  check("...and is not positioned inside the card", !/role="menu"[\s\S]{0,400}absolute right-0 top-full/.test(strip));
}

console.log("\na delete half-confirmed survives a stray click");
{
  // CLICKING ANYWHERE OUTSIDE THE DELETE CONFIRMATION DISMISSED IT, and the slug typed next went
  // nowhere. While a delete or a rename is being typed, only Escape or Cancel closes the menu.
  // ON THE RADIX MENU NOW: an outside press is refused while either form is open.
  check("an outside press does not close a confirmation or a rename in progress",
    /onInteractOutside=\{\(e\) => \{ if \(confirming \|\| renaming\) e\.preventDefault\(\); \}\}/.test(sidebar));
  check("...and typing in either form stays in the form", /onKeyDown=\{keepKeys\}[\s\S]*onKeyDown=\{keepKeys\}/.test(sidebar)
    && /const keepKeys = \(e: React\.KeyboardEvent\): void => \{ e\.stopPropagation\(\); \};/.test(sidebar));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

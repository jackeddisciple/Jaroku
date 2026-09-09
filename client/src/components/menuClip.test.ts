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

const sidebar = withoutComments(read("components/Sidebar.tsx"));

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
  const menus = [...inTheList].filter((n) => /role="menu"/.test(bodies.get(n) ?? ""));
  check("found the menus in the list", menus.length >= 2, `${menus.join(", ") || "none"}`);

  for (const name of menus) {
    const body = bodies.get(name)!;
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

console.log("\n...and a portalled panel keeps the wiring the portal breaks");
{
  // CLICK-AWAY IS THE ONE THAT FAILS SILENTLY AND TOTALLY. Once the panel is not inside the
  // trigger's subtree, a `mousedown` on one of its own items counts as a click outside: the menu
  // closes on mousedown and the item never receives the click. Every item is dead, and the menu
  // still looks completely normal.
  check("click-away tests the panel as well as the trigger",
    (sidebar.match(/panelRef\.current\?\.contains\(t\)/g) ?? []).length >= 2,
    "a portalled panel is `outside` its own trigger, so its items stop receiving clicks");
  // And the keyboard: `useMenuFocus` looks for items in the element it is given, so a portalled
  // menu has to hand it the panel — and the trigger separately, since they are no longer one tree.
  check("the focus hook is given the panel and the trigger separately",
    (sidebar.match(/useMenuFocus\(open, panelRef, ref\)/g) ?? []).length >= 2);
  check("both are anchored back to their trigger",
    (sidebar.match(/useAnchoredMenu\(open, ref, panelRef\)/g) ?? []).length >= 2);
}

console.log("\n...and the trigger does not fade out from under its own open menu");
{
  // The panel used to be a child of the row, so hovering it kept `group-hover` alive and the
  // overflow button shown. Portalled, the row un-hovers the moment somebody reaches for the menu.
  const openStays = sidebar.match(/open \? "opacity-100"/g) ?? [];
  check("an open menu pins its trigger visible", openStays.length >= 2, `${openStays.length} found`);
}

console.log("\nthe anchoring hook does what the portal owes the row");
{
  const hook = withoutComments(read("lib/anchoredMenu.ts"));
  check("it measures the trigger", /getBoundingClientRect\(\)/.test(hook));
  // A LAYOUT EFFECT, NOT AN EFFECT. It runs before paint, so the panel is never seen at the
  // top-left corner it is rendered at before being placed.
  check("it places the panel before the frame is painted", /useLayoutEffect/.test(hook));
  // Opening downward off the bottom of the window is the same invisible-menu bug in a new place.
  check("it flips up when there is no room below", /window\.innerHeight/.test(hook));
  check("...and stays inside the window horizontally", /window\.innerWidth/.test(hook));
  // CAPTURE, because scroll does not bubble from an element — without it the panel stays where the
  // row used to be the moment the list moves under it.
  check("it follows its trigger when the list scrolls",
    /addEventListener\("scroll", place, true\)/.test(hook));
  check("...and when the window is resized", /addEventListener\("resize", place\)/.test(hook));
  // SCROLLING MUST NOT CLOSE IT. Two of this menu's items open a form in the panel — a rename
  // field, and the one that asks for an agent's slug before deleting it — so a scroll that
  // dismissed the panel would throw away what somebody had typed.
  check("scrolling repositions rather than closes", !/setOpen\(false\)/.test(hook));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);

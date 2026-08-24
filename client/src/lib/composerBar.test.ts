// The bar's layout rules, which are §12's acceptance criteria 1c and 1d.
//
// Both of those criteria are written as things somebody verifies by resizing a window and looking,
// and that is exactly why they are checked here instead: "does hiding the effort control move the
// shield" is a question with a wrong answer that is invisible until the day somebody switches to
// Haiku, and by then the composer has been reviewed a dozen times at one width.
//
// The claim under all of it is that a position, once learned, stays learned.
//
//   npm run test:composer-bar

import {
  BREAKPOINT, CONTROL_ORDER, densityFor, layoutBar, overflowSlot, showsLabel,
  type ControlId,
} from "./composerBar.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Everything present — the widest composer on a reasoning model in a workspace with connectors. */
const ALL: ControlId[] = [...CONTROL_ORDER];

console.log("\nthe order is the spec's, and a caller cannot argue with it");
{
  const l = layoutBar(ALL, "full");
  check("the input group is ⊕, fullscreen, effort, shield, connectors, promote",
    l.left.join(",") === "add,fullscreen,effort,shield,connectors,promote", l.left.join(","));
  check("the execution group is model, mode, mic, send",
    l.right.join(",") === "model,mode,mic,send", l.right.join(","));
  check("nothing is in overflow at full width", l.overflow.length === 0);

  // Passed in reverse, the bar still comes out forwards. The order is the module's, not the
  // caller's — otherwise every call site is a place send can end up before mic.
  const reversed = layoutBar([...ALL].reverse(), "full");
  check("passing them backwards changes nothing", reversed.left.join(",") === l.left.join(",")
    && reversed.right.join(",") === l.right.join(","));
}

console.log("\n§12.1c — hiding a control does not move any other control");
{
  // The two the spec names: a non-reasoning model drops effort, an empty workspace drops the deck.
  const full = layoutBar(ALL, "full");
  const noEffort = layoutBar(ALL.filter((c) => c !== "effort"), "full");
  const noDeck = layoutBar(ALL.filter((c) => c !== "connectors"), "full");

  // ⊕ and fullscreen sit BEFORE the hidden control and must not move...
  check("⊕ stays first with no effort control", noEffort.left[0] === "add");
  check("fullscreen stays second with no effort control", noEffort.left[1] === "fullscreen");
  // ...and the execution group is packed from the other edge, so nothing there moves either.
  check("the execution group is untouched by a hidden input control",
    noEffort.right.join(",") === full.right.join(",") && noDeck.right.join(",") === full.right.join(","));
  // The surviving left controls keep their relative order; only the gap closes.
  check("the rest of the input group closes up in order",
    noEffort.left.join(",") === "add,fullscreen,shield,connectors,promote", noEffort.left.join(","));
  check("...and the same with the deck gone",
    noDeck.left.join(",") === "add,fullscreen,effort,shield,promote", noDeck.left.join(","));
}

console.log("\n§12.1d — the bar never wraps; below ~560 the three settings go to overflow");
{
  check("a wide composer is full", densityFor(900) === "full");
  check("just above the label breakpoint is still full", densityFor(BREAKPOINT.labels) === "full");
  check("just below it drops labels", densityFor(BREAKPOINT.labels - 1) === "dense");
  check("at the overflow breakpoint it is still dense", densityFor(BREAKPOINT.overflow) === "dense");
  check("below it, overflow", densityFor(BREAKPOINT.overflow - 1) === "overflow");
  check("a zero-width composer does not crash into a negative branch", densityFor(0) === "overflow");

  check("labels show only at full width",
    showsLabel("full") && !showsLabel("dense") && !showsLabel("overflow"));

  const narrow = layoutBar(ALL, "overflow");
  check("effort, shield, connectors and promote are what collapse",
    narrow.overflow.join(",") === "effort,shield,connectors,promote", narrow.overflow.join(","));
  check("...and they are gone from the bar itself",
    narrow.left.join(",") === "add,fullscreen", narrow.left.join(","));
  check("⊕, mic and send remain inline",
    narrow.left.includes("add") && narrow.right.includes("mic") && narrow.right.includes("send"));
  // The spec is explicit that these three are never behind a `⋯`.
  check("none of the three pinned controls is ever in overflow",
    !narrow.overflow.some((c) => c === "add" || c === "mic" || c === "send"));
}

console.log("\nthe ⋯ trigger sits at position 3, and stays there");
{
  const narrow = layoutBar(ALL, "overflow");
  check("after ⊕ and fullscreen", overflowSlot(narrow) === 2);
  check("there is no trigger when nothing collapsed", overflowSlot(layoutBar(ALL, "full")) === -1);

  // The clamp. With fullscreen hidden the left group is one item, and an unclamped splice at 2
  // would put the menu at the end — which is the very "position depends on what else is visible"
  // failure the fixed index exists to prevent.
  const noFullscreen = layoutBar(ALL.filter((c) => c !== "fullscreen"), "overflow");
  check("clamped to the group when fullscreen is hidden", overflowSlot(noFullscreen) === 1);
}

console.log("\nnothing collapses that is not there to collapse");
{
  // A non-reasoning model in a workspace with no connectors, on a narrow composer: the menu would
  // hold only the shield, and a `⋯` holding one item is a click somebody pays for nothing.
  const sparse = layoutBar(ALL.filter((c) => c !== "effort" && c !== "connectors" && c !== "promote"), "overflow");
  check("only what exists collapses", sparse.overflow.join(",") === "shield", sparse.overflow.join(","));

  // And with all three absent there is no trigger at all, rather than an empty menu.
  const none = layoutBar(["add", "fullscreen", "model", "mic", "send"], "overflow");
  check("no collapsible controls means no ⋯ at all", none.overflow.length === 0 && overflowSlot(none) === -1);
}

console.log("\nevery control lands on exactly one side of the spacer");
{
  for (const density of ["full", "dense", "overflow"] as const) {
    const l = layoutBar(ALL, density);
    const placed = [...l.left, ...l.right, ...l.overflow];
    check(`${density}: every control is placed exactly once`,
      placed.length === ALL.length && new Set(placed).size === ALL.length,
      `${placed.length} of ${ALL.length}`);
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

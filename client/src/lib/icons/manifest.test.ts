// I7, one half: every name the manifest gives resolves to a real export of the installed package.
//
// THE FAILURE THIS CATCHES IS AN UPGRADE, and it is silent without a suite. HugeIcons numbers its
// glyph families and the numbers move between releases: `import { Renamed01Icon }` from an ESM
// package yields `undefined` rather than throwing, so "the import worked" proves nothing and a
// typecheck proves less — the package's types allow it. What ships is a blank square in a filter
// bar, discovered by a person looking at it.
//
// It reads the manifest's SOURCE rather than importing it, deliberately. What the generator parses
// is the text of that file, so what this asserts should be the text of that file too — a suite that
// imported the module would pass on a manifest the generator could not read.
//
//   npm run test:icon-manifest

import { check, done, manifestKeys, read } from "./harness.ts";

const source = read("src/lib/icons/manifest.ts");
const entries = manifestKeys(source);
const icons = (await import("@hugeicons/core-free-icons")) as unknown as Record<string, unknown>;

console.log("\nthe manifest parses, and it is the size the specification asks for");
{
  // 162 SINCE THE NEW-AGENT SCREEN'S SUGGESTION CARDS: `emptyState.plan`, `build`, `explain` and
  // `trace`, one per command a card starts.
  //
  // 158 BEFORE THAT, SINCE THE RIGHT RAIL GOT ITS OWN TOGGLE: `panel.toggle`, the sidebar toggle's twin.
  //
  // 157 BEFORE THAT, SINCE THE TOP BAR WENT. `topbar.deploy`, `topbar.dryRun` and `deploy.cancel`
  // were drawn only in the strip above the middle panel, and left with it.
  //
  // 160 BEFORE THAT, SINCE THE SIDEBAR ROW'S OWN MENU. Five keys arrive and one leaves: `agents.rowMore`,
  // `pin`, `rename`, `configure` and `delete` for the menu that replaced the runs capsule, and
  // `agents.runsBadge` goes with the capsule it was drawn for. Counted rather than globbed for the
  // reason the icon release gave: a number in a test is a decision somebody has to change on
  // purpose, and a key added without one is a key nobody argued for.
  //
  // `agents.rowMore` IS A SECOND ELLIPSIS AND NOT A DUPLICATE. `agents.more` is horizontal and sits
  // on the AgentCard among other marks; this one is vertical and sits at the end of a dense sidebar
  // row, where a horizontal ellipsis reads as three more characters of the timestamp beside it.
  check("162 registry keys", entries.length === 162, `${entries.length}`);
  const names = new Set(entries.map((e) => e.export));
  // 104 from icons_integration's appendix, plus D8's 13 — the composer glyphs that had to move
  // here when `@hugeicons/react` came out. See the note at the top of `registry.ts`.
  // 123 SINCE THE SIDEBAR ROW MENU. Four new marks — `EllipsisVerticalIcon`, `PinIcon`,
  // `Edit03Icon`, `Settings05Icon` — plus `AddSquareIcon`, which replaced the plain plus the `New`
  // row drew on a filled black tile; `Delete01Icon` was already here for a dataset. `PlayCircle02Icon`
  // leaves with the runs capsule, the only mark this release removes.
  // 121 SINCE THE TOP BAR WENT: `SquareTerminalIcon` and `CancelCircleIcon` had no other key.
  // 122 WITH `PanelRightCloseIcon`, for the right rail's toggle.
  // 125 WITH `IdeaIcon`, `HammerIcon` and `Telescope01Icon` for the suggestion cards; the fourth
  // card borrows the Trace tab's `FootprintsIcon`.
  check("125 distinct marks", names.size === 125, `${names.size}`);
  check("no key is declared twice", new Set(entries.map((e) => e.key)).size === entries.length);
}

console.log("\n...and every name in it is a real export of the installed package");
{
  for (const { key, export: name } of entries) {
    const payload = icons[name];
    const ok = Array.isArray(payload) && payload.length > 0
      && payload.every((part) => Array.isArray(part) && typeof part[0] === "string" && !!part[1]);
    check(
      `${key} → ${name}`,
      ok,
      payload === undefined ? "undefined — renamed upstream?" : "present but not drawable",
    );
  }
}

console.log("\nthe three names the specification warns about are spelled the way the package spells them");
{
  // icons_integration §2's "three name gotchas that will cost an hour if missed". They are here by
  // name because each one is a plausible mis-spelling that a reader would not question.
  check("Grid3X2Icon — capital X, though the slug is grid3x2", "Grid3X2Icon" in icons);
  check("FullScreenIcon — capital S; FullscreenIcon does not exist", "FullScreenIcon" in icons
    && !("FullscreenIcon" in icons));
  check("McpServerIcon — Mcp, not MCP", "McpServerIcon" in icons && !("MCPServerIcon" in icons));
}

done();

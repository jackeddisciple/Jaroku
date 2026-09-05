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
  check("150 registry keys", entries.length === 150, `${entries.length}`);
  const names = new Set(entries.map((e) => e.export));
  // 104 from icons_integration's appendix, plus D8's 13 — the composer glyphs that had to move
  // here when `@hugeicons/react` came out. See the note at the top of `registry.ts`.
  check("117 distinct marks", names.size === 117, `${names.size}`);
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

// §5.2's "Export current version", as one file the browser hands over.
//
// IN ITS OWN MODULE BECAUSE IT HAS TWO CALLERS AND THEY MUST AGREE. The overflow menu on a card
// exports the current version; the file browser in the detail exports whichever version it is
// showing. Both produce the same document — and when the builder lived inside the file browser, the
// card's menu entry called `sendLoadAgentVersion` and stopped there: it fetched the files into the
// store and downloaded nothing at all, so "Export current version" was a menu item that did nothing
// visible. A shared builder is what makes the second caller possible.
//
// MARKDOWN WITH FENCED BLOCKS RATHER THAN A ZIP. A browser cannot write a zip without a library, and
// what somebody exporting a version actually does with it is read it or paste it somewhere — an
// issue, a review, another tool. Fenced by path, in manifest order, so it is still a project.

import type { AgentFileView } from "../types.ts";

/**
 * The longest run of backticks anywhere in a string, so a fence can be made longer than it.
 *
 * A GENERATED AGENT'S FILES CONTAIN MARKDOWN. `jaroku.json` has a description in it, a project can
 * carry a README, and a docstring can quote a fenced block — at which point a three-backtick fence
 * closes on the file's own content and the rest of the export is rendered as prose. CommonMark's
 * answer is that a fence may be longer than three and is closed only by one at least as long, so the
 * fence is sized to the content rather than assumed.
 */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The whole version as one markdown document. */
export function versionMarkdown(slug: string, version: number, files: readonly AgentFileView[]): string {
  const head = [`# ${slug} — v${version}`, "", `${files.length} file${files.length === 1 ? "" : "s"}`, ""];
  const body = files.map((f) => {
    const fence = fenceFor(f.content);
    return [`## ${f.path}`, "", fence, f.content, fence, ""].join("\n");
  });
  return [...head, ...body].join("\n");
}

/**
 * Hand the file to the browser.
 *
 * A DOWNLOAD RATHER THAN A CLIPBOARD, because a project is longer than anybody wants to paste and
 * the filename is what makes the export identifiable afterwards. The object URL is revoked in the
 * same tick: the anchor's click has already started the save, and leaving it alive holds the whole
 * document in memory for the life of the tab.
 */
export function downloadVersion(slug: string, version: number, files: readonly AgentFileView[]): void {
  const blob = new Blob([versionMarkdown(slug, version, files)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}-v${version}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

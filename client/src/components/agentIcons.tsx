// The marks the Agents tab needs and the panel did not already have.
//
// SAME IDIOM AS `composerIcons.tsx`, `graphIcons.tsx` AND `fileIcons.tsx`: no icon dependency, and
// the SVG attributes come from `panelIcons.svg` so nothing here can drift to a different stroke
// weight. That factory is the whole reason this is a separate file rather than a second one — two
// factories with two stroke weights is how a pane ends up with icons that are subtly different
// weights depending on which file they came from, which is exactly what v0.2.2 spent a release
// undoing.
//
// A NOTE ON WHERE THESE COME FROM, because §8 asks for HugeIcons and this is not that. The rule §8
// opens with is "one stroke weight everywhere… do not undo that", and every icon already in this
// product is Lucide geometry on a 24px grid at `ICON.strokeWidth`. Mixing a second family in would
// give the grid two optical weights and two ideas of what a rounded terminal looks like — visible
// immediately in a filter bar where a HugeIcons funnel sits beside Lucide's own magnifier. So these
// are drawn to the family already here. Everything else §8 asks for holds exactly: inline SVG
// components committed to the repo, no runtime icon font, no hotlink, one weight, and an accessible
// label plus a tooltip on every icon-only control.
//
// Ten icons, not a set. Each one is here because a control in this tab has no honest existing mark:
// there was no archive, no restore-from-archive, no copy, no download, no filter, no density
// toggle, no history, no folder and no stack.

import { svg } from "./panelIcons.tsx";
import { ICON, SURFACE } from "../lib/tokens.ts";
import { alpha } from "../lib/palette.ts";

type P = { size?: number; strokeWidth?: number; className?: string };

/** lucide:archive — put an agent away. The lid, and the box under it. */
export function ArchiveIcon(p: P) {
  return svg(
    p,
    <>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>,
  );
}

/** lucide:archive-restore — bring one back. The same box, with the arrow coming out of it. */
export function ArchiveRestoreIcon(p: P) {
  return svg(
    p,
    <>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h4" />
      <path d="M20 8v11a2 2 0 0 1-2 2h-4" />
      <path d="m9 15 3-3 3 3" />
      <path d="M12 12v9" />
    </>,
  );
}

/** lucide:copy — §5.5's copy agent context. Two sheets, one behind the other. */
export function CopyIcon(p: P) {
  return svg(
    p,
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>,
  );
}

/** lucide:download — export a version. */
export function DownloadIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </>,
  );
}

/** lucide:filter — §4's filter controls, behind one button rather than five in the header. */
export function FilterIcon(p: P) {
  return svg(p, <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />);
}

/** lucide:layout-grid — the comfortable density: three cards per row, each with room. */
export function GridIcon(p: P) {
  return svg(
    p,
    <>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </>,
  );
}

/** lucide:rows-3 — the compact density: more per row, shorter cards. */
export function RowsIcon(p: P) {
  return svg(
    p,
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
    </>,
  );
}

/** lucide:history — §6's version history. A clock with the arrow that goes backwards. */
export function HistoryIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </>,
  );
}

/** lucide:folder — §6's file browser. */
export function FolderIcon(p: P) {
  return svg(
    p,
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  );
}

/** lucide:layers — an agent's capabilities, which are a stack rather than a list. */
export function LayersIcon(p: P) {
  return svg(
    p,
    <>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m6.08 10.37-3.48 1.58a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59" />
      <path d="m6.08 15.87-3.48 1.58a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59" />
    </>,
  );
}

/**
 * The Jaroku mark's slot on a card thumbnail.
 *
 * NOT AN ICON, and that is why it is a wrapper rather than another entry above. §9 records brand
 * logos as exempt from the stroke rule, and `JarokuGlyph` is three solid contours traced from
 * `assets/logo.jpeg` — the real mark from v0.2.4's wordmark work, not a redrawing. What this adds is
 * only the disc it sits on: a solid glyph on a photograph needs a ground to be legible against, and
 * the ground is the app's own panel colour at high alpha rather than a tint, so the mark reads the
 * same over a pale gradient and a dark one.
 */
export function ThumbnailMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-full text-ink backdrop-blur-[2px]"
      style={{ width: size, height: size, background: alpha(SURFACE.panel, 0.72) }}
      aria-hidden
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M11 1.04C11.6 0.98 12.2 0.97 12.79 1.03C13.38 1.07 13.97 1.18 14.54 1.34C15.12 1.5 15.69 1.7 16.22 1.95C16.76 2.2 17.37 2.46 17.76 2.85C18.13 3.25 18.55 3.85 18.51 4.36C18.48 4.85 17.94 5.4 17.56 5.85C17.19 6.3 16.73 6.7 16.24 7.05C15.77 7.39 15.23 7.66 14.69 7.9C14.15 8.14 13.57 8.32 12.99 8.47C12.42 8.62 11.83 8.7 11.25 8.83C10.66 8.96 10.08 9.07 9.51 9.24C8.94 9.41 8.37 9.62 7.83 9.86C7.29 10.09 6.76 10.37 6.25 10.68C5.75 11 5.26 11.36 4.81 11.74C4.36 12.13 4.01 12.68 3.55 13C3.08 13.31 2.39 13.78 2.02 13.62C1.64 13.48 1.39 12.64 1.3 12.08C1.21 11.53 1.37 10.89 1.47 10.31C1.57 9.73 1.71 9.14 1.9 8.58C2.08 8.01 2.29 7.45 2.57 6.92C2.83 6.39 3.15 5.89 3.49 5.4C3.85 4.92 4.24 4.47 4.67 4.05C5.09 3.64 5.56 3.26 6.05 2.92C6.54 2.59 7.06 2.29 7.59 2.04C8.13 1.78 8.69 1.56 9.26 1.39C9.83 1.23 10.41 1.1 11 1.04Z" />
        <path d="M20.99 7.72C21.31 7.65 21.84 8.21 22.08 8.61C22.33 9.01 22.39 9.63 22.5 10.15C22.6 10.67 22.66 11.2 22.69 11.73C22.71 12.27 22.68 12.8 22.62 13.33C22.57 13.85 22.48 14.38 22.34 14.9C22.21 15.41 22.04 15.91 21.83 16.41C21.62 16.9 21.39 17.38 21.11 17.83C20.85 18.29 20.53 18.73 20.2 19.14C19.86 19.55 19.51 19.96 19.11 20.31C18.73 20.67 18.29 20.99 17.85 21.29C17.41 21.58 16.95 21.86 16.47 22.08C16 22.31 15.49 22.5 14.98 22.65C14.47 22.8 13.92 22.97 13.41 22.96C12.9 22.95 12.31 22.84 11.9 22.57C11.49 22.29 11.08 21.79 10.95 21.32C10.81 20.86 10.88 20.22 11.07 19.77C11.27 19.32 11.72 18.92 12.12 18.59C12.52 18.26 13.05 18.07 13.49 17.78C13.93 17.49 14.38 17.19 14.8 16.85C15.21 16.52 15.6 16.15 15.97 15.78C16.34 15.39 16.68 14.98 17.01 14.57C17.34 14.15 17.66 13.71 17.95 13.27C18.24 12.83 18.53 12.38 18.78 11.91C19.04 11.45 19.29 10.97 19.52 10.49C19.75 10.01 19.91 9.49 20.16 9.03C20.41 8.56 20.67 7.78 20.99 7.72Z" />
        <path d="M10.31 11.35C10.75 11.29 11.21 11.29 11.65 11.3C12.1 11.33 12.56 11.37 12.98 11.51C13.39 11.64 13.88 11.82 14.15 12.13C14.42 12.43 14.61 12.94 14.61 13.35C14.6 13.76 14.36 14.22 14.12 14.59C13.88 14.94 13.5 15.24 13.15 15.51C12.81 15.8 12.4 16.01 12.04 16.25C11.66 16.51 11.29 16.75 10.94 17.02C10.59 17.31 10.24 17.6 9.95 17.94C9.65 18.27 9.37 18.64 9.18 19.04C8.99 19.43 8.87 19.88 8.8 20.32C8.74 20.76 8.9 21.28 8.76 21.66C8.63 22.05 8.33 22.51 7.99 22.64C7.64 22.78 7.09 22.61 6.67 22.46C6.26 22.32 5.86 22.07 5.5 21.81C5.14 21.55 4.81 21.23 4.54 20.88C4.26 20.53 4.03 20.14 3.85 19.73C3.69 19.32 3.56 18.87 3.52 18.43C3.48 18 3.51 17.53 3.59 17.1C3.68 16.66 3.81 16.22 4 15.81C4.17 15.4 4.4 15.01 4.66 14.65C4.91 14.28 5.21 13.93 5.53 13.62C5.84 13.31 6.2 13.03 6.57 12.78C6.94 12.53 7.34 12.33 7.75 12.14C8.16 11.95 8.57 11.77 9 11.64C9.42 11.51 9.86 11.41 10.31 11.35Z" />
      </svg>
    </span>
  );
}

/** The size ladder, re-exported so a consumer needs one import rather than two. */
export { ICON };

// What kind of file this is, from its name.
//
// Every file list in the panel drew the same generic page: agent.py, jaroku.json, README.md and
// .env.example were four identical glyphs with four different strings beside them. The icon column
// carried no information at all — it was a bullet with extra steps — which is a waste of the one
// slot the eye lands on first when scanning a list of six or seven files.
//
// The shapes stay in one family on purpose. Every icon here is the same page outline with a
// different mark inside it, so a list still reads as "files" at a glance and as "which kinds of
// files" on a second look. That also keeps them inside the panel's icon system: Lucide geometry,
// one stroke weight, currentColor, drawn through the shared svg() factory.
//
// Deliberately *not* brand logos. A Python or Markdown logo cannot be drawn legibly at 12px in a
// single-weight stroke set, and the panel already reserves brand marks for identifying a service
// (lib/icons.tsx), not a file format. Type families are what a file list actually needs to
// distinguish anyway: source from data from prose from secrets.
//
// Reusable on purpose. The trace panel's step detail and the graph view's resource nodes both show
// file paths and could adopt this without re-deciding any of it — the same way lib/tokens.ts was
// built for them in the last pass. Neither is wired up here.

import { svg } from "./panelIcons.tsx";
import { FileIcon } from "./panelIcons.tsx";

type P = { size?: number; strokeWidth?: number; className?: string };

/** The page outline every icon in this file is built on — lucide's file, with its folded corner. */
const page = (
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </>
);

/** lucide:file-code — source. The thing that was written, rather than read or configured. */
export function FileCodeIcon(p: P) {
  return svg(
    p,
    <>
      {page}
      <path d="M10 12.5 8 15l2 2.5" />
      <path d="m14 12.5 2 2.5-2 2.5" />
    </>,
  );
}

/** lucide:file-text — prose. A README, a system prompt, anything meant to be read. */
export function FileTextIcon(p: P) {
  return svg(
    p,
    <>
      {page}
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>,
  );
}

/** lucide:file-json — structured data and manifests. Braces, because that is what is inside. */
export function FileDataIcon(p: P) {
  return svg(
    p,
    <>
      {page}
      <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
      <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
    </>,
  );
}

/** lucide:file-key — secrets and credentials. Worth telling apart from ordinary config at a glance. */
export function FileKeyIcon(p: P) {
  return svg(
    p,
    <>
      {page}
      <circle cx="10" cy="16" r="2" />
      <path d="m16 10-4.5 4.5" />
      <path d="m15 11 1 1" />
    </>,
  );
}

/**
 * Extension → icon. Lowercased, so `README.MD` lands with `readme.md`.
 *
 * `.example` is here because `.env.example` is the file this project actually ships, and the
 * suffix that matters is the one carrying the meaning — a template for secrets is still about
 * secrets.
 */
const BY_EXTENSION: Record<string, (p: P) => React.ReactElement> = {
  // Source.
  py: FileCodeIcon,
  ts: FileCodeIcon,
  tsx: FileCodeIcon,
  js: FileCodeIcon,
  jsx: FileCodeIcon,
  sh: FileCodeIcon,
  sql: FileCodeIcon,
  // Data and manifests.
  json: FileDataIcon,
  toml: FileDataIcon,
  yaml: FileDataIcon,
  yml: FileDataIcon,
  cfg: FileDataIcon,
  ini: FileDataIcon,
  lock: FileDataIcon,
  // Prose.
  md: FileTextIcon,
  txt: FileTextIcon,
  rst: FileTextIcon,
  // Secrets.
  env: FileKeyIcon,
  example: FileKeyIcon,
  pem: FileKeyIcon,
  key: FileKeyIcon,
};

/**
 * The icon for a path.
 *
 * Returns a component rather than an element so the caller still chooses the size — a file list and
 * a stat row want different ones, and baking a size in here would take that away.
 *
 * Falls back to the plain page, which is the honest answer for a file whose type we don't know:
 * better than picking a wrong one, and identical to what every row showed before this existed.
 */
export function iconForPath(path: string): (p: P) => React.ReactElement {
  const name = path.split("/").pop() ?? path;
  // Dotfiles with no other suffix (.env, .gitignore) have their name *as* the extension.
  const ext = name.startsWith(".") && !name.slice(1).includes(".")
    ? name.slice(1).toLowerCase()
    : (name.split(".").pop() ?? "").toLowerCase();
  return BY_EXTENSION[ext] ?? FileIcon;
}

// The icon registry — the single import surface for every glyph the composer and the turn
// interaction rows draw.
//
// WHY A REGISTRY AND NOT TWENTY IMPORTS. Hugeicons numbers its glyph families (`Copy01Icon`,
// `Send02Icon`, `Mic02Icon`) and the numbering moves between releases: a name that resolves today
// resolves to `undefined` after an upgrade, and an `undefined` icon does not throw — it renders
// nothing. Twenty ad-hoc imports means twenty places to discover that, one blank 20px square at a
// time. One registry means the upgrade breaks in a single file, and every rename is fixed where it
// is declared rather than where it is used. Nothing outside this file imports from
// `@hugeicons/core-free-icons`, and that rule is the whole value of the file.
//
// THE NAMES WERE VERIFIED AGAINST THE INSTALLED PACKAGE (4.3.0), not against the icon site. The
// site's slug (`ai-brain-02`) and the package's export (`AiBrain02Icon`) agree today and are not
// guaranteed to; the package is the thing that ships.
//
// AND THE URLS ARE NOT HERE ON PURPOSE. The spec lists a hugeicons.com link per token as a design
// reference for confirming a shape. They are a reference, never a runtime: this file imports from
// the npm package so tree-shaking works and an offline desktop build still draws its icons. A
// hotlinked SVG would be a network dependency in the composer's control bar, which is the one row
// in the product that has to be there before anything else is.
//
// `.ts` RATHER THAN `.tsx`, which is not an accident either. What a registry maps is data — an
// `IconSvgElement` is an array of path tuples — and keeping the file free of JSX is what stops it
// from slowly acquiring the components that consume it. The one renderer here is built with
// `createElement` for that reason, and it is deliberately the only thing in the file that is not a
// table.

import { createElement } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AddCircleIcon,
  AiBrain02Icon,
  BracesIcon,
  ConnectIcon,
  CopyIcon,
  DatabaseImportIcon,
  FileAddIcon,
  FlowConnectionIcon,
  FullScreenIcon,
  GithubIcon,
  HourglassIcon,
  Mic02Icon,
  Note02Icon,
  PinIcon,
  ReloadIcon,
  RepairIcon,
  SendIcon,
  ShieldEnergyIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "@hugeicons/core-free-icons";

/**
 * Every glyph, by the job it does rather than by the shape it is.
 *
 * The key side of this table is the part that must not change: a component asks for
 * `Icon.Regenerate` because it is regenerating something, and if a later release decides the
 * better shape for that is `Refresh02Icon`, the swap happens on the right-hand side and no caller
 * is touched. Naming these `Icon.Reload` — after the glyph — would have thrown that away and made
 * the registry a second spelling of the import list.
 */
export const Icon = {
  // --- composer control bar -------------------------------------------------------------------
  /** ⊕ — attach context to this turn. */
  Add: AddCircleIcon,
  /** ⛶ — expand the composer into the modal editor. */
  Fullscreen: FullScreenIcon,
  /** Reasoning effort, in the control bar and again in the metadata row that reports it. */
  Effort: AiBrain02Icon,
  /** The permission shield — a policy control, never a tool-execution one. */
  Shield: ShieldEnergyIcon,
  /** The connector deck's affordance, beside the stacked logos. */
  Connect: ConnectIcon,
  /** Voice input. Already in the composer; re-pointed here so one file owns the shape. */
  Mic: Mic02Icon,
  /** Submit. Same note as the mic. */
  Send: SendIcon,

  // --- the ⊕ menu's five sources --------------------------------------------------------------
  AttachFile: FileAddIcon,
  AttachRun: RepairIcon,
  AttachDataset: DatabaseImportIcon,
  AttachTool: FlowConnectionIcon,
  Github: GithubIcon,

  // --- the message action row -----------------------------------------------------------------
  Copy: CopyIcon,
  Note: Note02Icon,
  Pin: PinIcon,
  Regenerate: ReloadIcon,
  ThumbUp: ThumbsUpIcon,
  ThumbDown: ThumbsDownIcon,

  // --- the response metadata row --------------------------------------------------------------
  /** { } — this turn produced a version. */
  Build: BracesIcon,
  /** Wall-clock from dispatch to stream completion. */
  Duration: HourglassIcon,
} as const;

export type IconToken = keyof typeof Icon;

/**
 * The size ladder, by context.
 *
 * DELIBERATELY NOT `lib/tokens.ts`'s `ICON`. That ladder is 10/12/14/16 at stroke 1.75 and it
 * describes Lucide geometry drawn on a 24px grid — the family the rest of the client uses. These
 * are Hugeicons at stroke 1.5 on their own grid, and the two do not read the same at the same
 * nominal number: a Hugeicons glyph at 16 sits lighter than a Lucide one at 16, which is why the
 * composer's controls are 20 and the action row's are 16 rather than both being `ICON.md`.
 *
 * Merging the two ladders would mean one of the two families rendering at a size chosen for the
 * other, everywhere. Keeping them apart is what lets a Hugeicons control sit in a row of Lucide
 * chrome without either looking wrong.
 */
export const GLYPH = {
  /** The composer's bottom control bar. */
  toolbar: 20,
  /** Under an assistant turn: copy, note, pin, regenerate, feedback. */
  action: 16,
  /** The response metadata row — subordinate to the small muted text it sits in. */
  meta: 14,
  /** Rows inside a dropdown or popover menu. */
  menu: 18,
  /** The glyph of an empty state. */
  empty: 32,
  /**
   * Stroke 1.5, and it is the package's own default weight for Stroke Rounded — the only style
   * the free package ships, which is also the style the design asked for. Passing it explicitly
   * rather than relying on the default is what makes it a decision somebody can find.
   */
  strokeWidth: 1.5,
} as const;

/**
 * The minimum hit target for an icon-only control, in px, regardless of the glyph inside it.
 *
 * Thirty-two. A 20px glyph in a 20px button is a control you miss on a trackpad and cannot hit at
 * all on a touch screen, and the composer's bar is seven of them in a row — the place where a
 * near-miss costs the most, because the neighbour you hit instead is a different setting.
 */
export const HIT_TARGET = 32;

/**
 * Draw one registry glyph.
 *
 * `color="currentColor"` is not a default anybody may override at a call site, and that is the
 * point: the button's text colour drives the icon, so hover, active and disabled states come free
 * from the classes already on the button. Every icon in this app that hardcoded its own colour
 * ended up with a disabled state that stayed bright.
 */
export function Glyph({
  icon,
  size = GLYPH.action,
  className,
}: {
  icon: (typeof Icon)[IconToken];
  size?: number;
  className?: string;
}) {
  return createElement(HugeiconsIcon, {
    icon,
    size,
    strokeWidth: GLYPH.strokeWidth,
    color: "currentColor",
    className,
    // Decorative by default. An icon-only control carries its name on the BUTTON as an
    // `aria-label` — §10's rule — and a glyph that also announced itself would say the same word
    // twice to a screen reader.
    "aria-hidden": true,
  });
}

// Icons for the generation panel — Lucide geometry, drawn inline.
//
// Same idiom as composerIcons.tsx and graphIcons.tsx: no icon dependency, one shared factory that
// locks the SVG attributes so nothing can drift. The shapes are Lucide's (24px grid, round caps and
// joins), because that family reads correctly next to Inter and is what the rest of the industry's
// tooling uses — but only the dozen this panel actually needs are here, rather than a library.
//
// Stroke is 1.75, not Lucide's default 2. At 14px next to 12px text, 2 reads noticeably heavier than
// the type around it; 1.75 sits level. It comes from ICON.strokeWidth so there is one place to
// change it, and every icon in the panel moves together.
//
// Colour is always currentColor. An icon never decides its own colour — the row it sits in does,
// which is what lets the same check mean "audited" in teal and "approved" in green.

import { ICON } from "../lib/tokens.ts";

type P = {
  size?: number;
  /** Only for the rare case an icon sits against much larger type. Prefer leaving it alone. */
  strokeWidth?: number;
  className?: string;
};

/**
 * The one place SVG attributes are decided for the whole panel. Exported so composerIcons.tsx
 * draws through it too — two factories with two different stroke weights is how a pane ends up
 * with icons that are subtly different weights depending on which file they came from.
 */
export const svg = (
  { size = ICON.sm, strokeWidth = ICON.strokeWidth, className }: P,
  children: React.ReactNode,
) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    {children}
  </svg>
);

// ── Tool categories ─────────────────────────────────────────────────────────
// The two icons that carry the distinction the whole plan gate exists for.

/** lucide:shield-check — a reviewed connector tool. Audited, copied in verbatim, read-only. */
export function ShieldCheckIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>,
  );
}

/** lucide:plug — an MCP tool. Discovered from a server nobody here has reviewed. */
export function PlugIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
    </>,
  );
}

/** lucide:shield-alert — a high-impact tool, gated behind an explicit confirmation. */
export function ShieldAlertIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>,
  );
}

/** lucide:eye — a read-only tool. Lower friction by design. */
export function EyeIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </>,
  );
}

/** lucide:refresh-cw — re-run a server's capability handshake. */
export function RefreshIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>,
  );
}

/** lucide:key-round — a stored credential. Presence only; never the value. */
export function KeyIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </>,
  );
}

/** lucide:sparkles — a bespoke tool. About to be written by a model, for this agent only. */
export function SparklesIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </>,
  );
}

// ── Section headers ─────────────────────────────────────────────────────────

/** lucide:wrench — the tools sections. */
export function WrenchIcon(p: P) {
  return svg(
    p,
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  );
}

/** lucide:database — the state section. State is the agent's shape, its stored fields. */
export function DatabaseIcon(p: P) {
  return svg(
    p,
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </>,
  );
}

/** lucide:git-branch — the graph section. Nodes and the edges between them. */
export function GitBranchIcon(p: P) {
  return svg(
    p,
    <>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>,
  );
}

/** lucide:lightbulb — "worth knowing". Caveats and things the plan wants you to notice. */
export function LightbulbIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </>,
  );
}

/** lucide:lock — a hard rule. What the agent will never do, whatever it is asked. */
export function LockIcon(p: P) {
  return svg(
    p,
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>,
  );
}

/** lucide:info — a fact about how the agent works. Worth reading, not a rule. */
export function InfoIcon(p: P) {
  return svg(
    p,
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>,
  );
}

/** lucide:git-fork — a branch. A run forked from another run's checkpoint. */
export function GitForkIcon(p: P) {
  return svg(
    p,
    <>
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </>,
  );
}

/**
 * lucide:activity — a trace.
 *
 * The product's one primitive had no mark of its own. The tab says "Trace" and the timeline is
 * built out of step rows, so nothing anywhere was a picture of the thing — which only shows when
 * there is no trace to draw and the panel has to say what it is waiting for.
 */
export function ActivityIcon(p: P) {
  return svg(p, <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />);
}

// ── Navigation and controls ─────────────────────────────────────────────────

/** lucide:search — the sidebar's agent filter. */
export function SearchIcon(p: P) {
  return svg(
    p,
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>,
  );
}

/** lucide:settings — the one place the app's own configuration lives. */
export function SettingsIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  );
}

/** lucide:pencil — say it differently. Revising a plan rather than accepting or dropping it. */
export function PencilIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>,
  );
}

/** lucide:chevron-right — "there is more this way". Never a `›` character. */
export function ChevronRightIcon(p: P) {
  return svg(p, <path d="m9 18 6-6-6-6" />);
}

/** lucide:play — resume a paused run from its durable checkpoint. */
export function PlayIcon(p: P) {
  return svg(p, <path d="M6 3.6a1 1 0 0 1 1.5-.87l12 8.4a1 1 0 0 1 0 1.74l-12 8.4A1 1 0 0 1 6 20.4z" />);
}

/** lucide:pause — halt the live run at its next node boundary. */
export function PauseIcon(p: P) {
  return svg(
    p,
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </>,
  );
}

/**
 * lucide:loader-circle — work in flight.
 *
 * The one state the four StatusBadge glyphs could not say. A clock is "waiting on a decision",
 * which is a different thing from "running right now", and the app was drawing the difference
 * with a pulsing `●` character.
 */
export function LoaderIcon(p: P) {
  return svg(p, <path d="M21 12a9 9 0 1 1-6.219-8.56" />);
}

// ── Speakers ────────────────────────────────────────────────────────────────

/** lucide:circle-user-round — the person. The one who asked for this. */
export function UserCircleIcon(p: P) {
  return svg(
    p,
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7 20.7V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.7" />
    </>,
  );
}

// ── Status ──────────────────────────────────────────────────────────────────

/** lucide:check — approved, audited, done. */
export function CheckIcon(p: P) {
  return svg(p, <path d="M20 6 9 17l-5-5" />);
}

/** lucide:clock — pending, waiting on a decision. */
export function ClockIcon(p: P) {
  return svg(
    p,
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>,
  );
}

/** lucide:alert-triangle — needs attention. Warnings, staleness, mismatches. */
export function AlertTriangleIcon(p: P) {
  return svg(
    p,
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>,
  );
}

/** lucide:plus — added. A file that did not exist before this change. */
export function PlusIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>,
  );
}

/** lucide:x — discarded, failed. */
export function XIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>,
  );
}

/** lucide:undo-2 — put it back the way it was. */
export function UndoIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" />
    </>,
  );
}

// ── Stats ───────────────────────────────────────────────────────────────────

/** lucide:file — a written file. */
export function FileIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>,
  );
}

/** lucide:hash — a token count. */
export function HashIcon(p: P) {
  return svg(
    p,
    <>
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </>,
  );
}

/** lucide:dollar-sign — what it cost. */
export function DollarSignIcon(p: P) {
  return svg(
    p,
    <>
      <line x1="12" x2="12" y1="2" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </>,
  );
}

/** lucide:zap — a cache hit: the same work, without paying for it twice. */
/** lucide:rocket — deploy. The one action in the app that reaches outside this machine. */
export function RocketIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </>,
  );
}

/** lucide:globe — a live public URL. */
export function GlobeIcon(p: P) {
  return svg(
    p,
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>,
  );
}

export function ZapIcon(p: P) {
  return svg(
    p,
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  );
}

/**
 * The GitHub mark, drawn rather than imported.
 *
 * FILLED, and it is the one icon in this file that is. Every other mark here is a Lucide outline at
 * 1.75 because it describes an ACTION or a KIND — a wrench, an eye, a fork — and outlines read
 * lighter beside 12px type. This one is a LOGO, and a logo redrawn as a 1.75 outline stops being
 * recognisable as the thing it is a logo of, which defeats the only job it has. So it keeps its
 * silhouette and takes `currentColor` as a fill, exactly as the provider marks in lib/icons.tsx do.
 */
export function GithubIcon({ size = ICON.sm, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.23C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

/** lucide:arrow-up — ahead, and the push half of §A.8's split button. */
export function ArrowUpIcon(p: P) {
  return svg(p, <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>);
}

/** lucide:arrow-down — behind. */
export function ArrowDownIcon(p: P) {
  return svg(p, <><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>);
}

/** lucide:arrow-up-down — diverged. Both sides moved, which is a stopped state and not a busy one. */
export function ArrowUpDownIcon(p: P) {
  return svg(p, <><path d="m21 16-4 4-4-4" /><path d="M17 20V4" /><path d="m3 8 4-4 4 4" /><path d="M7 4v16" /></>);
}

/** lucide:external-link — a commit sha, a repo, a PR. Anything that leaves for github.com. */
export function ExternalLinkIcon(p: P) {
  return svg(p, <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" /></>);
}

/** lucide:chevron-down — a collapse chevron and a split button's caret. */
export function ChevronDownIcon(p: P) {
  return svg(p, <path d="m6 9 6 6 6-6" />);
}

/** lucide:git-pull-request — §3.9's card. */
export function GitPullRequestIcon(p: P) {
  return svg(
    p,
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </>,
  );
}

/** lucide:more-vertical — the kebab an escape hatch lives under. */
export function KebabIcon(p: P) {
  return svg(p, <><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></>);
}

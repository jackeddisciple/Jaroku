// The Activity tab's twelve marks, as inline SVG at the app's one stroke weight.
//
// SOURCED FROM THE HUGEICONS FREE SET (https://hugeicons.com/icons) and COMMITTED HERE, which §4
// asks for in both halves: an icon font loaded at runtime is a network dependency for a glyph, and
// hotlinking is somebody else's uptime deciding whether a card has a mark on it. The geometry below
// is the `stroke / rounded` free set at version 4.2.3, read out of `@hugeicons/core-free-icons` —
// the same set and the same route `inboxIcons.tsx` took for the Inbox's fifteen.
//
// EVERY STROKE WIDTH AND COLOUR THE SOURCE CARRIED IS DROPPED. v0.2.2 replaced eighteen font
// characters standing in for icons with real SVGs at ONE weight, and the fastest way to undo that
// pass is to paste a set drawn at a different one — HugeIcons ships at 1.5 on a 24 grid and this app
// draws at `ICON.strokeWidth`. Everything here goes through the shared `svg()` helper in
// panelIcons.tsx, which supplies both, so a mark on this tab is optically the same weight as a mark
// two panels over and inherits `currentColor` so a card can tint it.
//
// TWO ICONS ARE SIMPLIFIED, AND BOTH ARE RECORDED RATHER THAN QUIETLY REDRAWN:
//
//   `LeaderboardIcon` keeps the podium and drops the star that sits above it. At 14px the star is
//   four strokes inside a 5px box and turns to mud; what carries the meaning is the three stepped
//   bars, and an icon whose distinguishing detail is invisible at the size it is used is an icon
//   that reads as noise.
//
//   `RangeIcon` keeps the calendar's ticks, body and header rule and drops the day numerals inside
//   it, for the same reason and with the same test: the shape that says "a span of days" is the
//   grid, not the digits.
//
// WHAT IS DELIBERATELY NOT HERE: an icon for anything that already has one. §4 says not to define a
// second icon for an action that already exists, and `lib/actionIcons.tsx`, `panelIcons.tsx` and
// `inboxIcons.tsx` between them already carry a rocket for a deploy, a fork for a branch, a wrench
// for a tool call, a plug for MCP, a clock, a check and a warning triangle. This file is the
// vocabulary the app did not already have: the shapes of a DASHBOARD.

import { svg } from "./panelIcons.tsx";

type P = { size?: number; className?: string };

/** §1's global date range control — HugeIcons `calendar-01`, without its day numerals. */
export function RangeIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M16 2V6M8 2V6" />
      <path d="M13 4H11C7.22876 4 5.34315 4 4.17157 5.17157C3 6.34315 3 8.22876 3 12V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H13C16.7712 22 18.6569 22 19.8284 20.8284C21 19.6569 21 17.7712 21 14V12C21 8.22876 21 6.34315 19.8284 5.17157C18.6569 4 16.7712 4 13 4Z" />
      <path d="M3 10H21" />
    </>,
  );
}

/** §3.1's WORKSPACE PULSE band — HugeIcons `chart-line-data-01`. */
export function PulseIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M21 21H10C6.70017 21 5.05025 21 4.02513 19.9749C3 18.9497 3 17.2998 3 14V3" />
      <path d="M5 20C5.43938 16.8438 7.67642 8.7643 10.4282 8.7643C12.3301 8.7643 12.8226 12.6353 14.6864 12.6353C17.8931 12.6353 17.4282 4 21 4" />
    </>,
  );
}

/** §2's spend rollup and its ring gauge — HugeIcons `pie-chart`. */
export function RingIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M20.5 15.8278C17.9985 21.756 9.86407 23.4835 5.20143 18.8641C0.629484 14.3347 2.04493 6.12883 8.05653 3.5" />
      <path d="M17.6831 12.5C19.5708 12.5 20.5146 12.5 21.1241 11.655C21.1469 11.6234 21.1848 11.5667 21.2052 11.5336C21.7527 10.6471 21.4705 9.966 20.9063 8.60378C20.3946 7.36853 19.6447 6.24615 18.6993 5.30073C17.7538 4.35531 16.6315 3.60536 15.3962 3.0937C14.034 2.52946 13.3529 2.24733 12.4664 2.79477C12.4333 2.81523 12.3766 2.85309 12.345 2.87587C11.5 3.4854 11.5 4.42922 11.5 6.31686V8.42748C11.5 10.3473 11.5 11.3072 12.0964 11.9036C12.6928 12.5 13.6527 12.5 15.5725 12.5H17.6831Z" />
    </>,
  );
}

/** §6's model and provider mix — HugeIcons `chart-bar-line`. */
export function MixIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M22 22L2 22" />
      <path d="M4 15L4 19" />
      <path d="M12 9L12 19" />
      <path d="M20 13L20 19" />
    </>,
  );
}

/** §7's agent leaderboard — HugeIcons `ranking`, podium only. See the header for the star. */
export function LeaderboardIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M2 22H22" />
      <path d="M3.5 18C3.5 16.5858 3.5 15.8787 3.93934 15.4393C4.37868 15 5.08579 15 6.5 15H7C7.94281 15 8.41421 15 8.70711 15.2929C9 15.5858 9 16.0572 9 17V22H3.5V18Z" />
      <path d="M9 16C9 14.5858 9 13.8787 9.43934 13.4393C9.87868 13 10.5858 13 12 13C13.4142 13 14.1213 13 14.5607 13.4393C15 13.8787 15 14.5858 15 16V22H9V16Z" />
      <path d="M15 19C15 18.0572 15 17.5858 15.2929 17.2929C15.5858 17 16.0572 17 17 17H17.5C18.9142 17 19.6213 17 20.0607 17.4393C20.5 17.8787 20.5 18.5858 20.5 20V22H15V19Z" />
    </>,
  );
}

/** §5's feed filters — HugeIcons `filter`. */
export function FunnelIcon(p: P) {
  return svg(
    p,
    <path d="M8.85746 12.5061C6.36901 10.6456 4.59564 8.59915 3.62734 7.44867C3.3276 7.09253 3.22938 6.8319 3.17033 6.3728C2.96811 4.8008 2.86701 4.0148 3.32795 3.5074C3.7889 3 4.60404 3 6.23433 3H17.7657C19.396 3 20.2111 3 20.672 3.5074C21.133 4.0148 21.0319 4.8008 20.8297 6.37281C20.7706 6.83191 20.6724 7.09254 20.3726 7.44867C19.403 8.60062 17.6261 10.6507 15.1326 12.5135C14.907 12.6821 14.7583 12.9567 14.7307 13.2614C14.4837 15.992 14.2559 17.4876 14.1141 18.2442C13.8853 19.4657 12.1532 20.2006 11.226 20.8563C10.6741 21.2466 10.0043 20.782 9.93278 20.1778C9.79643 19.0261 9.53961 16.6864 9.25927 13.2614C9.23409 12.9539 9.08486 12.6761 8.85746 12.5061Z" />,
  );
}

/** §8's version publish on the release timeline — HugeIcons `tag-01`. */
export function ReleaseTagIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M2.77423 11.1439C1.77108 12.2643 1.7495 13.9546 2.67016 15.1437C4.49711 17.5033 6.49674 19.5029 8.85633 21.3298C10.0454 22.2505 11.7357 22.2289 12.8561 21.2258C15.8979 18.5022 18.6835 15.6559 21.3719 12.5279C21.6377 12.2187 21.8039 11.8397 21.8412 11.4336C22.0062 9.63798 22.3452 4.46467 20.9403 3.05974C19.5353 1.65481 14.362 1.99377 12.5664 2.15876C12.1603 2.19608 11.7813 2.36233 11.472 2.62811C8.34412 5.31646 5.49781 8.10211 2.77423 11.1439Z" />
      <path d="M7 14L10 17" />
      <circle cx="16.5" cy="7.5" r="1.5" />
    </>,
  );
}

/** §10's Team pulse — HugeIcons `user-multiple-02`. */
export function TeamPulseIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M13 7C13 9.20914 11.2091 11 9 11C6.79086 11 5 9.20914 5 7C5 4.79086 6.79086 3 9 3C11.2091 3 13 4.79086 13 7Z" />
      <path d="M15 11C17.2091 11 19 9.20914 19 7C19 4.79086 17.2091 3 15 3" />
      <path d="M11 14H7C4.23858 14 2 16.2386 2 19C2 20.1046 2.89543 21 4 21H14C15.1046 21 16 20.1046 16 19C16 16.2386 13.7614 14 11 14Z" />
      <path d="M17 14C19.7614 14 22 16.2386 22 19C22 20.1046 21.1046 21 20 21H18.5" />
    </>,
  );
}

/** §10's personal streak — HugeIcons `fire-02`. */
export function StreakIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M12 22C16.1421 22 19.5 18.6421 19.5 14.5C19.5 13.5 19.5 11.5 17.5 9C17.5 9 17.4004 11.8536 15.4262 11.4408C12.2331 10.7732 16.3551 4.50296 10.5 2C10.5 7 4.5 8.5 4.5 14.5C4.5 18.6421 7.85786 22 12 22Z" />
      <path d="M12 19.0011C13.933 19.0011 15.5 16.9864 15.5 14.5011C12.3 15.7011 11.1667 12.9379 11 11C9.55426 11.5532 8.5 13.8256 8.5 15C8.5 17.4853 10.067 19.0011 12 19.0011Z" />
    </>,
  );
}

/** §6's spend/volume toggle, and any figure that is a share — HugeIcons `percent`. */
export function ShareIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M4 20L20 4" />
      <path d="M8.26777 4.73223C9.24408 5.70854 9.24408 7.29146 8.26777 8.26777C7.29146 9.24408 5.70854 9.24408 4.73223 8.26777C3.75592 7.29146 3.75592 5.70854 4.73223 4.73223C5.70854 3.75592 7.29146 3.75592 8.26777 4.73223Z" />
      <path d="M19.2678 15.7322C20.2441 16.7085 20.2441 18.2915 19.2678 19.2678C18.2915 20.2441 16.7085 20.2441 15.7322 19.2678C14.7559 18.2915 14.7559 16.7085 15.7322 15.7322C16.7085 14.7559 18.2915 14.7559 19.2678 15.7322Z" />
    </>,
  );
}

/** §4's export affordance — HugeIcons `download-04`. */
export function ExportIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M16.9504 12.1817C17.1981 12.814 16.5076 13.5726 15.1267 15.0899C13.6702 16.6902 12.9201 17.4904 12 17.5C11.0799 17.4904 10.3298 16.6902 8.87331 15.0899C7.49239 13.5726 6.80193 12.814 7.04964 12.1817C7.05868 12.1586 7.06851 12.1359 7.0791 12.1135C7.34928 11.542 8.24477 11.5029 10 11.5002V4.99998C10 4.53501 10 4.30253 10.0511 4.11179C10.1898 3.59414 10.5941 3.1898 11.1118 3.05111C11.3025 3 11.535 3 12 3C12.4649 3 12.6974 3 12.8882 3.05111C13.4058 3.1898 13.8102 3.59414 13.9489 4.11179C14 4.30253 14 4.53501 14 4.99998V11.5002C15.7552 11.5029 16.6507 11.542 16.9209 12.1135C16.9315 12.1359 16.9413 12.1586 16.9504 12.1817Z" />
      <path d="M5 21H19" />
    </>,
  );
}

/** §4's expand and collapse — HugeIcons `arrow-expand-01`. */
export function ExpandIcon(p: P) {
  return svg(
    p,
    <>
      <path d="M16.4999 3.26621C17.3443 3.25421 20.1408 2.67328 20.7337 3.26621C21.3266 3.85913 20.7457 6.65559 20.7337 7.5M20.5059 3.49097L13.5021 10.4961" />
      <path d="M3.26636 16.5001C3.25436 17.3445 2.67343 20.141 3.26636 20.7339C3.85928 21.3268 6.65574 20.7459 7.50015 20.7339M10.502 13.4976L3.49824 20.5027" />
    </>,
  );
}

// Composer controls — mic, send, model chevron, save-to-dataset.
//
// Shapes are Tabler's (ti-microphone / ti-arrow-up / ti-chevron-down / ti-bookmark-plus), drawn
// through the shared factory in panelIcons.tsx rather than a local one. They previously had their
// own copy of the factory at strokeWidth 2, so a composer icon sat visibly heavier than a plan icon
// a few pixels above it — the kind of difference nobody names but everybody sees.
//
// Sizes come off ICON's ladder. The send arrow stays one step smaller because it sits inside a
// filled 30px circle, where an icon at the same nominal size reads larger than one on open
// background.

import { ICON } from "../lib/tokens.ts";
import { svg } from "./panelIcons.tsx";

type P = { size?: number };

export function MicIcon({ size = ICON.md }: P) {
  return svg(
    { size },
    <>
      <path d="M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -6 0z" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </>,
  );
}

export function ArrowUpIcon({ size = ICON.sm }: P) {
  return svg(
    { size },
    <>
      <path d="M12 5v14" />
      <path d="M18 11l-6 -6" />
      <path d="M6 11l6 -6" />
    </>,
  );
}

export function ChevronDownIcon({ size = ICON.sm - 1 }: P) {
  return svg({ size }, <path d="M6 9l6 6l6 -6" />);
}

/** ti-bookmark-plus — "save this test input into the eval dataset". */
export function SaveToDatasetIcon({ size = ICON.md }: P) {
  return svg(
    { size },
    <>
      <path d="M12 17l-6 4v-14a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v6" />
      <path d="M16 19h6" />
      <path d="M19 16v6" />
    </>,
  );
}

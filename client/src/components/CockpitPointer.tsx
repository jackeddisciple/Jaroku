// A pointer to the Cockpit, and deliberately not a second board.
//
// §3'S ONE SEAM BETWEEN TWO TABS, in its own words: "A deployed run waiting on an MCP confirmation
// is blocking in the Inbox's sense and waiting on you in the Cockpit's. Pick one home — the Cockpit
// — and give the Inbox a pointer to it rather than a second card. Two boards showing the same thing
// is how both stop being believed."
//
// SO THIS RENDERS A COUNT AND A DESTINATION AND NOTHING ELSE, which is the whole design of it and
// the reason it is thirty lines of markup rather than a card. The moment it rendered the tool being
// asked about, or an Allow button, there would be two places one confirmation can be answered — and
// worse than a duplicated surface, the two would race for one nonce and the loser would report a
// failure for a question that had been answered correctly.
//
// IT IS THE SAME COMPONENT SHAPE AS `InboxPointer`, which points the other way — from an agent's
// detail into the Inbox — and that symmetry is not decoration: it is what makes "a pointer" a thing
// this codebase has rather than a thing each surface improvises. Nothing renders at zero, no empty
// state, no reserved space.
//
// THE COUNT IS THE COCKPIT'S OWN, from the same snapshot its badge is drawn from. One quantity
// computed once and rendered in three places — the sidebar badge, the Cockpit header and here — is
// what stops two surfaces disagreeing about how much is blocked, which is exactly what somebody
// clicking through would notice first.

import { ICON } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useWorkStore, workBadgeCount } from "../store/workStore.ts";
import { ChevronRightIcon, GaugeIcon } from "./panelIcons.tsx";

export function CockpitPointer() {
  const waiting = useWorkStore((s) => workBadgeCount(s.counts));
  const openCockpit = useUiStore((s) => s.openCockpitForAgent);

  if (waiting === 0) return null;

  return (
    <button
      // THE WHOLE STRIP IS THE TARGET, for the reason `InboxPointer`'s is: it is one sentence and
      // one destination, and a hit area smaller than the thing it describes is a control people
      // miss.
      onClick={() => openCockpit(null)}
      className="flex w-full shrink-0 items-center gap-2 border-b border-hair px-4 py-1.5 text-left text-tiny text-muted transition-colors hover:bg-active/40 hover:text-ink"
      title="Open the Cockpit, where deployed jobs waiting on an answer live"
    >
      <span className="shrink-0 text-faint" aria-hidden>
        <GaugeIcon size={ICON.xs} />
      </span>
      <span className="text-ink">{waiting}</span>
      <span>
        deployed job{waiting === 1 ? "" : "s"} {waiting === 1 ? "is" : "are"} waiting on an answer
      </span>
      {/* AND WHERE IT LIVES, said rather than implied. Somebody reading a board of blocking cards
          needs to know this is not one of them — and that it is not missing from here by accident. */}
      <span className="text-faint">— in the Cockpit</span>
      <span className="ml-auto shrink-0 text-faint" aria-hidden>
        <ChevronRightIcon size={ICON.xs} />
      </span>
    </button>
  );
}

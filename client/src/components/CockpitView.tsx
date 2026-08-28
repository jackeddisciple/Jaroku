// The full-screen Cockpit — §2's console, and deliberately not a fifth list.
//
// FIVE TABS, FIVE GENUINELY DIFFERENT SILHOUETTES. Threads is a row list, Agents is a card grid
// with a density toggle, the Inbox is a severity board with a rail, Activity is figure-led cards.
// §2: "A fifth list would make the app feel like it has five of the same screen." So this one is a
// CONSOLE — a horizontal band of live objects across the top, a dense record below it, and a
// detail that slides over rather than navigates away.
//
// THE SHAPE MATCHES THE QUESTION. The eye goes to the band to see WHAT IS ALIVE, then down to the
// record to see WHAT HAPPENED, and a job's detail must not cost the reader their place in the
// list — "an operator scanning forty rows who loses scroll position on every click will stop
// clicking". Every one of the three regions below exists because of one clause of that sentence.
//
// AND WHAT IT MUST NOT RESEMBLE, which §2 spends as many words on: not the Inbox board, because
// work items are graded by TIME and a severity column would imply a triage that does not exist
// here; not the Agents grid, because fleet cards are a strip and they are glances rather than
// summaries; and not a table with sortable headers, because sorting is time descending, always,
// and a column-sorted table invites the reader to reorganise a record whose only true order is the
// order it happened in.
//
// ─── THE ALIGNMENT SPINE ────────────────────────────────────────────────────────────────────────
//
// §Craft 3 names one habit as "the single habit that separates a screen that reads as designed
// from one that reads as assembled": the header's label, the fleet card and the work row's status
// glyph sit on the same left edge. `SPINE` below is that edge, and it is a rung of the existing
// ladder rather than a number — `SPACE.section`, 20px, which is what `px-5` already spells and
// what the Inbox's header already uses.
//
// ONE OF THE THREE CANNOT BE ON IT TO THE PIXEL, and saying so is better than pretending. A fleet
// card is a bordered box with its own padding, so its NAME sits inset by that border and padding;
// putting the name itself at 20px would mean a card whose text begins on its own border. What
// shares the spine is the card's LEFT EDGE and its connection glyph — which puts the card's glyph,
// the row's glyph and the header's label on one line, and makes the card's name align with the
// row's input text rather than with the label above it. That is the strongest alignment a bordered
// card admits, and it is a better one than the literal reading: the two glyphs a reader's eye
// crosses in the same downward glance are the pair that had to agree.
//
// NO SPINNERS, AND `loaded` IS A DISTINCT STATE FROM EMPTY. "We have not been told yet" renders a
// skeleton and "there is nothing" renders one of §10's three zero states — collapsing them would
// put "Nothing has been asked of them yet" in front of somebody whose jobs are still on the wire.

import { useEffect } from "react";

import { HEADER, OFFLINE } from "../lib/cockpitCopy.ts";
import { CARD_HEIGHT, CARD_WIDTH, ROW_HEIGHT, SPINE_X } from "../lib/cockpitLayout.ts";
import { sendListFleet, sendListWork } from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import { EmptyState } from "./EmptyState.tsx";
import { FleetStrip } from "./FleetStrip.tsx";
import { WorkComposer } from "./WorkComposer.tsx";
import { WorkDetail } from "./WorkDetail.tsx";
import { WorkList } from "./WorkList.tsx";
import { RefreshIcon, RocketIcon } from "./panelIcons.tsx";

/**
 * §3A's header bar, which is the Inbox's header — copied literally rather than approximated.
 *
 * "TWO HEADERS THAT ARE NEARLY THE SAME ARE WORSE THAN TWO THAT ARE IDENTICAL OR TWO THAT ARE
 * OBVIOUSLY DIFFERENT." Every value here is `InboxView`'s: `border-b border-hair`, `px-5 py-3`,
 * `TYPE.panelLabel`, a `text-tiny tabular-nums text-faint` count, the reconnecting notice, and the
 * refresh control pushed right by `ml-auto`. The previous version of this header had `px-6 pt-5
 * pb-3`, no bottom border and an icon beside the label — four small disagreements with the tab one
 * click away, which is exactly the "nearly the same" §3 rules out.
 *
 * NO RANGE CONTROL AND NO SEARCH. Activity's header carries a range because every figure on that
 * page describes one window; nothing here is aggregated over a window — a job is a job. The
 * filters that DO belong to this tab are the list's, and they sit on the list.
 *
 * AND NO AUTO-REFRESH SPINNER — §15. The channel pushes. A spinner that turns on a live surface is
 * decoration, and the refresh here is a way to CHECK rather than a thing that is happening.
 */
function Header() {
  const counts = useWorkStore((s) => s.counts);
  const connected = useTraceStore((s) => s.connection === "open");

  // THE SUM OF THE PAGE'S OWN COUNTS, which is the Inbox's `counts.all` under a different name.
  // Scope-aware, because the chips beside the list are: a header figure computed workspace-wide
  // over a list showing one person's jobs is the promise `counts` was made scope-aware to keep.
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <div className={`flex shrink-0 items-center gap-3 border-b border-hair py-3 ${SPINE_X}`}>
      <span className={TYPE.panelLabel}>{HEADER.label}</span>
      <span className="text-tiny tabular-nums text-faint">{total}</span>
      {!connected && (
        // §10's offline treatment, and it is the Inbox's own so the two tabs say it identically.
        <span className="text-tiny text-muted" title={OFFLINE.hint}>
          {OFFLINE.header}
        </span>
      )}
      {/* ASK AGAIN. A full-snapshot channel that goes stale — a transition nothing broadcast, a
          frame dropped during a reconnect — otherwise has no remedy but reloading the page. BOTH
          reads, because they answer on different clocks and the relay volunteers only one of them. */}
      <button
        type="button"
        onClick={() => { sendListWork(); sendListFleet(); }}
        disabled={!connected}
        className="ml-auto rounded-control p-1.5 text-faint transition-colors hover:bg-active hover:text-ink active:bg-chrome disabled:pointer-events-none disabled:opacity-40"
        title={HEADER.refresh}
        aria-label={HEADER.refresh}
      >
        <RefreshIcon size={ICON.xs} />
      </button>
    </div>
  );
}

/**
 * §10's first zero state: no live agents at all.
 *
 * THE ONLY `full` EMPTY STATE IN THE TAB, and §10 says why: "it is a genuine state of the product,
 * not a gap that clears in ten seconds." The other two are `line`, because a full-height
 * illustration for a condition that resolves itself is theatre — `EmptyState`'s own file makes the
 * same argument at greater length.
 */
function NothingLive() {
  return (
    <EmptyState
      icon={RocketIcon}
      title="No agents are live yet"
      hint="Deploy an agent from its Deploy panel and it will appear here, with everything it has been asked to do."
    />
  );
}

export function CockpitView() {
  const loaded = useWorkStore((s) => s.loaded);
  const anyLive = useWorkStore((s) => s.anyLive);
  const error = useWorkStore((s) => s.error);
  const setFilters = useWorkStore((s) => s.setFilters);
  const takeCockpitAgentIntent = useUiStore((s) => s.takeCockpitAgentIntent);
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const connected = useTraceStore((s) => s.connection === "open");

  // ONE ASK PER (WORKSPACE, CONNECTION), which is `ActivityView`'s rule and is here for the reason
  // its own note gives: a reconnect leaves this tab holding a fleet from before the drop with no
  // way to know it is stale.
  //
  // BOTH READS, and they are two because they answer on different clocks. Only the LIST arrives
  // unprompted: the relay volunteers `work/snapshot` on connect so the badge is right on frame
  // one, and volunteers no `fleet` at all. So a mount-only ask left the strip empty for the whole
  // of the next workspace — `loaded` came back true from the volunteered snapshot while `anyLive`
  // stayed false, and the tab said "No agents are live yet" over a workspace with three of them.
  useEffect(() => {
    // A POINTER'S FILTER IS APPLIED BEFORE THE READ, not after it. An Agent detail's strip and the
    // Inbox both open this tab already narrowed, and asking unfiltered first would render the
    // whole workspace's work for a frame — which on a busy workspace is a list somebody starts
    // reading before it is replaced under them.
    const intent = takeCockpitAgentIntent();
    if (intent !== null) setFilters({ agentId: intent, scope: "all" });
    sendListWork();
    sendListFleet();
  }, [takeCockpitAgentIntent, setFilters, workspaceId, connected]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
      <Header />

      {/* §10: ERRORS GO WHERE THE INBOX'S GO — a `text-tiny text-err` strip under the header, with
          the same bottom hairline. NOT A TOAST: "a toast for a dispatch failure disappears before
          the user has read which job failed", and four of this tab's verbs spend money or stop
          something. It stays until the next snapshot clears it. */}
      {error && (
        <div className={`shrink-0 border-b border-hair py-2 text-tiny text-err ${SPINE_X}`}>{error}</div>
      )}

      {/* §3B: THE STRIP, DIRECTLY UNDER THE HEADER, and it is `shrink-0` so it never gives up
          height to the list. It renders whatever the fleet holds — including nothing, while the
          first snapshot is on the wire — because a strip that appeared only once it had cards
          would be a region arriving after the one below it and moving the whole list down. */}
      {loaded && anyLive && <FleetStrip />}

      {/* §3C AND §3D IN ONE CONTAINER, which is the load-bearing bit of geometry on this screen.
          `relative` HERE AND NOT ON THE VIEW ROOT: §3D says the detail slides over the WORK LIST,
          "not over the fleet strip and never over the sidebar". Anchored to the root it covered
          the header and the strip as well — so the glance the strip exists to be disappeared
          behind the panel opened FROM it. The sidebar is untouched either way, because a
          full-screen destination is contained by §2's layout law rather than by the viewport. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {!loaded ? (
          <CockpitSkeleton />
        ) : !anyLive ? (
          <NothingLive />
        ) : (
          <>
            <WorkList />
            {/* §8: THE COMPOSER SITS AT THE BOTTOM OF THE WORK LIST REGION, in the flow rather
                than floating. It is the one control on this tab that CREATES something, and
                putting it above the record would make the tab read as a form with a history under
                it rather than as a console with a way to act. */}
            <WorkComposer />
          </>
        )}

        {/* MOUNTED ALWAYS AND TRANSLATED OFF-SCREEN WHEN CLOSED, so the transition plays in both
            directions — the same mechanism `StepDetailPanel` uses. A panel that unmounted would
            appear instantly and leave slowly, which reads as two different controls. It is mounted
            outside the three branches above for a second reason: a citation opens a job by id,
            with no list in between, and a panel that lived inside the `anyLive` branch could not
            be opened in a workspace whose last agent had just been killed. */}
        <WorkDetail />
      </div>
    </div>
  );
}

/**
 * §10's loading state: a skeleton, not a spinner.
 *
 * THE INBOX'S PATTERN, AT THIS TAB'S SHAPE — "a heading bar and two blocks at the shape of the
 * content". What is skeletoned is the strip and the first few rows, because those are what will
 * be there; the detail panel gets `LoadingLine` instead, since it opens on an id rather than on a
 * shape.
 *
 * AND ITS GEOMETRY IS THE CONTENT'S, WHICH IS §Craft 1's WHOLE POINT: "every skeleton's geometry
 * matches its final content exactly: the same row height, the same column widths, the same card
 * width". One pixel of jump on a busy list is what makes a surface read as unfinished, and it is
 * the cheapest thing in this document to get right — it costs nothing but discipline in the
 * markup. The real dimensions are imported from the components rather than repeated here, so the
 * two cannot drift and `test:cockpit-craft` can hold them to each other.
 */
function CockpitSkeleton() {
  return (
    <div aria-hidden className="flex min-h-0 flex-1 flex-col">
      <div className={`flex shrink-0 gap-3 border-b border-hair py-2 ${SPINE_X}`}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            // THE CARD'S OWN WIDTH, imported rather than guessed — §Craft 1. A skeleton one pixel
            // off its content is the jump that makes a whole surface read as unfinished.
            style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
            className="shrink-0 rounded-card bg-active/60"
          />
        ))}
      </div>
      <div className={`flex flex-col py-1 ${SPINE_X}`}>
        {[0, 1, 2, 3, 4].map((i) => (
          // AND THE ROW'S OWN HEIGHT, for the same reason and from the same module. The glyph slot
          // and the figure column are reserved at their real widths too, so nothing beside them
          // moves when the real row lands — §Craft 4's rule applied to the wait rather than to a
          // hover.
          <div key={i} style={{ height: ROW_HEIGHT }} className="flex items-center gap-3">
            <div style={{ width: ICON.xs, height: ICON.xs }} className="shrink-0 rounded-full bg-active/60" />
            <div className="h-3 min-w-0 flex-1 rounded-chip bg-active/50" />
            <div className="h-3 w-[7ch] shrink-0 rounded-chip bg-active/40" />
          </div>
        ))}
      </div>
    </div>
  );
}

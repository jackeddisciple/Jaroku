// The full-screen Cockpit (§3–§11): a two-region operator console, and deliberately not a fifth list.
//
// FIVE TABS, FIVE GENUINELY DIFFERENT LAYOUTS. Threads is rows, Agents is a card grid, the Inbox is
// a severity board, Activity is figure-led cards, and this is a STRIP over a LIST with a detail
// panel sliding in from the right. §9 asks for exactly that shape and the reason is what the strip
// and the list each answer: the strip is "what is live", a glance across the fleet that fits on one
// line per agent; the list is "what is happening to the jobs I gave it", which is rows. Neither
// reads as the other and folding them together would produce a list of agents with jobs nested
// under it — which is the Agents tab with extra steps.
//
// IT IS WORK-FIRST, WHICH IS THE DECISION §3 SPENDS A PARAGRAPH ON. One list across every agent,
// because the operator asks "what is happening", not "how is agent four". There is deliberately no
// work list inside Agent detail: a second place a job can be dealt with is the mistake the Inbox
// already refused, so what goes there is a POINTER — "3 running, 1 waiting on you" — that opens
// this tab filtered to that agent.
//
// THE TWO REGIONS ARE ONE SCROLL AND THE STRIP DOES NOT MOVE. A fleet card is a glance and a glance
// that scrolls away is a glance somebody has to go and find; the strip scrolls HORIZONTALLY inside
// itself when the fleet is wider than the pane, which is what keeps a workspace with twenty agents
// from pushing the work list off the bottom of the screen.
//
// NO SPINNERS, AND `loaded` IS A DISTINCT STATE FROM EMPTY. "We have not been told yet" renders a
// line, and "there is nothing" renders one of §11.4's three zero states — collapsing them would put
// "Nothing has been asked of them yet" in front of somebody whose jobs are still on the wire.

import { useEffect } from "react";

import { sendListFleet, sendListWork } from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useWorkStore } from "../store/workStore.ts";
import { EmptyState, LoadingLine } from "./EmptyState.tsx";
import { GaugeIcon, RocketIcon } from "./panelIcons.tsx";

/**
 * The header: what this tab is, and the one number that says whether it needs somebody.
 *
 * NO RANGE CONTROL AND NO SEARCH. Activity's header carries a range because every figure on that
 * page describes one window; nothing here is aggregated over a window — a job is a job — so a
 * control that filtered by time would be inventing a question the surface does not ask. The filters
 * that DO belong here are the list's, and they sit on the list.
 */
function Header() {
  const counts = useWorkStore((s) => s.counts);
  const live = useWorkStore((s) => s.anyLive);

  return (
    <div className="flex shrink-0 items-baseline gap-3 px-6 pt-5 pb-3">
      <span className="text-faint" aria-hidden>
        <GaugeIcon size={ICON.sm} />
      </span>
      <h1 className={TYPE.panelLabel}>Cockpit</h1>
      {/* ONE SENTENCE OF REAL STATE, in the same spirit §9 asks of a fleet card. "Cockpit" alone
          says what the tab is called; this says whether it needs anybody, which is the thing
          somebody opened it to find out. Rendered only when there is something to say — an empty
          workspace gets the zero state below instead of a row of zeroes. */}
      {live && (
        <span className="text-caption text-muted tabular-nums">
          {counts.running} running
          {counts.waiting > 0 && <span className="text-ink"> · {counts.waiting} waiting on you</span>}
          {counts.queued > 0 && <> · {counts.queued} queued</>}
        </span>
      )}
    </div>
  );
}

/**
 * §11.4's first zero state: no live agents at all.
 *
 * "Blocking 0 should feel like an achievement; no live agents should feel like a NEXT STEP." So
 * this one is the full treatment with a route out of it, and the two below it are not — the
 * difference between a workspace that has not started and one that is simply idle.
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

  // BOTH READS ON MOUNT, and they are two because they answer on different clocks — see §5. The
  // list arrives on connect as well (the relay sends it in the initial snapshot, so the badge is
  // right on frame one), and asking again here is what makes the page correct after a tab has been
  // open through a workspace switch or a reconnect.
  useEffect(() => {
    sendListWork();
    sendListFleet();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Header />

      {/* THE REFUSAL IS A STRIP RATHER THAN A TOAST, and it stays until the next snapshot clears it.
          Four of this tab's six verbs spend money or stop something, so a refusal that faded after
          three seconds is one somebody presses the button again after. */}
      {error && (
        <div className="mx-6 mb-3 shrink-0 rounded-control border border-hair bg-elevated px-3 py-2 text-caption text-ink">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {!loaded ? (
          <LoadingLine label="Reading what is live…" />
        ) : !anyLive ? (
          <NothingLive />
        ) : (
          <FleetAndWork />
        )}
      </div>
    </div>
  );
}

/**
 * The two regions, once there is a fleet to render.
 *
 * SPLIT OUT SO THE SHELL ABOVE READS AS A SHELL, which is the same separation `ActivityView` and
 * `ActivityDashboard` draw and for the same reason: the shell is a mechanism — mount, refuse,
 * decide which of three states to show — and the composition below is a layout. Keeping them apart
 * is what lets the strip and the list land in commits of their own.
 */
function FleetAndWork() {
  const fleet = useWorkStore((s) => s.fleet);
  const items = useWorkStore((s) => s.items);

  return (
    <>
      <div className="shrink-0 border-b border-hair px-6 py-3">
        <div className="flex gap-3 overflow-x-auto pb-1">
          {fleet.map((card) => (
            <div key={card.deployment_id} className="shrink-0 text-caption text-muted">
              {card.agent_name}
            </div>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
        {items.length === 0 ? (
          // §11.4's second zero state. Live agents, no jobs — an idle fleet rather than an empty
          // workspace, so this is the `line` treatment rather than the full one: there is nothing
          // to set up and nothing has gone wrong.
          <EmptyState size="line" title="Nothing has been asked of them yet" />
        ) : (
          <ul className="flex flex-col">
            {items.map((item) => (
              <li key={item.id} className="border-b border-hair py-2 text-caption text-ink">
                {item.input_preview}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

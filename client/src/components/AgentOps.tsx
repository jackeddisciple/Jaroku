// The three things people still open the Railway dashboard for, surfaced.
//
// PART 1 BUILT ALL THREE AND LEFT THEM WITH NO CALLER, which is what makes this file a screen
// rather than a feature: `DeployOps.health` returns its own staleness, `runtimeLogs` follows the
// sliding window Railway's log query actually is, and `kill` reports what HAPPENED rather than what
// was asked for. Every hard decision in them is already made and argued in `deployOps.ts`; what is
// here is the rendering of three answers.
//
// HEALTH IS NOT A CONTROL. It arrives on the fleet card from the snapshot's cache, so there is no
// "check now" button here — §10 asks for a bounded poll with a stated staleness rather than a
// per-render fetch, and a button beside it would be exactly the per-render fetch with a person's
// finger on it. What the card says is what the agent last said about itself, and when.
//
// LOGS ARE FOLLOWED, NEVER PAGED. The cursor is a TIMESTAMP and goes back exactly as it arrived —
// Railway answers with the most recent N lines of a stream that is still being written, so an
// offset walks backwards through a moving window and shows lines twice or skips them. That bug is
// already in this repository's changelog once, for build logs, and `runtimeLogs` exists in the
// shape it does to stop it happening again.
//
// KILL ASKS TWICE AND SAYS WHAT IT DID. It deletes a service in somebody else's Railway account and
// cannot be undone from here — and the answer distinguishes "the service is gone" from "Jaroku let
// go of it and it may still be running and still costing money", which are different facts about
// somebody's bill.

import { useEffect } from "react";

import { sendLoadAgentLogs } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { FleetCardView } from "../types.ts";
import { Truncate } from "./Truncate.tsx";
import { ChevronRightIcon, GaugeIcon } from "./panelIcons.tsx";

/** How often a following log pane asks for what has arrived since. */
const FOLLOW_MS = 4_000;

/**
 * The container's own log pane, followed.
 *
 * IT ASKS AGAIN WITH THE CURSOR IT WAS GIVEN, which is the whole of the "sliding window" discipline
 * on this side: the server drops anything not strictly newer than that timestamp, so a poll that
 * arrives twice adds nothing and a poll that misses a beat catches up. What must never happen is a
 * page number.
 */
export function LogPane({ card }: { card: FleetCardView }) {
  const logs = useWorkStore((s) => s.logs);
  const mine = logs?.deploymentId === card.deployment_id ? logs : null;

  useEffect(() => {
    sendLoadAgentLogs(card.deployment_id, null);
    const timer = setInterval(() => {
      // READ AT THE MOMENT OF USE rather than captured, so each poll continues from the last line
      // actually shown. A cursor closed over at mount would ask for the same window for ever.
      const current = useWorkStore.getState().logs;
      sendLoadAgentLogs(
        card.deployment_id,
        current?.deploymentId === card.deployment_id ? current.cursor : null,
      );
    }, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [card.deployment_id]);

  return (
    <div className="mt-1 max-h-48 overflow-auto rounded-control border border-hair bg-canvas px-2 py-1.5">
      {!mine ? (
        <span className="text-tiny text-muted">Asking Railway…</span>
      ) : mine.lines.length === 0 ? (
        // A CONTAINER THAT HAS PRINTED NOTHING IS NOT A CONTAINER THAT IS BROKEN, and saying
        // "no logs" flatly would read as the second. Nothing has arrived SINCE, which is the
        // honest reading of a window onto the end of a stream.
        <span className="text-tiny text-muted">Nothing since the pane opened.</span>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {mine.lines.map((line) => (
            <li key={`${line.timestamp}-${line.message}`} className="flex gap-2 text-tiny leading-[1.5]">
              <span className="shrink-0 text-faint tabular-nums">{line.timestamp.slice(11, 19)}</span>
              <Truncate className="min-w-0 text-ink" title={line.message}>
                {line.message}
              </Truncate>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The Agent-detail pointer strip: "3 running, 1 waiting on you", linking into the Cockpit.
 *
 * §3'S OWN INSTRUCTION, in its own words: "Do not put a work list inside Agent detail; a second
 * place a job can be dealt with is the mistake the Inbox already refused. Put a pointer strip there
 * instead — '3 running, 1 waiting on you' — linking into the Cockpit filtered to that agent,
 * exactly as the Inbox did."
 *
 * SO IT RENDERS A COUNT AND A DESTINATION AND NOTHING ELSE, which is the same shape `InboxPointer`
 * and `CockpitPointer` take. Nothing at zero: an agent with no live work gets no strip, no empty
 * state and no reserved space.
 *
 * THE COUNTS COME FROM THE FLEET CARD, which is one quantity computed once on the server and
 * rendered wherever it is needed. A strip that counted the work list in hand would be counting the
 * PAGE — and on an agent whose jobs are on page two it would say nothing at all.
 */
export function AgentWorkPointer({ agentUuid }: { agentUuid: string | null }) {
  const card = useWorkStore((s) => s.fleet.find((c) => c.agent_id === agentUuid));
  const openCockpit = useUiStore((s) => s.openCockpitForAgent);
  const live = (card?.running ?? 0) + (card?.waiting ?? 0) + (card?.queued ?? 0);

  if (!agentUuid || !card || live === 0) return null;

  return (
    <button
      onClick={() => openCockpit(agentUuid)}
      className="flex w-full shrink-0 items-center gap-2 border-b border-hair px-4 py-1.5 text-left text-tiny text-muted transition-colors hover:bg-active/40 hover:text-ink"
      title="Open the Cockpit, filtered to this agent"
    >
      <span className="shrink-0 text-faint" aria-hidden>
        <GaugeIcon size={ICON.xs} />
      </span>
      {/* THE SAME SENTENCE THE FLEET CARD SAYS, from the same numbers — one quantity, rendered
          twice, which is what stops two surfaces disagreeing about how much is in flight. */}
      {card.running > 0 && <span className="text-ink">{card.running} running</span>}
      {card.waiting > 0 && (
        <span className="text-ink">
          {card.running > 0 ? ", " : ""}
          {card.waiting} waiting on you
        </span>
      )}
      {card.queued > 0 && <span>{card.running + card.waiting > 0 ? ", " : ""}{card.queued} queued</span>}
      <span className="ml-auto shrink-0 text-faint" aria-hidden>
        <ChevronRightIcon size={ICON.xs} />
      </span>
    </button>
  );
}

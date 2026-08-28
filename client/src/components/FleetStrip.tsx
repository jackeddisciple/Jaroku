// §9's fleet strip: a glance across what is live, not a dashboard.
//
// COMPACT CARDS THAT SCROLL HORIZONTALLY, which is the shape rather than a grid, and the reason is
// what the region is FOR. A grid grows downwards and pushes the work list — the thing somebody
// actually came to read — off the bottom of the screen the moment a workspace has eight agents. A
// strip is bounded in the direction that matters and overflows in the direction that does not.
//
// ONE CARD PER LIVE DEPLOYMENT AND NOT ONE PER AGENT. The Cockpit is about agents that are already
// live; a card for every draft would turn the glance into a second Agents grid, which §3 spends a
// paragraph saying this must not become.
//
// THE ONE LINE IS `lib/fleetSentence.ts`, a pure module rather than JSX for the reason the
// composer bar's layout is: it is a RULE that looks obviously right in a screenshot and is wrong in
// the case nobody had that day. What this file decides is weight and colour; what that one decides
// is what the sentence says.
//
// RECONNECT WARNS BEFORE IT IS PRESSED, NEVER AFTER. Setting a variable on Railway restarts the
// service: every run in flight in that container dies and its checkpoints die with them, so a run
// somebody paused this morning cannot be resumed afterwards. `DeployOps.reconnect` returns
// `restartsService` precisely so this can say it first — §9's own sentence is "A restart nobody was
// warned about is how a control plane loses trust in one click."

import { useState } from "react";

import { factsOf, fleetSentence, healthLine, needsReconnect } from "../lib/fleetSentence.ts";
import { sendListWork, sendReconnectAgent } from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { FleetCardView } from "../types.ts";
import { AgentOps } from "./AgentOps.tsx";
import { Capable } from "./Capable.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { AlertTriangleIcon, GlobeIcon, PlugIcon } from "./panelIcons.tsx";
import { Truncate } from "./Truncate.tsx";

/**
 * The dot on a card, which carries the CONNECTION rather than the work.
 *
 * TWO FACTS, ONE MARK, AND THE MARK BELONGS TO THE ONE THAT DECIDES WHETHER THE OTHER IS READABLE.
 * A card with three jobs running and a refused credential is not amber-with-a-warning; it is
 * broken, and the three are what it managed before it broke. Amber means RUNNING in this palette
 * and nothing else — v0.2.2's wordmark pass established that and §10 restates it — so a card whose
 * agent is idle wears no colour at all rather than borrowing one.
 */
function ConnectionDot({ card }: { card: FleetCardView }) {
  if (needsReconnect(card.connection)) {
    return <StatusDot state="error" icon={PlugIcon} size={ICON.xs} title={card.connection} />;
  }
  if (card.connection === "public") {
    // A WARNING STATE AND NOT A HEALTHY ONE. Anyone with the URL can spend the workspace's provider
    // key, and a green tick beside that would be the product agreeing with it.
    return <StatusDot state="warn" icon={GlobeIcon} size={ICON.xs} title="served publicly" />;
  }
  if (card.running > 0 || card.waiting > 0) {
    return <StatusDot state="pending" pulse size={ICON.xs} title="working" />;
  }
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" title="idle" />;
}

/**
 * §9's restart warning, in the confirmation rather than in a doc.
 *
 * INLINE ON THE CARD RATHER THAN A MODAL, and that is a judgement about weight. A modal is what the
 * dispatch pre-flight gets, because that one spends money on a decision somebody is making for the
 * first time; this is a repair, pressed by somebody who already knows their agent is broken, and
 * putting a dialog in front of it would make the fix feel more dangerous than the fault. What the
 * two share is that the consequence is stated BEFORE the button that causes it.
 *
 * THE SENTENCE IS THE SAME ONE §17.2 REQUIRES OF ENVIRONMENT VARIABLES, deliberately: "it must be
 * worded identically, because two different sentences for the same consequence teach the user that
 * neither is precise."
 */
export const RESTART_WARNING =
  "This will briefly take the agent offline: setting the token on Railway restarts the service, " +
  "and any run in flight — including a paused one — loses its checkpoint.";

function ReconnectControl({ card }: { card: FleetCardView }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-control border border-hair px-2 py-0.5 text-tiny text-ink transition-colors duration-fast hover:bg-active"
      >
        Reconnect
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="max-w-[26ch] text-tiny leading-[1.4] text-muted">{RESTART_WARNING}</span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            sendReconnectAgent(card.deployment_id);
          }}
          className="rounded-control bg-accent px-2 py-0.5 text-tiny text-bg transition-opacity duration-fast hover:opacity-90"
        >
          Reconnect anyway
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-control px-2 py-0.5 text-tiny text-muted transition-colors duration-fast hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FleetCard({ card }: { card: FleetCardView }) {
  const filters = useWorkStore((s) => s.filters);
  const setFilters = useWorkStore((s) => s.setFilters);
  const line = fleetSentence(factsOf(card));
  const health = healthLine(card);
  const mine = filters.agentId === card.agent_id;

  return (
    <div
      className={`flex w-[248px] shrink-0 flex-col gap-1.5 rounded-card border px-3 py-2.5 transition-colors duration-fast ${
        mine ? "border-accent bg-active/40" : "border-hair bg-elevated hover:bg-active/30"
      }`}
    >
      {/* THE WHOLE HEADER IS THE FILTER CONTROL, because a hit area smaller than the thing it
          describes is a control people miss — the same reason the Inbox pointer strip is one
          button. Clicking it filters the list below to this agent; clicking again clears it, so
          the card is a toggle rather than a one-way trip somebody has to find their way back from. */}
      <button
        type="button"
        onClick={() => {
          setFilters({ agentId: mine ? null : card.agent_id });
          sendListWork();
        }}
        className="flex items-center gap-2 text-left"
        title={mine ? "Show every agent's work" : `Show only ${card.agent_name}'s work`}
      >
        <ConnectionDot card={card} />
        <Truncate className={`min-w-0 ${TYPE.title}`} title={card.agent_name}>
          {card.agent_name}
        </Truncate>
        {/* The deployed version, when the row records one. NULL IS NOT ZERO AND NOT "v1": a
            deployment written before migration 041 has no record of which version it ran, and
            guessing one would be a confident lie about somebody's production. */}
        {card.version !== null && (
          <span className="shrink-0 text-tiny text-faint tabular-nums">v{card.version}</span>
        )}
      </button>

      {/* ONE STRING, NOT WEIGHTED PARTS. It used to be fragments each carrying an emphasis, so
          "1 waiting on you" could be rendered ink against a muted rest — and §5 replaces that
          arrangement with PRECEDENCE: the clause a person can act on is the one that comes first
          and the one that is never trimmed, so its prominence is its POSITION. Which is also what
          §Craft's accent rule wants, since a second weight on a card that already carries a
          connection glyph and a name is a third thing competing to be looked at first. */}
      <div className="text-tiny leading-[1.5] text-muted">{line}</div>

      {/* A PUBLIC URL SAYS SO EVEN WHEN THE AGENT IS WORKING, which is why this sits under the
          sentence rather than replacing it: the state is real and so is the warning. */}
      {card.connection === "public" && (
        <div className="flex items-baseline gap-1 text-tiny text-muted">
          <span className="shrink-0 text-warn" aria-hidden>
            <AlertTriangleIcon size={ICON.badge} />
          </span>
          <span>anyone with the URL can spend this workspace&rsquo;s provider key</span>
        </div>
      )}

      {/* THE PROBE'S ANSWER, WITH ITS AGE. Absent when nobody has asked, which is a third state and
          not "unhealthy" — see `healthLine`. */}
      {health && <span className="text-tiny text-faint">{health}</span>}

      {/* HEALTH, LOGS AND KILL — the three things people still open the Railway dashboard for. Part 1
          built all three and left them with no caller; this is where they surface. */}
      <AgentOps card={card} />

      {needsReconnect(card.connection) && (
        <Capable cmd="reconnectAgent">
          <ReconnectControl card={card} />
        </Capable>
      )}
    </div>
  );
}

export function FleetStrip() {
  const fleet = useWorkStore((s) => s.fleet);
  const notice = useWorkStore((s) => s.notice);

  return (
    <div className="shrink-0 border-b border-hair">
      {/* `overflow-x-auto` ON THE TRACK AND NOT ON THE PAGE. §9's layout law is that wide content
          scrolls inside its own container; a strip that widened the page would put a horizontal
          scrollbar under the work list, which is the one region that must not move sideways. */}
      <div className="flex gap-3 overflow-x-auto px-6 py-3">
        {fleet.map((card) => (
          <FleetCard key={card.deployment_id} card={card} />
        ))}
      </div>
      {/* WHAT A RECONNECT OR A KILL ACTUALLY DID, which is not the same as what was asked for —
          Part 1's commands return the difference and this is where it is read. It stays until
          something replaces it rather than fading, because "the service is restarting" is a
          sentence somebody may want to still be there when they look back. */}
      {notice && (
        <div className="border-t border-hair px-6 py-1.5 text-tiny text-muted">{notice}</div>
      )}
    </div>
  );
}

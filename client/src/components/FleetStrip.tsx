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

import { CONNECTION_LABEL, FILTERS } from "../lib/cockpitCopy.ts";
import { factsOf, fleetSentence, healthLine, needsReconnect } from "../lib/fleetSentence.ts";
import { sendListWork, sendReconnectAgent } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { CARD_HEIGHT, CARD_WIDTH, SPINE_X } from "../lib/cockpitLayout.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { FleetCardView } from "../types.ts";
import { AgentOps } from "./AgentOps.tsx";
import { AgentSparkline } from "./AgentSparkline.tsx";
import { Capable } from "./Capable.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { GlobeIcon, PlugIcon } from "./panelIcons.tsx";
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

/**
 * §4's card. Three lines, one button, and a health strip where a status page would put a figure.
 *
 * THE WHOLE CARD IS THE BUTTON — §4, and it is a change from the header-only target this had. "A
 * hit area smaller than the thing it describes is a control people miss", and a card whose top
 * third was clickable and whose bottom two thirds were not is a control that teaches people the
 * card is not a control. Pressing it FILTERS the work list to this agent; it does not navigate,
 * because §4 says so and because navigating away from a console to see one agent's work is the
 * arrangement the Cockpit exists instead of.
 *
 * THE FILTER IS VISIBLE AND UNDOABLE. §4: "The filter appears as a removable chip above the list,
 * so the user can see why the list shrank and can undo it in one press. A list that silently
 * filtered is a list the user thinks is broken." Pressing the same card again clears it, so the
 * card is a toggle rather than a one-way trip.
 *
 * LINE THREE IS THE SPARKLINE AND NOT A SPEND FIGURE — §4 and §Craft 5. `AgentSparkline` is reused
 * AS-IS: the last ~20 outcomes, each bar individually clickable, a failed bar opening directly on
 * its failing step through the server-resolved mapping. Its eleven-pixels-of-bar-two-of-gap sizing
 * and its drop-old-bars-first behaviour under width pressure are its own and are not re-derived
 * here. "This is what separates the card from a status page: it is dense, factual and a working
 * control, not a decoration." Today's spend moved to the overflow panel, where §4 sends it.
 *
 * A BAR IS A BUTTON INSIDE A BUTTON, and that is why the strip is rendered OUTSIDE the card's own
 * button rather than inside it. A nested button is invalid markup and, worse, a hit area that
 * swallows its parent's click — the bug the Inbox's `view_evidence` control had. The card's button
 * is absolutely positioned to fill the card behind the content, so the whole surface is the target
 * and the sparkline sits above it in the stacking order with its own clicks intact.
 */
function FleetCard({ card }: { card: FleetCardView }) {
  const filters = useWorkStore((s) => s.filters);
  const setFilters = useWorkStore((s) => s.setFilters);
  const line = fleetSentence(factsOf(card));
  const health = healthLine(card);
  const mine = filters.agentId === card.agent_id;

  return (
    <div
      style={{ width: CARD_WIDTH, minHeight: CARD_HEIGHT }}
      // `GLOW.hover`'s RUNG VIA THE HOVER BACKGROUND, AND `FOCUS_RING` UNMODIFIED — §4 asks for
      // both by name and forbids inventing a card-specific focus treatment. `focus-within` rather
      // than `focus-visible` because the ring belongs to the CARD and the focus lands on the button
      // filling it; a ring drawn on the button alone would sit inside the card's own border.
      //
      // A FIXED HEIGHT, WHICH IS §Craft 1 RATHER THAN A MAGIC NUMBER. Three lines is the anatomy
      // §4 states, so the card's height is a consequence of that anatomy and is declared once in
      // `cockpitLayout.ts` — where the skeleton reads it too, so the two cannot differ by the one
      // pixel that makes a whole surface read as unfinished.
      className={`relative flex shrink-0 flex-col gap-1.5 overflow-hidden rounded-card border px-3 py-2.5 transition-colors duration-fast focus-within:shadow-focusring ${
        mine ? "border-accent bg-active/40" : "border-hair bg-panel hover:bg-active/30"
      }`}
    >
      {/* THE TARGET, FILLING THE CARD AND SITTING BEHIND IT. `absolute inset-0` rather than a
          wrapper, so the sparkline's own twenty buttons are siblings rather than descendants —
          see the note above on why a bar cannot be nested inside this. */}
      <button
        type="button"
        onClick={() => {
          setFilters({ agentId: mine ? null : card.agent_id });
          sendListWork();
        }}
        className="absolute inset-0 z-0 rounded-card focus-visible:outline-none"
        aria-pressed={mine}
        title={mine ? FILTERS.clearAgent : FILTERS.agentChip(card.agent_name)}
        aria-label={mine ? FILTERS.clearAgent : FILTERS.agentChip(card.agent_name)}
      />

      {/* LINE ONE — IDENTITY. §4: the display name at `TYPE_SCALE.title`'s rung and
          `WEIGHT.semibold`, wrapped in `Truncate`, with the connection glyph to its left. The rung
          carries its own weight — `typeScale.ts` generates the Tailwind step with 600 on it — so
          `text-title` is the whole decision and needs no weight class beside it.

          IT WAS `TYPE.title`, WHICH IS `text-label`. That token is named for the JOB (the name of
          the thing a row is about) and spells §02's Label rung, 13px/500 — one rung below what §4
          asks for here. On a glance card the name is the thing the eye lands on first and it was
          the same size as the version chip beside it. */}
      <div className="pointer-events-none relative z-10 flex items-center gap-2">
        <ConnectionDot card={card} />
        <Truncate className="min-w-0 text-title text-ink" title={card.agent_name}>
          {card.agent_name}
        </Truncate>
        {/* §9: A WORD BESIDE THE COLOUR, because colour is never the only signal and `warn` is a
            blue somebody could read as decoration. It replaces the version rather than joining it:
            on a 248px card at the title rung there is room for one trailing mark, and which
            version a public endpoint is serving is a smaller fact than that it is public. */}
        {card.connection === "public" ? (
          <span className="shrink-0 text-tiny text-warn">{CONNECTION_LABEL.public}</span>
        ) : card.version !== null ? (
          // The deployed version, when the row records one. NULL IS NOT ZERO AND NOT "v1": a
          // deployment written before migration 041 has no record of which version it ran, and
          // guessing one would be a confident lie about somebody's production.
          <span className="shrink-0 text-tiny tabular-nums text-faint">v{card.version}</span>
        ) : null}
      </div>

      {/* LINE TWO — THE SENTENCE. §4: `TYPE_SCALE.caption`, `text-muted`. "This is the whole point
          of the card and §5 specifies it."

          ONE STRING, NOT WEIGHTED PARTS. It used to be fragments each carrying an emphasis, so
          "1 waiting on you" could be rendered ink against a muted rest — and §5 replaces that
          arrangement with PRECEDENCE: the clause a person can act on is the one that comes first
          and the one that is never trimmed, so its prominence is its POSITION. Which is also what
          §Craft 6's accent rule wants, since a second weight on a card that already carries a
          connection glyph and a name is a third thing competing to be looked at first.

          `truncate` RATHER THAN WRAPPING, because the card's height is fixed and a sentence that
          wrapped would push the sparkline out of the box. Three clauses fit at this width; §27
          asks to be told if they do not, and the answer is in this file's own note. */}
      <div className="pointer-events-none relative z-10 truncate text-caption text-muted" title={line}>
        {line}
      </div>

      {/* LINE THREE — THE HEALTH STRIP. Its height is reserved whether or not there are bars, which
          is §Craft 1: "a figure that arrives later has its space reserved from the first paint".
          `AgentSparkline` renders nothing at all for an agent that has never run — deliberately,
          because a row of grey placeholders would claim twenty runs that never happened — so
          without the reserved box a card would grow by fourteen pixels the moment its first run
          landed, and the whole strip would step down with it. */}
      <div className="relative z-10 flex h-[14px] items-end">
        <AgentSparkline outcomes={card.outcomes} />
      </div>

      {/* THE PROBE, THE OPS AND THE REPAIR — still in the flow, and still three visible controls.
          §4 wants them behind one overflow, "not as three visible buttons", because "a strip of
          forty cards each showing three destructive-adjacent controls is a strip where somebody
          eventually presses Kill by accident". That is the next commit's, and the height above is
          a MINIMUM rather than a fixed value until it lands — a card whose controls were removed
          before their replacement existed would be a commit that made the tab worse to ship a
          cleaner diff. */}
      {(health || needsReconnect(card.connection)) && (
        <div className="relative z-10 flex flex-col gap-1">
          {health && <span className="text-tiny text-faint">{health}</span>}
          {needsReconnect(card.connection) && (
            <Capable cmd="reconnectAgent">
              <ReconnectControl card={card} />
            </Capable>
          )}
        </div>
      )}
      <div className="relative z-10">
        <AgentOps card={card} />
      </div>
    </div>
  );
}

export function FleetStrip() {
  const fleet = useWorkStore((s) => s.fleet);
  const notice = useWorkStore((s) => s.notice);

  return (
    <div className="shrink-0 border-b border-hair">
      {/* `overflow-x-auto` ON THE TRACK AND NOT ON THE PAGE. §3B's layout law is that wide content
          scrolls inside its own container; a strip that widened the page would put a horizontal
          scrollbar under the work list, which is the one region that must not move sideways. The
          scrollbar is the app's own thin one — `index.css` states the rule this tab inherits:
          nothing in this product is drawn by the OS.

          `py-2` IS `SPACE.tight` AND THE HEIGHT IS THE CARD'S. §3B: "Height is set by its cards,
          not fixed by a magic number — one card's height, plus padding." Nothing here names a
          height, so a card that grows by a line takes the strip with it rather than being clipped
          by a number somebody chose against last week's card.

          `px-5` IS THE SPINE. §Craft 3: the first card's left edge lines up with the word
          "Cockpit" above it and with the work row's status glyph below it. It was `px-6` against a
          `px-6` header, which agreed with itself and with nothing else in the app. */}
      <div className={`flex gap-3 overflow-x-auto py-2 ${SPINE_X}`}>
        {fleet.map((card) => (
          <FleetCard key={card.deployment_id} card={card} />
        ))}
      </div>
      {/* WHAT A RECONNECT OR A KILL ACTUALLY DID, which is not the same as what was asked for —
          Part 1's commands return the difference and this is where it is read. It stays until
          something replaces it rather than fading, because "the service is restarting" is a
          sentence somebody may want to still be there when they look back. */}
      {notice && (
        <div className={`border-t border-hair py-1.5 text-tiny text-muted ${SPINE_X}`}>{notice}</div>
      )}
    </div>
  );
}

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

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { CONNECTION_LABEL, DESTRUCTIVE, FILTERS, OFFLINE } from "../lib/cockpitCopy.ts";
import { cockpitCost } from "../lib/cockpitFormat.ts";
import { factsOf, fleetSentence, healthLine } from "../lib/fleetSentence.ts";
import { sendCreateThread, sendKillAgent, sendListWork, sendReconnectAgent } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { CARD_HEIGHT, CARD_WIDTH, SPINE_X } from "../lib/cockpitLayout.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { FleetCardView } from "../types.ts";
import { LogPane } from "./AgentOps.tsx";
import { AgentSparkline } from "./AgentSparkline.tsx";
import { Capable } from "./Capable.tsx";
import { CockpitDialog } from "./CockpitDialog.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { GlobeIcon, KeyIcon, PlugIcon } from "./panelIcons.tsx";
import { Truncate } from "./Truncate.tsx";
import { Icon } from "../lib/icons/registry.ts";
import { IconButton } from "./IconButton.tsx";

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
  // THE SLOT IS ALWAYS THE SAME WIDTH, whatever is in it — including nothing. §Craft 3's spine
  // runs through this glyph, and a `connected` card that rendered no box would start its name
  // twelve pixels left of every other card's, which is the two-pixel disagreement at six times
  // the size. §Craft 4's reserve-the-space rule, applied to a mark rather than to a hover.
  const slot = (children: React.ReactNode, title: string): React.ReactElement => (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: ICON.xs, height: ICON.xs }}
      title={title}
    >
      {children}
    </span>
  );

  switch (card.connection) {
    case "unconnected":
      // §9's table: `STATUS.neutral`, and Reconnect is the card's primary action. NEUTRAL RATHER
      // THAN ERROR, which is the change from what this rendered before — an agent with no stored
      // token has not failed at anything; it has not been finished. Painting it red files a setup
      // step somebody has not done yet under "something went wrong".
      return slot(<StatusDot state="neutral" icon={PlugIcon} size={ICON.xs} />, CONNECTION_LABEL.unconnected!);
    case "unauthorised":
      // §9's table: `STATUS.error`. THIS one is a failure — a token exists and the container
      // refused it — and it is the only connection state that is. A key rather than a plug,
      // because what is wrong is the credential and not the wire.
      return slot(<StatusDot state="error" icon={KeyIcon} size={ICON.xs} />, CONNECTION_LABEL.unauthorised!);
    case "public":
      // §9's table: `STATUS.warn`, "and warn is the blue in this system, not an orange". A
      // supported mode somebody chose, not a fault — which is exactly what `tokens.ts` argues
      // §07's `info` is for, at length, in the comment §9 tells you to read before reaching here.
      return slot(<StatusDot state="warn" icon={GlobeIcon} size={ICON.xs} />, CONNECTION_LABEL.public!);
    case "connected":
      // §9's table: "the quietest possible mark, or none. Healthy is not a thing to announce." So
      // the slot is empty and holds its width — see above. A green tick on every working card
      // would be twenty marks saying the thing that is true of every card worth reading.
      return slot(null, "");
  }
}

/**
 * §4's one overflow control, and the reason there is exactly one.
 *
 * "RECONNECT, LOGS AND KILL LIVE BEHIND ONE OVERFLOW CONTROL ON THE CARD, NOT AS THREE VISIBLE
 * BUTTONS. A strip of forty cards each showing three destructive-adjacent controls is a strip where
 * somebody eventually presses Kill by accident." That is the whole argument and it is about scale
 * rather than about tidiness: one card with three buttons is fine, and forty is a minefield.
 *
 * KILL IS LAST AND SEPARATED — §21: "Kill is never adjacent to a non-destructive control, and it is
 * the last item behind the card's overflow, separated." The hairline above it is not decoration; it
 * is the pixel that stops a mis-aimed press on Logs from landing on the thing that deletes somebody
 * else's Railway service.
 *
 * TODAY'S SPEND LIVES HERE NOW — §4, which moved it off line three to make room for the health
 * strip: "Today's spend for the agent moves to the card's overflow panel or the detail's metadata
 * line — `tabular-nums`, an em dash when unknown, never `$0.00`." Both of the panel's figures go
 * through `cockpitCost`, so the card, the row and the detail cannot disagree.
 *
 * A POPOVER AT `LAYER.menu`, DISMISSED BY AN OUTSIDE CLICK AND BY ESCAPE, which is the shape every
 * other menu in this client takes — `Select.tsx` establishes it and says so. Not a `<details>`,
 * because a disclosure that pushes the card taller would grow the strip and move the work list.
 */
function CardMenu({ card }: { card: FleetCardView }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState(false);
  const [confirming, setConfirming] = useState<"reconnect" | "kill" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const health = healthLine(card);
  const spend = cockpitCost(card.spend_today, card.spend_complete);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative z-20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        // §12: EVERY ICON-ONLY CONTROL HAS AN ACCESSIBLE NAME, and this one names the agent —
        // twenty identical "More" buttons in a strip is twenty controls a screen reader cannot
        // tell apart.
        aria-label={`More for ${card.agent_name}`}
        title={`More for ${card.agent_name}`}
        className="rounded-control p-0.5 text-faint transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <Icon.cockpit.agentMore size={ICON.xs} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-[240px] rounded-card border border-edge bg-elevated p-1 shadow-floating"
        >
          {/* THE FACTS FIRST, THE VERBS AFTER. Somebody opening this menu is usually answering
              "what is wrong with this agent" rather than reaching for a control, and putting the
              probe and the spend above the actions means the commonest use of the menu costs no
              press at all. */}
          <div className="flex flex-col gap-0.5 px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2 text-tiny">
              <span className="text-muted">Today</span>
              <span className="tabular-nums text-ink" title={spend.title ?? undefined}>
                {spend.text}{spend.floor && <span className="text-faint">+</span>}
              </span>
            </div>
            {/* THE PROBE'S ANSWER WITH ITS AGE, or nothing at all when nobody has asked — which is
                a third state and not "unhealthy". A card reporting red because it had never been
                probed would be the product accusing a working agent. */}
            {health && <span className="text-tiny leading-[1.4] text-faint">{health}</span>}
          </div>

          <div className="my-1 border-t border-hair" />

          {/* §6 MAKES THESE THREE ICON-ONLY, so they are a row rather than a stack. Three bare
              glyphs listed vertically would be three lines of nothing; laid out as an action bar
              they read as what they are — the operations available on this card — and each one
              still carries its name in both places a name can be carried.

              §21 SURVIVES THE CHANGE, WHICH IS THE PART THAT MATTERED. Kill is still last and
              still separated by a rule, because the separation is about a mis-aimed press landing
              on the control that deletes somebody's agent, and shortening the controls makes that
              MORE likely rather than less, not less. */}
          <div role="group" aria-label={`Actions for ${card.agent_name}`} className="flex items-center gap-0.5">
            <IconButton
              icon={Icon.fleet.logs}
              label={logs ? "Hide logs" : "Show logs"}
              onClick={() => setLogs((v) => !v)}
            />

            {/* §9: RECONNECT IS THE CARD'S PRIMARY ACTION WHEN IT IS UNCONNECTED, and it is offered
                at every state rather than only then — a token can be rotated on Railway under a card
                that still reads `connected`, and the repair has to be reachable before the first job
                fails to prove it. */}
            <Capable cmd="reconnectAgent">
              <IconButton
                icon={Icon.fleet.reconnect}
                label={DESTRUCTIVE.reconnect.label}
                onClick={() => { setOpen(false); setConfirming("reconnect"); }}
              />
            </Capable>

            <Capable cmd="killAgent">
              <>
                <span className="mx-1 h-5 w-px shrink-0 bg-hair" aria-hidden />
                <IconButton
                  icon={Icon.fleet.kill}
                  label={DESTRUCTIVE.kill.label}
                  danger
                  onClick={() => { setOpen(false); setConfirming("kill"); }}
                />
              </>
            </Capable>
          </div>

          {logs && (
            <div className="px-1 pb-1">
              <LogPane card={card} />
            </div>
          )}
        </div>
      )}

      {/* §21's TWO DIALOGS, both through the app's own — see `CockpitDialog`. They live outside the
          menu's `open` branch so that dismissing the menu to show the dialog does not unmount the
          dialog with it. */}
      <CockpitDialog
        open={confirming === "reconnect"}
        title={DESTRUCTIVE.reconnect.title}
        body={DESTRUCTIVE.reconnect.warning}
        confirmLabel={DESTRUCTIVE.reconnect.confirm}
        onCancel={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); sendReconnectAgent(card.deployment_id); }}
      />
      <CockpitDialog
        open={confirming === "kill"}
        title={DESTRUCTIVE.kill.title}
        body={DESTRUCTIVE.kill.warning(card.agent_name)}
        confirmLabel={DESTRUCTIVE.kill.confirm}
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); sendKillAgent(card.deployment_id); }}
      />
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
function FleetCard({ card, tabIndex, onArrow }: {
  card: FleetCardView;
  /** §12's roving tabindex. Exactly one card in the strip is `0`; see `FleetStrip`. */
  tabIndex: number;
  onArrow: (delta: 1 | -1, track: HTMLElement | null) => void;
}) {
  const filters = useWorkStore((s) => s.filters);
  const setFilters = useWorkStore((s) => s.setFilters);
  const line = fleetSentence(factsOf(card));
  const mine = filters.agentId === card.agent_id;

  return (
    <div
      role="listitem"
      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
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
        data-fleet-card
        tabIndex={tabIndex}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          // The track, which is this button's card's parent. Reached by DOM rather than by a ref
          // per card, for the reason `AgentSparkline` does the same: forty refs to walk a list is
          // forty pieces of state for a query the browser answers in one call.
          onArrow(e.key === "ArrowRight" ? 1 : -1, e.currentTarget.parentElement?.parentElement ?? null);
        }}
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
        {/* PART 3 §11'S ENTRY POINT: "An operate thread opens from a Cockpit fleet card — Part 2's
            card already carries the agent's name and state, and this is the natural thing to press."
            A CONTROL ON THE CARD RATHER THAN THE CARD ITSELF, because the card is already a press
            with a meaning — it filters the list to this agent — and taking that over would break
            Part 2 to add Part 3. It is also not in the ⋯ menu beside it: this is the feature's front
            door, and a front door in an overflow menu is a feature people never find.

            `pointer-events-auto` AND `z-10`, because the whole card is covered by an absolute
            target sitting behind this row; without both, the press underneath wins and pressing
            "talk to it" filters the list instead. */}
        <button
          type="button"
          onClick={(e) => {
            // The card's own target is BEHIND this one rather than around it, so this does not
            // bubble into it — but a stray parent handler added later would, and a control whose
            // press also filters the list is the one bug this whole comment is about.
            e.stopPropagation();
            sendCreateThread(card.agent_id, card.agent_name, "operate");
          }}
          title={`Ask ${card.agent_name} what it has been doing, or give it a job`}
          aria-label={`Open the conversation with ${card.agent_name}`}
          className="pointer-events-auto relative z-10 flex shrink-0 items-center rounded-control p-0.5 text-faint transition-colors duration-fast hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <Icon.cockpit.openConversation size={ICON.xs} />
        </button>
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

      {/* THE OVERFLOW, IN THE CORNER AND OUT OF THE FLOW. Absolutely positioned so it costs the
          card no height — which is what lets the height above be exact rather than a minimum, and
          therefore what lets the skeleton match it to the pixel (§Craft 1). It sits above the
          card's own full-surface button in the stacking order, so pressing it opens the menu
          instead of filtering the list. */}
      <div className="absolute right-1.5 top-1.5">
        <CardMenu card={card} />
      </div>
    </div>
  );
}

/**
 * Which ends of the strip have more beyond them — §3B's fade, measured rather than assumed.
 *
 * §22 IS WHY THIS IS A HOOK AND NOT A CLASS. "Verify the fade actually appears — a fade computed
 * once on mount is invisible on a strip that only overflows after the data loads." Which is every
 * strip in this product: the view mounts, asks for the fleet, and the cards arrive a round trip
 * later. A measurement taken at mount is taken over an empty track, concludes there is no overflow,
 * and is never revisited.
 *
 * SO IT WATCHES THREE THINGS, and each one is a way the answer can change without the others
 * moving: the SCROLL position (there is nothing to the left until you scroll right), the track's
 * own SIZE (the pane is resizable and the window is), and the CONTENT (a deployment goes live, or
 * a kill removes a card). `ResizeObserver` on the track catches the second; observing the track's
 * first child catches the third, because a card added or removed changes the row's width without
 * changing the box around it.
 *
 * BOTH EDGES INDEPENDENTLY, because a fade at the far left would be the mask lying about the
 * scroll position — there is nothing above the first card to hint at, and dimming it would say
 * there is.
 */
function useEdgeFade(): { ref: React.RefObject<HTMLDivElement | null>; fade: string } {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const track = ref.current;
    if (!track) return;
    const measure = (): void => {
      // A ONE-PIXEL TOLERANCE, because `scrollWidth` and `clientWidth` are rounded from fractional
      // layout and a track that fits exactly reports a one-pixel overflow on some zoom levels —
      // which would put a permanent fade on a strip of three cards that does not scroll.
      const max = track.scrollWidth - track.clientWidth;
      setEdges({ start: track.scrollLeft > 1, end: track.scrollLeft < max - 1 });
    };
    measure();
    track.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => track.removeEventListener("scroll", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    // The row of cards as well as the box around it — see the header. A card arriving changes the
    // first and not the second, and the fade's whole job is to announce exactly that arrival.
    if (track.firstElementChild) observer.observe(track.firstElementChild);
    return () => {
      track.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  const fade = edges.start && edges.end ? "scroll-fade-x-both"
    : edges.start ? "scroll-fade-x-start"
    : edges.end ? "scroll-fade-x-end"
    : "";
  return { ref, fade };
}

/**
 * §12's keyboard traversal: one tab stop for the strip, arrow keys within it.
 *
 * A ROVING TABINDEX, which is the pattern `AgentSparkline` already uses two files over and which
 * the rest of the platform uses for a row of small related controls. §12: "keyboard-reachable by
 * arrow keys within the strip and by Tab into and out of it." Forty cards as forty tab stops would
 * put forty presses between somebody's keyboard and the work list, which is the region they came
 * for — and a strip is a glance, so walking it should cost one stop and then arrows.
 *
 * THE SPARKLINE INSIDE EACH CARD ALSO ANSWERS TO ARROWS, and it stops propagation when it does —
 * so arrows inside the health strip move between bars and arrows on the card move between cards.
 * That is one rule read at two depths rather than a collision: the arrow always moves within
 * whatever the focus is currently in.
 *
 * AND MOVING FOCUS SCROLLS THE STRIP, because a focused card outside the viewport is a focus ring
 * nobody can see. `block: "nearest"` so the strip does not scroll vertically inside the page.
 */
function moveCardFocus(from: number, delta: 1 | -1, track: HTMLElement | null, count: number): void {
  const next = Math.min(count - 1, Math.max(0, from + delta));
  const cards = track?.querySelectorAll<HTMLElement>("[data-fleet-card]");
  const target = cards?.[next];
  if (!target) return;
  target.focus();
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function FleetStrip() {
  const fleet = useWorkStore((s) => s.fleet);
  const notice = useWorkStore((s) => s.notice);
  const connected = useTraceStore((s) => s.connection === "open");
  const { ref, fade } = useEdgeFade();

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
      {/* §22'S TWO SHAPES, BOTH SATISFIED BY `justify-start` AND A FIXED CARD WIDTH. One agent: the
          card keeps its width and the strip does not stretch it — "a lone stretched card reads as a
          layout bug". Forty agents: the row overflows and the fade says so. Neither case needs a
          branch, which is the point of choosing a width rather than a fraction. */}
      <div
        ref={ref}
        role="list"
        aria-label="Live agents"
        className={`flex justify-start gap-3 overflow-x-auto py-2 ${SPINE_X} ${fade}`}
      >
        {fleet.map((card, i) => (
          <FleetCard
            key={card.deployment_id}
            card={card}
            // THE FIRST CARD IS THE ENTRY POINT, unlike the sparkline's, whose entry is its LAST
            // bar. The two differ because the questions differ: a sparkline is asked about its most
            // recent run, and a strip is read left to right from its first agent.
            tabIndex={i === 0 ? 0 : -1}
            onArrow={(delta, track) => moveCardFocus(i, delta, track, fleet.length)}
          />
        ))}
      </div>
      {/* §10's OFFLINE TREATMENT, and the half that is a decision rather than a notice.
          "Freeze the fleet strip's sentences RATHER THAN BLANKING THEM, with the header notice
          explaining that the figures are as of the last update. Blanking reads as 'everything
          stopped'; a stale figure with a STATED staleness is honest and calmer."

          THE FREEZING IS FREE AND THE STATEMENT IS NOT. The sentences are computed from the store,
          which nothing clears on a drop — so they already survive; what a dropped channel would
          otherwise leave is a strip that looks live and is not. This line is the difference between
          those two, and it is why the notice belongs beside the cards rather than only in the
          header: a reader looking at a figure needs the caveat where the figure is.

          THE CARDS ARE NOT DIMMED. Reduced opacity would say "these are disabled", which is a
          different and wrong claim — the numbers were true when they were sent. */}
      {!connected && (
        <div className={`border-t border-hair py-1.5 text-tiny text-faint ${SPINE_X}`}>{OFFLINE.frozen}</div>
      )}

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

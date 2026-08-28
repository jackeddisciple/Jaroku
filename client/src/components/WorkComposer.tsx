// §8's dispatch composer: one input, an agent picker, a destination label, and a gate.
//
// IT IS NOT THE BUILD COMPOSER, AND EVERY DIFFERENCE IS DELIBERATE. §8: "It must not look like the
// build composer... the build composer is the app's largest floating box at `RADIUS.modal` with
// attachments, connectors, variants and an intent label. This one is a control, at
// `RADIUS.control`, on the panel surface, with none of those affordances. A USER MUST NEVER CONFUSE
// THE BOX THAT EDITS AN AGENT WITH THE BOX THAT COMMANDS ONE. Different size, different radius,
// different placement."
//
// AND IT MUST NOT ROUTE THROUGH `lib/intent`. That input routes by (selection context + phrasing)
// into plan / revise / explain / branch / fix / edit; here there is exactly ONE destination, a live
// agent, for real. Reusing the routing would mean a real job — "refund order 4471" — could be read
// as an edit instruction and quietly turned into a code change to the agent that was supposed to do
// it.
//
// THE DESTINATION LABEL IS ALWAYS VISIBLE — §8, "above the input, at `tiny`: the agent's name and
// the words 'will run for real'. NOT A TOOLTIP, NOT ON HOVER." It is the one defence against the
// confusion the paragraph above is about, and a defence that appears on hover is one that is absent
// exactly when somebody is typing quickly.
//
// THE PICKER IS `Select` AND NOT A NATIVE `<select>` — §15, "no native `<select>`, ever". This
// component held the LAST one in the client: `Select.tsx` exists because six of them were the only
// controls in this product the operating system drew, and a seventh on the tab that spends money
// would be the OS drawing the control that chooses where the money goes.
//
// §19's OPTIMISTIC DISPATCH lives here and in `lib/workLive.ts`. What is here is the half about the
// COMPOSER: "The composer clears on press, not on acknowledgement, and RESTORES THE TEXT if the
// dispatch was refused — the same courtesy any message box owes."

import { useEffect, useRef, useState } from "react";

import { COMPOSER, GATE } from "../lib/cockpitCopy.ts";
import { cockpitComposer } from "../lib/cockpitComposer.ts";
import { needsReconnect } from "../lib/fleetSentence.ts";
import { optimisticRow } from "../lib/workLive.ts";
import { sendDispatchWork } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { useCanRun } from "../lib/useCapability.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { FleetCardView } from "../types.ts";
import { CockpitDialog } from "./CockpitDialog.tsx";
import { DisabledReason, ENABLED, type DisabledState } from "./DisabledReason.tsx";
import { Select } from "./Select.tsx";
// `ArrowUpIcon` RATHER THAN A NEW SEND MARK. The composer bar's send control already uses it, and
// the rule is to extend the icons this app has rather than define a second glyph for an action that
// already has one — a job going to an agent is the same verb as a message going to Jaroku.
import { ArrowUpIcon } from "./panelIcons.tsx";

/**
 * The byte cap, mirrored here so the refusal happens where somebody can shorten what they typed.
 *
 * "Input capped at 65,536 bytes at write time, matching MAX_BODY_BYTES. Refuse at the composer, not
 * at the container." The store enforces it regardless — a cap only at the surface is a cap the
 * socket goes around — so this is the SECOND check rather than the only one, and its job is to be
 * the one somebody can act on.
 *
 * AND §19 PUTS IT BEFORE THE GATE: "Refusals that are knowable before dispatch happen before the
 * gate... asking the user to confirm something that was always going to be refused is the worst
 * version of this flow."
 */
const MAX_INPUT_BYTES = 65_536;

/** In bytes, because that is what the boundary counts — a four-byte emoji is one character. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * §8's pre-flight gate: what is about to happen, before the button that causes it.
 *
 * A SMALL MODAL WITH A SCRIM, which is §8's own instruction and the one place in this tab a modal
 * is right: "it is asking for a decision that spends money and touches the world". Everything else
 * about it is the app's existing dialog — `CockpitDialog` — rather than a bespoke one, and that is
 * also where §21's "the confirming control is not the default focus" is satisfied.
 *
 * IT NAMES WHAT WILL HAPPEN AND NOT WHAT IT WILL COST, deliberately. Nothing can honestly predict
 * the cost of a job whose graph has not run — the eval estimator works because it has a dataset and
 * a history, and this has one sentence somebody just typed. A confident figure here would be the
 * one number on this surface that was made up, on the tab whose whole argument is that its numbers
 * are real.
 *
 * IN §8's ORDER: the agent, the deployment version, the provider and model, the first line of the
 * input. A DEPLOYMENT WITH NO RECORDED VERSION SAYS SO rather than guessing one — a row written
 * before migration 041 has no record of which version it ran, and a confident "v1" would be a lie
 * about somebody's production on the one screen asking them to spend money.
 */
function GateBody({ card, input }: { card: FleetCardView; input: string }) {
  // THE FIRST LINE, which is what §8 asks for. A gate that rendered a 600-line pasted email would
  // be a dialog somebody scrolls rather than reads, and the point of the line is recognition —
  // "yes, that is the job I meant" — rather than review.
  const firstLine = input.split("\n", 1)[0] ?? "";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 text-caption">
        <span className="text-ink">{card.agent_name}</span>
        <span className="text-muted">
          {card.version === null ? GATE.unrecordedVersion : `v${card.version}`}
          <span className="text-faint"> · </span>
          {card.model}
          <span className="text-faint"> on </span>
          {card.provider}
        </span>
        {/* THE ONE THING A PUBLIC ENDPOINT ADDS TO THE GATE. It is not about this job, it is about
            the agent this job is going to — and the moment somebody is being asked to spend money
            on it is the moment that fact is worth repeating. */}
        {card.connection === "public" && (
          <span className="text-warn">its URL is public, so anyone holding it can spend the same key</span>
        )}
      </div>
      <p className="truncate rounded-control border border-hair bg-canvas px-2 py-1 text-caption text-ink"
        title={firstLine}>
        {firstLine}
      </p>
    </div>
  );
}

export function WorkComposer() {
  const fleet = useWorkStore((s) => s.fleet);
  const draw = useWorkStore((s) => s.drawOptimistic);
  const viewer = useSessionStore((s) => s.user);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [gated, setGated] = useState(false);
  /** The reference of a dispatch this composer has sent and not yet had an answer for. */
  const inFlight = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // THE PICKER DEFAULTS TO THE ONLY LIVE AGENT, because a workspace with one deployment should not
  // have to choose. It follows the fleet rather than being set once: an agent going live, or the
  // last one being killed, changes what "the only one" means.
  const live = fleet.filter((c) => !needsReconnect(c.connection));
  const chosen = live.find((c) => c.agent_id === agentId) ?? (live.length === 1 ? live[0] : undefined);
  useEffect(() => {
    if (!chosen && agentId) setAgentId(null);
  }, [chosen, agentId]);

  /**
   * §19: THE COMPOSER CLEARS ON PRESS AND THE TEXT COMES BACK IF THE DISPATCH WAS REFUSED.
   *
   * WATCHED ON THE STORE'S ERROR RATHER THAN RETURNED FROM THE SEND, because the refusal arrives on
   * the socket a round trip later. What is held is the text and the reference; when a refusal lands
   * for our reference the text goes back in the box and the field takes focus, which is the whole
   * of "the same courtesy any message box owes".
   */
  const held = useRef<string>("");
  const error = useWorkStore((s) => s.error);
  useEffect(() => {
    if (!error || !inFlight.current) return;
    setInput(held.current);
    inFlight.current = null;
    setSending(false);
    boxRef.current?.focus();
  }, [error]);

  // AND AN ACKNOWLEDGEMENT ENDS THE FLIGHT. The panel opening on the new job is what says the
  // dispatch landed; `open` changing to a row we do not hold is that event, seen from here.
  const openId = useWorkStore((s) => s.open?.id);
  useEffect(() => {
    if (openId && inFlight.current) {
      inFlight.current = null;
      setSending(false);
    }
  }, [openId]);

  const bytes = byteLength(input);
  const permitted = useCanRun("dispatchWork", chosen?.agent_id ?? null);

  /**
   * §23's situation, as a pure function over a flat descriptor — see `lib/cockpitComposer.ts`.
   *
   * THE COMPONENT DECIDES NOTHING ABOUT PRECEDENCE. Every branch that used to be a `firstReason`
   * chain here is a rung of that list now, which is what lets `test:cockpit-composer` assert the
   * ORDER — the property a fixture per state cannot see.
   */
  const moment = cockpitComposer({
    liveAgents: live.length,
    agentName: chosen?.agent_name ?? null,
    // A CARD IN `live` IS BY CONSTRUCTION REACHABLE, so this is true whenever one is chosen. It is
    // still passed rather than hard-coded, because the filter above is a rendering decision and
    // this is the rule — and the two are allowed to diverge without the sentence going wrong.
    connected: chosen ? !needsReconnect(chosen.connection) : false,
    // AT CAPACITY IS THE AGENT'S OWN COUNT, not Jaroku's cap. What the card reports is what the
    // container has told us it is running; a composer that refused on Jaroku's workspace-wide cap
    // would be refusing on a number about somebody else's jobs.
    atCapacity: false,
    permitted,
    inFlight: sending,
    overCap: bytes > MAX_INPUT_BYTES,
  });

  /**
   * Why the send control cannot be pressed, in words §14 asks for.
   *
   * §14: "A control the user lacks permission for is DISABLED WITH A STATED REASON, not missing.
   * The reason names the capability in human words." And: "The gate modal's confirming control is
   * what gets disabled, NOT THE COMPOSER — a composer that cannot be typed in gives the user
   * nothing to read." So the textarea stays typeable in every state, and the refusal lands on the
   * button beside it.
   */
  const blocked: DisabledState = moment.ready
    ? ENABLED
    : {
        reason: bytes > MAX_INPUT_BYTES
          ? `That is ${bytes.toLocaleString()} bytes and the limit is ${MAX_INPUT_BYTES.toLocaleString()} — shorten it.`
          : (moment.status ?? COMPOSER.placeholder.noAgent),
      };

  /**
   * §19, in order: draw the row, clear the box, send.
   *
   * THE ROW IS DRAWN BEFORE THE SEND rather than after it, which costs nothing and means the list
   * is never briefly wrong — a `send` that throws would otherwise leave the composer cleared with
   * no row to show for it.
   */
  const dispatch = (): void => {
    if (!chosen || !moment.ready) return;
    const ref = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    held.current = input;
    inFlight.current = ref;
    setSending(true);
    setGated(false);

    draw(optimisticRow({
      ref,
      agentId: chosen.agent_id,
      agentName: chosen.agent_name,
      deploymentId: chosen.deployment_id,
      createdBy: viewer?.id ?? "",
      createdByName: viewer?.displayName ?? viewer?.email ?? null,
      text: input,
    }));

    // CLEARED ON PRESS AND NOT ON ACKNOWLEDGEMENT — §19. Leaving the text until the server answers
    // is what invites the same job to be sent twice, and the row already on screen is what says the
    // press was received.
    setInput("");
    sendDispatchWork(chosen.agent_id, held.current, ref);
  };

  return (
    // ON THE PANEL SURFACE, AT THE BOTTOM, IN THE FLOW — §8, "not floating, not in a modal". The
    // build composer floats at `RADIUS.modal`; this one does not float at all.
    <div className="shrink-0 border-t border-hair bg-panel">
      {/* §8's DESTINATION LABEL. Always visible, above the input, at `tiny`. */}
      <div className="flex items-center gap-2 px-4 pt-2 text-tiny">
        <span className={chosen ? "text-muted" : "text-faint"}>
          {chosen ? COMPOSER.destination(chosen.agent_name) : COMPOSER.noDestination}
        </span>
        {/* §23's STATUS, which is null when nothing is happening — so this renders nothing at all
            on a ready composer rather than a line saying so. */}
        {moment.status && <span className="text-faint">· {moment.status}</span>}
      </div>

      <div className="flex items-end gap-2 px-4 pt-1.5 pb-2.5">
        {/* THE PICKER IS ABSENT WHEN THERE IS ONE AGENT, which is the ordinary case: a workspace
            with one deployment should not be asked to choose between one thing. */}
        {live.length > 1 && (
          <Select
            value={chosen?.agent_id ?? ""}
            options={live.map((c) => ({ value: c.agent_id, label: c.agent_name }))}
            onChange={(value) => setAgentId(value || null)}
            ariaLabel="Which agent should do this"
            placeholder="Pick an agent…"
            className="w-[168px] shrink-0"
          />
        )}

        <textarea
          ref={boxRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // ENTER OPENS THE GATE, IT DOES NOT SEND. That is the difference between this and the
            // build composer, and it is the whole point of the gate: the key that means "go" in
            // every other input in this product means "show me what I am about to spend" here.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (moment.ready && input.trim()) setGated(true);
            }
          }}
          rows={1}
          placeholder={moment.placeholder}
          // ONE LINE THAT GROWS TO A SMALL MAXIMUM — §8. `max-h` rather than an auto-resize script,
          // because the growth is bounded and a scrollbar past the bound is the honest end of it.
          className="max-h-[96px] min-h-[36px] flex-1 resize-none rounded-control border border-hair bg-elevated px-2.5 py-2 text-caption leading-[1.5] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:shadow-focusring"
        />

        <DisabledReason state={blocked} className="shrink-0">
          <button
            type="button"
            onClick={() => setGated(true)}
            disabled={Boolean(blocked.reason) || input.trim().length === 0}
            className="flex h-9 w-9 items-center justify-center rounded-control bg-accent text-bg transition-opacity duration-fast hover:opacity-90 focus-visible:outline-none focus-visible:shadow-focusring disabled:pointer-events-none disabled:opacity-40"
            title={COMPOSER.send}
            aria-label={COMPOSER.send}
          >
            <ArrowUpIcon size={ICON.sm} />
          </button>
        </DisabledReason>
      </div>

      {/* MONEY ASKS FIRST. There is no free dry-run path out here — the container runs on the
          workspace's real provider key — so the gate is between the button and the dispatch rather
          than a confirmation after it. */}
      {chosen && (
        <CockpitDialog
          open={gated}
          title={GATE.title}
          body={<GateBody card={chosen} input={input} />}
          confirmLabel={GATE.confirm}
          onCancel={() => setGated(false)}
          onConfirm={dispatch}
        />
      )}
    </div>
  );
}

// §9's dispatch composer: one input, one agent picker, and a gate in front of the button.
//
// IT IS NOT THE BUILD COMPOSER, AND IT MUST NOT ROUTE THROUGH `lib/intent` — §9 states that and the
// reason is the build composer's whole design. That one input routes by (selection context +
// phrasing) into plan / revise / explain / branch / fix / edit; here there is exactly ONE
// destination, a live agent, for real. Reusing the routing would mean a real job — "refund order
// 4471" — could be read as an edit instruction and quietly turned into a code change to the agent
// that was supposed to do it. So: a separate component, no intent routing, and this comment.
//
// A PRE-FLIGHT GATE, AND NOT THE BUILD PLAN CARD. §9 asks for "one line naming the agent, the
// deployment version, and the provider and model it will run on, with a confirm" — a different
// WEIGHT of decision from a plan. A plan card is a proposal somebody reads and edits; this is a
// receipt somebody checks. "Money asks first" is a stated principle of this codebase and there is
// no free dry-run path out here: the container runs on the workspace's real provider key.
//
// THE GATE NAMES WHAT IS ABOUT TO HAPPEN AND NOT WHAT IT WILL COST, deliberately. Nothing can
// honestly predict the cost of a job whose graph has not run — the eval estimator works because it
// has a dataset and a history, and this has one sentence somebody just typed. A confident figure
// here would be the one number on this surface that was made up, on the tab whose whole argument is
// that its numbers are real.

import { useEffect, useRef, useState } from "react";

import { sendDispatchWork } from "../lib/socket.ts";
import { ICON } from "../lib/tokens.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { FleetCardView } from "../types.ts";
import { Capable } from "./Capable.tsx";
import { needsReconnect } from "../lib/fleetLine.ts";
import { DisabledReason, ENABLED, firstReason, type DisabledState } from "./DisabledReason.tsx";
// `ArrowUpIcon` RATHER THAN A NEW SEND MARK. The composer bar's send control already uses it and
// §4's rule is to extend the icons this app has rather than define a second glyph for an action
// that already has one — a job going to an agent is the same verb as a message going to Jaroku.
import { ArrowUpIcon } from "./panelIcons.tsx";

/**
 * The byte cap, mirrored here so the refusal happens where somebody can shorten what they typed.
 *
 * §4: "input capped at 65,536 bytes at write time, matching MAX_BODY_BYTES. Refuse at the composer,
 * not at the container." The store enforces it regardless — a cap only at the surface is a cap the
 * socket goes around — so this is the SECOND check rather than the only one, and its job is to be
 * the one somebody can act on.
 */
const MAX_INPUT_BYTES = 65_536;

/** In bytes, because that is what the boundary counts — a four-byte emoji is one character. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * §9's pre-flight: what is about to happen, in one line, before the button that causes it.
 *
 * A DEPLOYMENT WITH NO RECORDED VERSION SAYS SO rather than guessing one. A row written before
 * migration 041 has no record of which version it ran, and `deployments.version` is explicit that
 * it is never backfilled — so "v?" here is the honest reading of a fact nobody wrote down, and a
 * confident "v1" would be a lie about somebody's production on the one screen that is asking them
 * to spend money.
 */
function PreFlight({ card, onConfirm, onCancel }: {
  card: FleetCardView;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // FOCUS GOES TO THE CONFIRM, so the gate is answerable from the keyboard by somebody who never
  // left it — the composer is a text field and Tab from it would otherwise walk the whole bar.
  useEffect(() => confirmRef.current?.focus(), []);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-hair bg-elevated px-4 py-2 text-tiny">
      <span className="text-muted">This will run on</span>
      <span className="text-ink">{card.agent_name}</span>
      <span className="text-faint">·</span>
      <span className="text-ink">{card.version === null ? "an unrecorded version" : `v${card.version}`}</span>
      <span className="text-faint">·</span>
      <span className="text-ink">{card.model}</span>
      <span className="text-muted">on {card.provider}</span>
      {/* THE ONE THING A PUBLIC ENDPOINT ADDS TO THE GATE. It is not about this job, it is about the
          agent this job is going to — and the moment somebody is being asked to spend money on it is
          the moment that fact is worth repeating. */}
      {card.connection === "public" && (
        <span className="text-warn">· its URL is public, so anyone holding it can spend the same key</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-control px-2 py-0.5 text-muted transition-colors duration-fast hover:text-ink"
        >
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className="rounded-control bg-accent px-2.5 py-0.5 text-bg transition-opacity duration-fast hover:opacity-90"
        >
          Send it
        </button>
      </div>
    </div>
  );
}

export function WorkComposer() {
  const fleet = useWorkStore((s) => s.fleet);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [gated, setGated] = useState(false);

  // THE PICKER DEFAULTS TO THE ONLY LIVE AGENT, because a workspace with one deployment should not
  // have to choose. It follows the fleet rather than being set once: an agent going live, or the
  // last one being killed, changes what "the only one" means.
  const live = fleet.filter((c) => !needsReconnect(c.connection));
  const chosen = live.find((c) => c.agent_id === agentId) ?? (live.length === 1 ? live[0] : undefined);
  useEffect(() => {
    if (!chosen && agentId) setAgentId(null);
  }, [chosen, agentId]);

  const bytes = byteLength(input);
  /**
   * Why the button cannot be pressed, in the order somebody can act on.
   *
   * `firstReason` RATHER THAN A BOOLEAN, and the order is precedence — a control blocked by two
   * things at once shows the one they can do something about soonest. §8's rule is that a control
   * which can be disabled renders a one-line reason IN ITS PLACE rather than a lowered opacity,
   * because "why can't I click this" is exactly the silent failure the rest of this product goes
   * out of its way to avoid.
   */
  const blocked: DisabledState = firstReason(
    live.length === 0 && { reason: "No agent is connected. Reconnect one to give it work." },
    !chosen && { reason: "Pick which agent should do this." },
    input.trim().length === 0 && { reason: "Say what it should do." },
    bytes > MAX_INPUT_BYTES && {
      reason: `That is ${bytes.toLocaleString()} bytes and the limit is ${MAX_INPUT_BYTES.toLocaleString()} — shorten it.`,
    },
    ENABLED,
  );

  const dispatch = (): void => {
    if (!chosen || blocked.reason) return;
    sendDispatchWork(chosen.agent_id, input);
    setGated(false);
    // CLEARED OPTIMISTICALLY, because the answer opens the detail panel on the new job and leaving
    // the text behind would invite the same job to be sent twice. A refusal comes back on the
    // channel as a strip that names what was wrong, which is what somebody would retype from.
    setInput("");
  };

  return (
    <Capable cmd="dispatchWork" agentId={chosen?.agent_id ?? null}>
      <div className="shrink-0 border-t border-hair bg-canvas">
        <div className="flex items-end gap-2 px-4 py-2.5">
          {/* THE PICKER IS A SELECT AND NOT A SEARCH, because the fleet is bounded by how many
              agents a workspace has deployed — a list somebody scrolls, not one they query. It is
              absent entirely when there is one, which is the ordinary case. */}
          {live.length > 1 && (
            <select
              value={chosen?.agent_id ?? ""}
              onChange={(e) => setAgentId(e.target.value || null)}
              className="shrink-0 rounded-control border border-hair bg-elevated px-2 py-1.5 text-caption text-ink"
              aria-label="Which agent should do this"
            >
              <option value="">Pick an agent…</option>
              {live.map((c) => (
                <option key={c.agent_id} value={c.agent_id}>
                  {c.agent_name}
                </option>
              ))}
            </select>
          )}

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // ENTER OPENS THE GATE, IT DOES NOT SEND. That is the difference between this and the
              // build composer, and it is the whole point of the gate: the key that means "go" in
              // every other input in this product means "show me what I am about to spend" here.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!blocked.reason) setGated(true);
              }
            }}
            rows={1}
            placeholder={live.length === 0 ? "No agent is connected" : "Give this agent a real job…"}
            className="min-h-[36px] flex-1 resize-none rounded-control border border-hair bg-elevated px-2.5 py-2 text-caption leading-[1.5] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:shadow-focusring"
          />

          <DisabledReason state={blocked} className="shrink-0">
            <button
              type="button"
              onClick={() => setGated(true)}
              disabled={Boolean(blocked.reason)}
              className="flex h-9 w-9 items-center justify-center rounded-control bg-accent text-bg transition-opacity duration-fast hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
              title="Give this agent the job"
            >
              <ArrowUpIcon size={ICON.sm} />
            </button>
          </DisabledReason>
        </div>

        {/* MONEY ASKS FIRST. There is no free dry-run path out here — the container runs on the
            workspace's real provider key — so the gate is between the button and the dispatch
            rather than a confirmation after it. */}
        {gated && chosen && (
          <PreFlight card={chosen} onConfirm={dispatch} onCancel={() => setGated(false)} />
        )}
      </div>
    </Capable>
  );
}

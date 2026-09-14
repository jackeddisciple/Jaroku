// The subscription turns the server has prepared and a desktop app is answering.
//
// A CHAT TURN ON THE USER'S OWN PLAN RUNS ON THEIR MACHINE, and the server still owns everything
// around it: the thread it belongs to, the message it answers, the variant row its answer settles
// into, the one-answer-at-a-time rule for the conversation, and telling every other tab how it
// ended. So the server opens the turn, hands the requesting app a run, and waits for that same app
// to say how it went — and this is where it waits.
//
// KEYED BY A RUN ID THE SERVER MINTS, never by anything the client names. A settle has to come from
// the socket the run was handed to, in the workspace it was opened in, so a client cannot settle —
// or erase — a turn another tab or another workspace is answering.
//
// BOUNDED IN TIME. An app that closes mid-answer never settles, and a conversation must not stay
// "still answering" for ever because of it; see `SUBSCRIPTION_TURN_TIMEOUT_MS`.
//
//   npm run test:subscription-turns

import { randomUUID } from "node:crypto";

/** Who a prepared turn belongs to: the workspace, the socket that asked, and the conversation. */
export interface TurnOwner {
  workspaceId: string;
  requestId: string;
  threadId: string;
}

/** A turn as the registry holds it: whatever the caller stored, plus the id it was handed out under. */
export type OpenTurn<T extends TurnOwner> = T & { runId: string };

/**
 * How long an app may take to say how a turn ended.
 *
 * LONGER THAN ANY ANSWER, SHORTER THAN A LOCKED CONVERSATION IS BEARABLE. Codex at `xhigh` has taken
 * more than three minutes over one line; twenty is room for that several times over, and an app that
 * has said nothing by then is not going to.
 */
export const SUBSCRIPTION_TURN_TIMEOUT_MS = 20 * 60_000;

type Timer = { cancel: () => void };
type Schedule = (fn: () => void, ms: number) => Timer;

const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  // A process shutting down is not held open by an answer nobody is waiting for.
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export class SubscriptionTurns<T extends TurnOwner> {
  private turns = new Map<string, { turn: OpenTurn<T>; timer: Timer }>();

  constructor(
    /** What happens to a turn nobody settled in time. It has already left the registry. */
    private onTimeout: (turn: OpenTurn<T>) => void,
    private timeoutMs = SUBSCRIPTION_TURN_TIMEOUT_MS,
    private schedule: Schedule = realSchedule,
  ) {}

  /** Hold a turn until its app settles it, and hand back the id it is known by. */
  open(fields: T): OpenTurn<T> {
    const turn: OpenTurn<T> = { ...fields, runId: randomUUID() };
    const timer = this.schedule(() => {
      if (this.turns.get(turn.runId)?.turn !== turn) return;
      this.turns.delete(turn.runId);
      this.onTimeout(turn);
    }, this.timeoutMs);
    this.turns.set(turn.runId, { turn, timer });
    return turn;
  }

  /**
   * The turn with this id, taken out of the registry — but only by the socket it was handed to.
   *
   * ANYBODY ELSE GETS NOTHING AND CHANGES NOTHING. A wrong workspace or a different socket leaves the
   * turn exactly where it was, still waiting for the app that is actually answering it.
   */
  take(runId: string, by: { workspaceId: string; requestId: string }): OpenTurn<T> | null {
    const held = this.turns.get(runId);
    if (!held) return null;
    if (held.turn.workspaceId !== by.workspaceId || held.turn.requestId !== by.requestId) return null;
    this.turns.delete(runId);
    held.timer.cancel();
    return held.turn;
  }

  /** The turn answering in this conversation, if one is. The chat route allows one per thread. */
  inThread(workspaceId: string, threadId: string): OpenTurn<T> | null {
    for (const { turn } of this.turns.values()) {
      if (turn.workspaceId === workspaceId && turn.threadId === threadId) return turn;
    }
    return null;
  }

  /** Remove a turn without its app, because it is being given up on. Null when it was already gone. */
  drop(runId: string): OpenTurn<T> | null {
    const held = this.turns.get(runId);
    if (!held) return null;
    this.turns.delete(runId);
    held.timer.cancel();
    return held.turn;
  }

  get size(): number {
    return this.turns.size;
  }
}

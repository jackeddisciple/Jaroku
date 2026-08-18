// The Agents tab's own store — the grid, the open detail, and the version the browser is showing.
//
// SEPARATE FROM `buildStore`, WHICH ALREADY HOLDS AN AGENT LIST, and the separation is by invariant
// rather than by convenience — this codebase's stated rule for stores. `buildStore.agents` is the
// SIDEBAR's list: the shape every surface has selected an agent from since v0.0.3, keyed by slug,
// with the one invariant that the selected agent is one of its members. This holds a different thing:
// a derived, tag-bearing card whose fields are recomputed on the server on every state transition. A
// store that held both would have to keep them in step, and the two are refreshed by different
// broadcasts — so the day they disagreed, the sidebar and the grid would name the same agent
// differently on one screen.
//
// EVERY MESSAGE ON THIS CHANNEL IS A FULL SNAPSHOT, so every reducer here is a REPLACE and never a
// merge. §5.4's tag precedence is computed against a row as a whole; a merged row is a row whose tags
// were decided at two different moments, which is exactly the mismatch the thread store's own header
// argues against for the §4.4 counts.
//
// §5.5's LIVE GRID IS A DELTA ON TOP OF THE SNAPSHOT, not a second source of truth. `spend_7d` is the
// ledger's answer and is authoritative; `liveSpend` is what has arrived on the trace channel since,
// which the ledger has not caught up with yet (metering is deliberately floating and asynchronous).
// Displayed as the sum, cleared on every snapshot — the same arrangement, for the same reason, as
// `threadStore.liveCost`.

import { create } from "zustand";
import type { AgentCardView, AgentDetailView, AgentFileView } from "../types.ts";

interface AgentGridState {
  cards: AgentCardView[];
  /**
   * Whether this workspace has a members list at all.
   *
   * §4's `created_by` filter and §5.2's creator avatar are Team-only. Decided on the server, because
   * a personal workspace has one member — so the filter is a control with one option and the avatar
   * is a picture of the only person who could have made it.
   */
  team: boolean;
  /**
   * False until the first snapshot lands on this connection.
   *
   * §9's no-spinner rule needs this as a state distinct from "there are none": "we have not been told
   * yet" renders skeleton cards, and "the workspace has no agents" renders §4's prompt card. Collapsing
   * the two puts "Describe an agent and Jaroku will build it" in front of somebody whose grid is on
   * its way.
   */
  loaded: boolean;
  /** The last refusal on this channel, as a dismissible strip rather than a swallowed message. */
  error: string | null;
  /** The last thing the server said went right — a fork's new slug, a restored version. */
  notice: string | null;

  /**
   * The agent whose §6 detail is open, by SLUG, or null for the grid.
   *
   * BY SLUG, because that is what every other surface in this app calls an agent id — the sidebar
   * selects by it, the composer targets by it, run rows carry it — and a second identifier here would
   * make this the one place where "the selected agent" means something else.
   *
   * IT LIVES HERE RATHER THAN IN `uiStore` because it is not view state: it decides which agent's
   * record is loaded and which agent the composer is scoped to. `uiStore.navView` is the view state,
   * and the two are deliberately independent — §2 says clicking a card restores the three panes while
   * the Agents nav item stays active, which is two facts and therefore two fields.
   */
  openAgentId: string | null;
  detail: AgentDetailView | null;
  /** True while a detail is on its way, so the pane can hold its shape rather than flash empty. */
  detailLoading: boolean;

  /** The version the file browser is showing, and its files. Null before anything is asked for. */
  version: { agentId: string; version: number; files: AgentFileView[] } | null;
  versionLoading: boolean;

  /**
   * An agent whose next version payload should be SAVED rather than shown, by slug.
   *
   * A ONE-SHOT INTENT, exactly like `uiStore.secretsAddProvider` and for the same structural reason:
   * the thing that asks is a menu entry on a card in the grid, and the thing that can answer is
   * whatever is mounted when the files land, on the other side of a round trip. Lifting the download
   * into the store instead would put a DOM call in a store; passing a callback through the socket
   * layer would put a continuation in a protocol.
   *
   * CLEARED BY WHOEVER CONSUMES IT, because it describes something somebody asked for once. Left
   * set, the next time anybody browsed a version of that agent it would silently save a file.
   */
  exportRequest: string | null;
  requestExport: (slug: string) => void;
  clearExportRequest: () => void;

  /**
   * Per-agent spend that has arrived since the last snapshot, by SLUG (§5.5's ticker).
   *
   * KEYED BY SLUG AND FED FROM RUN IDS. A trace step carries a run id and nothing else — the frozen
   * event schema has no agent field and must not grow one — so the join is against the run ids on the
   * cards this store already holds. A step for a run no card claims is dropped, which is correct: it
   * belongs to an agent this grid is not showing.
   */
  liveSpend: Record<string, number>;
  /** The steps already counted, so a redelivered event cannot be added twice. Cleared with the deltas. */
  countedSteps: Record<string, true>;

  setGrid: (cards: AgentCardView[], team: boolean) => void;
  setDetail: (detail: AgentDetailView) => void;
  startDetail: (agentId: string) => void;
  closeDetail: () => void;
  setVersion: (agentId: string, version: number, files: AgentFileView[]) => void;
  startVersion: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  /** A step's cost, attributed to whichever agent owns its run. See `liveSpend`. */
  addStepCost: (runId: string, cost: number, stepId: string) => void;
}

export const useAgentGridStore = create<AgentGridState>((set, get) => ({
  cards: [],
  team: false,
  loaded: false,
  error: null,
  notice: null,
  openAgentId: null,
  detail: null,
  detailLoading: false,
  version: null,
  versionLoading: false,
  exportRequest: null,
  liveSpend: {},
  countedSteps: {},

  setGrid: (cards, team) =>
    set((s) => ({
      cards,
      team,
      loaded: true,
      // A SNAPSHOT CLEARS THE REFUSAL, rather than a close button doing it. The strip says the last
      // thing that did not work; the grid being right again is what makes that stale.
      error: null,
      // AND THE DELTAS, because the snapshot is the authority and a delta kept across one would
      // eventually be counted twice. The cost of that reset is honest and small — for the moment
      // between a transition and the ledger catching up, a figure can dip by a step or two.
      liveSpend: {},
      countedSteps: {},
      // A DETAIL THAT IS OPEN FOLLOWS THE SNAPSHOT'S CARD, so the header of the detail and the card
      // behind it can never disagree about a tag. The rest of the detail — versions, tools, latency —
      // is not in a grid snapshot and is deliberately left as it was rather than blanked: it is still
      // true, and blanking it would make every broadcast in the workspace flicker somebody's open
      // agent.
      detail: s.detail
        ? { ...s.detail, card: cards.find((c) => c.slug === s.detail!.card.slug) ?? s.detail.card }
        : null,
    })),

  startDetail: (agentId) =>
    set((s) => ({
      openAgentId: agentId,
      detailLoading: true,
      // The previous agent's detail is dropped immediately rather than left showing while the next
      // one loads. A pane that renders one agent's versions under another agent's name for two
      // frames is worse than one that is briefly empty.
      detail: s.detail?.card.slug === agentId ? s.detail : null,
      version: null,
    })),

  setDetail: (detail) => set({ detail, detailLoading: false, openAgentId: detail.card.slug, error: null }),

  closeDetail: () => set({ openAgentId: null, detail: null, detailLoading: false, version: null }),

  startVersion: () => set({ versionLoading: true }),
  requestExport: (slug) => set({ exportRequest: slug }),
  clearExportRequest: () => set({ exportRequest: null }),
  setVersion: (agentId, version, files) => set({ version: { agentId, version, files }, versionLoading: false }),

  setError: (error) => set({ error, detailLoading: false, versionLoading: false }),
  setNotice: (notice) => set({ notice }),

  addStepCost: (runId, cost, stepId) => {
    const state = get();
    if (state.countedSteps[stepId]) return;
    // The card that owns this run. A miss is an ordinary outcome — the run belongs to an agent the
    // grid is not showing, or to one whose window has moved past it — and is silently ignored rather
    // than attributed to nobody.
    const owner = state.cards.find((c) => c.outcomes.some((o) => o.run_id === runId));
    if (!owner) return;
    set((s) => ({
      liveSpend: { ...s.liveSpend, [owner.slug]: (s.liveSpend[owner.slug] ?? 0) + cost },
      countedSteps: { ...s.countedSteps, [stepId]: true },
    }));
  },
}));

/**
 * What a card's spend figure should read: the ledger's answer plus what has arrived since.
 *
 * A FUNCTION RATHER THAN A FIELD, so there is one definition of "the figure" and the card cannot
 * render the snapshot's half by itself. Null stays null — an agent that has spent nothing shows
 * nothing, not `$0.00`, and a delta that arrived for it is a real figure rather than an addition to
 * an absence.
 */
export function spendFor(card: AgentCardView, liveSpend: Record<string, number>): number | null {
  const delta = liveSpend[card.slug] ?? 0;
  if (card.spend_7d === null) return delta > 0 ? delta : null;
  return card.spend_7d + delta;
}

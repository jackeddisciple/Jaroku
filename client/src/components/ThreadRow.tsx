// One thread, in three lines (§4.3).
//
//   ◆  Stripe webhook retry logic                              18m
//      stripe_webhook · diff pending +42−11 · $0.04 · Riya
//      "add exponential backoff to the retry handler"
//
// DENSE BUT BREATHABLE — the same discipline as the trace timeline, which is the other surface in
// this product that puts four facts on a line and is read by scanning rather than by reading.
//
// THE GLYPHS ARE DRAWN, NOT TYPED. §3.3 names five shapes — ◆ ● ✕ ○ ⊘ — and the obvious way to get
// them is the characters themselves. The sidebar already learned why that is wrong: a font character
// sits on the text baseline at whatever weight the row happens to be, and never optically matches
// the icons two panels over. So each one is a small SVG at a fixed box, in the STATUS colour it is
// entitled to, and the shapes are exactly the five the spec names.
//
// FOUR COLOURS, AND NOT ONE MORE. Amber is running-or-attention, red is failure, and dim is
// "nothing outstanding". Green appears nowhere on this row: a thread that finished cleanly is not a
// success to be congratulated, it is a session with nothing waiting in it, and colouring it would
// make the amber rows compete with something.
//
// WHAT THE ROW DOES NOT DO. There is no [Apply] button beside `diff pending +42−11`, deliberately
// (§4.8). Applying a diff without its conversation and trace in view is exactly the context-free
// write the composer's ⊕ attach menu already declines to offer for GitHub, and this view's job —
// stated in §1.1 — is to answer which threads need you, not to let you act on them without going
// there.

import { useEffect, useRef, useState } from "react";
import { relTime } from "../lib/format.ts";
import { resumeHint } from "../lib/threadResume.ts";
import { fmtRunningCost, fmtThreadCost } from "../lib/threadCost.ts";
import { STATUS } from "../lib/tokens.ts";
import { agentChipLabel, threadEvalProgress, threadSpend, useThreadStore } from "../store/threadStore.ts";
import { ThreadGlyph } from "./ThreadGlyph.tsx";
import { useMemberStore } from "../store/memberStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import type { ThreadView } from "../types.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";

/**
 * Who opened the thread, in a Team workspace only (§4.3).
 *
 * IN PERSONAL THE COLUMN DOES NOT EXIST, because it would be the same name on every row — which is
 * not a column, it is a watermark.
 *
 * THE NAME COMES FROM THE MEMBERS LIST, and when that has not been read yet this renders nothing
 * rather than the user id it holds. A uuid in the author position is worse than an absent author: it
 * takes the space, it cannot be recognised, and it invites somebody to widen the row for it.
 */
function useAuthorLabel(createdBy: string | null): string | null {
  const workspaceId = useSessionStore((s) => s.workspaceId);
  const workspaces = useSessionStore((s) => s.workspaces);
  const members = useMemberStore((s) => s.members);
  const me = useSessionStore((s) => s.user?.id ?? null);

  const kind = workspaces.find((w) => w.id === workspaceId)?.kind;
  if (kind !== "team" || !createdBy) return null;
  const member = members.find((m) => m.user_id === createdBy);
  if (member) return member.display_name ?? member.email.split("@")[0] ?? null;
  // Their own row still names them, because the session already knows who they are — the members
  // list is only needed for other people.
  if (createdBy === me) {
    const user = useSessionStore.getState().user;
    return user?.displayName ?? user?.email.split("@")[0] ?? null;
  }
  return null;
}

export function ThreadRow({
  thread,
  selected,
  onOpen,
  onOpenAgent,
  onRename,
  onArchive,
  onRestore,
  renaming = false,
  onRenamingEnd,
  connected = true,
}: {
  thread: ThreadView;
  /** The keyboard's cursor (§4.7's J/K). Distinct from "the thread the centre pane holds". */
  selected: boolean;
  onOpen: () => void;
  /** §4.3: clicking the chip navigates to that AGENT, not into the thread. */
  onOpenAgent: (agentId: string) => void;
  onRename: (title: string) => void;
  /**
   * §5's other way in: `⌘Enter` on the cursor row (§4.7 — every action without a mouse).
   *
   * The row cannot own the whole of `editing` any more, because the keyboard hook is mounted on the
   * VIEW and has no handle on a row. So the view says which row is being renamed and the row still
   * decides when that ends — a double-click starts one locally, and `onRenamingEnd` tells the view
   * so the two never disagree about whether an editor is open.
   */
  renaming?: boolean;
  onRenamingEnd?: () => void;
  /** §3.4's `E`, reachable with a mouse too. Absent on an already-archived row. */
  onArchive: () => void;
  /** §3.4: restore is one click. The only control an archived row has. */
  onRestore: () => void;
  /**
   * Whether this row's mutations can reach the server at all.
   *
   * STATE WHAT'S TRUE, which is the product's own disabled-state rule. The transport drops writes in
   * silence while the socket is down, so an Archive that did nothing looked identical to one that
   * worked — and §3.4's notice said the thread had been archived either way. Defaulted to true so a
   * caller that has no opinion gets the old behaviour rather than a dead row.
   */
  connected?: boolean;
}) {
  const author = useAuthorLabel(thread.created_by);
  const hint = resumeHint(thread);
  /**
   * §4.3.3. A running thread's figure MOVES, and shows where it is heading when there is a denominator.
   *
   * Subscribed per row rather than per view, so a step landing on one thread re-renders that row and not
   * the whole list — a hundred rows re-rendering per step of one eval is the sort of thing that makes a
   * live figure worse than a still one.
   */
  const live = useThreadStore((s) => s.liveCost[thread.id] ?? 0);
  const spend = threadSpend(thread, { [thread.id]: live });
  // §4.3.3's denominator, from the eval channel rather than from the snapshot. The snapshot is taken
  // when the eval STARTS, when done is 0 — and projectCost correctly refuses to extrapolate from
  // nothing — so a row read from it alone showed `eval 0/120` and no projection for the whole sweep.
  const liveProgress = useThreadStore((s) => s.liveEvalProgress);
  const progress = threadEvalProgress(thread, liveProgress);
  const cost = thread.status === "running"
    ? fmtRunningCost(spend, thread.cost_known, progress)
    : fmtThreadCost(spend, thread.cost_known);
  // Started here by a double-click, or by the view when `⌘Enter` names this row. Either way the
  // ending is the row's, so `stopEditing` is the single exit both routes go through.
  const [locallyEditing, setLocallyEditing] = useState(false);
  const editing = locallyEditing || renaming;
  const [draft, setDraft] = useState(thread.title);
  const input = useRef<HTMLInputElement>(null);

  /**
   * Escape has cancelled this edit, so the blur it causes must not save it.
   *
   * Removing a focused input fires a blur, and `onBlur` is `commit` — which mattered little while
   * commit skipped an unchanged title and matters now that it does not: Escape after typing would
   * otherwise save the text it was pressed to discard.
   */
  const cancelled = useRef(false);

  const stopEditing = (): void => {
    setLocallyEditing(false);
    onRenamingEnd?.();
  };

  useEffect(() => {
    if (editing) {
      cancelled.current = false;
      setDraft(thread.title);
      input.current?.focus();
      input.current?.select();
    }
    // `thread.title` deliberately out of the deps: a snapshot arriving mid-edit must not overwrite
    // what somebody is typing. The edit is committed or cancelled by them, and the row re-reads the
    // title when it ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // SENT EVEN WHEN THE TEXT DID NOT CHANGE, and that is §5 rather than a redundant write. Saving
  // sets `title_is_custom`, and somebody who opened the editor, decided the auto-title was right and
  // pressed Enter has CHOSEN that title — skipping the send left the flag at 0, so the next message
  // ran `autoTitle` over it and silently reverted their decision. The server's UPDATE is idempotent,
  // so an unchanged title costs one statement and settles the flag.
  const commit = (): void => {
    stopEditing();
    if (cancelled.current) return;
    const next = draft.trim();
    if (next) onRename(next);
  };

  return (
    <div
      onClick={() => { if (!editing) onOpen(); }}
      className={`group relative cursor-pointer px-5 py-2 transition-colors ${
        selected ? "bg-active" : "hover:bg-active/40"
      }`}
    >
      {selected && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-ink" />}

      {/* line 1: glyph, title, time */}
      <div className="flex items-center gap-2">
        <span className="shrink-0"><ThreadGlyph status={thread.status} /></span>
        {editing ? (
          // §5's inline rename. Enter saves, Escape cancels, and the click that lands in the field
          // must not also open the thread — hence the stopPropagation, which is the only place this
          // row swallows an event.
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") { cancelled.current = true; stopEditing(); }
            }}
            className="min-w-0 flex-1 rounded-control bg-void px-1.5 py-0.5 text-[13px] text-ink outline-none ring-1 ring-edge"
          />
        ) : (
          // The double-click sits on a wrapper rather than on Truncate: that component measures its
          // own text to decide whether to fade, and it does that from a STRING child — handing it an
          // element would leave it measuring nothing and fading every title.
          <span
            className="min-w-0 flex-1"
            // A rename needs the socket too, and an editor that opened over a dead one would take
            // what somebody typed and drop it.
            onDoubleClick={(e) => { e.stopPropagation(); if (connected) setLocallyEditing(true); }}
          >
            <Truncate
              className={`text-[13px] ${thread.archived_at ? "text-muted" : "text-ink"}`}
              title={thread.title}
            >
              {thread.title}
            </Truncate>
          </span>
        )}
        {/* §4.5's affordance: on hover the timestamp gives way to where Enter will land, with the
            shape of the destination and not only its kind. It REPLACES the time rather than sitting
            beside it, because both belong at the right edge and a row that grew a second right-hand
            element on hover would reflow under the cursor.

            Nothing outstanding means no hint (`resumeHint` returns null) and the time simply stays —
            the click already means "open", and four words saying so on every idle row is noise. */}
        {hint ? (
          <span className="ml-auto hidden shrink-0 items-center gap-1 rounded-control bg-void px-1.5 py-0.5 text-[10px] text-muted group-hover:flex">
            {hint}
          </span>
        ) : null}
        <span
          className={`ml-auto shrink-0 text-[11px] text-faint tabular-nums ${hint ? "group-hover:hidden" : ""}`}
        >
          {relTime(thread.last_activity_at)}
        </span>
      </div>

      {/* line 2: the agent, the one decision-relevant fact, the cost, and who opened it */}
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-5 text-[11px] text-muted">
        {/* The chip navigates to the AGENT; the row navigates into the thread. Two destinations one
            pixel apart, so the click has to be stopped here — and `Chip.onClick` takes no event, on
            purpose, so the stopping happens on the span around it. */}
        <span
          onClick={thread.agent_id ? (e) => { e.stopPropagation(); onOpenAgent(thread.agent_id!); } : undefined}
        >
          <Chip
            size="sm"
            tone="faint"
            mono
            variant="bare"
            title={thread.agent_id ? `Go to ${agentChipLabel(thread)}` : undefined}
            className={`${thread.agent_deleted ? "opacity-60" : ""} ${thread.agent_id ? "hover:text-ink" : ""}`}
          >
            {agentChipLabel(thread)}
          </Chip>
        </span>
        {/* §4.3.4's collision marker, ON THE AGENT CHIP rather than on the row's status glyph: it is a
            fact about the AGENT, not about this particular thread, so it belongs on the element that
            already represents the agent.

            INFORMATIONAL ONLY. It does not block opening either thread, does not merge them, and does
            not lock one while the other is open — Jaroku has no file-locking model and this does not
            introduce one. It exists so somebody opening one thread already knows another is live on the
            same files, exactly as the GitHub tab's divergence badge exists so a person knows before they
            act rather than to act for them.

            Amber, because it is attention rather than failure — the marker says two sessions are moving,
            which is a thing to know and not a thing that has gone wrong. */}
        {thread.agent_active > 1 && (
          <span
            className="shrink-0 text-[10px] tabular-nums"
            style={{ color: STATUS.pending }}
            title={`${thread.agent_active} threads on this agent are blocked or running`}
          >
            ⚠ {thread.agent_active} active
          </span>
        )}
        {thread.fragment && (
          <>
            <span className="text-faint">·</span>
            <span className={thread.status === "errored" ? "text-err" : ""}>{thread.fragment}</span>
          </>
        )}
        {cost && (
          <>
            <span className="text-faint">·</span>
            {/* §4.3.6: an outline rather than a plain render when this session is a large share of the
                period's spend. THE LIGHTEST POSSIBLE TREATMENT — a hairline box and nothing else. No
                percentage on the row (that belongs in Activity), no colour (there are four and none is
                spare for "expensive"), and no icon, which would read as a warning about a number that is
                merely worth a second look. */}
            <span
              className={`tabular-nums ${
                thread.cost_share_high ? "rounded-control px-1 ring-1 ring-edge" : ""
              }`}
              title={
                thread.cost_share_high
                  ? "a large share of this workspace's spend this period — Activity has the breakdown"
                  : thread.cost_known
                    ? thread.eval_progress
                      ? "spent so far, and a linear projection over the remaining steps"
                      : undefined
                    : "a floor — something here ran on an unpriced model"
              }
            >
              {cost}
            </span>
          </>
        )}
        {author && (
          <>
            <span className="text-faint">·</span>
            <span>{author}</span>
          </>
        )}

        {/* §3.4's two lifecycle actions, on hover, at the end of the line rather than in a menu.
            Archive is `E` for anybody using the keyboard; this is the same action for anybody not.
            There is no third one: a thread cannot be deleted, so there is nothing else to offer. */}
        <span className="ml-auto hidden shrink-0 items-center gap-1 group-hover:flex">
          {thread.archived_at === null ? (
            <button
              onClick={(e) => { e.stopPropagation(); onArchive(); }}
              disabled={!connected}
              title={connected ? "Archive this thread (E)" : "Reconnecting — this needs a connection"}
              className="rounded-control px-1.5 py-0.5 text-[10px] text-faint transition-colors hover:bg-active hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              Archive
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onRestore(); }}
              disabled={!connected}
              title={connected ? "Put this thread back in the list" : "Reconnecting — this needs a connection"}
              className="rounded-control px-1.5 py-0.5 text-[10px] text-faint transition-colors hover:bg-active hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              Restore
            </button>
          )}
        </span>
      </div>

      {/* line 3: the last thing the USER said. Their intent is what makes a thread recognisable;
          Jaroku's reply is not (§4.3). Absent rather than empty when nobody has said anything. */}
      {thread.preview && (
        <div className="mt-0.5 pl-5">
          <Truncate className="text-[11px] italic text-faint" title={thread.preview}>
            “{thread.preview}”
          </Truncate>
        </div>
      )}
    </div>
  );
}

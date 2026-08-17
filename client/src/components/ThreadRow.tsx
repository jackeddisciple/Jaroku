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
import { fmtThreadCost } from "../lib/threadCost.ts";
import { STATUS } from "../lib/tokens.ts";
import { agentChipLabel } from "../store/threadStore.ts";
import { useMemberStore } from "../store/memberStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import type { ThreadStatus, ThreadView } from "../types.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";

/** The dim the two quiet glyphs share. Not a fifth colour — the absence of one. */
const DIM = "#52525b";

/**
 * §3.3's five, as geometry.
 *
 * `viewBox` and box size are identical for all five, so a column of rows has its glyphs on one
 * optical axis regardless of which states happen to be in it — which is the property that makes the
 * section headings unnecessary reading and the shapes scannable on their own.
 */
function ThreadGlyph({ status }: { status: ThreadStatus }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true } as const;
  // The tooltip goes on a wrapper rather than on the `<svg>`: an SVG element has no `title`
  // attribute, and the `<title>` CHILD that would give it one is not read by a screen reader on an
  // aria-hidden node — so the label belongs on the span, which is the thing hover finds anyway.
  const label: Record<ThreadStatus, string> = {
    needs_you: "needs you",
    running: "running",
    errored: "errored",
    idle: "idle",
    archived: "archived",
  };
  return (
    <span className="inline-flex" title={label[status]} aria-label={label[status]} role="img">
      {glyph(status, common)}
    </span>
  );
}

function glyph(status: ThreadStatus, common: { width: number; height: number; viewBox: string; "aria-hidden": true }) {
  switch (status) {
    case "needs_you":
      // ◆ — a diamond, filled. The only shape here with corners, which is what makes it findable
      // in a column of circles without needing its colour to be read first.
      return (
        <svg {...common}>
          <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill={STATUS.pending} />
        </svg>
      );
    case "running":
      // ● — filled, and pulsing, because something is changing right now. That animation means
      // exactly one thing everywhere in this app, and this is one of them.
      return (
        <svg {...common} className="animate-stream-pulse motion-reduce:animate-none">
          <circle cx="6" cy="6" r="4" fill={STATUS.pending} />
        </svg>
      );
    case "errored":
      // ✕ — the one red thing on the row.
      return (
        <svg {...common}>
          <path
            d="M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4"
            stroke={STATUS.error}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "archived":
      // ⊘ — a circle with a line through it. Dim, like idle: an archived thread is not a warning.
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4" fill="none" stroke={DIM} strokeWidth="1.3" />
          <path d="M3.2 8.8 8.8 3.2" stroke={DIM} strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "idle":
      // ○ — hollow. Nothing outstanding, and nothing to say about it.
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3.6" fill="none" stroke={DIM} strokeWidth="1.3" />
        </svg>
      );
  }
}

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
}: {
  thread: ThreadView;
  /** The keyboard's cursor (§4.7's J/K). Distinct from "the thread the centre pane holds". */
  selected: boolean;
  onOpen: () => void;
  /** §4.3: clicking the chip navigates to that AGENT, not into the thread. */
  onOpenAgent: (agentId: string) => void;
  onRename: (title: string) => void;
}) {
  const author = useAuthorLabel(thread.created_by);
  const hint = resumeHint(thread);
  const cost = fmtThreadCost(thread.cost_usd, thread.cost_known);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(thread.title);
      input.current?.focus();
      input.current?.select();
    }
    // `thread.title` deliberately out of the deps: a snapshot arriving mid-edit must not overwrite
    // what somebody is typing. The edit is committed or cancelled by them, and the row re-reads the
    // title when it ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== thread.title) onRename(next);
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
              else if (e.key === "Escape") setEditing(false);
            }}
            className="min-w-0 flex-1 rounded-control bg-void px-1.5 py-0.5 text-[13px] text-ink outline-none ring-1 ring-edge"
          />
        ) : (
          // The double-click sits on a wrapper rather than on Truncate: that component measures its
          // own text to decide whether to fade, and it does that from a STRING child — handing it an
          // element would leave it measuring nothing and fading every title.
          <span
            className="min-w-0 flex-1"
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
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
        {thread.fragment && (
          <>
            <span className="text-faint">·</span>
            <span className={thread.status === "errored" ? "text-err" : ""}>{thread.fragment}</span>
          </>
        )}
        {cost && (
          <>
            <span className="text-faint">·</span>
            <span className="tabular-nums" title={thread.cost_known ? undefined : "a floor — something here ran on an unpriced model"}>
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

// §6's overview header — always first, always cheap to load.
//
// "ALWAYS CHEAP TO LOAD" IS A REAL CONSTRAINT AND IS WHY THIS RENDERS FROM THE CARD. Every field
// here is on `AgentCardView`, which the grid already had in hand before the detail was asked for —
// so this paints on the frame the card was clicked, and the version history and the file browser
// below it fill in as their own reads land. A header that waited for the whole record would leave
// the top of the pane empty for the one part of it somebody can read instantly.
//
// THE RENAME IS INLINE, WHICH §6 ASKS FOR, and it is the same edit the sidebar row already offers.
// One command, two entry points — not two behaviours: the slug never moves, because it is the
// directory on disk, the key datasets and eval runs hold, and the id every past run row names.
//
// `creation_cost` IS NULL-AS-UNKNOWN, NEVER `$0`. v0.1.9 established that a missing figure is not a
// zero and §6 restates it for this line specifically, which is why the check is `=== null` rather
// than falsy — a generation that genuinely cost nothing is a different fact from one nobody priced.

import { useEffect, useRef, useState } from "react";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { AgentTagRow } from "./AgentTagRow.tsx";
import { AgentSparkline } from "./AgentSparkline.tsx";
import { PencilIcon } from "./panelIcons.tsx";
import { artFor } from "../lib/agentArt.ts";
import { ThumbnailMark } from "./agentIcons.tsx";
import { sendRenameAgent } from "../lib/socket.ts";
import { fmtCost, relTime } from "../lib/format.ts";
import { BRAND, ICON, TYPE } from "../lib/tokens.ts";
import type { AgentDetailView } from "../types.ts";

/** One fact, as a label over a value. The `well` level of §9's three-level nesting. */
function Fact({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 truncate text-[12px] text-ink">{value}</div>
    </div>
  );
}

export function AgentOverview({ detail }: { detail: AgentDetailView }) {
  const a = detail.card;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(a.name);
  const input = useRef<HTMLInputElement | null>(null);

  // The draft follows the agent, so opening a second agent while an edit is half-typed does not
  // carry the first one's text into it.
  useEffect(() => {
    setRenaming(false);
    setDraft(a.name);
  }, [a.slug, a.name]);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  /**
   * Whether Escape has already answered for this edit.
   *
   * ESCAPE HAS TO BEAT THE BLUR IT CAUSES, and a piece of state cannot do it. Escape sets the draft
   * back and takes the field down; taking it down fires `onBlur`, and that handler closed over the
   * render where the draft was still what somebody had typed — so cancelling an edit SENT it, which
   * is the one thing a cancel must never do. A ref is read at call time rather than captured, so the
   * blur that follows sees the cancellation that caused it.
   */
  const cancelled = useRef(false);

  const commit = (): void => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== a.name) sendRenameAgent(a.slug, next);
    else setDraft(a.name);
  };

  const cancel = (): void => {
    cancelled.current = true;
    setDraft(a.name);
    setRenaming(false);
  };

  return (
    <div className="shrink-0 border-b border-hair">
      {/* The gradient again, as a band rather than a card thumbnail — the same asset for the same
          agent, which is what makes the detail recognisable as the card that was clicked. */}
      <div className="relative h-16 w-full overflow-hidden bg-active" aria-hidden>
        <img src={artFor(a.uuid)} alt="" decoding="async" className="h-full w-full object-cover" />
        <div className="absolute inset-0 flex items-center justify-center">
          <ThumbnailMark size={BRAND.screen} />
        </div>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <input
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  // The view's own bare keys must not fire from inside a field somebody is typing a
                  // name into, and Escape has to cancel rather than commit — a rename you cannot
                  // back out of is one people stop starting.
                  e.stopPropagation();
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") cancel();
                }}
                aria-label={`Rename ${a.name}`}
                className="w-full rounded-control border border-edge bg-panel px-2 py-1 text-[13px] font-medium text-ink outline-none"
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                <Truncate className={TYPE.title} title={a.name}>
                  {a.name}
                </Truncate>
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  title="Rename this agent — the slug does not change"
                  aria-label={`Rename ${a.name}`}
                  className="shrink-0 rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active hover:text-ink"
                >
                  <PencilIcon size={ICON.xs} />
                </button>
              </div>
            )}
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              <Chip size="sm" mono tone="faint" title="The slug — the directory on disk, and the id every run row names">
                {a.slug}
              </Chip>
              <Chip size="sm" tone="faint" title="The version currently live">
                v{a.current_version}
              </Chip>
            </div>
          </div>
        </div>

        {/* The tag row again, in full: the detail has room, so nothing is behind an overflow chip
            here — `AgentTagRow` trims at three and reveals on hover, which at this width is one
            hover rather than a scan across forty cards. */}
        <AgentTagRow agent={a} />

        {a.description && <p className="text-[12px] leading-[1.55] text-muted">{a.description}</p>}

        <div className="grid grid-cols-2 gap-3 rounded-control border border-hair p-2.5 sm:grid-cols-4">
          <Fact
            label="Created"
            value={relTime(a.created_at)}
            title={a.created_at}
          />
          <Fact
            label="Cost to build"
            // NULL IS UNKNOWN AND IS RENDERED AS SUCH. A `$0` here would claim the generation was
            // free, which is a different thing from nobody having recorded what it cost.
            value={a.creation_cost === null ? <span className="text-faint">unknown</span> : fmtCost(a.creation_cost)}
            title={a.creation_cost === null ? "Nobody recorded what this generation cost" : undefined}
          />
          <Fact
            label="Live version"
            value={`v${a.current_version}${a.version_source ? ` · ${a.version_source}` : ""}`}
            title={
              a.version_source === "import"
                ? "Published as-is, so the validator never saw it"
                : "Published through the validator"
            }
          />
          <Fact
            label="Runs, 7 days"
            value={<span className="tabular-nums">{a.runs_7d}</span>}
          />
        </div>

        {/* The sparkline here is the same control as on the card, at the same size — §5.5's bars
            open a trace from either surface, and a second, differently-behaved version of it in the
            detail would be a second thing to learn. */}
        {a.outcomes.length > 0 && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[10px] uppercase tracking-wider text-faint">Recent runs</span>
            <AgentSparkline outcomes={a.outcomes} height={14} />
          </div>
        )}
      </div>
    </div>
  );
}

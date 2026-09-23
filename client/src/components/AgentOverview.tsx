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
import { ChevronDownIcon } from "./panelIcons.tsx";
import { FACE_SIZE, AgentFace, AgentBanner } from "./AgentFace.tsx";
import { AGENT_CATEGORIES, normalizeCategory, showsCategory } from "../lib/agentCategories.ts";
import { faceFor } from "../lib/agentFaces.ts";
import { sendSetAgentCategory } from "../lib/socket.ts";
import { sendRenameAgent } from "../lib/socket.ts";
import { fmtCost, relTime } from "../lib/format.ts";
import { validatorVerdict } from "../lib/validatorVerdict.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import type { AgentDetailView } from "../types.ts";

/** One fact, as a label over a value. The `well` level of §9's three-level nesting. */
function Fact({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-tiny uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 truncate text-caption text-ink">{value}</div>
    </div>
  );
}

export function AgentOverview({ detail }: { detail: AgentDetailView }) {
  const a = detail.card;
  /** The version the live one restored, if it is a restore (migration 081). */
  const restoredFrom = detail.versions.find((v) => v.current)?.restored_from ?? null;
  /** §6's "name your own", for an agent that already exists. Cleared once it has been sent. */
  const [customCategory, setCustomCategory] = useState("");
  /**
   * Does this agent have a picture? The banner and the overlap both depend on it.
   *
   * SAME TWO LAYOUTS AS THE CARD, for the same reason: with no picture there is no band, so there
   * is no seam to straddle and nothing for the portrait to rise into. See `AgentCard`.
   */
  const hasFace = faceFor(a.picture) !== null;
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
      {/* THE BANNER, AND IT IS THE SECOND TIME A BAND HAS SAT HERE. The first was a generated
          gradient, and D6 retired it with a live consequence recorded: the band said "the blue one"
          and the mark beside the name said "the tractor", two facts about one agent that reinforced
          nothing. This band is not that. It is cut from the same artwork as the portrait over it, so
          the two are one picture at two crops — which is the condition D6's objection was about, and
          it is met rather than argued around.

          EDGE TO EDGE, UNLIKE THE CARD'S. A card is a frame and holds its band inside a margin; this
          header IS the top of the pane, and a band inset from the pane's edges would read as a card
          that had lost its own border. Taller than the card's for the same reason — the pane is
          three times as wide, and a 80px strip across it is a line rather than a banner. */}
      <AgentBanner picture={a.picture} className="h-28" />

      <div className="relative space-y-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
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
                className="w-full rounded-input border border-edge bg-elevated px-2 py-1 text-label text-ink outline-none focus-visible:shadow-focusring"
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                {/* THE EMOJI IS NOT ON THIS LINE ANY MORE. It is inside the character to the left,
                    as its placeholder — §5.2's split applied to the second 3D surface exactly as it
                    is to the first. D6's "the blue one here, the tractor there" was true of this
                    header and is not any more: there is one picture of this agent on it. */}
                <Truncate className={TYPE.title} title={a.name}>
                  {a.name}
                </Truncate>
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  title="Rename this agent — the slug does not change"
                  aria-label={`Rename ${a.name}`}
                  className="shrink-0 rounded-control p-1 text-faint transition-colors duration-fast hover:bg-active active:bg-chrome hover:text-ink"
                >
                  <PencilIcon size={ICON.xs} />
                </button>
              </div>
            )}
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              <Chip size="sm" mono tone="faint" title="The slug — the directory on disk, and the id every run row names">
                {a.slug}
              </Chip>
              {/* ONLY WHEN SOMETHING IS LIVE. `current_version` starts at 1 on every row whether or
                  not a version exists behind it, so a draft wore a `v1` chip over a history that
                  said nothing had been published. `version_source` is null exactly then. */}
              {a.version_source !== null && (
                <Chip size="sm" tone="faint" title="The version currently live">
                  v{a.current_version}
                </Chip>
              )}
              {/* §6'S CATEGORY, WHERE THE OTHER TWO IDENTIFIERS ARE. `Uncategorized` is left out on
                  the same rule §7 gives the sidebar: an agent nobody has categorised should read as
                  a name, not as a name and a placeholder. The control that SETS it is in the
                  identity section below. */}
              {showsCategory(a.category) && (
                <Chip size="sm" tone="faint" title="What this agent is for">
                  {a.category}
                </Chip>
              )}
            </div>
          </div>
          {/* THE PORTRAIT, STRADDLING THE BANNER'S BOTTOM EDGE, AT THE RIGHT END OF THE ROW — the
              same corner the card puts it in, and the same corner for the same reason: two surfaces
              showing one agent should not disagree about where its face is. It sat on the LEFT for
              one commit, on the argument that a pane three times a card's width would put a
              right-hand portrait a long way from the name it identifies — which is true and is not
              the trade worth making. Somebody clicks a card and the detail opens; a face that jumps
              across the pane in that moment is the two surfaces looking like two products.

              THE NAME IS STILL THE FIRST THING READ on both, at the left, which is what §03's
              hierarchy actually asks for — the picture supports the name rather than sharing its
              column.

              IN THE FLOW RATHER THAN POSITIONED, unlike the card's. It is lifted out of the band by
              a negative margin, so `items-start` on the row is what holds it against the top and
              `shrink-0` — `AgentFace`'s own — is what stops a long name squeezing it.

              HIDDEN WHILE RENAMING, as the character it replaces was: the field takes the full width
              of the header and a 96px picture beside a text input somebody is typing in is a picture
              in the way. */}
          {!renaming && (
            <AgentFace
              picture={a.picture}
              name={a.name}
              size={FACE_SIZE.header}
              // `canvas`, not `elevated` — the detail pane's ground is §01's canvas, and a ring in
              // any colour but the one behind the picture is a halo. See `AgentFace`.
              ring={hasFace ? "canvas" : undefined}
              // HALF OF IT ABOVE THE BAND. The card lifts three-fifths of a 56px portrait; here the
              // portrait is 96px and the band is 112px, and half is what leaves air above its head
              // rather than pushing it against the top of the strip.
              className={hasFace ? "-mt-16" : "-mt-0.5"}
            />
          )}
        </div>

        {/* WHAT IS LEFT OF §6'S IDENTITY SECTION, WHICH IS THE CATEGORY AND NOTHING ELSE. It held
            three controls: the name, the emoji mark, and — briefly — a grid of 3D characters. The name is the
            pencil above, the mark is gone with the emoji, and the picture is not chosen at all any
            more: an agent is given one at creation, from the eleven, by its position in the
            workspace's creation order. So there is nothing here to pick it with, deliberately —
            a picker for a decision the product makes is a control that exists to be ignored.

            STILL BEHIND A DISCLOSURE, CLOSED, even at one control. Forty category pills open by
            default would be forty controls above the description, the tag row and every fact on the
            header — a page about categorising an agent rather than about the agent. Setting a
            category is something somebody does once; reading the header is what they do every time. */}
        <details className="group/identity rounded-control border border-hair">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-tiny text-muted transition-colors duration-fast hover:text-ink">
            {/* A CHEVRON, NOT A WORD — the app's one disclosure vocabulary. Down when open, ninety
                degrees when closed, as every tree and section here. */}
            <span className="text-faint transition-transform duration-fast group-open/identity:rotate-0 -rotate-90" aria-hidden>
              <ChevronDownIcon size={ICON.xs} />
            </span>
            Identity
            <span className="ml-auto text-faint">category</span>
          </summary>

          <div className="space-y-3 border-t border-hair p-2.5">
            {/* §6'S CATEGORY. The same twenty-five presets the create dialog offers plus a typed
                one, because they are the same question and a second vocabulary here would be a
                second list to keep in step. Stored identically either way (I6). */}
            <div>
              <span className={TYPE.sectionLabel}>Category</span>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {AGENT_CATEGORIES.map((c) => (
                  <Chip
                    key={c}
                    size="sm"
                    onClick={() => sendSetAgentCategory(a.slug, c)}
                    selected={a.category === c}
                    variant={a.category === c ? undefined : "outline"}
                  >
                    {c}
                  </Chip>
                ))}
              </div>
              <input
                value={customCategory}
                onChange={(e) => setCustomCategory(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && customCategory.trim()) {
                    sendSetAgentCategory(a.slug, normalizeCategory(customCategory));
                    setCustomCategory("");
                  }
                }}
                placeholder="…or name your own, then Enter"
                aria-label="Name your own category"
                className="mt-1.5 w-full rounded-input border border-edge bg-elevated px-2.5 py-1 text-caption text-ink outline-none placeholder:text-faint focus:shadow-focusring"
              />
            </div>

            {/* AND THERE IS NO PICTURE PICKER HERE, WHICH IS NOW TRUE OF THE WHOLE PRODUCT. It used
                to be true only of this panel — a carousel on the onboarding screen was the one place
                that asked — and the carousel is gone too: a picture and the name that goes with it
                are given at creation, from the eleven, by position. What this section owns is the
                category, which changes with how an agent is USED rather than with what it looks
                like, and that is the only half of identity anybody has a reason to revisit. */}
          </div>
        </details>

        {/* The tag row again, in full: the detail has room, so nothing is behind an overflow chip
            here — `AgentTagRow` trims at three and reveals on hover, which at this width is one
            hover rather than a scan across forty cards. */}
        <AgentTagRow agent={a} />

        {a.description && <p className="text-caption leading-[1.55] text-muted">{a.description}</p>}

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
            // NOT PUBLISHED IS SAID, the way Health says it, rather than a `v1` that names nothing.
            value={
              a.version_source === null
                ? <span className="text-faint">not published</span>
                // A RESTORE SAYS WHAT IT RESTORED. It carries the copied version's source, and
                // "v5 · generation" would claim a generation made v5.
                : restoredFrom !== null
                  ? `v${a.current_version} · restores v${restoredFrom}`
                  : `v${a.current_version} · ${a.version_source}`
            }
            // THE HEALTH TAB'S VERDICT, IN ITS SHORT FORM. This was a two-way branch that gave
            // "Published through the validator" to everything that was not an import — including a
            // draft that had published nothing and a deploy version the validator never saw.
            title={validatorVerdict(a.version_source, a.current_version, restoredFrom).short}
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
            <span className="shrink-0 text-tiny uppercase tracking-wider text-faint">Recent runs</span>
            <AgentSparkline outcomes={a.outcomes} height={14} />
          </div>
        )}
      </div>
    </div>
  );
}
